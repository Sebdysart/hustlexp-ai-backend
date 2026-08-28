-- PostgreSQL truncates generated constraint names. Remove the legacy
-- task/worker uniqueness by its definition so upgraded databases converge.

BEGIN;

DO $$
DECLARE
  v_constraint RECORD;
BEGIN
  FOR v_constraint IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid='hxos_local_test_provider_capability_evidence'::regclass
      AND contype='u'
      AND pg_get_constraintdef(oid)='UNIQUE (task_id, worker_id)'
  LOOP
    EXECUTE format(
      'ALTER TABLE hxos_local_test_provider_capability_evidence DROP CONSTRAINT %I',
      v_constraint.conname
    );
  END LOOP;
END
$$;

CREATE INDEX IF NOT EXISTS hxos_local_test_provider_capability_task_worker_idx
  ON hxos_local_test_provider_capability_evidence(task_id,worker_id,created_at DESC);

COMMIT;
