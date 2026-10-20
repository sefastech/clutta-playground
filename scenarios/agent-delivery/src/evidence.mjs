import { appendFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

export const services = Object.freeze({ agent: 'support-agent', delivery: 'delivery-worker', control: 'lab-control' });

const messages = Object.freeze({
  'answer.persisted': 'Answer saved and delivery queued',
  'delivery.attempted': 'Delivery attempt started',
  'delivery.accepted': 'Answer delivered to the customer channel',
  'delivery.rate_limited': 'Delivery rate limited; retry scheduled',
  'delivery.uncertain': 'Delivery outcome unknown; held for reconciliation',
});

// The checkout is the nearest ancestor holding this repository's AGENTS.md.
// A container image that copies only the scenario has no checkout to protect.
export function checkoutRoot(start = path.dirname(fileURLToPath(import.meta.url))) {
  for (let directory = start; ; directory = path.dirname(directory)) {
    if (existsSync(path.join(directory, 'AGENTS.md')) && existsSync(path.join(directory, 'scenarios'))) return realpathSync(directory);
    if (directory === path.dirname(directory)) return null;
  }
}

export function evidenceWriter(directory) {
  const root = path.resolve(directory ?? path.join(os.homedir(), 'sanitized-cases', 'clutta-agent-delivery'));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const resolved = realpathSync(root);
  const checkout = checkoutRoot();
  if (checkout && (resolved === checkout || resolved.startsWith(`${checkout}${path.sep}`))) throw new Error('Evidence must stay outside the checkout.');
  const logs = path.join(resolved, 'logs');
  mkdirSync(logs, { recursive: true, mode: 0o700 });
  const control = path.join(resolved, 'control');
  mkdirSync(control, { recursive: true, mode: 0o700 });
  const write = (file, record, folder = logs) => appendFileSync(path.join(folder, file), `${JSON.stringify(record)}\n`, { mode: 0o600 });
  const emit = (component, event, row, extra = {}) => {
    if (!['agent', 'delivery'].includes(component)) throw new Error('Unknown evidence component.');
    // No answer text, token, provider error body, or raw chat ID enters collection.
    const { timestamp, ...fields } = extra;
    const record = {
      time: timestamp ?? new Date().toISOString(), level: event === 'delivery.uncertain' ? 'warn' : 'info',
      service: services[component], event, message: messages[event] ?? event,
      request_id: row.request_id, answer_id: row.answer_id, order_id: row.order_id,
      destination_hash: createHash('sha256').update(String(row.destination)).digest('hex'),
      delivery_mode: row.delivery_mode, model_mode: row.model_mode,
      ...fields,
    };
    write(`${component}.log`, record);
    return record;
  };
  // Lab fault controls are preserved for the operator in a sibling folder that
  // is never watched: Clutta must establish the missing step from the application logs.
  emit.control = (event, row, extra = {}) => {
    const record = { time: new Date().toISOString(), service: services.control, event, answer_id: row.answer_id, request_id: row.request_id, ...extra };
    write('lab-control.log', record, control);
    return record;
  };
  return emit;
}
