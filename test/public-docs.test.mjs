import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { requiredScopes } from '../lib/cloud.mjs';

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (file) => readFileSync(path.join(repository, file), 'utf8');
const docs = ['README.md', 'docs/onboarding.md', 'docs/troubleshooting.md', 'scenarios/scheduler/README.md', 'AGENTS.md'];
const anchor = (heading) => heading.toLowerCase().replace(/[^\p{L}\p{N}_\-\s]/gu, '').replace(/\s/g, '-');

test('the public walkthrough separates progressive success checks from permission troubleshooting', () => {
  const guide = read('docs/onboarding.md');
  const trouble = read('docs/troubleshooting.md');
  const stages = [...guide.matchAll(/^## (\d)\. /gm)].map((match) => Number(match[1]));
  assert.deepEqual(stages, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal((guide.match(/\*\*Continue when:\*\*/g) ?? []).length, 7);
  assert.doesNotMatch(guide, /read:scan\.|write:scan\.|feat\/cloud-scheduler-lab/);
  for (const scope of requiredScopes) assert.ok(trouble.includes(scope), `Missing documented permission: ${scope}`);
  assert.match(guide, /Approve and activate the correct flow yourself/);
  assert.match(guide, /historical missed deadline is not automatically declared resolved/);
  assert.match(guide, /## When you run into issues\n/);
});

test('customer documentation has working local links and no private repository destinations', () => {
  for (const file of docs) {
    const source = read(file);
    assert.doesNotMatch(source, /\u2014|github\.com\/[^\s)]+-private|docs\/maintainer\//);
    for (const match of source.matchAll(/\]\(([^)]+)\)|(?:src|srcset)="([^"]+)"/g)) {
      const target = match[1] ?? match[2];
      if (!target || target.startsWith('https://')) continue;
      const [filename, fragment] = target.split('#');
      const linked = path.resolve(repository, path.dirname(file), filename || path.basename(file));
      assert.ok(existsSync(linked), `Missing ${target} in ${file}`);
      if (fragment) {
        const headings = [...readFileSync(linked, 'utf8').matchAll(/^#{1,6} (.+)$/gm)].map((match) => anchor(match[1]));
        assert.ok(headings.includes(fragment), `Missing anchor ${target} in ${file}`);
      }
    }
  }
  for (const file of ['docs/maintainer/source-and-reuse.md', 'docs/rehearsal-checklist.md', 'docs/video-script.md']) {
    assert.equal(existsSync(path.join(repository, file)), false);
  }
});

test('the public package identity and MIT notice agree while branded assets stay excluded', () => {
  const manifest = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(manifest.name, 'clutta-playground');
  assert.equal(lock.name, manifest.name);
  assert.equal(lock.packages[''].name, manifest.name);
  assert.equal(manifest.license, 'MIT');
  assert.equal(lock.packages[''].license, manifest.license);
  assert.match(read('LICENSE'), /^MIT License\n/);
  assert.match(read('README.md'), /assets\/.*excluded from that license/);
  const light = read('assets/clutta-logo-light.svg');
  const dark = read('assets/clutta-logo-dark.svg');
  assert.match(light, /Excluded from the playground MIT license/);
  assert.equal(light.replace('color="#001A6E"', 'color="#ffffff"'), dark);
  for (const logo of [light, dark]) assert.doesNotMatch(logo, /<script|<foreignObject|onload=|href=/i);
});

test('the catalogue admits future scenarios without promising unvalidated runtime support', () => {
  const readme = read('README.md');
  assert.match(readme, /scenarios\/<name>\//);
  assert.match(readme, /commands currently guide this scenario only/);
  assert.match(readme, /Fresh-account onboarding and rebuild\/resume preservation remain open/);
  assert.match(read('AGENTS.md'), /independently checked Clutta path before it is listed as runnable/);
});
