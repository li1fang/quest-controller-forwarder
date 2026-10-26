import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootFiles = ['.gitattributes', '.gitignore', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md', 'CMakeLists.txt', 'package.json', 'pnpm-lock.yaml'];
const docs = ['daily-use.md', 'annotation-use.md', 'build.md', 'protocol.md', 'validation.md', 'runtime-pairing.md', 'interface.md'];
const extensions = new Set(['.mjs', '.js', '.ps1', '.cs', '.java', '.cpp', '.h', '.html', '.css', '.json', '.xml', '.yml', '.yaml', '.md', '.txt']);
export function auditSourceFile(name, text) {
  if (/(^|\/)(?:\.git|\.local|recordings|validation|build|dist|node_modules)(\/|$)/.test(name) || /(?:receiver|lan-config)\.json$|\.(?:apk|pem|key|keystore|aar|dex|jar|png|jpg|zip)$/i.test(name)) throw new Error(`Private or generated file selected: ${name}`);
  const rules = [
    [/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/, 'private key'],
    [/\b\d{3}[A-Z]{2}[A-Z0-9]{8,}\b/, 'possible device serial'],
    [/[A-Z]:[\\/]Users[\\/][^\\/\s"']+/i, 'personal Windows path'],
    [/["']token["']\s*:\s*["'][a-f0-9]{64}["']/i, 'literal pairing token'],
  ];
  for (const [pattern, type] of rules) if (pattern.test(text)) throw new Error(`Review ${type} in ${name}; value withheld`);
  if (text.includes('\0') || text.includes('\uFFFD')) throw new Error(`Non-text or invalid UTF-8 selected: ${name}`);
}
export function collectPublicFiles(root = project) {
  const files = [...rootFiles, ...docs.map(name => 'docs/' + name), 'third_party/README.md'];
  for (const entry of fs.readdirSync(root)) if (entry.endsWith('.cmd') && entry !== 'Install-Quest-LAN-Candidate.cmd') files.push(entry);
  function walk(relative) {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const name = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`Symlink excluded from public source: ${name}`);
      if (entry.isDirectory()) walk(name);
      else if (name !== 'scripts/install-lan-candidate.ps1' && extensions.has(path.extname(entry.name))) files.push(name);
    }
  }
  for (const directory of ['app', 'pc', 'web', 'scripts', 'diagnostics', 'third_party/licenses', '.github']) walk(directory);
  return [...new Set(files)].sort();
}
export function exportPublic(destination) {
  destination = path.resolve(destination);
  const archive = destination + '.zip';
  if (fs.existsSync(destination) || fs.existsSync(archive)) throw new Error('Destination/archive already exists; nothing overwritten');
  const source = collectPublicFiles(), prepared = source.map(name => {
    const absolute = path.join(project, name);
    if (fs.lstatSync(absolute).isSymbolicLink()) throw new Error('Symlink source is not allowed');
    const text = fs.readFileSync(absolute, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    auditSourceFile(name, text); return { name, text };
  });
  fs.mkdirSync(destination, { recursive: true });
  const files = [];
  for (const { name, text } of prepared) {
    const target = path.join(destination, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, text, { flag: 'wx' });
    files.push({ file: name, sha256: createHash('sha256').update(text).digest('hex') });
  }
  fs.writeFileSync(path.join(destination, 'SOURCE_MANIFEST.json'), JSON.stringify({ schema: 'quest-public-source-v1', license: 'MIT', files }, null, 2) + '\n', { flag: 'wx' });
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Quest Controller Forwarder contributors', GIT_AUTHOR_EMAIL: 'contributors@localhost', GIT_COMMITTER_NAME: 'Quest Controller Forwarder contributors', GIT_COMMITTER_EMAIL: 'contributors@localhost' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[key];
  const git = args => execFileSync('git', args, { cwd: destination, env, windowsHide: true, encoding: 'utf8' }).trim();
  git(['init', '--initial-branch=main']); git(['add', '.']);
  git(['-c', 'commit.gpgsign=false', 'commit', '-m', 'Initial open-source source snapshot']);
  if (git(['rev-list', '--count', 'HEAD']) !== '1' || git(['remote'])) throw new Error('Expected one clean initial commit and no remotes');
  const commit = git(['rev-parse', 'HEAD']);
  git(['archive', '--format=zip', '--prefix=quest-controller-forwarder/', '--output', archive, 'HEAD']);
  return { directory: destination, archive, commit, file_count: files.length + 1, archive_sha256: createHash('sha256').update(fs.readFileSync(archive)).digest('hex'), history_commits: 1, remote_count: 0 };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== '--destination') throw new Error('Usage: node scripts/export-public.mjs --destination NEW_LOCAL_DIRECTORY');
    console.log(JSON.stringify(exportPublic(args[1]), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
