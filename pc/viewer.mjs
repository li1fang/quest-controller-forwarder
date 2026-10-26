import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { createReceiver, validatePacket, DEFAULT_PORT } from './receiver.mjs';
import { createTelemetryHub, createViewerServer, DEFAULT_UI_PORT } from './viewer-server.mjs';
import { inspectSession } from './inspect-session.mjs';

const args = process.argv.slice(2);
const options = { port: DEFAULT_UI_PORT, tcpPort: DEFAULT_PORT };
for (let index = 0; index < args.length; ++index) {
  const name = args[index];
  if (name === '--help' || name === '-h') options.help = true;
  else if (name === '--loop') options.loop = true;
  else if (['--replay', '--replay-session', '--port', '--tcp-port'].includes(name)) {
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
    if (name === '--replay') options.replay = value;
    else if (name === '--replay-session') options.replaySession = value;
    else options[name === '--port' ? 'port' : 'tcpPort'] = Number(value);
  } else throw new Error(`Unknown option: ${name}`);
}

async function main() {
  if (options.help) {
    console.log('node pc/viewer.mjs [--port 8787] [--tcp-port 19427] [--replay file.jsonl | --replay-session directory] [--loop]'); return;
  }
  for (const port of [options.port, options.tcpPort]) if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
  let replayFiles;
  if (options.replay && options.replaySession) throw new Error('Choose one replay source');
  if (options.replaySession) {
    const report = await inspectSession(options.replaySession);
    if (!report.integrity_ok) throw new Error('Session integrity audit failed; inspect-session reports details');
    replayFiles = report.files.filter(file => file.file.startsWith('raw/')).map(file => path.join(options.replaySession, file.file));
    if (!replayFiles.length) throw new Error('Session has no telemetry');
    options.replay = options.replaySession;
  } else if (options.replay) { await fs.promises.access(options.replay); replayFiles = [options.replay]; }
  if (options.loop && !options.replay) throw new Error('--loop requires --replay');
  const source = options.replay ? { mode: 'replay', name: path.basename(options.replay), phase: 'playing' } : { mode: 'live' };
  const hub = createTelemetryHub({ source });
  const ui = await createViewerServer({ hub, port: options.port });
  let receiver;
  const controller = new AbortController();
  let closing;
  const close = () => closing ??= (async () => {
    controller.abort();
    await receiver?.close();
    await ui.close();
  })();
  process.once('SIGINT', close); process.once('SIGTERM', close);
  console.error(`Local viewer: ${ui.url}`);
  try {
    if (!options.replay) {
      receiver = await createReceiver({ port: options.tcpPort, onPacket: hub.packet, onConnection: hub.connected, onDisconnect: hub.disconnected, onError: hub.error });
      console.error(`Waiting for headset telemetry on USB/TCP ${receiver.port}. This mode does not launch the headset app.`);
    } else {
      console.error(`RECORDED REPLAY, NOT LIVE: ${options.replay}`);
      // A file replay is always visibly identified; no generated data enters the live stream.
      const replay = async () => {
        try {
          do {
            hub.connected();
            let previousTime, previousConnection;
            for (const replayFile of replayFiles) {
            const input = fs.createReadStream(replayFile);
            const lines = readline.createInterface({ input, crlfDelay: Infinity });
            try {
              for await (const line of lines) {
                if (controller.signal.aborted) break;
                let packet;
                try { packet = validatePacket(JSON.parse(line)); } catch { continue; }
                if (packet.capture?.connection_id && packet.capture.connection_id !== previousConnection) { hub.connected(); previousTime = undefined; previousConnection = packet.capture.connection_id; }
                const time = BigInt(packet.device_monotonic_ns);
                if (previousTime !== undefined && time > previousTime) await delay(Math.min(1000, Number(time - previousTime) / 1e6), undefined, { signal: controller.signal });
                previousTime = time; hub.packet(packet);
              }
            } finally { lines.close(); input.destroy(); }
            if (controller.signal.aborted) break;
            }
          } while (options.loop && !controller.signal.aborted);
        } catch (error) { if (error.name !== 'AbortError') hub.error(error); }
        finally { hub.phase('ended'); hub.disconnected(); }
      };
      replay();
    }
  } catch (error) { await close(); throw error; }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
