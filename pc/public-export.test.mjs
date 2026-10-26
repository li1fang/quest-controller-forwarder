import test from 'node:test';
import assert from 'node:assert/strict';
import { collectPublicFiles, auditSourceFile } from '../scripts/export-public.mjs';

test('public source allowlist excludes local evidence, device-specific installers, recordings and images', () => {
  const files = collectPublicFiles();
  for (const required of ['LICENSE', 'README.md', 'app/AndroidManifest.xml', 'pc/annotation-server.mjs', 'web/annotate.html', 'third_party/licenses/threejs-MIT.txt']) assert.ok(files.includes(required), required);
  assert.ok(!files.some(name => /^(validation|recordings|\.local|\.git)\//.test(name)));
  assert.ok(!files.some(name => /install-lan-candidate|Install-Quest-LAN-Candidate|\.(png|apk|pem)$/.test(name)));
});
test('source audit rejects sensitive artifacts and identity literals without printing their values', () => {
  for (const name of ['.local/lan/receiver.json', 'app/assets/lan-config.json', 'recordings/raw.json', 'private.pem']) assert.throws(() => auditSourceFile(name, '{}'), /selected/);
  const serial = ['123', 'AB', 'EXAMPLE1234'].join('');
  assert.throws(() => auditSourceFile('example.txt', serial), error => /serial/.test(error.message) && !error.message.includes(serial));
  assert.throws(() => auditSourceFile('example.txt', JSON.stringify({ token: 'a'.repeat(64) })), /pairing token/);
  assert.doesNotThrow(() => auditSourceFile('pc/test.mjs', "const token = 'a'.repeat(64);"));
});
