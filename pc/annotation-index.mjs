import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inspectSession } from './inspect-session.mjs';

const tracked = (p, side) => { const h = p[side]; return !!(p.focused && h.pose_active && h.position_valid && h.position_tracked && h.orientation_valid && h.orientation_tracked); };
const signature = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
const sourceChanged = () => new Error('Source recording changed; reopen the session');

// Count real bytes, including CRLF delimiters and multibyte UTF-8, rather than JS characters.
async function* indexedLines(file, hash) {
  let pending = Buffer.alloc(0), position = 0;
  for await (const chunk of fs.createReadStream(file)) {
    hash.update(chunk);
    const bytes = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let start = 0, end;
    while ((end = bytes.indexOf(10, start)) !== -1) {
      const contentEnd = end > start && bytes[end - 1] === 13 ? end - 1 : end;
      if (contentEnd - start > 1024 * 1024) throw new Error('Recording line exceeds supported size');
      yield { text: bytes.toString('utf8', start, contentEnd), offset: position + start, bytes: contentEnd - start };
      start = end + 1;
    }
    position += start; pending = bytes.subarray(start);
    if (pending.length > 1024 * 1024) throw new Error('Recording line exceeds supported size');
  }
  if (pending.length) throw new Error('Recording has an unterminated final line');
}

/** Verified compact index. Full pose objects are loaded only for a requested window. */
export async function openAnnotationSession(directory) {
  directory = path.resolve(directory);
  const report = await inspectSession(directory);
  if (!report.integrity_ok) throw new Error('Recording integrity check failed; raw data was not changed');
  const files = report.files.filter(file => file.file.startsWith('raw/'));
  const identities = new Map();
  for (const name of ['manifest.json', ...report.files.map(file => file.file)])
    identities.set(name, signature(await fs.promises.stat(path.join(directory, name), { bigint: true })));
  const index = [], segments = [], invalidRanges = [], locations = [], ordinals = [];
  let origin, previous = -Infinity, invalid, ordinal = 0;
  for (let fileNumber = 0; fileNumber < files.length; ++fileNumber) {
    const file = files[fileNumber], hash = createHash('sha256');
    for await (const line of indexedLines(path.join(directory, file.file), hash)) {
      if (!line.text.trim()) continue;
      const p = JSON.parse(line.text); ++ordinal;
      if (p.kind !== 'frame') continue;
      if (typeof p.pc_monotonic_ns !== 'string' || !/^\d+$/.test(p.pc_monotonic_ns)) throw new Error('Recording lacks a monotonic receipt timeline');
      const now = BigInt(p.pc_monotonic_ns); origin ??= now;
      const time = Number(now - origin) / 1e6;
      if (time < previous) throw new Error('Recording receipt timeline is not monotonic'); previous = time;
      const segment = p.capture.coordinate_segment_id;
      if (!segments.includes(segment)) segments.push(segment);
      const left = tracked(p, 'left'), right = tracked(p, 'right'), number = Number(p.capture.sample_id.split(':').at(-1));
      if (!Number.isSafeInteger(number) || number < 1 || (index.length && number <= index.at(-1)[1])) throw new Error('Recording sample ids are not ordered');
      index.push([time, number, segments.indexOf(segment), left ? 1 : 0, right ? 1 : 0]);
      locations.push([fileNumber, line.offset, line.bytes]); ordinals.push(ordinal);
      if (!left || !right) {
        if (!invalid) { invalid = { first_frame: index.length, last_frame: index.length, start_ms: time, end_ms: time }; invalidRanges.push(invalid); }
        invalid.last_frame = index.length; invalid.end_ms = time;
      } else invalid = null;
    }
    if (hash.digest('hex') !== file.sha256) throw sourceChanged();
  }
  if (!index.length) throw new Error('Recording contains no pose frames');
  const rawFiles = files.map(({ file, sha256 }) => ({ file, sha256 }));
  const metadata = { schema: 'quest-annotation-playback-v1', session_id: report.session_id, name: path.basename(directory), frame_count: index.length,
    packet_count: report.packets, duration_ms: index.at(-1)[0], time_basis: 'PC receipt monotonic time relative to first pose frame; not device motion time or network latency',
    index_columns: ['time_ms', 'sample_number', 'segment_index', 'left_tracked', 'right_tracked'], index, segments, invalid_ranges: invalidRanges,
    dual_6dof_frames: report.dual_6dof_frames, integrity_verified: true, raw_files: rawFiles };
  async function assertUnchanged() {
    try {
      for (const [name, expected] of identities)
        if (signature(await fs.promises.stat(path.join(directory, name), { bigint: true })) !== expected) throw sourceChanged();
    } catch { throw sourceChanged(); }
  }
  async function readFrames(offset, limit = 256) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= index.length || !Number.isSafeInteger(limit) || limit < 1 || limit > 512) throw new Error('Invalid frame window');
    await assertUnchanged();
    const result = [], end = Math.min(index.length, offset + limit);
    for (let at = offset; at < end;) {
      const [fileNumber, start] = locations[at]; let stop = at + 1;
      while (stop < end && locations[stop][0] === fileNumber && locations[stop][1] + locations[stop][2] - start <= 2 * 1024 * 1024) ++stop;
      const final = locations[stop - 1], length = final[1] + final[2] - start;
      const handle = await fs.promises.open(path.join(directory, files[fileNumber].file), 'r');
      try {
        if (signature(await handle.stat({ bigint: true })) !== identities.get(files[fileNumber].file)) throw sourceChanged();
        const bytes = Buffer.allocUnsafe(length); let read = 0;
        while (read < length) {
          const part = await handle.read(bytes, read, length - read, start + read);
          if (!part.bytesRead) throw sourceChanged(); read += part.bytesRead;
        }
        for (let i = at; i < stop; ++i) {
          const [, position, size] = locations[i];
          result.push(JSON.parse(bytes.toString('utf8', position - start, position - start + size)));
        }
      } finally { await handle.close(); }
      at = stop;
    }
    await assertUnchanged(); return result;
  }
  async function annotationRange(start, end) {
    const find = number => {
      let low = 0, high = index.length;
      while (low < high) { const middle = Math.floor((low + high) / 2); if (index[middle][1] < number) low = middle + 1; else high = middle; }
      return low < index.length && index[low][1] === number ? low : -1;
    };
    const first = find(start), last = find(end);
    if (first < 0 || last < first) throw new Error('Range endpoints must refer to recorded pose frames');
    const segment = index[first][2], quality = { frames: last - first + 1, dual_6dof_frames: 0, left_tracked_frames: 0, right_tracked_frames: 0,
      status_packets: ordinals[last] - ordinals[first] - (last - first) };
    for (let i = first; i <= last; ++i) {
      const row = index[i]; if (row[2] !== segment) throw new Error('Annotation crosses coordinate segments; split it');
      quality.left_tracked_frames += row[3]; quality.right_tracked_frames += row[4]; if (row[3] && row[4]) ++quality.dual_6dof_frames;
    }
    const [a] = await readFrames(first, 1), [b] = first === last ? [a] : await readFrames(last, 1);
    return { first: a, last: b, segment: segments[segment], quality };
  }
  await assertUnchanged();
  return { directory, report, metadata, rawFiles, readFrames, assertUnchanged, annotationRange };
}
