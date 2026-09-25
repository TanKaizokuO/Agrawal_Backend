CREATE TABLE "refund_attempt" (
  "refund_id" TEXT NOT NULL,
  "attempt_number" INTEGER NOT NULL,
  "razorpay_refund_id" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "refund_attempt_pkey" PRIMARY KEY ("refund_id", "attempt_number"),
  CONSTRAINT "refund_attempt_refund_id_fkey" FOREIGN KEY ("refund_id") REFERENCES "refund"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "refund_attempt_number_nonnegative_ck" CHECK ("attempt_number" >= 0),
  CONSTRAINT "refund_attempt_razorpay_refund_id_key" UNIQUE ("razorpay_refund_id")
);

INSERT INTO "refund_attempt" ("refund_id", "attempt_number", "razorpay_refund_id")
SELECT r."id", (provider_attempt.ordinality - 1)::INTEGER, provider_attempt.provider_refund_id
FROM "refund" r
CROSS JOIN LATERAL unnest(r."provider_refund_ids") WITH ORDINALITY AS provider_attempt(provider_refund_id, ordinality)
WHERE provider_attempt.provider_refund_id IS NOT NULL
ON CONFLICT ("refund_id", "attempt_number") DO UPDATE
SET "razorpay_refund_id" = EXCLUDED."razorpay_refund_id";

INSERT INTO "refund_attempt" ("refund_id", "attempt_number", "razorpay_refund_id")
SELECT "id", "attempt_number", "razorpay_refund_id"
FROM "refund"
WHERE "razorpay_refund_id" IS NOT NULL
ON CONFLICT ("refund_id", "attempt_number") DO UPDATE
SET "razorpay_refund_id" = EXCLUDED."razorpay_refund_id";

CREATE TABLE restricted.refund_attempt (
  refund_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  razorpay_refund_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  retain_until TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (refund_id, attempt_number),
  CHECK (attempt_number >= 0),
  UNIQUE (razorpay_refund_id)
);

INSERT INTO restricted.refund_attempt (
  refund_id, attempt_number, razorpay_refund_id, retain_until
)
SELECT r.id, (provider_attempt.ordinality - 1)::INTEGER,
       provider_attempt.provider_refund_id, r.retain_until
FROM restricted.refund r
CROSS JOIN LATERAL unnest(r.provider_refund_ids) WITH ORDINALITY AS provider_attempt(provider_refund_id, ordinality)
WHERE provider_attempt.provider_refund_id IS NOT NULL
ON CONFLICT (refund_id, attempt_number) DO UPDATE
SET razorpay_refund_id = EXCLUDED.razorpay_refund_id;

INSERT INTO restricted.refund_attempt (
  refund_id, attempt_number, razorpay_refund_id, retain_until
)
SELECT id, attempt_number, razorpay_refund_id, retain_until
FROM restricted.refund
WHERE razorpay_refund_id IS NOT NULL
ON CONFLICT (refund_id, attempt_number) DO UPDATE
SET razorpay_refund_id = EXCLUDED.razorpay_refund_id;

CREATE INDEX restricted_refund_attempt_retain_idx
  ON restricted.refund_attempt (retain_until);

ALTER TABLE "refund" DROP COLUMN "provider_refund_ids";
ALTER TABLE restricted.refund DROP COLUMN provider_refund_ids;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'agrawal_app'
  ) THEN
    EXECUTE 'GRANT INSERT ON TABLE restricted.refund_attempt TO agrawal_app';
  END IF;
END;
$$;
CREATE OR REPLACE FUNCTION restricted.purge_expired()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  DELETE FROM restricted.consent_event WHERE retain_until < now();
  DELETE FROM restricted.payment WHERE retain_until < now();
  DELETE FROM restricted.refund_attempt WHERE retain_until < now();
  DELETE FROM restricted.refund WHERE retain_until < now();
  DELETE FROM restricted.member_tombstone WHERE retain_until < now();
$$;
