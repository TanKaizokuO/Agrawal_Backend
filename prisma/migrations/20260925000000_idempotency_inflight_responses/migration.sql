-- Allow a unique idempotency row to reserve an operation before it runs.
ALTER TABLE "idempotency_record"
  ALTER COLUMN "response_status" DROP NOT NULL,
  ALTER COLUMN "response_body" DROP NOT NULL;

-- Preserve application response headers for exact retries.
ALTER TABLE "idempotency_record"
  ADD COLUMN "response_headers" JSONB;

-- Remove previously cached failures; only successful outcomes remain replayable.
DELETE FROM "idempotency_record"
WHERE "response_status" < 200 OR "response_status" >= 300;
