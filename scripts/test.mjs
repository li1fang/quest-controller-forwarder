import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Windows cmd.exe and Node 20 do not expand the pc/*.test.mjs glob.
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tests = fs.readdirSync(path.join(project, 'pc'), { withFileTypes: true })
  .filter(entry => entry.isFile() && entry.name.endsWith('.test.mjs'))
  .map(entry => path.join(project, 'pc', entry.name)).sort();
if (!tests.length) throw new Error('No test files found');
const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...tests], { cwd: project, stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
