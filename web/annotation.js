import { createScene } from './scene.js';
import { handState } from './state.js';
import { frameAtTime, selectionQuality, formatTime } from './annotation-state.js';

const $ = selector => document.querySelector(selector), cache = new Map(), chunkSize = 256;
let metadata, annotations, scene, current = 0, currentPacket, seekEpoch = 0, renderTicket = 0;
let playing = false, playBase = 0, playStarted = 0, stopAt = null, speed = 1, busy = false;
let first = 0, last = 0, editingId = null, undoId = null, sampleToFrame = new Map();
function message(text, error = false) { $('#message').textContent = text; $('#message').dataset.error = String(error); }
try { scene = createScene($('#viewport')); }
catch { message('WebGL 2 未能启动；时间轴、原始数值和标注仍可使用。', true); }
const empty = { left: { visible: false }, right: { visible: false } };
function loadChunk(base) {
  if (base >= metadata.frame_count) return Promise.resolve([]);
  if (!cache.has(base)) {
    const entry = { data: null, promise: null };
    entry.promise = fetch(`/api/frames?offset=${base}&limit=${chunkSize}`).then(async response => {
      if (!response.ok) throw new Error('无法读取原始帧，请检查标注服务。');
      const value = await response.json(); entry.data = value.frames; return entry.data;
    }).catch(error => { cache.delete(base); throw error; });
    cache.set(base, entry);
    while (cache.size > 8) cache.delete(cache.keys().next().value);
  }
  return cache.get(base).promise;
}
function readout(packet, side) {
  const hand = packet[side], position = hand.position_valid ? hand.position_m.map(n => n.toFixed(3)).join(' / ') : '无有效位置';
  const rotation = hand.orientation_valid ? hand.orientation_xyzw.map(n => n.toFixed(3)).join(' / ') : '无有效旋转';
  const velocity = hand.linear_velocity_valid ? Math.hypot(...hand.linear_velocity_m_s).toFixed(3) + ' m/s' : '—';
  const inputAvailable = Object.values(hand.buttons).some(value => typeof value === 'boolean');
  const buttons = inputAvailable ? Object.entries(hand.buttons).filter(([name, value]) => value === true && !name.endsWith('_touch')).map(([name]) => name).join(', ') || '无按下' : '不可用';
  const touches = inputAvailable ? Object.entries(hand.buttons).filter(([name, value]) => value === true && name.endsWith('_touch')).map(([name]) => name).join(', ') || '无' : '不可用';
  const angular = hand.angular_velocity_valid ? Math.hypot(...hand.angular_velocity_rad_s).toFixed(3) + ' rad/s' : '—';
  return `位置 ${position}\n旋转 ${rotation}\n线速度 ${velocity} · 角速度 ${angular}\n扳机 ${hand.trigger === null ? '—' : hand.trigger.toFixed(2)} · 握把 ${hand.squeeze === null ? '—' : hand.squeeze.toFixed(2)}\n按键 ${buttons} · 触摸 ${touches}`;
}
function renderPacket(packet) {
  currentPacket = packet;
  const view = { left: handState(packet, 'left', true), right: handState(packet, 'right', true) };
  scene?.update(view, { frame: packet, connection_id: `${packet.capture.connection_id}:${seekEpoch}` });
  const valid = view.left.key === 'tracked' && view.right.key === 'tracked';
  $('#pose-status').textContent = valid ? '录制帧 · 双手 6DoF' : '录制帧 · 含无效或推算姿态';
  $('#pose-placeholder').hidden = view.left.visible || view.right.visible;
  $('#pose-placeholder').textContent = '此帧无有效手柄姿态 · 模型已隐藏';
  for (const side of ['left', 'right']) $(`#${side}-readout`).textContent = readout(packet, side);
}
function updatePlayhead() {
  const row = metadata.index[current];
  $('#scrubber').value = current; $('#frame-number').value = current + 1;
  $('#current-time').textContent = formatTime(row[0]);
  $('#frame-detail').textContent = `帧 ${current + 1} / ${metadata.frame_count} · 原始记录 #${row[1]} · 坐标段 ${row[2] + 1}`;
  $('#playhead').style.left = `${Math.min(99.9, row[0] / (metadata.duration_ms || 1) * 100)}%`;
}
async function showFrame(index, reset = false) {
  if (!metadata) return;
  current = Math.max(0, Math.min(metadata.frame_count - 1, index));
  if (reset) ++seekEpoch;
  updatePlayhead();
  const ticket = ++renderTicket, base = Math.floor(current / chunkSize) * chunkSize, offset = current - base;
  if (cache.get(base)?.data) renderPacket(cache.get(base).data[offset]);
  else {
    scene?.update(empty, { frame: currentPacket, connection_id: `${currentPacket?.capture.connection_id}:${seekEpoch}` });
    $('#pose-placeholder').hidden = false; $('#pose-placeholder').textContent = '正在读取选中的原始帧…';
    try { const frames = await loadChunk(base); if (ticket === renderTicket) renderPacket(frames[offset]); }
    catch (error) { if (ticket === renderTicket) { pause(); message(error.message, true); } }
  }
  if (offset > chunkSize / 2) loadChunk(base + chunkSize).catch(() => {});
}
function pause() { playing = false; $('#play-pause').textContent = '▶ 播放'; }
function play(selected = false) {
  if (!metadata) return;
  pause();
  if (selected) { const q = selectionQuality(metadata.index, first, last); if (!q) return; showFrame(first, true); stopAt = last; }
  else { if (current === metadata.frame_count - 1) showFrame(0, true); stopAt = null; }
  playBase = metadata.index[current][0]; playStarted = performance.now(); playing = true; $('#play-pause').textContent = 'Ⅱ 暂停';
}
function seek(index) { pause(); stopAt = null; showFrame(index, true); }
function animate(now) {
  if (playing && metadata) {
    const end = stopAt ?? metadata.frame_count - 1, time = playBase + (now - playStarted) * speed;
    const next = Math.min(end, frameAtTime(metadata.index, time));
    if (next !== current) showFrame(next);
    if (time >= metadata.index[end][0]) { if (current !== end) showFrame(end); pause(); }
  }
  scene?.render(); requestAnimationFrame(animate);
}
requestAnimationFrame(animate);

function updateRange() {
  if (!metadata) return;
  first = Number($('#range-start').value) - 1; last = Number($('#range-end').value) - 1;
  const q = selectionQuality(metadata.index, first, last);
  $('#save-annotation').disabled = busy || !q || q.crossSegment;
  $('#play-selection').disabled = !q;
  if (!q) { $('#range-times').textContent = '请选择有效的起止帧'; $('#range-quality').textContent = '起点不大于终点，帧号必须在录制范围内。'; $('#selection-overlay').hidden = true; return; }
  $('#range-times').textContent = `${formatTime(metadata.index[first][0])} → ${formatTime(metadata.index[last][0])}`;
  const note = q.crossSegment ? '跨坐标段，请拆开标注。' : `坐标段 ${q.segment + 1} · ${q.count} 帧 · 双手有效 ${q.dual}/${q.count}${q.dual < q.count ? '；含无效帧，保留质量标记。' : ''}`;
  $('#range-quality').textContent = note; $('.range-info').dataset.warning = String(q.crossSegment || q.dual < q.count);
  const duration = metadata.duration_ms || 1;
  $('#selection-overlay').hidden = false; $('#selection-overlay').style.left = `${metadata.index[first][0] / duration * 100}%`;
  $('#selection-overlay').style.width = `${Math.max(.15, q.duration_ms / duration * 100)}%`;
}
function setRange(start, end) { $('#range-start').value = start + 1; $('#range-end').value = end + 1; updateRange(); }
function markIn() { if (metadata) setRange(current, Math.max(current, last)); }
function markOut() { if (metadata) setRange(Math.min(current, first), current); }
function paintQuality() {
  if (!metadata) return;
  const canvas = $('#quality-timeline'), width = Math.max(1, Math.round(canvas.clientWidth * devicePixelRatio));
  canvas.width = width; canvas.height = 34 * devicePixelRatio;
  const ctx = canvas.getContext('2d'), scale = width / (metadata.duration_ms || 1), height = canvas.height;
  ctx.fillStyle = '#243846'; ctx.fillRect(0, 0, width, height);
  for (let i = 0; i < metadata.index.length; ++i) {
    const row = metadata.index[i], next = metadata.index[i + 1], x = row[0] * scale, span = Math.max(1, ((next?.[0] ?? row[0]) - row[0]) * scale);
    for (let side = 0; side < 2; ++side) { ctx.fillStyle = row[side + 3] ? side ? '#8076ae' : '#4c95a7' : '#e59477'; ctx.fillRect(x, side * height / 2, span, height / 2 - 2); }
  }
}
new ResizeObserver(paintQuality).observe($('#quality-timeline'));
function cancelEdit() { editingId = null; $('#form-title').textContent = '选择动作区间'; $('#cancel-edit').hidden = true; $('#save-annotation').textContent = '保存标注'; }
function labelRange(item) { return [sampleToFrame.get(item.start_sample_id), sampleToFrame.get(item.end_sample_id)]; }
function choose(item, edit = false) {
  const [start, end] = labelRange(item);
  if (start === undefined || end === undefined) { message('标注的帧引用不在当前录制中，请保留原件检查。', true); return; }
  seek(start); setRange(start, end);
  if (edit) { editingId = item.id; $('#label').value = item.label; $('#side').value = item.side; $('#notes').value = item.notes; $('#form-title').textContent = '编辑已保存标注'; $('#cancel-edit').hidden = false; $('#save-annotation').textContent = '保存修改'; }
}
function renderAnnotations() {
  const list = $('#saved-list'); list.replaceChildren(); $('#annotation-count').textContent = annotations.annotations.length;
  undoId = (annotations.deleted_annotations ?? []).filter(item => !item.restored_at_utc).at(-1)?.deletion_id ?? null;
  $('#undo-bar').hidden = !undoId;
  const vocabulary = $('#existing-labels'); vocabulary.replaceChildren();
  for (const label of [...new Set(annotations.annotations.map(item => item.label))].sort()) { const option = document.createElement('option'); option.value = label; vocabulary.append(option); }
  if (!annotations.annotations.length) { const p = document.createElement('p'); p.className = 'empty-labels'; p.textContent = '还没有标注。选取第一个动作区间后保存。'; list.append(p); }
  for (const item of [...annotations.annotations].sort((a, b) => (labelRange(a)[0] ?? Infinity) - (labelRange(b)[0] ?? Infinity))) {
    const row = document.createElement('div'); row.className = 'annotation-row';
    const copy = document.createElement('div'), name = document.createElement('strong'), detail = document.createElement('p');
    name.textContent = item.label; const [start, end] = labelRange(item);
    detail.textContent = `${({ both: '双手', left: '左手', right: '右手' })[item.side]} · ${start === undefined || end === undefined ? '帧引用异常' : `${formatTime(metadata.index[start][0])}–${formatTime(metadata.index[end][0])} · 帧 ${start + 1}–${end + 1}`}${item.notes ? '\n' + item.notes : ''}`;
    copy.append(name, detail); const actions = document.createElement('div'); actions.className = 'row-buttons';
    for (const [text, action] of [['定位', () => choose(item)], ['编辑', () => choose(item, true)], ['删除', () => mutate({ action: 'delete', id: item.id })]]) {
      const button = document.createElement('button'); button.textContent = text; button.disabled = busy; button.addEventListener('click', action); actions.append(button);
    }
    row.append(copy, actions); list.append(row);
  }
}
async function mutate(body) {
  if (busy || !metadata) return;
  busy = true; updateRange(); renderAnnotations();
  message('正在校验原始文件并保存标注…');
  try {
    const response = await fetch('/api/annotation', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Quest-Token': metadata.token }, body: JSON.stringify(body) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error ?? '保存失败。');
    annotations = result.document;
    if (body.action === 'delete') { undoId = result.result.deletion_id; $('#undo-bar').hidden = false; if (editingId === body.id) cancelEdit(); }
    else if (body.action === 'restore') { undoId = null; $('#undo-bar').hidden = true; }
    else { cancelEdit(); $('#label').value = ''; $('#notes').value = ''; }
    message(body.action === 'delete' ? '标注已删除到可恢复记录，可点击“撤销删除”。' : '标注已写入独立文件；原始数据未修改。');
  } catch (error) { message(error.message, true); }
  finally { busy = false; updateRange(); renderAnnotations(); }
}
$('#annotation-form').addEventListener('submit', event => {
  event.preventDefault(); const q = metadata && selectionQuality(metadata.index, first, last); if (!q || q.crossSegment) return;
  mutate({ action: editingId ? 'edit' : 'add', ...(editingId ? { id: editingId } : {}), label: $('#label').value, side: $('#side').value,
    notes: $('#notes').value, start: metadata.index[first][1], end: metadata.index[last][1] });
});
$('#cancel-edit').addEventListener('click', cancelEdit);
$('#refresh-annotations').addEventListener('click', async () => { if (busy) return; try { const r = await fetch('/api/annotations'); if (!r.ok) throw new Error('无法读取标注列表。'); annotations = await r.json(); renderAnnotations(); message('已重新读取磁盘上的标注。'); } catch (error) { message(error.message, true); } });
$('#undo-delete').addEventListener('click', () => { if (undoId) mutate({ action: 'restore', deletion_id: undoId }); });
$('#frame-hands').addEventListener('click', () => scene?.frameHands()); $('#reset-view').addEventListener('click', () => scene?.resetView());
for (const [id, option] of [['show-trails', 'trails'], ['show-velocity', 'velocity'], ['show-axes', 'axes']]) $(`#${id}`).addEventListener('change', event => { if (scene) scene.options[option] = event.target.checked; });
$('#play-pause').addEventListener('click', () => playing ? pause() : play()); $('#play-selection').addEventListener('click', () => play(true));
$('#step-back').addEventListener('click', () => seek(current - 1)); $('#step-next').addEventListener('click', () => seek(current + 1));
$('#scrubber').addEventListener('input', event => seek(Number(event.target.value)));
function jumpToFrame() { const n = Number($('#frame-number').value); if (metadata && Number.isInteger(n) && n >= 1 && n <= metadata.frame_count) seek(n - 1); else if (metadata) { updatePlayhead(); message('帧号超出录制范围。', true); } }
$('#frame-number').addEventListener('change', jumpToFrame); $('#jump-frame').addEventListener('click', jumpToFrame);
$('#frame-number').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); jumpToFrame(); } });
for (const id of ['range-start', 'range-end']) $(`#${id}`).addEventListener('input', updateRange);
$('#mark-in').addEventListener('click', markIn); $('#mark-out').addEventListener('click', markOut);
$('#playback-speed').addEventListener('change', event => { speed = Number(event.target.value); if (playing) { playBase = metadata.index[current][0]; playStarted = performance.now(); } });
$('#next-invalid').addEventListener('click', () => { if (!metadata?.invalid_ranges.length) return; const range = metadata.invalid_ranges.find(item => item.first_frame - 1 > current) ?? metadata.invalid_ranges[0]; seek(range.first_frame - 1); setRange(range.first_frame - 1, range.last_frame - 1); });
document.addEventListener('keydown', event => {
  if (!metadata || event.target.closest('input,textarea,select,button') || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.code === 'Space') { event.preventDefault(); playing ? pause() : play(); }
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); seek(current + (event.key === 'ArrowLeft' ? -1 : 1)); }
  if (event.key.toLowerCase() === 'i') markIn(); if (event.key.toLowerCase() === 'o') markOut();
});
$('#close-workspace').addEventListener('click', async () => {
  if (!metadata || busy) return; pause();
  try { const r = await fetch('/api/stop', { method: 'POST', headers: { 'X-Quest-Token': metadata.token } }); if (!r.ok) throw new Error('关闭服务失败。'); message('标注服务已结束，已保存标签仍在磁盘。'); for (const control of document.querySelectorAll('button,input,select,textarea')) control.disabled = true; }
  catch (error) { message(error.message, true); }
});
async function boot() {
  try {
    const r = await fetch('/api/session'); if (!r.ok) throw new Error('无法载入录制。'); metadata = await r.json();
    const a = await fetch('/api/annotations'); if (!a.ok) throw new Error('标注文件校验失败，请保留原件。'); annotations = await a.json();
    metadata.index.forEach((row, index) => sampleToFrame.set(`${metadata.session_id}:${row[1]}`, index));
    $('#session-name').textContent = metadata.name;
    $('#session-facts').textContent = `${metadata.frame_count.toLocaleString()} 帧 · ${formatTime(metadata.duration_ms)} · ${metadata.segments.length} 个坐标段`;
    $('#integrity-badge').textContent = '✓ 原始文件 SHA-256 已校验'; $('#total-time').textContent = '/ ' + formatTime(metadata.duration_ms);
    $('#scrubber').max = metadata.frame_count - 1; for (const id of ['range-start', 'range-end', 'frame-number']) $(`#${id}`).max = metadata.frame_count;
    $('#next-invalid').disabled = !metadata.invalid_ranges.length;
    setRange(0, 0); paintQuality(); renderAnnotations(); await showFrame(0, true);
    message('录制已载入。播放或逐帧定位，用 I / O 选择动作区间；标签单独保存。');
  } catch (error) { message(error.message, true); }
}
boot();
