// Application-side ground truth only. This never creates a Clutta finding.
export function assertOrderingTruth(payment, fault) {
  const recorded = Date.parse(payment.processed_at);
  const notified = Date.parse(payment.mailbox_delivered_at);
  if (payment.state !== 'processed' || payment.ledger_entries !== 2 || payment.ledger_balance !== 0 ||
      !Number.isFinite(recorded) || !Number.isFinite(notified) || payment.ordering_fault !== fault ||
      (fault ? notified >= recorded : notified < recorded)) {
    throw new Error('Application records do not prove the expected completed payment order');
  }
  return payment;
}
