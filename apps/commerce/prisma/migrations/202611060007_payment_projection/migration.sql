ALTER TABLE order_financial_projections ADD COLUMN operation_key varchar(150),
  ADD COLUMN bank_reference varchar(200), ADD COLUMN bank_deadline_at timestamptz(6);
