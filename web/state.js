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
