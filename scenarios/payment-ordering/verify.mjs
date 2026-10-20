import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { request, sendPayment } from '../scheduler/scripts/client.mjs';
import { assertOrderingTruth } from './truth.mjs';

const stages = [];
let passed = false;
async function completed(payment, fault) {
  const until = Date.now() + 30000;
  while (Date.now() < until) {
    const actual = await request('api', `/payments/${payment.payment_id}`);
    if (actual.processed_at && actual.mailbox_delivered_at) return assertOrderingTruth(actual, fault);
    await sleep(100);
  }
  throw new Error('Payment did not finish within the local verification window');
}
try {
  assert.equal(readFileSync('/app/source-revision', 'utf8').trim(), process.env.SOURCE_REVISION);
  for (const role of ['api', 'worker', 'scheduler']) await request(role, '/ready');
  await request('api', '/control/order-off', { method: 'POST' });
  for (const fault of [false, true, false]) {
    await request('api', `/control/${fault ? 'order-on' : 'order-off'}`, { method: 'POST' });
    const payment = await sendPayment(0);
    await request('api', '/control/order-off', { method: 'POST' });
    const truth = await completed(payment, fault);
    const replay = await request('api', '/payments', { method: 'POST', body: payment });
    assert.equal(replay.replay, true);
    await request('api', '/payments', { method: 'POST', body: { ...payment, amount_cents: payment.amount_cents + 1 }, expected: [409] });
    assert.deepEqual(await completed(payment, fault), truth);
    for (const [role, event, field] of [['api', 'payment.accepted', 'accepted_at'], ['worker', 'ledger.recorded', 'processed_at'], ['scheduler', 'merchant.notified', 'mailbox_delivered_at']]) {
      let records = [];
      for (let attempt = 0; attempt < 50; attempt++) {
        records = readFileSync(path.join(process.env.LOG_DIRECTORY, `${role}.log`), 'utf8').trim().split('\n').map(JSON.parse).filter(r => r.payment_id === payment.payment_id);
        if (records.length) break;
        await sleep(100);
      }
      assert.equal(records.length, 1, 'One post-commit record per service, including replay');
      assert.equal(records[0].event, event);
      assert.equal(records[0].time, truth[field]);
      assert.equal(records[0].ordering_fault, undefined, 'Clutta must not read the fault plan');
      assert.equal((await request(role, '/health')).status, 'ok');
    }
    stages.push({ phase: fault ? 'completed-out-of-order' : stages.length ? 'repaired' : 'healthy', payment, truth });
  }
  passed = true;
  console.log('PASS: healthy, completed out-of-order, repair, replay and committed evidence. Workload proof only; Clutta not tested here.');
} finally {
  try { await request('api', '/control/order-off', { method: 'POST' }); }
  finally {
    const receipt = path.join(process.env.RECEIPT_DIRECTORY, `ordering-verification-${randomUUID()}.json`);
    writeFileSync(receipt, JSON.stringify({ passed, cloudValidated: false, sourceRevision: process.env.SOURCE_REVISION, runtime: JSON.parse(process.env.WORKLOAD_IDENTITY ?? '{}'), stages }, null, 2), { mode: 0o600 });
    console.log(`Receipt saved: ${receipt}`);
  }
}
