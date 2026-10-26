import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { validatePacket } from './receiver.mjs';
import { full6dof } from './capture-session.mjs';

/** Read-only audit: also useful after a crash; never rewrites originals. */
export async function inspectSession(directory) {
  directory = path.resolve(directory);
  const manifest = JSON.parse(await fs.promises.readFile(path.join(directory, 'manifest.json'), 'utf8'));
  const result = { session_id: manifest.session_id, state: manifest.state, directory, complete: manifest.state === 'complete',
    packets: 0, frames: 0, dual_6dof_frames: 0, files: [], errors: [], hands: { left: {}, right: {} } };
  const listed = new Map(manifest.files.map(file => [file.file, file]));
  const rawNames = (await fs.promises.readdir(path.join(directory, 'raw'))).filter(name => /^\d{6}\.jsonl$/.test(name)).sort();
  const seenSamples = new Set();
  for (const name of [...rawNames.map(file => `raw/${file}`), 'events.jsonl']) {
    const absolute = path.join(directory, name), hash = createHash('sha256'); let bytes = 0, lastByte;
    const input = fs.createReadStream(absolute);
    input.on('data', chunk => { hash.update(chunk); bytes += chunk.length; lastByte = chunk.at(-1); });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    let lineNumber = 0;
    for await (const line of lines) {
      ++lineNumber; if (!line.trim()) continue;
      try {
        const packet = JSON.parse(line);
        if (name === 'events.jsonl') continue;
        validatePacket(packet); ++result.packets;
        if (!packet.capture?.sample_id || seenSamples.has(packet.capture.sample_id)) throw new Error('Missing or duplicated sample id');
        seenSamples.add(packet.capture.sample_id);
        if (packet.kind === 'frame') {
          ++result.frames; if (full6dof(packet)) ++result.dual_6dof_frames;
          for (const side of ['left', 'right']) {
            const hand = packet[side], summary = result.hands[side];
            for (const [button, value] of Object.entries(hand.buttons)) if (value === true) summary[button] = (summary[button] ?? 0) + 1;
            for (const axis of ['trigger', 'squeeze']) if (hand[axis] !== null) summary[`${axis}_max`] = Math.max(summary[`${axis}_max`] ?? 0, hand[axis]);
            if (hand.thumbstick) summary.stick_max_magnitude = Math.max(summary.stick_max_magnitude ?? 0, Math.hypot(...hand.thumbstick));
          }
        }
      } catch (error) { result.errors.push(`${name}:${lineNumber} ${error.message}`); }
    }
    if (bytes && lastByte !== 10) result.errors.push(`${name}: unterminated final line (possible crash tail)`);
    const digest = hash.digest('hex'), expected = listed.get(name);
    const verified = !!expected && digest === expected.sha256 && bytes === expected.bytes;
    result.files.push({ file: name, bytes, sha256: digest, verified });
    if (result.complete && !verified) result.errors.push(`${name}: final checksum absent or mismatched`);
  }
  for (const name of listed.keys()) if (!result.files.some(file => file.file === name)) result.errors.push(`Missing listed file: ${name}`);
  if (result.complete && (result.packets !== manifest.statistics.packets || result.frames !== manifest.statistics.frames || result.dual_6dof_frames !== manifest.statistics.dual_6dof_frames))
    result.errors.push('Final manifest counters do not match raw data');
  result.integrity_ok = result.complete && !result.errors.length;
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { const report = await inspectSession(process.argv[2]); console.log(JSON.stringify(report, null, 2)); if (!report.integrity_ok) process.exitCode = 1; }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
