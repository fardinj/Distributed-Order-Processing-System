CREATE TABLE payment_lines(payment_id uuid NOT NULL REFERENCES payments(id),item_id uuid NOT NULL,amount_minor numeric NOT NULL CHECK(valid_irr(amount_minor)),PRIMARY KEY(payment_id,item_id));
ALTER TABLE payments ADD COLUMN financial_version integer NOT NULL DEFAULT 0 CHECK(financial_version>=0);
ALTER TABLE refunds ADD COLUMN correlation_id varchar(80) NOT NULL DEFAULT 'refund-recovery', ADD COLUMN lookup_count integer NOT NULL DEFAULT 0 CHECK(lookup_count>=0),
 ADD COLUMN lease_token uuid,ADD COLUMN lease_until timestamptz(6),ADD COLUMN bank_reference varchar(200),ADD CONSTRAINT refund_lease CHECK((lease_token IS NULL)=(lease_until IS NULL));
CREATE INDEX refund_work_due ON refunds(next_reconcile_at,id) WHERE next_reconcile_at IS NOT NULL;
CREATE UNIQUE INDEX refund_one_item_obligation ON refund_items(item_id);
CREATE FUNCTION guard_refund_line() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected numeric; actual numeric;
BEGIN
 SELECT l.amount_minor,r.amount_minor INTO expected,actual FROM refunds r JOIN payment_lines l ON l.payment_id=r.payment_id AND l.item_id=NEW.item_id WHERE r.id=NEW.refund_id FOR UPDATE OF r;
 IF expected IS NULL OR NEW.amount_minor<>expected OR actual<>expected THEN RAISE EXCEPTION 'Refund requires exactly one captured whole line' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER refund_whole_line_guard BEFORE INSERT OR UPDATE ON refund_items FOR EACH ROW EXECUTE FUNCTION guard_refund_line();
REVOKE UPDATE,DELETE ON payment_lines,refund_items FROM billing_runtime;
