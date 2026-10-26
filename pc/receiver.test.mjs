import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { Writable } from 'node:stream';
import { createLineParser, createReceiver, validatePacket, parseOptions } from './receiver.mjs';

// Synthetic protocol fixtures are confined to tests; the application has no fake-data mode.
function sample(sequence = 1) {
  const hand = () => ({ pose_active: true, position_valid: true, orientation_valid: true,
    position_tracked: true, orientation_tracked: true, position_m: [0.12, 0.34, -0.56], orientation_xyzw: [0, 0, 0, 1],
    linear_velocity_valid: true, angular_velocity_valid: true, linear_velocity_m_s: [1, 2, 3], angular_velocity_rad_s: [0, 1, 0],
    trigger: 0.5, squeeze: 0, thumbstick: [0, -0.2], buttons: { x: false, y: true, menu: null } });
  return { schema: 'quest-usb-v1', kind: 'frame', sequence, device_monotonic_ns: '123456789012345678', focused: true,
    session_state: 'focused', reference_space: 'local', left: hand(), right: hand() };
}

async function removeTestDirectory(directory) {
  const resolved = path.resolve(directory);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('quest-usb-test-'));
  await fs.rm(resolved, { recursive: true, force: true });
}

test('NDJSON handles arbitrary TCP fragments, multiple lines and 64-bit timestamp strings', () => {
  const packets = [], errors = [];
  const parser = createLineParser(packet => packets.push(packet), error => errors.push(error));
  const data = Buffer.from(JSON.stringify(sample(1)) + '\n' + JSON.stringify(sample(2)) + '\n');
  for (let offset = 0; offset < data.length; offset += 7) parser.push(data.subarray(offset, offset + 7));
  parser.end();
  assert.deepEqual(packets.map(packet => packet.sequence), [1, 2]);
  assert.equal(packets[0].device_monotonic_ns, '123456789012345678');
  assert.equal(errors.length, 0);
});

test('malformed packets are rejected without losing the next complete packet', () => {
  const packets = [], errors = [];
  const parser = createLineParser(packet => packets.push(packet), error => errors.push(error));
  parser.push(Buffer.from('{broken}\n{"schema":"unknown"}\n' + JSON.stringify(sample()) + '\n'));
  assert.equal(errors.length, 2);
  assert.equal(packets.length, 1);
});

test('oversized and truncated lines are reported', () => {
  const errors = [];
  const parser = createLineParser(() => assert.fail('Oversized line accepted'), (error, fatal) => errors.push({ error, fatal }), 16);
  parser.push(Buffer.from('x'.repeat(17)));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].fatal, true);
  const truncated = createLineParser(() => assert.fail('Partial line accepted'), error => errors.push({ error }));
  truncated.push(Buffer.from('{"schema":'));
  truncated.end();
  assert.equal(errors.length, 2);
});

test('inactive or unfocused pose cannot be mistaken for valid live data', () => {
  const packet = sample();
  packet.focused = false;
  assert.throws(() => validatePacket(packet), /Inactive/);
  for (const hand of [packet.left, packet.right]) {
    hand.pose_active = false;
    for (const key of ['position_valid', 'orientation_valid', 'linear_velocity_valid', 'angular_velocity_valid', 'position_tracked', 'orientation_tracked']) hand[key] = false;
    for (const key of ['position_m', 'orientation_xyzw', 'linear_velocity_m_s', 'angular_velocity_rad_s']) hand[key] = null;
  }
  assert.equal(validatePacket(packet), packet);
});

test('invalid vectors, nonfinite numbers and stale values behind false validity flags are rejected', () => {
  const packet = sample();
  packet.left.position_m = [NaN, 0, 0];
  assert.throws(() => validatePacket(packet), /position_m/);
  packet.left.position_m = [0, 0, 0];
  packet.left.position_valid = false;
  assert.throws(() => validatePacket(packet), /position_m/);
  packet.left.position_m = null;
  packet.right.orientation_xyzw = [0, 0, 1];
  assert.throws(() => validatePacket(packet), /orientation_xyzw/);
});

test('status packets can report XR initialization failures', () => {
  const packet = { schema: 'quest-usb-v1', kind: 'status', sequence: 1, device_monotonic_ns: '123', state: 'error', message: 'xrCreateSession failed' };
  assert.equal(validatePacket(packet), packet);
});

test('CLI rejects missing values, unknown flags, and invalid durations', () => {
  assert.throws(() => parseOptions(['--record']), /Missing/);
  assert.throws(() => parseOptions(['--duration', '-1']), /positive/);
  assert.throws(() => parseOptions(['--port', '70000']), /port/);
  assert.throws(() => parseOptions(['--simulate']), /Unknown/);
  assert.equal(parseOptions(['--json', '--duration', '3']).duration, 3);
});

test('real TCP receiver records only validated packets and accepts a new connection after disconnect', { timeout: 10000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'quest-usb-test-'));
  let receiver;
  t.after(async () => { await receiver?.close(); await removeTestDirectory(directory); });
  const recording = path.join(directory, 'capture.jsonl');
  const packets = [], errors = [];
  let notify;
  const nextPacket = () => new Promise(resolve => { notify = resolve; });
  receiver = await createReceiver({ port: 0, record: recording, onPacket: packet => { packets.push(packet); notify?.(); }, onError: error => errors.push(error) });
  let socket = net.connect(receiver.port, '127.0.0.1');
  await once(socket, 'connect');
  let arrival = nextPacket();
  const data = JSON.stringify(sample(1)) + '\n';
  socket.write(data.slice(0, 20)); socket.write(data.slice(20));
  await arrival;
  assert.ok(packets[0].received_at_utc);
  assert.match(packets[0].pc_monotonic_ns, /^\d+$/);
  socket.end(); await once(socket, 'close');
  // Let the server's close callback remove the old producer before reconnecting.
  await new Promise(resolve => setTimeout(resolve, 20));
  socket = net.connect(receiver.port, '127.0.0.1');
  await once(socket, 'connect');
  arrival = nextPacket(); socket.write(JSON.stringify(sample(2)) + '\n'); await arrival;
  socket.end(); await once(socket, 'close');
  assert.equal(errors.length, 0);
  await receiver.close();
  const lines = (await fs.readFile(recording, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map(packet => packet.sequence), [1, 2]);
});

test('receiver close waits for delayed stream resource release and is idempotent', { timeout: 5000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'quest-usb-test-'));
  let receiver, released = false;
  t.after(async () => { await receiver?.close(); await removeTestDirectory(directory); });
  receiver = await createReceiver({ port: 0, record: path.join(directory, 'memory.jsonl') }, {
    createRecording() {
      const output = new Writable({ write(chunk, encoding, callback) { callback(); },
        destroy(error, callback) { setTimeout(() => { released = true; callback(error); }, 30); } });
      queueMicrotask(() => output.emit('open')); return output;
    },
  });
  await Promise.all([receiver.close(), receiver.close()]);
  assert.equal(released, true);
});

test('an existing recording is preserved', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'quest-usb-test-'));
  t.after(() => removeTestDirectory(directory));
  const recording = path.join(directory, 'existing.jsonl');
  await fs.writeFile(recording, 'keep this');
  await assert.rejects(createReceiver({ port: 0, record: recording }), /EEXIST/);
  assert.equal(await fs.readFile(recording, 'utf8'), 'keep this');
});

test('a TCP burst and slow recording keep one drain listener and preserve every frame', { timeout: 3000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'quest-usb-test-'));
  let receiver, stream, maxDrainListeners = 0, resolvePackets, resolveDisconnect;
  const packets = [], written = [];
  const arrival = new Promise(resolve => { resolvePackets = resolve; });
  const disconnected = new Promise(resolve => { resolveDisconnect = resolve; });
  t.after(async () => { await receiver?.close(); await removeTestDirectory(directory); });
  receiver = await createReceiver({ port: 0, record: path.join(directory, 'slow.jsonl'),
    onPacket: packet => { packets.push(packet); if (packets.length === 100) resolvePackets(); }, onDisconnect: resolveDisconnect }, {
    createRecording() {
      stream = new Writable({ highWaterMark: 1, write(chunk, encoding, callback) { written.push(String(chunk)); setTimeout(callback, 1); } });
      stream.on('newListener', name => { if (name === 'drain') maxDrainListeners = Math.max(maxDrainListeners, stream.listenerCount(name) + 1); });
      queueMicrotask(() => stream.emit('open'));
      return stream;
    },
  });
  const socket = net.connect(receiver.port, '127.0.0.1');
  await once(socket, 'connect');
  socket.write(Array.from({ length: 100 }, (_, index) => JSON.stringify(sample(index + 1)) + '\n').join(''));
  await arrival; socket.end(); await disconnected; await receiver.close();
  assert.equal(maxDrainListeners, 1);
  assert.equal(stream.listenerCount('drain'), 0);
  assert.equal(packets.length, 100);
  assert.deepEqual(written.map(line => JSON.parse(line).sequence), Array.from({ length: 100 }, (_, index) => index + 1));
});
