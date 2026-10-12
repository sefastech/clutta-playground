import { execFile } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const lockPath = '.devcontainer/devcontainer-lock.json';
const dirtyMessage = 'Run a clean committed checkout so image and receipt identify the actual source. Preserve changes on a branch; do not reset them.';

export async function sourceRevision(repository) {
  const git = async (...args) => (await execute('git', args, { cwd: repository })).stdout;
  const changes = await git('status', '--porcelain=v1', '-z', '--untracked-files=all');
  if (changes) {
    // Codespaces may omit the lock's final LF. Accept only that exact change,
    // with an untouched index and a regular file; never rewrite user files.
    if (changes !== ` M ${lockPath}\0`) throw new Error(dirtyMessage);
    const file = path.join(repository, lockPath);
    if (!(await lstat(file)).isFile()) throw new Error(dirtyMessage);
    const committed = await git('show', `HEAD:${lockPath}`);
    const current = await readFile(file, 'utf8');
    const withoutFinalLF = (value) => value.endsWith('\n') ? value.slice(0, -1) : value;
    if (current === committed || withoutFinalLF(current) !== withoutFinalLF(committed)) throw new Error(dirtyMessage);
    // A mode change must not be hidden by the permitted newline difference.
    if ((await git('diff', '--summary', '--', lockPath)).trim()) throw new Error(dirtyMessage);
  }
  const revision = (await git('rev-parse', 'HEAD')).trim();
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Could not identify checked-out source revision');
  return revision;
}
