ALTER TYPE "RefundStatus" ADD VALUE IF NOT EXISTS 'PROCESSING' BEFORE 'PROCESSED';

ALTER TABLE "refund"
  ADD COLUMN "processing_started_at" TIMESTAMPTZ(6);
ALTER TABLE "refund"
  ADD COLUMN "attempt_number" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "refund"
  ADD COLUMN "provider_refund_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];


ALTER TABLE restricted.refund
  ADD COLUMN attempt_number INTEGER NOT NULL DEFAULT 0;
ALTER TABLE restricted.refund
  ADD COLUMN provider_refund_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "refund"
  ADD CONSTRAINT "refund_attempt_number_nonnegative_ck"
  CHECK ("attempt_number" >= 0);

CREATE INDEX "refund_status_processing_started_idx"
  ON "refund"("status", "processing_started_at");

CREATE INDEX "payment_status_consumed_idx"
  ON "payment"("status", "consumed_at");

CREATE TABLE "payment_order_claim" (
  "purpose" "PaymentPurpose" NOT NULL,
  "subject_id" TEXT NOT NULL,
  "payment_id" TEXT NOT NULL,
  "amount_paise" INTEGER NOT NULL,
  "attempted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "payment_order_claim_pkey" PRIMARY KEY ("purpose", "subject_id")
);

CREATE UNIQUE INDEX "payment_order_claim_payment_id_key"
  ON "payment_order_claim"("payment_id");
CREATE INDEX "payment_order_claim_attempted_at_idx"
  ON "payment_order_claim"("attempted_at");

CREATE TABLE "payment_outbox_job" (
  "id" TEXT NOT NULL,
  "event_key" TEXT NOT NULL,
  "job_name" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "claimed_at" TIMESTAMPTZ(6),
  "dispatched_at" TIMESTAMPTZ(6),

  CONSTRAINT "payment_outbox_job_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "payment_outbox_job_event_key_key"
  ON "payment_outbox_job"("event_key");
CREATE INDEX "payment_outbox_pending_idx"
  ON "payment_outbox_job"("dispatched_at", "created_at");
