-- Nonproduction fake-finance v11: runtime insert authority v1.
--
-- The API/worker runtime must not receive UPDATE on append-only authority
-- relations or EXECUTE on the large legacy trigger/helper graph merely so an
-- INSERT can complete. Eight narrow runtime-callable ports execute the existing
-- exact trigger contracts as their NOLOGIN owner. Two additional bridge
-- functions are owner-only internal primitives used by the atomic event and
-- reconciliation ports; provisioning must never grant either primitive to a
-- runtime role. This migration creates no runtime
-- grant, provider invocation, financial effect, production capability, or
-- deployment action. Role provisioning is separate and must grant only the
-- eight exact callable signatures after reassigning them and all transitive database
-- dependencies to the approved NOLOGIN financial authority. The two
-- canonical fact ports atomically create their exact fake-evidence bridge;
-- no unbridged lifecycle or reconciliation fact can commit through them.

DO $$
BEGIN
  IF pg_catalog.to_regclass(
       'public.hxos_fake_financial_schema_evidence_v10'
     ) IS NULL THEN
    RAISE EXCEPTION
      'HXUV1-NPFIP-0: exact fake-finance v10 recovery authority must be installed first'
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS public.hxos_fake_financial_schema_evidence_v11 (
  migration_name TEXT PRIMARY KEY CHECK (
    migration_name = '20261013_nonproduction_runtime_insert_authority_v1'
  ),
  migration_sql_sha256 CHAR(64) NOT NULL CHECK (
    migration_sql_sha256 ~ '^[0-9a-f]{64}$'
  ),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

DROP TRIGGER IF EXISTS hxos_fake_financial_schema_evidence_append_only_v11
  ON public.hxos_fake_financial_schema_evidence_v11;
CREATE TRIGGER hxos_fake_financial_schema_evidence_append_only_v11
BEFORE UPDATE OR DELETE ON public.hxos_fake_financial_schema_evidence_v11
FOR EACH ROW EXECUTE FUNCTION public.hxos_reject_fake_financial_mutation_v1();

DROP TRIGGER IF EXISTS hxos_fake_financial_schema_evidence_no_truncate_v11
  ON public.hxos_fake_financial_schema_evidence_v11;
CREATE TRIGGER hxos_fake_financial_schema_evidence_no_truncate_v11
BEFORE TRUNCATE ON public.hxos_fake_financial_schema_evidence_v11
FOR EACH STATEMENT EXECUTE FUNCTION public.hxos_reject_fake_financial_mutation_v1();

DO $$
DECLARE
  missing_relation TEXT;
  missing_trigger TEXT;
  missing_mutation_guard TEXT;
BEGIN
  SELECT expected.relation_name
    INTO missing_relation
    FROM (VALUES
      ('financial_provider_command_journal'),
      ('universal_v1_prepared_financial_commands'),
      ('financial_provider_command_dispatch_attempts'),
      ('universal_v1_change_order_materialization_commands'),
      ('universal_v1_fake_financial_lifecycle_bridges'),
      ('universal_v1_fake_terminal_lifecycle_intents'),
      ('universal_v1_fake_provider_account_facts'),
      ('universal_v1_fake_reconciliation_bridges'),
      ('task_financial_security_events'),
      ('task_reconciliation_facts')
    ) expected(relation_name)
   WHERE pg_catalog.to_regclass('public.' || expected.relation_name) IS NULL
   ORDER BY expected.relation_name
   LIMIT 1;
  IF missing_relation IS NOT NULL THEN
    RAISE EXCEPTION
      'HXUV1-NPFIP-0: required authority relation is missing: %', missing_relation
      USING ERRCODE = 'P0001';
  END IF;

  SELECT expected.relation_name || ':' || expected.trigger_name
    INTO missing_trigger
    FROM (VALUES
      ('financial_provider_command_journal',
       'aa_universal_v1_change_order_terminal_journal_guard',
       'public.prevent_change_order_adjust_after_terminal_recovery()'),
      ('financial_provider_command_journal',
       'aa_universal_v1_dispute_command_release_gate',
       'public.enforce_universal_v1_dispute_release_gate_v1()'),
      ('financial_provider_command_journal',
       'financial_provider_command_prepared_authority_guard',
       'public.enforce_financial_provider_command_prepared_authority()'),
      ('financial_provider_command_journal',
       'zz_universal_v1_fake_terminal_reconcile_command_guard',
       'public.validate_universal_v1_fake_terminal_reconcile_command()'),
      ('universal_v1_prepared_financial_commands',
       'a0_universal_v1_change_order_financial_slot_lock',
       'public.lock_universal_v1_change_order_financial_slot_v1()'),
      ('universal_v1_prepared_financial_commands',
       'a_universal_v1_prepared_adjustment_witness',
       'public.enforce_universal_v1_prepared_adjustment_witness()'),
      ('universal_v1_prepared_financial_commands',
       'aa_universal_v1_dispute_prepared_release_gate',
       'public.enforce_universal_v1_dispute_release_gate_v1()'),
      ('universal_v1_prepared_financial_commands',
       'universal_v1_prepared_financial_command_guard',
       'public.enforce_universal_v1_financial_command_preparation()'),
      ('universal_v1_prepared_financial_commands',
       'v_universal_v1_prepared_positive_expiry_v1',
       'public.enforce_universal_v1_prepared_positive_expiry_v1()'),
      ('universal_v1_prepared_financial_commands',
       'zz_universal_v1_change_order_compensating_reversal_guard',
       'public.validate_universal_v1_change_order_compensating_reversal()'),
      ('universal_v1_prepared_financial_commands',
       'zz_universal_v1_fake_terminal_prepared_command_guard',
       'public.validate_universal_v1_fake_terminal_prepared_command()'),
      ('universal_v1_prepared_financial_commands',
       'zz_universal_v1_pre_work_order_void_guard',
       'public.validate_universal_v1_pre_work_order_void()'),
      ('financial_provider_command_dispatch_attempts',
       'aa_universal_v1_change_order_terminal_dispatch_guard',
       'public.prevent_change_order_adjust_after_terminal_recovery()'),
      ('financial_provider_command_dispatch_attempts',
       'financial_provider_command_dispatch_attempt_guard',
       'public.assert_financial_provider_command_dispatch_attempt()'),
      ('financial_provider_command_dispatch_attempts',
       'v_universal_v1_dispatch_positive_expiry_v1',
       'public.enforce_universal_v1_dispatch_positive_expiry_v1()'),
      ('financial_provider_command_dispatch_attempts',
       'zz_universal_v1_fake_terminal_dispatch_attempt_guard',
       'public.validate_universal_v1_fake_terminal_dispatch_attempt()'),
      ('universal_v1_change_order_materialization_commands',
       'universal_v1_change_order_materialization_command_guard',
       'public.enforce_universal_v1_change_order_materialization_command()'),
      ('universal_v1_change_order_materialization_commands',
       'v_universal_v1_change_order_predecessor_expiry_v9',
       'public.enforce_universal_v1_change_order_predecessor_expiry_v9()'),
      ('universal_v1_change_order_materialization_commands',
       'zz_universal_v1_change_order_phase_a_financial_slot_guard',
       'public.reject_change_order_witness_after_financial_slot_v1()'),
      ('universal_v1_fake_financial_lifecycle_bridges',
       'universal_v1_fake_financial_lifecycle_bridge_validate',
       'public.validate_universal_v1_fake_financial_lifecycle_bridge()'),
      ('universal_v1_fake_financial_lifecycle_bridges',
       'zz_universal_v1_fake_expiry_bridge_v9',
       'public.enforce_universal_v1_fake_expiry_bridge_v9()'),
      ('universal_v1_fake_terminal_lifecycle_intents',
       'aa_universal_v1_dispute_terminal_intent_gate',
       'public.enforce_universal_v1_dispute_release_gate_v1()'),
      ('universal_v1_fake_terminal_lifecycle_intents',
       'universal_v1_fake_terminal_lifecycle_intent_validate',
       'public.validate_universal_v1_fake_terminal_lifecycle_intent()'),
      ('universal_v1_fake_terminal_lifecycle_intents',
       'v_universal_v1_terminal_intent_expiry_v9',
       'public.enforce_universal_v1_terminal_intent_expiry_v9()'),
      ('universal_v1_fake_provider_account_facts',
       'universal_v1_fake_provider_account_fact_validate',
       'public.validate_universal_v1_fake_provider_account_fact()'),
      ('universal_v1_fake_reconciliation_bridges',
       'universal_v1_fake_reconciliation_bridge_validate',
       'public.validate_universal_v1_fake_reconciliation_bridge()'),
      ('task_financial_security_events',
       'aa_universal_v1_dispute_financial_release_gate',
       'public.enforce_universal_v1_dispute_release_gate_v1()'),
      ('task_financial_security_events',
       'universal_fake_finance_boundary_guard',
       'public.enforce_universal_fake_finance_boundary()'),
      ('task_financial_security_events',
       'universal_financial_event_sequence_guard',
       'public.enforce_universal_financial_event_sequence()'),
      ('task_financial_security_events',
       'universal_v1_controlled_fake_lifecycle_bridge_required',
       'public.require_universal_v1_controlled_fake_lifecycle_bridge()'),
      ('task_financial_security_events',
       'universal_v1_financial_execution_completion_guard',
       'public.enforce_universal_v1_financial_execution_completion()'),
      ('task_reconciliation_facts',
       'aa_universal_v1_dispute_reconciliation_gate',
       'public.enforce_universal_v1_dispute_closure_gate_v1()'),
      ('task_reconciliation_facts',
       'universal_reconciliation_bindings_guard',
       'public.enforce_universal_reconciliation_bindings()'),
      ('task_reconciliation_facts',
       'universal_v1_fake_reconciliation_bridge_required',
       'public.require_universal_v1_fake_reconciliation_bridge()'),
      ('task_reconciliation_facts',
       'zz_universal_v1_double_entry_ledger_required_v1',
       'public.require_universal_v1_double_entry_ledger_v1()')
    ) expected(relation_name, trigger_name, function_signature)
   WHERE NOT EXISTS (
     SELECT 1
       FROM pg_catalog.pg_trigger trigger_record
       JOIN pg_catalog.pg_class relation
         ON relation.oid = trigger_record.tgrelid
       JOIN pg_catalog.pg_namespace namespace
         ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relname = expected.relation_name
        AND trigger_record.tgname = expected.trigger_name
        AND NOT trigger_record.tgisinternal
        AND (trigger_record.tgtype::INTEGER & 4) = 4
        AND trigger_record.tgfoid =
          pg_catalog.to_regprocedure(expected.function_signature)::OID
        AND trigger_record.tgenabled IN ('O', 'A')
   )
   ORDER BY expected.relation_name, expected.trigger_name
   LIMIT 1;
  IF missing_trigger IS NOT NULL THEN
    RAISE EXCEPTION
      'HXUV1-NPFIP-1: exact INSERT trigger authority is missing: %', missing_trigger
      USING ERRCODE = 'P0001';
  END IF;

  SELECT expected.relation_name || ':' || expected.trigger_name
    INTO missing_mutation_guard
    FROM (VALUES
      ('task_financial_security_events',
       'task_financial_security_events_immutable',
       'public.prevent_universal_v1_fact_mutation()', 27),
      ('task_financial_security_events',
       'task_financial_security_events_no_truncate',
       'public.prevent_universal_v1_fact_mutation()', 34),
      ('task_reconciliation_facts',
       'task_reconciliation_facts_immutable',
       'public.prevent_universal_v1_fact_mutation()', 27),
      ('task_reconciliation_facts',
       'task_reconciliation_facts_no_truncate',
       'public.prevent_universal_v1_fact_mutation()', 34)
    ) expected(relation_name, trigger_name, function_signature, trigger_type)
   WHERE NOT EXISTS (
     SELECT 1
       FROM pg_catalog.pg_trigger trigger_record
       JOIN pg_catalog.pg_class relation
         ON relation.oid = trigger_record.tgrelid
       JOIN pg_catalog.pg_namespace namespace
         ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relname = expected.relation_name
        AND trigger_record.tgname = expected.trigger_name
        AND NOT trigger_record.tgisinternal
        AND trigger_record.tgtype::INTEGER = expected.trigger_type
        AND trigger_record.tgfoid =
          pg_catalog.to_regprocedure(expected.function_signature)::OID
        AND trigger_record.tgenabled IN ('O', 'A')
   )
   ORDER BY expected.relation_name, expected.trigger_name
   LIMIT 1;
  IF missing_mutation_guard IS NOT NULL THEN
    RAISE EXCEPTION
      'HXUV1-NPFIP-1: exact append-only authority is missing: %',
      missing_mutation_guard
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

-- These three constraint-trigger guards execute after the caller-facing
-- SECURITY DEFINER port returns. They therefore need their own sealed owner
-- authority; otherwise an EXECUTE-only runtime would need canonical-table
-- privileges merely to complete the deferred integrity checks.
ALTER FUNCTION public.require_universal_v1_controlled_fake_lifecycle_bridge()
  SECURITY DEFINER;
ALTER FUNCTION public.require_universal_v1_controlled_fake_lifecycle_bridge()
  SET search_path = pg_catalog, public;
ALTER FUNCTION public.require_universal_v1_fake_reconciliation_bridge()
  SECURITY DEFINER;
ALTER FUNCTION public.require_universal_v1_fake_reconciliation_bridge()
  SET search_path = pg_catalog, public;
ALTER FUNCTION public.require_universal_v1_double_entry_ledger_v1()
  SECURITY DEFINER;
ALTER FUNCTION public.require_universal_v1_double_entry_ledger_v1()
  SET search_path = pg_catalog, public;
REVOKE ALL ON FUNCTION
  public.require_universal_v1_controlled_fake_lifecycle_bridge()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.require_universal_v1_fake_reconciliation_bridge()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.require_universal_v1_double_entry_ledger_v1()
  FROM PUBLIC;

DO $$
DECLARE
  invalid_deferred_guard TEXT;
BEGIN
  SELECT expected.function_signature
    INTO invalid_deferred_guard
    FROM (VALUES
      ('public.require_universal_v1_controlled_fake_lifecycle_bridge()'),
      ('public.require_universal_v1_fake_reconciliation_bridge()'),
      ('public.require_universal_v1_double_entry_ledger_v1()')
    ) expected(function_signature)
    LEFT JOIN pg_catalog.pg_proc procedure
      ON procedure.oid =
         pg_catalog.to_regprocedure(expected.function_signature)::OID
   WHERE procedure.oid IS NULL
      OR procedure.proowner <> CURRENT_USER::pg_catalog.regrole::OID
      OR NOT procedure.prosecdef
      OR procedure.proconfig IS DISTINCT FROM
         ARRAY['search_path=pg_catalog, public']::TEXT[]
      OR EXISTS (
        SELECT 1
          FROM pg_catalog.aclexplode(COALESCE(
            procedure.proacl,
            pg_catalog.acldefault('f', procedure.proowner)
          )) privilege
         WHERE privilege.grantee = 0
           AND privilege.privilege_type = 'EXECUTE'
      )
   ORDER BY expected.function_signature
   LIMIT 1;
  IF invalid_deferred_guard IS NOT NULL THEN
    RAISE EXCEPTION
      'HXUV1-NPFIP-4: deferred integrity guard is not sealed: %',
      invalid_deferred_guard
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.hxos_record_financial_provider_command_v1(
  p_command_id UUID,
  p_operation_kind TEXT,
  p_operation_id UUID,
  p_provider_kind TEXT,
  p_idempotency_key TEXT,
  p_provider_expected_version BIGINT,
  p_request_sha256 TEXT,
  p_command_identity_sha256 TEXT,
  p_prepared_financial_command_id UUID,
  p_prepared_authority_sha256 TEXT,
  p_task_draft_id UUID,
  p_task_id UUID,
  p_work_order_id UUID,
  p_related_operation_id UUID,
  p_amount_cents BIGINT,
  p_currency TEXT,
  p_recorded_actor_id UUID,
  p_recorded_actor_kind TEXT,
  p_release_manifest_digest TEXT,
  p_release_id TEXT,
  p_release_revision TEXT,
  p_release_environment TEXT,
  p_release_authentication_status TEXT
)
RETURNS public.financial_provider_command_journal
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
PARALLEL UNSAFE
SET search_path = pg_catalog, public
AS $$
DECLARE
  inserted_row public.financial_provider_command_journal%ROWTYPE;
BEGIN
  -- HXUV1-NPFIP-V1:JOURNAL
  INSERT INTO public.financial_provider_command_journal (
    command_id, operation_kind, operation_id, provider_kind, idempotency_key,
    provider_expected_version, request_sha256, command_identity_sha256,
    prepared_financial_command_id, prepared_authority_sha256,
    task_draft_id, task_id, work_order_id, related_operation_id,
    amount_cents, currency, recorded_actor_id, recorded_actor_kind,
    release_manifest_digest, release_id, release_revision,
    release_environment, release_authentication_status
  ) VALUES (
    p_command_id, p_operation_kind, p_operation_id, p_provider_kind,
    p_idempotency_key, p_provider_expected_version, p_request_sha256,
    p_command_identity_sha256, p_prepared_financial_command_id,
    p_prepared_authority_sha256, p_task_draft_id, p_task_id, p_work_order_id,
    p_related_operation_id, p_amount_cents, p_currency, p_recorded_actor_id,
    p_recorded_actor_kind, p_release_manifest_digest, p_release_id,
    p_release_revision, p_release_environment, p_release_authentication_status
  )
  RETURNING * INTO STRICT inserted_row;
  RETURN inserted_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.hxos_prepare_universal_v1_financial_command_v1(
  p_prepared_command_id UUID,
  p_operation_kind TEXT,
  p_operation_id UUID,
  p_provider_kind TEXT,
  p_idempotency_key TEXT,
  p_provider_expected_version BIGINT,
  p_lifecycle_expected_version BIGINT,
  p_provider_request_sha256 TEXT,
  p_task_draft_id UUID,
  p_task_id UUID,
  p_eligibility_decision_id UUID,
  p_scope_version_id UUID,
  p_change_order_id UUID,
  p_predecessor_event_id UUID,
  p_completion_fact_id UUID,
  p_related_operation_id UUID,
  p_amount_cents BIGINT,
  p_currency TEXT,
  p_recorded_by UUID
)
RETURNS public.universal_v1_prepared_financial_commands
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
PARALLEL UNSAFE
SET search_path = pg_catalog, public
AS $$
DECLARE
  inserted_row public.universal_v1_prepared_financial_commands%ROWTYPE;
BEGIN
  -- HXUV1-NPFIP-V1:PREPARED
  INSERT INTO public.universal_v1_prepared_financial_commands (
    prepared_command_id, operation_kind, operation_id, provider_kind,
    idempotency_key, provider_expected_version, lifecycle_expected_version,
    provider_request_sha256, task_draft_id, task_id, eligibility_decision_id,
    scope_version_id, change_order_id, predecessor_event_id,
    completion_fact_id, related_operation_id, amount_cents, currency, recorded_by
  ) VALUES (
    p_prepared_command_id, p_operation_kind, p_operation_id, p_provider_kind,
    p_idempotency_key, p_provider_expected_version,
    p_lifecycle_expected_version, p_provider_request_sha256, p_task_draft_id,
    p_task_id, p_eligibility_decision_id, p_scope_version_id,
    p_change_order_id, p_predecessor_event_id, p_completion_fact_id,
    p_related_operation_id, p_amount_cents, p_currency, p_recorded_by
  )
  RETURNING * INTO STRICT inserted_row;
  RETURN inserted_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.hxos_record_financial_provider_dispatch_attempt_v1(
  p_dispatch_attempt_id UUID,
  p_command_id UUID,
  p_recovery_lease_id UUID,
  p_outcome_timeout_seconds INTEGER
)
RETURNS public.financial_provider_command_dispatch_attempts
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
PARALLEL UNSAFE
SET search_path = pg_catalog, public
AS $$
DECLARE
  inserted_row public.financial_provider_command_dispatch_attempts%ROWTYPE;
BEGIN
  -- HXUV1-NPFIP-V1:DISPATCH
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('financial-provider-command-recovery-v1'),
    pg_catalog.hashtext(p_command_id::TEXT)
  );
  WITH timing AS MATERIALIZED (
    SELECT pg_catalog.clock_timestamp() AS database_now
  ), derived AS (
    SELECT COALESCE(pg_catalog.max(previous.attempt_number), 0) + 1
             AS attempt_number,
           command.request_sha256
      FROM public.financial_provider_command_journal command
      LEFT JOIN public.financial_provider_command_dispatch_attempts previous
        ON previous.command_id = command.command_id
     WHERE command.command_id = p_command_id
     GROUP BY command.request_sha256
  )
  INSERT INTO public.financial_provider_command_dispatch_attempts (
    dispatch_attempt_id, command_id, recovery_lease_id, attempt_number,
    request_sha256, outcome_timeout_seconds, attempted_at, outcome_deadline_at
  )
  SELECT p_dispatch_attempt_id, p_command_id, p_recovery_lease_id,
         derived.attempt_number, derived.request_sha256,
         p_outcome_timeout_seconds, timing.database_now,
         timing.database_now + pg_catalog.make_interval(
           secs => p_outcome_timeout_seconds
         )
    FROM derived
    CROSS JOIN timing
  RETURNING * INTO inserted_row;
  IF inserted_row.dispatch_attempt_id IS NULL THEN
    RAISE EXCEPTION 'HXUV1-NPFIP-2: exact provider command is missing'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN inserted_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.hxos_record_change_order_materialization_command_v1(
  p_proposal_id UUID,
  p_idempotency_key TEXT,
  p_actor_user_id UUID,
  p_work_order_id UUID,
  p_task_id UUID,
  p_task_draft_id UUID,
  p_eligibility_decision_id UUID,
  p_base_scope_version_id UUID,
  p_replacement_scope_version_id UUID,
  p_expected_proposal_version INTEGER,
  p_expected_scope_version INTEGER,
  p_expected_amendment_version INTEGER,
  p_expected_execution_version INTEGER,
  p_expected_financial_version INTEGER,
  p_predecessor_event_id UUID,
  p_predecessor_operation_id UUID,
  p_adjustment_operation_id UUID,
  p_customer_total_cents INTEGER,
  p_provider_payout_cents INTEGER,
  p_currency TEXT,
  p_requested_occurred_at TIMESTAMPTZ
)
RETURNS public.universal_v1_change_order_materialization_commands
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
PARALLEL UNSAFE
SET search_path = pg_catalog, public
AS $$
DECLARE
  inserted_row public.universal_v1_change_order_materialization_commands%ROWTYPE;
  predecessor_occurred_at TIMESTAMPTZ;
BEGIN
  -- HXUV1-NPFIP-V1:CHANGE_ORDER
  SELECT event.occurred_at
    INTO predecessor_occurred_at
    FROM public.task_financial_security_events event
   WHERE event.id = p_predecessor_event_id
   FOR SHARE;
  IF predecessor_occurred_at IS NULL THEN
    RAISE EXCEPTION 'HXUV1-NPFIP-3: exact predecessor event is missing'
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.universal_v1_change_order_materialization_commands (
    proposal_id, idempotency_key, request_sha256, actor_user_id,
    work_order_id, task_id, task_draft_id, eligibility_decision_id,
    base_scope_version_id, replacement_scope_version_id,
    expected_proposal_version, expected_scope_version,
    expected_amendment_version, expected_execution_version,
    expected_financial_version, predecessor_event_id,
    predecessor_operation_id, adjustment_operation_id,
    customer_total_cents, provider_payout_cents, currency, occurred_at
  ) VALUES (
    p_proposal_id, p_idempotency_key,
    public.universal_v1_change_order_materialization_request_sha256(
      p_proposal_id, p_idempotency_key, p_actor_user_id, p_work_order_id,
      p_task_id, p_task_draft_id, p_eligibility_decision_id,
      p_base_scope_version_id, p_replacement_scope_version_id,
      p_expected_proposal_version, p_expected_scope_version,
      p_expected_amendment_version, p_expected_execution_version,
      p_expected_financial_version, p_predecessor_event_id,
      p_predecessor_operation_id, p_adjustment_operation_id
    ),
    p_actor_user_id, p_work_order_id, p_task_id, p_task_draft_id,
    p_eligibility_decision_id, p_base_scope_version_id,
    p_replacement_scope_version_id, p_expected_proposal_version,
    p_expected_scope_version, p_expected_amendment_version,
    p_expected_execution_version, p_expected_financial_version,
    p_predecessor_event_id, p_predecessor_operation_id,
    p_adjustment_operation_id, p_customer_total_cents,
    p_provider_payout_cents, p_currency,
    GREATEST(
      p_requested_occurred_at,
      predecessor_occurred_at + INTERVAL '1 millisecond'
    )
  )
  RETURNING * INTO STRICT inserted_row;
  RETURN inserted_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.hxos_record_fake_financial_lifecycle_bridge_v1(
  p_bridge_id UUID,
  p_prepared_command_id UUID,
  p_command_id UUID,
  p_dispatch_attempt_id UUID,
  p_outcome_fact_id UUID,
  p_fake_operation_event_id UUID,
  p_task_financial_security_event_id UUID
)
RETURNS public.universal_v1_fake_financial_lifecycle_bridges
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
PARALLEL UNSAFE
SET search_path = pg_catalog, public
AS $$
DECLARE
  inserted_row public.universal_v1_fake_financial_lifecycle_bridges%ROWTYPE;
BEGIN
  -- HXUV1-NPFIP-V1:LIFECYCLE_BRIDGE
  INSERT INTO public.universal_v1_fake_financial_lifecycle_bridges (
    bridge_id, prepared_command_id, command_id, dispatch_attempt_id,
    outcome_fact_id, fake_operation_event_id, task_financial_security_event_id
  ) VALUES (
    p_bridge_id, p_prepared_command_id, p_command_id, p_dispatch_attempt_id,
    p_outcome_fact_id, p_fake_operation_event_id,
    p_task_financial_security_event_id
  )
  RETURNING * INTO STRICT inserted_row;
  RETURN inserted_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.hxos_record_fake_financial_security_event_v1(
  p_event_id UUID,
  p_bridge_id UUID,
  p_provider_kind TEXT,
  p_operation_id UUID,
  p_idempotency_key TEXT,
  p_prepared_command_id UUID,
  p_command_id UUID,
  p_dispatch_attempt_id UUID,
  p_outcome_fact_id UUID,
  p_fake_operation_event_id UUID
)
RETURNS public.task_financial_security_events
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
PARALLEL UNSAFE
SET search_path = pg_catalog, public
AS $$
DECLARE
  prepared public.universal_v1_prepared_financial_commands%ROWTYPE;
  requested public.financial_provider_command_journal%ROWTYPE;
  outcome public.financial_provider_command_outcome_facts%ROWTYPE;
  fake_event public.hxos_fake_financial_operation_events_v1%ROWTYPE;
  inserted_row public.task_financial_security_events%ROWTYPE;
  existing_bridge public.universal_v1_fake_financial_lifecycle_bridges%ROWTYPE;
  derived_event_kind TEXT;
  derived_status TEXT;
  expected_external_reference_sha256 CHAR(64);
  expected_provider_result_sha256 CHAR(64);
BEGIN
  -- HXUV1-NPFIP-V1:FAKE_FINANCIAL_EVENT
  IF p_provider_kind IS DISTINCT FROM 'FAKE' THEN
    RAISE EXCEPTION
      'HXUV1-NPFIP-5: canonical runtime lifecycle materialization is fake-only'
      USING ERRCODE = 'P0001';
  END IF;
  IF p_event_id IS NULL
     OR p_bridge_id IS NULL
     OR p_operation_id IS NULL
     OR p_idempotency_key IS NULL
     OR p_prepared_command_id IS NULL
     OR p_command_id IS NULL
     OR p_dispatch_attempt_id IS NULL
     OR p_outcome_fact_id IS NULL
     OR p_fake_operation_event_id IS NULL THEN
    RAISE EXCEPTION
      'HXUV1-NPFIP-5: complete explicit lifecycle and durable-chain identities are required'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('hxos-record-fake-financial-security-event-v1'),
    pg_catalog.hashtext(p_idempotency_key)
  );

  SELECT * INTO prepared
    FROM public.universal_v1_prepared_financial_commands
   WHERE prepared_command_id = p_prepared_command_id
   FOR SHARE;
  SELECT * INTO requested
    FROM public.financial_provider_command_journal
   WHERE command_id = p_command_id
   FOR SHARE;
  SELECT * INTO outcome
    FROM public.financial_provider_command_outcome_facts
   WHERE outcome_fact_id = p_outcome_fact_id
   FOR SHARE;
  SELECT * INTO fake_event
    FROM public.hxos_fake_financial_operation_events_v1
   WHERE event_id = p_fake_operation_event_id
   FOR SHARE;

  IF prepared.prepared_command_id IS NULL
     OR requested.command_id IS NULL
     OR outcome.outcome_fact_id IS NULL
     OR fake_event.event_id IS NULL
     OR prepared.provider_kind <> 'FAKE'
     OR prepared.command_state <> 'PREPARED'
     OR prepared.operation_id IS DISTINCT FROM p_operation_id
     OR prepared.idempotency_key IS DISTINCT FROM p_idempotency_key
     OR requested.command_state <> 'REQUESTED'
     OR requested.provider_kind <> 'FAKE'
     OR requested.operation_kind IS DISTINCT FROM prepared.operation_kind
     OR requested.operation_id IS DISTINCT FROM p_operation_id
     OR requested.idempotency_key IS DISTINCT FROM p_idempotency_key
     OR requested.prepared_financial_command_id IS DISTINCT FROM p_prepared_command_id
     OR requested.prepared_authority_sha256 IS DISTINCT FROM
          prepared.authority_context_sha256
     OR requested.provider_expected_version IS DISTINCT FROM
          prepared.provider_expected_version
     OR requested.request_sha256 IS DISTINCT FROM prepared.provider_request_sha256
     OR outcome.command_id IS DISTINCT FROM p_command_id
     OR outcome.dispatch_attempt_id IS DISTINCT FROM p_dispatch_attempt_id
     OR fake_event.operation_id IS DISTINCT FROM p_operation_id
     OR fake_event.operation_kind IS DISTINCT FROM requested.operation_kind
     OR fake_event.idempotency_key IS DISTINCT FROM p_idempotency_key
     OR fake_event.provider_request_sha256 IS DISTINCT FROM
          requested.request_sha256 THEN
    RAISE EXCEPTION
      'HXUV1-NPFIP-6: lifecycle materialization durable chain is incomplete or not exact'
      USING ERRCODE = 'P0001';
  END IF;

  derived_event_kind := CASE prepared.operation_kind
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
  derived_status := CASE outcome.provider_state
    WHEN 'SUCCEEDED' THEN 'SUCCEEDED'
    WHEN 'VOIDED' THEN 'SUCCEEDED'
    WHEN 'REFUNDED' THEN 'SUCCEEDED'
    WHEN 'PARTIALLY_REFUNDED' THEN 'SUCCEEDED'
    WHEN 'REVERSED' THEN 'SUCCEEDED'
    WHEN 'DECLINED' THEN 'DECLINED'
    WHEN 'FAILED' THEN 'FAILED'
    ELSE NULL
  END;
  IF derived_event_kind IS NULL
     OR derived_status IS NULL
     OR outcome.outcome_kind <> 'OUTCOME_OBSERVED'
     OR outcome.retryable IS TRUE
     OR outcome.provider_result_version IS NULL
     OR outcome.provider_result_sha256 IS NULL
     OR outcome.external_reference_sha256 IS NULL THEN
    RAISE EXCEPTION
      'HXUV1-NPFIP-6: lifecycle materialization requires one terminal fake observation'
      USING ERRCODE = 'P0001';
  END IF;

  expected_external_reference_sha256 := pg_catalog.encode(
    public.digest(fake_event.external_reference, 'sha256'),
    'hex'
  );
  expected_provider_result_sha256 := pg_catalog.encode(
    public.digest(
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
  IF fake_event.event_version::BIGINT IS DISTINCT FROM
       outcome.provider_result_version
     OR fake_event.event_version::BIGINT IS DISTINCT FROM
          requested.provider_expected_version + 1
     OR fake_event.state IS DISTINCT FROM outcome.provider_state
     OR fake_event.retryable IS DISTINCT FROM outcome.retryable
     OR fake_event.amount_cents IS DISTINCT FROM outcome.amount_cents
     OR pg_catalog.upper(fake_event.currency) IS DISTINCT FROM outcome.currency
     OR fake_event.related_operation_id IS DISTINCT FROM
          requested.related_operation_id
     OR outcome.external_reference_sha256 IS DISTINCT FROM
          expected_external_reference_sha256
     OR outcome.provider_result_sha256 IS DISTINCT FROM
          expected_provider_result_sha256 THEN
    RAISE EXCEPTION
      'HXUV1-NPFIP-6: selected fake event is not the exact provider outcome result'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO inserted_row
    FROM public.task_financial_security_events
   WHERE idempotency_key = p_idempotency_key
   FOR SHARE;
  IF inserted_row.id IS NOT NULL THEN
    SELECT * INTO existing_bridge
      FROM public.universal_v1_fake_financial_lifecycle_bridges
     WHERE task_financial_security_event_id = inserted_row.id
     FOR SHARE;
    IF inserted_row.id IS DISTINCT FROM p_event_id
       OR inserted_row.operation_id IS DISTINCT FROM p_operation_id::TEXT
       OR inserted_row.event_kind IS DISTINCT FROM derived_event_kind
       OR inserted_row.status IS DISTINCT FROM derived_status
       OR inserted_row.provider_kind IS DISTINCT FROM 'FAKE'
       OR inserted_row.external_reference IS DISTINCT FROM fake_event.external_reference
       OR inserted_row.expected_version IS DISTINCT FROM
            prepared.lifecycle_expected_version::INTEGER
       OR inserted_row.task_draft_id IS DISTINCT FROM prepared.task_draft_id
       OR inserted_row.task_id IS DISTINCT FROM prepared.task_id
       OR inserted_row.eligibility_decision_id IS DISTINCT FROM
            prepared.eligibility_decision_id
       OR inserted_row.scope_version_id IS DISTINCT FROM prepared.scope_version_id
       OR inserted_row.change_order_id IS DISTINCT FROM prepared.change_order_id
       OR inserted_row.predecessor_event_id IS DISTINCT FROM prepared.predecessor_event_id
       OR inserted_row.completion_fact_id IS DISTINCT FROM prepared.completion_fact_id
       OR inserted_row.amount_cents IS DISTINCT FROM prepared.amount_cents
       OR inserted_row.currency IS DISTINCT FROM prepared.currency
       OR inserted_row.recorded_by IS DISTINCT FROM prepared.recorded_by
       OR inserted_row.occurred_at IS DISTINCT FROM fake_event.recorded_at
       OR inserted_row.expires_at IS DISTINCT FROM fake_event.expires_at
       OR inserted_row.evidence->>'providerState' IS DISTINCT FROM outcome.provider_state
       OR COALESCE(inserted_row.evidence->>'providerOperationVersion', '')
            IS DISTINCT FROM outcome.provider_result_version::TEXT
       OR inserted_row.evidence->>'providerIdempotencyReplayed' IS DISTINCT FROM 'false'
       OR existing_bridge.bridge_id IS DISTINCT FROM p_bridge_id
       OR existing_bridge.prepared_command_id IS DISTINCT FROM p_prepared_command_id
       OR existing_bridge.command_id IS DISTINCT FROM p_command_id
       OR existing_bridge.dispatch_attempt_id IS DISTINCT FROM p_dispatch_attempt_id
       OR existing_bridge.outcome_fact_id IS DISTINCT FROM p_outcome_fact_id
       OR existing_bridge.fake_operation_event_id IS DISTINCT FROM
            p_fake_operation_event_id THEN
      RAISE EXCEPTION
        'HXUV1-NPFIP-7: fake lifecycle idempotency identity conflicts with committed authority'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN inserted_row;
  END IF;

  INSERT INTO public.task_financial_security_events (
    id, task_draft_id, task_id, eligibility_decision_id, scope_version_id,
    change_order_id, predecessor_event_id, event_kind, status, operation_id,
    idempotency_key, expected_version, provider_kind, external_reference,
    amount_cents, currency, evidence, recorded_by, occurred_at, expires_at,
    completion_fact_id
  ) VALUES (
    p_event_id, prepared.task_draft_id, prepared.task_id,
    prepared.eligibility_decision_id, prepared.scope_version_id,
    prepared.change_order_id, prepared.predecessor_event_id,
    derived_event_kind, derived_status, prepared.operation_id::TEXT,
    prepared.idempotency_key, prepared.lifecycle_expected_version::INTEGER,
    'FAKE', fake_event.external_reference, prepared.amount_cents,
    prepared.currency,
    pg_catalog.jsonb_build_object(
      'providerState', outcome.provider_state,
      'providerOperationVersion', outcome.provider_result_version,
      'providerIdempotencyReplayed', FALSE
    ),
    prepared.recorded_by, fake_event.recorded_at, fake_event.expires_at,
    prepared.completion_fact_id
  )
  RETURNING * INTO STRICT inserted_row;

  PERFORM public.hxos_record_fake_financial_lifecycle_bridge_v1(
    p_bridge_id, p_prepared_command_id, p_command_id, p_dispatch_attempt_id,
    p_outcome_fact_id, p_fake_operation_event_id, p_event_id
  );
  RETURN inserted_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.hxos_record_fake_terminal_lifecycle_intent_v1(
  p_terminal_intent_id UUID,
  p_terminal_path TEXT,
  p_work_order_id UUID,
  p_completion_fact_id UUID,
  p_starting_financial_event_id UUID,
  p_provider_account_fact_id UUID,
  p_expected_financial_version BIGINT,
  p_expected_reconciliation_version INTEGER,
  p_idempotency_key TEXT,
  p_request_sha256 TEXT,
  p_requested_by UUID
)
RETURNS public.universal_v1_fake_terminal_lifecycle_intents
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
PARALLEL UNSAFE
SET search_path = pg_catalog, public
AS $$
DECLARE
  inserted_row public.universal_v1_fake_terminal_lifecycle_intents%ROWTYPE;
BEGIN
  -- HXUV1-NPFIP-V1:TERMINAL_INTENT
  INSERT INTO public.universal_v1_fake_terminal_lifecycle_intents (
    terminal_intent_id, terminal_path, work_order_id, completion_fact_id,
    starting_financial_event_id, provider_account_fact_id,
    expected_financial_version, expected_reconciliation_version,
    idempotency_key, request_sha256, requested_by
  ) VALUES (
    p_terminal_intent_id, p_terminal_path, p_work_order_id,
    p_completion_fact_id, p_starting_financial_event_id,
    p_provider_account_fact_id, p_expected_financial_version,
    p_expected_reconciliation_version, p_idempotency_key,
    p_request_sha256, p_requested_by
  )
  RETURNING * INTO STRICT inserted_row;
  RETURN inserted_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.hxos_record_fake_provider_account_fact_v1(
  p_provider_account_fact_id UUID,
  p_provider_subject_kind TEXT,
  p_provider_user_id UUID,
  p_provider_organization_id UUID,
  p_onboard_command_id UUID,
  p_onboard_dispatch_attempt_id UUID,
  p_onboard_outcome_fact_id UUID,
  p_onboard_fake_event_id UUID,
  p_refresh_command_id UUID,
  p_refresh_dispatch_attempt_id UUID,
  p_refresh_outcome_fact_id UUID,
  p_refresh_fake_event_id UUID,
  p_recorded_by UUID
)
RETURNS public.universal_v1_fake_provider_account_facts
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
PARALLEL UNSAFE
SET search_path = pg_catalog, public
AS $$
DECLARE
  inserted_row public.universal_v1_fake_provider_account_facts%ROWTYPE;
BEGIN
  -- HXUV1-NPFIP-V1:PROVIDER_ACCOUNT
  INSERT INTO public.universal_v1_fake_provider_account_facts (
    provider_account_fact_id, provider_subject_kind, provider_user_id,
    provider_organization_id, onboard_command_id,
    onboard_dispatch_attempt_id, onboard_outcome_fact_id,
    onboard_fake_event_id, refresh_command_id,
    refresh_dispatch_attempt_id, refresh_outcome_fact_id,
    refresh_fake_event_id, recorded_by
  ) VALUES (
    p_provider_account_fact_id, p_provider_subject_kind, p_provider_user_id,
    p_provider_organization_id, p_onboard_command_id,
    p_onboard_dispatch_attempt_id, p_onboard_outcome_fact_id,
    p_onboard_fake_event_id, p_refresh_command_id,
    p_refresh_dispatch_attempt_id, p_refresh_outcome_fact_id,
    p_refresh_fake_event_id, p_recorded_by
  )
  RETURNING * INTO STRICT inserted_row;
  RETURN inserted_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.hxos_record_fake_reconciliation_bridge_v1(
  p_reconciliation_bridge_id UUID,
  p_terminal_intent_id UUID,
  p_reconciliation_fact_id UUID,
  p_command_id UUID,
  p_dispatch_attempt_id UUID,
  p_outcome_fact_id UUID,
  p_fake_operation_event_id UUID
)
RETURNS public.universal_v1_fake_reconciliation_bridges
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
PARALLEL UNSAFE
SET search_path = pg_catalog, public
AS $$
DECLARE
  inserted_row public.universal_v1_fake_reconciliation_bridges%ROWTYPE;
BEGIN
  -- HXUV1-NPFIP-V1:RECONCILIATION_BRIDGE
  INSERT INTO public.universal_v1_fake_reconciliation_bridges (
    reconciliation_bridge_id, terminal_intent_id, reconciliation_fact_id,
    command_id, dispatch_attempt_id, outcome_fact_id, fake_operation_event_id
  ) VALUES (
    p_reconciliation_bridge_id, p_terminal_intent_id,
    p_reconciliation_fact_id, p_command_id, p_dispatch_attempt_id,
    p_outcome_fact_id, p_fake_operation_event_id
  )
  RETURNING * INTO STRICT inserted_row;
  RETURN inserted_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.hxos_record_fake_reconciliation_fact_v1(
  p_reconciliation_fact_id UUID,
  p_reconciliation_bridge_id UUID,
  p_provider_kind TEXT,
  p_operation_id UUID,
  p_idempotency_key TEXT,
  p_reconciliation_snapshot_sha256 TEXT,
  p_terminal_intent_id UUID,
  p_command_id UUID,
  p_dispatch_attempt_id UUID,
  p_outcome_fact_id UUID,
  p_fake_operation_event_id UUID,
  p_application_request_sha256 TEXT
)
RETURNS public.task_reconciliation_facts
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
PARALLEL UNSAFE
SET search_path = pg_catalog, public
AS $$
DECLARE
  intent public.universal_v1_fake_terminal_lifecycle_intents%ROWTYPE;
  requested public.financial_provider_command_journal%ROWTYPE;
  outcome public.financial_provider_command_outcome_facts%ROWTYPE;
  fake_event public.hxos_fake_financial_operation_events_v1%ROWTYPE;
  inserted_row public.task_reconciliation_facts%ROWTYPE;
  existing_bridge public.universal_v1_fake_reconciliation_bridges%ROWTYPE;
  expected_snapshot_sha256 CHAR(64);
  capture_event_id UUID;
  refund_event_id UUID;
  settlement_event_id UUID;
  funding_event_id UUID;
  provider_release_event_id UUID;
  payout_event_id UUID;
  bank_settlement_event_id UUID;
  expected_external_reference_sha256 CHAR(64);
  expected_provider_result_sha256 CHAR(64);
BEGIN
  -- HXUV1-NPFIP-V1:FAKE_RECONCILIATION_FACT
  IF p_provider_kind IS DISTINCT FROM 'FAKE' THEN
    RAISE EXCEPTION
      'HXUV1-NPFIP-8: canonical runtime reconciliation materialization is fake-only'
      USING ERRCODE = 'P0001';
  END IF;
  IF p_reconciliation_fact_id IS NULL
     OR p_reconciliation_bridge_id IS NULL
     OR p_operation_id IS NULL
     OR p_idempotency_key IS NULL
     OR p_terminal_intent_id IS NULL
     OR p_command_id IS NULL
     OR p_dispatch_attempt_id IS NULL
     OR p_outcome_fact_id IS NULL
     OR p_fake_operation_event_id IS NULL
     OR COALESCE(p_reconciliation_snapshot_sha256, '') !~ '^[a-f0-9]{64}$'
     OR COALESCE(p_application_request_sha256, '') !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION
      'HXUV1-NPFIP-8: complete explicit reconciliation and durable-chain identities are required'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('hxos-record-fake-reconciliation-fact-v1'),
    pg_catalog.hashtext(p_idempotency_key)
  );

  SELECT * INTO intent
    FROM public.universal_v1_fake_terminal_lifecycle_intents
   WHERE terminal_intent_id = p_terminal_intent_id
   FOR SHARE;
  SELECT * INTO requested
    FROM public.financial_provider_command_journal
   WHERE command_id = p_command_id
   FOR SHARE;
  SELECT * INTO outcome
    FROM public.financial_provider_command_outcome_facts
   WHERE outcome_fact_id = p_outcome_fact_id
   FOR SHARE;
  SELECT * INTO fake_event
    FROM public.hxos_fake_financial_operation_events_v1
   WHERE event_id = p_fake_operation_event_id
   FOR SHARE;

  IF intent.terminal_intent_id IS NULL
     OR requested.command_id IS NULL
     OR outcome.outcome_fact_id IS NULL
     OR fake_event.event_id IS NULL
     OR requested.operation_kind <> 'RECONCILE'
     OR requested.provider_kind <> 'FAKE'
     OR requested.operation_id IS DISTINCT FROM p_operation_id
     OR requested.idempotency_key IS DISTINCT FROM p_idempotency_key
     OR requested.work_order_id IS DISTINCT FROM intent.work_order_id
     OR p_application_request_sha256 IS DISTINCT FROM intent.request_sha256
     OR outcome.command_id IS DISTINCT FROM p_command_id
     OR outcome.dispatch_attempt_id IS DISTINCT FROM p_dispatch_attempt_id
     OR outcome.outcome_kind <> 'OUTCOME_OBSERVED'
     OR outcome.provider_state <> 'MATCHED'
     OR outcome.retryable IS TRUE
     OR outcome.provider_result_version IS NULL
     OR outcome.provider_result_sha256 IS NULL
     OR outcome.external_reference_sha256 IS NULL
     OR fake_event.operation_id IS DISTINCT FROM p_operation_id
     OR fake_event.operation_kind <> 'RECONCILE'
     OR fake_event.idempotency_key IS DISTINCT FROM p_idempotency_key
     OR fake_event.state IS DISTINCT FROM outcome.provider_state
     OR fake_event.event_version::BIGINT IS DISTINCT FROM
          outcome.provider_result_version
     OR fake_event.event_version::BIGINT IS DISTINCT FROM
          requested.provider_expected_version + 1
     OR fake_event.retryable IS DISTINCT FROM outcome.retryable
     OR fake_event.provider_request_sha256 IS DISTINCT FROM
          requested.request_sha256
     OR fake_event.amount_cents IS NOT NULL
     OR fake_event.currency IS NOT NULL THEN
    RAISE EXCEPTION
      'HXUV1-NPFIP-9: reconciliation materialization durable chain is incomplete or not exact'
      USING ERRCODE = 'P0001';
  END IF;

  expected_external_reference_sha256 := pg_catalog.encode(
    public.digest(fake_event.external_reference, 'sha256'),
    'hex'
  );
  expected_provider_result_sha256 := pg_catalog.encode(
    public.digest(
      requested.operation_id::TEXT || ':' || requested.operation_kind || ':' ||
      requested.provider_kind || ':' || outcome.provider_state || ':' ||
      outcome.provider_result_version::TEXT || ':::' ||
      expected_external_reference_sha256 || ':' || outcome.retryable::TEXT,
      'sha256'
    ),
    'hex'
  );
  IF outcome.external_reference_sha256 IS DISTINCT FROM
       expected_external_reference_sha256
     OR outcome.provider_result_sha256 IS DISTINCT FROM
          expected_provider_result_sha256 THEN
    RAISE EXCEPTION
      'HXUV1-NPFIP-9: selected fake reconciliation event is not the exact provider outcome result'
      USING ERRCODE = 'P0001';
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
  END IF;

  expected_snapshot_sha256 :=
    public.universal_v1_fake_terminal_reconciliation_snapshot_sha256_v1(
      p_terminal_intent_id
    );
  IF capture_event_id IS NULL
     OR expected_snapshot_sha256 IS NULL
     OR expected_snapshot_sha256::TEXT IS DISTINCT FROM
          p_reconciliation_snapshot_sha256
     OR fake_event.metadata->>'reconciliationSnapshotSha256' IS DISTINCT FROM
          expected_snapshot_sha256::TEXT
     OR (
       intent.terminal_path = 'SETTLED'
       AND (
         settlement_event_id IS NULL
         OR funding_event_id IS NULL
         OR provider_release_event_id IS NULL
         OR payout_event_id IS NULL
         OR bank_settlement_event_id IS NULL
       )
     )
     OR (intent.terminal_path = 'FULL_REFUND' AND refund_event_id IS NULL) THEN
    RAISE EXCEPTION
      'HXUV1-NPFIP-9: reconciliation snapshot is not the exact terminal intent result'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO inserted_row
    FROM public.task_reconciliation_facts
   WHERE idempotency_key = p_idempotency_key
   FOR SHARE;
  IF inserted_row.id IS NOT NULL THEN
    SELECT * INTO existing_bridge
      FROM public.universal_v1_fake_reconciliation_bridges
     WHERE reconciliation_fact_id = inserted_row.id
     FOR SHARE;
    IF inserted_row.id IS DISTINCT FROM p_reconciliation_fact_id
       OR public.universal_v1_reconciliation_snapshot_sha256_v1(inserted_row.id)::TEXT
            IS DISTINCT FROM expected_snapshot_sha256::TEXT
       OR inserted_row.evidence->>'operationId' IS DISTINCT FROM p_operation_id::TEXT
       OR inserted_row.evidence->>'providerKind' IS DISTINCT FROM 'FAKE'
       OR inserted_row.evidence->>'providerState' IS DISTINCT FROM outcome.provider_state
       OR inserted_row.evidence->>'reconciliationSnapshotSha256'
            IS DISTINCT FROM expected_snapshot_sha256::TEXT
       OR inserted_row.evidence->>'terminalIntentId'
            IS DISTINCT FROM p_terminal_intent_id::TEXT
       OR inserted_row.evidence->>'applicationRequestSha256'
            IS DISTINCT FROM p_application_request_sha256
       OR existing_bridge.reconciliation_bridge_id IS DISTINCT FROM
            p_reconciliation_bridge_id
       OR existing_bridge.terminal_intent_id IS DISTINCT FROM p_terminal_intent_id
       OR existing_bridge.command_id IS DISTINCT FROM p_command_id
       OR existing_bridge.dispatch_attempt_id IS DISTINCT FROM p_dispatch_attempt_id
       OR existing_bridge.outcome_fact_id IS DISTINCT FROM p_outcome_fact_id
       OR existing_bridge.fake_operation_event_id IS DISTINCT FROM
            p_fake_operation_event_id THEN
      RAISE EXCEPTION
        'HXUV1-NPFIP-10: fake reconciliation idempotency identity conflicts with committed authority'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN inserted_row;
  END IF;

  INSERT INTO public.task_reconciliation_facts (
    id, work_order_id, reconciliation_version, supersedes_fact_id,
    void_event_id, capture_event_id, refund_event_id, reversal_event_id,
    settlement_event_id, funding_event_id, provider_release_event_id,
    payout_event_id, bank_settlement_event_id, void_state, capture_state,
    refund_state, reversal_state, settlement_state, funding_state,
    provider_release_state, payout_state, bank_settlement_state, ledger_state,
    reconciliation_state, mismatch_codes, customer_ledger_amount_cents,
    provider_ledger_amount_cents, currency, expected_version, evidence,
    recorded_by, idempotency_key
  ) VALUES (
    p_reconciliation_fact_id, intent.work_order_id,
    intent.starting_reconciliation_version + 1,
    intent.prior_reconciliation_fact_id, NULL, capture_event_id,
    refund_event_id, NULL, settlement_event_id, funding_event_id,
    provider_release_event_id, payout_event_id, bank_settlement_event_id,
    'NOT_APPLICABLE', 'CAPTURED',
    CASE intent.terminal_path
      WHEN 'FULL_REFUND' THEN 'REFUNDED'
      ELSE 'NOT_APPLICABLE'
    END,
    'NOT_APPLICABLE',
    CASE intent.terminal_path
      WHEN 'SETTLED' THEN 'SETTLED'
      ELSE 'NOT_APPLICABLE'
    END,
    CASE intent.terminal_path
      WHEN 'SETTLED' THEN 'FUNDED'
      ELSE 'NOT_APPLICABLE'
    END,
    CASE intent.terminal_path
      WHEN 'SETTLED' THEN 'RELEASED'
      ELSE 'NOT_APPLICABLE'
    END,
    CASE intent.terminal_path
      WHEN 'SETTLED' THEN 'PAID'
      ELSE 'NOT_APPLICABLE'
    END,
    CASE intent.terminal_path
      WHEN 'SETTLED' THEN 'SETTLED'
      ELSE 'NOT_APPLICABLE'
    END,
    'MATCHED',
    CASE intent.terminal_path WHEN 'SETTLED' THEN 'MATCHED' ELSE 'CLOSED' END,
    ARRAY[]::TEXT[],
    CASE intent.terminal_path WHEN 'SETTLED' THEN intent.customer_amount_cents ELSE 0 END,
    CASE intent.terminal_path WHEN 'SETTLED' THEN intent.provider_amount_cents ELSE 0 END,
    intent.currency, intent.starting_reconciliation_version,
    pg_catalog.jsonb_build_object(
      'operationId', requested.operation_id,
      'providerKind', 'FAKE',
      'providerState', outcome.provider_state,
      'providerOperationVersion', outcome.provider_result_version,
      'providerExternalReference', fake_event.external_reference,
      'providerIdempotencyReplayed', FALSE,
      'reconciliationSnapshotSha256', expected_snapshot_sha256,
      'terminalIntentId', p_terminal_intent_id,
      'durableFakeEvidence', pg_catalog.jsonb_build_object(
        'commandId', p_command_id,
        'dispatchAttemptId', p_dispatch_attempt_id,
        'outcomeFactId', p_outcome_fact_id,
        'fakeOperationEventId', p_fake_operation_event_id
      ),
      'applicationRequestSha256', p_application_request_sha256
    ),
    intent.requested_by, requested.idempotency_key
  )
  RETURNING * INTO STRICT inserted_row;

  PERFORM public.hxos_record_fake_reconciliation_bridge_v1(
    p_reconciliation_bridge_id, p_terminal_intent_id,
    p_reconciliation_fact_id, p_command_id, p_dispatch_attempt_id,
    p_outcome_fact_id, p_fake_operation_event_id
  );
  RETURN inserted_row;
END;
$$;

REVOKE ALL ON FUNCTION public.hxos_record_financial_provider_command_v1(
  UUID, TEXT, UUID, TEXT, TEXT, BIGINT, TEXT, TEXT, UUID, TEXT, UUID, UUID,
  UUID, UUID, BIGINT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.hxos_prepare_universal_v1_financial_command_v1(
  UUID, TEXT, UUID, TEXT, TEXT, BIGINT, BIGINT, TEXT, UUID, UUID, UUID, UUID,
  UUID, UUID, UUID, UUID, BIGINT, TEXT, UUID
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.hxos_record_financial_provider_dispatch_attempt_v1(
  UUID, UUID, UUID, INTEGER
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.hxos_record_change_order_materialization_command_v1(
  UUID, TEXT, UUID, UUID, UUID, UUID, UUID, UUID, UUID, INTEGER, INTEGER,
  INTEGER, INTEGER, INTEGER, UUID, UUID, UUID, INTEGER, INTEGER, TEXT,
  TIMESTAMPTZ
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.hxos_record_fake_financial_lifecycle_bridge_v1(
  UUID, UUID, UUID, UUID, UUID, UUID, UUID
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.hxos_record_fake_financial_security_event_v1(
  UUID, UUID, TEXT, UUID, TEXT, UUID, UUID, UUID, UUID, UUID
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.hxos_record_fake_terminal_lifecycle_intent_v1(
  UUID, TEXT, UUID, UUID, UUID, UUID, BIGINT, INTEGER, TEXT, TEXT, UUID
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.hxos_record_fake_provider_account_fact_v1(
  UUID, TEXT, UUID, UUID, UUID, UUID, UUID, UUID, UUID, UUID, UUID, UUID, UUID
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.hxos_record_fake_reconciliation_bridge_v1(
  UUID, UUID, UUID, UUID, UUID, UUID, UUID
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.hxos_record_fake_reconciliation_fact_v1(
  UUID, UUID, TEXT, UUID, TEXT, TEXT, UUID, UUID, UUID, UUID, UUID, TEXT
) FROM PUBLIC;

DO $$
DECLARE
  invalid_port TEXT;
BEGIN
  SELECT expected.function_signature
    INTO invalid_port
    FROM (VALUES
      ('public.hxos_record_financial_provider_command_v1(uuid,text,uuid,text,text,bigint,text,text,uuid,text,uuid,uuid,uuid,uuid,bigint,text,uuid,text,text,text,text,text,text)',
       'public.financial_provider_command_journal'::pg_catalog.regtype,
       'HXUV1-NPFIP-V1:JOURNAL'),
      ('public.hxos_prepare_universal_v1_financial_command_v1(uuid,text,uuid,text,text,bigint,bigint,text,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,bigint,text,uuid)',
       'public.universal_v1_prepared_financial_commands'::pg_catalog.regtype,
       'HXUV1-NPFIP-V1:PREPARED'),
      ('public.hxos_record_financial_provider_dispatch_attempt_v1(uuid,uuid,uuid,integer)',
       'public.financial_provider_command_dispatch_attempts'::pg_catalog.regtype,
       'HXUV1-NPFIP-V1:DISPATCH'),
      ('public.hxos_record_change_order_materialization_command_v1(uuid,text,uuid,uuid,uuid,uuid,uuid,uuid,uuid,integer,integer,integer,integer,integer,uuid,uuid,uuid,integer,integer,text,timestamp with time zone)',
       'public.universal_v1_change_order_materialization_commands'::pg_catalog.regtype,
       'HXUV1-NPFIP-V1:CHANGE_ORDER'),
      ('public.hxos_record_fake_financial_lifecycle_bridge_v1(uuid,uuid,uuid,uuid,uuid,uuid,uuid)',
       'public.universal_v1_fake_financial_lifecycle_bridges'::pg_catalog.regtype,
       'HXUV1-NPFIP-V1:LIFECYCLE_BRIDGE'),
      ('public.hxos_record_fake_financial_security_event_v1(uuid,uuid,text,uuid,text,uuid,uuid,uuid,uuid,uuid)',
       'public.task_financial_security_events'::pg_catalog.regtype,
       'HXUV1-NPFIP-V1:FAKE_FINANCIAL_EVENT'),
      ('public.hxos_record_fake_terminal_lifecycle_intent_v1(uuid,text,uuid,uuid,uuid,uuid,bigint,integer,text,text,uuid)',
       'public.universal_v1_fake_terminal_lifecycle_intents'::pg_catalog.regtype,
       'HXUV1-NPFIP-V1:TERMINAL_INTENT'),
      ('public.hxos_record_fake_provider_account_fact_v1(uuid,text,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid)',
       'public.universal_v1_fake_provider_account_facts'::pg_catalog.regtype,
       'HXUV1-NPFIP-V1:PROVIDER_ACCOUNT'),
      ('public.hxos_record_fake_reconciliation_bridge_v1(uuid,uuid,uuid,uuid,uuid,uuid,uuid)',
       'public.universal_v1_fake_reconciliation_bridges'::pg_catalog.regtype,
       'HXUV1-NPFIP-V1:RECONCILIATION_BRIDGE'),
      ('public.hxos_record_fake_reconciliation_fact_v1(uuid,uuid,text,uuid,text,text,uuid,uuid,uuid,uuid,uuid,text)',
       'public.task_reconciliation_facts'::pg_catalog.regtype,
       'HXUV1-NPFIP-V1:FAKE_RECONCILIATION_FACT')
    ) expected(function_signature, return_type, body_marker)
    LEFT JOIN pg_catalog.pg_proc procedure
      ON procedure.oid =
        pg_catalog.to_regprocedure(expected.function_signature)::OID
    LEFT JOIN pg_catalog.pg_language language_record
      ON language_record.oid = procedure.prolang
   WHERE procedure.oid IS NULL
      OR procedure.proowner <> CURRENT_USER::pg_catalog.regrole::OID
      OR procedure.prorettype <> expected.return_type::OID
      OR procedure.proretset
      OR procedure.prokind <> 'f'
      OR language_record.lanname <> 'plpgsql'
      OR NOT procedure.prosecdef
      OR procedure.provolatile <> 'v'
      OR procedure.proparallel <> 'u'
      OR procedure.proconfig IS DISTINCT FROM
         ARRAY['search_path=pg_catalog, public']::TEXT[]
      OR pg_catalog.strpos(procedure.prosrc, expected.body_marker) = 0
      OR EXISTS (
        SELECT 1
          FROM pg_catalog.aclexplode(COALESCE(
            procedure.proacl,
            pg_catalog.acldefault('f', procedure.proowner)
          )) privilege
         WHERE privilege.grantee = 0
           AND privilege.privilege_type = 'EXECUTE'
      )
      OR EXISTS (
        SELECT 1
          FROM pg_catalog.pg_depend extension_dependency
         WHERE extension_dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
           AND extension_dependency.objid = procedure.oid
           AND extension_dependency.refclassid =
             'pg_catalog.pg_extension'::pg_catalog.regclass
           AND extension_dependency.deptype = 'e'
      )
   ORDER BY expected.function_signature
   LIMIT 1;
  IF invalid_port IS NOT NULL THEN
    RAISE EXCEPTION
      'HXUV1-NPFIP-4: sealed runtime insert port is missing or unsafe: %',
      invalid_port
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

COMMENT ON FUNCTION public.hxos_record_financial_provider_command_v1(
  UUID, TEXT, UUID, TEXT, TEXT, BIGINT, TEXT, TEXT, UUID, TEXT, UUID, UUID,
  UUID, UUID, BIGINT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
) IS 'Sealed provider-command journal insert port. It grants no provider call, positive financial effect, production capability, or runtime access by itself.';
COMMENT ON FUNCTION public.hxos_prepare_universal_v1_financial_command_v1(
  UUID, TEXT, UUID, TEXT, TEXT, BIGINT, BIGINT, TEXT, UUID, UUID, UUID, UUID,
  UUID, UUID, UUID, UUID, BIGINT, TEXT, UUID
) IS 'Sealed fake-only PREPARED financial command insert port; database triggers derive and validate lifecycle authority.';
COMMENT ON FUNCTION public.hxos_record_financial_provider_dispatch_attempt_v1(
  UUID, UUID, UUID, INTEGER
) IS 'Sealed durable dispatch-attempt evidence port. It records no provider outcome or lifecycle effect.';
COMMENT ON FUNCTION public.hxos_record_change_order_materialization_command_v1(
  UUID, TEXT, UUID, UUID, UUID, UUID, UUID, UUID, UUID, INTEGER, INTEGER,
  INTEGER, INTEGER, INTEGER, UUID, UUID, UUID, INTEGER, INTEGER, TEXT,
  TIMESTAMPTZ
) IS 'Sealed Phase-A change-order witness port. It does not execute an adapter or materialize an amendment.';
COMMENT ON FUNCTION public.hxos_record_fake_financial_lifecycle_bridge_v1(
  UUID, UUID, UUID, UUID, UUID, UUID, UUID
) IS 'Internal sealed fake-financial lifecycle evidence bridge primitive; canonical runtime materialization uses the atomic fact port.';
COMMENT ON FUNCTION public.hxos_record_fake_financial_security_event_v1(
  UUID, UUID, TEXT, UUID, TEXT, UUID, UUID, UUID, UUID, UUID
) IS 'Atomic fake-only lifecycle fact and bridge port. Provider observation time, expiry, result, amount, and bindings are database-derived; it performs no provider I/O or external effect.';
COMMENT ON FUNCTION public.hxos_record_fake_terminal_lifecycle_intent_v1(
  UUID, TEXT, UUID, UUID, UUID, UUID, BIGINT, INTEGER, TEXT, TEXT, UUID
) IS 'Sealed fake terminal-plan intent port. It creates no provider call or positive effect.';
COMMENT ON FUNCTION public.hxos_record_fake_provider_account_fact_v1(
  UUID, TEXT, UUID, UUID, UUID, UUID, UUID, UUID, UUID, UUID, UUID, UUID, UUID
) IS 'Sealed fake provider-account projection port; all provider state is derived from exact immutable fake evidence.';
COMMENT ON FUNCTION public.hxos_record_fake_reconciliation_bridge_v1(
  UUID, UUID, UUID, UUID, UUID, UUID, UUID
) IS 'Internal sealed fake reconciliation evidence bridge primitive; canonical runtime materialization uses the atomic fact port.';
COMMENT ON FUNCTION public.hxos_record_fake_reconciliation_fact_v1(
  UUID, UUID, TEXT, UUID, TEXT, TEXT, UUID, UUID, UUID, UUID, UUID, TEXT
) IS 'Atomic fake-only terminal reconciliation fact and bridge port. The snapshot is database-derived from immutable intent and lifecycle evidence; it performs no provider I/O or external effect.';

COMMENT ON TABLE public.hxos_fake_financial_schema_evidence_v11 IS
  'Append-only exact-SQL evidence for the nonproduction fake-finance v11 sealed runtime insert authority.';

REVOKE ALL ON TABLE public.hxos_fake_financial_schema_evidence_v11 FROM PUBLIC;
