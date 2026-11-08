-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "bank_operations" (
    "operation_key" VARCHAR(150) NOT NULL,
    "amount_minor" DECIMAL NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'IRR',
    "status" VARCHAR(30) NOT NULL DEFAULT 'PENDING',
    "reference" VARCHAR(200),
    "initiated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deadline_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "bank_operations_pkey" PRIMARY KEY ("operation_key")
);

-- CreateTable
CREATE TABLE "bank_refunds" (
    "operation_key" VARCHAR(150) NOT NULL,
    "charge_key" VARCHAR(150) NOT NULL,
    "amount_minor" DECIMAL NOT NULL,
    "status" VARCHAR(30) NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_refunds_pkey" PRIMARY KEY ("operation_key")
);

-- CreateTable
CREATE TABLE "simulation_rules" (
    "reference" VARCHAR(80) NOT NULL,
    "outcome" VARCHAR(40) NOT NULL,
    "description" VARCHAR(500) NOT NULL,

    CONSTRAINT "simulation_rules_pkey" PRIMARY KEY ("reference")
);

-- CreateIndex
CREATE INDEX "bank_operations_status_deadline_at_idx" ON "bank_operations"("status", "deadline_at");

-- AddForeignKey
ALTER TABLE "bank_refunds" ADD CONSTRAINT "bank_refunds_charge_key_fkey" FOREIGN KEY ("charge_key") REFERENCES "bank_operations"("operation_key") ON DELETE RESTRICT ON UPDATE CASCADE;

