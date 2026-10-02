import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { checkScriptInputs, trimInput } from '../src/input.mjs';

export async function request(service, route, { method = 'GET', body, expected = [200] } = {}) {
  const response = await fetch(`http://${service}:8080${route}`, {
    method, signal: AbortSignal.timeout(8000),
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!expected.includes(response.status)) throw new Error(`${service}${route}: HTTP ${response.status}`);
  return result;
}

export async function sendPayment(index = 0, paymentId = randomUUID()) {
  const samplePrices = [1299, 2499, 4999, 9900, 19900, 29900];
  const payment = {
    payment_id: paymentId, amount_cents: samplePrices[index % samplePrices.length], currency: 'USD',
  };
  await request('api', '/payments', { method: 'POST', body: payment, expected: [201, 200] });
  return payment;
}

export async function traffic(count = 600, rate = 10, onProgress = () => {}) {
  if (!Number.isInteger(count) || count < 1 || count > 10000) throw new Error('Count must be between 1 and 10000');
  if (!Number.isFinite(rate) || rate < 1 || rate > 100) throw new Error('Rate must be between 1 and 100 payments per second');
  const payments = [];
  for (let index = 0; index < count; index++) {
    payments.push(await sendPayment(index));
    if ((index + 1) % 100 === 0) await onProgress(index + 1);
    if (index + 1 < count) await sleep(1000 / rate);
  }
  return payments;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...args] = process.argv.slice(2).map(trimInput);
  try {
    checkScriptInputs([command, ...args]);
    const maximumArguments = { traffic: 2, payment: 0, status: 1, pause: 0, resume: 0 };
    if (command in maximumArguments && args.length > maximumArguments[command]) throw new Error('Unexpected command arguments');
    let result;
    if (command === 'traffic') {
      const payments = await traffic(Number(args[0] ?? 600), Number(args[1] ?? 10),
        (sent) => console.log(`${sent} distinct fake payments accepted`));
      result = { submitted: payments.length, ...(await request('api', '/summary')) };
    } else if (command === 'payment') {
      result = await sendPayment();
    } else if (command === 'status') {
      result = args[0] ? await request('api', `/payments/${args[0]}`) : {
        database: await request('api', '/summary'),
        scheduler: await request('scheduler', '/control'),
        health: await request('scheduler', '/health'),
      };
    } else if (command === 'pause' || command === 'resume') {
      result = await request('scheduler', `/control/${command}`, { method: 'POST' });
    } else {
      throw new Error('Use traffic [count] [rate], payment, status [payment-id], pause, or resume');
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
