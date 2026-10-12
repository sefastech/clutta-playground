import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { requireLinuxWorkspace, WorkspaceRequiredError } from '../lib/workspace.mjs';

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('workspace checks accept Linux execution and redirect native host attempts safely', () => {
  assert.doesNotThrow(() => requireLinuxWorkspace('linux'));
  for (const platform of ['darwin', 'win32', 'freebsd']) {
    assert.throws(() => requireLinuxWorkspace(platform), (error) => {
      assert.ok(error instanceof WorkspaceRequiredError);
      assert.match(error.message, /Codespaces or Dev Container terminal/);
      assert.match(error.message, /macOS, Windows or Linux/);
      assert.doesNotMatch(error.message, /requires Linux|Linux only/);
      return true;
    });
  }
});

test('both helpers keep the workspace boundary and existing kernel-lock commands', () => {
  for (const file of ['lab', 'workload']) {
    const source = readFileSync(path.join(repository, file), 'utf8');
    assert.match(source, /import \{ requireLinuxWorkspace \} from '\.\/lib\/workspace\.mjs'/);
    assert.match(source, /requireLinuxWorkspace\(\)/);
    assert.match(source, /'flock', \['--nonblock', '--conflict-exit-code', '75'/);
    assert.doesNotMatch(source, /requires Linux/);
  }
});

test('Windows checkouts keep Unix entrypoints and container sources in LF format', () => {
  const files = ['lab', 'workload', '.devcontainer/startup.mjs', '.devcontainer/devcontainer.json',
    'lib/workspace.mjs', 'test/fixtures/docker', 'scenarios/scheduler/compose.yaml', 'README.md'];
  const attributes = execFileSync('git', ['check-attr', 'eol', '--', ...files], { cwd: repository, encoding: 'utf8' });
  assert.deepEqual(attributes.trim().split('\n'), files.map((file) => `${file}: eol: lf`));
});
