CREATE TABLE payments (
    payment_id uuid PRIMARY KEY,
    amount_cents integer NOT NULL CHECK (amount_cents BETWEEN 1 AND 1000000),
    currency text NOT NULL CHECK (currency = 'USD'),
    state text NOT NULL DEFAULT 'accepted' CHECK (state IN ('accepted', 'processed')),
    accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    processed_at timestamptz,
    CHECK ((state = 'accepted' AND processed_at IS NULL) OR
           (state = 'processed' AND processed_at IS NOT NULL))
);

CREATE INDEX pending_payments ON payments (accepted_at, payment_id) WHERE state = 'accepted';

CREATE TABLE outbox (
    payment_id uuid PRIMARY KEY REFERENCES payments(payment_id),
    queued_at timestamptz NOT NULL,
    delivered_at timestamptz
);

CREATE INDEX pending_notifications ON outbox (queued_at, payment_id) WHERE delivered_at IS NULL;

CREATE TABLE mailbox (
    payment_id uuid PRIMARY KEY REFERENCES outbox(payment_id),
    delivered_at timestamptz NOT NULL
);
