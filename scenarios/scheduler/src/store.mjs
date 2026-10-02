import pg from 'pg';

export function createPool() {
  const pool = new pg.Pool({
    host: process.env.PGHOST ?? 'postgres',
    port: Number(process.env.PGPORT ?? 5432),
    database: 'playground', user: 'playground',
    max: 4, connectionTimeoutMillis: 3000, statement_timeout: 5000,
  });
  // An idle-client failure must not expose connection configuration or credentials.
  pool.on('error', () => process.stderr.write('Database connection unavailable\n'));
  return pool;
}

export async function transaction(pool, operation) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* Preserve the original failure. */ }
    throw error;
  } finally {
    client.release();
  }
}

export class PaymentConflict extends Error {}

export async function acceptPayment(pool, payment) {
  return transaction(pool, async (client) => {
    const inserted = await client.query(`
      INSERT INTO payments (payment_id, amount_cents, currency) VALUES ($1, $2, $3)
      ON CONFLICT (payment_id) DO NOTHING RETURNING *`,
    [payment.payment_id, payment.amount_cents, payment.currency]);
    if (inserted.rows.length) return { payment: inserted.rows[0], created: true };
    const existing = await client.query('SELECT * FROM payments WHERE payment_id = $1', [payment.payment_id]);
    const row = existing.rows[0];
    if (!row || row.amount_cents !== payment.amount_cents || row.currency !== payment.currency) {
      throw new PaymentConflict('Payment identifier already belongs to a different payment');
    }
    return { payment: row, created: false };
  });
}

export async function processNextPayment(pool) {
  return transaction(pool, async (client) => {
    const pending = await client.query(`
      SELECT * FROM payments WHERE state = 'accepted'
      ORDER BY accepted_at, payment_id LIMIT 1 FOR UPDATE SKIP LOCKED`);
    if (!pending.rows.length) return null;
    const processed = await client.query(`
      UPDATE payments SET state = 'processed', processed_at = clock_timestamp()
      WHERE payment_id = $1 RETURNING *`, [pending.rows[0].payment_id]);
    const payment = processed.rows[0];
    await client.query('INSERT INTO outbox (payment_id, queued_at) VALUES ($1, $2)',
      [payment.payment_id, payment.processed_at]);
    return payment;
  });
}

export async function deliverNextNotification(pool) {
  return transaction(pool, async (client) => {
    const pending = await client.query(`
      SELECT o.payment_id, p.amount_cents, p.currency FROM outbox o
      JOIN payments p USING (payment_id) WHERE o.delivered_at IS NULL
      ORDER BY o.queued_at, o.payment_id LIMIT 1 FOR UPDATE OF o SKIP LOCKED`);
    if (!pending.rows.length) return null;
    const payment = pending.rows[0];
    const delivered = await client.query(`
      INSERT INTO mailbox (payment_id, delivered_at)
      VALUES ($1, clock_timestamp()) RETURNING delivered_at`, [payment.payment_id]);
    const deliveredAt = delivered.rows[0].delivered_at;
    await client.query('UPDATE outbox SET delivered_at = $2 WHERE payment_id = $1',
      [payment.payment_id, deliveredAt]);
    return { ...payment, delivered_at: deliveredAt };
  });
}

export async function paymentStatus(pool, paymentId) {
  const result = await pool.query(`
    SELECT p.*, o.queued_at, o.delivered_at AS outbox_delivered_at,
           m.delivered_at AS mailbox_delivered_at
    FROM payments p LEFT JOIN outbox o USING (payment_id)
    LEFT JOIN mailbox m USING (payment_id) WHERE p.payment_id = $1`, [paymentId]);
  return result.rows[0] ?? null;
}

export async function summary(pool) {
  const result = await pool.query(`SELECT
    (SELECT count(*)::int FROM payments) AS accepted,
    (SELECT count(*)::int FROM payments WHERE state = 'processed') AS processed,
    (SELECT count(*)::int FROM outbox WHERE delivered_at IS NULL) AS pending,
    (SELECT count(*)::int FROM mailbox) AS delivered`);
  return result.rows[0];
}
