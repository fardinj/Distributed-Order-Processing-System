ALTER TABLE payments ADD COLUMN checkout_revision integer NOT NULL DEFAULT 1 CHECK(checkout_revision>0),
  ADD COLUMN correlation_id varchar(80) NOT NULL DEFAULT 'payment-recovery',
  ADD COLUMN bank_deadline_at timestamptz(6), ADD COLUMN bank_reference varchar(200),
  ADD COLUMN lookup_count integer NOT NULL DEFAULT 0 CHECK(lookup_count>=0),
  ADD COLUMN lease_token uuid, ADD COLUMN lease_until timestamptz(6),
  ADD CONSTRAINT payment_lease CHECK((lease_token IS NULL)=(lease_until IS NULL));
CREATE INDEX payment_work_due ON payments(next_reconcile_at,id) WHERE next_reconcile_at IS NOT NULL;
CREATE FUNCTION immutable_payment_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.checkout_revision<>OLD.checkout_revision THEN
    RAISE EXCEPTION 'Payment revision is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_revision_guard BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION immutable_payment_revision();
