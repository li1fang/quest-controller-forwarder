import { isIP } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function isPrivateIPv4(host) {
  if (typeof host !== 'string' || isIP(host) !== 4) return false;
  const [a, b] = host.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
export function validatePairing(value) {
  if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'cert_sha256,host,port,token,version' ||
    value.version !== 1 || !isPrivateIPv4(value.host) || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 ||
    typeof value.cert_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.cert_sha256) ||
    typeof value.token !== 'string' || !/^[a-f0-9]{64}$/.test(value.token)) throw new Error('Invalid LAN pairing configuration; values withheld');
  return { version: 1, host: value.host, port: value.port, cert_sha256: value.cert_sha256, token: value.token };
}
export function readPairing(file) {
  const bytes = fs.readFileSync(file);
  if (bytes.length > 4096) throw new Error('Pairing file too large');
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Invalid pairing JSON; values withheld'); }
  return validatePairing(value);
}
export function writePairing(file, value) {
  const text = JSON.stringify(validatePairing(value), null, 2) + '\n';
  const pending = path.join(path.dirname(file), `.pairing-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(pending, text, { mode: 0o600, flag: 'wx' });
    fs.renameSync(pending, file);
  } finally { if (fs.existsSync(pending)) fs.unlinkSync(pending); }
}
