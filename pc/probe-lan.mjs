import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createLanReceiver } from './lan-receiver.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serial = process.argv[2];
if (!/^[a-zA-Z0-9]+$/.test(serial ?? '')) throw new Error('Explicit USB serial required');
const adb = 'C:/Android/Sdk/platform-tools/adb.exe';
const run = (args, input) => new Promise((resolve, reject) => {
  const child = spawn(adb, ['-s', serial, ...args], { windowsHide: true, timeout: 15_000 });
  let stdout = '', stderr = ''; child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
  child.once('error', reject); child.once('close', code => code === 0 ? resolve(stdout) : reject(new Error(`ADB probe command failed (${code}); output withheld`)));
  child.stdin.on('error', () => {}); child.stdin.end(input);
});
const configPath = path.join(project, '.local/lan/receiver.json'), config = JSON.parse(fs.readFileSync(configPath));
const directory = path.dirname(configPath), remote = `/data/local/tmp/quest-lan-probe-${randomUUID()}.dex`;
const received = [];
const receiver = await createLanReceiver({ host: config.host, port: config.port, token: config.token,
  cert: fs.readFileSync(path.join(directory, 'server-cert.pem')), key: fs.readFileSync(path.join(directory, 'server-key.pem')),
  onPacket: packet => received.push({ kind: packet.kind, state: packet.state }), onError: () => {} });
const results = [];
try {
  if ((await run(['shell', 'getprop', 'ro.serialno'])).trim() !== serial) throw new Error('USB identity mismatch');
  await run(['push', path.join(project, 'build/lan-probe/dex/classes.dex'), remote]);
  await run(['shell', 'chmod', '0444', remote]);
  for (const mode of ['normal', 'bad-pin', 'bad-token']) {
    const response = await run(['shell', '-T', `CLASSPATH=${remote}`, 'app_process', '/', 'dev.quest.usbforwarder.LanTlsProbe', mode], JSON.stringify({ ...config, port: receiver.port }) + '\n');
    const match = /QUEST_LAN_PROBE (\{[^\r\n]+\})/.exec(response);
    if (!match) throw new Error('Probe result absent; output withheld');
    results.push({ mode, ...JSON.parse(match[1]) });
  }
} finally {
  await receiver.close();
  await run(['shell', 'rm', remote]); // Exact unique diagnostic path, no recursive or wildcard deletion.
}
const report = { schema: 'quest-lan-transport-preflight-v1', date: '2026-10-26', at_utc: new Date().toISOString(),
  transport: 'actual Android SSLSocket helper to separate LAN TLS probe receiver; USB only launches diagnostic', results, received,
  passed: results.length === 3 && results[0].sent && !results[1].sent && !results[2].sent && received.length === 1,
  headset_app_started: false, tracking_validated: false, temporary_dex_removed: true };
fs.mkdirSync(path.join(project, 'validation/2026-10-26'), { recursive: true });
fs.writeFileSync(path.join(project, `validation/2026-10-26/lan-transport-preflight-${Date.now()}.json`), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(report, null, 2)); if (!report.passed) process.exitCode = 1;
