import { execFile } from 'node:child_process';
import { parseOptions } from './receiver.mjs';

export function parseLaunchOptions(args) {
  let open = true, reinstall = false, wifi;
  const withoutWifi = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--wifi') {
      if (wifi !== undefined) throw new Error('Only one --wifi endpoint is allowed');
      wifi = args[++index];
      if (!wifi || wifi.startsWith('--')) throw new Error('Missing value for --wifi');
    } else withoutWifi.push(args[index]);
  }
  const rest = withoutWifi.filter(argument => {
    if (argument === '--no-open') { open = false; return false; }
    if (argument === '--reinstall') { reinstall = true; return false; }
    return true;
  });
  const options = parseOptions(rest);
  if (reinstall && options.install === false) throw new Error('--reinstall and --no-install cannot be combined');
  const result = { ...options, open, reinstall, ...(wifi === undefined ? {} : { wifi }) };
  validateWirelessOptions(result);
  return result;
}

export function validateWirelessOptions(options) {
  if (options.wifi === undefined) return;
  const match = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.exec(options.wifi);
  if (!match || match[1].split('.').some(part => Number(part) > 255) || Number(match[2]) < 1 || Number(match[2]) > 65535) {
    throw new Error('--wifi requires an explicit IPv4:port endpoint');
  }
  if (!options.serial || !/^[A-Za-z0-9._-]+$/.test(options.serial)) {
    throw new Error('--wifi requires --serial with the physical headset serial, not its IP address');
  }
}

export function openLocalBrowser(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw new Error('Only this application\'s loopback URL can be opened');
  }
  const command = process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', parsed.href]]
    : process.platform === 'darwin' ? ['open', [parsed.href]] : ['xdg-open', [parsed.href]];
  return new Promise((resolve, reject) => {
    execFile(command[0], command[1], { windowsHide: true, timeout: 10000 }, error => error ? reject(error) : resolve());
  });
}
