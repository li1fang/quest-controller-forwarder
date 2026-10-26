// Consumed locally by the PowerShell launcher before any device setting changes.
import { parseLaunchOptions } from './launch-options.mjs';
import { findAdb } from './adb-client.mjs';
try {
  const options = parseLaunchOptions(process.argv.slice(2));
  console.log(JSON.stringify({ ...options, adb: findAdb(options.adb) }));
} catch (error) { console.error(error.message); process.exitCode = 1; }
