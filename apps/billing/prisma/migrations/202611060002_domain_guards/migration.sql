CREATE FUNCTION valid_irr(n NUMERIC) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT n >= 0 AND n = trunc(n) AND n NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)
$$;
ALTER TABLE payments ALTER COLUMN amount_minor TYPE NUMERIC;
ALTER TABLE refunds ALTER COLUMN amount_minor TYPE NUMERIC;
ALTER TABLE refund_items ALTER COLUMN amount_minor TYPE NUMERIC;
ALTER TABLE payments ADD CONSTRAINT payment_amount CHECK(valid_irr(amount_minor) AND currency='IRR'),
  ADD CONSTRAINT payment_state CHECK(status IN ('PENDING','PROCESSING','UNKNOWN','SUCCEEDED','FAILED')),
  ADD CONSTRAINT payment_version CHECK(version > 0);
ALTER TABLE refunds ADD CONSTRAINT refund_amount CHECK(valid_irr(amount_minor) AND amount_minor > 0 AND currency='IRR'),
  ADD CONSTRAINT refund_state CHECK(status IN ('PENDING','PROCESSING','UNKNOWN','SUCCEEDED','FAILED','REVIEW_REQUIRED')),
  ADD CONSTRAINT refund_version CHECK(version > 0);
ALTER TABLE refund_items ADD CONSTRAINT refund_item_amount CHECK(valid_irr(amount_minor) AND amount_minor > 0);
ALTER TABLE payment_cancellations ADD CONSTRAINT cancel_state CHECK(status IN ('REQUESTED','NO_CHARGE','AWAITING_RESULT','REFUND_REQUIRED','RESOLVED'));
CREATE INDEX payment_reconciliation_due ON payments(next_reconcile_at) WHERE status IN ('PROCESSING','UNKNOWN');
CREATE INDEX refund_reconciliation_due ON refunds(next_reconcile_at) WHERE status IN ('PROCESSING','UNKNOWN');
CREATE INDEX outbox_due ON outbox(available_at,id) WHERE published_at IS NULL;
ALTER TABLE outbox ADD CONSTRAINT outbox_version CHECK(generation >= 0 AND attempts >= 0),
  ADD CONSTRAINT outbox_lease CHECK((claim_token IS NULL)=(lease_until IS NULL));
CREATE FUNCTION refund_budget() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE captured numeric; payment_state text; committed numeric;
BEGIN
  SELECT amount_minor,status INTO captured,payment_state FROM payments WHERE id=NEW.payment_id FOR UPDATE;
  IF payment_state <> 'SUCCEEDED' THEN RAISE EXCEPTION 'Refund requires captured payment' USING ERRCODE='23514'; END IF;
  SELECT coalesce(sum(amount_minor),0) INTO committed FROM refunds WHERE payment_id=NEW.payment_id AND id<>NEW.id;
  IF committed + NEW.amount_minor > captured THEN RAISE EXCEPTION 'Refund budget exceeded' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER refund_amount_budget BEFORE INSERT OR UPDATE OF amount_minor,payment_id ON refunds FOR EACH ROW EXECUTE FUNCTION refund_budget();
REVOKE UPDATE, DELETE ON refund_logs, payment_attempts FROM billing_runtime;
REVOKE ALL ON _prisma_migrations FROM billing_runtime;
