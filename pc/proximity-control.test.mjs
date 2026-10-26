import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareLan } from './prepare-lan.mjs';
import { createLanReceiver } from './lan-receiver.mjs';

test('authenticated opted-in app receives bounded renewable leases; old and untrusted apps receive none', { timeout: 10000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quest-power-test-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('quest-power-test-')); fs.rmSync(directory, { recursive: true, force: true }); });
  const prepared = prepareLan({ host: '192.168.1.2', directory, openssl: process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl' });
  const config = JSON.parse(fs.readFileSync(prepared.configPath)), cert = fs.readFileSync(path.join(directory, 'server-cert.pem'));
  const receiver = await createLanReceiver({ host: '127.0.0.1', port: 0, token: config.token, cert, key: fs.readFileSync(path.join(directory, 'server-key.pem')), keepAwake: true });
  const peers = []; t.after(async () => { for (const peer of peers) peer.destroy(); await receiver.close(); });
  async function client(capability, token = config.token) {
    const peer = tls.connect({ host: '127.0.0.1', port: receiver.port, ca: cert, checkServerIdentity: () => undefined }); peers.push(peer);
    peer.on('error', () => {}); const lines = []; let pending = '';
    peer.on('data', chunk => { pending += chunk; let end; while ((end = pending.indexOf('\n')) >= 0) { lines.push(JSON.parse(pending.slice(0, end))); pending = pending.slice(end + 1); } });
    await once(peer, 'secureConnect');
    peer.write(JSON.stringify({ protocol: 'quest-lan-v1', kind: 'hello', token, app_run_id: randomUUID(), power_control: capability }) + '\n');
    return { peer, lines };
  }
  const wrong = await client('prox-lease-v1', '0'.repeat(64)); await once(wrong.peer, 'close'); assert.deepEqual(wrong.lines, []);
  const legacy = await client(undefined); await once(legacy.peer, 'data'); await delay(150);
  assert.deepEqual(legacy.lines, [{ accepted: true }]); legacy.peer.destroy(); await once(legacy.peer, 'close'); await delay(25);
  const current = await client('prox-lease-v1'); await once(current.peer, 'data'); await delay(2150);
  assert.deepEqual(current.lines[0], { accepted: true }); assert.ok(current.lines.length >= 3);
  for (const line of current.lines.slice(1)) assert.deepEqual(line, { protocol: 'quest-lan-control-v1', lease_ms: 10000 });
  const closed = once(current.peer, 'close'); await receiver.close(); await closed;
  assert.equal(current.peer.destroyed, true);
});

test('power control is disabled unless the receiver explicitly enables it', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quest-power-test-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('quest-power-test-')); fs.rmSync(directory, { recursive: true, force: true }); });
  const prepared = prepareLan({ host: '192.168.1.2', directory, openssl: process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl' });
  const config = JSON.parse(fs.readFileSync(prepared.configPath)), cert = fs.readFileSync(path.join(directory, 'server-cert.pem'));
  const receiver = await createLanReceiver({ host: '127.0.0.1', port: 0, token: config.token, cert, key: fs.readFileSync(path.join(directory, 'server-key.pem')) });
  const peer = tls.connect({ host: '127.0.0.1', port: receiver.port, ca: cert, checkServerIdentity: () => undefined });
  peer.on('error', () => {}); t.after(async () => { peer.destroy(); await receiver.close(); });
  let data = ''; peer.on('data', bytes => { data += bytes; }); await once(peer, 'secureConnect');
  peer.write(JSON.stringify({ protocol: 'quest-lan-v1', kind: 'hello', token: config.token, app_run_id: randomUUID(), power_control: 'prox-lease-v1' }) + '\n');
  await once(peer, 'data'); await delay(150); assert.equal(data, '{"accepted":true}\n');
});
