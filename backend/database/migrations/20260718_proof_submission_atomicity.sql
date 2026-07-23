-- Durable client witness for atomic, retry-safe completion-proof submission.

ALTER TABLE proofs
  ADD COLUMN IF NOT EXISTS client_submission_id TEXT,
  ADD COLUMN IF NOT EXISTS submission_hash CHAR(64);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'proofs_client_submission_pair_ck'
  ) THEN
    ALTER TABLE proofs ADD CONSTRAINT proofs_client_submission_pair_ck CHECK (
      (client_submission_id IS NULL AND submission_hash IS NULL)
      OR (
        client_submission_id IS NOT NULL
        AND client_submission_id ~ '^[A-Za-z0-9:_-]{8,128}$'
        AND submission_hash ~ '^[a-f0-9]{64}$'
      )
    );
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS proofs_task_client_submission_uniq
  ON proofs(task_id, client_submission_id)
  WHERE client_submission_id IS NOT NULL;
