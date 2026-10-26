import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createReceiver, createDisplay, parseOptions, DEFAULT_PORT } from './receiver.mjs';
import { createTelemetryHub, createViewerServer } from './viewer-server.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageName = 'dev.quest.usbforwarder';

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    console.log('node pc/usb.mjs [--ui] [--ui-port 8787] [--record file.jsonl] [--json] [--serial USB_SERIAL] [--adb path] [--no-install] [--duration seconds]');
    return;
  }
  if (options.port !== DEFAULT_PORT) throw new Error(`The APK uses port ${DEFAULT_PORT}; use that port with pc/usb.mjs.`);
  const adb = options.adb ?? (fs.existsSync('C:/Android/Sdk/platform-tools/adb.exe') ? 'C:/Android/Sdk/platform-tools/adb.exe' : 'adb');
  const target = options.serial ? ['-s', options.serial] : ['-d'];
  function command(args, { quiet = false } = {}) {
    try {
      const result = execFileSync(adb, [...target, ...args], { encoding: 'utf8', timeout: 30000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      if (!quiet && result.trim()) console.error(result.trim());
      return result.trim();
    } catch (error) {
      throw new Error(`ADB ${args.join(' ')} failed: ${String(error.stderr ?? error.message).trim()}`);
    }
  }
  let state;
  try { state = command(['get-state'], { quiet: true }); }
  catch (error) {
    throw new Error(`${error.message}\nEnable Developer Mode, connect USB, and accept Allow USB debugging inside the headset (not just file access).`);
  }
  if (state !== 'device') throw new Error(`Headset is ${state}, not authorized/online.`);
  // -d already selects a USB transport. Windows' native USB backend may return
  // "unknown" for get-devpath even when that selection is fully operational.
  const devicePath = command(['get-devpath'], { quiet: true });
  if (options.serial && !devicePath.startsWith('usb:')) {
    let usbSerial;
    try { usbSerial = execFileSync(adb, ['-d', 'get-serialno'], { encoding: 'utf8', timeout: 10000, windowsHide: true }).trim(); }
    catch { throw new Error('Cannot verify the selected USB device on this ADB backend; temporarily connect only that headset.'); }
    if (usbSerial !== options.serial) throw new Error('The selected serial is not the connected USB headset.');
  }
  const apk = path.join(project, 'dist', 'quest-usb-forwarder.apk');
  if (options.install && !fs.existsSync(apk)) throw new Error('Build dist/quest-usb-forwarder.apk first: powershell -File scripts/build.ps1');
  const display = createDisplay(options);
  const hub = options.ui ? createTelemetryHub() : null;
  const ui = options.ui ? await createViewerServer({ hub, port: options['ui-port'] }) : null;
  let receiver;
  try {
    receiver = await createReceiver({ ...options,
      onPacket: packet => { display.packet(packet); hub?.packet(packet); },
      onConnection: () => { display.connected(); hub?.connected(); },
      onDisconnect: () => { display.disconnected(); hub?.disconnected(); },
      onError: error => { console.error(error.message); hub?.error(error); },
    });
  } catch (error) { await ui?.close(); display.close(); throw error; }
  if (ui) console.error(`Local viewer: ${ui.url}`);
  let keepAwake;
  let closing = false;
  let mapped = false;
  let proximityAttempted = false;
  let launched = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    clearInterval(keepAwake);
    display.close();
    for (const args of [
      ...(launched ? [['shell', 'am', 'force-stop', packageName]] : []),
      ...(proximityAttempted ? [['shell', 'am', 'broadcast', '-a', 'com.oculus.vrpowermanager.automation_disable']] : []),
      ...(mapped ? [['reverse', '--remove', `tcp:${DEFAULT_PORT}`]] : []),
    ]) {
      try { command(args, { quiet: true }); } catch (error) { console.error(`Cleanup: ${error.message}`); }
    }
    await receiver.close();
    await ui?.close();
    console.error('Stopped. Requested normal proximity behavior and removed this run\'s USB mapping.');
  };
  process.once('SIGINT', close); process.once('SIGTERM', close);
  try {
    const reverseList = command(['reverse', '--list'], { quiet: true });
    const existing = reverseList.split(/\r?\n/).map(line => line.trim().split(/\s+/)).find(parts => parts[1] === `tcp:${DEFAULT_PORT}`);
    if (existing && existing[2] !== `tcp:${DEFAULT_PORT}`) throw new Error(`USB port ${DEFAULT_PORT} already maps elsewhere; refusing to replace it.`);
    if (!existing) { command(['reverse', `tcp:${DEFAULT_PORT}`, `tcp:${DEFAULT_PORT}`]); mapped = true; }
    if (options.install) command(['install', '-r', apk]);
    command(['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'], { quiet: true });
    proximityAttempted = true;
    command(['shell', 'am', 'broadcast', '-a', 'com.oculus.vrpowermanager.prox_close'], { quiet: true });
    console.error('Requested headset-on proximity simulation. Verify focused=true and tracked=true while the headset is on the desk.');
    // Renew the development proximity override; no Guardian or persistent sleep settings are changed.
    keepAwake = setInterval(() => {
      try { command(['shell', 'am', 'broadcast', '-a', 'com.oculus.vrpowermanager.prox_close'], { quiet: true }); }
      catch (error) { console.error(error.message); }
    }, 30000);
    command(['shell', 'am', 'start', '-S', '-n', `${packageName}/android.app.NativeActivity`]);
    launched = true;
    console.error(`Receiving real controller data on 127.0.0.1:${receiver.port}. Keep the headset powered, cameras uncovered, and controllers awake. Ctrl+C to stop.`);
    if (options.duration) setTimeout(close, options.duration * 1000).unref();
  } catch (error) { await close(); throw error; }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
