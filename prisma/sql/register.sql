-- ---------------------------------------------------------------------------
-- Register module — raw SQL beyond what Prisma can express.
-- Run once during environment provisioning, idempotent.
-- ---------------------------------------------------------------------------

-- Extensions required for directory search.
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "unaccent";

-- ---------------------------------------------------------------------------
-- GIN trigram indexes for directory search on Member name / city columns.
-- ---------------------------------------------------------------------------
CREATE INDEX CONCURRENTLY IF NOT EXISTS member_name_en_trgm_idx
  ON member USING gin (name_en gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS member_name_hi_trgm_idx
  ON member USING gin (name_hi gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS member_name_en_search_key_trgm_idx
  ON member USING gin (name_en_search_key gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS member_city_key_trgm_idx
  ON member USING gin (city_key gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- Restricted schema — holds data moved out of live tables on Erasure.
-- The app role can INSERT only; the purgeRestricted job deletes expired rows
-- through the owner-owned SECURITY DEFINER function restricted.purge_expired().
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS restricted;

CREATE TABLE IF NOT EXISTS restricted.member_tombstone (
  member_id   TEXT        NOT NULL PRIMARY KEY,
  erased_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  retain_until TIMESTAMPTZ NOT NULL
);

-- Copies of the erased Member's Payments.
CREATE TABLE IF NOT EXISTS restricted.payment (
  id                  TEXT        NOT NULL PRIMARY KEY,
  purpose             TEXT        NOT NULL,
  subject_id          TEXT        NOT NULL,
  payer_phone_e164    TEXT        NOT NULL,
  payer_member_id     TEXT,
  amount_paise        INT         NOT NULL,
  currency            TEXT        NOT NULL DEFAULT 'INR',
  status              TEXT        NOT NULL,
  razorpay_order_id   TEXT        NOT NULL,
  razorpay_payment_id TEXT,
  method              TEXT,
  identity_kind       TEXT,
  identity_hash       TEXT,
  identity_masked     TEXT,
  captured_at         TIMESTAMPTZ,
  failed_at           TIMESTAMPTZ,
  failure_reason      TEXT,
  consumed_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  retain_until        TIMESTAMPTZ NOT NULL
);

-- Copies of the erased Member's Refunds.
CREATE TABLE IF NOT EXISTS restricted.refund (
  id                TEXT        NOT NULL PRIMARY KEY,
  payment_id        TEXT        NOT NULL,
  reason            TEXT        NOT NULL,
  amount_paise      INT         NOT NULL,
  razorpay_refund_id TEXT,
  status            TEXT        NOT NULL,
  requested_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at      TIMESTAMPTZ,
  failure_reason    TEXT,
  retain_until      TIMESTAMPTZ NOT NULL
);

-- Consent history of erased Members.
CREATE TABLE IF NOT EXISTS restricted.consent_event (
  id        TEXT        NOT NULL PRIMARY KEY,
  member_id TEXT        NOT NULL,
  toggle    TEXT        NOT NULL,
  value     BOOLEAN     NOT NULL,
  source    TEXT        NOT NULL,
  at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  retain_until TIMESTAMPTZ NOT NULL
);

-- ---------------------------------------------------------------------------
-- Grants for the app role on restricted tables (INSERT only).
-- The role name is a placeholder; deployment provisioning replaces it.
-- ---------------------------------------------------------------------------
-- GRANT INSERT ON ALL TABLES IN SCHEMA restricted TO app_role;
-- GRANT EXECUTE ON FUNCTION restricted.purge_expired() TO app_role;
-- ---------------------------------------------------------------------------
-- Immutable identifiers and lineage.
-- Family IDs, the minting pincode and Gotra are issued once and cannot be
-- changed by an application update.  Phone ownership is likewise immutable:
-- a phone is freed only by deleting the Member during Erasure.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION register_reject_immutable_member_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.phone_e164 IS DISTINCT FROM OLD.phone_e164 THEN
    RAISE EXCEPTION 'member phone_e164 is immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS member_immutable_phone ON member;
CREATE TRIGGER member_immutable_phone
BEFORE UPDATE OF phone_e164 ON member
FOR EACH ROW
EXECUTE FUNCTION register_reject_immutable_member_update();

CREATE OR REPLACE FUNCTION register_reject_immutable_family_identifiers()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.public_id IS DISTINCT FROM OLD.public_id
    OR NEW.gotra IS DISTINCT FROM OLD.gotra
    OR NEW.pincode_snapshot IS DISTINCT FROM OLD.pincode_snapshot THEN
    RAISE EXCEPTION 'family public identifiers are immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS family_immutable_identifiers ON family;
CREATE TRIGGER family_immutable_identifiers
BEFORE UPDATE OF public_id, gotra, pincode_snapshot ON family
FOR EACH ROW
EXECUTE FUNCTION register_reject_immutable_family_identifiers();

CREATE INDEX IF NOT EXISTS restricted_payment_member_retain_idx
  ON restricted.payment (payer_member_id, retain_until);

CREATE INDEX IF NOT EXISTS restricted_refund_retain_idx
  ON restricted.refund (retain_until);

CREATE INDEX IF NOT EXISTS restricted_consent_member_retain_idx
  ON restricted.consent_event (member_id, retain_until);

CREATE INDEX IF NOT EXISTS restricted_tombstone_retain_idx
  ON restricted.member_tombstone (retain_until);
