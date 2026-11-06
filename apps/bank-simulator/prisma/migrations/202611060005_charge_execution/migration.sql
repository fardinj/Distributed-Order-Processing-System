ALTER TABLE bank_operations ADD COLUMN simulation_outcome varchar(40) NOT NULL DEFAULT 'SUCCEED'
  CHECK(simulation_outcome IN ('SUCCEED','FAIL','TIMEOUT_BEFORE','TIMEOUT_AFTER'));
CREATE TABLE bank_simulation_assignments (
  operation_key varchar(150) PRIMARY KEY, reference varchar(80) NOT NULL REFERENCES simulation_rules(reference) ON DELETE RESTRICT
);
CREATE TABLE bank_charge_cancellations (
  operation_key varchar(150) PRIMARY KEY, created_at timestamptz(6) NOT NULL DEFAULT now()
);
REVOKE INSERT,UPDATE,DELETE ON bank_simulation_assignments FROM bank_runtime;
REVOKE UPDATE,DELETE ON bank_charge_cancellations FROM bank_runtime;
CREATE FUNCTION immutable_simulation_outcome() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.simulation_outcome<>OLD.simulation_outcome THEN
    RAISE EXCEPTION 'Simulation outcome is fixed at initialization' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bank_simulation_guard BEFORE UPDATE ON bank_operations FOR EACH ROW EXECUTE FUNCTION immutable_simulation_outcome();
