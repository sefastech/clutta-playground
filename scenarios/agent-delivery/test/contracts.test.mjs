import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newDb } from 'pg-mem';
import pg from 'pg';
import { AIMessage } from '@langchain/core/messages';
import { Store } from '../src/store.mjs';
import { runAgent, fixtureModel } from '../src/agent.mjs';
import { deliverOne, sandboxTransport, telegramTransport } from '../src/delivery.mjs';
import { evidenceWriter } from '../src/evidence.mjs';

async function setup(t) {
  let pool;
  if (process.env.AGENT_TEST_REAL_PG === '1') {
    assert.equal(process.env.PGDATABASE, 'clutta_agent_delivery_lab');
    pool = new pg.Pool();
  } else {
    const db = newDb();
    db.public.registerFunction({ name: 'clock_timestamp', returns: 'timestamptz', implementation: () => new Date(), impure: true });
    const adapter = db.adapters.createPg();
    pool = new adapter.Pool();
  }
  t.after(() => pool.end());
  const store = new Store(pool);
  await store.initialize();
  const records = [];
  const emit = (component, event, row, extra) => records.push({ component, event, answer_id: row.answer_id, ...extra });
  const request = await store.request({ destination: '1042' });
  const answer = await runAgent({ store, requestId: request.request_id, model: fixtureModel('1042'), modelMode: 'fixture', emit });
  return { store, pool, request, answer, records, emit };
}

test('real LangGraph tool path commits an answer plus pending delivery; replay does not rerun model', async (t) => {
  const { store, request, answer, records } = await setup(t);
  assert.match(answer.text, /shipped/);
  assert.equal((await store.delivery(answer.answer_id)).state, 'pending');
  assert.deepEqual(records.map((record) => record.event), ['answer.persisted']);
  const again = await runAgent({ store, requestId: request.request_id, model: { bindTools() { throw new Error('replay must not call model'); } }, modelMode: 'fixture' });
  assert.equal(again.answer_id, answer.answer_id);
});

test('healthy acceptance is recorded once; duplicate worker invocation does not send again', async (t) => {
  const { store, answer, records, emit } = await setup(t);
  let sends = 0;
  const transport = { mode: 'sandbox', async send() { sends++; return { kind: 'accepted', messageId: 'sandbox-1' }; } };
  assert.equal((await deliverOne({ store, answerId: answer.answer_id, transport, emit })).state, 'accepted');
  assert.equal((await deliverOne({ store, answerId: answer.answer_id, transport, emit })).attempted, false);
  assert.equal(sends, 1);
  assert.equal(records.filter((record) => record.event === 'delivery.accepted').length, 1);
});

test('injected stall leaves stored answer pending delivery; repair sends without regenerating', async (t) => {
  const { store, answer, records, emit } = await setup(t);
  let sends = 0;
  const transport = { mode: 'sandbox', async send() { sends++; return { kind: 'accepted', messageId: 'sandbox-recovery' }; } };
  assert.equal((await deliverOne({ store, answerId: answer.answer_id, transport, fault: 'retry-stall', emit })).state, 'stalled');
  assert.equal(sends, 0);
  assert.equal(records.some((record) => record.event === 'delivery.accepted'), false);
  assert.equal((await store.answerFor(answer.request_id)).answer_id, answer.answer_id);
  await store.repair(answer.answer_id);
  assert.equal((await deliverOne({ store, answerId: answer.answer_id, transport, emit })).state, 'accepted');
  assert.equal(sends, 1);
});

test('temporary rate limit obeys retry window then succeeds', async (t) => {
  const { store, answer } = await setup(t);
  const now = new Date(Date.now() + 100);
  const transport = sandboxTransport();
  assert.equal((await deliverOne({ store, answerId: answer.answer_id, transport, fault: 'rate-limit', now })).state, 'pending');
  assert.equal((await deliverOne({ store, answerId: answer.answer_id, transport, now: new Date(now.getTime() + 500) })).attempted, false);
  assert.equal((await deliverOne({ store, answerId: answer.answer_id, transport, now: new Date(now.getTime() + 1100) })).state, 'accepted');
});

test('uncertain send cannot be automatically repaired or retried', async (t) => {
  const { store, answer } = await setup(t);
  const transport = { mode: 'sandbox', async send() { throw new Error('possibly accepted, response lost'); } };
  assert.equal((await deliverOne({ store, answerId: answer.answer_id, transport })).state, 'uncertain');
  await assert.rejects(store.repair(answer.answer_id), /stalled/);
  assert.equal((await deliverOne({ store, answerId: answer.answer_id, transport })).attempted, false);
});

test('transport modes cannot mix acceptance evidence', async (t) => {
  const { store, answer } = await setup(t);
  await assert.rejects(deliverOne({ store, answerId: answer.answer_id, transport: { mode: 'telegram' } }), /cannot be mixed/);
  assert.equal((await store.delivery(answer.answer_id)).attempts, 0);
});

test('agent refuses final output without a successful lookup', async (t) => {
  const { store } = await setup(t);
  const request = await store.request({ destination: '1042' });
  const model = { bindTools() { return this; }, async invoke() { return new AIMessage('Your order is fine.'); } };
  await assert.rejects(runAgent({ store, requestId: request.request_id, model, modelMode: 'fixture' }), /no successful order lookup/);
  assert.equal(await store.answerFor(request.request_id), undefined);
});

test('concurrent claim permits only one sender', async (t) => {
  const { store, answer } = await setup(t);
  const claims = await Promise.all([store.claim(answer.answer_id, new Date()), store.claim(answer.answer_id, new Date())]);
  assert.equal(claims.filter(Boolean).length, 1);
});

test('Telegram acceptance checks chat identity and exact response text, with opaque failures', async () => {
  const job = { destination: '1042', text: 'Synthetic answer' };
  const response = (body, status = 200) => async () => ({ status, ok: status === 200, async json() { return body; } });
  const send = (fetchImpl) => telegramTransport({ token: 'test-token', chatId: '1042', fetchImpl }).send(job);
  assert.deepEqual(await send(response({ ok: true, result: { message_id: 9, chat: { id: 1042 }, text: job.text } })), { kind: 'accepted', messageId: '9' });
  assert.equal((await send(response({ ok: true, result: { message_id: 9, chat: { id: 777 }, text: job.text } }))).kind, 'uncertain');
  assert.deepEqual(await send(response({ ok: false, parameters: { retry_after: 3 } }, 429)), { kind: 'rate_limited', retryAfter: 3 });
  assert.equal((await send(async () => { throw new Error('secret URL'); })).kind, 'uncertain');
  await assert.rejects(telegramTransport({ token: 'test-token', chatId: '777' }).send(job), /allowed lab chat/);
});

test('collection preserves identities and modes without reply text or raw destination', (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'clutta-agent-evidence-'));
  t.after(() => rmSync(directory, { recursive: true }));
  const emit = evidenceWriter(directory);
  emit('agent', 'answer.persisted', { request_id: 'request-1', answer_id: 'answer-1', destination: '987654321',
    text: 'private synthetic reply', model_mode: 'fixture', delivery_mode: 'sandbox' });
  const raw = readFileSync(path.join(directory, 'logs', 'agent.log'), 'utf8');
  const record = JSON.parse(raw);
  assert.equal(record.answer_id, 'answer-1');
  assert.equal(record.delivery_mode, 'sandbox');
  assert.equal(record.destination_hash.length, 64);
  assert.equal(raw.includes('987654321'), false);
  assert.equal(raw.includes('private synthetic reply'), false);
  assert.throws(() => evidenceWriter(new URL('../', import.meta.url).pathname), /outside the checkout/);
});

test('real PostgreSQL rolls answer insertion back when outbox insertion fails', { skip: process.env.AGENT_TEST_REAL_PG !== '1' }, async (t) => {
  const { store, pool } = await setup(t);
  const request = await store.request({ destination: '1042' });
  const sabotage = {
    async connect() {
      const client = await pool.connect();
      return { release: () => client.release(), query: (sql, values) => {
        if (sql.startsWith('INSERT INTO lab_deliveries')) throw new Error('injected outbox write failure');
        return client.query(sql, values);
      } };
    },
  };
  await assert.rejects(new Store(sabotage).persistAnswer(request.request_id, 'synthetic', 'fixture'), /outbox write failure/);
  assert.equal(await store.answerFor(request.request_id), undefined);
});
