import { randomUUID } from 'node:crypto';

export function sandboxTransport() {
  return { mode: 'sandbox', async send() { return { kind: 'accepted', messageId: `sandbox-${randomUUID()}` }; } };
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
      } catch { return { kind: 'uncertain' }; } // Never print a token-bearing URL or assume the send failed.
      let body;
      try { body = await response.json(); } catch { return { kind: 'uncertain' }; }
      if (response.status === 429 && body.ok === false && Number.isInteger(body.parameters?.retry_after) && body.parameters.retry_after > 0) {
        return { kind: 'rate_limited', retryAfter: body.parameters.retry_after };
      }
      if (response.ok && body.ok === true && Number.isSafeInteger(body.result?.message_id) &&
          String(body.result?.chat?.id) === chatId && body.result?.text === job.text) {
        return { kind: 'accepted', messageId: String(body.result.message_id) };
      }
      return { kind: 'uncertain' };
    },
  };
}

export async function deliverOne({ store, answerId, transport, fault = 'none', now = new Date(), emit = () => {} }) {
  if (!['none', 'rate-limit', 'retry-stall'].includes(fault)) throw new Error('Unknown fault.');
  const before = await store.delivery(answerId);
  if (!before) throw new Error('Unknown delivery.');
  if (before.delivery_mode !== transport.mode) throw new Error('Sandbox and Telegram evidence cannot be mixed for one request.');
  const job = await store.claim(answerId, now);
  if (!job) return { attempted: false, state: before.state };
  emit('delivery', 'delivery.attempted', job, { attempt: job.attempts, fault_injected: fault !== 'none' });
  let result;
  try {
    // This adapter, not Telegram, generates the repeatable fault. No request is sent in either fault mode.
    result = fault === 'none' ? await transport.send(job) : { kind: 'rate_limited', retryAfter: 1 };
  } catch { result = { kind: 'uncertain' }; }
  if (result.kind === 'accepted') {
    const acceptedAt = new Date();
    await store.finish(answerId, { state: 'accepted', messageId: result.messageId, acceptedAt, result: 'accepted' });
    emit('delivery', 'delivery.accepted', job, { timestamp: acceptedAt.toISOString(), message_id: result.messageId });
  } else if (result.kind === 'rate_limited') {
    const state = fault === 'retry-stall' ? 'stalled' : 'pending';
    await store.finish(answerId, { state, retryAt: new Date(now.getTime() + result.retryAfter * 1000), result: 'rate_limited' });
    emit('delivery', 'delivery.rate_limited', job, { retry_after_seconds: result.retryAfter, fault_injected: fault !== 'none', retry_stalled: state === 'stalled' });
  } else {
    await store.finish(answerId, { state: 'uncertain', result: 'uncertain' });
    emit('delivery', 'delivery.uncertain', job);
  }
  return { attempted: true, ...(await store.delivery(answerId)) };
}
