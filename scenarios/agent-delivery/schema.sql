CREATE TABLE IF NOT EXISTS lab_orders (
  order_id text PRIMARY KEY,
  status text NOT NULL,
  arrival text NOT NULL
);
INSERT INTO lab_orders VALUES ('1042', 'shipped', 'tomorrow') ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS lab_requests (
  request_id uuid PRIMARY KEY,
  destination text NOT NULL,
  order_id text NOT NULL REFERENCES lab_orders(order_id),
  delivery_mode text NOT NULL CHECK (delivery_mode IN ('sandbox', 'telegram')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS lab_answers (
  answer_id uuid PRIMARY KEY,
  request_id uuid NOT NULL UNIQUE REFERENCES lab_requests(request_id),
  text text NOT NULL,
  model_mode text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS lab_deliveries (
  answer_id uuid PRIMARY KEY REFERENCES lab_answers(answer_id),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sending', 'stalled', 'accepted', 'uncertain')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  message_id text,
  accepted_at timestamptz
);
CREATE TABLE IF NOT EXISTS lab_delivery_attempts (
  attempt_id uuid PRIMARY KEY,
  answer_id uuid NOT NULL REFERENCES lab_answers(answer_id),
  result text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
