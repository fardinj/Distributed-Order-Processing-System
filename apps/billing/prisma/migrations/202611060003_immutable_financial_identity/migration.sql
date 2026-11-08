CREATE FUNCTION immutable_payment_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.order_id,NEW.operation_key,NEW.customer_id,NEW.amount_minor,NEW.currency) IS DISTINCT FROM
     ROW(OLD.id,OLD.order_id,OLD.operation_key,OLD.customer_id,OLD.amount_minor,OLD.currency) OR
     (OLD.status IN ('SUCCEEDED','FAILED') AND NEW.status<>OLD.status) THEN
    RAISE EXCEPTION 'Payment identity, amount and terminal result are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_identity_guard BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION immutable_payment_identity();
CREATE FUNCTION immutable_refund_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.payment_id,NEW.disposition_id,NEW.operation_key,NEW.amount_minor,NEW.currency) IS DISTINCT FROM
     ROW(OLD.id,OLD.payment_id,OLD.disposition_id,OLD.operation_key,OLD.amount_minor,OLD.currency) OR
     (OLD.status='SUCCEEDED' AND NEW.status<>OLD.status) THEN
    RAISE EXCEPTION 'Refund identity, amount and confirmed result are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER refund_identity_guard BEFORE UPDATE ON refunds FOR EACH ROW EXECUTE FUNCTION immutable_refund_identity();
