import { appendFileSync, mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import os from 'node:os';

export function evidenceWriter(directory) {
  const root = path.resolve(directory ?? path.join(os.homedir(), 'sanitized-cases', 'clutta-agent-delivery'));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const resolved = realpathSync(root);
  const checkout = realpathSync(new URL('../../../', import.meta.url));
  if (resolved === checkout || resolved.startsWith(`${checkout}${path.sep}`)) throw new Error('Evidence must stay outside the checkout.');
  const logs = path.join(resolved, 'logs');
  mkdirSync(logs, { recursive: true, mode: 0o700 });
  return (component, event, row, extra = {}) => {
    if (!['agent', 'delivery'].includes(component)) throw new Error('Unknown evidence component.');
    // No answer text, token, provider error body, or raw chat ID enters collection.
    const record = {
      timestamp: new Date().toISOString(), component, event,
      request_id: row.request_id, answer_id: row.answer_id,
      destination_hash: createHash('sha256').update(String(row.destination)).digest('hex'),
      delivery_mode: row.delivery_mode, model_mode: row.model_mode,
      ...extra,
    };
    appendFileSync(path.join(logs, `${component}.log`), `${JSON.stringify(record)}\n`, { mode: 0o600 });
    return record;
  };
}
