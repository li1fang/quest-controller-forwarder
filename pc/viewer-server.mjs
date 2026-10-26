import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_UI_PORT = 8787;

export function createTelemetryHub({ source = { mode: 'live' }, now = Date.now } = {}) {
  let connected = false, frame = null, status = null, receivedAt = null;
  let connectionId = 0, frameCount = 0, arrivals = [], error = null;
  let startup = null, controls = null, recording = null, validation = null, storage = null;
  const listeners = new Set();
  const emit = () => { for (const listener of listeners) listener(); };
  return {
    connected() {
      connected = true; frame = null; status = null; receivedAt = null; arrivals = []; error = null;
      ++connectionId; emit();
    },
    disconnected() { connected = false; frame = null; receivedAt = null; arrivals = []; emit(); },
    packet(packet) {
      if (packet.kind === 'frame') {
        frame = packet; status = null; receivedAt = now(); arrivals.push(receivedAt);
        arrivals = arrivals.filter(value => value > receivedAt - 1000); ++frameCount;
      } else { status = packet; frame = null; receivedAt = null; arrivals = []; }
      emit();
    },
    error(value) { error = String(value?.message ?? value); emit(); },
    clearError() { error = null; emit(); },
    phase(value) { source = { ...source, phase: value }; emit(); },
    startup(value) { startup = value; emit(); },
    controls(value) { controls = value; emit(); },
    recording(value) { recording = value; emit(); },
    validation(value) { validation = value; emit(); },
    storage(value) { storage = value; emit(); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    snapshot() {
      const time = now();
      arrivals = arrivals.filter(value => value > time - 1000);
      return { application: { id: 'quest-usb-monitor', api_version: 1 }, source, startup, controls, recording, validation, storage, transport_connected: connected, connection_id: connectionId,
        server_time_ms: time, frame_received_at_ms: receivedAt,
        frame_rate_hz: arrivals.length, frame_count: frameCount, frame, status, last_error: error };
    },
  };
}

const routes = new Map([
  ['/', ['web/index.html', 'text/html; charset=utf-8']],
  ['/capture', ['web/index.html', 'text/html; charset=utf-8']],
  ['/test', ['web/index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['web/app.js', 'text/javascript; charset=utf-8']],
  ['/scene.js', ['web/scene.js', 'text/javascript; charset=utf-8']],
  ['/state.js', ['web/state.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['web/style.css', 'text/css; charset=utf-8']],
  ['/workbench.css', ['web/workbench.css', 'text/css; charset=utf-8']],
  ['/vendor/three.module.js', ['node_modules/three/build/three.module.js', 'text/javascript; charset=utf-8']],
  ['/vendor/three.core.js', ['node_modules/three/build/three.core.js', 'text/javascript; charset=utf-8']],
  ['/vendor/OrbitControls.js', ['node_modules/three/examples/jsm/controls/OrbitControls.js', 'text/javascript; charset=utf-8']],
]);

export async function createViewerServer({ hub, port = DEFAULT_UI_PORT, onStop, onStartCapture, onStopCapture, onStartValidation } = {}) {
  if (!hub) throw new Error('A telemetry hub is required');
  if (!fs.existsSync(path.join(project, 'node_modules/three/build/three.module.js'))) {
    throw new Error('Missing Three.js. Run pnpm install --frozen-lockfile (or npm install) in this project.');
  }
  const streams = new Map();
  const token = onStop || onStartCapture || onStopCapture || onStartValidation ? randomBytes(24).toString('hex') : null;
  if (token) hub.controls({ can_stop: !!onStop, can_record: !!onStartCapture && !!onStopCapture, can_validate: !!onStartValidation, token });
  let dirty = true, lastBroadcast = 0, actualPort = port;
  const unsubscribe = hub.subscribe(() => { dirty = true; });
  function send(response, client) {
    if (client.blocked || response.destroyed || response.writableEnded) return;
    client.blocked = !response.write('data: ' + JSON.stringify(hub.snapshot()) + '\n\n');
  }
  const server = http.createServer((request, response) => {
    const hosts = new Set([`127.0.0.1:${actualPort}`, `localhost:${actualPort}`]);
    if (!hosts.has(request.headers.host)) { response.writeHead(403).end('Local access only'); return; }
    if (request.headers.origin && ![...hosts].some(host => request.headers.origin === `http://${host}`)) {
      response.writeHead(403).end('Origin not allowed'); return;
    }
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'");
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (pathname === '/api/validation/start' && request.method === 'POST' && onStartValidation) {
      if (request.headers['x-quest-token'] !== token) { response.writeHead(403).end('Invalid control token'); return; }
      let bytes = 0, body = '', rejected = false;
      request.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 2048) { if (!rejected) response.writeHead(413).end('Body too large'); rejected = true; body = ''; }
        else if (!rejected) body += chunk.toString('utf8');
      });
      request.on('end', async () => {
        if (rejected) return;
        let conditions;
        try { conditions = JSON.parse(body); } catch { response.writeHead(400).end('Invalid JSON'); return; }
        try {
          const result = await onStartValidation(conditions);
          response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ validation: result }));
        } catch (error) { response.writeHead([400, 409].includes(error.statusCode) ? error.statusCode : 500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Could not start validation; confirm conditions and stop any active recording' })); }
      }); return;
    }
    if (['/api/capture/start', '/api/capture/stop'].includes(pathname) && request.method === 'POST' && onStartCapture && onStopCapture) {
      if (request.headers['x-quest-token'] !== token) { response.writeHead(403).end('Invalid control token'); return; }
      const action = pathname.endsWith('/start') ? onStartCapture : onStopCapture;
      Promise.resolve().then(action).then(result => {
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ recording: result }));
      }).catch(error => {
        if (error.statusCode !== 507) hub.error(error);
        response.writeHead(error.statusCode === 507 ? 507 : 500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: error.statusCode === 507 ? '磁盘剩余空间不足或暂不可读取，未开始新采集；原有数据保留。' : 'Capture operation failed; inspect recording status' }));
      }); return;
    }
    if (pathname === '/api/stop' && request.method === 'POST' && onStop) {
      if (request.headers['x-quest-token'] !== token) { response.writeHead(403).end('Invalid control token'); return; }
      response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"stopping":true}');
      setImmediate(() => { Promise.resolve(onStop()).catch(error => console.error(error.message)); });
      return;
    }
    if (request.method !== 'GET') { response.writeHead(405, { Allow: 'GET' }).end(); return; }
    if (pathname === '/favicon.ico') { response.writeHead(204).end(); return; }
    if (pathname === '/api/state') { response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(hub.snapshot())); return; }
    if (pathname === '/events') {
      if (streams.size >= 8) { response.writeHead(503).end('Too many viewer connections'); return; }
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      response.flushHeaders();
      const client = { blocked: false };
      streams.set(response, client);
      response.on('drain', () => { client.blocked = false; send(response, client); });
      response.on('close', () => streams.delete(response));
      send(response, client);
      return;
    }
    const asset = routes.get(pathname);
    if (!asset) { response.writeHead(404).end('Not found'); return; }
    if (pathname === '/test' || pathname === '/capture') {
      fs.readFile(path.join(project, asset[0]), 'utf8', (error, html) => {
        if (error) { response.writeHead(404).end('Asset unavailable'); return; }
        const test = pathname === '/test';
        const page = html.replace('<title>Quest / 手柄观测台</title>', test ? '<title>Quest · 正式测试与录制</title>' : '<title>Quest · 日常采集（无固定时长）</title>')
          .replace('<body>', test ? '<body data-view="test">' : '<body data-view="capture">').replace('<h1>手柄观测台', test ? '<h1>正式测试与录制' : '<h1>日常采集');
        response.writeHead(200, { 'Content-Type': asset[1] }).end(page);
      }); return;
    }
    const stream = fs.createReadStream(path.join(project, asset[0]));
    stream.once('error', () => { if (!response.headersSent) response.writeHead(404); response.end('Asset unavailable'); });
    stream.once('open', () => { response.writeHead(200, { 'Content-Type': asset[1] }); stream.pipe(response); });
  });
  try { await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { actualPort = server.address().port; resolve(); });
  }); } catch (error) { unsubscribe(); throw error; }
  const timer = setInterval(() => {
    if (!dirty && Date.now() - lastBroadcast < 500) return;
    dirty = false; lastBroadcast = Date.now();
    for (const [response, client] of streams) send(response, client);
  }, 1000 / 30);
  timer.unref();
  let closing;
  return { port: actualPort, url: `http://127.0.0.1:${actualPort}`, broadcast() { for (const [response, client] of streams) send(response, client); }, close() {
    return closing ??= (async () => {
      clearInterval(timer); unsubscribe();
      for (const response of streams.keys()) response.end();
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    })();
  } };
}
