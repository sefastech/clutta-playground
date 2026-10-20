import { randomUUID } from 'node:crypto';

// The sandbox can return occasional ordinary rate limits so healthy traffic
// includes retries that succeed. These are labelled sandbox behaviour, not
// Telegram responses or injected faults.
export function sandboxTransport({ rateLimitPercent = 0, random = Math.random } = {}) {
  return {
    mode: 'sandbox',
    async send() {
      if (rateLimitPercent > 0 && random() * 100 < rateLimitPercent) return { kind: 'rate_limited', retryAfter: 1 };
      return { kind: 'accepted', messageId: `sandbox-${randomUUID()}` };
    },
  };
}

export function telegramTransport({ token, chatId, fetchImpl = fetch }) {
  if (!token || !/^-?[0-9]{1,20}$/.test(chatId ?? '')) throw new Error('Telegram needs a token and an explicitly allowed lab chat.');
  return {
    mode: 'telegram',
    async send(job) {
      if (job.destination !== chatId) throw new Error('Destination is outside the allowed lab chat.');
      let response;
      try {
        response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: job.text }), signal: AbortSignal.timeout(15000),
        });
      } catch (error) { return { kind: 'uncertain', reason: `request:${error?.cause?.code ?? error?.name ?? 'error'}` }; } // Never print a token-bearing URL or assume the send failed.
      let body;
      try { body = await response.json(); } catch { return { kind: 'uncertain', reason: `http:${response.status}:unreadable` }; }
      if (response.status === 429 && body.ok === false && Number.isInteger(body.parameters?.retry_after) && body.parameters.retry_after > 0) {
        return { kind: 'rate_limited', retryAfter: body.parameters.retry_after };
      }
      if (response.ok && body.ok === true && Number.isSafeInteger(body.result?.message_id) &&
          String(body.result?.chat?.id) === chatId && body.result?.text === job.text) {
        return { kind: 'accepted', messageId: String(body.result.message_id) };
      }
      // Reasons are categories only: status, Telegram's error code and which acceptance check failed. Never the token or text.
      const failed = !response.ok || body.ok !== true ? `telegram:${body.error_code ?? 'none'}`
        : !Number.isSafeInteger(body.result?.message_id) ? 'check:message_id'
          : String(body.result?.chat?.id) !== chatId ? 'check:chat' : 'check:text';
      return { kind: 'uncertain', reason: `http:${response.status}:${failed}` };
    },
  };
}

const faults = ['none', 'rate-limit', 'retry-stall'];

// Sends one claimed job. The delivery log records what the worker would
// ordinarily log. A retry-stall fault reports an ordinary rate limit with a
// scheduled retry, then strands the job; only the lab control log, which is
// not collected, names the injected fault.
async function send({ store, job, transport, fault, now, emit, control }) {
  emit('delivery', 'delivery.attempted', job, { attempt: job.attempts });
  let result;
  try {
    // This adapter, not Telegram, generates the repeatable fault. No request is sent in either fault mode.
    result = fault === 'none' ? await transport.send(job) : { kind: 'rate_limited', retryAfter: 1 };
  } catch (error) { result = { kind: 'uncertain', reason: `transport:${error?.message === 'Destination is outside the allowed lab chat.' ? 'destination' : 'error'}` }; }
  if (fault !== 'none') control('fault.injected', job, { fault, attempt: job.attempts });
  if (result.kind === 'accepted') {
    const row = await store.finish(job.answer_id, { state: 'accepted', messageId: result.messageId, now, result: 'accepted' });
    emit('delivery', 'delivery.accepted', job, { timestamp: new Date(row.accepted_at).toISOString(), message_id: result.messageId, attempt: job.attempts });
  } else if (result.kind === 'rate_limited') {
    const state = fault === 'retry-stall' ? 'stalled' : 'pending';
    await store.finish(job.answer_id, { state, retryAfterSeconds: result.retryAfter, now, result: 'rate_limited' });
    emit('delivery', 'delivery.rate_limited', job, { retry_after_seconds: result.retryAfter, attempt: job.attempts });
  } else {
    await store.finish(job.answer_id, { state: 'uncertain', now, result: 'uncertain' });
    emit('delivery', 'delivery.uncertain', job, { attempt: job.attempts });
    // Why the send is uncertain goes to the unwatched control log, so operators can diagnose without touching evidence.
    control('delivery.uncertain_reason', job, { reason: result.reason ?? 'unknown', attempt: job.attempts });
  }
  return { attempted: true, ...(await store.delivery(job.answer_id)) };
}

export async function deliverOne({ store, answerId, transport, fault = 'none', now, emit = () => {}, control = () => {} }) {
  if (!faults.includes(fault)) throw new Error('Unknown fault.');
  const before = await store.delivery(answerId);
  if (!before) throw new Error('Unknown delivery.');
  if (before.delivery_mode !== transport.mode) throw new Error('Sandbox and Telegram evidence cannot be mixed for one request.');
  const job = await store.claim(answerId, now);
  if (!job) return { attempted: false, state: before.state };
  return send({ store, job, transport, fault, now, emit, control });
}

// Worker loop step: claims the oldest due job. `nextFault` returns the fault
// for this claim, so a one-shot fault strands exactly one answer.
export async function deliverNext({ store, transport, nextFault = () => 'none', emit = () => {}, control = () => {} }) {
  const job = await store.claimNext();
  if (!job) return null;
  if (job.delivery_mode !== transport.mode) {
    await store.finish(job.answer_id, { state: 'uncertain', result: 'mode_mismatch' });
    control('delivery.mode_mismatch', job, {});
    return { attempted: false, ...(await store.delivery(job.answer_id)) };
  }
  const fault = nextFault(job);
  if (!faults.includes(fault)) throw new Error('Unknown fault.');
  return send({ store, job, transport, fault, emit, control });
}
