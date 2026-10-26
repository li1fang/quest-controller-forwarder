import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ObservationProbe, parseObservationOptions, sanitizeSnapshot, runObservation } from './wireless-observer.mjs';

// Simulated discovery and state fixtures stay in tests; they never enter the live viewer.
const serial = 'TEST-QUEST';
const snapshot = () => ({ device_serial: serial, boot_id: '11111111-1111-1111-1111-111111111111', boot_completed: '1', adb_wifi_enabled: '0', wifi: { connected: true, bssid_sha256: 'a'.repeat(64), trusted_aps: [] }, power: { wakefulness: 'Asleep' } });
function fixture(options = {}) {
  let time = 100000;
  const state = { devices: '', services: '' }, reads = [], snapshots = [];
  const probe = new ObservationProbe({ serial, now: () => time,
    globalRead: async args => {
      reads.push(args);
      if (args.join(' ') === 'devices -l') return state.devices;
      if (args.join(' ') === 'mdns services') return state.services;
      throw new Error('Observer attempted an unapproved command');
    }, readSnapshot: async target => { snapshots.push(target); return snapshot(); }, ...options });
  return { probe, state, reads, snapshots, advance(ms = 2000) { time += ms; } };
}

test('observer automatically waits through missing, unauthorized and offline USB then samples recovery', async () => {
  const f = fixture();
  assert.equal((await f.probe.poll()).phase, 'waiting_device');
  f.state.devices = `${serial} unauthorized`;
  assert.equal((await f.probe.poll()).phase, 'unauthorized');
  f.state.devices = `${serial} device product:test`;
  assert.equal((await f.probe.poll()).phase, 'device_readable');
  f.advance(); f.state.devices = `${serial} offline`;
  assert.equal((await f.probe.poll()).phase, 'offline');
  f.state.devices = `${serial} device`; f.advance();
  assert.equal((await f.probe.poll()).phase, 'device_readable');
  assert.deepEqual(f.snapshots, [serial, serial]);
  assert.ok(f.reads.every(args => ['devices -l','mdns services'].includes(args.join(' '))));
});

test('wireless observation follows changed advertised TLS ports without connecting or falling back to USB', async () => {
  const f = fixture({ transport: 'wifi' });
  f.state.services = `adb-${serial}-abc _adb-tls-connect._tcp 192.168.1.2:40001\nadb-OTHER-xyz _adb-tls-connect._tcp 192.168.1.3:40002\nadb-${serial}-abc _adb._tcp 192.168.1.2:5555`;
  f.state.devices = `${serial} device\n192.168.1.2:40001 device\n192.168.1.3:40002 device`;
  const first = await f.probe.poll();
  assert.equal(first.selected_target, '192.168.1.2:40001');
  assert.deepEqual(first.tls_advertisements, ['192.168.1.2:40001']);
  assert.equal(JSON.stringify(first).includes('192.168.1.3'), false);
  f.state.services = `adb-${serial}-abc _adb-tls-connect._tcp. 192.168.1.2:45001`;
  f.state.devices = `${serial} device\n192.168.1.2:45001 device`;
  assert.equal((await f.probe.poll()).selected_target, '192.168.1.2:45001');
  assert.deepEqual(f.snapshots, ['192.168.1.2:40001','192.168.1.2:45001']);
});

test('PC-only observation never invokes a device snapshot or treats advertisements as verified connectivity', async () => {
  const f = fixture({ mode: 'pc-only' }); f.state.devices = `${serial} device`;
  const result = await f.probe.poll();
  assert.equal(result.phase, 'pc_observation_only'); assert.equal(result.snapshot, undefined);
  assert.equal(f.snapshots.length, 0);
  f.state.devices = ''; f.state.services = `adb-${serial}-abc _adb-tls-connect._tcp 192.168.1.2:40001`;
  assert.equal((await f.probe.poll()).phase, 'waiting_device');
});

test('device snapshots are paced; stale identity or process errors cannot leak raw output', async () => {
  const f = fixture(); f.state.devices = `${serial} device`;
  await f.probe.poll(); f.advance(); await f.probe.poll();
  assert.equal(f.snapshots.length, 1);
  f.probe.readSnapshot = async () => { throw new Error('PRIVATE-FIXTURE-DO-NOT-LOG'); };
  f.advance(10000); const error = await f.probe.poll();
  assert.equal(error.phase, 'snapshot_unavailable'); assert.equal(JSON.stringify(error).includes('PRIVATE-FIXTURE'), false);
  f.probe.readSnapshot = async () => ({ ...snapshot(), device_serial: 'OTHER' }); f.advance(10000);
  assert.equal((await f.probe.poll()).phase, 'wrong_device');
});

test('snapshot whitelist discards host keys, raw network names and unexpected diagnostic fields', () => {
  const data = snapshot();
  data.user_keys = 'PRIVATE-FIXTURE'; data.wifi.ssid = 'PRIVATE-FIXTURE';
  data.wifi.trusted_aps = [{ bssid_sha256: 'b'.repeat(64), raw_bssid: 'PRIVATE-FIXTURE' }];
  data.power.wakefulness = 'PRIVATE-FIXTURE';
  data.uptime = '123.45 678.90';
  const safe = sanitizeSnapshot(data, serial);
  assert.equal(JSON.stringify(safe).includes('PRIVATE-FIXTURE'), false);
  assert.equal(safe.wifi.bssid_sha256, 'a'.repeat(64)); assert.equal(safe.power.wakefulness, null);
  assert.equal(safe.device_uptime_seconds, 123.45);
});

test('observer validates input and refuses to overwrite existing evidence before running ADB', async t => {
  for (const args of [[], ['--serial'], ['--serial',serial,'--duration','0'], ['--serial',serial,'--interval','0.1'], ['--serial',serial,'--mode','active'], ['--serial',serial,'--reboot']]) assert.throws(() => parseObservationOptions(args));
  assert.equal(parseObservationOptions(['--serial',serial,'--mode','pc-only']).mode, 'pc-only');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'quest-observer-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('quest-observer-test-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const output = path.join(directory, 'keep.jsonl'); await fs.writeFile(output, 'keep');
  await assert.rejects(runObservation({ ...parseObservationOptions(['--serial',serial,'--mode','pc-only']), adb: process.execPath, out: output }), { code: 'EEXIST' });
  assert.equal(await fs.readFile(output, 'utf8'), 'keep');
});
