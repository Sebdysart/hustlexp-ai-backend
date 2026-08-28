-- Encrypted, purpose-audited, time-limited safety-location evidence.

ALTER TABLE task_safety_incidents
  ADD COLUMN IF NOT EXISTS location_ciphertext TEXT,
  ADD COLUMN IF NOT EXISTS location_nonce TEXT,
  ADD COLUMN IF NOT EXISTS location_auth_tag TEXT,
  ADD COLUMN IF NOT EXISTS location_key_id TEXT,
  ADD COLUMN IF NOT EXISTS location_captured_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS location_accuracy_meters INTEGER,
  ADD COLUMN IF NOT EXISTS location_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS location_expired_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS location_legacy_unverified BOOLEAN NOT NULL DEFAULT FALSE;

-- Older clients stored only a consent-looking boolean and no coordinates.
-- Quarantine that historical claim rather than treating nonexistent evidence as shared.
UPDATE task_safety_incidents
SET location_sharing_enabled = FALSE,
    location_legacy_unverified = TRUE,
    updated_at = NOW()
WHERE location_sharing_enabled = TRUE
  AND location_ciphertext IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'task_safety_location_evidence_ck'
  ) THEN
    ALTER TABLE task_safety_incidents
      ADD CONSTRAINT task_safety_location_evidence_ck CHECK (
        (
          location_sharing_enabled = FALSE
          AND location_legacy_unverified IN (FALSE, TRUE)
          AND location_ciphertext IS NULL
          AND location_nonce IS NULL
          AND location_auth_tag IS NULL
          AND location_key_id IS NULL
          AND location_captured_at IS NULL
          AND location_accuracy_meters IS NULL
          AND location_expires_at IS NULL
          AND location_expired_at IS NULL
        )
        OR (
          location_sharing_enabled = TRUE
          AND location_legacy_unverified = FALSE
          AND (
            (
              location_expired_at IS NULL
              AND location_ciphertext IS NOT NULL
              AND location_nonce IS NOT NULL
              AND location_auth_tag IS NOT NULL
              AND location_key_id IS NOT NULL
              AND location_captured_at IS NOT NULL
              AND location_accuracy_meters BETWEEN 1 AND 10000
              AND location_expires_at > location_captured_at
            )
            OR (
              location_expired_at IS NOT NULL
              AND location_ciphertext IS NULL
              AND location_nonce IS NULL
              AND location_auth_tag IS NULL
              AND location_key_id IS NULL
              AND location_captured_at IS NOT NULL
              AND location_accuracy_meters BETWEEN 1 AND 10000
              AND location_expires_at IS NOT NULL
            )
          )
        )
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS task_safety_location_expiry_due
  ON task_safety_incidents(location_expires_at ASC)
  WHERE location_ciphertext IS NOT NULL AND location_expired_at IS NULL;

CREATE TABLE IF NOT EXISTS task_safety_location_access_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id UUID NOT NULL REFERENCES task_safety_incidents(id) ON DELETE RESTRICT,
  admin_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  purpose TEXT NOT NULL CHECK (char_length(purpose) BETWEEN 10 AND 500),
  location_key_id TEXT NOT NULL,
  accessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS task_safety_location_access_case_time
  ON task_safety_location_access_log(incident_id, accessed_at DESC);

CREATE OR REPLACE FUNCTION prevent_task_safety_location_access_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'HX818: safety location access logs are append-only' USING ERRCODE = 'HX818';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS task_safety_location_access_no_update ON task_safety_location_access_log;
CREATE TRIGGER task_safety_location_access_no_update
  BEFORE UPDATE ON task_safety_location_access_log
  FOR EACH ROW EXECUTE FUNCTION prevent_task_safety_location_access_mutation();

DROP TRIGGER IF EXISTS task_safety_location_access_no_delete ON task_safety_location_access_log;
CREATE TRIGGER task_safety_location_access_no_delete
  BEFORE DELETE ON task_safety_location_access_log
  FOR EACH ROW EXECUTE FUNCTION prevent_task_safety_location_access_mutation();
