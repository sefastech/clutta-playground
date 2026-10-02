import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { createPool, paymentStatus, summary } from '../src/store.mjs';
import { services } from '../src/logger.mjs';
import { request, sendPayment, traffic } from './client.mjs';

async function waitFor(check, explanation, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error(`Timed out: ${explanation}`);
}

const pool = createPool();
const startedAt = new Date().toISOString();
const directory = process.env.LOG_DIRECTORY ?? '/lab/logs';
const receiptPath = path.join(process.env.RECEIPT_DIRECTORY ?? '/lab/receipts', `workload-verification-${randomUUID()}.json`);
const stages = [];
let passed = false;
const artifact = {};

try {
  artifact.sourceRevision = readFileSync('/app/source-revision', 'utf8').trim();
  assert.equal(artifact.sourceRevision, process.env.SOURCE_REVISION, 'Built source revision and requested run must agree');
  artifact.lockChecksum = createHash('sha256').update(readFileSync('/app/package-lock.json')).digest('hex');
  artifact.pg = JSON.parse(readFileSync('/app/node_modules/pg/package.json', 'utf8')).version;
  artifact.runtime = JSON.parse(process.env.WORKLOAD_IDENTITY ?? '{}');
  assert.ok(artifact.runtime.containers?.api?.image, 'Verification requires actual running container/image identity');
  artifact.postgres = (await pool.query('SHOW server_version')).rows[0].server_version;
  for (const service of ['api', 'worker', 'scheduler']) await request(service, '/ready');
  const initial = await summary(pool);
  assert.deepEqual(initial, { accepted: 0, processed: 0, pending: 0, delivered: 0 }, 'Verify requires a fresh run; never erase old data');
  await request('scheduler', '/control/resume', { method: 'POST' });

  console.log('Running 600 real fake-payment transactions at 10 per second; no filler records');
  const payments = await traffic(600, 10, async (sent) => {
    const state = await summary(pool);
    console.log(`${sent} submitted; ${state.processed} processed; ${state.delivered} delivered`);
  });
  await waitFor(async () => (await summary(pool)).delivered === 600, 'all healthy payments delivered');
  await waitFor(() => Object.keys(services).every((role) => {
    try { return readFileSync(path.join(directory, `${role}.log`), 'utf8').trim().split('\n').length === 600; }
    catch { return false; }
  }), 'post-commit records have reached every log file');
  const ids = new Set(payments.map((payment) => payment.payment_id));
  const counts = {};
  for (const [role, service] of Object.entries(services)) {
    const records = readFileSync(path.join(directory, `${role}.log`), 'utf8').trim().split('\n').map(JSON.parse);
    const businessRecords = records.filter((record) => ids.has(record.payment_id));
    assert.equal(businessRecords.length, 600, `${role}: one committed record per payment`);
    assert.equal(new Set(businessRecords.map((record) => record.payment_id)).size, 600, `${role}: no repeated filler`);
    for (const record of businessRecords) {
      assert.equal(record.service, service);
      assert.equal(record.level, 'info');
      assert.ok(Number.isFinite(Date.parse(record.time)));
      const state = await paymentStatus(pool, record.payment_id);
      const field = role === 'api' ? 'accepted_at' : role === 'worker' ? 'processed_at' : 'mailbox_delivered_at';
      assert.equal(record.time, state[field].toISOString(), `${role}: timestamp belongs to committed database operation`);
      assert.equal(record.amount_cents, state.amount_cents);
    }
    counts[`${role}.log`] = businessRecords.length;
  }
  stages.push({ stage: 'healthy', database: await summary(pool), distinctCommittedRecords: counts });

  const replay = payments[0];
  const replayResult = await request('api', '/payments', { method: 'POST', body: replay });
  assert.equal(replayResult.replay, true);
  await request('api', '/payments', {
    method: 'POST', body: { ...replay, amount_cents: replay.amount_cents + 1 }, expected: [409],
  });
  await request('api', '/payments', { method: 'POST', body: { amount_cents: -1, currency: 'USD' }, expected: [400] });
  assert.equal((await summary(pool)).accepted, 600, 'Replays and invalid input must not create extra payments');
  stages.push({ stage: 'replay-and-input-boundaries', passed: true });

  assert.deepEqual(await request('scheduler', '/control/pause', { method: 'POST' }), { paused: true });
  const stalled = await sendPayment(600);
  await waitFor(async () => Boolean((await paymentStatus(pool, stalled.payment_id)).queued_at), 'new payment reaches outbox while scheduler is paused');
  const pausedAt = Date.now();
  for (let sample = 0; sample < 10; sample++) {
    assert.equal((await request('scheduler', '/health')).status, 'ok');
    assert.equal((await request('scheduler', '/ready')).status, 'ready');
    const state = await paymentStatus(pool, stalled.payment_id);
    assert.equal(state.state, 'processed');
    assert.equal(state.mailbox_delivered_at, null);
    assert.equal(state.outbox_delivered_at, null);
    await sleep(200);
  }
  const pausedSummary = await summary(pool);
  assert.equal(pausedSummary.pending, 1);
  stages.push({ stage: 'silent-pause', payment_id: stalled.payment_id,
    health: 'ok', database: pausedSummary, observedMs: Date.now() - pausedAt,
    limitation: 'Workload observation only; no Clutta deadline or Case File assertion' });

  await request('scheduler', '/control/resume', { method: 'POST' });
  await waitFor(async () => Boolean((await paymentStatus(pool, stalled.payment_id)).mailbox_delivered_at), 'repair drains old pending work');
  const fresh = await sendPayment(601);
  await waitFor(async () => Boolean((await paymentStatus(pool, fresh.payment_id)).mailbox_delivered_at), 'fresh payment completes after repair');
  const final = await summary(pool);
  assert.deepEqual(final, { accepted: 602, processed: 602, pending: 0, delivered: 602 });
  const duplicates = await pool.query('SELECT payment_id FROM mailbox GROUP BY payment_id HAVING count(*) > 1');
  assert.equal(duplicates.rows.length, 0);
  stages.push({ stage: 'repair', recoveredPayment: stalled.payment_id, freshPayment: fresh.payment_id, database: final });
  passed = true;
  console.log('PASS: committed log records, healthy completion, idempotency, silent pause, health independence, and repair');
} catch (error) {
  stages.push({ stage: 'failure', message: error.message });
  console.error(error.message);
  process.exitCode = 1;
} finally {
  writeFileSync(receiptPath, `${JSON.stringify({
    status: passed ? 'PASS' : 'FAIL', startedAt, endedAt: new Date().toISOString(),
    sourceRevision: process.env.SOURCE_REVISION ?? 'unknown', node: process.version, artifact,
    component: 'playground-workload-only', cloudValidated: false, stages,
  }, null, 2)}\n`, { mode: 0o600 });
  console.log(`Receipt saved: ${receiptPath}`);
  await pool.end();
}
