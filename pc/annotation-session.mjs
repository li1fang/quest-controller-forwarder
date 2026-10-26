import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { inspectSession } from './inspect-session.mjs';

const tracked = (p, side) => { const h = p[side]; return !!(p.focused && h.pose_active && h.position_valid && h.position_tracked && h.orientation_valid && h.orientation_tracked); };
/** Indexed, verified recorded frames. No receiver, device connection or rewritten timestamps. */
export async function loadAnnotationSession(directory) {
  directory = path.resolve(directory);
  const report = await inspectSession(directory);
  if (!report.integrity_ok) throw new Error('Recording integrity check failed; raw data was not changed');
  const frames = [], index = [], segments = [], invalidRanges = [];
  let origin, previous = -Infinity, invalid;
  for (const file of report.files.filter(file => file.file.startsWith('raw/'))) {
    const input = fs.createReadStream(path.join(directory, file.file));
    for await (const line of readline.createInterface({ input, crlfDelay: Infinity })) {
      if (!line.trim()) continue;
      const p = JSON.parse(line); if (p.kind !== 'frame') continue;
      if (typeof p.pc_monotonic_ns !== 'string' || !/^\d+$/.test(p.pc_monotonic_ns)) throw new Error('Recording lacks a monotonic receipt timeline');
      const now = BigInt(p.pc_monotonic_ns); origin ??= now;
      const time = Number(now - origin) / 1e6;
      if (time < previous) throw new Error('Recording receipt timeline is not monotonic'); previous = time;
      const segment = p.capture.coordinate_segment_id;
      if (!segments.includes(segment)) segments.push(segment);
      const left = tracked(p, 'left'), right = tracked(p, 'right'), number = Number(p.capture.sample_id.split(':').at(-1));
      index.push([time, number, segments.indexOf(segment), left ? 1 : 0, right ? 1 : 0]); frames.push(p);
      if (!left || !right) {
        if (!invalid) { invalid = { first_frame: frames.length, last_frame: frames.length, start_ms: time, end_ms: time }; invalidRanges.push(invalid); }
        invalid.last_frame = frames.length; invalid.end_ms = time;
      } else invalid = null;
    }
  }
  if (!frames.length) throw new Error('Recording contains no pose frames');
  const rawFiles = report.files.filter(file => file.file.startsWith('raw/')).map(({ file, sha256 }) => ({ file, sha256 }));
  const metadata = { schema: 'quest-annotation-playback-v1', session_id: report.session_id, name: path.basename(directory), frame_count: frames.length,
    packet_count: report.packets, duration_ms: index.at(-1)[0], time_basis: 'PC receipt monotonic time relative to first pose frame; not device motion time or network latency',
    index_columns: ['time_ms', 'sample_number', 'segment_index', 'left_tracked', 'right_tracked'], index, segments, invalid_ranges: invalidRanges,
    dual_6dof_frames: report.dual_6dof_frames, integrity_verified: true, raw_files: rawFiles };
  return { directory, report, metadata, frames, rawFiles };
}
