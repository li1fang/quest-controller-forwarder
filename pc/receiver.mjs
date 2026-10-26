import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';

export const DEFAULT_PORT = 19427;
export const SCHEMA = 'quest-usb-v1';

function vector(value, size) {
  return Array.isArray(value) && value.length === size && value.every(Number.isFinite);
}

export function validatePacket(packet) {
  if (!packet || typeof packet !== 'object' || packet.schema !== SCHEMA) throw new Error('Unknown telemetry schema');
  if (!Number.isSafeInteger(packet.sequence) || packet.sequence < 1) throw new Error('Invalid sequence');
  if (typeof packet.device_monotonic_ns !== 'string' || !/^\d+$/.test(packet.device_monotonic_ns)) throw new Error('Invalid device timestamp');
  if (packet.kind === 'status') {
    if (typeof packet.state !== 'string') throw new Error('Missing status state');
    return packet;
  }
  if (packet.kind !== 'frame' || typeof packet.focused !== 'boolean') throw new Error('Invalid frame');
  for (const side of ['left', 'right']) {
    const hand = packet[side];
    if (!hand || typeof hand !== 'object') throw new Error(`Missing ${side} hand`);
    for (const [key, flag, size] of [
      ['position_m', 'position_valid', 3],
      ['orientation_xyzw', 'orientation_valid', 4],
      ['linear_velocity_m_s', 'linear_velocity_valid', 3],
      ['angular_velocity_rad_s', 'angular_velocity_valid', 3],
    ]) {
      if (typeof hand[flag] !== 'boolean') throw new Error(`Missing ${side}.${flag}`);
      if (hand[flag] ? !vector(hand[key], size) : hand[key] !== null) throw new Error(`Invalid ${side}.${key}`);
    }
    if (typeof hand.pose_active !== 'boolean' || typeof hand.position_tracked !== 'boolean' || typeof hand.orientation_tracked !== 'boolean') {
      throw new Error(`Invalid ${side} tracking state`);
    }
    if ((!packet.focused || !hand.pose_active) && [hand.position_valid, hand.orientation_valid, hand.linear_velocity_valid, hand.angular_velocity_valid].some(Boolean)) {
      throw new Error(`Inactive ${side} pose contains valid tracking data`);
    }
    if (!hand.buttons || Object.values(hand.buttons).some(value => value !== null && typeof value !== 'boolean')) throw new Error(`Invalid ${side} buttons`);
    for (const key of ['trigger', 'squeeze']) {
      if (hand[key] !== null && (!Number.isFinite(hand[key]) || hand[key] < 0 || hand[key] > 1)) throw new Error(`Invalid ${side}.${key}`);
    }
    if (hand.thumbstick !== null && !vector(hand.thumbstick, 2)) throw new Error(`Invalid ${side}.thumbstick`);
  }
  return packet;
}

export function createLineParser(onPacket, onError = () => {}, maxBytes = 256 * 1024) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let failed = false;
  return {
    push(chunk) {
      if (failed) return;
      pending += decoder.write(chunk);
      let index;
      while ((index = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, index);
        pending = pending.slice(index + 1);
        if (Buffer.byteLength(line, 'utf8') > maxBytes) {
          failed = true; pending = ''; onError(new Error('Telemetry line exceeds size limit'), true); return;
        }
        if (!line.trim()) continue;
        let packet;
        try { packet = validatePacket(JSON.parse(line)); }
        catch (error) { onError(error, false); continue; }
        onPacket(packet);
      }
      if (Buffer.byteLength(pending, 'utf8') > maxBytes) {
        failed = true; pending = ''; onError(new Error('Unterminated telemetry line exceeds size limit'), true);
      }
    },
    end() {
      if (pending.trim()) onError(new Error('Connection closed during a partial telemetry line'), false);
      pending = ''; failed = true;
    },
  };
}

export async function createReceiver({ port = DEFAULT_PORT, record, onPacket = () => {}, onConnection = () => {}, onDisconnect = () => {}, onError = () => {} } = {}, { createRecording = fs.createWriteStream } = {}) {
  const clients = new Set();
  let recording;
  if (record) {
    fs.mkdirSync(path.dirname(path.resolve(record)), { recursive: true });
    // Never overwrite an existing recording.
    recording = createRecording(record, { flags: 'wx' });
    await new Promise((resolve, reject) => { recording.once('open', resolve); recording.once('error', reject); });
    recording.on('error', error => onError(error));
  }
  const server = net.createServer(socket => {
    // A single producer avoids mixing sequences from multiple headsets.
    if (clients.size) { socket.destroy(); onError(new Error('Rejected second telemetry producer')); return; }
    clients.add(socket);
    socket.setNoDelay(true);
    let awaitingDrain = false;
    const resumeAfterDrain = () => { awaitingDrain = false; if (!socket.destroyed) socket.resume(); };
    const parser = createLineParser(packet => {
      const received = { ...packet, received_at_utc: new Date().toISOString(), pc_monotonic_ns: process.hrtime.bigint().toString() };
      if (recording && !recording.destroyed && !recording.write(JSON.stringify(received) + '\n')) {
        // A Wi-Fi burst can contain many complete frames in one TCP chunk.
        // Pausing affects future chunks; register only one drain listener for this chunk.
        if (!awaitingDrain) { awaitingDrain = true; socket.pause(); recording.once('drain', resumeAfterDrain); }
      }
      onPacket(received);
    }, (error, fatal) => { onError(error); if (fatal) socket.destroy(); });
    socket.on('data', chunk => parser.push(chunk));
    socket.on('error', error => onError(error));
    socket.on('close', () => { recording?.off('drain', resumeAfterDrain); parser.end(); clients.delete(socket); onDisconnect(); });
    onConnection();
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
  } catch (error) {
    recording?.destroy();
    throw error;
  }
  server.on('error', onError);
  return {
    port: server.address().port,
    async close() {
      for (const client of clients) client.destroy();
      await new Promise(resolve => server.close(resolve));
      if (recording && !recording.destroyed) await new Promise((resolve, reject) => {
        recording.once('error', reject); recording.end(resolve);
      });
    },
  };
}

export function parseOptions(args) {
  const options = { port: DEFAULT_PORT, json: false, install: true };
  for (let index = 0; index < args.length; ++index) {
    const option = args[index];
    if (option === '--json') options.json = true;
    else if (option === '--ui') options.ui = true;
    else if (option === '--no-install') options.install = false;
    else if (option === '--help' || option === '-h') options.help = true;
    else if (['--record', '--serial', '--adb', '--port', '--duration', '--ui-port'].includes(option)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${option}`);
      const name = option.slice(2);
      options[name] = ['port', 'duration', 'ui-port'].includes(name) ? Number(value) : value;
    } else throw new Error(`Unknown option: ${option}`);
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error('Invalid TCP port');
  if (options['ui-port'] !== undefined && (!Number.isInteger(options['ui-port']) || options['ui-port'] < 1 || options['ui-port'] > 65535)) throw new Error('Invalid UI port');
  if (options.duration !== undefined && (!Number.isFinite(options.duration) || options.duration <= 0)) throw new Error('Duration must be positive');
  return options;
}

const formatVector = value => value ? '[' + value.map(number => number.toFixed(3)).join(', ') + ']' : 'unavailable';

export function createDisplay({ json = false } = {}) {
  let latest = null, total = 0, lastTotal = 0, lastPacketTime = 0;
  const timer = json ? null : setInterval(() => {
    if (!latest) return;
    const ageMs = Date.now() - lastPacketTime;
    if (ageMs > 2000) { console.error(`NO CURRENT DATA (${(ageMs / 1000).toFixed(1)}s since last packet)`); return; }
    if (latest.kind === 'status') { console.error(`Quest: ${latest.state} ${latest.message ?? ''}`); return; }
    const rate = total - lastTotal; lastTotal = total;
    console.error(`${rate} frames/s | session=${latest.session_state} | focused=${latest.focused} | seq=${latest.sequence}`);
    const untracked = ['left', 'right'].filter(side => latest[side].position_valid && !latest[side].position_tracked);
    if (untracked.length) console.error(`  POSITION NOT TRACKED: ${untracked.join(', ')}; returned coordinates may be inferred or last-known.`);
    for (const side of ['left', 'right']) {
      const hand = latest[side];
      const buttons = Object.entries(hand.buttons).filter(([, value]) => value === true).map(([name]) => name).join(',') || '-';
      console.error(`  ${side}: p=${formatVector(hand.position_m)} q(xyzw)=${formatVector(hand.orientation_xyzw)} v=${formatVector(hand.linear_velocity_m_s)} w=${formatVector(hand.angular_velocity_rad_s)} tracked=${hand.position_tracked}/${hand.orientation_tracked} trigger=${hand.trigger} squeeze=${hand.squeeze} stick=${formatVector(hand.thumbstick)} buttons=${buttons}`);
    }
  }, 1000);
  timer?.unref();
  return {
    packet(packet) { latest = packet; lastPacketTime = Date.now(); if (packet.kind === 'frame') ++total; if (json) process.stdout.write(JSON.stringify(packet) + '\n'); },
    connected() { latest = null; lastTotal = total; console.error('Quest transport connected. Waiting for XR session and controllers...'); },
    disconnected() { latest = null; console.error('Quest transport disconnected. Waiting for reconnect...'); },
    close() { if (timer) clearInterval(timer); },
  };
}

export async function runReceiver(options) {
  const display = createDisplay(options);
  const receiver = await createReceiver({ ...options, onPacket: display.packet, onConnection: display.connected, onDisconnect: display.disconnected, onError: error => console.error(error.message) });
  console.error(`Listening on 127.0.0.1:${receiver.port}. Ctrl+C to stop.`);
  let closing = false;
  const close = async () => { if (closing) return; closing = true; display.close(); await receiver.close(); };
  process.once('SIGINT', close); process.once('SIGTERM', close);
  if (options.duration) setTimeout(close, options.duration * 1000).unref();
  return { receiver, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = parseOptions(process.argv.slice(2));
    if (options.help) console.log('node pc/receiver.mjs [--record file.jsonl] [--json] [--port 19427] [--duration seconds]');
    else await runReceiver(options);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
