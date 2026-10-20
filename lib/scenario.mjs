import path from 'node:path';

export function scenarioName(value = 'scheduler') {
  if (!['scheduler', 'payment-ordering'].includes(value)) throw new Error('Unknown lab scenario');
  return value;
}

export function scenarioRoot(root, scenario) {
  return scenario === 'scheduler' ? root : path.join(root, 'payment-ordering');
}

export function businessEvents(scenario) {
  return scenario === 'payment-ordering'
    ? ['payment.accepted', 'ledger.recorded', 'merchant.notified']
    : ['payment.accepted', 'notification.queued', 'notification.delivered'];
}
