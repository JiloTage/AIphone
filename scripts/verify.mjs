import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const started = new Date();
if (existsSync('evidence/verification.json')) {
  const prior = JSON.parse(readFileSync('evidence/verification.json', 'utf8'));
  const archive = `evidence/runs/${prior.startedAt.replaceAll(/[:.]/g, '-')}`;
  mkdirSync(archive, { recursive: true });
  for (const file of ['verification.json', ...prior.results.map(result => result.log)]) copyFileSync(`evidence/${file}`, `${archive}/${file}`);
}
const commands = [
  [process.execPath, ['--test', 'tests/api.test.js', 'tests/core.test.js']],
  ['uv', ['run', 'python', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_*.py', '-v']],
  ['uv', ['run', 'python', '-c', "import backend.modal_app; print('Modal app import: OK')"]],
  [process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'deploy', '--dry-run', '--outdir', 'dist']],
];
const results = [];
mkdirSync('evidence', { recursive: true });
for (const [command, args] of commands) {
  const before = Date.now();
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 120_000 });
  const output = (result.stdout || '') + (result.stderr || '');
  const logfile = `check-${results.length + 1}.log`;
  writeFileSync(path.join('evidence', logfile), output);
  results.push({ command: [command, ...args], exitCode: result.status, error: result.error?.message, durationMs: Date.now() - before, log: logfile });
  process.stdout.write(`${command} ${args.join(' ')}: ${result.status === 0 ? 'PASS' : 'FAIL'}\n`);
  if (result.status !== 0) process.stdout.write(output);
}
const hashes = {};
function hashFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) { if (entry.name !== '__pycache__') hashFiles(file); }
    else hashes[file.replaceAll('\\', '/')] = createHash('sha256').update(readFileSync(file)).digest('hex');
  }
}
for (const directory of ['src', 'public', 'backend', 'config', 'prompts', 'tests']) hashFiles(directory);
for (const file of ['package.json', 'package-lock.json', 'pyproject.toml', 'uv.lock', 'wrangler.jsonc']) hashes[file] = createHash('sha256').update(readFileSync(file)).digest('hex');
writeFileSync('evidence/verification.json', JSON.stringify({ startedAt: started.toISOString(), finishedAt: new Date().toISOString(), node: process.version, scope: 'Local assertions, mocked upstreams, Modal module import, Cloudflare dry-run. No live AI, GPU inference, or real microphone tests.', results, sha256: hashes }, null, 2) + '\n');
if (results.some(result => result.exitCode !== 0)) process.exitCode = 1;
