import { deriveView, startupSteps } from './state.js';
import { createScene } from './scene.js';

const $ = selector => document.querySelector(selector);
const fields = {};
const fixed = (value, places = 3) => Number.isFinite(value) ? (Math.abs(value) < 0.5 * 10 ** -places ? 0 : value).toFixed(places) : '—';
const vectorText = value => value ? value.map(number => fixed(number, 2)).join('  ') : '—';

for (const side of ['left', 'right']) {
  const card = $('#hand-template').content.firstElementChild.cloneNode(true);
  card.dataset.side = side;
  card.querySelector('.hand-letter').textContent = side === 'left' ? 'L' : 'R';
  card.querySelector('h2').textContent = side === 'left' ? '左手柄' : '右手柄';
  const names = side === 'left' ? [['x', 'X'], ['y', 'Y'], ['menu', '菜单'], ['thumbstick_click', '摇杆']] : [['a', 'A'], ['b', 'B'], ['thumbstick_click', '摇杆']];
  for (const [name, label] of names) {
    const key = document.createElement('span'); key.className = 'key'; key.textContent = label; key.dataset.button = name; key.dataset.value = 'unknown';
    key.title = `${label}：实体手柄输入`; card.querySelector('.buttons').append(key);
  }
  $(`#${side}-panel`).append(card);
  fields[side] = { card, badge: card.querySelector('.tracking-badge'), position: [...card.querySelectorAll('.position-values strong')],
    quaternion: card.querySelector('.quaternion-values'), linear: card.querySelector('.linear-speed'), angular: card.querySelector('.angular-speed'),
    linearVector: card.querySelector('.linear-vector'), angularVector: card.querySelector('.angular-vector'), trigger: card.querySelector('.trigger-value'),
    squeeze: card.querySelector('.squeeze-value'), triggerFill: card.querySelector('.trigger-fill'), squeezeFill: card.querySelector('.squeeze-fill'),
    stickDot: card.querySelector('.stick-dot'), stickValues: card.querySelector('.stick-values'), keys: [...card.querySelectorAll('.key')], touches: [...card.querySelectorAll('.touch')] };
}

let scene;
try { scene = createScene($('#viewport')); }
catch (error) {
  $('#empty-title').textContent = '无法启动 3D 渲染';
  $('#empty-hint').textContent = '浏览器需要 WebGL 2 / 硬件加速；右侧数值面板仍可使用。';
  console.error(error);
}
$('#frame-hands').addEventListener('click', () => scene?.frameHands());
$('#reset-view').addEventListener('click', () => scene?.resetView());
for (const [id, option] of [['show-trails', 'trails'], ['show-velocity', 'velocity'], ['show-axes', 'axes']]) {
  $(`#${id}`).addEventListener('change', event => { if (scene) scene.options[option] = event.target.checked; });
}

let snapshot = null, receivedAt = performance.now(), browserConnected = false, lastUiTime = -Infinity;
let stoppedByUser = false, captureBusy = false, validationError = null, coverageKey = '';
const events = new EventSource('/events');
events.onmessage = event => {
  try { snapshot = JSON.parse(event.data); receivedAt = performance.now(); browserConnected = true; }
  catch (error) { console.error('Invalid local viewer event', error); }
};
events.onerror = () => { browserConnected = false; };
async function captureAction(action) {
  if (captureBusy || !snapshot?.controls?.can_record) return;
  captureBusy = true;
  try {
    const response = await fetch(`/api/capture/${action}`, { method: 'POST', headers: { 'X-Quest-Token': snapshot.controls.token } });
    if (!response.ok) throw new Error('采集操作失败，请查看录制状态');
    const result = await response.json();
    snapshot.recording = result.recording;
  } catch (error) { console.error(error); }
  finally { captureBusy = false; }
}
$('#start-capture').addEventListener('click', () => captureAction('start'));
$('#start-validation').addEventListener('click', async () => {
  if (captureBusy || !snapshot?.controls?.can_validate) return;
  captureBusy = true; validationError = null;
  try {
    const response = await fetch('/api/validation/start', { method: 'POST', headers: { 'X-Quest-Token': snapshot.controls.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ usb_disconnected: $('#validation-usb').checked, headset_removed: $('#validation-unworn').checked, proximity: $('#validation-proximity').value }) });
    if (!response.ok) throw new Error(response.status === 400 ? '请先确认 USB、摘下头显与感应器状态。' : response.status === 409 ? '请先停止当前采集，再开始验证。' : '验证未能启动，请检查服务和存储。');
    snapshot.validation = (await response.json()).validation;
  } catch (error) { validationError = error.message; }
  finally { captureBusy = false; }
});
$('#stop-session').addEventListener('click', async () => {
  if (snapshot?.controls?.can_record) { await captureAction('stop'); return; }
  if (!snapshot?.controls?.can_stop) return;
  const button = $('#stop-session'); button.disabled = true; button.textContent = '正在停止…';
  try {
    const response = await fetch('/api/stop', { method: 'POST', headers: { 'X-Quest-Token': snapshot.controls.token } });
    if (!response.ok) throw new Error('停止请求未被接受');
    stoppedByUser = true;
    button.textContent = '已停止';
  } catch (error) { button.disabled = false; button.textContent = '重试停止'; console.error(error); }
});
$('#end-service').addEventListener('click', async () => {
  if (!snapshot?.controls?.can_stop || stoppedByUser) return;
  const button = $('#end-service'); button.disabled = true;
  try {
    const response = await fetch('/api/stop', { method: 'POST', headers: { 'X-Quest-Token': snapshot.controls.token } });
    if (!response.ok) throw new Error('结束服务失败');
    stoppedByUser = true; button.textContent = '服务已结束';
  } catch { button.disabled = false; button.textContent = '重试结束服务'; }
});

function updateCard(side, state) {
  const ui = fields[side], hand = state.hand;
  ui.card.dataset.tracking = state.key;
  ui.badge.textContent = state.label; ui.badge.dataset.tone = state.tone;
  ui.position.forEach((element, index) => { element.textContent = hand?.position_valid ? fixed(hand.position_m?.[index]) : '—'; });
  ui.quaternion.textContent = hand?.orientation_valid ? hand.orientation_xyzw.map(value => fixed(value)).join('  ') : '—  —  —  —';
  const linear = hand?.linear_velocity_valid ? hand.linear_velocity_m_s : null;
  const angular = hand?.angular_velocity_valid ? hand.angular_velocity_rad_s : null;
  ui.linear.textContent = linear ? fixed(Math.hypot(...linear)) : '—';
  ui.angular.textContent = angular ? fixed(Math.hypot(...angular), 2) : '—';
  ui.linearVector.textContent = vectorText(linear); ui.angularVector.textContent = vectorText(angular);
  ui.trigger.textContent = fixed(hand?.trigger, 2); ui.squeeze.textContent = fixed(hand?.squeeze, 2);
  ui.triggerFill.style.width = `${Math.max(0, Math.min(1, hand?.trigger ?? 0)) * 100}%`;
  ui.squeezeFill.style.width = `${Math.max(0, Math.min(1, hand?.squeeze ?? 0)) * 100}%`;
  const stick = hand?.thumbstick;
  ui.stickValues.textContent = stick ? `${fixed(stick[0], 2)} / ${fixed(stick[1], 2)}` : '— / —';
  ui.stickDot.style.opacity = stick ? '1' : '0';
  ui.stickDot.style.left = `${50 + (stick?.[0] ?? 0) * 35}%`; ui.stickDot.style.top = `${50 - (stick?.[1] ?? 0) * 35}%`;
  for (const key of ui.keys) {
    const name = key.dataset.button, value = hand?.buttons?.[name], touched = hand?.buttons?.[name + '_touch'];
    key.dataset.value = value == null ? 'unknown' : value ? 'pressed' : touched ? 'touched' : 'released';
  }
  for (const touch of ui.touches) touch.dataset.active = String(hand?.buttons?.[touch.dataset.button] === true);
}

function updateValidation() {
  const state = snapshot?.validation, visible = !!snapshot?.controls?.can_validate && !!state;
  $('#validation-panel').hidden = !visible;
  if (!visible) return;
  if (document.body.dataset.view === 'test') $('#validation-panel').open = true;
  const motionOnly = state.profile === 'motion_only';
  const active = ['starting', 'waiting_tracking', 'measuring', 'saving'].includes(state.phase);
  // Tests can be started through the local API after the operator confirms conditions in chat.
  if (active && state.conditions) {
    $('#validation-usb').checked = state.conditions.usb_disconnected === true;
    $('#validation-unworn').checked = state.conditions.headset_removed === true;
    $('#validation-proximity').value = state.conditions.proximity;
  }
  $('#validation-summary').textContent = motionOnly ? '稳定性测量 · 只轻动双手，不按系统或菜单键' : '本轮检查 · 不戴头显 / USB 拔线 / 双手 6DoF 与按键';
  $('#validation-mode-note').textContent = motionOnly ? active ? '正在验证软件保活；下方条件来自本次人工确认。只轻动双手，不按系统或菜单键。是否通过以完整录制分析为准。' : '软件保活测试：0.7.0 App，感应器不遮挡、电脑 USB 拔掉、头显摘下，只轻动双手。保活请求已发送不等于实测成功。' : '动作与应用输入按本次测量分别核对。';
  $('#start-validation').textContent = motionOnly ? '开始 5 分钟稳定性测试并录制' : '开始 5 分钟测试并录制';
  const recording = ['recording', 'stopping'].includes(snapshot.recording?.state);
  for (const id of ['validation-usb', 'validation-unworn', 'validation-proximity']) $(`#${id}`).disabled = active || recording;
  $('#start-validation').disabled = active || recording || captureBusy || !browserConnected || !$('#validation-usb').checked || !$('#validation-unworn').checked || !$('#validation-proximity').value;
  const remaining = Math.max(0, Math.ceil(state.target_s - state.elapsed_s));
  $('#validation-timer').textContent = `${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`;
  $('#validation-progress').max = state.target_s; $('#validation-progress').value = state.elapsed_s;
  const messages = {
    idle: ['尚未开始测试，也未录制', '看到实时动作不代表保存。确认实际条件后，点击“开始 5 分钟测试并录制”；双手追踪就绪后才开始倒计时。'],
    starting: ['正在创建独立会话', '正在准备录制文件。'],
    waiting_tracking: ['准备中 · 正在保存准备数据', '等双手 6DoF 稳定 2 秒后才倒计时；若 XR 进入 idle，会记录准备未就绪。改变感应器遮挡条件前先停止保存，再开始新会话。'],
    measuring: ['正在测量 · 请保持双手参与', '按灰色项目补测；两只手柄保持轻动，头显放在旁边，电脑 USB 保持拔掉。到时自动保存。'],
    saving: ['测量结束 · 正在保存', '等待写盘完成，无需操作头显。'],
    complete: ['测量已结束 · 需要检查追踪质量', '原始数据与 validation.json 已保存。计时完成不等于持续 6DoF 通过；可直接查看下面的连续追踪与覆盖结果。'],
    timed_out: ['准备超时 · 数据已保存', '双手尚未稳定定位。本轮不算 5 分钟测量；检查手柄唤醒、光照、相机和佩戴感应器后可重新开始。'],
    cancelled: ['本轮已提前停止并保存', '当前处于预览，不再写入这次录制。'],
    error: ['验证遇到错误', state.error ?? '查看录制状态；已有原始文件保留。'],
    interrupted: ['姿态流中断 · 数据已保存', `姿态流连续 ${state.pose_stall_timeout_s ?? 10} 秒未恢复，本轮已自动保存。XR idle 不等同于已确认休眠；本轮未完成 5 分钟。`],
  };
  if (motionOnly) {
    messages.idle = ['稳定性测试尚未开始，也未录制', '确认 USB、摘下头显及实际遮挡状态后开始。双手追踪稳定 2 秒后倒计时；本轮只轻动双手，不补测按键。'];
    messages.measuring = ['正在测量 · 只轻动双手', '轻轻移动、转动两只手柄，不按系统、菜单或其他按键。5 分钟后自动保存；姿态流持续中断 10 秒也会自动保存。'];
  }
  const message = messages[state.phase] ?? messages.idle;
  $('#validation-status').textContent = validationError ? '未能开始验证' : message[0];
  $('#validation-hint').textContent = validationError ?? (!active && recording ? '普通采集正在录制；请先“停止并保存”，再开始验证。' : message[1]);
  const metrics = state.metrics, key = metrics.coverage.map(item => `${item.id}:${item.done}`).join('|');
  if (key !== coverageKey) {
    coverageKey = key;
    for (const side of ['left', 'right']) {
      const group = $(`#validation-${side}`); group.replaceChildren();
      for (const item of metrics.coverage.filter(item => item.side === side)) {
        const chip = document.createElement('span'); chip.className = 'coverage-chip'; chip.dataset.done = String(item.done); chip.textContent = `${item.done ? '✓ ' : '○ '}${item.label}`; group.append(chip);
      }
    }
  }
  const completed = metrics.coverage.filter(item => item.done).length;
  $('#validation-metrics').textContent = `${motionOnly ? '动作确认' : '覆盖'} ${completed}/${metrics.coverage.length} 项 · 完整双手 ${metrics.dual_6dof_frames}/${metrics.frames} 帧 · 最长连续 ${fixed(metrics.longest_dual_6dof_s, 1)} 秒 · 断线 ${metrics.disconnects} 次 · App 重启 ${metrics.app_restarts} 次${motionOnly ? ` · 应用按键按下 ${metrics.application_button_press_events ?? 0} 次` : ''}`;
}

function updateUi(view) {
  updateValidation();
  $('#status-bar').dataset.tone = view.tone;
  $('#status-title').textContent = view.label; $('#status-hint').textContent = view.hint;
  $('#frame-rate').innerHTML = `${view.fresh ? snapshot.frame_rate_hz : '—'}<small> Hz</small>`;
  $('#frame-age').innerHTML = `${view.age === null ? '—' : Math.min(99999, Math.round(view.age))}<small> ms</small>`;
  $('#session-label').textContent = `XR ${view.frame?.session_state ?? (browserConnected && snapshot?.transport_connected ? snapshot?.status?.state : null) ?? '—'}`;
  const replay = snapshot?.source?.mode === 'replay';
  const wireless = snapshot?.source?.transport === 'wifi';
  const lan = snapshot?.source?.transport === 'lan';
  $('#end-service').hidden = !lan || !snapshot?.controls?.can_stop;
  $('#end-service').disabled = !browserConnected || stoppedByUser;
  $('#power-status').hidden = !lan;
  const packet = snapshot?.frame ?? snapshot?.status, power = packet?.power;
  const powerOnline = browserConnected && snapshot?.transport_connected && !stoppedByUser;
  $('#power-title').textContent = !powerOnline ? '软件保活 · 等待 App 连接' : !power ? '软件保活 · 当前 App 未上报' : power.request_blocked ? '软件保活请求被系统拒绝' : power.override_requested ? '软件保活请求已发送 · 效果待验证' : '软件保活 · 尚未请求';
  $('#power-status').dataset.warning = String(!!power?.request_blocked);
  const flag = value => value === true ? '是' : value === false ? '否' : '未知';
  $('#power-detail').textContent = powerOnline && power
    ? `屏幕交互 ${flag(power.interactive)} · 显示状态 ${power.display_state} · Android 前台 ${flag(packet.android_resumed)} · XR 运行 ${flag(packet.xr_running)} · 请求 ${power.request_count} 次${power.control_error ? ` · ${power.control_error}` : ''}。停止并保存后仍保留预览；结束服务才释放保活。`
    : powerOnline ? '需安装 0.7.0 候选 App；旧版不会发送保活请求。' : '连接期间临时请求忽略佩戴感应器；不修改永久休眠设置。';
  $('#rate-title').textContent = replay ? '回放帧率' : '采集频率';
  $('#source-badge').classList.toggle('replay', replay);
  $('#source-badge').textContent = replay ? '录制回放 · 非实时' : lan ? '本机 · LAN 直传' : wireless ? '本机 · Wi-Fi 实时' : '本机 · USB 实时';
  $('#render-label').textContent = replay ? '历史录制 / 非实时' : '实时空间姿态';
  $('#source-detail').textContent = replay ? `回放文件：${snapshot.source.name}` : lan ? 'OpenXR → 局域网 TLS → 录制 / 本地浏览器' : wireless ? 'OpenXR → Wi-Fi / ADB / TCP → 本地浏览器' : 'OpenXR → USB / TCP → 本地浏览器';
  const recording = snapshot?.recording;
  const notice = $('#capture-notice'), testView = document.body.dataset.view === 'test';
  notice.hidden = !snapshot?.controls?.can_record || replay;
  const savingNow = ['recording', 'stopping'].includes(recording?.state);
  notice.dataset.recording = String(savingNow);
  $('#capture-notice-title').textContent = recording?.state === 'failed' ? '录制失败' : recording?.state === 'stopping' ? '正在保存' : savingNow ? '正在录制 · 数据写入本机' : '未在录制 · 实时动作不会保存';
  $('#capture-notice-detail').textContent = savingNow ? `本次目录：${recording.directory}` : snapshot?.validation?.profile === 'motion_only' ? '下方是历史结果。本轮只轻动双手，点击稳定性测试并录制后再开始。' : '下方“上次录制”是历史结果。本轮需启动测试并录制，才能检查连续追踪与按键。';
  $('#open-test-page').hidden = testView || !snapshot?.controls?.can_validate;
  $('#recording-bar').hidden = !recording;
  if (recording) {
    $('#recording-bar').dataset.failed = String(recording.state === 'failed');
    $('#recording-status').textContent = recording.state === 'failed' ? '录制失败：' + recording.error : recording.state === 'complete' ? '已保存 · 实时预览未录制' : recording.state === 'idle' ? '实时预览 · 未录制' : recording.state === 'stopping' ? '正在保存…' : '正在录制 · 每秒落盘';
    const recordingPrefix = ['recording', 'stopping'].includes(recording.state) ? '本次' : recording.directory ? '上次' : '尚未录制';
    $('#recording-count').textContent = `${recordingPrefix} ${recording.frames} 帧 · 双手 6DoF ${recording.dual_6dof_frames} 帧 · 缺失包 ${recording.missing_packets}`;
    $('#recording-directory').textContent = recording.directory ?? '点击“开始新采集”创建独立会话';
  }
  $('#connection-light').classList.toggle('connected', browserConnected && !!snapshot?.transport_connected);
  $('#connection-label').textContent = !browserConnected ? '本地服务未连接' : snapshot?.transport_connected ? '数据通道已连接' : replay ? '录制回放已结束' : '本地服务在线 · 等待采集端';
  $('#sequence-label').textContent = `FRAME ${view.frame?.sequence ?? '—'}`;
  const managed = !!snapshot?.startup?.managed;
  document.body.classList.toggle('managed-startup', managed);
  $('#startup-progress').hidden = !managed;
  const canRecord = !!snapshot?.controls?.can_record;
  const recordingActive = ['recording', 'stopping'].includes(recording?.state);
  $('#start-capture').hidden = !canRecord || recordingActive;
  $('#start-capture').disabled = captureBusy || !browserConnected;
  $('#stop-session').hidden = canRecord ? !recordingActive : !snapshot?.controls?.can_stop;
  if (canRecord) {
    $('#stop-session').disabled = captureBusy || recording?.state === 'stopping' || !browserConnected;
    $('#stop-session').textContent = recording?.state === 'stopping' ? '正在保存…' : '停止并保存';
  }
  for (const step of startupSteps(snapshot, view)) {
    const element = $(`[data-step="${step.key}"]`);
    element.dataset.state = step.state;
    element.querySelector('span').textContent = step.label;
  }
  $('#startup-detail').textContent = managed ? `阶段：${snapshot.startup.phase}\n启动尝试：${snapshot.startup.launch_attempts ?? 0} / 3\n${snapshot.startup.detail ? `最近一次诊断：${snapshot.startup.detail}` : ''}` : '';
  if (stoppedByUser) { $('#status-title').textContent = '本次采集已停止'; $('#status-hint').textContent = `可以关闭此页面；下次双击 ${lan ? 'Start-Quest-LAN.cmd' : 'Start-Quest.cmd'} 即可重新启动。`; $('#connection-label').textContent = '本次采集已停止'; }
  for (const side of ['left', 'right']) updateCard(side, view[side]);
  if (scene) {
    const empty = !view.left.visible && !view.right.visible;
    $('#empty-state').hidden = !empty;
    $('#empty-title').textContent = view.fresh ? '等待有效的手柄姿态' : '等待手柄数据';
    $('#empty-hint').textContent = view.hint;
  }
}

function animate(time) {
  const view = deriveView(snapshot, time - receivedAt, browserConnected && !stoppedByUser);
  scene?.update(view, snapshot);
  scene?.render();
  if (time - lastUiTime >= 100) { updateUi(view); lastUiTime = time; }
  requestAnimationFrame(animate);
}
requestAnimationFrame(animate);
