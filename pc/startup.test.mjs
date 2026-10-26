import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { StartupController } from './startup.mjs';
import { createTelemetryHub, createViewerServer } from './viewer-server.mjs';
import { classifyAdbError, reverseTarget, createAdbClient } from './adb-client.mjs';
import { parseLaunchOptions, openLocalBrowser } from './launch-options.mjs';
import { startMonitor } from './start.mjs';
import { deriveView, startupSteps } from '../web/state.js';

// Simulated ADB and OpenXR data stay inside these tests, never the live UI.
function fixture(overrides = {}) {
  let time = 100000;
  const calls = [];
  const adb = { available: () => true, abort() {}, bind() {},
    async run(args) {
      calls.push(args);
      const command = args.join(' ');
      if (command === 'get-state') return 'device';
      if (command === 'get-serialno') return 'TEST-USB';
      if (command.startsWith('shell pm path')) return 'package:/data/app/~~test/test/base.apk';
      if (command.startsWith('shell pidof')) throw new Error('not running');
      if (command === 'reverse --list') return '';
      return '';
    }, ...overrides };
  const hub = createTelemetryHub({ now: () => time });
  const controller = new StartupController({ adb, hub, apk: path.join(os.tmpdir(), 'quest-absent-test.apk'), now: () => time, log: () => {} });
  return { controller, hub, adb, calls, advance(ms = 11000) { time += ms; } };
}
const launched = f => f.calls.filter(args => args.slice(0, 3).join(' ') === 'shell am start');
const hands = () => ({ pose_active: true, position_valid: true, orientation_valid: true, position_tracked: true,
  orientation_tracked: true, position_m: [0, 1, 0], orientation_xyzw: [0, 0, 0, 1] });
const frame = () => ({ kind: 'frame', focused: true, left: hands(), right: hands() });

test('ADB failures give actionable states without installing or starting an app', async () => {
  for (const [message, phase] of [['device unauthorized', 'unauthorized'], ['no devices/emulators found', 'waiting_usb'], ['more than one device/emulator', 'multiple_devices']]) {
    const f = fixture({ run: async () => { throw new Error(message); } });
    await f.controller.tick();
    assert.equal(f.hub.snapshot().startup.phase, phase);
    assert.equal(launched(f).length, 0);
  }
  const missing = fixture({ available: () => false });
  await missing.controller.tick();
  assert.equal(missing.hub.snapshot().startup.phase, 'adb_missing');
  assert.equal(missing.calls.length, 0);
});

test('offline transport recovery is bounded, and never kills the global ADB server', async () => {
  const f = fixture();
  const original = f.adb.run;
  f.adb.run = async args => { if (args[0] === 'get-state') throw new Error('device offline'); return original(args); };
  await f.controller.tick(); await f.controller.tick();
  assert.equal(f.calls.filter(args => args[0] === 'reconnect').length, 1);
  f.advance(16000); await f.controller.tick();
  assert.equal(f.calls.filter(args => args[0] === 'reconnect').length, 2);
  assert.equal(f.calls.some(args => args.includes('kill-server')), false);
});

test('launch success is not readiness; timeouts and success share a finite attempt budget', async () => {
  const f = fixture(); const original = f.adb.run;
  f.adb.run = async args => { const result = await original(args); if (args[2] === 'start') throw Object.assign(new Error('timed out'), { timedOut: true }); return result; };
  for (let i = 0; i < 5; i++) { await f.controller.tick(); f.advance(); }
  assert.equal(launched(f).length, 3);
  assert.equal(f.hub.snapshot().startup.phase, 'waiting_headset');
  assert.ok(launched(f)[2].includes('-S'));
  assert.equal(f.hub.snapshot().transport_connected, false);
});

test('sleeping hands, localization and an already-focused app never cause restart loops', async () => {
  const f = fixture(); await f.controller.tick(); f.hub.connected();
  const packet = frame(); packet.left.pose_active = false;
  f.hub.packet(packet); await f.controller.tick();
  assert.equal(f.hub.snapshot().startup.phase, 'waiting_hands');
  assert.match(f.hub.snapshot().startup.label, /左手柄/);
  f.advance(30000); packet.left.pose_active = true; packet.left.position_tracked = false;
  f.hub.packet(packet); await f.controller.tick();
  assert.equal(f.hub.snapshot().startup.phase, 'localizing');
  packet.left.position_tracked = true; f.hub.packet(packet); await f.controller.tick();
  assert.equal(f.hub.snapshot().startup.phase, 'ready');
  f.advance(30000); packet.focused = false; f.hub.packet(packet); await f.controller.tick();
  assert.equal(f.hub.snapshot().startup.phase, 'waiting_focus');
  assert.equal(launched(f).length, 1);
});

test('matching installed APK is reused; a missing app is installed only once', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'quest-start-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('quest-start-test-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const apk = path.join(directory, 'test.apk'); await fs.writeFile(apk, 'test-only APK');
  const hash = createHash('sha256').update('test-only APK').digest('hex');
  for (const installed of [true, false]) {
    const f = fixture(); const original = f.adb.run; f.controller.apk = apk;
    f.adb.run = async args => {
      const result = await original(args);
      if (args[1] === 'pm') return installed ? result : '';
      if (args[1] === 'sha256sum') return `${hash}  /data/app/test/base.apk`;
      return result;
    };
    await f.controller.tick(); await f.controller.tick();
    assert.equal(f.calls.filter(args => args[0] === 'install').length, installed ? 0 : 1);
  }
});

test('no-install waits for a missing app and refuses a conflicting USB mapping', async () => {
  const f = fixture(); const original = f.adb.run; f.controller.install = false;
  f.adb.run = args => args[1] === 'pm' ? Promise.resolve('') : original(args);
  await f.controller.tick(); assert.equal(f.hub.snapshot().startup.phase, 'app_missing');
  assert.equal(launched(f).length, 0);
  const conflict = fixture(); const run = conflict.adb.run;
  conflict.adb.run = args => args.join(' ') === 'reverse --list' ? Promise.resolve('UsbFfs tcp:19427 tcp:9999') : run(args);
  await conflict.controller.tick(); assert.equal(conflict.hub.snapshot().startup.phase, 'mapping_conflict');
  assert.equal(conflict.calls.some(args => args[1] === 'tcp:19427'), false);
});

test('USB recovery rebuilds a lost mapping; cleanup removes only owned resources', async () => {
  const f = fixture(); const original = f.adb.run; let mapping = '', online = true;
  f.adb.run = async args => {
    const result = await original(args);
    if (args[0] === 'get-state' && !online) throw new Error('no devices/emulators found');
    if (args.join(' ') === 'reverse --list') return mapping;
    if (args[1] === 'tcp:19427') mapping = 'UsbFfs tcp:19427 tcp:19427';
    return result;
  };
  await f.controller.tick(); online = false; mapping = ''; await f.controller.tick();
  online = true; await f.controller.tick();
  assert.equal(f.calls.filter(args => args[1] === 'tcp:19427').length, 2);
  await f.controller.stop();
  assert.ok(f.calls.some(args => args.includes('com.oculus.vrpowermanager.automation_disable')));
  assert.ok(f.calls.some(args => args[1] === '--remove'));
  assert.ok(f.calls.some(args => args[2] === 'force-stop'));
  assert.equal(f.calls.some(args => /guardian|settings|kill-server/.test(args.join(' '))), false);
  const existing = fixture(); const run = existing.adb.run;
  existing.adb.run = args => args.join(' ') === 'reverse --list' ? Promise.resolve('UsbFfs tcp:19427 tcp:19427')
    : args[1] === 'pidof' ? Promise.resolve('1234') : run(args);
  await existing.controller.tick(); await existing.controller.stop();
  assert.equal(existing.calls.some(args => args[1] === '--remove' || args[2] === 'force-stop'), false);
});

test('managed UI distinguishes USB authorization, sleeping hand, localization and stale readiness', () => {
  const f = fixture();
  f.hub.startup({ managed: true, phase: 'unauthorized', label: '请允许 USB 调试', hint: '首次需要在头显里允许' });
  let snapshot = f.hub.snapshot(), view = deriveView(snapshot);
  assert.equal(view.label, '请允许 USB 调试'); assert.equal(startupSteps(snapshot, view)[0].state, 'warning');
  f.hub.connected(); const packet = frame(); packet.left.position_tracked = false; f.hub.packet(packet);
  snapshot = f.hub.snapshot(); view = deriveView(snapshot);
  assert.match(view.label, /定位/); assert.equal(startupSteps(snapshot, view)[3].state, 'warning');
  packet.left.pose_active = false; f.hub.packet(packet); assert.match(deriveView(f.hub.snapshot()).label, /唤醒左手柄/);
  f.hub.startup({ managed: true, phase: 'ready', label: 'ready' }); f.advance(2000);
  view = deriveView(f.hub.snapshot()); assert.match(view.label, /过期/); assert.equal(view.left.hand, null);
});

test('system controller-required dialog pauses launches and resumes automatically when dismissed', async () => {
  const f = fixture(); const original = f.adb.run; let blocked = true;
  f.adb.run = args => args[1] === 'dumpsys' ? Promise.resolve(blocked ? 'topResumedActivity=ActivityRecord{test com.oculus.vrshell/.systemdialog.launchcheck.LaunchCheckControllerRequiredDialogActivity}' : '') : original(args);
  await f.controller.tick(); assert.equal(f.hub.snapshot().startup.phase, 'waiting_controller_start');
  f.advance(); await f.controller.tick(); assert.equal(launched(f).length, 0);
  blocked = false; f.advance(); await f.controller.tick(); assert.equal(launched(f).length, 1);
});

test('control endpoint rejects missing token and foreign origins before accepting a local stop', async t => {
  const hub = createTelemetryHub(); let stops = 0;
  const ui = await createViewerServer({ hub, port: 0, onStop: () => { stops++; } }); t.after(() => ui.close());
  assert.equal((await fetch(`${ui.url}/api/stop`, { method: 'POST' })).status, 403);
  const headers = { 'X-Quest-Token': hub.snapshot().controls.token };
  assert.equal((await fetch(`${ui.url}/api/stop`, { method: 'POST', headers: { ...headers, Origin: 'https://example.com' } })).status, 403);
  assert.equal(stops, 0);
  assert.equal((await fetch(`${ui.url}/api/stop`, { method: 'POST', headers })).status, 200);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(stops, 1);
});

test('launcher flags are explicit and browser opening is restricted to the local monitor', () => {
  assert.equal(parseLaunchOptions(['--no-open']).open, false);
  assert.equal(parseLaunchOptions(['--reinstall']).reinstall, true);
  assert.throws(() => parseLaunchOptions(['--no-install', '--reinstall']));
  assert.throws(() => openLocalBrowser('https://example.com'));
  assert.throws(() => openLocalBrowser('http://127.0.0.1:8787/?command=x'));
  assert.equal(reverseTarget('UsbFfs tcp:1234 tcp:19427', 19427), null);
  assert.equal(classifyAdbError(new Error('device not found')).phase, 'waiting_usb');
});

test('monitor opens its UI with missing ADB, reuses a running service and stops its worker', async t => {
  let workers = 0, receiverCloses = 0, opened = 0;
  const dependencies = { log: () => {}, makeAdb: () => { workers++; return fixture({ available: () => false }).adb; },
    makeReceiver: async () => ({ close: async () => { receiverCloses++; } }), openBrowser: async () => { opened++; } };
  const monitor = await startMonitor({ 'ui-port': 0 }, dependencies); t.after(() => monitor.close());
  const state = await (await fetch(`${monitor.url}/api/state`)).json();
  assert.equal(state.startup.phase, 'adb_missing'); assert.equal(opened, 1);
  const second = await startMonitor({ 'ui-port': Number(new URL(monitor.url).port), open: false }, dependencies);
  assert.equal(second.reused, true); assert.equal(workers, 1);
  await monitor.close(); assert.equal(receiverCloses, 1);
  await assert.rejects(fetch(`${monitor.url}/api/state`));
});

test('monitor refuses to mistake a replay service for the live one-click launcher', async t => {
  const hub = createTelemetryHub({ source: { mode: 'replay' } });
  const ui = await createViewerServer({ hub, port: 0 }); t.after(() => ui.close());
  await assert.rejects(startMonitor({ 'ui-port': ui.port, open: false }, { log: () => {} }), /回放占用/);
});

test('wireless launcher requires endpoint and physical identity; it never selects USB', async () => {
  const options = parseLaunchOptions(['--wifi', '192.168.1.61:5555', '--serial', 'TEST-QUEST']);
  assert.equal(options.wifi, '192.168.1.61:5555');
  for (const args of [ ['--wifi'], ['--wifi', '192.168.1.61:5555'],
    ['--wifi', '300.1.1.1:5555', '--serial', 'TEST'], ['--wifi', '192.168.1.61:65536', '--serial', 'TEST'],
    ['--wifi', 'host:5555', '--serial', 'TEST'], ['--wifi', '1.1.1.1:5', '--wifi', '1.1.1.1:6', '--serial', 'TEST'] ]) {
    assert.throws(() => parseLaunchOptions(args));
  }
  const calls = [];
  const adb = createAdbClient({ executable: process.execPath, serial: options.wifi,
    execute(binary, args, config, callback) { calls.push(args); callback(null, 'device', ''); } });
  await adb.run(['get-state']); adb.bind('TEST-QUEST'); await adb.run(['reverse', '--list']);
  assert.deepEqual(calls.map(call => call.slice(0, 2)), [['-s', options.wifi], ['-s', options.wifi]]);
  assert.equal(classifyAdbError(new Error('device not found'), 'wifi').phase, 'waiting_wifi');
});

test('wireless identity is checked before mutations and again before cleanup', async () => {
  const f = fixture(); const original = f.adb.run; let identity = 'OTHER-QUEST';
  f.adb.run = async (args, options) => {
    assert.notEqual(options?.usb, true);
    if (args.join(' ') === 'shell getprop ro.serialno') { f.calls.push(args); return identity; }
    return original(args);
  };
  const controller = new StartupController({ adb: f.adb, hub: f.hub, apk: 'absent', transport: 'wifi', expectedSerial: 'TEST-QUEST', log: () => {} });
  await controller.tick();
  assert.equal(f.hub.snapshot().startup.phase, 'wrong_device');
  assert.equal(f.calls.some(call => call.includes('broadcast') || call.includes('install') || call.includes('reverse')), false);
  identity = 'TEST-QUEST'; await controller.tick();
  assert.equal(f.hub.snapshot().startup.device_serial, identity);
  assert.equal(launched(f).length, 1);
  identity = 'OTHER-QUEST'; const count = f.calls.length;
  assert.equal((await controller.stop()).length, 1);
  assert.deepEqual(f.calls.slice(count), [['shell', 'getprop', 'ro.serialno']]);
});

test('wireless sessions cannot be reused as USB or another endpoint', async t => {
  const hub = createTelemetryHub({ source: { mode: 'live', transport: 'wifi', endpoint: '192.168.1.61:5555', device_serial: 'TEST-QUEST' } });
  hub.startup({ managed: true });
  const ui = await createViewerServer({ hub, port: 0 }); t.after(() => ui.close());
  assert.equal(startupSteps(hub.snapshot(), deriveView(hub.snapshot()))[0].label, 'Wi-Fi / ADB');
  for (const options of [{}, { wifi: '192.168.1.62:5555', serial: 'TEST-QUEST' }, { wifi: '192.168.1.61:5555', serial: 'OTHER-QUEST' }]) {
    await assert.rejects(startMonitor({ ...options, 'ui-port': ui.port, open: false }, { log: () => {} }), /其他连接或设备/);
  }
});
