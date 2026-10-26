import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadAnnotationSession } from './annotation-session.mjs';
import { readAnnotations, addAnnotation, editAnnotation, deleteAnnotation, restoreAnnotation } from './annotate-session.mjs';
import { openLocalBrowser } from './launch-options.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = new Map([
  ['/', ['web/annotate.html', 'text/html; charset=utf-8']], ['/annotate', ['web/annotate.html', 'text/html; charset=utf-8']],
  ['/annotation.js', ['web/annotation.js', 'text/javascript; charset=utf-8']], ['/annotation.css', ['web/annotation.css', 'text/css; charset=utf-8']],
  ['/annotation-state.js', ['web/annotation-state.js', 'text/javascript; charset=utf-8']],
  ['/scene.js', ['web/scene.js', 'text/javascript; charset=utf-8']], ['/state.js', ['web/state.js', 'text/javascript; charset=utf-8']],
  ['/vendor/three.module.js', ['node_modules/three/build/three.module.js', 'text/javascript; charset=utf-8']],
  ['/vendor/three.core.js', ['node_modules/three/build/three.core.js', 'text/javascript; charset=utf-8']],
  ['/vendor/OrbitControls.js', ['node_modules/three/examples/jsm/controls/OrbitControls.js', 'text/javascript; charset=utf-8']],
]);
export async function createAnnotationServer({ directory, port = 8787 } = {}) {
  const model = await loadAnnotationSession(directory), token = randomBytes(24).toString('hex');
  readAnnotations(model.directory, model.report.session_id);
  let actualPort = port, queue = Promise.resolve(), closing;
  const doc = () => readAnnotations(model.directory, model.report.session_id);
  const json = (response, status, body) => response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
  const server = http.createServer((request, response) => {
    const hosts = [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`];
    if (!hosts.includes(request.headers.host) || (request.headers.origin && !hosts.some(host => request.headers.origin === `http://${host}`))) { response.writeHead(403).end('Local access only'); return; }
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'");
    const url = new URL(request.url, 'http://127.0.0.1');
    if (request.method === 'POST' && ['/api/annotation', '/api/stop'].includes(url.pathname)) {
      if (request.headers['x-quest-token'] !== token) { response.writeHead(403).end('Invalid control token'); return; }
      if (url.pathname === '/api/stop') { json(response, 200, { stopping: true }); setImmediate(() => close()); return; }
      let bytes = 0, chunks = [], rejected = false;
      request.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 8192) { if (!rejected) json(response, 413, { error: '请求过大。' }); rejected = true; chunks = []; }
        else if (!rejected) chunks.push(chunk);
      });
      request.on('end', () => {
        if (rejected) return;
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { json(response, 400, { error: '请求不是有效 JSON。' }); return; }
        const actions = { add: addAnnotation, edit: editAnnotation, delete: deleteAnnotation, restore: restoreAnnotation };
        if (!body || !Object.hasOwn(actions, body.action)) { json(response, 400, { error: '未知标注操作。' }); return; }
        const operation = queue.then(async () => {
          const result = await actions[body.action]({ ...body, directory: model.directory, expectedRawFiles: model.rawFiles });
          json(response, body.action === 'add' ? 201 : 200, { result, document: doc() });
        });
        queue = operation.catch(error => {
          const message = error.message ?? '';
          const changed = /integrity|verify|changed|hash|identity/.test(message), missing = /not found/.test(message);
          const status = changed || error.code === 'EEXIST' ? 409 : missing ? 404 : ['ENOSPC', 'EACCES', 'EPERM', 'EIO'].includes(error.code) ? 500 : 400;
          const text = /crosses coordinate/.test(message) ? '区间跨越了坐标段，请拆开标注。' : changed ? '原始数据或标注文档校验变化，请重新打开会话。' : missing ? '标注不存在或已被修改，请刷新列表。' : status === 500 ? '保存失败，请检查磁盘空间和写入权限；原始数据未修改。' : error.code === 'EEXIST' ? '标注文件正被其他程序写入，请稍后重试。' : '标签、备注或起止区间无效。';
          if (!response.writableEnded) json(response, status, { error: text });
        });
      }); return;
    }
    if (request.method !== 'GET') { response.writeHead(405, { Allow: 'GET, POST' }).end(); return; }
    if (url.pathname === '/api/session') { json(response, 200, { ...model.metadata, token }); return; }
    if (url.pathname === '/api/annotations') {
      try { json(response, 200, doc()); } catch { json(response, 409, { error: '标注文件校验失败，请保留原件并检查格式。' }); } return;
    }
    if (url.pathname === '/api/frames') {
      const offset = url.searchParams.get('offset') ?? '0', limit = url.searchParams.get('limit') ?? '256';
      if (!/^\d+$/.test(offset) || !/^\d+$/.test(limit) || !Number.isSafeInteger(Number(offset)) || Number(offset) >= model.frames.length || Number(limit) < 1 || Number(limit) > 512) { json(response, 400, { error: 'Invalid frame window' }); return; }
      json(response, 200, { offset: Number(offset), frames: model.frames.slice(Number(offset), Number(offset) + Number(limit)) }); return;
    }
    if (url.pathname === '/favicon.ico') { response.writeHead(204).end(); return; }
    const asset = assets.get(url.pathname);
    if (!asset) { response.writeHead(404).end('Not found'); return; }
    const input = fs.createReadStream(path.join(project, asset[0]));
    input.once('error', () => { if (!response.headersSent) response.writeHead(404); response.end('Asset unavailable'); });
    input.once('open', () => { response.writeHead(200, { 'Content-Type': asset[1] }); input.pipe(response); });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { actualPort = server.address().port; resolve(); }); });
  function close() { return closing ??= (async () => { await queue; await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); })(); }
  return { url: `http://127.0.0.1:${actualPort}`, port: actualPort, model, close };
}
function latestSession() {
  const root = path.join(project, 'recordings');
  for (const name of fs.readdirSync(root, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name).sort().reverse()) {
    try { const m = JSON.parse(fs.readFileSync(path.join(root, name, 'manifest.json'))); if (m.state === 'complete' && m.statistics.frames > 0) return path.join(root, name); } catch {}
  }
  throw new Error('No completed recording with pose frames found');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2), options = { open: true };
    for (let i = 0; i < args.length; ++i) {
      if (args[i] === '--no-open') options.open = false;
      else if (args[i] === '--help') options.help = true;
      else if (['--session', '--port'].includes(args[i])) { const key = args[i], value = args[++i]; if (!value || value.startsWith('--')) throw new Error('Missing option value'); if (key === '--session') options.directory = path.resolve(value); else { options.port = Number(value); if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error('Invalid port'); } }
      else throw new Error('Unknown option');
    }
    if (options.help) console.log('node pc/annotation-server.mjs [--session recordings/<directory>] [--port 8787] [--no-open] (defaults to latest completed recording)');
    else {
      const ui = await createAnnotationServer({ directory: options.directory ?? latestSession(), port: options.port });
      process.once('SIGINT', () => ui.close()); process.once('SIGTERM', () => ui.close());
      console.error(`Recorded annotation workspace: ${ui.url}/annotate`);
      console.error(`Verified ${ui.model.frames.length} frames. Recording receivers and headset keepalive are NOT started.`);
      if (options.open) await openLocalBrowser(ui.url);
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
