CREATE FUNCTION immutable_bank_refund() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.operation_key,NEW.charge_key,NEW.amount_minor) IS DISTINCT FROM ROW(OLD.operation_key,OLD.charge_key,OLD.amount_minor) OR
     (OLD.status IN ('SUCCEEDED','FAILED') AND NEW.status<>OLD.status) THEN
    RAISE EXCEPTION 'Bank refund identity and terminal result are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bank_refund_identity_guard BEFORE UPDATE ON bank_refunds FOR EACH ROW EXECUTE FUNCTION immutable_bank_refund();
