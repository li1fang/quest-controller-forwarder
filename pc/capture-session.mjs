import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const full6dof = packet => packet.kind === 'frame' && packet.focused && ['left', 'right'].every(side => {
  const h = packet[side]; return h?.pose_active && h.position_valid && h.orientation_valid && h.position_tracked && h.orientation_tracked;
});

export function createCaptureSession({ root = 'recordings', source = {}, onError = () => {}, onUpdate = () => {}, chunkBytes = 32 * 1024 * 1024,
  chunkMs = 60_000, syncMs = 1000, io = fs, monotonic = () => process.hrtime.bigint() } = {}) {
  const sessionId = randomUUID(), started = new Date().toISOString();
  const startedMono = monotonic(); let endedMono = null, stopReason = null;
  const directory = path.resolve(root, started.replaceAll(':', '-').replaceAll('.', '-') + '_' + sessionId);
  io.mkdirSync(directory, { recursive: true });
  io.mkdirSync(path.join(directory, 'raw')); // Exclusive even if an improbable id collision occurs.
  const manifestPath = path.join(directory, 'manifest.json');
  let state = 'recording', error = null, closed = false, chunk = null, index = 0, eventFd, timer, lastSync = null;
  const files = [], runs = new Map(), eventHash = createHash('sha256'); let eventBytes = 0;
  const counts = { packets: 0, frames: 0, dual_6dof_frames: 0, missing_packets: 0, duplicate_or_reordered_packets: 0,
    connections: 0, coordinate_segments: 0, bytes: 0, longest_dual_6dof_s: 0 };
  const status = () => ({ state, session_id: sessionId, directory, ...counts, started_at_utc: started,
    elapsed_s: Number((endedMono ?? monotonic()) - startedMono) / 1e9, stop_reason: stopReason, last_sync_at_utc: lastSync, error });
  function snapshot() {
    return { schema: 'quest-capture-session-v1', session_id: sessionId, started_at_utc: started,
      ended_at_utc: closed ? new Date().toISOString() : null, state, error, source, stop_reason: stopReason,
      elapsed_s: Number((endedMono ?? monotonic()) - startedMono) / 1e9,
      telemetry_schema: 'quest-usb-v1', units: { position: 'm', linear_velocity: 'm/s', angular_velocity: 'rad/s', orientation: 'xyzw' },
      coordinates: { reference: 'OpenXR LOCAL', handedness: 'right', x: 'right', y: 'up', minus_z: 'forward', floor_origin: false },
      time: { device_monotonic_ns: 'device CLOCK_MONOTONIC decimal string', xr_time_ns: 'OpenXR sample time; see sample_time_source',
        pc_monotonic_ns: 'host receive monotonic decimal string', received_at_utc: 'host receive wall clock', clock_synchronized: false },
      durability: { sync_interval_ms: syncMs, no_device_spool: true, gaps_include_status_packets: true },
      statistics: { ...counts }, files: [...files], open_chunk: chunk ? { file: chunk.file, bytes: chunk.bytes, packets: chunk.packets } : null,
      last_sync_at_utc: lastSync, annotation_file: 'annotations.json' };
  }
  function writeAll(fd, data) {
    const buffer = Buffer.from(data); let offset = 0;
    while (offset < buffer.length) { const n = io.writeSync(fd, buffer, offset, buffer.length - offset); if (!n) throw new Error('Recording write made no progress'); offset += n; }
    return buffer.length;
  }
  function persistManifest() {
    const next = path.join(directory, 'manifest.next');
    const fd = io.openSync(next, 'w', 0o600);
    try { writeAll(fd, JSON.stringify(snapshot(), null, 2) + '\n'); io.fsyncSync(fd); } finally { io.closeSync(fd); }
    io.renameSync(next, manifestPath);
  }
  function fail(value) {
    if (error) return;
    error = String(value.message ?? value); state = 'failed'; endedMono ??= monotonic(); clearInterval(timer);
    try { persistManifest(); } catch { /* Preserve last checkpoint if disk itself failed. */ }
    onUpdate(status()); onError(value);
  }
  function guard(operation) {
    if (closed || error) throw new Error(error || 'Capture session is closed');
    try { return operation(); } catch (value) { fail(value); throw value; }
  }
  function event(kind, details = {}) {
    return guard(() => {
      const line = JSON.stringify({ schema: 'quest-capture-event-v1', kind, ...details,
        at_utc: new Date().toISOString(), pc_monotonic_ns: process.hrtime.bigint().toString() }) + '\n';
      const bytes = writeAll(eventFd, line); eventHash.update(line); eventBytes += bytes; return bytes;
    });
  }
  function closeChunk() {
    if (!chunk) return;
    io.fsyncSync(chunk.fd); io.closeSync(chunk.fd);
    files.push({ file: chunk.file, bytes: chunk.bytes, packets: chunk.packets, sha256: chunk.hash.digest('hex') }); chunk = null;
  }
  function newChunk() {
    closeChunk();
    const file = `raw/${String(++index).padStart(6, '0')}.jsonl`;
    chunk = { file, fd: io.openSync(path.join(directory, file), 'wx', 0o600), bytes: 0, packets: 0, hash: createHash('sha256'), opened: Date.now() };
  }
  function checkpoint() {
    return guard(() => { if (chunk) io.fsyncSync(chunk.fd); io.fsyncSync(eventFd); lastSync = new Date().toISOString(); persistManifest(); onUpdate(status()); });
  }
  try {
    eventFd = io.openSync(path.join(directory, 'events.jsonl'), 'wx', 0o600);
    io.writeFileSync(path.join(directory, 'annotations.json'), JSON.stringify({ schema: 'quest-pose-annotations-v1', session_id: sessionId,
      interval: 'inclusive sample ids; one coordinate segment per annotation', label_vocabulary: [], annotations: [] }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    event('session_started'); checkpoint();
  } catch (value) { if (eventFd !== undefined) io.closeSync(eventFd); throw value; }
  timer = setInterval(() => { try { checkpoint(); } catch { /* fail() notifies owner and stops timer. */ } }, syncMs); timer.unref();
  return {
    directory, sessionId, status, event, checkpoint,
    connected(meta) { ++counts.connections; event('connected', { connection_id: meta.connection_id, app_run_id: meta.app_run_id, device_model: meta.device_model, app_version: meta.app_version }); },
    packet(packet, meta) {
      return guard(() => {
        let run = runs.get(meta.app_run_id);
        if (!run) { run = { sequence: null, segment: null, previous: null }; runs.set(meta.app_run_id, run); }
        const gap = run.sequence === null ? 0 : Math.max(0, packet.sequence - run.sequence - 1);
        if (gap) { counts.missing_packets += gap; event('sequence_gap', { app_run_id: meta.app_run_id, after: run.sequence, before: packet.sequence, missing_packets: gap }); }
        if (run.sequence !== null && packet.sequence <= run.sequence) { ++counts.duplicate_or_reordered_packets; event('sequence_regression', { app_run_id: meta.app_run_id, previous: run.sequence, current: packet.sequence }); }
        run.sequence = packet.sequence;
        if (packet.kind === 'frame') {
          const segment = `${meta.app_run_id}:${packet.reference_space_changes ?? 0}`;
          if (run.segment !== segment) { run.segment = segment; ++counts.coordinate_segments; event('coordinate_segment', { coordinate_segment_id: segment, app_run_id: meta.app_run_id }); run.previous = null; }
        }
        const sampleId = `${sessionId}:${counts.packets + 1}`;
        const received = { ...packet, received_at_utc: new Date().toISOString(), pc_monotonic_ns: process.hrtime.bigint().toString(),
          capture: { sample_id: sampleId, app_run_id: meta.app_run_id, connection_id: meta.connection_id, coordinate_segment_id: run.segment } };
        if (!chunk || chunk.bytes >= chunkBytes || Date.now() - chunk.opened >= chunkMs) newChunk();
        const line = JSON.stringify(received) + '\n';
        const bytes = writeAll(chunk.fd, line); chunk.hash.update(line); chunk.bytes += bytes; ++chunk.packets;
        counts.bytes += bytes; ++counts.packets;
        if (packet.kind === 'frame') {
          ++counts.frames;
          const dual = full6dof(packet); if (dual) ++counts.dual_6dof_frames;
          const now = BigInt(packet.device_monotonic_ns), previous = run.previous;
          const continuous = dual && previous?.dual && previous.connection === meta.connection_id && !gap && now > previous.time && now - previous.time <= 250_000_000n;
          const start = continuous ? previous.start : now;
          if (dual) counts.longest_dual_6dof_s = Math.max(counts.longest_dual_6dof_s, Number(now - start) / 1e9);
          run.previous = { time: now, start, dual, connection: meta.connection_id };
        } else run.previous = null;
        return received;
      });
    },
    close(reason = 'user_stop') {
      if (closed) return status();
      endedMono ??= monotonic(); stopReason = reason;
      clearInterval(timer);
      try {
        if (!error) event('session_stopped', { reason });
        closeChunk(); io.fsyncSync(eventFd); io.closeSync(eventFd); eventFd = undefined;
        files.push({ file: 'events.jsonl', bytes: eventBytes, sha256: eventHash.digest('hex') });
        closed = true; state = error ? 'failed' : 'complete'; lastSync = new Date().toISOString(); persistManifest();
      } catch (value) {
        fail(value); closed = true;
        if (chunk) { try { io.closeSync(chunk.fd); } catch {} chunk = null; }
        if (eventFd !== undefined) { try { io.closeSync(eventFd); } catch {} }
        try { persistManifest(); } catch {}
      }
      onUpdate(status()); return status();
    },
  };
}
