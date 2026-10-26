import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { randomUUID, X509Certificate } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createCaptureSession } from './capture-session.mjs';
import { inspectSession } from './inspect-session.mjs';
import { createLanReceiver } from './lan-receiver.mjs';
import { prepareLan, isPrivateIPv4 } from './prepare-lan.mjs';
import { addAnnotation } from './annotate-session.mjs';
import { analyzeSession } from './analyze-session.mjs';
import { createLanCaptureController } from './lan-capture-controller.mjs';
import { createTelemetryHub, createViewerServer } from './viewer-server.mjs';

function sample(sequence, ns = 1000000000n, tracked = true) {
  const hand = () => ({ pose_active: true, position_valid: true, orientation_valid: true, position_tracked: tracked, orientation_tracked: tracked,
    position_m: [0.1, 0.2, -0.3], orientation_xyzw: [0, 0, 0, 1], linear_velocity_valid: true, angular_velocity_valid: true,
    linear_velocity_m_s: [0, 1, 0], angular_velocity_rad_s: [1, 0, 0], trigger: 0.75, squeeze: 0.2, thumbstick: [0.1, -0.5], buttons: { x: true } });
  return { schema: 'quest-usb-v1', kind: 'frame', sequence, device_monotonic_ns: String(ns), xr_time_ns: String(ns),
    sample_time_source: 'monotonic_now', reference_space: 'local', reference_space_changes: 0, focused: true, left: hand(), right: hand() };
}
function temp(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quest-lan-test-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('quest-lan-test-')); fs.rmSync(directory, { recursive: true, force: true }); });
  return directory;
}
const meta = (run = randomUUID()) => ({ app_run_id: run, connection_id: randomUUID(), device_model: 'TEST FIXTURE' });

test('chunked capture preserves original data and 64-bit times, tracks gaps, separates coordinate segments, and audits checksums', async t => {
  const root = temp(t), capture = createCaptureSession({ root, chunkBytes: 1 }), connection = meta();
  capture.connected(connection);
  const input = sample(1, 123456789012345678n), stored = capture.packet(input, connection);
  assert.deepEqual(stored.left, input.left); assert.equal(stored.device_monotonic_ns, input.device_monotonic_ns);
  capture.packet(sample(2, 123456789026345678n), connection);
  capture.packet(sample(5, 123456789040345678n, false), connection);
  const moved = sample(6, 123456789054345678n); moved.reference_space_changes = 1;
  assert.notEqual(capture.packet(moved, connection).capture.coordinate_segment_id, stored.capture.coordinate_segment_id);
  const complete = capture.close(); assert.equal(complete.state, 'complete'); assert.equal(complete.missing_packets, 2);
  assert.equal(complete.coordinate_segments, 2); assert.equal(complete.dual_6dof_frames, 3);
  assert.equal(complete.longest_dual_6dof_s, .014);
  assert.equal(capture.close().state, 'complete');
  const report = await inspectSession(capture.directory);
  assert.equal(report.integrity_ok, true); assert.equal(report.frames, 4); assert.equal(report.files.length, 5);
  const quality = await analyzeSession(capture.directory);
  assert.equal(quality.frames, 4); assert.equal(quality.dual_6dof_frames, 3);
  assert.equal(quality.longest_dual_6dof_s, .014); assert.equal(quality.runs.length, 1);
  assert.equal(quality.coordinate_segments.length, 2); assert.equal(quality.observations.headset_unworn, 'not measured');
  const annotations = JSON.parse(fs.readFileSync(path.join(capture.directory, 'annotations.json')));
  assert.equal(annotations.session_id, capture.sessionId); assert.deepEqual(annotations.annotations, []);
  const annotation = await addAnnotation({ directory: capture.directory, label: 'test-only', side: 'left', start: 1, end: 2 });
  assert.equal(annotation.start_sample_id, stored.capture.sample_id);
  assert.equal((await inspectSession(capture.directory)).integrity_ok, true); // Labels never rewrite raw files.
  await assert.rejects(addAnnotation({ directory: capture.directory, label: 'cross-space', start: 1, end: 4 }), /crosses coordinate/);
  fs.appendFileSync(path.join(capture.directory, 'raw/000001.jsonl'), '\n');
  assert.equal((await inspectSession(capture.directory)).integrity_ok, false);
});

test('reconnects retain run identity and detect missing packets; new runs do not share sequence or coordinate space', t => {
  const capture = createCaptureSession({ root: temp(t) }), first = meta(); capture.connected(first);
  const a = capture.packet(sample(50), first);
  const reconnect = { ...first, connection_id: randomUUID() }; capture.connected(reconnect);
  const b = capture.packet(sample(53), reconnect), restart = meta(); capture.connected(restart);
  const c = capture.packet(sample(1), restart);
  assert.equal(a.capture.app_run_id, b.capture.app_run_id); assert.notEqual(a.capture.connection_id, b.capture.connection_id);
  assert.notEqual(b.capture.coordinate_segment_id, c.capture.coordinate_segment_id);
  const status = capture.close(); assert.equal(status.missing_packets, 2); assert.equal(status.coordinate_segments, 2); assert.equal(status.connections, 3);
});

test('power diagnostics remain raw data and survive finalized capture integrity checks', async t => {
  const capture = createCaptureSession({ root: temp(t) }), connection = meta(); capture.connected(connection);
  const packet = sample(1);
  packet.power = { schema: 'quest-power-v1', app_uid: 10123, interactive: false, override_requested: true, lease_remaining_ms: 9000 };
  packet.android_resumed = false; packet.xr_running = true;
  capture.packet(packet, connection); capture.close();
  const stored = JSON.parse(fs.readFileSync(path.join(capture.directory, 'raw/000001.jsonl'), 'utf8').trim());
  assert.deepEqual(stored.power, packet.power); assert.equal(stored.android_resumed, false);
  assert.equal((await inspectSession(capture.directory)).integrity_ok, true);
});

test('a real write failure stops recording, reports failure, and never claims a complete recording', async t => {
  let broken = false, failures = 0;
  const io = { ...fs, writeSync(...args) { if (broken) throw Object.assign(new Error('Simulated disk full'), { code: 'ENOSPC' }); return fs.writeSync(...args); } };
  const capture = createCaptureSession({ root: temp(t), io, onError() { ++failures; } });
  broken = true; assert.throws(() => capture.packet(sample(1), meta()), /disk full/);
  assert.equal(capture.status().state, 'failed'); assert.equal(failures, 1);
  broken = false; assert.equal(capture.close('disk_error').state, 'failed');
  assert.equal((await inspectSession(capture.directory)).integrity_ok, false);
});

test('abrupt process exit leaves recoverable checkpoints and read-only audit reports incomplete state', async t => {
  const root = temp(t);
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    `import {createCaptureSession} from ${JSON.stringify(new URL('./capture-session.mjs', import.meta.url).href)};
     const capture=createCaptureSession({root:process.argv[1]});
     capture.packet(${JSON.stringify(sample(1))},${JSON.stringify(meta())});capture.checkpoint();
     process.stdout.write(capture.directory+'\\n');process.exit(0);`, root], { windowsHide: true });
  let output = ''; child.stdout.on('data', bytes => output += bytes); await once(child, 'exit');
  const directory = output.trim(), report = await inspectSession(directory);
  assert.equal(report.state, 'recording'); assert.equal(report.complete, false); assert.equal(report.frames, 1);
  const before = fs.readFileSync(path.join(directory, 'raw/000001.jsonl'));
  fs.appendFileSync(path.join(directory, 'raw/000001.jsonl'), '{"partial":');
  const damaged = await inspectSession(directory); assert.ok(damaged.errors.some(message => message.includes('unterminated')));
  assert.deepEqual(fs.readFileSync(path.join(directory, 'raw/000001.jsonl')).subarray(0, before.length), before);
});

test('pairing requires a private IPv4 and reuses credentials without accidental rotation', t => {
  assert.equal(isPrivateIPv4('192.168.1.2'), true); assert.equal(isPrivateIPv4('172.31.2.1'), true);
  for (const host of ['0.0.0.0', '127.0.0.1', '8.8.8.8', '192.168.1.999']) assert.equal(isPrivateIPv4(host), false);
  assert.throws(() => prepareLan({ host: '0.0.0.0' }), /private/);
});

test('LAN UI labels the actual transport, recording failure and manual launch independently of USB', async t => {
  const { createTelemetryHub, createViewerServer } = await import('./viewer-server.mjs');
  const { deriveView } = await import('../web/state.js');
  const hub = createTelemetryHub({ source: { mode: 'live', transport: 'lan' } });
  hub.recording({ state: 'failed', error: 'disk full', directory: 'test-only', frames: 0 });
  assert.match(deriveView(hub.snapshot(), 0, true).hint, /Quest LAN Forwarder/);
  const server = await createViewerServer({ hub, port: 0 }); t.after(() => server.close());
  const state = await (await fetch(server.url + '/api/state')).json(); assert.equal(state.recording.state, 'failed');
  assert.equal(state.source.transport, 'lan');
  const asset = await (await fetch(server.url + '/app.js')).text(); assert.match(asset, /LAN 直传/); assert.match(asset, /录制失败/);
});

test('real TLS pairing rejects wrong credentials and second producer; fragmented telemetry reconnects into a durable session', async t => {
  const root = temp(t), openssl = process.env.QUEST_TEST_OPENSSL ?? (process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl');
  const prepared = prepareLan({ host: '192.168.1.2', directory: path.join(root, 'pairing'), openssl });
  assert.equal(prepareLan({ host: '192.168.1.2', directory: prepared.directory, openssl }).reused, true);
  assert.throws(() => prepareLan({ host: '192.168.1.3', directory: prepared.directory, openssl }), /another endpoint/);
  const config = JSON.parse(fs.readFileSync(prepared.configPath)), cert = fs.readFileSync(path.join(prepared.directory, 'server-cert.pem'));
  assert.equal(config.cert_sha256, new X509Certificate(cert).fingerprint256.replaceAll(':', '').toLowerCase());
  const capture = createCaptureSession({ root }), run = randomUUID(), peers = [];
  let connections = 0, receivedResolve;
  const nextPacket = () => new Promise(resolve => { receivedResolve = resolve; });
  const receiver = await createLanReceiver({ host: '127.0.0.1', port: 0, cert, key: fs.readFileSync(path.join(prepared.directory, 'server-key.pem')), token: config.token,
    onConnection(connection) { ++connections; capture.connected(connection); },
    onPacket(packet, connection) { const stored = capture.packet(packet, connection); receivedResolve?.(stored); },
    onDisconnect(connection) { capture.event('disconnected', { connection_id: connection.connection_id }); } });
  t.after(async () => { for (const peer of peers) peer.destroy(); await receiver.close(); capture.close(); });
  const client = async (token = config.token, appRunId = run) => {
    const peer = tls.connect({ host: '127.0.0.1', port: receiver.port, ca: cert, checkServerIdentity: () => undefined }); peers.push(peer);
    peer.on('error', () => {}); await once(peer, 'secureConnect');
    peer.write(JSON.stringify({ protocol: 'quest-lan-v1', kind: 'hello', token, app_run_id: appRunId }) + '\n'); return peer;
  };
  const wrong = await client('0'.repeat(64)); await once(wrong, 'close'); assert.equal(connections, 0);
  // Untrusted certificates fail the TLS handshake before the credential message.
  const untrusted = tls.connect({ host: '127.0.0.1', port: receiver.port }); untrusted.on('error', () => {});
  await assert.rejects(once(untrusted, 'secureConnect')); untrusted.destroy();
  const first = await client(); await once(first, 'data');
  const second = await client(config.token, randomUUID()); await once(second, 'close'); assert.equal(connections, 1);
  let packet = nextPacket(); const line = JSON.stringify(sample(1)); first.write(line.slice(0, 20)); first.write(line.slice(20) + '\n');
  const a = await packet; first.destroy(); await once(first, 'close');
  // Wait for the remote close before reconnecting; no arbitrary sleep.
  await new Promise(resolve => setImmediate(resolve));
  const reconnect = await client(); await once(reconnect, 'data'); packet = nextPacket(); reconnect.write(JSON.stringify(sample(4)) + '\n');
  const b = await packet; assert.equal(a.capture.app_run_id, b.capture.app_run_id); assert.notEqual(a.capture.connection_id, b.capture.connection_id);
  reconnect.destroy(); await once(reconnect, 'close'); await receiver.close(); capture.close();
  const report = await inspectSession(capture.directory); assert.equal(report.integrity_ok, true); assert.equal(report.frames, 2);
});

test('stop keeps preview/connection alive; a second start creates a new session without rewriting the first', async t => {
  const root = path.join(temp(t), 'captures'), hub = createTelemetryHub({ source: { mode: 'live', transport: 'lan' } });
  const controller = createLanCaptureController({ hub, root, source: { transport: 'test-only' } }), producer = meta();
  controller.connected(producer); controller.packet(sample(1), producer);
  assert.equal(fs.existsSync(root), false); assert.equal(hub.snapshot().frame.capture, undefined);
  const [first, repeated] = await Promise.all([controller.start(), controller.start()]); assert.equal(first.session_id, repeated.session_id);
  controller.packet(sample(2), producer); await Promise.all([controller.stop(), controller.stop()]);
  const firstAudit = await inspectSession(first.directory); assert.equal(firstAudit.integrity_ok, true); assert.equal(firstAudit.frames, 1);
  const firstBytes = fs.readFileSync(path.join(first.directory, 'raw/000001.jsonl'));
  controller.packet(sample(3), producer);
  assert.equal(hub.snapshot().transport_connected, true); assert.equal(hub.snapshot().frame.sequence, 3);
  assert.equal(hub.snapshot().frame.capture, undefined); assert.equal(controller.status().state, 'complete');
  const second = await controller.start(); assert.notEqual(first.session_id, second.session_id);
  controller.packet(sample(4), producer); await controller.stop();
  assert.equal((await inspectSession(second.directory)).frames, 1);
  assert.deepEqual(fs.readFileSync(path.join(first.directory, 'raw/000001.jsonl')), firstBytes);
  assert.equal(controller.status().connections, 1);
  await controller.shutdown(); await assert.rejects(controller.start(), /shutting down/);
});

test('start waits for an in-progress finalization, preventing overlapping sessions and late writes to closed files', async t => {
  const hub = createTelemetryHub(), root = temp(t); let release, notifyClose;
  const gate = new Promise(resolve => release = resolve), entered = new Promise(resolve => notifyClose = resolve);
  const controller = createLanCaptureController({ hub, root, makeSession(options) {
    const session = createCaptureSession(options);
    return { ...session, close(reason) { notifyClose(); return gate.then(() => session.close(reason)); } };
  } });
  const producer = meta(); controller.connected(producer); const first = await controller.start(); controller.packet(sample(1), producer);
  const stop = controller.stop(); await entered; const start = controller.start();
  assert.equal(controller.status().state, 'stopping'); controller.packet(sample(2), producer); // Preview only during finalization.
  release(); await stop; const next = await start; assert.notEqual(next.session_id, first.session_id);
  controller.packet(sample(3), producer); await controller.shutdown();
  assert.equal((await inspectSession(first.directory)).frames, 1); assert.equal((await inspectSession(next.directory)).frames, 1);
});

test('capture controls require loopback host/origin and token; stop acknowledges only after files are finalized', async t => {
  const hub = createTelemetryHub(), controller = createLanCaptureController({ hub, root: temp(t) });
  const ui = await createViewerServer({ hub, port: 0, onStartCapture: () => controller.start(), onStopCapture: () => controller.stop() });
  t.after(() => ui.close()); t.after(() => controller.shutdown());
  let response = await fetch(ui.url + '/api/capture/start', { method: 'POST' }); assert.equal(response.status, 403);
  const state = await (await fetch(ui.url + '/api/state')).json();
  const headers = { 'X-Quest-Token': state.controls.token };
  response = await fetch(ui.url + '/api/capture/start', { method: 'POST', headers: { ...headers, Origin: 'https://example.org' } }); assert.equal(response.status, 403);
  const hostileHost = await new Promise((resolve, reject) => {
    const req = httpRequest(ui.url + '/api/capture/start', { method: 'POST', headers: { ...headers, Host: 'evil.example' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end();
  }); assert.equal(hostileHost, 403);
  response = await fetch(ui.url + '/api/capture/start', { method: 'POST', headers }); assert.equal(response.status, 200);
  const first = (await response.json()).recording, producer = meta(); controller.connected(producer); controller.packet(sample(1), producer);
  response = await fetch(ui.url + '/api/capture/stop', { method: 'POST', headers }); assert.equal(response.status, 200);
  assert.equal((await response.json()).recording.state, 'complete'); assert.equal((await inspectSession(first.directory)).integrity_ok, true);
  response = await fetch(ui.url + '/api/capture/start', { method: 'POST', headers }); assert.equal(response.status, 200);
  assert.notEqual((await response.json()).recording.session_id, first.session_id);
  await controller.stop(); assert.equal((await fetch(ui.url + '/api/state')).status, 200);
});

test('recording failure keeps preview alive and permits an explicit new session after storage recovers', async t => {
  let diskBroken = false;
  const io = { ...fs, writeSync(...args) { if (diskBroken) throw new Error('Simulated storage failure'); return fs.writeSync(...args); } };
  const hub = createTelemetryHub(), producer = meta();
  const controller = createLanCaptureController({ hub, root: temp(t), makeSession: options => createCaptureSession({ ...options, io }) });
  controller.connected(producer); const failed = await controller.start();
  diskBroken = true; assert.throws(() => controller.packet(sample(1), producer), /storage failure/);
  await controller.stop(); assert.equal(controller.status().state, 'failed'); assert.equal(hub.snapshot().transport_connected, true);
  diskBroken = false; controller.packet(sample(2), producer); assert.equal(hub.snapshot().frame.sequence, 2);
  const recovered = await controller.start(); assert.notEqual(recovered.session_id, failed.session_id);
  controller.packet(sample(3), producer); await controller.shutdown();
  assert.equal((await inspectSession(recovered.directory)).integrity_ok, true);
});
