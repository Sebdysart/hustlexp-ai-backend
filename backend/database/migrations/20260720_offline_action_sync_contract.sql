-- HX/OS offline-action convergence contract.
-- Establishes one monotonic task aggregate version and preserves the complete,
-- privacy-minimized client witness for proof, safety, and geofence retries.

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 1;

CREATE OR REPLACE FUNCTION bump_task_aggregate_version()
RETURNS TRIGGER AS $$
BEGIN
  IF (to_jsonb(NEW) - 'version' - 'updated_at')
       IS DISTINCT FROM
     (to_jsonb(OLD) - 'version' - 'updated_at') THEN
    NEW.version := OLD.version + 1;
  ELSE
    NEW.version := OLD.version;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tasks_bump_aggregate_version ON tasks;
CREATE TRIGGER tasks_bump_aggregate_version
  BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION bump_task_aggregate_version();

COMMENT ON COLUMN tasks.version IS
  'Monotonic aggregate version used to reject stale consequential client actions. updated_at-only writes do not increment it.';

ALTER TABLE task_geofence_events
  ALTER COLUMN prior_task_version TYPE BIGINT USING prior_task_version::BIGINT;

ALTER TABLE proofs
  ADD COLUMN IF NOT EXISTS sync_contract_version SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS client_sequence BIGINT,
  ADD COLUMN IF NOT EXISTS prior_task_version BIGINT,
  ADD COLUMN IF NOT EXISTS local_occurred_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS device_version TEXT,
  ADD COLUMN IF NOT EXISTS app_version TEXT,
  ADD COLUMN IF NOT EXISTS entry_surface TEXT,
  ADD COLUMN IF NOT EXISTS context_source TEXT,
  ADD COLUMN IF NOT EXISTS intended_transition TEXT;

ALTER TABLE task_safety_incidents
  ADD COLUMN IF NOT EXISTS sync_contract_version SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS client_sequence BIGINT,
  ADD COLUMN IF NOT EXISTS prior_task_version BIGINT,
  ADD COLUMN IF NOT EXISTS local_occurred_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS device_version TEXT,
  ADD COLUMN IF NOT EXISTS app_version TEXT,
  ADD COLUMN IF NOT EXISTS entry_surface TEXT,
  ADD COLUMN IF NOT EXISTS context_source TEXT,
  ADD COLUMN IF NOT EXISTS intended_transition TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='proofs_offline_sync_tuple_ck') THEN
    ALTER TABLE proofs ADD CONSTRAINT proofs_offline_sync_tuple_ck CHECK (
      (
        sync_contract_version = 0
        AND client_sequence IS NULL
        AND prior_task_version IS NULL
        AND local_occurred_at IS NULL
        AND device_version IS NULL
        AND app_version IS NULL
        AND entry_surface IS NULL
        AND context_source IS NULL
        AND intended_transition IS NULL
      ) OR (
        sync_contract_version = 1
        AND client_submission_id IS NOT NULL
        AND client_sequence IS NOT NULL AND client_sequence > 0
        AND prior_task_version IS NOT NULL AND prior_task_version > 0
        AND local_occurred_at IS NOT NULL
        AND local_occurred_at <= created_at + INTERVAL '5 minutes'
        AND device_version IS NOT NULL
        AND device_version ~ '^[A-Za-z0-9._:-]{1,100}$'
        AND app_version IS NOT NULL
        AND app_version ~ '^[A-Za-z0-9._:-]{1,100}$'
        AND entry_surface IS NOT NULL
        AND entry_surface = 'TASK_PROOF_COMPOSER'
        AND context_source IS NOT NULL
        AND context_source = 'ACTIVE_TASK'
        AND intended_transition IS NOT NULL
        AND intended_transition = 'ACCEPTED_TO_PROOF_SUBMITTED'
      )
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='task_safety_offline_sync_tuple_ck') THEN
    ALTER TABLE task_safety_incidents ADD CONSTRAINT task_safety_offline_sync_tuple_ck CHECK (
      (
        sync_contract_version = 0
        AND client_sequence IS NULL
        AND prior_task_version IS NULL
        AND local_occurred_at IS NULL
        AND device_version IS NULL
        AND app_version IS NULL
        AND entry_surface IS NULL
        AND context_source IS NULL
        AND intended_transition IS NULL
      ) OR (
        sync_contract_version = 1
        AND client_sequence IS NOT NULL AND client_sequence > 0
        AND prior_task_version IS NOT NULL AND prior_task_version > 0
        AND local_occurred_at IS NOT NULL
        AND local_occurred_at <= created_at + INTERVAL '5 minutes'
        AND device_version IS NOT NULL
        AND device_version ~ '^[A-Za-z0-9._:-]{1,100}$'
        AND app_version IS NOT NULL
        AND app_version ~ '^[A-Za-z0-9._:-]{1,100}$'
        AND entry_surface IS NOT NULL
        AND entry_surface = 'TASK_SAFETY_CENTER'
        AND context_source IS NOT NULL
        AND context_source = 'ACTIVE_TASK'
        AND intended_transition IS NOT NULL
        AND intended_transition = 'ANY_TO_SAFETY_REPORT_RECEIVED'
      )
    );
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS proofs_task_actor_client_sequence_uniq
  ON proofs(task_id,submitter_id,client_sequence)
  WHERE sync_contract_version=1;

CREATE UNIQUE INDEX IF NOT EXISTS task_safety_task_actor_client_sequence_uniq
  ON task_safety_incidents(task_id,reporter_user_id,client_sequence)
  WHERE sync_contract_version=1;

CREATE INDEX IF NOT EXISTS proofs_offline_sync_reconciliation_idx
  ON proofs(task_id,submitter_id,local_occurred_at)
  WHERE sync_contract_version=1;

CREATE INDEX IF NOT EXISTS task_safety_offline_sync_reconciliation_idx
  ON task_safety_incidents(task_id,reporter_user_id,local_occurred_at)
  WHERE sync_contract_version=1;

COMMENT ON COLUMN proofs.submission_hash IS
  'SHA-256 of proof content plus the v1 offline witness when sync_contract_version=1; raw note/media bytes are excluded from general telemetry.';
COMMENT ON COLUMN task_safety_incidents.request_hash IS
  'SHA-256 of the encrypted safety command semantics plus the v1 offline witness when sync_contract_version=1; narrative and exact location stay purpose-bound.';
