import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';

export function createPool() {
  // Standard PG variables keep credentials out of process arguments and logs.
  if (process.env.PGDATABASE !== 'clutta_agent_delivery_lab') throw new Error('Use a dedicated PGDATABASE=clutta_agent_delivery_lab.');
  return new pg.Pool({ max: 5 });
}

export class Store {
  constructor(pool) { this.pool = pool; }
  async initialize() { await this.pool.query(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')); }
  async request({ destination, orderId = '1042', deliveryMode = 'sandbox', requestId = randomUUID() }) {
    if (!['sandbox', 'telegram'].includes(deliveryMode)) throw new Error('Unknown delivery mode.');
    if (typeof destination !== 'string' || !/^-?[0-9]{1,20}$/.test(destination)) throw new Error('Destination must be a numeric lab chat ID.');
    if (!/^[0-9]{1,20}$/.test(orderId)) throw new Error('Invalid synthetic order ID.');
    await this.pool.query('INSERT INTO lab_requests(request_id,destination,order_id,delivery_mode) VALUES ($1,$2,$3,$4)',
      [requestId, destination, orderId, deliveryMode]);
    return this.getRequest(requestId);
  }
  async getRequest(id) { return (await this.pool.query('SELECT * FROM lab_requests WHERE request_id=$1', [id])).rows[0]; }
  async lookupOrder(id) { return (await this.pool.query('SELECT * FROM lab_orders WHERE order_id=$1', [id])).rows[0]; }
  async answerFor(requestId) { return (await this.pool.query('SELECT * FROM lab_answers WHERE request_id=$1', [requestId])).rows[0]; }
  async persistAnswer(requestId, text, modelMode) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // A stable request identity prevents a graph retry from creating another answer/job.
      await client.query('INSERT INTO lab_answers(answer_id,request_id,text,model_mode) VALUES ($1,$2,$3,$4) ON CONFLICT (request_id) DO NOTHING',
        [randomUUID(), requestId, text, modelMode]);
      const answer = (await client.query('SELECT * FROM lab_answers WHERE request_id=$1', [requestId])).rows[0];
      await client.query('INSERT INTO lab_deliveries(answer_id) VALUES ($1) ON CONFLICT DO NOTHING', [answer.answer_id]);
      await client.query('COMMIT');
      return answer;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async delivery(answerId) {
    return (await this.pool.query(`SELECT d.*, a.request_id, a.text, a.model_mode, a.created_at AS answered_at, r.destination, r.delivery_mode, r.order_id
      FROM lab_deliveries d JOIN lab_answers a ON a.answer_id=d.answer_id
      JOIN lab_requests r ON r.request_id=a.request_id WHERE d.answer_id=$1`, [answerId])).rows[0];
  }
  // Due times are compared on the database clock unless a test supplies one.
  // Mixing a millisecond application clock with microsecond database times
  // can make a just-repaired job look not yet due.
  async claim(answerId, now) {
    const result = now
      ? await this.pool.query(`UPDATE lab_deliveries SET state='sending', attempts=attempts+1
        WHERE answer_id=$1 AND state='pending' AND next_attempt_at <= $2 RETURNING answer_id`, [answerId, now])
      : await this.pool.query(`UPDATE lab_deliveries SET state='sending', attempts=attempts+1
        WHERE answer_id=$1 AND state='pending' AND next_attempt_at <= clock_timestamp() RETURNING answer_id`, [answerId]);
    return result.rows.length ? this.delivery(answerId) : null;
  }
  // The worker claims the oldest due job. SKIP LOCKED lets several workers share the queue.
  async claimNext() {
    const result = await this.pool.query(`UPDATE lab_deliveries SET state='sending', attempts=attempts+1
      WHERE answer_id = (SELECT answer_id FROM lab_deliveries WHERE state='pending' AND next_attempt_at <= clock_timestamp()
        ORDER BY next_attempt_at, answer_id LIMIT 1 FOR UPDATE SKIP LOCKED)
      AND state='pending' RETURNING answer_id`);
    return result.rows.length ? this.delivery(result.rows[0].answer_id) : null;
  }
  async finish(answerId, { state, retryAfterSeconds = 0, now, messageId = null, result }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // The retry time is computed on the database clock unless a test supplies one.
      const base = now ? '$5::timestamptz' : 'clock_timestamp()';
      const updated = await client.query(`UPDATE lab_deliveries SET state=$2::text, next_attempt_at=${base} + ($3::text || ' seconds')::interval,
          message_id=$4, accepted_at=CASE WHEN $2::text='accepted' THEN clock_timestamp() ELSE NULL END
        WHERE answer_id=$1 AND state='sending' RETURNING accepted_at`,
      [answerId, state, String(retryAfterSeconds), messageId, ...(now ? [now] : [])]);
      // A job that is no longer ours must not gain an attempt or an acceptance record.
      if (updated.rowCount !== 1) throw new Error('Delivery claim was lost before it finished.');
      await client.query('INSERT INTO lab_delivery_attempts(attempt_id,answer_id,result) VALUES ($1,$2,$3)', [randomUUID(), answerId, result]);
      await client.query('COMMIT');
      return updated.rows[0];
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async repair(answerId) {
    // Only deliberately stranded jobs are safe to repair automatically.
    const result = await this.pool.query(`UPDATE lab_deliveries SET state='pending',next_attempt_at=clock_timestamp()
      WHERE answer_id=$1 AND state='stalled' RETURNING answer_id`, [answerId]);
    if (!result.rows.length) throw new Error('Repair requires a deliberately stalled job. Sending/uncertain jobs need reconciliation.');
  }
  async repairStalled() {
    const result = await this.pool.query(`UPDATE lab_deliveries SET state='pending',next_attempt_at=clock_timestamp()
      WHERE state='stalled' RETURNING answer_id`);
    return result.rows.map((row) => row.answer_id);
  }
  async summary() {
    const rows = (await this.pool.query('SELECT state, count(*)::int AS n FROM lab_deliveries GROUP BY state')).rows;
    const answers = (await this.pool.query('SELECT count(*)::int AS n FROM lab_answers')).rows[0].n;
    return { answers, deliveries: Object.fromEntries(rows.map((row) => [row.state, row.n])) };
  }
}
