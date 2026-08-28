-- Permit successive immutable, time-bounded provider attestations for one
-- controlled TEST task and worker. Idempotency remains unique per source call.

BEGIN;

ALTER TABLE hxos_local_test_provider_capability_evidence
  DROP CONSTRAINT IF EXISTS hxos_local_test_provider_capability_evidence_task_id_worker_id_key;

CREATE INDEX IF NOT EXISTS hxos_local_test_provider_capability_task_worker_idx
  ON hxos_local_test_provider_capability_evidence(task_id,worker_id,created_at DESC);

COMMENT ON INDEX hxos_local_test_provider_capability_task_worker_idx IS
  'Lookup path for the newest immutable capability attestation; multiple expiries are intentional.';

COMMIT;
