ALTER TABLE payments ADD COLUMN ordering_fault boolean NOT NULL DEFAULT false;
CREATE TABLE lab_control (id integer PRIMARY KEY CHECK (id = 1), notify_first boolean NOT NULL);
INSERT INTO lab_control VALUES (1, false);
CREATE TABLE ledger_entries (
  payment_id uuid NOT NULL REFERENCES payments(payment_id),
  account text NOT NULL CHECK (account IN ('clearing', 'merchant')),
  cents integer NOT NULL CHECK (cents <> 0),
  PRIMARY KEY (payment_id, account)
);
