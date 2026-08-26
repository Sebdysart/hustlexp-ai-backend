\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION pg_temp.hx_pr276_assert(condition boolean, message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF condition IS NOT TRUE THEN
    RAISE EXCEPTION 'HXPR276 assertion failed: %', message;
  END IF;
END;
$$;

SELECT pg_temp.hx_pr276_assert(
  (SELECT count(*) = 116 AND count(DISTINCT name) = 116 FROM public.applied_migrations),
  'the append-only engine ledger must contain bootstrap plus exactly 115 migration names'
);

SELECT pg_temp.hx_pr276_assert(
  EXISTS (
    SELECT 1 FROM public.applied_migrations
    WHERE name = '20260825_pr276_incident_containment'
  ),
  'the forward containment migration must be recorded'
);

SELECT pg_temp.hx_pr276_assert(
  (
    SELECT count(*) = 116
      AND count(DISTINCT ordinal) = 116
      AND min(ordinal) = 0
      AND max(ordinal) = 115
      AND bool_and(source_sha256 ~ '^[a-f0-9]{64}$')
      AND bool_and(ordinal >= 0)
    FROM public.applied_migrations
  )
  AND EXISTS (
    SELECT 1 FROM public.applied_migrations
    WHERE name = 'constitutional_schema_v1' AND ordinal = 0
  )
  AND EXISTS (
    SELECT 1 FROM public.applied_migrations
    WHERE name = '20260825_pr276_incident_containment' AND ordinal = 115
  ),
  'the migration ledger must bind every declared ordinal to a SHA-256 source identity'
);

SELECT pg_temp.hx_pr276_assert(
  (
    SELECT count(*) = 1
      AND bool_and(identity.cluster_system_identifier = control.system_identifier::text)
      AND bool_and(identity.database_oid = database_row.oid)
      AND bool_and(identity.database_name = database_row.datname)
      AND bool_and(identity.migration_owner = current_user)
    FROM public.hx_database_identity identity
    CROSS JOIN pg_catalog.pg_control_system() control
    JOIN pg_catalog.pg_database database_row ON database_row.datname = current_database()
    WHERE identity.singleton IS TRUE
  )
  AND current_user = session_user,
  'database identity must bind the direct migrator to this immutable cluster/database pair'
);

SELECT pg_temp.hx_pr276_assert(
  (
    SELECT count(*) = 9
    FROM public.applied_migrations
    WHERE name = ANY (ARRAY[
      '20260819_ops_web_hardening',
      '20260821_ops_business_claim_links',
      '20260821_business_ownership',
      '20260821_business_claim_links_extra',
      '20260823_business_fulfiller_lifecycle',
      '20260823_business_payout_tables',
      '20260824_enforce_controlled_test_business_acceptance',
      '20260824_business_controlled_test_acceptance',
      '20260824_orchestration_mode'
    ])
  ),
  'all nine immutable PR276 ledger identities must remain present'
);

SELECT pg_temp.hx_pr276_assert(
  to_regclass('public.ops_business_claim_links') IS NOT NULL
    AND to_regclass('public.hxos_local_test_business_payout_destinations') IS NOT NULL
    AND to_regclass('public.hxos_local_test_business_payout_transfers') IS NOT NULL,
  'containment must converge every partial PR276 catalog without deleting historical tables'
);

SELECT pg_temp.hx_pr276_assert(
  to_regclass('public.quote_payment_recovery_operations') IS NOT NULL
    AND to_regclass('public.quote_payment_recovery_events') IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.applied_migrations
      WHERE name = '20260823_quote_payment_recovery'
    ),
  'quote-payment recovery must converge whether it was initially absent or present'
);

SELECT pg_temp.hx_pr276_assert(
  (
    WITH expected(relation_name, constraint_name, definition) AS (
      VALUES
        ('public.tasks', 'tasks_pr276_business_fulfiller_frozen',
         'CHECK ((business_fulfiller_organization_id IS NULL)) NOT VALID'),
        ('public.tasks', 'tasks_pr276_orchestration_frozen',
         'CHECK ((orchestration_mode = ''AUTOMATED''::text)) NOT VALID'),
        ('public.quotes', 'quotes_pr276_business_organization_frozen',
         'CHECK ((business_organization_id IS NULL)) NOT VALID'),
        ('public.quotes', 'quotes_pr276_business_location_frozen',
         'CHECK ((business_location_id IS NULL)) NOT VALID'),
        ('public.quotes', 'quotes_pr276_provider_service_profile_frozen',
         'CHECK ((provider_service_profile_id IS NULL)) NOT VALID'),
        ('public.quotes', 'quotes_pr276_claimed_by_user_frozen',
         'CHECK ((claimed_by_user_id IS NULL)) NOT VALID')
    )
    SELECT count(*) = 6
      AND bool_and(constraint_row.oid IS NOT NULL)
      AND bool_and(constraint_row.convalidated IS FALSE)
      AND bool_and(pg_get_constraintdef(constraint_row.oid, false) = expected.definition)
    FROM expected
    LEFT JOIN pg_constraint constraint_row
      ON constraint_row.conrelid = to_regclass(expected.relation_name)
     AND constraint_row.conname = expected.constraint_name
     AND constraint_row.contype = 'c'
  ),
  'all six exact future-write containment checks must remain NOT VALID'
);

SELECT pg_temp.hx_pr276_assert(
  (
    SELECT constraint_row.convalidated
      AND pg_get_constraintdef(constraint_row.oid, false) =
        'CHECK (((provider_transfer_status IS NULL) OR (provider_transfer_status = ANY (ARRAY[''submitted''::text, ''processing''::text, ''paid''::text, ''manual_reconciliation''::text, ''reversed''::text]))))'
    FROM pg_catalog.pg_constraint constraint_row
    WHERE constraint_row.conrelid = 'public.escrows'::regclass
      AND constraint_row.conname = 'escrows_provider_transfer_status_ck'
      AND constraint_row.contype = 'c'
      AND NOT constraint_row.condeferrable
      AND NOT constraint_row.condeferred
      AND NOT constraint_row.connoinherit
  ),
  'provider transfer status must admit confirmed reversal evidence through a validated closed check'
);

DO $provider_transfer_status_contract$
DECLARE
  v_escrow_id UUID;
  v_original_status TEXT;
BEGIN
  SELECT id, provider_transfer_status
    INTO v_escrow_id, v_original_status
    FROM public.escrows
   ORDER BY id
   LIMIT 1;
  IF v_escrow_id IS NULL THEN
    RAISE EXCEPTION 'HXPR276 provider transfer status fixture is absent';
  END IF;

  UPDATE public.escrows
     SET provider_transfer_status = 'reversed'
   WHERE id = v_escrow_id;

  BEGIN
    UPDATE public.escrows
       SET provider_transfer_status = 'unrecognized_provider_state'
     WHERE id = v_escrow_id;
    RAISE EXCEPTION 'HXPR276 expected undeclared provider transfer status rejection';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  UPDATE public.escrows
     SET provider_transfer_status = v_original_status
   WHERE id = v_escrow_id;
END;
$provider_transfer_status_contract$;

SELECT pg_temp.hx_pr276_assert(
  to_regprocedure('public.enforce_controlled_test_business_acceptance()') IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgrelid = 'public.tasks'::regclass
        AND tgname = 'controlled_test_business_acceptance_guard'
        AND NOT tgisinternal
    ),
  'the PR276 Business acceptance function and trigger must be absent'
);

SELECT pg_temp.hx_pr276_assert(
  (
    WITH expected(trigger_name, function_name) AS (
      VALUES
        ('active_refund_claim_accept_gate', 'enforce_no_active_refund_claim_on_accept'),
        ('task_region_policy_accept_insert_gate', 'enforce_task_region_policy_on_accept'),
        ('task_region_policy_accept_gate', 'enforce_task_region_policy_on_accept'),
        ('task_worker_eligibility_accept_insert_gate', 'enforce_task_worker_eligibility_on_accept'),
        ('task_worker_eligibility_accept_gate', 'enforce_task_worker_eligibility_on_accept'),
        ('controlled_test_provider_capability_accept_guard', 'enforce_controlled_test_provider_capability_on_accept'),
        ('controlled_test_offer_accept_guard', 'enforce_controlled_test_offer_acceptance'),
        ('task_liquidity_cell_accept_gate', 'enforce_task_liquidity_cell_on_accept'),
        ('task_worker_offer_accept_gate', 'enforce_worker_offer_decision_on_accept')
    )
    SELECT count(*) = 9
      AND bool_and(trigger_row.tgenabled = 'A')
      AND bool_and(procedure_row.proname = expected.function_name)
    FROM expected
    LEFT JOIN pg_trigger trigger_row
      ON trigger_row.tgrelid = 'public.tasks'::regclass
     AND trigger_row.tgname = expected.trigger_name
     AND NOT trigger_row.tgisinternal
    LEFT JOIN pg_proc procedure_row ON procedure_row.oid = trigger_row.tgfoid
  ),
  'all nine baseline and refund-claim acceptance gates must be present, exact-bound, and ENABLE ALWAYS'
);

SELECT pg_temp.hx_pr276_assert(
  (
    WITH expected(relation_name, trigger_name) AS (
      VALUES
        ('public.tasks', 'task_terminal_guard'),
        ('public.tasks', 'task_completed_requires_accepted_proof'),
        ('public.tasks', 'live_task_escrow_check'),
        ('public.tasks', 'live_task_price_check'),
        ('public.escrows', 'escrow_terminal_guard'),
        ('public.escrows', 'escrow_amount_immutable'),
        ('public.escrows', 'escrow_released_requires_completed_task'),
        ('public.escrow_events', 'escrow_events_destructive_guard'),
        ('public.escrow_events', 'escrow_events_truncate_guard'),
        ('public.admin_actions', 'admin_actions_destructive_guard'),
        ('public.admin_actions', 'admin_actions_truncate_guard'),
        ('public.xp_ledger', 'xp_requires_released_escrow'),
        ('public.xp_ledger', 'xp_ledger_no_delete'),
        ('public.xp_ledger', 'xp_ledger_no_truncate')
    )
    SELECT count(*) = 14
      AND bool_and(trigger_row.tgenabled = 'A')
    FROM expected
    LEFT JOIN pg_catalog.pg_trigger trigger_row
      ON trigger_row.tgrelid = to_regclass(expected.relation_name)
     AND trigger_row.tgname = expected.trigger_name
     AND NOT trigger_row.tgisinternal
  ),
  'all constitutional money/state triggers must be ENABLE ALWAYS'
);

SELECT pg_temp.hx_pr276_assert(
  (
    WITH expected(relation_name) AS (
      VALUES
        ('public.ops_business_claim_links'),
        ('public.hxos_local_test_business_payout_destinations'),
        ('public.hxos_local_test_business_payout_transfers')
    )
    SELECT count(*) = 3
      AND bool_and(class_row.relkind IN ('r', 'p'))
      AND bool_and(dml_guard.tgenabled = 'A' AND dml_guard.tgtype = 30)
      AND bool_and(truncate_guard.tgenabled = 'A' AND truncate_guard.tgtype = 34)
      AND bool_and(dml_guard.tgfoid = to_regprocedure('public.reject_pr276_incident_table_mutation()'))
      AND bool_and(truncate_guard.tgfoid = to_regprocedure('public.reject_pr276_incident_table_mutation()'))
    FROM expected
    LEFT JOIN pg_class class_row ON class_row.oid = to_regclass(expected.relation_name)
    LEFT JOIN pg_trigger dml_guard
      ON dml_guard.tgrelid = class_row.oid
     AND dml_guard.tgname = 'pr276_incident_dml_guard'
     AND NOT dml_guard.tgisinternal
    LEFT JOIN pg_trigger truncate_guard
      ON truncate_guard.tgrelid = class_row.oid
     AND truncate_guard.tgname = 'pr276_incident_truncate_guard'
     AND NOT truncate_guard.tgisinternal
  ),
  'each incident table must be r/p and have exact ENABLE ALWAYS DML and truncate guards'
);

SELECT pg_temp.hx_pr276_assert(
  (
    SELECT count(*) = 21
      AND bool_and(proconfig = ARRAY['search_path=pg_catalog, public']::text[])
      AND bool_and(prosecdef IS FALSE)
      AND bool_and(provolatile = 'v')
      AND bool_and(language_row.lanname = 'plpgsql')
      AND bool_and(owner_role.rolname = current_user)
    FROM pg_proc
    JOIN pg_catalog.pg_language language_row ON language_row.oid = pg_proc.prolang
    JOIN pg_catalog.pg_roles owner_role ON owner_role.oid = pg_proc.proowner
    WHERE pronamespace = 'public'::regnamespace
      AND proname = ANY (ARRAY[
        'enforce_task_region_policy_on_accept',
        'enforce_task_worker_eligibility_on_accept',
        'enforce_controlled_test_offer_acceptance',
        'enforce_controlled_test_provider_capability_on_accept',
        'enforce_task_liquidity_cell_on_accept',
        'enforce_worker_offer_decision_on_accept',
        'reject_pr276_incident_table_mutation',
        'reject_control_table_destructive_mutation',
        'reject_escrow_event_destructive_mutation',
        'reject_admin_action_destructive_mutation',
        'enforce_no_active_refund_claim_on_accept',
        'prevent_task_terminal_mutation',
        'prevent_escrow_terminal_mutation',
        'prevent_escrow_amount_change',
        'enforce_xp_requires_released_escrow',
        'prevent_xp_ledger_delete',
        'prevent_xp_ledger_truncate',
        'enforce_released_requires_completed',
        'enforce_completed_requires_accepted_proof',
        'live_task_requires_funded_escrow',
        'live_task_price_floor'
      ])
  ),
  'all restored and incident guard functions must pin the trusted search_path'
);

SELECT pg_temp.hx_pr276_assert(
  (
    WITH expected(
      function_identity,
      body_sha256,
      volatility,
      parallel_safety,
      argument_count
    ) AS (
      VALUES
        (
          'public.hxos_same_worker_proof_retake_continuation(text, text, uuid, uuid)',
          '74396e06a9f862d24fc8dd3898a7b3eb95be91a338fd9da841a037b7e32d62b3',
          'i'::"char",
          's'::"char",
          4
        ),
        (
          'public.hxos_local_test_liquidity_witness_current(uuid, uuid, uuid)',
          '59ab81cc995dceff319ed18e9d10d565a2543ee5ee0662a0bf1074165813a6d7',
          's'::"char",
          'u'::"char",
          3
        ),
        (
          'public.hxos_local_test_provider_capability_current(uuid, uuid, uuid)',
          '511ff9229d8a6366ded4eb706bc7a32678b069e7640250e03d3a413a9bb3308d',
          's'::"char",
          'u'::"char",
          3
        ),
        (
          'public.hxos_local_test_liquidity_witness_current_v2(uuid, uuid, uuid)',
          'b742ecbbc1b0e9faf265860e28f8f64398add3d29f71df85bddcb9797f18ef49',
          's'::"char",
          'u'::"char",
          3
        ),
        (
          'public.hxos_local_test_offer_action_current(uuid, uuid, uuid, text)',
          'cbb001c243e07f0db95e4a305add951c69cbf7b6d16699433e7cb3b75b5032c2',
          's'::"char",
          'u'::"char",
          4
        )
    )
    SELECT count(*) = 5
      AND bool_and(procedure_row.oid IS NOT NULL)
      AND bool_and(
        format(
          '%I.%I(%s)',
          namespace_row.nspname,
          procedure_row.proname,
          pg_catalog.oidvectortypes(procedure_row.proargtypes)
        ) = expected.function_identity
      )
      AND bool_and(procedure_row.proconfig = ARRAY['search_path=pg_catalog, public']::text[])
      AND bool_and(procedure_row.prosecdef IS FALSE)
      AND bool_and(procedure_row.proisstrict IS FALSE)
      AND bool_and(procedure_row.proretset IS FALSE)
      AND bool_and(procedure_row.prorettype = 'pg_catalog.bool'::regtype)
      AND bool_and(procedure_row.prokind = 'f')
      AND bool_and(procedure_row.provolatile = expected.volatility)
      AND bool_and(procedure_row.proparallel = expected.parallel_safety)
      AND bool_and(procedure_row.pronargs = expected.argument_count)
      AND bool_and(language_row.lanname = 'sql')
      AND bool_and(owner_role.rolname = current_user)
      AND bool_and(
        encode(
          sha256(
            convert_to(
              btrim(regexp_replace(procedure_row.prosrc, '\s+', ' ', 'g')),
              'UTF8'
            )
          ),
          'hex'
        ) = expected.body_sha256
      )
    FROM expected
    LEFT JOIN pg_catalog.pg_proc procedure_row
      ON procedure_row.oid = to_regprocedure(expected.function_identity)
    LEFT JOIN pg_catalog.pg_namespace namespace_row
      ON namespace_row.oid = procedure_row.pronamespace
    LEFT JOIN pg_catalog.pg_language language_row ON language_row.oid = procedure_row.prolang
    LEFT JOIN pg_catalog.pg_roles owner_role ON owner_role.oid = procedure_row.proowner
  ),
  'every transitive acceptance helper must have exact signature, metadata, owner, and body identity'
);

SELECT pg_temp.hx_pr276_assert(
  NOT has_database_privilege('hx_ci_runtime', current_database(), 'TEMPORARY')
    AND NOT has_parameter_privilege('hx_ci_runtime', 'session_replication_role', 'SET')
    AND NOT EXISTS (
      SELECT 1 FROM pg_class class_row
      JOIN pg_namespace namespace_row ON namespace_row.oid = class_row.relnamespace
      WHERE namespace_row.nspname = 'public'
        AND class_row.relkind IN ('r', 'p')
        AND has_table_privilege('hx_ci_runtime', class_row.oid, 'TRIGGER')
    )
    AND NOT EXISTS (
      SELECT 1
      FROM unnest(ARRAY[
        'public.applied_migrations'::regclass,
        'public.schema_versions'::regclass,
        'public.hx_database_identity'::regclass
      ]) control_table(oid)
      WHERE has_table_privilege('hx_ci_runtime', control_table.oid, 'INSERT')
         OR has_table_privilege('hx_ci_runtime', control_table.oid, 'UPDATE')
         OR has_table_privilege('hx_ci_runtime', control_table.oid, 'DELETE')
         OR has_table_privilege('hx_ci_runtime', control_table.oid, 'TRUNCATE')
         OR has_table_privilege('hx_ci_runtime', control_table.oid, 'REFERENCES')
         OR has_table_privilege('hx_ci_runtime', control_table.oid, 'TRIGGER')
         OR has_any_column_privilege('hx_ci_runtime', control_table.oid, 'INSERT')
         OR has_any_column_privilege('hx_ci_runtime', control_table.oid, 'UPDATE')
         OR has_any_column_privilege('hx_ci_runtime', control_table.oid, 'REFERENCES')
    ),
  'runtime must retain neither elevated DDL nor table/column mutation authority on control state'
);

SELECT pg_temp.hx_pr276_assert(
  EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgrelid = 'public.tasks'::regclass
      AND NOT tgisinternal
      AND pg_get_triggerdef(oid) ILIKE '%enforce_task_region_policy_on_accept%'
      AND pg_get_triggerdef(oid) NOT ILIKE '%business_fulfiller_organization_id%'
  )
  AND EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgrelid = 'public.tasks'::regclass
      AND NOT tgisinternal
      AND pg_get_triggerdef(oid) ILIKE '%enforce_task_worker_eligibility_on_accept%'
      AND pg_get_triggerdef(oid) NOT ILIKE '%business_fulfiller_organization_id%'
  )
  AND EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgrelid = 'public.tasks'::regclass
      AND NOT tgisinternal
      AND pg_get_triggerdef(oid) ILIKE '%enforce_controlled_test_provider_capability_on_accept%'
      AND pg_get_triggerdef(oid) NOT ILIKE '%business_fulfiller_organization_id%'
  )
  AND EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgrelid = 'public.tasks'::regclass
      AND NOT tgisinternal
      AND pg_get_triggerdef(oid) ILIKE '%enforce_controlled_test_offer_acceptance%'
      AND pg_get_triggerdef(oid) NOT ILIKE '%business_fulfiller_organization_id%'
  ),
  'the ab4a76cb acceptance trigger bodies must be restored without Business exceptions'
);

SELECT pg_temp.hx_pr276_assert(
  (SELECT orchestration_mode = 'OPS_MANUAL'
     FROM public.tasks
    WHERE id = 'b2000000-0000-4000-8000-000000000001'),
  'the pre-containment invalid historical fixture must survive unchanged'
);

DO $$
BEGIN
  BEGIN
    UPDATE public.tasks
       SET orchestration_mode = 'OPS_MANUAL'
     WHERE id = 'b2000000-0000-4000-8000-000000000002';
    RAISE EXCEPTION 'HXPR276 expected OPS_MANUAL write rejection';
  EXCEPTION
    WHEN check_violation OR raise_exception THEN
      IF SQLERRM = 'HXPR276 expected OPS_MANUAL write rejection' THEN RAISE; END IF;
  END;

  BEGIN
    UPDATE public.tasks
       SET business_fulfiller_organization_id = 'b9000000-0000-4000-8000-000000000001'
     WHERE id = 'b2000000-0000-4000-8000-000000000002';
    RAISE EXCEPTION 'HXPR276 expected Business fulfiller write rejection';
  EXCEPTION
    WHEN check_violation OR raise_exception THEN
      IF SQLERRM = 'HXPR276 expected Business fulfiller write rejection' THEN RAISE; END IF;
  END;
END;
$$;

SELECT 'HXOS_PR276_INCIDENT_CONTAINMENT_OK' AS result;
