import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { inspectSession } from './inspect-session.mjs';
import { full6dof } from './capture-session.mjs';

/** Offline quality analysis. Original recordings and labels are never modified. */
export async function analyzeSession(directory) {
  const audit = await inspectSession(directory);
  if (!audit.integrity_ok) throw new Error('Session integrity audit failed; run inspect-session for details');
  const manifest = JSON.parse(await fs.promises.readFile(path.join(directory, 'manifest.json')));
  const result = { schema: 'quest-capture-quality-v1', session_id: audit.session_id, integrity_ok: true,
    files: audit.files, packets: 0, frames: 0, focused_frames: 0, dual_6dof_frames: 0,
    first_received_at_utc: null, last_received_at_utc: null, received_span_s: 0,
    continuous_frame_time_s: 0, dual_6dof_time_s: 0, longest_dual_6dof_s: 0,
    status_counts: {}, hands: {}, runs: [], coordinate_segments: [], dual_6dof_intervals: [],
    observations: { usb_unplugged: 'not established by telemetry', headset_unworn: 'not measured', proximity_covered: 'not measured' },
    recorded_statistics: manifest.statistics };
  const runs = new Map(), segments = new Map(); let previous = null, interval = null;
  for (const side of ['left', 'right']) result.hands[side] = { pose_active_frames: 0, tracked_6dof_frames: 0,
    valid_position_untracked_frames: 0, linear_velocity_valid_frames: 0, angular_velocity_valid_frames: 0,
    buttons: {}, trigger_range: null, squeeze_range: null, thumbstick_range: null, max_speed_m_s: 0 };
  const range = (bounds, values) => values.map((value, i) => [Math.min(bounds?.[i][0] ?? value, value), Math.max(bounds?.[i][1] ?? value, value)]);
  const finishInterval = () => { if (interval) result.dual_6dof_intervals.push(interval); interval = null; };
  for (const file of audit.files.filter(file => file.file.startsWith('raw/'))) {
    const input = fs.createReadStream(path.join(directory, file.file));
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        const packet = JSON.parse(line), capture = packet.capture;
        ++result.packets;
        result.first_received_at_utc ??= packet.received_at_utc; result.last_received_at_utc = packet.received_at_utc;
        let run = runs.get(capture.app_run_id);
        if (!run) { run = { app_run_id: capture.app_run_id, packets: 0, frames: 0, dual_6dof_frames: 0,
          first_received_at_utc: packet.received_at_utc, last_received_at_utc: null, connections: [] }; runs.set(capture.app_run_id, run); }
        ++run.packets; run.last_received_at_utc = packet.received_at_utc;
        if (!run.connections.includes(capture.connection_id)) run.connections.push(capture.connection_id);
        if (packet.kind !== 'frame') { result.status_counts[packet.state] = (result.status_counts[packet.state] ?? 0) + 1; previous = null; finishInterval(); continue; }
        ++result.frames; ++run.frames; if (packet.focused) ++result.focused_frames;
        const dual = full6dof(packet), time = BigInt(packet.device_monotonic_ns);
        const same = previous && capture.connection_id === previous.capture.connection_id && capture.coordinate_segment_id === previous.capture.coordinate_segment_id;
        const delta = same ? Number(time - previous.time) / 1e9 : 0;
        const contiguous = same && packet.sequence === previous.sequence + 1 && delta > 0 && delta <= .25;
        if (contiguous) result.continuous_frame_time_s += delta;
        if (dual) {
          ++result.dual_6dof_frames; ++run.dual_6dof_frames;
          if (!contiguous || !previous.dual) { finishInterval(); interval = { coordinate_segment_id: capture.coordinate_segment_id,
            start_sample_id: capture.sample_id, end_sample_id: capture.sample_id, frames: 0, duration_s: 0 }; }
          ++interval.frames; interval.end_sample_id = capture.sample_id;
          if (contiguous && previous.dual) { interval.duration_s += delta; result.dual_6dof_time_s += delta; }
          result.longest_dual_6dof_s = Math.max(result.longest_dual_6dof_s, interval.duration_s);
        } else finishInterval();
        let segment = segments.get(capture.coordinate_segment_id);
        if (!segment) { segment = { id: capture.coordinate_segment_id, frames: 0, dual_6dof_frames: 0, tracked_position_ranges_m: {} }; segments.set(segment.id, segment); }
        ++segment.frames; if (dual) ++segment.dual_6dof_frames;
        for (const side of ['left', 'right']) {
          const hand = packet[side], summary = result.hands[side];
          if (hand.pose_active) ++summary.pose_active_frames;
          const tracked = packet.focused && hand.pose_active && hand.position_valid && hand.orientation_valid && hand.position_tracked && hand.orientation_tracked;
          if (tracked) { ++summary.tracked_6dof_frames; segment.tracked_position_ranges_m[side] = range(segment.tracked_position_ranges_m[side], hand.position_m); }
          if (hand.position_valid && !hand.position_tracked) ++summary.valid_position_untracked_frames;
          if (hand.linear_velocity_valid) { ++summary.linear_velocity_valid_frames; summary.max_speed_m_s = Math.max(summary.max_speed_m_s, Math.hypot(...hand.linear_velocity_m_s)); }
          if (hand.angular_velocity_valid) ++summary.angular_velocity_valid_frames;
          for (const [button, value] of Object.entries(hand.buttons)) {
            const counter = summary.buttons[button] ??= { true_frames: 0, false_frames: 0, unavailable_frames: 0 };
            ++counter[value === true ? 'true_frames' : value === false ? 'false_frames' : 'unavailable_frames'];
          }
          for (const axis of ['trigger', 'squeeze']) if (hand[axis] !== null) summary[axis + '_range'] = range(summary[axis + '_range'], [hand[axis]]);
          if (hand.thumbstick) summary.thumbstick_range = range(summary.thumbstick_range, hand.thumbstick);
        }
        previous = { time, sequence: packet.sequence, capture, dual };
      }
    } finally { lines.close(); input.destroy(); }
  }
  finishInterval(); result.runs = [...runs.values()]; result.coordinate_segments = [...segments.values()];
  result.received_span_s = result.packets ? (Date.parse(result.last_received_at_utc) - Date.parse(result.first_received_at_utc)) / 1000 : 0;
  result.dual_6dof_frame_fraction = result.frames ? result.dual_6dof_frames / result.frames : 0;
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await analyzeSession(process.argv[2]), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
