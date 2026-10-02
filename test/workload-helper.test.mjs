import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('../workload', import.meta.url));

function command(program, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, output }));
  });
}

test('simultaneous session mutations cannot overwrite the active pointer; kernel releases the lock on exit', async () => {
  assert.equal(process.platform, 'linux', 'Helper lock proof requires Linux');
  const root = path.join(process.env.CLUTTA_PLAYGROUND_DATA_ROOT ?? path.join(homedir(), 'sanitized-cases/clutta-playground'), 'helper-tests');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(path.join(root, 'lock-proof-'));
  const lock = path.join(directory, 'operation.lock');
  const holder = spawn('flock', ['--no-fork', '--exclusive', lock, process.execPath, '-e',
    'process.stdout.write("ready\\n"); setTimeout(() => {}, 30000);'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise((resolve) => holder.once('exit', resolve));
  try {
    await new Promise((resolve, reject) => {
      holder.once('error', reject);
      holder.once('exit', () => reject(new Error('Lock owner exited before readiness')));
      holder.stdout.once('data', resolve);
    });
    const env = { ...process.env, CLUTTA_PLAYGROUND_DATA_ROOT: directory };
    delete env.CLUTTA_WORKLOAD_LOCK_HELD;
    const results = await Promise.all([
      command(process.execPath, [helper, 'start'], env),
      command(process.execPath, [helper, 'start'], env),
      command(process.execPath, [helper, 'stop'], env),
    ]);
    for (const result of results) {
      assert.equal(result.code, 1);
      assert.match(result.output, /Another start\/stop operation owns this data directory/);
    }
    assert.equal(existsSync(path.join(directory, 'active-workload.json')), false);
  } finally {
    holder.kill('SIGTERM');
    await exited;
  }
  const released = await command('flock', ['--nonblock', '--conflict-exit-code', '75', lock, 'true']);
  assert.equal(released.code, 0);
});

test('unknown arguments are rejected before touching a runtime or data session', async () => {
  const result = await command(process.execPath, [helper, 'start', '--with-clutta']);
  assert.equal(result.code, 1);
  assert.match(result.output, /Unexpected arguments for start/);
});

test('padded workload commands and a private data path containing spaces retain the same owned run', async () => {
  const root = path.join(process.env.CLUTTA_PLAYGROUND_DATA_ROOT ?? path.join(homedir(), 'sanitized-cases/clutta-playground'), 'helper-tests');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(path.join(root, 'workload with spaces-'));
  const project = 'clutta-playground-abcdef123456';
  const runDirectory = path.join(directory, project);
  mkdirSync(runDirectory, { mode: 0o700 });
  const activeFile = path.join(directory, 'active-workload.json');
  writeFileSync(activeFile, JSON.stringify({ project, directory: runDirectory, sourceRevision: 'a'.repeat(40), stopped: false }), { mode: 0o600 });
  const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
  const callsFile = path.join(directory, 'calls.jsonl');
  const result = await command(process.execPath, [helper, ' \tstop\n'], { ...process.env,
    PATH: `${fixtures}:${process.env.PATH}`, CLUTTA_PLAYGROUND_DATA_ROOT: ` \t${directory}\r\n`,
    CLUTTA_WORKLOAD_LOCK_HELD: '', LAB_TEST_CALLS: callsFile,
  });
  assert.equal(result.code, 0, result.output);
  assert.equal(JSON.parse(readFileSync(activeFile)).stopped, true);
  assert.equal(existsSync(runDirectory), true);
  const call = JSON.parse(readFileSync(callsFile, 'utf8').trim());
  assert.ok(call.args.includes(project));
  assert.ok(call.args.includes('down'));
  assert.ok(!call.args.includes('--volumes'));
});

test('blank workload commands, options, and directory overrides fail before creating state', async () => {
  for (const [args, env] of [[[' \t'], {}], [['status', ' \t'], {}], [['start'], { CLUTTA_PLAYGROUND_DATA_ROOT: ' \t\r\n' }]]) {
    const result = await command(process.execPath, [helper, ...args], { ...process.env, ...env });
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /cannot be empty or whitespace only/);
  }
});
