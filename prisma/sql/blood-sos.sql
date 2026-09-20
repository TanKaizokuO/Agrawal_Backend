-- ---------------------------------------------------------------------------
-- Blood SOS module — constraints that Prisma cannot express.
-- Run after the Prisma schema, and keep this script idempotent.
-- ---------------------------------------------------------------------------

-- A requester may have any number of historical requests, but only one live
-- request. This is the concurrency guard for the create route.
CREATE UNIQUE INDEX IF NOT EXISTS blood_sos_one_active_per_member
  ON blood_sos_request (requester_member_id)
  WHERE status = 'ACTIVE';

-- Matching and accounting values are domain invariants, not client input.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'blood_sos_request_current_tier_ck'
  ) THEN
    ALTER TABLE blood_sos_request
      ADD CONSTRAINT blood_sos_request_current_tier_ck
      CHECK (current_tier BETWEEN 1 AND 3);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'blood_sos_request_reach_nonnegative_ck'
  ) THEN
    ALTER TABLE blood_sos_request
      ADD CONSTRAINT blood_sos_request_reach_nonnegative_ck
      CHECK (donor_reach_total >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'blood_sos_alert_tier_ck'
  ) THEN
    ALTER TABLE blood_sos_alert
      ADD CONSTRAINT blood_sos_alert_tier_ck
      CHECK (tier BETWEEN 1 AND 3);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'blood_sos_alert_accepted_consistent_ck'
  ) THEN
    ALTER TABLE blood_sos_alert
      ADD CONSTRAINT blood_sos_alert_accepted_consistent_ck
      CHECK (accepted IN (TRUE, FALSE));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'donor_alert_day_count_nonnegative_ck'
  ) THEN
    ALTER TABLE donor_alert_day
      ADD CONSTRAINT donor_alert_day_count_nonnegative_ck
      CHECK (count >= 0);
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS blood_sos_alert_request_tier_idx
  ON blood_sos_alert (request_id, tier);

CREATE INDEX IF NOT EXISTS blood_sos_response_request_created_idx
  ON blood_sos_response (request_id, created_at);
