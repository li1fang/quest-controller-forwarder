import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { findAdb } from './adb-client.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ipv4Port = /^\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}$/;
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null;
const bit = value => typeof value === 'boolean' ? value : null;
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function parseObservationOptions(args) {
  const options = { duration: 60, interval: 2, 'snapshot-interval': 10, mode: 'observe', transport: 'usb' };
  for (let index = 0; index < args.length; index++) {
    const key = args[index].replace(/^--/, '');
    if (args[index] === '--help') { options.help = true; continue; }
    if (!args[index].startsWith('--') || !['serial','adb','out','duration','interval','snapshot-interval','mode','transport'].includes(key)) throw new Error('Unknown observer option');
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
    options[key] = ['duration','interval','snapshot-interval'].includes(key) ? Number(value) : value;
  }
  if (options.help) return options;
  if (!/^[A-Za-z0-9._-]+$/.test(options.serial ?? '')) throw new Error('--serial requires the physical headset serial');
  for (const key of ['duration','interval','snapshot-interval']) if (!Number.isFinite(options[key]) || options[key] <= 0) throw new Error(`Invalid --${key}`);
  if (options.interval < 1 || options['snapshot-interval'] < 5) throw new Error('Observation intervals must be at least 1 second (PC) and 5 seconds (device)');
  if (!['observe','pc-only'].includes(options.mode) || !['usb','wifi','any'].includes(options.transport)) throw new Error('Invalid observation mode or transport');
  return options;
}

// Store only known diagnostic fields. Never pass a raw dump or process error into the timeline.
export function sanitizeSnapshot(value, serial) {
  if (value.device_serial !== serial) throw new Error('Headset identity mismatch');
  const uptime = /^\d+(?:\.\d+)?(?:\s|$)/.test(value.uptime ?? '') ? Number(value.uptime.split(/\s+/)[0]) : null;
  return {
    device_serial: serial,
    checked_at_utc: /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(value.checked_at_utc) ? value.checked_at_utc : null,
    boot_id: /^[a-f0-9-]{36}$/.test(value.boot_id) ? value.boot_id : null,
    boot_completed: ['0','1'].includes(value.boot_completed) ? value.boot_completed : null,
    device_uptime_seconds: uptime,
    adb_wifi_enabled: ['0','1'].includes(value.adb_wifi_enabled) ? value.adb_wifi_enabled : null,
    wifi: {
      connected: bit(value.wifi?.connected), ssid_sha256: sha(value.wifi?.ssid_sha256), bssid_sha256: sha(value.wifi?.bssid_sha256),
      frequency_mhz: Number.isInteger(value.wifi?.frequency_mhz) ? value.wifi.frequency_mhz : null,
      adb_trust_store_visible: bit(value.wifi?.adb_trust_store_visible), current_ap_in_adb_trust_store: bit(value.wifi?.current_ap_in_adb_trust_store),
      trusted_aps: (Array.isArray(value.wifi?.trusted_aps) ? value.wifi.trusted_aps : []).map(ap => ({ bssid_sha256: sha(ap.bssid_sha256), observed_frequency_mhz: Number.isInteger(ap.observed_frequency_mhz) ? ap.observed_frequency_mhz : null })),
    },
    power: {
      wakefulness: ['Awake','Asleep','Dozing','Dreaming'].includes(value.power?.wakefulness) ? value.power.wakefulness : null,
      reported_supply: Object.fromEntries(['ac','usb','wireless','dock'].map(key => [key, bit(value.power?.reported_supply?.[key])])),
    },
    wifi_confirmation_activity_present: bit(value.wifi_confirmation_activity_present),
    controller_confirmation_activity_present: bit(value.controller_confirmation_activity_present),
  };
}

export class ObservationProbe {
  constructor({ serial, transport = 'usb', mode = 'observe', snapshotIntervalMs = 10000, globalRead, readSnapshot, now = Date.now }) {
    Object.assign(this, { serial, transport, mode, snapshotIntervalMs, globalRead, readSnapshot, now });
    this.knownEndpoints = new Set(); this.lastSnapshot = -Infinity; this.lastTarget = null;
  }
  async poll() {
    const at = new Date(this.now()).toISOString();
    let devices, services;
    try { devices = await this.globalRead(['devices','-l']); services = await this.globalRead(['mdns','services']); }
    catch (error) { return { at, phase: error.code === 'ENOENT' ? 'adb_missing' : 'observation_error', mode: this.mode }; }
    const ownService = new RegExp(`^adb-${escapeRegex(this.serial)}-[A-Za-z0-9_-]+$`);
    const tls = [];
    for (const line of services.split(/\r?\n/)) {
      const [instance, type, endpoint] = line.trim().split(/\s+/);
      if (ownService.test(instance ?? '') && type?.replace(/\.$/, '') === '_adb-tls-connect._tcp' && ipv4Port.test(endpoint ?? '')) {
        tls.push(endpoint); this.knownEndpoints.add(endpoint);
      }
    }
    const ownDevices = [];
    for (const line of devices.split(/\r?\n/)) {
      const [target, state] = line.trim().split(/\s+/);
      if ((target === this.serial || this.knownEndpoints.has(target)) && ['device','offline','unauthorized'].includes(state)) {
        ownDevices.push({ target, state, transport: target === this.serial ? 'usb' : 'wifi' });
      }
    }
    const allowed = ownDevices.filter(d => this.transport === 'any' || d.transport === this.transport);
    const online = allowed.filter(d => d.state === 'device');
    const selected = online.find(d => d.target === this.lastTarget) ?? online.find(d => d.transport === 'usb') ?? online[0];
    const result = { at, mode: this.mode, tls_advertisements: tls, devices: ownDevices,
      phase: selected ? 'connected_unverified' : allowed.some(d => d.state === 'unauthorized') ? 'unauthorized' : allowed.some(d => d.state === 'offline') ? 'offline' : 'waiting_device',
      selected_target: selected?.target ?? null, selected_transport: selected?.transport ?? null };
    if (!selected) { this.lastTarget = null; return result; }
    if (this.mode === 'pc-only') { result.phase = 'pc_observation_only'; return result; }
    if (selected.target === this.lastTarget && this.now() - this.lastSnapshot < this.snapshotIntervalMs) return result;
    this.lastSnapshot = this.now(); this.lastTarget = selected.target;
    try {
      result.snapshot = sanitizeSnapshot(await this.readSnapshot(selected.target), this.serial);
      result.phase = 'device_readable';
    } catch (error) { result.phase = /identity mismatch/i.test(error.message) ? 'wrong_device' : 'snapshot_unavailable'; }
    return result;
  }
}

function execute(binary, args, timeout = 5000) {
  return new Promise((resolve, reject) => execFile(binary, args, { encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 512 * 1024 },
    (error, stdout) => error ? reject(error) : resolve(stdout)));
}

export async function runObservation(options, { signal, progress = console.error } = {}) {
  const adb = findAdb(options.adb);
  if (!adb) throw new Error('ADB executable not found');
  if (options.mode !== 'pc-only' && process.platform !== 'win32') throw new Error('Device snapshots currently require Windows PowerShell; pc-only works without it');
  const output = path.resolve(options.out ?? path.join(project, '.local/wireless-observer', new Date().toISOString().replace(/[:.]/g,'-') + '.jsonl'));
  await fs.mkdir(path.dirname(output), { recursive: true });
  const file = await fs.open(output, 'wx');
  const write = event => file.write(JSON.stringify(event) + '\n');
  let count = 0, phase, last;
  const started = Date.now(), deadline = started + options.duration * 1000;
  const probe = new ObservationProbe({ serial: options.serial, mode: options.mode, transport: options.transport,
    snapshotIntervalMs: options['snapshot-interval'] * 1000,
    globalRead: args => execute(adb, args),
    readSnapshot: async target => JSON.parse(await execute('powershell.exe', ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',
      path.join(project, 'scripts/snapshot-wireless.ps1'), '-Serial', options.serial, '-Target', target, '-Label','observer','-Adb',adb,'-JsonOnly'], 20000)),
  });
  try {
    await write({ kind: 'session_start', at: new Date(started).toISOString(), serial: options.serial, read_only: true,
      mode: options.mode, transport: options.transport, duration_seconds: options.duration, interval_seconds: options.interval,
      device_snapshot_interval_seconds: options.mode === 'pc-only' ? null : options['snapshot-interval'],
      measurement_note: 'Device shell sampling may affect idle power/network behavior. PC-only does not issue device shell commands. Discovery is not proof of TLS connectivity.' });
    progress(`只读时间线：${output}`);
    while (!signal?.aborted && Date.now() < deadline) {
      last = await probe.poll(); ++count; await write({ kind: 'observation', ...last });
      if (last.phase !== phase) { phase = last.phase; progress(`[${phase}] ${last.selected_transport ?? 'none'} ${last.selected_target ?? ''}`); }
      const remaining = deadline - Date.now();
      if (remaining > 0) try { await delay(Math.min(options.interval * 1000, remaining), undefined, { signal }); } catch (error) { if (error.name !== 'AbortError') throw error; }
    }
    await write({ kind: 'session_end', at: new Date().toISOString(), observations: count, reason: signal?.aborted ? 'stopped' : 'duration', last_phase: last?.phase ?? null });
    progress(`记录结束：${count} 次观察；未重启或修改设备设置。`);
    return { output, observations: count, last };
  } finally { await file.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = parseObservationOptions(process.argv.slice(2));
    if (options.help) console.log('node pc/wireless-observer.mjs --serial PHYSICAL_SERIAL [--duration 60] [--mode observe|pc-only] [--transport usb|wifi|any] [--interval 2] [--snapshot-interval 10] [--out FILE] [--adb PATH]');
    else {
      const controller = new AbortController();
      process.once('SIGINT', () => controller.abort()); process.once('SIGTERM', () => controller.abort());
      await runObservation(options, { signal: controller.signal });
    }
  } catch (error) { console.error(error.code === 'EEXIST' ? 'Output already exists; no evidence was overwritten.' : error.message); process.exitCode = 1; }
}
