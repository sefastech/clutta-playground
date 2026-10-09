import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

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
    return (await this.pool.query(`SELECT d.*, a.request_id, a.text, a.model_mode, r.destination, r.delivery_mode
      FROM lab_deliveries d JOIN lab_answers a ON a.answer_id=d.answer_id
      JOIN lab_requests r ON r.request_id=a.request_id WHERE d.answer_id=$1`, [answerId])).rows[0];
  }
  async claim(answerId, now) {
    const result = await this.pool.query(`UPDATE lab_deliveries SET state='sending', attempts=attempts+1
      WHERE answer_id=$1 AND state='pending' AND next_attempt_at <= $2 RETURNING answer_id`, [answerId, now]);
    return result.rows.length ? this.delivery(answerId) : null;
  }
  async finish(answerId, { state, retryAt = new Date(), messageId = null, acceptedAt = null, result }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE lab_deliveries SET state=$2,next_attempt_at=$3,message_id=$4,accepted_at=$5
        WHERE answer_id=$1 AND state='sending'`, [answerId, state, retryAt, messageId, acceptedAt]);
      await client.query('INSERT INTO lab_delivery_attempts(attempt_id,answer_id,result) VALUES ($1,$2,$3)', [randomUUID(), answerId, result]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async repair(answerId) {
    // Only deliberately stranded jobs are safe to repair automatically.
    const result = await this.pool.query(`UPDATE lab_deliveries SET state='pending',next_attempt_at=clock_timestamp()
      WHERE answer_id=$1 AND state='stalled' RETURNING answer_id`, [answerId]);
    if (!result.rows.length) throw new Error('Repair requires a deliberately stalled job. Sending/uncertain jobs need reconciliation.');
  }
}
