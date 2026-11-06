ALTER TABLE orders ADD COLUMN payment_operation_key varchar(150) UNIQUE,
  ADD COLUMN payment_entry_revision integer,
  ADD CONSTRAINT payment_entry_identity CHECK((payment_operation_key IS NULL)=(payment_entry_revision IS NULL));
CREATE TABLE fulfillment_jobs (
  item_id uuid PRIMARY KEY REFERENCES order_items(id) ON DELETE RESTRICT,
  status varchar(30) NOT NULL DEFAULT 'READY' CHECK(status IN ('READY','RUNNING','DONE','DEFERRED','CANCELLED')),
  available_at timestamptz(6) NOT NULL DEFAULT now(), generation integer NOT NULL DEFAULT 0 CHECK(generation>=0)
);
CREATE INDEX fulfillment_jobs_due ON fulfillment_jobs(available_at,item_id) WHERE status IN ('READY','DEFERRED');
REVOKE DELETE ON fulfillment_jobs FROM commerce_runtime;
CREATE FUNCTION guard_payment_entry_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.payment_operation_key IS NOT NULL AND
    ROW(NEW.payment_operation_key,NEW.payment_entry_revision) IS DISTINCT FROM ROW(OLD.payment_operation_key,OLD.payment_entry_revision) THEN
    RAISE EXCEPTION 'Payment entry identity is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_entry_identity BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION guard_payment_entry_identity();
