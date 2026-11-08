-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "type" VARCHAR(20) NOT NULL,
    "price_minor" DECIMAL NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'IRR',
    "subscription_days" INTEGER,
    "digital_metadata" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory" (
    "product_id" UUID NOT NULL,
    "available" BIGINT NOT NULL DEFAULT 0,
    "observed_on_hand" BIGINT,
    "requires_review" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_pkey" PRIMARY KEY ("product_id")
);

-- CreateTable
CREATE TABLE "inventory_adjustments" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "actor_id" VARCHAR(128) NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "delta" BIGINT NOT NULL,
    "before_available" BIGINT NOT NULL,
    "after_available" BIGINT NOT NULL,
    "reason" VARCHAR(1000) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_discrepancies" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "counted_on_hand" BIGINT NOT NULL,
    "held_quantity" BIGINT NOT NULL,
    "shortage" BIGINT NOT NULL,
    "affected_reservations" JSONB NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'OPEN',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_discrepancies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "actor_id" VARCHAR(128) NOT NULL,
    "resource_id" UUID NOT NULL,
    "action" VARCHAR(80) NOT NULL,
    "reason" VARCHAR(1000) NOT NULL,
    "before" JSONB,
    "after" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "customer_id" VARCHAR(128) NOT NULL,
    "status" VARCHAR(40) NOT NULL DEFAULT 'CHECKOUT_RESERVED',
    "currency" VARCHAR(3) NOT NULL DEFAULT 'IRR',
    "total_minor" DECIMAL NOT NULL,
    "checkout_revision" INTEGER NOT NULL DEFAULT 1,
    "payment_version" INTEGER NOT NULL DEFAULT 0,
    "cancellation_requested" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "type" VARCHAR(20) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_price_minor" DECIMAL NOT NULL,
    "line_total_minor" DECIMAL NOT NULL,
    "subscription_days" INTEGER,
    "status" VARCHAR(30) NOT NULL DEFAULT 'PENDING',
    "disposition" VARCHAR(30) NOT NULL DEFAULT 'FULFILL',
    "generation" INTEGER NOT NULL DEFAULT 0,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6),

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "checkout_revisions" (
    "order_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "total_minor" DECIMAL NOT NULL,
    "confirmed" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "checkout_revisions_pkey" PRIMARY KEY ("order_id","version")
);

-- CreateTable
CREATE TABLE "reservations" (
    "id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "generation" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "status" VARCHAR(30) NOT NULL DEFAULT 'ACTIVE',
    "expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_events" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "type" VARCHAR(80) NOT NULL,
    "metadata" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_cases" (
    "id" UUID NOT NULL,
    "resource_id" UUID NOT NULL,
    "reason" VARCHAR(80) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'OPEN',
    "metadata" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "id" UUID NOT NULL,
    "actor_id" VARCHAR(128) NOT NULL,
    "operation" VARCHAR(120) NOT NULL,
    "key" VARCHAR(128) NOT NULL,
    "fingerprint" VARCHAR(64) NOT NULL,
    "response" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox" (
    "id" UUID NOT NULL,
    "kind" VARCHAR(100) NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "generation" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claim_token" UUID,
    "lease_until" TIMESTAMPTZ(6),
    "published_at" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consumer_receipts" (
    "consumer" VARCHAR(100) NOT NULL,
    "message_id" UUID NOT NULL,
    "handled_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consumer_receipts_pkey" PRIMARY KEY ("consumer","message_id")
);

-- CreateIndex
CREATE INDEX "inventory_adjustments_product_id_created_at_idx" ON "inventory_adjustments"("product_id", "created_at");

-- CreateIndex
CREATE INDEX "inventory_discrepancies_product_id_status_idx" ON "inventory_discrepancies"("product_id", "status");

-- CreateIndex
CREATE INDEX "audit_logs_resource_id_created_at_idx" ON "audit_logs"("resource_id", "created_at");

-- CreateIndex
CREATE INDEX "orders_customer_id_created_at_id_idx" ON "orders"("customer_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "orders_status_created_at_id_idx" ON "orders"("status", "created_at", "id");

-- CreateIndex
CREATE INDEX "order_items_order_id_status_idx" ON "order_items"("order_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "order_items_id_product_id_key" ON "order_items"("id", "product_id");

-- CreateIndex
CREATE INDEX "reservations_product_id_status_idx" ON "reservations"("product_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "reservations_item_id_generation_key" ON "reservations"("item_id", "generation");

-- CreateIndex
CREATE INDEX "order_events_order_id_created_at_id_idx" ON "order_events"("order_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "review_cases_status_created_at_idx" ON "review_cases"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_records_actor_id_operation_key_key" ON "idempotency_records"("actor_id", "operation", "key");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_kind_aggregate_id_generation_key" ON "outbox"("kind", "aggregate_id", "generation");

-- AddForeignKey
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "inventory_adjustments_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_discrepancies" ADD CONSTRAINT "inventory_discrepancies_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checkout_revisions" ADD CONSTRAINT "checkout_revisions_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_item_id_product_id_fkey" FOREIGN KEY ("item_id", "product_id") REFERENCES "order_items"("id", "product_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

