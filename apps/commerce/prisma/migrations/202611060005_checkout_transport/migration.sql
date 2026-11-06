ALTER TABLE orders ADD COLUMN checkout_expires_at timestamptz(6),
  ADD COLUMN preparation_version integer NOT NULL DEFAULT 0;
CREATE INDEX orders_checkout_due ON orders(checkout_expires_at,id)
  WHERE status IN ('CHECKOUT_RESERVED','BASKET_CHANGED');
CREATE TABLE admission_budget (
  id integer PRIMARY KEY CHECK(id=1), capacity integer NOT NULL CHECK(capacity>0),
  used integer NOT NULL DEFAULT 0 CHECK(used>=0 AND used<=capacity), accepting_new boolean NOT NULL DEFAULT true
);
INSERT INTO admission_budget(id,capacity) VALUES(1,200);
CREATE TABLE admission_slots (
  order_id uuid PRIMARY KEY REFERENCES orders(id) ON DELETE RESTRICT,
  released_at timestamptz(6)
);
CREATE INDEX admission_slots_active ON admission_slots(order_id) WHERE released_at IS NULL;
CREATE TABLE order_financial_projections (
  order_id uuid PRIMARY KEY REFERENCES orders(id) ON DELETE RESTRICT,
  revision integer NOT NULL CHECK(revision>0), source_version integer NOT NULL DEFAULT 0 CHECK(source_version>=0),
  status varchar(40) NOT NULL DEFAULT 'NOT_REQUESTED', pending boolean NOT NULL DEFAULT false,
  refunded_minor numeric NOT NULL DEFAULT 0 CHECK(valid_irr(refunded_minor)),
  pending_refund_minor numeric NOT NULL DEFAULT 0 CHECK(valid_irr(pending_refund_minor)),
  updated_at timestamptz(6) NOT NULL DEFAULT now()
);
ALTER TABLE orders ADD CONSTRAINT preparation_version_valid CHECK(preparation_version>=0 AND preparation_version<=checkout_revision);
REVOKE DELETE ON admission_budget,admission_slots,order_financial_projections FROM commerce_runtime;

CREATE TABLE inbox_messages (
  consumer varchar(100) NOT NULL, message_id uuid NOT NULL, envelope jsonb NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','DONE','QUARANTINED')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0), available_at timestamptz(6) NOT NULL DEFAULT now(),
  last_error varchar(80), created_at timestamptz(6) NOT NULL DEFAULT now(),
  PRIMARY KEY(consumer,message_id)
);
CREATE INDEX inbox_due ON inbox_messages(available_at,message_id) WHERE status='PENDING';
CREATE TABLE message_quarantine (
  id uuid PRIMARY KEY, consumer varchar(100) NOT NULL, reason varchar(80) NOT NULL,
  evidence jsonb NOT NULL, created_at timestamptz(6) NOT NULL DEFAULT now()
);
REVOKE DELETE ON inbox_messages FROM commerce_runtime;
REVOKE UPDATE,DELETE ON message_quarantine,consumer_receipts FROM commerce_runtime;
