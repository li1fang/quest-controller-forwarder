import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openAnnotationSession } from '../pc/annotation-index.mjs';
import { addAnnotation } from '../pc/annotate-session.mjs';

// Explicitly synthetic, offline stress check. Never touches recordings/ or a device.
if (process.argv[2] === '--worker') {
  const model = await openAnnotationSession(process.argv[3]);
  if (model.frames !== undefined) throw new Error('Full poses were retained');
  const tail = await model.readFrames(model.metadata.frame_count - 2, 2);
  if (tail.at(-1).sequence !== model.metadata.frame_count) throw new Error('Tail seek mismatch');
  const label = await addAnnotation({ directory: model.directory, label: 'SYNTHETIC_BENCHMARK_ONLY', start: 1000, end: 1009,
    expectedRawFiles: model.rawFiles, sessionIndex: model });
  if (label.quality.frames !== 10) throw new Error('Indexed annotation range mismatch');
  console.log(JSON.stringify({ synthetic_only: true, frame_count: model.metadata.frame_count, timeline_hours: model.metadata.duration_ms / 3600000,
    raw_MiB: model.rawFiles.reduce((sum, file) => sum + fs.statSync(path.join(model.directory, file.file)).size, 0) / 1024 ** 2,
    worker_old_space_budget_MiB: 96, heap_used_MiB: process.memoryUsage().heapUsed / 1024 ** 2,
    tail_seek: 'passed', independent_annotation: 'passed', hardware_endurance_test: false }));
} else {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quest-annotation-bench-'));
  try {
    fs.mkdirSync(path.join(root, 'raw'));
    const session = randomUUID(), run = randomUUID(), connection = randomUUID(), files = [];
    const hand = { pose_active: true, position_valid: true, orientation_valid: true, position_tracked: true, orientation_tracked: true,
      position_m: [0, 1, -1], orientation_xyzw: [0, 0, 0, 1], linear_velocity_valid: true, angular_velocity_valid: true,
      linear_velocity_m_s: [0, 0, 0], angular_velocity_rad_s: [0, 0, 0], trigger: 0, squeeze: 0, thumbstick: [0, 0], buttons: { x: false } };
    const note = 'synthetic-benchmark-'.repeat(820); let totalBytes = 0;
    for (let chunk = 0; chunk < 5; ++chunk) {
      const name = `raw/${String(chunk + 1).padStart(6, '0')}.jsonl`, fd = fs.openSync(path.join(root, name), 'wx');
      const hash = createHash('sha256'); let bytes = 0;
      try {
        for (let i = chunk * 2000 + 1; i <= (chunk + 1) * 2000; ++i) {
          const stamp = String(1000000000000000000n + BigInt(i) * 1000000000n);
          const line = JSON.stringify({ schema: 'quest-usb-v1', kind: 'frame', sequence: i, device_monotonic_ns: stamp, xr_time_ns: stamp,
            pc_monotonic_ns: stamp, received_at_utc: new Date(i * 1000).toISOString(), session_state: 'focused', focused: true,
            reference_space_changes: 0, left: hand, right: hand, fixture_note: note,
            capture: { sample_id: `${session}:${i}`, app_run_id: run, connection_id: connection, coordinate_segment_id: `${run}:0` } }) + '\n';
          const data = Buffer.from(line); let written = 0;
          while (written < data.length) written += fs.writeSync(fd, data, written, data.length - written);
          hash.update(data); bytes += data.length;
        }
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      files.push({ file: name, bytes, packets: 2000, sha256: hash.digest('hex') }); totalBytes += bytes;
    }
    fs.writeFileSync(path.join(root, 'events.jsonl'), '');
    files.push({ file: 'events.jsonl', bytes: 0, sha256: createHash('sha256').update('').digest('hex') });
    fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ schema: 'quest-capture-session-v1', state: 'complete', session_id: session,
      source: { synthetic_fixture: true, transport: 'offline-index-benchmark' }, files,
      statistics: { packets: 10000, frames: 10000, dual_6dof_frames: 10000, bytes: totalBytes } }));
    fs.writeFileSync(path.join(root, 'annotations.json'), JSON.stringify({ schema: 'quest-pose-annotations-v1', session_id: session, annotations: [] }));
    const output = execFileSync(process.execPath, ['--max-old-space-size=96', fileURLToPath(import.meta.url), '--worker', root],
      { encoding: 'utf8', windowsHide: true, timeout: 120000 });
    process.stdout.write(output);
  } finally {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('quest-annotation-bench-')) throw new Error('Unsafe benchmark cleanup target');
    fs.rmSync(root, { recursive: true, force: true });
  }
}
