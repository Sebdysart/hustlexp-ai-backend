-- Nonproduction fake-finance v12: Universal V1 Work Order authority hardening.
--
-- This append-only supplemental migration runs only after the complete
-- canonical engine chain and fake-finance v1-v11. It restores the Work Order
-- genesis exception overwritten by the older change-order supplement, fixes
-- the seven supplemental trigger-function paths, and certifies the exact full
-- trigger catalog before runtime roles may be provisioned. It creates no role,
-- runtime grant, provider call, hard assignment, positive financial effect,
-- production capability, deployment authority, or external value.

SELECT pg_catalog.set_config('search_path', 'pg_catalog', true);

DO $$
DECLARE
  invalid_migration TEXT;
  invalid_evidence_relation TEXT;
BEGIN
  IF pg_catalog.to_regclass('public.applied_migrations') IS NULL
     OR pg_catalog.to_regclass(
       'hx_authority.universal_v1_work_order_target_authority_facts'
     ) IS NULL
     OR pg_catalog.to_regclass(
       'hx_authority.universal_v1_work_order_command_execution_facts'
     ) IS NULL
     OR pg_catalog.to_regclass(
       'public.hxos_universal_v1_work_order_target_activation_barrier_v1'
     ) IS NULL THEN
    RAISE EXCEPTION
      'HXUV1-WOCMD-V12-0: exact ordinal146 Work Order authority must install first'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT expected.migration_name
    INTO invalid_migration
    FROM (VALUES
      ('20261014_universal_v1_work_order_command_ports_v1',
       '3920ac8d3208b9f573dc331cab60c373d0349611700c6e14a6e4c1dd8c53aac4')
    ) expected(migration_name, expected_sha256)
   WHERE (
          SELECT pg_catalog.count(*)
            FROM public.applied_migrations applied
           WHERE applied.name = expected.migration_name
         ) IS DISTINCT FROM 1::BIGINT
      OR (
          SELECT pg_catalog.min(pg_catalog.btrim(applied.sha256))
            FROM public.applied_migrations applied
           WHERE applied.name = expected.migration_name
         ) IS DISTINCT FROM expected.expected_sha256
   LIMIT 1;
  IF invalid_migration IS NOT NULL THEN
    RAISE EXCEPTION
      'HXUV1-WOCMD-V12-1: ordinal146 checksum evidence is absent or changed: %',
      invalid_migration
      USING ERRCODE = 'P0001';
  END IF;

  SELECT expected.relation_name
    INTO invalid_evidence_relation
    FROM (VALUES
      ('public.hxos_fake_financial_schema_evidence_v1'),
      ('public.hxos_fake_financial_schema_evidence_v2'),
      ('public.hxos_fake_financial_schema_evidence_v3'),
      ('public.hxos_fake_financial_schema_evidence_v4'),
      ('public.hxos_fake_financial_schema_evidence_v5'),
      ('public.hxos_fake_financial_schema_evidence_v6'),
      ('public.hxos_fake_financial_schema_evidence_v7'),
      ('public.hxos_fake_financial_schema_evidence_v8'),
      ('public.hxos_fake_financial_schema_evidence_v9'),
      ('public.hxos_fake_financial_schema_evidence_v10'),
      ('public.hxos_fake_financial_schema_evidence_v11')
    ) expected(relation_name)
    LEFT JOIN pg_catalog.pg_class relation_state
      ON relation_state.oid = pg_catalog.to_regclass(expected.relation_name)::OID
   WHERE relation_state.oid IS NULL
      OR relation_state.relkind IS DISTINCT FROM 'r'
   ORDER BY expected.relation_name
   LIMIT 1;
  IF invalid_evidence_relation IS NOT NULL THEN
    RAISE EXCEPTION
      'HXUV1-WOCMD-V12-2: fake-finance evidence relation is absent or unsafe: %',
      invalid_evidence_relation
      USING ERRCODE = 'P0001';
  END IF;

  WITH expected(migration_name, expected_sha256) AS (VALUES
    ('20260827_fake_financial_provider_v1',
     '26d451ef2812b11cf221290635cee4c402d16012e19741e58663b86e6ae10ec8'),
    ('20260903_fake_financial_provider_account_refresh_v2',
     '74cfbdde587bccd761a6043571d5c9dc2fde797d428911a45cb6eef7d0bb1389'),
    ('20260910_fake_financial_settlement_completion_v3',
     '77432de4ab69f63f23ef2558a4ef2164ac8a233ad394d66bf70e0142517dc1ef'),
    ('20260921_universal_v1_fake_financial_lifecycle_bridge_v1',
     '63075ae3094cc8d4d26999fbb1c2b31babe89b6bc2e7d99f092955452dd85e5e'),
    ('20260922_universal_v1_fake_terminal_lifecycle_intent_v1',
     'f1bc0be5cb925734d909a83018f7528c4b3c31654ae9f5cae3b8993c4f5ef693'),
    ('20260926_universal_v1_change_order_three_phase_v1',
     '574d440fea618c4a44efaf56e0a5f6f4cd84fd46089a12c2d071aa813a295613'),
    ('20260927_universal_v1_change_order_recovery_v1',
     '8ae30fd8e3b990e839fd6ed6dbed3c715ed6d9b8954fe8aaa49bbcbe09986078'),
    ('20261002_universal_v1_dispute_fake_release_gate_v8',
     '41e76dfa7f3293e1f9cf1bfda7b7c25344beec218366492b6ffa217ccdc8a0dc'),
    ('20261010_universal_v1_fake_financial_expiry_v9',
     '9c53bd9f8f9524b177c9b08f023bb3005d84ab6c159394ae6490ee1e48ad496d'),
    ('20261011_universal_v1_fake_financial_expiry_recovery_v10',
     '739ce58699a11ea0078c0c2eb910ec8a2adb2278e6af2aeefe041cc07c3d6a25'),
    ('20261013_nonproduction_runtime_insert_authority_v1',
     'e4204c41457be1ceb823b48baf228010e266172f6e081693475f05a670fcd35c')
  ), evidence AS (
    SELECT migration_name, pg_catalog.btrim(migration_sql_sha256) AS evidence_sha256
      FROM public.hxos_fake_financial_schema_evidence_v1
    UNION ALL
    SELECT migration_name, pg_catalog.btrim(migration_sql_sha256)
      FROM public.hxos_fake_financial_schema_evidence_v2
    UNION ALL
    SELECT migration_name, pg_catalog.btrim(migration_sql_sha256)
      FROM public.hxos_fake_financial_schema_evidence_v3
    UNION ALL
    SELECT migration_name, pg_catalog.btrim(migration_sql_sha256)
      FROM public.hxos_fake_financial_schema_evidence_v4
    UNION ALL
    SELECT migration_name, pg_catalog.btrim(migration_sql_sha256)
      FROM public.hxos_fake_financial_schema_evidence_v5
    UNION ALL
    SELECT migration_name, pg_catalog.btrim(migration_sql_sha256)
      FROM public.hxos_fake_financial_schema_evidence_v6
    UNION ALL
    SELECT migration_name, pg_catalog.btrim(migration_sql_sha256)
      FROM public.hxos_fake_financial_schema_evidence_v7
    UNION ALL
    SELECT migration_name, pg_catalog.btrim(migration_sql_sha256)
      FROM public.hxos_fake_financial_schema_evidence_v8
    UNION ALL
    SELECT migration_name, pg_catalog.btrim(migration_sql_sha256)
      FROM public.hxos_fake_financial_schema_evidence_v9
    UNION ALL
    SELECT migration_name, pg_catalog.btrim(migration_sql_sha256)
      FROM public.hxos_fake_financial_schema_evidence_v10
    UNION ALL
    SELECT migration_name, pg_catalog.btrim(migration_sql_sha256)
      FROM public.hxos_fake_financial_schema_evidence_v11
  ), applied_evidence AS (
    SELECT applied.name AS migration_name,
           pg_catalog.count(*) AS applied_count,
           pg_catalog.min(pg_catalog.btrim(applied.sha256)) AS applied_sha256
      FROM public.applied_migrations applied
     GROUP BY applied.name
  )
  SELECT expected.migration_name
    INTO invalid_migration
    FROM expected
    LEFT JOIN applied_evidence applied
      ON applied.migration_name = expected.migration_name
    LEFT JOIN evidence
      ON evidence.migration_name = expected.migration_name
   GROUP BY expected.migration_name, expected.expected_sha256,
            applied.migration_name, applied.applied_count, applied.applied_sha256
  HAVING COALESCE(applied.applied_count, 0::BIGINT)
           IS DISTINCT FROM 1::BIGINT
      OR applied.applied_sha256 IS DISTINCT FROM expected.expected_sha256
      OR pg_catalog.count(evidence.migration_name) IS DISTINCT FROM 1::BIGINT
      OR pg_catalog.min(evidence.evidence_sha256) IS DISTINCT FROM expected.expected_sha256
   ORDER BY expected.migration_name
   LIMIT 1;
  IF invalid_migration IS NOT NULL THEN
    RAISE EXCEPTION
      'HXUV1-WOCMD-V12-2: exact fake-finance v1-v11 checksum/evidence chain is required: %',
      invalid_migration
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

-- Accept the exact canonical engine-then-v1-v11 shape or the exact legacy
-- fake-preloaded-then-ordinal146 shape. The latter is an upgrade input only;
-- ordinal146 itself refuses replay once both authority and fake surfaces exist.
DO $$
DECLARE
  trigger_count INTEGER;
  trigger_catalog_sha256 TEXT;
BEGIN
  WITH trigger_rows AS (
    SELECT pg_catalog.format('%I.%I', namespace_state.nspname, relation_state.relname)
             || '|' || trigger_state.tgname
             || '|' || pg_catalog.format(
                  '%I.%I(%s)', function_namespace.nspname, function_state.proname,
                  pg_catalog.oidvectortypes(function_state.proargtypes)
                )
             || '|' || pg_catalog.pg_get_triggerdef(trigger_state.oid, false)
             || '|' || trigger_state.tgenabled::TEXT
             || '|' || function_state.prolang::pg_catalog.regproc::TEXT
             || '|' || function_state.prokind::TEXT
             || '|' || function_state.prorettype::pg_catalog.regtype::TEXT
             || '|' || function_state.prosecdef::TEXT
             || '|' || function_state.proisstrict::TEXT
             || '|' || function_state.proleakproof::TEXT
             || '|' || function_state.provolatile::TEXT
             || '|' || function_state.proparallel::TEXT
             || '|' || function_state.prosrc AS line
      FROM pg_catalog.pg_trigger trigger_state
      JOIN pg_catalog.pg_class relation_state
        ON relation_state.oid = trigger_state.tgrelid
      JOIN pg_catalog.pg_namespace namespace_state
        ON namespace_state.oid = relation_state.relnamespace
      JOIN pg_catalog.pg_proc function_state
        ON function_state.oid = trigger_state.tgfoid
      JOIN pg_catalog.pg_namespace function_namespace
        ON function_namespace.oid = function_state.pronamespace
     WHERE trigger_state.tgisinternal IS FALSE
       AND pg_catalog.format('%I.%I', namespace_state.nspname, relation_state.relname)
             = ANY (ARRAY[
               'hx_authority.universal_v1_actor_assertion_consumption_facts',
               'hx_authority.universal_v1_actor_assertion_issuance_facts',
               'hx_authority.universal_v1_work_order_command_execution_facts',
               'hx_authority.universal_v1_work_order_target_authority_facts',
               'public.admin_roles',
               'public.business_credentials',
               'public.business_memberships',
               'public.business_organizations',
               'public.capability_profiles',
               'public.current_verified_trade_qualifications',
               'public.financial_provider_command_journal',
               'public.financial_provider_command_outcome_facts',
               'public.hxos_universal_v1_work_order_target_activation_barrier_v1',
               'public.major_action_class_contracts',
               'public.major_action_events',
               'public.major_action_outcomes',
               'public.provider_estimate_submissions',
               'public.recommendations',
               'public.task_applications',
               'public.task_drafts',
               'public.task_estimate_acceptance_materializations',
               'public.task_financial_security_events',
               'public.task_provider_eligibility_decisions',
               'public.task_reservations',
               'public.task_reservation_requests',
               'public.task_routing_decisions',
               'public.task_scope_versions',
               'public.task_work_order_command_requests',
               'public.task_work_orders',
               'public.task_work_order_execution_facts',
               'public.universal_v1_fake_financial_lifecycle_bridges',
               'public.universal_v1_service_cell_authorities',
               'public.universal_v1_work_order_compensation_commands',
               'public.tasks',
               'public.users',
               'public.verified_trades',
               'public.worker_counter_offers',
               'public.worker_offer_decisions'
             ]::TEXT[])
  )
  SELECT pg_catalog.count(*)::INTEGER,
         pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
           COALESCE(pg_catalog.string_agg(line, E'\n' ORDER BY line), ''),
           'UTF8'
         )), 'hex')
    INTO trigger_count, trigger_catalog_sha256
    FROM trigger_rows;

  IF trigger_count <> 164
     OR trigger_catalog_sha256 NOT IN (
       '9b1befa40b2b2f377fa3323457e333be77f6e5f2c1d6107c871856cca2838dae',
       '18999ff352af8758d77cdca5b4857e5f0ce36acb3e4ccfbf8eb6bff73169b0f2'
     ) THEN
    RAISE EXCEPTION
      'HXUV1-WOCMD-V12-3: pre-hardening trigger catalog mismatch (% / %)',
      trigger_count,
      COALESCE(trigger_catalog_sha256, 'MISSING')
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

-- v6/v7 predate Work Order genesis and replace this shared trigger function.
-- Restore the exact ordinal146 behavior before certifying the combined chain.
CREATE OR REPLACE FUNCTION public.prevent_execution_during_prepared_change_order()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.execution_version = 1
     AND NEW.supersedes_fact_id IS NULL
     AND NEW.state = 'MATERIALIZED'
     AND NEW.transition_kind = 'MATERIALIZED'
     AND NEW.work_order_amendment_id IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('fulfillment:' || NEW.work_order_id::TEXT, 0)
  );
  IF EXISTS (
    SELECT 1
      FROM public.universal_v1_change_order_materialization_commands witness
      JOIN public.universal_v1_change_order_recovery_terminal_facts terminal
        ON terminal.proposal_id = witness.proposal_id
     WHERE witness.work_order_id = NEW.work_order_id
       AND terminal.outcome_state = 'CANCELLED'
       AND terminal.recovery_state = 'RECOVERY_REQUIRED'
  ) THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-RECOVERY-27: CANCELLED_RECOVERY_REQUIRED permits bounded recovery only, not execution'
      USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.universal_v1_change_order_materialization_commands witness
     WHERE witness.work_order_id = NEW.work_order_id
       AND NOT EXISTS (
         SELECT 1
           FROM public.task_work_order_amendments amendment
          WHERE amendment.change_order_id = witness.proposal_id
       )
       AND NOT EXISTS (
         SELECT 1
           FROM public.universal_v1_change_order_recovery_terminal_facts terminal
          WHERE terminal.proposal_id = witness.proposal_id
            AND terminal.outcome_state = 'MATERIALIZED'
       )
  ) THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-3P-6: execution is held until the prepared amendment finalizes or terminally recovers'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;


-- Normalize every supplemental protected digest caller onto the ordinary core-SHA
-- helper before hardening its fixed execution path.

CREATE OR REPLACE FUNCTION public.validate_universal_v1_fake_financial_lifecycle_bridge()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  prepared public.universal_v1_prepared_financial_commands%ROWTYPE;
  requested public.financial_provider_command_journal%ROWTYPE;
  attempted public.financial_provider_command_dispatch_attempts%ROWTYPE;
  latest_attempt_id UUID;
  outcome public.financial_provider_command_outcome_facts%ROWTYPE;
  fake_event public.hxos_fake_financial_operation_events_v1%ROWTYPE;
  fake_operation public.hxos_fake_financial_operations_v1%ROWTYPE;
  lifecycle public.task_financial_security_events%ROWTYPE;
  expected_event_kind TEXT;
  expected_lifecycle_status TEXT;
  expected_effect_certainty TEXT;
  expected_provider_result_sha256 CHAR(64);
  expected_external_reference_sha256 CHAR(64);
  derived_lifecycle_identity CHAR(64);
  zero_sha CHAR(64) := repeat('0', 64);
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtext('universal-v1-fake-financial-lifecycle-bridge-v1'),
    hashtext(NEW.command_id::TEXT)
  );

  SELECT * INTO prepared
    FROM public.universal_v1_prepared_financial_commands
   WHERE prepared_command_id = NEW.prepared_command_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HXUV1-FLB-3: exact PREPARED command does not exist'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO requested
    FROM public.financial_provider_command_journal
   WHERE command_id = NEW.command_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HXUV1-FLB-4: exact REQUESTED command does not exist'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO attempted
    FROM public.financial_provider_command_dispatch_attempts
   WHERE dispatch_attempt_id = NEW.dispatch_attempt_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HXUV1-FLB-5: exact DISPATCH_ATTEMPTED fact does not exist'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT dispatch_attempt_id INTO latest_attempt_id
    FROM public.financial_provider_command_dispatch_attempts
   WHERE command_id = NEW.command_id
   ORDER BY attempt_number DESC
   LIMIT 1;
  IF latest_attempt_id IS DISTINCT FROM NEW.dispatch_attempt_id THEN
    RAISE EXCEPTION 'HXUV1-FLB-6: lifecycle bridge requires the latest dispatch attempt'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO outcome
    FROM public.financial_provider_command_outcome_facts
   WHERE outcome_fact_id = NEW.outcome_fact_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HXUV1-FLB-7: exact terminal OUTCOME_OBSERVED fact does not exist'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO fake_event
    FROM public.hxos_fake_financial_operation_events_v1
   WHERE event_id = NEW.fake_operation_event_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HXUV1-FLB-8: exact raw fake-provider event does not exist'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO fake_operation
    FROM public.hxos_fake_financial_operations_v1
   WHERE operation_id = fake_event.operation_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HXUV1-FLB-9: exact raw fake-provider operation does not exist'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO lifecycle
    FROM public.task_financial_security_events
   WHERE id = NEW.task_financial_security_event_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HXUV1-FLB-10: exact lifecycle event does not exist'
      USING ERRCODE = 'P0001';
  END IF;

  IF prepared.command_state IS DISTINCT FROM 'PREPARED'
     OR prepared.provider_kind IS DISTINCT FROM 'FAKE'
     OR requested.command_state IS DISTINCT FROM 'REQUESTED'
     OR requested.provider_kind IS DISTINCT FROM 'FAKE'
     OR requested.prepared_financial_command_id IS DISTINCT FROM prepared.prepared_command_id
     OR requested.prepared_authority_sha256 IS DISTINCT FROM prepared.authority_context_sha256
     OR requested.operation_kind IS DISTINCT FROM prepared.operation_kind
     OR requested.operation_id IS DISTINCT FROM prepared.operation_id
     OR requested.idempotency_key IS DISTINCT FROM prepared.idempotency_key
     OR requested.provider_expected_version IS DISTINCT FROM prepared.provider_expected_version
     OR requested.request_sha256 IS DISTINCT FROM prepared.provider_request_sha256
     OR requested.task_draft_id IS DISTINCT FROM prepared.task_draft_id
     OR requested.task_id IS DISTINCT FROM prepared.task_id
     OR requested.work_order_id IS DISTINCT FROM prepared.work_order_id
     OR requested.related_operation_id IS DISTINCT FROM prepared.related_operation_id
     OR requested.amount_cents IS DISTINCT FROM prepared.amount_cents
     OR requested.currency IS DISTINCT FROM prepared.currency
     OR requested.recorded_actor_id IS DISTINCT FROM prepared.recorded_by
     OR requested.recorded_actor_kind IS DISTINCT FROM 'PARTICIPANT' THEN
    RAISE EXCEPTION 'HXUV1-FLB-11: PREPARED and REQUESTED authorities are not exact'
      USING ERRCODE = 'P0001';
  END IF;

  IF attempted.command_id IS DISTINCT FROM requested.command_id
     OR attempted.request_sha256 IS DISTINCT FROM requested.request_sha256 THEN
    RAISE EXCEPTION 'HXUV1-FLB-12: DISPATCH_ATTEMPTED does not bind the exact REQUESTED command'
      USING ERRCODE = 'P0001';
  END IF;

  IF outcome.command_id IS DISTINCT FROM requested.command_id
     OR outcome.dispatch_attempt_id IS DISTINCT FROM attempted.dispatch_attempt_id
     OR outcome.recovery_lease_id IS DISTINCT FROM attempted.recovery_lease_id
     OR outcome.outcome_kind IS DISTINCT FROM 'OUTCOME_OBSERVED'
     OR outcome.retryable IS TRUE
     OR outcome.provider_state IN ('PENDING', 'RETRYABLE_FAILURE')
     OR outcome.recovery_not_before IS NOT NULL
     OR outcome.provider_result_sha256 IS NULL
     OR outcome.provider_result_version IS NULL
     OR outcome.external_reference_sha256 IS NULL THEN
    RAISE EXCEPTION 'HXUV1-FLB-13: lifecycle materialization requires one terminal exact OUTCOME_OBSERVED fact'
      USING ERRCODE = 'P0001';
  END IF;

  expected_effect_certainty := CASE
    WHEN outcome.provider_state IN (
      'SUCCEEDED', 'VOIDED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'REVERSED'
    ) THEN 'CONFIRMED_EFFECT'
    WHEN outcome.provider_state IN ('DECLINED', 'FAILED') THEN 'CONFIRMED_NO_EFFECT'
    ELSE NULL
  END;
  IF expected_effect_certainty IS NULL
     OR outcome.effect_certainty IS DISTINCT FROM expected_effect_certainty THEN
    RAISE EXCEPTION 'HXUV1-FLB-14: terminal provider state has no exact effect certainty'
      USING ERRCODE = 'P0001';
  END IF;

  expected_external_reference_sha256 := encode(
    public.hxos_universal_v1_sha256_bytes_v1(fake_event.external_reference, 'sha256'),
    'hex'
  );
  expected_provider_result_sha256 := encode(
    public.hxos_universal_v1_sha256_bytes_v1(
      requested.operation_id::TEXT || ':' || requested.operation_kind || ':' ||
      requested.provider_kind || ':' || outcome.provider_state || ':' ||
      outcome.provider_result_version::TEXT || ':' ||
      COALESCE(outcome.amount_cents::TEXT, '') || ':' ||
      COALESCE(outcome.currency, '') || ':' ||
      expected_external_reference_sha256 || ':' || outcome.retryable::TEXT,
      'sha256'
    ),
    'hex'
  );

  IF fake_operation.provider_kind IS DISTINCT FROM 'FAKE'
     OR fake_operation.operation_id IS DISTINCT FROM requested.operation_id
     OR fake_operation.operation_kind IS DISTINCT FROM requested.operation_kind
     OR fake_event.operation_id IS DISTINCT FROM fake_operation.operation_id
     OR fake_event.operation_kind IS DISTINCT FROM fake_operation.operation_kind
     OR fake_event.idempotency_key IS DISTINCT FROM requested.idempotency_key
     OR fake_event.event_version IS DISTINCT FROM requested.provider_expected_version + 1
     OR outcome.provider_result_version IS DISTINCT FROM fake_event.event_version
     OR fake_event.state IS DISTINCT FROM outcome.provider_state
     OR fake_event.retryable IS DISTINCT FROM outcome.retryable
     OR fake_event.provider_request_sha256 IS NULL
     OR fake_event.provider_request_sha256 IS DISTINCT FROM requested.request_sha256
     OR fake_event.identity_sha256 IS DISTINCT FROM fake_operation.identity_sha256
     OR fake_event.external_reference IS DISTINCT FROM fake_operation.external_reference
     OR outcome.external_reference_sha256 IS DISTINCT FROM expected_external_reference_sha256
     OR outcome.provider_result_sha256 IS DISTINCT FROM expected_provider_result_sha256
     OR fake_event.amount_cents IS DISTINCT FROM prepared.amount_cents
     OR fake_operation.amount_cents IS DISTINCT FROM prepared.amount_cents
     OR upper(fake_event.currency) IS DISTINCT FROM prepared.currency
     OR upper(fake_operation.currency) IS DISTINCT FROM prepared.currency
     OR fake_event.related_operation_id IS DISTINCT FROM prepared.related_operation_id
     OR fake_operation.related_operation_id IS DISTINCT FROM prepared.related_operation_id THEN
    RAISE EXCEPTION 'HXUV1-FLB-15: raw fake-provider event is not the exact terminal command result'
      USING ERRCODE = 'P0001';
  END IF;

  expected_event_kind := CASE requested.operation_kind
    WHEN 'PREPARE_PAYMENT_METHOD' THEN 'PAYMENT_METHOD_PREPARED'
    WHEN 'AUTHORIZE' THEN 'AUTHORIZED'
    WHEN 'SECURE' THEN 'SECURED'
    WHEN 'VOID' THEN 'VOIDED'
    WHEN 'ADJUST' THEN 'ADJUSTMENT_AUTHORIZED'
    WHEN 'CAPTURE' THEN 'CAPTURED'
    WHEN 'REFUND' THEN 'REFUNDED'
    WHEN 'REVERSAL' THEN 'REVERSED'
    WHEN 'SETTLE' THEN 'SETTLEMENT_OBSERVED'
    WHEN 'FUND' THEN 'FUNDING_OBSERVED'
    WHEN 'PROVIDER_RELEASE' THEN 'PROVIDER_RELEASED'
    WHEN 'PAYOUT' THEN 'PAYOUT_OBSERVED'
    WHEN 'OBSERVE_BANK_SETTLEMENT' THEN 'BANK_SETTLEMENT_OBSERVED'
    ELSE NULL
  END;
  expected_lifecycle_status := CASE fake_event.state
    WHEN 'SUCCEEDED' THEN 'SUCCEEDED'
    WHEN 'VOIDED' THEN 'SUCCEEDED'
    WHEN 'REFUNDED' THEN 'SUCCEEDED'
    WHEN 'PARTIALLY_REFUNDED' THEN 'SUCCEEDED'
    WHEN 'REVERSED' THEN 'SUCCEEDED'
    WHEN 'DECLINED' THEN 'DECLINED'
    WHEN 'FAILED' THEN 'FAILED'
    ELSE NULL
  END;

  IF COALESCE(lifecycle.evidence->>'providerOperationVersion', '')
       !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'HXUV1-FLB-16: lifecycle event is not the exact terminal fake-provider projection'
      USING ERRCODE = 'P0001';
  END IF;

  IF expected_event_kind IS NULL
     OR expected_lifecycle_status IS NULL
     OR lifecycle.provider_kind IS DISTINCT FROM 'FAKE'
     OR lifecycle.operation_id IS DISTINCT FROM prepared.operation_id::TEXT
     OR lifecycle.event_kind IS DISTINCT FROM expected_event_kind
     OR lifecycle.event_kind IS DISTINCT FROM prepared.event_kind
     OR lifecycle.status IS DISTINCT FROM expected_lifecycle_status
     OR lifecycle.idempotency_key IS DISTINCT FROM prepared.idempotency_key
     OR lifecycle.expected_version IS DISTINCT FROM prepared.lifecycle_expected_version
     OR lifecycle.external_reference IS DISTINCT FROM fake_event.external_reference
     OR lifecycle.amount_cents IS DISTINCT FROM prepared.amount_cents
     OR lifecycle.currency IS DISTINCT FROM prepared.currency
     OR lifecycle.task_draft_id IS DISTINCT FROM prepared.task_draft_id
     OR lifecycle.task_id IS DISTINCT FROM prepared.task_id
     OR lifecycle.eligibility_decision_id IS DISTINCT FROM prepared.eligibility_decision_id
     OR lifecycle.scope_version_id IS DISTINCT FROM prepared.scope_version_id
     OR lifecycle.change_order_id IS DISTINCT FROM prepared.change_order_id
     OR lifecycle.completion_fact_id IS DISTINCT FROM prepared.completion_fact_id
     OR lifecycle.predecessor_event_id IS DISTINCT FROM prepared.predecessor_event_id
     OR lifecycle.recorded_by IS DISTINCT FROM prepared.recorded_by
     OR lifecycle.evidence->>'providerState' IS DISTINCT FROM fake_event.state
     OR (lifecycle.evidence->>'providerOperationVersion')::BIGINT
          IS DISTINCT FROM fake_event.event_version THEN
    RAISE EXCEPTION 'HXUV1-FLB-16: lifecycle event is not the exact terminal fake-provider projection'
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.tasks task
     WHERE task.id = lifecycle.task_id
       AND task.universal_contract_version = 1
       AND task.automation_classification = 'CONTROLLED_TEST'
       AND task.worker_id IS NULL
  ) THEN
    RAISE EXCEPTION 'HXUV1-FLB-17: fake lifecycle bridge is confined to unassigned controlled-test tasks'
      USING ERRCODE = 'P0001';
  END IF;

  IF prepared.operation_kind IS DISTINCT FROM 'PREPARE_PAYMENT_METHOD' AND NOT EXISTS (
    SELECT 1
      FROM public.task_financial_security_events predecessor
     WHERE predecessor.id = lifecycle.predecessor_event_id
       AND predecessor.operation_id = prepared.related_operation_id::TEXT
       AND predecessor.id = prepared.predecessor_event_id
  ) THEN
    RAISE EXCEPTION 'HXUV1-FLB-18: related operation is not the exact lifecycle predecessor'
      USING ERRCODE = 'P0001';
  END IF;

  IF prepared.authority_context_sha256 = zero_sha
     OR requested.request_sha256 = zero_sha
     OR requested.command_identity_sha256 = zero_sha
     OR attempted.attempt_identity_sha256 = zero_sha
     OR outcome.outcome_identity_sha256 = zero_sha
     OR fake_operation.identity_sha256 = zero_sha
     OR fake_event.request_sha256 = zero_sha
     OR fake_event.response_sha256 = zero_sha THEN
    RAISE EXCEPTION 'HXUV1-FLB-19: zero digest cannot establish lifecycle authority'
      USING ERRCODE = 'P0001';
  END IF;

  derived_lifecycle_identity := encode(
    public.hxos_universal_v1_sha256_bytes_v1(
      'HUSTLEXP_UNIVERSAL_V1_FAKE_LIFECYCLE_EVENT_V1:' ||
      lifecycle.id::TEXT || ':' || lifecycle.operation_id || ':' ||
      lifecycle.event_kind || ':' || lifecycle.status || ':' ||
      lifecycle.expected_version::TEXT || ':' || lifecycle.task_draft_id::TEXT || ':' ||
      lifecycle.task_id::TEXT || ':' || lifecycle.eligibility_decision_id::TEXT || ':' ||
      lifecycle.scope_version_id::TEXT || ':' ||
      COALESCE(lifecycle.change_order_id::TEXT, '') || ':' ||
      COALESCE(lifecycle.completion_fact_id::TEXT, '') || ':' ||
      COALESCE(lifecycle.predecessor_event_id::TEXT, '') || ':' ||
      COALESCE(lifecycle.amount_cents::TEXT, '') || ':' ||
      COALESCE(lifecycle.currency, '') || ':' || lifecycle.recorded_by::TEXT || ':' ||
      fake_event.event_id::TEXT || ':' || fake_event.response_sha256,
      'sha256'
    ),
    'hex'
  );

  NEW.fake_operation_id := fake_operation.operation_id;
  NEW.fake_operation_kind := fake_operation.operation_kind;
  NEW.fake_event_version := fake_event.event_version;
  NEW.fake_provider_state := fake_event.state;
  NEW.lifecycle_event_kind := lifecycle.event_kind;
  NEW.lifecycle_status := lifecycle.status;
  NEW.provider_expected_version := prepared.provider_expected_version;
  NEW.lifecycle_expected_version := prepared.lifecycle_expected_version;
  NEW.task_draft_id := prepared.task_draft_id;
  NEW.task_id := prepared.task_id;
  NEW.eligibility_decision_id := prepared.eligibility_decision_id;
  NEW.scope_version_id := prepared.scope_version_id;
  NEW.change_order_id := prepared.change_order_id;
  NEW.completion_fact_id := prepared.completion_fact_id;
  NEW.predecessor_event_id := prepared.predecessor_event_id;
  NEW.recorded_by := prepared.recorded_by;
  NEW.amount_cents := prepared.amount_cents;
  NEW.currency := prepared.currency;
  NEW.related_operation_id := prepared.related_operation_id;
  NEW.prepared_authority_sha256 := prepared.authority_context_sha256;
  NEW.provider_request_sha256 := requested.request_sha256;
  NEW.command_identity_sha256 := requested.command_identity_sha256;
  NEW.dispatch_attempt_identity_sha256 := attempted.attempt_identity_sha256;
  NEW.outcome_identity_sha256 := outcome.outcome_identity_sha256;
  NEW.fake_operation_identity_sha256 := fake_operation.identity_sha256;
  NEW.fake_event_request_sha256 := fake_event.request_sha256;
  NEW.fake_event_response_sha256 := fake_event.response_sha256;
  NEW.external_reference_sha256 := expected_external_reference_sha256;
  NEW.lifecycle_event_identity_sha256 := derived_lifecycle_identity;
  NEW.materialized_at := clock_timestamp();
  NEW.authority_chain_sha256 := encode(
    public.hxos_universal_v1_sha256_bytes_v1(
      'HUSTLEXP_UNIVERSAL_V1_FAKE_FINANCIAL_LIFECYCLE_BRIDGE_V1:' ||
      prepared.prepared_command_id::TEXT || ':' || prepared.authority_context_sha256 || ':' ||
      requested.command_id::TEXT || ':' || requested.command_identity_sha256 || ':' ||
      attempted.dispatch_attempt_id::TEXT || ':' || attempted.attempt_identity_sha256 || ':' ||
      outcome.outcome_fact_id::TEXT || ':' || outcome.outcome_identity_sha256 || ':' ||
      fake_operation.operation_id::TEXT || ':' || fake_operation.operation_kind || ':' ||
      fake_operation.identity_sha256 || ':' || fake_event.event_id::TEXT || ':' ||
      fake_event.event_version::TEXT || ':' || fake_event.provider_request_sha256 || ':' ||
      fake_event.request_sha256 || ':' || fake_event.response_sha256 || ':' ||
      lifecycle.id::TEXT || ':' ||
      derived_lifecycle_identity,
      'sha256'
    ),
    'hex'
  );
  RETURN NEW;
END;
$$;

-- The v5 reconciliation trigger reached both helpers transitively. Normalize
-- them here so the protected Work Order authority graph never depends on the
-- mutable pgcrypto digest symbol or an unsealed helper body.
CREATE OR REPLACE FUNCTION public.universal_v1_fake_terminal_operation_id_v1(
  terminal_idempotency_key TEXT,
  operation_label TEXT
)
RETURNS UUID
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
DECLARE
  hexadecimal TEXT;
  variant_nibble TEXT;
BEGIN
  hexadecimal := pg_catalog.substr(
    pg_catalog.encode(
      public.hxos_universal_v1_sha256_bytes_v1(
        terminal_idempotency_key || ':' || operation_label,
        'sha256'
      ),
      'hex'
    ),
    1,
    32
  );
  variant_nibble := CASE pg_catalog.substr(hexadecimal, 17, 1)
    WHEN '0' THEN '8' WHEN '1' THEN '9' WHEN '2' THEN 'a' WHEN '3' THEN 'b'
    WHEN '4' THEN '8' WHEN '5' THEN '9' WHEN '6' THEN 'a' WHEN '7' THEN 'b'
    WHEN '8' THEN '8' WHEN '9' THEN '9' WHEN 'a' THEN 'a' WHEN 'b' THEN 'b'
    WHEN 'c' THEN '8' WHEN 'd' THEN '9' WHEN 'e' THEN 'a' WHEN 'f' THEN 'b'
  END;
  hexadecimal := overlay(hexadecimal placing '4' from 13 for 1);
  hexadecimal := overlay(hexadecimal placing variant_nibble from 17 for 1);
  RETURN (
    pg_catalog.substr(hexadecimal, 1, 8) || '-' ||
    pg_catalog.substr(hexadecimal, 9, 4) || '-' ||
    pg_catalog.substr(hexadecimal, 13, 4) || '-' ||
    pg_catalog.substr(hexadecimal, 17, 4) || '-' ||
    pg_catalog.substr(hexadecimal, 21, 12)
  )::UUID;
END;
$$;

CREATE OR REPLACE FUNCTION public.universal_v1_fake_terminal_reconciliation_snapshot_sha256_v1(
  checked_terminal_intent_id UUID
)
RETURNS CHAR(64)
LANGUAGE plpgsql
STABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
DECLARE
  intent public.universal_v1_fake_terminal_lifecycle_intents%ROWTYPE;
  capture_event_id UUID;
  refund_event_id UUID;
  settlement_event_id UUID;
  funding_event_id UUID;
  provider_release_event_id UUID;
  payout_event_id UUID;
  bank_settlement_event_id UUID;
  stable_snapshot TEXT;
BEGIN
  SELECT * INTO intent
    FROM public.universal_v1_fake_terminal_lifecycle_intents
   WHERE terminal_intent_id = checked_terminal_intent_id;
  IF intent.terminal_intent_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT event.id INTO capture_event_id
    FROM public.task_financial_security_events event
   WHERE event.task_id = intent.task_id
     AND event.operation_id = public.universal_v1_fake_terminal_operation_id_v1(
       intent.idempotency_key,
       'capture'
     )::TEXT
     AND event.event_kind = 'CAPTURED'
     AND event.status = 'SUCCEEDED'
     AND event.expected_version = intent.starting_financial_version + 1;
  IF capture_event_id IS NULL THEN
    RETURN NULL;
  END IF;

  IF intent.terminal_path IS NULL
     OR intent.terminal_path NOT IN ('SETTLED', 'FULL_REFUND') THEN
    RETURN NULL;
  END IF;

  IF intent.terminal_path = 'SETTLED' THEN
    SELECT event.id INTO settlement_event_id
      FROM public.task_financial_security_events event
     WHERE event.task_id = intent.task_id
       AND event.operation_id = public.universal_v1_fake_terminal_operation_id_v1(
         intent.idempotency_key,
         'settle'
       )::TEXT
       AND event.event_kind = 'SETTLEMENT_OBSERVED'
       AND event.status = 'SUCCEEDED'
       AND event.expected_version = intent.starting_financial_version + 2;
    SELECT event.id INTO funding_event_id
      FROM public.task_financial_security_events event
     WHERE event.task_id = intent.task_id
       AND event.operation_id = public.universal_v1_fake_terminal_operation_id_v1(
         intent.idempotency_key,
         'fund'
       )::TEXT
       AND event.event_kind = 'FUNDING_OBSERVED'
       AND event.status = 'SUCCEEDED'
       AND event.expected_version = intent.starting_financial_version + 3;
    SELECT event.id INTO provider_release_event_id
      FROM public.task_financial_security_events event
     WHERE event.task_id = intent.task_id
       AND event.operation_id = public.universal_v1_fake_terminal_operation_id_v1(
         intent.idempotency_key,
         'provider-release'
       )::TEXT
       AND event.event_kind = 'PROVIDER_RELEASED'
       AND event.status = 'SUCCEEDED'
       AND event.expected_version = intent.starting_financial_version + 4;
    SELECT event.id INTO payout_event_id
      FROM public.task_financial_security_events event
     WHERE event.task_id = intent.task_id
       AND event.operation_id = public.universal_v1_fake_terminal_operation_id_v1(
         intent.idempotency_key,
         'payout'
       )::TEXT
       AND event.event_kind = 'PAYOUT_OBSERVED'
       AND event.status = 'SUCCEEDED'
       AND event.expected_version = intent.starting_financial_version + 5;
    SELECT event.id INTO bank_settlement_event_id
      FROM public.task_financial_security_events event
     WHERE event.task_id = intent.task_id
       AND event.operation_id = public.universal_v1_fake_terminal_operation_id_v1(
         intent.idempotency_key,
         'bank-settlement'
       )::TEXT
       AND event.event_kind = 'BANK_SETTLEMENT_OBSERVED'
       AND event.status = 'SUCCEEDED'
       AND event.expected_version = intent.starting_financial_version + 6;
    IF settlement_event_id IS NULL
       OR funding_event_id IS NULL
       OR provider_release_event_id IS NULL
       OR payout_event_id IS NULL
       OR bank_settlement_event_id IS NULL THEN
      RETURN NULL;
    END IF;
  ELSE
    SELECT event.id INTO refund_event_id
      FROM public.task_financial_security_events event
     WHERE event.task_id = intent.task_id
       AND event.operation_id = public.universal_v1_fake_terminal_operation_id_v1(
         intent.idempotency_key,
         'full-refund'
       )::TEXT
       AND event.event_kind = 'REFUNDED'
       AND event.status = 'SUCCEEDED'
       AND event.expected_version = intent.starting_financial_version + 2;
    IF refund_event_id IS NULL THEN
      RETURN NULL;
    END IF;
  END IF;

  stable_snapshot := '{' ||
    CASE WHEN bank_settlement_event_id IS NULL THEN '' ELSE
      '"bankSettlementEventId":' || pg_catalog.to_jsonb(bank_settlement_event_id::TEXT)::TEXT || ',' END ||
    '"bankSettlementState":' || pg_catalog.to_jsonb(
      CASE intent.terminal_path WHEN 'SETTLED' THEN 'SETTLED' ELSE 'NOT_APPLICABLE' END
    )::TEXT || ',' ||
    '"captureEventId":' || pg_catalog.to_jsonb(capture_event_id::TEXT)::TEXT || ',' ||
    '"captureState":"CAPTURED",' ||
    '"currency":' || pg_catalog.to_jsonb(intent.currency::TEXT)::TEXT || ',' ||
    '"customerLedgerAmountCents":' || CASE intent.terminal_path
      WHEN 'SETTLED' THEN intent.customer_amount_cents::TEXT ELSE '0' END || ',' ||
    '"expectedVersion":' || intent.starting_reconciliation_version::TEXT || ',' ||
    CASE WHEN funding_event_id IS NULL THEN '' ELSE
      '"fundingEventId":' || pg_catalog.to_jsonb(funding_event_id::TEXT)::TEXT || ',' END ||
    '"fundingState":' || pg_catalog.to_jsonb(
      CASE intent.terminal_path WHEN 'SETTLED' THEN 'FUNDED' ELSE 'NOT_APPLICABLE' END
    )::TEXT || ',' ||
    '"ledgerState":"MATCHED",' ||
    '"mismatchCodes":[],' ||
    CASE WHEN payout_event_id IS NULL THEN '' ELSE
      '"payoutEventId":' || pg_catalog.to_jsonb(payout_event_id::TEXT)::TEXT || ',' END ||
    '"payoutState":' || pg_catalog.to_jsonb(
      CASE intent.terminal_path WHEN 'SETTLED' THEN 'PAID' ELSE 'NOT_APPLICABLE' END
    )::TEXT || ',' ||
    '"providerLedgerAmountCents":' || CASE intent.terminal_path
      WHEN 'SETTLED' THEN intent.provider_amount_cents::TEXT ELSE '0' END || ',' ||
    CASE WHEN provider_release_event_id IS NULL THEN '' ELSE
      '"providerReleaseEventId":' || pg_catalog.to_jsonb(provider_release_event_id::TEXT)::TEXT || ',' END ||
    '"providerReleaseState":' || pg_catalog.to_jsonb(
      CASE intent.terminal_path WHEN 'SETTLED' THEN 'RELEASED' ELSE 'NOT_APPLICABLE' END
    )::TEXT || ',' ||
    '"reconciliationState":' || pg_catalog.to_jsonb(
      CASE intent.terminal_path WHEN 'SETTLED' THEN 'MATCHED' ELSE 'CLOSED' END
    )::TEXT || ',' ||
    '"reconciliationVersion":' || (intent.starting_reconciliation_version + 1)::TEXT || ',' ||
    '"recordedBy":' || pg_catalog.to_jsonb(intent.requested_by::TEXT)::TEXT || ',' ||
    CASE WHEN refund_event_id IS NULL THEN '' ELSE
      '"refundEventId":' || pg_catalog.to_jsonb(refund_event_id::TEXT)::TEXT || ',' END ||
    '"refundState":' || pg_catalog.to_jsonb(
      CASE intent.terminal_path WHEN 'FULL_REFUND' THEN 'REFUNDED' ELSE 'NOT_APPLICABLE' END
    )::TEXT || ',' ||
    '"reversalState":"NOT_APPLICABLE",' ||
    CASE WHEN settlement_event_id IS NULL THEN '' ELSE
      '"settlementEventId":' || pg_catalog.to_jsonb(settlement_event_id::TEXT)::TEXT || ',' END ||
    '"settlementState":' || pg_catalog.to_jsonb(
      CASE intent.terminal_path WHEN 'SETTLED' THEN 'SETTLED' ELSE 'NOT_APPLICABLE' END
    )::TEXT || ',' ||
    CASE WHEN intent.prior_reconciliation_fact_id IS NULL THEN '' ELSE
      '"supersedesFactId":' ||
      pg_catalog.to_jsonb(intent.prior_reconciliation_fact_id::TEXT)::TEXT || ',' END ||
    '"voidState":"NOT_APPLICABLE",' ||
    '"workOrderId":' || pg_catalog.to_jsonb(intent.work_order_id::TEXT)::TEXT ||
    '}';

  RETURN pg_catalog.encode(
    public.hxos_universal_v1_sha256_bytes_v1(stable_snapshot, 'sha256'),
    'hex'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.universal_v1_fake_terminal_operation_id_v1(TEXT, TEXT)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION
  public.universal_v1_fake_terminal_reconciliation_snapshot_sha256_v1(UUID)
  FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.validate_universal_v1_fake_terminal_reconcile_command()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  intent public.universal_v1_fake_terminal_lifecycle_intents%ROWTYPE;
  task_record public.tasks%ROWTYPE;
  expected_related_operation_id UUID;
  expected_reconciliation_snapshot_sha256 CHAR(64);
  expected_provider_request TEXT;
  expected_provider_request_sha256 CHAR(64);
BEGIN
  IF NEW.operation_kind <> 'RECONCILE' OR NEW.work_order_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT task.* INTO task_record
    FROM public.task_work_orders work_order
    JOIN public.tasks task ON task.id = work_order.task_id
   WHERE work_order.id = NEW.work_order_id
   FOR SHARE OF task;
  IF task_record.id IS NULL
     OR task_record.automation_classification IS DISTINCT FROM 'CONTROLLED_TEST' THEN
    RETURN NEW;
  END IF;
  SELECT * INTO intent
    FROM public.universal_v1_fake_terminal_lifecycle_intents
   WHERE work_order_id = NEW.work_order_id
   FOR SHARE;
  IF intent.terminal_intent_id IS NULL THEN
    RAISE EXCEPTION 'HXUV1-FTL-43: controlled-test reconciliation requires one exact terminal intent before provider I/O'
      USING ERRCODE = 'P0001';
  END IF;
  expected_related_operation_id := public.universal_v1_fake_terminal_operation_id_v1(
    intent.idempotency_key,
    CASE intent.terminal_path
      WHEN 'SETTLED' THEN 'bank-settlement'
      ELSE 'full-refund'
    END
  );
  expected_reconciliation_snapshot_sha256 :=
    public.universal_v1_fake_terminal_reconciliation_snapshot_sha256_v1(
      intent.terminal_intent_id
    );
  expected_provider_request :=
    '{"expectedVersion":0' ||
    ',"idempotencyKey":' ||
      to_jsonb(intent.idempotency_key || ':reconciliation')::TEXT ||
    ',"operationId":' || to_jsonb(
      public.universal_v1_fake_terminal_operation_id_v1(
        intent.idempotency_key,
        'reconciliation'
      )::TEXT
    )::TEXT ||
    ',"reconciliationSnapshotSha256":' ||
      to_jsonb(expected_reconciliation_snapshot_sha256::TEXT)::TEXT ||
    ',"relatedOperationId":' || to_jsonb(expected_related_operation_id::TEXT)::TEXT ||
    ',"scenario":"SUCCESS"}';
  expected_provider_request_sha256 := encode(
    public.hxos_universal_v1_sha256_bytes_v1(expected_provider_request, 'sha256'),
    'hex'
  );
  IF NEW.provider_kind IS DISTINCT FROM 'FAKE'
     OR NEW.provider_expected_version IS DISTINCT FROM 0
     OR NEW.operation_id IS DISTINCT FROM public.universal_v1_fake_terminal_operation_id_v1(
          intent.idempotency_key,
          'reconciliation'
        )
     OR NEW.idempotency_key IS DISTINCT FROM intent.idempotency_key || ':reconciliation'
     OR NEW.work_order_id IS DISTINCT FROM intent.work_order_id
     OR NEW.related_operation_id IS DISTINCT FROM expected_related_operation_id
     OR num_nonnulls(
          NEW.prepared_financial_command_id,
          NEW.prepared_authority_sha256,
          NEW.task_draft_id,
          NEW.task_id,
          NEW.amount_cents,
          NEW.currency
        ) IS DISTINCT FROM 0
     OR NEW.recorded_actor_id IS DISTINCT FROM intent.requested_by
     OR NEW.recorded_actor_kind IS DISTINCT FROM 'PARTICIPANT'
     OR expected_reconciliation_snapshot_sha256 IS NULL
     OR NEW.request_sha256 IS DISTINCT FROM expected_provider_request_sha256 THEN
    RAISE EXCEPTION 'HXUV1-FTL-44: reconciliation REQUESTED fact does not match the exact terminal intent identity'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_universal_v1_fake_expiry_bridge_v9()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  raw_recorded_at TIMESTAMPTZ;
  raw_expiry TIMESTAMPTZ;
  lifecycle_occurred_at TIMESTAMPTZ;
  lifecycle_expiry TIMESTAMPTZ;
  exact_expiry_authority_sha256 CHAR(64);
BEGIN
  SELECT raw.recorded_at, raw.expires_at
    INTO raw_recorded_at, raw_expiry
    FROM public.hxos_fake_financial_operation_events_v1 raw
   WHERE raw.event_id = NEW.fake_operation_event_id
   FOR SHARE;
  SELECT lifecycle.occurred_at, lifecycle.expires_at
    INTO lifecycle_occurred_at, lifecycle_expiry
    FROM public.task_financial_security_events lifecycle
   WHERE lifecycle.id = NEW.task_financial_security_event_id
   FOR SHARE;

  IF raw_recorded_at IS NULL
     OR raw_recorded_at IS DISTINCT FROM lifecycle_occurred_at
     OR raw_expiry IS DISTINCT FROM lifecycle_expiry THEN
    RAISE EXCEPTION 'HXUV1-FSE-V9-1: canonical provider time and expiry are not the exact raw fake-provider facts'
      USING ERRCODE = 'P0001';
  END IF;

  exact_expiry_authority_sha256 := encode(
    public.hxos_universal_v1_sha256_bytes_v1(
      NEW.fake_operation_event_id::TEXT || ':' ||
      NEW.task_financial_security_event_id::TEXT || ':' ||
      ((extract(epoch FROM raw_recorded_at) * 1000000)::BIGINT)::TEXT || ':' ||
      COALESCE(
        ((extract(epoch FROM raw_expiry) * 1000000)::BIGINT)::TEXT,
        'NO_EXPIRY'
      ),
      'sha256'
    ),
    'hex'
  );

  IF NEW.provider_recorded_at IS NOT NULL
     AND NEW.provider_recorded_at IS DISTINCT FROM raw_recorded_at THEN
    RAISE EXCEPTION 'HXUV1-FSE-V9-2: bridge provider occurrence differs from raw provider truth'
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.provider_expires_at IS NOT NULL
     AND NEW.provider_expires_at IS DISTINCT FROM raw_expiry THEN
    RAISE EXCEPTION 'HXUV1-FSE-V9-3: bridge provider expiry differs from raw provider truth'
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.expiry_authority_sha256 IS NOT NULL
     AND NEW.expiry_authority_sha256 IS DISTINCT FROM exact_expiry_authority_sha256 THEN
    RAISE EXCEPTION 'HXUV1-FSE-V9-4: bridge expiry authority digest differs from exact facts'
      USING ERRCODE = 'P0001';
  END IF;

  NEW.provider_recorded_at := raw_recorded_at;
  NEW.provider_expires_at := raw_expiry;
  NEW.expiry_authority_sha256 := exact_expiry_authority_sha256;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.validate_universal_v1_fake_financial_lifecycle_bridge()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.validate_universal_v1_fake_terminal_reconcile_command()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_universal_v1_fake_expiry_bridge_v9()
  FROM PUBLIC;
ALTER FUNCTION public.enforce_universal_v1_fake_expiry_bridge_v9()
  SET search_path TO pg_catalog, public;
-- v6 also replaces this engine trigger after ordinal146; retain its newer
-- body but restore the fixed path required by the sealed Work Order closure.
ALTER FUNCTION public.enforce_task_region_policy_binding()
  SET search_path TO pg_catalog, public;
ALTER FUNCTION public.prevent_change_order_adjust_after_terminal_recovery()
  SET search_path TO pg_catalog, public;
ALTER FUNCTION public.reject_universal_v1_fake_financial_lifecycle_bridge_mutation()
  SET search_path TO pg_catalog, public;
ALTER FUNCTION public.require_universal_v1_controlled_fake_lifecycle_bridge()
  SET search_path TO pg_catalog, public;
ALTER FUNCTION public.validate_universal_v1_fake_financial_lifecycle_bridge()
  SET search_path TO pg_catalog, public;
ALTER FUNCTION public.validate_universal_v1_fake_terminal_reconcile_command()
  SET search_path TO pg_catalog, public;
ALTER FUNCTION public.require_legacy_expiry_terminal_before_outcome_v10()
  SET search_path TO pg_catalog;
REVOKE ALL ON FUNCTION public.require_universal_v1_controlled_fake_lifecycle_bridge()
  FROM PUBLIC;
ALTER FUNCTION public.hxos_reject_fake_financial_mutation_v1()
  SET search_path TO pg_catalog;
REVOKE ALL ON FUNCTION public.hxos_reject_fake_financial_mutation_v1()
  FROM PUBLIC;

-- Every fake-financial successor and every Work Order materialization/recovery
-- shares one task-scoped transaction lock. The trigger is SECURITY INVOKER and
-- performs no DML; it closes the successor-insert window without granting a
-- hidden writer or positive financial capability.
CREATE FUNCTION public.serialize_universal_v1_financial_security_task_v12()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
VOLATILE
PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'hxuv1-financial-security-task:' || NEW.task_id::TEXT,
      0
    )
  );
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.serialize_universal_v1_financial_security_task_v12()
  FROM PUBLIC;

CREATE TRIGGER serialize_universal_v1_financial_security_task_v12
BEFORE INSERT ON public.task_financial_security_events
FOR EACH ROW
EXECUTE FUNCTION public.serialize_universal_v1_financial_security_task_v12();

-- Collision rejection is intentional. Canonical ledger replay skips this SQL;
-- a precreated object must never be normalized into trusted v12 evidence.
CREATE TABLE public.hxos_fake_financial_schema_evidence_v12 (
  migration_name TEXT PRIMARY KEY CHECK (
    migration_name =
      '20261015_universal_v1_work_order_fake_financial_authority_hardening_v12'
  ),
  migration_sql_sha256 CHAR(64) NOT NULL CHECK (
    migration_sql_sha256 ~ '^[0-9a-f]{64}$'
    AND migration_sql_sha256 <> pg_catalog.repeat('0', 64)
  ),
  ordinal146_sql_sha256 CHAR(64) NOT NULL DEFAULT
    '3920ac8d3208b9f573dc331cab60c373d0349611700c6e14a6e4c1dd8c53aac4'
    CHECK (
      ordinal146_sql_sha256 =
        '3920ac8d3208b9f573dc331cab60c373d0349611700c6e14a6e4c1dd8c53aac4'
    ),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

CREATE TRIGGER hxos_fake_financial_schema_evidence_append_only_v12
BEFORE UPDATE OR DELETE ON public.hxos_fake_financial_schema_evidence_v12
FOR EACH ROW EXECUTE FUNCTION public.hxos_reject_fake_financial_mutation_v1();

CREATE TRIGGER hxos_fake_financial_schema_evidence_no_truncate_v12
BEFORE TRUNCATE ON public.hxos_fake_financial_schema_evidence_v12
FOR EACH STATEMENT EXECUTE FUNCTION public.hxos_reject_fake_financial_mutation_v1();

COMMENT ON TABLE public.hxos_fake_financial_schema_evidence_v12 IS
  'Append-only exact-SQL evidence that canonical engine ordinal146 and nonproduction fake-finance v1-v11 converged to the certified Work Order trigger authority surface.';

REVOKE ALL ON TABLE public.hxos_fake_financial_schema_evidence_v12 FROM PUBLIC;

-- The normalized combined chain must converge to the one pinned migration-level
-- catalog. Runtime owner classes, ACLs, default privileges, and source bodies
-- are certified later in one atomic snapshot by the eight-role verifier.
DO $$
DECLARE
  trigger_count INTEGER;
  trigger_catalog_sha256 TEXT;
  invalid_function TEXT;
BEGIN
  WITH trigger_rows AS (
    SELECT pg_catalog.format('%I.%I', namespace_state.nspname, relation_state.relname)
             || '|' || trigger_state.tgname
             || '|' || pg_catalog.format(
                  '%I.%I(%s)', function_namespace.nspname, function_state.proname,
                  pg_catalog.oidvectortypes(function_state.proargtypes)
                )
             || '|' || pg_catalog.pg_get_triggerdef(trigger_state.oid, false)
             || '|' || trigger_state.tgenabled::TEXT
             || '|' || function_state.prolang::pg_catalog.regproc::TEXT
             || '|' || function_state.prokind::TEXT
             || '|' || function_state.prorettype::pg_catalog.regtype::TEXT
             || '|' || function_state.prosecdef::TEXT
             || '|' || function_state.proisstrict::TEXT
             || '|' || function_state.proleakproof::TEXT
             || '|' || function_state.provolatile::TEXT
             || '|' || function_state.proparallel::TEXT
             || '|' || function_state.prosrc AS line
      FROM pg_catalog.pg_trigger trigger_state
      JOIN pg_catalog.pg_class relation_state
        ON relation_state.oid = trigger_state.tgrelid
      JOIN pg_catalog.pg_namespace namespace_state
        ON namespace_state.oid = relation_state.relnamespace
      JOIN pg_catalog.pg_proc function_state
        ON function_state.oid = trigger_state.tgfoid
      JOIN pg_catalog.pg_namespace function_namespace
        ON function_namespace.oid = function_state.pronamespace
     WHERE trigger_state.tgisinternal IS FALSE
       AND pg_catalog.format('%I.%I', namespace_state.nspname, relation_state.relname)
             = ANY (ARRAY[
               'hx_authority.universal_v1_actor_assertion_consumption_facts',
               'hx_authority.universal_v1_actor_assertion_issuance_facts',
               'hx_authority.universal_v1_work_order_command_execution_facts',
               'hx_authority.universal_v1_work_order_target_authority_facts',
               'public.admin_roles',
               'public.business_credentials',
               'public.business_memberships',
               'public.business_organizations',
               'public.capability_profiles',
               'public.current_verified_trade_qualifications',
               'public.financial_provider_command_journal',
               'public.financial_provider_command_outcome_facts',
               'public.hxos_universal_v1_work_order_target_activation_barrier_v1',
               'public.hxos_fake_financial_schema_evidence_v12',
               'public.major_action_class_contracts',
               'public.major_action_events',
               'public.major_action_outcomes',
               'public.provider_estimate_submissions',
               'public.recommendations',
               'public.task_applications',
               'public.task_drafts',
               'public.task_estimate_acceptance_materializations',
               'public.task_financial_security_events',
               'public.task_provider_eligibility_decisions',
               'public.task_reservations',
               'public.task_reservation_requests',
               'public.task_routing_decisions',
               'public.task_scope_versions',
               'public.task_work_order_command_requests',
               'public.task_work_orders',
               'public.task_work_order_execution_facts',
               'public.universal_v1_fake_financial_lifecycle_bridges',
               'public.universal_v1_service_cell_authorities',
               'public.universal_v1_work_order_compensation_commands',
               'public.tasks',
               'public.users',
               'public.verified_trades',
               'public.worker_counter_offers',
               'public.worker_offer_decisions'
             ]::TEXT[])
  )
  SELECT pg_catalog.count(*)::INTEGER,
         pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
           COALESCE(pg_catalog.string_agg(line, E'\n' ORDER BY line), ''),
           'UTF8'
         )), 'hex')
    INTO trigger_count, trigger_catalog_sha256
    FROM trigger_rows;

  IF trigger_count <> 167
     OR trigger_catalog_sha256 <>
          'f9f21a5c97f88b6eed26d5e1cfe36bb25463f06cb9a769a713642c07a3c7e441' THEN
    RAISE EXCEPTION
      'HXUV1-WOCMD-V12-4: normalized trigger catalog mismatch (% / %)',
      trigger_count,
      COALESCE(trigger_catalog_sha256, 'MISSING')
      USING ERRCODE = 'P0001';
  END IF;

  SELECT expected.function_identity
    INTO invalid_function
    FROM (VALUES
      ('public.enforce_task_region_policy_binding()',
       ARRAY['search_path=pg_catalog, public']::TEXT[]),
      ('public.enforce_universal_v1_fake_expiry_bridge_v9()',
       ARRAY['search_path=pg_catalog, public']::TEXT[]),
      ('public.prevent_change_order_adjust_after_terminal_recovery()',
       ARRAY['search_path=pg_catalog, public']::TEXT[]),
      ('public.reject_universal_v1_fake_financial_lifecycle_bridge_mutation()',
       ARRAY['search_path=pg_catalog, public']::TEXT[]),
      ('public.require_universal_v1_controlled_fake_lifecycle_bridge()',
       ARRAY['search_path=pg_catalog, public']::TEXT[]),
      ('public.validate_universal_v1_fake_financial_lifecycle_bridge()',
       ARRAY['search_path=pg_catalog, public']::TEXT[]),
      ('public.validate_universal_v1_fake_terminal_reconcile_command()',
       ARRAY['search_path=pg_catalog, public']::TEXT[]),
      ('public.require_legacy_expiry_terminal_before_outcome_v10()',
       ARRAY['search_path=pg_catalog']::TEXT[]),
      ('public.serialize_universal_v1_financial_security_task_v12()',
       ARRAY['search_path=pg_catalog']::TEXT[])
    ) expected(function_identity, expected_configuration)
    LEFT JOIN pg_catalog.pg_proc function_state
      ON function_state.oid =
           pg_catalog.to_regprocedure(expected.function_identity)::OID
   WHERE function_state.oid IS NULL
      OR function_state.proconfig IS DISTINCT FROM expected.expected_configuration
   ORDER BY expected.function_identity
   LIMIT 1;
  IF invalid_function IS NOT NULL THEN
    RAISE EXCEPTION
      'HXUV1-WOCMD-V12-5: supplemental trigger function is missing or unsafe: %',
      invalid_function
      USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.aclexplode(COALESCE(
        (
          SELECT function_state.proacl
            FROM pg_catalog.pg_proc function_state
           WHERE function_state.oid = pg_catalog.to_regprocedure(
             'public.require_universal_v1_controlled_fake_lifecycle_bridge()'
           )::OID
        ),
        pg_catalog.acldefault(
          'f',
          (
            SELECT function_state.proowner
              FROM pg_catalog.pg_proc function_state
             WHERE function_state.oid = pg_catalog.to_regprocedure(
               'public.require_universal_v1_controlled_fake_lifecycle_bridge()'
             )::OID
          )
        )
      )) privilege
     WHERE privilege.grantee = 0
       AND privilege.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION
      'HXUV1-WOCMD-V12-6: controlled fake-lifecycle guard retains PUBLIC execute'
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;
