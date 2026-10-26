import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, X509Certificate, createPrivateKey } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { isPrivateIPv4, readPairing, writePairing } from './lan-pairing.mjs';
export { isPrivateIPv4 } from './lan-pairing.mjs';

export function prepareLan({ host, port = 19428, directory = '.local/lan', openssl = 'openssl' }) {
  if (!isPrivateIPv4(host)) throw new Error('Choose an explicit private LAN IPv4 address');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid LAN port');
  directory = path.resolve(directory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const configPath = path.join(directory, 'receiver.json');
  if (fs.existsSync(configPath)) {
    const existing = readPairing(configPath);
    const certificate = new X509Certificate(fs.readFileSync(path.join(directory, 'server-cert.pem')));
    if (certificate.fingerprint256.replaceAll(':', '').toLowerCase() !== existing.cert_sha256 ||
        !certificate.checkPrivateKey(createPrivateKey(fs.readFileSync(path.join(directory, 'server-key.pem'))))) throw new Error('Existing LAN certificate/key mismatch; pairing kept');
    const updated = existing.host !== host || existing.port !== port;
    if (updated) writePairing(configPath, { ...existing, host, port });
    // Recreate a missing/outdated client export after an interrupted previous update.
    writePairing(path.join(directory, 'lan-config.json'), { ...existing, host, port });
    return { directory, configPath, appConfig: path.join(directory, 'lan-config.json'), reused: true, endpoint_updated: updated };
  }
  const cert = path.join(directory, 'server-cert.pem'), key = path.join(directory, 'server-key.pem');
  if (fs.existsSync(cert) || fs.existsSync(key)) throw new Error('Incomplete pairing directory; use a new empty directory');
  execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '825', '-subj', '/CN=Quest LAN Receiver',
    '-addext', `subjectAltName=IP:${host}`, '-keyout', key, '-out', cert], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  fs.chmodSync(key, 0o600);
  const certificate = new X509Certificate(fs.readFileSync(cert));
  const config = { version: 1, host, port, cert_sha256: certificate.fingerprint256.replaceAll(':', '').toLowerCase(), token: randomBytes(32).toString('hex') };
  for (const file of [configPath, path.join(directory, 'lan-config.json')]) writePairing(file, config);
  return { directory, configPath, appConfig: path.join(directory, 'lan-config.json'), reused: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [host, directory, openssl] = process.argv.slice(2);
    console.log(JSON.stringify(prepareLan({ host, directory, openssl })));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
