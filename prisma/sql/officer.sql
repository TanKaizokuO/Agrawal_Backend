-- ---------------------------------------------------------------------------
-- Officer module — Processing Record protections and append-only indexes.
-- Run after the Prisma schema has created processing_record and flag.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS processing_record_subject_idx
  ON processing_record (subject_type, subject_id);

CREATE INDEX IF NOT EXISTS processing_record_actor_at_idx
  ON processing_record (actor_id, "at");

CREATE INDEX IF NOT EXISTS processing_record_retain_idx
  ON processing_record (retain_until);

CREATE INDEX IF NOT EXISTS flag_status_created_idx
  ON flag (status, created_at);

CREATE INDEX IF NOT EXISTS flag_subject_idx
  ON flag (subject_type, subject_id);

-- Keep the app role least-privileged. Deployment grants INSERT and SELECT to
-- the app role explicitly, and grants DELETE of expired rows only to the
-- retention worker role. Role names are environment-specific and therefore
-- are not hard-coded in this repository.
REVOKE UPDATE, DELETE ON TABLE processing_record FROM PUBLIC;


-- These checks keep the record vocabulary closed even when a migration or a
-- retention tool writes outside Prisma. New governed actions are added here
-- together with the ProcessingAction union in the module interface.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'processing_record_actor_kind_check'
  ) THEN
    ALTER TABLE processing_record
      ADD CONSTRAINT processing_record_actor_kind_check
      CHECK (actor_kind IN ('OFFICER', 'OPERATOR', 'MEMBER', 'SYSTEM'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'processing_record_action_check'
  ) THEN
    ALTER TABLE processing_record
      ADD CONSTRAINT processing_record_action_check
      CHECK (action IN (
        'MEMBER_ERASED',
        'ERASURE_REQUESTED',
        'FLAG_RESOLVED',
        'IMAGE_REMOVED',
        'IMAGE_OVERRIDE_APPROVED',
        'OFFICER_IMAGES_VIEWED',
        'OFFICER_MEMBER_LOOKUP',
        'NOMINEE_READ',
        'REFUND_REQUESTED',
        'HEAD_SUCCEEDED',
        'FAMILY_ARCHIVED',
        'MEMBER_ARCHIVED',
        'MEMBER_UNARCHIVED',
        'SUSPENSION_LIFTED',
        'NOTICE_RESTORED',
        'ARCHIVAL_RESOLVED_BY_OFFICER',
        'ROLE_GRANTED',
        'ROLE_REVOKED',
        'BLOOD_SOS_REPORT_RESOLVED',
        'PASS_REVOKED'
      ));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'processing_record_subject_type_check'
  ) THEN
    ALTER TABLE processing_record
      ADD CONSTRAINT processing_record_subject_type_check
      CHECK (subject_type IN (
        'MEMBER',
        'FAMILY',
        'IMAGE',
        'PAYMENT',
        'NOTICE',
        'FLAG',
        'REGISTRATION',
        'SUSPENSION',
        'ARCHIVAL_REQUEST',
        'BLOOD_SOS',
        'EVENT_PASS'
      ));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'processing_record_actor_id_check'
  ) THEN
    ALTER TABLE processing_record
      ADD CONSTRAINT processing_record_actor_id_check
      CHECK (
        (actor_kind = 'SYSTEM' AND actor_id IS NULL)
        OR (actor_kind <> 'SYSTEM' AND actor_id IS NOT NULL)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'processing_record_subject_id_check'
  ) THEN
    ALTER TABLE processing_record
      ADD CONSTRAINT processing_record_subject_id_check
      CHECK (length(subject_id) > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'processing_record_retention_check'
  ) THEN
    ALTER TABLE processing_record
      ADD CONSTRAINT processing_record_retention_check
      CHECK (retain_until >= "at");
  END IF;
END;
$$;
CREATE OR REPLACE FUNCTION officer_processing_record_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'processing records are append-only'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF TG_OP = 'DELETE' AND OLD.retain_until > CURRENT_TIMESTAMP THEN
    RAISE EXCEPTION 'processing records are retained until %', OLD.retain_until
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS processing_record_append_only ON processing_record;
CREATE TRIGGER processing_record_append_only
BEFORE UPDATE OR DELETE ON processing_record
FOR EACH ROW
EXECUTE FUNCTION officer_processing_record_guard();

-- Provisioning (outside this migration) must apply the following grants:
-- GRANT INSERT, SELECT ON processing_record TO app_role;
-- REVOKE UPDATE, DELETE ON processing_record FROM app_role;
-- GRANT EXECUTE ON FUNCTION purge_expired_processing_records() TO app_role;
