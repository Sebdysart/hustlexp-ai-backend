-- HX/OS offline-action reconciliation contract.
-- Persists the privacy-minimized client payload witness required to distinguish
-- an exact server acknowledgment from a conflicting use of the same identity.

ALTER TABLE proofs
  ADD COLUMN IF NOT EXISTS reconciliation_contract_version SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS offline_payload_hash CHAR(64);

ALTER TABLE task_safety_incidents
  ADD COLUMN IF NOT EXISTS reconciliation_contract_version SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS offline_payload_hash CHAR(64);

ALTER TABLE task_geofence_events
  ADD COLUMN IF NOT EXISTS reconciliation_contract_version SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS offline_payload_hash CHAR(64);

ALTER TABLE proofs DROP CONSTRAINT IF EXISTS proofs_offline_reconciliation_tuple_ck;
ALTER TABLE proofs ADD CONSTRAINT proofs_offline_reconciliation_tuple_ck CHECK (
  (reconciliation_contract_version=0 AND offline_payload_hash IS NULL)
  OR
  (reconciliation_contract_version=1 AND sync_contract_version=1
    AND offline_payload_hash IS NOT NULL
    AND offline_payload_hash ~ '^[a-f0-9]{64}$')
);

ALTER TABLE task_safety_incidents
  DROP CONSTRAINT IF EXISTS task_safety_offline_reconciliation_tuple_ck;
ALTER TABLE task_safety_incidents ADD CONSTRAINT task_safety_offline_reconciliation_tuple_ck CHECK (
  (reconciliation_contract_version=0 AND offline_payload_hash IS NULL)
  OR
  (reconciliation_contract_version=1 AND sync_contract_version=1
    AND offline_payload_hash IS NOT NULL
    AND offline_payload_hash ~ '^[a-f0-9]{64}$')
);

ALTER TABLE task_geofence_events
  DROP CONSTRAINT IF EXISTS task_geofence_offline_reconciliation_tuple_ck;
ALTER TABLE task_geofence_events ADD CONSTRAINT task_geofence_offline_reconciliation_tuple_ck CHECK (
  (reconciliation_contract_version=0 AND offline_payload_hash IS NULL)
  OR
  (reconciliation_contract_version=1
    AND offline_payload_hash IS NOT NULL
    AND offline_payload_hash ~ '^[a-f0-9]{64}$')
);

CREATE INDEX IF NOT EXISTS proofs_offline_reconciliation_lookup_idx
  ON proofs(task_id,submitter_id,client_submission_id,client_sequence)
  WHERE sync_contract_version=1;

CREATE INDEX IF NOT EXISTS task_safety_offline_reconciliation_lookup_idx
  ON task_safety_incidents(task_id,reporter_user_id,idempotency_key,client_sequence)
  WHERE sync_contract_version=1;

CREATE INDEX IF NOT EXISTS task_geofence_offline_reconciliation_lookup_idx
  ON task_geofence_events(task_id,user_id,client_event_id,client_sequence);

COMMENT ON COLUMN proofs.offline_payload_hash IS
  'Client SHA-256 command witness only; proof narrative and media are excluded.';
COMMENT ON COLUMN task_safety_incidents.offline_payload_hash IS
  'Client SHA-256 command witness only; report narrative and location are excluded.';
COMMENT ON COLUMN task_geofence_events.offline_payload_hash IS
  'Client SHA-256 command witness only; raw coordinates are excluded.';
