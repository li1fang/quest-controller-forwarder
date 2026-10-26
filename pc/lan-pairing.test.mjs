import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { X509Certificate } from 'node:crypto';
import { prepareLan } from './prepare-lan.mjs';
import { readPairing, validatePairing, writePairing } from './lan-pairing.mjs';
import { preparePairingImport } from './pair-lan.mjs';

const fixture = () => ({ version: 1, host: '192.168.1.2', port: 19428, cert_sha256: 'a'.repeat(64), token: 'b'.repeat(64) });
const openssl = process.env.QUEST_TEST_OPENSSL ?? (process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl');
function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quest-pairing-test-'));
  t.after(() => { assert.equal(path.dirname(directory), os.tmpdir()); assert.ok(path.basename(directory).startsWith('quest-pairing-test-')); fs.rmSync(directory, { recursive: true, force: true }); });
  return directory;
}
test('runtime pairing rejects public/ambiguous endpoints, malformed trust and coercion without leaking input', () => {
  assert.deepEqual(validatePairing(fixture()), fixture());
  const invalid = [null, [], {}, { ...fixture(), extra: 1 }, { ...fixture(), version: '1' }, { ...fixture(), port: '19428' },
    ...[0, -1, 65536, 1.5, NaN].map(port => ({ ...fixture(), port })),
    ...['localhost', '127.0.0.1', '0.0.0.0', '::1', '8.8.8.8', '192.168.001.2', '192.168.1.256', '192.168.1.2\n'].map(host => ({ ...fixture(), host })),
    { ...fixture(), token: 'SECRET-INPUT' }, { ...fixture(), cert_sha256: 'A'.repeat(64) }];
  for (const value of invalid) assert.throws(() => validatePairing(value), error => !error.message.includes('SECRET-INPUT') && /Invalid LAN pairing/.test(error.message));
});
test('invalid import and interrupted-file input do not overwrite a saved pairing; atomic replace leaves no pending secret', t => {
  const directory = temporary(t), file = path.join(directory, 'saved.json');
  writePairing(file, fixture()); const before = fs.readFileSync(file);
  assert.throws(() => writePairing(file, { ...fixture(), port: 0 }));
  assert.deepEqual(fs.readFileSync(file), before);
  for (const text of ['{"token":"PRIVATE-INPUT",', ' '.repeat(4097)]) {
    const invalid = path.join(directory, 'invalid.json'); fs.writeFileSync(invalid, text);
    assert.throws(() => readPairing(invalid), error => !error.message.includes('PRIVATE-INPUT'));
  }
  writePairing(file, { ...fixture(), host: '10.1.2.3' }); assert.equal(readPairing(file).host, '10.1.2.3');
  assert.ok(!fs.readdirSync(directory).some(name => name.endsWith('.tmp')));
});
test('endpoint can change without rotating TLS identity/token, and a missing client export is repaired', t => {
  const directory = temporary(t), first = prepareLan({ host: '192.168.1.2', directory, openssl });
  const old = readPairing(first.configPath), key = fs.readFileSync(path.join(directory, 'server-key.pem'));
  const cert = fs.readFileSync(path.join(directory, 'server-cert.pem'));
  fs.unlinkSync(first.appConfig);
  const next = prepareLan({ host: '10.2.3.4', port: 19429, directory, openssl });
  assert.equal(next.reused, true); assert.equal(next.endpoint_updated, true);
  const updated = readPairing(next.configPath);
  assert.deepEqual(updated, { ...old, host: '10.2.3.4', port: 19429 });
  assert.deepEqual(readPairing(next.appConfig), updated);
  assert.deepEqual(fs.readFileSync(path.join(directory, 'server-key.pem')), key);
  assert.deepEqual(fs.readFileSync(path.join(directory, 'server-cert.pem')), cert);
  assert.equal(updated.cert_sha256, new X509Certificate(cert).fingerprint256.replaceAll(':', '').toLowerCase());
  const exported = preparePairingImport(next.configPath);
  assert.equal(exported.endpoint, '10.2.3.4:19429'); assert.ok(!JSON.stringify(exported).includes(old.token));
  assert.deepEqual(Object.keys(readPairing(exported.app_config)).sort(), ['cert_sha256', 'host', 'port', 'token', 'version']);
});
test('mismatched certificate or key refuses endpoint update/export and preserves existing files', t => {
  const directory = temporary(t), first = prepareLan({ host: '192.168.1.2', directory: path.join(directory, 'first'), openssl });
  const other = prepareLan({ host: '192.168.1.2', directory: path.join(directory, 'other'), openssl });
  const before = fs.readFileSync(first.configPath), exported = fs.readFileSync(first.appConfig);
  fs.copyFileSync(path.join(other.directory, 'server-key.pem'), path.join(first.directory, 'server-key.pem'));
  assert.throws(() => prepareLan({ host: '10.2.3.4', directory: first.directory, openssl }), /mismatch/);
  assert.throws(() => preparePairingImport(first.configPath), /mismatch/);
  assert.deepEqual(fs.readFileSync(first.configPath), before); assert.deepEqual(fs.readFileSync(first.appConfig), exported);
});
