CREATE FUNCTION valid_irr(n NUMERIC) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT n >= 0 AND n = trunc(n) AND n NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)
$$;
ALTER TABLE bank_operations ALTER COLUMN amount_minor TYPE NUMERIC;
ALTER TABLE bank_refunds ALTER COLUMN amount_minor TYPE NUMERIC;
ALTER TABLE bank_operations ADD CONSTRAINT bank_amount CHECK(valid_irr(amount_minor) AND currency='IRR'),
  ADD CONSTRAINT bank_state CHECK(status IN ('PENDING','SUCCEEDED','FAILED')),
  ADD CONSTRAINT bank_deadline CHECK(deadline_at=initiated_at+interval '15 minutes');
ALTER TABLE bank_refunds ADD CONSTRAINT bank_refund_amount CHECK(valid_irr(amount_minor) AND amount_minor > 0),
  ADD CONSTRAINT bank_refund_state CHECK(status IN ('PENDING','SUCCEEDED','FAILED'));
ALTER TABLE simulation_rules ADD CONSTRAINT simulation_outcome CHECK(outcome IN ('SUCCEED','FAIL','TIMEOUT_BEFORE','TIMEOUT_AFTER'));
CREATE FUNCTION immutable_bank_operation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.operation_key,NEW.amount_minor,NEW.currency,NEW.initiated_at,NEW.deadline_at) IS DISTINCT FROM
    ROW(OLD.operation_key,OLD.amount_minor,OLD.currency,OLD.initiated_at,OLD.deadline_at) OR
    (OLD.status IN ('SUCCEEDED','FAILED') AND ROW(NEW.status,NEW.reference) IS DISTINCT FROM ROW(OLD.status,OLD.reference)) THEN
    RAISE EXCEPTION 'Bank identity/deadline/terminal outcome is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bank_operation_guard BEFORE UPDATE ON bank_operations FOR EACH ROW EXECUTE FUNCTION immutable_bank_operation();
CREATE FUNCTION bank_refund_budget() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE captured numeric; charge_state text; committed numeric;
BEGIN
  SELECT amount_minor,status INTO captured,charge_state FROM bank_operations WHERE operation_key=NEW.charge_key FOR UPDATE;
  IF charge_state <> 'SUCCEEDED' THEN RAISE EXCEPTION 'Bank refund requires successful charge' USING ERRCODE='23514'; END IF;
  SELECT coalesce(sum(amount_minor),0) INTO committed FROM bank_refunds WHERE charge_key=NEW.charge_key AND operation_key<>NEW.operation_key AND status<>'FAILED';
  IF committed + NEW.amount_minor > captured THEN RAISE EXCEPTION 'Bank refund budget exceeded' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bank_refund_guard BEFORE INSERT OR UPDATE ON bank_refunds FOR EACH ROW EXECUTE FUNCTION bank_refund_budget();
REVOKE ALL ON _prisma_migrations FROM bank_runtime;
