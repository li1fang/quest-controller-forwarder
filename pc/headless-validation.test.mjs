import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHeadlessValidation } from './headless-validation.mjs';
import { createLanCaptureController } from './lan-capture-controller.mjs';
import { createTelemetryHub, createViewerServer } from './viewer-server.mjs';
import { inspectSession } from './inspect-session.mjs';

// Synthetic fixtures stay in isolated tests and never enter the live UI/receiver.
const conditions = { usb_disconnected: true, headset_removed: true, proximity: 'covered' };
function frame(sequence, time, edit = () => {}) {
  const hand = () => ({ pose_active: true, position_valid: true, orientation_valid: true, position_tracked: true, orientation_tracked: true,
    position_m: [0, 0, 0], orientation_xyzw: [0, 0, 0, 1], linear_velocity_valid: true, angular_velocity_valid: true,
    linear_velocity_m_s: [0, 0, 0], angular_velocity_rad_s: [0, 0, 0], trigger: 0, squeeze: 0, thumbstick: [0, 0],
    buttons: { x: false, y: false, menu: false, a: false, b: false, a_touch: false, thumbstick_click: false } });
  const packet = { schema: 'quest-usb-v1', kind: 'frame', sequence, device_monotonic_ns: String(BigInt(time + 1) * 1_000_000n),
    focused: true, session_state: 'focused', reference_space_changes: 0, left: hand(), right: hand() };
  edit(packet); return packet;
}
function setup(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quest-headless-test-')), hub = createTelemetryHub();
  const captures = createLanCaptureController({ hub, root, source: { test_fixture: true } });
  let time = 0, seq = 0, producer = { app_run_id: randomUUID(), connection_id: randomUUID() };
  const validation = createHeadlessValidation({ captures, onUpdate: hub.validation, now: () => time, durationMs: 1000,
    readyMs: 100, warmupMs: 500, timers: false, ...options });
  captures.connected(producer);
  t.after(async () => {
    await validation.close(); await captures.shutdown();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('quest-headless-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, hub, captures, validation, advance(ms) { time += ms; }, setProducer(value) { producer = value; captures.connected(producer); },
    packet(edit) { const packet = frame(++seq, time, edit); validation.packet(captures.packet(packet, producer), producer); return packet; } };
}

test('physical conditions must be explicitly declared; an existing recording is preserved', async t => {
  const s = setup(t);
  await assert.rejects(s.validation.start({ ...conditions, usb_disconnected: false }), { statusCode: 400 });
  await assert.rejects(s.validation.start({ ...conditions, headset_removed: false }), { statusCode: 400 });
  await assert.rejects(s.validation.start({ ...conditions, proximity: '' }), { statusCode: 400 });
  assert.equal(fs.readdirSync(s.root).length, 0);
  const first = await s.captures.start();
  await assert.rejects(s.validation.start(conditions), { statusCode: 409 }); assert.equal(s.captures.status().session_id, first.session_id);
});

test('warmup is excluded, timer belongs to the PC, and auto-stop finalizes raw data plus a separate report', async t => {
  const s = setup(t); await s.validation.start(conditions);
  s.packet(); s.advance(50); s.packet(); assert.equal(s.validation.snapshot().phase, 'waiting_tracking');
  s.advance(50); s.packet(); assert.equal(s.validation.snapshot().phase, 'measuring');
  assert.equal(s.validation.snapshot().metrics.frames, 1); // The first two setup frames remain in raw, outside measurement.
  for (let i = 0; i < 19; ++i) { s.advance(50); s.packet(); }
  s.advance(50); await s.validation.tick();
  const result = s.validation.snapshot(); assert.equal(result.phase, 'complete'); assert.equal(result.elapsed_s, 1);
  assert.ok(Math.abs(result.metrics.longest_dual_6dof_s - .95) < 1e-9);
  const audit = await inspectSession(result.directory); assert.equal(audit.integrity_ok, true); assert.equal(audit.frames, 22);
  const report = JSON.parse(fs.readFileSync(path.join(result.directory, 'validation.json')));
  assert.equal(report.coverage_complete, false); assert.equal(report.conditions.source.includes('user_declaration'), true);
  const manifest = JSON.parse(fs.readFileSync(path.join(result.directory, 'manifest.json')));
  assert.equal(manifest.source.validation.conditions.proximity, 'covered');
  const events = fs.readFileSync(path.join(result.directory, 'events.jsonl'), 'utf8');
  assert.match(events, /headless_measurement_started/); assert.match(events, /headless_measurement_ended/);
});

test('one untracked hand never arms the timer and preparation timeout is not a completed measurement', async t => {
  const s = setup(t); await s.validation.start(conditions);
  for (let i = 0; i < 6; ++i) { s.packet(packet => { packet.left.position_tracked = false; }); s.advance(100); }
  await s.validation.tick();
  assert.equal(s.validation.snapshot().phase, 'timed_out'); assert.equal(s.validation.snapshot().elapsed_s, 0);
  assert.equal(s.validation.snapshot().metrics.frames, 0); assert.equal((await inspectSession(s.captures.status().directory)).integrity_ok, true);
});

test('touch is not a press, right-only movement does not cover left, and button coverage resets for another session', async t => {
  const s = setup(t, { readyMs: 0 }); await s.validation.start(conditions);
  s.packet(packet => { packet.right.buttons.a_touch = true; });
  const covered = id => s.validation.snapshot().metrics.coverage.find(item => item.id === id).done;
  assert.equal(covered('right.a'), false);
  s.advance(20); s.packet(packet => {
    packet.right.position_m = [.2, 0, 0]; packet.right.orientation_xyzw = [0, Math.sin(.3), 0, Math.cos(.3)];
    packet.right.linear_velocity_m_s = [.2, 0, 0]; packet.right.angular_velocity_rad_s = [0, .4, 0];
    packet.right.trigger = 1; packet.right.squeeze = .7; packet.right.thumbstick = [1, 1]; packet.right.buttons.a = true;
  });
  assert.equal(covered('right.a'), false); assert.equal(covered('right.position'), true); assert.equal(covered('left.position'), false);
  s.advance(20); s.packet(packet => { packet.right.thumbstick = [-1, -1]; });
  for (const key of ['position', 'rotation', 'velocity', 'trigger', 'squeeze', 'stick', 'a']) assert.equal(covered(`right.${key}`), true);
  await s.validation.finish(); await s.validation.start(conditions); assert.ok(s.validation.snapshot().metrics.coverage.every(item => !item.done));
});

test('stale telemetry, reference changes and App restarts break continuity rather than inflating the timer', async t => {
  const s = setup(t, { readyMs: 0, durationMs: 5000 }); await s.validation.start(conditions);
  s.packet(); s.advance(100); s.packet(); assert.equal(s.validation.snapshot().metrics.longest_dual_6dof_s, .1);
  s.advance(1200); s.validation.tick(); assert.equal(s.validation.snapshot().metrics.stale_episodes, 1);
  s.packet(); assert.equal(s.validation.snapshot().metrics.longest_dual_6dof_s, .1);
  s.validation.disconnected(); s.setProducer({ app_run_id: randomUUID(), connection_id: randomUUID() }); s.advance(100); s.packet();
  assert.equal(s.validation.snapshot().metrics.disconnects, 1); assert.equal(s.validation.snapshot().metrics.app_restarts, 1);
  s.advance(100); s.packet(packet => { packet.reference_space_changes = 1; });
  assert.equal(s.validation.snapshot().metrics.coordinate_changes, 2); assert.equal(s.validation.snapshot().metrics.longest_dual_6dof_s, .1);
});

test('guided API preserves token/origin guards, validates JSON and rejects oversized bodies before starting a recording', async t => {
  const s = setup(t), ui = await createViewerServer({ hub: s.hub, port: 0, onStartValidation: conditions => s.validation.start(conditions) });
  t.after(() => ui.close());
  const token = s.hub.snapshot().controls.token, endpoint = ui.url + '/api/validation/start';
  assert.equal((await fetch(endpoint, { method: 'POST' })).status, 403);
  const headers = { 'X-Quest-Token': token, 'Content-Type': 'application/json' };
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { ...headers, Origin: 'https://example.org' }, body: JSON.stringify(conditions) })).status, 403);
  assert.equal((await fetch(endpoint, { method: 'POST', headers, body: '{' })).status, 400);
  assert.equal((await fetch(endpoint, { method: 'POST', headers, body: 'x'.repeat(2049) })).status, 413);
  assert.equal((await fetch(endpoint, { method: 'POST', headers, body: '{}' })).status, 400);
  assert.equal(fs.readdirSync(s.root).length, 0);
  const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ ...conditions, duration_s: 0 }) });
  assert.equal(response.status, 200); assert.equal((await response.json()).validation.target_s, 1); // Duration is server-owned, not client supplied.
});

test('motion-only profile completes without button presses and preserves the declared physical conditions', async t => {
  const s = setup(t, { profile: 'motion_only', readyMs: 0 }); await s.validation.start(conditions);
  s.packet();
  for (let i = 0; i < 19; ++i) { s.advance(50); s.packet(packet => {
    for (const side of ['left', 'right']) {
      packet[side].position_m = [.2, 0, 0]; packet[side].orientation_xyzw = [0, Math.sin(.3), 0, Math.cos(.3)];
      packet[side].linear_velocity_m_s = [.2, 0, 0]; packet[side].angular_velocity_rad_s = [0, .4, 0];
    }
  }); }
  s.advance(50); await s.validation.tick();
  const result = s.validation.snapshot(); assert.equal(result.profile, 'motion_only'); assert.equal(result.phase, 'complete');
  assert.equal(result.metrics.coverage.length, 6); assert.ok(result.metrics.coverage.every(item => item.done));
  assert.equal(result.metrics.application_button_press_events, 0);
  const report = JSON.parse(fs.readFileSync(path.join(result.directory, 'validation.json')));
  assert.equal(report.coverage_complete, true); assert.equal(report.conditions.proximity, 'covered');
  const manifest = JSON.parse(fs.readFileSync(path.join(result.directory, 'manifest.json')));
  assert.equal(manifest.source.validation.profile, 'motion_only');
  assert.equal((await inspectSession(result.directory)).integrity_ok, true);
});

test('motion-only measurement auto-saves an interruption when XR stays idle while packets continue', async t => {
  const s = setup(t, { profile: 'motion_only', readyMs: 0, durationMs: 5000, stallMs: 1200 }); await s.validation.start(conditions);
  s.packet(); s.advance(100); s.packet();
  const producer = { app_run_id: 'unused', connection_id: 'unused' };
  // Reuse the real stream identity from the captured frame; these status heartbeats do not revive the pose stream.
  const captured = s.hub.snapshot().frame.capture;
  Object.assign(producer, { app_run_id: captured.app_run_id, connection_id: captured.connection_id });
  for (let i = 0; i < 3; ++i) {
    s.advance(400);
    const heartbeat = { schema: 'quest-usb-v1', kind: 'status', sequence: 3 + i, device_monotonic_ns: String(500_000_000n + BigInt(i) * 400_000_000n), state: 'idle' };
    s.validation.packet(s.captures.packet(heartbeat, producer), producer);
  }
  await s.validation.tick();
  const result = s.validation.snapshot(); assert.equal(result.phase, 'interrupted'); assert.equal(result.reason, 'pose_stream_stalled');
  assert.equal(result.metrics.last_xr_status, 'idle'); assert.equal(result.metrics.status_counts.idle, 3);
  assert.equal(result.metrics.disconnects, 0); assert.equal(result.metrics.longest_dual_6dof_s, .1);
  assert.equal((await inspectSession(result.directory)).integrity_ok, true);
});

test('motion-only metrics record accidental application buttons without requiring them as coverage', async t => {
  const s = setup(t, { profile: 'motion_only', readyMs: 0 }); await s.validation.start(conditions);
  s.packet(); s.advance(20); s.packet(packet => { packet.left.buttons.menu = true; });
  s.advance(20); s.packet(packet => { packet.left.buttons.menu = true; });
  s.advance(20); s.packet();
  const metrics = s.validation.snapshot().metrics; assert.equal(metrics.application_button_press_events, 1);
  assert.equal(metrics.application_button_presses['left.menu'], 1);
  assert.equal(metrics.coverage.some(item => item.key === 'menu'), false);
});

test('unsupported validation profiles are rejected before recording begins', () => {
  assert.throws(() => createHeadlessValidation({ profile: 'unknown' }), /Unknown validation profile/);
});
