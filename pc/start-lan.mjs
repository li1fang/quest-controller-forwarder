import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { X509Certificate } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createLanReceiver } from './lan-receiver.mjs';
import { createLanCaptureController } from './lan-capture-controller.mjs';
import { createTelemetryHub, createViewerServer } from './viewer-server.mjs';
import { openLocalBrowser } from './launch-options.mjs';
import { isPrivateIPv4 } from './prepare-lan.mjs';
import { createHeadlessValidation } from './headless-validation.mjs';
import { readPairing } from './lan-pairing.mjs';
import { createStorageGuard } from './storage-status.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function startLan(options = {}) {
  const configPath = path.resolve(options.config ?? path.join(project, '.local/lan/receiver.json'));
  const config = readPairing(configPath);
  if (!isPrivateIPv4(config.host) || !Object.values(os.networkInterfaces()).flat().some(nic => nic?.address === config.host))
    throw new Error('Configured LAN IPv4 is not assigned to this PC; update pairing with prepare-lan.ps1 and import it on the headset (no APK rebuild)');
  const cert = fs.readFileSync(path.join(path.dirname(configPath), 'server-cert.pem'));
  if (new X509Certificate(cert).fingerprint256.replaceAll(':', '').toLowerCase() !== config.cert_sha256) throw new Error('LAN certificate does not match receiver pairing');
  const hub = createTelemetryHub({ source: { mode: 'live', transport: 'lan', endpoint: `${config.host}:${config.port}` } });
  let ui, receiver, captures, validation, storage, timer, closing;
  const close = (reason = 'user_stop') => closing ??= (async () => {
    clearTimeout(timer);
    await storage?.close();
    await validation?.close();
    await receiver?.close();
    const result = await captures?.shutdown(reason);
    if (result) hub.recording(result);
    hub.phase('stopped'); ui?.broadcast();
    if (result) console.error(`Recording ${result.state}: ${result.directory} (${result.frames} frames)`);
    // Give the final persisted/error state time to reach connected browsers before closing SSE.
    if (ui) await new Promise(resolve => setTimeout(resolve, 150));
    await ui?.close();
    if (result?.state === 'failed') process.exitCode = 1;
    return result;
  })();
  try {
    const root = path.resolve(options.root ?? path.join(project, 'recordings'));
    let initialRecording;
    if (options.idle && fs.existsSync(root)) {
      const candidates = fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort().reverse();
      for (const name of candidates) {
        try {
          const directory = path.join(root, name), manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json')));
          if (manifest.schema === 'quest-capture-session-v1' && ['complete', 'failed'].includes(manifest.state)) {
            initialRecording = { state: manifest.state, session_id: manifest.session_id, directory, ...manifest.statistics, error: manifest.error,
              started_at_utc: manifest.started_at_utc, elapsed_s: manifest.elapsed_s ?? (Date.parse(manifest.ended_at_utc) - Date.parse(manifest.started_at_utc)) / 1000, stop_reason: manifest.stop_reason }; break;
          }
        } catch { /* An incomplete directory is not a completed recording. */ }
      }
    }
    captures = createLanCaptureController({ hub, root, initialRecording, log: console.error, beforeStart: () => storage.beforeStart(),
      source: { transport: 'app-lan-tls', endpoint: `${config.host}:${config.port}`, app_package: 'dev.quest.lanforwarder',
        worn_state: 'not_measured; validate separately', power_policy: 'prox-lease-v1 for opted-in app; device effect requires validation', server_cert_sha256: config.cert_sha256 } });
    validation = createHeadlessValidation({ captures, onUpdate: hub.validation, profile: options.validationProfile ?? 'motion_only' });
    storage = createStorageGuard({ root, onStatus: hub.storage, isRecording: () => captures.status().state === 'recording',
      stop: reason => validation.active() ? validation.finish(reason) : captures.stop(reason) });
    ui = await createViewerServer({ hub, port: options.uiPort ?? 8787, onStop: () => close(),
      onStartCapture: () => { if (validation.active()) throw new Error('Validation is active'); validation.reset(); return captures.start(); },
      onStopCapture: () => validation.active() ? validation.finish() : captures.stop(), onStartValidation: conditions => validation.start(conditions) });
    receiver = await createLanReceiver({ host: config.host, port: config.port, cert, token: config.token, keepAwake: true,
      key: fs.readFileSync(path.join(path.dirname(configPath), 'server-key.pem')),
      onConnection: meta => { captures.connected(meta); console.error('Paired LAN app connected.'); },
      onPacket: (packet, meta) => validation.packet(captures.packet(packet, meta), meta),
      onDisconnect: meta => { validation.disconnected(); captures.disconnected(meta); }, onError: captures.error });
    if (!options.idle) await captures.start();
    console.error(`LAN TLS receiver: ${config.host}:${receiver.port} (manual app launch; no ADB)`);
    if (options.idle) console.error('Preview only; click Start new capture to record.');
    console.error(`Daily capture (no default time limit): ${ui.url}/capture`);
    const stop = () => { close().catch(error => { console.error(error.message); process.exitCode = 1; }); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    if (options.duration) timer = setTimeout(() => close('duration_elapsed').catch(console.error), options.duration * 1000);
    if (options.open !== false) await openLocalBrowser(ui.url + '/capture');
    return { hub, ui, receiver, captures, close };
  } catch (error) { await close('startup_error'); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = {};
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; ++i) {
      if (args[i] === '--no-open') options.open = false;
      else if (args[i] === '--idle') options.idle = true;
      else if (args[i] === '--help') options.help = true;
      else if (['--config', '--root', '--duration', '--ui-port', '--validation-profile'].includes(args[i])) {
        const name = args[i], value = args[++i];
        if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
        if (name === '--duration') { options.duration = Number(value); if (!(options.duration > 0) || !Number.isFinite(options.duration)) throw new Error('Invalid duration'); }
        else if (name === '--ui-port') { options.uiPort = Number(value); if (!Number.isInteger(options.uiPort) || options.uiPort < 1 || options.uiPort > 65535) throw new Error('Invalid UI port'); }
        else if (name === '--validation-profile') { if (!['motion_only', 'inputs'].includes(value)) throw new Error('Invalid validation profile'); options.validationProfile = value; }
        else options[name.slice(2)] = value;
      } else throw new Error(`Unknown option ${args[i]}`);
    }
    if (options.help) console.log('node pc/start-lan.mjs [--config .local/lan/receiver.json] [--root recordings] [--idle] [--no-open] [--duration seconds] [--ui-port 8787] [--validation-profile motion_only|inputs]');
    else await startLan(options);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
