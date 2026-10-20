import { transaction, PaymentConflict, deliverNextNotification, summary } from '../../scheduler/src/store.mjs';
import { committedRecord as schedulerRecord } from '../../scheduler/src/logger.mjs';
export { deliverNextNotification, summary };

export function committedRecord(role, payment) {
  const record = schedulerRecord(role, payment);
  if (role === 'worker') { record.event = 'ledger.recorded'; record.message = 'Balanced ledger entry committed'; }
  if (role === 'scheduler') { record.event = 'merchant.notified'; record.message = 'Merchant notified in test mailbox'; }
  return record;
}

export async function setFault(pool, enabled) {
  await pool.query('UPDATE lab_control SET notify_first = $1 WHERE id = 1', [enabled]);
  return { notify_first: enabled };
}

export async function acceptPayment(pool, payment) {
  return transaction(pool, async (client) => {
    const inserted = await client.query(`INSERT INTO payments (payment_id, amount_cents, currency, ordering_fault)
      SELECT $1, $2, $3, notify_first FROM lab_control WHERE id = 1
      ON CONFLICT (payment_id) DO NOTHING RETURNING *`, [payment.payment_id, payment.amount_cents, payment.currency]);
    if (inserted.rows.length) {
      const row = inserted.rows[0];
      // This is the intentional business bug: enqueue before the ledger commit.
      if (row.ordering_fault) await client.query('INSERT INTO outbox (payment_id, queued_at) VALUES ($1, $2)', [row.payment_id, row.accepted_at]);
      return { payment: row, created: true };
    }
    const result = await client.query('SELECT * FROM payments WHERE payment_id = $1', [payment.payment_id]);
    const row = result.rows[0];
    if (!row || row.amount_cents !== payment.amount_cents || row.currency !== payment.currency) throw new PaymentConflict('Payment identifier already belongs to a different payment');
    return { payment: row, created: false };
  });
}

export async function processNextPayment(pool) {
  return transaction(pool, async (client) => {
    const result = await client.query(`SELECT p.* FROM payments p LEFT JOIN mailbox m USING (payment_id)
      WHERE p.state = 'accepted' AND (NOT p.ordering_fault OR m.delivered_at < clock_timestamp() - interval '250 milliseconds')
      ORDER BY p.accepted_at, p.payment_id LIMIT 1 FOR UPDATE OF p SKIP LOCKED`);
    if (!result.rows.length) return null;
    const row = result.rows[0];
    await client.query(`INSERT INTO ledger_entries (payment_id, account, cents) VALUES ($1, 'clearing', -$2::integer), ($1, 'merchant', $2::integer)`, [row.payment_id, row.amount_cents]);
    const updated = await client.query(`UPDATE payments SET state = 'processed', processed_at = clock_timestamp() WHERE payment_id = $1 RETURNING *`, [row.payment_id]);
    const payment = updated.rows[0];
    if (!payment.ordering_fault) await client.query('INSERT INTO outbox (payment_id, queued_at) VALUES ($1, $2)', [payment.payment_id, payment.processed_at]);
    return payment;
  });
}

export async function paymentStatus(pool, id) {
  const result = await pool.query(`SELECT p.*, m.delivered_at AS mailbox_delivered_at,
    (SELECT count(*)::int FROM ledger_entries l WHERE l.payment_id=p.payment_id) AS ledger_entries,
    (SELECT sum(cents)::int FROM ledger_entries l WHERE l.payment_id=p.payment_id) AS ledger_balance
    FROM payments p LEFT JOIN mailbox m USING (payment_id) WHERE p.payment_id=$1`, [id]);
  return result.rows[0] ?? null;
}
