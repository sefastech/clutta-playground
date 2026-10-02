import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runCodespaceStartup, startCodespace } from '../.devcontainer/startup.mjs';

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const config = JSON.parse(readFileSync(path.join(repository, '.devcontainer/devcontainer.json'), 'utf8'));

test('Codespaces pins its environment, runs setup on every start, and exposes no application ports', () => {
  const dockerfile = readFileSync(path.join(repository, '.devcontainer/Dockerfile'), 'utf8');
  assert.match(dockerfile, /^FROM mcr\.microsoft\.com\/devcontainers\/javascript-node:3-24-bookworm@sha256:[a-f0-9]{64}\n/);
  const features = Object.keys(config.features);
  assert.equal(features.length, 1);
  assert.match(features[0], /^ghcr\.io\/devcontainers\/features\/docker-in-docker@sha256:[a-f0-9]{64}$/);
  assert.equal(config.remoteUser, 'node');
  assert.deepEqual(config.postStartCommand, ['node', '.devcontainer/startup.mjs', '--codespaces-hook']);
  // Wait for dependency installation to finish before exposing lab commands.
  // The optional hook reports failure without forcing a recovery container.
  assert.equal(config.waitFor, 'postStartCommand');
  assert.deepEqual(config.forwardPorts, []);
  assert.equal(config.otherPortsAttributes.onAutoForward, 'ignore');
  assert.equal(config.customizations.vscode.settings['remote.autoForwardPorts'], false);
  assert.ok(config.hostRequirements.cpus >= 2);
  assert.equal(config.hostRequirements.memory, '4gb');
  assert.deepEqual(config.mounts, ['source=clutta-playground-data-${devcontainerId},target=/home/node/sanitized-cases,type=volume']);
  for (const prohibited of ['initializeCommand', 'postAttachCommand', 'containerEnv', 'remoteEnv', 'workspaceMount']) {
    assert.equal(config[prohibited], undefined);
  }
});

test('each startup verifies prerequisites and reinstalls lockfile dependencies before stable bootstrap', async () => {
  const calls = [], messages = [];
  const environment = { PATH: '/usr/bin', CLUTTA_API_KEY: 'never-inherit-this', CLUTTA_WORKSPACE_ID: 'foreign', CLUTTA_PLAYGROUND_DATA_ROOT: '/owned/lab' };
  for (let run = 0; run < 2; run++) {
    await startCodespace({ execute: (...call) => calls.push(call), log: (message) => messages.push(message), environment });
  }
  assert.equal(calls.length, 16);
  assert.deepEqual(calls.slice(0, 8).map(([program, args]) => [path.basename(program), args]), [
    ['node', ['--eval', 'if (Number(process.versions.node.split(".")[0]) < 20) process.exit(1)']],
    ['git', ['--version']], ['flock', ['--version']],
    ['docker', ['info', '--format', '{{.ServerVersion}}']], ['docker', ['compose', 'version']],
    ['npm', ['ci', '--ignore-scripts', '--no-fund', '--no-audit']],
    ['npm', ['--prefix', 'scenarios/scheduler', 'ci', '--ignore-scripts', '--no-fund', '--no-audit']],
    ['lab', ['bootstrap']],
  ]);
  assert.deepEqual(calls.slice(0, 8), calls.slice(8));
  for (const [, args, options] of calls) {
    assert.equal(options.cwd, repository);
    assert.equal(options.env.CLUTTA_API_KEY, undefined);
    assert.equal(options.env.CLUTTA_WORKSPACE_ID, undefined);
    assert.equal(options.env.CLUTTA_PLAYGROUND_DATA_ROOT, '/owned/lab');
    assert.equal(options.timeout, args[0] === 'info' ? 5000 : args.includes('bootstrap') ? 600000 : 180000);
    assert.equal(options.stdio, args[0] === 'info' ? 'pipe' : 'inherit');
    assert.equal(options.killSignal, args[0] === 'info' ? 'SIGKILL' : undefined);
  }
  assert.equal(environment.CLUTTA_API_KEY, 'never-inherit-this');
  assert.ok(messages.at(-1).includes('./lab start'));
});

test('a failed prerequisite stops before bootstrap or Cloud operations', async () => {
  const calls = [];
  await assert.rejects(startCodespace({
    execute: (program) => { calls.push(path.basename(program)); if (program === 'docker') throw new Error('daemon unavailable'); },
    log: () => {}, environment: {},
  }), /daemon unavailable/);
  assert.deepEqual(calls, ['node', 'git', 'flock', 'docker']);
});

test('a failed stable refresh does not report readiness or select a cached fallback', async () => {
  const messages = [];
  await assert.rejects(startCodespace({
    execute: (program, args) => { if (args.includes('bootstrap')) throw new Error('stable refresh failed'); },
    log: (message) => messages.push(message), environment: {},
  }), /stable refresh failed/);
  assert.equal(messages.length, 1);
  assert.ok(!messages.some((message) => message.startsWith('Ready')));
});

function clock() {
  let elapsed = 0;
  return { now: () => elapsed, sleep: async (ms) => { elapsed += ms; }, advance: (ms) => { elapsed += ms; } };
}

const unavailable = () => Object.assign(new Error('Cannot connect to the Docker daemon'), { status: 1 });

test('a resumed daemon becoming ready is verified before dependencies or runtime refresh', async () => {
  const calls = [], messages = [], time = clock();
  let probes = 0;
  await startCodespace({
    ...time, environment: {}, log: (message) => messages.push(message),
    execute: (program, args) => {
      calls.push([path.basename(program), args]);
      if (args[0] === 'info' && ++probes < 3) throw unavailable();
    },
  });
  assert.equal(time.now(), 4000);
  assert.deepEqual(calls.map(([program]) => program), ['node', 'git', 'flock', 'docker', 'docker', 'docker', 'docker', 'npm', 'npm', 'lab']);
  assert.equal(messages.filter((message) => message.startsWith('Docker readiness')).length, 2);
  assert.ok(messages.at(-1).startsWith('Ready for setup'));
});

test('persistent daemon failure is bounded and never runs npm, bootstrap, or workload commands', async () => {
  const calls = [], messages = [], time = clock();
  await assert.rejects(startCodespace({
    ...time, environment: {}, log: (message) => messages.push(message),
    execute: (program, args) => {
      calls.push([program, args]);
      if (program === 'docker') throw unavailable();
    },
  }), /Docker daemon is still unavailable after 60 seconds/);
  assert.equal(time.now(), 60000);
  assert.equal(calls.filter(([program]) => program === 'docker').length, 30);
  assert.ok(calls.every(([program]) => ['node', 'git', 'flock', 'docker'].includes(program)));
  assert.ok(!messages.some((message) => message.startsWith('Ready')));
});

test('hung Docker probes include their duration in the single readiness deadline', async () => {
  const time = clock(), timeouts = [];
  await assert.rejects(startCodespace({
    ...time, environment: {}, log: () => {},
    execute: (program, args, options) => {
      if (args[0] !== 'info') return;
      timeouts.push(options.timeout);
      time.advance(options.timeout);
      throw Object.assign(new Error('probe timed out'), { code: 'ETIMEDOUT', status: null });
    },
  }), /after 60 seconds/);
  assert.equal(time.now(), 60000);
  assert.equal(timeouts.length, 9);
  assert.equal(timeouts.at(-1), 4000);
  assert.ok(timeouts.every((value) => Number.isInteger(value) && value > 0 && value <= 5000));
});

test('missing Docker executable is not retried or mistaken for a warming daemon', async () => {
  const time = clock(), calls = [];
  await assert.rejects(startCodespace({
    ...time, environment: {}, log: () => {},
    execute: (program) => {
      calls.push(program);
      if (program === 'docker') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
  }), /Docker CLI is missing/);
  assert.equal(time.now(), 0);
  assert.deepEqual(calls, ['node', 'git', 'flock', 'docker']);
});

test('the optional lifecycle hook keeps the terminal accessible but manual preparation fails strictly', async () => {
  for (const lifecycle of [false, true]) {
    const time = clock(), messages = [], calls = [];
    const exitCode = await runCodespaceStartup({
      ...time, lifecycle, environment: {}, log: (message) => messages.push(message), report: (message) => messages.push(message),
      execute: (program) => { calls.push(program); if (program === 'docker') throw unavailable(); },
    });
    assert.equal(exitCode, lifecycle ? 0 : 1);
    assert.ok(messages.some((message) => message.startsWith('Lab not ready.')));
    assert.ok(messages.some((message) => message.includes('/tmp/dockerd.log')));
    assert.ok(!messages.some((message) => message.startsWith('Ready')));
    assert.ok(!calls.includes('npm'));
    assert.ok(!calls.some((program) => ['sudo', 'dockerd', 'containerd', 'lab'].includes(path.basename(program))));
  }
});

test('failed hook refresh stays explicit, without reporting stale artifacts as ready', async () => {
  const messages = [];
  assert.equal(await runCodespaceStartup({
    lifecycle: true, environment: {}, log: (message) => messages.push(message), report: (message) => messages.push(message),
    execute: (program, args) => { if (args.includes('bootstrap')) throw new Error('stable refresh failed'); },
  }), 0);
  assert.ok(messages.some((message) => message.startsWith('Lab not ready.')));
  assert.ok(!messages.some((message) => message.startsWith('Ready')));
});

test('actual hook entrypoint acknowledges preparation failure while manual and unknown invocations fail', () => {
  for (const [args, status] of [[[], 1], [['--codespaces-hook'], 0], [[' \t--codespaces-hook\n'], 0], [['--unknown'], 1]]) {
    const result = spawnSync(process.execPath, [path.join(repository, '.devcontainer/startup.mjs'), ...args], {
      cwd: repository, env: { PATH: '/nonexistent-playground-prerequisites' }, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, status);
    assert.ok(!result.stdout.includes('Ready for setup'));
    assert.match(result.stderr, args[0] === '--unknown' ? /Usage:/ : /Lab not ready/);
  }
});

test('startup trims a configured data directory and rejects an explicitly blank override before preparation', async () => {
  const calls = [];
  await startCodespace({
    environment: { CLUTTA_PLAYGROUND_DATA_ROOT: ' \t/owned/path with spaces\n' }, log: () => {},
    execute: (...call) => calls.push(call),
  });
  assert.ok(calls.every(([, , options]) => options.env.CLUTTA_PLAYGROUND_DATA_ROOT === '/owned/path with spaces'));
  const rejectedCalls = [];
  await assert.rejects(startCodespace({
    environment: { CLUTTA_PLAYGROUND_DATA_ROOT: ' \t\r\n' }, log: () => {},
    execute: (...call) => rejectedCalls.push(call),
  }), /cannot be empty or whitespace only/);
  assert.deepEqual(rejectedCalls, []);
});

test('unexpected transport errors are not printed as trusted readiness guidance', async () => {
  const messages = [];
  assert.equal(await runCodespaceStartup({
    lifecycle: true, environment: {}, log: () => {}, report: (message) => messages.push(message),
    execute: () => { throw new Error('Docker untrusted credential-bearing details'); },
  }), 0);
  assert.ok(!messages.some((message) => message.includes('credential-bearing')));
});
