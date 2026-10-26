import test from 'node:test';
import assert from 'node:assert/strict';
import { executeExperiments, createExperimentIo, repairExperimentJournal } from './wireless-experiments.mjs';

// All simulated device state stays in this test file. No test sends an ADB command.
const serial = 'TEST-QUEST';
function fixture(options = {}) {
  const state = { flag: options.original ?? '0', boot: '11111111-1111-1111-1111-111111111111', online: true, marker: '100.000', rebooted: false, network: 'a'.repeat(64) };
  const calls = [], events = []; let journalValue, journalCleared = false;
  const io = {
    usbIdentity: async () => { if (!state.online) throw new Error('offline'); return options.identity ?? serial; },
    snapshot: async () => {
      if (!state.online) throw new Error('offline');
      return { device_serial: serial, boot_id: state.boot, boot_completed: '1', adb_wifi_enabled: state.flag,
        wifi: { connected: true, ssid_sha256: 'b'.repeat(64), bssid_sha256: state.network, frequency_mhz: 5240, trusted_aps: [] }, power: {} };
    },
    setWifi: async value => {
      assert.ok(journalValue, 'journal must be saved before any mutation'); calls.push(['set', value]);
      if (value === '1' && (options.authorization || (options.authorizationAfterBoot && state.rebooted))) {
        state.flag = '0'; state.marker = String(Number(state.marker) + 1);
      } else state.flag = value;
      if (options.dropAfterWrite) state.online = false;
    },
    confirmationMarker: async () => state.marker,
    verifyTls: async () => options.noTls ? null : { verified: true, endpoint: '192.168.1.2:40001' },
    startupEvents: async () => [{ device_epoch_seconds: '100.001', event: 'wifi_unavailable_during_adb_enable' }],
    reboot: async () => {
      calls.push(['reboot']); state.rebooted = true; state.flag = '0'; state.boot = '22222222-2222-2222-2222-222222222222';
      if (options.noUsbRecovery) state.online = false;
      if (options.roamAtBoot) state.network = 'c'.repeat(64);
    },
    closeOwnedConnections: async () => { calls.push(['close_owned']); },
  };
  const run = extra => executeExperiments({ serial, io,
    journal: { create: async value => { journalValue = value; calls.push(['journal']); }, clear: async () => { journalCleared = true; calls.push(['clear_journal']); } },
    record: async event => { events.push(event); }, sleep: async () => {}, settleRounds: 2, enableRounds: 2, bootRounds: 3, ...extra });
  return { state, io, calls, events, run, cleared: () => journalCleared };
}

test('fresh authorization stops at the human threshold, restores original zero and never reboots', async () => {
  const f = fixture({ authorization: true }); const result = await f.run();
  assert.equal(result.status, 'human_threshold'); assert.equal(result.reason, 'network_confirmation_required');
  assert.equal(result.reboot_requests, 0); assert.equal(f.calls.some(call => call[0] === 'reboot'), false);
  assert.deepEqual(f.calls.filter(call => call[0] === 'set'), [['set','1']]);
  assert.equal(result.restoration.status, 'verified'); assert.equal(f.state.flag, '0'); assert.equal(f.cleared(), true);
});

test('A/B/C/D use one reboot, verify the physical TLS identity and restore the original setting', async () => {
  const f = fixture(); const result = await f.run();
  assert.equal(result.status, 'completed'); assert.equal(result.reboot_requests, 1);
  assert.equal(result.experiments.B_disable.status, 'passed');
  assert.equal(result.experiments.C_reboot.network_unchanged, true);
  assert.equal(result.experiments.D_ready_network.physical_identity_verified, true);
  assert.equal(f.state.flag, '0'); assert.equal(f.cleared(), true);
  assert.equal(f.calls.filter(call => call[0] === 'reboot').length, 1);
});

test('wrong USB identity prevents journal creation, mutations and reboot', async () => {
  const f = fixture({ identity: 'OTHER' }); const result = await f.run();
  assert.equal(result.status, 'human_threshold'); assert.equal(result.reason, 'usb_missing_or_wrong_device');
  assert.equal(f.calls.some(call => ['set','reboot','journal'].includes(call[0])), false);
});

test('TLS timeout is bounded and still restores an enabled setting to original zero', async () => {
  const f = fixture({ noTls: true }); const result = await f.run();
  assert.equal(result.status, 'inconclusive'); assert.equal(result.reason, 'no_verified_tls_within_budget');
  assert.equal(f.state.flag, '0'); assert.equal(result.restoration.status, 'verified');
  assert.deepEqual(f.calls.filter(call => call[0] === 'set'), [['set','1'],['set','0']]);
});

test('lost USB retains a credential-free restore journal without a GUI or retry loop', async () => {
  const f = fixture({ dropAfterWrite: true }); const result = await f.run();
  assert.equal(result.status, 'human_threshold'); assert.equal(result.restoration.journal_retained, true);
  assert.equal(f.cleared(), false); assert.equal(result.reboot_requests, 0);
  assert.equal(f.calls.filter(call => call[0] === 'set').length, 1);
});

test('a reboot with no USB recovery is not repeated and leaves pending cleanup explicit', async () => {
  const f = fixture({ noUsbRecovery: true }); const result = await f.run();
  assert.equal(result.status, 'human_threshold'); assert.equal(result.reboot_requests, 1);
  assert.equal(f.cleared(), false); assert.equal(result.restoration.status, 'pending_usb_or_authorization');
});

test('roaming after reboot invalidates the controlled comparison and skips D', async () => {
  const f = fixture({ roamAtBoot: true }); const result = await f.run();
  assert.equal(result.status, 'inconclusive'); assert.equal(result.reason, 'network_changed_after_reboot');
  assert.equal(result.experiments.D_ready_network, undefined); assert.equal(f.state.flag, '0');
});

test('restoring preexisting one never falsely reports restored when authorization is required', async () => {
  const f = fixture({ original: '1', authorizationAfterBoot: true }); const result = await f.run();
  assert.equal(result.status, 'human_threshold'); assert.equal(result.restoration.original, '1');
  assert.equal(result.restoration.status, 'pending_usb_or_authorization'); assert.equal(f.cleared(), false);
});

test('cancellation before mutation leaves settings untouched', async () => {
  const controller = new AbortController(), f = fixture(); controller.abort();
  const result = await f.run({ signal: controller.signal });
  assert.equal(result.reason, 'stopped'); assert.equal(f.calls.some(call => call[0] === 'set'), false);
});

test('real adapter filters TLS services, scopes cleanup and records only log markers', async () => {
  const calls = [];
  const io = createExperimentIo('ADB',serial,async (binary,args) => {
    calls.push(args);
    const command = args.join(' ');
    if (command.includes('ActivityTaskManager:I')) return '100.100 I ActivityTaskManager: START u0 com.other/.OtherActivity SECRET-FIXTURE\n101.200 I ActivityTaskManager: START u0 com.oculus.os.vrusb/.WifiDebuggingAlertActivity (has extras)';
    if (command === 'mdns services') return `adb-OTHER-xyz _adb-tls-connect._tcp 192.168.1.3:40002\nadb-${serial}-xyz _adb._tcp 192.168.1.2:5555\nadb-${serial}-xyz _adb-tls-connect._tcp 192.168.1.2:40001`;
    if (command === 'devices') return 'List of devices attached';
    if (command.endsWith('getprop ro.serialno')) return serial;
    return '';
  });
  assert.equal(await io.confirmationMarker(), '101.200');
  assert.deepEqual(await io.verifyTls(), { verified:true, endpoint:'192.168.1.2:40001' });
  await io.closeOwnedConnections();
  assert.deepEqual(calls.filter(args => args[0] === 'connect' || args[0] === 'disconnect'), [['connect','192.168.1.2:40001'],['disconnect','192.168.1.2:40001']]);
  await assert.rejects(async () => io.setWifi('not-a-bit'));
  assert.equal(calls.some(args => args.includes('5555') || args.includes('kill-server') || args.includes('PIN')), false);
});

test('an unstable trust dump stops before creating a journal or mutating the device', async () => {
  const f = fixture(); const read = f.io.snapshot; let calls = 0;
  f.io.snapshot = async () => { const data = await read(); data.wifi.trusted_aps = [{ bssid_sha256: (++calls % 2 ? 'c' : 'd').repeat(64) }]; return data; };
  const result = await f.run();
  assert.equal(result.reason, 'trust_dump_not_stable_within_observation');
  assert.equal(f.calls.some(call => ['set','journal','reboot'].includes(call[0])), false);
});

test('orphan recovery restores only the selected setting on the matching physical headset', async () => {
  let flag = '1', cleared = false; const writes = [];
  const previous = { schema:1,serial,property:'adb_wifi_enabled',original:'0',owner_pid:123 };
  const dependencies = { serial,isAlive:()=>false,record:async()=>{},clear:async()=>{cleared=true;},io:{ usbIdentity:async()=>serial,
    snapshot:async()=>({adb_wifi_enabled:flag}),setWifi:async value=>{writes.push(value);flag=value;} } };
  await repairExperimentJournal(previous,dependencies);
  assert.deepEqual(writes,['0']); assert.equal(cleared,true);
  writes.length=0; cleared=false;
  await assert.rejects(repairExperimentJournal(previous,{...dependencies,isAlive:()=>true}),/still be running/);
  await assert.rejects(repairExperimentJournal({...previous,property:'other'},dependencies),/Invalid/);
  await assert.rejects(repairExperimentJournal(previous,{...dependencies,io:{...dependencies.io,usbIdentity:async()=> 'OTHER'}}),/original USB/);
  assert.equal(cleared,false); assert.equal(writes.length,0);
});

test('orphan recovery keeps its journal when original one cannot be restored without authorization', async () => {
  let writes=0, cleared=false;
  await assert.rejects(repairExperimentJournal({schema:1,serial,property:'adb_wifi_enabled',original:'1',owner_pid:123},{serial,
    isAlive:()=>false,record:async()=>{},clear:async()=>{cleared=true;},io:{usbIdentity:async()=>serial,snapshot:async()=>({adb_wifi_enabled:'0'}),setWifi:async()=>{writes++;}}}),/authorization/);
  assert.equal(writes,1); assert.equal(cleared,false);
});

test('one initial authorization checkpoint continues automatically without rewriting the enable request', async () => {
  const behavior={authorization:true}, f=fixture(behavior); let waits=0;
  const result=await f.run({authorizationWindowMs:2000,record:async event=>{
    if(event.kind==='authorization_waiting'){ waits++; behavior.authorization=false; f.state.flag='1'; }
  }});
  assert.equal(waits,1); assert.equal(result.status,'completed'); assert.equal(result.human_actions_requested,1);
  assert.equal(result.reboot_requests,1); assert.equal(f.state.flag,'0');
  assert.equal(result.experiments.A_initial_enable.authorization_checkpoint_used,true);
});

test('authorization window expires without retrying the enable or leaving original zero changed', async () => {
  const f=fixture({authorization:true}); let time=10000;
  const result=await f.run({authorizationWindowMs:2000,now:()=>time,sleep:async ms=>{time+=ms;}});
  assert.equal(result.status,'human_threshold'); assert.equal(result.reason,'network_confirmation_window_expired');
  assert.equal(f.calls.filter(call=>call[0]==='set'&&call[1]==='1').length,1);
  assert.equal(f.state.flag,'0'); assert.equal(result.restoration.status,'verified');
});

test('a post-reboot authorization can be handled within the same manual window', async () => {
  const behavior={authorizationAfterBoot:true}, f=fixture(behavior), labels=[];
  const result=await f.run({authorizationWindowMs:2000,record:async event=>{
    if(event.kind==='authorization_waiting'){labels.push(event.label);f.state.flag='1';}
  }});
  assert.deepEqual(labels,['D_ready_network']); assert.equal(result.status,'completed');
  assert.equal(result.human_actions_requested,1); assert.equal(result.reboot_requests,1); assert.equal(f.state.flag,'0');
});

test('an unexpected same-boot reauthorization does not open another manual wait', async () => {
  const f=fixture(), originalWrite=f.io.setWifi; let enables=0;
  f.io.setWifi=async value=>{ await originalWrite(value); if(value==='1'&&++enables===2){f.state.flag='0';f.state.marker='999.000';} };
  const result=await f.run({authorizationWindowMs:2000});
  assert.equal(result.status,'human_threshold'); assert.equal(result.human_actions_requested,0);
  assert.equal(result.reboot_requests,0); assert.equal(result.reason,'network_confirmation_required');
});
