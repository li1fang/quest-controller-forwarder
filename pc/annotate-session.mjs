import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { inspectSession } from './inspect-session.mjs';
import { full6dof } from './capture-session.mjs';

const rawFiles = report => report.files.filter(file => file.file.startsWith('raw/')).map(({ file, sha256 }) => ({ file, sha256 }));
const sameFiles = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function readAnnotations(directory, sessionId) {
  const doc = JSON.parse(fs.readFileSync(path.join(directory, 'annotations.json'), 'utf8'));
  if (doc.schema !== 'quest-pose-annotations-v1' || doc.session_id !== sessionId || !Array.isArray(doc.annotations) ||
      (doc.deleted_annotations !== undefined && !Array.isArray(doc.deleted_annotations))) throw new Error('Annotation document identity mismatch');
  return doc;
}
async function verified(directory, expectedRawFiles) {
  const report = await inspectSession(directory);
  if (!report.integrity_ok) throw new Error('Finalize and verify the session before annotation');
  if (expectedRawFiles && !sameFiles(expectedRawFiles, rawFiles(report))) throw new Error('Source recording changed; reopen the session');
  return report;
}
function transaction(directory, report, change) {
  const lock = path.join(directory, 'annotations.lock'), file = path.join(directory, 'annotations.json');
  const fd = fs.openSync(lock, 'wx', 0o600), next = path.join(directory, `annotations.${randomUUID()}.next`);
  try {
    const doc = readAnnotations(directory, report.session_id), files = rawFiles(report);
    if (doc.raw_files && !sameFiles(doc.raw_files, files)) throw new Error('Annotation source hashes do not match the recording');
    const result = change(doc); doc.raw_files = files; doc.updated_at_utc = new Date().toISOString();
    const out = fs.openSync(next, 'wx', 0o600);
    try { fs.writeFileSync(out, JSON.stringify(doc, null, 2) + '\n'); fs.fsyncSync(out); } finally { fs.closeSync(out); }
    fs.renameSync(next, file); return result;
  } finally {
    if (fs.existsSync(next)) fs.unlinkSync(next);
    fs.closeSync(fd); fs.unlinkSync(lock);
  }
}

async function saveAnnotation({ directory, label, side = 'both', start, end = start, notes = '', id, expectedRawFiles }) {
  if (!['left', 'right', 'both'].includes(side) || typeof label !== 'string' || !label.trim() || label.length > 80 || typeof notes !== 'string' || notes.length > 2000)
    throw new Error('Invalid annotation label, side or notes');
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) throw new Error('Invalid inclusive sample range');
  const report = await verified(directory, expectedRawFiles);
  let first, last, segment;
  const quality = { frames: 0, dual_6dof_frames: 0, left_tracked_frames: 0, right_tracked_frames: 0, status_packets: 0 };
  for (const file of report.files.filter(file => file.file.startsWith('raw/'))) {
    const input = fs.createReadStream(path.join(directory, file.file));
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        const packet = JSON.parse(line), index = Number(packet.capture.sample_id.split(':').at(-1));
        if (index < start || index > end) continue;
        if (packet.kind !== 'frame') { ++quality.status_packets; continue; }
        const current = packet.capture.coordinate_segment_id;
        if (segment && segment !== current) throw new Error('Annotation crosses coordinate segments; split it');
        segment = current; ++quality.frames;
        if (full6dof(packet)) ++quality.dual_6dof_frames;
        for (const hand of ['left', 'right']) {
          const h = packet[hand];
          if (packet.focused && h.pose_active && h.position_valid && h.position_tracked && h.orientation_valid && h.orientation_tracked) ++quality[hand + '_tracked_frames'];
        }
        if (index === start) first = packet; if (index === end) last = packet;
      }
    } finally { lines.close(); input.destroy(); }
  }
  if (!first || !last || !segment) throw new Error('Range endpoints must refer to recorded pose frames');
  return transaction(directory, report, doc => {
    const previous = id === undefined ? null : doc.annotations.find(item => item.id === id);
    if (id !== undefined && !previous) throw new Error('Annotation not found');
    const annotation = { id: previous?.id ?? randomUUID(), label: label.trim(), side, start_sample_id: first.capture.sample_id,
      end_sample_id: last.capture.sample_id, coordinate_segment_id: segment, notes, quality,
      created_at_utc: previous?.created_at_utc ?? new Date().toISOString(), updated_at_utc: new Date().toISOString() };
    if (previous) doc.annotations[doc.annotations.indexOf(previous)] = annotation; else doc.annotations.push(annotation);
    return annotation;
  });
}
export async function addAnnotation(options) { return saveAnnotation({ ...options, id: undefined }); }
export async function editAnnotation(options) {
  if (typeof options.id !== 'string' || !options.id) throw new Error('Annotation id required');
  return saveAnnotation(options);
}
export async function deleteAnnotation({ directory, id, expectedRawFiles }) {
  const report = await verified(directory, expectedRawFiles);
  return transaction(directory, report, doc => {
    const index = doc.annotations.findIndex(item => item.id === id);
    if (index < 0) throw new Error('Annotation not found');
    const deletion = { deletion_id: randomUUID(), deleted_at_utc: new Date().toISOString(), annotation: doc.annotations[index] };
    (doc.deleted_annotations ??= []).push(deletion); doc.annotations.splice(index, 1); return deletion;
  });
}
export async function restoreAnnotation({ directory, deletion_id, expectedRawFiles }) {
  const report = await verified(directory, expectedRawFiles);
  return transaction(directory, report, doc => {
    const entry = doc.deleted_annotations?.find(item => item.deletion_id === deletion_id && !item.restored_at_utc);
    if (!entry || doc.annotations.some(item => item.id === entry.annotation.id)) throw new Error('Deleted annotation not found');
    doc.annotations.push(entry.annotation); entry.restored_at_utc = new Date().toISOString(); return entry.annotation;
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [directory, label, side, start, end = start, notes = ''] = process.argv.slice(2);
    console.log(JSON.stringify(await addAnnotation({ directory, label, side, start: Number(start), end: Number(end), notes }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
