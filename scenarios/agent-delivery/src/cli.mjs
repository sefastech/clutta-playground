import pg from 'pg';
import { Store } from './store.mjs';
import { runAgent, fixtureModel } from './agent.mjs';
import { deliverOne, sandboxTransport, telegramTransport } from './delivery.mjs';
import { evidenceWriter } from './evidence.mjs';

// PG variables keep credentials out of process arguments and logs.
if (process.env.PGDATABASE !== 'clutta_agent_delivery_lab') throw new Error('Use a dedicated PGDATABASE=clutta_agent_delivery_lab.');
if (['LANGSMITH_TRACING', 'LANGCHAIN_TRACING_V2'].some((key) => ['true', '1'].includes((process.env[key] ?? '').toLowerCase()))) throw new Error('Disable external tracing for this scoped lab.');
const pool = new pg.Pool();
const store = new Store(pool);
const [command, id, option] = process.argv.slice(2);
try {
  const emit = evidenceWriter(process.env.AGENT_DELIVERY_DATA_ROOT);
  if (command === 'init') {
    await store.initialize();
    console.log('Synthetic lab tables initialized. No Clutta connection or finding was created.');
  } else if (command === 'request') {
    const mode = process.env.AGENT_MODEL_MODE ?? 'fixture';
    const deliveryMode = process.env.AGENT_DELIVERY_MODE ?? 'sandbox';
    const destination = deliveryMode === 'telegram' ? process.env.TELEGRAM_LAB_CHAT_ID : '1042';
    let model;
    if (mode === 'fixture') model = fixtureModel('1042');
    else if (mode === 'anthropic') {
      if (!process.env.ANTHROPIC_API_KEY || !process.env.AGENT_MODEL) throw new Error('Configure a provider key and explicit model ID privately.');
      const { ChatAnthropic } = await import('@langchain/anthropic');
      model = new ChatAnthropic({ model: process.env.AGENT_MODEL, maxTokens: 256, maxRetries: 0 });
    } else throw new Error('Supported model modes: fixture, anthropic.');
    const request = await store.request({ destination, deliveryMode });
    const answer = await runAgent({ store, requestId: request.request_id, model, modelMode: mode, emit });
    console.log(JSON.stringify({ request_id: request.request_id, answer_id: answer.answer_id, model_mode: mode, delivery_mode: deliveryMode, agent: 'answer persisted', delivery: 'pending' }));
  } else if (command === 'deliver') {
    const job = await store.delivery(id);
    if (!job) throw new Error('Unknown answer ID.');
    const transport = job.delivery_mode === 'sandbox' ? sandboxTransport() : telegramTransport({ token: process.env.TELEGRAM_BOT_TOKEN, chatId: process.env.TELEGRAM_LAB_CHAT_ID });
    const result = await deliverOne({ store, answerId: id, transport, fault: option ?? 'none', emit, control: emit.control });
    console.log(JSON.stringify({ answer_id: id, attempted: result.attempted, state: result.state, delivery_mode: job.delivery_mode }));
  } else if (command === 'repair') {
    await store.repair(id);
    console.log('The deliberately stalled delivery is pending again. Run deliver.');
  } else if (command === 'status') {
    const job = await store.delivery(id);
    if (!job) throw new Error('Unknown answer ID.');
    console.log(JSON.stringify({ request_id: job.request_id, answer_id: job.answer_id, model_mode: job.model_mode, delivery_mode: job.delivery_mode, state: job.state, attempts: job.attempts, accepted_at: job.accepted_at, message_id: job.message_id }));
  } else throw new Error('Commands: init, request, deliver ANSWER_ID [none|rate-limit|retry-stall], repair ANSWER_ID, status ANSWER_ID.');
} catch {
  // Provider/driver errors can contain credentials or request text. Keep the public error generic.
  console.error('Lab command failed. Check command arguments, dedicated database access, model configuration, and the allowed lab chat. No Clutta success was assumed.');
  process.exitCode = 1;
} finally { await pool.end(); }
