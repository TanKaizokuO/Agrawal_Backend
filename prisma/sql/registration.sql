-- ---------------------------------------------------------------------------
-- Registration module — raw SQL invariants Prisma cannot express.
-- ---------------------------------------------------------------------------

-- A phone can have only one Registration that can still change.  Terminal
-- records remain for the statutory/payment history and do not block a fresh
-- sign-in.
CREATE UNIQUE INDEX IF NOT EXISTS registration_one_live_per_phone
  ON registration (phone_e164)
  WHERE status IN ('STARTED', 'PAID', 'AWAITING_HEAD');

-- The service takes a row/advisory lock before changing a Registration, but
-- this trigger is the final database-owned guard against stale writers and
-- accidental skips in the state machine.
CREATE OR REPLACE FUNCTION registration_reject_invalid_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
      (OLD.status = 'STARTED' AND NEW.status IN ('PAID', 'ABANDONED'))
      OR (OLD.status = 'PAID' AND NEW.status IN ('AWAITING_HEAD', 'COMPLETED', 'ABANDONED'))
      OR (OLD.status = 'AWAITING_HEAD' AND NEW.status IN ('COMPLETED', 'CANCELLED', 'DECLINED', 'EXPIRED'))
    ) THEN
      RAISE EXCEPTION 'invalid registration status transition: % -> %', OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.status = 'AWAITING_HEAD' THEN
    IF NEW.route IS DISTINCT FROM 'JOIN'
      OR NEW.join_family_id IS NULL
      OR NEW.submitted_profile IS NULL
      OR NEW.submitted_at IS NULL
      OR NEW.expires_at IS NULL THEN
      RAISE EXCEPTION 'awaiting-head registration is incomplete'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.expires_at IS NOT NULL THEN
    RAISE EXCEPTION 'only awaiting-head registrations may have expires_at'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status = 'COMPLETED' THEN
    IF NEW.completed_member_id IS NULL OR NEW.ended_at IS NULL OR NEW.submitted_profile IS NOT NULL THEN
      RAISE EXCEPTION 'completed registration is incomplete or still retains profile data'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.status IN ('ABANDONED', 'CANCELLED', 'DECLINED', 'EXPIRED') THEN
    IF NEW.ended_at IS NULL OR NEW.submitted_profile IS NOT NULL THEN
      RAISE EXCEPTION 'ended registration is incomplete or still retains profile data'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.route = 'JOIN' AND NEW.join_family_id IS NULL
    AND NEW.status NOT IN ('STARTED', 'PAID') THEN
    RAISE EXCEPTION 'joining registration must retain its family'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS registration_state_invariants ON registration;
CREATE TRIGGER registration_state_invariants
BEFORE INSERT OR UPDATE OF status, route, join_family_id, submitted_profile,
  submitted_at, expires_at, ended_at, completed_member_id
ON registration
EXECUTE FUNCTION registration_reject_invalid_transition();
