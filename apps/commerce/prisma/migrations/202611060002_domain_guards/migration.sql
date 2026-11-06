-- Custom guards intentionally kept in SQL: Prisma cannot express these invariants.
CREATE FUNCTION valid_irr(n NUMERIC) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT n >= 0 AND n = trunc(n) AND n NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
$$;
ALTER TABLE products ALTER COLUMN price_minor TYPE NUMERIC;
ALTER TABLE orders ALTER COLUMN total_minor TYPE NUMERIC;
ALTER TABLE order_items ALTER COLUMN unit_price_minor TYPE NUMERIC, ALTER COLUMN line_total_minor TYPE NUMERIC;
ALTER TABLE checkout_revisions ALTER COLUMN total_minor TYPE NUMERIC;
ALTER TABLE products ADD CONSTRAINT products_price_irr CHECK(valid_irr(price_minor) AND currency='IRR'),
  ADD CONSTRAINT products_kind CHECK(type IN ('DIGITAL','SUBSCRIPTION','PHYSICAL')),
  ADD CONSTRAINT products_duration CHECK((type='SUBSCRIPTION' AND subscription_days > 0) OR (type<>'SUBSCRIPTION' AND subscription_days IS NULL)),
  ADD CONSTRAINT products_metadata CHECK(type='DIGITAL' OR digital_metadata IS NULL),
  ADD CONSTRAINT products_version CHECK(version > 0);
ALTER TABLE inventory ADD CONSTRAINT inventory_nonnegative CHECK(available >= 0),
  ADD CONSTRAINT inventory_observed CHECK(observed_on_hand IS NULL OR observed_on_hand >= 0),
  ADD CONSTRAINT inventory_version CHECK(version > 0);
ALTER TABLE inventory_adjustments ADD CONSTRAINT adjustments_consistent CHECK(before_available >= 0 AND after_available >= 0 AND delta=after_available-before_available),
  ADD CONSTRAINT adjustments_kind CHECK(kind IN ('ADJUST','RECONCILE'));
ALTER TABLE inventory_discrepancies ADD CONSTRAINT discrepancy_amounts CHECK(counted_on_hand >= 0 AND held_quantity >= 0 AND shortage > 0 AND shortage=held_quantity-counted_on_hand),
  ADD CONSTRAINT discrepancy_status CHECK(status IN ('OPEN','RESOLVED'));
ALTER TABLE orders ADD CONSTRAINT order_amount CHECK(valid_irr(total_minor) AND currency='IRR'),
  ADD CONSTRAINT order_versions CHECK(checkout_revision > 0 AND payment_version >= 0),
  ADD CONSTRAINT order_status CHECK(status IN ('CHECKOUT_RESERVED','CHECKOUT_EXPIRED','BASKET_CHANGED','PENDING_PAYMENT','PAYING','PAYMENT_REVIEW','PROCESSING','ATTENTION_REQUIRED','MANUAL_REVIEW','CANCELLATION_PENDING','PAYMENT_FAILED','COMPLETED','CANCELLED'));
ALTER TABLE order_items ADD CONSTRAINT item_amounts CHECK(valid_irr(unit_price_minor) AND valid_irr(line_total_minor) AND line_total_minor=unit_price_minor*quantity),
  ADD CONSTRAINT item_quantity CHECK(quantity > 0 AND (type='PHYSICAL' OR quantity=1)),
  ADD CONSTRAINT item_type CHECK(type IN ('DIGITAL','SUBSCRIPTION','PHYSICAL')),
  ADD CONSTRAINT item_duration CHECK((type='SUBSCRIPTION' AND subscription_days > 0) OR (type<>'SUBSCRIPTION' AND subscription_days IS NULL)),
  ADD CONSTRAINT item_state CHECK(status IN ('PENDING','PROCESSING','RETRY_WAIT','SUCCEEDED','FAILED','MANUAL_REVIEW','CANCELLED')),
  ADD CONSTRAINT item_disposition CHECK(disposition IN ('FULFILL','REFUND','CANCEL')),
  ADD CONSTRAINT item_attempts CHECK(generation >= 0 AND attempt_count >= 0);
ALTER TABLE checkout_revisions ADD CONSTRAINT revision_amount CHECK(valid_irr(total_minor) AND version > 0);
ALTER TABLE reservations ADD CONSTRAINT reservation_quantity CHECK(quantity > 0 AND generation >= 0),
  ADD CONSTRAINT reservation_state CHECK(status IN ('ACTIVE','PAYMENT_PENDING','ALLOCATED','CONSUMED','EXPIRED','RELEASED','DISPUTED')),
  ADD CONSTRAINT reservation_expiry CHECK(status<>'ACTIVE' OR expires_at IS NOT NULL);
CREATE UNIQUE INDEX reservations_one_live_item ON reservations(item_id) WHERE status IN ('ACTIVE','PAYMENT_PENDING','ALLOCATED','DISPUTED');
CREATE INDEX reservations_due ON reservations(expires_at) WHERE status='ACTIVE';
CREATE INDEX item_retry_due ON order_items(next_attempt_at) WHERE status='RETRY_WAIT';
CREATE INDEX outbox_due ON outbox(available_at,id) WHERE published_at IS NULL;
ALTER TABLE outbox ADD CONSTRAINT outbox_version CHECK(generation >= 0 AND attempts >= 0),
  ADD CONSTRAINT outbox_lease CHECK((claim_token IS NULL)=(lease_until IS NULL));
ALTER TABLE idempotency_records ADD CONSTRAINT request_fingerprint CHECK(fingerprint ~ '^[a-f0-9]{64}$');
ALTER TABLE review_cases ADD CONSTRAINT review_state CHECK(status IN ('OPEN','RESOLVED'));

CREATE FUNCTION guard_inventory_type() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM products WHERE id=NEW.product_id AND type='PHYSICAL') THEN
    RAISE EXCEPTION 'Inventory requires a physical product' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inventory_physical BEFORE INSERT OR UPDATE ON inventory FOR EACH ROW EXECUTE FUNCTION guard_inventory_type();
CREATE FUNCTION immutable_product_type() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.type <> OLD.type THEN RAISE EXCEPTION 'Create a new product to change type' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER product_type_immutable BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION immutable_product_type();
CREATE FUNCTION guard_paid_order_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status NOT IN ('CHECKOUT_RESERVED','CHECKOUT_EXPIRED','BASKET_CHANGED','PENDING_PAYMENT') AND
    ROW(NEW.customer_id,NEW.total_minor,NEW.currency,NEW.checkout_revision) IS DISTINCT FROM
    ROW(OLD.customer_id,OLD.total_minor,OLD.currency,OLD.checkout_revision) THEN
    RAISE EXCEPTION 'Payment/paid order snapshot is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER paid_order_snapshot BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION guard_paid_order_snapshot();
CREATE FUNCTION guard_paid_item_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_state text;
BEGIN
  SELECT status INTO parent_state FROM orders WHERE id=OLD.order_id;
  IF parent_state NOT IN ('CHECKOUT_RESERVED','CHECKOUT_EXPIRED','BASKET_CHANGED','PENDING_PAYMENT') AND
    ROW(NEW.order_id,NEW.product_id,NEW.name,NEW.type,NEW.quantity,NEW.unit_price_minor,NEW.line_total_minor,NEW.subscription_days) IS DISTINCT FROM
    ROW(OLD.order_id,OLD.product_id,OLD.name,OLD.type,OLD.quantity,OLD.unit_price_minor,OLD.line_total_minor,OLD.subscription_days) THEN
    RAISE EXCEPTION 'Paid item snapshot is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER paid_item_snapshot BEFORE UPDATE ON order_items FOR EACH ROW EXECUTE FUNCTION guard_paid_item_snapshot();
REVOKE UPDATE, DELETE ON audit_logs, inventory_adjustments, order_events FROM commerce_runtime;
REVOKE ALL ON _prisma_migrations FROM commerce_runtime;
