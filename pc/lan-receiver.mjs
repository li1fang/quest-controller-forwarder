import tls from 'node:tls';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createLineParser } from './receiver.mjs';

export async function createLanReceiver({ host, port = 19428, key, cert, token, keepAwake = false, onPacket = () => {}, onConnection = () => {},
  onDisconnect = () => {}, onError = () => {} }) {
  if (!/^[a-f0-9]{64}$/.test(token ?? '')) throw new Error('LAN pairing token missing');
  const sockets = new Set(); let active = null, closing;
  const server = tls.createServer({ key, cert, minVersion: 'TLSv1.2', handshakeTimeout: 3000 }, socket => {
    let pending = Buffer.alloc(0), authenticated = false, meta, parser, leaseTimer;
    socket.setNoDelay(true); socket.setTimeout(5000, () => socket.destroy());
    socket.on('error', () => { if (authenticated) onError(new Error('LAN socket error')); });
    socket.on('close', () => { clearInterval(leaseTimer); if (active === socket) active = null; if (authenticated) { try { onDisconnect(meta); } catch (error) { onError(error); } } });
    socket.on('data', chunk => {
      if (!authenticated) {
        pending = Buffer.concat([pending, chunk]);
        const end = pending.indexOf(10);
        if (end < 0) { if (pending.length > 4096) socket.destroy(); return; }
        if (end > 4096) { socket.destroy(); return; }
        let hello;
        try { hello = JSON.parse(pending.subarray(0, end).toString('utf8')); } catch { socket.destroy(); return; }
        if (hello?.protocol !== 'quest-lan-v1' || hello.kind !== 'hello' || !/^[a-f0-9]{64}$/.test(hello.token ?? '') ||
          !timingSafeEqual(Buffer.from(hello.token, 'hex'), Buffer.from(token, 'hex')) || !/^[a-f0-9-]{36}$/.test(hello.app_run_id ?? '') || active) {
          socket.destroy(); return;
        }
        meta = { app_run_id: hello.app_run_id, connection_id: randomUUID(),
          device_model: String(hello.device_model ?? '').slice(0, 80), app_version: String(hello.app_version ?? '').slice(0, 40),
          power_control: hello.power_control === 'prox-lease-v1' ? 'prox-lease-v1' : null };
        active = socket; authenticated = true;
        parser = createLineParser(packet => {
          try { onPacket(packet, meta); } catch (error) { onError(error); socket.destroy(); }
        }, (error, fatal) => { onError(error); if (fatal) socket.destroy(); });
        try { onConnection(meta); } catch (error) { onError(error); socket.destroy(); return; }
        socket.write('{"accepted":true}\n');
        if (keepAwake && meta.power_control === 'prox-lease-v1') {
          const renew = () => { if (!socket.destroyed) socket.write('{"protocol":"quest-lan-control-v1","lease_ms":10000}\n'); };
          renew(); leaseTimer = setInterval(renew, 2000); leaseTimer.unref();
        }
        const remaining = pending.subarray(end + 1); pending = null;
        if (remaining.length) parser.push(remaining);
      } else parser.push(chunk);
    });
    socket.on('close', () => parser?.end());
  });
  // Include unauthenticated and half-open TLS peers in bounded resource/cleanup accounting.
  server.on('connection', socket => {
    if (sockets.size >= 8) { socket.destroy(); return; }
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
  });
  server.on('tlsClientError', () => {}); // Do not log hello contents, credentials or unrelated LAN peers.
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  server.on('error', onError);
  return { port: server.address().port, close() { return closing ??= new Promise(resolve => { for (const socket of sockets) socket.destroy(); server.close(resolve); }); } };
}
