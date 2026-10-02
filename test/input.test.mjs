import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { uuid } from '../lib/cloud.mjs';
import { appendHiddenCharacter, checkScriptInputs, trimInput } from '../scenarios/scheduler/src/input.mjs';

const execute = promisify(execFile);
const client = fileURLToPath(new URL('../scenarios/scheduler/scripts/client.mjs', import.meta.url));
const identifier = '11111111-1111-4111-8111-111111111111';
// In-memory local request fixture. No Clutta call, credential, or incident result is fabricated.
const fakeNetwork = `data:text/javascript,${encodeURIComponent(`globalThis.fetch = async (url) => {
  console.log('OFFLINE_REQUEST ' + url);
  return { status: 200, json: async () => ({ pending: 0 }) };
};`)}`;

test('one normalizer removes only edge whitespace from human inputs, preserving internal text and types', () => {
  for (const value of ['start', identifier, 'offline-fixture-key', '/owned/path with spaces', '600', '10']) {
    assert.equal(trimInput(` \t\r\n\u00a0${value}\u00a0\n\t `), value);
  }
  assert.equal(uuid(trimInput(` \t${identifier}\n`)), identifier);
  assert.equal(trimInput('first second'), 'first second');
  assert.equal(trimInput('first\tsecond'), 'first\tsecond');
  assert.equal(trimInput(undefined), undefined);
  assert.equal(trimInput(null), null);
  assert.equal(trimInput(5), 5);
  assert.throws(() => uuid(trimInput('11111111-1111-4111-8111-1111 11111111')));
});

test('explicitly empty inputs fail instead of becoming default commands, summary lookups, or data paths', () => {
  for (const value of ['', ' ', '\t\n', '\u00a0']) {
    assert.throws(() => checkScriptInputs([trimInput(value)]), /Command inputs cannot be empty/);
    assert.throws(() => checkScriptInputs([], trimInput(value)), /DATA_ROOT cannot be empty/);
  }
  assert.doesNotThrow(() => checkScriptInputs([undefined]));
});

test('hidden key typing preserves whitespace for edge trimming and validation rather than joining broken tokens', () => {
  let padded = '';
  for (const character of '\t \u00a0offline-fixture-key\u00a0 \t') padded = appendHiddenCharacter(padded, character);
  assert.equal(trimInput(padded), 'offline-fixture-key');
  let broken = '';
  for (const character of 'first\tsecond') broken = appendHiddenCharacter(broken, character);
  assert.equal(trimInput(broken), 'first\tsecond');
  assert.equal(appendHiddenCharacter('abc', '\b'), 'ab');
  assert.equal(appendHiddenCharacter('abc', '\u007f'), 'ab');
  assert.equal(appendHiddenCharacter('abc', '\u001b'), 'abc');
});

test('actual workload client normalizes padded commands and identifiers before requesting status', async () => {
  const { stdout } = await execute(process.execPath, ['--import', fakeNetwork, client, ' \tstatus\n', ` \t${identifier}\r\n`], { timeout: 10000 });
  assert.match(stdout, new RegExp(`OFFLINE_REQUEST http://api:8080/payments/${identifier}`));
  assert.equal(stdout.split('OFFLINE_REQUEST').length - 1, 1);
});

test('actual workload client normalizes numeric options but does not repair internally malformed numbers', async () => {
  const { stdout } = await execute(process.execPath, ['--import', fakeNetwork, client, ' traffic ', ' 1 ', '\t100\n'], { timeout: 10000 });
  assert.match(stdout, /"submitted": 1/);
  assert.equal(stdout.split('OFFLINE_REQUEST').length - 1, 2);
  await assert.rejects(execute(process.execPath, ['--import', fakeNetwork, client, 'traffic', '6 00', '10'], { timeout: 10000 }), (error) => {
    assert.match(error.stderr, /Count must be between/);
    assert.doesNotMatch(error.stdout, /OFFLINE_REQUEST/);
    return true;
  });
});

test('actual workload client rejects blank commands and identifiers before any network call', async () => {
  for (const args of [[' \t'], ['status', ' \t\r\n']]) {
    await assert.rejects(execute(process.execPath, ['--import', fakeNetwork, client, ...args], { timeout: 10000 }), (error) => {
      assert.match(error.stderr, /cannot be empty or whitespace only/);
      assert.doesNotMatch(error.stdout, /OFFLINE_REQUEST/);
      return true;
    });
  }
});
