import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sourceRevision } from '../lib/source.mjs';

const content = '{"features":{"docker":{"integrity":"sha256:original"}}}';
function fixture(newline = '\n') {
  const root = process.env.CLUTTA_PLAYGROUND_DATA_ROOT ?? path.join(tmpdir(), 'sanitized-cases');
  mkdirSync(root, { recursive: true });
  const repository = mkdtempSync(path.join(root, 'source-proof-'));
  const git = (...args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'Source fixture');
  git('config', 'core.filemode', 'true');
  git('config', 'core.autocrlf', 'false');
  mkdirSync(path.join(repository, '.devcontainer'));
  const lock = path.join(repository, '.devcontainer/devcontainer-lock.json');
  writeFileSync(lock, content + newline);
  writeFileSync(path.join(repository, 'app.js'), '// committed workload\n');
  git('add', '.');
  git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Fixture');
  return { repository, git, lock, revision: git('rev-parse', 'HEAD') };
}

test('clean source returns the committed revision', async () => {
  const f = fixture();
  assert.equal(await sourceRevision(f.repository), f.revision);
});

test('Codespaces final newline difference is accepted without rewriting the lock', async () => {
  for (const original of ['', '\n']) {
    const f = fixture(original);
    const changed = content + (original ? '' : '\n');
    writeFileSync(f.lock, changed);
    assert.equal(await sourceRevision(f.repository), f.revision);
    assert.equal(readFileSync(f.lock, 'utf8'), changed);
  }
});

for (const [name, change] of [
  ['changed digest', (f) => writeFileSync(f.lock, content.replace('original', 'different'))],
  ['invalid lock', (f) => writeFileSync(f.lock, '{')],
  ['extra whitespace', (f) => writeFileSync(f.lock, content + '\n\n')],
  ['staged newline change', (f) => { writeFileSync(f.lock, content); f.git('add', '.'); }],
  ['staged dependency change with restored working copy', (f) => { writeFileSync(f.lock, '{}'); f.git('add', '.'); writeFileSync(f.lock, content); }],
  ['changed source alongside newline', (f) => { writeFileSync(f.lock, content); writeFileSync(path.join(f.repository, 'app.js'), '// changed\n'); }],
  ['untracked file alongside newline', (f) => { writeFileSync(f.lock, content); writeFileSync(path.join(f.repository, 'extra.txt'), 'new'); }],
  ['changed mode alongside newline', (f) => { writeFileSync(f.lock, content); chmodSync(f.lock, 0o755); }],
  ['symlink', (f) => { unlinkSync(f.lock); symlinkSync('../app.js', f.lock); }],
  ['deleted lock', (f) => unlinkSync(f.lock)],
]) {
  test(`source verification still rejects ${name}`, async () => {
    const f = fixture();
    change(f);
    await assert.rejects(sourceRevision(f.repository), /clean committed checkout/);
  });
}
