-- Preserve historical records; the sequence orders new events even inside one transaction.
ALTER TABLE order_events ADD COLUMN sequence bigint GENERATED ALWAYS AS IDENTITY;
CREATE INDEX order_events_order_sequence_idx ON order_events(order_id,sequence);
CREATE INDEX orders_customer_status_created_id_idx ON orders(customer_id,status,created_at,id);
CREATE INDEX order_items_retry_wait_idx ON order_items(id) WHERE status='RETRY_WAIT';
CREATE INDEX order_financial_unknown_idx ON order_financial_projections(order_id) WHERE status='UNKNOWN';
