import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const lab = fileURLToPath(new URL('../lab', import.meta.url));
const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
const workspaceId = '11111111-1111-4111-8111-111111111111';
const projectId = '22222222-2222-4222-8222-222222222222';
const sourceId = '33333333-3333-4333-8333-333333333333';

function command(args, env) {
  return new Promise((resolve) => execFile(process.execPath, [lab, ...args], { env, timeout: 10000 },
    (error, stdout, stderr) => resolve({ code: error?.code ?? 0, output: stdout + stderr })));
}

function fixture({ cloud = true, credentials = false, prefix = 'guided-' } = {}) {
  const root = path.join(process.env.CLUTTA_PLAYGROUND_DATA_ROOT ?? path.join(homedir(), 'sanitized-cases/clutta-playground'), 'helper-tests');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(path.join(root, prefix));
  const project = 'clutta-playground-abcdef123456';
  const runDirectory = path.join(directory, project);
  mkdirSync(runDirectory, { mode: 0o700 });
  const save = (name, value) => writeFileSync(path.join(directory, name), JSON.stringify(value), { mode: 0o600 });
  save('active-workload.json', { project, directory: runDirectory, sourceRevision: 'a'.repeat(40), stopped: false });
  if (cloud) save('active-cloud.json', { workloadProject: project, directory: runDirectory,
    workspaceId, projectId, sourceId, agentName: 'clutta-scheduler-abcdef123456', stopped: false,
    runtime: { tag: 'v0.2.20', scanImage: `sefastech/clutta-scan@sha256:${'b'.repeat(64)}` } });
  if (credentials) save('lab-auth.json', { api_key: 'offline-fixture-value', workspace_id: workspaceId, project_id: projectId });
  const callsFile = path.join(directory, 'calls.jsonl');
  return { directory, runDirectory, callsFile, env: { ...process.env,
    PATH: `${fixtures}:${process.env.PATH}`, NODE_OPTIONS: `--import=${path.join(fixtures, 'deny-network.mjs')}`,
    CLUTTA_PLAYGROUND_DATA_ROOT: directory, CLUTTA_PLAYGROUND_LOCK_HELD: '',
    CLUTTA_API_KEY: 'ambient-value-must-not-be-used', LAB_TEST_CALLS: callsFile } };
}

test('help explains the journey and unexpected arguments never touch a session or expose a key', async () => {
  const help = await command(['help'], process.env);
  assert.equal(help.code, 0);
  assert.match(help.output, /review and activate in the browser/);
  const result = await command(['start', 'secret-argument-not-to-echo'], process.env);
  assert.equal(result.code, 1);
  assert.match(result.output, /Unexpected arguments/);
  assert.doesNotMatch(result.output, /secret-argument-not-to-echo/);
});

test('stop works offline without a saved key, stops only the owned project, preserves data, and is repeatable', async () => {
  const fixture_ = fixture();
  const result = await command(['stop'], fixture_.env);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /local stop is complete/);
  assert.equal(JSON.parse(readFileSync(path.join(fixture_.directory, 'active-cloud.json'))).stopped, true);
  assert.equal(JSON.parse(readFileSync(path.join(fixture_.directory, 'active-workload.json'))).stopped, true);
  assert.equal(existsSync(fixture_.runDirectory), true);
  const calls = readFileSync(fixture_.callsFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => !call.inheritedKey));
  assert.ok(calls[1].args.includes('clutta-playground-abcdef123456'));
  assert.ok(calls[1].args.includes('down'));
  assert.ok(!calls[1].args.includes('--volumes'));
  const repeated = await command(['stop'], fixture_.env);
  assert.equal(repeated.code, 0, repeated.output);
});

test('stop still succeeds when a saved key exists but Cloud is unreachable', async () => {
  const fixture_ = fixture({ credentials: true });
  const result = await command(['stop'], fixture_.env);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /retirement is not confirmed/);
  assert.doesNotMatch(result.output, /offline-fixture-value|ambient-value/);
  assert.match(readFileSync(fixture_.callsFile, 'utf8'), /network-denied/);
});

test('local repair runs before Cloud validation and does not pretend Cloud recovered', async () => {
  const fixture_ = fixture({ credentials: true });
  const result = await command(['repair'], fixture_.env);
  assert.equal(result.code, 1);
  assert.match(result.output, /Local recovery confirmed/);
  assert.doesNotMatch(result.output, /PASS: backlog drained|offline-fixture-value|ambient-value/);
  const calls = readFileSync(fixture_.callsFile, 'utf8').trim().split('\n');
  assert.equal(calls.at(-1), 'network-denied');
  assert.ok(JSON.parse(calls[0]).args.includes('resume'));
  assert.equal(JSON.parse(readFileSync(path.join(fixture_.directory, 'active-cloud.json'))).stopped, false);
});

test('a failed registration with no Cloud session can still stop the idle workload', async () => {
  const fixture_ = fixture({ cloud: false });
  const result = await command(['stop'], fixture_.env);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /No Cloud session was available/);
  assert.equal(JSON.parse(readFileSync(path.join(fixture_.directory, 'active-workload.json'))).stopped, true);
  assert.equal(existsSync(fixture_.runDirectory), true);
});

test('padded commands and data directories normalize before ownership checks and remain private', async () => {
  const fixture_ = fixture({ prefix: 'guided with spaces-' });
  const result = await command([' \tstop\n'], {
    ...fixture_.env, CLUTTA_PLAYGROUND_DATA_ROOT: ` \t${fixture_.directory}\r\n`,
  });
  assert.equal(result.code, 0, result.output);
  assert.equal(JSON.parse(readFileSync(path.join(fixture_.directory, 'active-workload.json'))).stopped, true);
  assert.equal(JSON.parse(readFileSync(path.join(fixture_.directory, 'active-cloud.json'))).stopped, true);
  assert.equal(existsSync(fixture_.runDirectory), true);
  assert.doesNotMatch(result.output, /ambient-value/);
});

test('blank commands, arguments, and data overrides stop before network or owned runtime operations', async () => {
  for (const [args, paddedRoot] of [[[' \t\n'], false], [['start', ' \t'], false], [['start'], true]]) {
    const fixture_ = fixture();
    const result = await command(args, { ...fixture_.env,
      ...(paddedRoot ? { CLUTTA_PLAYGROUND_DATA_ROOT: ' \t\r\n' } : {}),
    });
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /cannot be empty or whitespace only/);
    assert.equal(existsSync(fixture_.callsFile), false);
    assert.equal(JSON.parse(readFileSync(path.join(fixture_.directory, 'active-workload.json'))).stopped, false);
  }
});
