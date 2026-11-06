CREATE FUNCTION guard_fulfillment_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected_type text;
BEGIN
 expected_type:=CASE TG_TABLE_NAME WHEN 'digital_grants' THEN 'DIGITAL' WHEN 'subscription_extensions' THEN 'SUBSCRIPTION' ELSE 'PHYSICAL' END;
 IF NOT EXISTS(SELECT 1 FROM order_items i JOIN orders o ON o.id=i.order_id JOIN order_financial_projections f ON f.order_id=o.id
   WHERE i.id=NEW.item_id AND i.type=expected_type AND i.status='PROCESSING' AND i.disposition='FULFILL'
   AND NOT o.cancellation_requested AND f.status='SUCCEEDED' AND f.revision=o.checkout_revision) THEN
  RAISE EXCEPTION 'Effect requires eligible paid typed work' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER grant_eligibility BEFORE INSERT ON digital_grants FOR EACH ROW EXECUTE FUNCTION guard_fulfillment_evidence();
CREATE TRIGGER extension_eligibility BEFORE INSERT ON subscription_extensions FOR EACH ROW EXECUTE FUNCTION guard_fulfillment_evidence();
CREATE TRIGGER shipment_eligibility BEFORE INSERT ON shipments FOR EACH ROW EXECUTE FUNCTION guard_fulfillment_evidence();
CREATE FUNCTION guard_item_resolution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status='SUCCEEDED' AND (NEW.status<>'SUCCEEDED' OR NEW.disposition<>'FULFILL') THEN RAISE EXCEPTION 'Successful item is immutable' USING ERRCODE='23514'; END IF;
 IF NEW.status='SUCCEEDED' AND (EXISTS(SELECT 1 FROM item_refund_dispositions WHERE item_id=NEW.id) OR
   NOT CASE NEW.type WHEN 'DIGITAL' THEN EXISTS(SELECT 1 FROM digital_grants WHERE item_id=NEW.id)
    WHEN 'SUBSCRIPTION' THEN EXISTS(SELECT 1 FROM subscription_extensions WHERE item_id=NEW.id)
    ELSE EXISTS(SELECT 1 FROM shipments WHERE item_id=NEW.id) END) THEN
  RAISE EXCEPTION 'Item success requires unique effect and no refund disposition' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER item_resolution_guard BEFORE UPDATE ON order_items FOR EACH ROW EXECUTE FUNCTION guard_item_resolution();
