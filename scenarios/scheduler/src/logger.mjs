import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export const services = Object.freeze({ api: 'payment-api', worker: 'payment-worker', scheduler: 'notification-scheduler' });

export function committedRecord(role, payment) {
  const definitions = {
    api: ['payment.accepted', 'Payment accepted', payment.accepted_at],
    worker: ['notification.queued', 'Payment processed and notification queued', payment.processed_at],
    scheduler: ['notification.delivered', 'Notification delivered to the test mailbox', payment.delivered_at],
  };
  const definition = definitions[role];
  if (!definition || !payment.payment_id || !definition[2]) throw new Error('Committed business record is incomplete');
  return {
    time: new Date(definition[2]).toISOString(), level: 'info',
    service: services[role], event: definition[0], message: definition[1],
    payment_id: payment.payment_id, amount_cents: payment.amount_cents,
    currency: payment.currency,
  };
}

export function createLogger(role, directory) {
  if (!services[role]) throw new Error('Unknown service role');
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${role}.log`);
  return (payment) => {
    const line = `${JSON.stringify(committedRecord(role, payment))}\n`;
    // The caller only invokes this after a successful database COMMIT.
    appendFileSync(file, line, { mode: 0o600 });
    process.stdout.write(line);
  };
}
