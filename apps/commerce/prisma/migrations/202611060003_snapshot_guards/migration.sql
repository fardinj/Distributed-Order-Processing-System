-- CHECK accepts SQL NULL; require an explicit duration for subscriptions.
ALTER TABLE products DROP CONSTRAINT products_duration;
ALTER TABLE products ADD CONSTRAINT products_duration CHECK(
  (type='SUBSCRIPTION' AND subscription_days IS NOT NULL AND subscription_days > 0) OR
  (type<>'SUBSCRIPTION' AND subscription_days IS NULL));
ALTER TABLE order_items DROP CONSTRAINT item_duration;
ALTER TABLE order_items ADD CONSTRAINT item_duration CHECK(
  (type='SUBSCRIPTION' AND subscription_days IS NOT NULL AND subscription_days > 0) OR
  (type<>'SUBSCRIPTION' AND subscription_days IS NULL));
CREATE FUNCTION guard_item_product_type() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM products WHERE id=NEW.product_id AND type=NEW.type) THEN
    RAISE EXCEPTION 'Item type must match immutable product type' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER item_product_type BEFORE INSERT OR UPDATE ON order_items FOR EACH ROW EXECUTE FUNCTION guard_item_product_type();
CREATE FUNCTION guard_physical_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM order_items WHERE id=NEW.item_id AND product_id=NEW.product_id AND type='PHYSICAL') THEN
    RAISE EXCEPTION 'Reservation requires a physical item' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER physical_reservation BEFORE INSERT OR UPDATE ON reservations FOR EACH ROW EXECUTE FUNCTION guard_physical_reservation();
CREATE FUNCTION immutable_checkout_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.order_id,NEW.version,NEW.snapshot,NEW.total_minor) IS DISTINCT FROM ROW(OLD.order_id,OLD.version,OLD.snapshot,OLD.total_minor) THEN
    RAISE EXCEPTION 'Insert a new checkout revision instead of rewriting it' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER checkout_revision_snapshot BEFORE UPDATE ON checkout_revisions FOR EACH ROW EXECUTE FUNCTION immutable_checkout_revision();
