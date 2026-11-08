ALTER TABLE order_items
 ADD COLUMN retry_version integer NOT NULL DEFAULT 0 CHECK(retry_version>=0),
 ADD COLUMN cycle_start_attempt integer NOT NULL DEFAULT 0 CHECK(cycle_start_attempt>=0 AND cycle_start_attempt<=attempt_count),
 ADD COLUMN recovery_started_at timestamptz(6),
 ADD COLUMN infrastructure_failures integer NOT NULL DEFAULT 0 CHECK(infrastructure_failures>=0);
ALTER TABLE admission_budget ADD COLUMN storage_healthy boolean NOT NULL DEFAULT false,
 ADD COLUMN storage_checked_at timestamptz(6);
CREATE INDEX open_review_cursor ON review_cases(created_at,id) WHERE status='OPEN';
