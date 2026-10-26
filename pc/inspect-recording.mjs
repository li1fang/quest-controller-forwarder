import fs from 'node:fs';
import readline from 'node:readline';
import { validatePacket } from './receiver.mjs';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node pc/inspect-recording.mjs recordings/session.jsonl');
  process.exitCode = 1;
} else {
  try {
    const summary = { file, packets: 0, frames: 0, focused_frames: 0, head_position_tracked_frames: 0, both_hands_6dof_frames: 0, longest_both_hands_6dof_seconds: 0, invalid_lines: 0, sample_time_sources: {}, hands: {} };
    for (const side of ['left', 'right']) summary.hands[side] = {
      position_valid_frames: 0, position_tracked_frames: 0, orientation_tracked_frames: 0,
      linear_velocity_valid_frames: 0, angular_velocity_valid_frames: 0,
      max_trigger: 0, max_squeeze: 0, max_thumbstick_magnitude: 0,
      max_linear_speed_m_s: 0, max_angular_speed_rad_s: 0, button_true_frames: {},
    };
    let firstTime, lastTime, trackedSince, previousTime;
    const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      let packet;
      try { packet = validatePacket(JSON.parse(line)); }
      catch { ++summary.invalid_lines; continue; }
      ++summary.packets;
      if (packet.kind !== 'frame') continue;
      ++summary.frames;
      firstTime ??= BigInt(packet.device_monotonic_ns);
      lastTime = BigInt(packet.device_monotonic_ns);
      const bothTracked = packet.focused && ['left', 'right'].every(side => packet[side].position_tracked && packet[side].orientation_tracked);
      if (bothTracked) {
        ++summary.both_hands_6dof_frames;
        if (trackedSince === undefined || (previousTime !== undefined && lastTime - previousTime > 250000000n)) trackedSince = lastTime;
        summary.longest_both_hands_6dof_seconds = Math.max(summary.longest_both_hands_6dof_seconds, Number(lastTime - trackedSince) / 1e9);
      } else trackedSince = undefined;
      previousTime = lastTime;
      if (packet.focused) ++summary.focused_frames;
      if (packet.head_tracking?.position_tracked) ++summary.head_position_tracked_frames;
      const source = packet.sample_time_source ?? 'unspecified';
      summary.sample_time_sources[source] = (summary.sample_time_sources[source] ?? 0) + 1;
      for (const side of ['left', 'right']) {
        const hand = packet[side], result = summary.hands[side];
        for (const flag of ['position_valid', 'position_tracked', 'orientation_tracked', 'linear_velocity_valid', 'angular_velocity_valid']) {
          if (hand[flag]) ++result[flag + '_frames'];
        }
        result.max_trigger = Math.max(result.max_trigger, hand.trigger ?? 0);
        result.max_squeeze = Math.max(result.max_squeeze, hand.squeeze ?? 0);
        result.max_thumbstick_magnitude = Math.max(result.max_thumbstick_magnitude, Math.hypot(...(hand.thumbstick ?? [0, 0])));
        // Speeds can be valid even while position tracking is inferred. Keep tracking counts alongside them.
        result.max_linear_speed_m_s = Math.max(result.max_linear_speed_m_s, Math.hypot(...(hand.linear_velocity_m_s ?? [0, 0, 0])));
        result.max_angular_speed_rad_s = Math.max(result.max_angular_speed_rad_s, Math.hypot(...(hand.angular_velocity_rad_s ?? [0, 0, 0])));
        for (const [button, pressed] of Object.entries(hand.buttons)) {
          if (pressed === true) result.button_true_frames[button] = (result.button_true_frames[button] ?? 0) + 1;
        }
      }
    }
    summary.duration_seconds = firstTime !== undefined ? Number(lastTime - firstTime) / 1e9 : 0;
    summary.average_frame_rate_hz = summary.duration_seconds > 0 ? (summary.frames - 1) / summary.duration_seconds : 0;
    summary.both_hands_6dof_observed = summary.both_hands_6dof_frames > 0;
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
