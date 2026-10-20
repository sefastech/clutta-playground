import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

test('agent delivery walkthrough separates local success from connected acceptance', () => {
  const guide = read('scenarios/agent-delivery/README.md');
  assert.deepEqual([...guide.matchAll(/^## (\d)\. /gm)].map((match) => Number(match[1])), [1, 2, 3, 4, 5, 6]);
  for (const command of ['start', 'status', 'traffic 600 5', 'request', 'break', 'repair', 'stop']) {
    assert.ok(guide.includes(`./scenarios/agent-delivery/workload ${command}`));
  }
  for (const evidence of ['answer.persisted', 'delivery.attempted', 'delivery.accepted', 'answer_id']) {
    assert.ok(guide.includes(evidence));
  }
  assert.match(guide, /not a certified one-command demo/);
  assert.match(guide, /Stop here if/);
  assert.match(guide, /Automatic Case File resolution is not/);
  assert.match(guide, /HTTP 503\/504/);
  assert.doesNotMatch(guide, /\u2014|clutta-playground-private|claude-opus-5-5/);
  assert.match(read('README.md'), /Scenario 2, in rehearsal/);
});
