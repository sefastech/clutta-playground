import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { checkScriptInputs, trimInput } from '../scenarios/scheduler/src/input.mjs';

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const dockerWaitMs = 60000;
const dockerProbeMs = 5000;
const dockerRetryMs = 2000;
class DockerReadinessError extends Error {}

async function waitForDocker({ execute, options, log, now, sleep }) {
  const started = now();
  for (;;) {
    const remaining = Math.floor(dockerWaitMs - (now() - started));
    if (remaining <= 0) throw new DockerReadinessError('Docker daemon is still unavailable after 60 seconds. Inspect /tmp/dockerd.log and /tmp/containerd.log in the Node container; do not remove Docker data or change socket permissions.');
    try {
      execute('docker', ['info', '--format', '{{.ServerVersion}}'], {
        ...options, stdio: 'pipe', timeout: Math.min(dockerProbeMs, remaining), killSignal: 'SIGKILL',
      });
      return;
    } catch (error) {
      if (error.code === 'ENOENT') throw new DockerReadinessError('Docker CLI is missing. Rebuild the configured Node container; the recovery image is not the lab environment.');
      if (error.code !== 'ETIMEDOUT' && typeof error.status !== 'number') throw error;
      log(`Docker readiness: waiting (${Math.floor((now() - started) / 1000)}s of 60s). No lab workload has been started by this hook.`);
      const pause = Math.min(dockerRetryMs, dockerWaitMs - (now() - started));
      if (pause > 0) await sleep(pause);
    }
  }
}

export async function startCodespace({ execute = execFileSync, log = console.log, environment = process.env, now = () => performance.now(), sleep = delay } = {}) {
  const env = { ...environment };
  if (env.CLUTTA_PLAYGROUND_DATA_ROOT !== undefined) env.CLUTTA_PLAYGROUND_DATA_ROOT = trimInput(env.CLUTTA_PLAYGROUND_DATA_ROOT);
  checkScriptInputs([], env.CLUTTA_PLAYGROUND_DATA_ROOT);
  for (const key of Object.keys(env)) {
    if (key.startsWith('CLUTTA_') && !key.startsWith('CLUTTA_PLAYGROUND_')) delete env[key];
  }
  const options = { cwd: repository, env, stdio: 'inherit', timeout: 180000 };
  log('Preparing your lab. No workspace key or Cloud evidence is needed for this step.');
  for (const [program, args] of [
    ['node', ['--eval', 'if (Number(process.versions.node.split(".")[0]) < 20) process.exit(1)']],
    ['git', ['--version']],
    ['flock', ['--version']],
  ]) execute(program, args, options);
  await waitForDocker({ execute, options, log, now, sleep });
  for (const [program, args] of [
    ['docker', ['compose', 'version']],
    ['npm', ['ci', '--ignore-scripts', '--no-fund', '--no-audit']],
    ['npm', ['--prefix', 'scenarios/scheduler', 'ci', '--ignore-scripts', '--no-fund', '--no-audit']],
    [path.join(repository, 'lab'), ['bootstrap']],
  ]) {
    execute(program, args, args.includes('bootstrap') ? { ...options, timeout: 600000 } : options);
  }
  log('Ready for setup: run ./lab start in the terminal. Use your own Clutta account and workspace key.');
}

export async function runCodespaceStartup({ lifecycle = false, report = console.error, ...options } = {}) {
  try { await startCodespace(options); return 0; }
  catch (error) {
    report('Lab not ready. No Cloud scan or payment traffic was started by this hook.');
    if (error instanceof DockerReadinessError) report(error.message);
    report('Fix the prerequisite or network error, then run node .devcontainer/startup.mjs. See docs/troubleshooting.md.');
    // An optional preparation failure must not replace the working Node container with recovery mode.
    // Manual preparation and ./lab start retain their strict failure boundaries.
    return lifecycle ? 0 : 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2).map(trimInput);
  if (args.length && !(args.length === 1 && args[0] === '--codespaces-hook')) {
    console.error('Usage: node .devcontainer/startup.mjs [--codespaces-hook]');
    process.exitCode = 1;
  } else process.exitCode = await runCodespaceStartup({ lifecycle: args.length === 1 });
}
