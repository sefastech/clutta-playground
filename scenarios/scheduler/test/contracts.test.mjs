import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { validatePayment, createService } from '../src/server.mjs';
import { committedRecord } from '../src/logger.mjs';
import { transaction } from '../src/store.mjs';
import { ProcessingLoop } from '../src/loop.mjs';
import { sendPayment } from '../scripts/client.mjs';

test('payment input rejects invalid amounts, currencies and identifiers', () => {
  for (const amount of [-1, 0, 1.2, '500', 1000001, NaN]) {
    assert.throws(() => validatePayment({ amount_cents: amount, currency: 'USD' }));
  }
  assert.throws(() => validatePayment({ amount_cents: 500, currency: 'EUR' }));
  assert.throws(() => validatePayment({ payment_id: '../outside', amount_cents: 500, currency: 'USD' }));
  assert.throws(() => validatePayment(null));
  assert.throws(() => validatePayment([]));
  const payment = validatePayment({ amount_cents: 1000, currency: 'USD' });
  assert.match(payment.payment_id, /^[0-9a-f-]{36}$/);
});

test('business records are readable and require actual committed timestamps', () => {
  const payment = { payment_id: randomUUID(), amount_cents: 1299, currency: 'USD',
    accepted_at: new Date('2026-10-02T10:00:00Z') };
  const record = committedRecord('api', payment);
  assert.equal(record.message, 'Payment accepted');
  assert.equal(record.service, 'payment-api');
  assert.equal(record.payment_id, payment.payment_id);
  assert.equal(record.time, payment.accepted_at.toISOString());
  assert.throws(() => committedRecord('worker', payment));
  assert.throws(() => committedRecord('scheduler', payment));
  assert.throws(() => committedRecord('unknown', payment));
});

test('sample prices repeat realistically while each payment has its own identifier', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 201, json: async () => ({}) });
  try {
    const first = await sendPayment(0);
    const later = await sendPayment(6);
    assert.equal(first.amount_cents, later.amount_cents);
    assert.notEqual(first.payment_id, later.payment_id);
    assert.equal((await sendPayment(1)).amount_cents, 2499);
  } finally { globalThis.fetch = originalFetch; }
});

test('transaction commits on one client and always releases it', async () => {
  const calls = [];
  const client = { query: async (sql) => calls.push(sql), release: () => calls.push('release') };
  const pool = { connect: async () => client };
  const result = await transaction(pool, async (active) => {
    assert.equal(active, client);
    await active.query('business change');
    return 123;
  });
  assert.equal(result, 123);
  assert.deepEqual(calls, ['BEGIN', 'business change', 'COMMIT', 'release']);
});

test('operation and commit failures roll back without returning committed evidence', async () => {
  for (const failCommit of [false, true]) {
    const calls = [];
    const client = { query: async (sql) => {
      calls.push(sql);
      if (failCommit && sql === 'COMMIT') throw new Error('commit unavailable');
    }, release: () => calls.push('release') };
    await assert.rejects(transaction({ connect: async () => client }, async () => {
      if (!failCommit) throw new Error('operation unavailable');
      return 'not committed';
    }));
    assert.ok(calls.includes('ROLLBACK'));
    assert.equal(calls.at(-1), 'release');
  }
});

test('pause waits for an in-flight transaction and stops future work until resume', async () => {
  let calls = 0;
  let release;
  let begun;
  const started = new Promise((resolve) => { begun = resolve; });
  const pending = new Promise((resolve) => { release = resolve; });
  const loop = new ProcessingLoop(async () => {
    calls++;
    if (calls === 1) { begun(); await pending; }
    return false;
  }, { intervalMs: 5 });
  loop.resume();
  await started;
  let paused = false;
  const pausing = loop.pause().then(() => { paused = true; });
  await sleep(10);
  assert.equal(paused, false);
  release();
  await pausing;
  await sleep(20);
  assert.equal(calls, 1);
  loop.resume();
  await sleep(20);
  await loop.stop();
  assert.ok(calls > 1);
  assert.throws(() => loop.resume(), /closed/);
});

test('processing errors do not kill the loop or cause overlapping jobs', async () => {
  let active = 0;
  let maximum = 0;
  let errors = 0;
  const loop = new ProcessingLoop(async () => {
    active++;
    maximum = Math.max(maximum, active);
    await sleep(3);
    active--;
    throw new Error('actual operation failed');
  }, { intervalMs: 3, onError: () => { errors++; } });
  loop.resume();
  loop.resume();
  await sleep(40);
  await loop.stop();
  assert.equal(maximum, 1);
  assert.ok(errors > 0);
});

test('synchronous tick failures cannot strand the loop with a resolved in-flight promise', async () => {
  let errors = 0;
  const loop = new ProcessingLoop(() => { throw new Error('sync operation unavailable'); },
    { intervalMs: 2, onError: () => { errors++; } });
  loop.resume();
  await sleep(30);
  await loop.stop();
  assert.ok(errors > 1);
});

test('HTTP health remains independent of paused processing and database readiness', async () => {
  let unavailable = false;
  const pool = {
    query: async () => { if (unavailable) throw new Error('not exposed'); return { rows: [] }; },
    connect: async () => { throw new Error('test has no work'); },
  };
  const service = createService({ role: 'scheduler', pool, record: () => assert.fail('No payment committed') });
  await service.start(0, '127.0.0.1');
  const base = `http://127.0.0.1:${service.server.address().port}`;
  try {
    const paused = await fetch(`${base}/control/pause`, { method: 'POST' });
    assert.deepEqual(await paused.json(), { paused: true });
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/ready`)).status, 200);
    unavailable = true;
    assert.equal((await fetch(`${base}/health`)).status, 200);
    const readiness = await fetch(`${base}/ready`);
    assert.equal(readiness.status, 503);
    assert.deepEqual(await readiness.json(), { error: 'Service operation unavailable' });
    assert.equal((await fetch(`${base}/absent`)).status, 404);
  } finally { await service.stop(); }
});
