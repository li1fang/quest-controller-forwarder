import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { once } from 'node:events';
import { createReceiver } from './receiver.mjs';
import { createTelemetryHub, createViewerServer } from './viewer-server.mjs';
import { deriveView, recordingPresentation } from '../web/state.js';

test('recording feedback separates disk completion, tracking, disconnects and shutdown', () => {
  assert.equal(recordingPresentation({ state: 'recording' }).state, 'recording');
  assert.equal(recordingPresentation({ state: 'stopping' }).state, 'stopping');
  assert.equal(recordingPresentation({ state: 'complete' }).state, 'complete');
  assert.match(recordingPresentation({ state: 'complete' }).detail, /不代表追踪质量通过/);
  assert.match(recordingPresentation({ state: 'complete' }, { connected: false }).title, /待确认/);
  assert.match(recordingPresentation({ state: 'recording' }, { connected: false }).title, /待确认/);
  assert.equal(recordingPresentation({ state: 'failed', error: 'disk error' }).detail, 'disk error');
  assert.equal(recordingPresentation({ state: 'complete', stop_reason: 'low_disk_space' }).state, 'warning');
  assert.match(recordingPresentation(null).title, /未在录制/);
  assert.match(recordingPresentation(null, { testView: true }).detail, /五分钟/);
  assert.match(recordingPresentation(null, { stopped: true, connected: false }).detail, /等待 App 释放/);
});

test('dedicated test page has an explicit title, unsaved-preview warning and one named recording action', async t => {
  const hub = createTelemetryHub(), ui = await createViewerServer({ hub, port: 0 }); t.after(() => ui.close());
  const response = await fetch(ui.url + '/test'); assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>Quest · 正式测试与录制<\/title>/); assert.match(html, /<body data-view="test">/);
  assert.match(html, /实时动作不会自动保存/); assert.match(html, /开始 5 分钟测试并录制/);
  assert.match(html, /class="capture-actions"/);
  const style = await fetch(ui.url + '/workbench.css');
  assert.equal(style.status, 200); assert.match(style.headers.get('content-type'), /text\/css/);
  assert.match(await (await fetch(ui.url + '/')).text(), /<body>/);
  assert.equal((await fetch(ui.url + '/test', { headers: { Origin: 'https://example.org' } })).status, 403);
});

// Protocol fixtures only; the actual browser QA uses the user's recorded hardware data.
function frame(sequence = 1) {
  const hand = () => ({ pose_active: true, position_valid: true, orientation_valid: true,
    position_tracked: true, orientation_tracked: true, position_m: [0.1, -0.2, -0.3], orientation_xyzw: [0, 0, 0, 1],
    linear_velocity_valid: true, angular_velocity_valid: true, linear_velocity_m_s: [1, 0, 0], angular_velocity_rad_s: [0, 1, 0],
    trigger: 0.6, squeeze: 0.3, thumbstick: [0.2, -0.5], buttons: { x: true, y: false, menu: null } });
  return { schema: 'quest-usb-v1', kind: 'frame', sequence, device_monotonic_ns: String(1000000000n + BigInt(sequence)),
    session_state: 'focused', focused: true, left: hand(), right: hand() };
}
function snapshot(packet = frame()) {
  return { source: { mode: 'live' }, transport_connected: true, frame_received_at_ms: 1000,
    server_time_ms: 1050, frame_rate_hz: 72, frame: packet, status: null };
}

test('only valid, actively tracked poses receive a 6DoF label', () => {
  assert.equal(deriveView(snapshot()).left.key, 'tracked');
  const packet = frame(); packet.left.position_tracked = false;
  const view = deriveView(snapshot(packet));
  assert.equal(view.left.key, 'inferred');
  assert.equal(view.left.visible, true);
  assert.equal(view.tone, 'warning');
  assert.doesNotMatch(view.label, /双手 6DoF/);
});

test('stale data and browser disconnect clear poses AND button states', () => {
  for (const view of [deriveView(snapshot(), 1001), deriveView(snapshot(), 0, false)]) {
    assert.equal(view.left.visible, false);
    assert.equal(view.right.visible, false);
    assert.equal(view.left.hand, null);
    assert.equal(view.right.hand, null);
    assert.equal(view.frame, null);
  }
});

test('losing focus, sleeping controllers and invalid quaternions never render a live pose', () => {
  let packet = frame(); packet.focused = false;
  assert.equal(deriveView(snapshot(packet)).left.visible, false);
  packet = frame(); packet.left.pose_active = false;
  assert.equal(deriveView(snapshot(packet)).left.hand, null);
  packet = frame(); packet.left.orientation_xyzw = [0, 0, 0, 0];
  assert.equal(deriveView(snapshot(packet)).left.visible, false);
});

test('replay completion and XR error have distinct, truthful status messages', () => {
  const ended = snapshot(); ended.source = { mode: 'replay', phase: 'ended' }; ended.transport_connected = false;
  assert.equal(deriveView(ended).label, '回放已结束');
  const error = snapshot(); error.frame = null; error.status = { state: 'error', message: 'XR failure' };
  assert.equal(deriveView(error).label, '采集发生错误');
  assert.equal(deriveView(error).hint, 'XR failure');
});

test('reconnect and status transitions cannot resurrect a previous frame', () => {
  let now = 1000;
  const hub = createTelemetryHub({ now: () => now });
  hub.connected(); hub.packet(frame());
  assert.equal(hub.snapshot().frame_rate_hz, 1);
  now += 1001;
  assert.equal(hub.snapshot().frame_rate_hz, 0);
  hub.disconnected();
  assert.equal(hub.snapshot().frame, null);
  hub.connected();
  assert.equal(hub.snapshot().connection_id, 2);
  assert.equal(hub.snapshot().frame, null);
  hub.packet(frame(2));
  hub.packet({ kind: 'status', state: 'idle' });
  assert.equal(hub.snapshot().frame, null);
  assert.equal(hub.snapshot().status.state, 'idle');
});

test('loopback HTTP serves local assets and rejects file access, writes, hostile origins and hosts', async t => {
  const hub = createTelemetryHub();
  const ui = await createViewerServer({ hub, port: 0 });
  t.after(() => ui.close());
  const index = await fetch(ui.url);
  assert.match(await index.text(), /手柄观测台/);
  for (const asset of ['/app.js', '/scene.js', '/state.js', '/style.css', '/vendor/three.module.js', '/vendor/three.core.js', '/vendor/OrbitControls.js']) {
    assert.equal((await fetch(ui.url + asset)).status, 200, asset);
  }
  assert.equal((await fetch(ui.url + '/README.md')).status, 404);
  assert.equal((await fetch(ui.url + '/%2e%2e/app/main.cpp')).status, 404);
  assert.equal((await fetch(ui.url + '/api/state', { method: 'POST' })).status, 405);
  assert.equal((await fetch(ui.url + '/api/state', { headers: { Origin: 'https://unrelated.example' } })).status, 403);
  const hostileHostStatus = await new Promise((resolve, reject) => {
    const request = http.get(ui.url + '/api/state', { headers: { Host: 'unrelated.example' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
  });
  assert.equal(hostileHostStatus, 403);
  const state = await (await fetch(ui.url + '/api/state')).json();
  assert.equal(state.transport_connected, false);
  assert.equal(state.frame, null);
  assert.equal(state.source.mode, 'live');
});

test('actual TCP -> validation -> SSE -> browser state preserves orientation, velocity and buttons', async t => {
  const hub = createTelemetryHub();
  const receiver = await createReceiver({ port: 0, onPacket: hub.packet, onConnection: hub.connected, onDisconnect: hub.disconnected });
  const ui = await createViewerServer({ hub, port: 0 });
  t.after(async () => { await receiver.close(); await ui.close(); });
  const abort = new AbortController();
  const response = await fetch(ui.url + '/events', { signal: abort.signal });
  const reader = response.body.getReader();
  t.after(() => { abort.abort(); });
  const socket = net.connect(receiver.port, '127.0.0.1');
  await once(socket, 'connect');
  const packet = frame(7), line = JSON.stringify(packet) + '\n';
  socket.write(line.slice(0, 30)); socket.write(line.slice(30));
  let data = '', result;
  const timeout = setTimeout(() => abort.abort(), 3000);
  try {
    while (!result) {
      const { value, done } = await reader.read();
      if (done) throw new Error('SSE ended before telemetry arrived');
      data += Buffer.from(value).toString('utf8');
      let index;
      while ((index = data.indexOf('\n\n')) >= 0) {
        const event = data.slice(0, index); data = data.slice(index + 2);
        const parsed = JSON.parse(event.slice(6));
        if (parsed.frame?.sequence === 7) result = parsed;
      }
    }
  } finally { clearTimeout(timeout); await reader.cancel(); }
  assert.deepEqual(result.frame.left.orientation_xyzw, [0, 0, 0, 1]);
  assert.deepEqual(result.frame.right.linear_velocity_m_s, [1, 0, 0]);
  assert.equal(result.frame.left.buttons.x, true);
  assert.equal(deriveView(result).left.key, 'tracked');
  socket.end(); await once(socket, 'close');
});
