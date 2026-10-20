import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Store, createPool } from './store.mjs';
import { runAgent, fixtureModel } from './agent.mjs';
import { deliverNext, sandboxTransport, telegramTransport } from './delivery.mjs';
import { evidenceWriter, services } from './evidence.mjs';
import { ProcessingLoop } from './loop.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function reply(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  let text = '';
  for await (const chunk of request) {
    text += chunk;
    if (Buffer.byteLength(text) > 1024) throw new Error('Request is too large');
  }
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new Error('Request must contain valid JSON'); }
}

// The scenario runs the fixture model by default. A live model is opt-in and
// configured privately; its key never appears in arguments or logs.
async function modelFor(mode) {
  if (mode === 'fixture') return () => fixtureModel('1042');
  if (mode === 'anthropic') {
    if (!process.env.ANTHROPIC_API_KEY || !process.env.AGENT_MODEL) throw new Error('Configure a provider key and explicit model ID privately.');
    const { ChatAnthropic } = await import('@langchain/anthropic');
    // Current models think before answering and thinking counts toward maxTokens, so the live budget is configurable.
    const maxTokens = Number(process.env.AGENT_MAX_TOKENS ?? 256);
    if (!Number.isInteger(maxTokens) || maxTokens < 1) throw new Error('AGENT_MAX_TOKENS must be a positive integer.');
    return () => new ChatAnthropic({ model: process.env.AGENT_MODEL, maxTokens, maxRetries: 0 });
  }
  throw new Error('Supported model modes: fixture, anthropic.');
}

// Lab fault selection for the delivery worker. A targeted fault strands one specific request even while
// other traffic is flowing; the older one-shot fault strands whichever answer is claimed next.
export function faultPlan({ maxTargeted = 100 } = {}) {
  let armed = 0;
  const targeted = new Set();
  return {
    get armed() { return armed; },
    get targeted() { return targeted.size; },
    armNext() { armed = 1; },
    target(requestId) { if (targeted.size >= maxTargeted) return false; targeted.add(requestId); return true; },
    clear() { armed = 0; targeted.clear(); },
    next: (job) => (targeted.delete(job.request_id) ? 'retry-stall' : armed > 0 ? (armed--, 'retry-stall') : 'none'),
  };
}

// Sandbox is the default. Telegram is opt-in for the live demonstration; every request then targets the one allowed lab chat.
export function deliveryTarget(mode) {
  if (mode === 'sandbox') return { destination: '1042', transport: (rateLimitPercent) => sandboxTransport({ rateLimitPercent }) };
  if (mode === 'telegram') {
    const chatId = process.env.TELEGRAM_LAB_CHAT_ID;
    return { destination: chatId, transport: () => telegramTransport({ token: process.env.TELEGRAM_BOT_TOKEN, chatId }) };
  }
  throw new Error('Supported delivery modes: sandbox, telegram.');
}

export async function createService({ role, store, emit, modelMode = 'fixture', deliveryMode = 'sandbox', rateLimitPercent = 0 }) {
  if (!['agent', 'delivery'].includes(role)) throw new Error('Unknown service role');
  const target = deliveryTarget(deliveryMode);
  const newModel = role === 'agent' ? await modelFor(modelMode) : null;
  let loop = null;
  const faults = faultPlan();
  let failure = null;
  if (role === 'delivery') {
    const transport = target.transport(rateLimitPercent);
    loop = new ProcessingLoop(async () => Boolean(await deliverNext({
      store, transport, emit, control: emit.control,
      // A one-shot fault strands exactly the next claimed answer; others keep flowing.
      nextFault: faults.next,
    })), { onError: () => { failure = new Date().toISOString(); process.stderr.write('delivery-worker processing unavailable; inspect the service and database\n'); } });
  }

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://lab.invalid');
      if (request.method === 'GET' && url.pathname === '/health') {
        // Health reports the process, as most production checks do. It stays green while one answer is stranded.
        return reply(response, 200, { status: 'ok', service: services[role] });
      }
      if (request.method === 'GET' && url.pathname === '/ready') {
        await store.pool.query('SELECT 1');
        return reply(response, 200, { status: 'ready', service: services[role] });
      }
      if (request.method === 'GET' && url.pathname === '/summary') return reply(response, 200, await store.summary());
      if (request.method === 'GET' && url.pathname.startsWith('/answers/')) {
        const answerId = url.pathname.slice('/answers/'.length);
        if (!uuid.test(answerId)) return reply(response, 400, { error: 'Invalid answer identifier' });
        const job = await store.delivery(answerId);
        if (!job) return reply(response, 404, { error: 'Answer not found' });
        return reply(response, 200, { request_id: job.request_id, answer_id: job.answer_id, model_mode: job.model_mode,
          delivery_mode: job.delivery_mode, state: job.state, attempts: job.attempts, answered_at: job.answered_at, accepted_at: job.accepted_at });
      }
      if (role === 'agent' && request.method === 'POST' && url.pathname === '/requests') {
        let input;
        try { input = await readBody(request); } catch (error) { return reply(response, 400, { error: error.message }); }
        const requestId = input.request_id ?? randomUUID();
        if (typeof requestId !== 'string' || !uuid.test(requestId)) return reply(response, 400, { error: 'request_id must be a UUID' });
        const existing = await store.getRequest(requestId);
        if (!existing) await store.request({ destination: target.destination, deliveryMode, requestId });
        const answer = await runAgent({ store, requestId, model: newModel(), modelMode, emit });
        return reply(response, existing ? 200 : 201, { request_id: requestId, answer_id: answer.answer_id, replay: Boolean(existing) });
      }
      if (loop && request.method === 'GET' && url.pathname === '/control') {
        return reply(response, 200, { paused: loop.paused, armed_faults: faults.armed, targeted_faults: faults.targeted, last_processing_error: failure });
      }
      if (loop && request.method === 'POST' && url.pathname === '/control/stall-next') {
        faults.armNext();
        return reply(response, 200, { armed_faults: faults.armed });
      }
      if (loop && request.method === 'POST' && url.pathname === '/control/stall-request') {
        let input;
        try { input = await readBody(request); } catch (error) { return reply(response, 400, { error: error.message }); }
        if (typeof input.request_id !== 'string' || !uuid.test(input.request_id)) return reply(response, 400, { error: 'request_id must be a UUID' });
        if (!faults.target(input.request_id)) return reply(response, 409, { error: 'Too many targeted faults are armed' });
        return reply(response, 200, { targeted_faults: faults.targeted });
      }
      if (loop && request.method === 'POST' && url.pathname === '/control/repair') {
        faults.clear();
        const repaired = await store.repairStalled();
        for (const answerId of repaired) emit.control('fault.repaired', { answer_id: answerId }, {});
        return reply(response, 200, { repaired });
      }
      reply(response, 404, { error: 'Route not found' });
    } catch {
      // Never return raw database, model, or provider errors.
      reply(response, 503, { error: 'Service operation unavailable' });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 5000;
  return {
    server, loop,
    async start(port = 8080, host = '0.0.0.0') {
      await store.pool.query('SELECT 1');
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
      loop?.resume();
    },
    async stop() {
      await loop?.stop();
      const closed = new Promise((resolve) => server.close(resolve));
      server.closeIdleConnections();
      await closed;
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (['LANGSMITH_TRACING', 'LANGCHAIN_TRACING_V2'].some((key) => ['true', '1'].includes((process.env[key] ?? '').toLowerCase()))) {
    process.stderr.write('Disable external tracing for this scoped lab.\n');
    process.exit(1);
  }
  const pool = createPool();
  try {
    const store = new Store(pool);
    const emit = evidenceWriter(process.env.AGENT_DELIVERY_DATA_ROOT ?? '/lab');
    const service = await createService({ role: process.env.SERVICE_ROLE, store, emit,
      modelMode: process.env.AGENT_MODEL_MODE ?? 'fixture', deliveryMode: process.env.AGENT_DELIVERY_MODE ?? 'sandbox', rateLimitPercent: Number(process.env.SANDBOX_RATE_LIMIT_PERCENT ?? 0) });
    await service.start();
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => { await service.stop(); await pool.end(); });
  } catch {
    process.stderr.write('Lab service could not start; check database readiness, model configuration, and log access\n');
    await pool.end();
    process.exitCode = 1;
  }
}
