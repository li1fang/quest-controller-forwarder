import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { full6dof } from './capture-session.mjs';

const sides = ['left', 'right'];
export const VALIDATION_ITEMS = sides.flatMap(side => [
  ...['position', 'rotation', 'velocity', 'trigger', 'squeeze', 'stick', 'thumbstick_click', ...(side === 'left' ? ['x', 'y', 'menu'] : ['a', 'b'])]
    .map(key => ({ id: `${side}.${key}`, side, key, label: { position: '移动 ≥10cm', rotation: '旋转 ≥20°', velocity: '线/角速度',
      trigger: '扳机压下/松开', squeeze: '握把压下/松开', stick: '摇杆四向', thumbstick_click: '摇杆按下/松开', x: 'X', y: 'Y', menu: '菜单', a: 'A', b: 'B' }[key] })),
]);
function checkConditions(value) {
  if (!value || value.usb_disconnected !== true || value.headset_removed !== true || !['covered', 'uncovered'].includes(value.proximity))
    throw Object.assign(new Error('Confirm USB disconnected, headset removed and proximity condition'), { statusCode: 400 });
  return { usb_disconnected: true, headset_removed: true, proximity: value.proximity, source: 'user_declaration; not measured by telemetry' };
}
function createMetrics(profile = 'inputs') {
  const coverage = VALIDATION_ITEMS.filter(item => profile !== 'motion_only' || ['position', 'rotation', 'velocity'].includes(item.key))
    .map(item => ({ ...item, done: false }));
  const internals = new Map(coverage.map(item => [item.id, {}]));
  const result = { frames: 0, dual_6dof_frames: 0, focused_frames: 0, disconnects: 0, app_restarts: 0, coordinate_changes: 0,
    stale_episodes: 0, missing_packets: 0, longest_dual_6dof_s: 0, first_sample_id: null, last_sample_id: null,
    status_counts: {}, last_xr_status: null, application_button_press_events: 0, application_button_presses: {}, coverage };
  let previous = null, currentSpan = 0, run = null, segment = null;
  const previousButtons = new Map();
  return { result,
    breakTracking() { previous = null; currentSpan = 0; },
    packet(packet, meta) {
      if (run && run !== meta.app_run_id) { ++result.app_restarts; previousButtons.clear(); }
      run = meta.app_run_id;
      if (packet.kind !== 'frame') {
        result.last_xr_status = packet.state; result.status_counts[packet.state] = (result.status_counts[packet.state] ?? 0) + 1;
        previous = null; currentSpan = 0; return;
      }
      result.last_xr_status = packet.session_state;
      const nextSegment = packet.capture.coordinate_segment_id;
      if (segment && segment !== nextSegment) ++result.coordinate_changes;
      segment = nextSegment;
      const stamp = BigInt(packet.device_monotonic_ns), dual = full6dof(packet);
      ++result.frames; if (dual) ++result.dual_6dof_frames; if (packet.focused) ++result.focused_frames;
      result.first_sample_id ??= packet.capture.sample_id; result.last_sample_id = packet.capture.sample_id;
      const same = previous && previous.connection === meta.connection_id && previous.segment === segment;
      const delta = same ? Number(stamp - previous.stamp) / 1e9 : 0;
      const gap = same ? Math.max(0, packet.sequence - previous.sequence - 1) : 0; result.missing_packets += gap;
      if (dual && previous?.dual && same && packet.sequence === previous.sequence + 1 && delta > 0 && delta <= .25) currentSpan += delta; else currentSpan = 0;
      result.longest_dual_6dof_s = Math.max(result.longest_dual_6dof_s, currentSpan);
      previous = { connection: meta.connection_id, segment, stamp, sequence: packet.sequence, dual };
      for (const side of sides) for (const key of ['x', 'y', 'a', 'b', 'menu', 'thumbstick_click']) {
        const value = packet.focused && packet[side].pose_active ? packet[side].buttons[key] : null, id = `${side}.${key}`;
        if (value === true && previousButtons.get(id) !== true) {
          ++result.application_button_press_events;
          result.application_button_presses[id] = (result.application_button_presses[id] ?? 0) + 1;
        }
        previousButtons.set(id, value);
      }
      for (const item of coverage) {
        const hand = packet[item.side], state = internals.get(item.id);
        if (!packet.focused || !hand.pose_active) { state.previous = null; continue; }
        const tracked = hand.position_valid && hand.orientation_valid && hand.position_tracked && hand.orientation_tracked;
        if (item.key === 'position' && tracked) {
          if (state.segment !== segment) { state.origin = hand.position_m; state.segment = segment; }
          if (Math.hypot(...hand.position_m.map((v, i) => v - state.origin[i])) >= .1) item.done = true;
        } else if (item.key === 'rotation' && tracked) {
          if (state.segment !== segment) { state.origin = hand.orientation_xyzw; state.segment = segment; }
          const q = hand.orientation_xyzw, norm = Math.hypot(...q) * Math.hypot(...state.origin);
          if (norm > 0 && 2 * Math.acos(Math.min(1, Math.abs(q.reduce((sum, v, i) => sum + v * state.origin[i], 0) / norm))) >= Math.PI / 9) item.done = true;
        } else if (item.key === 'velocity') {
          if (hand.linear_velocity_valid && Math.hypot(...hand.linear_velocity_m_s) >= .1) state.linear = true;
          if (hand.angular_velocity_valid && Math.hypot(...hand.angular_velocity_rad_s) >= .2) state.angular = true;
          item.done = !!state.linear && !!state.angular;
        } else if (['trigger', 'squeeze'].includes(item.key)) {
          const value = hand[item.key];
          if (value !== null && value >= (item.key === 'trigger' ? .8 : .6)) state.pressed = true;
          if (state.pressed && value !== null && value <= .15) item.done = true;
        } else if (item.key === 'stick' && hand.thumbstick) {
          const [x, y] = hand.thumbstick;
          state.xp ||= x >= .4; state.xn ||= x <= -.4; state.yp ||= y >= .4; state.yn ||= y <= -.4;
          item.done = !!(state.xp && state.xn && state.yp && state.yn);
        } else if (Object.hasOwn(hand.buttons, item.key)) {
          const value = hand.buttons[item.key];
          if (value === true) state.pressed = true;
          if (state.pressed && state.previous === true && value === false) item.done = true;
          state.previous = value;
        }
      }
    },
  };
}

/** The PC owns the timer; browser closure cannot erase or restart a measurement. */
export function createHeadlessValidation({ captures, onUpdate = () => {}, now = () => performance.timeOrigin + performance.now(), durationMs = 300_000, readyMs = 2000,
  warmupMs = 120_000, timers = true, profile = 'inputs', stallMs = 10_000 } = {}) {
  if (!['inputs', 'motion_only'].includes(profile)) throw new Error('Unknown validation profile');
  let phase = 'idle', conditions = null, session = null, metrics = createMetrics(profile), requestedAt = null, startedAt = null,
    endedAt = null, readyAt = null, lastReady = null, lastPacketAt = null, stale = false, reason = null, error = null, finishing = null;
  const active = () => ['starting', 'waiting_tracking', 'measuring', 'saving'].includes(phase);
  const snapshot = () => ({ schema: 'quest-headless-validation-v1', profile, phase, conditions, target_s: durationMs / 1000,
    pose_stall_timeout_s: profile === 'motion_only' ? stallMs / 1000 : null,
    elapsed_s: startedAt === null ? 0 : Math.min(durationMs, Math.max(0, (endedAt ?? now()) - startedAt)) / 1000,
    ready_elapsed_s: readyAt === null ? 0 : Math.max(0, now() - readyAt) / 1000,
    started_at_utc: startedAt === null ? null : new Date(startedAt).toISOString(), session_id: session?.session_id ?? null,
    directory: session?.directory ?? null, reason, error, metrics: structuredClone(metrics.result) });
  const emit = () => onUpdate(snapshot());
  const controller = {
    active, snapshot,
    reset() { if (active()) return; phase = 'idle'; conditions = session = null; metrics = createMetrics(profile); reason = error = null; startedAt = endedAt = readyAt = null; emit(); },
    async start(input) {
      const checked = checkConditions(input);
      if (active() || captures.status().state === 'recording') throw Object.assign(new Error('Stop the current capture before starting validation'), { statusCode: 409 });
      phase = 'starting'; conditions = checked; metrics = createMetrics(profile); requestedAt = now(); startedAt = endedAt = readyAt = lastReady = lastPacketAt = null;
      reason = error = null; stale = false; finishing = null; emit();
      try {
        session = await captures.start({ validation: { protocol: 'quest-headless-lan-v1', profile, conditions, duration_s: durationMs / 1000,
          input_protocol: profile === 'motion_only' ? 'Both controllers move gently; do not press system or menu keys. System keys are not observable in telemetry.' : 'Exercise application inputs' } });
        captures.event('headless_validation_configured', { profile, conditions, duration_s: durationMs / 1000 });
        phase = 'waiting_tracking'; emit(); return snapshot();
      } catch (value) { phase = 'error'; error = value.message; emit(); throw value; }
    },
    packet(packet, meta) {
      if (!['waiting_tracking', 'measuring'].includes(phase)) return;
      if (!packet.capture) { controller.finish('recording_error').catch(() => {}); return; }
      if (packet.kind === 'frame') { lastPacketAt = now(); stale = false; }
      if (phase === 'waiting_tracking') {
        const ready = full6dof(packet);
        const key = `${meta.connection_id}/${packet.capture.coordinate_segment_id}`;
        if (!ready) { readyAt = lastReady = null; return; }
        if (!lastReady || lastReady.key !== key || now() - lastReady.at > 250 || packet.sequence !== lastReady.sequence + 1) readyAt = now();
        lastReady = { key, at: now(), sequence: packet.sequence };
        if (now() - readyAt < readyMs) return;
        phase = 'measuring'; startedAt = now();
        captures.event('headless_measurement_started', { profile, sample_id: packet.capture.sample_id, conditions, duration_s: durationMs / 1000 }); emit();
      }
      metrics.packet(packet, meta);
    },
    disconnected() {
      readyAt = lastReady = null;
      if (phase === 'measuring') { ++metrics.result.disconnects; metrics.breakTracking(); }
      emit();
    },
    tick() {
      if (!['waiting_tracking', 'measuring'].includes(phase)) return;
      if (captures.status().state === 'failed') return controller.finish('recording_error');
      if (lastPacketAt === null || now() - lastPacketAt > 1000) {
        readyAt = lastReady = null;
        if (!stale && phase === 'measuring') { ++metrics.result.stale_episodes; metrics.breakTracking(); }
        stale = true;
      }
      if (phase === 'waiting_tracking' && now() - requestedAt >= warmupMs) return controller.finish('tracking_not_ready');
      if (phase === 'measuring' && profile === 'motion_only' && lastPacketAt !== null && now() - lastPacketAt >= stallMs) return controller.finish('pose_stream_stalled');
      if (phase === 'measuring' && now() - startedAt >= durationMs) return controller.finish('duration_elapsed');
      emit();
    },
    finish(stopReason = 'user_stop') {
      if (finishing) return finishing;
      if (!active()) return captures.stop(stopReason);
      endedAt = now(); reason = stopReason; phase = 'saving'; emit();
      finishing = (async () => {
        try {
          captures.event('headless_measurement_ended', { reason, elapsed_s: snapshot().elapsed_s, metrics: metrics.result });
          const recording = await captures.stop(`headless_${reason}`);
          phase = reason === 'duration_elapsed' ? 'complete' : reason === 'tracking_not_ready' ? 'timed_out' : reason === 'pose_stream_stalled' ? 'interrupted' : 'cancelled';
          if (recording.state === 'failed') { phase = 'error'; error = recording.error; }
          if (recording.directory && recording.session_id === session?.session_id) {
            const manifest = JSON.parse(fs.readFileSync(path.join(recording.directory, 'manifest.json')));
            const report = { ...snapshot(), recording_state: recording.state, data_files: manifest.files,
              interpretation: 'Measurement complete does not assert sustained 6DoF or independently verify wearing/USB conditions. Review metrics and user confirmation.',
              coverage_complete: metrics.result.coverage.every(item => item.done) };
            const file = path.join(recording.directory, 'validation.json'), fd = fs.openSync(file, 'wx', 0o600);
            try { fs.writeFileSync(fd, JSON.stringify(report, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
          }
          emit(); return recording;
        } catch (value) { phase = 'error'; error = value.message; emit(); throw value; }
      })();
      return finishing;
    },
    close() { clearInterval(timer); return active() ? controller.finish('service_shutdown') : Promise.resolve(); },
  };
  const timer = timers ? setInterval(() => { Promise.resolve(controller.tick()).catch(() => {}); }, 250) : null;
  timer?.unref(); emit(); return controller;
}
