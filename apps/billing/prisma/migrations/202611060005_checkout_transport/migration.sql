CREATE TABLE prepared_checkouts (
  order_id uuid PRIMARY KEY, customer_id varchar(128) NOT NULL,
  revision integer NOT NULL CHECK(revision>0), total_minor numeric NOT NULL CHECK(valid_irr(total_minor)),
  currency varchar(3) NOT NULL CHECK(currency='IRR'), snapshot jsonb NOT NULL,
  updated_at timestamptz(6) NOT NULL DEFAULT now()
);
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
REVOKE DELETE ON prepared_checkouts,inbox_messages FROM billing_runtime;
REVOKE UPDATE,DELETE ON message_quarantine,consumer_receipts FROM billing_runtime;
