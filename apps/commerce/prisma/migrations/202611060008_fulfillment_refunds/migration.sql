ALTER TABLE orders ADD COLUMN fulfillment_started_at timestamptz(6), ADD COLUMN workflow_version integer NOT NULL DEFAULT 0 CHECK(workflow_version>=0);
ALTER TABLE orders DROP CONSTRAINT order_status;
ALTER TABLE orders ADD CONSTRAINT order_status CHECK(status IN ('CHECKOUT_RESERVED','CHECKOUT_EXPIRED','BASKET_CHANGED','PENDING_PAYMENT','PAYING','PAYMENT_REVIEW','PROCESSING','ATTENTION_REQUIRED','MANUAL_REVIEW','CANCELLATION_PENDING','PAYMENT_FAILED','COMPLETED','CANCELLED','RESOLVED'));
ALTER TABLE order_financial_projections ADD COLUMN refund_source_version integer NOT NULL DEFAULT 0 CHECK(refund_source_version>=0),
 ADD COLUMN summary varchar(30) NOT NULL DEFAULT 'NONE' CHECK(summary IN ('NONE','PARTIALLY_REFUNDED','REFUNDED'));
CREATE TABLE digital_entitlements(customer_id varchar(128) NOT NULL,product_id uuid NOT NULL REFERENCES products(id),created_at timestamptz(6) NOT NULL DEFAULT now(),PRIMARY KEY(customer_id,product_id));
CREATE TABLE digital_grants(item_id uuid PRIMARY KEY REFERENCES order_items(id),customer_id varchar(128) NOT NULL,product_id uuid NOT NULL REFERENCES products(id),created_at timestamptz(6) NOT NULL DEFAULT now());
CREATE TABLE subscriptions(customer_id varchar(128) NOT NULL,product_id uuid NOT NULL REFERENCES products(id),expires_at timestamptz(6) NOT NULL,PRIMARY KEY(customer_id,product_id));
CREATE TABLE subscription_extensions(item_id uuid PRIMARY KEY REFERENCES order_items(id),customer_id varchar(128) NOT NULL,product_id uuid NOT NULL REFERENCES products(id),days integer NOT NULL CHECK(days>0),previous_expires_at timestamptz(6),new_expires_at timestamptz(6) NOT NULL,created_at timestamptz(6) NOT NULL DEFAULT now());
CREATE TABLE shipments(item_id uuid PRIMARY KEY REFERENCES order_items(id),reservation_id uuid NOT NULL UNIQUE REFERENCES reservations(id),reference varchar(100) NOT NULL UNIQUE,created_at timestamptz(6) NOT NULL DEFAULT now());
CREATE TABLE fulfillment_attempts(id uuid PRIMARY KEY,item_id uuid NOT NULL REFERENCES order_items(id),attempt integer NOT NULL CHECK(attempt>0),result varchar(40) NOT NULL,reason varchar(100) NOT NULL,created_at timestamptz(6) NOT NULL DEFAULT now(),UNIQUE(item_id,attempt));
CREATE TABLE fulfillment_simulation_rules(item_id uuid PRIMARY KEY REFERENCES order_items(id),not_before timestamptz(6) NOT NULL DEFAULT now(),outcome varchar(30) NOT NULL DEFAULT 'SUCCESS' CHECK(outcome IN ('SUCCESS','TRANSIENT','PERMANENT')),fail_until_attempt integer NOT NULL DEFAULT 1 CHECK(fail_until_attempt>=0));
CREATE TABLE item_refund_dispositions(id uuid PRIMARY KEY,item_id uuid NOT NULL UNIQUE REFERENCES order_items(id),order_id uuid NOT NULL REFERENCES orders(id),operation_key varchar(150) NOT NULL UNIQUE,amount_minor numeric NOT NULL CHECK(valid_irr(amount_minor)),reason varchar(1000) NOT NULL,status varchar(30) NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','PROCESSING','UNKNOWN','SUCCEEDED','FAILED','REVIEW_REQUIRED')),source_version integer NOT NULL DEFAULT 0 CHECK(source_version>=0),billing_refund_id uuid,bank_reference varchar(200),created_at timestamptz(6) NOT NULL DEFAULT now());
CREATE INDEX disposition_order ON item_refund_dispositions(order_id,id);
CREATE TABLE refund_projection_logs(id uuid PRIMARY KEY,disposition_id uuid NOT NULL REFERENCES item_refund_dispositions(id),type varchar(80) NOT NULL,metadata jsonb NOT NULL,created_at timestamptz(6) NOT NULL);
CREATE INDEX refund_logs_cursor ON refund_projection_logs(disposition_id,created_at,id);
CREATE TABLE stock_dispositions(reservation_id uuid PRIMARY KEY REFERENCES reservations(id),disposition_id uuid NOT NULL UNIQUE REFERENCES item_refund_dispositions(id),kind varchar(30) NOT NULL CHECK(kind='MISSING'),actor_id varchar(128) NOT NULL,reason varchar(1000) NOT NULL,created_at timestamptz(6) NOT NULL DEFAULT now());
REVOKE INSERT,UPDATE,DELETE ON fulfillment_simulation_rules FROM commerce_runtime;
REVOKE UPDATE,DELETE ON digital_grants,subscription_extensions,shipments,fulfillment_attempts,refund_projection_logs,stock_dispositions FROM commerce_runtime;
REVOKE DELETE ON digital_entitlements,subscriptions,item_refund_dispositions FROM commerce_runtime;
CREATE FUNCTION guard_refund_disposition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE line numeric; item_state text;
BEGIN
 SELECT line_total_minor,status INTO line,item_state FROM order_items WHERE id=NEW.item_id AND order_id=NEW.order_id FOR UPDATE;
 IF line IS NULL OR line<>NEW.amount_minor OR item_state='SUCCEEDED' THEN RAISE EXCEPTION 'Refund requires an unfulfilled whole paid line' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND ROW(NEW.id,NEW.item_id,NEW.order_id,NEW.operation_key,NEW.amount_minor,NEW.reason) IS DISTINCT FROM ROW(OLD.id,OLD.item_id,OLD.order_id,OLD.operation_key,OLD.amount_minor,OLD.reason) THEN RAISE EXCEPTION 'Refund disposition identity is immutable' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND OLD.status='SUCCEEDED' AND NEW.status<>'SUCCEEDED' THEN RAISE EXCEPTION 'Confirmed refund is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER refund_disposition_guard BEFORE INSERT OR UPDATE ON item_refund_dispositions FOR EACH ROW EXECUTE FUNCTION guard_refund_disposition();
