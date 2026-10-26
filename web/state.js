export const STALE_MS = 1000;

export function handState(frame, side, usable) {
  const hand = frame?.[side];
  if (!usable || !hand || !frame.focused || !hand.pose_active) return { key: 'inactive', label: '无有效输入', tone: 'muted', hand: null, visible: false };
  const poseValid = hand.position_valid && hand.orientation_valid && Array.isArray(hand.position_m) && Array.isArray(hand.orientation_xyzw)
    && Math.hypot(...hand.orientation_xyzw) > 0.00001;
  if (!poseValid) return { key: 'locating', label: '正在定位', tone: 'warning', hand, visible: false };
  const tracked = hand.position_tracked && hand.orientation_tracked;
  return { key: tracked ? 'tracked' : 'inferred', label: tracked ? '6DoF 追踪' : '位置推算', tone: tracked ? 'good' : 'warning', hand, visible: true };
}

export function deriveView(snapshot, elapsedMs = 0, browserConnected = true) {
  const connected = browserConnected && !!snapshot?.transport_connected;
  const age = snapshot?.frame_received_at_ms == null ? null : Math.max(0, snapshot.server_time_ms - snapshot.frame_received_at_ms + elapsedMs);
  const fresh = connected && age !== null && age <= STALE_MS && snapshot?.frame?.kind === 'frame';
  const left = handState(snapshot?.frame, 'left', fresh), right = handState(snapshot?.frame, 'right', fresh);
  let state;
  if (!browserConnected) state = { label: '浏览器连接中断', tone: 'muted', hint: '等待本地服务重新连接，旧姿态已隐藏。' };
  else if (snapshot?.source?.mode === 'replay' && snapshot.source.phase === 'ended') state = { label: '回放已结束', tone: 'muted', hint: '这是本机录制的历史数据，非实时追踪。' };
  else if (snapshot?.status?.state === 'error') state = { label: '采集发生错误', tone: 'warning', hint: snapshot.status.message || '查看采集程序终端输出。' };
  else if (connected && age !== null && age > STALE_MS) state = { label: '数据已过期', tone: 'warning', hint: '超过 1 秒未收到新帧，旧姿态和按键已隐藏。' };
  else if (!fresh && snapshot?.startup?.managed && snapshot.startup.phase !== 'ready') state = { label: snapshot.startup.label, hint: snapshot.startup.hint, tone: snapshot.startup.tone ?? 'warning' };
  else if (!connected) state = { label: '等待数据通道', tone: 'muted', hint: snapshot?.source?.transport === 'lan' ? '请在头显手动打开 Quest LAN Forwarder；保持同一局域网，头显可放在旁边。' : '请在电脑启动 USB 采集；头显可保持开机放在旁边。' };
  else if (!fresh) state = { label: snapshot?.status ? '等待 XR 会话' : '已连接 · 等待首帧', tone: 'muted', hint: snapshot?.status ? `会话状态：${snapshot.status.state}` : '正在等待头显端的 OpenXR 数据。' };
  else if (!snapshot.frame.focused) state = { label: '输入焦点已丢失', tone: 'warning', hint: '头显系统菜单或弹窗可能遮住采集 App。' };
  else if (left.key === 'tracked' && right.key === 'tracked') state = { label: '双手 6DoF 已就绪', tone: 'good', hint: '位置与方向均为运行时确认的活动追踪。' };
  else if (!snapshot.frame.left.pose_active || !snapshot.frame.right.pose_active) {
    const missing = !snapshot.frame.left.pose_active && !snapshot.frame.right.pose_active ? '左右手柄' : !snapshot.frame.left.pose_active ? '左手柄' : '右手柄';
    state = { label: `请唤醒${missing}`, tone: 'warning', hint: '拿起手柄并按一下扳机或 A/X 键。此时不需要佩戴头显，唤醒后自动继续。' };
  }
  else if (left.key !== 'tracked' || right.key !== 'tracked') state = { label: '正在建立 6DoF 定位', tone: 'warning', hint: '虚线模型为推算位置。保持光照、相机无遮挡；必要时拿起头显观察房间，再让手柄在它前方移动约 20 秒，之后可放回桌上。' };
  else state = { label: '等待手柄唤醒 / 定位', tone: 'warning', hint: '拿起左右手柄，轻按扳机；保持相机无遮挡、环境光照正常。' };
  return { ...state, left, right, fresh, age, frame: fresh ? snapshot.frame : null };
}

export function startupSteps(snapshot, view) {
  const managed = snapshot?.startup?.managed;
  const online = managed ? snapshot.startup.device_online : snapshot?.transport_connected;
  const hands = [view.left, view.right];
  return [
    { key: 'usb', label: snapshot?.source?.transport === 'wifi' ? 'Wi-Fi / ADB' : 'USB / ADB', state: online ? 'done' : snapshot?.startup?.phase === 'unauthorized' ? 'warning' : 'pending' },
    { key: 'app', label: '采集 App', state: view.fresh ? 'done' : online ? 'active' : 'pending' },
    { key: 'hands', label: '手柄唤醒', state: hands.every(hand => hand.hand?.pose_active) ? 'done' : ['waiting_hands', 'waiting_controller_start'].includes(snapshot?.startup?.phase) ? 'warning' : hands.some(hand => hand.hand?.pose_active) ? 'active' : 'pending' },
    { key: 'tracking', label: '6DoF 定位', state: hands.every(hand => hand.key === 'tracked') ? 'done' : hands.some(hand => hand.key === 'inferred' || hand.key === 'locating') ? 'warning' : 'pending' },
  ];
}
export function formatRecordingDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const value = Math.floor(seconds);
  return [Math.floor(value / 3600), Math.floor(value / 60) % 60, value % 60].map(v => String(v).padStart(2, '0')).join(':');
}
export function formatStorageBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知';
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GiB` : `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}
export function validationPanelVisible(view, validation, available) {
  return !!available && !!validation && (view === 'test' || ['starting', 'waiting_tracking', 'measuring', 'saving'].includes(validation.phase));
}

// Disk state is independent of device tracking. An old snapshot cannot certify a save.
export function recordingPresentation(recording, { connected = true, stopped = false, error = null, testView = false } = {}) {
  if (stopped) return { state: 'idle', title: '服务已结束', detail: '已发送结束请求。头显恢复休眠需等待 App 释放保活；关闭网页即可。' };
  if (!connected) return { state: 'warning', title: '录制状态待确认', detail: '本地服务连接中断。下方为最后收到的统计；关闭页面不会停止服务，请恢复连接后确认保存结果。' };
  if (error) return { state: 'warning', title: '操作未完成', detail: error };
  if (recording?.state === 'failed') return { state: 'warning', title: '录制失败 · 原始文件已保留', detail: recording.error ?? '检查磁盘空间和权限；本次不能视为完整保存。' };
  if (recording?.state === 'stopping') return { state: 'stopping', title: '正在保存 · 请稍候', detail: '正在收尾本次录制，完成后可以再录一段。' };
  if (recording?.state === 'recording') return { state: 'recording', title: '正在录制 · 数据写入本机', detail: testView ? '五分钟验收进行中；测量状态见下方。停止并保存可提前结束。' : '无固定时长，手动停止并保存。追踪状态见下方；断流期间不会补写姿态。' };
  if (recording?.state === 'complete') return { state: recording.stop_reason === 'low_disk_space' ? 'warning' : 'complete', title: '本段已保存 · 当前仅预览', detail: recording.stop_reason === 'low_disk_space' ? '磁盘空间不足，已自动停止并保存。释放空间后再录；预览与保活仍在运行。' : '可再录一段，或运行 Annotate-Quest.cmd 开始标注。保存完成不代表追踪质量通过；预览与保活仍在运行。' };
  return { state: 'idle', title: '实时预览 · 未在录制', detail: testView ? '这是五分钟验收页。完成下方条件确认后开始测试；日常录制请切换到日常采集。' : '实时动作不会自动保存。点击“开始录制”创建独立会话，无倒计时。关闭网页不会停止服务。' };
}
