import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createReceiver, createDisplay, DEFAULT_PORT } from './receiver.mjs';
import { createTelemetryHub, createViewerServer, DEFAULT_UI_PORT } from './viewer-server.mjs';
import { createAdbClient } from './adb-client.mjs';
import { StartupController } from './startup.mjs';
import { openLocalBrowser, parseLaunchOptions, validateWirelessOptions } from './launch-options.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function startMonitor(options = {}, { makeAdb = createAdbClient, makeReceiver = createReceiver, openBrowser = openLocalBrowser, log = console.error } = {}) {
  validateWirelessOptions(options);
  const transport = options.wifi ? 'wifi' : 'usb';
  const port = options['ui-port'] ?? DEFAULT_UI_PORT;
  if (options.port !== undefined && options.port !== DEFAULT_PORT) throw new Error(`The APK uses TCP ${DEFAULT_PORT}.`);
  const hub = createTelemetryHub({ source: { mode: 'live', transport, ...(options.wifi ? { endpoint: options.wifi, device_serial: options.serial } : {}) } });
  hub.startup({ managed: true, phase: 'checking', label: '正在检查启动条件', hint: '正在建立本地接收端。', tone: 'muted', started_at_ms: Date.now() });
  let ui, receiver, controller, timer, closing;
  const display = options.json ? createDisplay({ json: true }) : null;
  const close = () => closing ??= (async () => {
    clearTimeout(timer);
    const cleanupFailures = await controller?.stop();
    display?.close();
    await receiver?.close();
    await ui?.close();
    log(cleanupFailures?.length ? '本地采集已停止，部分设备清理未完成。请恢复原设备连接后重试清理。' : '本次采集已停止，已清理本次建立的 ADB 转发和临时模拟佩戴。');
  })();
  try {
    ui = await createViewerServer({ hub, port, onStop: close });
  } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
    let state;
    try { state = await (await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(1500) })).json(); } catch { /* A different service owns this port. */ }
    if (state?.application?.id !== 'quest-usb-monitor' || !state.startup?.managed || state.source?.mode !== 'live') {
      throw new Error(`网页端口 ${port} 已被其他接收器或回放占用。请关闭旧窗口，或使用 --ui-port 指定另一端口。`);
    }
    if ((state.source.transport ?? 'usb') !== transport || (options.wifi && (state.source.endpoint !== options.wifi || state.source.device_serial !== options.serial))) {
      throw new Error('已有采集使用其他连接或设备。请先停止该会话，再切换 USB / Wi-Fi。');
    }
    display?.close();
    const url = `http://127.0.0.1:${port}`;
    log(`已复用正在运行的实时采集：${url}`);
    if (options.open !== false && Date.now() - state.startup.started_at_ms > 3000) await openBrowser(url);
    return { reused: true, url, close: async () => {} };
  }
  log(`实时界面：${ui.url}`);
  // The page is already available while USB is absent, unauthorized, or installing.
  const connectReceiver = async () => {
    try {
      receiver = await makeReceiver({ port: DEFAULT_PORT, record: options.record,
        onPacket: packet => { hub.packet(packet); display?.packet(packet); },
        onConnection: () => { hub.connected(); display?.connected(); },
        onDisconnect: () => { hub.disconnected(); display?.disconnected(); },
        onError: error => hub.error(error),
      });
      controller = new StartupController({ adb: makeAdb({ executable: options.adb, serial: options.wifi ?? options.serial }), hub,
        transport, expectedSerial: options.serial,
        apk: path.join(project, 'dist/quest-usb-forwarder.apk'), install: options.install !== false, reinstall: options.reinstall, log });
      controller.start();
    } catch (error) {
      hub.startup({ managed: true, phase: 'receiver_error', label: '本地接收端尚未就绪', tone: 'warning',
        hint: error.code === 'EADDRINUSE' ? '端口 19427 已被其他采集程序占用。请先关闭旧接收端，再重新启动。' : error.message,
        started_at_ms: Date.now() });
      log(error.message);
    }
  };
  await connectReceiver();
  if (options.open !== false) {
    Promise.resolve().then(() => openBrowser(ui.url)).catch(error => log(`请手动打开 ${ui.url}（自动打开浏览器未完成：${error.message}）`));
  }
  if (options.duration) timer = setTimeout(close, options.duration * 1000);
  return { reused: false, url: ui.url, hub, close };
}

async function main() {
  const options = parseLaunchOptions(process.argv.slice(2));
  if (options.help) {
    console.log('node pc/start.mjs [--wifi IPv4:port --serial PHYSICAL_SERIAL] [--no-open] [--ui-port 8787] [--serial SERIAL] [--adb PATH] [--no-install | --reinstall] [--record FILE] [--duration SECONDS]'); return;
  }
  const monitor = await startMonitor(options);
  if (!monitor.reused) {
    process.once('SIGINT', monitor.close); process.once('SIGTERM', monitor.close);
    console.error('按 Ctrl+C 结束，或在网页点击“停止本次采集”；直接强制关闭窗口后可用 Stop-Quest.cmd 清理。');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
