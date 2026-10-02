import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createPool, acceptPayment, processNextPayment, deliverNextNotification,
  paymentStatus, summary, PaymentConflict } from './store.mjs';
import { createLogger, services } from './logger.mjs';
import { ProcessingLoop } from './loop.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validatePayment(input) {
  if (!input || Array.isArray(input) || typeof input !== 'object') throw new Error('Payment must be an object');
  const paymentId = input.payment_id ?? randomUUID();
  if (typeof paymentId !== 'string' || !uuid.test(paymentId)) throw new Error('payment_id must be a UUID');
  if (!Number.isInteger(input.amount_cents) || input.amount_cents < 1 || input.amount_cents > 1000000) {
    throw new Error('amount_cents must be a whole number between 1 and 1000000');
  }
  if (input.currency !== 'USD') throw new Error('This fake-payment lab supports USD only');
  return { payment_id: paymentId.toLowerCase(), amount_cents: input.amount_cents, currency: input.currency };
}

function reply(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  let text = '';
  for await (const chunk of request) {
    text += chunk;
    if (Buffer.byteLength(text) > 4096) throw new Error('Payment request is too large');
  }
  try { return JSON.parse(text); } catch { throw new Error('Payment must contain valid JSON'); }
}

export function createService({ role, pool, record }) {
  if (!services[role]) throw new Error('Unknown service role');
  let loop = null;
  if (role !== 'api') {
    const operation = role === 'worker' ? processNextPayment : deliverNextNotification;
    loop = new ProcessingLoop(async () => {
      const payment = await operation(pool);
      if (!payment) return false;
      record(payment);
      return true;
    }, { onError: () => process.stderr.write(`${services[role]} processing unavailable; inspect the service and database\n`) });
  }

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://lab.invalid');
      if (request.method === 'GET' && url.pathname === '/health') {
        return reply(response, 200, { status: 'ok', service: services[role] });
      }
      if (request.method === 'GET' && url.pathname === '/ready') {
        await pool.query('SELECT 1');
        return reply(response, 200, { status: 'ready', service: services[role] });
      }
      if (loop && request.method === 'GET' && url.pathname === '/control') {
        return reply(response, 200, { paused: loop.paused });
      }
      if (loop && request.method === 'POST' && url.pathname === '/control/pause') {
        await loop.pause();
        return reply(response, 200, { paused: loop.paused });
      }
      if (loop && request.method === 'POST' && url.pathname === '/control/resume') {
        loop.resume();
        return reply(response, 200, { paused: loop.paused });
      }
      if (role === 'api' && request.method === 'POST' && url.pathname === '/payments') {
        let payment;
        try { payment = validatePayment(await readBody(request)); }
        catch (error) { return reply(response, 400, { error: error.message }); }
        const result = await acceptPayment(pool, payment);
        if (result.created) record(result.payment);
        return reply(response, result.created ? 201 : 200, { payment_id: result.payment.payment_id, replay: !result.created });
      }
      if (role === 'api' && request.method === 'GET' && url.pathname === '/summary') {
        return reply(response, 200, await summary(pool));
      }
      if (role === 'api' && request.method === 'GET' && url.pathname.startsWith('/payments/')) {
        const paymentId = url.pathname.slice('/payments/'.length);
        if (!uuid.test(paymentId)) return reply(response, 400, { error: 'Invalid payment identifier' });
        const payment = await paymentStatus(pool, paymentId);
        return reply(response, payment ? 200 : 404, payment ?? { error: 'Payment not found' });
      }
      reply(response, 404, { error: 'Route not found' });
    } catch (error) {
      if (error instanceof PaymentConflict) return reply(response, 409, { error: error.message });
      // Never return raw database errors or connection details to the browser.
      reply(response, 503, { error: 'Service operation unavailable' });
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  return {
    server, loop,
    async start(port = 8080, host = '0.0.0.0') {
      await pool.query('SELECT 1');
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
      });
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
  const role = process.env.SERVICE_ROLE;
  const pool = createPool();
  const record = createLogger(role, process.env.LOG_DIRECTORY ?? '/lab/logs');
  const service = createService({ role, pool, record });
  try {
    await service.start();
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => {
      await service.stop();
      await pool.end();
    });
  } catch {
    process.stderr.write('Lab service could not start; check database readiness and log access\n');
    await pool.end();
    process.exitCode = 1;
  }
}
