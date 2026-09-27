-- Tier 0 means "created, tier-one fanout not yet committed" (see
-- 20260925000100_blood_sos_durable_work). The foundation check only allowed
-- 1..3, so every insert with the new default failed. This sorts before the
-- durable-work migration on fresh databases and is idempotent so it can also
-- be applied after it on databases that already ran that migration.
ALTER TABLE "blood_sos_request"
  DROP CONSTRAINT IF EXISTS blood_sos_request_current_tier_ck;

ALTER TABLE "blood_sos_request"
  ADD CONSTRAINT blood_sos_request_current_tier_ck
  CHECK (current_tier BETWEEN 0 AND 3);
