import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

export async function request(service, route, { method = 'GET', body, expected = [200] } = {}) {
  const response = await fetch(`http://${service}:8080${route}`, {
    method, signal: AbortSignal.timeout(30000),
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!expected.includes(response.status)) throw new Error(`${service}${route}: HTTP ${response.status}`);
  return result;
}

export const ask = () => request('agent', '/requests', { method: 'POST', body: {}, expected: [201] });

export async function traffic(count, rate, onProgress = () => {}) {
  if (!Number.isInteger(count) || count < 1 || count > 1000000) throw new Error('Count must be between 1 and 1000000');
  if (!Number.isFinite(rate) || rate <= 0 || rate > 20) throw new Error('Rate must be above 0 and at most 20 requests per second');
  for (let index = 0; index < count; index++) {
    await ask();
    if ((index + 1) % 50 === 0) await onProgress(index + 1);
    if (index + 1 < count) await sleep(1000 / rate);
  }
}

async function waitState(answerId, states, seconds) {
  for (let elapsed = 0; elapsed < seconds * 4; elapsed++) {
    const status = await request('agent', `/answers/${answerId}`);
    if (states.includes(status.state)) return status;
    await sleep(250);
  }
  throw new Error(`Answer ${answerId} did not reach ${states.join('/')} in ${seconds}s; nothing was assumed`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...args] = process.argv.slice(2);
  try {
    let result;
    if (command === 'traffic') {
      await traffic(Number(args[0] ?? 200), Number(args[1] ?? 2), (sent) => console.log(`${sent} synthetic requests answered`));
      result = await request('agent', '/summary');
    } else if (command === 'request') {
      result = await ask();
    } else if (command === 'status') {
      result = args[0] ? await request('agent', `/answers/${args[0]}`) : {
        database: await request('agent', '/summary'),
        delivery_worker: await request('delivery', '/control'),
        health: { agent: await request('agent', '/health'), delivery: await request('delivery', '/health') },
      };
    } else if (command === 'break') {
      // Strand exactly one answer, chosen by its request ID so concurrent traffic cannot take the fault.
      // Other answers keep delivering and both health checks stay green.
      const requestId = randomUUID();
      await request('delivery', '/control/stall-request', { method: 'POST', body: { request_id: requestId } });
      const answer = await request('agent', '/requests', { method: 'POST', body: { request_id: requestId }, expected: [201] });
      const stalled = await waitState(answer.answer_id, ['stalled'], 30);
      if (stalled.request_id !== requestId) throw new Error('The stalled answer does not match the targeted request; nothing was assumed');
      result = { ...stalled, health: await request('delivery', '/health') };
    } else if (command === 'repair') {
      const { repaired } = await request('delivery', '/control/repair', { method: 'POST' });
      const delivered = [];
      for (const answerId of repaired) delivered.push(await waitState(answerId, ['accepted'], 30));
      result = { repaired: delivered };
    } else {
      throw new Error('Use traffic [count] [rate], request, status [answer-id], break, or repair');
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
