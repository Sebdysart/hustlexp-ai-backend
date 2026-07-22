-- Authenticated exact-location storage, append-only read evidence, and terminal expiry.
-- Existing plaintext rows remain quarantined and cannot be released by the application;
-- Posters must reset them once the runtime encryption key is configured.

ALTER TABLE task_location_vault
  ALTER COLUMN exact_location DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS location_ciphertext TEXT,
  ADD COLUMN IF NOT EXISTS location_nonce TEXT,
  ADD COLUMN IF NOT EXISTS location_auth_tag TEXT,
  ADD COLUMN IF NOT EXISTS location_key_id TEXT,
  ADD COLUMN IF NOT EXISTS location_fingerprint CHAR(64),
  ADD COLUMN IF NOT EXISTS expired_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS expiration_reason TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'task_location_vault_encrypted_payload_ck'
  ) THEN
    ALTER TABLE task_location_vault ADD CONSTRAINT task_location_vault_encrypted_payload_ck CHECK (
      expired_at IS NOT NULL
      OR exact_location IS NOT NULL
      OR (
        location_ciphertext IS NOT NULL
        AND location_nonce IS NOT NULL
        AND location_auth_tag IS NOT NULL
        AND location_key_id IS NOT NULL
        AND location_fingerprint IS NOT NULL
      )
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'task_location_vault_fingerprint_ck'
  ) THEN
    ALTER TABLE task_location_vault ADD CONSTRAINT task_location_vault_fingerprint_ck CHECK (
      location_fingerprint IS NULL OR location_fingerprint ~ '^[a-f0-9]{64}$'
    );
  END IF;
END
$$;

ALTER TABLE task_location_access_log
  DROP CONSTRAINT IF EXISTS task_location_access_log_task_id_worker_id_key,
  ADD COLUMN IF NOT EXISTS location_key_id TEXT;

CREATE INDEX IF NOT EXISTS task_location_access_log_task_time_idx
  ON task_location_access_log(task_id, accessed_at DESC);

-- Terminal tasks must not be backfilled because their address retention window
-- has already ended. Active legacy rows are encrypted by the application-level
-- startup backfill immediately after this migration commits.
UPDATE task_location_vault v
SET exact_location = NULL,
    expired_at = COALESCE(v.expired_at, NOW()),
    expiration_reason = COALESCE(v.expiration_reason, 'TERMINAL_STATE_MIGRATION')
FROM tasks t
WHERE t.id = v.task_id
  AND t.state IN ('COMPLETED', 'CANCELLED', 'EXPIRED')
  AND v.expired_at IS NULL;

CREATE OR REPLACE FUNCTION expire_task_location_on_terminal()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.state IN ('COMPLETED', 'CANCELLED', 'EXPIRED')
     AND OLD.state IS DISTINCT FROM NEW.state THEN
    UPDATE task_location_vault
    SET exact_location = NULL,
        location_ciphertext = NULL,
        location_nonce = NULL,
        location_auth_tag = NULL,
        location_key_id = NULL,
        location_fingerprint = NULL,
        expired_at = COALESCE(expired_at, NOW()),
        expiration_reason = COALESCE(expiration_reason, 'TASK_' || NEW.state)
    WHERE task_id = NEW.id AND expired_at IS NULL;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS task_location_expire_terminal ON tasks;
CREATE TRIGGER task_location_expire_terminal
AFTER UPDATE OF state ON tasks
FOR EACH ROW EXECUTE FUNCTION expire_task_location_on_terminal();
