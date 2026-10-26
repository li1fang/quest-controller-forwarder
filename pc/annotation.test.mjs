import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createCaptureSession } from './capture-session.mjs';
import { inspectSession } from './inspect-session.mjs';
import { loadAnnotationSession } from './annotation-session.mjs';
import { addAnnotation, editAnnotation, deleteAnnotation, restoreAnnotation, readAnnotations } from './annotate-session.mjs';
import { createAnnotationServer } from './annotation-server.mjs';
import { frameAtTime, selectionQuality, formatTime } from '../web/annotation-state.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quest-annotation-test-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('quest-annotation-test-')); fs.rmSync(root, { recursive: true, force: true }); });
  const capture = createCaptureSession({ root, chunkBytes: 1 }), meta = { app_run_id: randomUUID(), connection_id: randomUUID(), device_model: 'TEST FIXTURE' };
  const hand = tracked => ({ pose_active: true, position_valid: true, orientation_valid: true, position_tracked: tracked, orientation_tracked: true,
    position_m: [0, 1, -1], orientation_xyzw: [0, 0, 0, 1], linear_velocity_valid: true, angular_velocity_valid: true,
    linear_velocity_m_s: [1, 0, 0], angular_velocity_rad_s: [0, 1, 0], trigger: 0, squeeze: 0, thumbstick: [0, 0], buttons: { x: false } });
  const pose = (sequence, tracked = true, reference = 0) => ({ schema: 'quest-usb-v1', kind: 'frame', sequence, device_monotonic_ns: String(123456789012345678n + BigInt(sequence) * 14000000n),
    xr_time_ns: String(223456789012345678n + BigInt(sequence)), session_state: 'focused', focused: true, reference_space_changes: reference, left: hand(tracked), right: hand(true) });
  capture.connected(meta); capture.packet(pose(1), meta);
  capture.packet({ schema: 'quest-usb-v1', kind: 'status', sequence: 2, device_monotonic_ns: '123456789030000000', state: 'idle' }, meta);
  capture.packet(pose(3, false), meta); capture.packet(pose(4, true, 1), meta); capture.close();
  return capture;
}
const sourceHashes = directory => {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json')));
  return Object.fromEntries(['manifest.json', ...manifest.files.map(f => f.file)].map(name => [name, createHash('sha256').update(fs.readFileSync(path.join(directory, name))).digest('hex')]));
};
test('indexed replay preserves recorded times, status sample numbering, invalid flags and coordinate boundaries without writing', async t => {
  const capture = fixture(t), before = sourceHashes(capture.directory), annotationBytes = fs.readFileSync(path.join(capture.directory, 'annotations.json'));
  const model = await loadAnnotationSession(capture.directory);
  assert.equal(model.metadata.frame_count, 3); assert.equal(model.metadata.packet_count, 4);
  assert.deepEqual(model.metadata.index.map(row => row[1]), [1, 3, 4]);
  assert.deepEqual(model.metadata.index.map(row => row[2]), [0, 0, 1]);
  assert.deepEqual(model.metadata.index.map(row => row.slice(3)), [[1, 1], [0, 1], [1, 1]]);
  assert.equal(model.frames[0].device_monotonic_ns, '123456789026345678');
  assert.equal(model.frames[1].left.position_valid, true); assert.equal(model.frames[1].left.position_tracked, false);
  assert.equal(model.metadata.invalid_ranges[0].first_frame, 2);
  assert.deepEqual(sourceHashes(capture.directory), before); assert.deepEqual(fs.readFileSync(path.join(capture.directory, 'annotations.json')), annotationBytes);
});
test('inclusive annotations retain quality and hashes; edit, recoverable delete and restore never change raw data', async t => {
  const capture = fixture(t), before = sourceHashes(capture.directory), options = { directory: capture.directory, label: '手势 <文本>', side: 'left', start: 1, end: 3, notes: '人工标注' };
  const label = await addAnnotation(options);
  assert.equal(label.start_sample_id, capture.sessionId + ':1'); assert.equal(label.end_sample_id, capture.sessionId + ':3');
  assert.deepEqual(label.quality, { frames: 2, dual_6dof_frames: 1, left_tracked_frames: 1, right_tracked_frames: 2, status_packets: 1 });
  const edited = await editAnnotation({ ...options, id: label.id, label: '更正', end: 1 });
  assert.equal(edited.id, label.id); assert.equal(edited.created_at_utc, label.created_at_utc); assert.equal(edited.quality.frames, 1);
  const deleted = await deleteAnnotation({ directory: capture.directory, id: label.id });
  assert.equal(readAnnotations(capture.directory, capture.sessionId).annotations.length, 0);
  assert.equal(readAnnotations(capture.directory, capture.sessionId).deleted_annotations[0].annotation.label, '更正');
  const restored = await restoreAnnotation({ directory: capture.directory, deletion_id: deleted.deletion_id });
  assert.equal(restored.id, label.id); assert.equal(readAnnotations(capture.directory, capture.sessionId).annotations.length, 1);
  assert.deepEqual(sourceHashes(capture.directory), before); assert.equal((await inspectSession(capture.directory)).integrity_ok, true);
});
test('invalid endpoints, coordinate crossings, wrong document identity and changed source hashes reject before annotation writes', async t => {
  const capture = fixture(t), file = path.join(capture.directory, 'annotations.json'), original = fs.readFileSync(file);
  const common = { directory: capture.directory, label: 'test', start: 1 };
  await assert.rejects(addAnnotation({ ...common, end: 4 }), /crosses coordinate/);
  await assert.rejects(addAnnotation({ ...common, start: 2, end: 3 }), /endpoints/);
  await assert.rejects(addAnnotation({ ...common, notes: {} }), /Invalid annotation/);
  await assert.rejects(addAnnotation({ ...common, expectedRawFiles: [] }), /Source recording changed/);
  await assert.rejects(editAnnotation({ ...common, id: 'missing' }), /not found/);
  assert.deepEqual(fs.readFileSync(file), original);
  const wrong = JSON.parse(original); wrong.session_id = randomUUID(); fs.writeFileSync(file, JSON.stringify(wrong));
  await assert.rejects(addAnnotation(common), /identity/); assert.equal(fs.existsSync(path.join(capture.directory, 'annotations.lock')), false);
});
test('time seeking and inclusive selection preserve gaps, one-frame ranges and quality boundaries', () => {
  const index = [[0, 1, 0, 1, 1], [100, 2, 0, 0, 1], [2000, 4, 1, 1, 1]];
  assert.equal(frameAtTime(index, -1), 0); assert.equal(frameAtTime(index, 100), 1); assert.equal(frameAtTime(index, 1999), 1); assert.equal(frameAtTime(index, 9000), 2);
  assert.equal(selectionQuality(index, 0, 0).count, 1); assert.equal(selectionQuality(index, 0, 0).duration_ms, 0);
  assert.equal(selectionQuality(index, 0, 1).dual, 1); assert.equal(selectionQuality(index, 0, 2).crossSegment, true);
  assert.equal(selectionQuality(index, 1, 0), null); assert.equal(selectionQuality(index, 0, 3), null);
  assert.equal(formatTime(60001), '01:00.001');
});
test('annotation HTTP guards writes, bounds frame windows, persists across restart and serializes concurrent labels', { timeout: 20000 }, async t => {
  const capture = fixture(t), before = sourceHashes(capture.directory);
  let server = await createAnnotationServer({ directory: capture.directory, port: 0 }); t.after(() => server.close());
  const url = server.url, session = await (await fetch(url + '/api/session')).json();
  assert.equal(session.integrity_verified, true); assert.equal((await fetch(url + '/annotate')).status, 200);
  const html = await (await fetch(url)).text(); assert.match(html, /历史回放 · 非实时/); assert.match(html, /保存标注/);
  assert.equal((await fetch(url + '/api/frames?offset=0&limit=2')).status, 200);
  for (const query of ['offset=-1', 'offset=999999', 'limit=513', 'offset=1.2', 'offset=90071992547409999']) assert.equal((await fetch(url + '/api/frames?' + query)).status, 400);
  assert.equal((await fetch(url + '/api/session', { headers: { Origin: 'https://example.org' } })).status, 403);
  assert.equal((await fetch(url + '/api/annotation', { method: 'POST', body: '{}' })).status, 403);
  assert.equal((await fetch(url + '/.local/lan/receiver.json')).status, 404);
  assert.equal((await fetch(url + '/api/stop', { method: 'GET' })).status, 404);
  const headers = { 'Content-Type': 'application/json', 'X-Quest-Token': session.token };
  assert.equal((await fetch(url + '/api/annotation', { method: 'POST', headers, body: 'x'.repeat(8193) })).status, 413);
  assert.equal((await fetch(url + '/api/annotation', { method: 'POST', headers, body: '{' })).status, 400);
  const post = async body => { const response = await fetch(url + '/api/annotation', { method: 'POST', headers, body: JSON.stringify(body) }); return { status: response.status, ...(await response.json()) }; };
  assert.equal((await post({ action: 'add', label: 'crossing', start: 1, end: 4 })).status, 400);
  const results = await Promise.all(['一', '二', '三'].map(label => post({ action: 'add', label, start: 1, end: 1, directory: 'ignored-client-path' })));
  assert.ok(results.every(result => result.status === 201));
  assert.equal((await (await fetch(url + '/api/annotations')).json()).annotations.length, 3);
  await server.close(); server = await createAnnotationServer({ directory: capture.directory, port: 0 });
  assert.equal((await (await fetch(server.url + '/api/annotations')).json()).annotations.length, 3);
  assert.deepEqual(sourceHashes(capture.directory), before);
});
