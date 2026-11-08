ALTER TABLE bank_refunds ADD COLUMN reference varchar(200),ADD COLUMN simulation_outcome varchar(30) NOT NULL DEFAULT 'SUCCEED' CHECK(simulation_outcome IN ('SUCCEED','FAIL','TIMEOUT_BEFORE','TIMEOUT_AFTER')),
 ADD COLUMN attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count>=0),ADD COLUMN fault_count integer NOT NULL DEFAULT 1 CHECK(fault_count>=0);
CREATE TABLE bank_refund_simulation_assignments(operation_key varchar(150) PRIMARY KEY,outcome varchar(30) NOT NULL CHECK(outcome IN ('SUCCEED','FAIL','TIMEOUT_BEFORE','TIMEOUT_AFTER')),fault_count integer NOT NULL DEFAULT 1 CHECK(fault_count>=0));
REVOKE INSERT,UPDATE,DELETE ON bank_refund_simulation_assignments FROM bank_runtime;
CREATE FUNCTION guard_bank_refund_result() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.simulation_outcome,NEW.fault_count) IS DISTINCT FROM ROW(OLD.simulation_outcome,OLD.fault_count) OR
   (OLD.status IN ('SUCCEEDED','FAILED') AND ROW(NEW.status,NEW.reference) IS DISTINCT FROM ROW(OLD.status,OLD.reference)) THEN RAISE EXCEPTION 'Bank refund outcome/identity is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bank_refund_result_guard BEFORE UPDATE ON bank_refunds FOR EACH ROW EXECUTE FUNCTION guard_bank_refund_result();
