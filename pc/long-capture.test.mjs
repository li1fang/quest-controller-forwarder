import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCaptureSession } from './capture-session.mjs';
import { inspectSession } from './inspect-session.mjs';
import { createLanCaptureController } from './lan-capture-controller.mjs';
import { createTelemetryHub, createViewerServer } from './viewer-server.mjs';
import { createStorageGuard, readStorageStatus, MIN_FREE_BYTES } from './storage-status.mjs';
import { formatRecordingDuration, formatStorageBytes, validationPanelVisible } from '../web/state.js';

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quest-long-test-'));
  t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('quest-long-test-')); fs.rmSync(root, { recursive: true, force: true }); });
  return root;
}
test('manual capture has no five-minute cutoff, reports monotonic elapsed time and finalizes events without loading the event log', async t => {
  let now = 0n;
  const io = { ...fs, readFileSync() { throw new Error('Whole-file reads are forbidden in the recorder'); } };
  const capture = createCaptureSession({ root: temporary(t), io, monotonic: () => now });
  now = 8n * 3600n * 1000000000n;
  capture.event('synthetic_clock_advanced'); capture.checkpoint();
  assert.equal(capture.status().state, 'recording'); assert.equal(capture.status().elapsed_s, 28800);
  const stopped = capture.close(); now *= 2n;
  assert.equal(stopped.state, 'complete'); assert.equal(capture.status().elapsed_s, 28800);
  assert.equal(stopped.stop_reason, 'user_stop');
  assert.equal((await inspectSession(capture.directory)).integrity_ok, true);
});
test('low space rejects a new session without creating files, auto-finalizes an active session once, and retains preview for recovery', async t => {
  const root = path.join(temporary(t), 'captures'), hub = createTelemetryHub();
  let state = 'low', stops = 0, guard;
  const captures = createLanCaptureController({ hub, root, beforeStart: () => guard.beforeStart() });
  guard = createStorageGuard({ timers: false, read: () => ({ state, available_bytes: state === 'ready' ? 1024 ** 3 : 1, reserve_bytes: MIN_FREE_BYTES }),
    onStatus: hub.storage, isRecording: () => captures.status().state === 'recording', stop: reason => { ++stops; return captures.stop(reason); } });
  t.after(() => guard.close());
  await assert.rejects(captures.start(), error => error.statusCode === 507);
  assert.equal(fs.existsSync(root), false); assert.equal(captures.status().state, 'idle');
  state = 'ready'; const first = await captures.start();
  state = 'low'; await Promise.all([guard.tick(), guard.tick()]);
  assert.equal(stops, 1); assert.equal(captures.status().stop_reason, 'low_disk_space');
  assert.equal((await inspectSession(first.directory)).integrity_ok, true);
  const original = fs.readFileSync(path.join(first.directory, 'manifest.json'));
  await assert.rejects(captures.start(), /space/);
  state = 'ready'; const second = await captures.start(); await captures.shutdown();
  assert.notEqual(first.session_id, second.session_id); assert.deepEqual(fs.readFileSync(path.join(first.directory, 'manifest.json')), original);
  assert.equal(readStorageStatus(root).state, 'ready');
});
test('daily capture exposes manual controls separately from validation and reports a safe low-space rejection', async t => {
  const hub = createTelemetryHub(); let starts = 0;
  const ui = await createViewerServer({ hub, port: 0, onStartCapture() { ++starts; throw Object.assign(new Error('space'), { statusCode: 507 }); },
    onStopCapture() {}, onStartValidation() { throw new Error('Daily capture must not start validation'); } });
  t.after(() => ui.close());
  const html = await (await fetch(ui.url + '/capture')).text();
  assert.match(html, /<body data-view="capture">/); assert.match(html, /日常采集（无固定时长）/);
  const s = await (await fetch(ui.url + '/api/state')).json();
  const r = await fetch(ui.url + '/api/capture/start', { method: 'POST', headers: { 'x-quest-token': s.controls.token } });
  assert.equal(r.status, 507); assert.match((await r.json()).error, /磁盘/); assert.equal(starts, 1);
  assert.equal(validationPanelVisible('capture', { phase: 'idle' }, true), false);
  assert.equal(validationPanelVisible(undefined, { phase: 'complete' }, true), false);
  assert.equal(validationPanelVisible('test', { phase: 'idle' }, true), true);
  assert.equal(validationPanelVisible('capture', { phase: 'measuring' }, true), true);
  assert.equal(formatRecordingDuration(360001), '100:00:01');
  assert.equal(formatStorageBytes(1024 ** 3), '1.00 GiB');
});
test('storage-guard shutdown never blocks service cleanup when a stop operation fails', async () => {
  const guard = createStorageGuard({ timers: false, read: () => ({ state: 'low' }), isRecording: () => true, stop: () => { throw new Error('synthetic disk error'); } });
  const stopping = guard.tick(); await assert.doesNotReject(guard.close()); await assert.rejects(stopping, /synthetic disk error/);
});
