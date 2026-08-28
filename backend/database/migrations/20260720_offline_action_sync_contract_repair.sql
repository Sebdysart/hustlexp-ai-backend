-- Forward repair for PostgreSQL three-valued CHECK semantics.
-- Explicit non-null guards ensure incomplete v1 tuples cannot evaluate UNKNOWN
-- and pass a CHECK constraint.

ALTER TABLE proofs DROP CONSTRAINT IF EXISTS proofs_offline_sync_tuple_ck;
ALTER TABLE proofs ADD CONSTRAINT proofs_offline_sync_tuple_ck CHECK (
  (
    sync_contract_version = 0
    AND client_sequence IS NULL AND prior_task_version IS NULL
    AND local_occurred_at IS NULL AND device_version IS NULL AND app_version IS NULL
    AND entry_surface IS NULL AND context_source IS NULL AND intended_transition IS NULL
  ) OR (
    sync_contract_version = 1
    AND client_submission_id IS NOT NULL
    AND client_sequence IS NOT NULL AND client_sequence > 0
    AND prior_task_version IS NOT NULL AND prior_task_version > 0
    AND local_occurred_at IS NOT NULL
    AND local_occurred_at <= created_at + INTERVAL '5 minutes'
    AND device_version IS NOT NULL AND device_version ~ '^[A-Za-z0-9._:-]{1,100}$'
    AND app_version IS NOT NULL AND app_version ~ '^[A-Za-z0-9._:-]{1,100}$'
    AND entry_surface IS NOT NULL AND entry_surface = 'TASK_PROOF_COMPOSER'
    AND context_source IS NOT NULL AND context_source = 'ACTIVE_TASK'
    AND intended_transition IS NOT NULL
    AND intended_transition = 'ACCEPTED_TO_PROOF_SUBMITTED'
  )
);

ALTER TABLE task_safety_incidents DROP CONSTRAINT IF EXISTS task_safety_offline_sync_tuple_ck;
ALTER TABLE task_safety_incidents ADD CONSTRAINT task_safety_offline_sync_tuple_ck CHECK (
  (
    sync_contract_version = 0
    AND client_sequence IS NULL AND prior_task_version IS NULL
    AND local_occurred_at IS NULL AND device_version IS NULL AND app_version IS NULL
    AND entry_surface IS NULL AND context_source IS NULL AND intended_transition IS NULL
  ) OR (
    sync_contract_version = 1
    AND client_sequence IS NOT NULL AND client_sequence > 0
    AND prior_task_version IS NOT NULL AND prior_task_version > 0
    AND local_occurred_at IS NOT NULL
    AND local_occurred_at <= created_at + INTERVAL '5 minutes'
    AND device_version IS NOT NULL AND device_version ~ '^[A-Za-z0-9._:-]{1,100}$'
    AND app_version IS NOT NULL AND app_version ~ '^[A-Za-z0-9._:-]{1,100}$'
    AND entry_surface IS NOT NULL AND entry_surface = 'TASK_SAFETY_CENTER'
    AND context_source IS NOT NULL AND context_source = 'ACTIVE_TASK'
    AND intended_transition IS NOT NULL
    AND intended_transition = 'ANY_TO_SAFETY_REPORT_RECEIVED'
  )
);
