import test from 'node:test';
import assert from 'node:assert/strict';
import { scenarioName, scenarioRoot, businessEvents } from '../lib/scenario.mjs';
import { assertOrderingTruth } from '../scenarios/payment-ordering/truth.mjs';

test('ordering state is isolated without changing the scheduler default', () => {
  assert.equal(scenarioName(), 'scheduler');
  assert.throws(() => scenarioName('other'));
  assert.equal(scenarioRoot('/tmp/lab', 'scheduler'), '/tmp/lab');
  assert.equal(scenarioRoot('/tmp/lab', 'payment-ordering'), '/tmp/lab/payment-ordering');
  assert.deepEqual(businessEvents('payment-ordering'), ['payment.accepted', 'ledger.recorded', 'merchant.notified']);
});
test('truth requires a completed balanced ledger and actual temporal relation', () => {
  const row = { state: 'processed', ledger_entries: 2, ledger_balance: 0, processed_at: '2026-10-19T10:00:00Z', mailbox_delivered_at: '2026-10-19T10:00:01Z', ordering_fault: false };
  assert.equal(assertOrderingTruth(row, false), row);
  assert.throws(() => assertOrderingTruth(row, true));
  const fault = { ...row, ordering_fault: true, mailbox_delivered_at: '2026-10-19T09:59:59Z' };
  assert.equal(assertOrderingTruth(fault, true), fault);
  for (const patch of [{ ledger_entries: 0 }, { ledger_balance: 1 }, { state: 'accepted' }, { processed_at: null }, { mailbox_delivered_at: row.processed_at }]) assert.throws(() => assertOrderingTruth({ ...fault, ...patch }, true));
});
