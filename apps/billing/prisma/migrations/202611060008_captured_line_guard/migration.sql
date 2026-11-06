CREATE FUNCTION guard_captured_line_total() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (SELECT coalesce(sum(amount_minor),0) FROM payment_lines WHERE payment_id=NEW.payment_id)<>
    (SELECT amount_minor FROM payments WHERE id=NEW.payment_id) THEN
   RAISE EXCEPTION 'Captured line set must equal immutable payment amount' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER captured_line_total AFTER INSERT ON payment_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_captured_line_total();
