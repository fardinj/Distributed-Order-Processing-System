-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "operation_key" VARCHAR(150) NOT NULL,
    "customer_id" VARCHAR(128) NOT NULL,
    "amount_minor" DECIMAL NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'IRR',
    "status" VARCHAR(30) NOT NULL DEFAULT 'PENDING',
    "version" INTEGER NOT NULL DEFAULT 1,
    "next_reconcile_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_attempts" (
    "id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "kind" VARCHAR(30) NOT NULL,
    "result" VARCHAR(40) NOT NULL,
    "metadata" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refunds" (
    "id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "disposition_id" UUID NOT NULL,
    "operation_key" VARCHAR(150) NOT NULL,
    "amount_minor" DECIMAL NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'IRR',
    "status" VARCHAR(30) NOT NULL DEFAULT 'PENDING',
    "reason" VARCHAR(1000) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "next_reconcile_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refund_items" (
    "refund_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "amount_minor" DECIMAL NOT NULL,

    CONSTRAINT "refund_items_pkey" PRIMARY KEY ("refund_id","item_id")
);

-- CreateTable
CREATE TABLE "refund_logs" (
    "id" UUID NOT NULL,
    "refund_id" UUID NOT NULL,
    "type" VARCHAR(80) NOT NULL,
    "metadata" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refund_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_cancellations" (
    "operation_key" VARCHAR(150) NOT NULL,
    "status" VARCHAR(30) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_cancellations_pkey" PRIMARY KEY ("operation_key")
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
CREATE UNIQUE INDEX "payments_order_id_key" ON "payments"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_operation_key_key" ON "payments"("operation_key");

-- CreateIndex
CREATE INDEX "payment_attempts_payment_id_created_at_idx" ON "payment_attempts"("payment_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_disposition_id_key" ON "refunds"("disposition_id");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_operation_key_key" ON "refunds"("operation_key");

-- CreateIndex
CREATE INDEX "refund_logs_refund_id_created_at_id_idx" ON "refund_logs"("refund_id", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_kind_aggregate_id_generation_key" ON "outbox"("kind", "aggregate_id", "generation");

-- AddForeignKey
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund_items" ADD CONSTRAINT "refund_items_refund_id_fkey" FOREIGN KEY ("refund_id") REFERENCES "refunds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund_logs" ADD CONSTRAINT "refund_logs_refund_id_fkey" FOREIGN KEY ("refund_id") REFERENCES "refunds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

