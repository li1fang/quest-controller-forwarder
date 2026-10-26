import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { classifyAdbError, reverseTarget } from './adb-client.mjs';

export const PACKAGE = 'dev.quest.usbforwarder';
export const COMPONENT = `${PACKAGE}/android.app.NativeActivity`;

export class StartupController {
  constructor({ adb, hub, apk, install = true, reinstall = false, now = Date.now, pollMs = 2000, log = console.error, maxLaunches = 3, transport = 'usb', expectedSerial }) {
    Object.assign(this, { adb, hub, apk, install, reinstall, now, pollMs, log, maxLaunches, transport, expectedSerial });
    if (transport === 'wifi' && !expectedSerial) throw new Error('Wireless ADB requires a physical headset serial');
    this.running = false; this.configured = false; this.attempts = 0;
    this.lastLaunch = -Infinity; this.lastProximity = -Infinity; this.lastReconnect = -Infinity; this.lastDiagnostic = -Infinity;
    this.startedAt = now(); this.resources = { mapping: false, proximity: false, app: false };
    this.state = { managed: true, phase: 'checking', label: '正在检查启动条件', hint: `正在检测 ${transport === 'wifi' ? 'Wi-Fi' : 'USB'}、ADB 与采集 App。`, tone: 'muted', started_at_ms: this.startedAt };
    this.hub.startup(this.state);
  }
  publish(phase, label, hint, extra = {}) {
    if (this.state.phase !== phase) this.log(`[${phase}] ${label} — ${hint}`);
    this.state = { ...this.state, phase, label, hint, tone: phase === 'ready' ? 'good' : 'warning',
      launch_attempts: this.attempts, checked_at_ms: this.now(), ...extra };
    this.hub.startup(this.state);
  }
  start() {
    if (this.running) return;
    this.running = true;
    const cycle = async () => {
      if (!this.running) return;
      this.inflight = this.tick();
      try { await this.inflight; } catch (error) { if (this.running) this.report(error); }
      if (this.running) this.timer = setTimeout(cycle, this.pollMs);
    };
    cycle();
  }
  report(error) {
    const state = classifyAdbError(error, this.transport);
    const disconnected = ['adb_missing', 'waiting_usb', 'usb_offline', 'waiting_wifi', 'unauthorized', 'multiple_devices'].includes(state.phase);
    this.publish(state.phase, state.label, state.hint, { detail: error.message, device_online: disconnected ? false : this.state.device_online });
  }
  async tick() {
    try {
      if (!this.adb.available()) { const error = new Error('ADB executable not found'); error.code = 'ENOENT'; throw error; }
      const deviceState = await this.adb.run(['get-state']);
      if (deviceState !== 'device') throw new Error(`device ${deviceState || 'offline'}`);
      const wireless = this.transport === 'wifi';
      const serial = await this.adb.run(wireless ? ['shell', 'getprop', 'ro.serialno'] : ['get-serialno']);
      if (wireless && serial !== this.expectedSerial) {
        this.configured = false;
        this.publish('wrong_device', '无线头显身份不符', '此地址不是指定序列号的头显。请确认地址；不会启动 App 或修改设备。', { device_online: false }); return;
      }
      if (this.serial && this.serial !== serial) {
        this.publish('wrong_device', 'USB 设备已变化', '请重新连接本次使用的头显，或关闭本程序后选择另一台设备。', { device_online: false }); return;
      }
      if (!this.serial) {
        if (!wireless) {
          // USB overrides must resolve to the physical USB headset. Wi-Fi has its own identity check above.
          const physical = await this.adb.run(['get-serialno'], { usb: true });
          if (physical !== serial) {
            this.publish('wrong_device', '请选择 USB 头显', '指定的序列号不是当前 USB 设备。', { device_online: false }); return;
          }
        }
        this.serial = serial;
        if (!wireless) this.adb.bind?.(serial);
      }
      if (!this.configured) await this.configure();
      if (!this.configured) return;
      if (this.now() - this.lastProximity >= 25000) await this.requestAwake();
      const snapshot = this.hub.snapshot();
      const fresh = snapshot.transport_connected && snapshot.frame && this.now() - snapshot.frame_received_at_ms <= 1500;
      if (fresh) {
        this.lastData = this.now();
        const frame = snapshot.frame;
        if (!frame.focused) {
          this.publish('waiting_focus', '等待头显输入焦点', '请关闭头显系统菜单或确认弹窗；采集 App 保持前台后会自动继续。');
          if (!this.everFocused && this.now() - this.lastLaunch >= 10000 && this.attempts < this.maxLaunches) await this.launch();
        }
        else if (!frame.left.pose_active || !frame.right.pose_active) {
          this.everFocused = true; this.attempts = 0; this.lastLaunch = this.now();
          const missing = !frame.left.pose_active && !frame.right.pose_active ? '左右手柄' : !frame.left.pose_active ? '左手柄' : '右手柄';
          this.publish('waiting_hands', `请唤醒${missing}`, '拿起手柄并按一下扳机或 A/X 键。此时不需要佩戴头显，唤醒后自动继续。');
        } else if (!['left', 'right'].every(side => frame[side].position_valid && frame[side].orientation_valid && frame[side].position_tracked && frame[side].orientation_tracked)) {
          this.everFocused = true; this.attempts = 0; this.lastLaunch = this.now();
          this.publish('localizing', '正在建立 6DoF 定位', '保持光照和摄像头无遮挡；必要时拿起头显缓慢观察房间，再把手柄在它前方移动约 20 秒，之后可放回桌上。');
        } else { this.everFocused = true; this.attempts = 0; this.lastLaunch = this.now(); this.publish('ready', '双手 6DoF 已就绪', '可将头显放在旁边，直接操作左右手柄。'); }
        return;
      }
      if (this.now() - this.lastDiagnostic >= 10000) {
        this.lastDiagnostic = this.now();
        try {
          const activities = await this.adb.run(['shell', 'dumpsys', 'activity', 'activities'], { timeout: 4000 });
          const blocked = /topResumedActivity=.*LaunchCheckControllerRequiredDialogActivity/.test(activities);
          if (this.controllerDialog && !blocked) { this.attempts = 0; this.lastLaunch = -Infinity; }
          this.controllerDialog = blocked;
        } catch { /* Older OS versions may not expose the activity diagnostic. */ }
      }
      if (this.controllerDialog) {
        this.publish('waiting_controller_start', '系统正在等待控制器确认', '先拿起左右手柄并按扳机或 A/X 键；若已唤醒仍停留，请临时查看头显，在“需要控制器”弹窗选择“继续”，之后放回旁边，程序会自动继续。');
        return;
      }
      if (this.now() - this.lastLaunch >= 10000 && this.attempts < this.maxLaunches) {
        await this.ensureMapping();
        if (this.now() - this.lastProximity >= 5000) await this.requestAwake();
        await this.launch();
      }
      if (this.attempts >= this.maxLaunches && this.now() - this.lastLaunch >= 10000) {
        this.publish('waiting_headset', '采集 App 尚未返回数据', '已完成有限次数的启动尝试。先短按头显电源键；若仍无数据，请处理头显内的确认弹窗，或手动打开 Quest USB Forwarder。打开后会自动接入。');
      } else this.publish('waiting_app', '正在等待采集 App 的首帧', '启动请求已发出；正在确认实际数据。头显可以放在旁边，暂时不需要佩戴。');
    } catch (error) {
      if (!this.running && this.stopping) return;
      this.configured = false;
      this.report(error);
      if ((error.timedOut || error.message.toLowerCase().includes('offline')) && this.now() - this.lastReconnect >= 15000) {
        this.lastReconnect = this.now();
        try { await this.adb.run(['reconnect'], { timeout: 3000 }); } catch { /* Bounded recovery of this selected USB transport only. */ }
      }
    }
  }
  async configure() {
    this.publish('checking_app', `${this.transport === 'wifi' ? 'Wi-Fi' : 'USB'} 已连接，正在检查采集 App`, '已安装且版本相同的 APK 会直接复用。', { device_online: true, device_serial: this.serial, detail: null });
    let packagePath = '';
    try { packagePath = await this.adb.run(['shell', 'pm', 'path', PACKAGE]); }
    catch (error) { if (!/unknown package|package .*not found|not installed/i.test(error.message)) throw error; }
    let localHash = null;
    try { localHash = createHash('sha256').update(await fs.readFile(this.apk)).digest('hex'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    let different = false;
    const remotePath = packagePath.match(/^package:(\/data\/app\/[A-Za-z0-9_\/~.+=-]+\.apk)$/m)?.[1];
    if (localHash && remotePath && !this.reinstall) {
      try {
        const hash = (await this.adb.run(['shell', 'sha256sum', remotePath])).split(/\s+/)[0];
        if (/^[a-f0-9]{64}$/i.test(hash)) different = hash.toLowerCase() !== localHash;
      } catch { /* An installed app remains usable if the OS does not expose its APK hash. */ }
    }
    if (!packagePath || (this.install && (different || this.reinstall))) {
      if (!this.install || !localHash) {
        this.publish('app_missing', '需要安装或更新采集 App', '请先构建 dist/quest-usb-forwarder.apk，并允许安装；程序将继续检测。'); return;
      }
      if (localHash !== this.lastInstallHash) { this.installFailures = 0; this.lastInstallHash = localHash; }
      if ((this.installFailures ?? 0) >= 3 || this.now() < (this.installRetryAfter ?? 0)) {
        this.publish('install_error', '采集 App 安装未完成', '已限制自动重试次数。请检查 APK 和设备提示，修复后重新启动程序。'); return;
      }
      this.publish('installing', '正在安装采集 App', '安装只在缺失、APK 变化或指定 --reinstall 时进行，网页保持可用。');
      try { await this.adb.run(['install', '-r', this.apk], { timeout: 120000 }); }
      catch (error) {
        this.installFailures = (this.installFailures ?? 0) + 1;
        this.installRetryAfter = this.now() + 15000;
        this.publish('install_error', '采集 App 安装未完成', '请检查设备上的安装确认或 APK。短暂等待后会有限重试。', { detail: error.message }); return;
      }
      this.reinstall = false;
    }
    this.publish('preparing', `正在准备 ${this.transport === 'wifi' ? 'Wi-Fi' : 'USB'} 数据通道`, '正在设置端口转发与临时模拟佩戴。', { app_installed: true });
    await this.ensureMapping();
    try { await this.adb.run(['shell', 'pidof', PACKAGE]); this.appAlreadyRunning = true; }
    catch { this.appAlreadyRunning = false; }
    await this.requestAwake();
    this.configured = true; this.attempts = 0; this.lastLaunch = -Infinity;
  }
  async ensureMapping() {
    const mapping = reverseTarget(await this.adb.run(['reverse', '--list']), 19427);
    if (mapping && mapping !== 'tcp:19427') { const error = new Error('USB tcp:19427 is mapped to a different receiver; close that session first.'); error.code = 'REVERSE_CONFLICT'; throw error; }
    if (!mapping) { await this.adb.run(['reverse', 'tcp:19427', 'tcp:19427']); this.resources.mapping = true; }
  }
  async requestAwake() {
    await this.adb.run(['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP']);
    this.resources.proximity = true;
    await this.adb.run(['shell', 'am', 'broadcast', '-a', 'com.oculus.vrpowermanager.prox_close']);
    this.lastProximity = this.now();
  }
  async launch() {
    this.publish('starting_app', '正在启动头显采集 App', '将通过首帧与追踪标志确认就绪，不以启动命令的返回值判断成功。');
    const category = this.attempts === 1 ? 'com.oculus.intent.category.VR' : 'android.intent.category.LAUNCHER';
    const force = this.attempts === 2 ? ['-S'] : [];
    ++this.attempts; this.lastLaunch = this.now();
    if (!this.appAlreadyRunning) this.resources.app = true;
    try {
      await this.adb.run(['shell', 'am', 'start', ...force, '-a', 'android.intent.action.MAIN', '-c', category, '-n', COMPONENT], { timeout: 8000 });
    } catch (error) {
      this.publish('waiting_app', '启动请求尚未完成', '将检查真实数据，并进行有限次数的重试。', { detail: error.message });
    }
  }
  async stop() {
    if (this.stopPromise) return this.stopPromise;
    return this.stopPromise = (async () => {
      this.running = false; this.stopping = true; clearTimeout(this.timer); this.adb.abort();
      try { await this.inflight; } catch { /* Cleanup uses its own non-aborted commands. */ }
      if (this.transport === 'wifi' && Object.values(this.resources).some(Boolean)) {
        try {
          const physical = await this.adb.run(['shell', 'getprop', 'ro.serialno'], { cleanup: true, timeout: 4000 });
          if (physical !== this.expectedSerial) throw new Error('Wireless cleanup refused: headset serial does not match.');
        } catch (error) { this.log(`清理提示：${error.message}`); return [error.message]; }
      }
      const commands = [
        ...(this.resources.app ? [['shell', 'am', 'force-stop', PACKAGE]] : []),
        ...(this.resources.proximity ? [['shell', 'am', 'broadcast', '-a', 'com.oculus.vrpowermanager.automation_disable']] : []),
      ];
      const failures = [];
      for (const command of commands) {
        try { await this.adb.run(command, { cleanup: true, timeout: 4000 }); }
        catch (error) { failures.push(error.message); this.log(`清理提示：${error.message}`); }
      }
      if (this.resources.mapping) {
        try {
          const mapping = reverseTarget(await this.adb.run(['reverse', '--list'], { cleanup: true, timeout: 4000 }), 19427);
          if (mapping === 'tcp:19427') await this.adb.run(['reverse', '--remove', 'tcp:19427'], { cleanup: true, timeout: 4000 });
        } catch (error) { failures.push(error.message); this.log(`清理提示：${error.message}`); }
      }
      return failures;
    })();
  }
}
