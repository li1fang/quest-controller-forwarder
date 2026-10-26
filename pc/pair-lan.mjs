import fs from 'node:fs';
import path from 'node:path';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { readPairing, writePairing } from './lan-pairing.mjs';

/** Export only the client trust material. Private key is never copied to the headset. */
export function preparePairingImport(configFile) {
  configFile = path.resolve(configFile);
  const pairing = readPairing(configFile), directory = path.dirname(configFile);
  const certificate = new X509Certificate(fs.readFileSync(path.join(directory, 'server-cert.pem')));
  if (certificate.fingerprint256.replaceAll(':', '').toLowerCase() !== pairing.cert_sha256 ||
      !certificate.checkPrivateKey(createPrivateKey(fs.readFileSync(path.join(directory, 'server-key.pem'))))) throw new Error('Receiver certificate/key mismatch; no pairing exported');
  const appConfig = path.join(directory, 'lan-config.json');
  writePairing(appConfig, pairing);
  return { endpoint: `${pairing.host}:${pairing.port}`, cert_sha256: pairing.cert_sha256, app_config: appConfig };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== '--config') throw new Error('Usage: node pc/pair-lan.mjs --config .local/lan/receiver.json');
    console.log(JSON.stringify(preparePairingImport(args[1])));
  } catch { console.error('Pairing export failed; check configuration and certificate/key files locally. Values withheld.'); process.exitCode = 1; }
}
