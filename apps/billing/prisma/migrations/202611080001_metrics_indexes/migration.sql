CREATE INDEX payments_unresolved_status_age_idx ON payments(status,created_at) WHERE status IN ('PENDING','PROCESSING','UNKNOWN');
CREATE INDEX refunds_unconfirmed_idx ON refunds(id) WHERE status<>'SUCCEEDED';
