import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { randomBytes, X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function isPrivateIPv4(host) {
  if (net.isIP(host) !== 4) return false;
  const [a, b] = host.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function prepareLan({ host, port = 19428, directory = '.local/lan', openssl = 'openssl' }) {
  if (!isPrivateIPv4(host)) throw new Error('Choose an explicit private LAN IPv4 address');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid LAN port');
  directory = path.resolve(directory);
  fs.mkdirSync(directory, { recursive: true });
  const configPath = path.join(directory, 'receiver.json');
  if (fs.existsSync(configPath)) {
    const existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (existing.host !== host || existing.port !== port) throw new Error('Existing pairing uses another endpoint; use a new directory and rebuild the LAN APK');
    new X509Certificate(fs.readFileSync(path.join(directory, 'server-cert.pem')));
    return { directory, configPath, appConfig: path.join(directory, 'lan-config.json'), reused: true };
  }
  const cert = path.join(directory, 'server-cert.pem'), key = path.join(directory, 'server-key.pem');
  if (fs.existsSync(cert) || fs.existsSync(key)) throw new Error('Incomplete pairing directory; use a new empty directory');
  execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '825', '-subj', '/CN=Quest LAN Receiver',
    '-addext', `subjectAltName=IP:${host}`, '-keyout', key, '-out', cert], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  fs.chmodSync(key, 0o600);
  const certificate = new X509Certificate(fs.readFileSync(cert));
  const config = { version: 1, host, port, cert_sha256: certificate.fingerprint256.replaceAll(':', '').toLowerCase(), token: randomBytes(32).toString('hex') };
  for (const file of [configPath, path.join(directory, 'lan-config.json')]) fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { directory, configPath, appConfig: path.join(directory, 'lan-config.json'), reused: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [host, directory, openssl] = process.argv.slice(2);
    console.log(JSON.stringify(prepareLan({ host, directory, openssl })));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
