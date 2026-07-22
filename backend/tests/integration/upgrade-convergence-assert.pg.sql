\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION pg_temp.hxupgrade_assert(condition boolean,message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF condition IS NOT TRUE THEN RAISE EXCEPTION 'HXUPGRADE assertion failed: %',message; END IF;
END;
$$;

SELECT pg_temp.hxupgrade_assert(
  (SELECT version=1 FROM tasks WHERE id='b2000000-0000-4000-8000-000000000001'),
  'legacy task must receive aggregate version 1 without a false transition'
);
SELECT pg_temp.hxupgrade_assert(
  (SELECT sync_contract_version=0 AND client_sequence IS NULL
      AND prior_task_version IS NULL AND local_occurred_at IS NULL
      AND reconciliation_contract_version=0 AND offline_payload_hash IS NULL
   FROM proofs WHERE id='b3000000-0000-4000-8000-000000000001'),
  'legacy proof must remain an explicit v0 record'
);
SELECT pg_temp.hxupgrade_assert(
  (SELECT sync_contract_version=0 AND client_sequence IS NULL
      AND prior_task_version IS NULL AND local_occurred_at IS NULL
      AND reconciliation_contract_version=0 AND offline_payload_hash IS NULL
   FROM task_safety_incidents WHERE id='b4000000-0000-4000-8000-000000000001'),
  'legacy safety case must remain an explicit v0 record'
);
SELECT pg_temp.hxupgrade_assert(
  (SELECT count(*)=94 AND count(DISTINCT name)=94 FROM applied_migrations),
  'the exact 94-migration engine chain must be recorded once'
);
SELECT pg_temp.hxupgrade_assert(
  (SELECT count(*)=19 FROM major_action_class_contracts),
  'all 19 major-action classes must exist after upgrade'
);
SELECT pg_temp.hxupgrade_assert(
  (SELECT count(distinct action_class)=19 FROM major_action_source_registry),
  'all 19 major-action classes must retain a registered source after upgrade'
);

SELECT 'HXOS_UPGRADE_CONVERGENCE_DATA_OK' AS result;
