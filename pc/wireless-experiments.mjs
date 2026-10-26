import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { findAdb } from './adb-client.mjs';
import { sanitizeSnapshot } from './wireless-observer.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
class Gate extends Error {
  constructor(reason, human = false) { super(reason); this.reason = reason; this.human = human; }
}
const sameAp = (a, b) => a.wifi.connected && b.wifi.connected && a.wifi.bssid_sha256 && a.wifi.ssid_sha256
  && a.wifi.bssid_sha256 === b.wifi.bssid_sha256 && a.wifi.ssid_sha256 === b.wifi.ssid_sha256 && a.wifi.frequency_mhz === b.wifi.frequency_mhz;

// A device operation is either a bounded read, this one setting, or the single guarded reboot.
export async function executeExperiments({ serial, io, journal, record = async () => {}, sleep = ms => delay(ms), now = Date.now,
  signal, settleRounds = 3, enableRounds = 10, bootRounds = 90, authorizationWindowMs = 0 }) {
  if (!/^[A-Za-z0-9._-]+$/.test(serial)) throw new Error('Physical headset serial required');
  if (!Number.isFinite(authorizationWindowMs) || authorizationWindowMs < 0 || authorizationWindowMs > 300000) throw new Error('Authorization window must be between 0 and 300 seconds');
  const report = { serial, scope: 'USB-connected diagnostics; no claim of USB-free acceptance',
    status: 'running', experiments: {}, reboot_requests: 0, human_actions_requested: 0, pin_accessed: false, restoration: { status: 'not_needed' } };
  let original, mutationAttempted = false, baseline, journalCreated = false;
  const event = async (kind, data = {}) => record({ at: new Date(now()).toISOString(), kind, ...data });
  const check = () => { if (signal?.aborted) throw new Gate('stopped'); };
  const snapshot = async label => {
    const value = sanitizeSnapshot(await io.snapshot(), serial);
    await event('snapshot', { label, value });
    return value;
  };
  const guard = async () => { if (await io.usbIdentity() !== serial) throw new Gate('usb_missing_or_wrong_device', true); };
  const put = async value => {
    check(); await guard();
    mutationAttempted = true;
    await event('setting_requested', { property: 'adb_wifi_enabled', value });
    check();
    await io.setWifi(value);
  };
  const stable = async label => {
    let value; const signatures = [], counts = [];
    for (let index = 0; index < settleRounds; index++) {
      check(); value = await snapshot(`${label}_${index + 1}`);
      if (!sameAp(baseline, value)) throw new Gate('network_changed_or_unavailable');
      if (value.boot_id !== baseline.boot_id) throw new Gate('unexpected_boot_change');
      signatures.push(JSON.stringify(value.wifi.trusted_aps.map(ap => ap.bssid_sha256).sort()));
      counts.push(value.wifi.trusted_aps.length);
      if (index + 1 < settleRounds) await sleep(1000);
    }
    report.stability_observations ??= {};
    const settled = signatures.length < 2 || signatures.at(-1) === signatures.at(-2);
    report.stability_observations[label] = { samples: counts.length, trust_entry_counts: counts, last_two_dump_signatures_equal: settled,
      note: 'Observed dump stability, not proof of persistence across reboot.' };
    if (!settled) throw new Gate('trust_dump_not_stable_within_observation');
    return value;
  };
  const enable = async label => {
    const beforeMarker = await io.confirmationMarker();
    await put('1');
    let confirmationSeen = false, waitingUntil = null;
    for (let index = 0; index < enableRounds || waitingUntil !== null; index++) {
      check(); const value = await snapshot(`${label}_${index + 1}`);
      if (!sameAp(baseline, value)) throw new Gate('network_changed_or_unavailable');
      const marker = await io.confirmationMarker();
      if (value.adb_wifi_enabled === '0' && marker && marker !== beforeMarker && !confirmationSeen) {
        confirmationSeen = true;
        report.experiments[label] = { status: 'human_threshold', reason: 'fresh_network_confirmation', request_marker: marker,
          note: 'Fresh ActivityTaskManager launch after this enable request; not inferred from a historical Activity record or a missing dump entry.' };
        if (authorizationWindowMs > 0 && ['A_initial_enable','D_ready_network'].includes(label)) {
          waitingUntil = now() + authorizationWindowMs;
          ++report.human_actions_requested;
          await event('authorization_waiting', { label, timeout_seconds: authorizationWindowMs / 1000,
            instruction: 'Confirm wireless debugging for the already selected network in the headset; keep USB connected. No PIN is needed.' });
        } else throw new Gate('network_confirmation_required', true);
      }
      if (value.adb_wifi_enabled === '1') {
        if (waitingUntil !== null) {
          waitingUntil = null; index = 0;
          await event('authorization_setting_observed', { label, setting: '1', note: 'TLS verification remains separate.' });
        }
        const tls = await io.verifyTls();
        if (tls?.verified) {
          report.experiments[label] = { status: 'passed', tls_endpoint: tls.endpoint, physical_identity_verified: true,
            authorization_checkpoint_used: confirmationSeen };
          if (confirmationSeen) await event('authorization_observed', { label, setting: '1', physical_tls_identity_verified: true });
          await event('tls_verified', { label, endpoint: tls.endpoint });
          return value;
        }
      }
      if (waitingUntil !== null && now() >= waitingUntil) throw new Gate('network_confirmation_window_expired', true);
      await sleep(1000);
    }
    report.experiments[label] = { status: 'inconclusive', reason: 'no_verified_tls_within_budget' };
    throw new Gate('no_verified_tls_within_budget');
  };
  try {
    await guard(); baseline = await snapshot('preflight');
    if (!['0','1'].includes(baseline.adb_wifi_enabled)) throw new Gate('wireless_setting_unknown');
    if (baseline.boot_completed !== '1' || !baseline.boot_id || !sameAp(baseline, baseline)) throw new Gate('boot_or_network_not_ready');
    original = baseline.adb_wifi_enabled;
    await stable('preflight_stability');
    const logs = await io.startupEvents();
    report.preflight = { completed: true, snapshot: baseline, startup_events: logs };
    await journal.create({ schema: 1, serial, property: 'adb_wifi_enabled', original, owner_pid: process.pid, created_at: new Date(now()).toISOString() });
    journalCreated = true;

    await enable('A_initial_enable');
    await stable('A_save_settle');
    const beforeOff = await snapshot('B_before_disable');
    await put('0');
    const afterOff = await snapshot('B_after_disable');
    if (afterOff.adb_wifi_enabled !== '0') throw new Gate('disable_not_verified');
    report.experiments.B_disable = { status: 'passed',
      trust_entries_before: beforeOff.wifi.trusted_aps.length, trust_entries_after: afterOff.wifi.trusted_aps.length,
      trust_record_interpretation: 'Dump observations only; persistence/load cause is not inferred.' };
    await enable('A_reenable');
    await stable('before_reboot_stability');

    check(); await guard();
    const beforeReboot = await snapshot('C_before_reboot');
    if (!sameAp(baseline, beforeReboot) || beforeReboot.boot_id !== baseline.boot_id || beforeReboot.adb_wifi_enabled !== '1') throw new Gate('reboot_precondition_changed');
    await event('reboot_prepared', { transport: 'usb', operation: 'adb reboot', prior_boot_id: baseline.boot_id });
    check(); report.reboot_requests = 1;
    // A disconnect or command timeout is not evidence of a completed reboot. Never retry reboot.
    try { await io.reboot(); } catch { await event('reboot_command_disconnected_or_timed_out'); }
    let afterBoot, readyCount = 0;
    for (let index = 0; index < bootRounds; index++) {
      check();
      try {
        await guard();
        const value = await snapshot(`C_recovery_${index + 1}`);
        if (value.boot_id && value.boot_id !== baseline.boot_id) {
          if (value.boot_completed === '1' && value.wifi.connected) {
            if (!sameAp(baseline, value)) throw new Gate('network_changed_after_reboot');
            afterBoot = value; ++readyCount;
            if (readyCount >= 2) break;
          } else readyCount = 0;
        }
      } catch (error) { if (error instanceof Gate && error.reason === 'network_changed_after_reboot') throw error; readyCount = 0; await event('usb_or_snapshot_unavailable', { attempt: index + 1 }); }
      await sleep(1000);
    }
    if (!afterBoot || readyCount < 2) throw new Gate('usb_or_network_did_not_recover_within_budget', true);
    report.experiments.C_reboot = { status: 'observed', boot_id_changed: true, network_unchanged: true,
      wifi_enabled_after_boot: afterBoot.adb_wifi_enabled, snapshot: afterBoot, startup_events: await io.startupEvents() };
    // D is evaluated only after Wi-Fi is already stable on the same AP.
    if (afterBoot.adb_wifi_enabled === '1') {
      const tls = await io.verifyTls();
      if (tls?.verified) report.experiments.D_ready_network = { status: 'passed_without_setting_write', tls_endpoint: tls.endpoint };
      else await enable('D_ready_network');
    } else await enable('D_ready_network');
    report.status = 'completed';
  } catch (error) {
    report.status = error instanceof Gate ? error.human ? 'human_threshold' : 'inconclusive' : 'automation_error';
    report.reason = error instanceof Gate ? error.reason : 'device_or_tool_operation_failed';
    await event('stopped', { status: report.status, reason: report.reason });
  } finally {
    if (journalCreated) {
      try {
        if (mutationAttempted) {
          await guard();
          const current = await snapshot('restore_before');
          if (current.adb_wifi_enabled !== original) {
            await event('restore_requested', { property: 'adb_wifi_enabled', value: original });
            await io.setWifi(original);
          }
          const restored = await snapshot('restore_verified');
          if (restored.adb_wifi_enabled !== original) throw new Error('Restore not verified');
          report.restoration = { status: 'verified', original, observed: restored.adb_wifi_enabled };
        } else report.restoration = { status: 'not_needed', original };
        await journal.clear();
      } catch {
        report.restoration = { status: 'pending_usb_or_authorization', original, journal_retained: true };
        report.previous_status = report.status; report.status = 'human_threshold'; report.reason = 'restoration_requires_usb_or_authorization';
      }
    }
    try { await io.closeOwnedConnections?.(); } catch { report.connection_cleanup_pending = true; }
    await event('finished', { status: report.status, restoration: report.restoration });
  }
  return report;
}

function command(binary, args, timeout = 5000) {
  return new Promise((resolve, reject) => execFile(binary, args, { encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 1024 * 1024 },
    (error, stdout) => error ? reject(error) : resolve(String(stdout).trim())));
}

export async function repairExperimentJournal(previous, { serial, io, isAlive, clear, record }) {
  if (previous.schema !== 1 || previous.serial !== serial || previous.property !== 'adb_wifi_enabled' || !['0','1'].includes(previous.original) || !Number.isSafeInteger(previous.owner_pid)) throw new Error('Invalid recovery journal');
  if (await isAlive(previous.owner_pid)) throw new Error('A diagnostic owner may still be running; no setting changed');
  if (await io.usbIdentity() !== serial) throw new Error('Reconnect the original USB headset for recovery');
  const current = await io.snapshot();
  if (current.adb_wifi_enabled !== previous.original) await io.setWifi(previous.original);
  if ((await io.snapshot()).adb_wifi_enabled !== previous.original) throw new Error('Previous restoration still needs authorization; journal retained');
  await clear(); await record({ kind:'orphan_restoration_verified',original:previous.original });
}

export function createExperimentIo(adb, serial, run = command) {
  const usb = args => run(adb, ['-s', serial, ...args]);
  const owned = new Set();
  const requestMarker = async () => {
    const logs = await usb(['logcat','-d','-t','1200','-v','epoch','-s','ActivityTaskManager:I']);
    return logs.split(/\r?\n/).filter(line => /START u\d+.*WifiDebuggingAlertActivity/.test(line)).map(line => /^\s*(\d+\.\d+)/.exec(line)?.[1]).filter(Boolean).at(-1) ?? null;
  };
  return {
    usbIdentity: () => usb(['shell','getprop','ro.serialno']),
    snapshot: async () => JSON.parse(await run('powershell.exe', ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',
      path.join(project,'scripts/snapshot-wireless.ps1'),'-Serial',serial,'-Target',serial,'-Label','phase2','-Adb',adb,'-JsonOnly'], 20000)),
    setWifi: value => { if (!['0','1'].includes(value)) throw new Error('Invalid setting value'); return usb(['shell','settings','put','global','adb_wifi_enabled',value]); },
    reboot: () => run(adb, ['-s',serial,'reboot'], 6000),
    confirmationMarker: requestMarker,
    startupEvents: async () => {
      const text = await usb(['logcat','-d','-v','epoch','-s','AdbService:I','AdbDebuggingManager:I']);
      const patterns = [ [/Not connected to any wireless network\. Not enabling adbwifi\./,'wifi_unavailable_during_adb_enable'],
        [/Detected wifi network change\. Disabling adbwifi\./,'network_change_disabled_adb'], [/Network disconnected\. Disabling adbwifi\./,'disconnect_disabled_adb'] ];
      return text.split(/\r?\n/).flatMap(line => {
        const time = /^\s*(\d+\.\d+)/.exec(line)?.[1]; if (!time) return [];
        const match = patterns.find(([regex]) => regex.test(line)); return match ? [{ device_epoch_seconds: time, event: match[1] }] : [];
      });
    },
    verifyTls: async () => {
      const services = await run(adb, ['mdns','services']);
      const escaped = serial.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      const name = new RegExp(`^adb-${escaped}-[A-Za-z0-9_-]+$`);
      for (const line of services.split(/\r?\n/)) {
        const [instance,type,endpoint] = line.trim().split(/\s+/);
        if (!name.test(instance ?? '') || type?.replace(/\.$/,'') !== '_adb-tls-connect._tcp' || !/^\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}$/.test(endpoint ?? '')) continue;
        const list = await run(adb, ['devices']);
        const existed = list.split(/\r?\n/).some(row => row.trim().split(/\s+/)[0] === endpoint && row.trim().split(/\s+/)[1] === 'device');
        if (!existed) { await run(adb,['connect',endpoint],6000); owned.add(endpoint); }
        if (await run(adb,['-s',endpoint,'shell','getprop','ro.serialno']) !== serial) throw new Error('TLS identity mismatch');
        return { verified: true, endpoint };
      }
      return null;
    },
    closeOwnedConnections: async () => { for (const endpoint of owned) await run(adb,['disconnect',endpoint]); },
  };
}

export async function runExperiments({ serial, adb: explicitAdb, signal, authorizationWindow = 0 } = {}) {
  if (process.platform !== 'win32') throw new Error('This USB diagnostic runner currently requires Windows');
  if (!/^[A-Za-z0-9._-]+$/.test(serial ?? '')) throw new Error('--serial requires the physical headset serial');
  if (!Number.isFinite(authorizationWindow) || authorizationWindow < 0 || authorizationWindow > 300) throw new Error('Invalid authorization window');
  const adb = findAdb(explicitAdb); if (!adb) throw new Error('ADB executable not found');
  const directory = path.join(project,'.local/wireless-phase2',new Date().toISOString().replace(/[:.]/g,'-'));
  await fs.mkdir(directory,{recursive:true});
  const timeline = await fs.open(path.join(directory,'timeline.jsonl'),'wx');
  const journalPath = path.join(project,'.local/wireless-phase2',`restore-${serial}.json`);
  const io = createExperimentIo(adb,serial);
  const record = async event => { await timeline.write(JSON.stringify(event)+'\n'); if (['setting_requested','reboot_prepared','authorization_waiting','authorization_observed','stopped','finished'].includes(event.kind)) console.error(`[${event.kind}] ${event.label ?? event.reason ?? event.property ?? event.status ?? ''}`); };
  try {
    // An orphaned journal is repaired only for the same physical USB headset.
    let previous;
    try { previous = JSON.parse(await fs.readFile(journalPath,'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (previous) {
      await repairExperimentJournal(previous,{ serial,io,record,clear:()=>fs.unlink(journalPath),isAlive:pid=>{
        try { process.kill(pid,0); return true; } catch (error) { return error.code !== 'ESRCH'; }
      } });
    }
    const journal = {
      create: async value => { const file = await fs.open(journalPath,'wx'); try { await file.writeFile(JSON.stringify({...value,report_directory:directory})); await file.sync(); } finally { await file.close(); } },
      clear: () => fs.unlink(journalPath),
    };
    console.error(`USB 自动诊断记录：${directory}`);
    const report = await executeExperiments({ serial,io,journal,record,signal,authorizationWindowMs:authorizationWindow*1000 });
    await fs.writeFile(path.join(directory,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
    console.log(JSON.stringify({directory,status:report.status,reason:report.reason??null,restoration:report.restoration,reboot_requests:report.reboot_requests}));
    return {directory,report};
  } finally { await timeline.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2), options = {};
    for (let index=0; index<args.length; index++) {
      if (!['--serial','--adb','--authorization-window'].includes(args[index]) || !args[index+1] || args[index+1].startsWith('--')) throw new Error('Usage: node pc/wireless-experiments.mjs --serial PHYSICAL_SERIAL [--adb PATH] [--authorization-window SECONDS]');
      options[args[index].slice(2)] = args[++index];
    }
    const controller = new AbortController();
    process.once('SIGINT',()=>controller.abort()); process.once('SIGTERM',()=>controller.abort());
    await runExperiments({...options,authorizationWindow:Number(options['authorization-window']??0),signal:controller.signal});
  } catch { console.error('USB diagnostic operation did not complete. Local recovery journal and evidence, if any, are retained.'); process.exitCode=1; }
}
