CREATE FUNCTION guard_fulfillment_cutoff() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.fulfillment_started_at IS NOT NULL AND NEW.fulfillment_started_at IS DISTINCT FROM OLD.fulfillment_started_at THEN
  RAISE EXCEPTION 'First fulfillment start is immutable' USING ERRCODE='23514';
 END IF;
 IF NOT OLD.cancellation_requested AND NEW.cancellation_requested AND NEW.fulfillment_started_at IS NOT NULL THEN
  RAISE EXCEPTION 'Whole-order cancellation cutoff has passed' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER fulfillment_cutoff_guard BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION guard_fulfillment_cutoff();
