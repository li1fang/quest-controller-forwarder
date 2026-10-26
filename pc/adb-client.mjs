import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

export function findAdb(explicit, environment = process.env) {
  const candidates = [explicit, environment.ANDROID_HOME && path.join(environment.ANDROID_HOME, 'platform-tools', 'adb.exe'),
    environment.ANDROID_SDK_ROOT && path.join(environment.ANDROID_SDK_ROOT, 'platform-tools', 'adb.exe'),
    'C:/Android/Sdk/platform-tools/adb.exe', environment.LOCALAPPDATA && path.join(environment.LOCALAPPDATA, 'Android/Sdk/platform-tools/adb.exe'),
    ...(environment.PATH ?? environment.Path ?? '').split(path.delimiter).map(directory => path.join(directory, process.platform === 'win32' ? 'adb.exe' : 'adb'))];
  return candidates.find(candidate => candidate && fs.existsSync(candidate)) ?? null;
}

export function createAdbClient({ executable, serial, execute = execFile } = {}) {
  let controller = new AbortController();
  let boundSerial = null;
  return {
    available() { return findAdb(executable); },
    bind(value) { boundSerial = value; },
    abort() { controller.abort(); },
    async run(args, { timeout = 5000, cleanup = false, usb = false } = {}) {
      const binary = findAdb(executable);
      if (!binary) { const error = new Error('ADB executable not found'); error.code = 'ENOENT'; throw error; }
      const selectedSerial = serial ?? boundSerial;
      const target = !usb && selectedSerial ? ['-s', selectedSerial] : ['-d'];
      return new Promise((resolve, reject) => {
        execute(binary, [...target, ...args], { encoding: 'utf8', timeout, windowsHide: true,
          maxBuffer: 256 * 1024, ...(cleanup ? {} : { signal: controller.signal }) }, (error, stdout, stderr) => {
          if (!error) return resolve(String(stdout).trim());
          const detail = String(stderr || stdout || error.message).trim().slice(0, 1200);
          const failure = new Error(detail || 'ADB command failed');
          failure.code = error.code; failure.timedOut = error.killed || error.code === 'ETIMEDOUT';
          reject(failure);
        });
      });
    },
  };
}

export function classifyAdbError(error, transport = 'usb') {
  const state = classifyUsbAdbError(error);
  if (transport !== 'wifi') return state;
  if (['waiting_usb', 'usb_offline'].includes(state.phase)) return { phase: 'waiting_wifi', label: '等待无线 ADB 连接', hint: '确认头显开机且连接同一局域网；重新执行 adb connect 指定地址。不会改用 USB。' };
  if (state.phase === 'unauthorized') return { ...state, label: '无线 ADB 尚未授权', hint: '请先通过 USB 完成本机授权，再重新连接无线 ADB。' };
  if (state.phase === 'mapping_conflict') return { ...state, label: 'ADB 转发端口已被其他会话使用' };
  return state;
}

function classifyUsbAdbError(error) {
  const text = error.message.toLowerCase();
  if (error.code === 'REVERSE_CONFLICT') return { phase: 'mapping_conflict', label: 'USB 转发端口已被其他会话使用', hint: '请关闭旧采集会话，或恢复其端口配置；程序不会覆盖其他映射。' };
  if (error.code === 'ENOENT') return { phase: 'adb_missing', label: '未找到 ADB', hint: '请运行 scripts/install-toolchain.ps1 安装工具链，程序会继续检测。' };
  if (text.includes('unauthorized')) return { phase: 'unauthorized', label: '请允许 USB 调试', hint: '首次连接需在头显里允许 USB 调试，并勾选“始终允许这台计算机”。授权后会自动继续。' };
  if (text.includes('more than one')) return { phase: 'multiple_devices', label: '连接了多台 USB 设备', hint: '请只连接目标头显，或使用 --serial 指定头显；不会操作其他设备。' };
  if (text.includes('offline') || error.timedOut) return { phase: 'usb_offline', label: 'ADB 尚未响应', hint: '正在尝试恢复 USB 连接。若持续无响应，请短按头显电源键，或重新插紧 USB 数据线。' };
  if (/no devices|device .*not found|device not found/.test(text)) return { phase: 'waiting_usb', label: '等待 USB 头显', hint: '请保持头显开机并接上 USB 数据线。检测到连接后将自动继续。' };
  return { phase: 'device_error', label: '设备操作暂未完成', hint: '程序会继续检查连接；诊断详情中保留了设备返回的原因。' };
}

export function reverseTarget(output, port) {
  for (const line of output.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    const index = fields.indexOf(`tcp:${port}`);
    if (index >= 0 && index < fields.length - 1) return fields[index + 1];
  }
  return null;
}
