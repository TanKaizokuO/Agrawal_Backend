-- ---------------------------------------------------------------------------
-- Events module — integrity constraints and indexes beyond Prisma.
-- Run after Prisma has created event, event_pass, admission and gate_device.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS event_status_starts_at_idx
  ON event (status, starts_at);
CREATE INDEX IF NOT EXISTS event_pass_member_id_idx
  ON event_pass (member_id);
CREATE INDEX IF NOT EXISTS event_pass_event_status_idx
  ON event_pass (event_id, status);
CREATE INDEX IF NOT EXISTS admission_pass_id_idx
  ON admission (pass_id);
CREATE INDEX IF NOT EXISTS admission_gate_scanned_at_idx
  ON admission (gate_device_id, scanned_at);
CREATE INDEX IF NOT EXISTS gate_device_event_id_idx
  ON gate_device (event_id);
CREATE INDEX IF NOT EXISTS gate_device_registered_by_event_idx
  ON gate_device (registered_by, event_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'event_time_order_check'
  ) THEN
    ALTER TABLE event
      ADD CONSTRAINT event_time_order_check CHECK (ends_at > starts_at);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'event_status_vocabulary_check'
  ) THEN
    ALTER TABLE event
      ADD CONSTRAINT event_status_vocabulary_check
      CHECK (status IN ('UPCOMING', 'ONGOING', 'ENDED', 'CANCELLED'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'event_pass_status_vocabulary_check'
  ) THEN
    ALTER TABLE event_pass
      ADD CONSTRAINT event_pass_status_vocabulary_check
      CHECK (status IN ('ACTIVE', 'REVOKED'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'event_pass_minors_check'
  ) THEN
    ALTER TABLE event_pass
      ADD CONSTRAINT event_pass_minors_check
      CHECK (minors_count >= 0 AND minors_count <= 20);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'event_pass_head_minors_check'
  ) THEN
    ALTER TABLE event_pass
      ADD CONSTRAINT event_pass_head_minors_check
      CHECK (is_head OR minors_count = 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'event_pass_qr_payload_check'
  ) THEN
    ALTER TABLE event_pass
      ADD CONSTRAINT event_pass_qr_payload_check
      CHECK (length(qr_payload) > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'event_pass_revocation_fields_check'
  ) THEN
    ALTER TABLE event_pass
      ADD CONSTRAINT event_pass_revocation_fields_check
      CHECK (
        (status = 'ACTIVE' AND revoked_at IS NULL AND revoked_reason IS NULL)
        OR (status = 'REVOKED' AND revoked_at IS NOT NULL AND revoked_reason IS NOT NULL)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'event_pass_revoked_reason_check'
  ) THEN
    ALTER TABLE event_pass
      ADD CONSTRAINT event_pass_revoked_reason_check
      CHECK (
        revoked_reason IS NULL
        OR revoked_reason IN (
          'EVENT_ENDED',
          'EVENT_CANCELLED',
          'MEMBER_CANCELLED',
          'MEMBER_ERASED',
          'MEMBER_ARCHIVED',
          'OFFICER'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'gate_device_label_check'
  ) THEN
    ALTER TABLE gate_device
      ADD CONSTRAINT gate_device_label_check
      CHECK (length(btrim(label)) BETWEEN 1 AND 120);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'admission_scanned_at_check'
  ) THEN
    ALTER TABLE admission
      ADD CONSTRAINT admission_scanned_at_check
      CHECK (scanned_at IS NOT NULL);
  END IF;
END;
$$;
