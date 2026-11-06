-- Business processing changes states; deleting identity/snapshot evidence is not a runtime action.
REVOKE DELETE ON products, inventory, orders, order_items, checkout_revisions, reservations,
  idempotency_records, inventory_discrepancies, review_cases FROM commerce_runtime;
