-- Universal V1 fake-financial command outbox authority v13.
--
-- A fake lifecycle command becomes publishable only after its exact immutable
-- PREPARED and REQUESTED facts have committed in PostgreSQL. The REQUESTED
-- insert captures one outbox request in the same transaction. Redis/BullMQ is
-- transport only: its ID-only job envelope must match the database-generated
-- job ID and authority digest before PostgreSQL records DISPATCH_ATTEMPTED.
--
-- Publisher claims, publisher outcomes, worker validations, and webhook
-- evidence are append-only. A queue add that succeeds before its PostgreSQL
-- acknowledgement is recovered by reusing the same deterministic BullMQ job
-- ID after the lease expires. An exact Redis replay can therefore never mint a
-- second provider operation. Authenticated fake-provider webhooks are captured
-- on a separate inert evidence rail and can neither create an outbox request
-- nor authorize a lifecycle transition.
--
-- This migration performs no queue or provider I/O. Exact FAKE request bytes
-- remain in an owner-only immutable fact; transport carries IDs only. It creates
-- no hard assignment and grants no provider-execution,
-- payment, deployment, production, or positive-money capability. The recovery
-- lease and DISPATCH_ATTEMPTED rows written by the sealed evidence port are
-- crash-boundary evidence only. Runtime bootstrap, exact local bytes, the
-- eight-role catalog, and a separate opaque application capability must still
-- be revalidated immediately before any fake adapter entry.
--
-- Transport mutation ports require READ COMMITTED so each VOLATILE function
-- statement sees holds committed before it acquired the publisher lock.
-- Business PREPARED/REQUESTED capture remains usable in SERIALIZABLE transactions.

SELECT pg_catalog.set_config('search_path', 'pg_catalog', true);

DO $$
DECLARE
  missing_relation TEXT;
  unsafe_schema TEXT;
  invalid_predecessor TEXT;
  expected_ordinal146_sha256 CONSTANT TEXT :=
    '3920ac8d3208b9f573dc331cab60c373d0349611700c6e14a6e4c1dd8c53aac4';
  expected_v12_sha256 CONSTANT TEXT :=
    '5bb8ee72b9113146b88c22c6751ebe527ba6246b4463a8611ef9c24b999b7ac5';
  expected_seal_sha256 CONSTANT TEXT :=
    'c69825589193885d0f6a3b93930880998e95e1c5cd44bb9b5999cb457192b2bd';
BEGIN
  SELECT required.relation_name
    INTO missing_relation
    FROM (VALUES
      ('public.financial_provider_command_journal'),
      ('public.universal_v1_prepared_financial_commands'),
      ('public.financial_provider_command_recovery_leases'),
      ('public.financial_provider_command_dispatch_attempts'),
      ('public.financial_provider_command_outcome_facts'),
      ('public.provider_event_inbox_observations'),
      ('public.provider_event_inbox_receipts'),
      ('public.applied_migrations'),
      ('public.hxos_fake_financial_schema_evidence_v12'),
      ('public.hxos_work_order_bootstrap_seal_evidence_v1'),
      ('hx_authority.universal_v1_work_order_target_authority_facts')
    ) required(relation_name)
   WHERE pg_catalog.to_regclass(required.relation_name) IS NULL
   ORDER BY required.relation_name
   LIMIT 1;
  IF missing_relation IS NOT NULL THEN
    RAISE EXCEPTION
      'HXUV1-FINOUT-13-0: required predecessor relation is absent: %',
      missing_relation
      USING ERRCODE = 'P0001';
  END IF;

  LOCK TABLE public.applied_migrations IN SHARE MODE;
  LOCK TABLE public.hxos_fake_financial_schema_evidence_v12 IN SHARE MODE;
  LOCK TABLE public.hxos_work_order_bootstrap_seal_evidence_v1 IN SHARE MODE;

  SELECT expected.migration_name
    INTO invalid_predecessor
    FROM (VALUES
      ('20261014_universal_v1_work_order_command_ports_v1',
       expected_ordinal146_sha256),
      ('20261015_universal_v1_work_order_fake_financial_authority_hardening_v12',
       expected_v12_sha256),
      ('20261015_universal_v1_work_order_bootstrap_seal_v1',
       expected_seal_sha256)
    ) expected(migration_name, expected_sha256)
    LEFT JOIN public.applied_migrations applied
      ON applied.name = expected.migration_name
   GROUP BY expected.migration_name, expected.expected_sha256
  HAVING pg_catalog.count(applied.name) IS DISTINCT FROM 1::BIGINT
      OR pg_catalog.min(pg_catalog.btrim(applied.sha256)) IS DISTINCT FROM expected.expected_sha256
   ORDER BY expected.migration_name
   LIMIT 1;
  IF invalid_predecessor IS NOT NULL THEN
    RAISE EXCEPTION
      'HXUV1-FINOUT-13-1: exact applied predecessor hash is absent: %',
      invalid_predecessor
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.hxos_work_order_bootstrap_seal_evidence_v1 evidence
     WHERE evidence.migration_name =
             '20261015_universal_v1_work_order_bootstrap_seal_v1'
       AND pg_catalog.btrim(evidence.migration_sql_sha256) =
             expected_seal_sha256
       AND pg_catalog.btrim(evidence.ordinal146_sql_sha256) =
             expected_ordinal146_sha256
       AND pg_catalog.btrim(evidence.v12_sql_sha256) = expected_v12_sha256
  ) THEN
    RAISE EXCEPTION
      'HXUV1-FINOUT-13-1B: exact Work Order bootstrap seal evidence is absent'
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.hxos_fake_financial_schema_evidence_v12 evidence
     WHERE evidence.migration_name =
       '20261015_universal_v1_work_order_fake_financial_authority_hardening_v12'
       AND pg_catalog.btrim(evidence.migration_sql_sha256) =
             expected_v12_sha256
       AND pg_catalog.btrim(evidence.ordinal146_sql_sha256) =
             expected_ordinal146_sha256
  ) THEN
    RAISE EXCEPTION
      'HXUV1-FINOUT-13-1A: exact ordinal146/v12 predecessor evidence is absent'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT namespace_state.nspname
    INTO unsafe_schema
    FROM pg_catalog.pg_namespace namespace_state
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        namespace_state.nspacl,
        pg_catalog.acldefault('n', namespace_state.nspowner)
      )
    ) privilege
   WHERE namespace_state.nspname IN ('public', 'hx_authority')
     AND privilege.grantee <> namespace_state.nspowner
     AND privilege.privilege_type = 'CREATE'
   ORDER BY namespace_state.nspname
   LIMIT 1;
  IF unsafe_schema IS NOT NULL THEN
    RAISE EXCEPTION
      'HXUV1-FINOUT-13-2: non-owner CREATE remains available on schema %',
      unsafe_schema
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION hx_authority.fake_financial_job_digest_v13(
  identity_parts TEXT[]
)
RETURNS CHAR(64)
LANGUAGE SQL
SECURITY INVOKER
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        pg_catalog.array_to_string(
          ARRAY(
            SELECT pg_catalog.octet_length(part.value)::TEXT
                     || ':' || part.value
              FROM pg_catalog.unnest(identity_parts)
                   WITH ORDINALITY AS part(value, position)
             ORDER BY part.position
          ),
          '|'
        ),
        'UTF8'
      )
    ),
    'hex'
  )::CHAR(64)
$$;

-- Forward-normalize the newly protected prepared-command trigger dependencies.
-- Preserve the complete post-compensation/post-recovery sealed-prefix bodies;
-- change only SHA calls and pin the previously absent search path.
-- Exact installed sealed-prefix definition SHA-256: 7d9b9d78b0ffdfd1f7bd6b535363eb1f243b551eeaeceb59bb68a10d93e2a69f
CREATE OR REPLACE FUNCTION public.enforce_universal_v1_financial_command_preparation()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  lock_key TEXT;
  draft public.task_drafts%ROWTYPE;
  task_record public.tasks%ROWTYPE;
  eligibility public.task_provider_eligibility_decisions%ROWTYPE;
  scope_record public.task_scope_versions%ROWTYPE;
  work_order public.task_work_orders%ROWTYPE;
  predecessor public.task_financial_security_events%ROWTYPE;
  prior_preparation public.universal_v1_prepared_financial_commands%ROWTYPE;
  proposal public.task_scope_change_proposals%ROWTYPE;
  completion public.task_completion_facts%ROWTYPE;
  captured_amount BIGINT;
  refunded_amount BIGINT;
  expected_event_kind TEXT;
  effective_work_order_scope_id UUID;
BEGIN
  -- All callers, including direct DML, take the same ordered transaction locks.
  FOR lock_key IN
    SELECT candidate
    FROM unnest(ARRAY[
      'draft-version:' || NEW.task_draft_id::TEXT || ':' || NEW.lifecycle_expected_version::TEXT,
      'idempotency:' || NEW.idempotency_key,
      'operation-version:' || NEW.provider_kind || ':' || NEW.operation_kind || ':' ||
        NEW.operation_id::TEXT || ':' || NEW.provider_expected_version::TEXT
    ]) AS lock_candidates(candidate)
    ORDER BY candidate
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtext('universal-v1-prepared-financial-command-v1'),
      hashtext(lock_key)
    );
  END LOOP;

  IF NEW.provider_kind <> 'FAKE' THEN
    RAISE EXCEPTION 'HXUV1-PFC-1: approved-provider preparation remains sealed'
      USING ERRCODE = 'P0001';
  END IF;

  expected_event_kind := CASE NEW.operation_kind
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
  IF expected_event_kind IS NULL THEN
    RAISE EXCEPTION 'HXUV1-PFC-2: operation kind is outside lifecycle preparation authority'
      USING ERRCODE = 'P0001';
  END IF;
  NEW.event_kind := expected_event_kind;
  -- Wall-clock evidence belongs to PostgreSQL, never to an API caller.
  NEW.occurred_at := clock_timestamp();
  NEW.prepared_at := clock_timestamp();

  SELECT * INTO draft
  FROM public.task_drafts
  WHERE id = NEW.task_draft_id
  FOR SHARE;
  IF draft.id IS NULL OR draft.universal_contract_version <> 1 THEN
    RAISE EXCEPTION 'HXUV1-PFC-3: exact Universal V1 Task Draft authority is required'
      USING ERRCODE = 'P0001';
  END IF;

  -- Derived snapshots are database-owned; caller values are never trusted.
  NEW.eligibility_decision_version := NULL;
  NEW.eligibility_valid_until := NULL;
  NEW.scope_version := NULL;
  NEW.scope_hash := NULL;
  NEW.work_order_id := NULL;
  NEW.work_order_materialization_version := NULL;
  NEW.work_order_execution_contract_version := NULL;
  NEW.change_order_version := NULL;
  NEW.completion_version := NULL;
  NEW.predecessor_operation_id := NULL;
  NEW.predecessor_event_kind := NULL;
  NEW.predecessor_status := NULL;
  NEW.predecessor_lifecycle_version := NULL;

  IF NEW.operation_kind = 'PREPARE_PAYMENT_METHOD' THEN
    IF NEW.provider_expected_version <> 0
       OR NEW.lifecycle_expected_version <> 0
       OR NEW.predecessor_event_id IS NOT NULL
       OR NEW.related_operation_id IS NOT NULL
       OR NEW.change_order_id IS NOT NULL
       OR NEW.completion_fact_id IS NOT NULL
       OR NEW.amount_cents IS NOT NULL
       OR NEW.currency IS NOT NULL
       OR num_nonnulls(NEW.task_id, NEW.eligibility_decision_id, NEW.scope_version_id) NOT IN (0, 3)
       OR EXISTS (
         SELECT 1 FROM public.task_financial_operations operation
         WHERE operation.operation_id = NEW.operation_id::TEXT
       )
       OR EXISTS (
         SELECT 1 FROM public.task_financial_security_events event
         WHERE event.task_draft_id = NEW.task_draft_id
           AND event.expected_version = 0
       ) THEN
      RAISE EXCEPTION 'HXUV1-PFC-4: payment-method preparation must begin one unused exact lifecycle chain'
        USING ERRCODE = 'P0001';
    END IF;

    IF NEW.task_id IS NOT NULL THEN
      SELECT * INTO task_record FROM public.tasks WHERE id = NEW.task_id FOR SHARE;
      SELECT * INTO eligibility
      FROM public.task_provider_eligibility_decisions
      WHERE id = NEW.eligibility_decision_id
      FOR SHARE;
      SELECT * INTO scope_record
      FROM public.task_scope_versions
      WHERE id = NEW.scope_version_id
      FOR SHARE;
      IF task_record.id IS NULL
         OR eligibility.id IS NULL
         OR scope_record.id IS NULL
         OR draft.task_id IS DISTINCT FROM task_record.id
         OR task_record.universal_contract_version <> 1
         OR task_record.automation_classification <> 'CONTROLLED_TEST'
         OR task_record.universal_payment_posture <> 'PAYMENT_CREATION_FROZEN'
         OR task_record.worker_id IS NOT NULL
         OR eligibility.task_draft_id <> draft.id
         OR eligibility.task_id IS DISTINCT FROM task_record.id
         OR eligibility.scope_version_id IS DISTINCT FROM scope_record.id
         OR eligibility.task_eligible IS NOT TRUE
         OR eligibility.processor_payment_eligible IS NOT FALSE
         OR eligibility.payout_funding_eligible IS NOT FALSE
         OR scope_record.task_id <> task_record.id
         OR scope_record.universal_contract_version <> 1 THEN
        RAISE EXCEPTION 'HXUV1-PFC-5: bound preparation requires exact frozen fake-only task, eligibility, and scope facts'
          USING ERRCODE = 'P0001';
      END IF;
      NEW.eligibility_decision_version := eligibility.decision_version;
      NEW.eligibility_valid_until := eligibility.valid_until;
      NEW.scope_version := scope_record.version;
      NEW.scope_hash := scope_record.scope_hash;
      SELECT * INTO work_order
      FROM public.task_work_orders
      WHERE task_id = NEW.task_id
      FOR SHARE;
      IF work_order.id IS NOT NULL THEN
        IF work_order.task_draft_id <> NEW.task_draft_id
           OR work_order.eligibility_decision_id <> NEW.eligibility_decision_id THEN
          RAISE EXCEPTION 'HXUV1-PFC-6: derived Work Order conflicts with preparation bindings'
            USING ERRCODE = 'P0001';
        END IF;
        NEW.work_order_id := work_order.id;
        NEW.work_order_materialization_version := work_order.materialization_version;
        NEW.work_order_execution_contract_version := work_order.execution_contract_version;
      END IF;
    END IF;
  ELSE
    IF NEW.task_id IS NULL
       OR NEW.eligibility_decision_id IS NULL
       OR NEW.scope_version_id IS NULL
       OR NEW.predecessor_event_id IS NULL
       OR NEW.related_operation_id IS NULL
       OR NEW.amount_cents IS NULL
       OR NEW.currency IS NULL
       OR NEW.lifecycle_expected_version = 0
       OR (NEW.operation_kind = 'ADJUST') IS DISTINCT FROM (NEW.change_order_id IS NOT NULL)
       OR (NEW.operation_kind = 'CAPTURE') IS DISTINCT FROM (NEW.completion_fact_id IS NOT NULL) THEN
      RAISE EXCEPTION 'HXUV1-PFC-7: financial effect preparation bindings are incomplete'
        USING ERRCODE = 'P0001';
    END IF;

    SELECT * INTO task_record FROM public.tasks WHERE id = NEW.task_id FOR SHARE;
    SELECT * INTO eligibility
    FROM public.task_provider_eligibility_decisions
    WHERE id = NEW.eligibility_decision_id
    FOR SHARE;
    SELECT * INTO scope_record
    FROM public.task_scope_versions
    WHERE id = NEW.scope_version_id
    FOR SHARE;
    SELECT * INTO predecessor
    FROM public.task_financial_security_events
    WHERE id = NEW.predecessor_event_id
    FOR SHARE;
    SELECT * INTO work_order
    FROM public.task_work_orders
    WHERE task_id = NEW.task_id
    FOR SHARE;

    IF task_record.id IS NULL
       OR eligibility.id IS NULL
       OR scope_record.id IS NULL
       OR predecessor.id IS NULL
       OR draft.task_id IS DISTINCT FROM task_record.id
       OR task_record.universal_contract_version <> 1
       OR task_record.automation_classification <> 'CONTROLLED_TEST'
       OR task_record.universal_payment_posture <> 'PAYMENT_CREATION_FROZEN'
       OR task_record.worker_id IS NOT NULL
       OR eligibility.task_draft_id <> NEW.task_draft_id
       OR eligibility.task_id IS DISTINCT FROM NEW.task_id
       OR eligibility.task_eligible IS NOT TRUE
       OR eligibility.processor_payment_eligible IS NOT FALSE
       OR eligibility.payout_funding_eligible IS NOT FALSE
       OR scope_record.task_id <> NEW.task_id
       OR scope_record.universal_contract_version <> 1
       OR scope_record.currency IS DISTINCT FROM NEW.currency THEN
      RAISE EXCEPTION 'HXUV1-PFC-8: exact frozen fake-only task, eligibility, and monetary scope facts are required'
        USING ERRCODE = 'P0001';
    END IF;

    IF work_order.id IS NULL THEN
      IF eligibility.scope_version_id IS DISTINCT FROM NEW.scope_version_id
         OR (
           (
             eligibility.valid_until <= clock_timestamp()
             OR EXISTS (
               SELECT 1
               FROM public.task_provider_eligibility_decisions newer
               WHERE newer.task_draft_id = eligibility.task_draft_id
                 AND newer.provider_user_id = eligibility.provider_user_id
                 AND newer.provider_organization_id IS NOT DISTINCT FROM eligibility.provider_organization_id
                 AND newer.decision_version > eligibility.decision_version
             )
           )
           AND NOT (
             NEW.operation_kind = 'VOID'
             AND public.universal_v1_pre_work_order_void_is_authorized(
               NEW.operation_id,
               NEW.provider_kind,
               NEW.idempotency_key,
               NEW.provider_expected_version,
               NEW.lifecycle_expected_version,
               NEW.task_draft_id,
               NEW.task_id,
               NEW.eligibility_decision_id,
               NEW.scope_version_id,
               NEW.predecessor_event_id,
               NEW.related_operation_id,
               NEW.amount_cents,
               NEW.currency,
               NEW.recorded_by
             )
           )
         ) THEN
        RAISE EXCEPTION 'HXUV1-PFC-9: pre-Work-Order finance requires current eligibility or one exact compensation claim'
          USING ERRCODE = 'P0001';
      END IF;
    ELSE
      effective_work_order_scope_id := public.universal_v1_effective_work_order_scope_id(work_order.id);
      IF work_order.task_draft_id <> NEW.task_draft_id
         OR work_order.task_id <> NEW.task_id
         OR work_order.eligibility_decision_id <> NEW.eligibility_decision_id
         OR task_record.work_order_id IS DISTINCT FROM work_order.id
         OR (
           NEW.operation_kind <> 'ADJUST'
           AND effective_work_order_scope_id IS DISTINCT FROM NEW.scope_version_id
         ) THEN
        RAISE EXCEPTION 'HXUV1-PFC-10: financial command must bind the exact current Work Order authority'
          USING ERRCODE = 'P0001';
      END IF;
      NEW.work_order_id := work_order.id;
      NEW.work_order_materialization_version := work_order.materialization_version;
      NEW.work_order_execution_contract_version := work_order.execution_contract_version;
    END IF;

    IF NEW.operation_kind IN (
      'ADJUST','CAPTURE','REFUND','REVERSAL','SETTLE','FUND',
      'PROVIDER_RELEASE','PAYOUT','OBSERVE_BANK_SETTLEMENT'
    ) AND work_order.id IS NULL THEN
      RAISE EXCEPTION 'HXUV1-PFC-11: this financial operation requires an exact Work Order fact'
        USING ERRCODE = 'P0001';
    END IF;

    IF predecessor.task_draft_id <> NEW.task_draft_id
       OR predecessor.provider_kind <> NEW.provider_kind
       OR NEW.lifecycle_expected_version <> predecessor.expected_version + 1
       OR predecessor.operation_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       OR NOT (
         (
           predecessor.task_id IS NOT DISTINCT FROM NEW.task_id
           AND predecessor.eligibility_decision_id IS NOT DISTINCT FROM NEW.eligibility_decision_id
         )
         OR (
           predecessor.event_kind = 'PAYMENT_METHOD_PREPARED'
           AND NEW.operation_kind = 'AUTHORIZE'
           AND predecessor.task_id IS NULL
           AND predecessor.eligibility_decision_id IS NULL
           AND predecessor.scope_version_id IS NULL
         )
       )
       OR EXISTS (
         SELECT 1 FROM public.task_financial_security_events occupied
         WHERE occupied.task_draft_id = NEW.task_draft_id
           AND occupied.expected_version = NEW.lifecycle_expected_version
       ) THEN
      RAISE EXCEPTION 'HXUV1-PFC-12: exact latest financial predecessor and unused lifecycle version are required'
        USING ERRCODE = 'P0001';
    END IF;

    NEW.predecessor_operation_id := predecessor.operation_id::UUID;
    NEW.predecessor_event_kind := predecessor.event_kind;
    NEW.predecessor_status := predecessor.status;
    NEW.predecessor_lifecycle_version := predecessor.expected_version;

    IF predecessor.status IN ('REQUESTED', 'RETRYABLE_FAILURE') THEN
      IF NEW.operation_id::TEXT <> predecessor.operation_id
         OR NEW.event_kind <> predecessor.event_kind
         OR NEW.provider_expected_version = 0
         OR NEW.scope_version_id IS DISTINCT FROM predecessor.scope_version_id
         OR NEW.change_order_id IS DISTINCT FROM predecessor.change_order_id
         OR NEW.completion_fact_id IS DISTINCT FROM predecessor.completion_fact_id
         OR NEW.amount_cents IS DISTINCT FROM predecessor.amount_cents
         OR NEW.currency IS DISTINCT FROM predecessor.currency THEN
        RAISE EXCEPTION 'HXUV1-PFC-13: retry preparation must preserve the exact requested effect'
          USING ERRCODE = 'P0001';
      END IF;
      SELECT * INTO prior_preparation
      FROM public.universal_v1_prepared_financial_commands prior
      WHERE prior.provider_kind = NEW.provider_kind
        AND prior.operation_kind = NEW.operation_kind
        AND prior.operation_id = NEW.operation_id
        AND prior.provider_expected_version = NEW.provider_expected_version - 1
      FOR SHARE;
      IF prior_preparation.prepared_command_id IS NULL
         OR prior_preparation.task_draft_id <> NEW.task_draft_id
         OR prior_preparation.task_id IS DISTINCT FROM NEW.task_id
         OR prior_preparation.eligibility_decision_id IS DISTINCT FROM NEW.eligibility_decision_id
         OR prior_preparation.scope_version_id IS DISTINCT FROM NEW.scope_version_id
         OR prior_preparation.change_order_id IS DISTINCT FROM NEW.change_order_id
         OR prior_preparation.completion_fact_id IS DISTINCT FROM NEW.completion_fact_id
         OR prior_preparation.related_operation_id IS DISTINCT FROM NEW.related_operation_id
         OR prior_preparation.amount_cents IS DISTINCT FROM NEW.amount_cents
         OR prior_preparation.currency IS DISTINCT FROM NEW.currency
         OR NOT EXISTS (
           SELECT 1 FROM public.task_financial_operations operation
           WHERE operation.operation_id = NEW.operation_id::TEXT
             AND operation.task_draft_id = NEW.task_draft_id
             AND operation.task_id IS NOT DISTINCT FROM NEW.task_id
             AND operation.eligibility_decision_id IS NOT DISTINCT FROM NEW.eligibility_decision_id
             AND operation.scope_version_id IS NOT DISTINCT FROM NEW.scope_version_id
             AND operation.change_order_id IS NOT DISTINCT FROM NEW.change_order_id
             AND operation.event_kind = NEW.event_kind
             AND operation.provider_kind = NEW.provider_kind
             AND operation.amount_cents IS NOT DISTINCT FROM NEW.amount_cents
             AND operation.currency IS NOT DISTINCT FROM NEW.currency
             AND operation.completion_fact_id IS NOT DISTINCT FROM NEW.completion_fact_id
         ) THEN
        RAISE EXCEPTION 'HXUV1-PFC-14: retry lacks its exact prior PREPARED and immutable operation facts'
          USING ERRCODE = 'P0001';
      END IF;
    ELSE
      IF predecessor.status <> 'SUCCEEDED'
         OR NEW.provider_expected_version <> 0
         OR NEW.operation_id::TEXT = predecessor.operation_id
         OR NEW.related_operation_id::TEXT <> predecessor.operation_id
         OR EXISTS (
           SELECT 1 FROM public.task_financial_operations operation
           WHERE operation.operation_id = NEW.operation_id::TEXT
         )
         OR NOT (
           (NEW.event_kind = 'AUTHORIZED' AND predecessor.event_kind = 'PAYMENT_METHOD_PREPARED')
           OR (NEW.event_kind = 'SECURED' AND predecessor.event_kind IN ('AUTHORIZED','ADJUSTMENT_AUTHORIZED'))
           OR (NEW.event_kind = 'VOIDED' AND predecessor.event_kind IN ('AUTHORIZED','SECURED','ADJUSTMENT_AUTHORIZED'))
           OR (NEW.event_kind = 'ADJUSTMENT_AUTHORIZED' AND predecessor.event_kind IN ('SECURED','ADJUSTMENT_AUTHORIZED'))
           OR (NEW.event_kind = 'CAPTURED' AND predecessor.event_kind IN ('SECURED','ADJUSTMENT_AUTHORIZED'))
           OR (NEW.event_kind = 'REFUNDED' AND predecessor.event_kind IN (
             'CAPTURED','REFUNDED','SETTLEMENT_OBSERVED','FUNDING_OBSERVED',
             'PROVIDER_RELEASED','PAYOUT_OBSERVED','BANK_SETTLEMENT_OBSERVED'
           ))
           OR (NEW.event_kind = 'REVERSED' AND predecessor.event_kind IN (
             'AUTHORIZED','SECURED','ADJUSTMENT_AUTHORIZED','CAPTURED'
           ))
           OR (NEW.event_kind = 'SETTLEMENT_OBSERVED' AND predecessor.event_kind = 'CAPTURED')
           OR (NEW.event_kind = 'FUNDING_OBSERVED' AND predecessor.event_kind = 'SETTLEMENT_OBSERVED')
           OR (NEW.event_kind = 'PROVIDER_RELEASED' AND predecessor.event_kind = 'FUNDING_OBSERVED')
           OR (NEW.event_kind = 'PAYOUT_OBSERVED' AND predecessor.event_kind = 'PROVIDER_RELEASED')
           OR (NEW.event_kind = 'BANK_SETTLEMENT_OBSERVED' AND predecessor.event_kind = 'PAYOUT_OBSERVED')
         ) THEN
        RAISE EXCEPTION 'HXUV1-PFC-15: operation kind has no exact authorized predecessor transition'
          USING ERRCODE = 'P0001';
      END IF;
    END IF;

    IF predecessor.currency IS NOT NULL AND NEW.currency IS DISTINCT FROM predecessor.currency THEN
      RAISE EXCEPTION 'HXUV1-PFC-16: financial chain currency cannot drift'
        USING ERRCODE = 'P0001';
    END IF;
    IF NEW.operation_kind = 'AUTHORIZE' AND NEW.amount_cents <> scope_record.customer_total_cents THEN
      RAISE EXCEPTION 'HXUV1-PFC-17: authorization must equal the exact scope customer total'
        USING ERRCODE = 'P0001';
    END IF;
    IF NEW.operation_kind IN ('SECURE','VOID','REVERSAL','SETTLE','FUND','PAYOUT','OBSERVE_BANK_SETTLEMENT')
       AND NEW.amount_cents <> predecessor.amount_cents THEN
      RAISE EXCEPTION 'HXUV1-PFC-18: operation amount must preserve its exact predecessor authority'
        USING ERRCODE = 'P0001';
    END IF;
    IF NEW.operation_kind = 'PROVIDER_RELEASE'
       AND NEW.amount_cents <> scope_record.hustler_payout_cents THEN
      RAISE EXCEPTION 'HXUV1-PFC-19: provider release must equal the immutable scope payout'
        USING ERRCODE = 'P0001';
    END IF;

    IF NEW.operation_kind = 'ADJUST' THEN
      SELECT * INTO proposal
      FROM public.task_scope_change_proposals
      WHERE id = NEW.change_order_id
      FOR SHARE;
      IF proposal.id IS NULL
         OR work_order.id IS NULL
         OR proposal.task_id <> NEW.task_id
         OR proposal.universal_contract_version <> 1
         OR proposal.status <> 'APPROVED'
         OR proposal.change_order_kind <> 'PRICE_AND_SCOPE'
         OR proposal.financial_adjustment_required IS NOT TRUE
         OR proposal.approved_version_id IS DISTINCT FROM NEW.scope_version_id
         OR proposal.base_version_id IS DISTINCT FROM effective_work_order_scope_id
         OR proposal.proposed_customer_total_cents IS DISTINCT FROM NEW.amount_cents
         OR scope_record.customer_total_cents IS DISTINCT FROM NEW.amount_cents
         OR NOT EXISTS (
           SELECT 1 FROM public.task_scope_change_approvals approval
           WHERE approval.proposal_id = proposal.id
             AND approval.approver_role = 'CUSTOMER'
             AND approval.decision = 'APPROVED'
         )
         OR NOT EXISTS (
           SELECT 1 FROM public.task_scope_change_approvals approval
           WHERE approval.proposal_id = proposal.id
             AND approval.approver_role = 'PROVIDER'
             AND approval.decision = 'APPROVED'
         ) THEN
        RAISE EXCEPTION 'HXUV1-PFC-20: adjustment requires the exact dual-approved price-and-scope change'
          USING ERRCODE = 'P0001';
      END IF;
      NEW.change_order_version := proposal.proposal_version;
    ELSIF task_record.active_scope_version_id IS DISTINCT FROM NEW.scope_version_id THEN
      RAISE EXCEPTION 'HXUV1-PFC-21: non-adjustment finance requires the exact active task scope'
        USING ERRCODE = 'P0001';
    END IF;

    IF NEW.operation_kind = 'CAPTURE' THEN
      SELECT * INTO completion
      FROM public.task_completion_facts
      WHERE id = NEW.completion_fact_id
      FOR SHARE;
      IF completion.id IS NULL
         OR work_order.id IS NULL
         OR completion.work_order_id <> work_order.id
         OR completion.task_id <> NEW.task_id
         OR completion.scope_version_id <> NEW.scope_version_id
         OR completion.fact_kind <> 'APPROVED'
         OR completion.incident_gate <> 'CLEAR'
         OR completion.customer_notice_at IS NULL
         OR completion.delivery_event_id IS NULL
         OR completion.amount_approved_cents IS DISTINCT FROM NEW.amount_cents
         OR NEW.amount_cents > predecessor.amount_cents
         OR EXISTS (
           SELECT 1 FROM public.task_completion_facts newer
           WHERE newer.work_order_id = completion.work_order_id
             AND newer.completion_version > completion.completion_version
         )
         OR EXISTS (
           SELECT 1 FROM public.task_safety_incidents incident
           WHERE incident.task_id = NEW.task_id
             AND incident.status NOT IN ('resolved', 'closed')
         )
         OR (
           work_order.execution_contract_version = 1
           AND NOT EXISTS (
             SELECT 1
             FROM public.task_work_order_execution_facts execution
             WHERE execution.work_order_id = work_order.id
               AND execution.completion_fact_id = completion.id
               AND execution.state = 'COMPLETED'
               AND execution.transition_kind = 'COMPLETION_APPROVED'
               AND NOT EXISTS (
                 SELECT 1 FROM public.task_work_order_execution_facts newer_execution
                 WHERE newer_execution.work_order_id = work_order.id
                   AND newer_execution.execution_version > execution.execution_version
               )
           )
         ) THEN
        RAISE EXCEPTION 'HXUV1-PFC-22: capture requires exact current approved completion, execution, delivery, amount, and safety facts'
          USING ERRCODE = 'P0001';
      END IF;
      NEW.completion_version := completion.completion_version;
    END IF;

    IF NEW.operation_kind = 'REFUND' THEN
      SELECT amount_cents INTO captured_amount
      FROM public.task_financial_security_events event
      WHERE event.task_draft_id = NEW.task_draft_id
        AND event.task_id IS NOT DISTINCT FROM NEW.task_id
        AND event.eligibility_decision_id IS NOT DISTINCT FROM NEW.eligibility_decision_id
        AND event.scope_version_id IS NOT DISTINCT FROM NEW.scope_version_id
        AND event.event_kind = 'CAPTURED'
        AND event.status = 'SUCCEEDED'
        AND event.currency = NEW.currency
      ORDER BY event.expected_version DESC
      LIMIT 1;
      SELECT COALESCE(sum(event.amount_cents), 0) INTO refunded_amount
      FROM public.task_financial_security_events event
      WHERE event.task_draft_id = NEW.task_draft_id
        AND event.task_id IS NOT DISTINCT FROM NEW.task_id
        AND event.eligibility_decision_id IS NOT DISTINCT FROM NEW.eligibility_decision_id
        AND event.scope_version_id IS NOT DISTINCT FROM NEW.scope_version_id
        AND event.event_kind = 'REFUNDED'
        AND event.status = 'SUCCEEDED'
        AND event.currency = NEW.currency;
      IF captured_amount IS NULL OR refunded_amount + NEW.amount_cents > captured_amount THEN
        RAISE EXCEPTION 'HXUV1-PFC-23: prepared cumulative refunds cannot exceed successful capture'
          USING ERRCODE = 'P0001';
      END IF;
    END IF;

    NEW.eligibility_decision_version := eligibility.decision_version;
    NEW.eligibility_valid_until := eligibility.valid_until;
    NEW.scope_version := scope_record.version;
    NEW.scope_hash := scope_record.scope_hash;
  END IF;

  NEW.request_identity_sha256 := encode(public.hxos_universal_v1_sha256_bytes_v1(jsonb_build_object(
    'contract', 'HUSTLEXP_UNIVERSAL_V1_PREPARED_FINANCIAL_COMMAND_REQUEST_V1',
    'operationKind', NEW.operation_kind,
    'operationId', NEW.operation_id,
    'providerKind', NEW.provider_kind,
    'idempotencyKey', NEW.idempotency_key,
    'providerExpectedVersion', NEW.provider_expected_version,
    'lifecycleExpectedVersion', NEW.lifecycle_expected_version,
    'providerRequestSha256', NEW.provider_request_sha256,
    'taskDraftId', NEW.task_draft_id,
    'taskId', NEW.task_id,
    'eligibilityDecisionId', NEW.eligibility_decision_id,
    'scopeVersionId', NEW.scope_version_id,
    'changeOrderId', NEW.change_order_id,
    'predecessorEventId', NEW.predecessor_event_id,
    'completionFactId', NEW.completion_fact_id,
    'relatedOperationId', NEW.related_operation_id,
    'amountCents', NEW.amount_cents,
    'currency', NEW.currency,
    'recordedBy', NEW.recorded_by
  )::TEXT, 'sha256'), 'hex');
  NEW.authority_context_sha256 := encode(public.hxos_universal_v1_sha256_bytes_v1(jsonb_build_object(
    'contract', 'HUSTLEXP_UNIVERSAL_V1_PREPARED_FINANCIAL_COMMAND_AUTHORITY_V1',
    'requestIdentitySha256', NEW.request_identity_sha256,
    'eventKind', NEW.event_kind,
    'eligibilityDecisionVersion', NEW.eligibility_decision_version,
    'eligibilityValidUntil', NEW.eligibility_valid_until,
    'scopeVersion', NEW.scope_version,
    'scopeHash', NEW.scope_hash,
    'workOrderId', NEW.work_order_id,
    'workOrderMaterializationVersion', NEW.work_order_materialization_version,
    'workOrderExecutionContractVersion', NEW.work_order_execution_contract_version,
    'changeOrderVersion', NEW.change_order_version,
    'completionVersion', NEW.completion_version,
    'predecessorOperationId', NEW.predecessor_operation_id,
    'predecessorEventKind', NEW.predecessor_event_kind,
    'predecessorStatus', NEW.predecessor_status,
    'predecessorLifecycleVersion', NEW.predecessor_lifecycle_version,
    'databaseOccurredAt', NEW.occurred_at
  )::TEXT, 'sha256'), 'hex');
  RETURN NEW;
END;
$function$;

-- Exact installed sealed-prefix definition SHA-256: eeb0fe44bf86aad2429041a85a5f9a03dadb7b8d312cb2afcb3f56c4c182ff9a
CREATE OR REPLACE FUNCTION public.validate_universal_v1_fake_terminal_prepared_command()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  intent public.universal_v1_fake_terminal_lifecycle_intents%ROWTYPE;
  task_record public.tasks%ROWTYPE;
  work_order public.task_work_orders%ROWTYPE;
  eligibility public.task_provider_eligibility_decisions%ROWTYPE;
  starting_event public.task_financial_security_events%ROWTYPE;
  account_fact public.universal_v1_fake_provider_account_facts%ROWTYPE;
  account_onboard_event public.hxos_fake_financial_operation_events_v1%ROWTYPE;
  account_refresh_event public.hxos_fake_financial_operation_events_v1%ROWTYPE;
  operation_label TEXT;
  idempotency_suffix TEXT;
  expected_event_kind TEXT;
  expected_amount_cents BIGINT;
  expected_version_offset SMALLINT;
  expected_related_operation_id UUID;
  provider_account_reference TEXT;
  expected_provider_request TEXT;
  expected_provider_request_sha256 CHAR(64);
BEGIN
  IF NEW.operation_kind NOT IN (
       'CAPTURE', 'REFUND', 'SETTLE', 'FUND',
       'PROVIDER_RELEASE', 'PAYOUT', 'OBSERVE_BANK_SETTLEMENT'
     ) OR NEW.work_order_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO task_record
    FROM public.tasks
   WHERE id = NEW.task_id
   FOR SHARE;
  IF task_record.id IS NULL OR task_record.automation_classification <> 'CONTROLLED_TEST' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO intent
    FROM public.universal_v1_fake_terminal_lifecycle_intents
   WHERE work_order_id = NEW.work_order_id
   FOR SHARE;
  SELECT * INTO work_order
    FROM public.task_work_orders
   WHERE id = NEW.work_order_id
   FOR SHARE;
  SELECT * INTO eligibility
    FROM public.task_provider_eligibility_decisions
   WHERE id = NEW.eligibility_decision_id
   FOR SHARE;
  SELECT * INTO starting_event
    FROM public.task_financial_security_events
   WHERE id = intent.starting_financial_event_id
   FOR SHARE;
  IF intent.terminal_intent_id IS NULL
     OR work_order.id IS NULL
     OR eligibility.id IS NULL
     OR starting_event.id IS NULL THEN
    RAISE EXCEPTION 'HXUV1-FTL-40: controlled-test post-Work-Order provider preparation requires one exact terminal intent'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.operation_kind = 'CAPTURE' THEN
    operation_label := 'capture';
    idempotency_suffix := ':capture';
    expected_event_kind := 'CAPTURED';
    expected_amount_cents := intent.customer_amount_cents;
    expected_version_offset := 1;
    expected_related_operation_id := starting_event.operation_id;
  ELSIF intent.terminal_path = 'FULL_REFUND' AND NEW.operation_kind = 'REFUND' THEN
    operation_label := 'full-refund';
    idempotency_suffix := ':refund';
    expected_event_kind := 'REFUNDED';
    expected_amount_cents := intent.customer_amount_cents;
    expected_version_offset := 2;
    expected_related_operation_id := public.universal_v1_fake_terminal_operation_id_v1(
      intent.idempotency_key,
      'capture'
    );
  ELSIF intent.terminal_path = 'SETTLED' AND NEW.operation_kind = 'SETTLE' THEN
    operation_label := 'settle';
    idempotency_suffix := ':settle';
    expected_event_kind := 'SETTLEMENT_OBSERVED';
    expected_amount_cents := intent.customer_amount_cents;
    expected_version_offset := 2;
    expected_related_operation_id := public.universal_v1_fake_terminal_operation_id_v1(
      intent.idempotency_key,
      'capture'
    );
  ELSIF intent.terminal_path = 'SETTLED' AND NEW.operation_kind = 'FUND' THEN
    operation_label := 'fund';
    idempotency_suffix := ':fund';
    expected_event_kind := 'FUNDING_OBSERVED';
    expected_amount_cents := intent.customer_amount_cents;
    expected_version_offset := 3;
    expected_related_operation_id := public.universal_v1_fake_terminal_operation_id_v1(
      intent.idempotency_key,
      'settle'
    );
  ELSIF intent.terminal_path = 'SETTLED' AND NEW.operation_kind = 'PROVIDER_RELEASE' THEN
    operation_label := 'provider-release';
    idempotency_suffix := ':provider-release';
    expected_event_kind := 'PROVIDER_RELEASED';
    expected_amount_cents := intent.provider_amount_cents;
    expected_version_offset := 4;
    expected_related_operation_id := public.universal_v1_fake_terminal_operation_id_v1(
      intent.idempotency_key,
      'fund'
    );
  ELSIF intent.terminal_path = 'SETTLED' AND NEW.operation_kind = 'PAYOUT' THEN
    operation_label := 'payout';
    idempotency_suffix := ':payout';
    expected_event_kind := 'PAYOUT_OBSERVED';
    expected_amount_cents := intent.provider_amount_cents;
    expected_version_offset := 5;
    expected_related_operation_id := public.universal_v1_fake_terminal_operation_id_v1(
      intent.idempotency_key,
      'provider-release'
    );
  ELSIF intent.terminal_path = 'SETTLED'
        AND NEW.operation_kind = 'OBSERVE_BANK_SETTLEMENT' THEN
    operation_label := 'bank-settlement';
    idempotency_suffix := ':bank-settlement';
    expected_event_kind := 'BANK_SETTLEMENT_OBSERVED';
    expected_amount_cents := intent.provider_amount_cents;
    expected_version_offset := 6;
    expected_related_operation_id := public.universal_v1_fake_terminal_operation_id_v1(
      intent.idempotency_key,
      'payout'
    );
  ELSE
    RAISE EXCEPTION 'HXUV1-FTL-41: provider preparation is not a step in the immutable terminal path'
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (
       SELECT 1
         FROM public.universal_v1_fake_terminal_plan_v1(intent.terminal_path) plan
        WHERE plan.operation_kind = NEW.operation_kind
          AND plan.lifecycle_version_offset = expected_version_offset
     )
     OR NEW.provider_kind <> 'FAKE'
     OR NEW.provider_expected_version <> 0
     OR NEW.idempotency_key <> intent.idempotency_key || idempotency_suffix
     OR NEW.operation_id <> public.universal_v1_fake_terminal_operation_id_v1(
          intent.idempotency_key,
          operation_label
        )
     OR NEW.event_kind <> expected_event_kind
     OR NEW.task_draft_id <> intent.task_draft_id
     OR NEW.task_id <> intent.task_id
     OR NEW.eligibility_decision_id <> intent.eligibility_decision_id
     OR NEW.scope_version_id <> intent.scope_version_id
     OR NEW.work_order_id <> intent.work_order_id
     OR NEW.related_operation_id <> expected_related_operation_id
     OR NEW.lifecycle_expected_version <>
        intent.starting_financial_version + expected_version_offset
     OR NEW.amount_cents <> expected_amount_cents
     OR NEW.currency <> intent.currency
     OR NEW.recorded_by <> intent.requested_by
     OR (
       NEW.operation_kind = 'CAPTURE'
       AND NEW.completion_fact_id IS DISTINCT FROM intent.completion_fact_id
     )
     OR (
       NEW.operation_kind <> 'CAPTURE'
       AND NEW.completion_fact_id IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'HXUV1-FTL-41: provider preparation does not match the exact terminal step identity and authority'
      USING ERRCODE = 'P0001';
  END IF;

  IF intent.terminal_path = 'SETTLED' THEN
    PERFORM pg_advisory_xact_lock(
      hashtext('universal-v1-fake-provider-account-v1'),
      hashtext(intent.provider_subject_kind || ':' || intent.provider_subject_id::TEXT)
    );
    SELECT * INTO account_fact
      FROM public.universal_v1_fake_provider_account_facts
     WHERE provider_account_fact_id = intent.provider_account_fact_id
     FOR SHARE;
    SELECT * INTO account_onboard_event
      FROM public.hxos_fake_financial_operation_events_v1
     WHERE event_id = account_fact.onboard_fake_event_id
     FOR SHARE;
    SELECT * INTO account_refresh_event
      FROM public.hxos_fake_financial_operation_events_v1
     WHERE event_id = account_fact.refresh_fake_event_id
     FOR SHARE;
    provider_account_reference := account_onboard_event.external_reference;
    IF account_fact.provider_account_fact_id IS NULL
       OR account_fact.provider_subject_kind <> intent.provider_subject_kind
       OR COALESCE(account_fact.provider_user_id, account_fact.provider_organization_id)
          <> intent.provider_subject_id
       OR account_fact.account_state <> 'ENABLED'
       OR account_fact.charges_enabled IS NOT TRUE
       OR account_fact.payouts_enabled IS NOT TRUE
       OR provider_account_reference IS NULL
       OR encode(public.hxos_universal_v1_sha256_bytes_v1(provider_account_reference, 'sha256'), 'hex')
            IS DISTINCT FROM account_fact.provider_account_reference_sha256
       OR account_refresh_event.metadata->>'providerAccountReference'
            IS DISTINCT FROM provider_account_reference
       OR EXISTS (
         SELECT 1
           FROM public.universal_v1_fake_provider_account_facts newer
          WHERE newer.provider_subject_kind = account_fact.provider_subject_kind
            AND newer.provider_user_id IS NOT DISTINCT FROM account_fact.provider_user_id
            AND newer.provider_organization_id IS NOT DISTINCT FROM
                account_fact.provider_organization_id
            AND newer.account_version > account_fact.account_version
       )
       OR EXISTS (
         SELECT 1
           FROM public.task_safety_incidents incident
          WHERE incident.task_id = intent.task_id
            AND incident.status NOT IN ('resolved', 'closed')
       )
       OR public.universal_v1_invited_provider_authority_is_current(
            eligibility.provider_user_id,
            eligibility.provider_organization_id,
            eligibility.provider_class,
            eligibility.trade_credential_id,
            task_record.category,
            task_record.region_code
          ) IS NOT TRUE THEN
      RAISE EXCEPTION 'HXUV1-FTL-42: SETTLED preparation requires current incident, provider, and latest enabled account authority'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- The terminal plan fixes not just UUIDs and amounts but the exact bytes
  -- represented by provider_request_sha256. A caller cannot select a different
  -- deterministic scenario, related operation, or payout account reference
  -- while retaining the intent's operation identity.
  expected_provider_request :=
    '{"amountCents":' || expected_amount_cents::TEXT ||
    ',"currency":' || to_jsonb(lower(intent.currency::TEXT))::TEXT ||
    ',"expectedVersion":0' ||
    ',"idempotencyKey":' || to_jsonb(intent.idempotency_key || idempotency_suffix)::TEXT ||
    ',"operationId":' || to_jsonb(
      public.universal_v1_fake_terminal_operation_id_v1(
        intent.idempotency_key,
        operation_label
      )::TEXT
    )::TEXT ||
    CASE WHEN NEW.operation_kind = 'REFUND' THEN
      ',"originalAmountCents":' || intent.customer_amount_cents::TEXT
    ELSE '' END ||
    CASE WHEN NEW.operation_kind = 'PAYOUT' THEN
      ',"providerAccountReference":' || to_jsonb(provider_account_reference)::TEXT
    ELSE '' END ||
    ',"relatedOperationId":' || to_jsonb(expected_related_operation_id::TEXT)::TEXT ||
    ',"scenario":"SUCCESS"}';
  expected_provider_request_sha256 := encode(
    public.hxos_universal_v1_sha256_bytes_v1(expected_provider_request, 'sha256'),
    'hex'
  );
  IF NEW.provider_request_sha256 IS DISTINCT FROM expected_provider_request_sha256 THEN
    RAISE EXCEPTION 'HXUV1-FTL-45: terminal preparation request digest does not match the immutable intent step'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TABLE
  hx_authority.fake_financial_command_outbox_requests_v13 (
  outbox_request_id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  command_id UUID NOT NULL UNIQUE
    REFERENCES public.financial_provider_command_journal(command_id)
    ON DELETE RESTRICT,
  prepared_command_id UUID NOT NULL UNIQUE
    REFERENCES public.universal_v1_prepared_financial_commands(prepared_command_id)
    ON DELETE RESTRICT,
  target_authority_id UUID NOT NULL
    REFERENCES hx_authority.universal_v1_work_order_target_authority_facts(
      target_authority_id
    ) ON DELETE RESTRICT,
  target_authority_version INTEGER NOT NULL CHECK (target_authority_version > 0),
  target_database_name TEXT NOT NULL CHECK (
    target_database_name = pg_catalog.btrim(target_database_name)
    AND pg_catalog.char_length(target_database_name) BETWEEN 1 AND 63
  ),
  release_environment TEXT NOT NULL CHECK (
    release_environment IN ('local', 'preview', 'staging')
  ),
  release_manifest_digest TEXT NOT NULL CHECK (
    release_manifest_digest ~ '^sha256:[0-9a-f]{64}$'
    AND release_manifest_digest <> 'sha256:' || pg_catalog.repeat('0', 64)
  ),
  release_id TEXT NOT NULL CHECK (
    release_id ~ '^[a-z0-9][a-z0-9._-]{7,127}$'
  ),
  release_revision CHAR(40) NOT NULL CHECK (
    release_revision ~ '^[0-9a-f]{40}$'
    AND release_revision <> pg_catalog.repeat('0', 40)
  ),
  provider_kind TEXT NOT NULL DEFAULT 'FAKE' CHECK (provider_kind = 'FAKE'),
  prepared_state TEXT NOT NULL DEFAULT 'PREPARED' CHECK (
    prepared_state = 'PREPARED'
  ),
  command_state TEXT NOT NULL DEFAULT 'REQUESTED' CHECK (
    command_state = 'REQUESTED'
  ),
  operation_kind TEXT NOT NULL CHECK (operation_kind IN (
    'PREPARE_PAYMENT_METHOD', 'AUTHORIZE', 'SECURE', 'VOID', 'ADJUST',
    'CAPTURE', 'REFUND', 'REVERSAL', 'SETTLE', 'FUND',
    'PROVIDER_RELEASE', 'PAYOUT', 'OBSERVE_BANK_SETTLEMENT'
  )),
  operation_id UUID NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (
    idempotency_key ~ '^[A-Za-z0-9:_-]{16,128}$'
  ),
  provider_expected_version BIGINT NOT NULL CHECK (
    provider_expected_version BETWEEN 0 AND 9007199254740991
  ),
  provider_request_sha256 CHAR(64) NOT NULL CHECK (
    provider_request_sha256 ~ '^[0-9a-f]{64}$'
  ),
  command_identity_sha256 CHAR(64) NOT NULL CHECK (
    command_identity_sha256 ~ '^[0-9a-f]{64}$'
  ),
  prepared_authority_sha256 CHAR(64) NOT NULL CHECK (
    prepared_authority_sha256 ~ '^[0-9a-f]{64}$'
  ),
  queue_name TEXT NOT NULL DEFAULT 'synthetic_finance' CHECK (
    queue_name = 'synthetic_finance'
  ),
  job_name TEXT NOT NULL DEFAULT 'synthetic_finance.command.v13' CHECK (
    job_name = 'synthetic_finance.command.v13'
  ),
  payload_contract_version SMALLINT NOT NULL DEFAULT 1 CHECK (
    payload_contract_version = 1
  ),
  job_authority_sha256 CHAR(64) NOT NULL UNIQUE CHECK (
    job_authority_sha256 ~ '^[0-9a-f]{64}$'
  ),
  bullmq_job_id TEXT NOT NULL UNIQUE CHECK (
    bullmq_job_id ~ '^hx-fake-fin-[0-9a-f]{32}-[0-9a-f]{64}$'
  ),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  positive_money_capability BOOLEAN NOT NULL DEFAULT FALSE CHECK (
    positive_money_capability IS FALSE
  ),
  production_capability BOOLEAN NOT NULL DEFAULT FALSE CHECK (
    production_capability IS FALSE
  ),
  CONSTRAINT fake_finance_outbox_request_command_pair_v13_uniq
    UNIQUE (outbox_request_id, command_id),
  CONSTRAINT fake_finance_outbox_request_target_pair_v13_uniq
    UNIQUE (outbox_request_id, target_authority_id)
);

CREATE TABLE
  hx_authority.fake_financial_outbox_publish_claims_v13 (
  publish_claim_id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  outbox_request_id UUID NOT NULL
    REFERENCES hx_authority.fake_financial_command_outbox_requests_v13(
      outbox_request_id
    ) ON DELETE RESTRICT,
  claim_number INTEGER NOT NULL CHECK (claim_number BETWEEN 1 AND 64),
  publisher_instance_id UUID NOT NULL,
  lease_duration_seconds INTEGER NOT NULL CHECK (
    lease_duration_seconds BETWEEN 1 AND 300
  ),
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  lease_expires_at TIMESTAMPTZ NOT NULL,
  claim_identity_sha256 CHAR(64) NOT NULL UNIQUE CHECK (
    claim_identity_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT fake_finance_publish_claim_number_v13_uniq
    UNIQUE (outbox_request_id, claim_number),
  CONSTRAINT fake_finance_publish_claim_request_v13_uniq
    UNIQUE (publish_claim_id, outbox_request_id),
  CONSTRAINT fake_finance_publish_claim_window_v13_chk CHECK (
    lease_expires_at = claimed_at
      + pg_catalog.make_interval(secs => lease_duration_seconds)
  )
);

CREATE TABLE
  hx_authority.fake_financial_outbox_publish_outcomes_v13 (
  publish_outcome_id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  recording_transaction_id XID8 NOT NULL DEFAULT pg_catalog.pg_current_xact_id(),
  publish_claim_id UUID NOT NULL,
  outbox_request_id UUID NOT NULL,
  outcome_kind TEXT NOT NULL CHECK (outcome_kind IN (
    'BULLMQ_CONFIRMED', 'RETRYABLE_FAILURE', 'TERMINAL_FAILURE'
  )),
  observed_bullmq_job_id TEXT,
  observed_job_authority_sha256 CHAR(64),
  failure_code TEXT CHECK (
    failure_code IS NULL OR failure_code ~ '^[A-Z][A-Z0-9_.:-]{2,63}$'
  ),
  retry_delay_seconds INTEGER CHECK (
    retry_delay_seconds IS NULL OR retry_delay_seconds BETWEEN 1 AND 86400
  ),
  retry_not_before TIMESTAMPTZ,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  outcome_identity_sha256 CHAR(64) NOT NULL UNIQUE CHECK (
    outcome_identity_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT fake_finance_publish_outcome_claim_v13_uniq UNIQUE (publish_claim_id),
  CONSTRAINT fake_finance_publish_outcome_claim_v13_fk
    FOREIGN KEY (publish_claim_id, outbox_request_id)
    REFERENCES hx_authority.fake_financial_outbox_publish_claims_v13(
      publish_claim_id, outbox_request_id
    ) ON DELETE RESTRICT,
  CONSTRAINT fake_finance_publish_outcome_bundle_v13_chk CHECK (
    (
      outcome_kind = 'BULLMQ_CONFIRMED'
      AND observed_bullmq_job_id IS NOT NULL
      AND observed_job_authority_sha256 IS NOT NULL
      AND failure_code IS NULL
      AND retry_delay_seconds IS NULL
      AND retry_not_before IS NULL
    ) OR (
      outcome_kind = 'RETRYABLE_FAILURE'
      AND observed_bullmq_job_id IS NULL
      AND observed_job_authority_sha256 IS NULL
      AND failure_code IS NOT NULL
      AND retry_delay_seconds IS NOT NULL
      AND retry_not_before IS NOT NULL
    ) OR (
      outcome_kind = 'TERMINAL_FAILURE'
      AND observed_bullmq_job_id IS NULL
      AND observed_job_authority_sha256 IS NULL
      AND failure_code IS NOT NULL
      AND retry_delay_seconds IS NULL
      AND retry_not_before IS NULL
    )
  ),
  CONSTRAINT fake_finance_publish_outcome_retry_window_v13_chk CHECK (
    (retry_delay_seconds IS NULL AND retry_not_before IS NULL)
    OR retry_not_before = recorded_at
      + pg_catalog.make_interval(secs => retry_delay_seconds)
  )
);

-- A publisher retry limit is transport evidence, not a provider outcome.
-- Preserve any prior dispatch for reconciliation while denying new admissions.
CREATE TABLE hx_authority.fake_financial_publish_exhaustions_v13 (
  publish_exhaustion_id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  outbox_request_id UUID NOT NULL UNIQUE,
  final_publish_claim_id UUID NOT NULL UNIQUE,
  final_claim_number INTEGER NOT NULL DEFAULT 64 CHECK (final_claim_number = 64),
  reason TEXT NOT NULL DEFAULT 'PUBLISH_RETRY_EXHAUSTED' CHECK (
    reason = 'PUBLISH_RETRY_EXHAUSTED'
  ),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  exhaustion_identity_sha256 CHAR(64) NOT NULL UNIQUE CHECK (
    exhaustion_identity_sha256 ~ '^[0-9a-f]{64}$'
  ),
  reconciliation_required BOOLEAN NOT NULL DEFAULT TRUE CHECK (reconciliation_required IS TRUE),
  dispatch_authorized BOOLEAN NOT NULL DEFAULT FALSE CHECK (dispatch_authorized IS FALSE),
  provider_execution_capability BOOLEAN NOT NULL DEFAULT FALSE CHECK (provider_execution_capability IS FALSE),
  positive_money_capability BOOLEAN NOT NULL DEFAULT FALSE CHECK (positive_money_capability IS FALSE),
  production_capability BOOLEAN NOT NULL DEFAULT FALSE CHECK (production_capability IS FALSE),
  CONSTRAINT fake_finance_publish_exhaustion_claim_v13_fk
    FOREIGN KEY (final_publish_claim_id, outbox_request_id)
    REFERENCES hx_authority.fake_financial_outbox_publish_claims_v13(
      publish_claim_id, outbox_request_id
    ) ON DELETE RESTRICT
);

CREATE TABLE
  hx_authority.fake_financial_outbox_dispositions_v13 (
  outbox_disposition_id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  outbox_request_id UUID NOT NULL UNIQUE
    REFERENCES hx_authority.fake_financial_command_outbox_requests_v13(
      outbox_request_id
    ) ON DELETE RESTRICT,
  disposition_kind TEXT NOT NULL DEFAULT 'TARGET_SUPERSEDED' CHECK (
    disposition_kind = 'TARGET_SUPERSEDED'
  ),
  superseded_target_authority_id UUID NOT NULL,
  replacement_target_authority_id UUID NOT NULL,
  replacement_target_authority_version INTEGER NOT NULL CHECK (
    replacement_target_authority_version > 0
  ),
  replacement_database_name TEXT NOT NULL CHECK (
    replacement_database_name = pg_catalog.btrim(replacement_database_name)
    AND pg_catalog.char_length(replacement_database_name) BETWEEN 1 AND 63
  ),
  replacement_environment TEXT NOT NULL CHECK (
    replacement_environment IN ('local', 'preview', 'staging')
  ),
  replacement_manifest_digest TEXT NOT NULL CHECK (
    replacement_manifest_digest ~ '^sha256:[0-9a-f]{64}$'
  ),
  disposed_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  disposition_identity_sha256 CHAR(64) NOT NULL UNIQUE CHECK (
    disposition_identity_sha256 ~ '^[0-9a-f]{64}$'
  ),
  dispatch_authorized BOOLEAN NOT NULL DEFAULT FALSE CHECK (
    dispatch_authorized IS FALSE
  ),
  provider_execution_capability BOOLEAN NOT NULL DEFAULT FALSE CHECK (
    provider_execution_capability IS FALSE
  ),
  positive_money_capability BOOLEAN NOT NULL DEFAULT FALSE CHECK (
    positive_money_capability IS FALSE
  ),
  production_capability BOOLEAN NOT NULL DEFAULT FALSE CHECK (
    production_capability IS FALSE
  ),
  CONSTRAINT fake_finance_outbox_disposition_superseded_target_v13_fk
    FOREIGN KEY (superseded_target_authority_id)
    REFERENCES hx_authority.universal_v1_work_order_target_authority_facts(
      target_authority_id
    ) ON DELETE RESTRICT,
  CONSTRAINT fake_finance_outbox_disposition_replacement_target_v13_fk
    FOREIGN KEY (replacement_target_authority_id)
    REFERENCES hx_authority.universal_v1_work_order_target_authority_facts(
      target_authority_id
    ) ON DELETE RESTRICT,
  CONSTRAINT fake_finance_outbox_disposition_target_change_v13_chk CHECK (
    superseded_target_authority_id <> replacement_target_authority_id
  )
);

CREATE TABLE
  hx_authority.fake_financial_dispatch_admissions_v13 (
  dispatch_admission_id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  outbox_request_id UUID NOT NULL,
  command_id UUID NOT NULL,
  admission_number INTEGER NOT NULL CHECK (admission_number BETWEEN 1 AND 64),
  bullmq_job_id TEXT NOT NULL CHECK (
    bullmq_job_id ~ '^hx-fake-fin-[0-9a-f]{32}-[0-9a-f]{64}$'
  ),
  job_authority_sha256 CHAR(64) NOT NULL CHECK (
    job_authority_sha256 ~ '^[0-9a-f]{64}$'
  ),
  worker_instance_id UUID NOT NULL,
  bullmq_attempt_number INTEGER NOT NULL CHECK (
    bullmq_attempt_number BETWEEN 0 AND 64
  ),
  recovery_lease_id UUID NOT NULL UNIQUE,
  admitted_transaction_id BIGINT NOT NULL CHECK (admitted_transaction_id > 0),
  admitted_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  admission_identity_sha256 CHAR(64) NOT NULL UNIQUE CHECK (
    admission_identity_sha256 ~ '^[0-9a-f]{64}$'
  ),
  provider_execution_capability BOOLEAN NOT NULL DEFAULT FALSE CHECK (
    provider_execution_capability IS FALSE
  ),
  positive_money_capability BOOLEAN NOT NULL DEFAULT FALSE CHECK (
    positive_money_capability IS FALSE
  ),
  production_capability BOOLEAN NOT NULL DEFAULT FALSE CHECK (
    production_capability IS FALSE
  ),
  CONSTRAINT fake_finance_dispatch_admission_number_v13_uniq
    UNIQUE (outbox_request_id, admission_number),
  CONSTRAINT fake_finance_dispatch_admission_request_command_v13_fk
    FOREIGN KEY (outbox_request_id, command_id)
    REFERENCES hx_authority.fake_financial_command_outbox_requests_v13(
      outbox_request_id, command_id
    ) ON DELETE RESTRICT,
  CONSTRAINT fake_finance_dispatch_admission_command_pair_v13_uniq
    UNIQUE (command_id, dispatch_admission_id),
  CONSTRAINT fake_finance_dispatch_admission_recovery_pair_v13_uniq
    UNIQUE (command_id, recovery_lease_id)
);

CREATE TABLE
  hx_authority.fake_financial_job_validations_v13 (
  job_validation_id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  outbox_request_id UUID NOT NULL,
  command_id UUID NOT NULL,
  validation_number INTEGER NOT NULL CHECK (validation_number BETWEEN 1 AND 64),
  bullmq_job_id TEXT NOT NULL CHECK (
    bullmq_job_id ~ '^hx-fake-fin-[0-9a-f]{32}-[0-9a-f]{64}$'
  ),
  job_authority_sha256 CHAR(64) NOT NULL CHECK (
    job_authority_sha256 ~ '^[0-9a-f]{64}$'
  ),
  worker_instance_id UUID NOT NULL,
  bullmq_attempt_number INTEGER NOT NULL CHECK (
    bullmq_attempt_number BETWEEN 0 AND 64
  ),
  dispatch_admission_id UUID NOT NULL UNIQUE,
  recovery_lease_id UUID NOT NULL UNIQUE,
  dispatch_attempt_id UUID NOT NULL UNIQUE,
  validated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  validation_identity_sha256 CHAR(64) NOT NULL UNIQUE CHECK (
    validation_identity_sha256 ~ '^[0-9a-f]{64}$'
  ),
  provider_execution_capability BOOLEAN NOT NULL DEFAULT FALSE CHECK (
    provider_execution_capability IS FALSE
  ),
  positive_money_capability BOOLEAN NOT NULL DEFAULT FALSE CHECK (
    positive_money_capability IS FALSE
  ),
  production_capability BOOLEAN NOT NULL DEFAULT FALSE CHECK (
    production_capability IS FALSE
  ),
  CONSTRAINT fake_finance_job_validation_number_v13_uniq
    UNIQUE (outbox_request_id, validation_number),
  CONSTRAINT fake_finance_job_validation_request_command_v13_fk
    FOREIGN KEY (outbox_request_id, command_id)
    REFERENCES hx_authority.fake_financial_command_outbox_requests_v13(
      outbox_request_id, command_id
    ) ON DELETE RESTRICT,
  CONSTRAINT fake_finance_job_validation_admission_v13_fk
    FOREIGN KEY (command_id, dispatch_admission_id)
    REFERENCES hx_authority.fake_financial_dispatch_admissions_v13(
      command_id, dispatch_admission_id
    ) ON DELETE RESTRICT,
  CONSTRAINT fake_finance_job_validation_recovery_v13_fk
    FOREIGN KEY (command_id, recovery_lease_id)
    REFERENCES public.financial_provider_command_recovery_leases(
      command_id, recovery_lease_id
    ) ON DELETE RESTRICT,
  CONSTRAINT fake_finance_job_validation_dispatch_v13_fk
    FOREIGN KEY (command_id, dispatch_attempt_id)
    REFERENCES public.financial_provider_command_dispatch_attempts(
      command_id, dispatch_attempt_id
    ) ON DELETE RESTRICT
);

CREATE TABLE
  hx_authority.fake_financial_webhook_inert_evidence_v13 (
  inert_evidence_id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  observation_id UUID NOT NULL
    REFERENCES public.provider_event_inbox_observations(observation_id)
    ON DELETE RESTRICT,
  receipt_id UUID NOT NULL UNIQUE
    REFERENCES public.provider_event_inbox_receipts(receipt_id)
    ON DELETE RESTRICT,
  operation_id UUID NOT NULL,
  provider_kind TEXT NOT NULL DEFAULT 'FAKE' CHECK (provider_kind = 'FAKE'),
  provider_event_kind TEXT NOT NULL CHECK (
    pg_catalog.char_length(provider_event_kind) BETWEEN 1 AND 255
    AND provider_event_kind = pg_catalog.btrim(provider_event_kind)
  ),
  provider_event_reference_sha256 CHAR(64) NOT NULL CHECK (
    provider_event_reference_sha256 ~ '^[0-9a-f]{64}$'
  ),
  raw_payload_sha256 CHAR(64) NOT NULL CHECK (
    raw_payload_sha256 ~ '^[0-9a-f]{64}$'
  ),
  authentication_evidence_sha256 CHAR(64) NOT NULL CHECK (
    authentication_evidence_sha256 ~ '^[0-9a-f]{64}$'
  ),
  evidence_state TEXT NOT NULL DEFAULT 'INERT_WEBHOOK_EVIDENCE' CHECK (
    evidence_state = 'INERT_WEBHOOK_EVIDENCE'
  ),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  outbox_dispatch_authorized BOOLEAN NOT NULL DEFAULT FALSE CHECK (
    outbox_dispatch_authorized IS FALSE
  ),
  lifecycle_transition_authorized BOOLEAN NOT NULL DEFAULT FALSE CHECK (
    lifecycle_transition_authorized IS FALSE
  ),
  positive_money_capability BOOLEAN NOT NULL DEFAULT FALSE CHECK (
    positive_money_capability IS FALSE
  ),
  CONSTRAINT fake_finance_webhook_inert_observation_receipt_v13_uniq
    UNIQUE (observation_id, receipt_id)
);

CREATE TABLE
  hx_authority.fake_financial_webhook_rejection_receipts_v13 (
  rejection_receipt_id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  observation_id UUID NOT NULL
    REFERENCES public.provider_event_inbox_observations(observation_id)
    ON DELETE RESTRICT,
  operation_id UUID NOT NULL,
  provider_kind TEXT NOT NULL DEFAULT 'FAKE' CHECK (provider_kind = 'FAKE'),
  provider_event_kind TEXT NOT NULL CHECK (
    pg_catalog.char_length(provider_event_kind) BETWEEN 1 AND 255
    AND provider_event_kind = pg_catalog.btrim(provider_event_kind)
  ),
  provider_event_reference_sha256 CHAR(64) NOT NULL CHECK (
    provider_event_reference_sha256 ~ '^[0-9a-f]{64}$'
  ),
  raw_payload_sha256 CHAR(64) NOT NULL CHECK (
    raw_payload_sha256 ~ '^[0-9a-f]{64}$'
  ),
  ingress_idempotency_sha256 CHAR(64) NOT NULL CHECK (
    ingress_idempotency_sha256 ~ '^[0-9a-f]{64}$'
  ),
  request_sha256 CHAR(64) NOT NULL CHECK (
    request_sha256 ~ '^[0-9a-f]{64}$'
  ),
  authentication_scheme TEXT NOT NULL CHECK (
    authentication_scheme ~ '^[A-Z][A-Z0-9_-]{1,63}$'
  ),
  authentication_evidence_sha256 CHAR(64) NOT NULL CHECK (
    authentication_evidence_sha256 ~ '^[0-9a-f]{64}$'
  ),
  rejection_reason_code TEXT NOT NULL CHECK (
    rejection_reason_code ~ '^[A-Z][A-Z0-9_.:-]{2,63}$'
  ),
  receipt_state TEXT NOT NULL DEFAULT 'UNAUTHENTICATED_REJECTED' CHECK (
    receipt_state = 'UNAUTHENTICATED_REJECTED'
  ),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  rejection_identity_sha256 CHAR(64) NOT NULL UNIQUE CHECK (
    rejection_identity_sha256 ~ '^[0-9a-f]{64}$'
  ),
  outbox_dispatch_authorized BOOLEAN NOT NULL DEFAULT FALSE CHECK (
    outbox_dispatch_authorized IS FALSE
  ),
  lifecycle_transition_authorized BOOLEAN NOT NULL DEFAULT FALSE CHECK (
    lifecycle_transition_authorized IS FALSE
  ),
  provider_execution_capability BOOLEAN NOT NULL DEFAULT FALSE CHECK (
    provider_execution_capability IS FALSE
  ),
  positive_money_capability BOOLEAN NOT NULL DEFAULT FALSE CHECK (
    positive_money_capability IS FALSE
  ),
  production_capability BOOLEAN NOT NULL DEFAULT FALSE CHECK (
    production_capability IS FALSE
  ),
  CONSTRAINT fake_finance_webhook_rejection_identity_v13_uniq UNIQUE (
    observation_id, ingress_idempotency_sha256, request_sha256
  )
);

-- Collision rejection is intentional. The migration ledger owns replay, and a
-- pre-created relation must never be normalized into trusted v13 evidence.
CREATE TABLE public.hxos_fake_financial_schema_evidence_v13 (
  migration_name TEXT PRIMARY KEY CHECK (
    migration_name =
      '20261016_universal_v1_fake_financial_command_outbox_authority_v13'
  ),
  migration_sql_sha256 CHAR(64) NOT NULL CHECK (
    migration_sql_sha256 ~ '^[0-9a-f]{64}$'
    AND migration_sql_sha256 <> pg_catalog.repeat('0', 64)
  ),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

CREATE INDEX fake_finance_outbox_request_due_v13_idx
  ON hx_authority.fake_financial_command_outbox_requests_v13(
    requested_at, outbox_request_id
  );
CREATE INDEX fake_finance_publish_claim_expiry_v13_idx
  ON hx_authority.fake_financial_outbox_publish_claims_v13(
    outbox_request_id, lease_expires_at, claim_number
  );
CREATE INDEX fake_finance_publish_retry_v13_idx
  ON hx_authority.fake_financial_outbox_publish_outcomes_v13(
    outbox_request_id, retry_not_before
  ) WHERE outcome_kind = 'RETRYABLE_FAILURE';
CREATE INDEX fake_finance_outbox_disposition_replacement_v13_idx
  ON hx_authority.fake_financial_outbox_dispositions_v13(
    replacement_target_authority_id, disposed_at
  );
CREATE INDEX fake_finance_dispatch_admission_command_v13_idx
  ON hx_authority.fake_financial_dispatch_admissions_v13(
    command_id, admission_number
  );
CREATE INDEX fake_finance_job_validation_command_v13_idx
  ON hx_authority.fake_financial_job_validations_v13(
    command_id, validation_number
  );
CREATE INDEX fake_finance_webhook_inert_operation_v13_idx
  ON hx_authority.fake_financial_webhook_inert_evidence_v13(
    operation_id, recorded_at
  );
CREATE INDEX fake_finance_webhook_rejection_operation_v13_idx
  ON hx_authority.fake_financial_webhook_rejection_receipts_v13(
    operation_id, recorded_at
  );

CREATE OR REPLACE FUNCTION hx_authority.reject_fake_financial_outbox_mutation_v13()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION
    'HXUV1-FINOUT-13-3: fake-financial outbox authority facts are append-only'
    USING ERRCODE = 'P0001';
END;
$$;

CREATE TRIGGER fake_finance_outbox_request_append_only_v13
BEFORE UPDATE OR DELETE
ON hx_authority.fake_financial_command_outbox_requests_v13
FOR EACH ROW
EXECUTE FUNCTION hx_authority.reject_fake_financial_outbox_mutation_v13();
CREATE TRIGGER fake_finance_outbox_request_no_truncate_v13
BEFORE TRUNCATE
ON hx_authority.fake_financial_command_outbox_requests_v13
FOR EACH STATEMENT
EXECUTE FUNCTION hx_authority.reject_fake_financial_outbox_mutation_v13();

CREATE TRIGGER fake_finance_publish_claim_append_only_v13
BEFORE UPDATE OR DELETE
ON hx_authority.fake_financial_outbox_publish_claims_v13
FOR EACH ROW
EXECUTE FUNCTION hx_authority.reject_fake_financial_outbox_mutation_v13();
CREATE TRIGGER fake_finance_publish_claim_no_truncate_v13
BEFORE TRUNCATE
ON hx_authority.fake_financial_outbox_publish_claims_v13
FOR EACH STATEMENT
EXECUTE FUNCTION hx_authority.reject_fake_financial_outbox_mutation_v13();

CREATE TRIGGER fake_finance_publish_outcome_append_only_v13
BEFORE UPDATE OR DELETE
ON hx_authority.fake_financial_outbox_publish_outcomes_v13
FOR EACH ROW
EXECUTE FUNCTION hx_authority.reject_fake_financial_outbox_mutation_v13();
CREATE TRIGGER fake_finance_publish_outcome_no_truncate_v13
BEFORE TRUNCATE
ON hx_authority.fake_financial_outbox_publish_outcomes_v13
FOR EACH STATEMENT
EXECUTE FUNCTION hx_authority.reject_fake_financial_outbox_mutation_v13();

CREATE TRIGGER fake_finance_outbox_disposition_append_only_v13
BEFORE UPDATE OR DELETE
ON hx_authority.fake_financial_outbox_dispositions_v13
FOR EACH ROW
EXECUTE FUNCTION hx_authority.reject_fake_financial_outbox_mutation_v13();
CREATE TRIGGER fake_finance_outbox_disposition_no_truncate_v13
BEFORE TRUNCATE
ON hx_authority.fake_financial_outbox_dispositions_v13
FOR EACH STATEMENT
EXECUTE FUNCTION hx_authority.reject_fake_financial_outbox_mutation_v13();

CREATE TRIGGER fake_finance_dispatch_admission_append_only_v13
BEFORE UPDATE OR DELETE
ON hx_authority.fake_financial_dispatch_admissions_v13
FOR EACH ROW
EXECUTE FUNCTION hx_authority.reject_fake_financial_outbox_mutation_v13();
CREATE TRIGGER fake_finance_dispatch_admission_no_truncate_v13
BEFORE TRUNCATE
ON hx_authority.fake_financial_dispatch_admissions_v13
FOR EACH STATEMENT
EXECUTE FUNCTION hx_authority.reject_fake_financial_outbox_mutation_v13();

CREATE TRIGGER fake_finance_job_validation_append_only_v13
BEFORE UPDATE OR DELETE
ON hx_authority.fake_financial_job_validations_v13
FOR EACH ROW
EXECUTE FUNCTION hx_authority.reject_fake_financial_outbox_mutation_v13();
CREATE TRIGGER fake_finance_job_validation_no_truncate_v13
BEFORE TRUNCATE
ON hx_authority.fake_financial_job_validations_v13
FOR EACH STATEMENT
EXECUTE FUNCTION hx_authority.reject_fake_financial_outbox_mutation_v13();

CREATE TRIGGER fake_finance_webhook_inert_append_only_v13
BEFORE UPDATE OR DELETE
ON hx_authority.fake_financial_webhook_inert_evidence_v13
FOR EACH ROW
EXECUTE FUNCTION hx_authority.reject_fake_financial_outbox_mutation_v13();
CREATE TRIGGER fake_finance_webhook_inert_no_truncate_v13
BEFORE TRUNCATE
ON hx_authority.fake_financial_webhook_inert_evidence_v13
FOR EACH STATEMENT
EXECUTE FUNCTION hx_authority.reject_fake_financial_outbox_mutation_v13();

CREATE TRIGGER fake_finance_webhook_rejection_append_only_v13
BEFORE UPDATE OR DELETE
ON hx_authority.fake_financial_webhook_rejection_receipts_v13
FOR EACH ROW
EXECUTE FUNCTION hx_authority.reject_fake_financial_outbox_mutation_v13();
CREATE TRIGGER fake_finance_webhook_rejection_no_truncate_v13
BEFORE TRUNCATE
ON hx_authority.fake_financial_webhook_rejection_receipts_v13
FOR EACH STATEMENT
EXECUTE FUNCTION hx_authority.reject_fake_financial_outbox_mutation_v13();

CREATE TRIGGER fake_finance_schema_evidence_append_only_v13
BEFORE UPDATE OR DELETE ON public.hxos_fake_financial_schema_evidence_v13
FOR EACH ROW
EXECUTE FUNCTION hx_authority.reject_fake_financial_outbox_mutation_v13();
CREATE TRIGGER fake_finance_schema_evidence_no_truncate_v13
BEFORE TRUNCATE ON public.hxos_fake_financial_schema_evidence_v13
FOR EACH STATEMENT
EXECUTE FUNCTION hx_authority.reject_fake_financial_outbox_mutation_v13();

-- Additive read-only certification: preserve the frozen seal port, close its
-- ledger chain, and return the v13 receipt for comparison with packaged bytes.
-- The runtime holds the target activation barrier before taking its snapshot.
-- This port takes no advisory/row locks and writes no evidence or capabilities.

-- Restart readback returns previously committed outcome identity as well as raw
-- provider evidence. A missing outcome is absence, never confirmed no effect.
-- The exact recording port below is used only in its existing-row replay branch.
CREATE OR REPLACE FUNCTION public.hxos_read_fake_financial_progress_v13(
  p_outbox_request_id UUID, p_bullmq_job_id TEXT, p_job_authority_sha256 TEXT
)
RETURNS TABLE (recovery_evidence JSONB, recorded_outcome JSONB)
LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
DECLARE
  recovered RECORD;
  replayed RECORD;
  recorded public.financial_provider_command_outcome_facts%ROWTYPE;
  recording_lease public.financial_provider_command_recovery_leases%ROWTYPE;
  command_uuid UUID;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'HXUV1-FINPROGRESS-13-READ_COMMITTED_REQUIRED';
  END IF;
  SELECT * INTO recovered FROM public.hxos_read_fake_financial_recovery_evidence_v13(
    p_outbox_request_id,p_bullmq_job_id,p_job_authority_sha256
  );
  command_uuid := (recovered.request_evidence ->> 'command_id')::UUID;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('financial-provider-command-recovery-v1'),pg_catalog.hashtext(command_uuid::TEXT)
  );
  -- Refresh under the same command lock as admission, execution and outcomes.
  SELECT * INTO recovered FROM public.hxos_read_fake_financial_recovery_evidence_v13(
    p_outbox_request_id,p_bullmq_job_id,p_job_authority_sha256
  );
  IF recovered.admission_evidence IS NULL THEN
    RETURN QUERY SELECT pg_catalog.to_jsonb(recovered),NULL::JSONB;
    RETURN;
  END IF;
  SELECT outcome.* INTO recorded FROM public.financial_provider_command_outcome_facts outcome
   WHERE outcome.command_id = command_uuid
     AND outcome.dispatch_attempt_id = (recovered.admission_evidence ->> 'dispatch_attempt_id')::UUID
   ORDER BY outcome.recorded_at DESC,outcome.outcome_fact_id DESC LIMIT 1;
  IF recorded.outcome_fact_id IS NULL THEN
    RETURN QUERY SELECT pg_catalog.to_jsonb(recovered),NULL::JSONB;
    RETURN;
  END IF;
  IF recorded.recording_transaction_id IS NULL
     OR recorded.recording_transaction_id = pg_catalog.pg_current_xact_id_if_assigned() THEN
    RAISE EXCEPTION 'HXUV1-FINPROGRESS-13-COMMITTED_OUTCOME_REQUIRED';
  END IF;
  SELECT lease.* INTO recording_lease FROM public.financial_provider_command_recovery_leases lease
   WHERE lease.recovery_lease_id = recorded.recovery_lease_id;
  IF recording_lease.command_id IS DISTINCT FROM command_uuid
     OR recorded.observation_idempotency_key IS DISTINCT FROM
          'finance-outcome-v13:' || recording_lease.recovery_lease_id::TEXT THEN
    RAISE EXCEPTION 'HXUV1-FINPROGRESS-13-RECORDING_BINDING_MISMATCH';
  END IF;
  -- Identity is taken exclusively from immutable stored rows. Historical lease
  -- expiry does not prevent exact replay and no new lease is acquired here.
  SELECT * INTO replayed FROM public.hxos_record_fake_financial_outcome_v13(
    (recovered.admission_evidence ->> 'job_validation_id')::UUID,
    recording_lease.lease_owner_id,recording_lease.recovery_lease_id
  );
  IF replayed.idempotency_replayed IS DISTINCT FROM TRUE
     OR replayed.outcome_fact IS DISTINCT FROM pg_catalog.to_jsonb(recorded) - ARRAY['recording_transaction_id','resolution_observation_id','resolution_receipt_id','resolution_contract_version']::TEXT[]
     OR replayed.admission_evidence IS DISTINCT FROM recovered.admission_evidence THEN
    RAISE EXCEPTION 'HXUV1-FINPROGRESS-13-RECORDED_OUTCOME_MISMATCH';
  END IF;
  RETURN QUERY SELECT pg_catalog.to_jsonb(recovered),pg_catalog.to_jsonb(replayed);
END;
$$;
REVOKE ALL ON FUNCTION public.hxos_read_fake_financial_progress_v13(uuid,text,text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.hxos_read_universal_v1_fake_financial_runtime_authority_v13()
RETURNS TABLE (
  session_database_role TEXT,
  target_authority_id UUID,
  authority_version INTEGER,
  target_database_name TEXT,
  environment TEXT,
  release_manifest_sha256 TEXT,
  ordinal146_sql_sha256 TEXT,
  v12_sql_sha256 TEXT,
  seal_sql_sha256 TEXT,
  v13_sql_sha256 TEXT,
  fake_financial_operations_relation TEXT,
  fake_financial_operation_events_relation TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
DECLARE
  sealed RECORD;
  receipt_sha256 TEXT;
  receipt_count BIGINT;
  invalid_ledger TEXT;
BEGIN
  SELECT * INTO STRICT sealed
    FROM public.hxos_read_universal_v1_work_order_runtime_authority_v1();
  SELECT pg_catalog.count(*), pg_catalog.min(pg_catalog.btrim(evidence.migration_sql_sha256))
    INTO receipt_count, receipt_sha256
    FROM public.hxos_fake_financial_schema_evidence_v13 evidence
   WHERE evidence.migration_name =
     '20261016_universal_v1_fake_financial_command_outbox_authority_v13';
  IF receipt_count IS DISTINCT FROM 1::BIGINT
     OR receipt_sha256 IS NULL
     OR receipt_sha256 !~ '^[0-9a-f]{64}$'
     OR receipt_sha256 = pg_catalog.repeat('0', 64) THEN
    RAISE EXCEPTION 'HXUV1-FINOUT-13-46: exact v13 runtime receipt is absent'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT expected.migration_name INTO invalid_ledger
    FROM (VALUES
      ('20261014_universal_v1_work_order_command_ports_v1', sealed.ordinal146_sql_sha256),
      ('20261015_universal_v1_work_order_fake_financial_authority_hardening_v12', sealed.v12_sql_sha256),
      ('20261015_universal_v1_work_order_bootstrap_seal_v1', sealed.seal_sql_sha256),
      ('20261016_universal_v1_fake_financial_command_outbox_authority_v13', receipt_sha256)
    ) expected(migration_name, sql_sha256)
    LEFT JOIN public.applied_migrations applied ON applied.name = expected.migration_name
   GROUP BY expected.migration_name, expected.sql_sha256
  HAVING pg_catalog.count(applied.name) IS DISTINCT FROM 1::BIGINT
      OR pg_catalog.min(pg_catalog.btrim(applied.sha256)) IS DISTINCT FROM expected.sql_sha256
   ORDER BY expected.migration_name LIMIT 1;
  IF invalid_ledger IS NOT NULL THEN
    RAISE EXCEPTION 'HXUV1-FINOUT-13-47: exact runtime migration ledger drifted: %', invalid_ledger
      USING ERRCODE = 'P0001';
  END IF;
  RETURN QUERY SELECT
    sealed.session_database_role::TEXT,
    sealed.target_authority_id::UUID,
    sealed.authority_version::INTEGER,
    sealed.target_database_name::TEXT,
    sealed.environment::TEXT,
    sealed.release_manifest_sha256::TEXT,
    sealed.ordinal146_sql_sha256::TEXT,
    sealed.v12_sql_sha256::TEXT,
    sealed.seal_sql_sha256::TEXT,
    receipt_sha256,
    sealed.fake_financial_operations_relation::TEXT,
    sealed.fake_financial_operation_events_relation::TEXT;
END;
$$;

-- Metadata-only ports preserve runtime denial of evidence-table reads. They
-- return receipts, never capabilities or readiness verdicts; the caller must
-- compare exact expected bytes within its attested read-only snapshot.
CREATE OR REPLACE FUNCTION public.hxos_read_fake_financial_schema_evidence_v13()
RETURNS TABLE (migration_name TEXT, evidence_sha256 TEXT, applied_sha256 TEXT)
LANGUAGE sql
SECURITY DEFINER
STABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  WITH evidence AS (
    SELECT migration_name, pg_catalog.btrim(migration_sql_sha256) AS evidence_sha256
      FROM public.hxos_fake_financial_schema_evidence_v1
    UNION ALL SELECT migration_name, pg_catalog.btrim(migration_sql_sha256)
      FROM public.hxos_fake_financial_schema_evidence_v2
    UNION ALL SELECT migration_name, pg_catalog.btrim(migration_sql_sha256)
      FROM public.hxos_fake_financial_schema_evidence_v3
    UNION ALL SELECT migration_name, pg_catalog.btrim(migration_sql_sha256)
      FROM public.hxos_fake_financial_schema_evidence_v4
    UNION ALL SELECT migration_name, pg_catalog.btrim(migration_sql_sha256)
      FROM public.hxos_fake_financial_schema_evidence_v5
    UNION ALL SELECT migration_name, pg_catalog.btrim(migration_sql_sha256)
      FROM public.hxos_fake_financial_schema_evidence_v6
    UNION ALL SELECT migration_name, pg_catalog.btrim(migration_sql_sha256)
      FROM public.hxos_fake_financial_schema_evidence_v7
    UNION ALL SELECT migration_name, pg_catalog.btrim(migration_sql_sha256)
      FROM public.hxos_fake_financial_schema_evidence_v8
    UNION ALL SELECT migration_name, pg_catalog.btrim(migration_sql_sha256)
      FROM public.hxos_fake_financial_schema_evidence_v9
    UNION ALL SELECT migration_name, pg_catalog.btrim(migration_sql_sha256)
      FROM public.hxos_fake_financial_schema_evidence_v10
    UNION ALL SELECT migration_name, pg_catalog.btrim(migration_sql_sha256)
      FROM public.hxos_fake_financial_schema_evidence_v11
    UNION ALL SELECT migration_name, pg_catalog.btrim(migration_sql_sha256)
      FROM public.hxos_fake_financial_schema_evidence_v12
    UNION ALL SELECT migration_name, pg_catalog.btrim(migration_sql_sha256)
      FROM public.hxos_work_order_bootstrap_seal_evidence_v1
    UNION ALL SELECT migration_name, pg_catalog.btrim(migration_sql_sha256)
      FROM public.hxos_fake_financial_schema_evidence_v13
  )
  SELECT evidence.migration_name, evidence.evidence_sha256,
         pg_catalog.btrim(applied.sha256)
    FROM evidence
    LEFT JOIN public.applied_migrations applied ON applied.name = evidence.migration_name
   ORDER BY evidence.migration_name
$$;

CREATE OR REPLACE FUNCTION public.hxos_read_fake_financial_applied_migrations_v13()
RETURNS TABLE (migration_name TEXT, applied_sha256 TEXT)
LANGUAGE sql
SECURITY DEFINER
STABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT applied.name, pg_catalog.btrim(applied.sha256)
    FROM public.applied_migrations applied ORDER BY applied.name
$$;

CREATE OR REPLACE FUNCTION public.hxos_read_fake_financial_bootstrap_completion_v13(
  p_release_manifest_digest TEXT, p_migration_artifact_digest TEXT
)
RETURNS TABLE (
  release_id TEXT, release_environment TEXT, required_migration_count INTEGER,
  financial_migration_status TEXT, completed_at TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
STABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT completion.release_id, completion.release_environment,
         completion.required_migration_count, completion.financial_migration_status,
         completion.completed_at
    FROM public.hxos_nonproduction_bootstrap_completion_v1 completion
   WHERE completion.release_manifest_digest = p_release_manifest_digest
     AND completion.migration_artifact_digest = p_migration_artifact_digest
$$;

CREATE OR REPLACE FUNCTION hx_authority.assert_fake_financial_outbox_target_v13(
  expected_target_authority_id UUID,
  expected_database_name TEXT,
  expected_environment TEXT,
  expected_manifest_digest TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
DECLARE
  current_tip RECORD;
  current_tip_count INTEGER;
  unsafe_schema TEXT;
  unsafe_owner_membership TEXT;
  invalid_predecessor TEXT;
  expected_ordinal146_sha256 CONSTANT TEXT :=
    '3920ac8d3208b9f573dc331cab60c373d0349611700c6e14a6e4c1dd8c53aac4';
  expected_v12_sha256 CONSTANT TEXT :=
    '5bb8ee72b9113146b88c22c6751ebe527ba6246b4463a8611ef9c24b999b7ac5';
  expected_seal_sha256 CONSTANT TEXT :=
    'c69825589193885d0f6a3b93930880998e95e1c5cd44bb9b5999cb457192b2bd';
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('hxuv1-work-order-target-authority-v1', 0)
  );

  SELECT namespace_state.nspname
    INTO unsafe_schema
    FROM pg_catalog.pg_namespace namespace_state
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        namespace_state.nspacl,
        pg_catalog.acldefault('n', namespace_state.nspowner)
      )
    ) privilege
   WHERE namespace_state.nspname IN ('public', 'hx_authority')
     AND privilege.grantee <> namespace_state.nspowner
     AND privilege.privilege_type = 'CREATE'
   ORDER BY namespace_state.nspname
   LIMIT 1;
  IF unsafe_schema IS NOT NULL THEN
    RAISE EXCEPTION
      'HXUV1-FINOUT-13-4: non-owner CREATE drifted on schema %', unsafe_schema
      USING ERRCODE = 'P0001';
  END IF;

  WITH RECURSIVE object_owners(owner_oid) AS (
    SELECT relation_state.relowner
      FROM pg_catalog.pg_class relation_state
      JOIN pg_catalog.pg_namespace namespace_state
        ON namespace_state.oid = relation_state.relnamespace
     WHERE (
       namespace_state.nspname = 'hx_authority'
       AND relation_state.relname IN (
         'fake_financial_command_outbox_requests_v13',
         'fake_financial_outbox_publish_claims_v13',
         'fake_financial_outbox_publish_outcomes_v13',
         'fake_financial_outbox_dispositions_v13',
         'fake_financial_publish_exhaustions_v13',
         'fake_financial_dispatch_admissions_v13',
         'fake_financial_job_validations_v13',
         'fake_financial_webhook_inert_evidence_v13',
         'fake_financial_webhook_rejection_receipts_v13'
       )
     ) OR (
       namespace_state.nspname = 'public'
       AND relation_state.relname = 'hxos_fake_financial_schema_evidence_v13'
     )
    UNION
    SELECT function_state.proowner
      FROM pg_catalog.pg_proc function_state
      JOIN pg_catalog.pg_namespace namespace_state
        ON namespace_state.oid = function_state.pronamespace
     WHERE namespace_state.nspname IN ('hx_authority', 'public')
       AND (
         function_state.proname LIKE '%fake_financial%v13'
         OR function_state.proname =
              'assert_financial_provider_command_recovery_lease'
       )
  ), owner_members(owner_oid, member_oid) AS (
    SELECT owner_state.owner_oid, membership.member
      FROM object_owners owner_state
      JOIN pg_catalog.pg_auth_members membership
        ON membership.roleid = owner_state.owner_oid
    UNION
    SELECT membership_tree.owner_oid, membership.member
      FROM owner_members membership_tree
      JOIN pg_catalog.pg_auth_members membership
        ON membership.roleid = membership_tree.member_oid
  )
  SELECT pg_catalog.pg_get_userbyid(membership_state.owner_oid)
           || '->' || pg_catalog.pg_get_userbyid(membership_state.member_oid)
    INTO unsafe_owner_membership
    FROM owner_members membership_state
   ORDER BY membership_state.owner_oid, membership_state.member_oid
   LIMIT 1;
  IF unsafe_owner_membership IS NOT NULL THEN
    RAISE EXCEPTION
      'HXUV1-FINOUT-13-4A: v13 object-owner membership is unsafe: %',
      unsafe_owner_membership
      USING ERRCODE = 'P0001';
  END IF;

  SELECT expected.migration_name
    INTO invalid_predecessor
    FROM (VALUES
      ('20261014_universal_v1_work_order_command_ports_v1',
       expected_ordinal146_sha256),
      ('20261015_universal_v1_work_order_fake_financial_authority_hardening_v12',
       expected_v12_sha256),
      ('20261015_universal_v1_work_order_bootstrap_seal_v1',
       expected_seal_sha256)
    ) expected(migration_name, expected_sha256)
    LEFT JOIN public.applied_migrations applied
      ON applied.name = expected.migration_name
   GROUP BY expected.migration_name, expected.expected_sha256
  HAVING pg_catalog.count(applied.name) IS DISTINCT FROM 1::BIGINT
      OR pg_catalog.min(pg_catalog.btrim(applied.sha256)) IS DISTINCT FROM expected.expected_sha256
   ORDER BY expected.migration_name
   LIMIT 1;
  IF invalid_predecessor IS NOT NULL THEN
    RAISE EXCEPTION
      'HXUV1-FINOUT-13-4B: exact applied predecessor drifted: %',
      invalid_predecessor
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.hxos_fake_financial_schema_evidence_v12 evidence
     WHERE evidence.migration_name =
       '20261015_universal_v1_work_order_fake_financial_authority_hardening_v12'
       AND pg_catalog.btrim(evidence.migration_sql_sha256) =
             expected_v12_sha256
       AND pg_catalog.btrim(evidence.ordinal146_sql_sha256) =
             expected_ordinal146_sha256
  ) OR NOT EXISTS (
    SELECT 1
      FROM public.hxos_work_order_bootstrap_seal_evidence_v1 evidence
     WHERE evidence.migration_name =
             '20261015_universal_v1_work_order_bootstrap_seal_v1'
       AND pg_catalog.btrim(evidence.migration_sql_sha256) =
             expected_seal_sha256
       AND pg_catalog.btrim(evidence.ordinal146_sql_sha256) =
             expected_ordinal146_sha256
       AND pg_catalog.btrim(evidence.v12_sql_sha256) = expected_v12_sha256
  ) OR NOT EXISTS (
    SELECT 1
      FROM public.hxos_fake_financial_schema_evidence_v13 evidence
      LEFT JOIN public.applied_migrations applied
        ON applied.name = evidence.migration_name
     WHERE evidence.migration_name =
       '20261016_universal_v1_fake_financial_command_outbox_authority_v13'
    HAVING pg_catalog.count(*) = 1::BIGINT
       AND pg_catalog.bool_and(
         pg_catalog.btrim(applied.sha256) IS NOT DISTINCT FROM
           pg_catalog.btrim(evidence.migration_sql_sha256)
         AND pg_catalog.btrim(evidence.migration_sql_sha256) ~ '^[0-9a-f]{64}$'
         AND pg_catalog.btrim(evidence.migration_sql_sha256) <> pg_catalog.repeat('0', 64)
       )
  ) THEN
    RAISE EXCEPTION
      'HXUV1-FINOUT-13-5: exact sealed predecessor/v13 migration evidence is absent'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT pg_catalog.count(*)::INTEGER
    INTO current_tip_count
    FROM hx_authority.universal_v1_work_order_target_authority_facts target
   WHERE NOT EXISTS (
     SELECT 1
       FROM hx_authority.universal_v1_work_order_target_authority_facts successor
      WHERE successor.supersedes_target_authority_id = target.target_authority_id
   );
  IF current_tip_count <> 1 THEN
    RAISE EXCEPTION
      'HXUV1-FINOUT-13-6: exactly one current database target is required'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT target.target_authority_id,
         target.target_database_name,
         target.environment,
         target.release_manifest_sha256
    INTO current_tip
    FROM hx_authority.universal_v1_work_order_target_authority_facts target
   WHERE NOT EXISTS (
     SELECT 1
       FROM hx_authority.universal_v1_work_order_target_authority_facts successor
      WHERE successor.supersedes_target_authority_id = target.target_authority_id
   )
   FOR UPDATE;

  IF current_tip.target_authority_id IS DISTINCT FROM expected_target_authority_id
     OR current_tip.target_database_name IS DISTINCT FROM expected_database_name
     OR current_tip.target_database_name IS DISTINCT FROM pg_catalog.current_database()
     OR current_tip.environment IS DISTINCT FROM expected_environment
     OR current_tip.environment NOT IN ('local', 'preview', 'staging')
     OR current_tip.release_manifest_sha256 IS DISTINCT FROM
          expected_manifest_digest THEN
    RAISE EXCEPTION
      'HXUV1-FINOUT-13-7: fake-financial outbox target is stale or mismatched'
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

-- Forward-replace the v1 lease guard before installing the Redis evidence port.
-- The predecessor used three-valued `NOT (...)` logic; when the latest attempt
-- had no outcome, NULL made the IF condition false and admitted another
-- DISPATCH. This exact-signature replacement preserves reconciliation behavior
-- while making no-outcome and every non-confirmed result an explicit denial.
CREATE OR REPLACE FUNCTION public.assert_financial_provider_command_recovery_lease()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
VOLATILE
PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
DECLARE
  current_provider_kind TEXT;
  latest_attempt_id UUID;
  latest_outcome_deadline TIMESTAMPTZ;
  latest_outcome_kind TEXT;
  latest_outcome_retryable BOOLEAN;
  latest_effect_certainty TEXT;
  latest_recovery_not_before TIMESTAMPTZ;
  authority_now TIMESTAMPTZ;
  matching_dispatch_admission_count INTEGER;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('financial-provider-command-recovery-v1'),
    pg_catalog.hashtext(NEW.command_id::TEXT)
  );

  authority_now := pg_catalog.clock_timestamp();
  NEW.acquired_at := authority_now;
  NEW.expires_at := authority_now
    + pg_catalog.make_interval(secs => NEW.lease_duration_seconds);

  SELECT command.provider_kind
    INTO current_provider_kind
    FROM public.financial_provider_command_journal command
   WHERE command.command_id = NEW.command_id
   FOR SHARE;
  IF current_provider_kind IS DISTINCT FROM 'FAKE' THEN
    RAISE EXCEPTION
      'HXFPCREC1-V13: recovery requires one existing FAKE REQUESTED command'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.recovery_action = 'DISPATCH' THEN
    SELECT pg_catalog.count(*)::INTEGER
      INTO matching_dispatch_admission_count
      FROM hx_authority.fake_financial_dispatch_admissions_v13 admission
     WHERE admission.command_id = NEW.command_id
       AND admission.recovery_lease_id = NEW.recovery_lease_id
       AND admission.admitted_transaction_id =
             pg_catalog.pg_current_xact_id()::TEXT::BIGINT;
    IF matching_dispatch_admission_count <> 1 THEN
      RAISE EXCEPTION
        'HXFPCREC1-V13: DISPATCH requires one same-transaction sealed v13 admission'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.financial_provider_command_outcome_facts outcome
     WHERE outcome.command_id = NEW.command_id
       AND (
         (outcome.outcome_kind = 'OUTCOME_OBSERVED' AND outcome.retryable = FALSE)
         OR (outcome.outcome_kind = 'FAILED' AND outcome.retryable = FALSE)
       )
  ) THEN
    RAISE EXCEPTION 'HXFPCREC1-V13: command already has a terminal outcome'
      USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.financial_provider_command_recovery_leases lease
     WHERE lease.command_id = NEW.command_id
       AND lease.expires_at > authority_now
       AND NOT EXISTS (
         SELECT 1
           FROM public.financial_provider_command_dispatch_attempts attempt
          WHERE attempt.recovery_lease_id = lease.recovery_lease_id
       )
       AND NOT EXISTS (
         SELECT 1
           FROM public.financial_provider_command_outcome_facts outcome
          WHERE outcome.recovery_lease_id = lease.recovery_lease_id
       )
  ) THEN
    RAISE EXCEPTION 'HXFPCREC1-V13: command already has an active recovery lease'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT attempt.dispatch_attempt_id,
         attempt.outcome_deadline_at
    INTO latest_attempt_id,
         latest_outcome_deadline
    FROM public.financial_provider_command_dispatch_attempts attempt
   WHERE attempt.command_id = NEW.command_id
   ORDER BY attempt.attempt_number DESC
   LIMIT 1;
  IF latest_attempt_id IS NOT NULL THEN
    SELECT outcome.outcome_kind,
           outcome.retryable,
           outcome.effect_certainty,
           outcome.recovery_not_before
      INTO latest_outcome_kind,
           latest_outcome_retryable,
           latest_effect_certainty,
           latest_recovery_not_before
      FROM public.financial_provider_command_outcome_facts outcome
     WHERE outcome.command_id = NEW.command_id
       AND outcome.dispatch_attempt_id = latest_attempt_id
     ORDER BY outcome.recorded_at DESC, outcome.outcome_fact_id DESC
     LIMIT 1;
  END IF;

  IF NEW.recovery_action = 'DISPATCH' THEN
    IF latest_attempt_id IS NOT NULL AND (
      latest_outcome_kind IS DISTINCT FROM 'FAILED'
      OR latest_outcome_retryable IS DISTINCT FROM TRUE
      OR latest_effect_certainty IS DISTINCT FROM 'CONFIRMED_NO_EFFECT'
      OR latest_recovery_not_before IS NULL
      OR latest_recovery_not_before > authority_now
    ) THEN
      RAISE EXCEPTION
        'HXFPCREC1-V13: redispatch requires a due retryable FAILED CONFIRMED_NO_EFFECT outcome'
        USING ERRCODE = 'P0001';
    END IF;
  ELSIF NEW.recovery_action = 'RECONCILE' THEN
    IF latest_attempt_id IS NULL THEN
      RAISE EXCEPTION 'HXFPCREC1-V13: reconciliation requires a dispatch attempt'
        USING ERRCODE = 'P0001';
    ELSIF latest_outcome_kind IS NULL THEN
      IF latest_outcome_deadline > authority_now THEN
        RAISE EXCEPTION
          'HXFPCREC1-V13: dispatch outcome deadline has not elapsed'
          USING ERRCODE = 'P0001';
      END IF;
    ELSIF latest_outcome_kind NOT IN (
      'OUTCOME_OBSERVED', 'OUTCOME_UNKNOWN', 'FAILED'
    ) OR latest_outcome_retryable IS DISTINCT FROM TRUE
       OR latest_recovery_not_before IS NULL
       OR latest_recovery_not_before > authority_now THEN
      RAISE EXCEPTION
        'HXFPCREC1-V13: reconciliation requires a due explicit nonterminal outcome'
        USING ERRCODE = 'P0001';
    END IF;
  ELSE
    RAISE EXCEPTION 'HXFPCREC1-V13: unsupported recovery action'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS financial_provider_command_recovery_lease_guard
  ON public.financial_provider_command_recovery_leases;
CREATE TRIGGER financial_provider_command_recovery_lease_guard
BEFORE INSERT ON public.financial_provider_command_recovery_leases
FOR EACH ROW
EXECUTE FUNCTION public.assert_financial_provider_command_recovery_lease();

CREATE OR REPLACE FUNCTION hx_authority.validate_fake_financial_outbox_request_v13()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
DECLARE
  command_record RECORD;
  prepared_record RECORD;
  target_record RECORD;
  expected_job_authority_sha256 CHAR(64);
  expected_bullmq_job_id TEXT;
BEGIN
  SELECT command.command_state,
         command.operation_kind,
         command.operation_id,
         command.provider_kind,
         command.idempotency_key,
         command.provider_expected_version,
         command.request_sha256,
         command.command_identity_sha256,
         command.prepared_financial_command_id,
         command.prepared_authority_sha256,
         command.release_manifest_digest,
         command.release_id,
         command.release_revision,
         command.release_environment,
         command.release_authentication_status
    INTO command_record
    FROM public.financial_provider_command_journal command
   WHERE command.command_id = NEW.command_id
   FOR SHARE;

  SELECT prepared.command_state,
         prepared.operation_kind,
         prepared.operation_id,
         prepared.provider_kind,
         prepared.idempotency_key,
         prepared.provider_expected_version,
         prepared.provider_request_sha256,
         prepared.authority_context_sha256
    INTO prepared_record
    FROM public.universal_v1_prepared_financial_commands prepared
   WHERE prepared.prepared_command_id = NEW.prepared_command_id
   FOR SHARE;

  SELECT target.authority_version,
         target.target_database_name,
         target.environment,
         target.release_manifest_sha256
    INTO target_record
    FROM hx_authority.universal_v1_work_order_target_authority_facts target
   WHERE target.target_authority_id = NEW.target_authority_id
   FOR SHARE;

  PERFORM hx_authority.assert_fake_financial_outbox_target_v13(
    NEW.target_authority_id,
    NEW.target_database_name,
    NEW.release_environment,
    NEW.release_manifest_digest
  );

  IF NOT EXISTS (
    SELECT 1 FROM hx_authority.fake_financial_preparation_authority_v13 provenance
    JOIN public.universal_v1_prepared_financial_commands prepared
      ON prepared.prepared_command_id = provenance.prepared_command_id
    JOIN public.financial_provider_command_journal command
      ON command.command_id = NEW.command_id
    WHERE provenance.prepared_command_id = NEW.prepared_command_id
      AND provenance.actor_user_id = prepared.recorded_by
      AND provenance.actor_user_id = command.recorded_actor_id
      AND command.recorded_actor_kind = 'PARTICIPANT'
      AND provenance.target_authority_id = NEW.target_authority_id
      AND provenance.release_manifest_sha256 = NEW.release_manifest_digest
  ) THEN RAISE EXCEPTION 'HXUV1-FINREQ-13-AUTHENTICATED_PREPARATION_REQUIRED'; END IF;

  IF command_record.command_state IS DISTINCT FROM 'REQUESTED'
     OR command_record.provider_kind IS DISTINCT FROM 'FAKE'
     OR command_record.release_authentication_status IS DISTINCT FROM 'VERIFIED'
     OR command_record.release_environment NOT IN ('local', 'preview', 'staging')
     OR prepared_record.command_state IS DISTINCT FROM 'PREPARED'
     OR prepared_record.provider_kind IS DISTINCT FROM 'FAKE'
     OR command_record.prepared_financial_command_id IS DISTINCT FROM
          NEW.prepared_command_id
     OR command_record.prepared_authority_sha256 IS DISTINCT FROM
          prepared_record.authority_context_sha256
     OR command_record.request_sha256 IS DISTINCT FROM
          prepared_record.provider_request_sha256
     OR command_record.operation_kind IS DISTINCT FROM prepared_record.operation_kind
     OR command_record.operation_id IS DISTINCT FROM prepared_record.operation_id
     OR command_record.idempotency_key IS DISTINCT FROM prepared_record.idempotency_key
     OR command_record.provider_expected_version IS DISTINCT FROM
          prepared_record.provider_expected_version
     OR NEW.prepared_state IS DISTINCT FROM prepared_record.command_state
     OR NEW.command_state IS DISTINCT FROM command_record.command_state
     OR NEW.provider_kind IS DISTINCT FROM command_record.provider_kind
     OR NEW.operation_kind IS DISTINCT FROM command_record.operation_kind
     OR NEW.operation_id IS DISTINCT FROM command_record.operation_id
     OR NEW.idempotency_key IS DISTINCT FROM command_record.idempotency_key
     OR NEW.provider_expected_version IS DISTINCT FROM
          command_record.provider_expected_version
     OR NEW.provider_request_sha256 IS DISTINCT FROM command_record.request_sha256
     OR NEW.command_identity_sha256 IS DISTINCT FROM
          command_record.command_identity_sha256
     OR NEW.prepared_authority_sha256 IS DISTINCT FROM
          prepared_record.authority_context_sha256
     OR NEW.release_manifest_digest IS DISTINCT FROM
          command_record.release_manifest_digest
     OR NEW.release_id IS DISTINCT FROM command_record.release_id
     OR NEW.release_revision IS DISTINCT FROM command_record.release_revision
     OR NEW.release_environment IS DISTINCT FROM command_record.release_environment
     OR NEW.target_authority_version IS DISTINCT FROM target_record.authority_version
     OR NEW.target_database_name IS DISTINCT FROM target_record.target_database_name
     OR NEW.release_environment IS DISTINCT FROM target_record.environment
     OR NEW.release_manifest_digest IS DISTINCT FROM
          target_record.release_manifest_sha256 THEN
    RAISE EXCEPTION
      'HXUV1-FINOUT-13-8: outbox request lacks exact PREPARED/REQUESTED/target authority'
      USING ERRCODE = 'P0001';
  END IF;

  expected_job_authority_sha256 := hx_authority.fake_financial_job_digest_v13(
    ARRAY[
      'HXUV1_FAKE_FINANCIAL_BULLMQ_JOB_V13',
      NEW.outbox_request_id::TEXT,
      NEW.command_id::TEXT,
      NEW.prepared_command_id::TEXT,
      NEW.target_authority_id::TEXT,
      NEW.target_authority_version::TEXT,
      NEW.target_database_name,
      NEW.release_environment,
      NEW.release_manifest_digest,
      NEW.release_id,
      pg_catalog.btrim(NEW.release_revision),
      NEW.operation_kind,
      NEW.operation_id::TEXT,
      NEW.idempotency_key,
      NEW.provider_expected_version::TEXT,
      pg_catalog.btrim(NEW.provider_request_sha256),
      pg_catalog.btrim(NEW.command_identity_sha256),
      pg_catalog.btrim(NEW.prepared_authority_sha256),
      NEW.queue_name,
      NEW.job_name,
      NEW.payload_contract_version::TEXT
    ]::TEXT[]
  );
  expected_bullmq_job_id := 'hx-fake-fin-'
    || pg_catalog.replace(NEW.command_id::TEXT, '-', '')
    || '-' || pg_catalog.btrim(expected_job_authority_sha256);
  IF NEW.job_authority_sha256 IS DISTINCT FROM expected_job_authority_sha256
     OR NEW.bullmq_job_id IS DISTINCT FROM expected_bullmq_job_id THEN
    RAISE EXCEPTION
      'HXUV1-FINOUT-13-9: deterministic BullMQ job identity mismatch'
      USING ERRCODE = 'P0001';
  END IF;

  NEW.requested_at := pg_catalog.clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER fake_finance_outbox_request_validate_v13
BEFORE INSERT ON hx_authority.fake_financial_command_outbox_requests_v13
FOR EACH ROW
EXECUTE FUNCTION hx_authority.validate_fake_financial_outbox_request_v13();

CREATE OR REPLACE FUNCTION hx_authority.capture_fake_financial_outbox_request_v13()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
DECLARE
  prepared_record RECORD;
  target_record RECORD;
  target_count INTEGER;
  outbox_request_id UUID := pg_catalog.gen_random_uuid();
  job_authority_sha256 CHAR(64);
  bullmq_job_id TEXT;
BEGIN
  IF NEW.provider_kind <> 'FAKE'
     OR NEW.operation_kind NOT IN (
       'PREPARE_PAYMENT_METHOD', 'AUTHORIZE', 'SECURE', 'VOID', 'ADJUST',
       'CAPTURE', 'REFUND', 'REVERSAL', 'SETTLE', 'FUND',
       'PROVIDER_RELEASE', 'PAYOUT', 'OBSERVE_BANK_SETTLEMENT'
     ) THEN
    RETURN NEW;
  END IF;

  IF NEW.command_state <> 'REQUESTED'
     OR NEW.prepared_financial_command_id IS NULL
     OR NEW.prepared_authority_sha256 IS NULL
     OR NEW.release_authentication_status IS DISTINCT FROM 'VERIFIED'
     OR NEW.release_environment NOT IN ('local', 'preview', 'staging')
     OR NEW.release_manifest_digest IS NULL
     OR NEW.release_id IS NULL
     OR NEW.release_revision IS NULL THEN
    RAISE EXCEPTION
      'HXUV1-FINOUT-13-10: fake lifecycle REQUESTED requires verified nonproduction authority'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT prepared.command_state,
         prepared.operation_kind,
         prepared.operation_id,
         prepared.provider_kind,
         prepared.idempotency_key,
         prepared.provider_expected_version,
         prepared.provider_request_sha256,
         prepared.authority_context_sha256
    INTO prepared_record
    FROM public.universal_v1_prepared_financial_commands prepared
   WHERE prepared.prepared_command_id = NEW.prepared_financial_command_id
   FOR SHARE;
  IF prepared_record.command_state IS DISTINCT FROM 'PREPARED'
     OR prepared_record.provider_kind IS DISTINCT FROM 'FAKE'
     OR prepared_record.operation_kind IS DISTINCT FROM NEW.operation_kind
     OR prepared_record.operation_id IS DISTINCT FROM NEW.operation_id
     OR prepared_record.idempotency_key IS DISTINCT FROM NEW.idempotency_key
     OR prepared_record.provider_expected_version IS DISTINCT FROM
          NEW.provider_expected_version
     OR prepared_record.provider_request_sha256 IS DISTINCT FROM NEW.request_sha256
     OR prepared_record.authority_context_sha256 IS DISTINCT FROM
          NEW.prepared_authority_sha256 THEN
    RAISE EXCEPTION
      'HXUV1-FINOUT-13-11: REQUESTED fact does not match exact PREPARED authority'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('hxuv1-work-order-target-authority-v1', 0)
  );
  SELECT pg_catalog.count(*)::INTEGER
    INTO target_count
    FROM hx_authority.universal_v1_work_order_target_authority_facts target
   WHERE NOT EXISTS (
     SELECT 1
       FROM hx_authority.universal_v1_work_order_target_authority_facts successor
      WHERE successor.supersedes_target_authority_id = target.target_authority_id
   );
  IF target_count <> 1 THEN
    RAISE EXCEPTION
      'HXUV1-FINOUT-13-12: one current nonproduction target is required'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT target.target_authority_id,
         target.authority_version,
         target.target_database_name,
         target.environment,
         target.release_manifest_sha256
    INTO target_record
    FROM hx_authority.universal_v1_work_order_target_authority_facts target
   WHERE NOT EXISTS (
     SELECT 1
       FROM hx_authority.universal_v1_work_order_target_authority_facts successor
      WHERE successor.supersedes_target_authority_id = target.target_authority_id
   )
   FOR SHARE;

  PERFORM hx_authority.assert_fake_financial_outbox_target_v13(
    target_record.target_authority_id,
    target_record.target_database_name,
    target_record.environment,
    target_record.release_manifest_sha256
  );
  IF target_record.environment IS DISTINCT FROM NEW.release_environment
     OR target_record.release_manifest_sha256 IS DISTINCT FROM
          NEW.release_manifest_digest THEN
    RAISE EXCEPTION
      'HXUV1-FINOUT-13-13: REQUESTED release differs from current database target'
      USING ERRCODE = 'P0001';
  END IF;

  job_authority_sha256 := hx_authority.fake_financial_job_digest_v13(
    ARRAY[
      'HXUV1_FAKE_FINANCIAL_BULLMQ_JOB_V13',
      outbox_request_id::TEXT,
      NEW.command_id::TEXT,
      NEW.prepared_financial_command_id::TEXT,
      target_record.target_authority_id::TEXT,
      target_record.authority_version::TEXT,
      target_record.target_database_name,
      target_record.environment,
      target_record.release_manifest_sha256,
      NEW.release_id,
      pg_catalog.btrim(NEW.release_revision),
      NEW.operation_kind,
      NEW.operation_id::TEXT,
      NEW.idempotency_key,
      NEW.provider_expected_version::TEXT,
      pg_catalog.btrim(NEW.request_sha256),
      pg_catalog.btrim(NEW.command_identity_sha256),
      pg_catalog.btrim(NEW.prepared_authority_sha256),
      'synthetic_finance',
      'synthetic_finance.command.v13',
      '1'
    ]::TEXT[]
  );
  bullmq_job_id := 'hx-fake-fin-'
    || pg_catalog.replace(NEW.command_id::TEXT, '-', '')
    || '-' || pg_catalog.btrim(job_authority_sha256);

  INSERT INTO hx_authority.fake_financial_command_outbox_requests_v13 (
    outbox_request_id,
    command_id,
    prepared_command_id,
    target_authority_id,
    target_authority_version,
    target_database_name,
    release_environment,
    release_manifest_digest,
    release_id,
    release_revision,
    provider_kind,
    prepared_state,
    command_state,
    operation_kind,
    operation_id,
    idempotency_key,
    provider_expected_version,
    provider_request_sha256,
    command_identity_sha256,
    prepared_authority_sha256,
    queue_name,
    job_name,
    payload_contract_version,
    job_authority_sha256,
    bullmq_job_id
  ) VALUES (
    outbox_request_id,
    NEW.command_id,
    NEW.prepared_financial_command_id,
    target_record.target_authority_id,
    target_record.authority_version,
    target_record.target_database_name,
    NEW.release_environment,
    NEW.release_manifest_digest,
    NEW.release_id,
    NEW.release_revision,
    'FAKE',
    'PREPARED',
    'REQUESTED',
    NEW.operation_kind,
    NEW.operation_id,
    NEW.idempotency_key,
    NEW.provider_expected_version,
    NEW.request_sha256,
    NEW.command_identity_sha256,
    NEW.prepared_authority_sha256,
    'synthetic_finance',
    'synthetic_finance.command.v13',
    1,
    job_authority_sha256,
    bullmq_job_id
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS fake_finance_outbox_capture_v13
  ON public.financial_provider_command_journal;
CREATE TRIGGER fake_finance_outbox_capture_v13
AFTER INSERT ON public.financial_provider_command_journal
FOR EACH ROW
EXECUTE FUNCTION hx_authority.capture_fake_financial_outbox_request_v13();

-- Exact provider request bytes are private immutable authority evidence, never
-- queue payload. Existing commands intentionally keep a NULL creation marker;
-- neither this migration nor replay reconstructs or backfills their requests.
ALTER TABLE public.financial_provider_command_journal
  ADD COLUMN requested_transaction_id XID8;

CREATE TABLE hx_authority.fake_financial_exact_requests_v13 (
  command_id UUID PRIMARY KEY REFERENCES public.financial_provider_command_journal(command_id),
  payload_contract_version SMALLINT NOT NULL DEFAULT 1 CHECK (payload_contract_version = 1),
  canonical_provider_request TEXT NOT NULL CHECK (
    pg_catalog.octet_length(canonical_provider_request) BETWEEN 2 AND 65536
  ),
  provider_request_sha256 CHAR(64) NOT NULL CHECK (provider_request_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_transaction_id XID8 NOT NULL DEFAULT pg_catalog.pg_current_xact_id(),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

CREATE OR REPLACE FUNCTION hx_authority.parse_fake_financial_request_v13(
  p_operation_kind TEXT, p_canonical_request TEXT
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
DECLARE
  request JSONB;
  expected_keys TEXT[] := ARRAY['operationId','idempotencyKey','expectedVersion'];
  actual_keys TEXT[];
  field_name TEXT;
  field_value JSONB;
  rebuilt TEXT;
  ecmascript_whitespace CONSTANT TEXT :=
    pg_catalog.chr(9) || pg_catalog.chr(10) || pg_catalog.chr(11) || pg_catalog.chr(12) || pg_catalog.chr(13)
    || pg_catalog.chr(32) || pg_catalog.chr(160) || pg_catalog.chr(5760)
    || pg_catalog.chr(8192) || pg_catalog.chr(8193) || pg_catalog.chr(8194) || pg_catalog.chr(8195)
    || pg_catalog.chr(8196) || pg_catalog.chr(8197) || pg_catalog.chr(8198) || pg_catalog.chr(8199)
    || pg_catalog.chr(8200) || pg_catalog.chr(8201) || pg_catalog.chr(8202)
    || pg_catalog.chr(8232) || pg_catalog.chr(8233) || pg_catalog.chr(8239)
    || pg_catalog.chr(8287) || pg_catalog.chr(12288) || pg_catalog.chr(65279);
  uuid_pattern CONSTANT TEXT := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$';
BEGIN
  IF p_operation_kind IS NULL OR p_operation_kind NOT IN (
    'PREPARE_PAYMENT_METHOD','AUTHORIZE','SECURE','VOID','ADJUST','CAPTURE',
    'REFUND','REVERSAL','SETTLE','FUND','PROVIDER_RELEASE','PAYOUT','OBSERVE_BANK_SETTLEMENT'
  ) OR p_canonical_request IS NULL
    OR pg_catalog.octet_length(p_canonical_request) NOT BETWEEN 2 AND 65536 THEN
    RAISE EXCEPTION 'HXUV1-FINREQ-13-SHAPE_INVALID';
  END IF;
  request := p_canonical_request::JSONB;
  IF pg_catalog.jsonb_typeof(request) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'HXUV1-FINREQ-13-SHAPE_INVALID';
  END IF;
  IF p_operation_kind <> 'PREPARE_PAYMENT_METHOD' THEN
    expected_keys := expected_keys || ARRAY['amountCents','currency','relatedOperationId'];
  END IF;
  expected_keys := expected_keys || CASE p_operation_kind
    WHEN 'PREPARE_PAYMENT_METHOD' THEN ARRAY['customerId']
    WHEN 'AUTHORIZE' THEN ARRAY['paymentMethodReference']
    WHEN 'SECURE' THEN ARRAY['authorizationOperationId']
    WHEN 'ADJUST' THEN ARRAY['scopeVersionId','changeOrderId']
    WHEN 'REFUND' THEN ARRAY['originalAmountCents']
    WHEN 'PAYOUT' THEN ARRAY['providerAccountReference'] ELSE ARRAY[]::TEXT[] END;
  IF request ? 'scenario' THEN expected_keys := expected_keys || ARRAY['scenario']; END IF;
  SELECT pg_catalog.array_agg(key ORDER BY key COLLATE "C") INTO actual_keys
    FROM pg_catalog.jsonb_object_keys(request) keys(key);
  SELECT pg_catalog.array_agg(key ORDER BY key COLLATE "C") INTO expected_keys
    FROM pg_catalog.unnest(expected_keys) keys(key);
  IF actual_keys IS DISTINCT FROM expected_keys THEN
    RAISE EXCEPTION 'HXUV1-FINREQ-13-FIELDS_INVALID';
  END IF;
  FOREACH field_name IN ARRAY expected_keys LOOP
    field_value := request -> field_name;
    IF field_name IN ('expectedVersion','amountCents','originalAmountCents') THEN
      IF pg_catalog.jsonb_typeof(field_value) IS DISTINCT FROM 'number'
         OR field_value::TEXT !~ '^(0|[1-9][0-9]*)$'
         OR (field_value::TEXT)::NUMERIC > 9007199254740991
         OR (field_name <> 'expectedVersion' AND (field_value::TEXT)::NUMERIC < 1) THEN
        RAISE EXCEPTION 'HXUV1-FINREQ-13-NUMBER_INVALID';
      END IF;
    ELSE
      IF pg_catalog.jsonb_typeof(field_value) IS DISTINCT FROM 'string'
         OR pg_catalog.length(pg_catalog.btrim(request ->> field_name, ecmascript_whitespace)) = 0 THEN
        RAISE EXCEPTION 'HXUV1-FINREQ-13-REFERENCE_INVALID';
      END IF;
      IF field_name IN ('operationId','relatedOperationId','authorizationOperationId','scopeVersionId','changeOrderId')
         AND (request ->> field_name) !~ uuid_pattern THEN
        RAISE EXCEPTION 'HXUV1-FINREQ-13-UUID_INVALID';
      END IF;
    END IF;
  END LOOP;
  IF (request ->> 'idempotencyKey') !~ '^[A-Za-z0-9:_-]{16,128}$'
     OR (p_operation_kind <> 'PREPARE_PAYMENT_METHOD' AND (request ->> 'currency') !~ '^[a-z]{3}$')
     OR (p_operation_kind = 'REFUND' AND (request ->> 'originalAmountCents')::BIGINT < (request ->> 'amountCents')::BIGINT) THEN
    RAISE EXCEPTION 'HXUV1-FINREQ-13-IDENTITY_OR_MONEY_INVALID';
  END IF;
  IF request ? 'scenario' AND NOT (
    request ->> 'scenario' IN ('SUCCESS','DECLINE','TIMEOUT','RETRY')
    OR (request ->> 'scenario' = 'REVERSAL' AND p_operation_kind = 'REVERSAL')
    OR (request ->> 'scenario' = 'PARTIAL_REFUND' AND p_operation_kind = 'REFUND')
    OR (request ->> 'scenario' = 'DELAYED_SETTLEMENT' AND p_operation_kind IN ('SETTLE','FUND','PROVIDER_RELEASE','PAYOUT','OBSERVE_BANK_SETTLEMENT'))
  ) THEN RAISE EXCEPTION 'HXUV1-FINREQ-13-SCENARIO_INVALID'; END IF;
  SELECT '{' || pg_catalog.string_agg(pg_catalog.to_json(key)::TEXT || ':' || value::TEXT,
         ',' ORDER BY key COLLATE "C") || '}' INTO rebuilt
    FROM pg_catalog.jsonb_each(request);
  IF rebuilt IS DISTINCT FROM p_canonical_request THEN
    RAISE EXCEPTION 'HXUV1-FINREQ-13-NONCANONICAL_BYTES';
  END IF;
  RETURN request;
END;
$$;

-- This fixed-order identity is the existing journal's JSON.stringify contract,
-- separate from the alphabetically sorted provider-request contract above.
CREATE OR REPLACE FUNCTION hx_authority.parse_fake_financial_identity_v13(p_identity TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
DECLARE
  identity JSONB;
  group_name TEXT;
  group_value JSONB;
  group_keys TEXT[];
  field_name TEXT;
  field_value JSONB;
  rebuilt TEXT;
  groups JSONB := '{}'::JSONB;
  uuid_pattern CONSTANT TEXT := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$';
BEGIN
  IF p_identity IS NULL OR pg_catalog.octet_length(p_identity) NOT BETWEEN 2 AND 8192 THEN
    RAISE EXCEPTION 'HXUV1-FINREQ-13-COMMAND_IDENTITY_INVALID';
  END IF;
  identity := p_identity::JSONB;
  FOREACH group_name IN ARRAY ARRAY['evidence','actor','release','root'] LOOP
    group_value := CASE WHEN group_name = 'root' THEN identity ELSE identity -> group_name END;
    group_keys := CASE group_name
      WHEN 'evidence' THEN ARRAY['preparedFinancialCommandId','preparedAuthoritySha256','taskDraftId','taskId','workOrderId','relatedOperationId','amountCents','currency']
      WHEN 'actor' THEN ARRAY['actorId','actorKind']
      WHEN 'release' THEN ARRAY['manifestDigest','releaseId','revision','environment','authenticationStatus']
      ELSE ARRAY['schemaVersion','operationKind','operationId','providerKind','idempotencyKey','providerExpectedVersion','requestSha256','evidence','actor','release'] END;
    IF pg_catalog.jsonb_typeof(group_value) IS DISTINCT FROM 'object'
       OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(group_value)) <> pg_catalog.cardinality(group_keys)
       OR NOT (group_value ?& group_keys) THEN
      RAISE EXCEPTION 'HXUV1-FINREQ-13-COMMAND_IDENTITY_INVALID';
    END IF;
    rebuilt := '';
    FOREACH field_name IN ARRAY group_keys LOOP
      field_value := group_value -> field_name;
      IF group_name = 'root' AND field_name IN ('evidence','actor','release') THEN
        rebuilt := rebuilt || CASE WHEN rebuilt = '' THEN '' ELSE ',' END
          || pg_catalog.to_json(field_name)::TEXT || ':' || (groups ->> field_name);
        CONTINUE;
      END IF;
      IF field_value = 'null'::JSONB AND group_name = 'evidence' THEN NULL;
      ELSIF field_name IN ('schemaVersion','providerExpectedVersion','amountCents') THEN
        IF pg_catalog.jsonb_typeof(field_value) IS DISTINCT FROM 'number'
           OR field_value::TEXT !~ '^(0|[1-9][0-9]*)$'
           OR (field_value::TEXT)::NUMERIC > 9007199254740991 THEN
          RAISE EXCEPTION 'HXUV1-FINREQ-13-COMMAND_IDENTITY_INVALID';
        END IF;
      ELSIF pg_catalog.jsonb_typeof(field_value) IS DISTINCT FROM 'string' THEN
        RAISE EXCEPTION 'HXUV1-FINREQ-13-COMMAND_IDENTITY_INVALID';
      END IF;
      rebuilt := rebuilt || CASE WHEN rebuilt = '' THEN '' ELSE ',' END
        || pg_catalog.to_json(field_name)::TEXT || ':' || field_value::TEXT;
    END LOOP;
    groups := groups || pg_catalog.jsonb_build_object(group_name, '{' || rebuilt || '}');
  END LOOP;
  IF groups ->> 'root' IS DISTINCT FROM p_identity
     OR identity -> 'schemaVersion' IS DISTINCT FROM '1'::JSONB
     OR identity ->> 'providerKind' IS DISTINCT FROM 'FAKE'
     OR identity #>> '{actor,actorKind}' IS DISTINCT FROM 'PARTICIPANT'
     OR identity #>> '{release,authenticationStatus}' IS DISTINCT FROM 'VERIFIED'
     OR identity #>> '{release,environment}' NOT IN ('local','preview','staging')
     OR identity #>> '{evidence,preparedFinancialCommandId}' IS NULL
     OR identity #>> '{evidence,preparedAuthoritySha256}' IS NULL THEN
    RAISE EXCEPTION 'HXUV1-FINREQ-13-COMMAND_IDENTITY_INVALID';
  END IF;
  IF identity #>> '{actor,actorId}' !~ uuid_pattern
     OR identity #>> '{actor,actorId}' IS DISTINCT FROM pg_catalog.lower(identity #>> '{actor,actorId}')
     OR identity #>> '{evidence,preparedAuthoritySha256}' !~ '^[a-f0-9]{64}$'
     OR identity #>> '{release,manifestDigest}' !~ '^sha256:[a-f0-9]{64}$'
     OR identity #>> '{release,manifestDigest}' = 'sha256:' || pg_catalog.repeat('0',64)
     OR identity #>> '{release,releaseId}' !~ '^[a-z0-9][a-z0-9._-]{7,127}$'
     OR identity #>> '{release,revision}' !~ '^[a-f0-9]{40}$'
     OR identity #>> '{release,revision}' = pg_catalog.repeat('0',40)
     OR ((identity #>> '{evidence,amountCents}' IS NULL) <> (identity #>> '{evidence,currency}' IS NULL))
     OR (identity #>> '{evidence,currency}' IS NOT NULL AND identity #>> '{evidence,currency}' !~ '^[A-Z]{3}$') THEN
    RAISE EXCEPTION 'HXUV1-FINREQ-13-COMMAND_IDENTITY_INVALID';
  END IF;
  FOREACH field_name IN ARRAY ARRAY['preparedFinancialCommandId','taskDraftId','taskId','workOrderId','relatedOperationId'] LOOP
    IF identity -> 'evidence' ->> field_name IS NOT NULL
       AND identity -> 'evidence' ->> field_name !~ uuid_pattern THEN
      RAISE EXCEPTION 'HXUV1-FINREQ-13-COMMAND_IDENTITY_INVALID';
    END IF;
  END LOOP;
  RETURN identity;
END;
$$;

CREATE OR REPLACE FUNCTION hx_authority.mark_fake_financial_request_transaction_v13()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
BEGIN
  NEW.requested_transaction_id := CASE WHEN NEW.provider_kind = 'FAKE'
    AND NEW.operation_kind IN ('PREPARE_PAYMENT_METHOD','AUTHORIZE','SECURE','VOID','ADJUST','CAPTURE','REFUND','REVERSAL','SETTLE','FUND','PROVIDER_RELEASE','PAYOUT','OBSERVE_BANK_SETTLEMENT')
    THEN pg_catalog.pg_current_xact_id() ELSE NULL END;
  RETURN NEW;
END;
$$;
CREATE TRIGGER fake_finance_request_transaction_v13
BEFORE INSERT ON public.financial_provider_command_journal FOR EACH ROW
EXECUTE FUNCTION hx_authority.mark_fake_financial_request_transaction_v13();

CREATE OR REPLACE FUNCTION hx_authority.validate_fake_financial_exact_request_v13()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
DECLARE
  command public.financial_provider_command_journal%ROWTYPE;
  prepared public.universal_v1_prepared_financial_commands%ROWTYPE;
  request JSONB;
  request_sha256 TEXT;
  reference_count BIGINT;
  expected_reference TEXT;
  captured_amount BIGINT;
BEGIN
  SELECT * INTO command FROM public.financial_provider_command_journal
    WHERE command_id = NEW.command_id;
  IF command.command_id IS NULL OR command.provider_kind IS DISTINCT FROM 'FAKE'
     OR command.requested_transaction_id IS DISTINCT FROM pg_catalog.pg_current_xact_id()
     OR NEW.payload_contract_version IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'HXUV1-FINREQ-13-SAME_TRANSACTION_REQUIRED';
  END IF;
  SELECT * INTO prepared FROM public.universal_v1_prepared_financial_commands
    WHERE prepared_command_id = command.prepared_financial_command_id FOR SHARE;
  request := hx_authority.parse_fake_financial_request_v13(command.operation_kind, NEW.canonical_provider_request);
  request_sha256 := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(NEW.canonical_provider_request, 'UTF8')), 'hex');
  IF request_sha256 IS DISTINCT FROM pg_catalog.btrim(command.request_sha256)
     OR request_sha256 IS DISTINCT FROM pg_catalog.btrim(prepared.provider_request_sha256)
     OR NEW.provider_request_sha256 IS DISTINCT FROM request_sha256
     OR (request ->> 'operationId')::UUID IS DISTINCT FROM command.operation_id
     OR request ->> 'idempotencyKey' IS DISTINCT FROM command.idempotency_key
     OR (request ->> 'expectedVersion')::BIGINT IS DISTINCT FROM command.provider_expected_version
     OR NOT EXISTS (SELECT 1 FROM hx_authority.fake_financial_command_outbox_requests_v13 outbox
       WHERE outbox.command_id = command.command_id
         AND outbox.provider_request_sha256 = request_sha256) THEN
    RAISE EXCEPTION 'HXUV1-FINREQ-13-PREPARED_OR_REQUEST_MISMATCH';
  END IF;
  IF command.operation_kind <> 'PREPARE_PAYMENT_METHOD' AND (
    (request ->> 'amountCents')::BIGINT IS DISTINCT FROM prepared.amount_cents
    OR pg_catalog.upper(request ->> 'currency') IS DISTINCT FROM prepared.currency
    OR (request ->> 'relatedOperationId')::UUID IS DISTINCT FROM prepared.related_operation_id
  ) THEN RAISE EXCEPTION 'HXUV1-FINREQ-13-EFFECT_MISMATCH'; END IF;
  IF command.operation_kind = 'SECURE'
     AND (request ->> 'authorizationOperationId')::UUID IS DISTINCT FROM prepared.related_operation_id THEN
    RAISE EXCEPTION 'HXUV1-FINREQ-13-AUTHORIZATION_MISMATCH';
  END IF;
  IF command.operation_kind = 'ADJUST' AND (
    (request ->> 'scopeVersionId')::UUID IS DISTINCT FROM prepared.scope_version_id
    OR (request ->> 'changeOrderId')::UUID IS DISTINCT FROM prepared.change_order_id
  ) THEN RAISE EXCEPTION 'HXUV1-FINREQ-13-ADJUSTMENT_MISMATCH'; END IF;
  IF command.operation_kind = 'AUTHORIZE' THEN
    SELECT pg_catalog.count(*), pg_catalog.min(event.external_reference)
      INTO reference_count, expected_reference FROM public.task_financial_security_events event
      WHERE event.operation_id = prepared.related_operation_id::TEXT
        AND event.provider_kind = 'FAKE' AND event.event_kind = 'PAYMENT_METHOD_PREPARED'
        AND event.status = 'SUCCEEDED' AND event.task_draft_id = prepared.task_draft_id
        AND ((event.task_id IS NOT DISTINCT FROM prepared.task_id
              AND event.eligibility_decision_id IS NOT DISTINCT FROM prepared.eligibility_decision_id)
          OR (event.task_id IS NULL AND event.eligibility_decision_id IS NULL AND event.scope_version_id IS NULL));
    IF reference_count <> 1 OR request ->> 'paymentMethodReference' IS DISTINCT FROM expected_reference THEN
      RAISE EXCEPTION 'HXUV1-FINREQ-13-PAYMENT_METHOD_MISMATCH';
    END IF;
  END IF;
  IF command.operation_kind = 'REFUND' THEN
    SELECT event.amount_cents INTO captured_amount FROM public.task_financial_security_events event
      WHERE event.task_draft_id = prepared.task_draft_id
        AND event.task_id IS NOT DISTINCT FROM prepared.task_id
        AND event.eligibility_decision_id IS NOT DISTINCT FROM prepared.eligibility_decision_id
        AND event.scope_version_id IS NOT DISTINCT FROM prepared.scope_version_id
        AND event.event_kind = 'CAPTURED' AND event.status = 'SUCCEEDED'
        AND event.provider_kind = 'FAKE' AND event.currency = prepared.currency
      ORDER BY event.expected_version DESC LIMIT 1;
    IF captured_amount IS NULL OR (request ->> 'originalAmountCents')::BIGINT IS DISTINCT FROM captured_amount THEN
      RAISE EXCEPTION 'HXUV1-FINREQ-13-CAPTURE_AMOUNT_MISMATCH';
    END IF;
  END IF;
  -- PREPARE's generic customer reference is authorized by the exact PREPARED
  -- hash. Terminal SUCCESS and payout account references retain the existing
  -- terminal PREPARED guard's exact request hash and account authority checks.
  NEW.provider_request_sha256 := request_sha256;
  NEW.recorded_transaction_id := pg_catalog.pg_current_xact_id();
  NEW.recorded_at := pg_catalog.clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER fake_finance_exact_request_validate_v13
BEFORE INSERT ON hx_authority.fake_financial_exact_requests_v13 FOR EACH ROW
EXECUTE FUNCTION hx_authority.validate_fake_financial_exact_request_v13();
CREATE TRIGGER fake_finance_exact_request_append_only_v13
BEFORE UPDATE OR DELETE ON hx_authority.fake_financial_exact_requests_v13 FOR EACH ROW
EXECUTE FUNCTION hx_authority.reject_fake_financial_outbox_mutation_v13();
CREATE TRIGGER fake_finance_exact_request_no_truncate_v13
BEFORE TRUNCATE ON hx_authority.fake_financial_exact_requests_v13 FOR EACH STATEMENT
EXECUTE FUNCTION hx_authority.reject_fake_financial_outbox_mutation_v13();

CREATE OR REPLACE FUNCTION hx_authority.require_fake_financial_exact_request_v13()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.requested_transaction_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM hx_authority.fake_financial_exact_requests_v13 request
      WHERE request.command_id = NEW.command_id
        AND request.provider_request_sha256 = NEW.request_sha256
        AND request.recorded_transaction_id = NEW.requested_transaction_id
  ) THEN RAISE EXCEPTION 'HXUV1-FINREQ-13-EXACT_REQUEST_REQUIRED'; END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER fake_finance_exact_request_commit_v13
AFTER INSERT ON public.financial_provider_command_journal
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION hx_authority.require_fake_financial_exact_request_v13();

CREATE OR REPLACE FUNCTION public.hxos_request_fake_financial_command_v13(
  p_canonical_provider_request TEXT, p_canonical_command_identity TEXT
)
RETURNS TABLE (
  command_id UUID, operation_kind TEXT, operation_id UUID, provider_kind TEXT,
  idempotency_key TEXT, provider_expected_version BIGINT, request_sha256 TEXT,
  command_identity_sha256 TEXT, prepared_financial_command_id UUID,
  prepared_authority_sha256 TEXT, recorded_at TIMESTAMPTZ, idempotency_replayed BOOLEAN
)
LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
DECLARE
  identity JSONB;
  request JSONB;
  identity_sha256 TEXT;
  provider_sha256 TEXT;
  command public.financial_provider_command_journal%ROWTYPE;
  lock_name TEXT;
  replay BOOLEAN := FALSE;
  conflict_reason TEXT;
  outbox RECORD;
BEGIN
  identity := hx_authority.parse_fake_financial_identity_v13(p_canonical_command_identity);
  request := hx_authority.parse_fake_financial_request_v13(identity ->> 'operationKind', p_canonical_provider_request);
  identity_sha256 := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_canonical_command_identity,'UTF8')), 'hex');
  provider_sha256 := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_canonical_provider_request,'UTF8')), 'hex');
  IF identity ->> 'requestSha256' IS DISTINCT FROM provider_sha256
     OR identity ->> 'operationId' IS DISTINCT FROM ((request ->> 'operationId')::UUID)::TEXT
     OR identity -> 'idempotencyKey' IS DISTINCT FROM request -> 'idempotencyKey'
     OR identity -> 'providerExpectedVersion' IS DISTINCT FROM request -> 'expectedVersion' THEN
    RAISE EXCEPTION 'HXUV1-FINREQ-13-COMMAND_REQUEST_MISMATCH';
  END IF;
  FOR lock_name IN SELECT value FROM pg_catalog.unnest(ARRAY[
    'idempotency:' || (identity ->> 'idempotencyKey'),
    'operation-version:FAKE:' || (identity ->> 'operationKind') || ':' || (identity ->> 'operationId') || ':' || (identity ->> 'providerExpectedVersion')
  ]) locks(value) ORDER BY value COLLATE "C" LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('financial-provider-command-journal-v1'), pg_catalog.hashtext(lock_name));
  END LOOP;
  SELECT stored.* INTO command FROM public.financial_provider_command_journal stored
    WHERE stored.idempotency_key = identity ->> 'idempotencyKey';
  conflict_reason := 'HXUV1-FINREQ-13-IDEMPOTENCY_CONFLICT';
  IF command.command_id IS NULL THEN
    SELECT stored.* INTO command FROM public.financial_provider_command_journal stored
      WHERE stored.provider_kind = 'FAKE' AND stored.operation_kind = identity ->> 'operationKind'
        AND stored.operation_id = (identity ->> 'operationId')::UUID
        AND stored.provider_expected_version = (identity ->> 'providerExpectedVersion')::BIGINT;
    conflict_reason := 'HXUV1-FINREQ-13-OPERATION_VERSION_CONFLICT';
  END IF;
  IF command.command_id IS NOT NULL THEN
    IF pg_catalog.btrim(command.command_identity_sha256) IS DISTINCT FROM identity_sha256 THEN
      RAISE EXCEPTION '%', conflict_reason;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM hx_authority.fake_financial_exact_requests_v13 exact_request
      WHERE exact_request.command_id = command.command_id
        AND exact_request.canonical_provider_request = p_canonical_provider_request
        AND exact_request.provider_request_sha256 = provider_sha256) THEN
      RAISE EXCEPTION 'HXUV1-FINREQ-13-REPLAY_REQUEST_MISSING';
    END IF;
    replay := TRUE;
  ELSE
    INSERT INTO public.financial_provider_command_journal (
      operation_kind, operation_id, provider_kind, idempotency_key, provider_expected_version,
      request_sha256, command_identity_sha256, prepared_financial_command_id, prepared_authority_sha256,
      task_draft_id, task_id, work_order_id, related_operation_id, amount_cents, currency,
      recorded_actor_id, recorded_actor_kind, release_manifest_digest, release_id, release_revision,
      release_environment, release_authentication_status
    ) VALUES (
      identity ->> 'operationKind', (identity ->> 'operationId')::UUID, 'FAKE', identity ->> 'idempotencyKey',
      (identity ->> 'providerExpectedVersion')::BIGINT, provider_sha256, identity_sha256,
      (identity #>> '{evidence,preparedFinancialCommandId}')::UUID, identity #>> '{evidence,preparedAuthoritySha256}',
      (identity #>> '{evidence,taskDraftId}')::UUID, (identity #>> '{evidence,taskId}')::UUID,
      (identity #>> '{evidence,workOrderId}')::UUID, (identity #>> '{evidence,relatedOperationId}')::UUID,
      (identity #>> '{evidence,amountCents}')::BIGINT, identity #>> '{evidence,currency}',
      (identity #>> '{actor,actorId}')::UUID, identity #>> '{actor,actorKind}',
      identity #>> '{release,manifestDigest}', identity #>> '{release,releaseId}', identity #>> '{release,revision}',
      identity #>> '{release,environment}', identity #>> '{release,authenticationStatus}'
    ) RETURNING * INTO command;
    INSERT INTO hx_authority.fake_financial_exact_requests_v13 (
      command_id, canonical_provider_request, provider_request_sha256
    ) VALUES (command.command_id, p_canonical_provider_request, provider_sha256);
  END IF;
  SELECT * INTO outbox FROM hx_authority.fake_financial_command_outbox_requests_v13 queued
    WHERE queued.command_id = command.command_id;
  IF outbox.outbox_request_id IS NULL THEN RAISE EXCEPTION 'HXUV1-FINREQ-13-OUTBOX_MISSING'; END IF;
  PERFORM hx_authority.assert_fake_financial_outbox_target_v13(outbox.target_authority_id,
    outbox.target_database_name, outbox.release_environment, outbox.release_manifest_digest);
  RETURN QUERY SELECT command.command_id, command.operation_kind, command.operation_id,
    command.provider_kind, command.idempotency_key, command.provider_expected_version,
    pg_catalog.btrim(command.request_sha256), pg_catalog.btrim(command.command_identity_sha256),
    command.prepared_financial_command_id, pg_catalog.btrim(command.prepared_authority_sha256),
    command.recorded_at, replay;
END;
$$;

COMMENT ON TABLE hx_authority.fake_financial_exact_requests_v13 IS
  'Immutable canonical FAKE request bytes captured in the REQUESTED creation transaction. Owner-only table access; ID-only queue transport; no late fill, provider capability, or production effect.';


CREATE OR REPLACE FUNCTION hx_authority.validate_fake_financial_outbox_disposition_v13()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
DECLARE
  request_record RECORD;
  current_tip RECORD;
  current_tip_count INTEGER;
BEGIN
  -- A superseded target may also have terminal publication evidence; recording
  -- its disposition does not reopen it. Only isolation and lock order apply.
  PERFORM hx_authority.assert_fake_financial_publish_open_v13(NULL);
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('hxuv1-work-order-target-authority-v1', 0)
  );
  SELECT request.target_authority_id
    INTO request_record
    FROM hx_authority.fake_financial_command_outbox_requests_v13 request
   WHERE request.outbox_request_id = NEW.outbox_request_id
   FOR SHARE;
  SELECT pg_catalog.count(*)::INTEGER
    INTO current_tip_count
    FROM hx_authority.universal_v1_work_order_target_authority_facts target
   WHERE NOT EXISTS (
     SELECT 1
       FROM hx_authority.universal_v1_work_order_target_authority_facts successor
      WHERE successor.supersedes_target_authority_id = target.target_authority_id
   );
  IF current_tip_count <> 1 THEN
    RAISE EXCEPTION
      'HXUV1-FINOUT-13-13A: disposition requires one current target'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT target.target_authority_id,
         target.authority_version,
         target.target_database_name,
         target.environment,
         target.release_manifest_sha256
    INTO current_tip
    FROM hx_authority.universal_v1_work_order_target_authority_facts target
   WHERE NOT EXISTS (
     SELECT 1
       FROM hx_authority.universal_v1_work_order_target_authority_facts successor
      WHERE successor.supersedes_target_authority_id = target.target_authority_id
   )
   FOR SHARE;
  IF request_record.target_authority_id IS NULL
     OR request_record.target_authority_id IS NOT DISTINCT FROM
          current_tip.target_authority_id
     OR NEW.disposition_kind IS DISTINCT FROM 'TARGET_SUPERSEDED'
     OR NEW.superseded_target_authority_id IS DISTINCT FROM
          request_record.target_authority_id
     OR NEW.replacement_target_authority_id IS DISTINCT FROM
          current_tip.target_authority_id
     OR NEW.replacement_target_authority_version IS DISTINCT FROM
          current_tip.authority_version
     OR NEW.replacement_database_name IS DISTINCT FROM
          current_tip.target_database_name
     OR NEW.replacement_database_name IS DISTINCT FROM pg_catalog.current_database()
     OR NEW.replacement_environment IS DISTINCT FROM current_tip.environment
     OR NEW.replacement_environment NOT IN ('local', 'preview', 'staging')
     OR NEW.replacement_manifest_digest IS DISTINCT FROM
          current_tip.release_manifest_sha256 THEN
    RAISE EXCEPTION
      'HXUV1-FINOUT-13-13B: TARGET_SUPERSEDED disposition is stale or mismatched'
      USING ERRCODE = 'P0001';
  END IF;
  NEW.disposed_at := pg_catalog.clock_timestamp();
  NEW.disposition_identity_sha256 := hx_authority.fake_financial_job_digest_v13(
    ARRAY[
      'HXUV1_FAKE_FINANCIAL_OUTBOX_DISPOSITION_V13',
      NEW.outbox_disposition_id::TEXT,
      NEW.outbox_request_id::TEXT,
      NEW.disposition_kind,
      NEW.superseded_target_authority_id::TEXT,
      NEW.replacement_target_authority_id::TEXT,
      NEW.replacement_target_authority_version::TEXT,
      NEW.replacement_database_name,
      NEW.replacement_environment,
      NEW.replacement_manifest_digest
    ]::TEXT[]
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER fake_finance_outbox_disposition_validate_v13
BEFORE INSERT ON hx_authority.fake_financial_outbox_dispositions_v13
FOR EACH ROW
EXECUTE FUNCTION hx_authority.validate_fake_financial_outbox_disposition_v13();

CREATE OR REPLACE FUNCTION hx_authority.assert_fake_financial_publish_open_v13(
  p_outbox_request_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
BEGIN
  -- The same publisher lock serializes holds, acknowledgements and admission.
  -- Acquire it before target and command locks on every public entry path.
  -- An advisory lock cannot refresh REPEATABLE READ or SERIALIZABLE snapshots.
  IF pg_catalog.current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN
    RAISE EXCEPTION 'HXUV1-FINOUT-13-45: publication requires READ COMMITTED'
      USING ERRCODE = 'P0001';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('hxuv1-fake-finance-publisher-v13', 0)
  );
  IF p_outbox_request_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM hx_authority.fake_financial_command_outbox_requests_v13 outbox
      JOIN hx_authority.fake_financial_exact_requests_v13 exact_request
        ON exact_request.command_id = outbox.command_id
       AND exact_request.provider_request_sha256 = outbox.provider_request_sha256
     WHERE outbox.outbox_request_id = p_outbox_request_id
  ) THEN
    RAISE EXCEPTION 'HXUV1-FINREQ-13-EXACT_REQUEST_REQUIRED';
  END IF;
  IF EXISTS (
    SELECT 1 FROM hx_authority.fake_financial_publish_exhaustions_v13 exhausted
     WHERE exhausted.outbox_request_id = p_outbox_request_id
  ) OR EXISTS (
    SELECT 1 FROM hx_authority.fake_financial_outbox_dispositions_v13 disposition
     WHERE disposition.outbox_request_id = p_outbox_request_id
  ) OR EXISTS (
    SELECT 1 FROM hx_authority.fake_financial_outbox_publish_outcomes_v13 outcome
     WHERE outcome.outbox_request_id = p_outbox_request_id
       AND outcome.outcome_kind = 'TERMINAL_FAILURE'
  ) THEN
    RAISE EXCEPTION 'HXUV1-FINOUT-13-42: publication is terminally held'
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION hx_authority.validate_fake_financial_publish_exhaustion_v13()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
DECLARE
  request_record RECORD;
  latest_claim RECORD;
  latest_outcome RECORD;
  authority_now TIMESTAMPTZ;
BEGIN
  PERFORM hx_authority.assert_fake_financial_publish_open_v13(NEW.outbox_request_id);
  SELECT request.* INTO request_record
    FROM hx_authority.fake_financial_command_outbox_requests_v13 request
   WHERE request.outbox_request_id = NEW.outbox_request_id FOR SHARE;
  IF request_record.outbox_request_id IS NULL THEN
    RAISE EXCEPTION 'HXUV1-FINOUT-13-43: exhaustion request does not exist'
      USING ERRCODE = 'P0001';
  END IF;
  PERFORM hx_authority.assert_fake_financial_outbox_target_v13(
    request_record.target_authority_id, request_record.target_database_name,
    request_record.release_environment, request_record.release_manifest_digest
  );
  authority_now := pg_catalog.clock_timestamp();
  SELECT claim.publish_claim_id, claim.claim_number, claim.lease_expires_at
    INTO latest_claim
    FROM hx_authority.fake_financial_outbox_publish_claims_v13 claim
   WHERE claim.outbox_request_id = NEW.outbox_request_id
   ORDER BY claim.claim_number DESC LIMIT 1;
  SELECT outcome.outcome_kind, outcome.retry_not_before INTO latest_outcome
    FROM hx_authority.fake_financial_outbox_publish_outcomes_v13 outcome
   WHERE outcome.publish_claim_id = latest_claim.publish_claim_id;
  IF latest_claim.claim_number IS DISTINCT FROM 64
     OR NEW.final_claim_number IS DISTINCT FROM 64
     OR NEW.final_publish_claim_id IS DISTINCT FROM latest_claim.publish_claim_id
     OR (
       (latest_outcome.outcome_kind IS NULL AND latest_claim.lease_expires_at <= authority_now)
       OR (latest_outcome.outcome_kind IS NOT DISTINCT FROM 'RETRYABLE_FAILURE'
           AND latest_outcome.retry_not_before <= authority_now)
     ) IS NOT TRUE THEN
    RAISE EXCEPTION 'HXUV1-FINOUT-13-44: exhaustion requires the exact due final publisher claim'
      USING ERRCODE = 'P0001';
  END IF;
  NEW.recorded_at := authority_now;
  NEW.exhaustion_identity_sha256 := hx_authority.fake_financial_job_digest_v13(ARRAY[
    'HXUV1_FAKE_FINANCIAL_PUBLISH_EXHAUSTION_V13',
    NEW.publish_exhaustion_id::TEXT, NEW.outbox_request_id::TEXT,
    NEW.final_publish_claim_id::TEXT, NEW.final_claim_number::TEXT,
    NEW.reason, request_record.command_id::TEXT,
    pg_catalog.btrim(request_record.job_authority_sha256)
  ]::TEXT[]);
  RETURN NEW;
END;
$$;

CREATE TRIGGER fake_finance_publish_exhaustion_validate_v13
BEFORE INSERT ON hx_authority.fake_financial_publish_exhaustions_v13
FOR EACH ROW EXECUTE FUNCTION hx_authority.validate_fake_financial_publish_exhaustion_v13();
CREATE TRIGGER fake_finance_publish_exhaustion_append_only_v13
BEFORE UPDATE OR DELETE ON hx_authority.fake_financial_publish_exhaustions_v13
FOR EACH ROW EXECUTE FUNCTION hx_authority.reject_fake_financial_outbox_mutation_v13();
CREATE TRIGGER fake_finance_publish_exhaustion_no_truncate_v13
BEFORE TRUNCATE ON hx_authority.fake_financial_publish_exhaustions_v13
FOR EACH STATEMENT EXECUTE FUNCTION hx_authority.reject_fake_financial_outbox_mutation_v13();

CREATE OR REPLACE FUNCTION hx_authority.validate_fake_financial_publish_claim_v13()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
DECLARE
  request_record RECORD;
  latest_claim RECORD;
  latest_outcome RECORD;
  expected_claim_number INTEGER;
  requested_lease_duration INTERVAL;
  authority_now TIMESTAMPTZ;
BEGIN
  PERFORM hx_authority.assert_fake_financial_publish_open_v13(NEW.outbox_request_id);
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('hxuv1-fake-finance-publisher-v13', 0)
  );
  authority_now := pg_catalog.clock_timestamp();
  requested_lease_duration := NEW.lease_expires_at - NEW.claimed_at;
  IF requested_lease_duration < INTERVAL '1 second'
     OR requested_lease_duration > INTERVAL '5 minutes' THEN
    RAISE EXCEPTION
      'HXUV1-FINOUT-13-14: publisher lease duration is outside its bound'
      USING ERRCODE = 'P0001';
  END IF;
  NEW.claimed_at := authority_now;
  NEW.lease_expires_at := authority_now + requested_lease_duration;

  SELECT request.target_authority_id,
         request.target_database_name,
         request.release_environment,
         request.release_manifest_digest,
         request.job_authority_sha256,
         request.bullmq_job_id
    INTO request_record
    FROM hx_authority.fake_financial_command_outbox_requests_v13 request
   WHERE request.outbox_request_id = NEW.outbox_request_id
   FOR SHARE;
  IF request_record.target_authority_id IS NULL THEN
    RAISE EXCEPTION 'HXUV1-FINOUT-13-15: outbox request does not exist'
      USING ERRCODE = 'P0001';
  END IF;
  PERFORM hx_authority.assert_fake_financial_outbox_target_v13(
    request_record.target_authority_id,
    request_record.target_database_name,
    request_record.release_environment,
    request_record.release_manifest_digest
  );

  SELECT claim.publish_claim_id,
         claim.claim_number,
         claim.lease_expires_at
    INTO latest_claim
    FROM hx_authority.fake_financial_outbox_publish_claims_v13 claim
   WHERE claim.outbox_request_id = NEW.outbox_request_id
   ORDER BY claim.claim_number DESC
   LIMIT 1;
  IF latest_claim.publish_claim_id IS NOT NULL THEN
    SELECT outcome.outcome_kind,
           outcome.retry_not_before
      INTO latest_outcome
      FROM hx_authority.fake_financial_outbox_publish_outcomes_v13 outcome
     WHERE outcome.publish_claim_id = latest_claim.publish_claim_id;
    IF latest_outcome.outcome_kind IN ('BULLMQ_CONFIRMED', 'TERMINAL_FAILURE')
       OR (
         latest_outcome.outcome_kind = 'RETRYABLE_FAILURE'
         AND latest_outcome.retry_not_before > authority_now
       ) OR (
         latest_outcome.outcome_kind IS NULL
         AND latest_claim.lease_expires_at > authority_now
       ) THEN
      RAISE EXCEPTION 'HXUV1-FINOUT-13-16: outbox request is not due'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  SELECT COALESCE(pg_catalog.max(claim.claim_number), 0) + 1
    INTO expected_claim_number
    FROM hx_authority.fake_financial_outbox_publish_claims_v13 claim
   WHERE claim.outbox_request_id = NEW.outbox_request_id;
  IF NEW.claim_number <> expected_claim_number OR expected_claim_number > 64 THEN
    RAISE EXCEPTION 'HXUV1-FINOUT-13-17: publisher claim sequence mismatch'
      USING ERRCODE = 'P0001';
  END IF;

  NEW.claim_identity_sha256 := hx_authority.fake_financial_job_digest_v13(
    ARRAY[
      'HXUV1_FAKE_FINANCIAL_PUBLISH_CLAIM_V13',
      NEW.publish_claim_id::TEXT,
      NEW.outbox_request_id::TEXT,
      NEW.claim_number::TEXT,
      NEW.publisher_instance_id::TEXT,
      NEW.lease_duration_seconds::TEXT,
      pg_catalog.btrim(request_record.job_authority_sha256),
      request_record.bullmq_job_id
    ]::TEXT[]
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER fake_finance_publish_claim_validate_v13
BEFORE INSERT ON hx_authority.fake_financial_outbox_publish_claims_v13
FOR EACH ROW
EXECUTE FUNCTION hx_authority.validate_fake_financial_publish_claim_v13();

CREATE OR REPLACE FUNCTION hx_authority.claim_fake_financial_outbox_v13(
  publisher_instance_id UUID,
  lease_duration_seconds INTEGER
)
RETURNS TABLE (
  publish_claim_id UUID,
  outbox_request_id UUID,
  command_id UUID,
  bullmq_job_id TEXT,
  queue_name TEXT,
  job_name TEXT,
  job_payload JSONB,
  job_authority_sha256 TEXT,
  claim_number INTEGER,
  lease_expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY INVOKER
VOLATILE
PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
DECLARE
  request_record RECORD;
  current_tip RECORD;
  current_tip_count INTEGER;
  new_claim_id UUID;
  next_claim_number INTEGER;
  authority_now TIMESTAMPTZ;
BEGIN
  IF publisher_instance_id IS NULL
     OR lease_duration_seconds NOT BETWEEN 1 AND 300 THEN
    RAISE EXCEPTION 'HXUV1-FINOUT-13-18: invalid publisher claim input'
      USING ERRCODE = 'P0001';
  END IF;
  -- Validate isolation and acquire the shared publisher lock before selecting
  -- requests or recording any terminal disposition. NULL checks no one request.
  PERFORM hx_authority.assert_fake_financial_publish_open_v13(NULL);
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('hxuv1-fake-finance-publisher-v13', 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('hxuv1-work-order-target-authority-v1', 0)
  );
  authority_now := pg_catalog.clock_timestamp();

  SELECT pg_catalog.count(*)::INTEGER
    INTO current_tip_count
    FROM hx_authority.universal_v1_work_order_target_authority_facts target
   WHERE NOT EXISTS (
     SELECT 1
       FROM hx_authority.universal_v1_work_order_target_authority_facts successor
      WHERE successor.supersedes_target_authority_id = target.target_authority_id
   );
  IF current_tip_count <> 1 THEN
    RAISE EXCEPTION
      'HXUV1-FINOUT-13-18A: publisher requires one exact current target'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT target.target_authority_id,
         target.authority_version,
         target.target_database_name,
         target.environment,
         target.release_manifest_sha256
    INTO current_tip
    FROM hx_authority.universal_v1_work_order_target_authority_facts target
   WHERE NOT EXISTS (
     SELECT 1
       FROM hx_authority.universal_v1_work_order_target_authority_facts successor
      WHERE successor.supersedes_target_authority_id = target.target_authority_id
   )
   FOR SHARE;
  PERFORM hx_authority.assert_fake_financial_outbox_target_v13(
    current_tip.target_authority_id,
    current_tip.target_database_name,
    current_tip.environment,
    current_tip.release_manifest_sha256
  );

  INSERT INTO hx_authority.fake_financial_outbox_dispositions_v13 (
    outbox_request_id,
    disposition_kind,
    superseded_target_authority_id,
    replacement_target_authority_id,
    replacement_target_authority_version,
    replacement_database_name,
    replacement_environment,
    replacement_manifest_digest,
    disposition_identity_sha256
  )
  SELECT request.outbox_request_id,
         'TARGET_SUPERSEDED',
         request.target_authority_id,
         current_tip.target_authority_id,
         current_tip.authority_version,
         current_tip.target_database_name,
         current_tip.environment,
         current_tip.release_manifest_sha256,
         pg_catalog.repeat('0', 64)
    FROM hx_authority.fake_financial_command_outbox_requests_v13 request
    JOIN hx_authority.fake_financial_exact_requests_v13 exact_request
      ON exact_request.command_id = request.command_id
     AND exact_request.provider_request_sha256 = request.provider_request_sha256
    LEFT JOIN hx_authority.fake_financial_outbox_dispositions_v13 disposition
      ON disposition.outbox_request_id = request.outbox_request_id
    LEFT JOIN LATERAL (
      SELECT claim.publish_claim_id,
             claim.lease_expires_at
        FROM hx_authority.fake_financial_outbox_publish_claims_v13 claim
       WHERE claim.outbox_request_id = request.outbox_request_id
       ORDER BY claim.claim_number DESC
       LIMIT 1
    ) latest_claim ON TRUE
    LEFT JOIN LATERAL (
      SELECT outcome.outcome_kind,
             outcome.retry_not_before
        FROM hx_authority.fake_financial_outbox_publish_outcomes_v13 outcome
       WHERE outcome.publish_claim_id = latest_claim.publish_claim_id
    ) latest_outcome ON TRUE
   WHERE disposition.outbox_disposition_id IS NULL
     AND request.target_authority_id <> current_tip.target_authority_id
     AND (
       latest_claim.publish_claim_id IS NULL
       OR (
         latest_outcome.outcome_kind = 'RETRYABLE_FAILURE'
         AND latest_outcome.retry_not_before <= authority_now
       )
       OR (
         latest_outcome.outcome_kind IS NULL
         AND latest_claim.lease_expires_at <= authority_now
       )
     )
   ORDER BY request.requested_at, request.outbox_request_id;

  -- Exhaustion is recorded durably and never converted into a provider failure.
  -- Continue selecting other work in the same transaction instead of raising
  -- on the oldest request and starving every later command.
  INSERT INTO hx_authority.fake_financial_publish_exhaustions_v13 (
    outbox_request_id, final_publish_claim_id, exhaustion_identity_sha256
  )
  SELECT request.outbox_request_id, latest_claim.publish_claim_id, pg_catalog.repeat('0', 64)
    FROM hx_authority.fake_financial_command_outbox_requests_v13 request
    JOIN hx_authority.fake_financial_exact_requests_v13 exact_request
      ON exact_request.command_id = request.command_id
     AND exact_request.provider_request_sha256 = request.provider_request_sha256
    JOIN LATERAL (
      SELECT claim.publish_claim_id, claim.claim_number, claim.lease_expires_at
        FROM hx_authority.fake_financial_outbox_publish_claims_v13 claim
       WHERE claim.outbox_request_id = request.outbox_request_id
       ORDER BY claim.claim_number DESC LIMIT 1
    ) latest_claim ON latest_claim.claim_number = 64
    LEFT JOIN hx_authority.fake_financial_outbox_publish_outcomes_v13 latest_outcome
      ON latest_outcome.publish_claim_id = latest_claim.publish_claim_id
   WHERE request.target_authority_id = current_tip.target_authority_id
     AND NOT EXISTS (
       SELECT 1 FROM hx_authority.fake_financial_outbox_dispositions_v13 disposition
        WHERE disposition.outbox_request_id = request.outbox_request_id
     )
     AND NOT EXISTS (
       SELECT 1 FROM hx_authority.fake_financial_publish_exhaustions_v13 exhausted
        WHERE exhausted.outbox_request_id = request.outbox_request_id
     )
     AND (
       (latest_outcome.outcome_kind IS NULL AND latest_claim.lease_expires_at <= authority_now)
       OR (latest_outcome.outcome_kind = 'RETRYABLE_FAILURE'
           AND latest_outcome.retry_not_before <= authority_now)
     )
   ORDER BY request.requested_at, request.outbox_request_id;

  SELECT request.*
    INTO request_record
    FROM hx_authority.fake_financial_command_outbox_requests_v13 request
    JOIN hx_authority.fake_financial_exact_requests_v13 exact_request
      ON exact_request.command_id = request.command_id
     AND exact_request.provider_request_sha256 = request.provider_request_sha256
    LEFT JOIN hx_authority.fake_financial_outbox_dispositions_v13 disposition
      ON disposition.outbox_request_id = request.outbox_request_id
    LEFT JOIN LATERAL (
      SELECT claim.publish_claim_id,
             claim.lease_expires_at
        FROM hx_authority.fake_financial_outbox_publish_claims_v13 claim
       WHERE claim.outbox_request_id = request.outbox_request_id
       ORDER BY claim.claim_number DESC
       LIMIT 1
    ) latest_claim ON TRUE
    LEFT JOIN LATERAL (
      SELECT outcome.outcome_kind,
             outcome.retry_not_before
        FROM hx_authority.fake_financial_outbox_publish_outcomes_v13 outcome
       WHERE outcome.publish_claim_id = latest_claim.publish_claim_id
    ) latest_outcome ON TRUE
   WHERE disposition.outbox_disposition_id IS NULL
     AND request.target_authority_id = current_tip.target_authority_id
     AND NOT EXISTS (
       SELECT 1 FROM hx_authority.fake_financial_publish_exhaustions_v13 exhausted
        WHERE exhausted.outbox_request_id = request.outbox_request_id
     )
     AND (
       latest_claim.publish_claim_id IS NULL
       OR (
         latest_outcome.outcome_kind = 'RETRYABLE_FAILURE'
         AND latest_outcome.retry_not_before <= authority_now
       )
       OR (
         latest_outcome.outcome_kind IS NULL
         AND latest_claim.lease_expires_at <= authority_now
       )
     )
   ORDER BY request.requested_at, request.outbox_request_id
   LIMIT 1;
  IF request_record.outbox_request_id IS NULL THEN
    RETURN;
  END IF;

  PERFORM hx_authority.assert_fake_financial_outbox_target_v13(
    request_record.target_authority_id,
    request_record.target_database_name,
    request_record.release_environment,
    request_record.release_manifest_digest
  );
  SELECT COALESCE(pg_catalog.max(claim.claim_number), 0) + 1
    INTO next_claim_number
    FROM hx_authority.fake_financial_outbox_publish_claims_v13 claim
   WHERE claim.outbox_request_id = request_record.outbox_request_id;
  IF next_claim_number > 64 THEN
    RAISE EXCEPTION 'HXUV1-FINOUT-13-19: publisher retry bound exhausted'
      USING ERRCODE = 'P0001';
  END IF;

  new_claim_id := pg_catalog.gen_random_uuid();
  INSERT INTO hx_authority.fake_financial_outbox_publish_claims_v13 (
    publish_claim_id,
    outbox_request_id,
    claim_number,
    publisher_instance_id,
    lease_duration_seconds,
    claimed_at,
    lease_expires_at,
    claim_identity_sha256
  ) VALUES (
    new_claim_id,
    request_record.outbox_request_id,
    next_claim_number,
    publisher_instance_id,
    lease_duration_seconds,
    authority_now,
    authority_now + pg_catalog.make_interval(secs => lease_duration_seconds),
    pg_catalog.repeat('0', 64)
  );

  RETURN QUERY SELECT
    new_claim_id,
    request_record.outbox_request_id,
    request_record.command_id,
    request_record.bullmq_job_id,
    request_record.queue_name,
    request_record.job_name,
    pg_catalog.jsonb_build_object(
      'version', request_record.payload_contract_version,
      'kind', 'UNIVERSAL_V1_FAKE_FINANCIAL_COMMAND',
      'outboxRequestId', request_record.outbox_request_id,
      'commandId', request_record.command_id,
      'jobAuthoritySha256', pg_catalog.btrim(request_record.job_authority_sha256)
    ),
    pg_catalog.btrim(request_record.job_authority_sha256),
    next_claim_number,
    authority_now + pg_catalog.make_interval(secs => lease_duration_seconds);
END;
$$;

CREATE OR REPLACE FUNCTION hx_authority.validate_fake_financial_publish_outcome_v13()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
DECLARE
  claim_record RECORD;
  request_record RECORD;
  latest_claim_id UUID;
  requested_retry_delay INTERVAL;
  authority_now TIMESTAMPTZ;
BEGIN
  NEW.recording_transaction_id := pg_catalog.pg_current_xact_id();
  PERFORM hx_authority.assert_fake_financial_publish_open_v13(NEW.outbox_request_id);
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('hxuv1-fake-finance-publisher-v13', 0)
  );
  authority_now := pg_catalog.clock_timestamp();
  IF NEW.outcome_kind = 'RETRYABLE_FAILURE' THEN
    requested_retry_delay := NEW.retry_not_before - NEW.recorded_at;
    IF requested_retry_delay < INTERVAL '1 second'
       OR requested_retry_delay > INTERVAL '1 day' THEN
      RAISE EXCEPTION 'HXUV1-FINOUT-13-20: publisher retry delay is invalid'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  NEW.recorded_at := authority_now;
  IF NEW.outcome_kind = 'RETRYABLE_FAILURE' THEN
    NEW.retry_not_before := authority_now + requested_retry_delay;
  END IF;

  SELECT claim.outbox_request_id,
         claim.claim_number
    INTO claim_record
    FROM hx_authority.fake_financial_outbox_publish_claims_v13 claim
   WHERE claim.publish_claim_id = NEW.publish_claim_id
     AND claim.outbox_request_id = NEW.outbox_request_id
   FOR SHARE;
  SELECT request.target_authority_id,
         request.target_database_name,
         request.release_environment,
         request.release_manifest_digest,
         request.bullmq_job_id,
         request.job_authority_sha256
    INTO request_record
    FROM hx_authority.fake_financial_command_outbox_requests_v13 request
   WHERE request.outbox_request_id = NEW.outbox_request_id
   FOR SHARE;
  IF claim_record.outbox_request_id IS NULL
     OR request_record.target_authority_id IS NULL THEN
    RAISE EXCEPTION 'HXUV1-FINOUT-13-21: publisher outcome lacks exact claim'
      USING ERRCODE = 'P0001';
  END IF;
  PERFORM hx_authority.assert_fake_financial_outbox_target_v13(
    request_record.target_authority_id,
    request_record.target_database_name,
    request_record.release_environment,
    request_record.release_manifest_digest
  );
  SELECT claim.publish_claim_id
    INTO latest_claim_id
    FROM hx_authority.fake_financial_outbox_publish_claims_v13 claim
   WHERE claim.outbox_request_id = NEW.outbox_request_id
   ORDER BY claim.claim_number DESC
   LIMIT 1;
  IF latest_claim_id IS DISTINCT FROM NEW.publish_claim_id
     OR EXISTS (
       SELECT 1
         FROM hx_authority.fake_financial_outbox_publish_outcomes_v13 outcome
        WHERE outcome.publish_claim_id = NEW.publish_claim_id
     ) THEN
    RAISE EXCEPTION 'HXUV1-FINOUT-13-22: publisher outcome is stale or duplicated'
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.outcome_kind = 'BULLMQ_CONFIRMED'
     AND (
       NEW.observed_bullmq_job_id IS DISTINCT FROM request_record.bullmq_job_id
       OR NEW.observed_job_authority_sha256 IS DISTINCT FROM
            request_record.job_authority_sha256
     ) THEN
    RAISE EXCEPTION 'HXUV1-FINOUT-13-23: BullMQ acknowledgement identity mismatch'
      USING ERRCODE = 'P0001';
  END IF;

  NEW.outcome_identity_sha256 := hx_authority.fake_financial_job_digest_v13(
    ARRAY[
      'HXUV1_FAKE_FINANCIAL_PUBLISH_OUTCOME_V13',
      NEW.publish_outcome_id::TEXT,
      NEW.publish_claim_id::TEXT,
      NEW.outbox_request_id::TEXT,
      NEW.outcome_kind,
      COALESCE(NEW.observed_bullmq_job_id, ''),
      COALESCE(pg_catalog.btrim(NEW.observed_job_authority_sha256), ''),
      COALESCE(NEW.failure_code, ''),
      COALESCE(NEW.retry_delay_seconds::TEXT, '')
    ]::TEXT[]
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER fake_finance_publish_outcome_validate_v13
BEFORE INSERT ON hx_authority.fake_financial_outbox_publish_outcomes_v13
FOR EACH ROW
EXECUTE FUNCTION hx_authority.validate_fake_financial_publish_outcome_v13();

CREATE OR REPLACE FUNCTION hx_authority.record_fake_financial_publish_outcome_v13(
  p_publish_claim_id UUID,
  p_outcome_kind TEXT,
  p_observed_bullmq_job_id TEXT,
  p_observed_job_authority_sha256 TEXT,
  p_failure_code TEXT,
  p_retry_delay_seconds INTEGER
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY INVOKER
VOLATILE
PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
DECLARE
  claim_record RECORD;
  new_outcome_id UUID := pg_catalog.gen_random_uuid();
  authority_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
BEGIN
  SELECT claim.outbox_request_id
    INTO claim_record
    FROM hx_authority.fake_financial_outbox_publish_claims_v13 claim
   WHERE claim.publish_claim_id = p_publish_claim_id;
  IF claim_record.outbox_request_id IS NULL THEN
    RAISE EXCEPTION 'HXUV1-FINOUT-13-24: publisher claim does not exist'
      USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO hx_authority.fake_financial_outbox_publish_outcomes_v13 (
    publish_outcome_id,
    publish_claim_id,
    outbox_request_id,
    outcome_kind,
    observed_bullmq_job_id,
    observed_job_authority_sha256,
    failure_code,
    retry_delay_seconds,
    retry_not_before,
    recorded_at,
    outcome_identity_sha256
  ) VALUES (
    new_outcome_id,
    p_publish_claim_id,
    claim_record.outbox_request_id,
    p_outcome_kind,
    p_observed_bullmq_job_id,
    p_observed_job_authority_sha256,
    p_failure_code,
    p_retry_delay_seconds,
    CASE
      WHEN p_retry_delay_seconds IS NULL
        THEN NULL
      ELSE authority_now + pg_catalog.make_interval(
        secs => p_retry_delay_seconds
      )
    END,
    authority_now,
    pg_catalog.repeat('0', 64)
  );
  RETURN new_outcome_id;
END;
$$;

CREATE OR REPLACE FUNCTION hx_authority.validate_fake_financial_dispatch_admission_v13()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
DECLARE
  request_record RECORD;
  expected_admission_number INTEGER;
BEGIN
  PERFORM hx_authority.assert_fake_financial_publish_open_v13(NEW.outbox_request_id);
  SELECT request.target_authority_id,
         request.target_database_name,
         request.release_environment,
         request.release_manifest_digest,
         request.bullmq_job_id,
         request.job_authority_sha256
    INTO request_record
    FROM hx_authority.fake_financial_command_outbox_requests_v13 request
   WHERE request.outbox_request_id = NEW.outbox_request_id
     AND request.command_id = NEW.command_id
   FOR SHARE;
  IF request_record.target_authority_id IS NULL
     OR NEW.bullmq_job_id IS DISTINCT FROM request_record.bullmq_job_id
     OR NEW.job_authority_sha256 IS DISTINCT FROM
          request_record.job_authority_sha256
     OR NOT EXISTS (
       SELECT 1
         FROM hx_authority.fake_financial_outbox_publish_claims_v13 claim
        WHERE claim.outbox_request_id = NEW.outbox_request_id
     ) THEN
    RAISE EXCEPTION
      'HXUV1-FINOUT-13-25: sealed DISPATCH admission lacks exact published job'
      USING ERRCODE = 'P0001';
  END IF;
  PERFORM hx_authority.assert_fake_financial_outbox_target_v13(
    request_record.target_authority_id,
    request_record.target_database_name,
    request_record.release_environment,
    request_record.release_manifest_digest
  );

  SELECT COALESCE(pg_catalog.max(admission.admission_number), 0) + 1
    INTO expected_admission_number
    FROM hx_authority.fake_financial_dispatch_admissions_v13 admission
   WHERE admission.outbox_request_id = NEW.outbox_request_id;
  IF NEW.admission_number <> expected_admission_number
     OR expected_admission_number > 64 THEN
    RAISE EXCEPTION 'HXUV1-FINOUT-13-26: DISPATCH admission sequence mismatch'
      USING ERRCODE = 'P0001';
  END IF;

  NEW.admitted_transaction_id :=
    pg_catalog.pg_current_xact_id()::TEXT::BIGINT;
  NEW.admitted_at := pg_catalog.clock_timestamp();
  NEW.admission_identity_sha256 := hx_authority.fake_financial_job_digest_v13(
    ARRAY[
      'HXUV1_FAKE_FINANCIAL_DISPATCH_ADMISSION_V13',
      NEW.dispatch_admission_id::TEXT,
      NEW.outbox_request_id::TEXT,
      NEW.command_id::TEXT,
      NEW.admission_number::TEXT,
      NEW.bullmq_job_id,
      pg_catalog.btrim(NEW.job_authority_sha256),
      NEW.worker_instance_id::TEXT,
      NEW.bullmq_attempt_number::TEXT,
      NEW.recovery_lease_id::TEXT,
      NEW.admitted_transaction_id::TEXT
    ]::TEXT[]
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER fake_finance_dispatch_admission_validate_v13
BEFORE INSERT ON hx_authority.fake_financial_dispatch_admissions_v13
FOR EACH ROW
EXECUTE FUNCTION hx_authority.validate_fake_financial_dispatch_admission_v13();

CREATE OR REPLACE FUNCTION hx_authority.validate_fake_financial_job_validation_v13()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
DECLARE
  request_record RECORD;
  admission_record RECORD;
  recovery_record RECORD;
  dispatch_record RECORD;
  expected_validation_number INTEGER;
BEGIN
  PERFORM hx_authority.assert_fake_financial_publish_open_v13(NEW.outbox_request_id);
  SELECT request.target_authority_id,
         request.target_database_name,
         request.release_environment,
         request.release_manifest_digest,
         request.bullmq_job_id,
         request.job_authority_sha256,
         request.provider_request_sha256
    INTO request_record
    FROM hx_authority.fake_financial_command_outbox_requests_v13 request
   WHERE request.outbox_request_id = NEW.outbox_request_id
     AND request.command_id = NEW.command_id
   FOR SHARE;
  IF request_record.target_authority_id IS NULL
     OR NEW.bullmq_job_id IS DISTINCT FROM request_record.bullmq_job_id
     OR NEW.job_authority_sha256 IS DISTINCT FROM
          request_record.job_authority_sha256
     OR NOT EXISTS (
       SELECT 1
         FROM hx_authority.fake_financial_outbox_publish_claims_v13 claim
        WHERE claim.outbox_request_id = NEW.outbox_request_id
     ) THEN
    RAISE EXCEPTION
      'HXUV1-FINOUT-13-27: forged or unpublished Redis job rejected'
      USING ERRCODE = 'P0001';
  END IF;
  PERFORM hx_authority.assert_fake_financial_outbox_target_v13(
    request_record.target_authority_id,
    request_record.target_database_name,
    request_record.release_environment,
    request_record.release_manifest_digest
  );

  SELECT admission.outbox_request_id,
         admission.worker_instance_id,
         admission.bullmq_attempt_number,
         admission.recovery_lease_id,
         admission.admitted_transaction_id
    INTO admission_record
    FROM hx_authority.fake_financial_dispatch_admissions_v13 admission
   WHERE admission.command_id = NEW.command_id
     AND admission.dispatch_admission_id = NEW.dispatch_admission_id
   FOR SHARE;
  SELECT lease.recovery_action,
         lease.lease_owner_id
    INTO recovery_record
    FROM public.financial_provider_command_recovery_leases lease
   WHERE lease.command_id = NEW.command_id
     AND lease.recovery_lease_id = NEW.recovery_lease_id
   FOR SHARE;
  SELECT attempt.recovery_lease_id,
         attempt.request_sha256
    INTO dispatch_record
    FROM public.financial_provider_command_dispatch_attempts attempt
   WHERE attempt.command_id = NEW.command_id
     AND attempt.dispatch_attempt_id = NEW.dispatch_attempt_id
   FOR SHARE;
  IF admission_record.outbox_request_id IS DISTINCT FROM NEW.outbox_request_id
     OR admission_record.worker_instance_id IS DISTINCT FROM NEW.worker_instance_id
     OR admission_record.bullmq_attempt_number IS DISTINCT FROM
          NEW.bullmq_attempt_number
     OR admission_record.recovery_lease_id IS DISTINCT FROM NEW.recovery_lease_id
     OR admission_record.admitted_transaction_id IS DISTINCT FROM
          pg_catalog.pg_current_xact_id()::TEXT::BIGINT
     OR recovery_record.recovery_action IS DISTINCT FROM 'DISPATCH'
     OR recovery_record.lease_owner_id IS DISTINCT FROM NEW.worker_instance_id
     OR dispatch_record.recovery_lease_id IS DISTINCT FROM NEW.recovery_lease_id
     OR dispatch_record.request_sha256 IS DISTINCT FROM
          request_record.provider_request_sha256 THEN
    RAISE EXCEPTION
      'HXUV1-FINOUT-13-28: job validation lacks exact DISPATCH_ATTEMPTED evidence'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(pg_catalog.max(validation.validation_number), 0) + 1
    INTO expected_validation_number
    FROM hx_authority.fake_financial_job_validations_v13 validation
   WHERE validation.outbox_request_id = NEW.outbox_request_id;
  IF NEW.validation_number <> expected_validation_number
     OR expected_validation_number > 64 THEN
    RAISE EXCEPTION 'HXUV1-FINOUT-13-29: job validation sequence mismatch'
      USING ERRCODE = 'P0001';
  END IF;

  NEW.validated_at := pg_catalog.clock_timestamp();
  NEW.validation_identity_sha256 := hx_authority.fake_financial_job_digest_v13(
    ARRAY[
      'HXUV1_FAKE_FINANCIAL_JOB_VALIDATION_V13',
      NEW.job_validation_id::TEXT,
      NEW.outbox_request_id::TEXT,
      NEW.command_id::TEXT,
      NEW.validation_number::TEXT,
      NEW.bullmq_job_id,
      pg_catalog.btrim(NEW.job_authority_sha256),
      NEW.worker_instance_id::TEXT,
      NEW.bullmq_attempt_number::TEXT,
      NEW.dispatch_admission_id::TEXT,
      NEW.recovery_lease_id::TEXT,
      NEW.dispatch_attempt_id::TEXT
    ]::TEXT[]
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER fake_finance_job_validation_validate_v13
BEFORE INSERT ON hx_authority.fake_financial_job_validations_v13
FOR EACH ROW
EXECUTE FUNCTION hx_authority.validate_fake_financial_job_validation_v13();

CREATE OR REPLACE FUNCTION hx_authority.record_fake_financial_job_dispatch_evidence_v13(
  p_outbox_request_id UUID,
  p_bullmq_job_id TEXT,
  p_job_authority_sha256 TEXT,
  p_worker_instance_id UUID,
  p_bullmq_attempt_number INTEGER,
  p_recovery_lease_duration_seconds INTEGER,
  p_outcome_timeout_seconds INTEGER
)
RETURNS TABLE (
  job_validation_id UUID,
  command_id UUID,
  recovery_lease_id UUID,
  dispatch_attempt_id UUID,
  provider_request_sha256 TEXT,
  command_identity_sha256 TEXT,
  prepared_command_id UUID,
  prepared_authority_sha256 TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
DECLARE
  request_record RECORD;
  new_dispatch_admission_id UUID := pg_catalog.gen_random_uuid();
  new_validation_id UUID := pg_catalog.gen_random_uuid();
  new_recovery_lease_id UUID := pg_catalog.gen_random_uuid();
  new_dispatch_attempt_id UUID := pg_catalog.gen_random_uuid();
  next_dispatch_attempt BIGINT;
  next_admission_number INTEGER;
  next_validation_number INTEGER;
  latest_dispatch_attempt_id UUID;
  latest_outcome_kind TEXT;
  latest_outcome_retryable BOOLEAN;
  latest_effect_certainty TEXT;
  latest_recovery_not_before TIMESTAMPTZ;
  authority_now TIMESTAMPTZ;
BEGIN
  IF p_worker_instance_id IS NULL
     OR p_bullmq_attempt_number NOT BETWEEN 0 AND 64
     OR p_recovery_lease_duration_seconds NOT BETWEEN 2 AND 300
     OR p_outcome_timeout_seconds NOT BETWEEN 1
          AND p_recovery_lease_duration_seconds - 1 THEN
    RAISE EXCEPTION 'HXUV1-FINOUT-13-30: invalid worker evidence input'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM hx_authority.assert_fake_financial_publish_open_v13(p_outbox_request_id);
  SELECT request.*
    INTO request_record
    FROM hx_authority.fake_financial_command_outbox_requests_v13 request
   WHERE request.outbox_request_id = p_outbox_request_id
   FOR SHARE;
  IF request_record.outbox_request_id IS NULL
     OR request_record.provider_kind IS DISTINCT FROM 'FAKE'
     OR request_record.release_environment NOT IN ('local', 'preview', 'staging')
     OR request_record.bullmq_job_id IS DISTINCT FROM p_bullmq_job_id
     OR request_record.job_authority_sha256 IS DISTINCT FROM
          p_job_authority_sha256
     OR NOT EXISTS (
       SELECT 1
         FROM hx_authority.fake_financial_outbox_publish_claims_v13 claim
        WHERE claim.outbox_request_id = request_record.outbox_request_id
     ) THEN
    RAISE EXCEPTION
      'HXUV1-FINOUT-13-31: forged, stale, or unpublished Redis job rejected'
      USING ERRCODE = 'P0001';
  END IF;
  PERFORM hx_authority.assert_fake_financial_outbox_target_v13(
    request_record.target_authority_id,
    request_record.target_database_name,
    request_record.release_environment,
    request_record.release_manifest_digest
  );

  -- Use the same command lock as financial-provider recovery v1. Committing
  -- these facts proves only that adapter entry would have a durable crash
  -- boundary; it deliberately does not issue provider-execution capability.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('financial-provider-command-recovery-v1'),
    pg_catalog.hashtext(request_record.command_id::TEXT)
  );
  authority_now := pg_catalog.clock_timestamp();
  IF EXISTS (
    SELECT 1
      FROM public.financial_provider_command_outcome_facts outcome
     WHERE outcome.command_id = request_record.command_id
       AND (
         (outcome.outcome_kind = 'OUTCOME_OBSERVED' AND outcome.retryable = FALSE)
         OR (outcome.outcome_kind = 'FAILED' AND outcome.retryable = FALSE)
       )
  ) THEN
    RAISE EXCEPTION
      'HXUV1-FINOUT-13-32: terminal provider outcome forbids Redis redispatch'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT attempt.dispatch_attempt_id
    INTO latest_dispatch_attempt_id
    FROM public.financial_provider_command_dispatch_attempts attempt
   WHERE attempt.command_id = request_record.command_id
   ORDER BY attempt.attempt_number DESC
   LIMIT 1;
  IF latest_dispatch_attempt_id IS NOT NULL THEN
    SELECT outcome.outcome_kind,
           outcome.retryable,
           outcome.effect_certainty,
           outcome.recovery_not_before
      INTO latest_outcome_kind,
           latest_outcome_retryable,
           latest_effect_certainty,
           latest_recovery_not_before
      FROM public.financial_provider_command_outcome_facts outcome
     WHERE outcome.command_id = request_record.command_id
       AND outcome.dispatch_attempt_id = latest_dispatch_attempt_id
     ORDER BY outcome.recorded_at DESC, outcome.outcome_fact_id DESC
     LIMIT 1;
    IF latest_outcome_kind IS DISTINCT FROM 'FAILED'
       OR latest_outcome_retryable IS DISTINCT FROM TRUE
       OR latest_effect_certainty IS DISTINCT FROM 'CONFIRMED_NO_EFFECT'
       OR latest_recovery_not_before IS NULL
       OR latest_recovery_not_before > authority_now THEN
      RAISE EXCEPTION
        'HXUV1-FINOUT-13-33: Redis replay lacks a due confirmed-no-effect outcome'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF EXISTS(SELECT 1 FROM public.financial_provider_command_outcome_facts fence
    WHERE fence.dispatch_attempt_id=latest_dispatch_attempt_id
      AND fence.outcome_kind='FAILED' AND fence.failure_code='FAKE_ADMISSION_FENCED_NO_EFFECT'
      AND (fence.recording_transaction_id IS NULL OR
        fence.recording_transaction_id=pg_catalog.pg_current_xact_id_if_assigned())) THEN
    RAISE EXCEPTION 'HXUV1-FINFENCE-13-PRIOR_COMMITTED_FENCE_REQUIRED'; END IF;
  SELECT COALESCE(pg_catalog.max(attempt.attempt_number), 0) + 1
    INTO next_dispatch_attempt
    FROM public.financial_provider_command_dispatch_attempts attempt
   WHERE attempt.command_id = request_record.command_id;
  SELECT COALESCE(pg_catalog.max(admission.admission_number), 0) + 1
    INTO next_admission_number
    FROM hx_authority.fake_financial_dispatch_admissions_v13 admission
   WHERE admission.outbox_request_id = request_record.outbox_request_id;
  SELECT COALESCE(pg_catalog.max(validation.validation_number), 0) + 1
    INTO next_validation_number
    FROM hx_authority.fake_financial_job_validations_v13 validation
   WHERE validation.outbox_request_id = request_record.outbox_request_id;
  IF next_dispatch_attempt > 9007199254740991
     OR next_admission_number > 64
     OR next_validation_number > 64 THEN
    RAISE EXCEPTION 'HXUV1-FINOUT-13-34: worker evidence retry bound exhausted'
      USING ERRCODE = 'P0001';
  END IF;

  -- This row is visible only inside the current transaction until the exact
  -- recovery lease and DISPATCH_ATTEMPTED facts commit with it. The legacy
  -- lease guard rejects every DISPATCH that lacks this unforgeable-by-ACL,
  -- same-transaction admission. It is evidence, not provider capability.
  INSERT INTO hx_authority.fake_financial_dispatch_admissions_v13 (
    dispatch_admission_id,
    outbox_request_id,
    command_id,
    admission_number,
    bullmq_job_id,
    job_authority_sha256,
    worker_instance_id,
    bullmq_attempt_number,
    recovery_lease_id,
    admitted_transaction_id,
    admission_identity_sha256
  ) VALUES (
    new_dispatch_admission_id,
    request_record.outbox_request_id,
    request_record.command_id,
    next_admission_number,
    request_record.bullmq_job_id,
    request_record.job_authority_sha256,
    p_worker_instance_id,
    p_bullmq_attempt_number,
    new_recovery_lease_id,
    pg_catalog.pg_current_xact_id()::TEXT::BIGINT,
    pg_catalog.repeat('0', 64)
  );
  INSERT INTO public.financial_provider_command_recovery_leases (
    recovery_lease_id,
    command_id,
    recovery_action,
    lease_owner_id,
    lease_duration_seconds,
    acquired_at,
    expires_at
  ) VALUES (
    new_recovery_lease_id,
    request_record.command_id,
    'DISPATCH',
    p_worker_instance_id,
    p_recovery_lease_duration_seconds,
    authority_now,
    authority_now + pg_catalog.make_interval(
      secs => p_recovery_lease_duration_seconds
    )
  );
  INSERT INTO public.financial_provider_command_dispatch_attempts (
    dispatch_attempt_id,
    command_id,
    recovery_lease_id,
    attempt_number,
    request_sha256,
    outcome_timeout_seconds,
    attempted_at,
    outcome_deadline_at
  ) VALUES (
    new_dispatch_attempt_id,
    request_record.command_id,
    new_recovery_lease_id,
    next_dispatch_attempt,
    request_record.provider_request_sha256,
    p_outcome_timeout_seconds,
    authority_now,
    authority_now + pg_catalog.make_interval(secs => p_outcome_timeout_seconds)
  );
  INSERT INTO hx_authority.fake_financial_job_validations_v13 (
    job_validation_id,
    outbox_request_id,
    command_id,
    validation_number,
    bullmq_job_id,
    job_authority_sha256,
    worker_instance_id,
    bullmq_attempt_number,
    dispatch_admission_id,
    recovery_lease_id,
    dispatch_attempt_id,
    validation_identity_sha256
  ) VALUES (
    new_validation_id,
    request_record.outbox_request_id,
    request_record.command_id,
    next_validation_number,
    request_record.bullmq_job_id,
    request_record.job_authority_sha256,
    p_worker_instance_id,
    p_bullmq_attempt_number,
    new_dispatch_admission_id,
    new_recovery_lease_id,
    new_dispatch_attempt_id,
    pg_catalog.repeat('0', 64)
  );

  RETURN QUERY SELECT
    new_validation_id,
    request_record.command_id,
    new_recovery_lease_id,
    new_dispatch_attempt_id,
    pg_catalog.btrim(request_record.provider_request_sha256),
    pg_catalog.btrim(request_record.command_identity_sha256),
    request_record.prepared_command_id,
    pg_catalog.btrim(request_record.prepared_authority_sha256);
END;
$$;

-- A committed admission can be inspected only by its exact worker. This read
-- is evidence, not a capability: execution must revalidate it in its write port.
CREATE OR REPLACE FUNCTION public.hxos_read_admitted_fake_financial_request_v13(
  p_job_validation_id UUID, p_worker_instance_id UUID
)
RETURNS TABLE (
  job_validation_id UUID, worker_instance_id UUID, command_id UUID,
  dispatch_admission_id UUID, outbox_request_id UUID, recovery_lease_id UUID,
  dispatch_attempt_id UUID, validation_identity_sha256 TEXT,
  admission_identity_sha256 TEXT, job_authority_sha256 TEXT, bullmq_job_id TEXT,
  payload_contract_version SMALLINT, canonical_provider_request TEXT,
  operation_kind TEXT, operation_id UUID, idempotency_key TEXT,
  provider_expected_version BIGINT, provider_request_sha256 TEXT,
  command_identity_sha256 TEXT, prepared_command_id UUID,
  prepared_authority_sha256 TEXT, lease_expires_at TIMESTAMPTZ,
  outcome_deadline_at TIMESTAMPTZ, target_authority_id UUID,
  target_authority_version INTEGER, target_database_name TEXT,
  release_environment TEXT, release_manifest_digest TEXT, release_id TEXT,
  release_revision TEXT, provider_execution_capability BOOLEAN,
  positive_money_capability BOOLEAN, production_capability BOOLEAN
)
LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
DECLARE
  binding RECORD;
  request_record RECORD;
  evidence RECORD;
  authority_now TIMESTAMPTZ;
BEGIN
  IF p_job_validation_id IS NULL OR p_worker_instance_id IS NULL THEN
    RAISE EXCEPTION 'HXUV1-FINREAD-13-INPUT_INVALID';
  END IF;
  -- No row locks precede the common publisher -> target -> command lock order.
  PERFORM hx_authority.assert_fake_financial_publish_open_v13(NULL);
  SELECT validation.outbox_request_id, validation.command_id INTO binding
    FROM hx_authority.fake_financial_job_validations_v13 validation
   WHERE validation.job_validation_id = p_job_validation_id
     AND validation.worker_instance_id = p_worker_instance_id;
  IF binding.outbox_request_id IS NULL THEN
    RAISE EXCEPTION 'HXUV1-FINREAD-13-ADMISSION_NOT_FOUND';
  END IF;
  PERFORM hx_authority.assert_fake_financial_publish_open_v13(binding.outbox_request_id);
  SELECT request.target_authority_id, request.target_database_name,
         request.release_environment, request.release_manifest_digest INTO request_record
    FROM hx_authority.fake_financial_command_outbox_requests_v13 request
   WHERE request.outbox_request_id = binding.outbox_request_id
     AND request.command_id = binding.command_id;
  PERFORM hx_authority.assert_fake_financial_outbox_target_v13(
    request_record.target_authority_id, request_record.target_database_name,
    request_record.release_environment, request_record.release_manifest_digest
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('financial-provider-command-recovery-v1'),
    pg_catalog.hashtext(binding.command_id::TEXT)
  );
  SELECT validation.job_validation_id, validation.worker_instance_id,
         validation.command_id, validation.dispatch_admission_id,
         validation.outbox_request_id, validation.recovery_lease_id,
         validation.dispatch_attempt_id, validation.validation_identity_sha256,
         admission.admission_identity_sha256, admission.admitted_transaction_id,
         outbox.job_authority_sha256, outbox.bullmq_job_id,
         exact_request.payload_contract_version, exact_request.canonical_provider_request,
         outbox.operation_kind, outbox.operation_id, outbox.idempotency_key,
         outbox.provider_expected_version, outbox.provider_request_sha256,
         outbox.command_identity_sha256, outbox.prepared_command_id,
         outbox.prepared_authority_sha256, lease.expires_at AS lease_expires_at,
         attempt.outcome_deadline_at, attempt.attempt_number,
         outbox.target_authority_id, outbox.target_authority_version,
         outbox.target_database_name, outbox.release_environment,
         outbox.release_manifest_digest, outbox.release_id, outbox.release_revision
    INTO evidence
    FROM hx_authority.fake_financial_job_validations_v13 validation
    JOIN hx_authority.fake_financial_dispatch_admissions_v13 admission
      ON admission.dispatch_admission_id = validation.dispatch_admission_id
     AND admission.command_id = validation.command_id
     AND admission.outbox_request_id = validation.outbox_request_id
     AND admission.worker_instance_id = validation.worker_instance_id
     AND admission.recovery_lease_id = validation.recovery_lease_id
     AND admission.bullmq_job_id = validation.bullmq_job_id
     AND admission.job_authority_sha256 = validation.job_authority_sha256
     AND admission.bullmq_attempt_number = validation.bullmq_attempt_number
    JOIN hx_authority.fake_financial_command_outbox_requests_v13 outbox
      ON outbox.outbox_request_id = validation.outbox_request_id
     AND outbox.command_id = validation.command_id
     AND outbox.bullmq_job_id = validation.bullmq_job_id
     AND outbox.job_authority_sha256 = validation.job_authority_sha256
    JOIN public.financial_provider_command_journal command
      ON command.command_id = outbox.command_id
     AND command.command_state = 'REQUESTED' AND command.provider_kind = 'FAKE'
     AND command.operation_kind = outbox.operation_kind
     AND command.operation_id = outbox.operation_id
     AND command.idempotency_key = outbox.idempotency_key
     AND command.provider_expected_version = outbox.provider_expected_version
     AND command.request_sha256 = outbox.provider_request_sha256
     AND command.command_identity_sha256 = outbox.command_identity_sha256
     AND command.prepared_financial_command_id = outbox.prepared_command_id
     AND command.prepared_authority_sha256 = outbox.prepared_authority_sha256
     AND command.release_environment = outbox.release_environment
     AND command.release_manifest_digest = outbox.release_manifest_digest
     AND command.release_id = outbox.release_id
     AND command.release_revision = outbox.release_revision
     AND command.release_authentication_status = 'VERIFIED'
    JOIN public.universal_v1_prepared_financial_commands prepared
      ON prepared.prepared_command_id = outbox.prepared_command_id
     AND prepared.authority_context_sha256 = outbox.prepared_authority_sha256
     AND prepared.provider_request_sha256 = outbox.provider_request_sha256
     AND prepared.operation_kind = outbox.operation_kind
     AND prepared.operation_id = outbox.operation_id
     AND prepared.provider_kind = 'FAKE'
     AND prepared.idempotency_key = outbox.idempotency_key
     AND prepared.provider_expected_version = outbox.provider_expected_version
    JOIN hx_authority.fake_financial_exact_requests_v13 exact_request
      ON exact_request.command_id = outbox.command_id
     AND exact_request.provider_request_sha256 = outbox.provider_request_sha256
     AND exact_request.recorded_transaction_id = command.requested_transaction_id
    JOIN public.financial_provider_command_recovery_leases lease
      ON lease.recovery_lease_id = validation.recovery_lease_id
     AND lease.command_id = validation.command_id
     AND lease.lease_owner_id = validation.worker_instance_id
     AND lease.recovery_action = 'DISPATCH'
    JOIN public.financial_provider_command_dispatch_attempts attempt
      ON attempt.dispatch_attempt_id = validation.dispatch_attempt_id
     AND attempt.command_id = validation.command_id
     AND attempt.recovery_lease_id = validation.recovery_lease_id
     AND attempt.request_sha256 = outbox.provider_request_sha256
   WHERE validation.job_validation_id = p_job_validation_id
     AND validation.worker_instance_id = p_worker_instance_id
     AND validation.provider_execution_capability IS FALSE
     AND validation.positive_money_capability IS FALSE
     AND validation.production_capability IS FALSE
     AND admission.provider_execution_capability IS FALSE
     AND admission.positive_money_capability IS FALSE
     AND admission.production_capability IS FALSE
     AND outbox.positive_money_capability IS FALSE
     AND outbox.production_capability IS FALSE;
  IF evidence.command_id IS NULL THEN
    RAISE EXCEPTION 'HXUV1-FINREAD-13-EVIDENCE_MISMATCH';
  END IF;
  IF evidence.admitted_transaction_id = pg_catalog.pg_current_xact_id()::TEXT::BIGINT THEN
    RAISE EXCEPTION 'HXUV1-FINREAD-13-COMMITTED_ADMISSION_REQUIRED';
  END IF;
  -- Sample time after all blocking authority locks. An earlier timestamp could
  -- allow an expired attempt through after waiting for a concurrent writer.
  authority_now := pg_catalog.clock_timestamp();
  IF evidence.lease_expires_at <= authority_now
     OR evidence.outcome_deadline_at <= authority_now THEN
    RAISE EXCEPTION 'HXUV1-FINREAD-13-EXECUTION_WINDOW_EXPIRED';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.financial_provider_command_dispatch_attempts successor
     WHERE successor.command_id = evidence.command_id
       AND successor.attempt_number > evidence.attempt_number
  ) OR EXISTS (
    SELECT 1 FROM public.financial_provider_command_outcome_facts outcome
     WHERE outcome.command_id = evidence.command_id
       AND (outcome.dispatch_attempt_id = evidence.dispatch_attempt_id
         OR outcome.recovery_lease_id = evidence.recovery_lease_id
         OR (outcome.outcome_kind IN ('OUTCOME_OBSERVED', 'FAILED') AND outcome.retryable IS FALSE))
  ) THEN
    RAISE EXCEPTION 'HXUV1-FINREAD-13-DISPATCH_NOT_OPEN';
  END IF;
  RETURN QUERY SELECT evidence.job_validation_id, evidence.worker_instance_id,
    evidence.command_id, evidence.dispatch_admission_id, evidence.outbox_request_id,
    evidence.recovery_lease_id, evidence.dispatch_attempt_id,
    pg_catalog.btrim(evidence.validation_identity_sha256),
    pg_catalog.btrim(evidence.admission_identity_sha256),
    pg_catalog.btrim(evidence.job_authority_sha256), evidence.bullmq_job_id,
    evidence.payload_contract_version, evidence.canonical_provider_request,
    evidence.operation_kind, evidence.operation_id, evidence.idempotency_key,
    evidence.provider_expected_version, pg_catalog.btrim(evidence.provider_request_sha256),
    pg_catalog.btrim(evidence.command_identity_sha256), evidence.prepared_command_id,
    pg_catalog.btrim(evidence.prepared_authority_sha256), evidence.lease_expires_at,
    evidence.outcome_deadline_at, evidence.target_authority_id,
    evidence.target_authority_version, evidence.target_database_name,
    evidence.release_environment, evidence.release_manifest_digest, evidence.release_id,
    pg_catalog.btrim(evidence.release_revision), FALSE, FALSE, FALSE;
END;
$$;

-- Immutable admission-chain evidence only; no current target, publication,
-- execution-window or new-dispatch authorization is implied by this helper.
CREATE OR REPLACE FUNCTION hx_authority.read_fake_financial_admission_evidence_v13(
  p_job_validation_id UUID, p_worker_instance_id UUID
)
RETURNS TABLE (
  job_validation_id UUID, worker_instance_id UUID, command_id UUID,
  dispatch_admission_id UUID, outbox_request_id UUID, recovery_lease_id UUID,
  dispatch_attempt_id UUID, validation_identity_sha256 TEXT,
  admission_identity_sha256 TEXT, job_authority_sha256 TEXT, bullmq_job_id TEXT,
  payload_contract_version SMALLINT, canonical_provider_request TEXT,
  operation_kind TEXT, operation_id UUID, idempotency_key TEXT,
  provider_expected_version BIGINT, provider_request_sha256 TEXT,
  command_identity_sha256 TEXT, prepared_command_id UUID,
  prepared_authority_sha256 TEXT, lease_expires_at TIMESTAMPTZ,
  outcome_deadline_at TIMESTAMPTZ, target_authority_id UUID,
  target_authority_version INTEGER, target_database_name TEXT,
  release_environment TEXT, release_manifest_digest TEXT, release_id TEXT,
  release_revision TEXT, provider_execution_capability BOOLEAN,
  positive_money_capability BOOLEAN, production_capability BOOLEAN
)
LANGUAGE plpgsql SECURITY DEFINER STABLE PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
DECLARE
  evidence RECORD;
BEGIN
  SELECT validation.job_validation_id, validation.worker_instance_id,
         validation.command_id, validation.dispatch_admission_id,
         validation.outbox_request_id, validation.recovery_lease_id,
         validation.dispatch_attempt_id, validation.validation_identity_sha256,
         admission.admission_identity_sha256, admission.admitted_transaction_id,
         outbox.job_authority_sha256, outbox.bullmq_job_id,
         exact_request.payload_contract_version, exact_request.canonical_provider_request,
         outbox.operation_kind, outbox.operation_id, outbox.idempotency_key,
         outbox.provider_expected_version, outbox.provider_request_sha256,
         outbox.command_identity_sha256, outbox.prepared_command_id,
         outbox.prepared_authority_sha256, lease.expires_at AS lease_expires_at,
         attempt.outcome_deadline_at, attempt.attempt_number,
         outbox.target_authority_id, outbox.target_authority_version,
         outbox.target_database_name, outbox.release_environment,
         outbox.release_manifest_digest, outbox.release_id, outbox.release_revision
    INTO evidence
    FROM hx_authority.fake_financial_job_validations_v13 validation
    JOIN hx_authority.fake_financial_dispatch_admissions_v13 admission
      ON admission.dispatch_admission_id = validation.dispatch_admission_id
     AND admission.command_id = validation.command_id
     AND admission.outbox_request_id = validation.outbox_request_id
     AND admission.worker_instance_id = validation.worker_instance_id
     AND admission.recovery_lease_id = validation.recovery_lease_id
     AND admission.bullmq_job_id = validation.bullmq_job_id
     AND admission.job_authority_sha256 = validation.job_authority_sha256
     AND admission.bullmq_attempt_number = validation.bullmq_attempt_number
    JOIN hx_authority.fake_financial_command_outbox_requests_v13 outbox
      ON outbox.outbox_request_id = validation.outbox_request_id
     AND outbox.command_id = validation.command_id
     AND outbox.bullmq_job_id = validation.bullmq_job_id
     AND outbox.job_authority_sha256 = validation.job_authority_sha256
    JOIN public.financial_provider_command_journal command
      ON command.command_id = outbox.command_id
     AND command.command_state = 'REQUESTED' AND command.provider_kind = 'FAKE'
     AND command.operation_kind = outbox.operation_kind
     AND command.operation_id = outbox.operation_id
     AND command.idempotency_key = outbox.idempotency_key
     AND command.provider_expected_version = outbox.provider_expected_version
     AND command.request_sha256 = outbox.provider_request_sha256
     AND command.command_identity_sha256 = outbox.command_identity_sha256
     AND command.prepared_financial_command_id = outbox.prepared_command_id
     AND command.prepared_authority_sha256 = outbox.prepared_authority_sha256
     AND command.release_environment = outbox.release_environment
     AND command.release_manifest_digest = outbox.release_manifest_digest
     AND command.release_id = outbox.release_id
     AND command.release_revision = outbox.release_revision
     AND command.release_authentication_status = 'VERIFIED'
    JOIN public.universal_v1_prepared_financial_commands prepared
      ON prepared.prepared_command_id = outbox.prepared_command_id
     AND prepared.authority_context_sha256 = outbox.prepared_authority_sha256
     AND prepared.provider_request_sha256 = outbox.provider_request_sha256
     AND prepared.operation_kind = outbox.operation_kind
     AND prepared.operation_id = outbox.operation_id
     AND prepared.provider_kind = 'FAKE'
     AND prepared.idempotency_key = outbox.idempotency_key
     AND prepared.provider_expected_version = outbox.provider_expected_version
    JOIN hx_authority.fake_financial_exact_requests_v13 exact_request
      ON exact_request.command_id = outbox.command_id
     AND exact_request.provider_request_sha256 = outbox.provider_request_sha256
     AND exact_request.recorded_transaction_id = command.requested_transaction_id
    JOIN public.financial_provider_command_recovery_leases lease
      ON lease.recovery_lease_id = validation.recovery_lease_id
     AND lease.command_id = validation.command_id
     AND lease.lease_owner_id = validation.worker_instance_id
     AND lease.recovery_action = 'DISPATCH'
    JOIN public.financial_provider_command_dispatch_attempts attempt
      ON attempt.dispatch_attempt_id = validation.dispatch_attempt_id
     AND attempt.command_id = validation.command_id
     AND attempt.recovery_lease_id = validation.recovery_lease_id
     AND attempt.request_sha256 = outbox.provider_request_sha256
   WHERE validation.job_validation_id = p_job_validation_id
     AND validation.worker_instance_id = p_worker_instance_id
     AND validation.provider_execution_capability IS FALSE
     AND validation.positive_money_capability IS FALSE
     AND validation.production_capability IS FALSE
     AND admission.provider_execution_capability IS FALSE
     AND admission.positive_money_capability IS FALSE
     AND admission.production_capability IS FALSE
     AND outbox.positive_money_capability IS FALSE
     AND outbox.production_capability IS FALSE;
  IF evidence.command_id IS NULL THEN
    RAISE EXCEPTION 'HXUV1-FINREAD-13-EVIDENCE_MISMATCH';
  END IF;
  IF evidence.admitted_transaction_id = pg_catalog.pg_current_xact_id_if_assigned()::TEXT::BIGINT THEN
    RAISE EXCEPTION 'HXUV1-FINREAD-13-COMMITTED_ADMISSION_REQUIRED';
  END IF;
  RETURN QUERY SELECT evidence.job_validation_id, evidence.worker_instance_id,
    evidence.command_id, evidence.dispatch_admission_id, evidence.outbox_request_id,
    evidence.recovery_lease_id, evidence.dispatch_attempt_id,
    pg_catalog.btrim(evidence.validation_identity_sha256),
    pg_catalog.btrim(evidence.admission_identity_sha256),
    pg_catalog.btrim(evidence.job_authority_sha256), evidence.bullmq_job_id,
    evidence.payload_contract_version, evidence.canonical_provider_request,
    evidence.operation_kind, evidence.operation_id, evidence.idempotency_key,
    evidence.provider_expected_version, pg_catalog.btrim(evidence.provider_request_sha256),
    pg_catalog.btrim(evidence.command_identity_sha256), evidence.prepared_command_id,
    pg_catalog.btrim(evidence.prepared_authority_sha256), evidence.lease_expires_at,
    evidence.outcome_deadline_at, evidence.target_authority_id,
    evidence.target_authority_version, evidence.target_database_name,
    evidence.release_environment, evidence.release_manifest_digest, evidence.release_id,
    pg_catalog.btrim(evidence.release_revision), FALSE, FALSE, FALSE;
END;
$$;


-- Deterministic fake-provider projection of an already canonical request.
-- This helper performs no writes and grants no execution authority.
-- Preserve the exact legacy guard contracts while removing their extension/search-path SHA dependency.
CREATE OR REPLACE FUNCTION public.validate_universal_v1_fake_terminal_lifecycle_intent()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  work_order public.task_work_orders%ROWTYPE;
  task_record public.tasks%ROWTYPE;
  scope_record public.task_scope_versions%ROWTYPE;
  completion public.task_completion_facts%ROWTYPE;
  execution public.task_work_order_execution_facts%ROWTYPE;
  starting_event public.task_financial_security_events%ROWTYPE;
  starting_bridge public.universal_v1_fake_financial_lifecycle_bridges%ROWTYPE;
  prior_reconciliation public.task_reconciliation_facts%ROWTYPE;
  provider_account RECORD;
  provider_account_authority_sha256 CHAR(64);
  current_reconciliation_version INTEGER := 0;
  current_reconciliation_id UUID;
  derived_plan_count SMALLINT;
  derived_plan_sha256 CHAR(64);
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtext('universal-v1-fake-terminal-lifecycle-intent-v1'),
    hashtext(NEW.work_order_id::TEXT)
  );

  SELECT * INTO work_order
    FROM public.task_work_orders
   WHERE id = NEW.work_order_id
   FOR SHARE;
  SELECT * INTO task_record
    FROM public.tasks
   WHERE id = work_order.task_id
   FOR SHARE;
  SELECT * INTO completion
    FROM public.task_completion_facts
   WHERE id = NEW.completion_fact_id
   FOR SHARE;
  SELECT * INTO starting_event
    FROM public.task_financial_security_events
   WHERE id = NEW.starting_financial_event_id
   FOR SHARE;
  SELECT * INTO starting_bridge
    FROM public.universal_v1_fake_financial_lifecycle_bridges
   WHERE task_financial_security_event_id = NEW.starting_financial_event_id
   FOR SHARE;
  SELECT * INTO scope_record
    FROM public.task_scope_versions
   WHERE id = public.universal_v1_effective_work_order_scope_id(NEW.work_order_id)
   FOR SHARE;

  IF work_order.id IS NULL
     OR task_record.id IS NULL
     OR completion.id IS NULL
     OR starting_event.id IS NULL
     OR starting_bridge.bridge_id IS NULL
     OR scope_record.id IS NULL THEN
    RAISE EXCEPTION 'HXUV1-FTL-1: terminal intent requires exact durable Work Order, task, completion, scope, financial, and bridge facts'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO execution
    FROM public.task_work_order_execution_facts fact
   WHERE fact.work_order_id = work_order.id
     AND fact.task_id = work_order.task_id
     AND fact.scope_version_id = scope_record.id
     AND fact.completion_fact_id = completion.id
     AND fact.transition_kind = 'COMPLETION_APPROVED'
     AND fact.state = 'COMPLETED'
     AND NOT EXISTS (
       SELECT 1
         FROM public.task_work_order_execution_facts newer
        WHERE newer.work_order_id = fact.work_order_id
          AND newer.execution_version > fact.execution_version
     )
   FOR SHARE;

  IF execution.id IS NULL
     OR work_order.execution_contract_version <> 1
     OR work_order.provider_user_id IS NULL
     OR task_record.work_order_id IS DISTINCT FROM work_order.id
     OR task_record.universal_contract_version <> 1
     OR task_record.automation_classification <> 'CONTROLLED_TEST'
     OR task_record.universal_payment_posture <> 'PAYMENT_CREATION_FROZEN'
     OR task_record.worker_id IS NOT NULL
     OR completion.work_order_id <> work_order.id
     OR completion.task_id <> work_order.task_id
     OR completion.scope_version_id <> scope_record.id
     OR completion.fact_kind <> 'APPROVED'
     OR completion.incident_gate <> 'CLEAR'
     OR completion.amount_approved_cents IS DISTINCT FROM scope_record.customer_total_cents
     OR completion.actor_id IS DISTINCT FROM NEW.requested_by
     OR EXISTS (
       SELECT 1
         FROM public.task_completion_facts newer
        WHERE newer.work_order_id = completion.work_order_id
          AND newer.completion_version > completion.completion_version
     ) THEN
    RAISE EXCEPTION 'HXUV1-FTL-2: terminal intent is confined to an unassigned frozen controlled-test Work Order with exact current approved completion and execution authority'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.terminal_path = 'SETTLED' THEN
    PERFORM pg_advisory_xact_lock(
      hashtext('universal-v1-fake-provider-account-v1'),
      hashtext(
        CASE
          WHEN work_order.provider_organization_id IS NULL
            THEN 'USER:' || work_order.provider_user_id::TEXT
          ELSE 'ORGANIZATION:' || work_order.provider_organization_id::TEXT
        END
      )
    );
    SELECT * INTO provider_account
      FROM public.universal_v1_fake_provider_account_facts fact
     WHERE fact.provider_account_fact_id = NEW.provider_account_fact_id
     FOR SHARE;
    IF provider_account.provider_account_fact_id IS NULL
       OR provider_account.provider_subject_kind IS DISTINCT FROM (CASE
             WHEN work_order.provider_organization_id IS NULL THEN 'USER'
             ELSE 'ORGANIZATION'
          END)
       OR provider_account.provider_user_id IS DISTINCT FROM (CASE
             WHEN work_order.provider_organization_id IS NULL THEN work_order.provider_user_id
             ELSE NULL
          END)
       OR provider_account.provider_organization_id IS DISTINCT FROM
          work_order.provider_organization_id
       OR provider_account.account_state <> 'ENABLED'
       OR provider_account.charges_enabled IS NOT TRUE
       OR provider_account.payouts_enabled IS NOT TRUE
       OR (
         work_order.provider_organization_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1
             FROM public.business_memberships crew_membership
             JOIN public.business_organizations crew_organization
               ON crew_organization.id = crew_membership.organization_id
            WHERE crew_membership.organization_id = work_order.provider_organization_id
              AND crew_membership.user_id = work_order.provider_user_id
              AND crew_membership.status = 'ACTIVE'
              AND crew_membership.role IN ('OWNER', 'ADMIN', 'DISPATCHER', 'CREW')
              AND crew_organization.status = 'ACTIVE'
              AND crew_organization.provider_enabled IS TRUE
         )
       )
       OR EXISTS (
         SELECT 1
           FROM public.universal_v1_fake_provider_account_facts newer
          WHERE newer.provider_subject_kind = provider_account.provider_subject_kind
            AND newer.provider_user_id IS NOT DISTINCT FROM provider_account.provider_user_id
            AND newer.provider_organization_id IS NOT DISTINCT FROM
                provider_account.provider_organization_id
            AND newer.account_version > provider_account.account_version
       ) THEN
      RAISE EXCEPTION 'HXUV1-FTL-6: SETTLED intent requires the latest exact enabled provider-authored account fact before terminal execution'
        USING ERRCODE = 'P0001';
    END IF;
    provider_account_authority_sha256 := provider_account.authority_sha256;
  ELSIF NEW.provider_account_fact_id IS NOT NULL THEN
    RAISE EXCEPTION 'HXUV1-FTL-7: FULL_REFUND intent cannot claim provider-account authority'
      USING ERRCODE = 'P0001';
  END IF;

  IF starting_event.task_draft_id IS DISTINCT FROM work_order.task_draft_id
     OR starting_event.task_id IS DISTINCT FROM work_order.task_id
     OR starting_event.eligibility_decision_id IS DISTINCT FROM work_order.eligibility_decision_id
     OR starting_event.scope_version_id IS DISTINCT FROM scope_record.id
     OR starting_event.provider_kind <> 'FAKE'
     OR starting_event.status <> 'SUCCEEDED'
     OR starting_event.event_kind NOT IN ('SECURED', 'ADJUSTMENT_AUTHORIZED')
     OR starting_event.expected_version IS DISTINCT FROM NEW.expected_financial_version
     OR starting_bridge.task_id IS DISTINCT FROM work_order.task_id
     OR starting_bridge.scope_version_id IS DISTINCT FROM scope_record.id
     OR starting_bridge.lifecycle_status <> 'SUCCEEDED'
     OR starting_bridge.lifecycle_expected_version IS DISTINCT FROM NEW.expected_financial_version
     OR EXISTS (
       SELECT 1
         FROM public.task_financial_security_events later
        WHERE later.task_draft_id = work_order.task_draft_id
          AND later.expected_version > starting_event.expected_version
     )
     OR NOT EXISTS (
       WITH RECURSIVE authority_chain(event_id) AS (
         SELECT work_order.financial_security_event_id
         UNION ALL
         SELECT successor.id
           FROM public.task_financial_security_events successor
           JOIN authority_chain predecessor
             ON successor.predecessor_event_id = predecessor.event_id
       )
       SELECT 1 FROM authority_chain
        WHERE event_id = starting_event.id
     ) THEN
    RAISE EXCEPTION 'HXUV1-FTL-3: terminal intent must start at the exact latest successful fake financial authority for the Work Order'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT reconciliation.id, reconciliation.reconciliation_version
    INTO current_reconciliation_id, current_reconciliation_version
    FROM public.task_reconciliation_facts reconciliation
   WHERE reconciliation.work_order_id = work_order.id
   ORDER BY reconciliation.reconciliation_version DESC
   LIMIT 1
   FOR SHARE;
  current_reconciliation_version := COALESCE(current_reconciliation_version, 0);
  IF current_reconciliation_version <> NEW.expected_reconciliation_version THEN
    RAISE EXCEPTION 'HXUV1-FTL-4: terminal intent must name the exact latest canonical reconciliation version'
      USING ERRCODE = 'P0001';
  END IF;
  IF current_reconciliation_id IS NOT NULL THEN
    SELECT * INTO prior_reconciliation
      FROM public.task_reconciliation_facts
     WHERE id = current_reconciliation_id
     FOR SHARE;
  END IF;

  SELECT count(*)::SMALLINT,
         encode(
           public.hxos_universal_v1_sha256_bytes_v1(
             string_agg(
               plan.step_ordinal::TEXT || ':' || plan.step_class || ':' ||
               plan.operation_kind || ':' ||
               COALESCE(plan.lifecycle_version_offset::TEXT, ''),
               '|' ORDER BY plan.step_ordinal
             ),
             'sha256'
           ),
           'hex'
         )
    INTO derived_plan_count, derived_plan_sha256
    FROM public.universal_v1_fake_terminal_plan_v1(NEW.terminal_path) plan;
  IF derived_plan_count IS NULL OR derived_plan_count = 0 THEN
    RAISE EXCEPTION 'HXUV1-FTL-5: terminal path has no immutable plan'
      USING ERRCODE = 'P0001';
  END IF;

  NEW.task_draft_id := work_order.task_draft_id;
  NEW.task_id := work_order.task_id;
  NEW.scope_version_id := scope_record.id;
  NEW.eligibility_decision_id := work_order.eligibility_decision_id;
  NEW.completion_execution_fact_id := execution.id;
  NEW.starting_financial_bridge_id := starting_bridge.bridge_id;
  NEW.prior_reconciliation_fact_id := current_reconciliation_id;
  NEW.starting_financial_version := starting_event.expected_version;
  NEW.starting_reconciliation_version := current_reconciliation_version;
  NEW.provider_subject_kind := CASE
    WHEN work_order.provider_organization_id IS NOT NULL THEN 'ORGANIZATION'
    ELSE 'USER'
  END;
  NEW.provider_subject_id := COALESCE(
    work_order.provider_organization_id,
    work_order.provider_user_id
  );
  NEW.customer_amount_cents := scope_record.customer_total_cents;
  NEW.provider_amount_cents := scope_record.hustler_payout_cents;
  NEW.currency := scope_record.currency;
  NEW.plan_step_count := derived_plan_count;
  NEW.plan_sha256 := derived_plan_sha256;
  NEW.materialized_at := clock_timestamp();
  NEW.authority_context_sha256 := encode(
    public.hxos_universal_v1_sha256_bytes_v1(
      'HUSTLEXP_UNIVERSAL_V1_FAKE_TERMINAL_INTENT_V1:' ||
      NEW.terminal_intent_id::TEXT || ':' || NEW.terminal_path || ':' ||
      work_order.id::TEXT || ':' || completion.id::TEXT || ':' ||
      execution.id::TEXT || ':' || starting_event.id::TEXT || ':' ||
      starting_bridge.authority_chain_sha256 || ':' ||
      NEW.expected_financial_version::TEXT || ':' ||
      NEW.expected_reconciliation_version::TEXT || ':' ||
      COALESCE(current_reconciliation_id::TEXT, '') || ':' ||
      COALESCE(provider_account_authority_sha256, '') || ':' ||
      NEW.provider_subject_kind || ':' || NEW.provider_subject_id::TEXT || ':' ||
      NEW.customer_amount_cents::TEXT || ':' || NEW.provider_amount_cents::TEXT || ':' ||
      NEW.currency || ':' || NEW.plan_sha256 || ':' || NEW.request_sha256 || ':' ||
      NEW.requested_by::TEXT,
      'sha256'
    ),
    'hex'
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.validate_universal_v1_fake_provider_account_fact()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  onboard_requested public.financial_provider_command_journal%ROWTYPE;
  refresh_requested public.financial_provider_command_journal%ROWTYPE;
  onboard_attempted public.financial_provider_command_dispatch_attempts%ROWTYPE;
  refresh_attempted public.financial_provider_command_dispatch_attempts%ROWTYPE;
  onboard_outcome public.financial_provider_command_outcome_facts%ROWTYPE;
  refresh_outcome public.financial_provider_command_outcome_facts%ROWTYPE;
  onboard_event public.hxos_fake_financial_operation_events_v1%ROWTYPE;
  refresh_event public.hxos_fake_financial_operation_events_v1%ROWTYPE;
  onboard_operation public.hxos_fake_financial_operations_v1%ROWTYPE;
  refresh_operation public.hxos_fake_financial_operations_v1%ROWTYPE;
  prior_fact public.universal_v1_fake_provider_account_facts%ROWTYPE;
  prior_refresh_outcome public.financial_provider_command_outcome_facts%ROWTYPE;
  latest_onboard_attempt_id UUID;
  latest_refresh_attempt_id UUID;
  provider_subject_id UUID;
  provider_account_reference TEXT;
  onboard_external_reference_sha256 CHAR(64);
  refresh_external_reference_sha256 CHAR(64);
  expected_onboard_result_sha256 CHAR(64);
  expected_refresh_result_sha256 CHAR(64);
  onboard_request_without_scenario TEXT;
  onboard_request_with_scenario TEXT;
  refresh_request_without_scenario TEXT;
  refresh_request_with_scenario TEXT;
  derived_account_version BIGINT;
  derived_supersedes_fact_id UUID;
  derived_account_state TEXT;
  derived_charges_enabled BOOLEAN;
  derived_payouts_enabled BOOLEAN;
  derived_requirements_sha256 CHAR(64);
  derived_requirements TEXT;
BEGIN
  IF (
       NEW.provider_subject_kind = 'USER'
       AND NEW.provider_user_id IS NOT NULL
       AND NEW.provider_organization_id IS NULL
     ) IS NOT TRUE
     AND (
       NEW.provider_subject_kind = 'ORGANIZATION'
       AND NEW.provider_user_id IS NULL
       AND NEW.provider_organization_id IS NOT NULL
     ) IS NOT TRUE THEN
    RAISE EXCEPTION 'HXUV1-FTL-10: provider-account fact requires one discriminated USER or ORGANIZATION subject'
      USING ERRCODE = 'P0001';
  END IF;
  provider_subject_id := COALESCE(NEW.provider_organization_id, NEW.provider_user_id);

  PERFORM pg_advisory_xact_lock(
    hashtext('universal-v1-fake-provider-account-v1'),
    hashtext(
      NEW.provider_subject_kind || ':' || provider_subject_id::TEXT
    )
  );

  SELECT * INTO onboard_requested
    FROM public.financial_provider_command_journal
   WHERE command_id = NEW.onboard_command_id
   FOR SHARE;
  SELECT * INTO refresh_requested
    FROM public.financial_provider_command_journal
   WHERE command_id = NEW.refresh_command_id
   FOR SHARE;
  SELECT * INTO onboard_attempted
    FROM public.financial_provider_command_dispatch_attempts
   WHERE dispatch_attempt_id = NEW.onboard_dispatch_attempt_id
   FOR SHARE;
  SELECT * INTO refresh_attempted
    FROM public.financial_provider_command_dispatch_attempts
   WHERE dispatch_attempt_id = NEW.refresh_dispatch_attempt_id
   FOR SHARE;
  SELECT * INTO onboard_outcome
    FROM public.financial_provider_command_outcome_facts
   WHERE outcome_fact_id = NEW.onboard_outcome_fact_id
   FOR SHARE;
  SELECT * INTO refresh_outcome
    FROM public.financial_provider_command_outcome_facts
   WHERE outcome_fact_id = NEW.refresh_outcome_fact_id
   FOR SHARE;
  SELECT * INTO onboard_event
    FROM public.hxos_fake_financial_operation_events_v1
   WHERE event_id = NEW.onboard_fake_event_id
   FOR SHARE;
  SELECT * INTO refresh_event
    FROM public.hxos_fake_financial_operation_events_v1
   WHERE event_id = NEW.refresh_fake_event_id
   FOR SHARE;
  SELECT * INTO onboard_operation
    FROM public.hxos_fake_financial_operations_v1
   WHERE operation_id = onboard_event.operation_id
   FOR SHARE;
  SELECT * INTO refresh_operation
    FROM public.hxos_fake_financial_operations_v1
   WHERE operation_id = refresh_event.operation_id
   FOR SHARE;
  SELECT dispatch_attempt_id INTO latest_onboard_attempt_id
    FROM public.financial_provider_command_dispatch_attempts
   WHERE command_id = NEW.onboard_command_id
   ORDER BY attempt_number DESC
   LIMIT 1;
  SELECT dispatch_attempt_id INTO latest_refresh_attempt_id
    FROM public.financial_provider_command_dispatch_attempts
   WHERE command_id = NEW.refresh_command_id
   ORDER BY attempt_number DESC
   LIMIT 1;

  IF onboard_requested.command_id IS NULL
     OR onboard_attempted.dispatch_attempt_id IS NULL
     OR onboard_outcome.outcome_fact_id IS NULL
     OR onboard_event.event_id IS NULL
     OR onboard_operation.operation_id IS NULL
     OR onboard_requested.operation_kind <> 'ONBOARD_PROVIDER'
     OR onboard_requested.provider_kind <> 'FAKE'
     OR num_nonnulls(
          onboard_requested.task_draft_id,
          onboard_requested.task_id,
          onboard_requested.work_order_id,
          onboard_requested.related_operation_id,
          onboard_requested.amount_cents,
          onboard_requested.currency
        ) <> 0
     OR onboard_requested.recorded_actor_id IS DISTINCT FROM NEW.recorded_by
     OR onboard_requested.recorded_actor_kind IS DISTINCT FROM 'PARTICIPANT'
     OR onboard_attempted.command_id IS DISTINCT FROM onboard_requested.command_id
     OR onboard_attempted.request_sha256 IS DISTINCT FROM onboard_requested.request_sha256
     OR onboard_attempted.dispatch_attempt_id IS DISTINCT FROM latest_onboard_attempt_id
     OR onboard_outcome.command_id IS DISTINCT FROM onboard_requested.command_id
     OR onboard_outcome.dispatch_attempt_id IS DISTINCT FROM onboard_attempted.dispatch_attempt_id
     OR onboard_outcome.recovery_lease_id IS DISTINCT FROM onboard_attempted.recovery_lease_id
     OR onboard_outcome.outcome_kind <> 'OUTCOME_OBSERVED'
     OR onboard_outcome.retryable IS TRUE
     OR onboard_outcome.provider_state NOT IN ('SUCCEEDED', 'ACCEPTED')
     OR onboard_operation.provider_kind <> 'FAKE'
     OR onboard_operation.operation_id IS DISTINCT FROM onboard_requested.operation_id
     OR onboard_operation.operation_kind <> 'ONBOARD_PROVIDER'
     OR onboard_event.operation_id IS DISTINCT FROM onboard_requested.operation_id
     OR onboard_event.operation_kind <> 'ONBOARD_PROVIDER'
     OR onboard_event.idempotency_key IS DISTINCT FROM onboard_requested.idempotency_key
     OR onboard_event.event_version IS DISTINCT FROM onboard_requested.provider_expected_version + 1
     OR onboard_event.state IS DISTINCT FROM onboard_outcome.provider_state
     OR onboard_event.retryable IS DISTINCT FROM onboard_outcome.retryable
     OR onboard_event.provider_request_sha256 IS DISTINCT FROM onboard_requested.request_sha256
     OR onboard_event.identity_sha256 IS DISTINCT FROM onboard_operation.identity_sha256
     OR onboard_event.external_reference IS DISTINCT FROM onboard_operation.external_reference
     OR onboard_event.amount_cents IS NOT NULL
     OR onboard_event.currency IS NOT NULL THEN
    RAISE EXCEPTION 'HXUV1-FTL-11: provider-account fact requires the exact successful provider-authored onboarding chain'
      USING ERRCODE = 'P0001';
  END IF;

  IF refresh_requested.command_id IS NULL
     OR refresh_attempted.dispatch_attempt_id IS NULL
     OR refresh_outcome.outcome_fact_id IS NULL
     OR refresh_event.event_id IS NULL
     OR refresh_operation.operation_id IS NULL
     OR refresh_requested.operation_kind <> 'REFRESH_PROVIDER_ACCOUNT_STATE'
     OR refresh_requested.provider_kind <> 'FAKE'
     OR num_nonnulls(
          refresh_requested.task_draft_id,
          refresh_requested.task_id,
          refresh_requested.work_order_id,
          refresh_requested.related_operation_id,
          refresh_requested.amount_cents,
          refresh_requested.currency
        ) <> 0
     OR refresh_requested.recorded_actor_id IS DISTINCT FROM NEW.recorded_by
     OR refresh_requested.recorded_actor_kind IS DISTINCT FROM 'PARTICIPANT'
     OR refresh_attempted.command_id IS DISTINCT FROM refresh_requested.command_id
     OR refresh_attempted.request_sha256 IS DISTINCT FROM refresh_requested.request_sha256
     OR refresh_attempted.dispatch_attempt_id IS DISTINCT FROM latest_refresh_attempt_id
     OR refresh_outcome.command_id IS DISTINCT FROM refresh_requested.command_id
     OR refresh_outcome.dispatch_attempt_id IS DISTINCT FROM refresh_attempted.dispatch_attempt_id
     OR refresh_outcome.recovery_lease_id IS DISTINCT FROM refresh_attempted.recovery_lease_id
     OR refresh_outcome.outcome_kind <> 'OUTCOME_OBSERVED'
     OR refresh_outcome.retryable IS TRUE
     OR refresh_outcome.provider_state IN ('PENDING', 'RETRYABLE_FAILURE')
     OR refresh_operation.provider_kind <> 'FAKE'
     OR refresh_operation.operation_id IS DISTINCT FROM refresh_requested.operation_id
     OR refresh_operation.operation_kind <> 'REFRESH_PROVIDER_ACCOUNT_STATE'
     OR refresh_event.operation_id IS DISTINCT FROM refresh_requested.operation_id
     OR refresh_event.operation_kind <> 'REFRESH_PROVIDER_ACCOUNT_STATE'
     OR refresh_event.idempotency_key IS DISTINCT FROM refresh_requested.idempotency_key
     OR refresh_event.event_version IS DISTINCT FROM refresh_requested.provider_expected_version + 1
     OR refresh_event.state IS DISTINCT FROM refresh_outcome.provider_state
     OR refresh_event.retryable IS DISTINCT FROM refresh_outcome.retryable
     OR refresh_event.provider_request_sha256 IS DISTINCT FROM refresh_requested.request_sha256
     OR refresh_event.identity_sha256 IS DISTINCT FROM refresh_operation.identity_sha256
     OR refresh_event.external_reference IS DISTINCT FROM refresh_operation.external_reference
     OR refresh_event.amount_cents IS NOT NULL
     OR refresh_event.currency IS NOT NULL THEN
    RAISE EXCEPTION 'HXUV1-FTL-12: provider-account fact requires the exact terminal provider-authored refresh chain'
      USING ERRCODE = 'P0001';
  END IF;

  IF onboard_requested.recorded_at > onboard_attempted.attempted_at
     OR onboard_attempted.attempted_at > onboard_operation.created_at
     OR onboard_operation.created_at > onboard_event.recorded_at
     OR onboard_event.recorded_at > onboard_outcome.recorded_at
     OR refresh_requested.recorded_at > refresh_attempted.attempted_at
     OR refresh_attempted.attempted_at > refresh_operation.created_at
     OR refresh_operation.created_at > refresh_event.recorded_at
     OR refresh_event.recorded_at > refresh_outcome.recorded_at
     OR refresh_requested.recorded_at <= onboard_outcome.recorded_at THEN
    RAISE EXCEPTION 'HXUV1-FTL-16: provider-account refresh must be causally downstream of the completed onboarding chain'
      USING ERRCODE = 'P0001';
  END IF;

  onboard_external_reference_sha256 := encode(
    public.hxos_universal_v1_sha256_bytes_v1(onboard_event.external_reference, 'sha256'),
    'hex'
  );
  refresh_external_reference_sha256 := encode(
    public.hxos_universal_v1_sha256_bytes_v1(refresh_event.external_reference, 'sha256'),
    'hex'
  );
  expected_onboard_result_sha256 := encode(
    public.hxos_universal_v1_sha256_bytes_v1(
      onboard_requested.operation_id::TEXT || ':' || onboard_requested.operation_kind || ':' ||
      onboard_requested.provider_kind || ':' || onboard_outcome.provider_state || ':' ||
      onboard_outcome.provider_result_version::TEXT || ':::' ||
      onboard_external_reference_sha256 || ':' || onboard_outcome.retryable::TEXT,
      'sha256'
    ),
    'hex'
  );
  expected_refresh_result_sha256 := encode(
    public.hxos_universal_v1_sha256_bytes_v1(
      refresh_requested.operation_id::TEXT || ':' || refresh_requested.operation_kind || ':' ||
      refresh_requested.provider_kind || ':' || refresh_outcome.provider_state || ':' ||
      refresh_outcome.provider_result_version::TEXT || ':::' ||
      refresh_external_reference_sha256 || ':' || refresh_outcome.retryable::TEXT,
      'sha256'
    ),
    'hex'
  );
  IF onboard_outcome.provider_result_version IS DISTINCT FROM onboard_event.event_version
     OR onboard_outcome.external_reference_sha256 IS DISTINCT FROM onboard_external_reference_sha256
     OR onboard_outcome.provider_result_sha256 IS DISTINCT FROM expected_onboard_result_sha256
     OR refresh_outcome.provider_result_version IS DISTINCT FROM refresh_event.event_version
     OR refresh_outcome.external_reference_sha256 IS DISTINCT FROM refresh_external_reference_sha256
     OR refresh_outcome.provider_result_sha256 IS DISTINCT FROM expected_refresh_result_sha256 THEN
    RAISE EXCEPTION 'HXUV1-FTL-13: provider-account outcome digests are not exact'
      USING ERRCODE = 'P0001';
  END IF;

  provider_account_reference := refresh_event.metadata->>'providerAccountReference';
  IF onboard_event.metadata->>'providerId' IS DISTINCT FROM provider_subject_id::TEXT
     OR refresh_event.metadata->>'providerId' IS DISTINCT FROM provider_subject_id::TEXT
     OR provider_account_reference IS NULL
     OR provider_account_reference IS DISTINCT FROM onboard_event.external_reference THEN
    RAISE EXCEPTION 'HXUV1-FTL-14: onboarding and refresh must name the same exact provider and account reference'
      USING ERRCODE = 'P0001';
  END IF;

  onboard_request_without_scenario :=
    '{"expectedVersion":' || onboard_requested.provider_expected_version::TEXT ||
    ',"idempotencyKey":' || to_jsonb(onboard_requested.idempotency_key)::TEXT ||
    ',"operationId":' || to_jsonb(onboard_requested.operation_id::TEXT)::TEXT ||
    ',"providerId":' || to_jsonb(provider_subject_id::TEXT)::TEXT || '}';
  onboard_request_with_scenario :=
    left(onboard_request_without_scenario, -1) ||
    ',"scenario":' || to_jsonb(onboard_event.scenario)::TEXT || '}';
  refresh_request_without_scenario :=
    '{"expectedVersion":' || refresh_requested.provider_expected_version::TEXT ||
    ',"idempotencyKey":' || to_jsonb(refresh_requested.idempotency_key)::TEXT ||
    ',"operationId":' || to_jsonb(refresh_requested.operation_id::TEXT)::TEXT ||
    ',"providerAccountReference":' || to_jsonb(provider_account_reference)::TEXT ||
    ',"providerId":' || to_jsonb(provider_subject_id::TEXT)::TEXT || '}';
  refresh_request_with_scenario :=
    left(refresh_request_without_scenario, -1) ||
    ',"scenario":' || to_jsonb(refresh_event.scenario)::TEXT || '}';
  IF onboard_requested.request_sha256 NOT IN (
       encode(public.hxos_universal_v1_sha256_bytes_v1(onboard_request_without_scenario, 'sha256'), 'hex'),
       encode(public.hxos_universal_v1_sha256_bytes_v1(onboard_request_with_scenario, 'sha256'), 'hex')
     )
     OR refresh_requested.request_sha256 NOT IN (
       encode(public.hxos_universal_v1_sha256_bytes_v1(refresh_request_without_scenario, 'sha256'), 'hex'),
       encode(public.hxos_universal_v1_sha256_bytes_v1(refresh_request_with_scenario, 'sha256'), 'hex')
     ) THEN
    RAISE EXCEPTION 'HXUV1-FTL-17: provider-account commands must bind the exact subject and onboarding-created account reference'
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (
       SELECT 1
         FROM public.users actor
        WHERE actor.id = NEW.recorded_by
          AND actor.account_status = 'ACTIVE'
          AND actor.is_minor IS FALSE
          AND COALESCE(actor.is_banned, FALSE) IS FALSE
     )
     OR (
       NEW.provider_subject_kind = 'USER'
       AND NEW.recorded_by IS DISTINCT FROM NEW.provider_user_id
     )
     OR (
       NEW.provider_subject_kind = 'ORGANIZATION'
       AND NOT EXISTS (
         SELECT 1
           FROM public.business_organizations organization
           JOIN public.business_memberships membership
             ON membership.organization_id = organization.id
          WHERE organization.id = NEW.provider_organization_id
            AND organization.provider_enabled IS TRUE
            AND organization.status = 'ACTIVE'
            AND membership.user_id = NEW.recorded_by
            AND membership.status = 'ACTIVE'
            AND membership.role IN ('OWNER', 'ADMIN')
       )
     ) THEN
    RAISE EXCEPTION 'HXUV1-FTL-15: provider-account authority requires the USER subject or an active ORGANIZATION owner/admin actor'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO prior_fact
    FROM public.universal_v1_fake_provider_account_facts fact
   WHERE fact.provider_subject_kind = NEW.provider_subject_kind
     AND fact.provider_user_id IS NOT DISTINCT FROM NEW.provider_user_id
     AND fact.provider_organization_id IS NOT DISTINCT FROM NEW.provider_organization_id
   ORDER BY fact.account_version DESC
   LIMIT 1
   FOR SHARE;

  -- Account facts are a provider-observation sequence, not a caller-selected
  -- arrival order. Both dispatch_attempt.attempted_at and outcome.recorded_at
  -- are overwritten by database triggers, so this strict happens-before edge
  -- cannot be forged with caller timestamps. It also rejects an overlapping
  -- refresh whose request did not begin after the latest terminal observation.
  IF prior_fact.provider_account_fact_id IS NOT NULL THEN
    SELECT * INTO prior_refresh_outcome
      FROM public.financial_provider_command_outcome_facts
     WHERE outcome_fact_id = prior_fact.refresh_outcome_fact_id
     FOR SHARE;

    IF prior_refresh_outcome.outcome_fact_id IS NULL
       OR refresh_attempted.attempted_at <= prior_refresh_outcome.recorded_at THEN
      RAISE EXCEPTION 'HXUV1-FTL-19: provider-account refresh dispatch must be causally downstream of the latest account observation'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  derived_account_version := COALESCE(prior_fact.account_version, 0) + 1;
  derived_supersedes_fact_id := prior_fact.provider_account_fact_id;
  derived_account_state := CASE
    WHEN refresh_outcome.provider_state = 'SUCCEEDED' THEN 'ENABLED'
    WHEN refresh_outcome.provider_state IN ('DECLINED', 'REJECTED') THEN 'RESTRICTED'
    ELSE 'FAILED'
  END;
  derived_charges_enabled := derived_account_state = 'ENABLED';
  derived_payouts_enabled := derived_account_state = 'ENABLED';
  derived_requirements := CASE derived_account_state
    WHEN 'ENABLED' THEN 'NONE'
    WHEN 'FAILED' THEN 'IDENTITY_VERIFICATION'
    WHEN 'PENDING' THEN 'PROVIDER_REVIEW'
    ELSE 'PROVIDER_ACCOUNT_RESTRICTED'
  END;
  derived_requirements_sha256 := encode(public.hxos_universal_v1_sha256_bytes_v1(derived_requirements, 'sha256'), 'hex');

  IF (NEW.account_version IS NOT NULL AND NEW.account_version <> derived_account_version)
     OR (
       NEW.supersedes_fact_id IS NOT NULL
       AND NEW.supersedes_fact_id IS DISTINCT FROM derived_supersedes_fact_id
     )
     OR (NEW.account_state IS NOT NULL AND NEW.account_state <> derived_account_state)
     OR (
       NEW.charges_enabled IS NOT NULL
       AND NEW.charges_enabled IS DISTINCT FROM derived_charges_enabled
     )
     OR (
       NEW.payouts_enabled IS NOT NULL
       AND NEW.payouts_enabled IS DISTINCT FROM derived_payouts_enabled
     )
     OR (
       NEW.requirements_due_sha256 IS NOT NULL
       AND NEW.requirements_due_sha256 IS DISTINCT FROM derived_requirements_sha256
     ) THEN
    RAISE EXCEPTION 'HXUV1-FTL-18: caller-supplied provider-account version or current-state claim conflicts with database authority'
      USING ERRCODE = 'P0001';
  END IF;

  NEW.account_version := derived_account_version;
  NEW.supersedes_fact_id := derived_supersedes_fact_id;
  NEW.provider_account_reference_sha256 := encode(
    public.hxos_universal_v1_sha256_bytes_v1(provider_account_reference, 'sha256'),
    'hex'
  );
  NEW.account_state := derived_account_state;
  NEW.charges_enabled := derived_charges_enabled;
  NEW.payouts_enabled := derived_payouts_enabled;
  NEW.requirements_due_sha256 := derived_requirements_sha256;
  NEW.recorded_at := refresh_outcome.recorded_at;
  NEW.materialized_at := clock_timestamp();
  NEW.fact_sha256 := encode(
    public.hxos_universal_v1_sha256_bytes_v1(
      'HUSTLEXP_UNIVERSAL_V1_FAKE_PROVIDER_ACCOUNT_FACT_V1:' ||
      NEW.provider_subject_kind || ':' || provider_subject_id::TEXT || ':' ||
      COALESCE(NEW.provider_user_id::TEXT, '') || ':' ||
      COALESCE(NEW.provider_organization_id::TEXT, '') || ':' ||
      NEW.account_version::TEXT || ':' ||
      NEW.provider_account_reference_sha256 || ':' || NEW.account_state || ':' ||
      NEW.charges_enabled::TEXT || ':' || NEW.payouts_enabled::TEXT || ':' ||
      NEW.requirements_due_sha256 || ':' || NEW.recorded_by::TEXT,
      'sha256'
    ),
    'hex'
  );
  NEW.authority_sha256 := encode(
    public.hxos_universal_v1_sha256_bytes_v1(
      'HUSTLEXP_UNIVERSAL_V1_FAKE_PROVIDER_ACCOUNT_AUTHORITY_V1:' ||
      NEW.fact_sha256 || ':' ||
      onboard_requested.command_id::TEXT || ':' || onboard_requested.command_identity_sha256 || ':' ||
      onboard_attempted.dispatch_attempt_id::TEXT || ':' || onboard_attempted.attempt_identity_sha256 || ':' ||
      onboard_outcome.outcome_fact_id::TEXT || ':' || onboard_outcome.outcome_identity_sha256 || ':' ||
      onboard_event.event_id::TEXT || ':' || onboard_event.response_sha256 || ':' ||
      refresh_requested.command_id::TEXT || ':' || refresh_requested.command_identity_sha256 || ':' ||
      refresh_attempted.dispatch_attempt_id::TEXT || ':' || refresh_attempted.attempt_identity_sha256 || ':' ||
      refresh_outcome.outcome_fact_id::TEXT || ':' || refresh_outcome.outcome_identity_sha256 || ':' ||
      refresh_event.event_id::TEXT || ':' || refresh_event.response_sha256,
      'sha256'
    ),
    'hex'
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION hx_authority.derive_fake_financial_projection_v13(
  p_operation_kind TEXT, p_canonical_request TEXT
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
DECLARE
  request JSONB;
  metadata JSONB;
  metadata_text TEXT;
  identity JSONB;
  identity_text TEXT;
  internal_request_text TEXT;
  response_text TEXT;
  scenario TEXT;
  provider_state TEXT;
  retryable BOOLEAN;
  external_reference TEXT;
BEGIN
  request := hx_authority.parse_fake_financial_request_v13(p_operation_kind, p_canonical_request);
  scenario := COALESCE(request ->> 'scenario', 'SUCCESS');
  metadata := CASE p_operation_kind
    WHEN 'PREPARE_PAYMENT_METHOD' THEN pg_catalog.jsonb_build_object('customerId', request -> 'customerId')
    WHEN 'AUTHORIZE' THEN pg_catalog.jsonb_build_object('paymentMethodReference', request -> 'paymentMethodReference')
    WHEN 'SECURE' THEN pg_catalog.jsonb_build_object('authorizationOperationId', request -> 'authorizationOperationId')
    WHEN 'ADJUST' THEN pg_catalog.jsonb_build_object('changeOrderId', request -> 'changeOrderId', 'scopeVersionId', request -> 'scopeVersionId')
    WHEN 'REFUND' THEN pg_catalog.jsonb_build_object('originalAmountCents', request -> 'originalAmountCents')
    WHEN 'PAYOUT' THEN pg_catalog.jsonb_build_object('providerAccountReference', request -> 'providerAccountReference')
    ELSE '{}'::JSONB END;
  provider_state := CASE
    WHEN scenario = 'DECLINE' THEN 'DECLINED'
    WHEN scenario = 'TIMEOUT' THEN 'PENDING'
    WHEN scenario = 'RETRY' THEN CASE WHEN (request ->> 'expectedVersion')::BIGINT = 0 THEN 'RETRYABLE_FAILURE' ELSE 'SUCCEEDED' END
    WHEN scenario = 'DELAYED_SETTLEMENT' AND p_operation_kind IN ('SETTLE','FUND','PROVIDER_RELEASE','PAYOUT','OBSERVE_BANK_SETTLEMENT')
      THEN CASE WHEN (request ->> 'expectedVersion')::BIGINT = 0 THEN 'PENDING' ELSE 'SUCCEEDED' END
    WHEN scenario = 'PARTIAL_REFUND' AND p_operation_kind = 'REFUND' THEN 'PARTIALLY_REFUNDED'
    WHEN p_operation_kind = 'REVERSAL' THEN 'REVERSED'
    WHEN p_operation_kind = 'VOID' THEN 'VOIDED'
    WHEN p_operation_kind = 'REFUND' THEN 'REFUNDED'
    ELSE 'SUCCEEDED' END;
  retryable := provider_state = 'RETRYABLE_FAILURE' OR (provider_state = 'PENDING' AND scenario = 'TIMEOUT');
  external_reference := 'fake_' || pg_catalog.lower(p_operation_kind) || '_' || pg_catalog.left(
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.to_jsonb(request ->> 'operationId')::TEXT, 'UTF8')), 'hex'), 24
  );
  -- All keys here are fixed ASCII names. Their C order equals the established
  -- provider encoder's localeCompare order; string values retain exact bytes.
  SELECT '{' || COALESCE(pg_catalog.string_agg(pg_catalog.to_json(key)::TEXT || ':' || value::TEXT, ',' ORDER BY key COLLATE "C"), '') || '}'
    INTO metadata_text FROM pg_catalog.jsonb_each(metadata);
  identity := pg_catalog.jsonb_build_object(
    'operationId', request -> 'operationId', 'operationKind', p_operation_kind,
    'providerKind', 'FAKE', 'amountCents', request -> 'amountCents',
    'currency', request -> 'currency', 'relatedOperationId', request -> 'relatedOperationId',
    'scenario', scenario, 'metadata', metadata
  );
  SELECT '{' || pg_catalog.string_agg(pg_catalog.to_json(key)::TEXT || ':' ||
    CASE WHEN key = 'metadata' THEN metadata_text ELSE value::TEXT END, ',' ORDER BY key COLLATE "C") || '}'
    INTO identity_text FROM pg_catalog.jsonb_each(identity);
  SELECT '{' || pg_catalog.string_agg(pg_catalog.to_json(key)::TEXT || ':' ||
    CASE WHEN key = 'metadata' THEN metadata_text ELSE value::TEXT END, ',' ORDER BY key COLLATE "C") || '}'
    INTO internal_request_text FROM pg_catalog.jsonb_each(identity || pg_catalog.jsonb_build_object(
      'idempotencyKey', request -> 'idempotencyKey', 'expectedVersion', request -> 'expectedVersion'
    ));
  response_text := '{"externalReference":' || pg_catalog.to_json(external_reference)::TEXT
    || ',"retryable":' || retryable::TEXT || ',"state":' || pg_catalog.to_json(provider_state)::TEXT || '}';
  RETURN pg_catalog.jsonb_build_object(
    'operationId', request -> 'operationId', 'operationKind', p_operation_kind,
    'idempotencyKey', request -> 'idempotencyKey', 'expectedVersion', request -> 'expectedVersion',
    'scenario', scenario, 'amountCents', request -> 'amountCents', 'currency', request -> 'currency',
    'relatedOperationId', request -> 'relatedOperationId', 'externalReference', external_reference,
    'state', provider_state, 'retryable', retryable, 'metadata', metadata,
    'identitySha256', pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(identity_text,'UTF8')),'hex'),
    'requestSha256', pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(internal_request_text,'UTF8')),'hex'),
    'providerRequestSha256', pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_canonical_request,'UTF8')),'hex'),
    'responseSha256', pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(response_text,'UTF8')),'hex')
  );
END;
$$;


-- Contract 1 is the immutable historical projection above. Contract 2 fixes
-- terminal retry states and delayed-settlement retryability, and binds its
-- version into response hashes. Request and operation identity bytes stay exact.
CREATE OR REPLACE FUNCTION hx_authority.derive_fake_financial_projection_v13(
  p_operation_kind TEXT, p_canonical_request TEXT, p_projection_contract_version SMALLINT
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
DECLARE
  projection JSONB;
  provider_state TEXT;
  retryable_result BOOLEAN;
  response_text TEXT;
BEGIN
  IF p_projection_contract_version IS NULL OR p_projection_contract_version NOT IN (1,2) THEN
    RAISE EXCEPTION 'HXUV1-FINPROJECTION-13-CONTRACT_VERSION_INVALID';
  END IF;
  projection := hx_authority.derive_fake_financial_projection_v13(p_operation_kind,p_canonical_request);
  IF p_projection_contract_version = 2 THEN
    provider_state := projection ->> 'state';
    IF projection ->> 'scenario' = 'RETRY' AND (projection ->> 'expectedVersion')::BIGINT > 0 THEN
      provider_state := CASE p_operation_kind
        WHEN 'VOID' THEN 'VOIDED' WHEN 'REFUND' THEN 'REFUNDED' WHEN 'REVERSAL' THEN 'REVERSED'
        ELSE provider_state END;
    END IF;
    retryable_result := provider_state IN ('PENDING','RETRYABLE_FAILURE');
    response_text := '{"externalReference":' || pg_catalog.to_json(projection ->> 'externalReference')::TEXT
      || ',"projectionContractVersion":2,"retryable":' || retryable_result::TEXT
      || ',"state":' || pg_catalog.to_json(provider_state)::TEXT || '}';
    projection := projection || pg_catalog.jsonb_build_object(
      'state',provider_state,'retryable',retryable_result,
      'responseSha256',pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(response_text,'UTF8')),'hex')
    );
  END IF;
  RETURN projection || pg_catalog.jsonb_build_object('projectionContractVersion',p_projection_contract_version);
END;
$$;


-- Command-owner domain revalidation; no runtime EXECUTE grant.
CREATE OR REPLACE FUNCTION hx_authority.assert_fake_financial_execution_domain_v13(p_command_id UUID, p_request_sha256 TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
DECLARE
  requested public.financial_provider_command_journal%ROWTYPE;
  prepared public.universal_v1_prepared_financial_commands%ROWTYPE;
  intent public.universal_v1_fake_terminal_lifecycle_intents%ROWTYPE;
  task_record public.tasks%ROWTYPE;
  work_order public.task_work_orders%ROWTYPE;
  eligibility public.task_provider_eligibility_decisions%ROWTYPE;
  account_fact public.universal_v1_fake_provider_account_facts%ROWTYPE;
  draft_record public.task_drafts%ROWTYPE;
  scope_record public.task_scope_versions%ROWTYPE;
  route_record public.task_routing_decisions%ROWTYPE;
  service_cell public.universal_v1_service_cell_authorities%ROWTYPE;
  commitment public.task_work_order_command_requests%ROWTYPE;
  hold_record public.task_reservations%ROWTYPE;
  interest_record public.task_applications%ROWTYPE;
  domain_now TIMESTAMPTZ;
  adjustment_actor_ids UUID[];
BEGIN
  SELECT * INTO requested
    FROM public.financial_provider_command_journal
   WHERE command_id = p_command_id
   FOR SHARE;
  IF requested.command_id IS NULL
     OR requested.prepared_financial_command_id IS NULL THEN
    RAISE EXCEPTION 'HXUV1-FINEXEC-13-REQUESTED_MISSING';
  END IF;

  SELECT * INTO prepared
    FROM public.universal_v1_prepared_financial_commands
   WHERE prepared_command_id = requested.prepared_financial_command_id
   FOR SHARE;
  IF prepared.prepared_command_id IS NULL OR requested.request_sha256 IS DISTINCT FROM p_request_sha256 THEN
    RAISE EXCEPTION 'HXUV1-FINEXEC-13-PREPARED_MISMATCH';
  END IF;
  IF prepared.operation_kind IN ('SECURE', 'ADJUST', 'CAPTURE') AND
     public.universal_v1_financial_security_is_current_v1(
       public.universal_v1_effective_financial_security_expiry_v1(prepared.predecessor_event_id),
       pg_catalog.clock_timestamp()
     ) IS NOT TRUE THEN
    RAISE EXCEPTION 'HXUV1-FINEXEC-13-PREDECESSOR_EXPIRED';
  END IF;

  IF prepared.operation_kind IN ('PROVIDER_RELEASE','PAYOUT') AND prepared.work_order_id IS NOT NULL THEN
    -- Submission takes dispute before target. Never wait for that lock while
    -- execution holds target: refuse contention and retain the admitted attempt.
    IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(
      'universal-v1-dispute:' || prepared.work_order_id::TEXT, 0
    )) THEN RAISE EXCEPTION 'HXUV1-FINEXEC-13-DISPUTE_LOCK_BUSY'; END IF;
    IF public.universal_v1_has_open_material_dispute_v1(prepared.work_order_id) IS DISTINCT FROM FALSE THEN
      RAISE EXCEPTION 'HXUV1-FINEXEC-13-MATERIAL_DISPUTE_OPEN';
    END IF;
  END IF;
  IF prepared.operation_kind IN ('PREPARE_PAYMENT_METHOD','AUTHORIZE','SECURE') THEN
    -- Execution already owns publisher/target/command/operation locks. Domain
    -- submissions take those locks in the other direction: never wait here.
    SELECT * INTO draft_record FROM public.task_drafts
      WHERE id=prepared.task_draft_id FOR UPDATE NOWAIT;
    PERFORM 1 FROM public.users WHERE id=prepared.recorded_by FOR SHARE NOWAIT;
    IF draft_record.id IS NULL OR draft_record.universal_contract_version IS DISTINCT FROM 1
       OR draft_record.ingress_origin IS DISTINCT FROM 'BACKEND_POSTGRESQL'
       OR draft_record.claimed_at IS NULL
       OR draft_record.poster_user_id IS DISTINCT FROM prepared.recorded_by
       OR NOT EXISTS (SELECT 1 FROM public.users customer
         WHERE customer.id=prepared.recorded_by AND customer.account_status='ACTIVE'
           AND customer.is_minor IS FALSE AND COALESCE(customer.is_banned,FALSE) IS FALSE) THEN
      RAISE EXCEPTION 'HXUV1-FINEXEC-13-CUSTOMER_AUTHORITY_REVOKED';
    END IF;
    IF prepared.task_id IS NULL THEN
      IF prepared.operation_kind IS DISTINCT FROM 'PREPARE_PAYMENT_METHOD'
         OR draft_record.task_id IS NOT NULL THEN
        RAISE EXCEPTION 'HXUV1-FINEXEC-13-UNBOUND_DRAFT_CHANGED';
      END IF;
      RETURN;
    END IF;
    IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(
      'hxuv1-financial-security-task:' || prepared.task_id::TEXT,0
    )) THEN RAISE EXCEPTION 'HXUV1-FINEXEC-13-TASK_LOCK_BUSY'; END IF;
    -- Task and draft UPDATE locks also serialize incident, compensation,
    -- routing and eligibility inserts through their canonical foreign keys.
    SELECT * INTO task_record FROM public.tasks WHERE id=prepared.task_id FOR UPDATE NOWAIT;
    SELECT * INTO scope_record FROM public.task_scope_versions
      WHERE id=prepared.scope_version_id FOR SHARE NOWAIT;
    SELECT * INTO eligibility FROM public.task_provider_eligibility_decisions
      WHERE id=prepared.eligibility_decision_id FOR SHARE NOWAIT;
    SELECT * INTO route_record FROM public.task_routing_decisions
      WHERE id=eligibility.routing_decision_id FOR SHARE NOWAIT;
    SELECT * INTO service_cell FROM public.universal_v1_service_cell_authorities
      WHERE id=route_record.service_cell_authority_id FOR UPDATE NOWAIT;
    IF eligibility.id IS NULL OR NOT pg_catalog.pg_try_advisory_xact_lock(
      pg_catalog.hashtextextended('eligibility:' || prepared.task_draft_id::TEXT || ':' ||
        eligibility.provider_user_id::TEXT || ':' ||
        COALESCE(eligibility.provider_organization_id::TEXT,'individual'),0)
    ) THEN RAISE EXCEPTION 'HXUV1-FINEXEC-13-ELIGIBILITY_AUTHORITY_UNAVAILABLE'; END IF;
    PERFORM 1 FROM public.users WHERE id=eligibility.provider_user_id FOR SHARE NOWAIT;
    PERFORM 1 FROM public.capability_profiles WHERE user_id=eligibility.provider_user_id
      ORDER BY user_id FOR SHARE NOWAIT;
    PERFORM 1 FROM public.business_organizations WHERE id=eligibility.provider_organization_id
      FOR SHARE NOWAIT;
    PERFORM 1 FROM public.business_memberships
      WHERE organization_id=eligibility.provider_organization_id
        AND user_id=eligibility.provider_user_id ORDER BY user_id,id FOR SHARE NOWAIT;
    PERFORM 1 FROM public.business_credentials WHERE id=eligibility.trade_credential_id
      FOR SHARE NOWAIT;
    PERFORM 1 FROM public.verified_trades WHERE user_id=eligibility.provider_user_id
      AND provider_organization_id IS NOT DISTINCT FROM eligibility.provider_organization_id
      AND business_credential_id IS NOT DISTINCT FROM eligibility.trade_credential_id
      ORDER BY user_id,trade FOR SHARE NOWAIT;

    IF prepared.operation_kind IN ('AUTHORIZE','SECURE') THEN
      -- The immutable unique task winner is the only accepted-estimate Phase A
      -- witness. A different live hold or a caller-generated key cannot replace it.
      SELECT * INTO commitment FROM public.task_work_order_command_requests
        WHERE task_id=prepared.task_id FOR SHARE NOWAIT;
      SELECT * INTO hold_record FROM public.task_reservations
        WHERE id=commitment.conditional_hold_id FOR SHARE NOWAIT;
      SELECT * INTO interest_record FROM public.task_applications
        WHERE id=eligibility.interest_application_id FOR SHARE NOWAIT;
      PERFORM 1 FROM public.task_estimate_acceptance_materializations
        WHERE task_id=prepared.task_id ORDER BY id FOR SHARE NOWAIT;
      PERFORM 1 FROM public.provider_estimate_submissions
        WHERE id=commitment.provider_estimate_submission_id FOR SHARE NOWAIT;
    END IF;
    domain_now := pg_catalog.clock_timestamp();
    IF task_record.id IS NULL OR scope_record.id IS NULL OR route_record.id IS NULL
       OR draft_record.task_id IS DISTINCT FROM task_record.id
       OR task_record.poster_id IS DISTINCT FROM prepared.recorded_by
       OR task_record.state IS DISTINCT FROM 'OPEN'
       OR task_record.universal_contract_version IS DISTINCT FROM 1
       OR task_record.automation_classification IS DISTINCT FROM 'CONTROLLED_TEST'
       OR task_record.universal_payment_posture IS DISTINCT FROM 'PAYMENT_CREATION_FROZEN'
       OR task_record.worker_id IS NOT NULL OR task_record.work_order_id IS NOT NULL
       OR prepared.work_order_id IS NOT NULL
       OR task_record.active_scope_version_id IS DISTINCT FROM scope_record.id
       OR scope_record.task_id IS DISTINCT FROM task_record.id
       OR scope_record.universal_contract_version IS DISTINCT FROM 1
       OR scope_record.version IS DISTINCT FROM prepared.scope_version
       OR scope_record.scope_hash IS DISTINCT FROM prepared.scope_hash
       OR task_record.scope_hash IS DISTINCT FROM scope_record.scope_hash
       OR draft_record.active_routing_decision_id IS DISTINCT FROM route_record.id
       OR route_record.task_draft_id IS DISTINCT FROM draft_record.id
       OR route_record.outcome IS DISTINCT FROM 'FULFILLMENT_CANDIDATE'
       OR route_record.category_snapshot IS DISTINCT FROM task_record.category
       OR route_record.service_cell_snapshot IS DISTINCT FROM task_record.region_code
       OR service_cell.id IS NULL
       OR service_cell.authority_environment IS DISTINCT FROM requested.release_environment
       OR service_cell.is_test IS NOT TRUE
       OR service_cell.authority_kind IS DISTINCT FROM 'SYNTHETIC_FIXTURE'
       OR service_cell.region_code IS DISTINCT FROM task_record.region_code
       OR service_cell.routing_availability IS DISTINCT FROM 'ACTIVE'
       OR service_cell.effective_from > domain_now
       OR service_cell.expires_at <= domain_now
       OR EXISTS (SELECT 1 FROM public.universal_v1_service_cell_authorities successor
          WHERE successor.supersedes_authority_id=service_cell.id)
       OR EXISTS (SELECT 1 FROM public.task_safety_incidents incident
          WHERE incident.task_id=task_record.id AND incident.status NOT IN ('resolved','closed'))
       OR EXISTS (SELECT 1 FROM public.universal_v1_work_order_compensation_commands compensation
          WHERE compensation.task_id=task_record.id) THEN
      RAISE EXCEPTION 'HXUV1-FINEXEC-13-TASK_AUTHORITY_REVOKED';
    END IF;
    IF eligibility.task_draft_id IS DISTINCT FROM draft_record.id
       OR eligibility.task_id IS DISTINCT FROM task_record.id
       OR eligibility.scope_version_id IS DISTINCT FROM scope_record.id
       OR eligibility.decision_version IS DISTINCT FROM prepared.eligibility_decision_version
       OR eligibility.valid_until IS DISTINCT FROM prepared.eligibility_valid_until
       OR eligibility.evaluated_at > domain_now OR eligibility.valid_until <= domain_now
       OR eligibility.profile_eligible IS NOT TRUE OR eligibility.identity_eligible IS NOT TRUE
       OR eligibility.category_eligible IS NOT TRUE OR eligibility.credential_eligible IS NOT TRUE
       OR eligibility.geography_eligible IS NOT TRUE OR eligibility.availability_eligible IS NOT TRUE
       OR eligibility.restriction_clear IS NOT TRUE OR eligibility.task_eligible IS NOT TRUE
       OR eligibility.processor_payment_eligible IS NOT FALSE
       OR eligibility.payout_funding_eligible IS NOT FALSE
       OR EXISTS (SELECT 1 FROM public.task_provider_eligibility_decisions newer
          WHERE newer.task_draft_id=eligibility.task_draft_id
            AND newer.provider_user_id=eligibility.provider_user_id
            AND newer.provider_organization_id IS NOT DISTINCT FROM eligibility.provider_organization_id
            AND newer.decision_version>eligibility.decision_version) THEN
      RAISE EXCEPTION 'HXUV1-FINEXEC-13-ELIGIBILITY_AUTHORITY_REVOKED';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.users provider WHERE provider.id=eligibility.provider_user_id
         AND provider.account_status='ACTIVE' AND provider.is_minor IS FALSE
         AND COALESCE(provider.is_banned,FALSE) IS FALSE
         AND NOT (provider.trust_hold IS TRUE
           AND (provider.trust_hold_until IS NULL OR provider.trust_hold_until>domain_now)))
       OR public.universal_v1_invited_provider_authority_is_current(
         eligibility.provider_user_id,eligibility.provider_organization_id,eligibility.provider_class,
         eligibility.trade_credential_id,task_record.category,task_record.region_code) IS NOT TRUE THEN
      RAISE EXCEPTION 'HXUV1-FINEXEC-13-PROVIDER_AUTHORITY_REVOKED';
    END IF;
    IF prepared.operation_kind IN ('AUTHORIZE','SECURE') THEN
      IF commitment.idempotency_key IS NULL
         OR commitment.canonical_command_request_sha256 IS NULL
         OR pg_catalog.btrim(commitment.canonical_command_request_sha256) !~ '^[a-f0-9]{64}$'
         OR commitment.canonical_command_request_sha256=pg_catalog.repeat('0',64)
         OR commitment.created_at>prepared.prepared_at
         OR commitment.actor_user_id IS DISTINCT FROM prepared.recorded_by
         OR commitment.task_draft_id IS DISTINCT FROM prepared.task_draft_id
         OR commitment.scope_version_id IS DISTINCT FROM prepared.scope_version_id
         OR commitment.routing_decision_id IS DISTINCT FROM route_record.id
         OR commitment.provider_user_id IS DISTINCT FROM eligibility.provider_user_id
         OR commitment.provider_organization_id IS DISTINCT FROM eligibility.provider_organization_id
         OR commitment.eligibility_decision_id IS DISTINCT FROM eligibility.id
         OR commitment.eligibility_version IS DISTINCT FROM eligibility.decision_version
         OR commitment.amount_cents IS DISTINCT FROM prepared.amount_cents
         OR commitment.currency IS DISTINCT FROM prepared.currency
         OR scope_record.customer_total_cents IS DISTINCT FROM prepared.amount_cents
         OR scope_record.currency IS DISTINCT FROM prepared.currency
         OR prepared.idempotency_key IS DISTINCT FROM (commitment.idempotency_key ||
           CASE prepared.operation_kind WHEN 'AUTHORIZE' THEN ':auth' ELSE ':secure' END)
         OR prepared.operation_id IS DISTINCT FROM public.universal_v1_work_order_operation_id_v1(
           commitment.idempotency_key,pg_catalog.lower(prepared.operation_kind))
         OR hold_record.id IS NULL OR hold_record.task_id IS DISTINCT FROM task_record.id
         OR hold_record.hustler_id IS DISTINCT FROM eligibility.provider_user_id
         OR hold_record.reserved_by IS DISTINCT FROM prepared.recorded_by
         OR hold_record.eligibility_decision_id IS DISTINCT FROM eligibility.id
         OR hold_record.interest_application_id IS DISTINCT FROM interest_record.id
         OR hold_record.universal_contract_version IS DISTINCT FROM 1
         OR hold_record.hold_kind IS DISTINCT FROM 'CONDITIONAL_HOLD'
         OR hold_record.status IS DISTINCT FROM 'ACTIVE'
         OR hold_record.reserved_at > domain_now OR hold_record.expires_at <= domain_now
         OR interest_record.id IS NULL OR interest_record.task_id IS DISTINCT FROM task_record.id
         OR interest_record.hustler_id IS DISTINCT FROM eligibility.provider_user_id
         OR interest_record.provider_organization_id IS DISTINCT FROM eligibility.provider_organization_id
         OR interest_record.interest_scope_version_id IS DISTINCT FROM scope_record.id
         OR interest_record.universal_contract_version IS DISTINCT FROM 1
         OR interest_record.authority IS DISTINCT FROM 'EXPRESS_INTEREST'
         OR interest_record.status IS DISTINCT FROM 'pending'
         OR NOT EXISTS (
           SELECT 1 FROM public.task_estimate_acceptance_materializations materialization
           JOIN public.provider_estimate_submissions estimate
             ON estimate.id=materialization.provider_estimate_submission_id
            AND estimate.routing_decision_id=materialization.prior_routing_decision_id
           WHERE materialization.task_id=task_record.id
             AND materialization.task_draft_id=draft_record.id
             AND materialization.scope_version_id=scope_record.id
             AND materialization.resulting_routing_decision_id=route_record.id
             AND estimate.id=commitment.provider_estimate_submission_id
             AND estimate.provider_user_id=eligibility.provider_user_id
             AND estimate.provider_organization_id IS NOT DISTINCT FROM eligibility.provider_organization_id
             AND estimate.scope_hash=scope_record.scope_hash
             AND estimate.customer_total_cents=scope_record.customer_total_cents
             AND estimate.currency=scope_record.currency
         ) THEN
        RAISE EXCEPTION 'HXUV1-FINEXEC-13-COMMITMENT_AUTHORITY_REVOKED';
      END IF;
    END IF;
    IF prepared.operation_kind='SECURE' AND public.universal_v1_financial_security_is_current_v1(
      public.universal_v1_effective_financial_security_expiry_v1(prepared.predecessor_event_id),
      pg_catalog.clock_timestamp()) IS NOT TRUE THEN
      RAISE EXCEPTION 'HXUV1-FINEXEC-13-PREDECESSOR_EXPIRED';
    END IF;
    RETURN;
  END IF;

  IF prepared.operation_kind = 'ADJUST' THEN
    -- Preserve the v6 exact witness predicates at the first-effect boundary.
    -- Domain writers take proposal/fulfillment before financial locks; this
    -- caller already owns financial locks and must never wait in reverse order.
    IF prepared.change_order_id IS NULL OR prepared.work_order_id IS NULL
       OR NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(
         'universal-v1-change-order-proposal:' || prepared.change_order_id::TEXT,0))
       OR NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(
         'fulfillment:' || prepared.work_order_id::TEXT,0)) THEN
      RAISE EXCEPTION 'HXUV1-FINEXEC-13-ADJUSTMENT_LOCK_BUSY';
    END IF;
    SELECT * INTO work_order FROM public.task_work_orders
      WHERE id=prepared.work_order_id FOR UPDATE NOWAIT;
    SELECT * INTO task_record FROM public.tasks
      WHERE id=prepared.task_id FOR UPDATE NOWAIT;
    SELECT * INTO draft_record FROM public.task_drafts
      WHERE id=prepared.task_draft_id FOR UPDATE NOWAIT;
    PERFORM 1 FROM public.task_scope_change_proposals
      WHERE id=prepared.change_order_id FOR UPDATE NOWAIT;
    SELECT * INTO eligibility FROM public.task_provider_eligibility_decisions
      WHERE id=prepared.eligibility_decision_id FOR SHARE NOWAIT;
    PERFORM 1 FROM public.task_scope_versions scope
      WHERE scope.id=prepared.scope_version_id OR scope.id IN (
        SELECT witness.base_scope_version_id
        FROM public.universal_v1_change_order_materialization_commands witness
        WHERE witness.proposal_id=prepared.change_order_id
      ) ORDER BY scope.id FOR SHARE NOWAIT;
    -- Approvals and Phase A are immutable. The proposal UPDATE lock also
    -- prevents a concurrent approval insert through its canonical foreign key.
    SELECT pg_catalog.array_agg(actor_id ORDER BY actor_id) INTO adjustment_actor_ids
      FROM (SELECT prepared.recorded_by AS actor_id
        UNION SELECT work_order.provider_user_id
        UNION SELECT approval.actor_id FROM public.task_scope_change_approvals approval
          WHERE approval.proposal_id=prepared.change_order_id) actors;
    PERFORM 1 FROM public.users WHERE id=ANY(adjustment_actor_ids)
      ORDER BY id FOR SHARE NOWAIT;
    PERFORM 1 FROM public.business_organizations
      WHERE id IN (task_record.business_organization_id,work_order.provider_organization_id)
      ORDER BY id FOR SHARE NOWAIT;
    PERFORM 1 FROM public.business_memberships
      WHERE organization_id IN (task_record.business_organization_id,work_order.provider_organization_id)
        AND user_id=ANY(adjustment_actor_ids)
      ORDER BY organization_id,user_id,id FOR SHARE NOWAIT;
    PERFORM 1 FROM public.capability_profiles WHERE user_id=work_order.provider_user_id
      ORDER BY user_id FOR SHARE NOWAIT;
    PERFORM 1 FROM public.business_credentials WHERE id=eligibility.trade_credential_id
      FOR SHARE NOWAIT;
    PERFORM 1 FROM public.verified_trades WHERE user_id=work_order.provider_user_id
      AND provider_organization_id IS NOT DISTINCT FROM work_order.provider_organization_id
      AND business_credential_id IS NOT DISTINCT FROM eligibility.trade_credential_id
      ORDER BY user_id,trade FOR SHARE NOWAIT;
    domain_now := pg_catalog.clock_timestamp();
    IF requested.provider_kind IS DISTINCT FROM 'FAKE'
       OR requested.operation_kind IS DISTINCT FROM prepared.operation_kind
       OR requested.operation_id IS DISTINCT FROM prepared.operation_id
       OR requested.idempotency_key IS DISTINCT FROM prepared.idempotency_key
       OR requested.provider_expected_version IS DISTINCT FROM prepared.provider_expected_version
       OR requested.request_sha256 IS DISTINCT FROM prepared.provider_request_sha256
       OR draft_record.id IS NULL OR draft_record.task_id IS DISTINCT FROM prepared.task_id
       OR draft_record.universal_contract_version IS DISTINCT FROM 1
       OR draft_record.ingress_origin IS DISTINCT FROM 'BACKEND_POSTGRESQL'
       OR draft_record.poster_user_id IS DISTINCT FROM task_record.poster_id
       OR work_order.id IS NULL OR task_record.id IS NULL THEN
      RAISE EXCEPTION 'HXUV1-FINEXEC-13-ADJUSTMENT_AUTHORITY_REVOKED';
    END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.universal_v1_change_order_materialization_commands command
    JOIN public.task_scope_change_proposals proposal ON proposal.id = command.proposal_id
    JOIN public.tasks task ON task.id = command.task_id
    JOIN public.task_work_orders adjustment_work_order ON adjustment_work_order.id = command.work_order_id
    JOIN public.task_provider_eligibility_decisions adjustment_eligibility
      ON adjustment_eligibility.id = command.eligibility_decision_id
    JOIN public.task_scope_versions base_scope
      ON base_scope.id = command.base_scope_version_id
    JOIN public.task_scope_versions replacement
      ON replacement.id = command.replacement_scope_version_id
    JOIN public.task_financial_security_events predecessor
      ON predecessor.id = command.predecessor_event_id
    JOIN public.task_work_order_execution_facts execution
      ON execution.work_order_id = adjustment_work_order.id
     AND execution.scope_version_id = base_scope.id
     AND execution.execution_version = command.expected_execution_version
    JOIN public.users actor ON actor.id = prepared.recorded_by
    JOIN public.users provider ON provider.id = adjustment_work_order.provider_user_id
    JOIN public.task_scope_change_approvals customer_approval
      ON customer_approval.proposal_id = proposal.id
     AND customer_approval.approver_role = 'CUSTOMER'
     AND customer_approval.decision = 'APPROVED'
    JOIN public.task_scope_change_approvals provider_approval
      ON provider_approval.proposal_id = proposal.id
     AND provider_approval.approver_role = 'PROVIDER'
     AND provider_approval.decision = 'APPROVED'
    JOIN public.users customer_approval_actor
      ON customer_approval_actor.id = customer_approval.actor_id
    JOIN public.users provider_approval_actor
      ON provider_approval_actor.id = provider_approval.actor_id
    LEFT JOIN public.business_organizations customer_organization
      ON customer_organization.id = task.business_organization_id
    LEFT JOIN public.business_organizations provider_organization
      ON provider_organization.id = adjustment_work_order.provider_organization_id
    WHERE command.proposal_id = prepared.change_order_id
      AND command.work_order_id = prepared.work_order_id
      AND adjustment_work_order.task_id = command.task_id
      AND adjustment_work_order.task_draft_id = command.task_draft_id
      AND adjustment_work_order.eligibility_decision_id = command.eligibility_decision_id
      AND adjustment_work_order.materialization_version = prepared.work_order_materialization_version
      AND adjustment_work_order.execution_contract_version = prepared.work_order_execution_contract_version
      AND adjustment_eligibility.provider_user_id = adjustment_work_order.provider_user_id
      AND adjustment_eligibility.provider_organization_id IS NOT DISTINCT FROM adjustment_work_order.provider_organization_id
      AND proposal.universal_contract_version = 1
      AND proposal.application_contract_version = 1
      AND proposal.proposed_customer_total_cents = command.customer_total_cents
      AND proposal.proposed_provider_payout_cents = command.provider_payout_cents
      AND proposal.proposal_version = prepared.change_order_version
      AND replacement.version = prepared.scope_version
      AND replacement.scope_hash = prepared.scope_hash
      AND NOT (provider.trust_hold IS TRUE
        AND (provider.trust_hold_until IS NULL OR provider.trust_hold_until > domain_now))
      AND COALESCE((SELECT MAX(amendment.amendment_version)
        FROM public.task_work_order_amendments amendment
        WHERE amendment.work_order_id = command.work_order_id),0) = command.expected_amendment_version
      AND NOT EXISTS (SELECT 1 FROM public.universal_v1_change_order_compensation_commands compensation
        WHERE compensation.proposal_id = command.proposal_id)
      AND NOT EXISTS (SELECT 1 FROM public.universal_v1_change_order_recovery_terminal_facts terminal
        WHERE terminal.proposal_id = command.proposal_id)
      AND command.idempotency_key || ':adjust' = prepared.idempotency_key
      AND command.adjustment_operation_id = prepared.operation_id
      AND command.actor_user_id = prepared.recorded_by
      AND command.task_draft_id = prepared.task_draft_id
      AND command.task_id = prepared.task_id
      AND command.eligibility_decision_id = prepared.eligibility_decision_id
      AND command.replacement_scope_version_id = prepared.scope_version_id
      AND command.predecessor_event_id = prepared.predecessor_event_id
      AND command.predecessor_operation_id = prepared.related_operation_id
      AND command.customer_total_cents = prepared.amount_cents
      AND command.currency = prepared.currency
      AND command.expected_financial_version + 1 = prepared.lifecycle_expected_version
      AND prepared.provider_kind = 'FAKE'
      AND prepared.provider_expected_version = 0
      AND proposal.status = 'APPROVED'
      AND proposal.change_order_kind = 'PRICE_AND_SCOPE'
      AND proposal.financial_adjustment_required IS TRUE
      AND proposal.proposal_version = command.expected_proposal_version
      AND proposal.base_version_id = command.base_scope_version_id
      AND proposal.approved_version_id = command.replacement_scope_version_id
      AND proposal.reviewed_by = command.actor_user_id
      AND task.work_order_id = adjustment_work_order.id
      AND task.active_scope_version_id = command.base_scope_version_id
      AND task.worker_id IS NULL
      AND task.universal_contract_version = 1
      AND task.automation_classification = 'CONTROLLED_TEST'
      AND task.universal_payment_posture = 'PAYMENT_CREATION_FROZEN'
      AND public.universal_v1_effective_work_order_scope_id(adjustment_work_order.id) =
        command.base_scope_version_id
      AND base_scope.version = command.expected_scope_version
      AND replacement.task_id = task.id
      AND replacement.version = command.expected_scope_version + 1
      AND replacement.supersedes_version_id = base_scope.id
      AND replacement.source = 'APPROVED_CHANGE'
      AND replacement.scope_hash = proposal.proposed_scope_sha256
      AND replacement.customer_total_cents = command.customer_total_cents
      AND replacement.hustler_payout_cents = command.provider_payout_cents
      AND replacement.currency = command.currency
      AND predecessor.task_draft_id = command.task_draft_id
      AND predecessor.task_id = command.task_id
      AND predecessor.eligibility_decision_id = command.eligibility_decision_id
      AND predecessor.scope_version_id = command.base_scope_version_id
      AND predecessor.operation_id = command.predecessor_operation_id::TEXT
      AND predecessor.expected_version = command.expected_financial_version
      AND predecessor.event_kind IN ('SECURED', 'ADJUSTMENT_AUTHORIZED')
      AND predecessor.status = 'SUCCEEDED'
      AND predecessor.provider_kind = 'FAKE'
      AND NOT EXISTS (
        SELECT 1 FROM public.task_financial_security_events newer_financial
        WHERE newer_financial.task_draft_id = command.task_draft_id
          AND newer_financial.expected_version > predecessor.expected_version
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.task_work_order_execution_facts newer_execution
        WHERE newer_execution.work_order_id = adjustment_work_order.id
          AND newer_execution.execution_version > execution.execution_version
      )
      AND execution.state IN ('MATERIALIZED','ACKNOWLEDGED','EN_ROUTE','ARRIVED','PAUSED')
      AND actor.account_status = 'ACTIVE'
      AND actor.is_minor IS FALSE
      AND COALESCE(actor.is_banned, FALSE) IS FALSE
      AND provider.account_status = 'ACTIVE'
      AND provider.is_minor IS FALSE
      AND COALESCE(provider.is_banned, FALSE) IS FALSE
      AND customer_approval_actor.account_status = 'ACTIVE'
      AND customer_approval_actor.is_minor IS FALSE
      AND COALESCE(customer_approval_actor.is_banned, FALSE) IS FALSE
      AND provider_approval_actor.account_status = 'ACTIVE'
      AND provider_approval_actor.is_minor IS FALSE
      AND COALESCE(provider_approval_actor.is_banned, FALSE) IS FALSE
      AND (
        (task.business_organization_id IS NULL AND task.poster_id = prepared.recorded_by)
        OR (
          task.business_organization_id IS NOT NULL
          AND customer_organization.status = 'ACTIVE'
          AND customer_organization.client_enabled IS TRUE
          AND public.business_membership_has_action(
            task.business_organization_id, prepared.recorded_by, 'APPROVE_SPEND'
          )
        )
      )
      AND (
        (task.business_organization_id IS NULL AND customer_approval.actor_id = task.poster_id)
        OR (
          task.business_organization_id IS NOT NULL
          AND customer_organization.status = 'ACTIVE'
          AND customer_organization.client_enabled IS TRUE
          AND public.business_membership_has_action(
            task.business_organization_id, customer_approval.actor_id, 'APPROVE_SPEND'
          )
        )
      )
      AND (
        provider_approval.actor_id = adjustment_work_order.provider_user_id
        OR (
          adjustment_work_order.provider_organization_id IS NOT NULL
          AND provider_organization.status = 'ACTIVE'
          AND provider_organization.provider_enabled IS TRUE
          AND public.business_membership_has_action(
            adjustment_work_order.provider_organization_id,
            provider_approval.actor_id,
            'APPROVE_SPEND'
          )
        )
      )
      AND customer_approval.actor_id <> provider_approval.actor_id
      AND public.universal_v1_invited_provider_authority_is_current(
        adjustment_eligibility.provider_user_id,
        adjustment_eligibility.provider_organization_id,
        adjustment_eligibility.provider_class,
        adjustment_eligibility.trade_credential_id,
        task.category,
        task.region_code
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.task_work_order_amendments amendment
        WHERE amendment.change_order_id = command.proposal_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.task_completion_facts completion
        WHERE completion.work_order_id = adjustment_work_order.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.task_reconciliation_facts reconciliation
        WHERE reconciliation.work_order_id = adjustment_work_order.id
      )

  ) THEN
      RAISE EXCEPTION 'HXUV1-FINEXEC-13-ADJUSTMENT_AUTHORITY_REVOKED';
    END IF;
    -- Post-Work-Order ADJUST retains current provider/approval authority;
    -- pre-Work-Order hold or eligibility TTLs are not new requirements here.
    IF public.universal_v1_financial_security_is_current_v1(
      public.universal_v1_effective_financial_security_expiry_v1(prepared.predecessor_event_id),
      pg_catalog.clock_timestamp()) IS NOT TRUE THEN
      RAISE EXCEPTION 'HXUV1-FINEXEC-13-PREDECESSOR_EXPIRED';
    END IF;
    RETURN;
  END IF;

  IF prepared.work_order_id IS NULL
     OR prepared.operation_kind NOT IN (
       'CAPTURE', 'REFUND', 'SETTLE', 'FUND',
       'PROVIDER_RELEASE', 'PAYOUT', 'OBSERVE_BANK_SETTLEMENT'
     ) THEN
    RETURN;
  END IF;

  SELECT * INTO task_record
    FROM public.tasks
   WHERE id = prepared.task_id
   FOR SHARE;
  SELECT * INTO work_order
    FROM public.task_work_orders
   WHERE id = prepared.work_order_id
   FOR SHARE;
  IF task_record.id IS NULL OR task_record.automation_classification IS DISTINCT FROM 'CONTROLLED_TEST' THEN
    RAISE EXCEPTION 'HXUV1-FINEXEC-13-CONTROLLED_TASK_REQUIRED';
  END IF;

  SELECT * INTO intent
    FROM public.universal_v1_fake_terminal_lifecycle_intents
   WHERE work_order_id = prepared.work_order_id
   FOR SHARE;
  SELECT * INTO eligibility
    FROM public.task_provider_eligibility_decisions
   WHERE id = prepared.eligibility_decision_id
   FOR SHARE;
  IF intent.terminal_intent_id IS NULL
     OR eligibility.id IS NULL
     OR work_order.id IS NULL
     OR requested.provider_kind <> 'FAKE'
     OR requested.operation_kind <> prepared.operation_kind
     OR requested.operation_id <> prepared.operation_id
     OR requested.idempotency_key <> prepared.idempotency_key
     OR requested.provider_expected_version <> prepared.provider_expected_version
     OR requested.request_sha256 <> prepared.provider_request_sha256
     OR requested.prepared_authority_sha256 <> prepared.authority_context_sha256
     OR requested.work_order_id <> intent.work_order_id
     OR requested.task_draft_id <> intent.task_draft_id
     OR requested.task_id <> intent.task_id
     OR prepared.eligibility_decision_id <> intent.eligibility_decision_id
     OR prepared.scope_version_id <> intent.scope_version_id
     OR prepared.recorded_by <> intent.requested_by
     OR work_order.task_id <> intent.task_id
     OR work_order.task_draft_id <> intent.task_draft_id
     OR work_order.eligibility_decision_id <> intent.eligibility_decision_id
     OR work_order.provider_user_id <> eligibility.provider_user_id
     OR work_order.provider_organization_id IS DISTINCT FROM
        eligibility.provider_organization_id
     OR p_request_sha256 <> requested.request_sha256 THEN
    RAISE EXCEPTION 'HXUV1-FTL-46: terminal dispatch does not retain the exact PREPARED, REQUESTED, and intent authority chain'
      USING ERRCODE = 'P0001';
  END IF;

  IF intent.terminal_path = 'SETTLED' THEN
    PERFORM pg_advisory_xact_lock(
      hashtext('universal-v1-fake-provider-account-v1'),
      hashtext(intent.provider_subject_kind || ':' || intent.provider_subject_id::TEXT)
    );
  END IF;

  -- This task lock orders the common final incident/current-eligibility check
  -- against task FK locks taken by concurrent incident or eligibility inserts,
  -- and prevents assignment/posture changes from racing either terminal path.
  SELECT * INTO task_record
    FROM public.tasks
   WHERE id = intent.task_id
   FOR UPDATE;
  IF task_record.id IS NULL
     OR task_record.universal_payment_posture <> 'PAYMENT_CREATION_FROZEN'
     OR task_record.worker_id IS NOT NULL
     OR task_record.work_order_id IS DISTINCT FROM intent.work_order_id
     OR eligibility.task_draft_id <> intent.task_draft_id
     OR eligibility.task_id IS DISTINCT FROM intent.task_id
     OR eligibility.scope_version_id IS DISTINCT FROM intent.scope_version_id
     OR eligibility.task_eligible IS NOT TRUE
     OR eligibility.processor_payment_eligible IS NOT FALSE
     OR eligibility.valid_until <= clock_timestamp()
     OR eligibility.evaluated_at > clock_timestamp()
     OR EXISTS (
       SELECT 1
         FROM public.task_provider_eligibility_decisions newer
        WHERE newer.task_draft_id = eligibility.task_draft_id
          AND newer.provider_user_id IS NOT DISTINCT FROM eligibility.provider_user_id
          AND newer.provider_organization_id IS NOT DISTINCT FROM
              eligibility.provider_organization_id
          AND newer.decision_version > eligibility.decision_version
     )
     OR EXISTS (
       SELECT 1
         FROM public.task_safety_incidents incident
        WHERE incident.task_id = intent.task_id
          AND incident.status NOT IN ('resolved', 'closed')
     ) THEN
    RAISE EXCEPTION 'HXUV1-FTL-47: terminal dispatch requires current frozen, unassigned, incident-free task and eligibility authority'
      USING ERRCODE = 'P0001';
  END IF;

  IF intent.terminal_path = 'SETTLED' THEN
    -- The eligibility helper takes the shared provider/org/membership/
    -- credential locks used by invitation authority, eliminating a
    -- check-then-revocation provider race for positive settlement steps.
    PERFORM public.lock_universal_v1_estimate_authority(
      eligibility.task_draft_id,
      eligibility.provider_user_id,
      eligibility.provider_organization_id,
      eligibility.trade_credential_id,
      eligibility.provider_user_id
    );
    SELECT * INTO account_fact
      FROM public.universal_v1_fake_provider_account_facts
     WHERE provider_account_fact_id = intent.provider_account_fact_id
     FOR SHARE;
    IF account_fact.provider_account_fact_id IS NULL
       OR account_fact.provider_subject_kind <> intent.provider_subject_kind
       OR COALESCE(account_fact.provider_user_id, account_fact.provider_organization_id)
          <> intent.provider_subject_id
       OR account_fact.account_state <> 'ENABLED'
       OR account_fact.charges_enabled IS NOT TRUE
       OR account_fact.payouts_enabled IS NOT TRUE
       OR eligibility.payout_funding_eligible IS NOT FALSE
       OR EXISTS (
         SELECT 1
           FROM public.universal_v1_fake_provider_account_facts newer
          WHERE newer.provider_subject_kind = account_fact.provider_subject_kind
            AND newer.provider_user_id IS NOT DISTINCT FROM account_fact.provider_user_id
            AND newer.provider_organization_id IS NOT DISTINCT FROM
                account_fact.provider_organization_id
            AND newer.account_version > account_fact.account_version
       )
       OR public.universal_v1_invited_provider_authority_is_current(
            eligibility.provider_user_id,
            eligibility.provider_organization_id,
            eligibility.provider_class,
            eligibility.trade_credential_id,
            task_record.category,
            task_record.region_code
          ) IS NOT TRUE THEN
      RAISE EXCEPTION 'HXUV1-FTL-47: SETTLED dispatch requires current provider, payout, and latest enabled account authority'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF prepared.operation_kind IN ('SECURE', 'ADJUST', 'CAPTURE') AND
     public.universal_v1_financial_security_is_current_v1(
       public.universal_v1_effective_financial_security_expiry_v1(prepared.predecessor_event_id),
       pg_catalog.clock_timestamp()
     ) IS NOT TRUE THEN
    RAISE EXCEPTION 'HXUV1-FINEXEC-13-PREDECESSOR_EXPIRED';
  END IF;
  IF eligibility.valid_until <= pg_catalog.clock_timestamp() THEN
    RAISE EXCEPTION 'HXUV1-FINEXEC-13-ELIGIBILITY_EXPIRED';
  END IF;
  RETURN;
END;
$$;

-- Historical events remain unbound. No mutation or later adoption is allowed.
ALTER TABLE public.hxos_fake_financial_operation_events_v1
  ADD COLUMN admitted_job_validation_id UUID UNIQUE
    REFERENCES hx_authority.fake_financial_job_validations_v13(job_validation_id)
    ON DELETE RESTRICT,
  ADD COLUMN execution_transaction_id XID8,
  ADD COLUMN projection_contract_version SMALLINT NOT NULL DEFAULT 1 CHECK (projection_contract_version IN (1,2)),
  ADD CONSTRAINT admitted_fake_event_transaction_v13 CHECK (
    admitted_job_validation_id IS NULL OR (execution_transaction_id IS NOT NULL AND execution_transaction_id > '0'::pg_catalog.xid8)
  );

CREATE OR REPLACE FUNCTION public.hxos_execute_admitted_fake_financial_request_v13(
  p_job_validation_id UUID, p_worker_instance_id UUID
)
RETURNS TABLE (
  event_id UUID, operation_id UUID, operation_kind TEXT, event_version INTEGER,
  state TEXT, scenario TEXT, amount_cents BIGINT, currency TEXT,
  related_operation_id UUID, external_reference TEXT, idempotency_key TEXT,
  identity_sha256 TEXT, request_sha256 TEXT, provider_request_sha256 TEXT,
  response_sha256 TEXT, retryable BOOLEAN, metadata JSONB,
  recorded_at TIMESTAMPTZ, expires_at TIMESTAMPTZ,
  admitted_job_validation_id UUID, projection_contract_version SMALLINT, idempotency_replayed BOOLEAN
)
LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
DECLARE
  admission RECORD;
  projection JSONB;
  operation public.hxos_fake_financial_operations_v1%ROWTYPE;
  observed public.hxos_fake_financial_operation_events_v1%ROWTYPE;
  current_version BIGINT;
  observation_time TIMESTAMPTZ;
  replayed BOOLEAN := FALSE;
BEGIN
  SELECT * INTO STRICT admission FROM public.hxos_read_admitted_fake_financial_request_v13(
    p_job_validation_id, p_worker_instance_id
  );
  projection := hx_authority.derive_fake_financial_projection_v13(
    admission.operation_kind, admission.canonical_provider_request, 2::SMALLINT
  );
  IF projection ->> 'providerRequestSha256' IS DISTINCT FROM admission.provider_request_sha256 THEN
    RAISE EXCEPTION 'HXUV1-FINEXEC-13-REQUEST_HASH_MISMATCH';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('fake-financial-operation'), pg_catalog.hashtext(admission.operation_id::TEXT)
  );
  SELECT stored.* INTO observed FROM public.hxos_fake_financial_operation_events_v1 stored
    WHERE stored.idempotency_key = admission.idempotency_key;
  IF observed.event_id IS NOT NULL THEN
    projection := hx_authority.derive_fake_financial_projection_v13(
      admission.operation_kind,admission.canonical_provider_request,observed.projection_contract_version
    );
    IF observed.admitted_job_validation_id IS DISTINCT FROM p_job_validation_id
       OR observed.operation_id IS DISTINCT FROM admission.operation_id
       OR observed.operation_kind IS DISTINCT FROM admission.operation_kind
       OR observed.event_version IS DISTINCT FROM admission.provider_expected_version + 1
       OR observed.identity_sha256 IS DISTINCT FROM projection ->> 'identitySha256'
       OR observed.request_sha256 IS DISTINCT FROM projection ->> 'requestSha256'
       OR observed.provider_request_sha256 IS DISTINCT FROM admission.provider_request_sha256
       OR observed.response_sha256 IS DISTINCT FROM projection ->> 'responseSha256'
       OR observed.state IS DISTINCT FROM projection ->> 'state'
       OR observed.scenario IS DISTINCT FROM projection ->> 'scenario'
       OR observed.amount_cents IS DISTINCT FROM (projection ->> 'amountCents')::BIGINT
       OR observed.currency IS DISTINCT FROM projection ->> 'currency'
       OR observed.related_operation_id IS DISTINCT FROM (projection ->> 'relatedOperationId')::UUID
       OR observed.external_reference IS DISTINCT FROM projection ->> 'externalReference'
       OR observed.retryable IS DISTINCT FROM (projection ->> 'retryable')::BOOLEAN
       OR observed.metadata IS DISTINCT FROM projection -> 'metadata' THEN
      RAISE EXCEPTION 'HXUV1-FINEXEC-13-EVENT_PROVENANCE_CONFLICT';
    END IF;
    replayed := TRUE;
  ELSE
    IF admission.provider_expected_version >= 2147483647 THEN
      RAISE EXCEPTION 'HXUV1-FINEXEC-13-EVENT_VERSION_EXHAUSTED';
    END IF;
    SELECT stored.* INTO operation FROM public.hxos_fake_financial_operations_v1 stored
      WHERE stored.operation_id = admission.operation_id FOR UPDATE;
    SELECT COALESCE(pg_catalog.max(stored.event_version),0) INTO current_version
      FROM public.hxos_fake_financial_operation_events_v1 stored WHERE stored.operation_id = admission.operation_id;
    IF current_version IS DISTINCT FROM admission.provider_expected_version THEN
      RAISE EXCEPTION 'HXUV1-FINEXEC-13-VERSION_CONFLICT';
    END IF;
    IF operation.operation_id IS NOT NULL AND (
      operation.identity_sha256 IS DISTINCT FROM projection ->> 'identitySha256'
      OR operation.operation_kind IS DISTINCT FROM admission.operation_kind
      OR operation.external_reference IS DISTINCT FROM projection ->> 'externalReference'
      OR operation.amount_cents IS DISTINCT FROM (projection ->> 'amountCents')::BIGINT
      OR operation.currency IS DISTINCT FROM projection ->> 'currency'
      OR operation.related_operation_id IS DISTINCT FROM (projection ->> 'relatedOperationId')::UUID
    ) THEN RAISE EXCEPTION 'HXUV1-FINEXEC-13-OPERATION_IDENTITY_CONFLICT'; END IF;
    IF operation.operation_id IS NULL THEN
      INSERT INTO public.hxos_fake_financial_operations_v1 (
        operation_id, operation_kind, identity_sha256, external_reference,
        amount_cents, currency, related_operation_id
      ) VALUES (
        admission.operation_id, admission.operation_kind, projection ->> 'identitySha256',
        projection ->> 'externalReference', (projection ->> 'amountCents')::BIGINT,
        projection ->> 'currency', (projection ->> 'relatedOperationId')::UUID
      ) RETURNING * INTO operation;
    END IF;
    PERFORM pg_catalog.pg_sleep_until(pg_catalog.date_trunc('milliseconds', operation.created_at) + INTERVAL '1 millisecond');
    -- Domain and lease checks run after the operation lock and causal wait.
    -- All writes above roll back if those checks fail; there is no provider I/O
    -- outside PostgreSQL and no canonical lifecycle effect in this function.
    PERFORM hx_authority.assert_fake_financial_execution_domain_v13(
      admission.command_id, admission.provider_request_sha256
    );
    PERFORM public.hxos_read_admitted_fake_financial_request_v13(p_job_validation_id, p_worker_instance_id);
    observation_time := pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp());
    INSERT INTO public.hxos_fake_financial_operation_events_v1 (
      operation_id, operation_kind, event_version, state, scenario, amount_cents,
      currency, related_operation_id, external_reference, idempotency_key,
      identity_sha256, request_sha256, provider_request_sha256, response_sha256,
      retryable, metadata, recorded_at, expires_at, admitted_job_validation_id, execution_transaction_id, projection_contract_version
    ) VALUES (
      admission.operation_id, admission.operation_kind, (current_version + 1)::INTEGER,
      projection ->> 'state', projection ->> 'scenario', (projection ->> 'amountCents')::BIGINT,
      projection ->> 'currency', (projection ->> 'relatedOperationId')::UUID,
      projection ->> 'externalReference', admission.idempotency_key,
      projection ->> 'identitySha256', projection ->> 'requestSha256',
      admission.provider_request_sha256, projection ->> 'responseSha256',
      (projection ->> 'retryable')::BOOLEAN, projection -> 'metadata', observation_time,
      CASE WHEN projection ->> 'state' = 'SUCCEEDED' AND admission.operation_kind IN ('AUTHORIZE','SECURE','ADJUST')
        THEN observation_time + INTERVAL '15 minutes' ELSE NULL END,
      p_job_validation_id, pg_catalog.pg_current_xact_id(), 2
    ) RETURNING * INTO observed;
  END IF;
  RETURN QUERY SELECT observed.event_id, observed.operation_id, observed.operation_kind,
    observed.event_version, observed.state, observed.scenario, observed.amount_cents,
    pg_catalog.btrim(observed.currency), observed.related_operation_id, observed.external_reference,
    observed.idempotency_key, pg_catalog.btrim(observed.identity_sha256),
    pg_catalog.btrim(observed.request_sha256), pg_catalog.btrim(observed.provider_request_sha256),
    pg_catalog.btrim(observed.response_sha256), observed.retryable, observed.metadata,
    observed.recorded_at, observed.expires_at, observed.admitted_job_validation_id, observed.projection_contract_version, replayed;
END;
$$;


-- Historical evidence only. Publication, elapsed execution deadlines and a
-- replaced target do not erase an already committed fake-provider observation.
-- This port grants no dispatch, lifecycle, money or production capability.
CREATE OR REPLACE FUNCTION public.hxos_read_fake_financial_recovery_evidence_v13(
  p_outbox_request_id UUID, p_bullmq_job_id TEXT, p_job_authority_sha256 TEXT
)
RETURNS TABLE (request_evidence JSONB, admission_evidence JSONB, provider_event JSONB)
LANGUAGE plpgsql SECURITY DEFINER STABLE PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
DECLARE
  request_record hx_authority.fake_financial_command_outbox_requests_v13%ROWTYPE;
  exact_request hx_authority.fake_financial_exact_requests_v13%ROWTYPE;
  validation hx_authority.fake_financial_job_validations_v13%ROWTYPE;
  observed public.hxos_fake_financial_operation_events_v1%ROWTYPE;
  admission JSONB;
  projection JSONB;
  request_json JSONB;
  event_json JSONB;
BEGIN
  IF p_outbox_request_id IS NULL OR p_bullmq_job_id IS NULL
     OR p_job_authority_sha256 IS NULL OR p_job_authority_sha256 !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'HXUV1-FINREC-13-INPUT_INVALID';
  END IF;
  SELECT request.* INTO request_record
    FROM hx_authority.fake_financial_command_outbox_requests_v13 request
    JOIN public.financial_provider_command_journal command
      ON command.command_id = request.command_id
     AND command.command_state = 'REQUESTED' AND command.provider_kind = 'FAKE'
     AND command.command_identity_sha256 = request.command_identity_sha256
     AND command.operation_id = request.operation_id AND command.operation_kind = request.operation_kind
     AND command.idempotency_key = request.idempotency_key
     AND command.provider_expected_version = request.provider_expected_version
     AND command.request_sha256 = request.provider_request_sha256
     AND command.prepared_financial_command_id = request.prepared_command_id
     AND command.prepared_authority_sha256 = request.prepared_authority_sha256
     AND command.release_environment = request.release_environment
     AND command.release_manifest_digest = request.release_manifest_digest
     AND command.release_id = request.release_id AND command.release_revision = request.release_revision
     AND command.release_authentication_status = 'VERIFIED'
    JOIN public.universal_v1_prepared_financial_commands prepared
      ON prepared.prepared_command_id = request.prepared_command_id
     AND prepared.authority_context_sha256 = request.prepared_authority_sha256
     AND prepared.provider_request_sha256 = request.provider_request_sha256
     AND prepared.operation_kind = request.operation_kind AND prepared.operation_id = request.operation_id
     AND prepared.provider_kind = 'FAKE' AND prepared.idempotency_key = request.idempotency_key
     AND prepared.provider_expected_version = request.provider_expected_version
    JOIN hx_authority.universal_v1_work_order_target_authority_facts target
      ON target.target_authority_id = request.target_authority_id
     AND target.authority_version = request.target_authority_version
     AND target.target_database_name = request.target_database_name
     AND target.environment = request.release_environment
     AND target.release_manifest_sha256 = request.release_manifest_digest
   WHERE request.outbox_request_id = p_outbox_request_id
     AND request.bullmq_job_id = p_bullmq_job_id
     AND request.job_authority_sha256 = p_job_authority_sha256
     AND request.target_database_name = pg_catalog.current_database()
     AND request.release_environment IN ('local','preview','staging')
     AND request.positive_money_capability IS FALSE AND request.production_capability IS FALSE;
  IF request_record.outbox_request_id IS NULL THEN
    RAISE EXCEPTION 'HXUV1-FINREC-13-REQUEST_NOT_FOUND';
  END IF;
  SELECT exact.* INTO exact_request
    FROM hx_authority.fake_financial_exact_requests_v13 exact
    JOIN public.financial_provider_command_journal command
      ON command.command_id = exact.command_id
     AND command.requested_transaction_id = exact.recorded_transaction_id
   WHERE exact.command_id = request_record.command_id
     AND exact.provider_request_sha256 = request_record.provider_request_sha256;
  IF exact_request.command_id IS NULL THEN
    RAISE EXCEPTION 'HXUV1-FINREC-13-EXACT_REQUEST_MISSING';
  END IF;
  IF exact_request.recorded_transaction_id = pg_catalog.pg_current_xact_id_if_assigned() THEN
    RAISE EXCEPTION 'HXUV1-FINREC-13-COMMITTED_REQUEST_REQUIRED';
  END IF;
  projection := hx_authority.derive_fake_financial_projection_v13(
    request_record.operation_kind, exact_request.canonical_provider_request
  );
  IF projection ->> 'providerRequestSha256' IS DISTINCT FROM pg_catalog.btrim(request_record.provider_request_sha256) THEN
    RAISE EXCEPTION 'HXUV1-FINREC-13-REQUEST_HASH_MISMATCH';
  END IF;
  request_json := pg_catalog.jsonb_build_object(
    'command_id', request_record.command_id,
    'outbox_request_id', request_record.outbox_request_id,
    'bullmq_job_id', request_record.bullmq_job_id,
    'job_authority_sha256', request_record.job_authority_sha256,
    'operation_kind', request_record.operation_kind,
    'operation_id', request_record.operation_id,
    'idempotency_key', request_record.idempotency_key,
    'provider_expected_version', request_record.provider_expected_version,
    'provider_request_sha256', request_record.provider_request_sha256,
    'command_identity_sha256', request_record.command_identity_sha256,
    'prepared_command_id', request_record.prepared_command_id,
    'prepared_authority_sha256', request_record.prepared_authority_sha256,
    'payload_contract_version', exact_request.payload_contract_version,
    'canonical_provider_request', exact_request.canonical_provider_request,
    'target_authority_id', request_record.target_authority_id,
    'target_authority_version', request_record.target_authority_version,
    'target_database_name', request_record.target_database_name,
    'release_environment', request_record.release_environment,
    'release_manifest_digest', request_record.release_manifest_digest,
    'release_id', request_record.release_id,
    'release_revision', request_record.release_revision
  );
  SELECT stored.* INTO observed FROM public.hxos_fake_financial_operation_events_v1 stored
   WHERE stored.idempotency_key = request_record.idempotency_key;
  IF observed.event_id IS NULL THEN
    -- A missing observation is only absence in this snapshot, never proof that
    -- a provider call did not happen and never permission to redispatch.
    SELECT candidate.* INTO validation
      FROM hx_authority.fake_financial_job_validations_v13 candidate
      JOIN public.financial_provider_command_dispatch_attempts attempt
        ON attempt.dispatch_attempt_id = candidate.dispatch_attempt_id
       AND attempt.command_id = candidate.command_id
     WHERE candidate.outbox_request_id = request_record.outbox_request_id
       AND candidate.command_id = request_record.command_id
     ORDER BY attempt.attempt_number DESC LIMIT 1;
  ELSE
    projection := hx_authority.derive_fake_financial_projection_v13(
      request_record.operation_kind,exact_request.canonical_provider_request,observed.projection_contract_version
    );
    SELECT candidate.* INTO validation
      FROM hx_authority.fake_financial_job_validations_v13 candidate
     WHERE candidate.job_validation_id = observed.admitted_job_validation_id
       AND candidate.outbox_request_id = request_record.outbox_request_id
       AND candidate.command_id = request_record.command_id;
    IF validation.job_validation_id IS NULL OR observed.execution_transaction_id IS NULL
       OR observed.operation_id IS DISTINCT FROM request_record.operation_id
       OR observed.operation_kind IS DISTINCT FROM request_record.operation_kind
       OR observed.event_version IS DISTINCT FROM request_record.provider_expected_version + 1
       OR observed.identity_sha256 IS DISTINCT FROM projection ->> 'identitySha256'
       OR observed.request_sha256 IS DISTINCT FROM projection ->> 'requestSha256'
       OR observed.provider_request_sha256 IS DISTINCT FROM request_record.provider_request_sha256
       OR observed.response_sha256 IS DISTINCT FROM projection ->> 'responseSha256'
       OR observed.state IS DISTINCT FROM projection ->> 'state'
       OR observed.scenario IS DISTINCT FROM projection ->> 'scenario'
       OR observed.amount_cents IS DISTINCT FROM (projection ->> 'amountCents')::BIGINT
       OR observed.currency IS DISTINCT FROM projection ->> 'currency'
       OR observed.related_operation_id IS DISTINCT FROM (projection ->> 'relatedOperationId')::UUID
       OR observed.external_reference IS DISTINCT FROM projection ->> 'externalReference'
       OR observed.retryable IS DISTINCT FROM (projection ->> 'retryable')::BOOLEAN
       OR observed.metadata IS DISTINCT FROM projection -> 'metadata' THEN
      RAISE EXCEPTION 'HXUV1-FINREC-13-EVENT_PROVENANCE_CONFLICT';
    END IF;
    IF observed.execution_transaction_id = pg_catalog.pg_current_xact_id_if_assigned() THEN
      RAISE EXCEPTION 'HXUV1-FINREC-13-COMMITTED_EVENT_REQUIRED';
    END IF;
    event_json := pg_catalog.jsonb_build_object(
    'event_id', observed.event_id,
    'operation_id', observed.operation_id,
    'operation_kind', observed.operation_kind,
    'event_version', observed.event_version,
    'state', observed.state,
    'scenario', observed.scenario,
    'amount_cents', observed.amount_cents,
    'currency', observed.currency,
    'related_operation_id', observed.related_operation_id,
    'external_reference', observed.external_reference,
    'idempotency_key', observed.idempotency_key,
    'identity_sha256', observed.identity_sha256,
    'request_sha256', observed.request_sha256,
    'provider_request_sha256', observed.provider_request_sha256,
    'response_sha256', observed.response_sha256,
    'retryable', observed.retryable,
    'metadata', observed.metadata,
    'recorded_at', observed.recorded_at,
    'expires_at', observed.expires_at,
    'admitted_job_validation_id', observed.admitted_job_validation_id,
    'projection_contract_version', observed.projection_contract_version,
    'idempotency_replayed', TRUE
  );
  END IF;
  IF validation.job_validation_id IS NOT NULL THEN
    SELECT pg_catalog.to_jsonb(evidence) INTO admission
      FROM hx_authority.read_fake_financial_admission_evidence_v13(
        validation.job_validation_id, validation.worker_instance_id
      ) evidence;
    IF admission IS NULL THEN RAISE EXCEPTION 'HXUV1-FINREC-13-ADMISSION_MISSING'; END IF;
  END IF;
  RETURN QUERY SELECT request_json, admission, event_json;
END;
$$;

CREATE OR REPLACE FUNCTION public.validate_fake_financial_legacy_expiry_compensation_v9()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  disposition public.hxos_fake_financial_legacy_expiry_dispositions_v9%ROWTYPE;
  source_event public.hxos_fake_financial_operation_events_v1%ROWTYPE;
  compensation_event public.hxos_fake_financial_operation_events_v1%ROWTYPE;
  command public.hxos_fake_financial_legacy_expiry_compensation_commands_v9%ROWTYPE;
  attempt public.hxos_fake_financial_legacy_expiry_compensation_attempts_v9%ROWTYPE;
  outcome public.hxos_fake_financial_legacy_expiry_compensation_outcomes_v9%ROWTYPE;
  expected_compensation_kind TEXT;
  expected_compensation_state TEXT;
  expected_idempotency_key TEXT;
BEGIN
  SELECT * INTO disposition
    FROM public.hxos_fake_financial_legacy_expiry_dispositions_v9
   WHERE fake_operation_event_id = NEW.source_fake_operation_event_id
   FOR SHARE;
  SELECT * INTO source_event
    FROM public.hxos_fake_financial_operation_events_v1
   WHERE event_id = NEW.source_fake_operation_event_id
   FOR SHARE;
  SELECT * INTO compensation_event
    FROM public.hxos_fake_financial_operation_events_v1
   WHERE event_id = NEW.compensation_fake_operation_event_id
   FOR SHARE;
  SELECT * INTO command
    FROM public.hxos_fake_financial_legacy_expiry_compensation_commands_v9
   WHERE command_id = NEW.compensation_command_id
   FOR SHARE;
  SELECT * INTO attempt
    FROM public.hxos_fake_financial_legacy_expiry_compensation_attempts_v9
   WHERE dispatch_attempt_id = NEW.dispatch_attempt_id
   FOR SHARE;
  SELECT * INTO outcome
    FROM public.hxos_fake_financial_legacy_expiry_compensation_outcomes_v9
   WHERE outcome_fact_id = NEW.outcome_fact_id
   FOR SHARE;

  expected_compensation_kind := CASE
    WHEN source_event.operation_kind IN ('AUTHORIZE', 'SECURE') THEN 'VOID'
    WHEN source_event.operation_kind = 'ADJUST' THEN 'REVERSAL'
    ELSE NULL
  END;
  expected_compensation_state := CASE
    WHEN expected_compensation_kind = 'VOID' THEN 'VOIDED'
    WHEN expected_compensation_kind = 'REVERSAL' THEN 'REVERSED'
    ELSE NULL
  END;
  expected_idempotency_key :=
    'legacy-expiry-compensation:v9:' || source_event.event_id::TEXT;

  IF disposition.fake_operation_event_id IS NULL
     OR disposition.disposition <> 'LEGACY_EXPIRY_UNPROVEN'
     OR disposition.recovery_state <> 'COMPENSATION_REQUIRED'
     OR disposition.recovery_terminal
     OR NOT disposition.recovery_retryable
     OR source_event.event_id IS NULL
     OR compensation_event.event_id IS NULL
     OR command.source_fake_operation_event_id IS DISTINCT FROM source_event.event_id
     OR command.compensation_operation_id IS DISTINCT FROM compensation_event.operation_id
     OR attempt.command_id IS DISTINCT FROM command.command_id
     OR outcome.command_id IS DISTINCT FROM command.command_id
     OR outcome.dispatch_attempt_id IS DISTINCT FROM attempt.dispatch_attempt_id
     OR outcome.compensation_fake_operation_event_id IS DISTINCT FROM compensation_event.event_id
     OR compensation_event.operation_kind IS DISTINCT FROM expected_compensation_kind
     OR compensation_event.state IS DISTINCT FROM expected_compensation_state
     OR compensation_event.scenario <> 'SUCCESS'
     OR compensation_event.event_version <> 1
     OR compensation_event.related_operation_id IS DISTINCT FROM source_event.operation_id
     OR compensation_event.amount_cents IS DISTINCT FROM source_event.amount_cents
     OR compensation_event.currency IS DISTINCT FROM source_event.currency
     OR compensation_event.idempotency_key IS DISTINCT FROM expected_idempotency_key
     OR compensation_event.expires_at IS NOT NULL THEN
    RAISE EXCEPTION 'HXUV1-FSE-V9-10: legacy expiry compensation is not the exact bounded fake recovery event'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.source_operation_id IS NOT NULL
     AND NEW.source_operation_id IS DISTINCT FROM source_event.operation_id THEN
    RAISE EXCEPTION 'HXUV1-FSE-V9-11: supplied legacy source identity differs from provider truth'
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.compensation_operation_id IS NOT NULL
     AND NEW.compensation_operation_id IS DISTINCT FROM compensation_event.operation_id THEN
    RAISE EXCEPTION 'HXUV1-FSE-V9-12: supplied legacy compensation identity differs from provider truth'
      USING ERRCODE = 'P0001';
  END IF;

  NEW.source_operation_id := source_event.operation_id;
  NEW.source_operation_kind := source_event.operation_kind;
  NEW.compensation_operation_id := compensation_event.operation_id;
  NEW.compensation_operation_kind := compensation_event.operation_kind;
  NEW.compensation_provider_state := compensation_event.state;
  NEW.compensation_idempotency_key := compensation_event.idempotency_key;
  NEW.source_recorded_at := source_event.recorded_at;
  NEW.compensation_recorded_at := compensation_event.recorded_at;
  NEW.closed_at := COALESCE(
    NEW.closed_at,
    date_trunc('milliseconds', clock_timestamp())
  );
  IF NEW.closed_at < compensation_event.recorded_at THEN
    RAISE EXCEPTION 'HXUV1-FSE-V9-13: legacy compensation closure predates provider truth'
      USING ERRCODE = 'P0001';
  END IF;
  NEW.authority_sha256 := encode(
    public.hxos_universal_v1_sha256_bytes_v1(
      source_event.event_id::TEXT || ':' ||
      source_event.operation_id::TEXT || ':' ||
      source_event.operation_kind || ':' ||
      compensation_event.event_id::TEXT || ':' ||
      compensation_event.operation_id::TEXT || ':' ||
      compensation_event.operation_kind || ':' ||
      compensation_event.state || ':' ||
      compensation_event.idempotency_key || ':' ||
      command.command_id::TEXT || ':' || command.command_identity_sha256 || ':' ||
      attempt.dispatch_attempt_id::TEXT || ':' || attempt.attempt_identity_sha256 || ':' ||
      outcome.outcome_fact_id::TEXT || ':' || outcome.outcome_identity_sha256 || ':' ||
      ((extract(epoch FROM source_event.recorded_at) * 1000000)::BIGINT)::TEXT || ':' ||
      ((extract(epoch FROM compensation_event.recorded_at) * 1000000)::BIGINT)::TEXT || ':' ||
      ((extract(epoch FROM NEW.closed_at) * 1000000)::BIGINT)::TEXT,
      'sha256'
    ),
    'hex'
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.validate_fake_financial_legacy_expiry_disposition_v9()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  raw public.hxos_fake_financial_operation_events_v1%ROWTYPE;
  exact_authority_sha256 CHAR(64);
  has_existing_canonical_bridge BOOLEAN;
BEGIN
  SELECT *
    INTO raw
    FROM public.hxos_fake_financial_operation_events_v1
   WHERE event_id = NEW.fake_operation_event_id
   FOR SHARE;

  SELECT EXISTS (
    SELECT 1
      FROM public.universal_v1_fake_financial_lifecycle_bridges bridge
      JOIN public.task_financial_security_events lifecycle
        ON lifecycle.id = bridge.task_financial_security_event_id
     WHERE bridge.fake_operation_event_id = NEW.fake_operation_event_id
       AND lifecycle.provider_kind = 'FAKE'
       AND lifecycle.expires_at IS NULL
       AND lifecycle.occurred_at IS NOT DISTINCT FROM raw.recorded_at
  ) INTO has_existing_canonical_bridge;

  IF raw.event_id IS NULL
     OR raw.state <> 'SUCCEEDED'
     OR raw.operation_kind NOT IN ('AUTHORIZE', 'SECURE', 'ADJUST')
     OR raw.expires_at IS NOT NULL
     OR NEW.operation_id IS DISTINCT FROM raw.operation_id
     OR NEW.operation_kind IS DISTINCT FROM raw.operation_kind
     OR NEW.provider_state IS DISTINCT FROM raw.state
     OR NEW.provider_recorded_at IS DISTINCT FROM raw.recorded_at
     OR NEW.disposition <> 'LEGACY_EXPIRY_UNPROVEN'
     OR NEW.recovery_state IS DISTINCT FROM (
          CASE
            WHEN has_existing_canonical_bridge THEN 'EXACT_REPLAY_ONLY'
            ELSE 'COMPENSATION_REQUIRED'
          END
        )
     OR NEW.recovery_terminal IS DISTINCT FROM
          (NEW.recovery_state = 'EXACT_REPLAY_ONLY')
     OR NEW.recovery_retryable IS DISTINCT FROM
          (NEW.recovery_state = 'COMPENSATION_REQUIRED')
     OR NEW.classified_at < raw.recorded_at THEN
    RAISE EXCEPTION 'HXUV1-FSE-V9-8: legacy expiry disposition is not exact bounded provider truth'
      USING ERRCODE = 'P0001';
  END IF;

  exact_authority_sha256 := encode(
    public.hxos_universal_v1_sha256_bytes_v1(
      NEW.fake_operation_event_id::TEXT || ':' ||
      raw.operation_id::TEXT || ':' ||
      raw.operation_kind || ':' ||
      raw.state || ':' ||
      ((extract(epoch FROM raw.recorded_at) * 1000000)::BIGINT)::TEXT || ':' ||
      raw.identity_sha256 || ':' ||
      raw.request_sha256 || ':' ||
      raw.response_sha256 || ':' ||
      NEW.disposition || ':' ||
      NEW.recovery_state || ':' ||
      NEW.recovery_terminal::TEXT || ':' ||
      NEW.recovery_retryable::TEXT || ':' ||
      ((extract(epoch FROM NEW.classified_at) * 1000000)::BIGINT)::TEXT,
      'sha256'
    ),
    'hex'
  );
  IF NEW.authority_sha256 IS DISTINCT FROM exact_authority_sha256 THEN
    RAISE EXCEPTION 'HXUV1-FSE-V9-9: legacy expiry disposition digest is not exact'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION
  public.validate_fake_financial_legacy_expiry_noncompensable_v10()
RETURNS TRIGGER
LANGUAGE plpgsql
VOLATILE
PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
DECLARE
  disposition public.hxos_fake_financial_legacy_expiry_dispositions_v9%ROWTYPE;
  source_event public.hxos_fake_financial_operation_events_v1%ROWTYPE;
BEGIN
  SELECT * INTO disposition
    FROM public.hxos_fake_financial_legacy_expiry_dispositions_v9 existing
   WHERE existing.fake_operation_event_id = NEW.source_fake_operation_event_id
   FOR SHARE;
  SELECT * INTO source_event
    FROM public.hxos_fake_financial_operation_events_v1 existing
   WHERE existing.event_id = NEW.source_fake_operation_event_id
   FOR SHARE;

  IF disposition.fake_operation_event_id IS NULL
     OR disposition.disposition <> 'LEGACY_EXPIRY_UNPROVEN'
     OR disposition.recovery_state <> 'COMPENSATION_REQUIRED'
     OR disposition.recovery_terminal
     OR NOT disposition.recovery_retryable
     OR source_event.event_id IS NULL
     OR source_event.state <> 'SUCCEEDED'
     OR source_event.operation_kind NOT IN ('AUTHORIZE', 'SECURE', 'ADJUST')
     OR source_event.expires_at IS NOT NULL
     OR NOT (
       (
         source_event.amount_cents IS NULL
         AND source_event.currency IS NULL
       ) OR (
         source_event.amount_cents > 9007199254740991
         AND source_event.currency IS NOT NULL
       )
     )
     OR EXISTS (
       SELECT 1
         FROM public.hxos_fake_financial_legacy_expiry_compensation_commands_v9 command
        WHERE command.source_fake_operation_event_id = source_event.event_id
     )
     OR EXISTS (
       SELECT 1
         FROM public.hxos_fake_financial_legacy_expiry_compensations_v9 compensation
        WHERE compensation.source_fake_operation_event_id = source_event.event_id
     ) THEN
    RAISE EXCEPTION 'HXUV1-FSE-V10-1: only runtime-unrepresentable raw legacy security may be terminalized as noncompensable'
      USING ERRCODE = 'P0001';
  END IF;

  NEW.source_operation_id := source_event.operation_id;
  NEW.source_operation_kind := source_event.operation_kind;
  NEW.provider_recorded_at := source_event.recorded_at;
  NEW.reason_code := CASE
    WHEN source_event.amount_cents IS NULL
      THEN 'SOURCE_AMOUNT_AND_CURRENCY_UNPROVEN'
    ELSE 'SOURCE_AMOUNT_OUTSIDE_RUNTIME_RANGE'
  END;
  NEW.positive_use_denied := TRUE;
  NEW.recovery_terminal := TRUE;
  NEW.recovery_retryable := FALSE;
  NEW.terminalized_at := pg_catalog.date_trunc(
    'milliseconds', pg_catalog.statement_timestamp()
  );
  NEW.authority_sha256 := pg_catalog.encode(
    public.hxos_universal_v1_sha256_bytes_v1(
      source_event.event_id::TEXT || ':' || source_event.operation_id::TEXT || ':' ||
      source_event.operation_kind || ':' || source_event.state || ':' ||
      ((extract(epoch FROM source_event.recorded_at) * 1000000)::BIGINT)::TEXT || ':' ||
      source_event.identity_sha256 || ':' || source_event.request_sha256 || ':' ||
      source_event.response_sha256 || ':' || disposition.authority_sha256 || ':' ||
      NEW.reason_code || ':true:true:false:' ||
      ((extract(epoch FROM NEW.terminalized_at) * 1000000)::BIGINT)::TEXT,
      'sha256'
    ),
    'hex'
  );
  RETURN NEW;
END;
$$;

-- Durable recovery records evidence only. Neither port can dispatch or create
-- provider/lifecycle effects; original immutable admission remains the provenance.
ALTER TABLE public.financial_provider_command_recovery_leases
  ADD COLUMN admitted_job_validation_id UUID
    REFERENCES hx_authority.fake_financial_job_validations_v13(job_validation_id),
  ADD CONSTRAINT financial_provider_reconcile_admission_v13_chk CHECK (
    admitted_job_validation_id IS NULL OR recovery_action = 'RECONCILE'
  );

-- Preserve original canonical trigger bodies with explicit fixed lookup paths.
ALTER FUNCTION public.enforce_universal_financial_event_sequence() SET search_path = pg_catalog, public;
ALTER FUNCTION public.enforce_universal_fake_finance_boundary() SET search_path = pg_catalog, public;
ALTER FUNCTION public.enforce_universal_v1_financial_execution_completion() SET search_path = pg_catalog, public;
ALTER FUNCTION public.enforce_financial_operation_trigger_only() SET search_path = pg_catalog, public;
ALTER FUNCTION public.enforce_universal_v1_dispute_release_gate_v1() SET search_path = pg_catalog, public;

-- Canonical materialization consumes a separately committed observed outcome.
-- No historical recording transaction is inferred or backfilled.
ALTER TABLE public.financial_provider_command_outcome_facts
  ADD COLUMN resolution_observation_id UUID REFERENCES public.provider_event_inbox_observations(observation_id),
  ADD COLUMN resolution_receipt_id UUID REFERENCES public.provider_event_inbox_receipts(receipt_id),
  ADD COLUMN resolution_contract_version SMALLINT,
  ADD CONSTRAINT financial_provider_outcome_resolution_v13_chk CHECK (
    (resolution_observation_id IS NULL AND resolution_receipt_id IS NULL AND resolution_contract_version IS NULL)
    OR (resolution_observation_id IS NOT NULL AND resolution_receipt_id IS NOT NULL
      AND resolution_contract_version IS NOT NULL AND resolution_contract_version=1
      AND outcome_kind='OUTCOME_OBSERVED' AND retryable=FALSE)
  ),
  ADD COLUMN recording_transaction_id pg_catalog.xid8,
  ADD CONSTRAINT financial_provider_outcome_recording_transaction_v13_chk CHECK (
    recording_transaction_id IS NULL OR recording_transaction_id > '0'::pg_catalog.xid8
  );


-- One immutable no-effect fence per dispatch; retries never move its due time.
CREATE UNIQUE INDEX fake_financial_abandoned_dispatch_fence_v13_uniq
  ON public.financial_provider_command_outcome_facts(dispatch_attempt_id)
  WHERE outcome_kind='FAILED' AND failure_code='FAKE_ADMISSION_FENCED_NO_EFFECT';

CREATE OR REPLACE FUNCTION hx_authority.read_fake_financial_outcome_admission_v13(
  p_job_validation_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER STABLE PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
DECLARE
  original_worker UUID;
  evidence JSONB;
BEGIN
  SELECT validation.worker_instance_id INTO original_worker
    FROM hx_authority.fake_financial_job_validations_v13 validation
   WHERE validation.job_validation_id = p_job_validation_id;
  IF original_worker IS NULL THEN
    RAISE EXCEPTION 'HXUV1-FINOUTCOME-13-ADMISSION_NOT_FOUND';
  END IF;
  SELECT pg_catalog.to_jsonb(admission) INTO evidence
    FROM hx_authority.read_fake_financial_admission_evidence_v13(
      p_job_validation_id, original_worker
    ) admission;
  IF evidence IS NULL OR evidence ->> 'target_database_name' IS DISTINCT FROM pg_catalog.current_database()
     OR evidence ->> 'release_environment' NOT IN ('local','preview','staging')
     OR NOT EXISTS (
       SELECT 1 FROM hx_authority.universal_v1_work_order_target_authority_facts target
        WHERE target.target_authority_id = (evidence ->> 'target_authority_id')::UUID
          AND target.authority_version = (evidence ->> 'target_authority_version')::INTEGER
          AND target.target_database_name = evidence ->> 'target_database_name'
          AND target.environment = evidence ->> 'release_environment'
          AND target.release_manifest_sha256 = evidence ->> 'release_manifest_digest'
     ) THEN
    RAISE EXCEPTION 'HXUV1-FINOUTCOME-13-HISTORICAL_TARGET_MISMATCH';
  END IF;
  RETURN evidence;
END;
$$;

CREATE OR REPLACE FUNCTION public.hxos_acquire_fake_financial_reconcile_lease_v13(
  p_job_validation_id UUID, p_worker_instance_id UUID,
  p_recovery_lease_id UUID, p_lease_duration_seconds INTEGER
)
RETURNS TABLE (admission_evidence JSONB, recovery_lease JSONB, idempotency_replayed BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
DECLARE
  evidence JSONB;
  command_uuid UUID;
  stored public.financial_provider_command_recovery_leases%ROWTYPE;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'HXUV1-FINOUTCOME-13-READ_COMMITTED_REQUIRED';
  END IF;
  IF p_job_validation_id IS NULL OR p_worker_instance_id IS NULL OR p_recovery_lease_id IS NULL
     OR p_lease_duration_seconds IS NULL OR p_lease_duration_seconds NOT BETWEEN 1 AND 900 THEN
    RAISE EXCEPTION 'HXUV1-FINOUTCOME-13-LEASE_INPUT_INVALID';
  END IF;
  evidence := hx_authority.read_fake_financial_outcome_admission_v13(p_job_validation_id);
  command_uuid := (evidence ->> 'command_id')::UUID;
  -- Use the same serialization boundary as execution and the existing guards.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('financial-provider-command-recovery-v1'), pg_catalog.hashtext(command_uuid::TEXT)
  );
  SELECT lease.* INTO stored FROM public.financial_provider_command_recovery_leases lease
   WHERE lease.recovery_lease_id = p_recovery_lease_id;
  IF stored.recovery_lease_id IS NOT NULL THEN
    IF stored.command_id IS DISTINCT FROM command_uuid OR stored.recovery_action IS DISTINCT FROM 'RECONCILE'
       OR stored.lease_owner_id IS DISTINCT FROM p_worker_instance_id
       OR stored.admitted_job_validation_id IS DISTINCT FROM p_job_validation_id
       OR stored.lease_duration_seconds IS DISTINCT FROM p_lease_duration_seconds
       OR stored.expires_at IS DISTINCT FROM stored.acquired_at + pg_catalog.make_interval(secs => p_lease_duration_seconds) THEN
      RAISE EXCEPTION 'HXUV1-FINOUTCOME-13-LEASE_REPLAY_CONFLICT';
    END IF;
    RETURN QUERY SELECT evidence, pg_catalog.to_jsonb(stored), TRUE;
    RETURN;
  END IF;
  IF EXISTS(SELECT 1 FROM public.financial_provider_command_outcome_facts fence
    WHERE fence.dispatch_attempt_id=(evidence->>'dispatch_attempt_id')::UUID
      AND fence.outcome_kind='FAILED' AND fence.failure_code='FAKE_ADMISSION_FENCED_NO_EFFECT') THEN
    RAISE EXCEPTION 'HXUV1-FINFENCE-13-DISPATCH_ALREADY_FENCED'; END IF;
  IF (SELECT attempt.dispatch_attempt_id
        FROM public.financial_provider_command_dispatch_attempts attempt
       WHERE attempt.command_id = command_uuid ORDER BY attempt.attempt_number DESC LIMIT 1)
       IS DISTINCT FROM (evidence ->> 'dispatch_attempt_id')::UUID THEN
    RAISE EXCEPTION 'HXUV1-FINOUTCOME-13-LATEST_ATTEMPT_REQUIRED';
  END IF;
  -- The existing trigger owns due-time, terminal-outcome, active-lease checks
  -- and both timestamps. Stable UUID replay above never renews the window.
  INSERT INTO public.financial_provider_command_recovery_leases (
    recovery_lease_id, command_id, recovery_action, lease_owner_id, lease_duration_seconds, admitted_job_validation_id
  ) VALUES (p_recovery_lease_id, command_uuid, 'RECONCILE', p_worker_instance_id, p_lease_duration_seconds, p_job_validation_id)
  RETURNING * INTO stored;
  RETURN QUERY SELECT evidence, pg_catalog.to_jsonb(stored), FALSE;
END;
$$;

CREATE OR REPLACE FUNCTION public.hxos_record_fake_financial_outcome_v13(
  p_job_validation_id UUID, p_worker_instance_id UUID, p_recovery_lease_id UUID
)
RETURNS TABLE (admission_evidence JSONB, recovery_lease JSONB, outcome_fact JSONB, provider_event JSONB, idempotency_replayed BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
DECLARE
  evidence JSONB;
  command_uuid UUID;
  lease public.financial_provider_command_recovery_leases%ROWTYPE;
  stored public.financial_provider_command_outcome_facts%ROWTYPE;
  recovered RECORD;
  observed JSONB;
  original_event JSONB;
  resolution JSONB;
  expected JSONB;
  observation_key TEXT;
  result_sha TEXT;
  reference_sha TEXT;
  retryable_result BOOLEAN;
  replay BOOLEAN;
  fenced BOOLEAN:=FALSE;
  authority_now TIMESTAMPTZ;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'HXUV1-FINOUTCOME-13-READ_COMMITTED_REQUIRED';
  END IF;
  IF p_job_validation_id IS NULL OR p_worker_instance_id IS NULL OR p_recovery_lease_id IS NULL THEN
    RAISE EXCEPTION 'HXUV1-FINOUTCOME-13-INPUT_INVALID';
  END IF;
  evidence := hx_authority.read_fake_financial_outcome_admission_v13(p_job_validation_id);
  command_uuid := (evidence ->> 'command_id')::UUID;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('financial-provider-command-recovery-v1'), pg_catalog.hashtext(command_uuid::TEXT)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('fake-financial-operation'), pg_catalog.hashtext(evidence ->> 'operation_id')
  );
  SELECT candidate.* INTO lease FROM public.financial_provider_command_recovery_leases candidate
   WHERE candidate.recovery_lease_id = p_recovery_lease_id;
  IF lease.command_id IS DISTINCT FROM command_uuid OR lease.lease_owner_id IS DISTINCT FROM p_worker_instance_id
     OR lease.recovery_action NOT IN ('DISPATCH','RECONCILE')
     OR (lease.recovery_action = 'DISPATCH' AND (
       lease.recovery_lease_id IS DISTINCT FROM (evidence ->> 'recovery_lease_id')::UUID
       OR p_worker_instance_id IS DISTINCT FROM (evidence ->> 'worker_instance_id')::UUID
     )) OR (lease.recovery_action = 'RECONCILE' AND lease.admitted_job_validation_id IS DISTINCT FROM p_job_validation_id)
     OR (lease.recovery_action = 'RECONCILE' AND EXISTS (
       SELECT 1 FROM public.financial_provider_command_dispatch_attempts attempt
        WHERE attempt.recovery_lease_id = lease.recovery_lease_id
     )) THEN
    RAISE EXCEPTION 'HXUV1-FINOUTCOME-13-LEASE_BINDING_MISMATCH';
  END IF;
  observation_key := 'finance-outcome-v13:' || p_recovery_lease_id::TEXT;
  SELECT outcome.* INTO stored FROM public.financial_provider_command_outcome_facts outcome
   WHERE outcome.observation_idempotency_key = observation_key;
  replay := stored.outcome_fact_id IS NOT NULL;
  IF NOT replay AND EXISTS(SELECT 1 FROM public.financial_provider_command_outcome_facts fence
    WHERE fence.dispatch_attempt_id=(evidence->>'dispatch_attempt_id')::UUID
      AND fence.outcome_kind='FAILED' AND fence.failure_code='FAKE_ADMISSION_FENCED_NO_EFFECT') THEN
    RAISE EXCEPTION 'HXUV1-FINFENCE-13-DISPATCH_ALREADY_FENCED'; END IF;
  -- Sample after the command and operation locks. The SQL-only executor holds
  -- the same locks through its atomic writes and late admission/window recheck.
  evidence:=hx_authority.read_fake_financial_outcome_admission_v13(p_job_validation_id);
  authority_now:=pg_catalog.clock_timestamp();
  IF replay AND stored.outcome_kind='FAILED' THEN
    IF stored.failure_code IS DISTINCT FROM 'FAKE_ADMISSION_FENCED_NO_EFFECT'
       OR lease.recovery_action IS DISTINCT FROM 'RECONCILE'
       OR stored.recording_transaction_id IS NULL
       OR stored.recorded_at < LEAST((evidence->>'lease_expires_at')::TIMESTAMPTZ,
         (evidence->>'outcome_deadline_at')::TIMESTAMPTZ) THEN
      RAISE EXCEPTION 'HXUV1-FINFENCE-13-REPLAY_PROVENANCE_INVALID'; END IF;
    fenced:=TRUE;
  END IF;
  -- UNKNOWN is an immutable observation. Its replay must not inspect whether
  -- a raw event appeared later; only a new RECONCILE lease may observe again.
  IF NOT replay OR stored.outcome_kind NOT IN ('OUTCOME_UNKNOWN','FAILED') THEN
    SELECT * INTO recovered FROM public.hxos_read_fake_financial_recovery_evidence_v13(
      (evidence ->> 'outbox_request_id')::UUID, evidence ->> 'bullmq_job_id', evidence ->> 'job_authority_sha256'
    );
    IF recovered.admission_evidence IS DISTINCT FROM evidence THEN
      RAISE EXCEPTION 'HXUV1-FINOUTCOME-13-EVENT_ADMISSION_MISMATCH';
    END IF;
    observed := recovered.provider_event;
    IF replay AND stored.resolution_contract_version IS NOT NULL THEN
      IF stored.resolution_contract_version<>1 OR lease.recovery_action<>'RECONCILE' THEN
        RAISE EXCEPTION 'HXUV1-FINRESOLUTION-13-REPLAY_PROVENANCE_INVALID';
      END IF;
      resolution:=hx_authority.read_fake_financial_terminal_observation_v13(
        p_job_validation_id,stored.resolution_observation_id,stored.resolution_receipt_id);
    ELSIF NOT replay AND lease.recovery_action='RECONCILE'
       AND observed->>'state' IN ('PENDING','RETRYABLE_FAILURE') THEN
      resolution:=hx_authority.read_fake_financial_terminal_observation_v13(p_job_validation_id,NULL,NULL);
    END IF;
    IF resolution IS NOT NULL THEN
      original_event:=observed;
      -- This local projection drives the outcome only. Returned evidence keeps
      -- the original raw event unchanged inside an explicit versioned envelope.
      observed:=observed||pg_catalog.jsonb_build_object(
        'state',(resolution->>'raw_payload')::JSONB->>'observedState','retryable',FALSE);
    END IF;
  END IF;
  expected := pg_catalog.jsonb_build_object(
    'command_id', command_uuid, 'dispatch_attempt_id', (evidence ->> 'dispatch_attempt_id')::UUID,
    'recovery_lease_id', p_recovery_lease_id, 'observation_idempotency_key', observation_key
  );
  IF NOT replay AND observed IS NULL AND lease.recovery_action='RECONCILE'
     AND authority_now >= LEAST((evidence->>'lease_expires_at')::TIMESTAMPTZ,
       (evidence->>'outcome_deadline_at')::TIMESTAMPTZ) THEN
    -- New-operation absence is provable under the closed atomic SQL writer.
    -- Existing operation versions need an exact baseline proof; they stay
    -- UNKNOWN here, as do orphan/conflicting operation or event facts.
    fenced:=(evidence->>'provider_expected_version')::BIGINT=0
      AND NOT EXISTS(SELECT 1 FROM public.hxos_fake_financial_operations_v1 operation
        WHERE operation.operation_id=(evidence->>'operation_id')::UUID)
      AND NOT EXISTS(SELECT 1 FROM public.hxos_fake_financial_operation_events_v1 event
        WHERE event.operation_id=(evidence->>'operation_id')::UUID
          OR event.idempotency_key=evidence->>'idempotency_key'
          OR event.admitted_job_validation_id=p_job_validation_id);
  END IF;
  IF fenced THEN
    expected:=expected || pg_catalog.jsonb_build_object(
      'outcome_kind','FAILED','provider_result_sha256',NULL,'provider_state',NULL,
      'provider_result_version',NULL,'amount_cents',NULL,'currency',NULL,'external_reference_sha256',NULL,
      'effect_certainty','CONFIRMED_NO_EFFECT','retryable',TRUE,
      'failure_code','FAKE_ADMISSION_FENCED_NO_EFFECT','recovery_delay_seconds',1);
  ELSIF observed IS NULL THEN
    expected := expected || pg_catalog.jsonb_build_object(
      'outcome_kind','OUTCOME_UNKNOWN', 'provider_result_sha256',NULL, 'provider_state',NULL,
      'provider_result_version',NULL, 'amount_cents',NULL, 'currency',NULL,
      'external_reference_sha256',NULL, 'effect_certainty','UNKNOWN', 'retryable',TRUE,
      'failure_code','FAKE_EVENT_NOT_OBSERVED', 'recovery_delay_seconds',1
    );
  ELSE
    retryable_result := (observed ->> 'retryable')::BOOLEAN;
    -- Do not normalize incompatible historical fake-provider semantics here.
    -- Such evidence stays readable; a corrected, versioned producer is required.
    IF retryable_result IS DISTINCT FROM (observed ->> 'state' IN ('PENDING','RETRYABLE_FAILURE'))
       OR (evidence ->> 'operation_kind' IN ('VOID','REFUND','REVERSAL') AND observed ->> 'state' = 'SUCCEEDED') THEN
      RAISE EXCEPTION 'HXUV1-FINOUTCOME-13-PROJECTION_POLICY_INCOMPATIBLE';
    END IF;
    reference_sha := pg_catalog.encode(public.hxos_universal_v1_sha256_bytes_v1(observed ->> 'external_reference','sha256'),'hex');
    result_sha := pg_catalog.encode(public.hxos_universal_v1_sha256_bytes_v1(
      (evidence ->> 'operation_id') || ':' || (evidence ->> 'operation_kind') || ':FAKE:' ||
      (observed ->> 'state') || ':' || (observed ->> 'event_version') || ':' ||
      COALESCE(observed ->> 'amount_cents','') || ':' || COALESCE(pg_catalog.upper(observed ->> 'currency'),'') || ':' ||
      reference_sha || ':' || retryable_result::TEXT, 'sha256'), 'hex');
    expected := expected || pg_catalog.jsonb_build_object(
      'outcome_kind','OUTCOME_OBSERVED', 'provider_result_sha256',result_sha,
      'provider_state',observed ->> 'state', 'provider_result_version',(observed ->> 'event_version')::BIGINT,
      'amount_cents',(observed ->> 'amount_cents')::BIGINT, 'currency',pg_catalog.upper(observed ->> 'currency'),
      'external_reference_sha256',reference_sha,
      'effect_certainty',CASE WHEN retryable_result THEN 'UNKNOWN'
        WHEN observed ->> 'state' IN ('DECLINED','FAILED','REJECTED','MISMATCH') THEN 'CONFIRMED_NO_EFFECT'
        ELSE 'CONFIRMED_EFFECT' END,
      'retryable',retryable_result, 'failure_code',NULL,
      'recovery_delay_seconds',CASE WHEN retryable_result THEN 1 ELSE NULL END
    );
  END IF;
  IF replay THEN
    IF (pg_catalog.to_jsonb(stored) - ARRAY['outcome_fact_id','recorded_at','recovery_not_before','outcome_identity_sha256','recording_transaction_id','resolution_observation_id','resolution_receipt_id','resolution_contract_version']::TEXT[])
         IS DISTINCT FROM expected
       OR stored.recovery_not_before IS DISTINCT FROM (CASE WHEN stored.recovery_delay_seconds IS NULL THEN NULL
          ELSE stored.recorded_at + pg_catalog.make_interval(secs => stored.recovery_delay_seconds) END) THEN
      RAISE EXCEPTION 'HXUV1-FINOUTCOME-13-OUTCOME_REPLAY_CONFLICT';
    END IF;
    RETURN QUERY SELECT evidence, pg_catalog.to_jsonb(lease), pg_catalog.to_jsonb(stored) - ARRAY['recording_transaction_id','resolution_observation_id','resolution_receipt_id','resolution_contract_version']::TEXT[], CASE WHEN resolution IS NULL THEN observed ELSE pg_catalog.jsonb_build_object('kind','HX_FAKE_TERMINAL_OBSERVATION_V13','original_event',original_event,'resolution',resolution) END, TRUE;
    RETURN;
  END IF;
  -- The existing trigger checks lease expiry at clock time after both locks,
  -- latest dispatch, exact command value/version/state/hash and terminality.
  INSERT INTO public.financial_provider_command_outcome_facts (
    command_id,dispatch_attempt_id,recovery_lease_id,observation_idempotency_key,
    outcome_kind,provider_result_sha256,provider_state,provider_result_version,
    amount_cents,currency,external_reference_sha256,effect_certainty,retryable,
    failure_code,recovery_delay_seconds,recording_transaction_id,
    resolution_observation_id,resolution_receipt_id,resolution_contract_version
  ) VALUES (
    command_uuid,(evidence ->> 'dispatch_attempt_id')::UUID,p_recovery_lease_id,observation_key,
    expected ->> 'outcome_kind',expected ->> 'provider_result_sha256',expected ->> 'provider_state',
    (expected ->> 'provider_result_version')::BIGINT,(expected ->> 'amount_cents')::BIGINT,
    expected ->> 'currency',expected ->> 'external_reference_sha256',expected ->> 'effect_certainty',
    (expected ->> 'retryable')::BOOLEAN,expected ->> 'failure_code',(expected ->> 'recovery_delay_seconds')::INTEGER,pg_catalog.pg_current_xact_id(),
    (resolution->>'observation_id')::UUID,(resolution->>'receipt_id')::UUID,(resolution->>'contract_version')::SMALLINT
  ) RETURNING * INTO stored;
  RETURN QUERY SELECT evidence, pg_catalog.to_jsonb(lease), pg_catalog.to_jsonb(stored) - ARRAY['recording_transaction_id','resolution_observation_id','resolution_receipt_id','resolution_contract_version']::TEXT[], CASE WHEN resolution IS NULL THEN observed ELSE pg_catalog.jsonb_build_object('kind','HX_FAKE_TERMINAL_OBSERVATION_V13','original_event',original_event,'resolution',resolution) END, FALSE;
END;
$$;

-- Legacy bridges retain their exact V1 identity; observation-derived bridges
-- carry an explicit closed version and immutable selected receipt provenance.
ALTER TABLE public.universal_v1_fake_financial_lifecycle_bridges
  ADD COLUMN resolution_contract_version SMALLINT,
  ADD COLUMN resolution_observation_id UUID REFERENCES public.provider_event_inbox_observations(observation_id),
  ADD COLUMN resolution_receipt_id UUID REFERENCES public.provider_event_inbox_receipts(receipt_id),
  ADD COLUMN resolution_identity_sha256 CHAR(64),
  ADD CONSTRAINT fake_financial_bridge_resolution_v13_chk CHECK (
    (resolution_contract_version IS NULL AND resolution_observation_id IS NULL
      AND resolution_receipt_id IS NULL AND resolution_identity_sha256 IS NULL)
    OR (resolution_contract_version IS NOT NULL AND resolution_contract_version=1
      AND resolution_observation_id IS NOT NULL AND resolution_receipt_id IS NOT NULL
      AND resolution_identity_sha256 IS NOT NULL AND resolution_identity_sha256 ~ '^[a-f0-9]{64}$'
      AND resolution_identity_sha256<>repeat('0',64))
  );

CREATE OR REPLACE FUNCTION hx_authority.read_fake_financial_materialization_evidence_v13(
  p_job_validation_id UUID, p_outcome_fact_id UUID
)
RETURNS TABLE (admission_evidence JSONB, recovery_lease JSONB, outcome_fact JSONB, provider_event JSONB)
LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
DECLARE
  admission JSONB;
  observed public.financial_provider_command_outcome_facts%ROWTYPE;
  lease public.financial_provider_command_recovery_leases%ROWTYPE;
  exact RECORD;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'HXUV1-FINMATERIALIZE-13-READ_COMMITTED_REQUIRED';
  END IF;
  IF p_job_validation_id IS NULL OR p_outcome_fact_id IS NULL THEN
    RAISE EXCEPTION 'HXUV1-FINMATERIALIZE-13-INPUT_INVALID';
  END IF;
  admission := hx_authority.read_fake_financial_outcome_admission_v13(p_job_validation_id);
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('financial-provider-command-recovery-v1'),
    pg_catalog.hashtext(admission ->> 'command_id')
  );
  SELECT candidate.* INTO observed FROM public.financial_provider_command_outcome_facts candidate
   WHERE candidate.outcome_fact_id = p_outcome_fact_id;
  IF observed.command_id IS DISTINCT FROM (admission ->> 'command_id')::UUID
     OR observed.dispatch_attempt_id IS DISTINCT FROM (admission ->> 'dispatch_attempt_id')::UUID
     OR observed.outcome_kind IS DISTINCT FROM 'OUTCOME_OBSERVED'
     OR observed.retryable IS DISTINCT FROM FALSE
     OR observed.provider_state NOT IN ('SUCCEEDED','VOIDED','REFUNDED','PARTIALLY_REFUNDED','REVERSED','DECLINED','FAILED')
     OR observed.recovery_not_before IS NOT NULL THEN
    RAISE EXCEPTION 'HXUV1-FINMATERIALIZE-13-TERMINAL_OUTCOME_REQUIRED';
  END IF;
  IF observed.recording_transaction_id IS NULL
     OR observed.recording_transaction_id = pg_catalog.pg_current_xact_id() THEN
    RAISE EXCEPTION 'HXUV1-FINMATERIALIZE-13-COMMITTED_OUTCOME_REQUIRED';
  END IF;
  SELECT candidate.* INTO lease FROM public.financial_provider_command_recovery_leases candidate
   WHERE candidate.recovery_lease_id = observed.recovery_lease_id;
  IF lease.recovery_lease_id IS NULL
     OR observed.observation_idempotency_key IS DISTINCT FROM 'finance-outcome-v13:' || lease.recovery_lease_id::TEXT THEN
    RAISE EXCEPTION 'HXUV1-FINMATERIALIZE-13-OUTCOME_PROVENANCE_MISMATCH';
  END IF;
  -- Existing port replays only this exact stable key, reconstructs the committed
  -- raw event at its stored projection version, and verifies the recording lease
  -- against original dispatch/admission. An expired lease is not renewed.
  SELECT * INTO exact FROM public.hxos_record_fake_financial_outcome_v13(
    p_job_validation_id, lease.lease_owner_id, lease.recovery_lease_id
  );
  IF exact.idempotency_replayed IS DISTINCT FROM TRUE
     OR exact.admission_evidence IS DISTINCT FROM admission
     OR exact.outcome_fact ->> 'outcome_fact_id' IS DISTINCT FROM p_outcome_fact_id::TEXT
     OR exact.provider_event IS NULL
     OR (CASE WHEN observed.resolution_contract_version IS NULL THEN exact.provider_event
          ELSE exact.provider_event->'original_event' END)->>'admitted_job_validation_id'
          IS DISTINCT FROM p_job_validation_id::TEXT
     OR (observed.resolution_contract_version IS NOT NULL AND (
          exact.provider_event->>'kind' IS DISTINCT FROM 'HX_FAKE_TERMINAL_OBSERVATION_V13'
          OR (exact.provider_event->'resolution'->>'contract_version')::SMALLINT IS DISTINCT FROM observed.resolution_contract_version
          OR (exact.provider_event->'resolution'->>'observation_id')::UUID IS DISTINCT FROM observed.resolution_observation_id
          OR (exact.provider_event->'resolution'->>'receipt_id')::UUID IS DISTINCT FROM observed.resolution_receipt_id)) THEN
    RAISE EXCEPTION 'HXUV1-FINMATERIALIZE-13-OUTCOME_PROVENANCE_MISMATCH';
  END IF;
  RETURN QUERY SELECT admission, exact.recovery_lease, exact.outcome_fact, exact.provider_event;
END;
$$;

CREATE OR REPLACE FUNCTION public.hxos_materialize_fake_financial_event_v13(
  p_job_validation_id UUID, p_outcome_fact_id UUID
)
RETURNS TABLE (
  admission_evidence JSONB, recovery_lease JSONB, outcome_fact JSONB,
  provider_event JSONB, financial_event JSONB, lifecycle_bridge JSONB, idempotency_replayed BOOLEAN
)
LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
DECLARE
  exact RECORD;
  prepared public.universal_v1_prepared_financial_commands%ROWTYPE;
  event public.task_financial_security_events%ROWTYPE;
  bridge public.universal_v1_fake_financial_lifecycle_bridges%ROWTYPE;
  replay BOOLEAN;
  expected_status TEXT;
  effective_event JSONB;
  resolution JSONB;
BEGIN
  SELECT * INTO exact FROM hx_authority.read_fake_financial_materialization_evidence_v13(
    p_job_validation_id, p_outcome_fact_id
  );
  IF exact.provider_event->>'kind'='HX_FAKE_TERMINAL_OBSERVATION_V13' THEN
    resolution:=exact.provider_event->'resolution';
    effective_event:=(exact.provider_event->'original_event')||pg_catalog.jsonb_build_object(
      'state',exact.outcome_fact->>'provider_state','retryable',FALSE,
      'recorded_at',resolution->'provider_occurred_at','expires_at',resolution->'provider_expires_at');
  ELSE
    effective_event:=exact.provider_event;
  END IF;
  SELECT candidate.* INTO prepared FROM public.universal_v1_prepared_financial_commands candidate
   WHERE candidate.prepared_command_id = (exact.admission_evidence ->> 'prepared_command_id')::UUID;
  IF prepared.prepared_command_id IS NULL THEN
    RAISE EXCEPTION 'HXUV1-FINMATERIALIZE-13-PREPARED_NOT_FOUND';
  END IF;
  expected_status := CASE effective_event ->> 'state'
    WHEN 'DECLINED' THEN 'DECLINED' WHEN 'FAILED' THEN 'FAILED' ELSE 'SUCCEEDED' END;
  SELECT candidate.* INTO bridge FROM public.universal_v1_fake_financial_lifecycle_bridges candidate
   WHERE candidate.command_id = (exact.admission_evidence ->> 'command_id')::UUID;
  replay := bridge.bridge_id IS NOT NULL;
  IF replay THEN
    SELECT candidate.* INTO event FROM public.task_financial_security_events candidate
     WHERE candidate.id = bridge.task_financial_security_event_id;
    IF bridge.prepared_command_id IS DISTINCT FROM prepared.prepared_command_id
       OR bridge.dispatch_attempt_id IS DISTINCT FROM (exact.admission_evidence ->> 'dispatch_attempt_id')::UUID
       OR bridge.outcome_fact_id IS DISTINCT FROM p_outcome_fact_id
       OR bridge.fake_operation_event_id IS DISTINCT FROM (effective_event ->> 'event_id')::UUID
       OR event.id IS NULL
       OR event.operation_id IS DISTINCT FROM prepared.operation_id::TEXT
       OR event.idempotency_key IS DISTINCT FROM prepared.idempotency_key
       OR event.provider_kind IS DISTINCT FROM 'FAKE'
       OR event.event_kind IS DISTINCT FROM prepared.event_kind
       OR event.status IS DISTINCT FROM expected_status
       OR event.expected_version IS DISTINCT FROM prepared.lifecycle_expected_version
       OR event.task_draft_id IS DISTINCT FROM prepared.task_draft_id
       OR event.task_id IS DISTINCT FROM prepared.task_id
       OR event.eligibility_decision_id IS DISTINCT FROM prepared.eligibility_decision_id
       OR event.scope_version_id IS DISTINCT FROM prepared.scope_version_id
       OR event.change_order_id IS DISTINCT FROM prepared.change_order_id
       OR event.predecessor_event_id IS DISTINCT FROM prepared.predecessor_event_id
       OR event.completion_fact_id IS DISTINCT FROM prepared.completion_fact_id
       OR event.amount_cents IS DISTINCT FROM prepared.amount_cents
       OR event.currency IS DISTINCT FROM prepared.currency
       OR event.recorded_by IS DISTINCT FROM prepared.recorded_by
       OR event.external_reference IS DISTINCT FROM effective_event ->> 'external_reference'
       OR event.occurred_at IS DISTINCT FROM (effective_event ->> 'recorded_at')::TIMESTAMPTZ
       OR event.expires_at IS DISTINCT FROM (effective_event ->> 'expires_at')::TIMESTAMPTZ
       OR event.evidence IS DISTINCT FROM pg_catalog.jsonb_build_object(
         'providerState',effective_event ->> 'state',
         'providerOperationVersion',(effective_event ->> 'event_version')::BIGINT,
         'providerIdempotencyReplayed',FALSE
       ) THEN
      RAISE EXCEPTION 'HXUV1-FINMATERIALIZE-13-REPLAY_CONFLICT';
    END IF;
  ELSE
    -- Do not wait on task/dispute authority while holding recovery/operation
    -- locks. Existing guards reacquire these transaction locks without a wait.
    IF prepared.task_id IS NOT NULL AND NOT pg_catalog.pg_try_advisory_xact_lock(
      pg_catalog.hashtextextended('hxuv1-financial-security-task:' || prepared.task_id::TEXT,0)
    ) THEN
      RAISE EXCEPTION 'HXUV1-FINMATERIALIZE-13-TASK_AUTHORITY_BUSY';
    END IF;
    IF prepared.task_id IS NOT NULL THEN
      PERFORM task.id FROM public.tasks task WHERE task.id=prepared.task_id FOR KEY SHARE NOWAIT;
    END IF;
    IF prepared.operation_kind IN ('PROVIDER_RELEASE','PAYOUT') AND NOT pg_catalog.pg_try_advisory_xact_lock(
      pg_catalog.hashtextextended('universal-v1-dispute:' || prepared.work_order_id::TEXT,0)
    ) THEN
      RAISE EXCEPTION 'HXUV1-FINMATERIALIZE-13-DISPUTE_AUTHORITY_BUSY';
    END IF;
    INSERT INTO public.task_financial_security_events (
      id,task_draft_id,task_id,eligibility_decision_id,scope_version_id,
      change_order_id,predecessor_event_id,event_kind,status,operation_id,
      idempotency_key,expected_version,provider_kind,external_reference,
      amount_cents,currency,evidence,recorded_by,occurred_at,expires_at,completion_fact_id
    ) VALUES (
      pg_catalog.gen_random_uuid(),prepared.task_draft_id,prepared.task_id,
      prepared.eligibility_decision_id,prepared.scope_version_id,prepared.change_order_id,
      prepared.predecessor_event_id,prepared.event_kind,expected_status,prepared.operation_id::TEXT,
      prepared.idempotency_key,prepared.lifecycle_expected_version::INTEGER,'FAKE',
      effective_event ->> 'external_reference',prepared.amount_cents,prepared.currency,
      pg_catalog.jsonb_build_object('providerState',effective_event ->> 'state',
        'providerOperationVersion',(effective_event ->> 'event_version')::BIGINT,
        'providerIdempotencyReplayed',FALSE),prepared.recorded_by,
      (effective_event ->> 'recorded_at')::TIMESTAMPTZ,
      (effective_event ->> 'expires_at')::TIMESTAMPTZ,prepared.completion_fact_id
    ) RETURNING * INTO event;
    INSERT INTO public.universal_v1_fake_financial_lifecycle_bridges (
      bridge_id,prepared_command_id,command_id,dispatch_attempt_id,outcome_fact_id,
      fake_operation_event_id,task_financial_security_event_id
    ) VALUES (
      pg_catalog.gen_random_uuid(),prepared.prepared_command_id,(exact.admission_evidence ->> 'command_id')::UUID,
      (exact.admission_evidence ->> 'dispatch_attempt_id')::UUID,p_outcome_fact_id,
      (effective_event ->> 'event_id')::UUID,event.id
    ) RETURNING * INTO bridge;
  END IF;
  RETURN QUERY SELECT exact.admission_evidence,exact.recovery_lease,exact.outcome_fact,
    exact.provider_event,pg_catalog.to_jsonb(event),
    CASE WHEN bridge.resolution_contract_version IS NULL THEN pg_catalog.to_jsonb(bridge)
      - ARRAY['resolution_contract_version','resolution_observation_id','resolution_receipt_id','resolution_identity_sha256']::TEXT[]
      ELSE pg_catalog.to_jsonb(bridge) END,replay;
END;
$$;


CREATE OR REPLACE FUNCTION public.validate_universal_v1_fake_financial_lifecycle_bridge()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  admitted_result RECORD;
  original_admitted_event JSONB;
  resolution JSONB;
  effective_state TEXT;
  resolution_suffix TEXT := '';
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

  effective_state:=fake_event.state;
  -- Preserve the original lease rule for nonadmitted history. Admitted events
  -- must prove the committed outcome and both original dispatch / recording
  -- lease identities through the sealed v13 provenance reader.
  IF fake_event.admitted_job_validation_id IS NULL THEN
    IF outcome.recovery_lease_id IS DISTINCT FROM attempted.recovery_lease_id THEN
      RAISE EXCEPTION 'HXUV1-FLB-13: legacy lifecycle outcome requires its original dispatch lease';
    END IF;
  ELSE
    SELECT * INTO admitted_result FROM hx_authority.read_fake_financial_materialization_evidence_v13(
      fake_event.admitted_job_validation_id, outcome.outcome_fact_id
    );
    IF admitted_result.provider_event->>'kind'='HX_FAKE_TERMINAL_OBSERVATION_V13' THEN
      original_admitted_event:=admitted_result.provider_event->'original_event';
      resolution:=admitted_result.provider_event->'resolution';
      effective_state:=admitted_result.outcome_fact->>'provider_state';
    ELSE
      original_admitted_event:=admitted_result.provider_event;
    END IF;
    IF original_admitted_event ->> 'event_id' IS DISTINCT FROM fake_event.event_id::TEXT
       OR admitted_result.admission_evidence ->> 'command_id' IS DISTINCT FROM requested.command_id::TEXT
       OR admitted_result.admission_evidence ->> 'prepared_command_id' IS DISTINCT FROM prepared.prepared_command_id::TEXT
       OR admitted_result.admission_evidence ->> 'dispatch_attempt_id' IS DISTINCT FROM attempted.dispatch_attempt_id::TEXT THEN
      RAISE EXCEPTION 'HXUV1-FINMATERIALIZE-13-BRIDGE_PROVENANCE_MISMATCH';
    END IF;
  END IF;

  IF resolution IS NULL THEN
    IF outcome.resolution_contract_version IS NOT NULL OR NEW.resolution_contract_version IS NOT NULL
       OR NEW.resolution_observation_id IS NOT NULL OR NEW.resolution_receipt_id IS NOT NULL
       OR NEW.resolution_identity_sha256 IS NOT NULL THEN
      RAISE EXCEPTION 'HXUV1-FINMATERIALIZE-13-BRIDGE_RESOLUTION_MISMATCH';
    END IF;
  ELSE
    IF outcome.resolution_contract_version IS DISTINCT FROM 1
       OR outcome.resolution_observation_id IS DISTINCT FROM (resolution->>'observation_id')::UUID
       OR outcome.resolution_receipt_id IS DISTINCT FROM (resolution->>'receipt_id')::UUID
       OR (NEW.resolution_contract_version IS NOT NULL AND NEW.resolution_contract_version<>1)
       OR (NEW.resolution_observation_id IS NOT NULL AND NEW.resolution_observation_id IS DISTINCT FROM outcome.resolution_observation_id)
       OR (NEW.resolution_receipt_id IS NOT NULL AND NEW.resolution_receipt_id IS DISTINCT FROM outcome.resolution_receipt_id)
       OR (NEW.resolution_identity_sha256 IS NOT NULL AND NEW.resolution_identity_sha256 IS DISTINCT FROM resolution->>'resolution_identity_sha256') THEN
      RAISE EXCEPTION 'HXUV1-FINMATERIALIZE-13-BRIDGE_RESOLUTION_MISMATCH';
    END IF;
    NEW.resolution_contract_version:=1;
    NEW.resolution_observation_id:=outcome.resolution_observation_id;
    NEW.resolution_receipt_id:=outcome.resolution_receipt_id;
    NEW.resolution_identity_sha256:=resolution->>'resolution_identity_sha256';
    resolution_suffix:=':1:'||NEW.resolution_observation_id::TEXT||':'||NEW.resolution_receipt_id::TEXT||':'||NEW.resolution_identity_sha256;
  END IF;

  IF outcome.command_id IS DISTINCT FROM requested.command_id
     OR outcome.dispatch_attempt_id IS DISTINCT FROM attempted.dispatch_attempt_id
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
     OR effective_state IS DISTINCT FROM outcome.provider_state
     OR (CASE WHEN resolution IS NULL THEN fake_event.retryable ELSE FALSE END) IS DISTINCT FROM outcome.retryable
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
  expected_lifecycle_status := CASE effective_state
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
     OR lifecycle.evidence->>'providerState' IS DISTINCT FROM effective_state
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
      (CASE WHEN resolution IS NULL THEN 'HUSTLEXP_UNIVERSAL_V1_FAKE_LIFECYCLE_EVENT_V1:'
        ELSE 'HUSTLEXP_UNIVERSAL_V1_FAKE_LIFECYCLE_EVENT_RESOLUTION_V1:' END) ||
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
      fake_event.event_id::TEXT || ':' || fake_event.response_sha256 || resolution_suffix,
      'sha256'
    ),
    'hex'
  );

  NEW.fake_operation_id := fake_operation.operation_id;
  NEW.fake_operation_kind := fake_operation.operation_kind;
  NEW.fake_event_version := fake_event.event_version;
  NEW.fake_provider_state := effective_state;
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
      (CASE WHEN resolution IS NULL THEN 'HUSTLEXP_UNIVERSAL_V1_FAKE_FINANCIAL_LIFECYCLE_BRIDGE_V1:'
        ELSE 'HUSTLEXP_UNIVERSAL_V1_FAKE_FINANCIAL_LIFECYCLE_BRIDGE_RESOLUTION_V1:' END) ||
      prepared.prepared_command_id::TEXT || ':' || prepared.authority_context_sha256 || ':' ||
      requested.command_id::TEXT || ':' || requested.command_identity_sha256 || ':' ||
      attempted.dispatch_attempt_id::TEXT || ':' || attempted.attempt_identity_sha256 || ':' ||
      outcome.outcome_fact_id::TEXT || ':' || outcome.outcome_identity_sha256 || ':' ||
      fake_operation.operation_id::TEXT || ':' || fake_operation.operation_kind || ':' ||
      fake_operation.identity_sha256 || ':' || fake_event.event_id::TEXT || ':' ||
      fake_event.event_version::TEXT || ':' || fake_event.provider_request_sha256 || ':' ||
      fake_event.request_sha256 || ':' || fake_event.response_sha256 || ':' ||
      lifecycle.id::TEXT || ':' ||
      derived_lifecycle_identity || resolution_suffix,
      'sha256'
    ),
    'hex'
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_universal_v1_fake_expiry_bridge_v9()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  admitted_result RECORD;
  original_event JSONB;
  resolution JSONB;
  admitted_id UUID;
  outcome_resolution_version SMALLINT;
  resolution_suffix TEXT := '';
  expiry_prefix TEXT := '';
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

  SELECT resolution_contract_version INTO outcome_resolution_version
    FROM public.financial_provider_command_outcome_facts WHERE outcome_fact_id=NEW.outcome_fact_id;
  IF outcome_resolution_version IS NOT NULL THEN
    IF outcome_resolution_version<>1 OR NEW.resolution_contract_version IS DISTINCT FROM outcome_resolution_version THEN RAISE EXCEPTION 'HXUV1-FINMATERIALIZE-13-EXPIRY_RESOLUTION_VERSION'; END IF;
    SELECT admitted_job_validation_id INTO admitted_id
      FROM public.hxos_fake_financial_operation_events_v1 WHERE event_id=NEW.fake_operation_event_id;
    SELECT * INTO admitted_result FROM hx_authority.read_fake_financial_materialization_evidence_v13(admitted_id,NEW.outcome_fact_id);
    original_event:=admitted_result.provider_event->'original_event';
    resolution:=admitted_result.provider_event->'resolution';
    IF admitted_result.provider_event->>'kind' IS DISTINCT FROM 'HX_FAKE_TERMINAL_OBSERVATION_V13'
       OR original_event->>'event_id' IS DISTINCT FROM NEW.fake_operation_event_id::TEXT
       OR (resolution->>'observation_id')::UUID IS DISTINCT FROM NEW.resolution_observation_id
       OR (resolution->>'receipt_id')::UUID IS DISTINCT FROM NEW.resolution_receipt_id
       OR resolution->>'resolution_identity_sha256' IS DISTINCT FROM NEW.resolution_identity_sha256 THEN
      RAISE EXCEPTION 'HXUV1-FINMATERIALIZE-13-EXPIRY_RESOLUTION_MISMATCH';
    END IF;
    raw_recorded_at:=(resolution->>'provider_occurred_at')::TIMESTAMPTZ;
    raw_expiry:=(resolution->>'provider_expires_at')::TIMESTAMPTZ;
    expiry_prefix:='HUSTLEXP_UNIVERSAL_V1_FAKE_EXPIRY_RESOLUTION_V1:';
    resolution_suffix:=':1:'||NEW.resolution_observation_id::TEXT||':'||NEW.resolution_receipt_id::TEXT||':'||NEW.resolution_identity_sha256;
  ELSIF NEW.resolution_contract_version IS NOT NULL OR NEW.resolution_observation_id IS NOT NULL
    OR NEW.resolution_receipt_id IS NOT NULL OR NEW.resolution_identity_sha256 IS NOT NULL THEN
    RAISE EXCEPTION 'HXUV1-FINMATERIALIZE-13-EXPIRY_RESOLUTION_MISMATCH';
  END IF;

  IF raw_recorded_at IS NULL
     OR raw_recorded_at IS DISTINCT FROM lifecycle_occurred_at
     OR raw_expiry IS DISTINCT FROM lifecycle_expiry THEN
    RAISE EXCEPTION 'HXUV1-FSE-V9-1: canonical provider time and expiry are not the exact raw fake-provider facts'
      USING ERRCODE = 'P0001';
  END IF;

  exact_expiry_authority_sha256 := encode(
    public.hxos_universal_v1_sha256_bytes_v1(
      expiry_prefix || NEW.fake_operation_event_id::TEXT || ':' ||
      NEW.task_financial_security_event_id::TEXT || ':' ||
      ((extract(epoch FROM raw_recorded_at) * 1000000)::BIGINT)::TEXT || ':' ||
      COALESCE(
        ((extract(epoch FROM raw_expiry) * 1000000)::BIGINT)::TEXT,
        'NO_EXPIRY'
      ) || resolution_suffix,
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

CREATE OR REPLACE FUNCTION hx_authority.validate_fake_financial_webhook_rejection_v13()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
DECLARE
  observation_record RECORD;
  expected_reference_sha256 CHAR(64);
BEGIN
  SELECT observation.provider_kind,
         observation.provider_event_reference,
         observation.provider_event_kind,
         observation.operation_id,
         observation.raw_payload_sha256
    INTO observation_record
    FROM public.provider_event_inbox_observations observation
   WHERE observation.observation_id = NEW.observation_id
   FOR SHARE;
  expected_reference_sha256 := hx_authority.fake_financial_job_digest_v13(
    ARRAY[
      'HXUV1_FAKE_FINANCIAL_WEBHOOK_REFERENCE_V13',
      observation_record.provider_event_reference
    ]::TEXT[]
  );
  IF observation_record.provider_kind IS DISTINCT FROM 'FAKE'
     OR NEW.provider_kind IS DISTINCT FROM 'FAKE'
     OR NEW.operation_id IS DISTINCT FROM observation_record.operation_id
     OR NEW.provider_event_kind IS DISTINCT FROM
          observation_record.provider_event_kind
     OR NEW.provider_event_reference_sha256 IS DISTINCT FROM
          expected_reference_sha256
     OR NEW.raw_payload_sha256 IS DISTINCT FROM
          observation_record.raw_payload_sha256
     OR NEW.receipt_state IS DISTINCT FROM 'UNAUTHENTICATED_REJECTED'
     OR NEW.outbox_dispatch_authorized IS DISTINCT FROM FALSE
     OR NEW.lifecycle_transition_authorized IS DISTINCT FROM FALSE
     OR NEW.provider_execution_capability IS DISTINCT FROM FALSE
     OR NEW.positive_money_capability IS DISTINCT FROM FALSE
     OR NEW.production_capability IS DISTINCT FROM FALSE THEN
    RAISE EXCEPTION
      'HXUV1-FINOUT-13-35: unauthenticated webhook rejection evidence is not exact and inert'
      USING ERRCODE = 'P0001';
  END IF;
  NEW.recorded_at := pg_catalog.clock_timestamp();
  NEW.rejection_identity_sha256 := hx_authority.fake_financial_job_digest_v13(
    ARRAY[
      'HXUV1_FAKE_FINANCIAL_WEBHOOK_REJECTION_V13',
      NEW.rejection_receipt_id::TEXT,
      NEW.observation_id::TEXT,
      pg_catalog.btrim(NEW.provider_event_reference_sha256),
      pg_catalog.btrim(NEW.raw_payload_sha256),
      pg_catalog.btrim(NEW.ingress_idempotency_sha256),
      pg_catalog.btrim(NEW.request_sha256),
      NEW.authentication_scheme,
      pg_catalog.btrim(NEW.authentication_evidence_sha256),
      NEW.rejection_reason_code
    ]::TEXT[]
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER fake_finance_webhook_rejection_validate_v13
BEFORE INSERT ON hx_authority.fake_financial_webhook_rejection_receipts_v13
FOR EACH ROW
EXECUTE FUNCTION hx_authority.validate_fake_financial_webhook_rejection_v13();

CREATE OR REPLACE FUNCTION hx_authority.record_fake_financial_webhook_rejection_v13(
  p_observation_id UUID,
  p_ingress_idempotency_sha256 TEXT,
  p_request_sha256 TEXT,
  p_authentication_scheme TEXT,
  p_authentication_evidence_sha256 TEXT,
  p_rejection_reason_code TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY INVOKER
VOLATILE
PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
DECLARE
  observation_record RECORD;
  new_rejection_receipt_id UUID := pg_catalog.gen_random_uuid();
BEGIN
  SELECT observation.provider_kind,
         observation.provider_event_reference,
         observation.provider_event_kind,
         observation.operation_id,
         observation.raw_payload_sha256
    INTO observation_record
    FROM public.provider_event_inbox_observations observation
   WHERE observation.observation_id = p_observation_id
   FOR SHARE;
  IF observation_record.provider_kind IS DISTINCT FROM 'FAKE' THEN
    RAISE EXCEPTION
      'HXUV1-FINOUT-13-36: webhook rejection receipt requires one FAKE observation'
      USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO hx_authority.fake_financial_webhook_rejection_receipts_v13 (
    rejection_receipt_id,
    observation_id,
    operation_id,
    provider_kind,
    provider_event_kind,
    provider_event_reference_sha256,
    raw_payload_sha256,
    ingress_idempotency_sha256,
    request_sha256,
    authentication_scheme,
    authentication_evidence_sha256,
    rejection_reason_code,
    receipt_state,
    rejection_identity_sha256
  ) VALUES (
    new_rejection_receipt_id,
    p_observation_id,
    observation_record.operation_id,
    'FAKE',
    observation_record.provider_event_kind,
    hx_authority.fake_financial_job_digest_v13(
      ARRAY[
        'HXUV1_FAKE_FINANCIAL_WEBHOOK_REFERENCE_V13',
        observation_record.provider_event_reference
      ]::TEXT[]
    ),
    observation_record.raw_payload_sha256,
    p_ingress_idempotency_sha256,
    p_request_sha256,
    p_authentication_scheme,
    p_authentication_evidence_sha256,
    p_rejection_reason_code,
    'UNAUTHENTICATED_REJECTED',
    pg_catalog.repeat('0', 64)
  );
  RETURN new_rejection_receipt_id;
END;
$$;

CREATE OR REPLACE FUNCTION hx_authority.validate_fake_financial_webhook_inert_v13()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
DECLARE
  inbox_record RECORD;
  expected_reference_sha256 CHAR(64);
BEGIN
  SELECT observation.provider_kind,
         observation.provider_event_reference,
         observation.provider_event_kind,
         observation.operation_id,
         observation.raw_payload_sha256,
         receipt.authentication_status,
         receipt.authentication_evidence_sha256
    INTO inbox_record
    FROM public.provider_event_inbox_receipts receipt
    JOIN public.provider_event_inbox_observations observation
      ON observation.observation_id = receipt.observation_id
   WHERE receipt.receipt_id = NEW.receipt_id
     AND observation.observation_id = NEW.observation_id
   FOR SHARE OF receipt, observation;
  expected_reference_sha256 := hx_authority.fake_financial_job_digest_v13(
    ARRAY[
      'HXUV1_FAKE_FINANCIAL_WEBHOOK_REFERENCE_V13',
      inbox_record.provider_event_reference
    ]::TEXT[]
  );
  IF inbox_record.provider_kind IS DISTINCT FROM 'FAKE'
     OR inbox_record.authentication_status IS DISTINCT FROM 'VERIFIED'
     OR NEW.provider_kind IS DISTINCT FROM inbox_record.provider_kind
     OR NEW.operation_id IS DISTINCT FROM inbox_record.operation_id
     OR NEW.provider_event_kind IS DISTINCT FROM inbox_record.provider_event_kind
     OR NEW.provider_event_reference_sha256 IS DISTINCT FROM
          expected_reference_sha256
     OR NEW.raw_payload_sha256 IS DISTINCT FROM inbox_record.raw_payload_sha256
     OR NEW.authentication_evidence_sha256 IS DISTINCT FROM
          inbox_record.authentication_evidence_sha256
     OR NEW.evidence_state IS DISTINCT FROM 'INERT_WEBHOOK_EVIDENCE'
     OR NEW.outbox_dispatch_authorized IS DISTINCT FROM FALSE
     OR NEW.lifecycle_transition_authorized IS DISTINCT FROM FALSE
     OR NEW.positive_money_capability IS DISTINCT FROM FALSE THEN
    RAISE EXCEPTION
      'HXUV1-FINOUT-13-35: webhook evidence is not exact, verified, and inert'
      USING ERRCODE = 'P0001';
  END IF;
  NEW.recorded_at := pg_catalog.clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER fake_finance_webhook_inert_validate_v13
BEFORE INSERT ON hx_authority.fake_financial_webhook_inert_evidence_v13
FOR EACH ROW
EXECUTE FUNCTION hx_authority.validate_fake_financial_webhook_inert_v13();

CREATE OR REPLACE FUNCTION hx_authority.capture_fake_financial_webhook_inert_v13()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
DECLARE
  observation_record RECORD;
BEGIN
  SELECT observation.provider_kind,
         observation.provider_event_reference,
         observation.provider_event_kind,
         observation.operation_id,
         observation.raw_payload_sha256
    INTO observation_record
    FROM public.provider_event_inbox_observations observation
   WHERE observation.observation_id = NEW.observation_id
   FOR SHARE;
  IF observation_record.provider_kind IS DISTINCT FROM 'FAKE' THEN
    RETURN NEW;
  END IF;
  IF NEW.authentication_status IS DISTINCT FROM 'VERIFIED' THEN
    PERFORM hx_authority.record_fake_financial_webhook_rejection_v13(
      NEW.observation_id,
      hx_authority.fake_financial_job_digest_v13(
        ARRAY[
          'HXUV1_FAKE_FINANCIAL_INGRESS_IDEMPOTENCY_V13',
          NEW.ingress_idempotency_key
        ]::TEXT[]
      ),
      pg_catalog.btrim(NEW.request_sha256),
      NEW.authentication_scheme,
      pg_catalog.btrim(NEW.authentication_evidence_sha256),
      'AUTHENTICATION_STATUS_NOT_VERIFIED'
    );
    RETURN NEW;
  END IF;

  INSERT INTO hx_authority.fake_financial_webhook_inert_evidence_v13 (
    observation_id,
    receipt_id,
    operation_id,
    provider_kind,
    provider_event_kind,
    provider_event_reference_sha256,
    raw_payload_sha256,
    authentication_evidence_sha256,
    evidence_state,
    outbox_dispatch_authorized,
    lifecycle_transition_authorized,
    positive_money_capability
  ) VALUES (
    NEW.observation_id,
    NEW.receipt_id,
    observation_record.operation_id,
    'FAKE',
    observation_record.provider_event_kind,
    hx_authority.fake_financial_job_digest_v13(
      ARRAY[
        'HXUV1_FAKE_FINANCIAL_WEBHOOK_REFERENCE_V13',
        observation_record.provider_event_reference
      ]::TEXT[]
    ),
    observation_record.raw_payload_sha256,
    NEW.authentication_evidence_sha256,
    'INERT_WEBHOOK_EVIDENCE',
    FALSE,
    FALSE,
    FALSE
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS fake_finance_webhook_inert_capture_v13
  ON public.provider_event_inbox_receipts;
CREATE TRIGGER fake_finance_webhook_inert_capture_v13
AFTER INSERT ON public.provider_event_inbox_receipts
FOR EACH ROW
EXECUTE FUNCTION hx_authority.capture_fake_financial_webhook_inert_v13();

-- Runtime logins receive EXECUTE only on these sealed transport ports. Their
-- existing implementations remain owner-only invokers; no worker table DML is
-- necessary. The eight-role provisioner assigns the non-login finance owner.
-- Durable discovery is an ID-only read. Historical admitted work remains
-- discoverable across target replacement and publication holds. Each consumer
-- re-reads committed progress; this result grants no dispatch capability.
CREATE OR REPLACE FUNCTION public.hxos_scan_fake_financial_recovery_v13(
  p_after_outbox_request_id UUID, p_limit INTEGER
)
RETURNS TABLE (
  outbox_request_id UUID, command_id UUID, bullmq_job_id TEXT,
  job_authority_sha256 TEXT, admission_present BOOLEAN,
  publication_confirmed BOOLEAN, publication_held BOOLEAN
)
LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
     OR pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'HXUV1-FINDISCOVERY-13-INPUT_OR_ISOLATION_INVALID';
  END IF;
  RETURN QUERY SELECT request.outbox_request_id,request.command_id,request.bullmq_job_id,
    pg_catalog.btrim(request.job_authority_sha256),
    EXISTS(SELECT 1 FROM hx_authority.fake_financial_dispatch_admissions_v13 admission
      WHERE admission.outbox_request_id=request.outbox_request_id),
    EXISTS(SELECT 1 FROM hx_authority.fake_financial_outbox_publish_outcomes_v13 outcome
      WHERE outcome.outbox_request_id=request.outbox_request_id AND outcome.outcome_kind='BULLMQ_CONFIRMED'),
    EXISTS(SELECT 1 FROM hx_authority.fake_financial_outbox_dispositions_v13 disposition
      WHERE disposition.outbox_request_id=request.outbox_request_id)
      OR EXISTS(SELECT 1 FROM hx_authority.fake_financial_publish_exhaustions_v13 exhaustion
        WHERE exhaustion.outbox_request_id=request.outbox_request_id)
      OR EXISTS(SELECT 1 FROM hx_authority.fake_financial_outbox_publish_outcomes_v13 outcome
        WHERE outcome.outbox_request_id=request.outbox_request_id AND outcome.outcome_kind='TERMINAL_FAILURE')
      OR EXISTS(SELECT 1 FROM hx_authority.universal_v1_work_order_target_authority_facts successor
        WHERE successor.supersedes_target_authority_id=request.target_authority_id)
    FROM hx_authority.fake_financial_command_outbox_requests_v13 request
    JOIN hx_authority.fake_financial_exact_requests_v13 exact_request
      ON exact_request.command_id=request.command_id
      AND exact_request.provider_request_sha256=request.provider_request_sha256
   WHERE (p_after_outbox_request_id IS NULL OR request.outbox_request_id>p_after_outbox_request_id)
     AND request.target_database_name=pg_catalog.current_database()
     AND request.release_environment IN ('local','preview','staging')
     AND request.positive_money_capability IS FALSE AND request.production_capability IS FALSE
     AND exact_request.recorded_transaction_id IS DISTINCT FROM pg_catalog.pg_current_xact_id_if_assigned()
     AND NOT EXISTS(SELECT 1 FROM public.universal_v1_fake_financial_lifecycle_bridges bridge
       WHERE bridge.command_id=request.command_id)
   ORDER BY request.outbox_request_id LIMIT p_limit;
END;
$$;
REVOKE ALL ON FUNCTION public.hxos_scan_fake_financial_recovery_v13(uuid,integer) FROM PUBLIC;

-- Read-only restoration authority is distinct from a newly leased publication.
-- The original confirmation is historical immutable evidence. Re-adding the
-- same Redis identity may repair transport, but does not create a new SQL claim,
-- outcome, admission or provider capability. Dispatch rechecks current authority.
CREATE OR REPLACE FUNCTION public.hxos_read_fake_financial_restoration_v13(
  p_outbox_request_id UUID, p_bullmq_job_id TEXT, p_job_authority_sha256 TEXT
)
RETURNS TABLE (
  outbox_request_id UUID, command_id UUID, bullmq_job_id TEXT,
  queue_name TEXT, job_name TEXT, job_payload JSONB,
  job_authority_sha256 TEXT, historical_publish_outcome_id UUID
)
LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
DECLARE
  request_record hx_authority.fake_financial_command_outbox_requests_v13%ROWTYPE;
  recovered RECORD;
  progress RECORD;
  confirmed hx_authority.fake_financial_outbox_publish_outcomes_v13%ROWTYPE;
BEGIN
  IF p_outbox_request_id IS NULL OR p_bullmq_job_id IS NULL
     OR p_job_authority_sha256 IS NULL OR p_job_authority_sha256 !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'HXUV1-FINRESTORE-13-INPUT_INVALID';
  END IF;
  PERFORM hx_authority.assert_fake_financial_publish_open_v13(p_outbox_request_id);
  SELECT * INTO recovered FROM public.hxos_read_fake_financial_recovery_evidence_v13(
    p_outbox_request_id,p_bullmq_job_id,p_job_authority_sha256
  );
  SELECT request.* INTO request_record
    FROM hx_authority.fake_financial_command_outbox_requests_v13 request
   WHERE request.outbox_request_id=p_outbox_request_id FOR SHARE;
  PERFORM hx_authority.assert_fake_financial_outbox_target_v13(
    request_record.target_authority_id,request_record.target_database_name,
    request_record.release_environment,request_record.release_manifest_digest
  );
  SELECT * INTO STRICT progress FROM public.hxos_read_fake_financial_progress_v13(
    p_outbox_request_id,p_bullmq_job_id,p_job_authority_sha256);
  IF EXISTS(SELECT 1 FROM public.universal_v1_fake_financial_lifecycle_bridges bridge
    WHERE bridge.command_id=request_record.command_id) THEN
    RAISE EXCEPTION 'HXUV1-FINRESTORE-13-MATERIALIZED_REQUEST'; END IF;
  IF progress.recovery_evidence->'admission_evidence' <> 'null'::JSONB THEN
    IF progress.recorded_outcome IS NULL
       OR progress.recorded_outcome->'outcome_fact'->>'outcome_kind' IS DISTINCT FROM 'FAILED'
       OR progress.recorded_outcome->'outcome_fact'->>'failure_code' IS DISTINCT FROM 'FAKE_ADMISSION_FENCED_NO_EFFECT'
       OR progress.recorded_outcome->'outcome_fact'->>'effect_certainty' IS DISTINCT FROM 'CONFIRMED_NO_EFFECT'
       OR progress.recorded_outcome->'outcome_fact'->>'retryable' IS DISTINCT FROM 'true' THEN
      RAISE EXCEPTION 'HXUV1-FINRESTORE-13-UNADMITTED_OR_FENCED_REQUEST_REQUIRED'; END IF;
    IF (progress.recorded_outcome->'outcome_fact'->>'recovery_not_before')::TIMESTAMPTZ > pg_catalog.clock_timestamp() THEN
      RAISE EXCEPTION 'HXUV1-FINRESTORE-13-FENCE_NOT_DUE'; END IF;
  END IF;
  SELECT outcome.* INTO confirmed
    FROM hx_authority.fake_financial_outbox_publish_outcomes_v13 outcome
    JOIN hx_authority.fake_financial_outbox_publish_claims_v13 claim
      ON claim.publish_claim_id=outcome.publish_claim_id AND claim.outbox_request_id=outcome.outbox_request_id
   WHERE outcome.outbox_request_id=p_outbox_request_id AND outcome.outcome_kind='BULLMQ_CONFIRMED'
     AND outcome.observed_bullmq_job_id=p_bullmq_job_id
     AND outcome.observed_job_authority_sha256=p_job_authority_sha256
     AND outcome.recording_transaction_id IS DISTINCT FROM pg_catalog.pg_current_xact_id_if_assigned()
   ORDER BY claim.claim_number DESC LIMIT 1;
  IF confirmed.publish_outcome_id IS NULL THEN
    RAISE EXCEPTION 'HXUV1-FINRESTORE-13-COMMITTED_CONFIRMATION_REQUIRED';
  END IF;
  RETURN QUERY SELECT request_record.outbox_request_id,request_record.command_id,
    request_record.bullmq_job_id,request_record.queue_name,request_record.job_name,
    pg_catalog.jsonb_build_object('version',request_record.payload_contract_version,
      'kind','UNIVERSAL_V1_FAKE_FINANCIAL_COMMAND','outboxRequestId',request_record.outbox_request_id,
      'commandId',request_record.command_id,'jobAuthoritySha256',pg_catalog.btrim(request_record.job_authority_sha256)),
    pg_catalog.btrim(request_record.job_authority_sha256),confirmed.publish_outcome_id;
END;
$$;
REVOKE ALL ON FUNCTION public.hxos_read_fake_financial_restoration_v13(uuid,text,text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.hxos_claim_fake_financial_outbox_v13(
  p_publisher_instance_id UUID, p_lease_duration_seconds INTEGER
)
RETURNS TABLE (
  publish_claim_id UUID,
  outbox_request_id UUID,
  command_id UUID,
  bullmq_job_id TEXT,
  queue_name TEXT,
  job_name TEXT,
  job_payload JSONB,
  job_authority_sha256 TEXT,
  claim_number INTEGER,
  lease_expires_at TIMESTAMPTZ
)
LANGUAGE SQL
SECURITY DEFINER
VOLATILE
PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
  SELECT * FROM hx_authority.claim_fake_financial_outbox_v13(
    p_publisher_instance_id, p_lease_duration_seconds
  );
$$;

CREATE OR REPLACE FUNCTION public.hxos_record_fake_financial_publish_outcome_v13(
  p_publish_claim_id UUID,
  p_outcome_kind TEXT,
  p_bullmq_job_id TEXT,
  p_job_authority_sha256 TEXT,
  p_failure_code TEXT,
  p_retry_delay_seconds INTEGER
)
RETURNS UUID
LANGUAGE SQL
SECURITY DEFINER
VOLATILE
PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
  SELECT hx_authority.record_fake_financial_publish_outcome_v13(
    p_publish_claim_id, p_outcome_kind, p_bullmq_job_id,
    p_job_authority_sha256, p_failure_code, p_retry_delay_seconds
  );
$$;

COMMENT ON TABLE hx_authority.fake_financial_command_outbox_requests_v13 IS
  'Append-only same-transaction outbox requests binding exact FAKE PREPARED and REQUESTED facts to one current nonproduction target and deterministic ID-only BullMQ job. No row grants provider execution or positive-money capability.';
COMMENT ON TABLE hx_authority.fake_financial_outbox_publish_claims_v13 IS
  'Append-only bounded publisher leases. Expiry permits exact deterministic-job reconciliation; it never creates a second command identity.';
COMMENT ON TABLE hx_authority.fake_financial_outbox_publish_outcomes_v13 IS
  'Append-only BullMQ acknowledgement, retryable transport failure, or terminal transport failure facts. They are transport evidence only.';
COMMENT ON TABLE hx_authority.fake_financial_outbox_dispositions_v13 IS
  'Append-only TARGET_SUPERSEDED retirement facts. A stale target request is held with zero dispatch authority so it cannot head-of-line block the exact current target.';
COMMENT ON TABLE hx_authority.fake_financial_dispatch_admissions_v13 IS
  'Append-only same-transaction admissions created only by the sealed v13 worker evidence port. They prevent legacy direct DISPATCH lease insertion and carry no provider-execution, money, or production capability.';
COMMENT ON TABLE hx_authority.fake_financial_job_validations_v13 IS
  'Append-only exact Redis-job validation linked to one sealed admission, FAKE recovery lease, and DISPATCH_ATTEMPTED evidence. It explicitly carries no provider-execution, money, or production capability.';
COMMENT ON TABLE hx_authority.fake_financial_webhook_inert_evidence_v13 IS
  'Append-only authenticated FAKE webhook digest evidence on a rail with no command or outbox authority. Raw payload remains only in the provider inbox.';
COMMENT ON TABLE hx_authority.fake_financial_webhook_rejection_receipts_v13 IS
  'Append-only digest-only unauthenticated FAKE webhook rejection receipts. Rejection evidence never grants outbox, lifecycle, provider, production, or money authority.';
COMMENT ON TABLE public.hxos_fake_financial_schema_evidence_v13 IS
  'Append-only exact migration-SQL evidence required before the v13 outbox capture, publisher, or worker evidence ports become usable.';
COMMENT ON FUNCTION hx_authority.claim_fake_financial_outbox_v13(UUID, INTEGER) IS
  'SECURITY INVOKER publisher claim port. Returns an ID-only job envelope after exact target/evidence checks; performs no BullMQ or provider I/O.';
COMMENT ON FUNCTION hx_authority.record_fake_financial_publish_outcome_v13(
  UUID, TEXT, TEXT, TEXT, TEXT, INTEGER
) IS
  'SECURITY INVOKER append-only BullMQ transport outcome port.';
COMMENT ON FUNCTION hx_authority.record_fake_financial_job_dispatch_evidence_v13(
  UUID, TEXT, TEXT, UUID, INTEGER, INTEGER, INTEGER
) IS
  'Narrow SECURITY DEFINER sealed admission port with PUBLIC/default direct grants removed. It rejects forged Redis, records crash-boundary evidence, and never issues adapter or money capability. A sealed non-login owner and exact worker EXECUTE grant remain runtime-provisioning requirements.';
COMMENT ON FUNCTION hx_authority.record_fake_financial_webhook_rejection_v13(
  UUID, TEXT, TEXT, TEXT, TEXT, TEXT
) IS
  'SECURITY INVOKER digest-only rejection-receipt port for unauthenticated FAKE webhooks. It performs no provider, queue, lifecycle, or money I/O.';

REVOKE ALL ON TABLE
  hx_authority.fake_financial_exact_requests_v13,
  hx_authority.fake_financial_command_outbox_requests_v13,
  hx_authority.fake_financial_outbox_publish_claims_v13,
  hx_authority.fake_financial_outbox_publish_outcomes_v13,
  hx_authority.fake_financial_outbox_dispositions_v13,
  hx_authority.fake_financial_publish_exhaustions_v13,
  hx_authority.fake_financial_dispatch_admissions_v13,
  hx_authority.fake_financial_job_validations_v13,
  hx_authority.fake_financial_webhook_inert_evidence_v13,
  hx_authority.fake_financial_webhook_rejection_receipts_v13,
  public.hxos_fake_financial_schema_evidence_v13
FROM PUBLIC;

REVOKE ALL ON FUNCTION public.hxos_request_fake_financial_command_v13(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION hx_authority.parse_fake_financial_request_v13(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION hx_authority.parse_fake_financial_identity_v13(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION hx_authority.mark_fake_financial_request_transaction_v13() FROM PUBLIC;
REVOKE ALL ON FUNCTION hx_authority.validate_fake_financial_exact_request_v13() FROM PUBLIC;
REVOKE ALL ON FUNCTION hx_authority.require_fake_financial_exact_request_v13() FROM PUBLIC;

REVOKE ALL ON FUNCTION hx_authority.fake_financial_job_digest_v13(TEXT[])
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.hxos_read_universal_v1_fake_financial_runtime_authority_v13()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_universal_financial_event_sequence() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_universal_fake_finance_boundary() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_universal_v1_financial_execution_completion() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_financial_operation_trigger_only() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.serialize_universal_v1_financial_security_task_v12() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_universal_v1_dispute_release_gate_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.universal_v1_dispute_lock_v1(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION hx_authority.read_fake_financial_materialization_evidence_v13(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.hxos_materialize_fake_financial_event_v13(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION hx_authority.read_fake_financial_outcome_admission_v13(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.hxos_acquire_fake_financial_reconcile_lease_v13(uuid,uuid,uuid,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.hxos_record_fake_financial_outcome_v13(uuid,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.hxos_read_fake_financial_recovery_evidence_v13(uuid,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION hx_authority.read_fake_financial_admission_evidence_v13(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.hxos_read_admitted_fake_financial_request_v13(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION hx_authority.derive_fake_financial_projection_v13(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION hx_authority.derive_fake_financial_projection_v13(text,text,smallint) FROM PUBLIC;
REVOKE ALL ON FUNCTION hx_authority.assert_fake_financial_execution_domain_v13(uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.hxos_execute_admitted_fake_financial_request_v13(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.universal_v1_has_open_material_dispute_v1(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.hxos_read_fake_financial_schema_evidence_v13() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.hxos_read_fake_financial_applied_migrations_v13() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.hxos_read_fake_financial_bootstrap_completion_v13(TEXT,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.hxos_claim_fake_financial_outbox_v13(UUID, INTEGER)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.hxos_record_fake_financial_publish_outcome_v13(UUID, TEXT, TEXT, TEXT, TEXT, INTEGER)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION hx_authority.reject_fake_financial_outbox_mutation_v13()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION hx_authority.assert_fake_financial_outbox_target_v13(
  UUID, TEXT, TEXT, TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_financial_provider_command_recovery_lease()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION hx_authority.validate_fake_financial_outbox_request_v13()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION hx_authority.capture_fake_financial_outbox_request_v13()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION hx_authority.validate_fake_financial_outbox_disposition_v13()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION hx_authority.validate_fake_financial_publish_claim_v13()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION hx_authority.assert_fake_financial_publish_open_v13(UUID)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION hx_authority.validate_fake_financial_publish_exhaustion_v13()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION hx_authority.claim_fake_financial_outbox_v13(UUID, INTEGER)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION hx_authority.validate_fake_financial_publish_outcome_v13()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION hx_authority.record_fake_financial_publish_outcome_v13(
  UUID, TEXT, TEXT, TEXT, TEXT, INTEGER
) FROM PUBLIC;
REVOKE ALL ON FUNCTION hx_authority.validate_fake_financial_dispatch_admission_v13()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION hx_authority.validate_fake_financial_job_validation_v13()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION hx_authority.record_fake_financial_job_dispatch_evidence_v13(
  UUID, TEXT, TEXT, UUID, INTEGER, INTEGER, INTEGER
) FROM PUBLIC;
REVOKE ALL ON FUNCTION hx_authority.validate_fake_financial_webhook_rejection_v13()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION hx_authority.record_fake_financial_webhook_rejection_v13(
  UUID, TEXT, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION hx_authority.validate_fake_financial_webhook_inert_v13()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION hx_authority.capture_fake_financial_webhook_inert_v13()
  FROM PUBLIC;


-- Extend only the closed command-kind allowlist; authentication validation is unchanged.
CREATE OR REPLACE FUNCTION public.hxos_issue_universal_v1_actor_assertion_v1(
  opaque_token TEXT,
  asserted_environment TEXT,
  asserted_command_kind TEXT,
  asserted_canonical_request_sha256 TEXT,
  verified_auth_facts JSONB,
  requested_expires_at TIMESTAMPTZ
)
RETURNS TABLE (
  assertion_id UUID,
  issued_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
DECLARE
  database_now TIMESTAMPTZ;
  token_digest TEXT;
  auth_facts_digest TEXT;
  fact_keys TEXT[];
  step_up_keys TEXT[];
  auth_methods JSONB;
  verified_subject_value TEXT;
  verified_issuer_value TEXT;
  verified_audience_value TEXT;
  release_manifest_value TEXT;
  verified_at_value TIMESTAMPTZ;
  bearer_expires_at_value TIMESTAMPTZ;
  authentication_time_value TIMESTAMPTZ;
  revocation_checked_at_value TIMESTAMPTZ;
  mfa_verified_value BOOLEAN;
  step_up_satisfied_value BOOLEAN;
  step_up_method_value TEXT;
  step_up_verified_at_value TIMESTAMPTZ;
  effective_expires_at TIMESTAMPTZ;
BEGIN
  database_now := pg_catalog.clock_timestamp();

  IF opaque_token IS NULL
     OR opaque_token !~ '^[0-9a-f]{64}$'
     OR opaque_token = pg_catalog.repeat('0', 64) THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-2: assertion token must be one opaque 256-bit lowercase-hex value'
      USING ERRCODE = 'P0001';
  END IF;
  IF asserted_environment NOT IN ('local', 'preview', 'staging') THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-3: assertion environment is not isolated nonproduction'
      USING ERRCODE = 'P0001';
  END IF;
  IF asserted_command_kind NOT IN (
    'EXPRESS_POST_ESTIMATE_INTEREST',
    'PLACE_CONDITIONAL_HOLD',
    'PREPARE_FAKE_WORK_ORDER',
    'MATERIALIZE_FAKE_WORK_ORDER',
    'REQUEST_FAKE_WORK_ORDER_RECOVERY',
    'CLAIM_WORK_ORDER_COMPENSATION',
    'PREPARE_FAKE_FINANCIAL_COMMAND','READ_FAKE_FINANCIAL_REQUEST_PROGRESS','READ_FAKE_FINANCIAL_PREDECESSOR','READ_FAKE_WORK_ORDER_HISTORY','READ_FAKE_CHANGE_ORDER_HISTORY','PROPOSE_FAKE_CHANGE_ORDER','DECIDE_FAKE_CHANGE_ORDER','READ_FAKE_CHANGE_ORDER_KIND','PREPARE_FAKE_CHANGE_ORDER','FINALIZE_FAKE_CHANGE_ORDER'
  ) THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-4: assertion command kind is outside the closed V1A set'
      USING ERRCODE = 'P0001';
  END IF;
  IF asserted_canonical_request_sha256 IS NULL
     OR asserted_canonical_request_sha256 !~ '^[0-9a-f]{64}$'
     OR asserted_canonical_request_sha256 = pg_catalog.repeat('0', 64) THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-5: exact canonical request SHA-256 is required'
      USING ERRCODE = 'P0001';
  END IF;
  IF pg_catalog.jsonb_typeof(verified_auth_facts) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-6: verified authentication facts must be one closed object'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT pg_catalog.array_agg(fact_key ORDER BY fact_key)
    INTO fact_keys
    FROM pg_catalog.jsonb_object_keys(verified_auth_facts) AS keys(fact_key);
  IF fact_keys IS DISTINCT FROM ARRAY[
    'amr',
    'audience',
    'auth_time',
    'bearer_expires_at',
    'issuer',
    'mfa_verified',
    'release_manifest_sha256',
    'revocation_checked_at',
    'schema_version',
    'step_up',
    'verified_at',
    'verified_subject'
  ]::TEXT[]
     OR verified_auth_facts->'schema_version' IS DISTINCT FROM '1'::JSONB
     OR pg_catalog.jsonb_typeof(verified_auth_facts->'verified_subject') <> 'string'
     OR pg_catalog.jsonb_typeof(verified_auth_facts->'issuer') <> 'string'
     OR pg_catalog.jsonb_typeof(verified_auth_facts->'audience') <> 'string'
     OR pg_catalog.jsonb_typeof(verified_auth_facts->'release_manifest_sha256') <> 'string'
     OR pg_catalog.jsonb_typeof(verified_auth_facts->'verified_at') <> 'string'
     OR pg_catalog.jsonb_typeof(verified_auth_facts->'bearer_expires_at') <> 'string'
     OR pg_catalog.jsonb_typeof(verified_auth_facts->'auth_time') <> 'string'
     OR pg_catalog.jsonb_typeof(verified_auth_facts->'revocation_checked_at') <> 'string'
     OR pg_catalog.jsonb_typeof(verified_auth_facts->'amr') <> 'array'
     OR pg_catalog.jsonb_typeof(verified_auth_facts->'mfa_verified') <> 'boolean'
     OR pg_catalog.jsonb_typeof(verified_auth_facts->'step_up') <> 'object' THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-6: verified authentication facts must match the exact v1 shape'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT pg_catalog.array_agg(step_key ORDER BY step_key)
    INTO step_up_keys
    FROM pg_catalog.jsonb_object_keys(verified_auth_facts->'step_up') AS keys(step_key);
  IF step_up_keys IS DISTINCT FROM ARRAY['method', 'satisfied', 'verified_at']::TEXT[]
     OR pg_catalog.jsonb_typeof(verified_auth_facts->'step_up'->'satisfied') <> 'boolean'
     OR pg_catalog.jsonb_typeof(verified_auth_facts->'step_up'->'method')
          NOT IN ('string', 'null')
     OR pg_catalog.jsonb_typeof(verified_auth_facts->'step_up'->'verified_at')
          NOT IN ('string', 'null') THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-7: step-up facts must match the exact v1 shape'
      USING ERRCODE = 'P0001';
  END IF;

  auth_methods := verified_auth_facts->'amr';
  IF pg_catalog.jsonb_array_length(auth_methods) NOT BETWEEN 1 AND 8
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.jsonb_array_elements(auth_methods) AS method(value)
        WHERE pg_catalog.jsonb_typeof(value) <> 'string'
           OR value #>> '{}' !~ '^[a-z0-9:_-]{1,64}$'
     ) THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-8: authentication methods must be a bounded typed set'
      USING ERRCODE = 'P0001';
  END IF;

  verified_subject_value := verified_auth_facts->>'verified_subject';
  verified_issuer_value := verified_auth_facts->>'issuer';
  verified_audience_value := verified_auth_facts->>'audience';
  release_manifest_value := verified_auth_facts->>'release_manifest_sha256';
  verified_at_value := (verified_auth_facts->>'verified_at')::TIMESTAMPTZ;
  bearer_expires_at_value := (verified_auth_facts->>'bearer_expires_at')::TIMESTAMPTZ;
  authentication_time_value := (verified_auth_facts->>'auth_time')::TIMESTAMPTZ;
  revocation_checked_at_value :=
    (verified_auth_facts->>'revocation_checked_at')::TIMESTAMPTZ;
  mfa_verified_value := (verified_auth_facts->>'mfa_verified')::BOOLEAN;
  step_up_satisfied_value :=
    (verified_auth_facts->'step_up'->>'satisfied')::BOOLEAN;
  step_up_method_value := verified_auth_facts->'step_up'->>'method';
  step_up_verified_at_value := CASE
    WHEN verified_auth_facts->'step_up'->>'verified_at' IS NULL THEN NULL
    ELSE (verified_auth_facts->'step_up'->>'verified_at')::TIMESTAMPTZ
  END;

  IF verified_subject_value IS NULL
     OR verified_subject_value <> pg_catalog.btrim(verified_subject_value)
     OR pg_catalog.char_length(verified_subject_value) NOT BETWEEN 1 AND 128
     OR verified_subject_value !~ '^[A-Za-z0-9:_-]+$'
     OR verified_issuer_value IS NULL
     OR verified_issuer_value <> pg_catalog.btrim(verified_issuer_value)
     OR pg_catalog.char_length(verified_issuer_value) NOT BETWEEN 3 AND 512
     OR verified_audience_value IS NULL
     OR verified_audience_value <> pg_catalog.btrim(verified_audience_value)
     OR pg_catalog.char_length(verified_audience_value) NOT BETWEEN 1 AND 512
     OR release_manifest_value IS NULL
     OR release_manifest_value !~ '^sha256:[0-9a-f]{64}$'
     OR release_manifest_value = 'sha256:' || pg_catalog.repeat('0', 64) THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-9: verified subject, issuer, audience, and release binding are required'
      USING ERRCODE = 'P0001';
  END IF;

  IF authentication_time_value > verified_at_value
     OR verified_at_value > database_now
     OR verified_at_value < database_now - INTERVAL '60 seconds'
     OR revocation_checked_at_value > database_now
     OR revocation_checked_at_value < database_now - INTERVAL '60 seconds'
     OR bearer_expires_at_value <= database_now THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-10: bearer verification is stale, future-dated, revoked, or expired'
      USING ERRCODE = 'P0001';
  END IF;
  IF mfa_verified_value IS DISTINCT FROM (auth_methods @> '["mfa"]'::JSONB) THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-11: MFA fact contradicts the independently verified methods'
      USING ERRCODE = 'P0001';
  END IF;
  IF (
       step_up_satisfied_value
       AND (
         step_up_method_value IS NULL
         OR step_up_method_value <> pg_catalog.btrim(step_up_method_value)
         OR pg_catalog.char_length(step_up_method_value) NOT BETWEEN 1 AND 64
         OR step_up_verified_at_value IS NULL
         OR step_up_verified_at_value < authentication_time_value
         OR step_up_verified_at_value > verified_at_value
       )
     )
     OR (
       NOT step_up_satisfied_value
       AND (step_up_method_value IS NOT NULL OR step_up_verified_at_value IS NOT NULL)
     ) THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-12: step-up evidence is contradictory'
      USING ERRCODE = 'P0001';
  END IF;
  IF requested_expires_at IS NULL OR requested_expires_at <= database_now THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-13: requested assertion expiry must still be in the future'
      USING ERRCODE = 'P0001';
  END IF;

  effective_expires_at := LEAST(
    requested_expires_at,
    bearer_expires_at_value,
    database_now + INTERVAL '60 seconds'
  );
  IF effective_expires_at <= database_now THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-13: database-owned effective assertion lifetime is empty'
      USING ERRCODE = 'P0001';
  END IF;

  token_digest := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(opaque_token, 'UTF8')),
    'hex'
  );
  auth_facts_digest := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(verified_auth_facts::TEXT, 'UTF8')),
    'hex'
  );

  RETURN QUERY
  INSERT INTO hx_authority.universal_v1_actor_assertion_issuance_facts (
    token_sha256,
    environment,
    command_kind,
    canonical_request_sha256,
    release_manifest_sha256,
    verified_subject,
    verified_issuer,
    verified_audience,
    verified_at,
    bearer_expires_at,
    authentication_time,
    revocation_checked_at,
    authentication_methods,
    mfa_verified,
    step_up_satisfied,
    step_up_method,
    step_up_verified_at,
    auth_facts_sha256,
    issued_at,
    expires_at
  ) VALUES (
    token_digest,
    asserted_environment,
    asserted_command_kind,
    asserted_canonical_request_sha256,
    release_manifest_value,
    verified_subject_value,
    verified_issuer_value,
    verified_audience_value,
    verified_at_value,
    bearer_expires_at_value,
    authentication_time_value,
    revocation_checked_at_value,
    auth_methods,
    mfa_verified_value,
    step_up_satisfied_value,
    step_up_method_value,
    step_up_verified_at_value,
    auth_facts_digest,
    database_now,
    effective_expires_at
  )
  RETURNING
    universal_v1_actor_assertion_issuance_facts.assertion_id,
    universal_v1_actor_assertion_issuance_facts.issued_at,
    universal_v1_actor_assertion_issuance_facts.expires_at;
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'HXUV1-ACTOR-14: assertion token digest already exists'
      USING ERRCODE = 'P0001';
END;
$$;

-- Human financial preparation uses the same attester and current target authority.
-- Its closed payload contains no actor, caller release, generated id or provider capability.
ALTER TABLE hx_authority.universal_v1_actor_assertion_issuance_facts
  DROP CONSTRAINT universal_v1_actor_assertion_issuance_facts_command_kind_check;
ALTER TABLE hx_authority.universal_v1_actor_assertion_issuance_facts
  ADD CONSTRAINT universal_v1_actor_assertion_issuance_facts_command_kind_check CHECK(command_kind IN (
    'EXPRESS_POST_ESTIMATE_INTEREST','PLACE_CONDITIONAL_HOLD','PREPARE_FAKE_WORK_ORDER',
    'MATERIALIZE_FAKE_WORK_ORDER','REQUEST_FAKE_WORK_ORDER_RECOVERY','CLAIM_WORK_ORDER_COMPENSATION',
    'PREPARE_FAKE_FINANCIAL_COMMAND','READ_FAKE_FINANCIAL_REQUEST_PROGRESS','READ_FAKE_FINANCIAL_PREDECESSOR','READ_FAKE_WORK_ORDER_HISTORY','READ_FAKE_CHANGE_ORDER_HISTORY','PROPOSE_FAKE_CHANGE_ORDER','DECIDE_FAKE_CHANGE_ORDER','READ_FAKE_CHANGE_ORDER_KIND','PREPARE_FAKE_CHANGE_ORDER','FINALIZE_FAKE_CHANGE_ORDER'));

CREATE OR REPLACE FUNCTION hx_authority.validate_fake_financial_preparation_payload_v13(payload JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE
SET search_path = pg_catalog AS $$
DECLARE keys TEXT[]; name TEXT; binding_count INTEGER;
BEGIN
  IF pg_catalog.jsonb_typeof(payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'HXUV1-FINPREP-13-PAYLOAD_INVALID'; END IF;
  SELECT pg_catalog.array_agg(key ORDER BY key COLLATE "C") INTO keys FROM pg_catalog.jsonb_object_keys(payload) key;
  IF keys IS DISTINCT FROM ARRAY['amountCents','changeOrderId','completionFactId','currency',
    'eligibilityDecisionId','idempotencyKey','lifecycleExpectedVersion','operationId','operationKind',
    'predecessorEventId','providerExpectedVersion','providerKind','providerRequestSha256',
    'relatedOperationId','scopeVersionId','taskDraftId','taskId']::TEXT[] THEN
    RAISE EXCEPTION 'HXUV1-FINPREP-13-PAYLOAD_INVALID'; END IF;
  IF payload->>'providerKind' IS DISTINCT FROM 'FAKE'
     OR payload->>'operationKind' NOT IN ('PREPARE_PAYMENT_METHOD','AUTHORIZE','SECURE','VOID','ADJUST',
       'CAPTURE','REFUND','REVERSAL','SETTLE','FUND','PROVIDER_RELEASE','PAYOUT','OBSERVE_BANK_SETTLEMENT')
     OR pg_catalog.jsonb_typeof(payload->'operationKind') IS DISTINCT FROM 'string'
     OR pg_catalog.jsonb_typeof(payload->'idempotencyKey') IS DISTINCT FROM 'string'
     OR payload->>'idempotencyKey' !~ '^[A-Za-z0-9:_-]{16,128}$'
     OR pg_catalog.jsonb_typeof(payload->'providerRequestSha256') IS DISTINCT FROM 'string'
     OR payload->>'providerRequestSha256' !~ '^[a-f0-9]{64}$'
     OR payload->>'providerRequestSha256'=pg_catalog.repeat('0',64) THEN
    RAISE EXCEPTION 'HXUV1-FINPREP-13-PAYLOAD_INVALID'; END IF;
  FOREACH name IN ARRAY ARRAY['operationId','taskDraftId','taskId','eligibilityDecisionId',
    'scopeVersionId','changeOrderId','predecessorEventId','completionFactId','relatedOperationId'] LOOP
    IF payload->name='null'::JSONB AND name NOT IN ('operationId','taskDraftId') THEN CONTINUE; END IF;
    IF pg_catalog.jsonb_typeof(payload->name) IS DISTINCT FROM 'string'
       OR payload->>name !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' THEN
      RAISE EXCEPTION 'HXUV1-FINPREP-13-BINDING_INVALID'; END IF;
  END LOOP;
  FOREACH name IN ARRAY ARRAY['providerExpectedVersion','lifecycleExpectedVersion','amountCents'] LOOP
    IF name='amountCents' AND payload->name='null'::JSONB THEN CONTINUE; END IF;
    IF pg_catalog.jsonb_typeof(payload->name) IS DISTINCT FROM 'number'
       OR payload->>name !~ '^(0|[1-9][0-9]{0,15})$'
       OR (payload->>name)::NUMERIC>9007199254740991
       OR (name='amountCents' AND (payload->>name)::NUMERIC<=0) THEN
      RAISE EXCEPTION 'HXUV1-FINPREP-13-VERSION_AMOUNT_INVALID'; END IF;
  END LOOP;
  IF payload->'currency'<>'null'::JSONB AND (pg_catalog.jsonb_typeof(payload->'currency') IS DISTINCT FROM 'string'
       OR payload->>'currency' !~ '^[A-Z]{3}$') THEN RAISE EXCEPTION 'HXUV1-FINPREP-13-CURRENCY_INVALID'; END IF;
  SELECT pg_catalog.count(*) INTO binding_count FROM pg_catalog.unnest(ARRAY['taskId','eligibilityDecisionId','scopeVersionId']) item
    WHERE payload->item<>'null'::JSONB;
  IF payload->>'operationKind'='PREPARE_PAYMENT_METHOD' THEN
    IF binding_count NOT IN (0,3) OR payload->>'lifecycleExpectedVersion'<>'0'
       OR payload->>'providerExpectedVersion'<>'0'
       OR EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY['changeOrderId','predecessorEventId','completionFactId',
         'relatedOperationId','amountCents','currency']) item WHERE payload->item<>'null'::JSONB) THEN
      RAISE EXCEPTION 'HXUV1-FINPREP-13-BINDING_INVALID'; END IF;
  ELSIF binding_count<>3 OR payload->'predecessorEventId'='null'::JSONB
     OR payload->'relatedOperationId'='null'::JSONB OR payload->'amountCents'='null'::JSONB
     OR payload->'currency'='null'::JSONB OR payload->>'lifecycleExpectedVersion'='0'
     OR ((payload->>'operationKind'='ADJUST') IS DISTINCT FROM (payload->'changeOrderId'<>'null'::JSONB))
     OR ((payload->>'operationKind'='CAPTURE') IS DISTINCT FROM (payload->'completionFactId'<>'null'::JSONB)) THEN
    RAISE EXCEPTION 'HXUV1-FINPREP-13-BINDING_INVALID';
  END IF;
  RETURN payload;
END;
$$;

CREATE OR REPLACE FUNCTION public.hxos_build_fake_financial_preparation_actor_request_v13(
  expected_command_kind TEXT, command_payload JSONB
)
RETURNS TABLE(target_authority_id UUID,environment TEXT,release_manifest_sha256 TEXT,
  canonical_request JSONB,actor_request_sha256 TEXT)
LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE SET search_path=pg_catalog AS $$
DECLARE target RECORD; payload JSONB;
BEGIN
  PERFORM hx_authority.assert_universal_v1_work_order_bootstrap_seal_v1();
  IF expected_command_kind IS DISTINCT FROM 'PREPARE_FAKE_FINANCIAL_COMMAND' THEN
    RAISE EXCEPTION 'HXUV1-FINPREP-13-COMMAND_KIND_INVALID'; END IF;
  payload:=hx_authority.validate_fake_financial_preparation_payload_v13(command_payload);
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('hxuv1-work-order-target-authority-v1',0));
  SELECT * INTO STRICT target FROM hx_authority.read_universal_v1_work_order_target_authority_v1();
  canonical_request:=pg_catalog.jsonb_build_object('schema_version',1,'command_kind',expected_command_kind,
    'release_manifest_sha256',target.release_manifest_sha256,
    'target_authority',pg_catalog.jsonb_build_object('id',target.target_authority_id,'version',target.authority_version,
      'database',target.target_database_name,'environment',target.environment,'release',target.release_manifest_sha256),
    'authentication_requirements',pg_catalog.jsonb_build_object('mfa_required',FALSE,'step_up_required',FALSE,
      'max_auth_age_seconds',300,'max_step_up_age_seconds',NULL),'command_payload',payload);
  target_authority_id:=target.target_authority_id; environment:=target.environment;
  release_manifest_sha256:=target.release_manifest_sha256;
  actor_request_sha256:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(canonical_request::TEXT,'UTF8')),'hex');
  RETURN NEXT;
END;
$$;

CREATE TABLE hx_authority.fake_financial_preparation_authority_v13 (
  prepared_command_id UUID PRIMARY KEY REFERENCES public.universal_v1_prepared_financial_commands(prepared_command_id),
  actor_assertion_id UUID NOT NULL UNIQUE REFERENCES hx_authority.universal_v1_actor_assertion_issuance_facts(assertion_id),
  actor_user_id UUID NOT NULL REFERENCES public.users(id),
  target_authority_id UUID NOT NULL REFERENCES hx_authority.universal_v1_work_order_target_authority_facts(target_authority_id),
  release_manifest_sha256 TEXT NOT NULL CHECK(release_manifest_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  actor_request_sha256 TEXT NOT NULL CHECK(actor_request_sha256 ~ '^[a-f0-9]{64}$' AND actor_request_sha256<>pg_catalog.repeat('0',64)),
  command_payload JSONB NOT NULL CHECK(pg_catalog.jsonb_typeof(command_payload)='object'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
CREATE TRIGGER fake_financial_preparation_authority_no_mutation_v13
  BEFORE UPDATE OR DELETE ON hx_authority.fake_financial_preparation_authority_v13
  FOR EACH ROW EXECUTE FUNCTION hx_authority.reject_universal_v1_work_order_authority_mutation_v1();
CREATE TRIGGER fake_financial_preparation_authority_no_truncate_v13
  BEFORE TRUNCATE ON hx_authority.fake_financial_preparation_authority_v13
  FOR EACH STATEMENT EXECUTE FUNCTION hx_authority.reject_universal_v1_work_order_authority_mutation_v1();

CREATE OR REPLACE FUNCTION public.hxos_prepare_authenticated_fake_financial_command_v13(
  actor_assertion_token TEXT, command_payload JSONB
)
RETURNS TABLE(prepared_command JSONB,idempotency_replayed BOOLEAN,actor_request_sha256 TEXT,
  actor_assertion_id UUID,target_authority_id UUID)
LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE SET search_path=pg_catalog AS $$
DECLARE
  request RECORD; actor RECORD; draft public.task_drafts%ROWTYPE;
  bound_task public.tasks%ROWTYPE; customer_authorized BOOLEAN;
  prepared public.universal_v1_prepared_financial_commands%ROWTYPE;
  provenance hx_authority.fake_financial_preparation_authority_v13%ROWTYPE;
  payload JSONB; lock_name TEXT; replay BOOLEAN:=FALSE;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'HXUV1-FINPREP-13-READ_COMMITTED_REQUIRED'; END IF;
  SELECT * INTO STRICT request FROM public.hxos_build_fake_financial_preparation_actor_request_v13(
    'PREPARE_FAKE_FINANCIAL_COMMAND',command_payload);
  payload:=request.canonical_request->'command_payload';
  FOR lock_name IN SELECT value FROM pg_catalog.unnest(ARRAY[
    'draft-version:'||(payload->>'taskDraftId')||':'||(payload->>'lifecycleExpectedVersion'),
    'idempotency:'||(payload->>'idempotencyKey'),
    'operation-version:FAKE:'||(payload->>'operationKind')||':'||(payload->>'operationId')||':'||(payload->>'providerExpectedVersion')
  ]) locks(value) ORDER BY value COLLATE "C" LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('universal-v1-prepared-financial-command-v1'),pg_catalog.hashtext(lock_name));
  END LOOP;
  SELECT * INTO draft FROM public.task_drafts WHERE id=(payload->>'taskDraftId')::UUID FOR UPDATE NOWAIT;
  PERFORM 1 FROM public.users WHERE id=draft.poster_user_id FOR SHARE NOWAIT;
  IF payload->>'taskId' IS NOT NULL THEN
    SELECT * INTO bound_task FROM public.tasks WHERE id=(payload->>'taskId')::UUID FOR SHARE NOWAIT;
  END IF;
  SELECT * INTO STRICT actor FROM hx_authority.consume_universal_v1_actor_assertion_v1(
    actor_assertion_token,'PREPARE_FAKE_FINANCIAL_COMMAND',request.canonical_request,request.environment);
  -- Delegation is bounded to the immutable Phase A adjustment. Other financial
  -- commands retain their existing customer-poster authorization boundary.
  PERFORM 1 FROM public.users WHERE id=actor.resolved_user_id FOR SHARE NOWAIT;
  customer_authorized:=draft.poster_user_id=actor.resolved_user_id;
  IF payload->>'operationKind'='ADJUST' THEN
    PERFORM 1 FROM public.business_organizations WHERE id=bound_task.business_organization_id FOR SHARE NOWAIT;
    PERFORM 1 FROM public.business_memberships
      WHERE organization_id=bound_task.business_organization_id AND user_id=actor.resolved_user_id
      ORDER BY organization_id,user_id,id FOR SHARE NOWAIT;
    SELECT EXISTS (
      SELECT 1 FROM public.universal_v1_change_order_materialization_commands witness
      LEFT JOIN public.business_organizations organization ON organization.id=bound_task.business_organization_id
      WHERE witness.proposal_id=(payload->>'changeOrderId')::UUID
        AND witness.actor_user_id=actor.resolved_user_id
        AND witness.task_draft_id=draft.id AND witness.task_id=bound_task.id
        AND witness.work_order_id=bound_task.work_order_id
        AND witness.eligibility_decision_id=(payload->>'eligibilityDecisionId')::UUID
        AND witness.replacement_scope_version_id=(payload->>'scopeVersionId')::UUID
        AND witness.adjustment_operation_id=(payload->>'operationId')::UUID
        AND witness.idempotency_key||':adjust'=payload->>'idempotencyKey'
        AND witness.predecessor_event_id=(payload->>'predecessorEventId')::UUID
        AND witness.predecessor_operation_id=(payload->>'relatedOperationId')::UUID
        AND witness.expected_financial_version+1=(payload->>'lifecycleExpectedVersion')::BIGINT
        AND witness.customer_total_cents=(payload->>'amountCents')::BIGINT
        AND witness.currency=payload->>'currency'
        AND payload->>'providerExpectedVersion'='0' AND bound_task.worker_id IS NULL
        AND ((bound_task.business_organization_id IS NULL AND bound_task.poster_id=actor.resolved_user_id)
          OR (bound_task.business_organization_id IS NOT NULL AND organization.status='ACTIVE'
            AND organization.client_enabled IS TRUE
            AND public.business_membership_has_action(bound_task.business_organization_id,actor.resolved_user_id,'APPROVE_SPEND')))
    ) INTO customer_authorized;
  END IF;
  IF draft.id IS NULL OR draft.claimed_at IS NULL OR draft.ingress_origin IS DISTINCT FROM 'BACKEND_POSTGRESQL'
     OR draft.universal_contract_version IS DISTINCT FROM 1 OR customer_authorized IS NOT TRUE
     OR NOT EXISTS (SELECT 1 FROM public.users current_actor WHERE current_actor.id=actor.resolved_user_id
       AND current_actor.firebase_uid=actor.verified_subject AND current_actor.account_status='ACTIVE'
       AND current_actor.is_minor IS FALSE AND COALESCE(current_actor.is_banned,FALSE) IS FALSE)
     OR (draft.task_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.tasks task
       WHERE task.id=draft.task_id AND task.poster_id=draft.poster_user_id
         AND task.universal_contract_version=1 AND task.automation_classification='CONTROLLED_TEST'
         AND task.universal_payment_posture='PAYMENT_CREATION_FROZEN')) THEN
    RAISE EXCEPTION 'HXUV1-FINPREP-13-CUSTOMER_AUTHORITY_REVOKED'; END IF;
  SELECT * INTO prepared FROM public.universal_v1_prepared_financial_commands p
    WHERE p.idempotency_key=payload->>'idempotencyKey'
       OR (p.provider_kind='FAKE' AND p.operation_kind=payload->>'operationKind'
         AND p.operation_id=(payload->>'operationId')::UUID AND p.provider_expected_version=(payload->>'providerExpectedVersion')::BIGINT)
       OR (p.task_draft_id=draft.id AND p.lifecycle_expected_version=(payload->>'lifecycleExpectedVersion')::BIGINT)
    ORDER BY (p.idempotency_key=payload->>'idempotencyKey') DESC,p.prepared_command_id LIMIT 1;
  IF prepared.prepared_command_id IS NOT NULL THEN
    SELECT * INTO provenance FROM hx_authority.fake_financial_preparation_authority_v13 p
      WHERE p.prepared_command_id=prepared.prepared_command_id;
    IF provenance.prepared_command_id IS NULL THEN RAISE EXCEPTION 'HXUV1-FINPREP-13-UNAUTHENTICATED_HISTORY'; END IF;
    IF provenance.command_payload IS DISTINCT FROM payload OR provenance.actor_user_id IS DISTINCT FROM actor.resolved_user_id
       OR provenance.target_authority_id IS DISTINCT FROM request.target_authority_id
       OR provenance.release_manifest_sha256 IS DISTINCT FROM request.release_manifest_sha256
       OR provenance.actor_request_sha256 IS DISTINCT FROM request.actor_request_sha256
       OR prepared.recorded_by IS DISTINCT FROM actor.resolved_user_id THEN
      RAISE EXCEPTION 'HXUV1-FINPREP-13-IDEMPOTENCY_CONFLICT'; END IF;
    replay:=TRUE;
  ELSE
    IF draft.task_id IS DISTINCT FROM (payload->>'taskId')::UUID THEN
      RAISE EXCEPTION 'HXUV1-FINPREP-13-TASK_BINDING_MISMATCH'; END IF;
    SELECT * INTO STRICT prepared FROM public.hxos_prepare_universal_v1_financial_command_v1(
      pg_catalog.gen_random_uuid(),payload->>'operationKind',(payload->>'operationId')::UUID,'FAKE',payload->>'idempotencyKey',
      (payload->>'providerExpectedVersion')::BIGINT,(payload->>'lifecycleExpectedVersion')::BIGINT,payload->>'providerRequestSha256',
      draft.id,(payload->>'taskId')::UUID,(payload->>'eligibilityDecisionId')::UUID,(payload->>'scopeVersionId')::UUID,
      (payload->>'changeOrderId')::UUID,(payload->>'predecessorEventId')::UUID,(payload->>'completionFactId')::UUID,
      (payload->>'relatedOperationId')::UUID,(payload->>'amountCents')::BIGINT,payload->>'currency',actor.resolved_user_id);
    INSERT INTO hx_authority.fake_financial_preparation_authority_v13(prepared_command_id,actor_assertion_id,actor_user_id,
      target_authority_id,release_manifest_sha256,actor_request_sha256,command_payload)
    VALUES(prepared.prepared_command_id,actor.assertion_id,actor.resolved_user_id,request.target_authority_id,
      request.release_manifest_sha256,request.actor_request_sha256,payload);
  END IF;
  prepared_command:=pg_catalog.to_jsonb(prepared);idempotency_replayed:=replay;
  actor_request_sha256:=request.actor_request_sha256;actor_assertion_id:=actor.assertion_id;target_authority_id:=request.target_authority_id;
  RETURN NEXT;
END;
$$;
REVOKE ALL ON TABLE hx_authority.fake_financial_preparation_authority_v13 FROM PUBLIC;
REVOKE ALL ON FUNCTION hx_authority.validate_fake_financial_preparation_payload_v13(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.hxos_build_fake_financial_preparation_actor_request_v13(TEXT,JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.hxos_prepare_authenticated_fake_financial_command_v13(TEXT,JSONB) FROM PUBLIC;


-- Customer progress is an attested read. It never prepares, publishes, admits,
-- executes or materializes a financial command and returns no provider request.
CREATE OR REPLACE FUNCTION public.hxos_build_fake_financial_progress_actor_request_v13(
  expected_command_kind TEXT, command_payload JSONB
)
RETURNS TABLE(target_authority_id UUID,environment TEXT,release_manifest_sha256 TEXT,
  canonical_request JSONB,actor_request_sha256 TEXT)
LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE SET search_path=pg_catalog AS $$
DECLARE target RECORD;
BEGIN
  PERFORM hx_authority.assert_universal_v1_work_order_bootstrap_seal_v1();
  IF expected_command_kind IS DISTINCT FROM 'READ_FAKE_FINANCIAL_REQUEST_PROGRESS'
     OR pg_catalog.jsonb_typeof(command_payload) IS DISTINCT FROM 'object'
     OR command_payload - 'commandId' <> '{}'::JSONB
     OR pg_catalog.jsonb_typeof(command_payload->'commandId') IS DISTINCT FROM 'string'
     OR command_payload->>'commandId' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' THEN
    RAISE EXCEPTION 'HXUV1-FINPUBLIC-13-PAYLOAD_INVALID'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('hxuv1-work-order-target-authority-v1',0));
  SELECT * INTO STRICT target FROM hx_authority.read_universal_v1_work_order_target_authority_v1();
  canonical_request:=pg_catalog.jsonb_build_object('schema_version',1,'command_kind',expected_command_kind,
    'release_manifest_sha256',target.release_manifest_sha256,
    'target_authority',pg_catalog.jsonb_build_object('id',target.target_authority_id,'version',target.authority_version,
      'database',target.target_database_name,'environment',target.environment,'release',target.release_manifest_sha256),
    'authentication_requirements',pg_catalog.jsonb_build_object('mfa_required',FALSE,'step_up_required',FALSE,
      'max_auth_age_seconds',300,'max_step_up_age_seconds',NULL),'command_payload',command_payload);
  target_authority_id:=target.target_authority_id; environment:=target.environment;
  release_manifest_sha256:=target.release_manifest_sha256;
  actor_request_sha256:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(canonical_request::TEXT,'UTF8')),'hex');
  RETURN NEXT;
END;
$$;

-- Only the command owner can call this projection across the finance boundary.
-- It must check current customer authority before returning the projection.
CREATE OR REPLACE FUNCTION hx_authority.read_fake_financial_public_progress_v13(p_command_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE SET search_path=pg_catalog AS $$
DECLARE
  request_record hx_authority.fake_financial_command_outbox_requests_v13%ROWTYPE;
  command_record public.financial_provider_command_journal%ROWTYPE;
  progress RECORD; bridge public.universal_v1_fake_financial_lifecycle_bridges%ROWTYPE;
  event public.task_financial_security_events%ROWTYPE;
  exact RECORD; prepared public.universal_v1_prepared_financial_commands%ROWTYPE; expected_status TEXT;
  state TEXT; event_json JSONB:=NULL; observed_at TIMESTAMPTZ;
  effective_event JSONB; resolution JSONB;
BEGIN
  SELECT * INTO command_record FROM public.financial_provider_command_journal WHERE command_id=p_command_id;
  SELECT * INTO request_record FROM hx_authority.fake_financial_command_outbox_requests_v13 WHERE command_id=p_command_id;
  IF command_record.command_id IS NULL OR request_record.outbox_request_id IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO STRICT progress FROM public.hxos_read_fake_financial_progress_v13(
    request_record.outbox_request_id,request_record.bullmq_job_id,pg_catalog.btrim(request_record.job_authority_sha256));
  observed_at:=pg_catalog.clock_timestamp();
  SELECT * INTO bridge FROM public.universal_v1_fake_financial_lifecycle_bridges WHERE command_id=p_command_id;
  IF bridge.bridge_id IS NOT NULL THEN
    SELECT * INTO event FROM public.task_financial_security_events WHERE id=bridge.task_financial_security_event_id;
    SELECT * INTO STRICT exact FROM hx_authority.read_fake_financial_materialization_evidence_v13(
      (progress.recovery_evidence->'admission_evidence'->>'job_validation_id')::UUID,bridge.outcome_fact_id);
    -- Use the same validated terminal projection as materialization. Preserve
    -- the original admitted event identity and signed resolution timestamps.
    IF exact.provider_event->>'kind'='HX_FAKE_TERMINAL_OBSERVATION_V13' THEN
      resolution:=exact.provider_event->'resolution';
      effective_event:=(exact.provider_event->'original_event')||pg_catalog.jsonb_build_object(
        'state',exact.outcome_fact->>'provider_state','retryable',FALSE,
        'recorded_at',resolution->'provider_occurred_at','expires_at',resolution->'provider_expires_at');
    ELSE
      effective_event:=exact.provider_event;
    END IF;
    SELECT * INTO STRICT prepared FROM public.universal_v1_prepared_financial_commands
      WHERE prepared_command_id=request_record.prepared_command_id;
    expected_status:=CASE effective_event->>'state' WHEN 'DECLINED' THEN 'DECLINED' WHEN 'FAILED' THEN 'FAILED' ELSE 'SUCCEEDED' END;
    IF bridge.prepared_command_id IS DISTINCT FROM prepared.prepared_command_id
       OR bridge.dispatch_attempt_id IS DISTINCT FROM (exact.admission_evidence ->> 'dispatch_attempt_id')::UUID
       OR bridge.outcome_fact_id IS DISTINCT FROM (progress.recorded_outcome->'outcome_fact'->>'outcome_fact_id')::UUID
       OR bridge.fake_operation_event_id IS DISTINCT FROM (effective_event ->> 'event_id')::UUID
       OR event.id IS NULL
       OR event.operation_id IS DISTINCT FROM prepared.operation_id::TEXT
       OR event.idempotency_key IS DISTINCT FROM prepared.idempotency_key
       OR event.provider_kind IS DISTINCT FROM 'FAKE'
       OR event.event_kind IS DISTINCT FROM prepared.event_kind
       OR event.status IS DISTINCT FROM expected_status
       OR event.expected_version IS DISTINCT FROM prepared.lifecycle_expected_version
       OR event.task_draft_id IS DISTINCT FROM prepared.task_draft_id
       OR event.task_id IS DISTINCT FROM prepared.task_id
       OR event.eligibility_decision_id IS DISTINCT FROM prepared.eligibility_decision_id
       OR event.scope_version_id IS DISTINCT FROM prepared.scope_version_id
       OR event.change_order_id IS DISTINCT FROM prepared.change_order_id
       OR event.predecessor_event_id IS DISTINCT FROM prepared.predecessor_event_id
       OR event.completion_fact_id IS DISTINCT FROM prepared.completion_fact_id
       OR event.amount_cents IS DISTINCT FROM prepared.amount_cents
       OR event.currency IS DISTINCT FROM prepared.currency
       OR event.recorded_by IS DISTINCT FROM prepared.recorded_by
       OR event.external_reference IS DISTINCT FROM effective_event ->> 'external_reference'
       OR event.occurred_at IS DISTINCT FROM (effective_event ->> 'recorded_at')::TIMESTAMPTZ
       OR event.expires_at IS DISTINCT FROM (effective_event ->> 'expires_at')::TIMESTAMPTZ
       OR event.evidence IS DISTINCT FROM pg_catalog.jsonb_build_object(
         'providerState',effective_event ->> 'state',
         'providerOperationVersion',(effective_event ->> 'event_version')::BIGINT,
         'providerIdempotencyReplayed',FALSE
       ) THEN
      RAISE EXCEPTION 'HXUV1-FINPUBLIC-13-MATERIALIZATION_INCONSISTENT'; END IF;
    state:='MATERIALIZED';
    event_json:=pg_catalog.jsonb_build_object('id',event.id,'eventKind',event.event_kind,'status',event.status);
  ELSIF progress.recorded_outcome IS NOT NULL THEN
    -- A committed outcome awaiting materialization, UNKNOWN or pending value
    -- remains unfinished. Never report success from a raw provider event alone.
    state:='RECOVERY_REQUIRED';
  ELSIF progress.recovery_evidence->'admission_evidence' <> 'null'::JSONB THEN
    state:=CASE WHEN (progress.recovery_evidence->'admission_evidence'->>'outcome_deadline_at')::TIMESTAMPTZ <= observed_at
      THEN 'RECOVERY_REQUIRED' ELSE 'PROCESSING' END;
  ELSIF EXISTS(SELECT 1 FROM hx_authority.fake_financial_outbox_dispositions_v13 WHERE outbox_request_id=request_record.outbox_request_id)
     OR EXISTS(SELECT 1 FROM hx_authority.fake_financial_publish_exhaustions_v13 WHERE outbox_request_id=request_record.outbox_request_id)
     OR EXISTS(SELECT 1 FROM hx_authority.fake_financial_outbox_publish_outcomes_v13 WHERE outbox_request_id=request_record.outbox_request_id AND outcome_kind='TERMINAL_FAILURE')
     OR EXISTS(SELECT 1 FROM hx_authority.universal_v1_work_order_target_authority_facts WHERE supersedes_target_authority_id=request_record.target_authority_id) THEN
    state:='RECOVERY_REQUIRED';
  ELSIF EXISTS(SELECT 1 FROM hx_authority.fake_financial_outbox_publish_outcomes_v13 WHERE outbox_request_id=request_record.outbox_request_id AND outcome_kind='BULLMQ_CONFIRMED'
    AND recording_transaction_id IS DISTINCT FROM pg_catalog.pg_current_xact_id_if_assigned()) THEN state:='PUBLISHED';
  ELSE state:='REQUESTED'; END IF;
  RETURN pg_catalog.jsonb_build_object('commandId',command_record.command_id,'operationId',command_record.operation_id,
    'operationKind',command_record.operation_kind,'taskDraftId',command_record.task_draft_id,'taskId',command_record.task_id,
    'ownerActorId',command_record.recorded_actor_id,'environment',request_record.release_environment,
    'requestedAt',command_record.recorded_at,'observedAt',observed_at,
    'requestState','REQUESTED','progressState',state,'financialEvent',event_json);
END;
$$;

CREATE OR REPLACE FUNCTION public.hxos_read_authenticated_fake_financial_progress_v13(
  actor_assertion_token TEXT, command_payload JSONB
)
RETURNS TABLE(progress JSONB,actor_user_id UUID,actor_assertion_id UUID,actor_request_sha256 TEXT,
  target_authority_id UUID,reader_release_sha256 TEXT)
LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE SET search_path=pg_catalog AS $$
DECLARE request RECORD; actor RECORD; projected JSONB; context JSONB; before_locks JSONB; pass INTEGER;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'HXUV1-FINPUBLIC-13-READ_COMMITTED_REQUIRED'; END IF;
  SELECT * INTO STRICT request FROM public.hxos_build_fake_financial_progress_actor_request_v13(
    'READ_FAKE_FINANCIAL_REQUEST_PROGRESS',command_payload);
  SELECT * INTO STRICT actor FROM hx_authority.consume_universal_v1_actor_assertion_v1(
    actor_assertion_token,'READ_FAKE_FINANCIAL_REQUEST_PROGRESS',request.canonical_request,request.environment);
  -- Preflight ownership before locking another customer's rows. Re-read all
  -- mutable authority after locks, before crossing into the finance projection.
  FOR pass IN 1..2 LOOP
    SELECT pg_catalog.jsonb_build_object('draft_id',candidate.id,'task_id',candidate.task_id,
      'poster_user_id',candidate.poster_user_id,'organization_id',task.business_organization_id)
      INTO context
    FROM public.task_drafts candidate
    JOIN public.financial_provider_command_journal command ON command.task_draft_id=candidate.id
    JOIN public.users current_actor ON current_actor.id=actor.resolved_user_id
    LEFT JOIN public.tasks task ON task.id=candidate.task_id
    LEFT JOIN public.business_organizations organization ON organization.id=task.business_organization_id
    WHERE command.command_id=(command_payload->>'commandId')::UUID
      AND command.recorded_actor_id=actor.resolved_user_id AND command.provider_kind='FAKE'
      AND candidate.claimed_at IS NOT NULL AND candidate.ingress_origin='BACKEND_POSTGRESQL'
      AND candidate.universal_contract_version=1
      AND current_actor.firebase_uid=actor.verified_subject AND current_actor.account_status='ACTIVE'
      AND current_actor.is_minor IS FALSE AND COALESCE(current_actor.is_banned,FALSE) IS FALSE
      AND (candidate.task_id IS NULL OR (task.poster_id=candidate.poster_user_id
        AND task.universal_contract_version=1 AND task.automation_classification='CONTROLLED_TEST'
        AND task.worker_id IS NULL AND task.universal_payment_posture='PAYMENT_CREATION_FROZEN'))
      AND ((command.operation_kind<>'ADJUST' AND candidate.poster_user_id=actor.resolved_user_id)
        OR (command.operation_kind='ADJUST' AND EXISTS (
          SELECT 1 FROM public.universal_v1_prepared_financial_commands prepared
          JOIN public.universal_v1_change_order_materialization_commands witness
            ON witness.proposal_id=prepared.change_order_id
          WHERE prepared.prepared_command_id=command.prepared_financial_command_id
            AND prepared.provider_kind='FAKE' AND prepared.operation_kind='ADJUST'
            AND prepared.recorded_by=actor.resolved_user_id AND witness.actor_user_id=actor.resolved_user_id
            AND prepared.operation_id=command.operation_id AND witness.adjustment_operation_id=prepared.operation_id
            AND prepared.idempotency_key=command.idempotency_key AND witness.idempotency_key||':adjust'=prepared.idempotency_key
            AND prepared.provider_request_sha256=command.request_sha256
            AND prepared.provider_expected_version=command.provider_expected_version AND prepared.provider_expected_version=0
            AND prepared.task_draft_id=candidate.id AND witness.task_draft_id=candidate.id
            AND prepared.task_id=task.id AND command.task_id=task.id AND witness.task_id=task.id
            AND prepared.work_order_id=task.work_order_id AND witness.work_order_id=task.work_order_id
            AND witness.eligibility_decision_id=prepared.eligibility_decision_id
            AND witness.replacement_scope_version_id=prepared.scope_version_id
            AND witness.predecessor_event_id=prepared.predecessor_event_id
            AND witness.predecessor_operation_id=prepared.related_operation_id
            AND witness.expected_financial_version+1=prepared.lifecycle_expected_version
            AND witness.customer_total_cents=prepared.amount_cents AND witness.currency=prepared.currency
            AND ((task.business_organization_id IS NULL AND task.poster_id=actor.resolved_user_id)
              OR (task.business_organization_id IS NOT NULL AND organization.status='ACTIVE'
                AND organization.client_enabled IS TRUE
                AND public.business_membership_has_action(task.business_organization_id,actor.resolved_user_id,'APPROVE_SPEND')))
        )));
    IF context IS NULL THEN EXIT; END IF;
    IF pass=1 THEN
      before_locks:=context;
      PERFORM 1 FROM public.task_drafts WHERE id=(context->>'draft_id')::UUID FOR SHARE NOWAIT;
      PERFORM 1 FROM public.tasks WHERE id=(context->>'task_id')::UUID FOR SHARE NOWAIT;
      PERFORM 1 FROM public.users WHERE id=actor.resolved_user_id FOR SHARE NOWAIT;
      PERFORM 1 FROM public.business_organizations WHERE id=(context->>'organization_id')::UUID FOR SHARE NOWAIT;
      PERFORM 1 FROM public.business_memberships WHERE organization_id=(context->>'organization_id')::UUID
        AND user_id=actor.resolved_user_id ORDER BY organization_id,user_id,id FOR SHARE NOWAIT;
    ELSE
      IF context IS DISTINCT FROM before_locks THEN EXIT; END IF;
      projected:=hx_authority.read_fake_financial_public_progress_v13((command_payload->>'commandId')::UUID);
      IF projected->>'environment' IS DISTINCT FROM request.environment THEN projected:=NULL; END IF;
    END IF;
  END LOOP;
  progress:=projected - ARRAY['ownerActorId','environment']::TEXT[];
  actor_user_id:=actor.resolved_user_id; actor_assertion_id:=actor.assertion_id;
  actor_request_sha256:=request.actor_request_sha256; target_authority_id:=request.target_authority_id;
  reader_release_sha256:=request.release_manifest_sha256;
  RETURN NEXT;
END;
$$;
REVOKE ALL ON FUNCTION public.hxos_build_fake_financial_progress_actor_request_v13(TEXT,JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION hx_authority.read_fake_financial_public_progress_v13(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.hxos_read_authenticated_fake_financial_progress_v13(TEXT,JSONB) FROM PUBLIC;


-- Backend-only historical predecessor facts under fresh customer authentication.
-- Reading a fact cannot prepare, dispatch or authorize its successor.
CREATE OR REPLACE FUNCTION public.hxos_build_fake_financial_predecessor_actor_request_v13(
  expected_command_kind TEXT, command_payload JSONB
)
RETURNS TABLE(target_authority_id UUID,environment TEXT,release_manifest_sha256 TEXT,
  canonical_request JSONB,actor_request_sha256 TEXT)
LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE SET search_path=pg_catalog AS $$
DECLARE target RECORD;
BEGIN
  PERFORM hx_authority.assert_universal_v1_work_order_bootstrap_seal_v1();
  IF expected_command_kind IS DISTINCT FROM 'READ_FAKE_FINANCIAL_PREDECESSOR'
     OR pg_catalog.jsonb_typeof(command_payload) IS DISTINCT FROM 'object'
     OR command_payload - ARRAY['operationKind','operationId','taskDraftId','idempotencyKey']::TEXT[] <> '{}'::JSONB
     OR pg_catalog.jsonb_typeof(command_payload->'operationKind') IS DISTINCT FROM 'string'
     OR command_payload->>'operationKind' NOT IN ('PREPARE_PAYMENT_METHOD','AUTHORIZE','SECURE')
     OR pg_catalog.jsonb_typeof(command_payload->'operationId') IS DISTINCT FROM 'string'
     OR command_payload->>'operationId' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
     OR pg_catalog.jsonb_typeof(command_payload->'taskDraftId') IS DISTINCT FROM 'string'
     OR command_payload->>'taskDraftId' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
     OR pg_catalog.jsonb_typeof(command_payload->'idempotencyKey') IS DISTINCT FROM 'string'
     OR command_payload->>'idempotencyKey' !~ '^[A-Za-z0-9:_-]{16,128}$' THEN
    RAISE EXCEPTION 'HXUV1-FINPREDECESSOR-13-PAYLOAD_INVALID'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('hxuv1-work-order-target-authority-v1',0));
  SELECT * INTO STRICT target FROM hx_authority.read_universal_v1_work_order_target_authority_v1();
  canonical_request:=pg_catalog.jsonb_build_object('schema_version',1,'command_kind',expected_command_kind,
    'release_manifest_sha256',target.release_manifest_sha256,
    'target_authority',pg_catalog.jsonb_build_object('id',target.target_authority_id,'version',target.authority_version,
      'database',target.target_database_name,'environment',target.environment,'release',target.release_manifest_sha256),
    'authentication_requirements',pg_catalog.jsonb_build_object('mfa_required',FALSE,'step_up_required',FALSE,
      'max_auth_age_seconds',300,'max_step_up_age_seconds',NULL),'command_payload',command_payload);
  target_authority_id:=target.target_authority_id; environment:=target.environment;
  release_manifest_sha256:=target.release_manifest_sha256;
  actor_request_sha256:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(canonical_request::TEXT,'UTF8')),'hex');
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION hx_authority.read_fake_financial_predecessor_v13(command_payload JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE SET search_path=pg_catalog AS $$
DECLARE
  command_record public.financial_provider_command_journal%ROWTYPE;
  request_record hx_authority.fake_financial_command_outbox_requests_v13%ROWTYPE;
  event public.task_financial_security_events%ROWTYPE;
  projected JSONB; predecessor JSONB:=NULL;
BEGIN
  SELECT * INTO command_record FROM public.financial_provider_command_journal
    WHERE operation_id=(command_payload->>'operationId')::UUID
      AND operation_kind=command_payload->>'operationKind'
      AND task_draft_id=(command_payload->>'taskDraftId')::UUID
      AND idempotency_key=command_payload->>'idempotencyKey'
      AND provider_kind='FAKE' AND command_state='REQUESTED' AND provider_expected_version=0;
  IF command_record.command_id IS NULL THEN RETURN NULL; END IF;
  projected:=hx_authority.read_fake_financial_public_progress_v13(command_record.command_id);
  IF projected IS NULL THEN RETURN NULL; END IF;
  IF projected->>'progressState'='MATERIALIZED' AND projected->'financialEvent'->>'status'='SUCCEEDED' THEN
    -- The progress projection already validates the exact committed admission,
    -- outcome, prepared command, event, bridge and signed resolution envelope.
    -- These immutable rows can be read historically after later events exist.
    SELECT * INTO STRICT event FROM public.task_financial_security_events
      WHERE id=(projected->'financialEvent'->>'id')::UUID;
    SELECT * INTO STRICT request_record FROM hx_authority.fake_financial_command_outbox_requests_v13
      WHERE command_id=command_record.command_id;
    predecessor:=pg_catalog.jsonb_build_object(
      'commandId',command_record.command_id,'idempotencyKey',command_record.idempotency_key,
      'preparedCommandId',request_record.prepared_command_id,
      'operationId',command_record.operation_id,'operationKind',command_record.operation_kind,
      'financialEventId',event.id,'eventKind',event.event_kind,
      'lifecycleExpectedVersion',event.expected_version,
      'taskDraftId',event.task_draft_id,'taskId',event.task_id,
      'scopeVersionId',event.scope_version_id,'eligibilityDecisionId',event.eligibility_decision_id,
      'predecessorEventId',event.predecessor_event_id,'amountCents',event.amount_cents,'currency',event.currency,
      'externalReference',CASE WHEN command_record.operation_kind='PREPARE_PAYMENT_METHOD' THEN event.external_reference ELSE NULL END,
      'occurredAt',event.occurred_at,'expiresAt',event.expires_at,
      'sourceTargetAuthorityId',request_record.target_authority_id,'sourceReleaseSha256',request_record.release_manifest_digest);
  END IF;
  RETURN pg_catalog.jsonb_build_object('idempotencyKey',command_record.idempotency_key,
    'progress',projected,'predecessor',predecessor);
END;
$$;

CREATE OR REPLACE FUNCTION public.hxos_read_authenticated_fake_financial_predecessor_v13(
  actor_assertion_token TEXT, command_payload JSONB
)
RETURNS TABLE(financial_facts JSONB,actor_user_id UUID,actor_assertion_id UUID,actor_request_sha256 TEXT,
  target_authority_id UUID,reader_release_sha256 TEXT)
LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE SET search_path=pg_catalog AS $$
DECLARE request RECORD; actor RECORD; projected JSONB; draft public.task_drafts%ROWTYPE;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'HXUV1-FINPREDECESSOR-13-READ_COMMITTED_REQUIRED'; END IF;
  SELECT * INTO STRICT request FROM public.hxos_build_fake_financial_predecessor_actor_request_v13(
    'READ_FAKE_FINANCIAL_PREDECESSOR',command_payload);
  SELECT * INTO STRICT actor FROM hx_authority.consume_universal_v1_actor_assertion_v1(
    actor_assertion_token,'READ_FAKE_FINANCIAL_PREDECESSOR',request.canonical_request,request.environment);
  -- Resolve exact customer ownership before entering finance or locking another
  -- customer's draft/command. Wrong-owner and absent identities have one shape.
  SELECT candidate.* INTO draft FROM public.task_drafts candidate
    JOIN public.financial_provider_command_journal command ON command.task_draft_id=candidate.id
    WHERE command.operation_id=(command_payload->>'operationId')::UUID
      AND command.operation_kind=command_payload->>'operationKind'
      AND command.task_draft_id=(command_payload->>'taskDraftId')::UUID
      AND command.idempotency_key=command_payload->>'idempotencyKey'
      AND command.command_state='REQUESTED' AND command.provider_expected_version=0
      AND command.recorded_actor_id=actor.resolved_user_id AND command.provider_kind='FAKE'
      AND candidate.poster_user_id=actor.resolved_user_id AND candidate.claimed_at IS NOT NULL
      AND candidate.ingress_origin='BACKEND_POSTGRESQL' AND candidate.universal_contract_version=1
    FOR SHARE OF candidate NOWAIT;
  IF draft.id IS NOT NULL THEN
    IF draft.task_id IS NOT NULL THEN
      PERFORM task.id FROM public.tasks task WHERE task.id=draft.task_id
        AND task.poster_id=actor.resolved_user_id AND task.universal_contract_version=1
        AND task.automation_classification='CONTROLLED_TEST' AND task.worker_id IS NULL
        AND task.universal_payment_posture='PAYMENT_CREATION_FROZEN' FOR SHARE NOWAIT;
      IF NOT FOUND THEN draft.id:=NULL; END IF;
    END IF;
    IF draft.id IS NOT NULL THEN
      projected:=hx_authority.read_fake_financial_predecessor_v13(command_payload);
      IF projected->'progress'->>'environment' IS DISTINCT FROM request.environment THEN projected:=NULL; END IF;
    END IF;
  END IF;
  financial_facts:=CASE WHEN projected IS NULL THEN NULL ELSE
    pg_catalog.jsonb_set(projected,'{progress}',(projected->'progress') - ARRAY['ownerActorId','environment']::TEXT[]) END;
  actor_user_id:=actor.resolved_user_id; actor_assertion_id:=actor.assertion_id;
  actor_request_sha256:=request.actor_request_sha256; target_authority_id:=request.target_authority_id;
  reader_release_sha256:=request.release_manifest_sha256;
  RETURN NEXT;
END;
$$;
REVOKE ALL ON FUNCTION public.hxos_build_fake_financial_predecessor_actor_request_v13(TEXT,JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION hx_authority.read_fake_financial_predecessor_v13(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.hxos_read_authenticated_fake_financial_predecessor_v13(TEXT,JSONB) FROM PUBLIC;

-- Fresh customer reads recover the original Work Order command without
-- changing its timestamp-bound canonical identity or renewing any authority.
CREATE OR REPLACE FUNCTION public.hxos_build_work_order_history_actor_request_v13(
  expected_command_kind TEXT, command_payload JSONB
)
RETURNS TABLE(target_authority_id UUID,environment TEXT,release_manifest_sha256 TEXT,
  canonical_request JSONB,actor_request_sha256 TEXT)
LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE SET search_path=pg_catalog AS $$
DECLARE target RECORD;
BEGIN
  PERFORM hx_authority.assert_universal_v1_work_order_bootstrap_seal_v1();
  IF expected_command_kind IS DISTINCT FROM 'READ_FAKE_WORK_ORDER_HISTORY'
     OR pg_catalog.jsonb_typeof(command_payload) IS DISTINCT FROM 'object'
     OR command_payload - ARRAY['conditional_hold_id','expected_eligibility_version','idempotency_key']::TEXT[] <> '{}'::JSONB
     OR pg_catalog.jsonb_typeof(command_payload->'conditional_hold_id') IS DISTINCT FROM 'string'
     OR command_payload->>'conditional_hold_id' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
     OR pg_catalog.jsonb_typeof(command_payload->'expected_eligibility_version') IS DISTINCT FROM 'number'
     OR command_payload->>'expected_eligibility_version' !~ '^[1-9][0-9]{0,9}$'
     OR (command_payload->>'expected_eligibility_version')::BIGINT > 2147483647
     OR pg_catalog.jsonb_typeof(command_payload->'idempotency_key') IS DISTINCT FROM 'string'
     OR command_payload->>'idempotency_key' !~ '^[A-Za-z0-9:_-]{16,96}$' THEN
    RAISE EXCEPTION 'HXUV1-WOHISTORY-13-PAYLOAD_INVALID'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('hxuv1-work-order-target-authority-v1',0));
  SELECT * INTO STRICT target FROM hx_authority.read_universal_v1_work_order_target_authority_v1();
  canonical_request:=pg_catalog.jsonb_build_object('schema_version',1,'command_kind',expected_command_kind,
    'release_manifest_sha256',target.release_manifest_sha256,
    'target_authority',pg_catalog.jsonb_build_object('id',target.target_authority_id,'version',target.authority_version,
      'database',target.target_database_name,'environment',target.environment,'release',target.release_manifest_sha256),
    'authentication_requirements',pg_catalog.jsonb_build_object('mfa_required',FALSE,'step_up_required',FALSE,
      'max_auth_age_seconds',300,'max_step_up_age_seconds',NULL),'command_payload',command_payload);
  target_authority_id:=target.target_authority_id; environment:=target.environment;
  release_manifest_sha256:=target.release_manifest_sha256;
  actor_request_sha256:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(canonical_request::TEXT,'UTF8')),'hex');
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.hxos_read_authenticated_work_order_history_v13(
  actor_assertion_token TEXT, command_payload JSONB
)
RETURNS TABLE(history JSONB,actor_user_id UUID,actor_assertion_id UUID,actor_request_sha256 TEXT,
  target_authority_id UUID,reader_release_sha256 TEXT)
LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE SET search_path=pg_catalog AS $$
DECLARE
  request RECORD; actor RECORD; preparation RECORD; saved_context RECORD;
  witness public.task_work_order_command_requests%ROWTYPE;
  work_order public.task_work_orders%ROWTYPE;
  claim public.universal_v1_work_order_compensation_commands%ROWTYPE;
  journal public.financial_provider_command_journal%ROWTYPE;
  prepared public.universal_v1_prepared_financial_commands%ROWTYPE;
  linked_work_order_id UUID; witness_sha TEXT; phase JSONB; provenance JSONB; public_progress JSONB;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'HXUV1-WOHISTORY-13-READ_COMMITTED_REQUIRED'; END IF;
  SELECT * INTO STRICT request FROM public.hxos_build_work_order_history_actor_request_v13(
    'READ_FAKE_WORK_ORDER_HISTORY',command_payload);
  SELECT * INTO STRICT actor FROM hx_authority.consume_universal_v1_actor_assertion_v1(
    actor_assertion_token,'READ_FAKE_WORK_ORDER_HISTORY',request.canonical_request,request.environment);
  actor_user_id:=actor.resolved_user_id; actor_assertion_id:=actor.assertion_id;
  actor_request_sha256:=request.actor_request_sha256; target_authority_id:=request.target_authority_id;
  reader_release_sha256:=request.release_manifest_sha256;

  -- No financial lookup or another customer's row lock before ownership.
  SELECT original.* INTO witness FROM public.task_work_order_command_requests original
    JOIN public.tasks task ON task.id=original.task_id
    JOIN public.task_drafts draft ON draft.id=original.task_draft_id AND draft.task_id=task.id
    WHERE original.idempotency_key=command_payload->>'idempotency_key'
      AND original.actor_user_id=actor.resolved_user_id AND task.poster_id=actor.resolved_user_id
      AND draft.poster_user_id=actor.resolved_user_id AND draft.claimed_at IS NOT NULL
      AND draft.ingress_origin='BACKEND_POSTGRESQL' AND draft.universal_contract_version=1
      AND task.universal_contract_version=1 AND task.automation_classification='CONTROLLED_TEST'
      AND task.universal_payment_posture='PAYMENT_CREATION_FROZEN' AND task.worker_id IS NULL
    FOR SHARE OF original,task,draft NOWAIT;
  IF witness.idempotency_key IS NULL THEN history:=NULL; RETURN NEXT; RETURN; END IF;
  IF witness.conditional_hold_id IS DISTINCT FROM (command_payload->>'conditional_hold_id')::UUID
     OR witness.eligibility_version IS DISTINCT FROM (command_payload->>'expected_eligibility_version')::INTEGER THEN
    RAISE EXCEPTION 'HXUV1-WOHISTORY-13-IDENTITY_CONFLICT'; END IF;
  IF witness.canonical_command_request_sha256 IS NULL
     OR pg_catalog.btrim(witness.canonical_command_request_sha256)!~'^[a-f0-9]{64}$'
     OR pg_catalog.btrim(witness.canonical_command_request_sha256)=pg_catalog.repeat('0',64) THEN
    RAISE EXCEPTION 'HXUV1-WOHISTORY-13-PROVENANCE_UNAVAILABLE'; END IF;
  witness_sha:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
    'actor',witness.actor_user_id,'hold',witness.conditional_hold_id,'task',witness.task_id,
    'draft',witness.task_draft_id,'estimate',witness.provider_estimate_submission_id,
    'route',witness.routing_decision_id,'scope',witness.scope_version_id,'provider',witness.provider_user_id,
    'organization',witness.provider_organization_id,'eligibility',witness.eligibility_decision_id,
    'eligibility_version',witness.eligibility_version,'amount',witness.amount_cents,'currency',witness.currency
  )::TEXT,'UTF8')),'hex');
  IF witness_sha IS DISTINCT FROM pg_catalog.btrim(witness.request_sha256) THEN
    RAISE EXCEPTION 'HXUV1-WOHISTORY-13-WITNESS_INVALID'; END IF;

  -- The original RECORDED execution is the immutable creation proof. Later
  -- PREPARE replays may use a completed-result shape and are not its replacement.
  SELECT execution.*,source.release_manifest_sha256 AS source_release INTO STRICT preparation
    FROM hx_authority.universal_v1_work_order_command_execution_facts execution
    JOIN hx_authority.universal_v1_work_order_target_authority_facts source
      ON source.target_authority_id=execution.target_authority_id
    WHERE execution.command_kind='PREPARE_FAKE_WORK_ORDER' AND execution.result_kind='RECORDED'
      AND execution.idempotency_key=witness.idempotency_key AND execution.domain_object_id=witness.conditional_hold_id
      AND execution.expected_version=witness.eligibility_version AND execution.actor_user_id=witness.actor_user_id
      AND execution.canonical_request_sha256=witness.canonical_command_request_sha256
      AND execution.actor_assertion_id IS NOT NULL AND execution.service_identity IS NULL
      AND execution.hard_assignment_created IS FALSE AND execution.payment_creation_performed IS FALSE
      AND execution.result_identifiers=pg_catalog.jsonb_build_object('task_id',witness.task_id,
        'request_sha256',witness_sha,'witness_preexisted',FALSE)
      AND source.target_database_name=pg_catalog.current_database() AND source.environment=request.environment;

  SELECT witness.task_id AS task_id,witness.task_draft_id AS task_draft_id,witness.scope_version_id AS scope_version_id,
      scope.version AS scope_version,witness.routing_decision_id AS routing_decision_id,
      witness.provider_user_id AS provider_user_id,witness.provider_organization_id AS provider_organization_id,
      eligibility.provider_class,eligibility.trade_credential_id,eligibility.id AS predecessor_eligibility_id,
      eligibility.decision_version AS predecessor_eligibility_version,eligibility.valid_until AS predecessor_valid_until,
      witness.actor_user_id AS poster_user_id,eligibility.interest_application_id,
      witness.eligibility_decision_id AS eligibility_decision_id,witness.eligibility_version AS eligibility_version,
      eligibility.valid_until AS eligibility_valid_until,witness.conditional_hold_id AS conditional_hold_id,
      reservation.reserved_at AS hold_reserved_at,reservation.expires_at AS hold_expires_at,
      witness.provider_estimate_submission_id AS provider_estimate_submission_id,
      witness.amount_cents AS customer_total_cents,witness.currency::TEXT AS currency
    INTO STRICT saved_context FROM public.task_scope_versions scope
    JOIN public.task_provider_eligibility_decisions eligibility ON eligibility.id=witness.eligibility_decision_id
    JOIN public.task_reservations reservation ON reservation.id=witness.conditional_hold_id
    WHERE scope.id=witness.scope_version_id AND scope.customer_total_cents=witness.amount_cents AND scope.currency=witness.currency
      AND eligibility.task_id=witness.task_id AND eligibility.task_draft_id=witness.task_draft_id
      AND eligibility.scope_version_id=witness.scope_version_id AND eligibility.routing_decision_id=witness.routing_decision_id
      AND eligibility.decision_version=witness.eligibility_version AND eligibility.provider_user_id=witness.provider_user_id
      AND eligibility.provider_organization_id IS NOT DISTINCT FROM witness.provider_organization_id
      AND reservation.task_id=witness.task_id AND reservation.reserved_by=witness.actor_user_id
      AND reservation.eligibility_decision_id=witness.eligibility_decision_id
      AND reservation.interest_application_id=eligibility.interest_application_id
      AND reservation.universal_contract_version=1 AND reservation.hold_kind='CONDITIONAL_HOLD';
  phase:=pg_catalog.jsonb_build_object('completed',FALSE,'context',pg_catalog.to_jsonb(saved_context),
    'idempotencyKey',witness.idempotency_key,'requestSha256',witness_sha,'occurredAt',saved_context.hold_reserved_at);
  provenance:=pg_catalog.jsonb_build_object('targetAuthorityId',preparation.target_authority_id,
    'releaseSha256',preparation.source_release,'canonicalRequestSha256',pg_catalog.btrim(preparation.canonical_request_sha256),
    'preparationExecutionId',preparation.command_execution_fact_id);

  SELECT * INTO work_order FROM public.task_work_orders WHERE task_id=witness.task_id;
  SELECT * INTO claim FROM public.universal_v1_work_order_compensation_commands WHERE task_id=witness.task_id;
  SELECT task.work_order_id INTO linked_work_order_id FROM public.tasks task WHERE task.id=witness.task_id;
  IF work_order.id IS NOT NULL AND claim.compensation_command_id IS NOT NULL THEN
    RAISE EXCEPTION 'HXUV1-WOHISTORY-13-CONFLICTING_TERMINAL_HISTORY'; END IF;

  IF work_order.id IS NOT NULL THEN
    IF work_order.id IS DISTINCT FROM linked_work_order_id
       OR work_order.idempotency_key IS DISTINCT FROM witness.idempotency_key
       OR work_order.task_draft_id IS DISTINCT FROM witness.task_draft_id
       OR work_order.scope_version_id IS DISTINCT FROM witness.scope_version_id
       OR work_order.routing_decision_id IS DISTINCT FROM witness.routing_decision_id
       OR work_order.provider_estimate_submission_id IS DISTINCT FROM witness.provider_estimate_submission_id
       OR work_order.interest_application_id IS DISTINCT FROM saved_context.interest_application_id
       OR work_order.eligibility_decision_id IS DISTINCT FROM witness.eligibility_decision_id
       OR work_order.conditional_hold_id IS DISTINCT FROM witness.conditional_hold_id
       OR work_order.provider_user_id IS DISTINCT FROM witness.provider_user_id
       OR work_order.provider_organization_id IS DISTINCT FROM witness.provider_organization_id
       OR work_order.materialized_by IS DISTINCT FROM witness.actor_user_id THEN
      RAISE EXCEPTION 'HXUV1-WOHISTORY-13-WORK_ORDER_IDENTITY_INVALID'; END IF;
    PERFORM 1 FROM hx_authority.universal_v1_work_order_command_execution_facts execution
      WHERE execution.command_kind='MATERIALIZE_FAKE_WORK_ORDER' AND execution.result_kind='COMPLETED'
        AND execution.idempotency_key=witness.idempotency_key AND execution.domain_object_id=witness.task_id
        AND execution.expected_version=witness.eligibility_version AND execution.actor_user_id=witness.actor_user_id
        AND execution.actor_assertion_id IS NOT NULL AND execution.service_identity IS NULL
        AND execution.hard_assignment_created IS FALSE AND execution.payment_creation_performed IS FALSE
        AND execution.result_identifiers=pg_catalog.jsonb_build_object('work_order_id',work_order.id,
          'financial_security_event_id',work_order.financial_security_event_id);
    IF NOT FOUND THEN RAISE EXCEPTION 'HXUV1-WOHISTORY-13-COMPLETION_PROVENANCE_UNAVAILABLE'; END IF;
    history:=pg_catalog.jsonb_build_object('state','COMPLETED','observedAt',pg_catalog.clock_timestamp(),'phase',phase,'source',provenance,
      'result',pg_catalog.jsonb_build_object('work_order_id',work_order.id,
        'financial_security_event_id',work_order.financial_security_event_id,'replayed',TRUE,
        'hard_assignment_created',FALSE,'payment_creation_performed',FALSE));
    RETURN NEXT; RETURN;
  END IF;
  IF linked_work_order_id IS NOT NULL THEN RAISE EXCEPTION 'HXUV1-WOHISTORY-13-WORK_ORDER_IDENTITY_INVALID'; END IF;

  IF claim.compensation_command_id IS NOT NULL THEN
    IF claim.work_order_idempotency_key IS DISTINCT FROM witness.idempotency_key
       OR claim.task_draft_id IS DISTINCT FROM witness.task_draft_id OR claim.scope_version_id IS DISTINCT FROM witness.scope_version_id
       OR claim.eligibility_decision_id IS DISTINCT FROM witness.eligibility_decision_id
       OR claim.requested_by IS DISTINCT FROM witness.actor_user_id
       OR claim.amount_cents IS DISTINCT FROM witness.amount_cents OR claim.currency IS DISTINCT FROM witness.currency
       OR claim.secured_operation_id IS DISTINCT FROM public.universal_v1_work_order_operation_id_v1(witness.idempotency_key,'secure')
       OR claim.void_operation_id IS DISTINCT FROM public.universal_v1_work_order_operation_id_v1(witness.idempotency_key,'void')
       OR claim.void_idempotency_key IS DISTINCT FROM witness.idempotency_key||':void' THEN
      RAISE EXCEPTION 'HXUV1-WOHISTORY-13-COMPENSATION_IDENTITY_INVALID'; END IF;
    PERFORM 1 FROM public.task_financial_security_events event
      WHERE event.id=claim.secured_event_id AND event.operation_id=claim.secured_operation_id::TEXT
        AND event.idempotency_key=witness.idempotency_key||':secure'
        AND event.provider_kind='FAKE' AND event.event_kind='SECURED' AND event.status='SUCCEEDED'
        AND event.expected_version=2 AND event.task_draft_id=witness.task_draft_id AND event.task_id=witness.task_id
        AND event.scope_version_id=witness.scope_version_id AND event.eligibility_decision_id=witness.eligibility_decision_id
        AND event.amount_cents=witness.amount_cents AND event.currency=witness.currency;
    IF NOT FOUND THEN RAISE EXCEPTION 'HXUV1-WOHISTORY-13-COMPENSATION_EVENT_INVALID'; END IF;
    SELECT * INTO journal FROM public.financial_provider_command_journal
      WHERE operation_id=claim.void_operation_id AND operation_kind='VOID' AND provider_kind='FAKE'
        AND command_state='REQUESTED' AND provider_expected_version=0 AND idempotency_key=claim.void_idempotency_key;
    IF journal.command_id IS NOT NULL THEN
      SELECT * INTO STRICT prepared FROM public.universal_v1_prepared_financial_commands
        WHERE prepared_command_id=journal.prepared_financial_command_id;
      IF journal.recorded_actor_id IS DISTINCT FROM claim.requested_by
         OR journal.task_draft_id IS DISTINCT FROM claim.task_draft_id OR journal.task_id IS DISTINCT FROM claim.task_id
         OR journal.work_order_id IS NOT NULL OR journal.related_operation_id IS DISTINCT FROM claim.secured_operation_id
         OR journal.amount_cents IS DISTINCT FROM claim.amount_cents OR journal.currency IS DISTINCT FROM claim.currency
         OR prepared.operation_kind IS DISTINCT FROM 'VOID' OR prepared.operation_id IS DISTINCT FROM claim.void_operation_id
         OR prepared.idempotency_key IS DISTINCT FROM claim.void_idempotency_key
         OR prepared.task_draft_id IS DISTINCT FROM claim.task_draft_id OR prepared.task_id IS DISTINCT FROM claim.task_id
         OR prepared.scope_version_id IS DISTINCT FROM claim.scope_version_id
         OR prepared.eligibility_decision_id IS DISTINCT FROM claim.eligibility_decision_id
         OR prepared.predecessor_event_id IS DISTINCT FROM claim.secured_event_id
         OR prepared.lifecycle_expected_version IS DISTINCT FROM 3 OR prepared.work_order_id IS NOT NULL THEN
        RAISE EXCEPTION 'HXUV1-WOHISTORY-13-VOID_IDENTITY_INVALID'; END IF;
      public_progress:=hx_authority.read_fake_financial_public_progress_v13(journal.command_id);
      IF public_progress IS NULL OR public_progress->>'ownerActorId' IS DISTINCT FROM actor.resolved_user_id::TEXT
         OR public_progress->>'environment' IS DISTINCT FROM request.environment THEN
        RAISE EXCEPTION 'HXUV1-WOHISTORY-13-VOID_PROGRESS_INVALID'; END IF;
      public_progress:=public_progress-ARRAY['ownerActorId','environment']::TEXT[];
    END IF;
    history:=pg_catalog.jsonb_build_object('state','COMPENSATION_CLAIM','observedAt',pg_catalog.clock_timestamp(),'phase',phase,'source',provenance,
      'compensation',pg_catalog.to_jsonb(claim),'voidProgress',public_progress);
    RETURN NEXT; RETURN;
  END IF;
  history:=pg_catalog.jsonb_build_object('state','PREPARED','observedAt',pg_catalog.clock_timestamp(),'phase',phase,'source',provenance);
  RETURN NEXT;
END;
$$;
REVOKE ALL ON FUNCTION public.hxos_build_work_order_history_actor_request_v13(TEXT,JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.hxos_read_authenticated_work_order_history_v13(TEXT,JSONB) FROM PUBLIC;

-- Fresh read authority over the original immutable ChangeOrder Phase A.
CREATE OR REPLACE FUNCTION public.hxos_build_change_order_history_actor_request_v13(
  expected_command_kind TEXT, command_payload JSONB
)
RETURNS TABLE(target_authority_id UUID,environment TEXT,release_manifest_sha256 TEXT,
  canonical_request JSONB,actor_request_sha256 TEXT)
LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE SET search_path=pg_catalog AS $$
DECLARE target RECORD; field_name TEXT;
BEGIN
  PERFORM hx_authority.assert_universal_v1_work_order_bootstrap_seal_v1();
  IF expected_command_kind IS DISTINCT FROM 'READ_FAKE_CHANGE_ORDER_HISTORY'
     OR pg_catalog.jsonb_typeof(command_payload) IS DISTINCT FROM 'object'
     OR command_payload - ARRAY['proposal_id','expected_proposal_version','expected_scope_version',
       'expected_amendment_version','expected_execution_version','expected_financial_version','idempotency_key']::TEXT[] <> '{}'::JSONB
     OR pg_catalog.jsonb_typeof(command_payload->'proposal_id') IS DISTINCT FROM 'string'
     OR command_payload->>'proposal_id' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
     OR pg_catalog.jsonb_typeof(command_payload->'idempotency_key') IS DISTINCT FROM 'string'
     OR command_payload->>'idempotency_key' !~ '^[A-Za-z0-9:_-]{16,96}$' THEN
    RAISE EXCEPTION 'HXUV1-COHISTORY-13-PAYLOAD_INVALID'; END IF;
  FOREACH field_name IN ARRAY ARRAY['expected_proposal_version','expected_scope_version',
    'expected_amendment_version','expected_execution_version','expected_financial_version'] LOOP
    IF pg_catalog.jsonb_typeof(command_payload->field_name) IS DISTINCT FROM 'number'
       OR command_payload->>field_name !~ '^(0|[1-9][0-9]{0,9})$'
       OR (command_payload->>field_name)::BIGINT > 2147483647
       OR (field_name IN ('expected_proposal_version','expected_scope_version','expected_execution_version')
         AND (command_payload->>field_name)::BIGINT=0) THEN
      RAISE EXCEPTION 'HXUV1-COHISTORY-13-PAYLOAD_INVALID'; END IF;
  END LOOP;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('hxuv1-work-order-target-authority-v1',0));
  SELECT * INTO STRICT target FROM hx_authority.read_universal_v1_work_order_target_authority_v1();
  canonical_request:=pg_catalog.jsonb_build_object('schema_version',1,'command_kind',expected_command_kind,
    'release_manifest_sha256',target.release_manifest_sha256,
    'target_authority',pg_catalog.jsonb_build_object('id',target.target_authority_id,'version',target.authority_version,
      'database',target.target_database_name,'environment',target.environment,'release',target.release_manifest_sha256),
    'authentication_requirements',pg_catalog.jsonb_build_object('mfa_required',FALSE,'step_up_required',FALSE,
      'max_auth_age_seconds',300,'max_step_up_age_seconds',NULL),'command_payload',command_payload);
  target_authority_id:=target.target_authority_id; environment:=target.environment;
  release_manifest_sha256:=target.release_manifest_sha256;
  actor_request_sha256:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(canonical_request::TEXT,'UTF8')),'hex');
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.hxos_read_authenticated_change_order_history_v13(
  actor_assertion_token TEXT, command_payload JSONB
)
RETURNS TABLE(history JSONB,actor_user_id UUID,actor_assertion_id UUID,actor_request_sha256 TEXT,
  target_authority_id UUID,reader_release_sha256 TEXT)
LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE SET search_path=pg_catalog AS $$
DECLARE
  request RECORD; actor RECORD; replacement RECORD; amendment RECORD; terminal RECORD; compensation RECORD;
  witness public.universal_v1_change_order_materialization_commands%ROWTYPE;
  financial public.task_financial_security_events%ROWTYPE;
  journal public.financial_provider_command_journal%ROWTYPE;
  prepared public.universal_v1_prepared_financial_commands%ROWTYPE;
  witness_sha TEXT; phase JSONB; identity_payload JSONB; adjustment_progress JSONB; reversal_progress JSONB;
  immutable_context JSONB; historical_compensation JSONB;
  adjustment_request_state TEXT:='NOT_REQUESTED'; reversal_request_state TEXT:='NOT_REQUESTED';
BEGIN
  IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'HXUV1-COHISTORY-13-READ_COMMITTED_REQUIRED'; END IF;
  SELECT * INTO STRICT request FROM public.hxos_build_change_order_history_actor_request_v13(
    'READ_FAKE_CHANGE_ORDER_HISTORY',command_payload);
  SELECT * INTO STRICT actor FROM hx_authority.consume_universal_v1_actor_assertion_v1(
    actor_assertion_token,'READ_FAKE_CHANGE_ORDER_HISTORY',request.canonical_request,request.environment);
  actor_user_id:=actor.resolved_user_id; actor_assertion_id:=actor.assertion_id;
  actor_request_sha256:=request.actor_request_sha256; target_authority_id:=request.target_authority_id;
  reader_release_sha256:=request.release_manifest_sha256;

  -- Current customer read authority, not fresh positive provider authority.
  -- No financial lookup or foreign domain lock before this ownership check.
  SELECT original.* INTO witness FROM public.universal_v1_change_order_materialization_commands original
    JOIN public.tasks task ON task.id=original.task_id
    JOIN public.task_drafts draft ON draft.id=original.task_draft_id AND draft.task_id=task.id
    JOIN public.task_work_orders work_order ON work_order.id=original.work_order_id
      AND work_order.task_id=task.id AND work_order.task_draft_id=draft.id
    LEFT JOIN public.business_organizations customer_organization ON customer_organization.id=task.business_organization_id
    WHERE original.idempotency_key=command_payload->>'idempotency_key'
      AND original.proposal_id=(command_payload->>'proposal_id')::UUID
      AND original.actor_user_id=actor.resolved_user_id
      AND draft.poster_user_id=task.poster_id AND draft.claimed_at IS NOT NULL
      AND draft.ingress_origin='BACKEND_POSTGRESQL' AND draft.universal_contract_version=1
      AND task.work_order_id=work_order.id AND task.universal_contract_version=1
      AND task.automation_classification='CONTROLLED_TEST'
      AND task.universal_payment_posture='PAYMENT_CREATION_FROZEN' AND task.worker_id IS NULL
      AND ((task.business_organization_id IS NULL AND task.poster_id=actor.resolved_user_id)
        OR (task.business_organization_id IS NOT NULL AND customer_organization.status='ACTIVE'
          AND customer_organization.client_enabled IS TRUE
          AND public.business_membership_has_action(task.business_organization_id,actor.resolved_user_id,'APPROVE_SPEND')));
  IF witness.proposal_id IS NULL THEN history:=NULL; RETURN NEXT; RETURN; END IF;
  IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(
      'universal-v1-change-order-proposal:'||witness.proposal_id::TEXT,0))
     OR NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('fulfillment:'||witness.work_order_id::TEXT,0)) THEN
    RAISE EXCEPTION 'HXUV1-COHISTORY-13-LOCK_BUSY'; END IF;
  -- Hold only the identified customer's read authority across any financial
  -- lock wait; provider restriction must not erase historical recovery facts.
  PERFORM 1 FROM public.users WHERE id=actor.resolved_user_id FOR SHARE NOWAIT;
  PERFORM 1 FROM public.tasks WHERE id=witness.task_id FOR SHARE NOWAIT;
  PERFORM 1 FROM public.task_drafts WHERE id=witness.task_draft_id FOR SHARE NOWAIT;
  PERFORM 1 FROM public.business_organizations WHERE id IN (
    SELECT task.business_organization_id FROM public.tasks task WHERE task.id=witness.task_id
  ) ORDER BY id FOR SHARE NOWAIT;
  PERFORM 1 FROM public.business_memberships WHERE user_id=actor.resolved_user_id AND organization_id IN (
    SELECT task.business_organization_id FROM public.tasks task WHERE task.id=witness.task_id
  ) ORDER BY organization_id,user_id,id FOR SHARE NOWAIT;
  PERFORM 1 FROM public.tasks task
    JOIN public.task_drafts draft ON draft.id=witness.task_draft_id AND draft.task_id=task.id
    JOIN public.users current_actor ON current_actor.id=actor.resolved_user_id
    LEFT JOIN public.business_organizations organization ON organization.id=task.business_organization_id
    WHERE task.id=witness.task_id AND task.work_order_id=witness.work_order_id
      AND task.worker_id IS NULL AND task.universal_contract_version=1
      AND task.automation_classification='CONTROLLED_TEST' AND task.universal_payment_posture='PAYMENT_CREATION_FROZEN'
      AND draft.poster_user_id=task.poster_id AND draft.claimed_at IS NOT NULL
      AND draft.ingress_origin='BACKEND_POSTGRESQL' AND draft.universal_contract_version=1
      AND current_actor.account_status='ACTIVE' AND current_actor.is_minor IS FALSE
      AND COALESCE(current_actor.is_banned,FALSE) IS FALSE
      AND ((task.business_organization_id IS NULL AND task.poster_id=actor.resolved_user_id)
        OR (task.business_organization_id IS NOT NULL AND organization.status='ACTIVE' AND organization.client_enabled IS TRUE
          AND public.business_membership_has_action(task.business_organization_id,actor.resolved_user_id,'APPROVE_SPEND')));
  IF NOT FOUND THEN RAISE EXCEPTION 'HXUV1-COHISTORY-13-READ_AUTHORITY_REVOKED'; END IF;
  identity_payload:=pg_catalog.jsonb_build_object('proposal_id',witness.proposal_id,
    'expected_proposal_version',witness.expected_proposal_version,'expected_scope_version',witness.expected_scope_version,
    'expected_amendment_version',witness.expected_amendment_version,'expected_execution_version',witness.expected_execution_version,
    'expected_financial_version',witness.expected_financial_version,'idempotency_key',witness.idempotency_key);
  IF identity_payload IS DISTINCT FROM command_payload THEN
    RAISE EXCEPTION 'HXUV1-COHISTORY-13-IDENTITY_CONFLICT'; END IF;
  -- Reproduce the v6 witness digest exactly; the original database timestamp is
  -- outside this hash and must be read, never reconstructed from a retry.
  witness_sha:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
    'contract','HUSTLEXP_UNIVERSAL_V1_CHANGE_ORDER_MATERIALIZATION_V1',
    'proposalId',witness.proposal_id,'idempotencyKey',witness.idempotency_key,
    'actorUserId',witness.actor_user_id,'workOrderId',witness.work_order_id,
    'taskId',witness.task_id,'taskDraftId',witness.task_draft_id,
    'eligibilityDecisionId',witness.eligibility_decision_id,'baseScopeVersionId',witness.base_scope_version_id,
    'replacementScopeVersionId',witness.replacement_scope_version_id,
    'expectedProposalVersion',witness.expected_proposal_version,'expectedScopeVersion',witness.expected_scope_version,
    'expectedAmendmentVersion',witness.expected_amendment_version,'expectedExecutionVersion',witness.expected_execution_version,
    'expectedFinancialVersion',witness.expected_financial_version,'predecessorEventId',witness.predecessor_event_id,
    'predecessorOperationId',witness.predecessor_operation_id,'adjustmentOperationId',witness.adjustment_operation_id
  )::TEXT,'UTF8')),'hex');
  IF witness_sha IS DISTINCT FROM pg_catalog.btrim(witness.request_sha256)
     OR witness.adjustment_operation_id IS DISTINCT FROM public.universal_v1_work_order_operation_id_v1(witness.idempotency_key,'adjust') THEN
    RAISE EXCEPTION 'HXUV1-COHISTORY-13-WITNESS_INVALID'; END IF;
  SELECT scope.version,scope.scope_hash,scope.customer_total_cents,scope.hustler_payout_cents,scope.currency
    INTO STRICT replacement FROM public.task_scope_versions scope
    WHERE scope.id=witness.replacement_scope_version_id AND scope.task_id=witness.task_id
      AND scope.supersedes_version_id=witness.base_scope_version_id
      AND scope.version=witness.expected_scope_version+1 AND scope.source='APPROVED_CHANGE'
      AND scope.customer_total_cents=witness.customer_total_cents AND scope.hustler_payout_cents=witness.provider_payout_cents
      AND scope.currency=witness.currency;
  immutable_context:=pg_catalog.jsonb_build_object('proposalId',witness.proposal_id,'workOrderId',witness.work_order_id,
    'taskId',witness.task_id,'taskDraftId',witness.task_draft_id,'eligibilityDecisionId',witness.eligibility_decision_id,
    'scopeVersionId',witness.replacement_scope_version_id,'scopeVersion',replacement.version,
    'customerTotalCents',witness.customer_total_cents,'currency',witness.currency,
    'predecessorEventId',witness.predecessor_event_id,'predecessorOperationId',witness.predecessor_operation_id,
    'expectedFinancialVersion',witness.expected_financial_version,'adjustmentOperationId',witness.adjustment_operation_id,
    'occurredAt',witness.occurred_at);
  phase:=pg_catalog.jsonb_build_object('completed',FALSE,'idempotencyKey',witness.idempotency_key,
    'requestSha256',witness_sha,'context',immutable_context);

  SELECT a.id,a.work_order_id,a.amendment_version,a.change_order_id,a.scope_version_id,a.adjustment_event_id,
    a.expected_financial_version,a.idempotency_key,a.request_sha256,a.materialized_by INTO amendment
    FROM public.task_work_order_amendments a WHERE a.change_order_id=witness.proposal_id;
  SELECT c.compensation_command_id,c.proposal_id,c.witness_request_sha256,c.task_draft_id,c.task_id,c.work_order_id,
    c.eligibility_decision_id,c.base_scope_version_id,c.adjustment_event_id,c.adjustment_operation_id,c.reversal_operation_id,
    c.reversal_idempotency_key,c.lifecycle_expected_version,c.amount_cents,c.currency,c.requested_by,c.created_at,c.semantic_limitation
    INTO compensation FROM public.universal_v1_change_order_compensation_commands c WHERE c.proposal_id=witness.proposal_id;
  SELECT t.terminal_fact_id,t.proposal_id,t.witness_request_sha256,t.outcome_state,t.recovery_state,t.amendment_id,
    t.adjustment_event_id,t.compensation_command_id,t.compensation_event_id,t.resolution_evidence_kind,
    t.prior_secured_state_restored,t.execution_resume_authorized,t.capture_resume_authorized,
    t.payment_creation_performed,t.hard_assignment_created INTO terminal
    FROM public.universal_v1_change_order_recovery_terminal_facts t WHERE t.proposal_id=witness.proposal_id;
  IF (amendment.id IS NOT NULL AND compensation.compensation_command_id IS NOT NULL)
     OR (terminal.terminal_fact_id IS NOT NULL AND terminal.witness_request_sha256 IS DISTINCT FROM witness.request_sha256)
     OR (terminal.outcome_state='CANCELLED' AND amendment.id IS NOT NULL)
     OR (terminal.outcome_state='MATERIALIZED' AND terminal.amendment_id IS DISTINCT FROM amendment.id) THEN
    RAISE EXCEPTION 'HXUV1-COHISTORY-13-CONFLICTING_TERMINAL_HISTORY'; END IF;
  IF amendment.id IS NOT NULL THEN
    SELECT * INTO STRICT financial FROM public.task_financial_security_events WHERE id=amendment.adjustment_event_id;
    IF amendment.work_order_id IS DISTINCT FROM witness.work_order_id
       OR amendment.idempotency_key IS DISTINCT FROM witness.idempotency_key
       OR amendment.materialized_by IS DISTINCT FROM witness.actor_user_id
       OR amendment.amendment_version IS DISTINCT FROM witness.expected_amendment_version+1
       OR amendment.expected_financial_version IS DISTINCT FROM witness.expected_financial_version
       OR amendment.scope_version_id IS DISTINCT FROM witness.replacement_scope_version_id
       OR financial.operation_id IS DISTINCT FROM witness.adjustment_operation_id::TEXT
       OR financial.idempotency_key IS DISTINCT FROM witness.idempotency_key||':adjust'
       OR financial.change_order_id IS DISTINCT FROM witness.proposal_id OR financial.task_id IS DISTINCT FROM witness.task_id
       OR financial.task_draft_id IS DISTINCT FROM witness.task_draft_id OR financial.scope_version_id IS DISTINCT FROM witness.replacement_scope_version_id
       OR financial.predecessor_event_id IS DISTINCT FROM witness.predecessor_event_id
       OR financial.expected_version IS DISTINCT FROM witness.expected_financial_version+1
       OR financial.amount_cents IS DISTINCT FROM witness.customer_total_cents OR financial.currency IS DISTINCT FROM witness.currency
       OR financial.provider_kind IS DISTINCT FROM 'FAKE' OR financial.event_kind IS DISTINCT FROM 'ADJUSTMENT_AUTHORIZED'
       OR financial.status IS DISTINCT FROM 'SUCCEEDED' THEN
      RAISE EXCEPTION 'HXUV1-COHISTORY-13-AMENDMENT_INVALID'; END IF;
    PERFORM 1 FROM public.task_work_order_execution_facts execution
      WHERE execution.work_order_amendment_id=amendment.id AND execution.work_order_id=witness.work_order_id
        AND execution.scope_version_id=witness.replacement_scope_version_id AND execution.transition_kind='APPLY_AMENDMENT'
        AND execution.actor_user_id=witness.actor_user_id AND execution.execution_version=witness.expected_execution_version+1;
    IF NOT FOUND THEN RAISE EXCEPTION 'HXUV1-COHISTORY-13-AMENDMENT_INVALID'; END IF;
    history:=pg_catalog.jsonb_build_object('state','COMPLETED','observedAt',pg_catalog.clock_timestamp(),
      'actorUserId',witness.actor_user_id,'identity',identity_payload,'phase',phase,
      'result',pg_catalog.jsonb_build_object('amendment_id',amendment.id,'amendment_version',amendment.amendment_version,
        'proposal_id',witness.proposal_id,'scope_version_id',witness.replacement_scope_version_id,'scope_version',replacement.version,
        'adjustment_event_id',amendment.adjustment_event_id,'provider_kind','FAKE','replayed',TRUE,
        'payment_creation_performed',FALSE,'hard_assignment_created',FALSE));
    RETURN NEXT; RETURN;
  END IF;
  IF terminal.outcome_state='CANCELLED' THEN
    IF terminal.recovery_state IS DISTINCT FROM 'RECOVERY_REQUIRED' OR terminal.prior_secured_state_restored IS NOT FALSE
       OR terminal.execution_resume_authorized IS NOT FALSE OR terminal.capture_resume_authorized IS NOT FALSE
       OR terminal.payment_creation_performed IS NOT FALSE OR terminal.hard_assignment_created IS NOT FALSE THEN
      RAISE EXCEPTION 'HXUV1-COHISTORY-13-TERMINAL_INVALID'; END IF;
    history:=pg_catalog.jsonb_build_object('state','CANCELLED','observedAt',pg_catalog.clock_timestamp(),
      'actorUserId',witness.actor_user_id,'identity',identity_payload,'phase',phase,
      'terminal',pg_catalog.jsonb_build_object('terminalFactId',terminal.terminal_fact_id,
        'evidenceKind',terminal.resolution_evidence_kind,'priorSecuredStateRestored',FALSE,
        'executionResumeAuthorized',FALSE,'captureResumeAuthorized',FALSE));
    RETURN NEXT; RETURN;
  END IF;
  IF compensation.compensation_command_id IS NOT NULL THEN
    IF compensation.witness_request_sha256 IS DISTINCT FROM witness.request_sha256
       OR compensation.task_draft_id IS DISTINCT FROM witness.task_draft_id OR compensation.task_id IS DISTINCT FROM witness.task_id
       OR compensation.work_order_id IS DISTINCT FROM witness.work_order_id OR compensation.eligibility_decision_id IS DISTINCT FROM witness.eligibility_decision_id
       OR compensation.base_scope_version_id IS DISTINCT FROM witness.base_scope_version_id
       OR compensation.adjustment_operation_id IS DISTINCT FROM witness.adjustment_operation_id
       OR compensation.requested_by IS DISTINCT FROM witness.actor_user_id
       OR compensation.amount_cents IS DISTINCT FROM witness.customer_total_cents OR compensation.currency IS DISTINCT FROM witness.currency
       OR compensation.lifecycle_expected_version IS DISTINCT FROM witness.expected_financial_version+2
       OR compensation.semantic_limitation IS DISTINCT FROM 'PRIOR_SECURED_STATE_NOT_RESTORED' THEN
      RAISE EXCEPTION 'HXUV1-COHISTORY-13-COMPENSATION_INVALID'; END IF;
    historical_compensation:=pg_catalog.jsonb_build_object('compensationCommandId',compensation.compensation_command_id,
      'adjustmentEventId',compensation.adjustment_event_id,'reversalOperationId',compensation.reversal_operation_id,
      'reversalIdempotencyKey',compensation.reversal_idempotency_key,'baseScopeVersionId',compensation.base_scope_version_id,
      'lifecycleExpectedVersion',compensation.lifecycle_expected_version,'amountCents',compensation.amount_cents,
      'currency',compensation.currency,'requestedBy',compensation.requested_by,'createdAt',compensation.created_at,
      'semanticLimitation',compensation.semantic_limitation);
    SELECT * INTO journal FROM public.financial_provider_command_journal WHERE operation_id=compensation.reversal_operation_id
      AND operation_kind='REVERSAL' AND provider_kind='FAKE' AND command_state='REQUESTED' AND idempotency_key=compensation.reversal_idempotency_key;
    IF journal.command_id IS NOT NULL THEN
      IF journal.recorded_actor_id IS DISTINCT FROM witness.actor_user_id OR journal.task_draft_id IS DISTINCT FROM witness.task_draft_id
         OR journal.task_id IS DISTINCT FROM witness.task_id OR journal.work_order_id IS DISTINCT FROM witness.work_order_id
         OR journal.related_operation_id IS DISTINCT FROM witness.adjustment_operation_id
         OR journal.amount_cents IS DISTINCT FROM witness.customer_total_cents OR journal.currency IS DISTINCT FROM witness.currency THEN
        RAISE EXCEPTION 'HXUV1-COHISTORY-13-REVERSAL_IDENTITY_INVALID'; END IF;
      reversal_progress:=hx_authority.read_fake_financial_public_progress_v13(journal.command_id);
      reversal_request_state:=CASE WHEN reversal_progress IS NULL THEN 'UNADMITTED_HELD' ELSE 'OUTBOX_RECORDED' END;
      IF reversal_progress IS NOT NULL AND (reversal_progress->>'ownerActorId' IS DISTINCT FROM actor.resolved_user_id::TEXT
         OR reversal_progress->>'environment' IS DISTINCT FROM request.environment) THEN
        RAISE EXCEPTION 'HXUV1-COHISTORY-13-PROGRESS_INVALID'; END IF;
      reversal_progress:=reversal_progress-ARRAY['ownerActorId','environment']::TEXT[];
    END IF;
    history:=pg_catalog.jsonb_build_object('state','COMPENSATION_CLAIM','observedAt',pg_catalog.clock_timestamp(),
      'actorUserId',witness.actor_user_id,'identity',identity_payload,'phase',phase,'compensation',historical_compensation,
      'reversalRequestState',reversal_request_state,'reversalProgress',reversal_progress);
    RETURN NEXT; RETURN;
  END IF;
  -- Progress reader validates the full exact request, outbox, outcome and event chain.
  SELECT * INTO journal FROM public.financial_provider_command_journal
    WHERE operation_id=witness.adjustment_operation_id AND operation_kind='ADJUST'
      AND provider_kind='FAKE' AND command_state='REQUESTED' AND idempotency_key=witness.idempotency_key||':adjust';
  IF journal.command_id IS NOT NULL THEN
    SELECT * INTO STRICT prepared FROM public.universal_v1_prepared_financial_commands WHERE prepared_command_id=journal.prepared_financial_command_id;
    IF journal.recorded_actor_id IS DISTINCT FROM witness.actor_user_id OR journal.work_order_id IS DISTINCT FROM witness.work_order_id
       OR prepared.change_order_id IS DISTINCT FROM witness.proposal_id OR prepared.task_draft_id IS DISTINCT FROM witness.task_draft_id
       OR prepared.task_id IS DISTINCT FROM witness.task_id OR prepared.scope_version_id IS DISTINCT FROM witness.replacement_scope_version_id
       OR prepared.eligibility_decision_id IS DISTINCT FROM witness.eligibility_decision_id
       OR prepared.predecessor_event_id IS DISTINCT FROM witness.predecessor_event_id
       OR prepared.lifecycle_expected_version IS DISTINCT FROM witness.expected_financial_version+1
       OR prepared.amount_cents IS DISTINCT FROM witness.customer_total_cents OR prepared.currency IS DISTINCT FROM witness.currency THEN
      RAISE EXCEPTION 'HXUV1-COHISTORY-13-ADJUST_IDENTITY_INVALID'; END IF;
    adjustment_progress:=hx_authority.read_fake_financial_public_progress_v13(journal.command_id);
    adjustment_request_state:=CASE WHEN adjustment_progress IS NULL THEN 'UNADMITTED_HELD' ELSE 'OUTBOX_RECORDED' END;
    IF adjustment_progress IS NOT NULL AND (adjustment_progress->>'ownerActorId' IS DISTINCT FROM actor.resolved_user_id::TEXT
       OR adjustment_progress->>'environment' IS DISTINCT FROM request.environment) THEN
      RAISE EXCEPTION 'HXUV1-COHISTORY-13-PROGRESS_INVALID'; END IF;
    adjustment_progress:=adjustment_progress-ARRAY['ownerActorId','environment']::TEXT[];
  END IF;
  history:=pg_catalog.jsonb_build_object('state','PREPARED','observedAt',pg_catalog.clock_timestamp(),
    'actorUserId',witness.actor_user_id,'identity',identity_payload,'phase',phase,'adjustmentProgress',adjustment_progress,
    'adjustmentRequestState',adjustment_request_state,
    'predecessorExpiresAt',public.universal_v1_effective_financial_security_expiry_v1(witness.predecessor_event_id));
  RETURN NEXT;
END;
$$;
REVOKE ALL ON FUNCTION public.hxos_build_change_order_history_actor_request_v13(TEXT,JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.hxos_read_authenticated_change_order_history_v13(TEXT,JSONB) FROM PUBLIC;


-- Authenticated proposal and decision ports. Exact custody and grants are
-- enrolled in the closed runtime authority catalog and provisioning plan.
-- Existing legacy request hashes remain byte-compatible; fresh actor receipts
-- bind the separate current target, normalized payload and timestamp.

CREATE OR REPLACE FUNCTION public.universal_v1_change_scope_sha256(
  checked_title TEXT, checked_description TEXT, checked_requirements TEXT,
  checked_checklist JSONB, checked_customer_total_cents INTEGER,
  checked_provider_payout_cents INTEGER, checked_currency CHAR(3)
) RETURNS CHAR(64)
LANGUAGE sql IMMUTABLE SECURITY INVOKER PARALLEL SAFE SET search_path=pg_catalog AS $$
  SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
    'contract','HUSTLEXP_UNIVERSAL_V1_SCOPE_V1',
    'title',checked_title,'description',checked_description,'requirements',checked_requirements,
    'checklist',checked_checklist,'customerTotalCents',checked_customer_total_cents,
    'providerPayoutCents',checked_provider_payout_cents,'currency',checked_currency
  )::TEXT,'UTF8')),'hex')::CHAR(64);
$$;

CREATE OR REPLACE FUNCTION public.universal_v1_change_proposal_request_sha256(
  checked_task_id UUID, checked_base_version_id UUID, checked_proposed_by UUID,
  checked_proposer_role TEXT, checked_proposal_version INTEGER,
  checked_supersedes_proposal_id UUID, checked_change_order_kind TEXT,
  checked_observed_scope_summary TEXT, checked_proposed_scope_sha256 CHAR(64),
  checked_idempotency_key TEXT
) RETURNS CHAR(64)
LANGUAGE sql IMMUTABLE SECURITY INVOKER PARALLEL SAFE SET search_path=pg_catalog AS $$
  SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
    'contract','HUSTLEXP_UNIVERSAL_V1_CHANGE_ORDER_PROPOSAL_V1',
    'taskId',checked_task_id,'baseScopeVersionId',checked_base_version_id,
    'proposedBy',checked_proposed_by,'proposerRole',checked_proposer_role,
    'proposalVersion',checked_proposal_version,'supersedesProposalId',checked_supersedes_proposal_id,
    'changeOrderKind',checked_change_order_kind,'changeSummary',checked_observed_scope_summary,
    'proposedScopeSha256',checked_proposed_scope_sha256,'idempotencyKey',checked_idempotency_key
  )::TEXT,'UTF8')),'hex')::CHAR(64);
$$;

CREATE OR REPLACE FUNCTION public.universal_v1_change_decision_request_sha256(
  checked_proposal_id UUID, checked_expected_proposal_version INTEGER,
  checked_approver_role TEXT, checked_decision TEXT, checked_actor_id UUID,
  checked_reason TEXT, checked_idempotency_key TEXT
) RETURNS CHAR(64)
LANGUAGE sql IMMUTABLE SECURITY INVOKER PARALLEL SAFE SET search_path=pg_catalog AS $$
  SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
    'contract','HUSTLEXP_UNIVERSAL_V1_CHANGE_ORDER_DECISION_V1',
    'proposalId',checked_proposal_id,'expectedProposalVersion',checked_expected_proposal_version,
    'approverRole',checked_approver_role,'decision',checked_decision,'actorId',checked_actor_id,
    'reason',checked_reason,'idempotencyKey',checked_idempotency_key
  )::TEXT,'UTF8')),'hex')::CHAR(64);
$$;

CREATE OR REPLACE FUNCTION public.hxos_build_change_order_actor_request_v13(
  expected_command_kind TEXT, command_payload JSONB
) RETURNS TABLE(target_authority_id UUID,environment TEXT,release_manifest_sha256 TEXT,
  canonical_request JSONB,actor_request_sha256 TEXT)
LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE SET search_path=pg_catalog AS $$
DECLARE
  target RECORD; allowed_keys TEXT[]; version_fields TEXT[]; field_name TEXT;
  text_value TEXT; scope_payload JSONB; entry JSONB; minimum_length INTEGER; maximum_length INTEGER;
  utf16_length INTEGER;
  -- ECMAScript String.trim whitespace, matching the normalized public schema.
  trim_chars TEXT:=pg_catalog.chr(9)||pg_catalog.chr(10)||pg_catalog.chr(11)||pg_catalog.chr(12)||
    pg_catalog.chr(13)||pg_catalog.chr(32)||pg_catalog.chr(160)||pg_catalog.chr(5760)||
    pg_catalog.chr(8192)||pg_catalog.chr(8193)||pg_catalog.chr(8194)||pg_catalog.chr(8195)||
    pg_catalog.chr(8196)||pg_catalog.chr(8197)||pg_catalog.chr(8198)||pg_catalog.chr(8199)||
    pg_catalog.chr(8200)||pg_catalog.chr(8201)||pg_catalog.chr(8202)||pg_catalog.chr(8232)||
    pg_catalog.chr(8233)||pg_catalog.chr(8239)||pg_catalog.chr(8287)||pg_catalog.chr(12288)||pg_catalog.chr(65279);
BEGIN
  PERFORM hx_authority.assert_universal_v1_work_order_bootstrap_seal_v1();
  IF expected_command_kind IS NULL OR expected_command_kind NOT IN ('PROPOSE_FAKE_CHANGE_ORDER','DECIDE_FAKE_CHANGE_ORDER')
     OR pg_catalog.jsonb_typeof(command_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'HXUV1-COWRITE-13-PAYLOAD_INVALID'; END IF;
  IF expected_command_kind='PROPOSE_FAKE_CHANGE_ORDER' THEN
    allowed_keys:=ARRAY['work_order_id','expected_scope_version','expected_amendment_version',
      'expected_latest_proposal_version','observed_scope_summary','proposed_scope','idempotency_key',
      'client_timestamp_epoch_ms','change_order_kind'];
    version_fields:=ARRAY['expected_scope_version','expected_amendment_version','expected_latest_proposal_version'];
    IF pg_catalog.jsonb_typeof(command_payload->'change_order_kind') IS DISTINCT FROM 'string'
       OR command_payload->>'change_order_kind' NOT IN ('SCOPE_ONLY','PRICE_AND_SCOPE') THEN
      RAISE EXCEPTION 'HXUV1-COWRITE-13-PAYLOAD_INVALID'; END IF;
    IF command_payload->>'change_order_kind'='PRICE_AND_SCOPE' THEN
      allowed_keys:=allowed_keys||ARRAY['proposed_customer_total_cents','proposed_provider_payout_cents'];
      FOREACH field_name IN ARRAY ARRAY['proposed_customer_total_cents','proposed_provider_payout_cents'] LOOP
        IF pg_catalog.jsonb_typeof(command_payload->field_name) IS DISTINCT FROM 'number'
           OR command_payload->>field_name !~ '^[1-9][0-9]{0,8}$' THEN
          RAISE EXCEPTION 'HXUV1-COWRITE-13-PAYLOAD_INVALID'; END IF;
        IF (command_payload->>field_name)::BIGINT>100000000 THEN
          RAISE EXCEPTION 'HXUV1-COWRITE-13-PAYLOAD_INVALID'; END IF;
      END LOOP;
      IF (command_payload->>'proposed_provider_payout_cents')::BIGINT>
         (command_payload->>'proposed_customer_total_cents')::BIGINT THEN
        RAISE EXCEPTION 'HXUV1-COWRITE-13-PAYLOAD_INVALID'; END IF;
    END IF;
    field_name:='work_order_id';
  ELSE
    allowed_keys:=ARRAY['proposal_id','expected_proposal_version','decision','reason','idempotency_key','client_timestamp_epoch_ms'];
    version_fields:=ARRAY['expected_proposal_version'];
    IF pg_catalog.jsonb_typeof(command_payload->'decision') IS DISTINCT FROM 'string'
       OR command_payload->>'decision' NOT IN ('APPROVED','REJECTED') THEN
      RAISE EXCEPTION 'HXUV1-COWRITE-13-PAYLOAD_INVALID'; END IF;
    field_name:='proposal_id';
  END IF;
  IF command_payload-allowed_keys<>'{}'::JSONB
     OR pg_catalog.jsonb_typeof(command_payload->field_name) IS DISTINCT FROM 'string'
     OR command_payload->>field_name !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
     OR pg_catalog.jsonb_typeof(command_payload->'idempotency_key') IS DISTINCT FROM 'string'
     OR command_payload->>'idempotency_key' !~ '^[A-Za-z0-9:_-]{16,96}$'
     OR pg_catalog.jsonb_typeof(command_payload->'client_timestamp_epoch_ms') IS DISTINCT FROM 'number'
     OR command_payload->>'client_timestamp_epoch_ms' !~ '^(0|[1-9][0-9]{0,15})$' THEN
    RAISE EXCEPTION 'HXUV1-COWRITE-13-PAYLOAD_INVALID'; END IF;
  IF (command_payload->>'client_timestamp_epoch_ms')::NUMERIC>9007199254740991 THEN
    RAISE EXCEPTION 'HXUV1-COWRITE-13-PAYLOAD_INVALID'; END IF;
  FOREACH field_name IN ARRAY version_fields LOOP
    IF pg_catalog.jsonb_typeof(command_payload->field_name) IS DISTINCT FROM 'number'
       OR command_payload->>field_name !~ '^(0|[1-9][0-9]{0,9})$' THEN
      RAISE EXCEPTION 'HXUV1-COWRITE-13-PAYLOAD_INVALID'; END IF;
    IF (command_payload->>field_name)::BIGINT>2147483647
       OR (field_name IN ('expected_scope_version','expected_proposal_version')
         AND (command_payload->>field_name)::BIGINT=0) THEN
      RAISE EXCEPTION 'HXUV1-COWRITE-13-PAYLOAD_INVALID'; END IF;
  END LOOP;
  field_name:=CASE expected_command_kind WHEN 'PROPOSE_FAKE_CHANGE_ORDER' THEN 'observed_scope_summary' ELSE 'reason' END;
  text_value:=command_payload->>field_name;
  IF pg_catalog.jsonb_typeof(command_payload->field_name) IS DISTINCT FROM 'string' THEN
    RAISE EXCEPTION 'HXUV1-COWRITE-13-PAYLOAD_INVALID'; END IF;
  utf16_length:=pg_catalog.char_length(text_value)+pg_catalog.char_length(
    pg_catalog.regexp_replace(text_value,U&'[^\+010000-\+10FFFF]','','g'));
  IF text_value IS DISTINCT FROM pg_catalog.btrim(text_value,trim_chars) OR utf16_length NOT BETWEEN 3 AND 1000 THEN
    RAISE EXCEPTION 'HXUV1-COWRITE-13-PAYLOAD_INVALID'; END IF;
  IF expected_command_kind='PROPOSE_FAKE_CHANGE_ORDER' THEN
    scope_payload:=command_payload->'proposed_scope';
    IF pg_catalog.jsonb_typeof(scope_payload) IS DISTINCT FROM 'object'
       OR scope_payload-ARRAY['title','description','requirements','checklist']::TEXT[]<>'{}'::JSONB THEN
      RAISE EXCEPTION 'HXUV1-COWRITE-13-PAYLOAD_INVALID'; END IF;
    FOREACH field_name IN ARRAY ARRAY['title','description','requirements'] LOOP
      IF field_name='requirements' AND scope_payload->field_name='null'::JSONB THEN CONTINUE; END IF;
      IF pg_catalog.jsonb_typeof(scope_payload->field_name) IS DISTINCT FROM 'string' THEN
        RAISE EXCEPTION 'HXUV1-COWRITE-13-PAYLOAD_INVALID'; END IF;
      text_value:=scope_payload->>field_name;
      minimum_length:=CASE field_name WHEN 'description' THEN 10 ELSE 3 END;
      maximum_length:=CASE field_name WHEN 'title' THEN 200 ELSE 5000 END;
      utf16_length:=pg_catalog.char_length(text_value)+pg_catalog.char_length(
        pg_catalog.regexp_replace(text_value,U&'[^\+010000-\+10FFFF]','','g'));
      IF text_value IS DISTINCT FROM pg_catalog.btrim(text_value,trim_chars)
         OR utf16_length NOT BETWEEN minimum_length AND maximum_length THEN
        RAISE EXCEPTION 'HXUV1-COWRITE-13-PAYLOAD_INVALID'; END IF;
    END LOOP;
    IF pg_catalog.jsonb_typeof(scope_payload->'checklist') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'HXUV1-COWRITE-13-PAYLOAD_INVALID'; END IF;
    IF pg_catalog.jsonb_array_length(scope_payload->'checklist') NOT BETWEEN 1 AND 50 THEN
      RAISE EXCEPTION 'HXUV1-COWRITE-13-PAYLOAD_INVALID'; END IF;
    FOR entry IN SELECT value FROM pg_catalog.jsonb_array_elements(scope_payload->'checklist') items(value) LOOP
      IF pg_catalog.jsonb_typeof(entry) IS DISTINCT FROM 'string' THEN
        RAISE EXCEPTION 'HXUV1-COWRITE-13-PAYLOAD_INVALID'; END IF;
      text_value:=entry#>>'{}';
      utf16_length:=pg_catalog.char_length(text_value)+pg_catalog.char_length(
        pg_catalog.regexp_replace(text_value,U&'[^\+010000-\+10FFFF]','','g'));
      IF text_value IS DISTINCT FROM pg_catalog.btrim(text_value,trim_chars) OR utf16_length NOT BETWEEN 1 AND 500 THEN
        RAISE EXCEPTION 'HXUV1-COWRITE-13-PAYLOAD_INVALID'; END IF;
    END LOOP;
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('hxuv1-work-order-target-authority-v1',0));
  SELECT * INTO STRICT target FROM hx_authority.read_universal_v1_work_order_target_authority_v1();
  canonical_request:=pg_catalog.jsonb_build_object('schema_version',1,'command_kind',expected_command_kind,
    'release_manifest_sha256',target.release_manifest_sha256,
    'target_authority',pg_catalog.jsonb_build_object('id',target.target_authority_id,'version',target.authority_version,
      'database',target.target_database_name,'environment',target.environment,'release',target.release_manifest_sha256),
    'authentication_requirements',pg_catalog.jsonb_build_object('mfa_required',FALSE,'step_up_required',FALSE,
      'max_auth_age_seconds',300,'max_step_up_age_seconds',NULL),'command_payload',command_payload);
  target_authority_id:=target.target_authority_id; environment:=target.environment;
  release_manifest_sha256:=target.release_manifest_sha256;
  actor_request_sha256:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(canonical_request::TEXT,'UTF8')),'hex');
  RETURN NEXT;
END;
$$;

-- Private fixed-purpose dependency: no API/worker/attester EXECUTE grant.
-- The actor argument comes exclusively from the enclosing assertion consumer.
CREATE OR REPLACE FUNCTION hx_authority.lock_change_order_write_context_v13(
  p_command_kind TEXT,p_subject_id UUID,p_actor_user_id UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE SET search_path=pg_catalog AS $$
DECLARE
  checked_work_order_id UUID; context RECORD; pass INTEGER; action_name TEXT; actor_ids UUID[];
  locked_dependency_identity JSONB; observed_dependency_identity JSONB;
BEGIN
  IF p_actor_user_id IS NULL OR p_subject_id IS NULL OR p_command_kind IS NULL
     OR p_command_kind NOT IN ('PROPOSE_FAKE_CHANGE_ORDER','DECIDE_FAKE_CHANGE_ORDER') THEN
    RAISE EXCEPTION 'HXUV1-COWRITE-13-CONTEXT_INPUT_INVALID'; END IF;
  action_name:=CASE p_command_kind WHEN 'PROPOSE_FAKE_CHANGE_ORDER' THEN 'CREATE_WORK_ORDER' ELSE 'APPROVE_SPEND' END;
  IF p_command_kind='PROPOSE_FAKE_CHANGE_ORDER' THEN checked_work_order_id:=p_subject_id;
  ELSE
    SELECT work_order.id INTO checked_work_order_id FROM public.task_scope_change_proposals proposal
      JOIN public.tasks task ON task.id=proposal.task_id
      JOIN public.task_work_orders work_order ON work_order.task_id=task.id AND task.work_order_id=work_order.id
      WHERE proposal.id=p_subject_id AND proposal.universal_contract_version=1 AND proposal.application_contract_version=1;
  END IF;
  FOR pass IN 0..1 LOOP
    -- This same static query runs before foreign domain locks and again after
    -- all locks. Its method-specific predicates mirror the repository.
    SELECT work_order.id AS work_order_id,task.id AS task_id,work_order.task_draft_id,
      work_order.eligibility_decision_id,work_order.provider_user_id,work_order.provider_organization_id,
      task.business_organization_id AS customer_organization_id,eligibility.provider_class,eligibility.trade_credential_id,
      scope.id AS scope_id,scope.version AS scope_version,scope.scope_hash,scope.title,scope.description,
      scope.requirements,scope.checklist,scope.customer_total_cents,scope.hustler_payout_cents,scope.currency,
      COALESCE(latest_amendment.amendment_version,0) AS amendment_version,
      latest_proposal.id AS latest_proposal_id,COALESCE(latest_proposal.proposal_version,0) AS latest_proposal_version,
      latest_proposal.status AS latest_proposal_status,selected_proposal.proposed_by AS original_proposer_id,
      ((task.business_organization_id IS NULL AND task.poster_id=p_actor_user_id)
        OR (task.business_organization_id IS NOT NULL AND customer_organization.status='ACTIVE'
          AND customer_organization.client_enabled IS TRUE
          AND public.business_membership_has_action(task.business_organization_id,p_actor_user_id,action_name))) AS actor_is_customer,
      (work_order.provider_user_id=p_actor_user_id
        OR (work_order.provider_organization_id IS NOT NULL AND provider_organization.status='ACTIVE'
          AND provider_organization.provider_enabled IS TRUE
          AND public.business_membership_has_action(work_order.provider_organization_id,p_actor_user_id,action_name))) AS actor_is_provider
    INTO context
    FROM public.task_work_orders work_order
    JOIN public.tasks task ON task.id=work_order.task_id
    JOIN public.task_drafts draft ON draft.id=work_order.task_draft_id
    JOIN public.task_provider_eligibility_decisions eligibility ON eligibility.id=work_order.eligibility_decision_id
    JOIN public.users actor ON actor.id=p_actor_user_id
    JOIN public.users provider ON provider.id=work_order.provider_user_id
    LEFT JOIN public.business_organizations customer_organization ON customer_organization.id=task.business_organization_id
    LEFT JOIN public.business_organizations provider_organization ON provider_organization.id=work_order.provider_organization_id
    LEFT JOIN public.task_scope_change_proposals selected_proposal ON p_command_kind='DECIDE_FAKE_CHANGE_ORDER'
      AND selected_proposal.id=p_subject_id AND selected_proposal.task_id=task.id
      AND selected_proposal.universal_contract_version=1 AND selected_proposal.application_contract_version=1
    LEFT JOIN LATERAL (SELECT amendment.scope_version_id,amendment.amendment_version
      FROM public.task_work_order_amendments amendment WHERE amendment.work_order_id=work_order.id
      ORDER BY amendment.amendment_version DESC LIMIT 1) latest_amendment ON TRUE
    JOIN public.task_scope_versions scope ON scope.id=COALESCE(latest_amendment.scope_version_id,work_order.scope_version_id)
    LEFT JOIN LATERAL (SELECT proposal.id,proposal.proposal_version,proposal.status
      FROM public.task_scope_change_proposals proposal WHERE proposal.task_id=task.id AND proposal.universal_contract_version=1
      ORDER BY proposal.proposal_version DESC LIMIT 1) latest_proposal ON TRUE
    WHERE work_order.id=checked_work_order_id AND task.work_order_id=work_order.id
      AND task.universal_contract_version=1 AND task.automation_classification='CONTROLLED_TEST'
      AND task.universal_payment_posture='PAYMENT_CREATION_FROZEN' AND task.worker_id IS NULL
      AND actor.account_status='ACTIVE' AND actor.is_minor IS FALSE AND COALESCE(actor.is_banned,FALSE) IS FALSE
      AND provider.account_status='ACTIVE' AND provider.is_minor IS FALSE AND COALESCE(provider.is_banned,FALSE) IS FALSE
      AND public.universal_v1_invited_provider_authority_is_current(eligibility.provider_user_id,
        eligibility.provider_organization_id,eligibility.provider_class,eligibility.trade_credential_id,task.category,task.region_code) IS TRUE
      AND ((p_command_kind='PROPOSE_FAKE_CHANGE_ORDER' AND draft.universal_contract_version=1
          AND task.active_scope_version_id=scope.id
          AND NOT EXISTS(SELECT 1 FROM public.task_completion_facts completion WHERE completion.work_order_id=work_order.id)
          AND NOT EXISTS(SELECT 1 FROM public.task_reconciliation_facts reconciliation WHERE reconciliation.work_order_id=work_order.id))
        OR (p_command_kind='DECIDE_FAKE_CHANGE_ORDER' AND selected_proposal.id IS NOT NULL));
    IF NOT FOUND THEN RAISE EXCEPTION 'HXUV1-COWRITE-13: CHANGE_ORDER_CONTEXT_UNAVAILABLE'; END IF;
    IF context.actor_is_customer IS NOT TRUE AND context.actor_is_provider IS NOT TRUE THEN
      RAISE EXCEPTION 'HXUV1-COWRITE-13: CHANGE_ORDER_AUTHORITY_REVOKED'; END IF;
    IF context.actor_is_customer IS TRUE AND context.actor_is_provider IS TRUE THEN
      RAISE EXCEPTION 'HXUV1-COWRITE-13: CHANGE_ORDER_AUTHORITY_REVOKED'; END IF;
    observed_dependency_identity:=pg_catalog.jsonb_build_array(context.work_order_id,context.task_id,
      context.task_draft_id,context.eligibility_decision_id,context.provider_user_id,context.provider_organization_id,
      context.customer_organization_id,context.trade_credential_id,context.scope_id,context.original_proposer_id);
    IF pass=1 THEN
      IF observed_dependency_identity IS DISTINCT FROM locked_dependency_identity THEN
        RAISE EXCEPTION 'HXUV1-COWRITE-13: CHANGE_ORDER_VERSION_CONFLICT'; END IF;
      EXIT;
    END IF;
    locked_dependency_identity:=observed_dependency_identity;
    IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(
      CASE p_command_kind WHEN 'PROPOSE_FAKE_CHANGE_ORDER' THEN 'universal-v1-change-order:'||checked_work_order_id::TEXT
        ELSE 'universal-v1-change-order-proposal:'||p_subject_id::TEXT END,0))
       OR NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('fulfillment:'||checked_work_order_id::TEXT,0)) THEN
      RAISE EXCEPTION 'HXUV1-COWRITE-13-LOCK_BUSY'; END IF;
    PERFORM 1 FROM public.task_work_orders WHERE id=checked_work_order_id FOR UPDATE NOWAIT;
    PERFORM 1 FROM public.tasks WHERE id=context.task_id FOR UPDATE NOWAIT;
    PERFORM 1 FROM public.task_drafts WHERE id=context.task_draft_id FOR SHARE NOWAIT;
    IF p_command_kind='DECIDE_FAKE_CHANGE_ORDER' THEN
      PERFORM 1 FROM public.task_scope_change_proposals WHERE id=p_subject_id FOR UPDATE NOWAIT;
    END IF;
    PERFORM 1 FROM public.task_provider_eligibility_decisions WHERE id=context.eligibility_decision_id FOR SHARE NOWAIT;
    PERFORM 1 FROM public.task_scope_versions WHERE id=context.scope_id FOR SHARE NOWAIT;
    SELECT pg_catalog.array_agg(actor_id ORDER BY actor_id) INTO actor_ids FROM (
      SELECT p_actor_user_id AS actor_id UNION SELECT context.provider_user_id UNION SELECT context.original_proposer_id
    ) exact_actors WHERE actor_id IS NOT NULL;
    -- A membership absent at preflight must not appear before commit. The user
    -- FK takes KEY SHARE on insert, so UPDATE also protects that absent-row case.
    PERFORM 1 FROM public.users WHERE id=ANY(actor_ids) ORDER BY id FOR UPDATE NOWAIT;
    PERFORM 1 FROM public.business_organizations WHERE id IN (context.customer_organization_id,context.provider_organization_id)
      ORDER BY id FOR SHARE NOWAIT;
    PERFORM 1 FROM public.business_memberships WHERE organization_id IN (context.customer_organization_id,context.provider_organization_id)
      AND user_id=ANY(actor_ids) ORDER BY organization_id,user_id,id FOR SHARE NOWAIT;
    PERFORM 1 FROM public.capability_profiles WHERE user_id=context.provider_user_id ORDER BY user_id FOR SHARE NOWAIT;
    PERFORM 1 FROM public.business_credentials WHERE id=context.trade_credential_id FOR SHARE NOWAIT;
    PERFORM 1 FROM public.verified_trades WHERE user_id=context.provider_user_id
      AND provider_organization_id IS NOT DISTINCT FROM context.provider_organization_id
      AND business_credential_id IS NOT DISTINCT FROM context.trade_credential_id ORDER BY user_id,trade FOR SHARE NOWAIT;
  END LOOP;
  RETURN pg_catalog.to_jsonb(context)||pg_catalog.jsonb_build_object('party',
    CASE WHEN context.actor_is_customer IS TRUE THEN 'CUSTOMER' ELSE 'PROVIDER' END);
END;
$$;

CREATE OR REPLACE FUNCTION public.hxos_propose_authenticated_change_order_v13(
  actor_assertion_token TEXT,command_payload JSONB
) RETURNS TABLE(result JSONB,actor_user_id UUID,actor_assertion_id UUID,actor_request_sha256 TEXT,
  target_authority_id UUID,command_release_sha256 TEXT)
LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE SET search_path=pg_catalog AS $$
DECLARE
  request RECORD; actor RECORD; context JSONB; scope_payload JSONB;
  prior public.task_scope_change_proposals%ROWTYPE; stored public.task_scope_change_proposals%ROWTYPE;
  base_scope public.task_scope_versions%ROWTYPE; replay_amendment_version INTEGER;
  proposer_role_value TEXT; key_value TEXT; kind_value TEXT; scope_sha CHAR(64); request_sha CHAR(64);
  customer_total INTEGER; provider_payout INTEGER; next_version INTEGER; supersedes_id UUID; replay BOOLEAN:=FALSE;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'HXUV1-COWRITE-13-READ_COMMITTED_REQUIRED'; END IF;
  SELECT * INTO STRICT request FROM public.hxos_build_change_order_actor_request_v13('PROPOSE_FAKE_CHANGE_ORDER',command_payload);
  SELECT * INTO STRICT actor FROM hx_authority.consume_universal_v1_actor_assertion_v1(
    actor_assertion_token,'PROPOSE_FAKE_CHANGE_ORDER',request.canonical_request,request.environment);
  IF pg_catalog.abs(EXTRACT(EPOCH FROM pg_catalog.clock_timestamp())*1000-
      (command_payload->>'client_timestamp_epoch_ms')::NUMERIC)>300000 THEN
    RAISE EXCEPTION 'HXUV1-COWRITE-13-CLIENT_TIMESTAMP_INVALID'; END IF;
  context:=hx_authority.lock_change_order_write_context_v13('PROPOSE_FAKE_CHANGE_ORDER',
    (command_payload->>'work_order_id')::UUID,actor.resolved_user_id);
  PERFORM 1 FROM public.users current_actor WHERE current_actor.id=actor.resolved_user_id
    AND current_actor.firebase_uid=actor.verified_subject;
  IF NOT FOUND THEN RAISE EXCEPTION 'HXUV1-COWRITE-13: CHANGE_ORDER_AUTHORITY_REVOKED'; END IF;
  proposer_role_value:=CASE context->>'party' WHEN 'CUSTOMER' THEN 'POSTER' ELSE 'HUSTLER' END;
  key_value:=command_payload->>'idempotency_key'; kind_value:=command_payload->>'change_order_kind';
  scope_payload:=command_payload->'proposed_scope';
  -- Identity is immutable. A global key collision never locks a foreign row.
  SELECT * INTO prior FROM public.task_scope_change_proposals proposal WHERE proposal.idempotency_key=key_value
    AND proposal.universal_contract_version=1 AND proposal.application_contract_version=1;
  IF prior.id IS NOT NULL THEN
    IF prior.task_id IS DISTINCT FROM (context->>'task_id')::UUID OR prior.proposed_by IS DISTINCT FROM actor.resolved_user_id
       OR prior.proposer_role IS DISTINCT FROM proposer_role_value
       OR prior.proposal_version::BIGINT IS DISTINCT FROM (command_payload->>'expected_latest_proposal_version')::BIGINT+1
       OR prior.change_order_kind IS DISTINCT FROM kind_value
       OR prior.observed_scope_summary IS DISTINCT FROM command_payload->>'observed_scope_summary'
       OR prior.proposed_title IS DISTINCT FROM scope_payload->>'title'
       OR prior.proposed_description IS DISTINCT FROM scope_payload->>'description'
       OR prior.proposed_requirements IS DISTINCT FROM scope_payload->>'requirements'
       OR prior.proposed_checklist IS DISTINCT FROM scope_payload->'checklist'
       OR (kind_value='PRICE_AND_SCOPE' AND (prior.proposed_customer_total_cents IS DISTINCT FROM (command_payload->>'proposed_customer_total_cents')::INTEGER
         OR prior.proposed_provider_payout_cents IS DISTINCT FROM (command_payload->>'proposed_provider_payout_cents')::INTEGER))
       OR (kind_value='SCOPE_ONLY' AND (prior.proposed_customer_total_cents IS NOT NULL OR prior.proposed_provider_payout_cents IS NOT NULL)) THEN
      RAISE EXCEPTION 'HXUV1-COWRITE-13: CHANGE_ORDER_IDEMPOTENCY_CONFLICT'; END IF;
    SELECT * INTO STRICT base_scope FROM public.task_scope_versions scope WHERE scope.id=prior.base_version_id AND scope.task_id=prior.task_id;
    SELECT CASE WHEN work_order.scope_version_id=base_scope.id THEN 0 ELSE COALESCE((
      SELECT amendment.amendment_version FROM public.task_work_order_amendments amendment
      WHERE amendment.work_order_id=work_order.id AND amendment.scope_version_id=base_scope.id
      ORDER BY amendment.amendment_version DESC LIMIT 1),-1) END INTO replay_amendment_version
      FROM public.task_work_orders work_order WHERE work_order.id=(context->>'work_order_id')::UUID;
    IF base_scope.version IS DISTINCT FROM (command_payload->>'expected_scope_version')::INTEGER
       OR replay_amendment_version IS DISTINCT FROM (command_payload->>'expected_amendment_version')::INTEGER THEN
      RAISE EXCEPTION 'HXUV1-COWRITE-13: CHANGE_ORDER_IDEMPOTENCY_CONFLICT'; END IF;
    customer_total:=COALESCE(prior.proposed_customer_total_cents,base_scope.customer_total_cents);
    provider_payout:=COALESCE(prior.proposed_provider_payout_cents,base_scope.hustler_payout_cents);
    scope_sha:=public.universal_v1_change_scope_sha256(scope_payload->>'title',scope_payload->>'description',
      scope_payload->>'requirements',scope_payload->'checklist',customer_total,provider_payout,base_scope.currency);
    request_sha:=public.universal_v1_change_proposal_request_sha256(prior.task_id,prior.base_version_id,actor.resolved_user_id,
      proposer_role_value,prior.proposal_version,prior.supersedes_proposal_id,kind_value,
      command_payload->>'observed_scope_summary',scope_sha,key_value);
    IF prior.proposed_scope_sha256 IS DISTINCT FROM scope_sha OR prior.request_sha256 IS DISTINCT FROM request_sha THEN
      RAISE EXCEPTION 'HXUV1-COWRITE-13: CHANGE_ORDER_IDEMPOTENCY_CONFLICT'; END IF;
    stored:=prior; replay:=TRUE;
  ELSE
    IF (context->>'scope_version')::INTEGER IS DISTINCT FROM (command_payload->>'expected_scope_version')::INTEGER
       OR (context->>'amendment_version')::INTEGER IS DISTINCT FROM (command_payload->>'expected_amendment_version')::INTEGER
       OR (context->>'latest_proposal_version')::INTEGER IS DISTINCT FROM (command_payload->>'expected_latest_proposal_version')::INTEGER
       OR (context->>'latest_proposal_version')::INTEGER=2147483647 THEN
      RAISE EXCEPTION 'HXUV1-COWRITE-13: CHANGE_ORDER_VERSION_CONFLICT'; END IF;
    IF context->>'latest_proposal_status'='PENDING' THEN
      RAISE EXCEPTION 'HXUV1-COWRITE-13: CHANGE_ORDER_STATE_CONFLICT'; END IF;
    IF context->>'title' IS NOT DISTINCT FROM scope_payload->>'title'
       AND context->>'description' IS NOT DISTINCT FROM scope_payload->>'description'
       AND context->>'requirements' IS NOT DISTINCT FROM scope_payload->>'requirements'
       AND context->'checklist' IS NOT DISTINCT FROM scope_payload->'checklist' THEN
      RAISE EXCEPTION 'HXUV1-COWRITE-13: CHANGE_ORDER_STATE_CONFLICT'; END IF;
    customer_total:=CASE kind_value WHEN 'PRICE_AND_SCOPE' THEN (command_payload->>'proposed_customer_total_cents')::INTEGER
      ELSE (context->>'customer_total_cents')::INTEGER END;
    provider_payout:=CASE kind_value WHEN 'PRICE_AND_SCOPE' THEN (command_payload->>'proposed_provider_payout_cents')::INTEGER
      ELSE (context->>'hustler_payout_cents')::INTEGER END;
    IF customer_total IS NULL OR provider_payout IS NULL OR customer_total<=0 OR provider_payout<=0
       OR provider_payout>customer_total
       OR (kind_value='PRICE_AND_SCOPE' AND customer_total=(context->>'customer_total_cents')::INTEGER) THEN
      RAISE EXCEPTION 'HXUV1-COWRITE-13: CHANGE_ORDER_STATE_CONFLICT'; END IF;
    scope_sha:=public.universal_v1_change_scope_sha256(scope_payload->>'title',scope_payload->>'description',
      scope_payload->>'requirements',scope_payload->'checklist',customer_total,provider_payout,(context->>'currency')::CHAR(3));
    next_version:=(context->>'latest_proposal_version')::INTEGER+1;
    supersedes_id:=CASE WHEN next_version=1 THEN NULL ELSE (context->>'latest_proposal_id')::UUID END;
    request_sha:=public.universal_v1_change_proposal_request_sha256((context->>'task_id')::UUID,(context->>'scope_id')::UUID,
      actor.resolved_user_id,proposer_role_value,next_version,supersedes_id,kind_value,
      command_payload->>'observed_scope_summary',scope_sha,key_value);
    INSERT INTO public.task_scope_change_proposals AS inserted (
      task_id,base_version_id,proposed_by,proposer_role,observed_scope_summary,proposed_checklist,status,
      universal_contract_version,application_contract_version,proposal_version,supersedes_proposal_id,change_order_kind,
      proposed_customer_total_cents,proposed_provider_payout_cents,proposed_title,proposed_description,proposed_requirements,
      proposed_scope_sha256,schedule_effect,financial_adjustment_required,idempotency_key,request_sha256
    ) VALUES ((context->>'task_id')::UUID,(context->>'scope_id')::UUID,actor.resolved_user_id,proposer_role_value,
      command_payload->>'observed_scope_summary',scope_payload->'checklist','PENDING',1,1,next_version,supersedes_id,kind_value,
      CASE WHEN kind_value='PRICE_AND_SCOPE' THEN customer_total ELSE NULL END,
      CASE WHEN kind_value='PRICE_AND_SCOPE' THEN provider_payout ELSE NULL END,
      scope_payload->>'title',scope_payload->>'description',scope_payload->>'requirements',scope_sha,NULL,
      kind_value='PRICE_AND_SCOPE',key_value,request_sha) RETURNING inserted.* INTO stored;
    IF stored.id IS NULL THEN RAISE EXCEPTION 'HXUV1-COWRITE-13: CHANGE_ORDER_MATERIALIZATION_FAILED'; END IF;
  END IF;
  -- Do not allow lock/trigger work to turn a stale request into fresh authority.
  IF pg_catalog.abs(EXTRACT(EPOCH FROM pg_catalog.clock_timestamp())*1000-
      (command_payload->>'client_timestamp_epoch_ms')::NUMERIC)>300000 THEN
    RAISE EXCEPTION 'HXUV1-COWRITE-13-CLIENT_TIMESTAMP_INVALID'; END IF;
  result:=pg_catalog.jsonb_build_object('proposal_id',stored.id,'proposal_version',stored.proposal_version,
    'change_order_kind',stored.change_order_kind,'proposer_party',context->>'party',
    'proposed_scope_sha256',stored.proposed_scope_sha256,'replayed',replay,
    'payment_creation_performed',FALSE,'hard_assignment_created',FALSE);
  actor_user_id:=actor.resolved_user_id; actor_assertion_id:=actor.assertion_id;
  actor_request_sha256:=request.actor_request_sha256; target_authority_id:=request.target_authority_id;
  command_release_sha256:=request.release_manifest_sha256;
  RETURN NEXT;
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'HXUV1-COWRITE-13: CHANGE_ORDER_IDEMPOTENCY_CONFLICT';
END;
$$;

CREATE OR REPLACE FUNCTION public.hxos_decide_authenticated_change_order_v13(
  actor_assertion_token TEXT,command_payload JSONB
) RETURNS TABLE(result JSONB,actor_user_id UUID,actor_assertion_id UUID,actor_request_sha256 TEXT,
  target_authority_id UUID,command_release_sha256 TEXT)
LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE SET search_path=pg_catalog AS $$
DECLARE
  request RECORD; actor RECORD; context JSONB; proposal public.task_scope_change_proposals%ROWTYPE;
  approval RECORD; key_value TEXT; party_value TEXT; decision_value TEXT; request_sha CHAR(64);
  replay BOOLEAN:=FALSE; changed_count BIGINT;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'HXUV1-COWRITE-13-READ_COMMITTED_REQUIRED'; END IF;
  SELECT * INTO STRICT request FROM public.hxos_build_change_order_actor_request_v13('DECIDE_FAKE_CHANGE_ORDER',command_payload);
  SELECT * INTO STRICT actor FROM hx_authority.consume_universal_v1_actor_assertion_v1(
    actor_assertion_token,'DECIDE_FAKE_CHANGE_ORDER',request.canonical_request,request.environment);
  IF pg_catalog.abs(EXTRACT(EPOCH FROM pg_catalog.clock_timestamp())*1000-
      (command_payload->>'client_timestamp_epoch_ms')::NUMERIC)>300000 THEN
    RAISE EXCEPTION 'HXUV1-COWRITE-13-CLIENT_TIMESTAMP_INVALID'; END IF;
  context:=hx_authority.lock_change_order_write_context_v13('DECIDE_FAKE_CHANGE_ORDER',
    (command_payload->>'proposal_id')::UUID,actor.resolved_user_id);
  PERFORM 1 FROM public.users current_actor WHERE current_actor.id=actor.resolved_user_id
    AND current_actor.firebase_uid=actor.verified_subject;
  IF NOT FOUND THEN RAISE EXCEPTION 'HXUV1-COWRITE-13: CHANGE_ORDER_AUTHORITY_REVOKED'; END IF;
  SELECT * INTO STRICT proposal FROM public.task_scope_change_proposals p WHERE p.id=(command_payload->>'proposal_id')::UUID;
  key_value:=command_payload->>'idempotency_key'; party_value:=context->>'party'; decision_value:=command_payload->>'decision';
  request_sha:=public.universal_v1_change_decision_request_sha256(proposal.id,
    (command_payload->>'expected_proposal_version')::INTEGER,party_value,decision_value,actor.resolved_user_id,
    command_payload->>'reason',key_value);
  SELECT a.id,a.proposal_id,a.approver_role,a.decision,a.actor_id,a.expected_proposal_version,a.reason,a.idempotency_key,a.request_sha256
    INTO approval FROM public.task_scope_change_approvals a WHERE a.idempotency_key=key_value AND a.proposal_id=proposal.id;
  IF approval.id IS NOT NULL THEN
    IF approval.request_sha256 IS DISTINCT FROM request_sha THEN
      RAISE EXCEPTION 'HXUV1-COWRITE-13: CHANGE_ORDER_IDEMPOTENCY_CONFLICT'; END IF;
    replay:=TRUE;
  ELSE
    IF proposal.proposal_version IS DISTINCT FROM (command_payload->>'expected_proposal_version')::INTEGER
       OR proposal.status IS DISTINCT FROM 'PENDING' OR proposal.base_version_id IS DISTINCT FROM (context->>'scope_id')::UUID THEN
      RAISE EXCEPTION 'HXUV1-COWRITE-13: CHANGE_ORDER_VERSION_CONFLICT'; END IF;
    IF EXISTS(SELECT 1 FROM public.task_scope_change_approvals a WHERE a.proposal_id=proposal.id AND a.approver_role=party_value) THEN
      RAISE EXCEPTION 'HXUV1-COWRITE-13: CHANGE_ORDER_STATE_CONFLICT'; END IF;
    IF EXISTS(SELECT 1 FROM public.task_scope_change_approvals a WHERE a.proposal_id=proposal.id
      AND a.approver_role<>party_value AND a.actor_id=actor.resolved_user_id) THEN
      RAISE EXCEPTION 'HXUV1-COWRITE-13: CHANGE_ORDER_INDEPENDENT_APPROVAL_REQUIRED'; END IF;
    INSERT INTO public.task_scope_change_approvals AS inserted
      (proposal_id,approver_role,decision,actor_id,expected_proposal_version,reason,idempotency_key,request_sha256)
    VALUES(proposal.id,party_value,decision_value,actor.resolved_user_id,
      (command_payload->>'expected_proposal_version')::INTEGER,command_payload->>'reason',key_value,request_sha)
    RETURNING inserted.id,inserted.proposal_id,inserted.approver_role,inserted.decision,inserted.actor_id,
      inserted.expected_proposal_version,inserted.reason,inserted.idempotency_key,inserted.request_sha256 INTO approval;
    IF approval.id IS NULL THEN RAISE EXCEPTION 'HXUV1-COWRITE-13: CHANGE_ORDER_MATERIALIZATION_FAILED'; END IF;
    IF decision_value='REJECTED' THEN
      UPDATE public.task_scope_change_proposals p SET status='REJECTED',reviewed_by=actor.resolved_user_id,
        reviewed_at=pg_catalog.clock_timestamp(),decision_reason=command_payload->>'reason',updated_at=pg_catalog.clock_timestamp()
      WHERE p.id=proposal.id AND p.status='PENDING';
      GET DIAGNOSTICS changed_count=ROW_COUNT;
      IF changed_count<>1 THEN RAISE EXCEPTION 'HXUV1-COWRITE-13: CHANGE_ORDER_VERSION_CONFLICT'; END IF;
    END IF;
  END IF;
  IF pg_catalog.abs(EXTRACT(EPOCH FROM pg_catalog.clock_timestamp())*1000-
      (command_payload->>'client_timestamp_epoch_ms')::NUMERIC)>300000 THEN
    RAISE EXCEPTION 'HXUV1-COWRITE-13-CLIENT_TIMESTAMP_INVALID'; END IF;
  result:=pg_catalog.jsonb_build_object('approval_id',approval.id,'proposal_id',approval.proposal_id,
    'proposal_version',approval.expected_proposal_version,'approver_party',approval.approver_role,'decision',approval.decision,
    'proposal_status',CASE approval.decision WHEN 'REJECTED' THEN 'REJECTED' ELSE 'PENDING' END,'replayed',replay,
    'payment_creation_performed',FALSE,'hard_assignment_created',FALSE);
  actor_user_id:=actor.resolved_user_id; actor_assertion_id:=actor.assertion_id;
  actor_request_sha256:=request.actor_request_sha256; target_authority_id:=request.target_authority_id;
  command_release_sha256:=request.release_manifest_sha256;
  RETURN NEXT;
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'HXUV1-COWRITE-13: CHANGE_ORDER_IDEMPOTENCY_CONFLICT';
END;
$$;

REVOKE ALL ON FUNCTION public.universal_v1_change_scope_sha256(TEXT,TEXT,TEXT,JSONB,INTEGER,INTEGER,CHAR) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.universal_v1_change_proposal_request_sha256(UUID,UUID,UUID,TEXT,INTEGER,UUID,TEXT,TEXT,CHAR,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.universal_v1_change_decision_request_sha256(UUID,INTEGER,TEXT,TEXT,UUID,TEXT,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.hxos_build_change_order_actor_request_v13(TEXT,JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION hx_authority.lock_change_order_write_context_v13(TEXT,UUID,UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.hxos_propose_authenticated_change_order_v13(TEXT,JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.hxos_decide_authenticated_change_order_v13(TEXT,JSONB) FROM PUBLIC;

ALTER FUNCTION public.universal_v1_effective_work_order_scope_id(uuid) SET search_path = pg_catalog, public;
ALTER FUNCTION public.universal_v1_pre_work_order_void_is_authorized(uuid,text,text,bigint,bigint,uuid,uuid,uuid,uuid,uuid,uuid,bigint,text,uuid) SET search_path = pg_catalog, public;
ALTER FUNCTION public.universal_v1_fake_terminal_plan_v1(text) SET search_path = pg_catalog, public;
ALTER FUNCTION public.business_membership_has_action(uuid,uuid,text) SET search_path = pg_catalog, public;
ALTER FUNCTION public.lock_universal_v1_change_order_financial_slot_v1() SET search_path = pg_catalog, public;
ALTER FUNCTION public.enforce_universal_v1_prepared_adjustment_witness() SET search_path = pg_catalog, public;
ALTER FUNCTION public.validate_universal_v1_change_order_compensating_reversal() SET search_path = pg_catalog, public;
ALTER FUNCTION public.validate_universal_v1_pre_work_order_void() SET search_path = pg_catalog, public;

-- Independently authenticated fake-provider ingress. Private verifier keys are
-- migration-provisioned; runtime logins receive neither key reads nor a signer.
-- Authenticated observations remain observations, never financial commands.
CREATE TABLE hx_authority.fake_financial_webhook_keys_v13 (
  key_id UUID PRIMARY KEY,
  target_authority_id UUID NOT NULL REFERENCES hx_authority.universal_v1_work_order_target_authority_facts(target_authority_id),
  key_material BYTEA NOT NULL CHECK (octet_length(key_material) BETWEEN 32 AND 128),
  expires_at TIMESTAMPTZ NOT NULL CHECK (isfinite(expires_at)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  created_transaction_id XID8 NOT NULL DEFAULT pg_current_xact_id(),
  CHECK (expires_at > created_at)
);
CREATE TABLE hx_authority.fake_financial_webhook_key_revocations_v13 (
  key_id UUID PRIMARY KEY REFERENCES hx_authority.fake_financial_webhook_keys_v13(key_id),
  revoked_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  recording_transaction_id XID8 NOT NULL DEFAULT pg_current_xact_id()
);
CREATE TABLE hx_authority.fake_financial_webhook_verifications_v13 (
  receipt_id UUID PRIMARY KEY REFERENCES public.provider_event_inbox_receipts(receipt_id),
  observation_id UUID NOT NULL REFERENCES public.provider_event_inbox_observations(observation_id),
  key_id UUID NOT NULL REFERENCES hx_authority.fake_financial_webhook_keys_v13(key_id),
  target_authority_id UUID NOT NULL REFERENCES hx_authority.universal_v1_work_order_target_authority_facts(target_authority_id),
  signed_payload_sha256 CHAR(64) NOT NULL CHECK (signed_payload_sha256 ~ '^[0-9a-f]{64}$'),
  authentication_evidence_sha256 CHAR(64) NOT NULL CHECK (authentication_evidence_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  recording_transaction_id XID8 NOT NULL DEFAULT pg_current_xact_id()
);

CREATE FUNCTION hx_authority.guard_fake_financial_webhook_key_v13()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE
SET search_path = pg_catalog AS $$
DECLARE target RECORD;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'HXUV1-FINHOOK-13: CURRENT_SNAPSHOT_REQUIRED' USING ERRCODE='P0001';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('hxuv1-work-order-target-authority-v1',0));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('hxuv1-fake-webhook-key-v13:'||NEW.key_id::TEXT,0));
  IF TG_TABLE_NAME = 'fake_financial_webhook_keys_v13' THEN
    SELECT * INTO target FROM hx_authority.universal_v1_work_order_target_authority_facts
      WHERE target_authority_id=NEW.target_authority_id;
    IF target.target_authority_id IS NULL OR target.target_database_name<>pg_catalog.current_database()
       OR target.environment NOT IN ('local','preview','staging')
       OR EXISTS(SELECT 1 FROM hx_authority.universal_v1_work_order_target_authority_facts
         WHERE supersedes_target_authority_id=NEW.target_authority_id) THEN
      RAISE EXCEPTION 'HXUV1-FINHOOK-13: KEY_TARGET_INVALID' USING ERRCODE='P0001';
    END IF;
    NEW.created_at:=pg_catalog.clock_timestamp();
    NEW.created_transaction_id:=pg_catalog.pg_current_xact_id();
  ELSIF TG_TABLE_NAME = 'fake_financial_webhook_key_revocations_v13' THEN
    NEW.revoked_at:=pg_catalog.clock_timestamp();
    NEW.recording_transaction_id:=pg_catalog.pg_current_xact_id();
  ELSE
    RAISE EXCEPTION 'HXUV1-FINHOOK-13: KEY_RELATION_INVALID' USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER fake_financial_webhook_keys_guard_v13 BEFORE INSERT ON hx_authority.fake_financial_webhook_keys_v13
  FOR EACH ROW EXECUTE FUNCTION hx_authority.guard_fake_financial_webhook_key_v13();
CREATE TRIGGER fake_financial_webhook_revocations_guard_v13 BEFORE INSERT ON hx_authority.fake_financial_webhook_key_revocations_v13
  FOR EACH ROW EXECUTE FUNCTION hx_authority.guard_fake_financial_webhook_key_v13();

CREATE FUNCTION hx_authority.mark_fake_financial_webhook_verification_v13()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE
SET search_path = pg_catalog AS $$
BEGIN
  NEW.recorded_at:=pg_catalog.clock_timestamp();
  NEW.recording_transaction_id:=pg_catalog.pg_current_xact_id();
  RETURN NEW;
END;
$$;
CREATE TRIGGER fake_financial_webhook_verification_transaction_v13
  BEFORE INSERT ON hx_authority.fake_financial_webhook_verifications_v13
  FOR EACH ROW EXECUTE FUNCTION hx_authority.mark_fake_financial_webhook_verification_v13();

DO $$
DECLARE relation_name TEXT;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY['fake_financial_webhook_keys_v13',
    'fake_financial_webhook_key_revocations_v13','fake_financial_webhook_verifications_v13'] LOOP
    EXECUTE pg_catalog.format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON hx_authority.%I FOR EACH ROW EXECUTE FUNCTION hx_authority.reject_fake_financial_outbox_mutation_v13()',relation_name||'_immutable',relation_name);
    EXECUTE pg_catalog.format('CREATE TRIGGER %I BEFORE TRUNCATE ON hx_authority.%I FOR EACH STATEMENT EXECUTE FUNCTION hx_authority.reject_fake_financial_outbox_mutation_v13()',relation_name||'_no_truncate',relation_name);
  END LOOP;
END;
$$;

-- Remove the legacy digest extension dependency without changing its bytes or
-- invariant. HMAC below still uses the pinned, standard pgcrypto implementation.
DO $$
DECLARE constraint_names TEXT[];
BEGIN
  SELECT pg_catalog.array_agg(c.conname ORDER BY c.conname) INTO constraint_names
    FROM pg_catalog.pg_constraint c
    WHERE c.conrelid='public.provider_event_inbox_observations'::pg_catalog.regclass
      AND c.contype='c' AND EXISTS(SELECT 1 FROM pg_catalog.pg_depend d
        WHERE d.classid='pg_catalog.pg_constraint'::pg_catalog.regclass AND d.objid=c.oid
          AND d.refclassid='pg_catalog.pg_proc'::pg_catalog.regclass
          AND d.refobjid=pg_catalog.to_regprocedure('public.digest(bytea,text)'));
  IF pg_catalog.cardinality(constraint_names) IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'HXUV1-FINHOOK-13: INBOX_DIGEST_CONSTRAINT_DRIFT' USING ERRCODE='P0001';
  END IF;
  EXECUTE pg_catalog.format('ALTER TABLE public.provider_event_inbox_observations DROP CONSTRAINT %I',constraint_names[1]);
END;
$$;
ALTER TABLE public.provider_event_inbox_observations
  ADD CONSTRAINT provider_event_inbox_observations_raw_payload_sha256_check CHECK (
    raw_payload_sha256 ~ '^[0-9a-f]{64}$'
    AND raw_payload_sha256=pg_catalog.encode(pg_catalog.sha256(raw_payload),'hex'));
ALTER FUNCTION public.initialize_provider_event_processing_state() SET search_path=pg_catalog,public;
ALTER FUNCTION public.reject_provider_event_inbox_mutation() SET search_path=pg_catalog,public;
ALTER FUNCTION public.validate_provider_event_processing_state_transition() SET search_path=pg_catalog,public;
ALTER FUNCTION public.reject_provider_event_processing_state_removal() SET search_path=pg_catalog,public;

CREATE FUNCTION public.hxos_record_authenticated_fake_financial_webhook_v13(
  p_key_id UUID,p_raw_payload BYTEA,p_signature TEXT,p_ingress_idempotency_key TEXT
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE
SET search_path=pg_catalog AS $$
DECLARE
  key_record RECORD; target RECORD; payload JSONB; raw_json JSON; field_name TEXT;
  signed_bytes BYTEA; expected_signature BYTEA; supplied_signature BYTEA; signature_difference INTEGER:=0;
  byte_index INTEGER; authentication_hash TEXT; raw_hash TEXT; request_hash TEXT; ingress_key TEXT;
  observation public.provider_event_inbox_observations%ROWTYPE;
  receipt public.provider_event_inbox_receipts%ROWTYPE;
  verification hx_authority.fake_financial_webhook_verifications_v13%ROWTYPE;
  event_replayed BOOLEAN:=FALSE; receipt_replayed BOOLEAN:=FALSE; now_at TIMESTAMPTZ;
  expected_fields CONSTANT TEXT[]:=ARRAY['version','kind','providerKind','providerEventReference','operationId',
    'operationKind','predecessorProviderVersion','observedProviderVersion','observedState','externalReference',
    'amountCents','currency','providerOccurredAt'];
BEGIN
  -- A transaction-wide historical snapshot cannot observe a revocation that
  -- commits while this call waits for its serialized authority locks.
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'HXUV1-FINHOOK-13: CURRENT_SNAPSHOT_REQUIRED' USING ERRCODE='P0001';
  END IF;
  IF p_raw_payload IS NULL OR pg_catalog.octet_length(p_raw_payload) NOT BETWEEN 2 AND 16384 THEN
    RAISE EXCEPTION 'HXUV1-FINHOOK-13: PAYLOAD_INVALID' USING ERRCODE='P0001';
  END IF;
  IF p_key_id IS NULL OR p_signature IS NULL OR p_signature !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'HXUV1-FINHOOK-13: SIGNATURE_INVALID' USING ERRCODE='P0001';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('hxuv1-work-order-target-authority-v1',0));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('hxuv1-fake-webhook-key-v13:'||p_key_id::TEXT,0));
  SELECT * INTO key_record FROM hx_authority.fake_financial_webhook_keys_v13 WHERE key_id=p_key_id;
  IF key_record.key_id IS NULL OR key_record.created_transaction_id=pg_catalog.pg_current_xact_id()
     OR key_record.expires_at<=pg_catalog.clock_timestamp()
     OR EXISTS(SELECT 1 FROM hx_authority.fake_financial_webhook_key_revocations_v13 WHERE key_id=p_key_id) THEN
    RAISE EXCEPTION 'HXUV1-FINHOOK-13: SIGNATURE_INVALID' USING ERRCODE='P0001';
  END IF;
  SELECT * INTO target FROM hx_authority.universal_v1_work_order_target_authority_facts
    WHERE target_authority_id=key_record.target_authority_id;
  PERFORM hx_authority.assert_fake_financial_outbox_target_v13(target.target_authority_id,
    target.target_database_name,target.environment,target.release_manifest_sha256);

  -- A substituted SQL function with the same name must not become a verifier.
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_language l ON l.oid=p.prolang
    JOIN pg_catalog.pg_depend d ON d.classid='pg_catalog.pg_proc'::pg_catalog.regclass
      AND d.objid=p.oid AND d.refclassid='pg_catalog.pg_extension'::pg_catalog.regclass AND d.deptype='e'
    JOIN pg_catalog.pg_extension e ON e.oid=d.refobjid
    WHERE p.oid=pg_catalog.to_regprocedure('public.hmac(bytea,bytea,text)')
      AND e.extname='pgcrypto' AND e.extversion='1.3' AND p.pronargdefaults=0 AND p.provariadic=0 AND e.extnamespace='public'::pg_catalog.regnamespace
      AND l.lanname='c' AND p.prosrc='pg_hmac' AND p.probin='$libdir/pgcrypto'
      AND p.prorettype='bytea'::pg_catalog.regtype AND p.prokind='f'
      AND p.proisstrict AND NOT p.prosecdef AND p.provolatile='i' AND p.proparallel='s'
      AND p.proconfig IS NULL) THEN
    RAISE EXCEPTION 'HXUV1-FINHOOK-13: VERIFIER_UNAVAILABLE' USING ERRCODE='P0001';
  END IF;
  signed_bytes:=pg_catalog.convert_to('HUSTLEXP_FAKE_FINANCIAL_WEBHOOK_V13','UTF8')||pg_catalog.decode('00','hex')
    ||pg_catalog.convert_to(p_key_id::TEXT,'UTF8')||pg_catalog.decode('00','hex')
    ||pg_catalog.convert_to(target.target_authority_id::TEXT,'UTF8')||pg_catalog.decode('00','hex')
    ||pg_catalog.convert_to(target.authority_version::TEXT,'UTF8')||pg_catalog.decode('00','hex')
    ||pg_catalog.convert_to(target.target_database_name,'UTF8')||pg_catalog.decode('00','hex')
    ||pg_catalog.convert_to(target.environment,'UTF8')||pg_catalog.decode('00','hex')
    ||pg_catalog.convert_to(target.release_manifest_sha256,'UTF8')||pg_catalog.decode('00','hex')||p_raw_payload;
  expected_signature:=public.hmac(signed_bytes,key_record.key_material,'sha256');
  supplied_signature:=pg_catalog.decode(p_signature,'hex');
  -- Compare all 32 bytes without an early-exit prefix comparison.
  FOR byte_index IN 0..31 LOOP
    signature_difference:=signature_difference | (pg_catalog.get_byte(expected_signature,byte_index)
      # pg_catalog.get_byte(supplied_signature,byte_index));
  END LOOP;
  IF signature_difference<>0 THEN
    RAISE EXCEPTION 'HXUV1-FINHOOK-13: SIGNATURE_INVALID' USING ERRCODE='P0001';
  END IF;
  BEGIN
    raw_json:=pg_catalog.convert_from(p_raw_payload,'UTF8')::JSON;
    payload:=raw_json::JSONB;
    IF pg_catalog.json_typeof(raw_json)<>'object'
       OR (SELECT count(*) FROM pg_catalog.json_each(raw_json))<>13
       OR (SELECT count(DISTINCT key) FROM pg_catalog.json_each(raw_json))<>13
       OR NOT payload ?& expected_fields OR payload-expected_fields<>'{}'::JSONB THEN
      RAISE EXCEPTION 'invalid fields';
    END IF;
    FOREACH field_name IN ARRAY ARRAY['version','kind','providerKind','providerEventReference','operationId',
      'operationKind','observedState','externalReference','providerOccurredAt'] LOOP
      IF pg_catalog.jsonb_typeof(payload->field_name)<>'string' THEN RAISE EXCEPTION 'invalid string'; END IF;
    END LOOP;
    IF payload->>'version'<>'HX_SYNTHETIC_FINANCIAL_OBSERVATION_V1'
       OR payload->>'kind'<>'FINANCIAL_OPERATION_OBSERVED' OR payload->>'providerKind'<>'FAKE'
       OR payload->>'operationId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       OR payload->>'operationKind' NOT IN ('PREPARE_PAYMENT_METHOD','AUTHORIZE','SECURE','VOID','ADJUST','CAPTURE',
         'REFUND','REVERSAL','SETTLE','FUND','PROVIDER_RELEASE','PAYOUT','OBSERVE_BANK_SETTLEMENT')
       OR payload->>'observedState' NOT IN ('UNKNOWN','PENDING','RETRYABLE_FAILURE','SUCCEEDED','DECLINED','FAILED',
         'VOIDED','REFUNDED','PARTIALLY_REFUNDED','REVERSED') THEN RAISE EXCEPTION 'invalid identity'; END IF;
    FOREACH field_name IN ARRAY ARRAY['providerEventReference','externalReference'] LOOP
      IF pg_catalog.length(payload->>field_name) NOT BETWEEN 3 AND (CASE field_name WHEN 'providerEventReference' THEN 255 ELSE 256 END)
         OR payload->>field_name<>pg_catalog.btrim(payload->>field_name)
         OR payload->>field_name ~ '[[:cntrl:]]' THEN RAISE EXCEPTION 'invalid reference'; END IF;
    END LOOP;
    FOREACH field_name IN ARRAY ARRAY['predecessorProviderVersion','observedProviderVersion'] LOOP
      IF pg_catalog.jsonb_typeof(payload->field_name)<>'number'
         OR (payload->>field_name)::NUMERIC NOT BETWEEN 0 AND 9007199254740991
         OR pg_catalog.trunc((payload->>field_name)::NUMERIC)<>(payload->>field_name)::NUMERIC THEN
        RAISE EXCEPTION 'invalid version';
      END IF;
    END LOOP;
    IF (payload->>'observedProviderVersion')::NUMERIC<>(payload->>'predecessorProviderVersion')::NUMERIC+1 THEN
      RAISE EXCEPTION 'noncausal version';
    END IF;
    IF payload->>'operationKind'='PREPARE_PAYMENT_METHOD' THEN
      IF payload->'amountCents'<>'null'::JSONB OR payload->'currency'<>'null'::JSONB THEN RAISE EXCEPTION 'invalid value'; END IF;
    ELSIF pg_catalog.jsonb_typeof(payload->'amountCents')<>'number' OR pg_catalog.jsonb_typeof(payload->'currency')<>'string'
       OR payload->>'currency' !~ '^[A-Z]{3}$' OR (payload->>'amountCents')::NUMERIC NOT BETWEEN 1 AND 9007199254740991
       OR pg_catalog.trunc((payload->>'amountCents')::NUMERIC)<>(payload->>'amountCents')::NUMERIC THEN
      RAISE EXCEPTION 'invalid value';
    END IF;
    IF payload->>'providerOccurredAt' !~ '^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,6})?Z$'
       OR NOT pg_catalog.isfinite((payload->>'providerOccurredAt')::TIMESTAMPTZ) THEN RAISE EXCEPTION 'invalid time'; END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'HXUV1-FINHOOK-13: PAYLOAD_INVALID' USING ERRCODE='P0001';
  END;
  raw_hash:=pg_catalog.encode(pg_catalog.sha256(p_raw_payload),'hex');
  authentication_hash:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('HUSTLEXP_FAKE_FINANCIAL_WEBHOOK_AUTH_V13','UTF8')
    ||pg_catalog.decode('00','hex')||signed_bytes||supplied_signature),'hex');
  ingress_key:=COALESCE(p_ingress_idempotency_key,'provider-event:'||pg_catalog.encode(pg_catalog.sha256(
    pg_catalog.convert_to('FAKE','UTF8')||pg_catalog.decode('00','hex')||pg_catalog.convert_to(payload->>'providerEventReference','UTF8')),'hex'));
  IF ingress_key !~ '^[A-Za-z0-9:_-]{16,128}$' THEN
    RAISE EXCEPTION 'HXUV1-FINHOOK-13: IDEMPOTENCY_INVALID' USING ERRCODE='P0001';
  END IF;
  request_hash:=hx_authority.fake_financial_job_digest_v13(ARRAY['HX_FAKE_WEBHOOK_RECEIPT_V13',
    p_key_id::TEXT,target.target_authority_id::TEXT,ingress_key,raw_hash,authentication_hash]);
  -- Same ordering/namespaces as the legacy inbox writer serialize exact events
  -- and delivery keys without adopting that writer's caller-VERIFIED receipts.
  FOR field_name IN SELECT unnest(ARRAY['event:FAKE:'||(payload->>'providerEventReference'),'idempotency:'||ingress_key]) ORDER BY 1 LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('provider-event-inbox-v1'),pg_catalog.hashtext(field_name));
  END LOOP;
  now_at:=pg_catalog.clock_timestamp();
  IF key_record.expires_at<=now_at THEN
    RAISE EXCEPTION 'HXUV1-FINHOOK-13: SIGNATURE_INVALID' USING ERRCODE='P0001';
  END IF;
  SELECT * INTO receipt FROM public.provider_event_inbox_receipts WHERE ingress_idempotency_key=ingress_key;
  IF receipt.receipt_id IS NOT NULL THEN
    SELECT * INTO verification FROM hx_authority.fake_financial_webhook_verifications_v13 WHERE receipt_id=receipt.receipt_id;
    IF receipt.request_sha256<>request_hash OR verification.receipt_id IS NULL
       OR verification.key_id<>p_key_id OR verification.target_authority_id<>target.target_authority_id THEN
      RAISE EXCEPTION 'HXUV1-FINHOOK-13: IDEMPOTENCY_CONFLICT' USING ERRCODE='P0001';
    END IF;
    SELECT * INTO observation FROM public.provider_event_inbox_observations WHERE observation_id=receipt.observation_id;
    event_replayed:=TRUE; receipt_replayed:=TRUE;
  ELSE
    SELECT * INTO observation FROM public.provider_event_inbox_observations
      WHERE provider_kind='FAKE' AND provider_event_reference=payload->>'providerEventReference';
    event_replayed:=observation.observation_id IS NOT NULL;
    IF event_replayed AND (observation.raw_payload<>p_raw_payload
       OR observation.operation_id<>(payload->>'operationId')::UUID
       OR observation.provider_event_kind<>'FINANCIAL_OPERATION_OBSERVED') THEN
      RAISE EXCEPTION 'HXUV1-FINHOOK-13: EVENT_CONFLICT' USING ERRCODE='P0001';
    END IF;
    IF NOT event_replayed THEN
      INSERT INTO public.provider_event_inbox_observations(provider_kind,provider_event_reference,provider_event_kind,
        operation_id,raw_payload,raw_payload_sha256,raw_payload_bytes,first_received_at)
      VALUES('FAKE',payload->>'providerEventReference','FINANCIAL_OPERATION_OBSERVED',(payload->>'operationId')::UUID,
        p_raw_payload,raw_hash,pg_catalog.octet_length(p_raw_payload),now_at) RETURNING * INTO observation;
    END IF;
    INSERT INTO public.provider_event_inbox_receipts(observation_id,ingress_idempotency_key,request_sha256,
      authentication_status,authentication_scheme,authentication_evidence_sha256,authenticated_at,received_at)
    VALUES(observation.observation_id,ingress_key,request_hash,'VERIFIED','HMAC_SHA256_TARGET_V13',authentication_hash,now_at,now_at)
      RETURNING * INTO receipt;
    INSERT INTO hx_authority.fake_financial_webhook_verifications_v13(receipt_id,observation_id,key_id,target_authority_id,
      signed_payload_sha256,authentication_evidence_sha256)
    VALUES(receipt.receipt_id,observation.observation_id,p_key_id,target.target_authority_id,
      pg_catalog.encode(pg_catalog.sha256(signed_bytes),'hex'),authentication_hash) RETURNING * INTO verification;
  END IF;
  -- Foreign-key/trigger locks can also wait during inserts. Refuse the complete
  -- transaction if the verification window expired before it can return.
  IF key_record.expires_at<=pg_catalog.clock_timestamp() THEN
    RAISE EXCEPTION 'HXUV1-FINHOOK-13: SIGNATURE_INVALID' USING ERRCODE='P0001';
  END IF;
  RETURN pg_catalog.jsonb_build_object('observationId',observation.observation_id,'receiptId',receipt.receipt_id,
    'providerKind',observation.provider_kind,'providerEventReference',observation.provider_event_reference,
    'providerEventKind',observation.provider_event_kind,'operationId',observation.operation_id,
    'rawPayloadSha256',observation.raw_payload_sha256,'rawPayloadBytes',observation.raw_payload_bytes,
    'ingressIdempotencyKey',receipt.ingress_idempotency_key,'authenticationScheme',receipt.authentication_scheme,
    'authenticationEvidenceSha256',receipt.authentication_evidence_sha256,'authenticatedAt',receipt.authenticated_at,
    'firstReceivedAt',observation.first_received_at,'receivedAt',receipt.received_at,
    'observationReplayed',event_replayed,'idempotencyReplayed',receipt_replayed,
    'keyId',verification.key_id,'targetAuthorityId',verification.target_authority_id,
    'targetAuthorityVersion',target.authority_version,'targetDatabaseName',target.target_database_name,
    'environment',target.environment,'releaseManifestSha256',target.release_manifest_sha256,
    'signedPayloadSha256',verification.signed_payload_sha256);
END;
$$;
REVOKE ALL ON TABLE hx_authority.fake_financial_webhook_keys_v13,
  hx_authority.fake_financial_webhook_key_revocations_v13,hx_authority.fake_financial_webhook_verifications_v13 FROM PUBLIC;
REVOKE ALL ON FUNCTION hx_authority.guard_fake_financial_webhook_key_v13(),
  hx_authority.mark_fake_financial_webhook_verification_v13(),
  public.hxos_record_authenticated_fake_financial_webhook_v13(UUID,BYTEA,TEXT,TEXT) FROM PUBLIC;


-- Terminal observations refine the original dispatched operation version.
-- Authentication is historical: expiry/revocation after a committed receipt
-- does not erase it. No current-target substitution or new dispatch is allowed.
ALTER TABLE public.financial_provider_command_outcome_facts
  ADD CONSTRAINT fake_financial_resolution_verified_receipt_v13_fk
    FOREIGN KEY (resolution_receipt_id)
    REFERENCES hx_authority.fake_financial_webhook_verifications_v13(receipt_id);

CREATE OR REPLACE FUNCTION hx_authority.read_fake_financial_terminal_observation_v13(
  p_job_validation_id UUID, p_observation_id UUID, p_receipt_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
DECLARE
  admission JSONB;
  recovered RECORD;
  original JSONB;
  candidate RECORD;
  payload JSONB;
  selected JSONB;
  signed_bytes BYTEA;
  expected_success TEXT;
  occurred_at TIMESTAMPTZ;
  expires_at TIMESTAMPTZ;
  projected_sha TEXT;
  resolution_sha TEXT;
BEGIN
  IF p_job_validation_id IS NULL OR (p_observation_id IS NULL)<>(p_receipt_id IS NULL) THEN
    RAISE EXCEPTION 'HXUV1-FINRESOLUTION-13-INPUT_INVALID';
  END IF;
  admission:=hx_authority.read_fake_financial_outcome_admission_v13(p_job_validation_id);
  SELECT * INTO recovered FROM public.hxos_read_fake_financial_recovery_evidence_v13(
    (admission->>'outbox_request_id')::UUID,admission->>'bullmq_job_id',admission->>'job_authority_sha256');
  original:=recovered.provider_event;
  IF recovered.admission_evidence IS DISTINCT FROM admission OR original IS NULL
     OR original->>'state' NOT IN ('PENDING','RETRYABLE_FAILURE')
     OR (original->>'retryable')::BOOLEAN IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'HXUV1-FINRESOLUTION-13-ORIGINAL_PENDING_EVENT_REQUIRED';
  END IF;
  expected_success:=CASE admission->>'operation_kind'
    WHEN 'VOID' THEN 'VOIDED' WHEN 'REVERSAL' THEN 'REVERSED'
    WHEN 'REFUND' THEN CASE WHEN (original->>'amount_cents')::BIGINT
      <((admission->>'canonical_provider_request')::JSONB->>'originalAmountCents')::BIGINT
      THEN 'PARTIALLY_REFUNDED' ELSE 'REFUNDED' END
    ELSE 'SUCCEEDED' END;
  FOR candidate IN
    SELECT o.observation_id,o.provider_event_reference,o.provider_event_kind,o.raw_payload,
      o.raw_payload_sha256,o.raw_payload_bytes,r.receipt_id,r.authentication_scheme,
      r.authentication_evidence_sha256,r.authenticated_at,r.received_at,
      v.key_id,v.target_authority_id,v.signed_payload_sha256,
      v.authentication_evidence_sha256 AS verification_authentication_sha256,
      v.recorded_at AS verified_at,v.recording_transaction_id,
      k.created_at AS key_created_at,k.expires_at AS key_expires_at,
      t.authority_version,t.target_database_name,t.environment,t.release_manifest_sha256
    FROM public.provider_event_inbox_observations o
    JOIN hx_authority.fake_financial_webhook_verifications_v13 v ON v.observation_id=o.observation_id
    JOIN public.provider_event_inbox_receipts r ON r.receipt_id=v.receipt_id AND r.observation_id=o.observation_id
    JOIN hx_authority.fake_financial_webhook_keys_v13 k ON k.key_id=v.key_id AND k.target_authority_id=v.target_authority_id
    JOIN hx_authority.universal_v1_work_order_target_authority_facts t ON t.target_authority_id=v.target_authority_id
    WHERE o.provider_kind='FAKE' AND o.operation_id=(admission->>'operation_id')::UUID
      AND v.target_authority_id=(admission->>'target_authority_id')::UUID
      AND (p_observation_id IS NULL OR (o.observation_id=p_observation_id AND r.receipt_id=p_receipt_id))
    ORDER BY o.first_received_at,r.received_at,r.receipt_id
  LOOP
    -- Verification and receipt must precede this outer transaction, including
    -- a released savepoint. New inbox rows never grant tentative resolution.
    IF candidate.recording_transaction_id=pg_catalog.pg_current_xact_id_if_assigned() THEN
      RAISE EXCEPTION 'HXUV1-FINRESOLUTION-13-COMMITTED_VERIFICATION_REQUIRED';
    END IF;
    payload:=pg_catalog.convert_from(candidate.raw_payload,'UTF8')::JSONB;
    IF payload->>'observedState' IN ('UNKNOWN','PENDING','RETRYABLE_FAILURE') THEN
      IF p_observation_id IS NOT NULL THEN RAISE EXCEPTION 'HXUV1-FINRESOLUTION-13-TERMINAL_REQUIRED'; END IF;
      CONTINUE;
    END IF;
    -- Other versions, stale observations, or different request/value/reference
    -- bindings are retained inbox evidence, not competing results of this exact
    -- dispatch. Explicit historical replay still validates its selected receipt.
    IF p_observation_id IS NULL AND (
      payload->>'operationKind' IS DISTINCT FROM admission->>'operation_kind'
      OR (payload->>'predecessorProviderVersion')::NUMERIC<>(admission->>'provider_expected_version')::BIGINT
      OR (payload->>'observedProviderVersion')::NUMERIC<>(original->>'event_version')::BIGINT
      OR payload->>'externalReference' IS DISTINCT FROM original->>'external_reference'
      OR (payload->>'amountCents')::NUMERIC IS DISTINCT FROM (original->>'amount_cents')::BIGINT
      OR payload->>'currency' IS DISTINCT FROM pg_catalog.upper(original->>'currency')
      OR (payload->>'providerOccurredAt')::TIMESTAMPTZ<(original->>'recorded_at')::TIMESTAMPTZ
    ) THEN CONTINUE; END IF;
    signed_bytes:=pg_catalog.convert_to('HUSTLEXP_FAKE_FINANCIAL_WEBHOOK_V13','UTF8')||pg_catalog.decode('00','hex')
      ||pg_catalog.convert_to(candidate.key_id::TEXT,'UTF8')||pg_catalog.decode('00','hex')
      ||pg_catalog.convert_to(candidate.target_authority_id::TEXT,'UTF8')||pg_catalog.decode('00','hex')
      ||pg_catalog.convert_to(candidate.authority_version::TEXT,'UTF8')||pg_catalog.decode('00','hex')
      ||pg_catalog.convert_to(candidate.target_database_name,'UTF8')||pg_catalog.decode('00','hex')
      ||pg_catalog.convert_to(candidate.environment,'UTF8')||pg_catalog.decode('00','hex')
      ||pg_catalog.convert_to(candidate.release_manifest_sha256,'UTF8')||pg_catalog.decode('00','hex')||candidate.raw_payload;
    occurred_at:=(payload->>'providerOccurredAt')::TIMESTAMPTZ;
    IF payload->>'providerOccurredAt' !~ '^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,6})?Z$'
       OR candidate.provider_event_kind<>'FINANCIAL_OPERATION_OBSERVED'
       OR payload->>'providerEventReference'<>candidate.provider_event_reference
       OR payload->>'operationId'<>admission->>'operation_id'
       OR payload->>'operationKind'<>admission->>'operation_kind'
       OR (payload->>'predecessorProviderVersion')::NUMERIC::BIGINT<>(admission->>'provider_expected_version')::BIGINT
       OR (payload->>'observedProviderVersion')::NUMERIC::BIGINT<>(original->>'event_version')::BIGINT
       OR payload->>'externalReference' IS DISTINCT FROM original->>'external_reference'
       OR (payload->>'amountCents')::NUMERIC::BIGINT IS DISTINCT FROM (original->>'amount_cents')::BIGINT
       OR payload->>'currency' IS DISTINCT FROM pg_catalog.upper(original->>'currency')
       OR payload->>'observedState' NOT IN (expected_success,'FAILED','DECLINED')
       OR candidate.raw_payload_sha256<>pg_catalog.encode(pg_catalog.sha256(candidate.raw_payload),'hex')
       OR candidate.raw_payload_bytes<>pg_catalog.octet_length(candidate.raw_payload)
       OR candidate.signed_payload_sha256<>pg_catalog.encode(pg_catalog.sha256(signed_bytes),'hex')
       OR candidate.authentication_scheme<>'HMAC_SHA256_TARGET_V13'
       OR candidate.authentication_evidence_sha256<>candidate.verification_authentication_sha256
       OR candidate.authority_version<>(admission->>'target_authority_version')::INTEGER
       OR candidate.target_database_name<>admission->>'target_database_name'
       OR candidate.environment<>admission->>'release_environment'
       OR candidate.release_manifest_sha256<>admission->>'release_manifest_digest'
       OR candidate.authenticated_at<>candidate.received_at
       OR candidate.authenticated_at<candidate.key_created_at
       OR candidate.verified_at<candidate.authenticated_at OR candidate.verified_at>=candidate.key_expires_at
       OR occurred_at<(original->>'recorded_at')::TIMESTAMPTZ OR occurred_at>candidate.authenticated_at THEN
      RAISE EXCEPTION 'HXUV1-FINRESOLUTION-13-OBSERVATION_BINDING_MISMATCH';
    END IF;
    -- Contract 1 uses the existing fake provider's 15-minute successful
    -- authorization/security/adjustment rule, anchored to signed provider time.
    -- Worker processing time cannot renew financial security.
    expires_at:=CASE WHEN payload->>'observedState'='SUCCEEDED'
      AND admission->>'operation_kind' IN ('AUTHORIZE','SECURE','ADJUST')
      THEN occurred_at+interval '15 minutes' ELSE NULL END;
    projected_sha:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
      (admission->>'operation_id')||':'||(admission->>'operation_kind')||':FAKE:'||
      (payload->>'observedState')||':'||((payload->>'observedProviderVersion')::NUMERIC::BIGINT)::TEXT||':'||
      COALESCE(((payload->>'amountCents')::NUMERIC::BIGINT)::TEXT,'')||':'||COALESCE(payload->>'currency','')||':'||
      pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(payload->>'externalReference','UTF8')),'hex')||':false','UTF8')),'hex');
    IF selected IS NOT NULL THEN
      IF selected->>'provider_result_sha256'<>projected_sha
         OR (selected->>'provider_occurred_at')::TIMESTAMPTZ IS DISTINCT FROM occurred_at
         OR (selected->>'provider_expires_at')::TIMESTAMPTZ IS DISTINCT FROM expires_at THEN
        RAISE EXCEPTION 'HXUV1-FINRESOLUTION-13-CONFLICTING_TERMINAL_OBSERVATIONS';
      END IF;
      CONTINUE;
    END IF;
    resolution_sha:=hx_authority.fake_financial_job_digest_v13(ARRAY[
      'HX_FAKE_TERMINAL_OBSERVATION_RESOLUTION_V13','1',admission->>'command_id',p_job_validation_id::TEXT,
      admission->>'dispatch_attempt_id',original->>'event_id',original->>'response_sha256',
      admission->>'provider_request_sha256',candidate.observation_id::TEXT,candidate.receipt_id::TEXT,
      candidate.raw_payload_sha256,candidate.authentication_evidence_sha256,
      candidate.signed_payload_sha256,candidate.target_authority_id::TEXT,projected_sha,
      ((extract(epoch FROM occurred_at)*1000000)::BIGINT)::TEXT,
      COALESCE(((extract(epoch FROM expires_at)*1000000)::BIGINT)::TEXT,'')]);
    selected:=pg_catalog.jsonb_build_object(
      'contract_version',1,'observation_id',candidate.observation_id,'receipt_id',candidate.receipt_id,
      'key_id',candidate.key_id,'target_authority_id',candidate.target_authority_id,
      'raw_payload',pg_catalog.convert_from(candidate.raw_payload,'UTF8'),
      'raw_payload_sha256',candidate.raw_payload_sha256,'signed_payload_sha256',candidate.signed_payload_sha256,
      'authentication_evidence_sha256',candidate.authentication_evidence_sha256,
      'authenticated_at',candidate.authenticated_at,'verified_at',candidate.verified_at,
      'provider_occurred_at',occurred_at,'provider_expires_at',expires_at,
      'provider_result_sha256',projected_sha,'resolution_identity_sha256',resolution_sha);
  END LOOP;
  IF p_observation_id IS NOT NULL AND selected IS NULL THEN
    RAISE EXCEPTION 'HXUV1-FINRESOLUTION-13-VERIFIED_OBSERVATION_NOT_FOUND';
  END IF;
  RETURN selected;
END;
$$;
REVOKE ALL ON FUNCTION hx_authority.read_fake_financial_terminal_observation_v13(UUID,UUID,UUID) FROM PUBLIC;


-- Hostile ALTER DEFAULT PRIVILEGES rules may target every future relation or
-- function, including invoker ports. Strip every non-owner ACL across the
-- complete frozen v13 inventory. The eight-role bootstrap must later assign
-- sealed owners and only its exact role-specific grants. Owner-role membership
-- is also rejected because it would inherit owner authority outside that ACL.
DO $$
DECLARE
  object_record RECORD;
  privilege_record RECORD;
  grantee_sql TEXT;
  unsafe_membership TEXT;
BEGIN
  FOR object_record IN
    SELECT expected.object_identity,
           relation_state.oid AS object_oid,
           relation_state.relowner AS owner_oid,
           relation_state.relacl AS object_acl
      FROM (VALUES
        ('hx_authority.fake_financial_webhook_keys_v13'),
        ('hx_authority.fake_financial_webhook_key_revocations_v13'),
        ('hx_authority.fake_financial_webhook_verifications_v13'),
        ('public.provider_event_processing_state'),
        ('public.provider_event_inbox_observations'),
        ('public.provider_event_inbox_receipts'),
        ('public.universal_v1_change_order_recovery_terminal_facts'),
        ('public.task_reconciliation_facts'),
        ('hx_authority.fake_financial_preparation_authority_v13'),
        ('hx_authority.fake_financial_exact_requests_v13'),
        ('hx_authority.fake_financial_command_outbox_requests_v13'),
        ('hx_authority.fake_financial_outbox_publish_claims_v13'),
        ('hx_authority.fake_financial_outbox_publish_outcomes_v13'),
        ('hx_authority.fake_financial_outbox_dispositions_v13'),
        ('hx_authority.fake_financial_publish_exhaustions_v13'),
        ('hx_authority.fake_financial_dispatch_admissions_v13'),
        ('hx_authority.fake_financial_job_validations_v13'),
        ('hx_authority.fake_financial_webhook_inert_evidence_v13'),
        ('hx_authority.fake_financial_webhook_rejection_receipts_v13'),
        ('public.task_financial_operations'),
        ('public.task_scope_change_proposals'),
        ('public.task_scope_change_approvals'),
        ('public.task_work_order_amendments'),
        ('public.universal_v1_change_order_materialization_commands'),
        ('public.universal_v1_change_order_compensation_commands'),
        ('public.task_completion_facts'),
        ('public.hxos_fake_financial_legacy_expiry_dispositions_v9'),
        ('public.hxos_fake_financial_legacy_expiry_compensations_v9'),
        ('public.hxos_fake_financial_legacy_expiry_noncompensable_facts_v10'),
        ('public.hxos_fake_financial_operations_v1'),
        ('public.hxos_fake_financial_operation_events_v1'),
        ('public.universal_v1_fake_terminal_lifecycle_intents'),
        ('public.universal_v1_fake_provider_account_facts'),
        ('public.task_safety_incidents'),
        ('public.universal_v1_dispute_incidents'),
        ('public.universal_v1_dispute_timeline_events'),
        ('public.universal_v1_dispute_current_v1'),
        ('public.hxos_fake_financial_schema_evidence_v13')
      ) expected(object_identity)
      LEFT JOIN pg_catalog.pg_class relation_state
        ON relation_state.oid = pg_catalog.to_regclass(expected.object_identity)
  LOOP
    IF object_record.object_oid IS NULL THEN
      RAISE EXCEPTION
        'HXUV1-FINOUT-13-39: v13 relation inventory is incomplete: %',
        object_record.object_identity
        USING ERRCODE = 'P0001';
    END IF;
    FOR privilege_record IN
      SELECT DISTINCT privilege.grantee
        FROM pg_catalog.aclexplode(COALESCE(
          object_record.object_acl,
          pg_catalog.acldefault('r', object_record.owner_oid)
        )) privilege
       WHERE privilege.grantee <> object_record.owner_oid
    LOOP
      grantee_sql := CASE
        WHEN privilege_record.grantee = 0 THEN 'PUBLIC'
        ELSE pg_catalog.format(
          '%I', pg_catalog.pg_get_userbyid(privilege_record.grantee)
        )
      END;
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE %s FROM %s',
        object_record.object_identity,
        grantee_sql
      );
    END LOOP;
  END LOOP;

  FOR object_record IN
    SELECT expected.object_identity,
           function_state.oid AS object_oid,
           function_state.proowner AS owner_oid,
           function_state.proacl AS object_acl
      FROM (VALUES
        ('public.hxos_record_authenticated_fake_financial_webhook_v13(uuid,bytea,text,text)'),
        ('hx_authority.guard_fake_financial_webhook_key_v13()'),
        ('hx_authority.mark_fake_financial_webhook_verification_v13()'),
        ('public.initialize_provider_event_processing_state()'),
        ('public.reject_provider_event_inbox_mutation()'),
        ('public.validate_provider_event_processing_state_transition()'),
        ('public.reject_provider_event_processing_state_removal()'),
        ('public.hxos_read_universal_v1_fake_financial_runtime_authority_v13()'),
        ('public.hxos_read_fake_financial_schema_evidence_v13()'),
        ('public.hxos_read_fake_financial_applied_migrations_v13()'),
        ('public.hxos_read_fake_financial_bootstrap_completion_v13(text,text)'),
        ('public.hxos_claim_fake_financial_outbox_v13(uuid,integer)'),
        ('public.hxos_record_fake_financial_publish_outcome_v13(uuid,text,text,text,text,integer)'),
        ('public.enforce_universal_financial_event_sequence()'),
        ('public.enforce_universal_fake_finance_boundary()'),
        ('public.enforce_universal_v1_financial_execution_completion()'),
        ('public.enforce_financial_operation_trigger_only()'),
        ('public.serialize_universal_v1_financial_security_task_v12()'),
        ('public.enforce_universal_v1_dispute_release_gate_v1()'),
        ('public.universal_v1_dispute_lock_v1(uuid)'),
        ('public.universal_v1_change_order_compensating_reversal_is_exact_v1(public.task_financial_security_events,public.task_financial_security_events)'),
        ('hx_authority.read_fake_financial_terminal_observation_v13(uuid,uuid,uuid)'),
        ('hx_authority.read_fake_financial_materialization_evidence_v13(uuid,uuid)'),
        ('public.hxos_materialize_fake_financial_event_v13(uuid,uuid)'),
        ('hx_authority.read_fake_financial_outcome_admission_v13(uuid)'),
        ('public.hxos_acquire_fake_financial_reconcile_lease_v13(uuid,uuid,uuid,integer)'),
        ('public.hxos_record_fake_financial_outcome_v13(uuid,uuid,uuid)'),
        ('public.hxos_read_fake_financial_progress_v13(uuid,text,text)'),
        ('public.hxos_scan_fake_financial_recovery_v13(uuid,integer)'),
        ('public.hxos_read_fake_financial_restoration_v13(uuid,text,text)'),
        ('public.hxos_read_fake_financial_recovery_evidence_v13(uuid,text,text)'),
        ('hx_authority.read_fake_financial_admission_evidence_v13(uuid,uuid)'),
        ('public.hxos_read_admitted_fake_financial_request_v13(uuid,uuid)'),
        ('hx_authority.derive_fake_financial_projection_v13(text,text)'),
        ('hx_authority.derive_fake_financial_projection_v13(text,text,smallint)'),
        ('hx_authority.assert_fake_financial_execution_domain_v13(uuid,text)'),
        ('public.hxos_execute_admitted_fake_financial_request_v13(uuid,uuid)'),
        ('public.validate_universal_v1_fake_terminal_lifecycle_intent()'),
        ('public.validate_universal_v1_fake_provider_account_fact()'),
        ('public.validate_fake_financial_legacy_expiry_compensation_v9()'),
        ('public.validate_fake_financial_legacy_expiry_disposition_v9()'),
        ('public.validate_fake_financial_legacy_expiry_noncompensable_v10()'),
        ('public.universal_v1_has_open_material_dispute_v1(uuid)'),
        ('public.hxos_request_fake_financial_command_v13(text,text)'),
        ('hx_authority.parse_fake_financial_request_v13(text,text)'),
        ('hx_authority.parse_fake_financial_identity_v13(text)'),
        ('hx_authority.mark_fake_financial_request_transaction_v13()'),
        ('hx_authority.validate_fake_financial_exact_request_v13()'),
        ('hx_authority.require_fake_financial_exact_request_v13()'),
        ('hx_authority.validate_fake_financial_preparation_payload_v13(jsonb)'),
        ('public.hxos_build_fake_financial_preparation_actor_request_v13(text,jsonb)'),
        ('public.hxos_build_fake_financial_progress_actor_request_v13(text,jsonb)'),
        ('hx_authority.read_fake_financial_public_progress_v13(uuid)'),
        ('public.hxos_read_authenticated_fake_financial_progress_v13(text,jsonb)'),
        ('public.hxos_build_fake_financial_predecessor_actor_request_v13(text,jsonb)'),
        ('hx_authority.read_fake_financial_predecessor_v13(jsonb)'),
        ('public.hxos_read_authenticated_fake_financial_predecessor_v13(text,jsonb)'),
        ('public.hxos_build_work_order_history_actor_request_v13(text,jsonb)'),
        ('public.hxos_build_change_order_actor_request_v13(text,jsonb)'),
        ('public.hxos_propose_authenticated_change_order_v13(text,jsonb)'),
        ('public.hxos_decide_authenticated_change_order_v13(text,jsonb)'),
        ('hx_authority.lock_change_order_write_context_v13(text,uuid,uuid)'),
        ('public.universal_v1_change_scope_sha256(text,text,text,jsonb,integer,integer,character)'),
        ('public.universal_v1_change_proposal_request_sha256(uuid,uuid,uuid,text,integer,uuid,text,text,character,text)'),
        ('public.universal_v1_change_decision_request_sha256(uuid,integer,text,text,uuid,text,text)'),
        ('public.hxos_build_change_order_history_actor_request_v13(text,jsonb)'),
        ('public.hxos_read_authenticated_work_order_history_v13(text,jsonb)'),
        ('public.hxos_read_authenticated_change_order_history_v13(text,jsonb)'),
        ('public.hxos_prepare_authenticated_fake_financial_command_v13(text,jsonb)'),
        ('public.hxos_prepare_universal_v1_financial_command_v1(uuid,text,uuid,text,text,bigint,bigint,text,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,bigint,text,uuid)'),
        ('public.universal_v1_effective_work_order_scope_id(uuid)'),
        ('public.universal_v1_pre_work_order_void_is_authorized(uuid,text,text,bigint,bigint,uuid,uuid,uuid,uuid,uuid,uuid,bigint,text,uuid)'),
        ('public.universal_v1_fake_terminal_plan_v1(text)'),
        ('public.business_membership_has_action(uuid,uuid,text)'),
        ('hx_authority.fake_financial_job_digest_v13(text[])'),
        ('hx_authority.reject_fake_financial_outbox_mutation_v13()'),
        ('hx_authority.assert_fake_financial_outbox_target_v13(uuid,text,text,text)'),
        ('public.assert_financial_provider_command_recovery_lease()'),
        ('hx_authority.validate_fake_financial_outbox_request_v13()'),
        ('hx_authority.capture_fake_financial_outbox_request_v13()'),
        ('hx_authority.validate_fake_financial_outbox_disposition_v13()'),
        ('hx_authority.validate_fake_financial_publish_claim_v13()'),
        ('hx_authority.assert_fake_financial_publish_open_v13(uuid)'),
        ('hx_authority.validate_fake_financial_publish_exhaustion_v13()'),
        ('hx_authority.claim_fake_financial_outbox_v13(uuid,integer)'),
        ('hx_authority.validate_fake_financial_publish_outcome_v13()'),
        ('hx_authority.record_fake_financial_publish_outcome_v13(uuid,text,text,text,text,integer)'),
        ('hx_authority.validate_fake_financial_dispatch_admission_v13()'),
        ('hx_authority.validate_fake_financial_job_validation_v13()'),
        ('hx_authority.record_fake_financial_job_dispatch_evidence_v13(uuid,text,text,uuid,integer,integer,integer)'),
        ('hx_authority.validate_fake_financial_webhook_rejection_v13()'),
        ('hx_authority.record_fake_financial_webhook_rejection_v13(uuid,text,text,text,text,text)'),
        ('hx_authority.validate_fake_financial_webhook_inert_v13()'),
        ('hx_authority.capture_fake_financial_webhook_inert_v13()')
      ) expected(object_identity)
      LEFT JOIN pg_catalog.pg_proc function_state
        ON function_state.oid = pg_catalog.to_regprocedure(expected.object_identity)
  LOOP
    IF object_record.object_oid IS NULL THEN
      RAISE EXCEPTION
        'HXUV1-FINOUT-13-40: v13 function inventory is incomplete: %',
        object_record.object_identity
        USING ERRCODE = 'P0001';
    END IF;
    FOR privilege_record IN
      SELECT DISTINCT privilege.grantee
        FROM pg_catalog.aclexplode(COALESCE(
          object_record.object_acl,
          pg_catalog.acldefault('f', object_record.owner_oid)
        )) privilege
       WHERE privilege.grantee <> object_record.owner_oid
    LOOP
      grantee_sql := CASE
        WHEN privilege_record.grantee = 0 THEN 'PUBLIC'
        ELSE pg_catalog.format(
          '%I', pg_catalog.pg_get_userbyid(privilege_record.grantee)
        )
      END;
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %s',
        object_record.object_identity,
        grantee_sql
      );
    END LOOP;
  END LOOP;

  WITH RECURSIVE object_owners(owner_oid) AS (
    SELECT relation_state.relowner
      FROM pg_catalog.pg_class relation_state
     WHERE relation_state.oid = ANY (ARRAY[
       pg_catalog.to_regclass('hx_authority.fake_financial_webhook_keys_v13'),
       pg_catalog.to_regclass('hx_authority.fake_financial_webhook_key_revocations_v13'),
       pg_catalog.to_regclass('hx_authority.fake_financial_webhook_verifications_v13'),
       pg_catalog.to_regclass('public.provider_event_processing_state'),
       pg_catalog.to_regclass('public.provider_event_inbox_observations'),
       pg_catalog.to_regclass('public.provider_event_inbox_receipts'),
       pg_catalog.to_regclass('public.universal_v1_change_order_recovery_terminal_facts'),
       pg_catalog.to_regclass('public.task_reconciliation_facts'),
       pg_catalog.to_regclass('hx_authority.fake_financial_preparation_authority_v13'),
       pg_catalog.to_regclass('hx_authority.fake_financial_exact_requests_v13'),
       pg_catalog.to_regclass('hx_authority.fake_financial_command_outbox_requests_v13'),
       pg_catalog.to_regclass('hx_authority.fake_financial_outbox_publish_claims_v13'),
       pg_catalog.to_regclass('hx_authority.fake_financial_outbox_publish_outcomes_v13'),
       pg_catalog.to_regclass('hx_authority.fake_financial_outbox_dispositions_v13'),
       pg_catalog.to_regclass('hx_authority.fake_financial_publish_exhaustions_v13'),
       pg_catalog.to_regclass('hx_authority.fake_financial_dispatch_admissions_v13'),
       pg_catalog.to_regclass('hx_authority.fake_financial_job_validations_v13'),
       pg_catalog.to_regclass('hx_authority.fake_financial_webhook_inert_evidence_v13'),
       pg_catalog.to_regclass('hx_authority.fake_financial_webhook_rejection_receipts_v13'),
       pg_catalog.to_regclass('public.task_financial_operations'),
       pg_catalog.to_regclass('public.task_scope_change_proposals'),
       pg_catalog.to_regclass('public.task_scope_change_approvals'),
       pg_catalog.to_regclass('public.task_work_order_amendments'),
       pg_catalog.to_regclass('public.universal_v1_change_order_materialization_commands'),
       pg_catalog.to_regclass('public.universal_v1_change_order_compensation_commands'),
       pg_catalog.to_regclass('public.task_completion_facts'),
       pg_catalog.to_regclass('public.hxos_fake_financial_legacy_expiry_dispositions_v9'),
       pg_catalog.to_regclass('public.hxos_fake_financial_legacy_expiry_compensations_v9'),
       pg_catalog.to_regclass('public.hxos_fake_financial_legacy_expiry_noncompensable_facts_v10'),
       pg_catalog.to_regclass('public.hxos_fake_financial_operations_v1'),
       pg_catalog.to_regclass('public.hxos_fake_financial_operation_events_v1'),
       pg_catalog.to_regclass('public.universal_v1_fake_terminal_lifecycle_intents'),
       pg_catalog.to_regclass('public.universal_v1_fake_provider_account_facts'),
       pg_catalog.to_regclass('public.task_safety_incidents'),
       pg_catalog.to_regclass('public.universal_v1_dispute_incidents'),
       pg_catalog.to_regclass('public.universal_v1_dispute_timeline_events'),
       pg_catalog.to_regclass('public.universal_v1_dispute_current_v1'),
       pg_catalog.to_regclass('public.hxos_fake_financial_schema_evidence_v13')
     ]::OID[])
    UNION
    SELECT function_state.proowner
      FROM pg_catalog.pg_proc function_state
     WHERE function_state.oid = ANY (ARRAY[
       pg_catalog.to_regprocedure('public.hxos_record_authenticated_fake_financial_webhook_v13(uuid,bytea,text,text)'),
       pg_catalog.to_regprocedure('hx_authority.guard_fake_financial_webhook_key_v13()'),
       pg_catalog.to_regprocedure('hx_authority.mark_fake_financial_webhook_verification_v13()'),
       pg_catalog.to_regprocedure('public.initialize_provider_event_processing_state()'),
       pg_catalog.to_regprocedure('public.reject_provider_event_inbox_mutation()'),
       pg_catalog.to_regprocedure('public.validate_provider_event_processing_state_transition()'),
       pg_catalog.to_regprocedure('public.reject_provider_event_processing_state_removal()'),
       pg_catalog.to_regprocedure('public.hxos_read_universal_v1_fake_financial_runtime_authority_v13()'),
       pg_catalog.to_regprocedure('public.hxos_read_fake_financial_schema_evidence_v13()'),
       pg_catalog.to_regprocedure('public.hxos_read_fake_financial_applied_migrations_v13()'),
       pg_catalog.to_regprocedure('public.hxos_read_fake_financial_bootstrap_completion_v13(text,text)'),
       pg_catalog.to_regprocedure('public.hxos_claim_fake_financial_outbox_v13(uuid,integer)'),
       pg_catalog.to_regprocedure('public.hxos_record_fake_financial_publish_outcome_v13(uuid,text,text,text,text,integer)'),
       pg_catalog.to_regprocedure('public.enforce_universal_financial_event_sequence()'),
       pg_catalog.to_regprocedure('public.enforce_universal_fake_finance_boundary()'),
       pg_catalog.to_regprocedure('public.enforce_universal_v1_financial_execution_completion()'),
       pg_catalog.to_regprocedure('public.enforce_financial_operation_trigger_only()'),
       pg_catalog.to_regprocedure('public.serialize_universal_v1_financial_security_task_v12()'),
       pg_catalog.to_regprocedure('public.enforce_universal_v1_dispute_release_gate_v1()'),
       pg_catalog.to_regprocedure('public.universal_v1_dispute_lock_v1(uuid)'),
       pg_catalog.to_regprocedure('public.universal_v1_change_order_compensating_reversal_is_exact_v1(public.task_financial_security_events,public.task_financial_security_events)'),
       pg_catalog.to_regprocedure('hx_authority.read_fake_financial_terminal_observation_v13(uuid,uuid,uuid)'),
       pg_catalog.to_regprocedure('hx_authority.read_fake_financial_materialization_evidence_v13(uuid,uuid)'),
       pg_catalog.to_regprocedure('public.hxos_materialize_fake_financial_event_v13(uuid,uuid)'),
       pg_catalog.to_regprocedure('hx_authority.read_fake_financial_outcome_admission_v13(uuid)'),
       pg_catalog.to_regprocedure('public.hxos_acquire_fake_financial_reconcile_lease_v13(uuid,uuid,uuid,integer)'),
       pg_catalog.to_regprocedure('public.hxos_record_fake_financial_outcome_v13(uuid,uuid,uuid)'),
       pg_catalog.to_regprocedure('public.hxos_read_fake_financial_progress_v13(uuid,text,text)'),
       pg_catalog.to_regprocedure('public.hxos_scan_fake_financial_recovery_v13(uuid,integer)'),
       pg_catalog.to_regprocedure('public.hxos_read_fake_financial_restoration_v13(uuid,text,text)'),
       pg_catalog.to_regprocedure('public.hxos_read_fake_financial_recovery_evidence_v13(uuid,text,text)'),
       pg_catalog.to_regprocedure('hx_authority.read_fake_financial_admission_evidence_v13(uuid,uuid)'),
       pg_catalog.to_regprocedure('public.hxos_read_admitted_fake_financial_request_v13(uuid,uuid)'),
       pg_catalog.to_regprocedure('hx_authority.derive_fake_financial_projection_v13(text,text)'),
       pg_catalog.to_regprocedure('hx_authority.derive_fake_financial_projection_v13(text,text,smallint)'),
       pg_catalog.to_regprocedure('hx_authority.assert_fake_financial_execution_domain_v13(uuid,text)'),
       pg_catalog.to_regprocedure('public.hxos_execute_admitted_fake_financial_request_v13(uuid,uuid)'),
       pg_catalog.to_regprocedure('public.validate_universal_v1_fake_terminal_lifecycle_intent()'),
       pg_catalog.to_regprocedure('public.validate_universal_v1_fake_provider_account_fact()'),
       pg_catalog.to_regprocedure('public.validate_fake_financial_legacy_expiry_compensation_v9()'),
       pg_catalog.to_regprocedure('public.validate_fake_financial_legacy_expiry_disposition_v9()'),
       pg_catalog.to_regprocedure('public.validate_fake_financial_legacy_expiry_noncompensable_v10()'),
       pg_catalog.to_regprocedure('public.universal_v1_has_open_material_dispute_v1(uuid)'),
       pg_catalog.to_regprocedure('public.hxos_request_fake_financial_command_v13(text,text)'),
       pg_catalog.to_regprocedure('hx_authority.parse_fake_financial_request_v13(text,text)'),
       pg_catalog.to_regprocedure('hx_authority.parse_fake_financial_identity_v13(text)'),
       pg_catalog.to_regprocedure('hx_authority.mark_fake_financial_request_transaction_v13()'),
       pg_catalog.to_regprocedure('hx_authority.validate_fake_financial_exact_request_v13()'),
       pg_catalog.to_regprocedure('hx_authority.require_fake_financial_exact_request_v13()'),
       pg_catalog.to_regprocedure('hx_authority.validate_fake_financial_preparation_payload_v13(jsonb)'),
       pg_catalog.to_regprocedure('public.hxos_build_fake_financial_preparation_actor_request_v13(text,jsonb)'),
       pg_catalog.to_regprocedure('public.hxos_build_fake_financial_progress_actor_request_v13(text,jsonb)'),
       pg_catalog.to_regprocedure('hx_authority.read_fake_financial_public_progress_v13(uuid)'),
       pg_catalog.to_regprocedure('public.hxos_read_authenticated_fake_financial_progress_v13(text,jsonb)'),
       pg_catalog.to_regprocedure('public.hxos_build_fake_financial_predecessor_actor_request_v13(text,jsonb)'),
       pg_catalog.to_regprocedure('hx_authority.read_fake_financial_predecessor_v13(jsonb)'),
       pg_catalog.to_regprocedure('public.hxos_read_authenticated_fake_financial_predecessor_v13(text,jsonb)'),
       pg_catalog.to_regprocedure('public.hxos_build_work_order_history_actor_request_v13(text,jsonb)'),
       pg_catalog.to_regprocedure('public.hxos_build_change_order_actor_request_v13(text,jsonb)'),
       pg_catalog.to_regprocedure('public.hxos_propose_authenticated_change_order_v13(text,jsonb)'),
       pg_catalog.to_regprocedure('public.hxos_decide_authenticated_change_order_v13(text,jsonb)'),
       pg_catalog.to_regprocedure('hx_authority.lock_change_order_write_context_v13(text,uuid,uuid)'),
       pg_catalog.to_regprocedure('public.universal_v1_change_scope_sha256(text,text,text,jsonb,integer,integer,character)'),
       pg_catalog.to_regprocedure('public.universal_v1_change_proposal_request_sha256(uuid,uuid,uuid,text,integer,uuid,text,text,character,text)'),
       pg_catalog.to_regprocedure('public.universal_v1_change_decision_request_sha256(uuid,integer,text,text,uuid,text,text)'),
       pg_catalog.to_regprocedure('public.hxos_build_change_order_history_actor_request_v13(text,jsonb)'),
       pg_catalog.to_regprocedure('public.hxos_read_authenticated_work_order_history_v13(text,jsonb)'),
       pg_catalog.to_regprocedure('public.hxos_read_authenticated_change_order_history_v13(text,jsonb)'),
       pg_catalog.to_regprocedure('public.hxos_prepare_authenticated_fake_financial_command_v13(text,jsonb)'),
       pg_catalog.to_regprocedure('public.hxos_prepare_universal_v1_financial_command_v1(uuid,text,uuid,text,text,bigint,bigint,text,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,bigint,text,uuid)'),
       pg_catalog.to_regprocedure('public.universal_v1_effective_work_order_scope_id(uuid)'),
       pg_catalog.to_regprocedure('public.universal_v1_pre_work_order_void_is_authorized(uuid,text,text,bigint,bigint,uuid,uuid,uuid,uuid,uuid,uuid,bigint,text,uuid)'),
       pg_catalog.to_regprocedure('public.universal_v1_fake_terminal_plan_v1(text)'),
       pg_catalog.to_regprocedure('public.business_membership_has_action(uuid,uuid,text)'),
       pg_catalog.to_regprocedure('hx_authority.fake_financial_job_digest_v13(text[])'),
       pg_catalog.to_regprocedure('hx_authority.reject_fake_financial_outbox_mutation_v13()'),
       pg_catalog.to_regprocedure('hx_authority.assert_fake_financial_outbox_target_v13(uuid,text,text,text)'),
       pg_catalog.to_regprocedure('public.assert_financial_provider_command_recovery_lease()'),
       pg_catalog.to_regprocedure('hx_authority.validate_fake_financial_outbox_request_v13()'),
       pg_catalog.to_regprocedure('hx_authority.capture_fake_financial_outbox_request_v13()'),
       pg_catalog.to_regprocedure('hx_authority.validate_fake_financial_outbox_disposition_v13()'),
       pg_catalog.to_regprocedure('hx_authority.validate_fake_financial_publish_claim_v13()'),
       pg_catalog.to_regprocedure('hx_authority.assert_fake_financial_publish_open_v13(uuid)'),
       pg_catalog.to_regprocedure('hx_authority.validate_fake_financial_publish_exhaustion_v13()'),
       pg_catalog.to_regprocedure('hx_authority.claim_fake_financial_outbox_v13(uuid,integer)'),
       pg_catalog.to_regprocedure('hx_authority.validate_fake_financial_publish_outcome_v13()'),
       pg_catalog.to_regprocedure('hx_authority.record_fake_financial_publish_outcome_v13(uuid,text,text,text,text,integer)'),
       pg_catalog.to_regprocedure('hx_authority.validate_fake_financial_dispatch_admission_v13()'),
       pg_catalog.to_regprocedure('hx_authority.validate_fake_financial_job_validation_v13()'),
       pg_catalog.to_regprocedure('hx_authority.record_fake_financial_job_dispatch_evidence_v13(uuid,text,text,uuid,integer,integer,integer)'),
       pg_catalog.to_regprocedure('hx_authority.validate_fake_financial_webhook_rejection_v13()'),
       pg_catalog.to_regprocedure('hx_authority.record_fake_financial_webhook_rejection_v13(uuid,text,text,text,text,text)'),
       pg_catalog.to_regprocedure('hx_authority.validate_fake_financial_webhook_inert_v13()'),
       pg_catalog.to_regprocedure('hx_authority.capture_fake_financial_webhook_inert_v13()')
     ]::OID[])
  ), owner_members(owner_oid, member_oid) AS (
    SELECT owner_state.owner_oid, membership.member
      FROM object_owners owner_state
      JOIN pg_catalog.pg_auth_members membership
        ON membership.roleid = owner_state.owner_oid
    UNION
    SELECT membership_tree.owner_oid, membership.member
      FROM owner_members membership_tree
      JOIN pg_catalog.pg_auth_members membership
        ON membership.roleid = membership_tree.member_oid
  )
  SELECT pg_catalog.pg_get_userbyid(membership_state.owner_oid)
           || '->' || pg_catalog.pg_get_userbyid(membership_state.member_oid)
    INTO unsafe_membership
    FROM owner_members membership_state
   ORDER BY membership_state.owner_oid, membership_state.member_oid
   LIMIT 1;
  IF unsafe_membership IS NOT NULL THEN
    RAISE EXCEPTION
      'HXUV1-FINOUT-13-41: v13 owner membership is unsafe: %',
      unsafe_membership
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;


-- Authenticated ChangeOrder materialization retains the existing lifecycle guards.
CREATE OR REPLACE FUNCTION public.hxos_build_change_order_materialization_actor_request_v13(
  expected_command_kind TEXT,command_payload JSONB
) RETURNS TABLE(target_authority_id UUID,environment TEXT,release_manifest_sha256 TEXT,
  canonical_request JSONB,actor_request_sha256 TEXT)
LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE SET search_path=pg_catalog AS $$
DECLARE
  target RECORD; allowed_keys TEXT[]; field_name TEXT;
BEGIN
  PERFORM hx_authority.assert_universal_v1_work_order_bootstrap_seal_v1();
  IF expected_command_kind IS NULL OR expected_command_kind NOT IN
      ('READ_FAKE_CHANGE_ORDER_KIND','PREPARE_FAKE_CHANGE_ORDER','FINALIZE_FAKE_CHANGE_ORDER')
     OR pg_catalog.jsonb_typeof(command_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'HXUV1-COMATERIALIZE-13-PAYLOAD_INVALID'; END IF;
  allowed_keys:=ARRAY['proposal_id'];
  IF expected_command_kind<>'READ_FAKE_CHANGE_ORDER_KIND' THEN
    allowed_keys:=allowed_keys||ARRAY['expected_proposal_version','expected_scope_version','expected_amendment_version',
      'expected_execution_version','expected_financial_version','idempotency_key','client_timestamp_epoch_ms'];
    FOREACH field_name IN ARRAY ARRAY['expected_proposal_version','expected_scope_version','expected_amendment_version',
        'expected_execution_version','expected_financial_version'] LOOP
      IF pg_catalog.jsonb_typeof(command_payload->field_name) IS DISTINCT FROM 'number'
         OR command_payload->>field_name !~ '^(0|[1-9][0-9]{0,9})$' THEN
        RAISE EXCEPTION 'HXUV1-COMATERIALIZE-13-PAYLOAD_INVALID'; END IF;
      IF (command_payload->>field_name)::BIGINT>2147483647
         OR (field_name IN ('expected_proposal_version','expected_scope_version','expected_execution_version')
           AND (command_payload->>field_name)::BIGINT=0) THEN
        RAISE EXCEPTION 'HXUV1-COMATERIALIZE-13-PAYLOAD_INVALID'; END IF;
    END LOOP;
    IF pg_catalog.jsonb_typeof(command_payload->'idempotency_key') IS DISTINCT FROM 'string'
       OR command_payload->>'idempotency_key' !~ '^[A-Za-z0-9:_-]{16,96}$'
       OR pg_catalog.jsonb_typeof(command_payload->'client_timestamp_epoch_ms') IS DISTINCT FROM 'number'
       OR command_payload->>'client_timestamp_epoch_ms' !~ '^(0|[1-9][0-9]{0,15})$' THEN
      RAISE EXCEPTION 'HXUV1-COMATERIALIZE-13-PAYLOAD_INVALID'; END IF;
    IF (command_payload->>'client_timestamp_epoch_ms')::NUMERIC>9007199254740991 THEN
      RAISE EXCEPTION 'HXUV1-COMATERIALIZE-13-PAYLOAD_INVALID'; END IF;
  END IF;
  IF expected_command_kind='FINALIZE_FAKE_CHANGE_ORDER' THEN
    allowed_keys:=allowed_keys||ARRAY['phase_request_sha256','adjustment_event_id'];
    IF pg_catalog.jsonb_typeof(command_payload->'phase_request_sha256') IS DISTINCT FROM 'string'
       OR command_payload->>'phase_request_sha256' !~ '^[a-f0-9]{64}$'
       OR command_payload->>'phase_request_sha256'=pg_catalog.repeat('0',64)
       OR pg_catalog.jsonb_typeof(command_payload->'adjustment_event_id') IS DISTINCT FROM 'string'
       OR command_payload->>'adjustment_event_id' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' THEN
      RAISE EXCEPTION 'HXUV1-COMATERIALIZE-13-PAYLOAD_INVALID'; END IF;
  END IF;
  IF command_payload-allowed_keys<>'{}'::JSONB
     OR pg_catalog.jsonb_typeof(command_payload->'proposal_id') IS DISTINCT FROM 'string'
     OR command_payload->>'proposal_id' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' THEN
    RAISE EXCEPTION 'HXUV1-COMATERIALIZE-13-PAYLOAD_INVALID'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('hxuv1-work-order-target-authority-v1',0));
  SELECT * INTO STRICT target FROM hx_authority.read_universal_v1_work_order_target_authority_v1();
  canonical_request:=pg_catalog.jsonb_build_object('schema_version',1,'command_kind',expected_command_kind,
    'release_manifest_sha256',target.release_manifest_sha256,
    'target_authority',pg_catalog.jsonb_build_object('id',target.target_authority_id,'version',target.authority_version,
      'database',target.target_database_name,'environment',target.environment,'release',target.release_manifest_sha256),
    'authentication_requirements',pg_catalog.jsonb_build_object('mfa_required',FALSE,'step_up_required',FALSE,
      'max_auth_age_seconds',300,'max_step_up_age_seconds',NULL),'command_payload',command_payload);
  target_authority_id:=target.target_authority_id; environment:=target.environment;
  release_manifest_sha256:=target.release_manifest_sha256;
  actor_request_sha256:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(canonical_request::TEXT,'UTF8')),'hex');
  RETURN NEXT;
END;
$$;

-- Preserve the existing customer-only kind read so scope-only changes do not
-- acquire a financial prerequisite. Reading kind never authorizes a write.
CREATE OR REPLACE FUNCTION public.hxos_read_authenticated_change_order_kind_v13(
  actor_assertion_token TEXT,command_payload JSONB
) RETURNS TABLE(result JSONB,actor_user_id UUID,actor_assertion_id UUID,actor_request_sha256 TEXT,
  target_authority_id UUID,command_release_sha256 TEXT)
LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE SET search_path=pg_catalog AS $$
DECLARE
  request RECORD; actor RECORD; context RECORD; dependency_identity JSONB; pass INTEGER;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'HXUV1-COMATERIALIZE-13-READ_COMMITTED_REQUIRED'; END IF;
  SELECT * INTO STRICT request FROM public.hxos_build_change_order_materialization_actor_request_v13(
    'READ_FAKE_CHANGE_ORDER_KIND',command_payload);
  SELECT * INTO STRICT actor FROM hx_authority.consume_universal_v1_actor_assertion_v1(
    actor_assertion_token,'READ_FAKE_CHANGE_ORDER_KIND',request.canonical_request,request.environment);
  actor_user_id:=actor.resolved_user_id; actor_assertion_id:=actor.assertion_id;
  actor_request_sha256:=request.actor_request_sha256; target_authority_id:=request.target_authority_id;
  command_release_sha256:=request.release_manifest_sha256;
  FOR pass IN 0..1 LOOP
    SELECT proposal.id AS proposal_id,proposal.change_order_kind,task.id AS task_id,
      work_order.id AS work_order_id,task.business_organization_id AS customer_organization_id INTO context
    FROM public.task_scope_change_proposals proposal
    JOIN public.tasks task ON task.id=proposal.task_id
    JOIN public.task_work_orders work_order ON work_order.task_id=task.id AND task.work_order_id=work_order.id
    JOIN public.users current_actor ON current_actor.id=actor.resolved_user_id
    LEFT JOIN public.business_organizations customer_organization ON customer_organization.id=task.business_organization_id
    WHERE proposal.id=(command_payload->>'proposal_id')::UUID
      AND proposal.universal_contract_version=1 AND proposal.application_contract_version=1
      AND task.universal_contract_version=1 AND task.automation_classification='CONTROLLED_TEST'
      AND task.worker_id IS NULL AND task.universal_payment_posture='PAYMENT_CREATION_FROZEN'
      AND current_actor.account_status='ACTIVE' AND current_actor.is_minor IS FALSE
      AND COALESCE(current_actor.is_banned,FALSE) IS FALSE AND current_actor.firebase_uid=actor.verified_subject
      AND ((task.business_organization_id IS NULL AND task.poster_id=actor.resolved_user_id)
        OR (task.business_organization_id IS NOT NULL AND customer_organization.status='ACTIVE'
          AND customer_organization.client_enabled IS TRUE
          AND public.business_membership_has_action(task.business_organization_id,actor.resolved_user_id,'APPROVE_SPEND')));
    IF NOT FOUND THEN
      IF pass=0 THEN result:=NULL; RETURN NEXT; RETURN; END IF;
      RAISE EXCEPTION 'HXUV1-COMATERIALIZE-13: CHANGE_ORDER_AUTHORITY_REVOKED';
    END IF;
    IF pass=1 THEN
      IF dependency_identity IS DISTINCT FROM pg_catalog.to_jsonb(context) THEN
        RAISE EXCEPTION 'HXUV1-COMATERIALIZE-13: CHANGE_ORDER_AUTHORITY_REVOKED'; END IF;
      EXIT;
    END IF;
    dependency_identity:=pg_catalog.to_jsonb(context);
    PERFORM 1 FROM public.task_scope_change_proposals WHERE id=context.proposal_id FOR SHARE NOWAIT;
    PERFORM 1 FROM public.task_work_orders WHERE id=context.work_order_id FOR SHARE NOWAIT;
    PERFORM 1 FROM public.tasks WHERE id=context.task_id FOR SHARE NOWAIT;
    PERFORM 1 FROM public.users WHERE id=actor.resolved_user_id FOR SHARE NOWAIT;
    PERFORM 1 FROM public.business_organizations WHERE id=context.customer_organization_id FOR SHARE NOWAIT;
    PERFORM 1 FROM public.business_memberships WHERE organization_id=context.customer_organization_id
      AND user_id=actor.resolved_user_id ORDER BY id FOR SHARE NOWAIT;
  END LOOP;
  result:=pg_catalog.to_jsonb(context.change_order_kind); RETURN NEXT;
END;
$$;
REVOKE ALL ON FUNCTION public.hxos_build_change_order_materialization_actor_request_v13(TEXT,JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.hxos_read_authenticated_change_order_kind_v13(TEXT,JSONB) FROM PUBLIC;


CREATE OR REPLACE FUNCTION public.universal_v1_change_amendment_request_sha256(
  checked_work_order_id UUID,checked_amendment_version INTEGER,
  checked_supersedes_amendment_id UUID,checked_change_order_id UUID,
  checked_scope_version_id UUID,checked_adjustment_event_id UUID,
  checked_expected_financial_version INTEGER,checked_materialized_by UUID,
  checked_idempotency_key TEXT
) RETURNS CHAR(64)
LANGUAGE sql IMMUTABLE SECURITY INVOKER PARALLEL SAFE SET search_path=pg_catalog AS $$
  SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
    'contract','HUSTLEXP_UNIVERSAL_V1_WORK_ORDER_AMENDMENT_V1',
    'workOrderId',checked_work_order_id,'amendmentVersion',checked_amendment_version,
    'supersedesAmendmentId',checked_supersedes_amendment_id,'changeOrderId',checked_change_order_id,
    'scopeVersionId',checked_scope_version_id,'adjustmentEventId',checked_adjustment_event_id,
    'expectedFinancialVersion',checked_expected_financial_version,
    'materializedBy',checked_materialized_by,'idempotencyKey',checked_idempotency_key
  )::TEXT,'UTF8')),'hex')::CHAR(64);
$$;

CREATE OR REPLACE FUNCTION public.universal_v1_change_order_materialization_request_sha256(
  checked_proposal_id UUID,checked_idempotency_key TEXT,checked_actor_user_id UUID,
  checked_work_order_id UUID,checked_task_id UUID,checked_task_draft_id UUID,
  checked_eligibility_decision_id UUID,checked_base_scope_version_id UUID,
  checked_replacement_scope_version_id UUID,checked_expected_proposal_version INTEGER,
  checked_expected_scope_version INTEGER,checked_expected_amendment_version INTEGER,
  checked_expected_execution_version INTEGER,checked_expected_financial_version INTEGER,
  checked_predecessor_event_id UUID,checked_predecessor_operation_id UUID,
  checked_adjustment_operation_id UUID
) RETURNS CHAR(64)
LANGUAGE sql IMMUTABLE SECURITY INVOKER PARALLEL SAFE SET search_path=pg_catalog AS $$
  SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
    'contract','HUSTLEXP_UNIVERSAL_V1_CHANGE_ORDER_MATERIALIZATION_V1',
    'proposalId',checked_proposal_id,'idempotencyKey',checked_idempotency_key,
    'actorUserId',checked_actor_user_id,'workOrderId',checked_work_order_id,
    'taskId',checked_task_id,'taskDraftId',checked_task_draft_id,
    'eligibilityDecisionId',checked_eligibility_decision_id,
    'baseScopeVersionId',checked_base_scope_version_id,
    'replacementScopeVersionId',checked_replacement_scope_version_id,
    'expectedProposalVersion',checked_expected_proposal_version,
    'expectedScopeVersion',checked_expected_scope_version,
    'expectedAmendmentVersion',checked_expected_amendment_version,
    'expectedExecutionVersion',checked_expected_execution_version,
    'expectedFinancialVersion',checked_expected_financial_version,
    'predecessorEventId',checked_predecessor_event_id,
    'predecessorOperationId',checked_predecessor_operation_id,
    'adjustmentOperationId',checked_adjustment_operation_id
  )::TEXT,'UTF8')),'hex')::CHAR(64);
$$;

CREATE OR REPLACE FUNCTION public.hxos_prepare_authenticated_change_order_v13(
  actor_assertion_token TEXT,command_payload JSONB
) RETURNS TABLE(result JSONB,actor_user_id UUID,actor_assertion_id UUID,actor_request_sha256 TEXT,
  target_authority_id UUID,command_release_sha256 TEXT)
LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE SET search_path=pg_catalog AS $$
DECLARE
  request RECORD; actor RECORD; owned RECORD; context RECORD; replay_row RECORD;
  witness public.universal_v1_change_order_materialization_commands%ROWTYPE;
  replacement public.task_scope_versions%ROWTYPE;
  pass INTEGER; actor_ids UUID[]; dependency_identity JSONB; locked_dependency_identity JSONB;
  proposal_id_value UUID; key_value TEXT; kind_value TEXT; epoch_value BIGINT; client_time TIMESTAMPTZ;
  expected_proposal INTEGER; expected_scope INTEGER; expected_amendment INTEGER;
  expected_execution INTEGER; expected_financial INTEGER;
  is_price_change BOOLEAN; prepared_exists BOOLEAN; financial_version_matches BOOLEAN;
  customer_total INTEGER; provider_payout INTEGER; amendment_version INTEGER;
  scope_sha CHAR(64); business_sha CHAR(64); witness_sha CHAR(64);
  new_scope_id UUID; new_amendment_id UUID; new_execution_id UUID;
  predecessor_amendment_id UUID; adjustment_operation_id_value UUID; changed_count BIGINT;
  projected_worker_id UUID;
  trim_chars TEXT:=pg_catalog.chr(9)||pg_catalog.chr(10)||pg_catalog.chr(11)||pg_catalog.chr(12)||
    pg_catalog.chr(13)||pg_catalog.chr(32)||pg_catalog.chr(160)||pg_catalog.chr(5760)||
    pg_catalog.chr(8192)||pg_catalog.chr(8193)||pg_catalog.chr(8194)||pg_catalog.chr(8195)||
    pg_catalog.chr(8196)||pg_catalog.chr(8197)||pg_catalog.chr(8198)||pg_catalog.chr(8199)||
    pg_catalog.chr(8200)||pg_catalog.chr(8201)||pg_catalog.chr(8202)||pg_catalog.chr(8232)||
    pg_catalog.chr(8233)||pg_catalog.chr(8239)||pg_catalog.chr(8287)||pg_catalog.chr(12288)||pg_catalog.chr(65279);
BEGIN
  IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'HXUV1-COPREPARE-13-READ_COMMITTED_REQUIRED'; END IF;
  SELECT * INTO STRICT request FROM public.hxos_build_change_order_materialization_actor_request_v13(
    'PREPARE_FAKE_CHANGE_ORDER',command_payload);
  SELECT * INTO STRICT actor FROM hx_authority.consume_universal_v1_actor_assertion_v1(
    actor_assertion_token,'PREPARE_FAKE_CHANGE_ORDER',request.canonical_request,request.environment);
  epoch_value:=(command_payload->>'client_timestamp_epoch_ms')::BIGINT;
  IF pg_catalog.abs(EXTRACT(EPOCH FROM pg_catalog.clock_timestamp())*1000-epoch_value)>300000 THEN
    RAISE EXCEPTION 'HXUV1-COPREPARE-13: CHANGE_ORDER_REQUEST_STALE'; END IF;
  client_time:=pg_catalog.to_timestamp((epoch_value/1000)::DOUBLE PRECISION)
    +(epoch_value%1000)::INTEGER*INTERVAL '1 millisecond';
  proposal_id_value:=(command_payload->>'proposal_id')::UUID;
  key_value:=command_payload->>'idempotency_key';
  expected_proposal:=(command_payload->>'expected_proposal_version')::INTEGER;
  expected_scope:=(command_payload->>'expected_scope_version')::INTEGER;
  expected_amendment:=(command_payload->>'expected_amendment_version')::INTEGER;
  expected_execution:=(command_payload->>'expected_execution_version')::INTEGER;
  expected_financial:=(command_payload->>'expected_financial_version')::INTEGER;

  -- Establish current customer read rights before foreign domain locks or finance reads.
  -- Completed replay deliberately does not require provider reauthorization, current
  -- financial expiry, the latest scope or the original target/release to remain current.
  FOR pass IN 0..1 LOOP
    SELECT proposal.id AS proposal_id,proposal.task_id,proposal.proposed_by,
      proposal.change_order_kind,work_order.id AS work_order_id,work_order.task_draft_id,
      work_order.eligibility_decision_id,work_order.provider_user_id,work_order.provider_organization_id,
      task.business_organization_id AS customer_organization_id,eligibility.trade_credential_id,
      COALESCE(latest_amendment.scope_version_id,work_order.scope_version_id) AS scope_id,
      customer_approval.actor_id AS customer_approval_actor_id,
      provider_approval.actor_id AS provider_approval_actor_id
    INTO owned
    FROM public.task_scope_change_proposals proposal
    JOIN public.tasks task ON task.id=proposal.task_id
    JOIN public.task_work_orders work_order ON work_order.task_id=task.id AND task.work_order_id=work_order.id
    JOIN public.users current_actor ON current_actor.id=actor.resolved_user_id
    LEFT JOIN public.task_provider_eligibility_decisions eligibility ON eligibility.id=work_order.eligibility_decision_id
    LEFT JOIN public.business_organizations customer_organization ON customer_organization.id=task.business_organization_id
    LEFT JOIN public.task_scope_change_approvals customer_approval ON customer_approval.proposal_id=proposal.id
      AND customer_approval.approver_role='CUSTOMER'
    LEFT JOIN public.task_scope_change_approvals provider_approval ON provider_approval.proposal_id=proposal.id
      AND provider_approval.approver_role='PROVIDER'
    LEFT JOIN LATERAL (SELECT amendment.scope_version_id FROM public.task_work_order_amendments amendment
      WHERE amendment.work_order_id=work_order.id ORDER BY amendment.amendment_version DESC LIMIT 1) latest_amendment ON TRUE
    WHERE proposal.id=proposal_id_value AND proposal.universal_contract_version=1 AND proposal.application_contract_version=1
      AND current_actor.firebase_uid=actor.verified_subject AND current_actor.account_status='ACTIVE'
      AND current_actor.is_minor IS FALSE AND COALESCE(current_actor.is_banned,FALSE) IS FALSE
      AND ((task.business_organization_id IS NULL AND task.poster_id=actor.resolved_user_id)
        OR (task.business_organization_id IS NOT NULL AND customer_organization.status='ACTIVE'
          AND customer_organization.client_enabled IS TRUE
          AND public.business_membership_has_action(task.business_organization_id,actor.resolved_user_id,'APPROVE_SPEND')));
    IF NOT FOUND THEN RAISE EXCEPTION 'HXUV1-COPREPARE-13: CHANGE_ORDER_CONTEXT_UNAVAILABLE'; END IF;
    dependency_identity:=pg_catalog.to_jsonb(owned);
    IF pass=1 THEN
      IF dependency_identity IS DISTINCT FROM locked_dependency_identity THEN
        RAISE EXCEPTION 'HXUV1-COPREPARE-13: CHANGE_ORDER_VERSION_CONFLICT'; END IF;
      EXIT;
    END IF;
    locked_dependency_identity:=dependency_identity;
    IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(
        'universal-v1-change-order-proposal:'||proposal_id_value::TEXT,0))
       OR NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('fulfillment:'||owned.work_order_id::TEXT,0)) THEN
      RAISE EXCEPTION 'HXUV1-COPREPARE-13-LOCK_BUSY'; END IF;
    PERFORM 1 FROM public.task_work_orders WHERE id=owned.work_order_id FOR UPDATE NOWAIT;
    PERFORM 1 FROM public.tasks WHERE id=owned.task_id FOR UPDATE NOWAIT;
    PERFORM 1 FROM public.task_drafts WHERE id=owned.task_draft_id FOR SHARE NOWAIT;
    PERFORM 1 FROM public.task_scope_change_proposals WHERE id=proposal_id_value FOR UPDATE NOWAIT;
    PERFORM 1 FROM public.task_provider_eligibility_decisions WHERE id=owned.eligibility_decision_id FOR SHARE NOWAIT;
    PERFORM 1 FROM public.task_scope_versions WHERE id=owned.scope_id FOR SHARE NOWAIT;
    SELECT pg_catalog.array_agg(actor_id ORDER BY actor_id) INTO actor_ids FROM (
      SELECT actor.resolved_user_id AS actor_id UNION SELECT owned.provider_user_id UNION SELECT owned.proposed_by
      UNION SELECT owned.customer_approval_actor_id UNION SELECT owned.provider_approval_actor_id
    ) exact_actors WHERE actor_id IS NOT NULL;
    -- UPDATE conflicts with the FK KEY SHARE lock of a newly inserted membership;
    -- locking only existing membership rows would leave an absent-row race.
    PERFORM 1 FROM public.users WHERE id=ANY(actor_ids) ORDER BY id FOR UPDATE NOWAIT;
    PERFORM 1 FROM public.business_organizations WHERE id IN (owned.customer_organization_id,owned.provider_organization_id)
      ORDER BY id FOR SHARE NOWAIT;
    PERFORM 1 FROM public.business_memberships WHERE organization_id IN (owned.customer_organization_id,owned.provider_organization_id)
      AND user_id=ANY(actor_ids) ORDER BY organization_id,user_id,id FOR SHARE NOWAIT;
    PERFORM 1 FROM public.capability_profiles WHERE user_id=owned.provider_user_id ORDER BY user_id FOR SHARE NOWAIT;
    PERFORM 1 FROM public.business_credentials WHERE id=owned.trade_credential_id FOR SHARE NOWAIT;
    PERFORM 1 FROM public.verified_trades WHERE user_id=owned.provider_user_id
      AND provider_organization_id IS NOT DISTINCT FROM owned.provider_organization_id
      AND business_credential_id IS NOT DISTINCT FROM owned.trade_credential_id ORDER BY user_id,trade FOR SHARE NOWAIT;
  END LOOP;
  kind_value:=owned.change_order_kind;
  IF kind_value='SCHEDULE_AND_SCOPE' THEN
    RAISE EXCEPTION 'HXUV1-COPREPARE-13: CHANGE_ORDER_SCHEDULE_UNSUPPORTED'; END IF;
  IF kind_value IS NULL OR kind_value NOT IN ('SCOPE_ONLY','PRICE_AND_SCOPE') THEN
    RAISE EXCEPTION 'HXUV1-COPREPARE-13: CHANGE_ORDER_CONTEXT_UNAVAILABLE'; END IF;
  is_price_change:=kind_value='PRICE_AND_SCOPE';

  -- Preserve the repository's completed-amendment replay before current-state checks.
  SELECT amendment.id AS amendment_id,amendment.amendment_version,amendment.change_order_id,
    proposal.proposal_version,amendment.scope_version_id,scope.version AS scope_version,
    amendment.supersedes_amendment_id,amendment.adjustment_event_id,amendment.expected_financial_version,
    adjustment.expected_version AS adjustment_expected_version,proposal.change_order_kind,
    amendment.request_sha256,amendment.materialized_by,adjustment.event_kind AS adjustment_event_kind,
    adjustment.status AS adjustment_status,adjustment.provider_kind AS adjustment_provider_kind,
    execution.id AS execution_fact_id,execution.execution_version,execution.actor_user_id AS execution_actor_user_id
  INTO replay_row
  FROM public.task_work_order_amendments amendment
  JOIN public.task_scope_change_proposals proposal ON proposal.id=amendment.change_order_id
  JOIN public.task_scope_versions scope ON scope.id=amendment.scope_version_id
  JOIN public.task_work_orders work_order ON work_order.id=amendment.work_order_id
  LEFT JOIN public.task_financial_security_events adjustment ON adjustment.id=amendment.adjustment_event_id
  JOIN public.task_work_order_execution_facts execution ON execution.work_order_amendment_id=amendment.id
    AND execution.transition_kind='APPLY_AMENDMENT'
  WHERE amendment.idempotency_key=key_value AND amendment.change_order_id=proposal_id_value
    AND work_order.id=owned.work_order_id AND proposal.universal_contract_version=1 AND proposal.application_contract_version=1;
  IF replay_row.amendment_id IS NOT NULL THEN
    IF replay_row.request_sha256 !~ '^[a-f0-9]{64}$'
       OR replay_row.materialized_by IS DISTINCT FROM actor.resolved_user_id
       OR replay_row.expected_financial_version IS DISTINCT FROM expected_financial
       OR replay_row.proposal_version IS DISTINCT FROM expected_proposal
       OR replay_row.scope_version::BIGINT IS DISTINCT FROM expected_scope::BIGINT+1
       OR replay_row.amendment_version::BIGINT IS DISTINCT FROM expected_amendment::BIGINT+1
       OR replay_row.execution_version::BIGINT IS DISTINCT FROM expected_execution::BIGINT+1
       OR replay_row.execution_actor_user_id IS DISTINCT FROM actor.resolved_user_id
       OR replay_row.change_order_kind IS DISTINCT FROM kind_value
       OR (is_price_change AND (replay_row.adjustment_event_id IS NULL
         OR replay_row.adjustment_expected_version::BIGINT IS DISTINCT FROM expected_financial::BIGINT+1
         OR replay_row.adjustment_event_kind IS DISTINCT FROM 'ADJUSTMENT_AUTHORIZED'
         OR replay_row.adjustment_status IS DISTINCT FROM 'SUCCEEDED'
         OR replay_row.adjustment_provider_kind IS DISTINCT FROM 'FAKE')) THEN
      RAISE EXCEPTION 'HXUV1-COPREPARE-13: CHANGE_ORDER_IDEMPOTENCY_CONFLICT'; END IF;
    result:=pg_catalog.jsonb_build_object('completed',TRUE,'result',pg_catalog.jsonb_build_object(
      'amendment_id',replay_row.amendment_id,'amendment_version',replay_row.amendment_version,
      'proposal_id',replay_row.change_order_id,'scope_version_id',replay_row.scope_version_id,
      'scope_version',replay_row.scope_version,'adjustment_event_id',replay_row.adjustment_event_id,
      'provider_kind',CASE WHEN replay_row.adjustment_event_id IS NULL THEN NULL ELSE 'FAKE' END,
      'replayed',TRUE,'payment_creation_performed',FALSE,'hard_assignment_created',FALSE));
  ELSE
    IF is_price_change THEN
      -- Immutable collision reads never lock the unrelated command's domain.
      SELECT * INTO witness FROM public.universal_v1_change_order_materialization_commands command
        WHERE command.proposal_id=proposal_id_value OR command.idempotency_key=key_value
        ORDER BY (command.proposal_id=proposal_id_value) DESC LIMIT 1;
      IF witness.proposal_id IS NOT NULL AND (witness.proposal_id IS DISTINCT FROM proposal_id_value
         OR witness.idempotency_key IS DISTINCT FROM key_value OR witness.actor_user_id IS DISTINCT FROM actor.resolved_user_id
         OR witness.expected_proposal_version IS DISTINCT FROM expected_proposal
         OR witness.expected_scope_version IS DISTINCT FROM expected_scope
         OR witness.expected_amendment_version IS DISTINCT FROM expected_amendment
         OR witness.expected_execution_version IS DISTINCT FROM expected_execution
         OR witness.expected_financial_version IS DISTINCT FROM expected_financial OR witness.request_sha256 !~ '^[a-f0-9]{64}$') THEN
        RAISE EXCEPTION 'HXUV1-COPREPARE-13: CHANGE_ORDER_IDEMPOTENCY_CONFLICT'; END IF;
    END IF;
    prepared_exists:=witness.proposal_id IS NOT NULL;

    SELECT proposal.id AS proposal_id,proposal.proposal_version,proposal.status AS proposal_status,
      proposal.base_version_id,proposal.approved_version_id,proposal.change_order_kind,
      proposal.observed_scope_summary,proposal.proposed_title,proposal.proposed_description,
      proposal.proposed_requirements,proposal.proposed_checklist,proposal.proposed_customer_total_cents,
      proposal.proposed_provider_payout_cents,proposal.proposed_scope_sha256,proposal.financial_adjustment_required,
      work_order.id AS work_order_id,work_order.task_id,work_order.task_draft_id,work_order.eligibility_decision_id,
      scope.id AS scope_version_id,scope.version AS scope_version,scope.scope_hash,scope.title,scope.description,
      scope.requirements,scope.checklist,scope.customer_total_cents,scope.hustler_payout_cents AS provider_payout_cents,scope.currency,
      latest_amendment.id AS latest_amendment_id,COALESCE(latest_amendment.amendment_version,0) AS latest_amendment_version,
      customer_approval.actor_id AS customer_approval_actor_id,customer_approval.decision AS customer_approval_decision,
      provider_approval.actor_id AS provider_approval_actor_id,provider_approval.decision AS provider_approval_decision,
      (((task.business_organization_id IS NULL AND customer_approval.actor_id=task.poster_id)
         OR (task.business_organization_id IS NOT NULL AND customer_organization.status='ACTIVE'
           AND customer_organization.client_enabled IS TRUE
           AND public.business_membership_has_action(task.business_organization_id,customer_approval.actor_id,'APPROVE_SPEND')))
        AND customer_approval_actor.account_status='ACTIVE' AND customer_approval_actor.is_minor IS FALSE
        AND COALESCE(customer_approval_actor.is_banned,FALSE) IS FALSE) AS customer_approval_current,
      ((provider_approval.actor_id=work_order.provider_user_id
         OR (work_order.provider_organization_id IS NOT NULL AND organization.status='ACTIVE'
           AND organization.provider_enabled IS TRUE
           AND public.business_membership_has_action(work_order.provider_organization_id,provider_approval.actor_id,'APPROVE_SPEND')))
        AND provider_approval_actor.account_status='ACTIVE' AND provider_approval_actor.is_minor IS FALSE
        AND COALESCE(provider_approval_actor.is_banned,FALSE) IS FALSE) AS provider_approval_current,
      public.universal_v1_invited_provider_authority_is_current(eligibility.provider_user_id,eligibility.provider_organization_id,
        eligibility.provider_class,eligibility.trade_credential_id,task.category,task.region_code) AS provider_authority_current,
      latest_financial.id AS latest_financial_event_id,latest_financial.operation_id AS latest_financial_operation_id,
      latest_financial.event_kind AS latest_financial_event_kind,latest_financial.status AS latest_financial_status,
      latest_financial.expected_version AS latest_financial_version,latest_financial.occurred_at AS latest_financial_occurred_at,
      latest_financial.change_order_id AS latest_financial_change_order_id,latest_financial.scope_version_id AS latest_financial_scope_version_id,
      latest_financial.predecessor_event_id AS latest_financial_predecessor_event_id,latest_financial.amount_cents AS latest_financial_amount_cents,
      latest_financial.currency AS latest_financial_currency,execution.id AS execution_fact_id,execution.execution_version,execution.state AS execution_state
    INTO context
    FROM public.task_scope_change_proposals proposal
    JOIN public.tasks task ON task.id=proposal.task_id
    JOIN public.task_work_orders work_order ON work_order.task_id=task.id
    JOIN public.task_drafts draft ON draft.id=work_order.task_draft_id
    JOIN public.task_provider_eligibility_decisions eligibility ON eligibility.id=work_order.eligibility_decision_id
    JOIN public.users current_actor ON current_actor.id=actor.resolved_user_id
    JOIN public.users provider ON provider.id=work_order.provider_user_id
    LEFT JOIN public.business_organizations organization ON organization.id=work_order.provider_organization_id
    LEFT JOIN public.business_organizations customer_organization ON customer_organization.id=task.business_organization_id
    LEFT JOIN LATERAL (SELECT amendment.id,amendment.amendment_version,amendment.scope_version_id
      FROM public.task_work_order_amendments amendment WHERE amendment.work_order_id=work_order.id
      ORDER BY amendment.amendment_version DESC LIMIT 1) latest_amendment ON TRUE
    JOIN public.task_scope_versions scope ON scope.id=COALESCE(latest_amendment.scope_version_id,work_order.scope_version_id)
    JOIN public.task_work_order_execution_facts execution ON execution.work_order_id=work_order.id AND execution.scope_version_id=scope.id
      AND NOT EXISTS(SELECT 1 FROM public.task_work_order_execution_facts newer_execution
        WHERE newer_execution.work_order_id=execution.work_order_id AND newer_execution.execution_version>execution.execution_version)
    JOIN public.task_scope_change_approvals customer_approval ON customer_approval.proposal_id=proposal.id AND customer_approval.approver_role='CUSTOMER'
    JOIN public.task_scope_change_approvals provider_approval ON provider_approval.proposal_id=proposal.id AND provider_approval.approver_role='PROVIDER'
    JOIN public.users customer_approval_actor ON customer_approval_actor.id=customer_approval.actor_id
    JOIN public.users provider_approval_actor ON provider_approval_actor.id=provider_approval.actor_id
    JOIN LATERAL (SELECT financial.id,financial.operation_id,financial.event_kind,financial.status,financial.expected_version,
      financial.occurred_at,financial.change_order_id,financial.scope_version_id,financial.predecessor_event_id,financial.amount_cents,financial.currency
      FROM public.task_financial_security_events financial WHERE financial.task_draft_id=work_order.task_draft_id
      ORDER BY financial.expected_version DESC LIMIT 1 FOR UPDATE NOWAIT) latest_financial ON TRUE
    WHERE proposal.id=proposal_id_value AND proposal.universal_contract_version=1 AND proposal.application_contract_version=1
      AND task.work_order_id=work_order.id AND work_order.execution_contract_version=1 AND task.active_scope_version_id=scope.id
      AND ((task.business_organization_id IS NULL AND task.poster_id=actor.resolved_user_id)
        OR (task.business_organization_id IS NOT NULL AND customer_organization.status='ACTIVE'
          AND customer_organization.client_enabled IS TRUE
          AND public.business_membership_has_action(task.business_organization_id,actor.resolved_user_id,'APPROVE_SPEND')))
      AND task.universal_contract_version=1 AND draft.universal_contract_version=1
      AND task.automation_classification='CONTROLLED_TEST' AND task.worker_id IS NULL
      AND task.universal_payment_posture='PAYMENT_CREATION_FROZEN'
      AND current_actor.firebase_uid=actor.verified_subject AND current_actor.account_status='ACTIVE'
      AND current_actor.is_minor IS FALSE AND COALESCE(current_actor.is_banned,FALSE) IS FALSE
      AND provider.account_status='ACTIVE' AND provider.is_minor IS FALSE AND COALESCE(provider.is_banned,FALSE) IS FALSE
      AND NOT EXISTS(SELECT 1 FROM public.task_completion_facts completion WHERE completion.work_order_id=work_order.id)
      AND NOT EXISTS(SELECT 1 FROM public.task_reconciliation_facts reconciliation WHERE reconciliation.work_order_id=work_order.id);
    IF NOT FOUND OR context.provider_authority_current IS NOT TRUE THEN
      RAISE EXCEPTION 'HXUV1-COPREPARE-13: CHANGE_ORDER_CONTEXT_UNAVAILABLE'; END IF;
    IF context.change_order_kind IS DISTINCT FROM kind_value THEN
      RAISE EXCEPTION 'HXUV1-COPREPARE-13: CHANGE_ORDER_IDEMPOTENCY_CONFLICT'; END IF;
    amendment_version:=context.latest_amendment_version;
    financial_version_matches:=CASE WHEN prepared_exists THEN
      (context.latest_financial_version=expected_financial
        AND context.latest_financial_event_id=witness.predecessor_event_id
        AND context.latest_financial_operation_id=witness.predecessor_operation_id::TEXT)
      OR (context.latest_financial_version::BIGINT=expected_financial::BIGINT+1
        AND context.latest_financial_operation_id=witness.adjustment_operation_id::TEXT
        AND context.latest_financial_event_kind='ADJUSTMENT_AUTHORIZED' AND context.latest_financial_status='SUCCEEDED'
        AND context.latest_financial_change_order_id=witness.proposal_id
        AND context.latest_financial_scope_version_id=witness.replacement_scope_version_id
        AND context.latest_financial_predecessor_event_id=witness.predecessor_event_id
        AND context.latest_financial_amount_cents=witness.customer_total_cents AND context.latest_financial_currency=witness.currency)
      ELSE context.latest_financial_version=expected_financial END;
    IF (CASE WHEN prepared_exists THEN context.proposal_status='APPROVED'
          AND context.approved_version_id=witness.replacement_scope_version_id
        ELSE context.proposal_status='PENDING' AND context.approved_version_id IS NULL END) IS NOT TRUE
       OR context.proposal_version IS DISTINCT FROM expected_proposal OR context.scope_version IS DISTINCT FROM expected_scope
       OR amendment_version IS DISTINCT FROM expected_amendment OR context.execution_version IS DISTINCT FROM expected_execution
       OR financial_version_matches IS NOT TRUE OR context.base_version_id IS DISTINCT FROM context.scope_version_id THEN
      RAISE EXCEPTION 'HXUV1-COPREPARE-13: CHANGE_ORDER_VERSION_CONFLICT'; END IF;
    IF prepared_exists AND (witness.work_order_id IS DISTINCT FROM context.work_order_id OR witness.task_id IS DISTINCT FROM context.task_id
       OR witness.task_draft_id IS DISTINCT FROM context.task_draft_id OR witness.eligibility_decision_id IS DISTINCT FROM context.eligibility_decision_id
       OR witness.base_scope_version_id IS DISTINCT FROM context.scope_version_id
       OR witness.customer_total_cents IS DISTINCT FROM context.proposed_customer_total_cents
       OR witness.provider_payout_cents IS DISTINCT FROM context.proposed_provider_payout_cents OR witness.currency IS DISTINCT FROM context.currency) THEN
      RAISE EXCEPTION 'HXUV1-COPREPARE-13: CHANGE_ORDER_AUTHORITY_REVOKED'; END IF;
    IF context.execution_state NOT IN ('MATERIALIZED','ACKNOWLEDGED','EN_ROUTE','ARRIVED','PAUSED') THEN
      RAISE EXCEPTION 'HXUV1-COPREPARE-13: CHANGE_ORDER_STATE_CONFLICT'; END IF;
    IF context.customer_approval_decision IS DISTINCT FROM 'APPROVED' OR context.provider_approval_decision IS DISTINCT FROM 'APPROVED'
       OR context.customer_approval_current IS NOT TRUE OR context.provider_approval_current IS NOT TRUE
       OR context.customer_approval_actor_id IS NOT DISTINCT FROM context.provider_approval_actor_id THEN
      RAISE EXCEPTION 'HXUV1-COPREPARE-13: CHANGE_ORDER_INDEPENDENT_APPROVAL_REQUIRED'; END IF;
    IF context.latest_financial_status IS DISTINCT FROM 'SUCCEEDED'
       OR context.latest_financial_event_kind NOT IN ('SECURED','ADJUSTMENT_AUTHORIZED') THEN
      RAISE EXCEPTION 'HXUV1-COPREPARE-13: CHANGE_ORDER_STATE_CONFLICT'; END IF;
    IF context.proposed_title IS NULL OR context.proposed_title='' OR context.proposed_description IS NULL OR context.proposed_description=''
       OR context.proposed_scope_sha256 IS NULL OR pg_catalog.jsonb_typeof(context.proposed_checklist) IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'HXUV1-COPREPARE-13: CHANGE_ORDER_CONTEXT_UNAVAILABLE'; END IF;
    IF pg_catalog.jsonb_array_length(context.proposed_checklist)=0 OR EXISTS(
      SELECT 1 FROM pg_catalog.jsonb_array_elements(context.proposed_checklist) entry(value)
      WHERE pg_catalog.jsonb_typeof(entry.value) IS DISTINCT FROM 'string' OR pg_catalog.btrim(entry.value#>>'{}',trim_chars)='') THEN
      RAISE EXCEPTION 'HXUV1-COPREPARE-13: CHANGE_ORDER_CONTEXT_UNAVAILABLE'; END IF;
    IF context.title IS NOT DISTINCT FROM context.proposed_title AND context.description IS NOT DISTINCT FROM context.proposed_description
       AND context.requirements IS NOT DISTINCT FROM context.proposed_requirements AND context.checklist IS NOT DISTINCT FROM context.proposed_checklist THEN
      RAISE EXCEPTION 'HXUV1-COPREPARE-13: CHANGE_ORDER_STATE_CONFLICT'; END IF;
    customer_total:=CASE WHEN is_price_change THEN context.proposed_customer_total_cents ELSE context.customer_total_cents END;
    provider_payout:=CASE WHEN is_price_change THEN context.proposed_provider_payout_cents ELSE context.provider_payout_cents END;
    IF context.customer_total_cents IS NULL OR context.customer_total_cents<=0
       OR context.provider_payout_cents IS NULL OR context.provider_payout_cents<=0
       OR customer_total IS NULL OR customer_total<=0 OR provider_payout IS NULL OR provider_payout<=0 THEN
      RAISE EXCEPTION 'HXUV1-COPREPARE-13: CHANGE_ORDER_CONTEXT_UNAVAILABLE'; END IF;
    IF provider_payout>customer_total OR context.financial_adjustment_required IS DISTINCT FROM is_price_change
       OR (is_price_change AND customer_total=context.customer_total_cents) THEN
      RAISE EXCEPTION 'HXUV1-COPREPARE-13: CHANGE_ORDER_STATE_CONFLICT'; END IF;
    scope_sha:=public.universal_v1_change_scope_sha256(context.proposed_title,context.proposed_description,context.proposed_requirements,
      context.proposed_checklist,customer_total,provider_payout,context.currency);
    IF scope_sha IS DISTINCT FROM context.proposed_scope_sha256 THEN
      RAISE EXCEPTION 'HXUV1-COPREPARE-13: CHANGE_ORDER_SCOPE_HASH_MISMATCH'; END IF;
    adjustment_operation_id_value:=public.universal_v1_work_order_operation_id_v1(key_value,'adjust');
    IF prepared_exists THEN
      SELECT * INTO STRICT replacement FROM public.task_scope_versions scope WHERE scope.id=witness.replacement_scope_version_id;
      IF replacement.scope_hash IS DISTINCT FROM scope_sha OR replacement.version::BIGINT IS DISTINCT FROM expected_scope::BIGINT+1
         OR replacement.customer_total_cents IS DISTINCT FROM customer_total OR replacement.hustler_payout_cents IS DISTINCT FROM provider_payout
         OR replacement.currency IS DISTINCT FROM context.currency OR witness.adjustment_operation_id IS DISTINCT FROM adjustment_operation_id_value THEN
        RAISE EXCEPTION 'HXUV1-COPREPARE-13: CHANGE_ORDER_IDEMPOTENCY_CONFLICT'; END IF;
    ELSE
      IF expected_scope=2147483647 OR expected_amendment=2147483647 OR expected_execution=2147483647
         OR (is_price_change AND expected_financial=2147483647) THEN
        RAISE EXCEPTION 'HXUV1-COPREPARE-13: CHANGE_ORDER_VERSION_CONFLICT'; END IF;
      INSERT INTO public.task_scope_versions AS inserted (
        task_id,version,scope_hash,title,description,requirements,checklist,customer_total_cents,hustler_payout_cents,
        source,change_summary,created_by,supersedes_version_id,universal_contract_version,currency
      ) VALUES (context.task_id,context.scope_version+1,scope_sha,context.proposed_title,context.proposed_description,
        context.proposed_requirements,context.proposed_checklist,customer_total,provider_payout,'APPROVED_CHANGE',
        context.observed_scope_summary,actor.resolved_user_id,context.scope_version_id,1,context.currency)
      RETURNING inserted.id INTO new_scope_id;
      IF new_scope_id IS NULL THEN RAISE EXCEPTION 'HXUV1-COPREPARE-13: CHANGE_ORDER_MATERIALIZATION_FAILED'; END IF;
      UPDATE public.task_scope_change_proposals proposal SET status='APPROVED',reviewed_by=actor.resolved_user_id,
        reviewed_at=pg_catalog.clock_timestamp(),decision_reason='Customer authorized exact dual-approved amendment',
        approved_version_id=new_scope_id,updated_at=pg_catalog.clock_timestamp()
      WHERE proposal.id=proposal_id_value AND proposal.status='PENDING';
      GET DIAGNOSTICS changed_count=ROW_COUNT;
      IF changed_count<>1 THEN RAISE EXCEPTION 'HXUV1-COPREPARE-13: CHANGE_ORDER_VERSION_CONFLICT'; END IF;
      IF is_price_change THEN
        witness_sha:=public.universal_v1_change_order_materialization_request_sha256(proposal_id_value,key_value,actor.resolved_user_id,
          context.work_order_id,context.task_id,context.task_draft_id,context.eligibility_decision_id,context.scope_version_id,new_scope_id,
          expected_proposal,expected_scope,expected_amendment,expected_execution,expected_financial,
          context.latest_financial_event_id,context.latest_financial_operation_id::UUID,adjustment_operation_id_value);
        -- Exact legacy writer projection; v6 owns occurred_at/prepared_at, v9 checks
        -- predecessor expiry, and v7 refuses an already-reserved finance slot.
        INSERT INTO public.universal_v1_change_order_materialization_commands AS inserted (
          proposal_id,idempotency_key,request_sha256,actor_user_id,work_order_id,task_id,task_draft_id,eligibility_decision_id,
          base_scope_version_id,replacement_scope_version_id,expected_proposal_version,expected_scope_version,
          expected_amendment_version,expected_execution_version,expected_financial_version,predecessor_event_id,
          predecessor_operation_id,adjustment_operation_id,customer_total_cents,provider_payout_cents,currency,occurred_at
        ) VALUES (proposal_id_value,key_value,witness_sha,actor.resolved_user_id,context.work_order_id,context.task_id,context.task_draft_id,
          context.eligibility_decision_id,context.scope_version_id,new_scope_id,expected_proposal,expected_scope,expected_amendment,
          expected_execution,expected_financial,context.latest_financial_event_id,context.latest_financial_operation_id::UUID,
          adjustment_operation_id_value,customer_total,provider_payout,context.currency,
          GREATEST(client_time,context.latest_financial_occurred_at+INTERVAL '1 millisecond')) RETURNING inserted.* INTO witness;
        IF witness.proposal_id IS NULL OR witness.request_sha256 !~ '^[a-f0-9]{64}$' THEN
          RAISE EXCEPTION 'HXUV1-COPREPARE-13: CHANGE_ORDER_MATERIALIZATION_FAILED'; END IF;
      ELSE
        predecessor_amendment_id:=CASE WHEN amendment_version=0 THEN NULL ELSE context.latest_amendment_id END;
        business_sha:=public.universal_v1_change_amendment_request_sha256(context.work_order_id,amendment_version+1,
          predecessor_amendment_id,proposal_id_value,new_scope_id,NULL,expected_financial,actor.resolved_user_id,key_value);
        UPDATE public.tasks task SET title=context.proposed_title,description=context.proposed_description,
          requirements=context.proposed_requirements,price=customer_total,hustler_payout_cents=provider_payout,
          platform_margin_cents=customer_total-provider_payout,scope_hash=scope_sha,active_scope_version_id=new_scope_id,
          updated_at=pg_catalog.clock_timestamp()
        WHERE task.id=context.task_id AND task.active_scope_version_id=context.scope_version_id AND task.worker_id IS NULL
          AND task.universal_contract_version=1 AND task.automation_classification='CONTROLLED_TEST'
          AND task.universal_payment_posture='PAYMENT_CREATION_FROZEN'
        RETURNING task.worker_id INTO projected_worker_id;
        GET DIAGNOSTICS changed_count=ROW_COUNT;
        IF changed_count<>1 OR projected_worker_id IS NOT NULL THEN
          RAISE EXCEPTION 'HXUV1-COPREPARE-13: CHANGE_ORDER_HARD_ASSIGNMENT_FORBIDDEN'; END IF;
        INSERT INTO public.task_work_order_amendments AS inserted (
          work_order_id,amendment_version,supersedes_amendment_id,change_order_id,scope_version_id,adjustment_event_id,
          expected_financial_version,idempotency_key,request_sha256,materialized_by
        ) VALUES (context.work_order_id,amendment_version+1,predecessor_amendment_id,proposal_id_value,new_scope_id,NULL,
          expected_financial,key_value,business_sha,actor.resolved_user_id) RETURNING inserted.id INTO new_amendment_id;
        IF new_amendment_id IS NULL THEN RAISE EXCEPTION 'HXUV1-COPREPARE-13: CHANGE_ORDER_MATERIALIZATION_FAILED'; END IF;
        INSERT INTO public.task_work_order_execution_facts AS inserted (
          work_order_id,task_id,scope_version_id,execution_version,supersedes_fact_id,state,transition_kind,completion_fact_id,
          work_order_amendment_id,actor_role,actor_user_id,reason,idempotency_key,request_sha256,client_occurred_at,policy_version
        ) VALUES (context.work_order_id,context.task_id,new_scope_id,context.execution_version+1,context.execution_fact_id,
          context.execution_state,'APPLY_AMENDMENT',NULL,new_amendment_id,'CUSTOMER',actor.resolved_user_id,NULL,key_value||':execution',
          public.universal_v1_execution_internal_request_sha256(actor.resolved_user_id,context.work_order_id,'APPLY_AMENDMENT',
            context.execution_state,context.execution_version,new_scope_id,NULL,new_amendment_id,key_value||':execution',client_time,NULL),
          client_time,'universal-v1-work-order-execution-1.0.0') RETURNING inserted.id INTO new_execution_id;
        IF new_execution_id IS NULL THEN RAISE EXCEPTION 'HXUV1-COPREPARE-13: CHANGE_ORDER_MATERIALIZATION_FAILED'; END IF;
        result:=pg_catalog.jsonb_build_object('completed',TRUE,'result',pg_catalog.jsonb_build_object(
          'amendment_id',new_amendment_id,'amendment_version',amendment_version+1,'proposal_id',proposal_id_value,
          'scope_version_id',new_scope_id,'scope_version',context.scope_version+1,'adjustment_event_id',NULL,'provider_kind',NULL,
          'replayed',FALSE,'payment_creation_performed',FALSE,'hard_assignment_created',FALSE));
      END IF;
    END IF;
    IF is_price_change THEN
      result:=pg_catalog.jsonb_build_object('completed',FALSE,'idempotencyKey',witness.idempotency_key,
        'requestSha256',witness.request_sha256,'context',pg_catalog.jsonb_build_object(
          'proposalId',witness.proposal_id,'workOrderId',witness.work_order_id,'taskId',witness.task_id,'taskDraftId',witness.task_draft_id,
          'eligibilityDecisionId',witness.eligibility_decision_id,'scopeVersionId',witness.replacement_scope_version_id,
          'scopeVersion',witness.expected_scope_version+1,'customerTotalCents',witness.customer_total_cents,'currency',witness.currency,
          'predecessorEventId',witness.predecessor_event_id,'predecessorOperationId',witness.predecessor_operation_id,
          'expectedFinancialVersion',witness.expected_financial_version,'adjustmentOperationId',witness.adjustment_operation_id,
          'occurredAt',pg_catalog.to_char(witness.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
    END IF;
  END IF;
  IF pg_catalog.abs(EXTRACT(EPOCH FROM pg_catalog.clock_timestamp())*1000-epoch_value)>300000 THEN
    RAISE EXCEPTION 'HXUV1-COPREPARE-13: CHANGE_ORDER_REQUEST_STALE'; END IF;
  actor_user_id:=actor.resolved_user_id; actor_assertion_id:=actor.assertion_id;
  actor_request_sha256:=request.actor_request_sha256; target_authority_id:=request.target_authority_id;
  command_release_sha256:=request.release_manifest_sha256;
  RETURN NEXT;
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'HXUV1-COPREPARE-13: CHANGE_ORDER_IDEMPOTENCY_CONFLICT';
END;
$$;

REVOKE ALL ON FUNCTION public.hxos_prepare_authenticated_change_order_v13(TEXT,JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.universal_v1_change_amendment_request_sha256(UUID,INTEGER,UUID,UUID,UUID,UUID,INTEGER,UUID,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.universal_v1_change_order_materialization_request_sha256(UUID,TEXT,UUID,UUID,UUID,UUID,UUID,UUID,UUID,INTEGER,INTEGER,INTEGER,INTEGER,INTEGER,UUID,UUID,UUID) FROM PUBLIC;


CREATE OR REPLACE FUNCTION public.hxos_finalize_authenticated_change_order_v13(
  actor_assertion_token TEXT, command_payload JSONB
) RETURNS TABLE(
  result JSONB,actor_user_id UUID,actor_assertion_id UUID,actor_request_sha256 TEXT,
  target_authority_id UUID,command_release_sha256 TEXT
)
LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE
SET search_path=pg_catalog AS $$
DECLARE
  request RECORD; actor RECORD; context RECORD; amendment RECORD; execution RECORD;
  predecessor_amendment RECORD; predecessor_execution RECORD;
  bridge RECORD; journal RECORD; outcome RECORD;
  witness public.universal_v1_change_order_materialization_commands%ROWTYPE;
  proposal public.task_scope_change_proposals%ROWTYPE;
  replacement public.task_scope_versions%ROWTYPE;
  base_scope public.task_scope_versions%ROWTYPE;
  financial public.task_financial_security_events%ROWTYPE;
  current_execution RECORD;
  pass INTEGER; actor_ids UUID[];
  locked_dependency_identity JSONB; observed_dependency_identity JSONB; financial_progress JSONB;
  identity_payload JSONB; witness_sha CHAR(64); amendment_sha CHAR(64); execution_sha CHAR(64);
  key_value TEXT; execution_key TEXT; adjustment_id UUID; amendment_id_value UUID;
  finalization_at TIMESTAMPTZ; next_amendment_version INTEGER; next_execution_version INTEGER;
  changed_count BIGINT; replay BOOLEAN:=FALSE; authority_current BOOLEAN;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'HXUV1-COMATERIALIZE-13-READ_COMMITTED_REQUIRED';
  END IF;
  SELECT * INTO STRICT request
    FROM public.hxos_build_change_order_materialization_actor_request_v13(
      'FINALIZE_FAKE_CHANGE_ORDER',command_payload);
  SELECT * INTO STRICT actor FROM hx_authority.consume_universal_v1_actor_assertion_v1(
    actor_assertion_token,'FINALIZE_FAKE_CHANGE_ORDER',request.canonical_request,request.environment);
  IF pg_catalog.abs(EXTRACT(EPOCH FROM pg_catalog.clock_timestamp())*1000-
      (command_payload->>'client_timestamp_epoch_ms')::NUMERIC)>300000 THEN
    RAISE EXCEPTION 'HXUV1-COMATERIALIZE-13-CLIENT_TIMESTAMP_INVALID';
  END IF;
  key_value:=command_payload->>'idempotency_key';
  adjustment_id:=(command_payload->>'adjustment_event_id')::UUID;
  -- Safe, exact milliseconds are checked by the shared closed-payload builder.
  -- This new authenticated finalization time is NOT Phase A's original time.
  finalization_at:=TIMESTAMPTZ 'epoch'+
    ((command_payload->>'client_timestamp_epoch_ms')::BIGINT/1000)*INTERVAL '1 second'+
    ((command_payload->>'client_timestamp_epoch_ms')::BIGINT%1000)*INTERVAL '1 millisecond';

  -- Authenticate ownership before any proposal/fulfillment/foreign row locks.
  -- This root check deliberately permits completed-history replay after
  -- provider revocation; current provider/approval authority is checked below
  -- only when a new amendment would be inserted.
  FOR pass IN 0..1 LOOP
    SELECT original.work_order_id,original.task_id,original.task_draft_id,
      original.eligibility_decision_id,original.base_scope_version_id,
      original.replacement_scope_version_id,task.poster_id,
      task.business_organization_id AS customer_organization_id,
      work_order.provider_user_id,work_order.provider_organization_id,
      eligibility.trade_credential_id,customer_approval.actor_id AS customer_approval_actor_id,
      provider_approval.actor_id AS provider_approval_actor_id
    INTO context
    FROM public.universal_v1_change_order_materialization_commands original
    JOIN public.tasks task ON task.id=original.task_id
    JOIN public.task_drafts draft ON draft.id=original.task_draft_id AND draft.task_id=task.id
    JOIN public.task_work_orders work_order ON work_order.id=original.work_order_id
      AND work_order.task_id=task.id AND work_order.task_draft_id=draft.id
      AND work_order.eligibility_decision_id=original.eligibility_decision_id
    JOIN public.task_provider_eligibility_decisions eligibility
      ON eligibility.id=original.eligibility_decision_id
    JOIN public.users current_actor ON current_actor.id=actor.resolved_user_id
    LEFT JOIN public.business_organizations customer_organization
      ON customer_organization.id=task.business_organization_id
    LEFT JOIN public.task_scope_change_approvals customer_approval
      ON customer_approval.proposal_id=original.proposal_id AND customer_approval.approver_role='CUSTOMER'
    LEFT JOIN public.task_scope_change_approvals provider_approval
      ON provider_approval.proposal_id=original.proposal_id AND provider_approval.approver_role='PROVIDER'
    WHERE original.proposal_id=(command_payload->>'proposal_id')::UUID
      AND original.idempotency_key=key_value AND original.actor_user_id=actor.resolved_user_id
      AND task.work_order_id=work_order.id AND task.universal_contract_version=1
      AND task.automation_classification='CONTROLLED_TEST'
      AND task.universal_payment_posture='PAYMENT_CREATION_FROZEN' AND task.worker_id IS NULL
      AND draft.poster_user_id=task.poster_id AND draft.claimed_at IS NOT NULL
      AND draft.universal_contract_version=1 AND draft.ingress_origin='BACKEND_POSTGRESQL'
      AND current_actor.account_status='ACTIVE' AND current_actor.is_minor IS FALSE
      AND COALESCE(current_actor.is_banned,FALSE) IS FALSE
      AND current_actor.firebase_uid=actor.verified_subject
      AND ((task.business_organization_id IS NULL AND task.poster_id=actor.resolved_user_id)
        OR (task.business_organization_id IS NOT NULL AND customer_organization.status='ACTIVE'
          AND customer_organization.client_enabled IS TRUE
          AND public.business_membership_has_action(
            task.business_organization_id,actor.resolved_user_id,'APPROVE_SPEND') IS TRUE));
    IF NOT FOUND THEN
      RAISE EXCEPTION 'HXUV1-COMATERIALIZE-13: CHANGE_ORDER_CONTEXT_UNAVAILABLE';
    END IF;
    observed_dependency_identity:=pg_catalog.jsonb_build_array(
      context.work_order_id,context.task_id,context.task_draft_id,context.eligibility_decision_id,
      context.base_scope_version_id,context.replacement_scope_version_id,context.poster_id,
      context.customer_organization_id,context.provider_user_id,context.provider_organization_id,
      context.trade_credential_id,context.customer_approval_actor_id,context.provider_approval_actor_id);
    IF pass=1 THEN
      IF observed_dependency_identity IS DISTINCT FROM locked_dependency_identity THEN
        RAISE EXCEPTION 'HXUV1-COMATERIALIZE-13: CHANGE_ORDER_VERSION_CONFLICT';
      END IF;
      EXIT;
    END IF;
    locked_dependency_identity:=observed_dependency_identity;
    IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(
        'universal-v1-change-order-proposal:'||(command_payload->>'proposal_id'),0))
       OR NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(
        'fulfillment:'||context.work_order_id::TEXT,0)) THEN
      RAISE EXCEPTION 'HXUV1-COMATERIALIZE-13-LOCK_BUSY';
    END IF;
    PERFORM 1 FROM public.task_work_orders WHERE id=context.work_order_id FOR UPDATE NOWAIT;
    PERFORM 1 FROM public.tasks WHERE id=context.task_id FOR UPDATE NOWAIT;
    PERFORM 1 FROM public.task_drafts WHERE id=context.task_draft_id FOR SHARE NOWAIT;
    PERFORM 1 FROM public.task_scope_change_proposals
      WHERE id=(command_payload->>'proposal_id')::UUID FOR UPDATE NOWAIT;
    PERFORM 1 FROM public.task_provider_eligibility_decisions
      WHERE id=context.eligibility_decision_id FOR SHARE NOWAIT;
    PERFORM 1 FROM public.task_scope_versions
      WHERE id IN (context.base_scope_version_id,context.replacement_scope_version_id)
      ORDER BY id FOR SHARE NOWAIT;
    PERFORM 1 FROM public.task_scope_change_approvals
      WHERE proposal_id=(command_payload->>'proposal_id')::UUID ORDER BY id FOR SHARE NOWAIT;
    SELECT pg_catalog.array_agg(actor_id ORDER BY actor_id) INTO actor_ids FROM (
      SELECT actor.resolved_user_id AS actor_id UNION SELECT context.poster_id
      UNION SELECT context.provider_user_id UNION SELECT context.customer_approval_actor_id
      UNION SELECT context.provider_approval_actor_id
    ) exact_actors WHERE actor_id IS NOT NULL;
    -- UPDATE locks block the users FK's KEY SHARE for new memberships,
    -- including a previously absent conflicting role. SHARE alone does not.
    PERFORM 1 FROM public.users WHERE id=ANY(actor_ids) ORDER BY id FOR UPDATE NOWAIT;
    PERFORM 1 FROM public.business_organizations
      WHERE id IN (context.customer_organization_id,context.provider_organization_id)
      ORDER BY id FOR SHARE NOWAIT;
    PERFORM 1 FROM public.business_memberships
      WHERE organization_id IN (context.customer_organization_id,context.provider_organization_id)
        AND user_id=ANY(actor_ids) ORDER BY organization_id,user_id,id FOR SHARE NOWAIT;
    PERFORM 1 FROM public.capability_profiles
      WHERE user_id=context.provider_user_id ORDER BY user_id FOR SHARE NOWAIT;
    PERFORM 1 FROM public.business_credentials WHERE id=context.trade_credential_id FOR SHARE NOWAIT;
    PERFORM 1 FROM public.verified_trades WHERE user_id=context.provider_user_id
      AND provider_organization_id IS NOT DISTINCT FROM context.provider_organization_id
      AND business_credential_id IS NOT DISTINCT FROM context.trade_credential_id
      ORDER BY user_id,trade FOR SHARE NOWAIT;
  END LOOP;
  -- Revalidate the consumed Firebase subject after the sorted user locks.
  PERFORM 1 FROM public.users current_actor WHERE current_actor.id=actor.resolved_user_id
    AND current_actor.firebase_uid=actor.verified_subject;
  IF NOT FOUND THEN RAISE EXCEPTION 'HXUV1-COMATERIALIZE-13: CHANGE_ORDER_AUTHORITY_REVOKED'; END IF;

  SELECT * INTO STRICT witness FROM public.universal_v1_change_order_materialization_commands original
    WHERE original.proposal_id=(command_payload->>'proposal_id')::UUID
      AND original.idempotency_key=key_value AND original.actor_user_id=actor.resolved_user_id;
  identity_payload:=pg_catalog.jsonb_build_object('proposal_id',witness.proposal_id,
    'expected_proposal_version',witness.expected_proposal_version,
    'expected_scope_version',witness.expected_scope_version,
    'expected_amendment_version',witness.expected_amendment_version,
    'expected_execution_version',witness.expected_execution_version,
    'expected_financial_version',witness.expected_financial_version,'idempotency_key',witness.idempotency_key);
  IF identity_payload IS DISTINCT FROM command_payload-
      ARRAY['phase_request_sha256','adjustment_event_id','client_timestamp_epoch_ms']::TEXT[]
     OR pg_catalog.btrim(witness.request_sha256) IS DISTINCT FROM command_payload->>'phase_request_sha256' THEN
    RAISE EXCEPTION 'HXUV1-COMATERIALIZE-13: CHANGE_ORDER_IDEMPOTENCY_CONFLICT';
  END IF;
  witness_sha:=public.universal_v1_change_order_materialization_request_sha256(
    witness.proposal_id,witness.idempotency_key,witness.actor_user_id,witness.work_order_id,
    witness.task_id,witness.task_draft_id,witness.eligibility_decision_id,
    witness.base_scope_version_id,witness.replacement_scope_version_id,
    witness.expected_proposal_version,witness.expected_scope_version,witness.expected_amendment_version,
    witness.expected_execution_version,witness.expected_financial_version,witness.predecessor_event_id,
    witness.predecessor_operation_id,witness.adjustment_operation_id);
  IF witness.request_sha256 IS DISTINCT FROM witness_sha
     OR witness.adjustment_operation_id IS DISTINCT FROM
       public.universal_v1_work_order_operation_id_v1(witness.idempotency_key,'adjust') THEN
    RAISE EXCEPTION 'HXUV1-COMATERIALIZE-13: CHANGE_ORDER_IDEMPOTENCY_CONFLICT';
  END IF;
  SELECT * INTO STRICT proposal FROM public.task_scope_change_proposals p WHERE p.id=witness.proposal_id;
  SELECT * INTO STRICT base_scope FROM public.task_scope_versions s WHERE s.id=witness.base_scope_version_id;
  SELECT * INTO STRICT replacement FROM public.task_scope_versions s WHERE s.id=witness.replacement_scope_version_id;
  IF proposal.universal_contract_version IS DISTINCT FROM 1 OR proposal.application_contract_version IS DISTINCT FROM 1
     OR proposal.task_id IS DISTINCT FROM witness.task_id OR proposal.status IS DISTINCT FROM 'APPROVED'
     OR proposal.change_order_kind IS DISTINCT FROM 'PRICE_AND_SCOPE' OR proposal.financial_adjustment_required IS NOT TRUE
     OR proposal.proposal_version IS DISTINCT FROM witness.expected_proposal_version
     OR proposal.base_version_id IS DISTINCT FROM witness.base_scope_version_id
     OR proposal.approved_version_id IS DISTINCT FROM witness.replacement_scope_version_id
     OR proposal.reviewed_by IS DISTINCT FROM witness.actor_user_id
     OR proposal.proposed_customer_total_cents IS DISTINCT FROM witness.customer_total_cents
     OR proposal.proposed_provider_payout_cents IS DISTINCT FROM witness.provider_payout_cents
     OR base_scope.task_id IS DISTINCT FROM witness.task_id OR base_scope.version IS DISTINCT FROM witness.expected_scope_version
     OR base_scope.universal_contract_version IS DISTINCT FROM 1
     OR replacement.universal_contract_version IS DISTINCT FROM 1 OR replacement.task_id IS DISTINCT FROM witness.task_id
     OR replacement.version::BIGINT IS DISTINCT FROM witness.expected_scope_version::BIGINT+1
     OR replacement.supersedes_version_id IS DISTINCT FROM base_scope.id
     OR replacement.source IS DISTINCT FROM 'APPROVED_CHANGE'
     OR replacement.created_by IS DISTINCT FROM witness.actor_user_id
     OR replacement.change_summary IS DISTINCT FROM proposal.observed_scope_summary
     OR replacement.title IS DISTINCT FROM proposal.proposed_title
     OR replacement.description IS DISTINCT FROM proposal.proposed_description
     OR replacement.requirements IS DISTINCT FROM proposal.proposed_requirements
     OR replacement.checklist IS DISTINCT FROM proposal.proposed_checklist
     OR replacement.customer_total_cents IS DISTINCT FROM witness.customer_total_cents
     OR replacement.hustler_payout_cents IS DISTINCT FROM witness.provider_payout_cents
     OR replacement.currency IS DISTINCT FROM witness.currency OR replacement.currency IS DISTINCT FROM base_scope.currency
     OR witness.customer_total_cents=base_scope.customer_total_cents
     OR witness.customer_total_cents<=0 OR witness.provider_payout_cents<=0
     OR witness.provider_payout_cents>witness.customer_total_cents
     OR replacement.scope_hash IS DISTINCT FROM proposal.proposed_scope_sha256
     OR replacement.scope_hash IS DISTINCT FROM public.universal_v1_change_scope_sha256(
       replacement.title,replacement.description,replacement.requirements,replacement.checklist,
       replacement.customer_total_cents,replacement.hustler_payout_cents,replacement.currency) THEN
    RAISE EXCEPTION 'HXUV1-COMATERIALIZE-13: CHANGE_ORDER_SCOPE_HASH_MISMATCH';
  END IF;

  -- These immutable facts remain exact on historical replay even when a newer
  -- financial or execution fact now exists. Fresh-effect head checks follow.
  SELECT * INTO financial FROM public.task_financial_security_events f WHERE f.id=adjustment_id;
  SELECT b.bridge_id,b.task_financial_security_event_id,b.fake_operation_id,b.fake_operation_kind,
    b.lifecycle_event_kind,b.lifecycle_status,b.command_id,b.outcome_fact_id,b.prepared_command_id
    INTO bridge FROM public.universal_v1_fake_financial_lifecycle_bridges b
    WHERE b.task_financial_security_event_id=adjustment_id;
  SELECT j.command_id,j.operation_id,j.operation_kind,j.provider_kind,j.provider_expected_version,
    j.idempotency_key,j.recorded_actor_id,j.task_draft_id,j.task_id,j.work_order_id,j.prepared_financial_command_id
    INTO journal FROM public.financial_provider_command_journal j WHERE j.command_id=bridge.command_id;
  SELECT o.outcome_fact_id,o.command_id,o.outcome_kind,o.retryable INTO outcome
    FROM public.financial_provider_command_outcome_facts o WHERE o.outcome_fact_id=bridge.outcome_fact_id;
  IF financial.id IS NULL OR bridge.bridge_id IS NULL OR journal.command_id IS NULL OR outcome.outcome_fact_id IS NULL
     OR financial.operation_id IS DISTINCT FROM witness.adjustment_operation_id::TEXT
     OR financial.idempotency_key IS DISTINCT FROM witness.idempotency_key||':adjust'
     OR financial.event_kind IS DISTINCT FROM 'ADJUSTMENT_AUTHORIZED' OR financial.status IS DISTINCT FROM 'SUCCEEDED'
     OR financial.provider_kind IS DISTINCT FROM 'FAKE' OR financial.recorded_by IS DISTINCT FROM witness.actor_user_id
     OR financial.task_draft_id IS DISTINCT FROM witness.task_draft_id OR financial.task_id IS DISTINCT FROM witness.task_id
     OR financial.eligibility_decision_id IS DISTINCT FROM witness.eligibility_decision_id
     OR financial.scope_version_id IS DISTINCT FROM witness.replacement_scope_version_id
     OR financial.change_order_id IS DISTINCT FROM witness.proposal_id
     OR financial.predecessor_event_id IS DISTINCT FROM witness.predecessor_event_id
     OR financial.expected_version::BIGINT IS DISTINCT FROM witness.expected_financial_version::BIGINT+1
     OR financial.amount_cents IS DISTINCT FROM witness.customer_total_cents OR financial.currency IS DISTINCT FROM witness.currency
     OR bridge.fake_operation_id IS DISTINCT FROM witness.adjustment_operation_id
     OR bridge.fake_operation_kind IS DISTINCT FROM 'ADJUST'
     OR bridge.lifecycle_event_kind IS DISTINCT FROM 'ADJUSTMENT_AUTHORIZED' OR bridge.lifecycle_status IS DISTINCT FROM 'SUCCEEDED'
     OR journal.operation_id IS DISTINCT FROM witness.adjustment_operation_id OR journal.operation_kind IS DISTINCT FROM 'ADJUST'
     OR journal.provider_kind IS DISTINCT FROM 'FAKE' OR journal.provider_expected_version IS DISTINCT FROM 0
     OR journal.idempotency_key IS DISTINCT FROM witness.idempotency_key||':adjust'
     OR journal.recorded_actor_id IS DISTINCT FROM witness.actor_user_id
     OR journal.task_draft_id IS DISTINCT FROM witness.task_draft_id OR journal.task_id IS DISTINCT FROM witness.task_id
     OR journal.work_order_id IS DISTINCT FROM witness.work_order_id
     OR journal.prepared_financial_command_id IS DISTINCT FROM bridge.prepared_command_id
     OR outcome.command_id IS DISTINCT FROM journal.command_id OR outcome.outcome_kind IS DISTINCT FROM 'OUTCOME_OBSERVED'
     OR outcome.retryable IS NOT FALSE THEN
    RAISE EXCEPTION 'HXUV1-COMATERIALIZE-13: CHANGE_ORDER_AUTHORITY_REVOKED';
  END IF;
  IF EXISTS(SELECT 1 FROM public.universal_v1_change_order_compensation_commands c WHERE c.proposal_id=witness.proposal_id)
     OR EXISTS(SELECT 1 FROM public.universal_v1_change_order_recovery_terminal_facts t
       WHERE t.proposal_id=witness.proposal_id AND t.outcome_state='CANCELLED') THEN
    RAISE EXCEPTION 'HXUV1-COMATERIALIZE-13: CHANGE_ORDER_AUTHORITY_REVOKED';
  END IF;

  SELECT a.id,a.work_order_id,a.amendment_version,a.supersedes_amendment_id,a.change_order_id,a.scope_version_id,
    a.adjustment_event_id,a.expected_financial_version,a.idempotency_key,a.request_sha256,a.materialized_by
    INTO amendment FROM public.task_work_order_amendments a
    WHERE a.change_order_id=witness.proposal_id OR a.idempotency_key=witness.idempotency_key
    ORDER BY (a.change_order_id=witness.proposal_id) DESC,a.id LIMIT 1;
  IF amendment.id IS NOT NULL THEN
    SELECT e.id,e.work_order_id,e.task_id,e.scope_version_id,e.execution_version,e.supersedes_fact_id,e.state,
      e.transition_kind,e.completion_fact_id,e.work_order_amendment_id,e.actor_role,e.actor_user_id,e.reason,
      e.idempotency_key,e.request_sha256,e.client_occurred_at,e.policy_version
      INTO execution FROM public.task_work_order_execution_facts e
      WHERE e.work_order_amendment_id=amendment.id AND e.transition_kind='APPLY_AMENDMENT';
    SELECT e.id,e.work_order_id,e.task_id,e.scope_version_id,e.execution_version,e.state
      INTO predecessor_execution FROM public.task_work_order_execution_facts e WHERE e.id=execution.supersedes_fact_id;
    SELECT a.id,a.work_order_id,a.amendment_version,a.scope_version_id
      INTO predecessor_amendment FROM public.task_work_order_amendments a WHERE a.id=amendment.supersedes_amendment_id;
    amendment_sha:=public.universal_v1_change_amendment_request_sha256(
      witness.work_order_id,witness.expected_amendment_version+1,amendment.supersedes_amendment_id,
      witness.proposal_id,witness.replacement_scope_version_id,adjustment_id,witness.expected_financial_version,
      witness.actor_user_id,witness.idempotency_key);
    IF amendment.work_order_id IS DISTINCT FROM witness.work_order_id OR amendment.change_order_id IS DISTINCT FROM witness.proposal_id
       OR amendment.amendment_version::BIGINT IS DISTINCT FROM witness.expected_amendment_version::BIGINT+1
       OR amendment.scope_version_id IS DISTINCT FROM witness.replacement_scope_version_id
       OR amendment.adjustment_event_id IS DISTINCT FROM adjustment_id
       OR amendment.expected_financial_version IS DISTINCT FROM witness.expected_financial_version
       OR amendment.idempotency_key IS DISTINCT FROM witness.idempotency_key OR amendment.materialized_by IS DISTINCT FROM witness.actor_user_id
       OR amendment.request_sha256 IS DISTINCT FROM amendment_sha
       OR (witness.expected_amendment_version=0 AND amendment.supersedes_amendment_id IS NOT NULL)
       OR (witness.expected_amendment_version>0 AND (predecessor_amendment.id IS NULL
         OR predecessor_amendment.work_order_id IS DISTINCT FROM witness.work_order_id
         OR predecessor_amendment.amendment_version IS DISTINCT FROM witness.expected_amendment_version
         OR predecessor_amendment.scope_version_id IS DISTINCT FROM witness.base_scope_version_id))
       OR execution.id IS NULL OR execution.work_order_id IS DISTINCT FROM witness.work_order_id
       OR execution.task_id IS DISTINCT FROM witness.task_id OR execution.scope_version_id IS DISTINCT FROM witness.replacement_scope_version_id
       OR execution.execution_version::BIGINT IS DISTINCT FROM witness.expected_execution_version::BIGINT+1
       OR execution.actor_user_id IS DISTINCT FROM witness.actor_user_id OR execution.actor_role IS DISTINCT FROM 'CUSTOMER'
       OR execution.idempotency_key IS DISTINCT FROM witness.idempotency_key||':execution'
       OR execution.completion_fact_id IS NOT NULL OR execution.reason IS NOT NULL
       OR execution.policy_version IS DISTINCT FROM 'universal-v1-work-order-execution-1.0.0'
       OR predecessor_execution.id IS NULL OR predecessor_execution.work_order_id IS DISTINCT FROM witness.work_order_id
       OR predecessor_execution.task_id IS DISTINCT FROM witness.task_id
       OR predecessor_execution.scope_version_id IS DISTINCT FROM witness.base_scope_version_id
       OR predecessor_execution.execution_version IS DISTINCT FROM witness.expected_execution_version
       OR execution.state IS DISTINCT FROM predecessor_execution.state
       OR predecessor_execution.state NOT IN ('MATERIALIZED','ACKNOWLEDGED','EN_ROUTE','ARRIVED','PAUSED')
       OR execution.request_sha256 IS DISTINCT FROM public.universal_v1_execution_internal_request_sha256(
         witness.actor_user_id,witness.work_order_id,'APPLY_AMENDMENT',execution.state,witness.expected_execution_version,
         witness.replacement_scope_version_id,NULL,amendment.id,witness.idempotency_key||':execution',
         execution.client_occurred_at,NULL) THEN
      RAISE EXCEPTION 'HXUV1-COMATERIALIZE-13: CHANGE_ORDER_IDEMPOTENCY_CONFLICT';
    END IF;
    amendment_id_value:=amendment.id; next_amendment_version:=amendment.amendment_version; replay:=TRUE;
  ELSE
    -- The admitted projection verifies exact outbox/admission/outcome/provider
    -- event/bridge provenance. An unadmitted legacy journal cannot authorize a
    -- new foreground effect. All mutable principal rows remain locked while
    -- the finance projection waits on its own recovery locks.
    financial_progress:=hx_authority.read_fake_financial_public_progress_v13(journal.command_id);
    IF financial_progress IS NULL
       OR financial_progress->>'commandId' IS DISTINCT FROM journal.command_id::TEXT
       OR financial_progress->>'operationId' IS DISTINCT FROM witness.adjustment_operation_id::TEXT
       OR financial_progress->>'operationKind' IS DISTINCT FROM 'ADJUST'
       OR financial_progress->>'ownerActorId' IS DISTINCT FROM witness.actor_user_id::TEXT
       OR financial_progress->>'environment' IS DISTINCT FROM request.environment
       OR financial_progress->>'taskDraftId' IS DISTINCT FROM witness.task_draft_id::TEXT
       OR financial_progress->>'taskId' IS DISTINCT FROM witness.task_id::TEXT
       OR financial_progress->>'progressState' IS DISTINCT FROM 'MATERIALIZED'
       OR financial_progress->'financialEvent' IS DISTINCT FROM pg_catalog.jsonb_build_object(
         'id',adjustment_id,'eventKind','ADJUSTMENT_AUTHORIZED','status','SUCCEEDED') THEN
      RAISE EXCEPTION 'HXUV1-COMATERIALIZE-13: CHANGE_ORDER_AUTHORITY_REVOKED';
    END IF;
    SELECT e.id,e.execution_version,e.state,e.scope_version_id
      INTO current_execution FROM public.task_work_order_execution_facts e WHERE e.work_order_id=witness.work_order_id
      ORDER BY e.execution_version DESC LIMIT 1;
    SELECT a.id,a.amendment_version,a.scope_version_id INTO predecessor_amendment
      FROM public.task_work_order_amendments a WHERE a.work_order_id=witness.work_order_id
      ORDER BY a.amendment_version DESC LIMIT 1;
    -- A fresh READ COMMITTED statement after all locks and financial progress:
    -- immutable Phase A is retained, but each new domain effect needs current
    -- actors, independent approvals, provider credentials, head and expiry.
    SELECT EXISTS(
      SELECT 1 FROM public.tasks task
      JOIN public.task_drafts draft ON draft.id=witness.task_draft_id AND draft.task_id=task.id
      JOIN public.task_work_orders work_order ON work_order.id=witness.work_order_id
      JOIN public.task_provider_eligibility_decisions eligibility ON eligibility.id=witness.eligibility_decision_id
      JOIN public.users current_actor ON current_actor.id=witness.actor_user_id
      JOIN public.users provider ON provider.id=work_order.provider_user_id
      JOIN public.task_scope_change_approvals customer_approval
        ON customer_approval.proposal_id=witness.proposal_id AND customer_approval.approver_role='CUSTOMER'
      JOIN public.task_scope_change_approvals provider_approval
        ON provider_approval.proposal_id=witness.proposal_id AND provider_approval.approver_role='PROVIDER'
      JOIN public.users customer_approval_actor ON customer_approval_actor.id=customer_approval.actor_id
      JOIN public.users provider_approval_actor ON provider_approval_actor.id=provider_approval.actor_id
      LEFT JOIN public.business_organizations customer_organization ON customer_organization.id=task.business_organization_id
      LEFT JOIN public.business_organizations provider_organization ON provider_organization.id=work_order.provider_organization_id
      WHERE task.id=witness.task_id AND task.work_order_id=work_order.id
        AND task.active_scope_version_id=witness.base_scope_version_id
        AND task.universal_contract_version=1 AND task.automation_classification='CONTROLLED_TEST'
        AND task.universal_payment_posture='PAYMENT_CREATION_FROZEN' AND task.worker_id IS NULL
        AND draft.universal_contract_version=1 AND draft.ingress_origin='BACKEND_POSTGRESQL'
        AND draft.claimed_at IS NOT NULL AND draft.poster_user_id=task.poster_id
        AND work_order.task_id=task.id AND work_order.task_draft_id=draft.id
        AND work_order.eligibility_decision_id=eligibility.id AND work_order.execution_contract_version=1
        AND eligibility.task_id=task.id AND eligibility.task_draft_id=draft.id AND eligibility.task_eligible IS TRUE
        AND eligibility.provider_user_id=work_order.provider_user_id
        AND eligibility.provider_organization_id IS NOT DISTINCT FROM work_order.provider_organization_id
        AND current_actor.account_status='ACTIVE' AND current_actor.is_minor IS FALSE
        AND COALESCE(current_actor.is_banned,FALSE) IS FALSE AND current_actor.firebase_uid=actor.verified_subject
        AND provider.account_status='ACTIVE' AND provider.is_minor IS FALSE AND COALESCE(provider.is_banned,FALSE) IS FALSE
        AND NOT (provider.trust_hold IS TRUE
          AND (provider.trust_hold_until IS NULL OR provider.trust_hold_until>pg_catalog.clock_timestamp()))
        AND customer_approval.decision='APPROVED' AND provider_approval.decision='APPROVED'
        AND customer_approval.expected_proposal_version=witness.expected_proposal_version
        AND provider_approval.expected_proposal_version=witness.expected_proposal_version
        AND customer_approval.actor_id<>provider_approval.actor_id
        AND customer_approval_actor.account_status='ACTIVE' AND customer_approval_actor.is_minor IS FALSE
        AND COALESCE(customer_approval_actor.is_banned,FALSE) IS FALSE
        AND provider_approval_actor.account_status='ACTIVE' AND provider_approval_actor.is_minor IS FALSE
        AND COALESCE(provider_approval_actor.is_banned,FALSE) IS FALSE
        AND ((task.business_organization_id IS NULL AND task.poster_id=witness.actor_user_id)
          OR (task.business_organization_id IS NOT NULL AND customer_organization.status='ACTIVE'
            AND customer_organization.client_enabled IS TRUE
            AND public.business_membership_has_action(task.business_organization_id,witness.actor_user_id,'APPROVE_SPEND') IS TRUE))
        AND ((task.business_organization_id IS NULL AND customer_approval.actor_id=task.poster_id)
          OR (task.business_organization_id IS NOT NULL AND customer_organization.status='ACTIVE'
            AND customer_organization.client_enabled IS TRUE
            AND public.business_membership_has_action(task.business_organization_id,customer_approval.actor_id,'APPROVE_SPEND') IS TRUE))
        AND (provider_approval.actor_id=work_order.provider_user_id
          OR (work_order.provider_organization_id IS NOT NULL AND provider_organization.status='ACTIVE'
            AND provider_organization.provider_enabled IS TRUE
            AND public.business_membership_has_action(work_order.provider_organization_id,provider_approval.actor_id,'APPROVE_SPEND') IS TRUE))
        AND public.universal_v1_invited_provider_authority_is_current(eligibility.provider_user_id,
          eligibility.provider_organization_id,eligibility.provider_class,eligibility.trade_credential_id,
          task.category,task.region_code) IS TRUE
        AND NOT EXISTS(SELECT 1 FROM public.task_financial_security_events f
          WHERE f.task_draft_id=witness.task_draft_id AND f.expected_version>financial.expected_version)
        AND NOT EXISTS(SELECT 1 FROM public.task_completion_facts c WHERE c.work_order_id=work_order.id)
        AND NOT EXISTS(SELECT 1 FROM public.task_reconciliation_facts r WHERE r.work_order_id=work_order.id)
        AND NOT EXISTS(SELECT 1 FROM public.universal_v1_change_order_compensation_commands c WHERE c.proposal_id=witness.proposal_id)
        AND NOT EXISTS(SELECT 1 FROM public.universal_v1_change_order_recovery_terminal_facts t WHERE t.proposal_id=witness.proposal_id)
    ) INTO authority_current;
    IF authority_current IS NOT TRUE OR current_execution.id IS NULL
       OR current_execution.execution_version IS DISTINCT FROM witness.expected_execution_version
       OR current_execution.scope_version_id IS DISTINCT FROM witness.base_scope_version_id
       OR current_execution.state NOT IN ('MATERIALIZED','ACKNOWLEDGED','EN_ROUTE','ARRIVED','PAUSED')
       OR COALESCE(predecessor_amendment.amendment_version,0) IS DISTINCT FROM witness.expected_amendment_version
       OR (predecessor_amendment.id IS NOT NULL AND predecessor_amendment.scope_version_id IS DISTINCT FROM witness.base_scope_version_id)
       OR witness.expected_amendment_version=2147483647 OR witness.expected_execution_version=2147483647
       OR public.universal_v1_financial_security_is_current_v1(
         public.universal_v1_effective_financial_security_expiry_v1(adjustment_id),
         pg_catalog.clock_timestamp()) IS NOT TRUE THEN
      RAISE EXCEPTION 'HXUV1-COMATERIALIZE-13: CHANGE_ORDER_AUTHORITY_REVOKED';
    END IF;
    IF pg_catalog.abs(EXTRACT(EPOCH FROM pg_catalog.clock_timestamp())*1000-
        (command_payload->>'client_timestamp_epoch_ms')::NUMERIC)>300000 THEN
      RAISE EXCEPTION 'HXUV1-COMATERIALIZE-13-CLIENT_TIMESTAMP_INVALID';
    END IF;
    next_amendment_version:=witness.expected_amendment_version+1;
    next_execution_version:=witness.expected_execution_version+1;
    amendment_sha:=public.universal_v1_change_amendment_request_sha256(
      witness.work_order_id,next_amendment_version,predecessor_amendment.id,witness.proposal_id,
      witness.replacement_scope_version_id,adjustment_id,witness.expected_financial_version,
      witness.actor_user_id,witness.idempotency_key);
    UPDATE public.tasks task SET title=replacement.title,description=replacement.description,
      requirements=replacement.requirements,price=replacement.customer_total_cents,
      hustler_payout_cents=replacement.hustler_payout_cents,
      platform_margin_cents=replacement.customer_total_cents-replacement.hustler_payout_cents,
      scope_hash=replacement.scope_hash,active_scope_version_id=replacement.id,updated_at=pg_catalog.clock_timestamp()
    WHERE task.id=witness.task_id AND task.active_scope_version_id=witness.base_scope_version_id
      AND task.worker_id IS NULL AND task.universal_contract_version=1
      AND task.automation_classification='CONTROLLED_TEST' AND task.universal_payment_posture='PAYMENT_CREATION_FROZEN';
    GET DIAGNOSTICS changed_count=ROW_COUNT;
    IF changed_count<>1 THEN RAISE EXCEPTION 'HXUV1-COMATERIALIZE-13: CHANGE_ORDER_HARD_ASSIGNMENT_FORBIDDEN'; END IF;
    INSERT INTO public.task_work_order_amendments AS inserted(
      work_order_id,amendment_version,supersedes_amendment_id,change_order_id,scope_version_id,
      adjustment_event_id,expected_financial_version,idempotency_key,request_sha256,materialized_by
    ) VALUES(witness.work_order_id,next_amendment_version,predecessor_amendment.id,witness.proposal_id,
      witness.replacement_scope_version_id,adjustment_id,witness.expected_financial_version,
      witness.idempotency_key,amendment_sha,witness.actor_user_id)
    RETURNING inserted.id INTO amendment_id_value;
    IF amendment_id_value IS NULL THEN RAISE EXCEPTION 'HXUV1-COMATERIALIZE-13: CHANGE_ORDER_MATERIALIZATION_FAILED'; END IF;
    execution_key:=witness.idempotency_key||':execution';
    execution_sha:=public.universal_v1_execution_internal_request_sha256(witness.actor_user_id,witness.work_order_id,
      'APPLY_AMENDMENT',current_execution.state,witness.expected_execution_version,witness.replacement_scope_version_id,
      NULL,amendment_id_value,execution_key,finalization_at,NULL);
    INSERT INTO public.task_work_order_execution_facts AS inserted(
      work_order_id,task_id,scope_version_id,execution_version,supersedes_fact_id,state,transition_kind,
      completion_fact_id,work_order_amendment_id,actor_role,actor_user_id,reason,idempotency_key,
      request_sha256,client_occurred_at,policy_version
    ) VALUES(witness.work_order_id,witness.task_id,witness.replacement_scope_version_id,next_execution_version,
      current_execution.id,current_execution.state,'APPLY_AMENDMENT',NULL,amendment_id_value,'CUSTOMER',
      witness.actor_user_id,NULL,execution_key,execution_sha,finalization_at,'universal-v1-work-order-execution-1.0.0')
    RETURNING inserted.id INTO execution;
    IF execution.id IS NULL THEN RAISE EXCEPTION 'HXUV1-COMATERIALIZE-13: CHANGE_ORDER_MATERIALIZATION_FAILED'; END IF;
  END IF;
  IF pg_catalog.abs(EXTRACT(EPOCH FROM pg_catalog.clock_timestamp())*1000-
      (command_payload->>'client_timestamp_epoch_ms')::NUMERIC)>300000 THEN
    RAISE EXCEPTION 'HXUV1-COMATERIALIZE-13-CLIENT_TIMESTAMP_INVALID';
  END IF;
  result:=pg_catalog.jsonb_build_object('amendment_id',amendment_id_value,'amendment_version',next_amendment_version,
    'proposal_id',witness.proposal_id,'scope_version_id',witness.replacement_scope_version_id,
    'scope_version',replacement.version,'adjustment_event_id',adjustment_id,'provider_kind','FAKE',
    'replayed',replay,'payment_creation_performed',FALSE,'hard_assignment_created',FALSE);
  actor_user_id:=actor.resolved_user_id; actor_assertion_id:=actor.assertion_id;
  actor_request_sha256:=request.actor_request_sha256; target_authority_id:=request.target_authority_id;
  command_release_sha256:=request.release_manifest_sha256;
  RETURN NEXT;
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'HXUV1-COMATERIALIZE-13: CHANGE_ORDER_IDEMPOTENCY_CONFLICT';
END;
$$;
REVOKE ALL ON FUNCTION public.hxos_finalize_authenticated_change_order_v13(TEXT,JSONB) FROM PUBLIC;

-- Deferred checks execute at API COMMIT after the outer command has returned.
-- Seal only these existing read guards; API relation access stays forbidden.
ALTER FUNCTION public.enforce_universal_active_scope_transition() SECURITY DEFINER;
ALTER FUNCTION public.enforce_universal_active_scope_transition() SET search_path=pg_catalog,public;
REVOKE ALL ON FUNCTION public.enforce_universal_active_scope_transition() FROM PUBLIC;
ALTER FUNCTION public.enforce_universal_v1_amendment_execution_fact() SECURITY DEFINER;
ALTER FUNCTION public.enforce_universal_v1_amendment_execution_fact() SET search_path=pg_catalog,public;
REVOKE ALL ON FUNCTION public.enforce_universal_v1_amendment_execution_fact() FROM PUBLIC;

-- Existing task projection dependencies retain their guards and immutable policy semantics.
CREATE OR REPLACE FUNCTION public.validate_region_policy_document()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.policy_hash <> pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(NEW.policy_document::text, 'UTF8')), 'hex') THEN
    RAISE EXCEPTION 'HXRP1: region policy hash does not match its document' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.policy_document->>'schemaVersion' <> 'hxos-region-policy-v1'
     OR jsonb_typeof(NEW.policy_document->'categories') <> 'object'
     OR NEW.policy_document->'categories' = '{}'::jsonb
     OR jsonb_typeof(NEW.policy_document->'recording') <> 'object'
     OR jsonb_typeof(NEW.policy_document->'workerRights') <> 'object'
     OR jsonb_typeof(NEW.policy_document->'financial') <> 'object'
     OR jsonb_typeof(NEW.policy_document->'safety') <> 'object' THEN
    RAISE EXCEPTION 'HXRP2: region policy document is incomplete' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.enforce_public_question_lifecycle() SET search_path=pg_catalog,public;
REVOKE ALL ON FUNCTION public.enforce_public_question_lifecycle() FROM PUBLIC;
ALTER FUNCTION public.enforce_clarification_revision_lifecycle() SET search_path=pg_catalog,public;
REVOKE ALL ON FUNCTION public.enforce_clarification_revision_lifecycle() FROM PUBLIC;
ALTER FUNCTION public.validate_region_policy_document() SET search_path=pg_catalog,public;
REVOKE ALL ON FUNCTION public.validate_region_policy_document() FROM PUBLIC;
ALTER FUNCTION public.prevent_region_policy_mutation() SET search_path=pg_catalog,public;
REVOKE ALL ON FUNCTION public.prevent_region_policy_mutation() FROM PUBLIC;

-- Worker-owned lease acquisition for existing immutable ChangeOrder Phase A.
-- A lease permits subsequent recovery observation only; it grants no ADJUST,
-- REVERSAL, amendment, cancellation, execution, capture or assignment authority.
CREATE OR REPLACE FUNCTION public.hxos_claim_fake_financial_change_order_recovery_v13(
  p_target_authority_id UUID, p_target_database_name TEXT,
  p_release_environment TEXT, p_release_manifest_digest TEXT,
  p_lease_owner_id UUID, p_limit INTEGER, p_lease_duration_seconds INTEGER,
  p_minimum_age_seconds INTEGER
) RETURNS TABLE (
  proposal_id UUID, recovery_lease_id UUID, lease_owner_id UUID,
  witness_request_sha256 TEXT, work_order_id UUID,
  acquired_at TIMESTAMPTZ, expires_at TIMESTAMPTZ,
  target_authority_id UUID, release_manifest_digest TEXT
)
LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE
SET search_path=pg_catalog
AS $$
DECLARE
  candidate RECORD;
  witness RECORD;
  claimed RECORD;
  claimed_count INTEGER := 0;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed'
     OR p_target_authority_id IS NULL OR p_target_database_name IS NULL
     OR p_release_environment IS NULL OR p_release_manifest_digest IS NULL
     OR p_lease_owner_id IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
     OR p_lease_duration_seconds IS NULL OR p_lease_duration_seconds NOT BETWEEN 5 AND 900
     OR p_minimum_age_seconds IS NULL OR p_minimum_age_seconds NOT BETWEEN 5 AND 3600 THEN
    RAISE EXCEPTION 'HXUV1-CORECOVERY-13-CLAIM_INPUT_INVALID';
  END IF;
  PERFORM hx_authority.assert_fake_financial_outbox_target_v13(
    p_target_authority_id,p_target_database_name,p_release_environment,p_release_manifest_digest
  );
  -- Read candidates without row locks, then take proposal before witness. The
  -- retained scanner took witness before proposal and could deadlock finalization.
  -- Bound committed leases by p_limit; do not truncate the candidate stream,
  -- which would starve later work whenever an old prefix stays busy.
  FOR candidate IN
    SELECT command.proposal_id
      FROM public.universal_v1_change_order_materialization_commands command
     WHERE command.prepared_at <= pg_catalog.clock_timestamp()
             - pg_catalog.make_interval(secs=>p_minimum_age_seconds)
       AND NOT EXISTS (SELECT 1 FROM public.universal_v1_change_order_recovery_terminal_facts terminal
                        WHERE terminal.proposal_id=command.proposal_id)
       AND NOT EXISTS (SELECT 1 FROM public.universal_v1_change_order_recovery_leases lease
                        WHERE lease.proposal_id=command.proposal_id
                          AND lease.expires_at>pg_catalog.clock_timestamp())
     ORDER BY command.prepared_at,command.proposal_id
  LOOP
    BEGIN
    IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(
      'universal-v1-change-order-proposal:'||candidate.proposal_id::TEXT,0)) THEN
      CONTINUE;
    END IF;
    -- This is a fresh READ COMMITTED statement after the advisory lock.
    SELECT command.proposal_id,command.request_sha256,command.work_order_id
      INTO witness
      FROM public.universal_v1_change_order_materialization_commands command
     WHERE command.proposal_id=candidate.proposal_id
       AND command.prepared_at <= pg_catalog.clock_timestamp()
             - pg_catalog.make_interval(secs=>p_minimum_age_seconds)
       AND NOT EXISTS (SELECT 1 FROM public.universal_v1_change_order_recovery_terminal_facts terminal
                        WHERE terminal.proposal_id=command.proposal_id)
       AND NOT EXISTS (SELECT 1 FROM public.universal_v1_change_order_recovery_leases lease
                        WHERE lease.proposal_id=command.proposal_id
                          AND lease.expires_at>pg_catalog.clock_timestamp())
     FOR UPDATE OF command SKIP LOCKED;
    IF NOT FOUND THEN
      -- Roll back just this candidate so a skipped row cannot retain its
      -- proposal lock and exhaust shared lock memory across a busy prefix.
      RAISE EXCEPTION 'HXUV1-CORECOVERY-13-CANDIDATE_SKIPPED' USING ERRCODE='P0C01';
    END IF;
    INSERT INTO public.universal_v1_change_order_recovery_leases(
      proposal_id,lease_owner_id,lease_duration_seconds,expires_at
    ) VALUES (
      witness.proposal_id,p_lease_owner_id,p_lease_duration_seconds,pg_catalog.clock_timestamp()
    ) RETURNING * INTO claimed;
    -- The unchanged insertion guard owns the clock and rejects another active
    -- lease or terminal winner. Historical actor revocation does not block a lease.
    RETURN QUERY SELECT witness.proposal_id,claimed.recovery_lease_id,claimed.lease_owner_id,
      pg_catalog.btrim(witness.request_sha256),witness.work_order_id,
      claimed.acquired_at,claimed.expires_at,p_target_authority_id,p_release_manifest_digest;
    claimed_count:=claimed_count+1;
    EXCEPTION WHEN SQLSTATE 'P0C01' THEN NULL;
    END;
    EXIT WHEN claimed_count>=p_limit;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.hxos_claim_fake_financial_change_order_recovery_v13(
  UUID,TEXT,TEXT,TEXT,UUID,INTEGER,INTEGER,INTEGER
) FROM PUBLIC;


-- A scoped recovery observation is advisory evidence, never dispatch or terminal
-- authority. Every later writer must revalidate its own exact durable evidence.
CREATE OR REPLACE FUNCTION public.hxos_observe_fake_financial_change_order_recovery_v13(
  p_target_authority_id UUID,p_target_database_name TEXT,
  p_release_environment TEXT,p_release_manifest_digest TEXT,
  p_proposal_id UUID,p_recovery_lease_id UUID,p_lease_owner_id UUID,
  p_witness_request_sha256 TEXT,p_work_order_id UUID
) RETURNS TABLE(observation JSONB,observed_at TIMESTAMPTZ,
  target_authority_id UUID,release_manifest_digest TEXT)
LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE
SET search_path=pg_catalog
AS $$
DECLARE
  witness RECORD;
  lease RECORD;
  revocation_reason TEXT;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed'
     OR p_target_authority_id IS NULL OR p_target_database_name IS NULL
     OR p_release_environment IS NULL OR p_release_manifest_digest IS NULL
     OR p_proposal_id IS NULL OR p_recovery_lease_id IS NULL OR p_lease_owner_id IS NULL
     OR p_work_order_id IS NULL OR p_witness_request_sha256 IS NULL
     OR p_witness_request_sha256 !~ '^[a-f0-9]{64}$'
     OR p_witness_request_sha256=pg_catalog.repeat('0',64) THEN
    RAISE EXCEPTION 'HXUV1-CORECOVERY-13-OBSERVATION_INPUT_INVALID';
  END IF;
  PERFORM hx_authority.assert_fake_financial_outbox_target_v13(
    p_target_authority_id,p_target_database_name,p_release_environment,p_release_manifest_digest);
  IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(
    'universal-v1-change-order-proposal:'||p_proposal_id::TEXT,0)) THEN
    RAISE EXCEPTION 'HXUV1-CORECOVERY-13-OBSERVATION_LOCK_BUSY';
  END IF;
  SELECT command.proposal_id,command.work_order_id,command.request_sha256 INTO witness
    FROM public.universal_v1_change_order_materialization_commands command
   WHERE command.proposal_id=p_proposal_id FOR SHARE NOWAIT;
  IF witness.proposal_id IS NULL OR witness.work_order_id IS DISTINCT FROM p_work_order_id
     OR pg_catalog.btrim(witness.request_sha256) IS DISTINCT FROM p_witness_request_sha256 THEN
    RAISE EXCEPTION 'HXUV1-CORECOVERY-13-OBSERVATION_BINDING_MISMATCH';
  END IF;
  SELECT l.expires_at INTO lease FROM public.universal_v1_change_order_recovery_leases l
   WHERE l.proposal_id=p_proposal_id AND l.recovery_lease_id=p_recovery_lease_id
     AND l.lease_owner_id=p_lease_owner_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'HXUV1-CORECOVERY-13-OBSERVATION_BINDING_MISMATCH'; END IF;
  IF lease.expires_at<=pg_catalog.clock_timestamp() OR EXISTS(
    SELECT 1 FROM public.universal_v1_change_order_recovery_terminal_facts terminal
     WHERE terminal.proposal_id=p_proposal_id) THEN RETURN; END IF;
  IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(
    'fulfillment:'||p_work_order_id::TEXT,0)) THEN
    RAISE EXCEPTION 'HXUV1-CORECOVERY-13-OBSERVATION_LOCK_BUSY';
  END IF;
  revocation_reason:=public.universal_v1_change_order_recovery_revocation_reason_v1(p_proposal_id);
  RETURN QUERY WITH claimed AS (
    SELECT p_proposal_id AS proposal_id,p_recovery_lease_id AS recovery_lease_id,p_lease_owner_id AS lease_owner_id
  ), observed AS (
       SELECT command.proposal_id, claimed.recovery_lease_id, claimed.lease_owner_id,
              command.idempotency_key, command.request_sha256,
              command.actor_user_id, command.work_order_id, command.task_id,
              command.task_draft_id, command.eligibility_decision_id,
              command.base_scope_version_id, command.replacement_scope_version_id,
              replacement.version AS replacement_scope_version,
              command.expected_financial_version, command.predecessor_event_id,
              command.predecessor_operation_id, command.adjustment_operation_id,
              command.customer_total_cents, command.currency, command.occurred_at,
              adjustment.id AS adjustment_event_id,
              amendment.id AS amendment_id,
              compensation_event.id AS compensation_event_id,
              adjustment_outcome.outcome_fact_id AS adjustment_outcome_fact_id,
              revocation_reason AS authority_revocation_reason,
              compensation.compensation_command_id,
              compensation.reversal_operation_id AS compensation_reversal_operation_id,
              compensation.reversal_idempotency_key AS compensation_reversal_idempotency_key,
              compensation.lifecycle_expected_version AS compensation_lifecycle_expected_version,
              compensation.amount_cents AS compensation_amount_cents,
              compensation.currency AS compensation_currency,
              compensation.requested_by AS compensation_requested_by,
              compensation.created_at AS compensation_created_at,
              compensation.semantic_limitation AS compensation_semantic_limitation,
              CASE
                WHEN amendment.id IS NOT NULL THEN 'AMENDMENT_MATERIALIZED'
                WHEN compensation_event.id IS NOT NULL AND compensation_bridge.bridge_id IS NOT NULL
                  THEN 'COMPENSATION_SUCCEEDED'
                WHEN compensation.compensation_command_id IS NOT NULL THEN
                  CASE
                    WHEN compensation_journal.command_id IS NULL
                      OR compensation_attempt.dispatch_attempt_id IS NULL
                      THEN 'COMPENSATION_READY'
                    WHEN compensation_outcome.outcome_kind = 'OUTCOME_OBSERVED'
                      AND compensation_outcome.effect_certainty = 'CONFIRMED_EFFECT'
                      AND compensation_outcome.provider_state = 'REVERSED'
                      AND compensation_outcome.retryable = FALSE
                      THEN 'COMPENSATION_REPLAYABLE'
                    WHEN (
                      compensation_outcome.outcome_kind = 'FAILED'
                      AND compensation_outcome.effect_certainty = 'CONFIRMED_NO_EFFECT'
                      AND compensation_outcome.retryable = FALSE
                    ) OR (
                      compensation_outcome.outcome_kind = 'OUTCOME_OBSERVED'
                      AND compensation_outcome.effect_certainty = 'CONFIRMED_NO_EFFECT'
                      AND compensation_outcome.retryable = FALSE
                    ) THEN 'COMPENSATION_TERMINAL_NO_EFFECT'
                    WHEN compensation_attempt.dispatch_attempt_id IS NOT NULL
                      THEN 'COMPENSATION_RECONCILE_ONLY'
                    ELSE 'WAITING'
                  END
                WHEN adjustment.id IS NOT NULL
                  AND adjustment.status = 'SUCCEEDED'
                  AND adjustment_bridge.bridge_id IS NOT NULL
                  THEN 'ADJUSTMENT_SUCCEEDED'
                WHEN adjustment.id IS NOT NULL
                  AND adjustment.status IN ('DECLINED','FAILED')
                  AND adjustment_bridge.bridge_id IS NOT NULL
                  THEN 'ADJUST_TERMINAL_NO_EFFECT'
                WHEN adjustment_attempt.dispatch_attempt_id IS NULL
                  AND revocation_reason IN (
                    'AMENDMENT_CHAIN_CHANGED',
                    'FINANCIAL_CHAIN_CHANGED',
                    'WORK_ORDER_TERMINALIZED'
                  )
                  THEN 'WAITING'
                WHEN adjustment_attempt.dispatch_attempt_id IS NULL
                  AND revocation_reason IS NOT NULL
                  THEN 'ADJUST_NO_EFFECT_AUTHORITY_REVOKED'
                WHEN adjustment_journal.command_id IS NULL
                  OR adjustment_attempt.dispatch_attempt_id IS NULL
                  THEN 'ADJUST_READY'
                WHEN adjustment_outcome.outcome_kind = 'OUTCOME_OBSERVED'
                  AND adjustment_outcome.effect_certainty = 'CONFIRMED_EFFECT'
                  AND adjustment_outcome.provider_state = 'SUCCEEDED'
                  AND adjustment_outcome.retryable = FALSE
                  THEN 'ADJUST_REPLAYABLE'
                WHEN (
                  adjustment_outcome.outcome_kind = 'FAILED'
                  AND adjustment_outcome.effect_certainty = 'CONFIRMED_NO_EFFECT'
                  AND adjustment_outcome.retryable = FALSE
                ) OR (
                  adjustment_outcome.outcome_kind = 'OUTCOME_OBSERVED'
                  AND adjustment_outcome.effect_certainty = 'CONFIRMED_NO_EFFECT'
                  AND adjustment_outcome.retryable = FALSE
                ) THEN 'ADJUST_TERMINAL_NO_EFFECT'
                WHEN adjustment_attempt.dispatch_attempt_id IS NOT NULL
                  THEN 'ADJUST_RECONCILE_ONLY'
                ELSE 'WAITING'
              END AS recovery_state
         FROM claimed
         JOIN public.universal_v1_change_order_materialization_commands command
           ON command.proposal_id = claimed.proposal_id
         JOIN public.task_scope_versions replacement
           ON replacement.id = command.replacement_scope_version_id
         LEFT JOIN public.task_work_order_amendments amendment
           ON amendment.change_order_id = command.proposal_id
          AND amendment.work_order_id = command.work_order_id
          AND amendment.scope_version_id = command.replacement_scope_version_id
         LEFT JOIN public.task_financial_security_events adjustment
           ON adjustment.operation_id = command.adjustment_operation_id::text
          AND adjustment.idempotency_key = command.idempotency_key || ':adjust'
          AND adjustment.expected_version = command.expected_financial_version + 1
          AND adjustment.provider_kind = 'FAKE'
          AND adjustment.event_kind = 'ADJUSTMENT_AUTHORIZED'
          AND adjustment.task_draft_id = command.task_draft_id
          AND adjustment.task_id = command.task_id
          AND adjustment.eligibility_decision_id = command.eligibility_decision_id
          AND adjustment.scope_version_id = command.replacement_scope_version_id
          AND adjustment.change_order_id = command.proposal_id
          AND adjustment.predecessor_event_id = command.predecessor_event_id
          AND adjustment.amount_cents = command.customer_total_cents
          AND adjustment.currency = command.currency
         LEFT JOIN public.universal_v1_fake_financial_lifecycle_bridges adjustment_bridge
           ON adjustment_bridge.task_financial_security_event_id = adjustment.id
          AND adjustment_bridge.fake_operation_kind = 'ADJUST'
         LEFT JOIN public.universal_v1_prepared_financial_commands adjustment_prepared
           ON adjustment_prepared.operation_kind = 'ADJUST'
          AND adjustment_prepared.operation_id = command.adjustment_operation_id
          AND adjustment_prepared.provider_kind = 'FAKE'
          AND adjustment_prepared.provider_expected_version = 0
          AND adjustment_prepared.idempotency_key = command.idempotency_key || ':adjust'
         LEFT JOIN public.financial_provider_command_journal adjustment_journal
           ON adjustment_journal.prepared_financial_command_id = adjustment_prepared.prepared_command_id
          AND adjustment_journal.operation_id = command.adjustment_operation_id
          AND adjustment_journal.idempotency_key = command.idempotency_key || ':adjust'
         LEFT JOIN LATERAL (
           SELECT attempt.dispatch_attempt_id
             FROM public.financial_provider_command_dispatch_attempts attempt
            WHERE attempt.command_id = adjustment_journal.command_id
            ORDER BY attempt.attempt_number DESC
            LIMIT 1
         ) adjustment_attempt ON TRUE
         LEFT JOIN LATERAL (
           SELECT outcome.outcome_fact_id, outcome.outcome_kind, outcome.effect_certainty,
                  outcome.provider_state, outcome.retryable
             FROM public.financial_provider_command_outcome_facts outcome
            WHERE outcome.command_id = adjustment_journal.command_id
              AND outcome.dispatch_attempt_id = adjustment_attempt.dispatch_attempt_id
            ORDER BY outcome.recorded_at DESC, outcome.outcome_fact_id DESC
            LIMIT 1
         ) adjustment_outcome ON TRUE
         LEFT JOIN public.universal_v1_change_order_compensation_commands compensation
           ON compensation.proposal_id = command.proposal_id
         LEFT JOIN public.task_financial_security_events compensation_event
           ON compensation_event.operation_id = compensation.reversal_operation_id::text
          AND compensation_event.idempotency_key = compensation.reversal_idempotency_key
          AND compensation_event.expected_version = compensation.lifecycle_expected_version
          AND compensation_event.event_kind = 'REVERSED'
          AND compensation_event.status = 'SUCCEEDED'
          AND compensation_event.provider_kind = 'FAKE'
         LEFT JOIN public.universal_v1_fake_financial_lifecycle_bridges compensation_bridge
           ON compensation_bridge.task_financial_security_event_id = compensation_event.id
          AND compensation_bridge.fake_operation_kind = 'REVERSAL'
         LEFT JOIN public.universal_v1_prepared_financial_commands compensation_prepared
           ON compensation_prepared.operation_kind = 'REVERSAL'
          AND compensation_prepared.operation_id = compensation.reversal_operation_id
          AND compensation_prepared.provider_kind = 'FAKE'
          AND compensation_prepared.provider_expected_version = 0
          AND compensation_prepared.idempotency_key = compensation.reversal_idempotency_key
         LEFT JOIN public.financial_provider_command_journal compensation_journal
           ON compensation_journal.prepared_financial_command_id = compensation_prepared.prepared_command_id
          AND compensation_journal.operation_id = compensation.reversal_operation_id
          AND compensation_journal.idempotency_key = compensation.reversal_idempotency_key
         LEFT JOIN LATERAL (
           SELECT attempt.dispatch_attempt_id
             FROM public.financial_provider_command_dispatch_attempts attempt
            WHERE attempt.command_id = compensation_journal.command_id
            ORDER BY attempt.attempt_number DESC
            LIMIT 1
         ) compensation_attempt ON TRUE
         LEFT JOIN LATERAL (
           SELECT outcome.outcome_kind, outcome.effect_certainty,
                  outcome.provider_state, outcome.retryable
             FROM public.financial_provider_command_outcome_facts outcome
            WHERE outcome.command_id = compensation_journal.command_id
              AND outcome.dispatch_attempt_id = compensation_attempt.dispatch_attempt_id
            ORDER BY outcome.recorded_at DESC, outcome.outcome_fact_id DESC
            LIMIT 1
         ) compensation_outcome ON TRUE

  ) SELECT pg_catalog.to_jsonb(observed),pg_catalog.clock_timestamp(),
      p_target_authority_id,p_release_manifest_digest FROM observed;
  IF lease.expires_at<=pg_catalog.clock_timestamp() THEN
    RAISE EXCEPTION 'HXUV1-CORECOVERY-13-OBSERVATION_LEASE_EXPIRED';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.hxos_observe_fake_financial_change_order_recovery_v13(
  UUID,TEXT,TEXT,TEXT,UUID,UUID,UUID,TEXT,UUID) FROM PUBLIC;


-- Pin the retained UUID helper's unqualified digest lookup without changing its body.
ALTER FUNCTION public.universal_v1_change_order_recovery_uuid_v1(TEXT,TEXT) SET search_path=pg_catalog,public;
-- Worker provenance is separate from the historical participant requested_by.
-- An existing legacy winner is never silently adopted into this authority table.
CREATE TABLE hx_authority.fake_financial_change_order_compensation_origins_v13 (
  compensation_command_id UUID PRIMARY KEY REFERENCES public.universal_v1_change_order_compensation_commands(compensation_command_id),
  proposal_id UUID NOT NULL UNIQUE REFERENCES public.universal_v1_change_order_materialization_commands(proposal_id),
  recovery_lease_id UUID NOT NULL REFERENCES public.universal_v1_change_order_recovery_leases(recovery_lease_id),
  lease_owner_id UUID NOT NULL,
  target_authority_id UUID NOT NULL REFERENCES hx_authority.universal_v1_work_order_target_authority_facts(target_authority_id),
  release_environment TEXT NOT NULL CHECK(release_environment IN ('local','preview','staging')),
  release_manifest_digest TEXT NOT NULL CHECK(release_manifest_digest ~ '^sha256:[a-f0-9]{64}$'),
  service_database_role TEXT NOT NULL CHECK(service_database_role<>''),
  witness_request_sha256 TEXT NOT NULL CHECK(witness_request_sha256 ~ '^[a-f0-9]{64}$'),
  adjustment_event_id UUID NOT NULL REFERENCES public.task_financial_security_events(id),
  revocation_reason TEXT NOT NULL CHECK(revocation_reason<>''),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
CREATE TRIGGER change_order_compensation_origin_append_only_v13
BEFORE UPDATE OR DELETE ON hx_authority.fake_financial_change_order_compensation_origins_v13
FOR EACH ROW EXECUTE FUNCTION hx_authority.reject_fake_financial_outbox_mutation_v13();
CREATE TRIGGER change_order_compensation_origin_no_truncate_v13
BEFORE TRUNCATE ON hx_authority.fake_financial_change_order_compensation_origins_v13
FOR EACH STATEMENT EXECUTE FUNCTION hx_authority.reject_fake_financial_outbox_mutation_v13();
REVOKE ALL ON TABLE hx_authority.fake_financial_change_order_compensation_origins_v13 FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.hxos_claim_fake_financial_change_order_compensation_v13(
  p_target_authority_id UUID,p_target_database_name TEXT,
  p_release_environment TEXT,p_release_manifest_digest TEXT,
  p_proposal_id UUID,p_recovery_lease_id UUID,p_lease_owner_id UUID,
  p_witness_request_sha256 TEXT,p_work_order_id UUID,p_adjustment_event_id UUID
) RETURNS TABLE(resolution JSONB,observed_at TIMESTAMPTZ,
  target_authority_id UUID,release_manifest_digest TEXT)
LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE SET search_path=pg_catalog AS $$
DECLARE
  initial JSONB; context RECORD; context_before JSONB; actor_ids UUID[]; pass INTEGER;
  witness public.universal_v1_change_order_materialization_commands%ROWTYPE;
  winner public.universal_v1_change_order_compensation_commands%ROWTYPE;
  amendment RECORD; financial RECORD; bridge RECORD; progress JSONB; reason TEXT; witness_sha TEXT;
  origin JSONB; created BOOLEAN:=FALSE; lease_expires_at TIMESTAMPTZ;
BEGIN
  IF p_adjustment_event_id IS NULL THEN RAISE EXCEPTION 'HXUV1-COCOMP-13-INPUT_INVALID'; END IF;
  -- The scoped observation acquires current target, proposal, witness and fulfillment
  -- locks and checks the exact live lease before any compensation-table write.
  SELECT o.observation INTO initial FROM public.hxos_observe_fake_financial_change_order_recovery_v13(
    p_target_authority_id,p_target_database_name,p_release_environment,p_release_manifest_digest,
    p_proposal_id,p_recovery_lease_id,p_lease_owner_id,p_witness_request_sha256,p_work_order_id) o;
  IF initial IS NULL THEN RETURN; END IF;
  SELECT l.expires_at INTO STRICT lease_expires_at FROM public.universal_v1_change_order_recovery_leases l
    WHERE l.recovery_lease_id=p_recovery_lease_id;
  SELECT * INTO STRICT witness FROM public.universal_v1_change_order_materialization_commands c
    WHERE c.proposal_id=p_proposal_id;
  witness_sha:=public.universal_v1_change_order_materialization_request_sha256(
    witness.proposal_id,witness.idempotency_key,witness.actor_user_id,witness.work_order_id,
    witness.task_id,witness.task_draft_id,witness.eligibility_decision_id,
    witness.base_scope_version_id,witness.replacement_scope_version_id,
    witness.expected_proposal_version,witness.expected_scope_version,witness.expected_amendment_version,
    witness.expected_execution_version,witness.expected_financial_version,witness.predecessor_event_id,
    witness.predecessor_operation_id,witness.adjustment_operation_id);
  IF witness_sha IS DISTINCT FROM p_witness_request_sha256 THEN
    RAISE EXCEPTION 'HXUV1-COCOMP-13-WITNESS_MISMATCH'; END IF;
  SELECT f.id,f.operation_id,f.idempotency_key,f.event_kind,f.status,f.provider_kind,f.recorded_by,
    f.task_draft_id,f.task_id,f.eligibility_decision_id,f.scope_version_id,f.change_order_id,
    f.predecessor_event_id,f.expected_version,f.amount_cents,f.currency INTO financial
    FROM public.task_financial_security_events f WHERE f.id=p_adjustment_event_id;
  SELECT b.bridge_id,b.command_id,b.fake_operation_id,b.fake_operation_kind,b.lifecycle_event_kind,
    b.lifecycle_status INTO bridge FROM public.universal_v1_fake_financial_lifecycle_bridges b
    WHERE b.task_financial_security_event_id=p_adjustment_event_id;
  IF financial.id IS NULL OR bridge.bridge_id IS NULL OR bridge.command_id IS NULL
     OR financial.operation_id IS DISTINCT FROM witness.adjustment_operation_id::TEXT
     OR financial.idempotency_key IS DISTINCT FROM witness.idempotency_key||':adjust'
     OR financial.event_kind IS DISTINCT FROM 'ADJUSTMENT_AUTHORIZED' OR financial.status IS DISTINCT FROM 'SUCCEEDED'
     OR financial.provider_kind IS DISTINCT FROM 'FAKE' OR financial.recorded_by IS DISTINCT FROM witness.actor_user_id
     OR financial.task_draft_id IS DISTINCT FROM witness.task_draft_id OR financial.task_id IS DISTINCT FROM witness.task_id
     OR financial.eligibility_decision_id IS DISTINCT FROM witness.eligibility_decision_id
     OR financial.scope_version_id IS DISTINCT FROM witness.replacement_scope_version_id
     OR financial.change_order_id IS DISTINCT FROM witness.proposal_id
     OR financial.predecessor_event_id IS DISTINCT FROM witness.predecessor_event_id
     OR financial.expected_version::BIGINT IS DISTINCT FROM witness.expected_financial_version::BIGINT+1
     OR financial.amount_cents IS DISTINCT FROM witness.customer_total_cents OR financial.currency IS DISTINCT FROM witness.currency
     OR bridge.fake_operation_id IS DISTINCT FROM witness.adjustment_operation_id
     OR bridge.fake_operation_kind IS DISTINCT FROM 'ADJUST'
     OR bridge.lifecycle_event_kind IS DISTINCT FROM 'ADJUSTMENT_AUTHORIZED' OR bridge.lifecycle_status IS DISTINCT FROM 'SUCCEEDED' THEN
    RAISE EXCEPTION 'HXUV1-COCOMP-13-ADJUSTMENT_MISMATCH'; END IF;

  SELECT a.id,a.work_order_id,a.scope_version_id,a.adjustment_event_id INTO amendment
    FROM public.task_work_order_amendments a WHERE a.change_order_id=p_proposal_id;
  SELECT * INTO winner FROM public.universal_v1_change_order_compensation_commands c WHERE c.proposal_id=p_proposal_id;
  IF amendment.id IS NOT NULL THEN
    IF winner.compensation_command_id IS NOT NULL OR amendment.work_order_id IS DISTINCT FROM p_work_order_id
       OR amendment.scope_version_id IS DISTINCT FROM witness.replacement_scope_version_id
       OR amendment.adjustment_event_id IS DISTINCT FROM p_adjustment_event_id THEN
      RAISE EXCEPTION 'HXUV1-COCOMP-13-WINNER_MISMATCH'; END IF;
    resolution:=pg_catalog.jsonb_build_object('kind','AMENDMENT_MATERIALIZED',
      'amendmentId',amendment.id,'adjustmentEventId',p_adjustment_event_id);
  ELSE
    IF winner.compensation_command_id IS NULL THEN
      -- Lock mutable authority without requiring a live historical participant.
      -- A fresh statement after the locks verifies the exact dependency identity.
      FOR pass IN 0..1 LOOP
        SELECT t.poster_id,t.business_organization_id AS customer_organization_id,
          w.provider_user_id,w.provider_organization_id,e.trade_credential_id,
          ca.actor_id AS customer_approval_actor_id,pa.actor_id AS provider_approval_actor_id INTO context
        FROM public.tasks t
        JOIN public.task_drafts d ON d.id=witness.task_draft_id AND d.task_id=t.id
        JOIN public.task_work_orders w ON w.id=witness.work_order_id AND w.task_id=t.id
          AND w.task_draft_id=d.id AND w.eligibility_decision_id=witness.eligibility_decision_id
        JOIN public.task_provider_eligibility_decisions e ON e.id=witness.eligibility_decision_id
        LEFT JOIN public.task_scope_change_approvals ca ON ca.proposal_id=p_proposal_id AND ca.approver_role='CUSTOMER'
        LEFT JOIN public.task_scope_change_approvals pa ON pa.proposal_id=p_proposal_id AND pa.approver_role='PROVIDER'
        WHERE t.id=witness.task_id AND t.work_order_id=w.id AND t.active_scope_version_id=witness.base_scope_version_id
          AND t.universal_contract_version=1 AND t.automation_classification='CONTROLLED_TEST'
          AND t.universal_payment_posture='PAYMENT_CREATION_FROZEN' AND t.worker_id IS NULL
          AND d.poster_user_id=t.poster_id AND d.claimed_at IS NOT NULL
          AND d.universal_contract_version=1 AND d.ingress_origin='BACKEND_POSTGRESQL';
        IF NOT FOUND THEN RAISE EXCEPTION 'HXUV1-COCOMP-13-CONTEXT_MISMATCH'; END IF;
        IF pass=1 THEN
          IF pg_catalog.to_jsonb(context) IS DISTINCT FROM context_before THEN
            RAISE EXCEPTION 'HXUV1-COCOMP-13-DEPENDENCY_CHANGED'; END IF;
          EXIT;
        END IF;
        context_before:=pg_catalog.to_jsonb(context);
        PERFORM 1 FROM public.task_work_orders WHERE id=witness.work_order_id FOR UPDATE NOWAIT;
        PERFORM 1 FROM public.tasks WHERE id=witness.task_id FOR UPDATE NOWAIT;
        PERFORM 1 FROM public.task_drafts WHERE id=witness.task_draft_id FOR SHARE NOWAIT;
        PERFORM 1 FROM public.task_scope_change_proposals WHERE id=p_proposal_id FOR UPDATE NOWAIT;
        PERFORM 1 FROM public.task_provider_eligibility_decisions WHERE id=witness.eligibility_decision_id FOR SHARE NOWAIT;
        PERFORM 1 FROM public.task_scope_versions WHERE id IN(witness.base_scope_version_id,witness.replacement_scope_version_id)
          ORDER BY id FOR SHARE NOWAIT;
        PERFORM 1 FROM public.task_scope_change_approvals WHERE proposal_id=p_proposal_id ORDER BY id FOR SHARE NOWAIT;
        SELECT pg_catalog.array_agg(id ORDER BY id) INTO actor_ids FROM (
          SELECT witness.actor_user_id AS id UNION SELECT context.poster_id UNION SELECT context.provider_user_id
          UNION SELECT context.customer_approval_actor_id UNION SELECT context.provider_approval_actor_id
        ) actors WHERE id IS NOT NULL;
        -- UPDATE blocks users FK KEY SHARE for newly inserted memberships.
        PERFORM 1 FROM public.users WHERE id=ANY(actor_ids) ORDER BY id FOR UPDATE NOWAIT;
        PERFORM 1 FROM public.business_organizations WHERE id IN(context.customer_organization_id,context.provider_organization_id)
          ORDER BY id FOR SHARE NOWAIT;
        PERFORM 1 FROM public.business_memberships
          WHERE organization_id IN(context.customer_organization_id,context.provider_organization_id) AND user_id=ANY(actor_ids)
          ORDER BY organization_id,user_id,id FOR SHARE NOWAIT;
        PERFORM 1 FROM public.capability_profiles WHERE user_id=context.provider_user_id ORDER BY user_id FOR SHARE NOWAIT;
        PERFORM 1 FROM public.business_credentials WHERE id=context.trade_credential_id FOR SHARE NOWAIT;
        PERFORM 1 FROM public.verified_trades WHERE user_id=context.provider_user_id
          AND provider_organization_id IS NOT DISTINCT FROM context.provider_organization_id
          AND business_credential_id IS NOT DISTINCT FROM context.trade_credential_id ORDER BY user_id,trade FOR SHARE NOWAIT;
      END LOOP;
      -- A worker transaction may already hold recovery/operation locks before
      -- calling a target port. Never block in the reverse order under domain locks.
      IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtext('financial-provider-command-recovery-v1'),pg_catalog.hashtext(bridge.command_id::TEXT))
         OR NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtext('fake-financial-operation'),pg_catalog.hashtext(witness.adjustment_operation_id::TEXT)) THEN
        RAISE EXCEPTION 'HXUV1-COCOMP-13-LOCK_BUSY'; END IF;
      progress:=hx_authority.read_fake_financial_public_progress_v13(bridge.command_id);
      IF progress IS NULL OR progress->>'commandId' IS DISTINCT FROM bridge.command_id::TEXT
         OR progress->>'operationId' IS DISTINCT FROM witness.adjustment_operation_id::TEXT
         OR progress->>'operationKind' IS DISTINCT FROM 'ADJUST'
         OR progress->>'ownerActorId' IS DISTINCT FROM witness.actor_user_id::TEXT
         OR progress->>'environment' IS DISTINCT FROM p_release_environment
         OR progress->>'taskDraftId' IS DISTINCT FROM witness.task_draft_id::TEXT
         OR progress->>'taskId' IS DISTINCT FROM witness.task_id::TEXT
         OR progress->>'progressState' IS DISTINCT FROM 'MATERIALIZED'
         OR progress->'financialEvent' IS DISTINCT FROM pg_catalog.jsonb_build_object(
           'id',p_adjustment_event_id,'eventKind','ADJUSTMENT_AUTHORIZED','status','SUCCEEDED') THEN
        RAISE EXCEPTION 'HXUV1-COCOMP-13-ADMITTED_ADJUSTMENT_REQUIRED'; END IF;
      reason:=public.universal_v1_change_order_recovery_revocation_reason_v1(p_proposal_id);
      IF reason IS NULL OR reason IN('AMENDMENT_CHAIN_CHANGED','FINANCIAL_CHAIN_CHANGED') THEN
        RAISE EXCEPTION 'HXUV1-COCOMP-13-PERMANENT_REVOCATION_REQUIRED'; END IF;
      INSERT INTO public.universal_v1_change_order_compensation_commands
        (proposal_id,recovery_lease_id,lease_owner_id,adjustment_event_id,requested_by,reason_code)
      VALUES(p_proposal_id,p_recovery_lease_id,p_lease_owner_id,p_adjustment_event_id,witness.actor_user_id,
        'FINALIZATION_AUTHORITY_REVOKED') RETURNING * INTO winner;
      IF winner.authority_revocation_reason IS DISTINCT FROM reason THEN
        RAISE EXCEPTION 'HXUV1-COCOMP-13-REVOCATION_CHANGED'; END IF;
      INSERT INTO hx_authority.fake_financial_change_order_compensation_origins_v13
        (compensation_command_id,proposal_id,recovery_lease_id,lease_owner_id,target_authority_id,
         release_environment,release_manifest_digest,service_database_role,witness_request_sha256,
         adjustment_event_id,revocation_reason)
      VALUES(winner.compensation_command_id,p_proposal_id,p_recovery_lease_id,p_lease_owner_id,p_target_authority_id,
        p_release_environment,p_release_manifest_digest,SESSION_USER,p_witness_request_sha256,p_adjustment_event_id,reason);
      created:=TRUE;
    END IF;
    IF winner.compensation_command_id IS DISTINCT FROM public.universal_v1_change_order_recovery_uuid_v1(witness.idempotency_key,'compensation-command')
       OR winner.reversal_operation_id IS DISTINCT FROM public.universal_v1_change_order_recovery_uuid_v1(witness.idempotency_key,'compensating-reversal')
       OR winner.reversal_idempotency_key IS DISTINCT FROM witness.idempotency_key||':recovery:reversal'
       OR winner.work_order_id IS DISTINCT FROM p_work_order_id
       OR winner.reason_code IS DISTINCT FROM 'FINALIZATION_AUTHORITY_REVOKED'
       OR winner.witness_request_sha256 IS DISTINCT FROM witness.request_sha256
       OR winner.adjustment_event_id IS DISTINCT FROM p_adjustment_event_id
       OR winner.requested_by IS DISTINCT FROM witness.actor_user_id
       OR winner.base_scope_version_id IS DISTINCT FROM witness.base_scope_version_id
       OR winner.adjustment_operation_id IS DISTINCT FROM witness.adjustment_operation_id
       OR winner.task_draft_id IS DISTINCT FROM witness.task_draft_id OR winner.task_id IS DISTINCT FROM witness.task_id
       OR winner.eligibility_decision_id IS DISTINCT FROM witness.eligibility_decision_id
       OR winner.lifecycle_expected_version IS DISTINCT FROM witness.expected_financial_version::BIGINT+2
       OR winner.amount_cents IS DISTINCT FROM witness.customer_total_cents::BIGINT OR winner.currency IS DISTINCT FROM witness.currency
       OR winner.semantic_limitation IS DISTINCT FROM 'PRIOR_SECURED_STATE_NOT_RESTORED' THEN
      RAISE EXCEPTION 'HXUV1-COCOMP-13-WINNER_MISMATCH'; END IF;
    SELECT pg_catalog.to_jsonb(o) INTO origin FROM hx_authority.fake_financial_change_order_compensation_origins_v13 o
      WHERE o.compensation_command_id=winner.compensation_command_id;
    resolution:=pg_catalog.jsonb_build_object('kind','COMPENSATE','command',pg_catalog.to_jsonb(winner),
      'workerOrigin',origin,'created',created);
  END IF;
  IF lease_expires_at<=pg_catalog.clock_timestamp() THEN RAISE EXCEPTION 'HXUV1-COCOMP-13-LEASE_EXPIRED'; END IF;
  observed_at:=pg_catalog.clock_timestamp();target_authority_id:=p_target_authority_id;
  release_manifest_digest:=p_release_manifest_digest;RETURN NEXT;
EXCEPTION WHEN lock_not_available THEN
  RAISE EXCEPTION 'HXUV1-COCOMP-13-LOCK_BUSY';
END;
$$;
REVOKE ALL ON FUNCTION public.hxos_claim_fake_financial_change_order_compensation_v13(
  UUID,TEXT,TEXT,TEXT,UUID,UUID,UUID,TEXT,UUID,UUID) FROM PUBLIC;

-- These appended objects are created after the predecessor inventory scrub.
-- Remove hostile inherited default ACLs from these exact new objects only.
DO $$ DECLARE permission RECORD; grantee TEXT; BEGIN
  FOR permission IN SELECT a.grantee FROM pg_catalog.pg_class c,
    LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
    WHERE c.oid='hx_authority.fake_financial_change_order_compensation_origins_v13'::pg_catalog.regclass
      AND a.grantee<>c.relowner LOOP
    grantee:=CASE WHEN permission.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(permission.grantee)) END;
    EXECUTE 'REVOKE ALL ON TABLE hx_authority.fake_financial_change_order_compensation_origins_v13 FROM '||grantee||' CASCADE';
  END LOOP;
  FOR permission IN SELECT a.grantee FROM pg_catalog.pg_proc p,
    LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
    WHERE p.oid='public.hxos_claim_fake_financial_change_order_compensation_v13(uuid,text,text,text,uuid,uuid,uuid,text,uuid,uuid)'::pg_catalog.regprocedure
      AND a.grantee<>p.proowner LOOP
    grantee:=CASE WHEN permission.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(permission.grantee)) END;
    EXECUTE 'REVOKE ALL ON FUNCTION public.hxos_claim_fake_financial_change_order_compensation_v13(uuid,text,text,text,uuid,uuid,uuid,text,uuid,uuid) FROM '||grantee||' CASCADE';
  END LOOP;
END $$;

-- Worker-origin recovery preserves the historical participant but never invents
-- an actor assertion. The committed compensation winner survives lease expiry.
CREATE TABLE hx_authority.fake_financial_change_order_reversal_preparations_v13 (
  prepared_command_id UUID PRIMARY KEY REFERENCES public.universal_v1_prepared_financial_commands(prepared_command_id),
  compensation_command_id UUID NOT NULL UNIQUE REFERENCES hx_authority.fake_financial_change_order_compensation_origins_v13(compensation_command_id),
  target_authority_id UUID NOT NULL REFERENCES hx_authority.universal_v1_work_order_target_authority_facts(target_authority_id),
  release_manifest_sha256 TEXT NOT NULL CHECK(release_manifest_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  service_database_role TEXT NOT NULL CHECK(length(service_database_role)>0),
  provider_request_sha256 TEXT NOT NULL CHECK(provider_request_sha256 ~ '^[a-f0-9]{64}$'),
  prepared_authority_sha256 TEXT NOT NULL CHECK(prepared_authority_sha256 ~ '^[a-f0-9]{64}$'),
  preparation_transaction_id XID8 NOT NULL DEFAULT pg_catalog.pg_current_xact_id(),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
CREATE TRIGGER immutable_change_order_reversal_preparation_v13
BEFORE UPDATE OR DELETE ON hx_authority.fake_financial_change_order_reversal_preparations_v13
FOR EACH ROW EXECUTE FUNCTION hx_authority.reject_fake_financial_outbox_mutation_v13();
CREATE TRIGGER immutable_change_order_reversal_preparation_truncate_v13
BEFORE TRUNCATE ON hx_authority.fake_financial_change_order_reversal_preparations_v13
FOR EACH STATEMENT EXECUTE FUNCTION hx_authority.reject_fake_financial_outbox_mutation_v13();
REVOKE ALL ON TABLE hx_authority.fake_financial_change_order_reversal_preparations_v13 FROM PUBLIC;

CREATE OR REPLACE FUNCTION hx_authority.assert_worker_change_order_reversal_v13(
  p_compensation_id UUID,p_prepared_id UUID,p_target_id UUID,p_manifest TEXT,p_require_open BOOLEAN
) RETURNS public.universal_v1_change_order_compensation_commands
LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE SET search_path=pg_catalog AS $$
DECLARE
  claim public.universal_v1_change_order_compensation_commands%ROWTYPE;
  origin hx_authority.fake_financial_change_order_compensation_origins_v13%ROWTYPE;
  provenance hx_authority.fake_financial_change_order_reversal_preparations_v13%ROWTYPE;
  witness public.universal_v1_change_order_materialization_commands%ROWTYPE;
  prepared public.universal_v1_prepared_financial_commands%ROWTYPE;
  target RECORD; original_target RECORD; work_order RECORD; task_record RECORD; draft RECORD;
  adjustment RECORD; bridge RECORD; progress JSONB;
BEGIN
  IF p_compensation_id IS NULL OR p_target_id IS NULL OR p_manifest IS NULL OR p_require_open IS NULL THEN
    RAISE EXCEPTION 'HXUV1-COREVERSAL-13-INPUT_INVALID'; END IF;
  SELECT * INTO claim FROM public.universal_v1_change_order_compensation_commands WHERE compensation_command_id=p_compensation_id;
  SELECT * INTO origin FROM hx_authority.fake_financial_change_order_compensation_origins_v13 WHERE compensation_command_id=p_compensation_id;
  SELECT * INTO target FROM hx_authority.universal_v1_work_order_target_authority_facts WHERE target_authority_id=p_target_id;
  PERFORM hx_authority.assert_fake_financial_outbox_target_v13(p_target_id,pg_catalog.current_database(),target.environment,p_manifest);
  SELECT * INTO original_target FROM hx_authority.universal_v1_work_order_target_authority_facts WHERE target_authority_id=origin.target_authority_id;
  SELECT * INTO witness FROM public.universal_v1_change_order_materialization_commands WHERE proposal_id=claim.proposal_id;
  IF claim.compensation_command_id IS NULL OR origin.compensation_command_id IS NULL OR witness.proposal_id IS NULL
    OR origin.proposal_id IS DISTINCT FROM claim.proposal_id OR origin.recovery_lease_id IS DISTINCT FROM claim.recovery_lease_id
    OR origin.lease_owner_id IS DISTINCT FROM claim.lease_owner_id OR origin.witness_request_sha256 IS DISTINCT FROM claim.witness_request_sha256
    OR origin.adjustment_event_id IS DISTINCT FROM claim.adjustment_event_id OR origin.revocation_reason IS DISTINCT FROM claim.authority_revocation_reason
    OR original_target.target_database_name IS DISTINCT FROM pg_catalog.current_database()
    OR original_target.environment IS DISTINCT FROM target.environment OR origin.release_environment IS DISTINCT FROM target.environment
    OR origin.release_manifest_digest IS DISTINCT FROM original_target.release_manifest_sha256
    OR NOT EXISTS(WITH RECURSIVE ancestry AS (
      SELECT t.target_authority_id,t.supersedes_target_authority_id FROM hx_authority.universal_v1_work_order_target_authority_facts t WHERE t.target_authority_id=p_target_id
      UNION SELECT t.target_authority_id,t.supersedes_target_authority_id FROM hx_authority.universal_v1_work_order_target_authority_facts t JOIN ancestry a ON t.target_authority_id=a.supersedes_target_authority_id
    ) SELECT 1 FROM ancestry WHERE target_authority_id=origin.target_authority_id)
    OR claim.compensation_command_id IS DISTINCT FROM public.universal_v1_change_order_recovery_uuid_v1(witness.idempotency_key,'compensation-command')
    OR claim.reversal_operation_id IS DISTINCT FROM public.universal_v1_change_order_recovery_uuid_v1(witness.idempotency_key,'compensating-reversal')
    OR claim.reversal_idempotency_key IS DISTINCT FROM witness.idempotency_key||':recovery:reversal'
    OR claim.witness_request_sha256 IS DISTINCT FROM pg_catalog.btrim(witness.request_sha256)
    OR claim.task_draft_id IS DISTINCT FROM witness.task_draft_id OR claim.task_id IS DISTINCT FROM witness.task_id
    OR claim.work_order_id IS DISTINCT FROM witness.work_order_id OR claim.eligibility_decision_id IS DISTINCT FROM witness.eligibility_decision_id
    OR claim.base_scope_version_id IS DISTINCT FROM witness.base_scope_version_id OR claim.adjustment_operation_id IS DISTINCT FROM witness.adjustment_operation_id
    OR claim.lifecycle_expected_version::BIGINT IS DISTINCT FROM witness.expected_financial_version::BIGINT+2
    OR claim.amount_cents IS DISTINCT FROM witness.customer_total_cents OR claim.currency IS DISTINCT FROM witness.currency
    OR claim.requested_by IS DISTINCT FROM witness.actor_user_id OR claim.reason_code IS DISTINCT FROM 'FINALIZATION_AUTHORITY_REVOKED'
    OR claim.semantic_limitation IS DISTINCT FROM 'PRIOR_SECURED_STATE_NOT_RESTORED' THEN
    RAISE EXCEPTION 'HXUV1-COREVERSAL-13-ORIGIN_IDENTITY_INVALID'; END IF;
  IF p_prepared_id IS NOT NULL THEN
    SELECT * INTO prepared FROM public.universal_v1_prepared_financial_commands WHERE prepared_command_id=p_prepared_id;
    SELECT * INTO provenance FROM hx_authority.fake_financial_change_order_reversal_preparations_v13 WHERE prepared_command_id=p_prepared_id;
    IF provenance.prepared_command_id IS NULL OR prepared.prepared_command_id IS NULL
      OR provenance.compensation_command_id IS DISTINCT FROM claim.compensation_command_id
      OR provenance.target_authority_id IS DISTINCT FROM p_target_id OR provenance.release_manifest_sha256 IS DISTINCT FROM p_manifest
      OR prepared.command_state IS DISTINCT FROM 'PREPARED' OR prepared.provider_kind IS DISTINCT FROM 'FAKE'
      OR prepared.operation_kind IS DISTINCT FROM 'REVERSAL' OR prepared.operation_id IS DISTINCT FROM claim.reversal_operation_id
      OR prepared.idempotency_key IS DISTINCT FROM claim.reversal_idempotency_key OR prepared.provider_expected_version IS DISTINCT FROM 0::BIGINT
      OR prepared.task_draft_id IS DISTINCT FROM claim.task_draft_id OR prepared.task_id IS DISTINCT FROM claim.task_id
      OR prepared.work_order_id IS DISTINCT FROM claim.work_order_id OR prepared.eligibility_decision_id IS DISTINCT FROM claim.eligibility_decision_id
      OR prepared.scope_version_id IS DISTINCT FROM claim.base_scope_version_id OR prepared.change_order_id IS NOT NULL OR prepared.completion_fact_id IS NOT NULL
      OR prepared.predecessor_event_id IS DISTINCT FROM claim.adjustment_event_id OR prepared.related_operation_id IS DISTINCT FROM claim.adjustment_operation_id
      OR prepared.lifecycle_expected_version IS DISTINCT FROM claim.lifecycle_expected_version
      OR prepared.amount_cents IS DISTINCT FROM claim.amount_cents OR prepared.currency IS DISTINCT FROM claim.currency
      OR prepared.recorded_by IS DISTINCT FROM claim.requested_by
      OR provenance.provider_request_sha256 IS DISTINCT FROM pg_catalog.btrim(prepared.provider_request_sha256)
      OR provenance.prepared_authority_sha256 IS DISTINCT FROM pg_catalog.btrim(prepared.authority_context_sha256) THEN
      RAISE EXCEPTION 'HXUV1-COREVERSAL-13-PREPARATION_IDENTITY_INVALID'; END IF;
  END IF;
  IF p_require_open THEN
    IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('universal-v1-change-order-proposal:'||claim.proposal_id::TEXT,0))
      OR NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('fulfillment:'||claim.work_order_id::TEXT,0)) THEN
      RAISE EXCEPTION 'HXUV1-COREVERSAL-13-DOMAIN_LOCK_BUSY'; END IF;
    PERFORM 1 FROM public.universal_v1_change_order_materialization_commands WHERE proposal_id=claim.proposal_id FOR SHARE NOWAIT;
    SELECT id,task_id,task_draft_id,eligibility_decision_id INTO work_order FROM public.task_work_orders WHERE id=claim.work_order_id FOR UPDATE NOWAIT;
    SELECT id,universal_contract_version,automation_classification,universal_payment_posture,worker_id,work_order_id,active_scope_version_id INTO task_record FROM public.tasks WHERE id=claim.task_id FOR UPDATE NOWAIT;
    SELECT id,task_id,claimed_at,ingress_origin,universal_contract_version INTO draft FROM public.task_drafts WHERE id=claim.task_draft_id FOR UPDATE NOWAIT;
    PERFORM 1 FROM public.task_scope_change_proposals WHERE id=claim.proposal_id FOR UPDATE NOWAIT;
    PERFORM 1 FROM public.task_provider_eligibility_decisions WHERE id=claim.eligibility_decision_id FOR SHARE NOWAIT;
    PERFORM 1 FROM public.task_scope_versions WHERE id IN (claim.base_scope_version_id,witness.replacement_scope_version_id) ORDER BY id FOR SHARE NOWAIT;
    SELECT * INTO adjustment FROM public.task_financial_security_events WHERE id=claim.adjustment_event_id FOR SHARE NOWAIT;
    SELECT * INTO bridge FROM public.universal_v1_fake_financial_lifecycle_bridges WHERE task_financial_security_event_id=claim.adjustment_event_id;
    IF work_order.id IS NULL OR task_record.id IS NULL OR draft.id IS NULL OR adjustment.id IS NULL OR bridge.bridge_id IS NULL
      OR draft.task_id IS DISTINCT FROM claim.task_id OR draft.claimed_at IS NULL OR draft.ingress_origin IS DISTINCT FROM 'BACKEND_POSTGRESQL'
      OR draft.universal_contract_version IS DISTINCT FROM 1 OR task_record.universal_contract_version IS DISTINCT FROM 1
      OR task_record.automation_classification IS DISTINCT FROM 'CONTROLLED_TEST' OR task_record.universal_payment_posture IS DISTINCT FROM 'PAYMENT_CREATION_FROZEN'
      OR task_record.worker_id IS NOT NULL OR task_record.work_order_id IS DISTINCT FROM claim.work_order_id
      OR task_record.active_scope_version_id IS DISTINCT FROM claim.base_scope_version_id
      OR work_order.task_id IS DISTINCT FROM claim.task_id OR work_order.task_draft_id IS DISTINCT FROM claim.task_draft_id
      OR work_order.eligibility_decision_id IS DISTINCT FROM claim.eligibility_decision_id
      OR public.universal_v1_effective_work_order_scope_id(claim.work_order_id) IS DISTINCT FROM claim.base_scope_version_id
      OR EXISTS(SELECT 1 FROM public.task_work_order_amendments WHERE change_order_id=claim.proposal_id)
      OR EXISTS(SELECT 1 FROM public.universal_v1_change_order_recovery_terminal_facts WHERE proposal_id=claim.proposal_id)
      OR EXISTS(SELECT 1 FROM public.task_financial_security_events e WHERE e.task_draft_id=claim.task_draft_id AND e.expected_version>=claim.lifecycle_expected_version)
      OR adjustment.operation_id IS DISTINCT FROM claim.adjustment_operation_id::TEXT OR adjustment.idempotency_key IS DISTINCT FROM witness.idempotency_key||':adjust'
      OR adjustment.event_kind IS DISTINCT FROM 'ADJUSTMENT_AUTHORIZED' OR adjustment.status IS DISTINCT FROM 'SUCCEEDED' OR adjustment.provider_kind IS DISTINCT FROM 'FAKE'
      OR adjustment.expected_version::BIGINT IS DISTINCT FROM claim.lifecycle_expected_version::BIGINT-1
      OR adjustment.task_draft_id IS DISTINCT FROM claim.task_draft_id OR adjustment.task_id IS DISTINCT FROM claim.task_id
      OR adjustment.eligibility_decision_id IS DISTINCT FROM claim.eligibility_decision_id
      OR adjustment.scope_version_id IS DISTINCT FROM witness.replacement_scope_version_id OR adjustment.change_order_id IS DISTINCT FROM claim.proposal_id
      OR adjustment.predecessor_event_id IS DISTINCT FROM witness.predecessor_event_id OR adjustment.recorded_by IS DISTINCT FROM claim.requested_by
      OR adjustment.amount_cents IS DISTINCT FROM claim.amount_cents OR adjustment.currency IS DISTINCT FROM claim.currency
      OR bridge.fake_operation_id IS DISTINCT FROM claim.adjustment_operation_id OR bridge.fake_operation_kind IS DISTINCT FROM 'ADJUST'
      OR bridge.command_id IS NULL THEN RAISE EXCEPTION 'HXUV1-COREVERSAL-13-DOMAIN_AUTHORITY_CHANGED'; END IF;
    IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtext('financial-provider-command-recovery-v1'),pg_catalog.hashtext(bridge.command_id::TEXT))
      OR NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtext('fake-financial-operation'),pg_catalog.hashtext(claim.adjustment_operation_id::TEXT)) THEN
      RAISE EXCEPTION 'HXUV1-COREVERSAL-13-FINANCIAL_LOCK_BUSY'; END IF;
    progress:=hx_authority.read_fake_financial_public_progress_v13(bridge.command_id);
    IF progress IS NULL OR progress->>'commandId' IS DISTINCT FROM bridge.command_id::TEXT
      OR progress->>'ownerActorId' IS DISTINCT FROM claim.requested_by::TEXT OR progress->>'environment' IS DISTINCT FROM target.environment
      OR progress->>'taskDraftId' IS DISTINCT FROM claim.task_draft_id::TEXT OR progress->>'taskId' IS DISTINCT FROM claim.task_id::TEXT
      OR progress->>'operationKind' IS DISTINCT FROM 'ADJUST' OR progress->>'operationId' IS DISTINCT FROM claim.adjustment_operation_id::TEXT
      OR progress->>'progressState' IS DISTINCT FROM 'MATERIALIZED' OR progress#>>'{financialEvent,id}' IS DISTINCT FROM claim.adjustment_event_id::TEXT THEN
      RAISE EXCEPTION 'HXUV1-COREVERSAL-13-ADMITTED_ADJUSTMENT_REQUIRED'; END IF;
  END IF;
  RETURN claim;
EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION 'HXUV1-COREVERSAL-13-DOMAIN_LOCK_BUSY';
END;
$$;

CREATE OR REPLACE FUNCTION public.hxos_prepare_change_order_compensation_reversal_v13(
  p_target_id UUID,p_database TEXT,p_environment TEXT,p_manifest TEXT,p_compensation_id UUID,p_canonical_request TEXT
) RETURNS TABLE(prepared_command JSONB,idempotency_replayed BOOLEAN,worker_provenance JSONB,target_authority_id UUID,release_manifest_digest TEXT)
LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE SET search_path=pg_catalog AS $$
DECLARE
  claim public.universal_v1_change_order_compensation_commands%ROWTYPE;
  prepared public.universal_v1_prepared_financial_commands%ROWTYPE;
  provenance hx_authority.fake_financial_change_order_reversal_preparations_v13%ROWTYPE;
  request JSONB; request_sha TEXT; lock_name TEXT; replay BOOLEAN:=FALSE;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'HXUV1-COREVERSAL-13-READ_COMMITTED_REQUIRED'; END IF;
  PERFORM hx_authority.assert_fake_financial_outbox_target_v13(p_target_id,p_database,p_environment,p_manifest);
  claim:=hx_authority.assert_worker_change_order_reversal_v13(p_compensation_id,NULL,p_target_id,p_manifest,FALSE);
  request:=hx_authority.parse_fake_financial_request_v13('REVERSAL',p_canonical_request);
  request_sha:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_canonical_request,'UTF8')),'hex');
  IF request->>'operationId' IS DISTINCT FROM claim.reversal_operation_id::TEXT OR request->>'idempotencyKey' IS DISTINCT FROM claim.reversal_idempotency_key
    OR request->>'expectedVersion' IS DISTINCT FROM '0' OR request->>'relatedOperationId' IS DISTINCT FROM claim.adjustment_operation_id::TEXT
    OR (request->>'amountCents')::BIGINT IS DISTINCT FROM claim.amount_cents OR request->>'currency' IS DISTINCT FROM pg_catalog.lower(claim.currency) THEN
    RAISE EXCEPTION 'HXUV1-COREVERSAL-13-REQUEST_IDENTITY_INVALID'; END IF;
  FOR lock_name IN SELECT value FROM pg_catalog.unnest(ARRAY[
    'draft-version:'||claim.task_draft_id::TEXT||':'||claim.lifecycle_expected_version::TEXT,
    'idempotency:'||claim.reversal_idempotency_key,
    'operation-version:FAKE:REVERSAL:'||claim.reversal_operation_id::TEXT||':0'
  ]) locks(value) ORDER BY value COLLATE "C" LOOP
    IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtext('universal-v1-prepared-financial-command-v1'),pg_catalog.hashtext(lock_name)) THEN
      RAISE EXCEPTION 'HXUV1-COREVERSAL-13-PREPARATION_LOCK_BUSY'; END IF;
  END LOOP;
  SELECT * INTO prepared FROM public.universal_v1_prepared_financial_commands p
    WHERE p.idempotency_key=claim.reversal_idempotency_key
      OR (p.provider_kind='FAKE' AND p.operation_kind='REVERSAL' AND p.operation_id=claim.reversal_operation_id AND p.provider_expected_version=0)
      OR (p.task_draft_id=claim.task_draft_id AND p.lifecycle_expected_version=claim.lifecycle_expected_version)
    ORDER BY (p.idempotency_key=claim.reversal_idempotency_key) DESC,p.prepared_command_id LIMIT 1;
  IF prepared.prepared_command_id IS NOT NULL THEN
    PERFORM hx_authority.assert_worker_change_order_reversal_v13(p_compensation_id,prepared.prepared_command_id,p_target_id,p_manifest,FALSE);
    SELECT * INTO provenance FROM hx_authority.fake_financial_change_order_reversal_preparations_v13 WHERE prepared_command_id=prepared.prepared_command_id;
    IF provenance.service_database_role IS DISTINCT FROM SESSION_USER OR provenance.provider_request_sha256 IS DISTINCT FROM request_sha THEN
      RAISE EXCEPTION 'HXUV1-COREVERSAL-13-IDEMPOTENCY_CONFLICT'; END IF;
    replay:=TRUE;
  ELSE
    PERFORM hx_authority.assert_worker_change_order_reversal_v13(p_compensation_id,NULL,p_target_id,p_manifest,TRUE);
    SELECT * INTO STRICT prepared FROM public.hxos_prepare_universal_v1_financial_command_v1(
      pg_catalog.gen_random_uuid(),'REVERSAL',claim.reversal_operation_id,'FAKE',claim.reversal_idempotency_key,0::BIGINT,
      claim.lifecycle_expected_version,request_sha,claim.task_draft_id,claim.task_id,claim.eligibility_decision_id,claim.base_scope_version_id,
      NULL,claim.adjustment_event_id,NULL,claim.adjustment_operation_id,claim.amount_cents,claim.currency,claim.requested_by);
    INSERT INTO hx_authority.fake_financial_change_order_reversal_preparations_v13(
      prepared_command_id,compensation_command_id,target_authority_id,release_manifest_sha256,service_database_role,provider_request_sha256,prepared_authority_sha256
    ) VALUES(prepared.prepared_command_id,claim.compensation_command_id,p_target_id,p_manifest,SESSION_USER,request_sha,pg_catalog.btrim(prepared.authority_context_sha256)) RETURNING * INTO provenance;
  END IF;
  prepared_command:=pg_catalog.to_jsonb(prepared);idempotency_replayed:=replay;worker_provenance:=pg_catalog.to_jsonb(provenance);
  target_authority_id:=p_target_id;release_manifest_digest:=p_manifest;RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION hx_authority.require_worker_change_order_reversal_preparation_v13()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE SET search_path=pg_catalog AS $$
DECLARE claim_id UUID; provenance hx_authority.fake_financial_change_order_reversal_preparations_v13%ROWTYPE;
BEGIN
  IF NEW.operation_kind<>'REVERSAL' THEN RETURN NEW; END IF;
  SELECT c.compensation_command_id INTO claim_id FROM public.universal_v1_change_order_compensation_commands c
    JOIN hx_authority.fake_financial_change_order_compensation_origins_v13 o USING(compensation_command_id)
    WHERE c.reversal_operation_id=NEW.operation_id;
  IF claim_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO provenance FROM hx_authority.fake_financial_change_order_reversal_preparations_v13 WHERE prepared_command_id=NEW.prepared_command_id;
  IF provenance.prepared_command_id IS NULL OR provenance.service_database_role IS DISTINCT FROM SESSION_USER
    OR provenance.preparation_transaction_id IS DISTINCT FROM pg_catalog.pg_current_xact_id() THEN
    RAISE EXCEPTION 'HXUV1-COREVERSAL-13-WORKER_PREPARATION_REQUIRED'; END IF;
  PERFORM hx_authority.assert_worker_change_order_reversal_v13(claim_id,NEW.prepared_command_id,provenance.target_authority_id,provenance.release_manifest_sha256,FALSE);
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER require_worker_change_order_reversal_preparation_v13
AFTER INSERT ON public.universal_v1_prepared_financial_commands
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION hx_authority.require_worker_change_order_reversal_preparation_v13();

CREATE OR REPLACE FUNCTION hx_authority.validate_fake_financial_outbox_request_v13()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
DECLARE
  command_record RECORD;
  prepared_record RECORD;
  target_record RECORD;
  expected_job_authority_sha256 CHAR(64);
  expected_bullmq_job_id TEXT;
BEGIN
  SELECT command.command_state,
         command.operation_kind,
         command.operation_id,
         command.provider_kind,
         command.idempotency_key,
         command.provider_expected_version,
         command.request_sha256,
         command.command_identity_sha256,
         command.prepared_financial_command_id,
         command.prepared_authority_sha256,
         command.release_manifest_digest,
         command.release_id,
         command.release_revision,
         command.release_environment,
         command.release_authentication_status
    INTO command_record
    FROM public.financial_provider_command_journal command
   WHERE command.command_id = NEW.command_id
   FOR SHARE;

  SELECT prepared.command_state,
         prepared.operation_kind,
         prepared.operation_id,
         prepared.provider_kind,
         prepared.idempotency_key,
         prepared.provider_expected_version,
         prepared.provider_request_sha256,
         prepared.authority_context_sha256
    INTO prepared_record
    FROM public.universal_v1_prepared_financial_commands prepared
   WHERE prepared.prepared_command_id = NEW.prepared_command_id
   FOR SHARE;

  SELECT target.authority_version,
         target.target_database_name,
         target.environment,
         target.release_manifest_sha256
    INTO target_record
    FROM hx_authority.universal_v1_work_order_target_authority_facts target
   WHERE target.target_authority_id = NEW.target_authority_id
   FOR SHARE;

  PERFORM hx_authority.assert_fake_financial_outbox_target_v13(
    NEW.target_authority_id,
    NEW.target_database_name,
    NEW.release_environment,
    NEW.release_manifest_digest
  );

  IF NOT EXISTS (
    SELECT 1 FROM hx_authority.fake_financial_preparation_authority_v13 provenance
    JOIN public.universal_v1_prepared_financial_commands prepared
      ON prepared.prepared_command_id = provenance.prepared_command_id
    JOIN public.financial_provider_command_journal command
      ON command.command_id = NEW.command_id
    WHERE provenance.prepared_command_id = NEW.prepared_command_id
      AND provenance.actor_user_id = prepared.recorded_by
      AND provenance.actor_user_id = command.recorded_actor_id
      AND command.recorded_actor_kind = 'PARTICIPANT'
      AND provenance.target_authority_id = NEW.target_authority_id
      AND provenance.release_manifest_sha256 = NEW.release_manifest_digest
      AND NOT EXISTS(SELECT 1 FROM public.universal_v1_change_order_compensation_commands c
        JOIN hx_authority.fake_financial_change_order_compensation_origins_v13 o USING(compensation_command_id)
        WHERE c.reversal_operation_id=prepared.operation_id AND prepared.operation_kind='REVERSAL')
  ) AND NOT EXISTS (
    SELECT 1 FROM hx_authority.fake_financial_change_order_reversal_preparations_v13 provenance
    JOIN public.universal_v1_prepared_financial_commands prepared ON prepared.prepared_command_id=provenance.prepared_command_id
    JOIN public.financial_provider_command_journal command ON command.command_id=NEW.command_id
    JOIN public.universal_v1_change_order_compensation_commands compensation ON compensation.compensation_command_id=provenance.compensation_command_id
    WHERE provenance.prepared_command_id=NEW.prepared_command_id AND provenance.service_database_role=SESSION_USER
      AND provenance.target_authority_id=NEW.target_authority_id AND provenance.release_manifest_sha256=NEW.release_manifest_digest
      AND provenance.provider_request_sha256=command.request_sha256 AND provenance.prepared_authority_sha256=command.prepared_authority_sha256
      AND prepared.recorded_by=compensation.requested_by AND command.recorded_actor_id=compensation.requested_by
      AND command.recorded_actor_kind='PARTICIPANT' AND prepared.operation_kind='REVERSAL'
      AND prepared.operation_id=compensation.reversal_operation_id
  ) THEN RAISE EXCEPTION 'HXUV1-FINREQ-13-AUTHENTICATED_PREPARATION_REQUIRED'; END IF;

  IF command_record.command_state IS DISTINCT FROM 'REQUESTED'
     OR command_record.provider_kind IS DISTINCT FROM 'FAKE'
     OR command_record.release_authentication_status IS DISTINCT FROM 'VERIFIED'
     OR command_record.release_environment NOT IN ('local', 'preview', 'staging')
     OR prepared_record.command_state IS DISTINCT FROM 'PREPARED'
     OR prepared_record.provider_kind IS DISTINCT FROM 'FAKE'
     OR command_record.prepared_financial_command_id IS DISTINCT FROM
          NEW.prepared_command_id
     OR command_record.prepared_authority_sha256 IS DISTINCT FROM
          prepared_record.authority_context_sha256
     OR command_record.request_sha256 IS DISTINCT FROM
          prepared_record.provider_request_sha256
     OR command_record.operation_kind IS DISTINCT FROM prepared_record.operation_kind
     OR command_record.operation_id IS DISTINCT FROM prepared_record.operation_id
     OR command_record.idempotency_key IS DISTINCT FROM prepared_record.idempotency_key
     OR command_record.provider_expected_version IS DISTINCT FROM
          prepared_record.provider_expected_version
     OR NEW.prepared_state IS DISTINCT FROM prepared_record.command_state
     OR NEW.command_state IS DISTINCT FROM command_record.command_state
     OR NEW.provider_kind IS DISTINCT FROM command_record.provider_kind
     OR NEW.operation_kind IS DISTINCT FROM command_record.operation_kind
     OR NEW.operation_id IS DISTINCT FROM command_record.operation_id
     OR NEW.idempotency_key IS DISTINCT FROM command_record.idempotency_key
     OR NEW.provider_expected_version IS DISTINCT FROM
          command_record.provider_expected_version
     OR NEW.provider_request_sha256 IS DISTINCT FROM command_record.request_sha256
     OR NEW.command_identity_sha256 IS DISTINCT FROM
          command_record.command_identity_sha256
     OR NEW.prepared_authority_sha256 IS DISTINCT FROM
          prepared_record.authority_context_sha256
     OR NEW.release_manifest_digest IS DISTINCT FROM
          command_record.release_manifest_digest
     OR NEW.release_id IS DISTINCT FROM command_record.release_id
     OR NEW.release_revision IS DISTINCT FROM command_record.release_revision
     OR NEW.release_environment IS DISTINCT FROM command_record.release_environment
     OR NEW.target_authority_version IS DISTINCT FROM target_record.authority_version
     OR NEW.target_database_name IS DISTINCT FROM target_record.target_database_name
     OR NEW.release_environment IS DISTINCT FROM target_record.environment
     OR NEW.release_manifest_digest IS DISTINCT FROM
          target_record.release_manifest_sha256 THEN
    RAISE EXCEPTION
      'HXUV1-FINOUT-13-8: outbox request lacks exact PREPARED/REQUESTED/target authority'
      USING ERRCODE = 'P0001';
  END IF;

  expected_job_authority_sha256 := hx_authority.fake_financial_job_digest_v13(
    ARRAY[
      'HXUV1_FAKE_FINANCIAL_BULLMQ_JOB_V13',
      NEW.outbox_request_id::TEXT,
      NEW.command_id::TEXT,
      NEW.prepared_command_id::TEXT,
      NEW.target_authority_id::TEXT,
      NEW.target_authority_version::TEXT,
      NEW.target_database_name,
      NEW.release_environment,
      NEW.release_manifest_digest,
      NEW.release_id,
      pg_catalog.btrim(NEW.release_revision),
      NEW.operation_kind,
      NEW.operation_id::TEXT,
      NEW.idempotency_key,
      NEW.provider_expected_version::TEXT,
      pg_catalog.btrim(NEW.provider_request_sha256),
      pg_catalog.btrim(NEW.command_identity_sha256),
      pg_catalog.btrim(NEW.prepared_authority_sha256),
      NEW.queue_name,
      NEW.job_name,
      NEW.payload_contract_version::TEXT
    ]::TEXT[]
  );
  expected_bullmq_job_id := 'hx-fake-fin-'
    || pg_catalog.replace(NEW.command_id::TEXT, '-', '')
    || '-' || pg_catalog.btrim(expected_job_authority_sha256);
  IF NEW.job_authority_sha256 IS DISTINCT FROM expected_job_authority_sha256
     OR NEW.bullmq_job_id IS DISTINCT FROM expected_bullmq_job_id THEN
    RAISE EXCEPTION
      'HXUV1-FINOUT-13-9: deterministic BullMQ job identity mismatch'
      USING ERRCODE = 'P0001';
  END IF;

  NEW.requested_at := pg_catalog.clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION public.hxos_request_fake_financial_command_v13(
  p_canonical_provider_request TEXT, p_canonical_command_identity TEXT
)
RETURNS TABLE (
  command_id UUID, operation_kind TEXT, operation_id UUID, provider_kind TEXT,
  idempotency_key TEXT, provider_expected_version BIGINT, request_sha256 TEXT,
  command_identity_sha256 TEXT, prepared_financial_command_id UUID,
  prepared_authority_sha256 TEXT, recorded_at TIMESTAMPTZ, idempotency_replayed BOOLEAN
)
LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
DECLARE
  identity JSONB;
  request JSONB;
  identity_sha256 TEXT;
  provider_sha256 TEXT;
  command public.financial_provider_command_journal%ROWTYPE;
  lock_name TEXT;
  replay BOOLEAN := FALSE;
  conflict_reason TEXT;
  outbox RECORD;
  worker_reversal hx_authority.fake_financial_change_order_reversal_preparations_v13%ROWTYPE;
BEGIN
  identity := hx_authority.parse_fake_financial_identity_v13(p_canonical_command_identity);
  request := hx_authority.parse_fake_financial_request_v13(identity ->> 'operationKind', p_canonical_provider_request);
  identity_sha256 := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_canonical_command_identity,'UTF8')), 'hex');
  provider_sha256 := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_canonical_provider_request,'UTF8')), 'hex');
  IF identity ->> 'requestSha256' IS DISTINCT FROM provider_sha256
     OR identity ->> 'operationId' IS DISTINCT FROM ((request ->> 'operationId')::UUID)::TEXT
     OR identity -> 'idempotencyKey' IS DISTINCT FROM request -> 'idempotencyKey'
     OR identity -> 'providerExpectedVersion' IS DISTINCT FROM request -> 'expectedVersion' THEN
    RAISE EXCEPTION 'HXUV1-FINREQ-13-COMMAND_REQUEST_MISMATCH';
  END IF;
  SELECT * INTO worker_reversal FROM hx_authority.fake_financial_change_order_reversal_preparations_v13
    WHERE prepared_command_id=(identity#>>'{evidence,preparedFinancialCommandId}')::UUID;
  IF worker_reversal.prepared_command_id IS NOT NULL AND worker_reversal.service_database_role IS DISTINCT FROM SESSION_USER THEN
    RAISE EXCEPTION 'HXUV1-COREVERSAL-13-WORKER_REQUEST_REQUIRED'; END IF;
  FOR lock_name IN SELECT value FROM pg_catalog.unnest(ARRAY[
    'idempotency:' || (identity ->> 'idempotencyKey'),
    'operation-version:FAKE:' || (identity ->> 'operationKind') || ':' || (identity ->> 'operationId') || ':' || (identity ->> 'providerExpectedVersion')
  ]) locks(value) ORDER BY value COLLATE "C" LOOP
    IF worker_reversal.prepared_command_id IS NOT NULL THEN
      IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtext('financial-provider-command-journal-v1'),pg_catalog.hashtext(lock_name)) THEN
        RAISE EXCEPTION 'HXUV1-COREVERSAL-13-REQUEST_LOCK_BUSY'; END IF;
    ELSE
      PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('financial-provider-command-journal-v1'),pg_catalog.hashtext(lock_name));
    END IF;
  END LOOP;
  SELECT stored.* INTO command FROM public.financial_provider_command_journal stored
    WHERE stored.idempotency_key = identity ->> 'idempotencyKey';
  conflict_reason := 'HXUV1-FINREQ-13-IDEMPOTENCY_CONFLICT';
  IF command.command_id IS NULL THEN
    SELECT stored.* INTO command FROM public.financial_provider_command_journal stored
      WHERE stored.provider_kind = 'FAKE' AND stored.operation_kind = identity ->> 'operationKind'
        AND stored.operation_id = (identity ->> 'operationId')::UUID
        AND stored.provider_expected_version = (identity ->> 'providerExpectedVersion')::BIGINT;
    conflict_reason := 'HXUV1-FINREQ-13-OPERATION_VERSION_CONFLICT';
  END IF;
  IF worker_reversal.prepared_command_id IS NOT NULL THEN
    PERFORM hx_authority.assert_worker_change_order_reversal_v13(worker_reversal.compensation_command_id,
      worker_reversal.prepared_command_id,worker_reversal.target_authority_id,worker_reversal.release_manifest_sha256,command.command_id IS NULL);
  END IF;
  IF command.command_id IS NOT NULL THEN
    IF pg_catalog.btrim(command.command_identity_sha256) IS DISTINCT FROM identity_sha256 THEN
      RAISE EXCEPTION '%', conflict_reason;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM hx_authority.fake_financial_exact_requests_v13 exact_request
      WHERE exact_request.command_id = command.command_id
        AND exact_request.canonical_provider_request = p_canonical_provider_request
        AND exact_request.provider_request_sha256 = provider_sha256) THEN
      RAISE EXCEPTION 'HXUV1-FINREQ-13-REPLAY_REQUEST_MISSING';
    END IF;
    replay := TRUE;
  ELSE
    INSERT INTO public.financial_provider_command_journal (
      operation_kind, operation_id, provider_kind, idempotency_key, provider_expected_version,
      request_sha256, command_identity_sha256, prepared_financial_command_id, prepared_authority_sha256,
      task_draft_id, task_id, work_order_id, related_operation_id, amount_cents, currency,
      recorded_actor_id, recorded_actor_kind, release_manifest_digest, release_id, release_revision,
      release_environment, release_authentication_status
    ) VALUES (
      identity ->> 'operationKind', (identity ->> 'operationId')::UUID, 'FAKE', identity ->> 'idempotencyKey',
      (identity ->> 'providerExpectedVersion')::BIGINT, provider_sha256, identity_sha256,
      (identity #>> '{evidence,preparedFinancialCommandId}')::UUID, identity #>> '{evidence,preparedAuthoritySha256}',
      (identity #>> '{evidence,taskDraftId}')::UUID, (identity #>> '{evidence,taskId}')::UUID,
      (identity #>> '{evidence,workOrderId}')::UUID, (identity #>> '{evidence,relatedOperationId}')::UUID,
      (identity #>> '{evidence,amountCents}')::BIGINT, identity #>> '{evidence,currency}',
      (identity #>> '{actor,actorId}')::UUID, identity #>> '{actor,actorKind}',
      identity #>> '{release,manifestDigest}', identity #>> '{release,releaseId}', identity #>> '{release,revision}',
      identity #>> '{release,environment}', identity #>> '{release,authenticationStatus}'
    ) RETURNING * INTO command;
    INSERT INTO hx_authority.fake_financial_exact_requests_v13 (
      command_id, canonical_provider_request, provider_request_sha256
    ) VALUES (command.command_id, p_canonical_provider_request, provider_sha256);
  END IF;
  SELECT * INTO outbox FROM hx_authority.fake_financial_command_outbox_requests_v13 queued
    WHERE queued.command_id = command.command_id;
  IF outbox.outbox_request_id IS NULL THEN RAISE EXCEPTION 'HXUV1-FINREQ-13-OUTBOX_MISSING'; END IF;
  PERFORM hx_authority.assert_fake_financial_outbox_target_v13(outbox.target_authority_id,
    outbox.target_database_name, outbox.release_environment, outbox.release_manifest_digest);
  RETURN QUERY SELECT command.command_id, command.operation_kind, command.operation_id,
    command.provider_kind, command.idempotency_key, command.provider_expected_version,
    pg_catalog.btrim(command.request_sha256), pg_catalog.btrim(command.command_identity_sha256),
    command.prepared_financial_command_id, pg_catalog.btrim(command.prepared_authority_sha256),
    command.recorded_at, replay;
END;
$$;
CREATE OR REPLACE FUNCTION hx_authority.assert_worker_change_order_reversal_execution_v13(p_prepared_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE SET search_path=pg_catalog AS $$
DECLARE provenance hx_authority.fake_financial_change_order_reversal_preparations_v13%ROWTYPE;
BEGIN
  SELECT * INTO provenance FROM hx_authority.fake_financial_change_order_reversal_preparations_v13 WHERE prepared_command_id=p_prepared_id;
  IF provenance.prepared_command_id IS NOT NULL THEN
    PERFORM hx_authority.assert_worker_change_order_reversal_v13(provenance.compensation_command_id,
      p_prepared_id,provenance.target_authority_id,provenance.release_manifest_sha256,TRUE);
  END IF;
END;
$$;
CREATE OR REPLACE FUNCTION hx_authority.assert_fake_financial_execution_domain_v13(p_command_id UUID, p_request_sha256 TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
DECLARE
  requested public.financial_provider_command_journal%ROWTYPE;
  prepared public.universal_v1_prepared_financial_commands%ROWTYPE;
  intent public.universal_v1_fake_terminal_lifecycle_intents%ROWTYPE;
  task_record public.tasks%ROWTYPE;
  work_order public.task_work_orders%ROWTYPE;
  eligibility public.task_provider_eligibility_decisions%ROWTYPE;
  account_fact public.universal_v1_fake_provider_account_facts%ROWTYPE;
  draft_record public.task_drafts%ROWTYPE;
  scope_record public.task_scope_versions%ROWTYPE;
  route_record public.task_routing_decisions%ROWTYPE;
  service_cell public.universal_v1_service_cell_authorities%ROWTYPE;
  commitment public.task_work_order_command_requests%ROWTYPE;
  hold_record public.task_reservations%ROWTYPE;
  interest_record public.task_applications%ROWTYPE;
  domain_now TIMESTAMPTZ;
  adjustment_actor_ids UUID[];

BEGIN
  SELECT * INTO requested
    FROM public.financial_provider_command_journal
   WHERE command_id = p_command_id
   FOR SHARE;
  IF requested.command_id IS NULL
     OR requested.prepared_financial_command_id IS NULL THEN
    RAISE EXCEPTION 'HXUV1-FINEXEC-13-REQUESTED_MISSING';
  END IF;

  SELECT * INTO prepared
    FROM public.universal_v1_prepared_financial_commands
   WHERE prepared_command_id = requested.prepared_financial_command_id
   FOR SHARE;
  IF prepared.prepared_command_id IS NULL OR requested.request_sha256 IS DISTINCT FROM p_request_sha256 THEN
    RAISE EXCEPTION 'HXUV1-FINEXEC-13-PREPARED_MISMATCH';
  END IF;
  IF prepared.operation_kind IN ('SECURE', 'ADJUST', 'CAPTURE') AND
     public.universal_v1_financial_security_is_current_v1(
       public.universal_v1_effective_financial_security_expiry_v1(prepared.predecessor_event_id),
       pg_catalog.clock_timestamp()
     ) IS NOT TRUE THEN
    RAISE EXCEPTION 'HXUV1-FINEXEC-13-PREDECESSOR_EXPIRED';
  END IF;

  IF prepared.operation_kind IN ('PROVIDER_RELEASE','PAYOUT') AND prepared.work_order_id IS NOT NULL THEN
    -- Submission takes dispute before target. Never wait for that lock while
    -- execution holds target: refuse contention and retain the admitted attempt.
    IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(
      'universal-v1-dispute:' || prepared.work_order_id::TEXT, 0
    )) THEN RAISE EXCEPTION 'HXUV1-FINEXEC-13-DISPUTE_LOCK_BUSY'; END IF;
    IF public.universal_v1_has_open_material_dispute_v1(prepared.work_order_id) IS DISTINCT FROM FALSE THEN
      RAISE EXCEPTION 'HXUV1-FINEXEC-13-MATERIAL_DISPUTE_OPEN';
    END IF;
  END IF;
  IF prepared.operation_kind IN ('PREPARE_PAYMENT_METHOD','AUTHORIZE','SECURE') THEN
    -- Execution already owns publisher/target/command/operation locks. Domain
    -- submissions take those locks in the other direction: never wait here.
    SELECT * INTO draft_record FROM public.task_drafts
      WHERE id=prepared.task_draft_id FOR UPDATE NOWAIT;
    PERFORM 1 FROM public.users WHERE id=prepared.recorded_by FOR SHARE NOWAIT;
    IF draft_record.id IS NULL OR draft_record.universal_contract_version IS DISTINCT FROM 1
       OR draft_record.ingress_origin IS DISTINCT FROM 'BACKEND_POSTGRESQL'
       OR draft_record.claimed_at IS NULL
       OR draft_record.poster_user_id IS DISTINCT FROM prepared.recorded_by
       OR NOT EXISTS (SELECT 1 FROM public.users customer
         WHERE customer.id=prepared.recorded_by AND customer.account_status='ACTIVE'
           AND customer.is_minor IS FALSE AND COALESCE(customer.is_banned,FALSE) IS FALSE) THEN
      RAISE EXCEPTION 'HXUV1-FINEXEC-13-CUSTOMER_AUTHORITY_REVOKED';
    END IF;
    IF prepared.task_id IS NULL THEN
      IF prepared.operation_kind IS DISTINCT FROM 'PREPARE_PAYMENT_METHOD'
         OR draft_record.task_id IS NOT NULL THEN
        RAISE EXCEPTION 'HXUV1-FINEXEC-13-UNBOUND_DRAFT_CHANGED';
      END IF;
      RETURN;
    END IF;
    IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(
      'hxuv1-financial-security-task:' || prepared.task_id::TEXT,0
    )) THEN RAISE EXCEPTION 'HXUV1-FINEXEC-13-TASK_LOCK_BUSY'; END IF;
    -- Task and draft UPDATE locks also serialize incident, compensation,
    -- routing and eligibility inserts through their canonical foreign keys.
    SELECT * INTO task_record FROM public.tasks WHERE id=prepared.task_id FOR UPDATE NOWAIT;
    SELECT * INTO scope_record FROM public.task_scope_versions
      WHERE id=prepared.scope_version_id FOR SHARE NOWAIT;
    SELECT * INTO eligibility FROM public.task_provider_eligibility_decisions
      WHERE id=prepared.eligibility_decision_id FOR SHARE NOWAIT;
    SELECT * INTO route_record FROM public.task_routing_decisions
      WHERE id=eligibility.routing_decision_id FOR SHARE NOWAIT;
    SELECT * INTO service_cell FROM public.universal_v1_service_cell_authorities
      WHERE id=route_record.service_cell_authority_id FOR UPDATE NOWAIT;
    IF eligibility.id IS NULL OR NOT pg_catalog.pg_try_advisory_xact_lock(
      pg_catalog.hashtextextended('eligibility:' || prepared.task_draft_id::TEXT || ':' ||
        eligibility.provider_user_id::TEXT || ':' ||
        COALESCE(eligibility.provider_organization_id::TEXT,'individual'),0)
    ) THEN RAISE EXCEPTION 'HXUV1-FINEXEC-13-ELIGIBILITY_AUTHORITY_UNAVAILABLE'; END IF;
    PERFORM 1 FROM public.users WHERE id=eligibility.provider_user_id FOR SHARE NOWAIT;
    PERFORM 1 FROM public.capability_profiles WHERE user_id=eligibility.provider_user_id
      ORDER BY user_id FOR SHARE NOWAIT;
    PERFORM 1 FROM public.business_organizations WHERE id=eligibility.provider_organization_id
      FOR SHARE NOWAIT;
    PERFORM 1 FROM public.business_memberships
      WHERE organization_id=eligibility.provider_organization_id
        AND user_id=eligibility.provider_user_id ORDER BY user_id,id FOR SHARE NOWAIT;
    PERFORM 1 FROM public.business_credentials WHERE id=eligibility.trade_credential_id
      FOR SHARE NOWAIT;
    PERFORM 1 FROM public.verified_trades WHERE user_id=eligibility.provider_user_id
      AND provider_organization_id IS NOT DISTINCT FROM eligibility.provider_organization_id
      AND business_credential_id IS NOT DISTINCT FROM eligibility.trade_credential_id
      ORDER BY user_id,trade FOR SHARE NOWAIT;

    IF prepared.operation_kind IN ('AUTHORIZE','SECURE') THEN
      -- The immutable unique task winner is the only accepted-estimate Phase A
      -- witness. A different live hold or a caller-generated key cannot replace it.
      SELECT * INTO commitment FROM public.task_work_order_command_requests
        WHERE task_id=prepared.task_id FOR SHARE NOWAIT;
      SELECT * INTO hold_record FROM public.task_reservations
        WHERE id=commitment.conditional_hold_id FOR SHARE NOWAIT;
      SELECT * INTO interest_record FROM public.task_applications
        WHERE id=eligibility.interest_application_id FOR SHARE NOWAIT;
      PERFORM 1 FROM public.task_estimate_acceptance_materializations
        WHERE task_id=prepared.task_id ORDER BY id FOR SHARE NOWAIT;
      PERFORM 1 FROM public.provider_estimate_submissions
        WHERE id=commitment.provider_estimate_submission_id FOR SHARE NOWAIT;
    END IF;
    domain_now := pg_catalog.clock_timestamp();
    IF task_record.id IS NULL OR scope_record.id IS NULL OR route_record.id IS NULL
       OR draft_record.task_id IS DISTINCT FROM task_record.id
       OR task_record.poster_id IS DISTINCT FROM prepared.recorded_by
       OR task_record.state IS DISTINCT FROM 'OPEN'
       OR task_record.universal_contract_version IS DISTINCT FROM 1
       OR task_record.automation_classification IS DISTINCT FROM 'CONTROLLED_TEST'
       OR task_record.universal_payment_posture IS DISTINCT FROM 'PAYMENT_CREATION_FROZEN'
       OR task_record.worker_id IS NOT NULL OR task_record.work_order_id IS NOT NULL
       OR prepared.work_order_id IS NOT NULL
       OR task_record.active_scope_version_id IS DISTINCT FROM scope_record.id
       OR scope_record.task_id IS DISTINCT FROM task_record.id
       OR scope_record.universal_contract_version IS DISTINCT FROM 1
       OR scope_record.version IS DISTINCT FROM prepared.scope_version
       OR scope_record.scope_hash IS DISTINCT FROM prepared.scope_hash
       OR task_record.scope_hash IS DISTINCT FROM scope_record.scope_hash
       OR draft_record.active_routing_decision_id IS DISTINCT FROM route_record.id
       OR route_record.task_draft_id IS DISTINCT FROM draft_record.id
       OR route_record.outcome IS DISTINCT FROM 'FULFILLMENT_CANDIDATE'
       OR route_record.category_snapshot IS DISTINCT FROM task_record.category
       OR route_record.service_cell_snapshot IS DISTINCT FROM task_record.region_code
       OR service_cell.id IS NULL
       OR service_cell.authority_environment IS DISTINCT FROM requested.release_environment
       OR service_cell.is_test IS NOT TRUE
       OR service_cell.authority_kind IS DISTINCT FROM 'SYNTHETIC_FIXTURE'
       OR service_cell.region_code IS DISTINCT FROM task_record.region_code
       OR service_cell.routing_availability IS DISTINCT FROM 'ACTIVE'
       OR service_cell.effective_from > domain_now
       OR service_cell.expires_at <= domain_now
       OR EXISTS (SELECT 1 FROM public.universal_v1_service_cell_authorities successor
          WHERE successor.supersedes_authority_id=service_cell.id)
       OR EXISTS (SELECT 1 FROM public.task_safety_incidents incident
          WHERE incident.task_id=task_record.id AND incident.status NOT IN ('resolved','closed'))
       OR EXISTS (SELECT 1 FROM public.universal_v1_work_order_compensation_commands compensation
          WHERE compensation.task_id=task_record.id) THEN
      RAISE EXCEPTION 'HXUV1-FINEXEC-13-TASK_AUTHORITY_REVOKED';
    END IF;
    IF eligibility.task_draft_id IS DISTINCT FROM draft_record.id
       OR eligibility.task_id IS DISTINCT FROM task_record.id
       OR eligibility.scope_version_id IS DISTINCT FROM scope_record.id
       OR eligibility.decision_version IS DISTINCT FROM prepared.eligibility_decision_version
       OR eligibility.valid_until IS DISTINCT FROM prepared.eligibility_valid_until
       OR eligibility.evaluated_at > domain_now OR eligibility.valid_until <= domain_now
       OR eligibility.profile_eligible IS NOT TRUE OR eligibility.identity_eligible IS NOT TRUE
       OR eligibility.category_eligible IS NOT TRUE OR eligibility.credential_eligible IS NOT TRUE
       OR eligibility.geography_eligible IS NOT TRUE OR eligibility.availability_eligible IS NOT TRUE
       OR eligibility.restriction_clear IS NOT TRUE OR eligibility.task_eligible IS NOT TRUE
       OR eligibility.processor_payment_eligible IS NOT FALSE
       OR eligibility.payout_funding_eligible IS NOT FALSE
       OR EXISTS (SELECT 1 FROM public.task_provider_eligibility_decisions newer
          WHERE newer.task_draft_id=eligibility.task_draft_id
            AND newer.provider_user_id=eligibility.provider_user_id
            AND newer.provider_organization_id IS NOT DISTINCT FROM eligibility.provider_organization_id
            AND newer.decision_version>eligibility.decision_version) THEN
      RAISE EXCEPTION 'HXUV1-FINEXEC-13-ELIGIBILITY_AUTHORITY_REVOKED';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.users provider WHERE provider.id=eligibility.provider_user_id
         AND provider.account_status='ACTIVE' AND provider.is_minor IS FALSE
         AND COALESCE(provider.is_banned,FALSE) IS FALSE
         AND NOT (provider.trust_hold IS TRUE
           AND (provider.trust_hold_until IS NULL OR provider.trust_hold_until>domain_now)))
       OR public.universal_v1_invited_provider_authority_is_current(
         eligibility.provider_user_id,eligibility.provider_organization_id,eligibility.provider_class,
         eligibility.trade_credential_id,task_record.category,task_record.region_code) IS NOT TRUE THEN
      RAISE EXCEPTION 'HXUV1-FINEXEC-13-PROVIDER_AUTHORITY_REVOKED';
    END IF;
    IF prepared.operation_kind IN ('AUTHORIZE','SECURE') THEN
      IF commitment.idempotency_key IS NULL
         OR commitment.canonical_command_request_sha256 IS NULL
         OR pg_catalog.btrim(commitment.canonical_command_request_sha256) !~ '^[a-f0-9]{64}$'
         OR commitment.canonical_command_request_sha256=pg_catalog.repeat('0',64)
         OR commitment.created_at>prepared.prepared_at
         OR commitment.actor_user_id IS DISTINCT FROM prepared.recorded_by
         OR commitment.task_draft_id IS DISTINCT FROM prepared.task_draft_id
         OR commitment.scope_version_id IS DISTINCT FROM prepared.scope_version_id
         OR commitment.routing_decision_id IS DISTINCT FROM route_record.id
         OR commitment.provider_user_id IS DISTINCT FROM eligibility.provider_user_id
         OR commitment.provider_organization_id IS DISTINCT FROM eligibility.provider_organization_id
         OR commitment.eligibility_decision_id IS DISTINCT FROM eligibility.id
         OR commitment.eligibility_version IS DISTINCT FROM eligibility.decision_version
         OR commitment.amount_cents IS DISTINCT FROM prepared.amount_cents
         OR commitment.currency IS DISTINCT FROM prepared.currency
         OR scope_record.customer_total_cents IS DISTINCT FROM prepared.amount_cents
         OR scope_record.currency IS DISTINCT FROM prepared.currency
         OR prepared.idempotency_key IS DISTINCT FROM (commitment.idempotency_key ||
           CASE prepared.operation_kind WHEN 'AUTHORIZE' THEN ':auth' ELSE ':secure' END)
         OR prepared.operation_id IS DISTINCT FROM public.universal_v1_work_order_operation_id_v1(
           commitment.idempotency_key,pg_catalog.lower(prepared.operation_kind))
         OR hold_record.id IS NULL OR hold_record.task_id IS DISTINCT FROM task_record.id
         OR hold_record.hustler_id IS DISTINCT FROM eligibility.provider_user_id
         OR hold_record.reserved_by IS DISTINCT FROM prepared.recorded_by
         OR hold_record.eligibility_decision_id IS DISTINCT FROM eligibility.id
         OR hold_record.interest_application_id IS DISTINCT FROM interest_record.id
         OR hold_record.universal_contract_version IS DISTINCT FROM 1
         OR hold_record.hold_kind IS DISTINCT FROM 'CONDITIONAL_HOLD'
         OR hold_record.status IS DISTINCT FROM 'ACTIVE'
         OR hold_record.reserved_at > domain_now OR hold_record.expires_at <= domain_now
         OR interest_record.id IS NULL OR interest_record.task_id IS DISTINCT FROM task_record.id
         OR interest_record.hustler_id IS DISTINCT FROM eligibility.provider_user_id
         OR interest_record.provider_organization_id IS DISTINCT FROM eligibility.provider_organization_id
         OR interest_record.interest_scope_version_id IS DISTINCT FROM scope_record.id
         OR interest_record.universal_contract_version IS DISTINCT FROM 1
         OR interest_record.authority IS DISTINCT FROM 'EXPRESS_INTEREST'
         OR interest_record.status IS DISTINCT FROM 'pending'
         OR NOT EXISTS (
           SELECT 1 FROM public.task_estimate_acceptance_materializations materialization
           JOIN public.provider_estimate_submissions estimate
             ON estimate.id=materialization.provider_estimate_submission_id
            AND estimate.routing_decision_id=materialization.prior_routing_decision_id
           WHERE materialization.task_id=task_record.id
             AND materialization.task_draft_id=draft_record.id
             AND materialization.scope_version_id=scope_record.id
             AND materialization.resulting_routing_decision_id=route_record.id
             AND estimate.id=commitment.provider_estimate_submission_id
             AND estimate.provider_user_id=eligibility.provider_user_id
             AND estimate.provider_organization_id IS NOT DISTINCT FROM eligibility.provider_organization_id
             AND estimate.scope_hash=scope_record.scope_hash
             AND estimate.customer_total_cents=scope_record.customer_total_cents
             AND estimate.currency=scope_record.currency
         ) THEN
        RAISE EXCEPTION 'HXUV1-FINEXEC-13-COMMITMENT_AUTHORITY_REVOKED';
      END IF;
    END IF;
    IF prepared.operation_kind='SECURE' AND public.universal_v1_financial_security_is_current_v1(
      public.universal_v1_effective_financial_security_expiry_v1(prepared.predecessor_event_id),
      pg_catalog.clock_timestamp()) IS NOT TRUE THEN
      RAISE EXCEPTION 'HXUV1-FINEXEC-13-PREDECESSOR_EXPIRED';
    END IF;
    RETURN;
  END IF;

  IF prepared.operation_kind = 'ADJUST' THEN
    -- Preserve the v6 exact witness predicates at the first-effect boundary.
    -- Domain writers take proposal/fulfillment before financial locks; this
    -- caller already owns financial locks and must never wait in reverse order.
    IF prepared.change_order_id IS NULL OR prepared.work_order_id IS NULL
       OR NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(
         'universal-v1-change-order-proposal:' || prepared.change_order_id::TEXT,0))
       OR NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(
         'fulfillment:' || prepared.work_order_id::TEXT,0)) THEN
      RAISE EXCEPTION 'HXUV1-FINEXEC-13-ADJUSTMENT_LOCK_BUSY';
    END IF;
    SELECT * INTO work_order FROM public.task_work_orders
      WHERE id=prepared.work_order_id FOR UPDATE NOWAIT;
    SELECT * INTO task_record FROM public.tasks
      WHERE id=prepared.task_id FOR UPDATE NOWAIT;
    SELECT * INTO draft_record FROM public.task_drafts
      WHERE id=prepared.task_draft_id FOR UPDATE NOWAIT;
    PERFORM 1 FROM public.task_scope_change_proposals
      WHERE id=prepared.change_order_id FOR UPDATE NOWAIT;
    SELECT * INTO eligibility FROM public.task_provider_eligibility_decisions
      WHERE id=prepared.eligibility_decision_id FOR SHARE NOWAIT;
    PERFORM 1 FROM public.task_scope_versions scope
      WHERE scope.id=prepared.scope_version_id OR scope.id IN (
        SELECT witness.base_scope_version_id
        FROM public.universal_v1_change_order_materialization_commands witness
        WHERE witness.proposal_id=prepared.change_order_id
      ) ORDER BY scope.id FOR SHARE NOWAIT;
    -- Approvals and Phase A are immutable. The proposal UPDATE lock also
    -- prevents a concurrent approval insert through its canonical foreign key.
    SELECT pg_catalog.array_agg(actor_id ORDER BY actor_id) INTO adjustment_actor_ids
      FROM (SELECT prepared.recorded_by AS actor_id
        UNION SELECT work_order.provider_user_id
        UNION SELECT approval.actor_id FROM public.task_scope_change_approvals approval
          WHERE approval.proposal_id=prepared.change_order_id) actors;
    PERFORM 1 FROM public.users WHERE id=ANY(adjustment_actor_ids)
      ORDER BY id FOR SHARE NOWAIT;
    PERFORM 1 FROM public.business_organizations
      WHERE id IN (task_record.business_organization_id,work_order.provider_organization_id)
      ORDER BY id FOR SHARE NOWAIT;
    PERFORM 1 FROM public.business_memberships
      WHERE organization_id IN (task_record.business_organization_id,work_order.provider_organization_id)
        AND user_id=ANY(adjustment_actor_ids)
      ORDER BY organization_id,user_id,id FOR SHARE NOWAIT;
    PERFORM 1 FROM public.capability_profiles WHERE user_id=work_order.provider_user_id
      ORDER BY user_id FOR SHARE NOWAIT;
    PERFORM 1 FROM public.business_credentials WHERE id=eligibility.trade_credential_id
      FOR SHARE NOWAIT;
    PERFORM 1 FROM public.verified_trades WHERE user_id=work_order.provider_user_id
      AND provider_organization_id IS NOT DISTINCT FROM work_order.provider_organization_id
      AND business_credential_id IS NOT DISTINCT FROM eligibility.trade_credential_id
      ORDER BY user_id,trade FOR SHARE NOWAIT;
    domain_now := pg_catalog.clock_timestamp();
    IF requested.provider_kind IS DISTINCT FROM 'FAKE'
       OR requested.operation_kind IS DISTINCT FROM prepared.operation_kind
       OR requested.operation_id IS DISTINCT FROM prepared.operation_id
       OR requested.idempotency_key IS DISTINCT FROM prepared.idempotency_key
       OR requested.provider_expected_version IS DISTINCT FROM prepared.provider_expected_version
       OR requested.request_sha256 IS DISTINCT FROM prepared.provider_request_sha256
       OR draft_record.id IS NULL OR draft_record.task_id IS DISTINCT FROM prepared.task_id
       OR draft_record.universal_contract_version IS DISTINCT FROM 1
       OR draft_record.ingress_origin IS DISTINCT FROM 'BACKEND_POSTGRESQL'
       OR draft_record.poster_user_id IS DISTINCT FROM task_record.poster_id
       OR work_order.id IS NULL OR task_record.id IS NULL THEN
      RAISE EXCEPTION 'HXUV1-FINEXEC-13-ADJUSTMENT_AUTHORITY_REVOKED';
    END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.universal_v1_change_order_materialization_commands command
    JOIN public.task_scope_change_proposals proposal ON proposal.id = command.proposal_id
    JOIN public.tasks task ON task.id = command.task_id
    JOIN public.task_work_orders adjustment_work_order ON adjustment_work_order.id = command.work_order_id
    JOIN public.task_provider_eligibility_decisions adjustment_eligibility
      ON adjustment_eligibility.id = command.eligibility_decision_id
    JOIN public.task_scope_versions base_scope
      ON base_scope.id = command.base_scope_version_id
    JOIN public.task_scope_versions replacement
      ON replacement.id = command.replacement_scope_version_id
    JOIN public.task_financial_security_events predecessor
      ON predecessor.id = command.predecessor_event_id
    JOIN public.task_work_order_execution_facts execution
      ON execution.work_order_id = adjustment_work_order.id
     AND execution.scope_version_id = base_scope.id
     AND execution.execution_version = command.expected_execution_version
    JOIN public.users actor ON actor.id = prepared.recorded_by
    JOIN public.users provider ON provider.id = adjustment_work_order.provider_user_id
    JOIN public.task_scope_change_approvals customer_approval
      ON customer_approval.proposal_id = proposal.id
     AND customer_approval.approver_role = 'CUSTOMER'
     AND customer_approval.decision = 'APPROVED'
    JOIN public.task_scope_change_approvals provider_approval
      ON provider_approval.proposal_id = proposal.id
     AND provider_approval.approver_role = 'PROVIDER'
     AND provider_approval.decision = 'APPROVED'
    JOIN public.users customer_approval_actor
      ON customer_approval_actor.id = customer_approval.actor_id
    JOIN public.users provider_approval_actor
      ON provider_approval_actor.id = provider_approval.actor_id
    LEFT JOIN public.business_organizations customer_organization
      ON customer_organization.id = task.business_organization_id
    LEFT JOIN public.business_organizations provider_organization
      ON provider_organization.id = adjustment_work_order.provider_organization_id
    WHERE command.proposal_id = prepared.change_order_id
      AND command.work_order_id = prepared.work_order_id
      AND adjustment_work_order.task_id = command.task_id
      AND adjustment_work_order.task_draft_id = command.task_draft_id
      AND adjustment_work_order.eligibility_decision_id = command.eligibility_decision_id
      AND adjustment_work_order.materialization_version = prepared.work_order_materialization_version
      AND adjustment_work_order.execution_contract_version = prepared.work_order_execution_contract_version
      AND adjustment_eligibility.provider_user_id = adjustment_work_order.provider_user_id
      AND adjustment_eligibility.provider_organization_id IS NOT DISTINCT FROM adjustment_work_order.provider_organization_id
      AND proposal.universal_contract_version = 1
      AND proposal.application_contract_version = 1
      AND proposal.proposed_customer_total_cents = command.customer_total_cents
      AND proposal.proposed_provider_payout_cents = command.provider_payout_cents
      AND proposal.proposal_version = prepared.change_order_version
      AND replacement.version = prepared.scope_version
      AND replacement.scope_hash = prepared.scope_hash
      AND NOT (provider.trust_hold IS TRUE
        AND (provider.trust_hold_until IS NULL OR provider.trust_hold_until > domain_now))
      AND COALESCE((SELECT MAX(amendment.amendment_version)
        FROM public.task_work_order_amendments amendment
        WHERE amendment.work_order_id = command.work_order_id),0) = command.expected_amendment_version
      AND NOT EXISTS (SELECT 1 FROM public.universal_v1_change_order_compensation_commands compensation
        WHERE compensation.proposal_id = command.proposal_id)
      AND NOT EXISTS (SELECT 1 FROM public.universal_v1_change_order_recovery_terminal_facts terminal
        WHERE terminal.proposal_id = command.proposal_id)
      AND command.idempotency_key || ':adjust' = prepared.idempotency_key
      AND command.adjustment_operation_id = prepared.operation_id
      AND command.actor_user_id = prepared.recorded_by
      AND command.task_draft_id = prepared.task_draft_id
      AND command.task_id = prepared.task_id
      AND command.eligibility_decision_id = prepared.eligibility_decision_id
      AND command.replacement_scope_version_id = prepared.scope_version_id
      AND command.predecessor_event_id = prepared.predecessor_event_id
      AND command.predecessor_operation_id = prepared.related_operation_id
      AND command.customer_total_cents = prepared.amount_cents
      AND command.currency = prepared.currency
      AND command.expected_financial_version + 1 = prepared.lifecycle_expected_version
      AND prepared.provider_kind = 'FAKE'
      AND prepared.provider_expected_version = 0
      AND proposal.status = 'APPROVED'
      AND proposal.change_order_kind = 'PRICE_AND_SCOPE'
      AND proposal.financial_adjustment_required IS TRUE
      AND proposal.proposal_version = command.expected_proposal_version
      AND proposal.base_version_id = command.base_scope_version_id
      AND proposal.approved_version_id = command.replacement_scope_version_id
      AND proposal.reviewed_by = command.actor_user_id
      AND task.work_order_id = adjustment_work_order.id
      AND task.active_scope_version_id = command.base_scope_version_id
      AND task.worker_id IS NULL
      AND task.universal_contract_version = 1
      AND task.automation_classification = 'CONTROLLED_TEST'
      AND task.universal_payment_posture = 'PAYMENT_CREATION_FROZEN'
      AND public.universal_v1_effective_work_order_scope_id(adjustment_work_order.id) =
        command.base_scope_version_id
      AND base_scope.version = command.expected_scope_version
      AND replacement.task_id = task.id
      AND replacement.version = command.expected_scope_version + 1
      AND replacement.supersedes_version_id = base_scope.id
      AND replacement.source = 'APPROVED_CHANGE'
      AND replacement.scope_hash = proposal.proposed_scope_sha256
      AND replacement.customer_total_cents = command.customer_total_cents
      AND replacement.hustler_payout_cents = command.provider_payout_cents
      AND replacement.currency = command.currency
      AND predecessor.task_draft_id = command.task_draft_id
      AND predecessor.task_id = command.task_id
      AND predecessor.eligibility_decision_id = command.eligibility_decision_id
      AND predecessor.scope_version_id = command.base_scope_version_id
      AND predecessor.operation_id = command.predecessor_operation_id::TEXT
      AND predecessor.expected_version = command.expected_financial_version
      AND predecessor.event_kind IN ('SECURED', 'ADJUSTMENT_AUTHORIZED')
      AND predecessor.status = 'SUCCEEDED'
      AND predecessor.provider_kind = 'FAKE'
      AND NOT EXISTS (
        SELECT 1 FROM public.task_financial_security_events newer_financial
        WHERE newer_financial.task_draft_id = command.task_draft_id
          AND newer_financial.expected_version > predecessor.expected_version
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.task_work_order_execution_facts newer_execution
        WHERE newer_execution.work_order_id = adjustment_work_order.id
          AND newer_execution.execution_version > execution.execution_version
      )
      AND execution.state IN ('MATERIALIZED','ACKNOWLEDGED','EN_ROUTE','ARRIVED','PAUSED')
      AND actor.account_status = 'ACTIVE'
      AND actor.is_minor IS FALSE
      AND COALESCE(actor.is_banned, FALSE) IS FALSE
      AND provider.account_status = 'ACTIVE'
      AND provider.is_minor IS FALSE
      AND COALESCE(provider.is_banned, FALSE) IS FALSE
      AND customer_approval_actor.account_status = 'ACTIVE'
      AND customer_approval_actor.is_minor IS FALSE
      AND COALESCE(customer_approval_actor.is_banned, FALSE) IS FALSE
      AND provider_approval_actor.account_status = 'ACTIVE'
      AND provider_approval_actor.is_minor IS FALSE
      AND COALESCE(provider_approval_actor.is_banned, FALSE) IS FALSE
      AND (
        (task.business_organization_id IS NULL AND task.poster_id = prepared.recorded_by)
        OR (
          task.business_organization_id IS NOT NULL
          AND customer_organization.status = 'ACTIVE'
          AND customer_organization.client_enabled IS TRUE
          AND public.business_membership_has_action(
            task.business_organization_id, prepared.recorded_by, 'APPROVE_SPEND'
          )
        )
      )
      AND (
        (task.business_organization_id IS NULL AND customer_approval.actor_id = task.poster_id)
        OR (
          task.business_organization_id IS NOT NULL
          AND customer_organization.status = 'ACTIVE'
          AND customer_organization.client_enabled IS TRUE
          AND public.business_membership_has_action(
            task.business_organization_id, customer_approval.actor_id, 'APPROVE_SPEND'
          )
        )
      )
      AND (
        provider_approval.actor_id = adjustment_work_order.provider_user_id
        OR (
          adjustment_work_order.provider_organization_id IS NOT NULL
          AND provider_organization.status = 'ACTIVE'
          AND provider_organization.provider_enabled IS TRUE
          AND public.business_membership_has_action(
            adjustment_work_order.provider_organization_id,
            provider_approval.actor_id,
            'APPROVE_SPEND'
          )
        )
      )
      AND customer_approval.actor_id <> provider_approval.actor_id
      AND public.universal_v1_invited_provider_authority_is_current(
        adjustment_eligibility.provider_user_id,
        adjustment_eligibility.provider_organization_id,
        adjustment_eligibility.provider_class,
        adjustment_eligibility.trade_credential_id,
        task.category,
        task.region_code
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.task_work_order_amendments amendment
        WHERE amendment.change_order_id = command.proposal_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.task_completion_facts completion
        WHERE completion.work_order_id = adjustment_work_order.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.task_reconciliation_facts reconciliation
        WHERE reconciliation.work_order_id = adjustment_work_order.id
      )

  ) THEN
      RAISE EXCEPTION 'HXUV1-FINEXEC-13-ADJUSTMENT_AUTHORITY_REVOKED';
    END IF;
    -- Post-Work-Order ADJUST retains current provider/approval authority;
    -- pre-Work-Order hold or eligibility TTLs are not new requirements here.
    IF public.universal_v1_financial_security_is_current_v1(
      public.universal_v1_effective_financial_security_expiry_v1(prepared.predecessor_event_id),
      pg_catalog.clock_timestamp()) IS NOT TRUE THEN
      RAISE EXCEPTION 'HXUV1-FINEXEC-13-PREDECESSOR_EXPIRED';
    END IF;
    RETURN;
  END IF;

  IF prepared.operation_kind='REVERSAL' THEN
    PERFORM hx_authority.assert_worker_change_order_reversal_execution_v13(prepared.prepared_command_id);
    RETURN;
  END IF;

  IF prepared.work_order_id IS NULL
     OR prepared.operation_kind NOT IN (
       'CAPTURE', 'REFUND', 'SETTLE', 'FUND',
       'PROVIDER_RELEASE', 'PAYOUT', 'OBSERVE_BANK_SETTLEMENT'
     ) THEN
    RETURN;
  END IF;

  SELECT * INTO task_record
    FROM public.tasks
   WHERE id = prepared.task_id
   FOR SHARE;
  SELECT * INTO work_order
    FROM public.task_work_orders
   WHERE id = prepared.work_order_id
   FOR SHARE;
  IF task_record.id IS NULL OR task_record.automation_classification IS DISTINCT FROM 'CONTROLLED_TEST' THEN
    RAISE EXCEPTION 'HXUV1-FINEXEC-13-CONTROLLED_TASK_REQUIRED';
  END IF;

  SELECT * INTO intent
    FROM public.universal_v1_fake_terminal_lifecycle_intents
   WHERE work_order_id = prepared.work_order_id
   FOR SHARE;
  SELECT * INTO eligibility
    FROM public.task_provider_eligibility_decisions
   WHERE id = prepared.eligibility_decision_id
   FOR SHARE;
  IF intent.terminal_intent_id IS NULL
     OR eligibility.id IS NULL
     OR work_order.id IS NULL
     OR requested.provider_kind <> 'FAKE'
     OR requested.operation_kind <> prepared.operation_kind
     OR requested.operation_id <> prepared.operation_id
     OR requested.idempotency_key <> prepared.idempotency_key
     OR requested.provider_expected_version <> prepared.provider_expected_version
     OR requested.request_sha256 <> prepared.provider_request_sha256
     OR requested.prepared_authority_sha256 <> prepared.authority_context_sha256
     OR requested.work_order_id <> intent.work_order_id
     OR requested.task_draft_id <> intent.task_draft_id
     OR requested.task_id <> intent.task_id
     OR prepared.eligibility_decision_id <> intent.eligibility_decision_id
     OR prepared.scope_version_id <> intent.scope_version_id
     OR prepared.recorded_by <> intent.requested_by
     OR work_order.task_id <> intent.task_id
     OR work_order.task_draft_id <> intent.task_draft_id
     OR work_order.eligibility_decision_id <> intent.eligibility_decision_id
     OR work_order.provider_user_id <> eligibility.provider_user_id
     OR work_order.provider_organization_id IS DISTINCT FROM
        eligibility.provider_organization_id
     OR p_request_sha256 <> requested.request_sha256 THEN
    RAISE EXCEPTION 'HXUV1-FTL-46: terminal dispatch does not retain the exact PREPARED, REQUESTED, and intent authority chain'
      USING ERRCODE = 'P0001';
  END IF;

  IF intent.terminal_path = 'SETTLED' THEN
    PERFORM pg_advisory_xact_lock(
      hashtext('universal-v1-fake-provider-account-v1'),
      hashtext(intent.provider_subject_kind || ':' || intent.provider_subject_id::TEXT)
    );
  END IF;

  -- This task lock orders the common final incident/current-eligibility check
  -- against task FK locks taken by concurrent incident or eligibility inserts,
  -- and prevents assignment/posture changes from racing either terminal path.
  SELECT * INTO task_record
    FROM public.tasks
   WHERE id = intent.task_id
   FOR UPDATE;
  IF task_record.id IS NULL
     OR task_record.universal_payment_posture <> 'PAYMENT_CREATION_FROZEN'
     OR task_record.worker_id IS NOT NULL
     OR task_record.work_order_id IS DISTINCT FROM intent.work_order_id
     OR eligibility.task_draft_id <> intent.task_draft_id
     OR eligibility.task_id IS DISTINCT FROM intent.task_id
     OR eligibility.scope_version_id IS DISTINCT FROM intent.scope_version_id
     OR eligibility.task_eligible IS NOT TRUE
     OR eligibility.processor_payment_eligible IS NOT FALSE
     OR eligibility.valid_until <= clock_timestamp()
     OR eligibility.evaluated_at > clock_timestamp()
     OR EXISTS (
       SELECT 1
         FROM public.task_provider_eligibility_decisions newer
        WHERE newer.task_draft_id = eligibility.task_draft_id
          AND newer.provider_user_id IS NOT DISTINCT FROM eligibility.provider_user_id
          AND newer.provider_organization_id IS NOT DISTINCT FROM
              eligibility.provider_organization_id
          AND newer.decision_version > eligibility.decision_version
     )
     OR EXISTS (
       SELECT 1
         FROM public.task_safety_incidents incident
        WHERE incident.task_id = intent.task_id
          AND incident.status NOT IN ('resolved', 'closed')
     ) THEN
    RAISE EXCEPTION 'HXUV1-FTL-47: terminal dispatch requires current frozen, unassigned, incident-free task and eligibility authority'
      USING ERRCODE = 'P0001';
  END IF;

  IF intent.terminal_path = 'SETTLED' THEN
    -- The eligibility helper takes the shared provider/org/membership/
    -- credential locks used by invitation authority, eliminating a
    -- check-then-revocation provider race for positive settlement steps.
    PERFORM public.lock_universal_v1_estimate_authority(
      eligibility.task_draft_id,
      eligibility.provider_user_id,
      eligibility.provider_organization_id,
      eligibility.trade_credential_id,
      eligibility.provider_user_id
    );
    SELECT * INTO account_fact
      FROM public.universal_v1_fake_provider_account_facts
     WHERE provider_account_fact_id = intent.provider_account_fact_id
     FOR SHARE;
    IF account_fact.provider_account_fact_id IS NULL
       OR account_fact.provider_subject_kind <> intent.provider_subject_kind
       OR COALESCE(account_fact.provider_user_id, account_fact.provider_organization_id)
          <> intent.provider_subject_id
       OR account_fact.account_state <> 'ENABLED'
       OR account_fact.charges_enabled IS NOT TRUE
       OR account_fact.payouts_enabled IS NOT TRUE
       OR eligibility.payout_funding_eligible IS NOT FALSE
       OR EXISTS (
         SELECT 1
           FROM public.universal_v1_fake_provider_account_facts newer
          WHERE newer.provider_subject_kind = account_fact.provider_subject_kind
            AND newer.provider_user_id IS NOT DISTINCT FROM account_fact.provider_user_id
            AND newer.provider_organization_id IS NOT DISTINCT FROM
                account_fact.provider_organization_id
            AND newer.account_version > account_fact.account_version
       )
       OR public.universal_v1_invited_provider_authority_is_current(
            eligibility.provider_user_id,
            eligibility.provider_organization_id,
            eligibility.provider_class,
            eligibility.trade_credential_id,
            task_record.category,
            task_record.region_code
          ) IS NOT TRUE THEN
      RAISE EXCEPTION 'HXUV1-FTL-47: SETTLED dispatch requires current provider, payout, and latest enabled account authority'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF prepared.operation_kind IN ('SECURE', 'ADJUST', 'CAPTURE') AND
     public.universal_v1_financial_security_is_current_v1(
       public.universal_v1_effective_financial_security_expiry_v1(prepared.predecessor_event_id),
       pg_catalog.clock_timestamp()
     ) IS NOT TRUE THEN
    RAISE EXCEPTION 'HXUV1-FINEXEC-13-PREDECESSOR_EXPIRED';
  END IF;
  IF eligibility.valid_until <= pg_catalog.clock_timestamp() THEN
    RAISE EXCEPTION 'HXUV1-FINEXEC-13-ELIGIBILITY_EXPIRED';
  END IF;
  RETURN;
END;
$$;

DO $worker_reversal_acl$ DECLARE r RECORD; grantee TEXT; BEGIN
  FOR r IN SELECT a.grantee FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
    WHERE c.oid='hx_authority.fake_financial_change_order_reversal_preparations_v13'::pg_catalog.regclass AND a.grantee<>c.relowner LOOP
    grantee:=CASE WHEN r.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(r.grantee)) END;
    EXECUTE 'REVOKE ALL ON TABLE hx_authority.fake_financial_change_order_reversal_preparations_v13 FROM '||grantee||' CASCADE';
  END LOOP;
  FOR r IN SELECT p.oid::pg_catalog.regprocedure::TEXT AS identity,a.grantee FROM pg_catalog.pg_proc p
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
    WHERE p.oid IN ('hx_authority.assert_worker_change_order_reversal_v13(uuid,uuid,uuid,text,boolean)'::pg_catalog.regprocedure,'public.hxos_prepare_change_order_compensation_reversal_v13(uuid,text,text,text,uuid,text)'::pg_catalog.regprocedure,'hx_authority.require_worker_change_order_reversal_preparation_v13()'::pg_catalog.regprocedure,'hx_authority.assert_worker_change_order_reversal_execution_v13(uuid)'::pg_catalog.regprocedure) AND a.grantee<>p.proowner LOOP
    grantee:=CASE WHEN r.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(r.grantee)) END;
    EXECUTE 'REVOKE ALL ON FUNCTION '||r.identity||' FROM '||grantee||' CASCADE';
  END LOOP;
END $worker_reversal_acl$;


-- Exact worker terminal commands retain the immutable recovery relation and its
-- v7 guard. Replay precedes lease expiry; creation serializes domain and finance.
CREATE OR REPLACE FUNCTION hx_authority.record_fake_financial_change_order_terminal_v13(
  p_target_authority_id UUID,p_target_database_name TEXT,
  p_release_environment TEXT,p_release_manifest_digest TEXT,
  p_proposal_id UUID,p_recovery_lease_id UUID,p_lease_owner_id UUID,
  p_witness_request_sha256 TEXT,p_work_order_id UUID,p_kind TEXT,
  p_amendment_id UUID,p_adjustment_event_id UUID,p_compensation_command_id UUID,
  p_compensation_event_id UUID,p_no_effect_outcome_fact_id UUID,p_revocation_reason TEXT
) RETURNS TABLE(terminal_fact JSONB,idempotency_replayed BOOLEAN,observed_at TIMESTAMPTZ,
  target_authority_id UUID,release_manifest_digest TEXT)
LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE SET search_path=pg_catalog AS $$
DECLARE
  witness public.universal_v1_change_order_materialization_commands%ROWTYPE;
  stored public.universal_v1_change_order_recovery_terminal_facts%ROWTYPE;
  claim public.universal_v1_change_order_compensation_commands%ROWTYPE;
  origin hx_authority.fake_financial_change_order_compensation_origins_v13%ROWTYPE;
  provenance hx_authority.fake_financial_change_order_reversal_preparations_v13%ROWTYPE;
  prepared public.universal_v1_prepared_financial_commands%ROWTYPE;
  journal public.financial_provider_command_journal%ROWTYPE;
  no_effect public.financial_provider_command_outcome_facts%ROWTYPE;
  lease_expires_at TIMESTAMPTZ; adjustment_id UUID; witness_sha TEXT; amendment_sha TEXT;
  financial RECORD; bridge RECORD; amendment RECORD; execution RECORD;
  predecessor_execution RECORD; predecessor_amendment RECORD; original_target RECORD;
  historical_target RECORD; request RECORD; admitted RECORD; effect RECORD; progress JSONB;
  context RECORD; context_before JSONB; actor_ids UUID[]; pass INTEGER; lock_name TEXT; reason TEXT;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'HXUV1-COTERMINAL-13-READ_COMMITTED_REQUIRED'; END IF;
  IF p_target_authority_id IS NULL OR p_proposal_id IS NULL OR p_recovery_lease_id IS NULL
    OR p_lease_owner_id IS NULL OR p_work_order_id IS NULL OR p_witness_request_sha256 IS NULL
    OR p_witness_request_sha256 !~ '^[0-9a-f]{64}$'
    OR p_kind IS NULL OR p_kind NOT IN('MATERIALIZED','COMPENSATED','NO_EFFECT')
    OR (p_kind='MATERIALIZED' AND (p_amendment_id IS NULL OR p_adjustment_event_id IS NULL
      OR p_compensation_command_id IS NOT NULL OR p_compensation_event_id IS NOT NULL
      OR p_no_effect_outcome_fact_id IS NOT NULL OR p_revocation_reason IS NOT NULL))
    OR (p_kind='COMPENSATED' AND (p_compensation_command_id IS NULL OR p_compensation_event_id IS NULL
      OR p_amendment_id IS NOT NULL OR p_adjustment_event_id IS NOT NULL
      OR p_no_effect_outcome_fact_id IS NOT NULL OR p_revocation_reason IS NOT NULL))
    OR (p_kind='NO_EFFECT' AND (p_amendment_id IS NOT NULL OR p_adjustment_event_id IS NOT NULL
      OR p_compensation_command_id IS NOT NULL OR p_compensation_event_id IS NOT NULL
      OR ((p_no_effect_outcome_fact_id IS NULL)=(p_revocation_reason IS NULL)))) THEN
    RAISE EXCEPTION 'HXUV1-COTERMINAL-13-INPUT_INVALID'; END IF;
  PERFORM hx_authority.assert_fake_financial_outbox_target_v13(
    p_target_authority_id,p_target_database_name,p_release_environment,p_release_manifest_digest);
  IF NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('universal-v1-change-order-proposal:'||p_proposal_id::TEXT,0)) THEN
    RAISE EXCEPTION 'HXUV1-COTERMINAL-13-LOCK_BUSY'; END IF;
  SELECT * INTO witness FROM public.universal_v1_change_order_materialization_commands c
    WHERE c.proposal_id=p_proposal_id FOR SHARE NOWAIT;
  IF witness.proposal_id IS NULL OR witness.work_order_id IS DISTINCT FROM p_work_order_id
    OR witness.request_sha256 IS DISTINCT FROM p_witness_request_sha256 THEN
    RAISE EXCEPTION 'HXUV1-COTERMINAL-13-WITNESS_MISMATCH'; END IF;
  witness_sha:=public.universal_v1_change_order_materialization_request_sha256(
    witness.proposal_id,witness.idempotency_key,witness.actor_user_id,witness.work_order_id,
    witness.task_id,witness.task_draft_id,witness.eligibility_decision_id,
    witness.base_scope_version_id,witness.replacement_scope_version_id,
    witness.expected_proposal_version,witness.expected_scope_version,witness.expected_amendment_version,
    witness.expected_execution_version,witness.expected_financial_version,witness.predecessor_event_id,
    witness.predecessor_operation_id,witness.adjustment_operation_id);
  IF witness_sha IS DISTINCT FROM p_witness_request_sha256 THEN
    RAISE EXCEPTION 'HXUV1-COTERMINAL-13-WITNESS_MISMATCH'; END IF;
  SELECT l.expires_at INTO lease_expires_at FROM public.universal_v1_change_order_recovery_leases l
    WHERE l.proposal_id=p_proposal_id AND l.recovery_lease_id=p_recovery_lease_id
      AND l.lease_owner_id=p_lease_owner_id FOR SHARE NOWAIT;
  IF lease_expires_at IS NULL THEN RAISE EXCEPTION 'HXUV1-COTERMINAL-13-LEASE_MISMATCH'; END IF;
  IF NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('fulfillment:'||p_work_order_id::TEXT,0)) THEN
    RAISE EXCEPTION 'HXUV1-COTERMINAL-13-LOCK_BUSY'; END IF;
  SELECT * INTO stored FROM public.universal_v1_change_order_recovery_terminal_facts t
    WHERE t.proposal_id=p_proposal_id;
  IF stored.terminal_fact_id IS NOT NULL THEN
    IF stored.terminal_fact_id IS DISTINCT FROM public.universal_v1_change_order_recovery_uuid_v1(witness.idempotency_key,'terminal-fact')
      OR stored.witness_request_sha256 IS DISTINCT FROM p_witness_request_sha256
      OR stored.recovery_lease_id IS DISTINCT FROM p_recovery_lease_id OR stored.lease_owner_id IS DISTINCT FROM p_lease_owner_id
      OR stored.recorded_by IS DISTINCT FROM witness.actor_user_id
      OR stored.prior_secured_state_restored IS DISTINCT FROM FALSE
      OR stored.capture_resume_authorized IS DISTINCT FROM FALSE
      OR stored.payment_creation_performed IS DISTINCT FROM FALSE OR stored.hard_assignment_created IS DISTINCT FROM FALSE
      OR stored.amendment_id IS DISTINCT FROM p_amendment_id
      OR stored.compensation_command_id IS DISTINCT FROM p_compensation_command_id
      OR stored.compensation_event_id IS DISTINCT FROM p_compensation_event_id
      OR stored.no_effect_outcome_fact_id IS DISTINCT FROM p_no_effect_outcome_fact_id
      OR stored.authority_revocation_reason IS DISTINCT FROM p_revocation_reason
      OR stored.outcome_state IS DISTINCT FROM (CASE WHEN p_kind='MATERIALIZED' THEN 'MATERIALIZED' ELSE 'CANCELLED' END)
      OR stored.recovery_state IS DISTINCT FROM (CASE WHEN p_kind='MATERIALIZED' THEN 'NOT_REQUIRED' ELSE 'RECOVERY_REQUIRED' END)
      OR stored.resolution_evidence_kind IS DISTINCT FROM (CASE p_kind WHEN 'MATERIALIZED' THEN 'AMENDMENT' WHEN 'COMPENSATED' THEN 'REVERSAL' ELSE 'NO_EFFECT' END)
      OR stored.hold_clearance_kind IS DISTINCT FROM (CASE WHEN p_kind='MATERIALIZED' THEN 'EXACT_AMENDMENT' ELSE 'BOUNDED_CANCELLATION_RECOVERY' END)
      OR stored.execution_resume_authorized IS DISTINCT FROM (p_kind='MATERIALIZED')
      OR (p_kind='MATERIALIZED' AND stored.adjustment_event_id IS DISTINCT FROM p_adjustment_event_id) THEN
      RAISE EXCEPTION 'HXUV1-COTERMINAL-13-IDEMPOTENCY_CONFLICT'; END IF;
    RETURN QUERY SELECT pg_catalog.to_jsonb(stored),TRUE,pg_catalog.clock_timestamp(),p_target_authority_id,p_release_manifest_digest;
    RETURN;
  END IF;
  IF lease_expires_at<=pg_catalog.clock_timestamp() THEN RAISE EXCEPTION 'HXUV1-COTERMINAL-13-LEASE_EXPIRED'; END IF;
  -- Lock the historical FK actor without reauthorizing that participant.
  PERFORM 1 FROM public.users WHERE id=witness.actor_user_id FOR KEY SHARE NOWAIT;
  -- The current REQUESTED writer takes these keys before target acquisition.
  -- Try-locking avoids inversion and excludes its uncommitted journal rows.
  FOR lock_name IN SELECT value FROM pg_catalog.unnest(ARRAY[
    'idempotency:'||witness.idempotency_key||':adjust',
    'operation-version:FAKE:ADJUST:'||witness.adjustment_operation_id::TEXT||':0'
  ]) locks(value) ORDER BY value COLLATE "C" LOOP
    IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtext('financial-provider-command-journal-v1'),pg_catalog.hashtext(lock_name)) THEN
      RAISE EXCEPTION 'HXUV1-COTERMINAL-13-LOCK_BUSY'; END IF;
  END LOOP;
  SELECT * INTO journal FROM public.financial_provider_command_journal c
    WHERE c.operation_kind='ADJUST' AND c.operation_id=witness.adjustment_operation_id AND c.provider_kind='FAKE'
      AND c.provider_expected_version=0 FOR SHARE NOWAIT;
  IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtext('fake-financial-operation'),pg_catalog.hashtext(witness.adjustment_operation_id::TEXT))
    OR (journal.command_id IS NOT NULL AND NOT pg_catalog.pg_try_advisory_xact_lock(
      pg_catalog.hashtext('financial-provider-command-recovery-v1'),pg_catalog.hashtext(journal.command_id::TEXT))) THEN
    RAISE EXCEPTION 'HXUV1-COTERMINAL-13-LOCK_BUSY'; END IF;
  IF p_kind='COMPENSATED' THEN
    SELECT * INTO claim FROM public.universal_v1_change_order_compensation_commands c
      WHERE c.compensation_command_id=p_compensation_command_id FOR SHARE NOWAIT;
    adjustment_id:=claim.adjustment_event_id;
  ELSE adjustment_id:=p_adjustment_event_id;
  END IF;
  IF p_kind IN('MATERIALIZED','COMPENSATED') THEN
    SELECT * INTO financial FROM public.task_financial_security_events f WHERE f.id=adjustment_id FOR SHARE NOWAIT;
    SELECT * INTO bridge FROM public.universal_v1_fake_financial_lifecycle_bridges b WHERE b.task_financial_security_event_id=adjustment_id;
    IF financial.id IS NULL OR bridge.bridge_id IS NULL OR bridge.command_id IS NULL
     OR financial.operation_id IS DISTINCT FROM witness.adjustment_operation_id::TEXT
     OR financial.idempotency_key IS DISTINCT FROM witness.idempotency_key||':adjust'
     OR financial.event_kind IS DISTINCT FROM 'ADJUSTMENT_AUTHORIZED' OR financial.status IS DISTINCT FROM 'SUCCEEDED'
     OR financial.provider_kind IS DISTINCT FROM 'FAKE' OR financial.recorded_by IS DISTINCT FROM witness.actor_user_id
     OR financial.task_draft_id IS DISTINCT FROM witness.task_draft_id OR financial.task_id IS DISTINCT FROM witness.task_id
     OR financial.eligibility_decision_id IS DISTINCT FROM witness.eligibility_decision_id
     OR financial.scope_version_id IS DISTINCT FROM witness.replacement_scope_version_id
     OR financial.change_order_id IS DISTINCT FROM witness.proposal_id
     OR financial.predecessor_event_id IS DISTINCT FROM witness.predecessor_event_id
     OR financial.expected_version::BIGINT IS DISTINCT FROM witness.expected_financial_version::BIGINT+1
     OR financial.amount_cents IS DISTINCT FROM witness.customer_total_cents OR financial.currency IS DISTINCT FROM witness.currency
     OR bridge.fake_operation_id IS DISTINCT FROM witness.adjustment_operation_id
     OR bridge.fake_operation_kind IS DISTINCT FROM 'ADJUST'
     OR bridge.lifecycle_event_kind IS DISTINCT FROM 'ADJUSTMENT_AUTHORIZED' OR bridge.lifecycle_status IS DISTINCT FROM 'SUCCEEDED' THEN
    RAISE EXCEPTION 'HXUV1-COTERMINAL-13-ADJUSTMENT_MISMATCH'; END IF;
  END IF;
  IF p_kind='MATERIALIZED' THEN
    SELECT a.id,a.work_order_id,a.amendment_version,a.supersedes_amendment_id,a.change_order_id,a.scope_version_id,
      a.adjustment_event_id,a.expected_financial_version,a.idempotency_key,a.request_sha256,a.materialized_by
      INTO amendment FROM public.task_work_order_amendments a WHERE a.id=p_amendment_id FOR SHARE NOWAIT;
    IF amendment.id IS NULL OR EXISTS(SELECT 1 FROM public.universal_v1_change_order_compensation_commands c WHERE c.proposal_id=p_proposal_id) THEN
      RAISE EXCEPTION 'HXUV1-COTERMINAL-13-AMENDMENT_MISMATCH'; END IF;
    SELECT e.id,e.work_order_id,e.task_id,e.scope_version_id,e.execution_version,e.supersedes_fact_id,e.state,
      e.transition_kind,e.completion_fact_id,e.work_order_amendment_id,e.actor_role,e.actor_user_id,e.reason,
      e.idempotency_key,e.request_sha256,e.client_occurred_at,e.policy_version
      INTO execution FROM public.task_work_order_execution_facts e
      WHERE e.work_order_amendment_id=amendment.id AND e.transition_kind='APPLY_AMENDMENT';
    SELECT e.id,e.work_order_id,e.task_id,e.scope_version_id,e.execution_version,e.state
      INTO predecessor_execution FROM public.task_work_order_execution_facts e WHERE e.id=execution.supersedes_fact_id;
    SELECT a.id,a.work_order_id,a.amendment_version,a.scope_version_id
      INTO predecessor_amendment FROM public.task_work_order_amendments a WHERE a.id=amendment.supersedes_amendment_id;
    amendment_sha:=public.universal_v1_change_amendment_request_sha256(
      witness.work_order_id,witness.expected_amendment_version+1,amendment.supersedes_amendment_id,
      witness.proposal_id,witness.replacement_scope_version_id,adjustment_id,witness.expected_financial_version,
      witness.actor_user_id,witness.idempotency_key);
    IF amendment.work_order_id IS DISTINCT FROM witness.work_order_id OR amendment.change_order_id IS DISTINCT FROM witness.proposal_id
       OR amendment.amendment_version::BIGINT IS DISTINCT FROM witness.expected_amendment_version::BIGINT+1
       OR amendment.scope_version_id IS DISTINCT FROM witness.replacement_scope_version_id
       OR amendment.adjustment_event_id IS DISTINCT FROM adjustment_id
       OR amendment.expected_financial_version IS DISTINCT FROM witness.expected_financial_version
       OR amendment.idempotency_key IS DISTINCT FROM witness.idempotency_key OR amendment.materialized_by IS DISTINCT FROM witness.actor_user_id
       OR amendment.request_sha256 IS DISTINCT FROM amendment_sha
       OR (witness.expected_amendment_version=0 AND amendment.supersedes_amendment_id IS NOT NULL)
       OR (witness.expected_amendment_version>0 AND (predecessor_amendment.id IS NULL
         OR predecessor_amendment.work_order_id IS DISTINCT FROM witness.work_order_id
         OR predecessor_amendment.amendment_version IS DISTINCT FROM witness.expected_amendment_version
         OR predecessor_amendment.scope_version_id IS DISTINCT FROM witness.base_scope_version_id))
       OR execution.id IS NULL OR execution.work_order_id IS DISTINCT FROM witness.work_order_id
       OR execution.task_id IS DISTINCT FROM witness.task_id OR execution.scope_version_id IS DISTINCT FROM witness.replacement_scope_version_id
       OR execution.execution_version::BIGINT IS DISTINCT FROM witness.expected_execution_version::BIGINT+1
       OR execution.actor_user_id IS DISTINCT FROM witness.actor_user_id OR execution.actor_role IS DISTINCT FROM 'CUSTOMER'
       OR execution.idempotency_key IS DISTINCT FROM witness.idempotency_key||':execution'
       OR execution.completion_fact_id IS NOT NULL OR execution.reason IS NOT NULL
       OR execution.policy_version IS DISTINCT FROM 'universal-v1-work-order-execution-1.0.0'
       OR predecessor_execution.id IS NULL OR predecessor_execution.work_order_id IS DISTINCT FROM witness.work_order_id
       OR predecessor_execution.task_id IS DISTINCT FROM witness.task_id
       OR predecessor_execution.scope_version_id IS DISTINCT FROM witness.base_scope_version_id
       OR predecessor_execution.execution_version IS DISTINCT FROM witness.expected_execution_version
       OR execution.state IS DISTINCT FROM predecessor_execution.state
       OR predecessor_execution.state NOT IN ('MATERIALIZED','ACKNOWLEDGED','EN_ROUTE','ARRIVED','PAUSED')
       OR execution.request_sha256 IS DISTINCT FROM public.universal_v1_execution_internal_request_sha256(
         witness.actor_user_id,witness.work_order_id,'APPLY_AMENDMENT',execution.state,witness.expected_execution_version,
         witness.replacement_scope_version_id,NULL,amendment.id,witness.idempotency_key||':execution',
         execution.client_occurred_at,NULL) THEN
      RAISE EXCEPTION 'HXUV1-COTERMINAL-13-AMENDMENT_MISMATCH';
    END IF;
  ELSIF p_kind='COMPENSATED' THEN
    SELECT * INTO origin FROM hx_authority.fake_financial_change_order_compensation_origins_v13 WHERE compensation_command_id=p_compensation_command_id;
    SELECT * INTO original_target FROM hx_authority.universal_v1_work_order_target_authority_facts t WHERE t.target_authority_id=origin.target_authority_id;
    SELECT * INTO prepared FROM public.universal_v1_prepared_financial_commands c
      WHERE c.operation_kind='REVERSAL' AND c.operation_id=claim.reversal_operation_id AND c.provider_kind='FAKE'
        AND c.provider_expected_version=0 FOR SHARE NOWAIT;
    SELECT * INTO provenance FROM hx_authority.fake_financial_change_order_reversal_preparations_v13 WHERE prepared_command_id=prepared.prepared_command_id;
    SELECT * INTO request FROM hx_authority.fake_financial_command_outbox_requests_v13 r WHERE r.prepared_command_id=prepared.prepared_command_id;
    SELECT * INTO historical_target FROM hx_authority.universal_v1_work_order_target_authority_facts t WHERE t.target_authority_id=request.target_authority_id;
    IF claim.compensation_command_id IS NULL OR origin.compensation_command_id IS NULL OR witness.proposal_id IS NULL
    OR claim.proposal_id IS DISTINCT FROM witness.proposal_id
    OR origin.proposal_id IS DISTINCT FROM claim.proposal_id OR origin.recovery_lease_id IS DISTINCT FROM claim.recovery_lease_id
    OR origin.lease_owner_id IS DISTINCT FROM claim.lease_owner_id OR origin.witness_request_sha256 IS DISTINCT FROM claim.witness_request_sha256
    OR origin.adjustment_event_id IS DISTINCT FROM claim.adjustment_event_id OR origin.revocation_reason IS DISTINCT FROM claim.authority_revocation_reason
    OR original_target.target_database_name IS DISTINCT FROM pg_catalog.current_database()
    OR original_target.environment IS DISTINCT FROM p_release_environment OR origin.release_environment IS DISTINCT FROM p_release_environment
    OR origin.release_manifest_digest IS DISTINCT FROM original_target.release_manifest_sha256
    OR NOT EXISTS(WITH RECURSIVE ancestry AS (
      SELECT t.target_authority_id,t.supersedes_target_authority_id FROM hx_authority.universal_v1_work_order_target_authority_facts t WHERE t.target_authority_id=p_target_authority_id
      UNION SELECT t.target_authority_id,t.supersedes_target_authority_id FROM hx_authority.universal_v1_work_order_target_authority_facts t JOIN ancestry a ON t.target_authority_id=a.supersedes_target_authority_id
    ) SELECT 1 FROM ancestry a WHERE a.target_authority_id=origin.target_authority_id)
    OR claim.compensation_command_id IS DISTINCT FROM public.universal_v1_change_order_recovery_uuid_v1(witness.idempotency_key,'compensation-command')
    OR claim.reversal_operation_id IS DISTINCT FROM public.universal_v1_change_order_recovery_uuid_v1(witness.idempotency_key,'compensating-reversal')
    OR claim.reversal_idempotency_key IS DISTINCT FROM witness.idempotency_key||':recovery:reversal'
    OR claim.witness_request_sha256 IS DISTINCT FROM pg_catalog.btrim(witness.request_sha256)
    OR claim.task_draft_id IS DISTINCT FROM witness.task_draft_id OR claim.task_id IS DISTINCT FROM witness.task_id
    OR claim.work_order_id IS DISTINCT FROM witness.work_order_id OR claim.eligibility_decision_id IS DISTINCT FROM witness.eligibility_decision_id
    OR claim.base_scope_version_id IS DISTINCT FROM witness.base_scope_version_id OR claim.adjustment_operation_id IS DISTINCT FROM witness.adjustment_operation_id
    OR claim.lifecycle_expected_version::BIGINT IS DISTINCT FROM witness.expected_financial_version::BIGINT+2
    OR claim.amount_cents IS DISTINCT FROM witness.customer_total_cents OR claim.currency IS DISTINCT FROM witness.currency
    OR claim.requested_by IS DISTINCT FROM witness.actor_user_id OR claim.reason_code IS DISTINCT FROM 'FINALIZATION_AUTHORITY_REVOKED'
    OR claim.semantic_limitation IS DISTINCT FROM 'PRIOR_SECURED_STATE_NOT_RESTORED' THEN
    RAISE EXCEPTION 'HXUV1-COTERMINAL-13-ORIGIN_IDENTITY_INVALID'; END IF;
    IF provenance.prepared_command_id IS NULL OR prepared.prepared_command_id IS NULL
      OR provenance.compensation_command_id IS DISTINCT FROM claim.compensation_command_id
      OR provenance.target_authority_id IS DISTINCT FROM request.target_authority_id OR provenance.release_manifest_sha256 IS DISTINCT FROM request.release_manifest_digest
      OR prepared.command_state IS DISTINCT FROM 'PREPARED' OR prepared.provider_kind IS DISTINCT FROM 'FAKE'
      OR prepared.operation_kind IS DISTINCT FROM 'REVERSAL' OR prepared.operation_id IS DISTINCT FROM claim.reversal_operation_id
      OR prepared.idempotency_key IS DISTINCT FROM claim.reversal_idempotency_key OR prepared.provider_expected_version IS DISTINCT FROM 0::BIGINT
      OR prepared.task_draft_id IS DISTINCT FROM claim.task_draft_id OR prepared.task_id IS DISTINCT FROM claim.task_id
      OR prepared.work_order_id IS DISTINCT FROM claim.work_order_id OR prepared.eligibility_decision_id IS DISTINCT FROM claim.eligibility_decision_id
      OR prepared.scope_version_id IS DISTINCT FROM claim.base_scope_version_id OR prepared.change_order_id IS NOT NULL OR prepared.completion_fact_id IS NOT NULL
      OR prepared.predecessor_event_id IS DISTINCT FROM claim.adjustment_event_id OR prepared.related_operation_id IS DISTINCT FROM claim.adjustment_operation_id
      OR prepared.lifecycle_expected_version IS DISTINCT FROM claim.lifecycle_expected_version
      OR prepared.amount_cents IS DISTINCT FROM claim.amount_cents OR prepared.currency IS DISTINCT FROM claim.currency
      OR prepared.recorded_by IS DISTINCT FROM claim.requested_by
      OR provenance.provider_request_sha256 IS DISTINCT FROM pg_catalog.btrim(prepared.provider_request_sha256)
      OR provenance.prepared_authority_sha256 IS DISTINCT FROM pg_catalog.btrim(prepared.authority_context_sha256) THEN
      RAISE EXCEPTION 'HXUV1-COTERMINAL-13-PREPARATION_IDENTITY_INVALID'; END IF;
    IF request.outbox_request_id IS NULL OR historical_target.target_database_name IS DISTINCT FROM p_target_database_name
      OR historical_target.environment IS DISTINCT FROM p_release_environment
      OR NOT EXISTS(WITH RECURSIVE ancestry AS (
        SELECT t.target_authority_id,t.supersedes_target_authority_id FROM hx_authority.universal_v1_work_order_target_authority_facts t WHERE t.target_authority_id=request.target_authority_id
        UNION SELECT t.target_authority_id,t.supersedes_target_authority_id FROM hx_authority.universal_v1_work_order_target_authority_facts t JOIN ancestry a ON t.target_authority_id=a.supersedes_target_authority_id
      ) SELECT 1 FROM ancestry a WHERE a.target_authority_id=origin.target_authority_id)
      OR EXISTS(SELECT 1 FROM public.task_work_order_amendments a WHERE a.change_order_id=p_proposal_id) THEN
      RAISE EXCEPTION 'HXUV1-COTERMINAL-13-COMPENSATION_MISMATCH'; END IF;
    PERFORM 1 FROM public.task_financial_security_events f WHERE f.id=p_compensation_event_id FOR SHARE NOWAIT;
  ELSE
    IF EXISTS(SELECT 1 FROM public.task_work_order_amendments a WHERE a.change_order_id=p_proposal_id)
      OR EXISTS(SELECT 1 FROM public.universal_v1_change_order_compensation_commands c WHERE c.proposal_id=p_proposal_id) THEN
      RAISE EXCEPTION 'HXUV1-COTERMINAL-13-NO_EFFECT_WINNER_CONFLICT'; END IF;
    IF p_no_effect_outcome_fact_id IS NOT NULL THEN
      SELECT * INTO no_effect FROM public.financial_provider_command_outcome_facts o
        WHERE o.outcome_fact_id=p_no_effect_outcome_fact_id FOR SHARE NOWAIT;
      SELECT * INTO prepared FROM public.universal_v1_prepared_financial_commands c
        WHERE c.prepared_command_id=journal.prepared_financial_command_id FOR SHARE NOWAIT;
      SELECT * INTO request FROM hx_authority.fake_financial_command_outbox_requests_v13 r WHERE r.command_id=journal.command_id;
      IF no_effect.outcome_fact_id IS NULL OR journal.command_id IS NULL OR prepared.prepared_command_id IS NULL
        OR no_effect.command_id IS DISTINCT FROM journal.command_id OR request.outbox_request_id IS NULL
        OR no_effect.effect_certainty IS DISTINCT FROM 'CONFIRMED_NO_EFFECT' OR no_effect.retryable IS DISTINCT FROM FALSE
        OR NOT(no_effect.outcome_kind='FAILED' OR (no_effect.outcome_kind='OUTCOME_OBSERVED' AND no_effect.provider_state IN('DECLINED','FAILED'))) THEN
        RAISE EXCEPTION 'HXUV1-COTERMINAL-13-ADMITTED_NO_EFFECT_REQUIRED'; END IF;
      IF request.target_database_name IS DISTINCT FROM p_target_database_name OR request.release_environment IS DISTINCT FROM p_release_environment
        OR NOT EXISTS(WITH RECURSIVE ancestry AS (
          SELECT t.target_authority_id,t.supersedes_target_authority_id FROM hx_authority.universal_v1_work_order_target_authority_facts t WHERE t.target_authority_id=p_target_authority_id
          UNION SELECT t.target_authority_id,t.supersedes_target_authority_id FROM hx_authority.universal_v1_work_order_target_authority_facts t JOIN ancestry a ON t.target_authority_id=a.supersedes_target_authority_id
        ) SELECT 1 FROM ancestry a WHERE a.target_authority_id=request.target_authority_id) THEN
        RAISE EXCEPTION 'HXUV1-COTERMINAL-13-HISTORICAL_TARGET_MISMATCH'; END IF;
      SELECT * INTO admitted FROM public.hxos_read_fake_financial_progress_v13(request.outbox_request_id,request.bullmq_job_id,request.job_authority_sha256);
      IF admitted.recorded_outcome#>>'{outcome_fact,outcome_fact_id}' IS DISTINCT FROM p_no_effect_outcome_fact_id::TEXT
        OR admitted.recovery_evidence->'admission_evidence' IS NULL
        OR admitted.recovery_evidence#>>'{request_evidence,command_id}' IS DISTINCT FROM journal.command_id::TEXT THEN
        RAISE EXCEPTION 'HXUV1-COTERMINAL-13-ADMITTED_NO_EFFECT_REQUIRED'; END IF;
    ELSE
      FOR pass IN 0..1 LOOP
        SELECT t.poster_id,t.business_organization_id AS customer_organization_id,
          w.provider_user_id,w.provider_organization_id,e.trade_credential_id,
          ca.actor_id AS customer_approval_actor_id,pa.actor_id AS provider_approval_actor_id INTO context
        FROM public.tasks t
        JOIN public.task_drafts d ON d.id=witness.task_draft_id AND d.task_id=t.id
        JOIN public.task_work_orders w ON w.id=witness.work_order_id AND w.task_id=t.id
          AND w.task_draft_id=d.id AND w.eligibility_decision_id=witness.eligibility_decision_id
        JOIN public.task_provider_eligibility_decisions e ON e.id=witness.eligibility_decision_id
        LEFT JOIN public.task_scope_change_approvals ca ON ca.proposal_id=p_proposal_id AND ca.approver_role='CUSTOMER'
        LEFT JOIN public.task_scope_change_approvals pa ON pa.proposal_id=p_proposal_id AND pa.approver_role='PROVIDER'
        WHERE t.id=witness.task_id AND t.work_order_id=w.id AND t.active_scope_version_id=witness.base_scope_version_id
          AND t.universal_contract_version=1 AND t.automation_classification='CONTROLLED_TEST'
          AND t.universal_payment_posture='PAYMENT_CREATION_FROZEN' AND t.worker_id IS NULL
          AND d.poster_user_id=t.poster_id AND d.claimed_at IS NOT NULL
          AND d.universal_contract_version=1 AND d.ingress_origin='BACKEND_POSTGRESQL';
        IF NOT FOUND THEN RAISE EXCEPTION 'HXUV1-COTERMINAL-13-CONTEXT_MISMATCH'; END IF;
        IF pass=1 THEN
          IF pg_catalog.to_jsonb(context) IS DISTINCT FROM context_before THEN
            RAISE EXCEPTION 'HXUV1-COTERMINAL-13-DEPENDENCY_CHANGED'; END IF;
          EXIT;
        END IF;
        context_before:=pg_catalog.to_jsonb(context);
        PERFORM 1 FROM public.task_work_orders WHERE id=witness.work_order_id FOR UPDATE NOWAIT;
        PERFORM 1 FROM public.tasks WHERE id=witness.task_id FOR UPDATE NOWAIT;
        PERFORM 1 FROM public.task_drafts WHERE id=witness.task_draft_id FOR SHARE NOWAIT;
        PERFORM 1 FROM public.task_scope_change_proposals WHERE id=p_proposal_id FOR UPDATE NOWAIT;
        PERFORM 1 FROM public.task_provider_eligibility_decisions WHERE id=witness.eligibility_decision_id FOR SHARE NOWAIT;
        PERFORM 1 FROM public.task_scope_versions WHERE id IN(witness.base_scope_version_id,witness.replacement_scope_version_id)
          ORDER BY id FOR SHARE NOWAIT;
        PERFORM 1 FROM public.task_scope_change_approvals WHERE proposal_id=p_proposal_id ORDER BY id FOR SHARE NOWAIT;
        SELECT pg_catalog.array_agg(id ORDER BY id) INTO actor_ids FROM (
          SELECT witness.actor_user_id AS id UNION SELECT context.poster_id UNION SELECT context.provider_user_id
          UNION SELECT context.customer_approval_actor_id UNION SELECT context.provider_approval_actor_id
        ) actors WHERE id IS NOT NULL;
        -- UPDATE blocks users FK KEY SHARE for newly inserted memberships.
        PERFORM 1 FROM public.users WHERE id=ANY(actor_ids) ORDER BY id FOR UPDATE NOWAIT;
        PERFORM 1 FROM public.business_organizations WHERE id IN(context.customer_organization_id,context.provider_organization_id)
          ORDER BY id FOR SHARE NOWAIT;
        PERFORM 1 FROM public.business_memberships
          WHERE organization_id IN(context.customer_organization_id,context.provider_organization_id) AND user_id=ANY(actor_ids)
          ORDER BY organization_id,user_id,id FOR SHARE NOWAIT;
        PERFORM 1 FROM public.capability_profiles WHERE user_id=context.provider_user_id ORDER BY user_id FOR SHARE NOWAIT;
        PERFORM 1 FROM public.business_credentials WHERE id=context.trade_credential_id FOR SHARE NOWAIT;
        PERFORM 1 FROM public.verified_trades WHERE user_id=context.provider_user_id
          AND provider_organization_id IS NOT DISTINCT FROM context.provider_organization_id
          AND business_credential_id IS NOT DISTINCT FROM context.trade_credential_id ORDER BY user_id,trade FOR SHARE NOWAIT;
      END LOOP;
      reason:=public.universal_v1_change_order_recovery_revocation_reason_v1(p_proposal_id);
      IF reason IS NULL OR reason IS DISTINCT FROM p_revocation_reason
        OR reason IN('AMENDMENT_CHAIN_CHANGED','FINANCIAL_CHAIN_CHANGED','WORK_ORDER_TERMINALIZED')
        OR EXISTS(SELECT 1 FROM public.financial_provider_command_dispatch_attempts a WHERE a.command_id=journal.command_id)
        OR EXISTS(SELECT 1 FROM public.task_financial_security_events f WHERE f.operation_id=witness.adjustment_operation_id::TEXT OR f.idempotency_key=witness.idempotency_key||':adjust')
        OR EXISTS(SELECT 1 FROM public.hxos_fake_financial_operations_v1 f WHERE f.operation_id=witness.adjustment_operation_id)
        OR EXISTS(SELECT 1 FROM public.hxos_fake_financial_operation_events_v1 f WHERE f.operation_id=witness.adjustment_operation_id OR f.idempotency_key=witness.idempotency_key||':adjust') THEN
        RAISE EXCEPTION 'HXUV1-COTERMINAL-13-NO_DISPATCH_REVOCATION_REQUIRED'; END IF;
    END IF;
  END IF;
  -- Public progress authenticates committed request/admission/outcome and exact
  -- bridge bytes. Historical execution targets must precede this current writer.
  FOR effect IN
    SELECT journal.command_id AS command_id,witness.adjustment_operation_id AS operation_id,
      'ADJUST'::TEXT AS operation_kind,adjustment_id AS event_id,'ADJUSTMENT_AUTHORIZED'::TEXT AS event_kind
      WHERE p_kind IN('MATERIALIZED','COMPENSATED')
    UNION ALL SELECT r.command_id,claim.reversal_operation_id,'REVERSAL',p_compensation_event_id,'REVERSED'
      FROM hx_authority.fake_financial_command_outbox_requests_v13 r
      WHERE p_kind='COMPENSATED' AND r.prepared_command_id=prepared.prepared_command_id
  LOOP
    IF effect.command_id IS NULL THEN RAISE EXCEPTION 'HXUV1-COTERMINAL-13-ADMITTED_EFFECT_REQUIRED'; END IF;
    IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtext('financial-provider-command-recovery-v1'),pg_catalog.hashtext(effect.command_id::TEXT))
      OR NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtext('fake-financial-operation'),pg_catalog.hashtext(effect.operation_id::TEXT)) THEN
      RAISE EXCEPTION 'HXUV1-COTERMINAL-13-LOCK_BUSY'; END IF;
    SELECT * INTO request FROM hx_authority.fake_financial_command_outbox_requests_v13 r WHERE r.command_id=effect.command_id;
    IF request.target_database_name IS DISTINCT FROM p_target_database_name OR request.release_environment IS DISTINCT FROM p_release_environment
      OR NOT EXISTS(WITH RECURSIVE ancestry AS (
        SELECT t.target_authority_id,t.supersedes_target_authority_id FROM hx_authority.universal_v1_work_order_target_authority_facts t WHERE t.target_authority_id=p_target_authority_id
        UNION SELECT t.target_authority_id,t.supersedes_target_authority_id FROM hx_authority.universal_v1_work_order_target_authority_facts t JOIN ancestry a ON t.target_authority_id=a.supersedes_target_authority_id
      ) SELECT 1 FROM ancestry a WHERE a.target_authority_id=request.target_authority_id) THEN
      RAISE EXCEPTION 'HXUV1-COTERMINAL-13-HISTORICAL_TARGET_MISMATCH'; END IF;
    progress:=hx_authority.read_fake_financial_public_progress_v13(effect.command_id);
    IF progress IS NULL OR progress->>'commandId' IS DISTINCT FROM effect.command_id::TEXT
      OR progress->>'operationId' IS DISTINCT FROM effect.operation_id::TEXT OR progress->>'operationKind' IS DISTINCT FROM effect.operation_kind
      OR progress->>'ownerActorId' IS DISTINCT FROM witness.actor_user_id::TEXT OR progress->>'environment' IS DISTINCT FROM p_release_environment
      OR progress->>'taskDraftId' IS DISTINCT FROM witness.task_draft_id::TEXT OR progress->>'taskId' IS DISTINCT FROM witness.task_id::TEXT
      OR progress->>'progressState' IS DISTINCT FROM 'MATERIALIZED'
      OR progress->'financialEvent' IS DISTINCT FROM pg_catalog.jsonb_build_object('id',effect.event_id,'eventKind',effect.event_kind,'status','SUCCEEDED') THEN
      RAISE EXCEPTION 'HXUV1-COTERMINAL-13-ADMITTED_EFFECT_REQUIRED'; END IF;
  END LOOP;
  INSERT INTO public.universal_v1_change_order_recovery_terminal_facts(
    proposal_id,witness_request_sha256,recovery_lease_id,lease_owner_id,outcome_state,recovery_state,
    amendment_id,adjustment_event_id,compensation_command_id,compensation_event_id,no_effect_outcome_fact_id,
    authority_revocation_reason,hold_clearance_kind,execution_resume_authorized,recorded_by
  ) VALUES(p_proposal_id,p_witness_request_sha256,p_recovery_lease_id,p_lease_owner_id,
    CASE WHEN p_kind='MATERIALIZED' THEN 'MATERIALIZED' ELSE 'CANCELLED' END,
    CASE WHEN p_kind='MATERIALIZED' THEN 'NOT_REQUIRED' ELSE 'RECOVERY_REQUIRED' END,
    p_amendment_id,adjustment_id,p_compensation_command_id,p_compensation_event_id,p_no_effect_outcome_fact_id,
    p_revocation_reason,CASE WHEN p_kind='MATERIALIZED' THEN 'EXACT_AMENDMENT' ELSE 'BOUNDED_CANCELLATION_RECOVERY' END,
    p_kind='MATERIALIZED',witness.actor_user_id) RETURNING * INTO stored;
  IF lease_expires_at<=pg_catalog.clock_timestamp() THEN RAISE EXCEPTION 'HXUV1-COTERMINAL-13-LEASE_EXPIRED'; END IF;
  RETURN QUERY SELECT pg_catalog.to_jsonb(stored),FALSE,pg_catalog.clock_timestamp(),p_target_authority_id,p_release_manifest_digest;
EXCEPTION WHEN lock_not_available THEN
  RAISE EXCEPTION 'HXUV1-COTERMINAL-13-LOCK_BUSY';
END;
$$;

CREATE OR REPLACE FUNCTION public.hxos_record_fake_financial_change_order_materialized_v13(
  p_target_authority_id UUID,p_target_database_name TEXT,p_release_environment TEXT,p_release_manifest_digest TEXT,
  p_proposal_id UUID,p_recovery_lease_id UUID,p_lease_owner_id UUID,p_witness_request_sha256 TEXT,p_work_order_id UUID,
  p_amendment_id UUID,p_adjustment_event_id UUID
) RETURNS TABLE(terminal_fact JSONB,idempotency_replayed BOOLEAN,observed_at TIMESTAMPTZ,
  target_authority_id UUID,release_manifest_digest TEXT)
LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE SET search_path=pg_catalog AS $$
BEGIN
  RETURN QUERY SELECT * FROM hx_authority.record_fake_financial_change_order_terminal_v13(
    p_target_authority_id,p_target_database_name,p_release_environment,p_release_manifest_digest,
    p_proposal_id,p_recovery_lease_id,p_lease_owner_id,p_witness_request_sha256,p_work_order_id,'MATERIALIZED',
    p_amendment_id,p_adjustment_event_id,NULL,NULL,NULL,NULL);
END;
$$;

CREATE OR REPLACE FUNCTION public.hxos_record_fake_financial_change_order_compensated_v13(
  p_target_authority_id UUID,p_target_database_name TEXT,p_release_environment TEXT,p_release_manifest_digest TEXT,
  p_proposal_id UUID,p_recovery_lease_id UUID,p_lease_owner_id UUID,p_witness_request_sha256 TEXT,p_work_order_id UUID,
  p_compensation_command_id UUID,p_compensation_event_id UUID
) RETURNS TABLE(terminal_fact JSONB,idempotency_replayed BOOLEAN,observed_at TIMESTAMPTZ,
  target_authority_id UUID,release_manifest_digest TEXT)
LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE SET search_path=pg_catalog AS $$
BEGIN
  RETURN QUERY SELECT * FROM hx_authority.record_fake_financial_change_order_terminal_v13(
    p_target_authority_id,p_target_database_name,p_release_environment,p_release_manifest_digest,
    p_proposal_id,p_recovery_lease_id,p_lease_owner_id,p_witness_request_sha256,p_work_order_id,'COMPENSATED',
    NULL,NULL,p_compensation_command_id,p_compensation_event_id,NULL,NULL);
END;
$$;

CREATE OR REPLACE FUNCTION public.hxos_record_fake_financial_change_order_no_effect_v13(
  p_target_authority_id UUID,p_target_database_name TEXT,p_release_environment TEXT,p_release_manifest_digest TEXT,
  p_proposal_id UUID,p_recovery_lease_id UUID,p_lease_owner_id UUID,p_witness_request_sha256 TEXT,p_work_order_id UUID,
  p_no_effect_outcome_fact_id UUID,p_revocation_reason TEXT
) RETURNS TABLE(terminal_fact JSONB,idempotency_replayed BOOLEAN,observed_at TIMESTAMPTZ,
  target_authority_id UUID,release_manifest_digest TEXT)
LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE SET search_path=pg_catalog AS $$
BEGIN
  RETURN QUERY SELECT * FROM hx_authority.record_fake_financial_change_order_terminal_v13(
    p_target_authority_id,p_target_database_name,p_release_environment,p_release_manifest_digest,
    p_proposal_id,p_recovery_lease_id,p_lease_owner_id,p_witness_request_sha256,p_work_order_id,'NO_EFFECT',
    NULL,NULL,NULL,NULL,p_no_effect_outcome_fact_id,p_revocation_reason);
END;
$$;

CREATE OR REPLACE FUNCTION hx_authority.validate_fake_financial_outbox_request_v13()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
DECLARE
  command_record RECORD;
  prepared_record RECORD;
  target_record RECORD;
  expected_job_authority_sha256 CHAR(64);
  expected_bullmq_job_id TEXT;
BEGIN
  SELECT command.command_state,
         command.operation_kind,
         command.operation_id,
         command.provider_kind,
         command.idempotency_key,
         command.provider_expected_version,
         command.request_sha256,
         command.command_identity_sha256,
         command.prepared_financial_command_id,
         command.prepared_authority_sha256,
         command.release_manifest_digest,
         command.release_id,
         command.release_revision,
         command.release_environment,
         command.release_authentication_status
    INTO command_record
    FROM public.financial_provider_command_journal command
   WHERE command.command_id = NEW.command_id
   FOR SHARE;

  SELECT prepared.command_state,
         prepared.operation_kind,
         prepared.operation_id,
         prepared.provider_kind,
         prepared.idempotency_key,
         prepared.provider_expected_version,
         prepared.provider_request_sha256,
         prepared.authority_context_sha256
    INTO prepared_record
    FROM public.universal_v1_prepared_financial_commands prepared
   WHERE prepared.prepared_command_id = NEW.prepared_command_id
   FOR SHARE;

  SELECT target.authority_version,
         target.target_database_name,
         target.environment,
         target.release_manifest_sha256
    INTO target_record
    FROM hx_authority.universal_v1_work_order_target_authority_facts target
   WHERE target.target_authority_id = NEW.target_authority_id
   FOR SHARE;

  PERFORM hx_authority.assert_fake_financial_outbox_target_v13(
    NEW.target_authority_id,
    NEW.target_database_name,
    NEW.release_environment,
    NEW.release_manifest_digest
  );

  -- ADJUST creation must observe a terminal committed while target acquisition
  -- was waiting. Exact existing REQUESTED replay does not enter this trigger.
  IF prepared_record.operation_kind='ADJUST' THEN
    IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN
      RAISE EXCEPTION 'HXUV1-COTERMINAL-13-ADJUST_REQUEST_READ_COMMITTED_REQUIRED'; END IF;
    IF EXISTS(SELECT 1 FROM public.universal_v1_prepared_financial_commands p
      JOIN public.universal_v1_change_order_materialization_commands w ON w.work_order_id=p.work_order_id
      JOIN public.universal_v1_change_order_recovery_terminal_facts t ON t.proposal_id=w.proposal_id
      WHERE p.prepared_command_id=NEW.prepared_command_id AND w.work_order_id=p.work_order_id
        AND t.outcome_state='CANCELLED') THEN
      RAISE EXCEPTION 'HXUV1-COTERMINAL-13-ADJUST_REQUEST_CANCELLED'; END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM hx_authority.fake_financial_preparation_authority_v13 provenance
    JOIN public.universal_v1_prepared_financial_commands prepared
      ON prepared.prepared_command_id = provenance.prepared_command_id
    JOIN public.financial_provider_command_journal command
      ON command.command_id = NEW.command_id
    WHERE provenance.prepared_command_id = NEW.prepared_command_id
      AND provenance.actor_user_id = prepared.recorded_by
      AND provenance.actor_user_id = command.recorded_actor_id
      AND command.recorded_actor_kind = 'PARTICIPANT'
      AND provenance.target_authority_id = NEW.target_authority_id
      AND provenance.release_manifest_sha256 = NEW.release_manifest_digest
      AND NOT EXISTS(SELECT 1 FROM public.universal_v1_change_order_compensation_commands c
        JOIN hx_authority.fake_financial_change_order_compensation_origins_v13 o USING(compensation_command_id)
        WHERE c.reversal_operation_id=prepared.operation_id AND prepared.operation_kind='REVERSAL')
  ) AND NOT EXISTS (
    SELECT 1 FROM hx_authority.fake_financial_change_order_reversal_preparations_v13 provenance
    JOIN public.universal_v1_prepared_financial_commands prepared ON prepared.prepared_command_id=provenance.prepared_command_id
    JOIN public.financial_provider_command_journal command ON command.command_id=NEW.command_id
    JOIN public.universal_v1_change_order_compensation_commands compensation ON compensation.compensation_command_id=provenance.compensation_command_id
    WHERE provenance.prepared_command_id=NEW.prepared_command_id AND provenance.service_database_role=SESSION_USER
      AND provenance.target_authority_id=NEW.target_authority_id AND provenance.release_manifest_sha256=NEW.release_manifest_digest
      AND provenance.provider_request_sha256=command.request_sha256 AND provenance.prepared_authority_sha256=command.prepared_authority_sha256
      AND prepared.recorded_by=compensation.requested_by AND command.recorded_actor_id=compensation.requested_by
      AND command.recorded_actor_kind='PARTICIPANT' AND prepared.operation_kind='REVERSAL'
      AND prepared.operation_id=compensation.reversal_operation_id
  ) THEN RAISE EXCEPTION 'HXUV1-FINREQ-13-AUTHENTICATED_PREPARATION_REQUIRED'; END IF;

  IF command_record.command_state IS DISTINCT FROM 'REQUESTED'
     OR command_record.provider_kind IS DISTINCT FROM 'FAKE'
     OR command_record.release_authentication_status IS DISTINCT FROM 'VERIFIED'
     OR command_record.release_environment NOT IN ('local', 'preview', 'staging')
     OR prepared_record.command_state IS DISTINCT FROM 'PREPARED'
     OR prepared_record.provider_kind IS DISTINCT FROM 'FAKE'
     OR command_record.prepared_financial_command_id IS DISTINCT FROM
          NEW.prepared_command_id
     OR command_record.prepared_authority_sha256 IS DISTINCT FROM
          prepared_record.authority_context_sha256
     OR command_record.request_sha256 IS DISTINCT FROM
          prepared_record.provider_request_sha256
     OR command_record.operation_kind IS DISTINCT FROM prepared_record.operation_kind
     OR command_record.operation_id IS DISTINCT FROM prepared_record.operation_id
     OR command_record.idempotency_key IS DISTINCT FROM prepared_record.idempotency_key
     OR command_record.provider_expected_version IS DISTINCT FROM
          prepared_record.provider_expected_version
     OR NEW.prepared_state IS DISTINCT FROM prepared_record.command_state
     OR NEW.command_state IS DISTINCT FROM command_record.command_state
     OR NEW.provider_kind IS DISTINCT FROM command_record.provider_kind
     OR NEW.operation_kind IS DISTINCT FROM command_record.operation_kind
     OR NEW.operation_id IS DISTINCT FROM command_record.operation_id
     OR NEW.idempotency_key IS DISTINCT FROM command_record.idempotency_key
     OR NEW.provider_expected_version IS DISTINCT FROM
          command_record.provider_expected_version
     OR NEW.provider_request_sha256 IS DISTINCT FROM command_record.request_sha256
     OR NEW.command_identity_sha256 IS DISTINCT FROM
          command_record.command_identity_sha256
     OR NEW.prepared_authority_sha256 IS DISTINCT FROM
          prepared_record.authority_context_sha256
     OR NEW.release_manifest_digest IS DISTINCT FROM
          command_record.release_manifest_digest
     OR NEW.release_id IS DISTINCT FROM command_record.release_id
     OR NEW.release_revision IS DISTINCT FROM command_record.release_revision
     OR NEW.release_environment IS DISTINCT FROM command_record.release_environment
     OR NEW.target_authority_version IS DISTINCT FROM target_record.authority_version
     OR NEW.target_database_name IS DISTINCT FROM target_record.target_database_name
     OR NEW.release_environment IS DISTINCT FROM target_record.environment
     OR NEW.release_manifest_digest IS DISTINCT FROM
          target_record.release_manifest_sha256 THEN
    RAISE EXCEPTION
      'HXUV1-FINOUT-13-8: outbox request lacks exact PREPARED/REQUESTED/target authority'
      USING ERRCODE = 'P0001';
  END IF;

  expected_job_authority_sha256 := hx_authority.fake_financial_job_digest_v13(
    ARRAY[
      'HXUV1_FAKE_FINANCIAL_BULLMQ_JOB_V13',
      NEW.outbox_request_id::TEXT,
      NEW.command_id::TEXT,
      NEW.prepared_command_id::TEXT,
      NEW.target_authority_id::TEXT,
      NEW.target_authority_version::TEXT,
      NEW.target_database_name,
      NEW.release_environment,
      NEW.release_manifest_digest,
      NEW.release_id,
      pg_catalog.btrim(NEW.release_revision),
      NEW.operation_kind,
      NEW.operation_id::TEXT,
      NEW.idempotency_key,
      NEW.provider_expected_version::TEXT,
      pg_catalog.btrim(NEW.provider_request_sha256),
      pg_catalog.btrim(NEW.command_identity_sha256),
      pg_catalog.btrim(NEW.prepared_authority_sha256),
      NEW.queue_name,
      NEW.job_name,
      NEW.payload_contract_version::TEXT
    ]::TEXT[]
  );
  expected_bullmq_job_id := 'hx-fake-fin-'
    || pg_catalog.replace(NEW.command_id::TEXT, '-', '')
    || '-' || pg_catalog.btrim(expected_job_authority_sha256);
  IF NEW.job_authority_sha256 IS DISTINCT FROM expected_job_authority_sha256
     OR NEW.bullmq_job_id IS DISTINCT FROM expected_bullmq_job_id THEN
    RAISE EXCEPTION
      'HXUV1-FINOUT-13-9: deterministic BullMQ job identity mismatch'
      USING ERRCODE = 'P0001';
  END IF;

  NEW.requested_at := pg_catalog.clock_timestamp();
  RETURN NEW;
END;
$$;

DO $change_order_terminal_acl$
DECLARE signature TEXT; entry RECORD;
BEGIN
  FOREACH signature IN ARRAY ARRAY['hx_authority.record_fake_financial_change_order_terminal_v13(uuid,text,text,text,uuid,uuid,uuid,text,uuid,text,uuid,uuid,uuid,uuid,uuid,text)',
    'public.hxos_record_fake_financial_change_order_materialized_v13(uuid,text,text,text,uuid,uuid,uuid,text,uuid,uuid,uuid)',
    'public.hxos_record_fake_financial_change_order_compensated_v13(uuid,text,text,text,uuid,uuid,uuid,text,uuid,uuid,uuid)',
    'public.hxos_record_fake_financial_change_order_no_effect_v13(uuid,text,text,text,uuid,uuid,uuid,text,uuid,uuid,text)'] LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',signature);
    FOR entry IN SELECT DISTINCT acl.grantee FROM pg_catalog.pg_proc p
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) acl
      WHERE p.oid=signature::regprocedure AND acl.grantee<>0 AND acl.grantee<>p.proowner LOOP
      EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM %I',signature,pg_catalog.pg_get_userbyid(entry.grantee));
    END LOOP;
  END LOOP;
END;
$change_order_terminal_acl$;

-- Worker amendment materialization retains Phase A and participant attribution.
-- Service origin is immutable and separate from the historical human actor.
CREATE TABLE hx_authority.fake_financial_change_order_materialization_origins_v13 (
  amendment_id UUID PRIMARY KEY REFERENCES public.task_work_order_amendments(id),
  execution_fact_id UUID NOT NULL UNIQUE REFERENCES public.task_work_order_execution_facts(id),
  proposal_id UUID NOT NULL UNIQUE REFERENCES public.universal_v1_change_order_materialization_commands(proposal_id),
  recovery_lease_id UUID NOT NULL REFERENCES public.universal_v1_change_order_recovery_leases(recovery_lease_id),
  lease_owner_id UUID NOT NULL,
  target_authority_id UUID NOT NULL REFERENCES hx_authority.universal_v1_work_order_target_authority_facts(target_authority_id),
  release_environment TEXT NOT NULL CHECK(release_environment IN ('local','preview','staging')),
  release_manifest_digest TEXT NOT NULL CHECK(release_manifest_digest ~ '^sha256:[a-f0-9]{64}$'),
  service_database_role TEXT NOT NULL CHECK(service_database_role<>''),
  witness_request_sha256 TEXT NOT NULL CHECK(witness_request_sha256 ~ '^[a-f0-9]{64}$'),
  adjustment_event_id UUID NOT NULL REFERENCES public.task_financial_security_events(id),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
CREATE TRIGGER change_order_materialization_origin_append_only_v13
BEFORE UPDATE OR DELETE ON hx_authority.fake_financial_change_order_materialization_origins_v13
FOR EACH ROW EXECUTE FUNCTION hx_authority.reject_universal_v1_work_order_authority_mutation_v1();
CREATE TRIGGER change_order_materialization_origin_no_truncate_v13
BEFORE TRUNCATE ON hx_authority.fake_financial_change_order_materialization_origins_v13
FOR EACH STATEMENT EXECUTE FUNCTION hx_authority.reject_universal_v1_work_order_authority_mutation_v1();
REVOKE ALL ON TABLE hx_authority.fake_financial_change_order_materialization_origins_v13 FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.hxos_finalize_worker_change_order_v13(
  p_target_authority_id UUID,p_target_database_name TEXT,
  p_release_environment TEXT,p_release_manifest_digest TEXT,
  p_proposal_id UUID,p_recovery_lease_id UUID,p_lease_owner_id UUID,
  p_witness_request_sha256 TEXT,p_work_order_id UUID,p_adjustment_event_id UUID
) RETURNS TABLE(result JSONB,worker_origin JSONB,actor_user_id UUID,observed_at TIMESTAMPTZ,
  target_authority_id UUID,release_manifest_digest TEXT)
LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE SET search_path=pg_catalog AS $$
DECLARE
  context RECORD; amendment RECORD; execution RECORD; predecessor_amendment RECORD; predecessor_execution RECORD;
  bridge RECORD; journal RECORD; outcome RECORD; current_execution RECORD;
  witness public.universal_v1_change_order_materialization_commands%ROWTYPE;
  proposal public.task_scope_change_proposals%ROWTYPE;
  replacement public.task_scope_versions%ROWTYPE; base_scope public.task_scope_versions%ROWTYPE;
  financial public.task_financial_security_events%ROWTYPE;
  origin hx_authority.fake_financial_change_order_materialization_origins_v13%ROWTYPE;
  historical_request RECORD; historical_target RECORD; original_target RECORD; original_lease RECORD;
  pass INTEGER; actor_ids UUID[]; context_before JSONB; financial_progress JSONB;
  witness_sha CHAR(64); amendment_sha CHAR(64); execution_sha CHAR(64); execution_key TEXT;
  adjustment_id UUID; amendment_id_value UUID; region_policy_id_value UUID;
  finalization_at TIMESTAMPTZ; lease_expires_at TIMESTAMPTZ; next_amendment_version INTEGER; next_execution_version INTEGER;
  changed_count BIGINT; replay BOOLEAN:=FALSE; authority_current BOOLEAN;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'HXUV1-COWORKERMATERIALIZE-13-READ_COMMITTED_REQUIRED'; END IF;
  IF p_target_authority_id IS NULL OR p_proposal_id IS NULL OR p_recovery_lease_id IS NULL
    OR p_lease_owner_id IS NULL OR p_work_order_id IS NULL OR p_adjustment_event_id IS NULL
    OR p_witness_request_sha256 IS NULL OR p_witness_request_sha256 !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'HXUV1-COWORKERMATERIALIZE-13-INPUT_INVALID'; END IF;
  PERFORM hx_authority.assert_fake_financial_outbox_target_v13(
    p_target_authority_id,p_target_database_name,p_release_environment,p_release_manifest_digest);
  IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(
      'universal-v1-change-order-proposal:'||p_proposal_id::TEXT,0)) THEN
    RAISE EXCEPTION 'HXUV1-COWORKERMATERIALIZE-13-LOCK_BUSY'; END IF;
  SELECT * INTO witness FROM public.universal_v1_change_order_materialization_commands c
    WHERE c.proposal_id=p_proposal_id FOR SHARE NOWAIT;
  IF witness.proposal_id IS NULL OR witness.work_order_id IS DISTINCT FROM p_work_order_id
    OR witness.request_sha256 IS DISTINCT FROM p_witness_request_sha256 THEN
    RAISE EXCEPTION 'HXUV1-COWORKERMATERIALIZE-13-WITNESS_MISMATCH'; END IF;
  witness_sha:=public.universal_v1_change_order_materialization_request_sha256(
    witness.proposal_id,witness.idempotency_key,witness.actor_user_id,witness.work_order_id,
    witness.task_id,witness.task_draft_id,witness.eligibility_decision_id,
    witness.base_scope_version_id,witness.replacement_scope_version_id,
    witness.expected_proposal_version,witness.expected_scope_version,witness.expected_amendment_version,
    witness.expected_execution_version,witness.expected_financial_version,witness.predecessor_event_id,
    witness.predecessor_operation_id,witness.adjustment_operation_id);
  IF witness.request_sha256 IS DISTINCT FROM witness_sha
     OR witness.adjustment_operation_id IS DISTINCT FROM
       public.universal_v1_work_order_operation_id_v1(witness.idempotency_key,'adjust') THEN
    RAISE EXCEPTION 'HXUV1-COWORKERMATERIALIZE-13: CHANGE_ORDER_IDEMPOTENCY_CONFLICT';
  END IF;

  SELECT l.expires_at INTO lease_expires_at FROM public.universal_v1_change_order_recovery_leases l
    WHERE l.proposal_id=p_proposal_id AND l.recovery_lease_id=p_recovery_lease_id
      AND l.lease_owner_id=p_lease_owner_id FOR SHARE NOWAIT;
  IF lease_expires_at IS NULL THEN RAISE EXCEPTION 'HXUV1-COWORKERMATERIALIZE-13-LEASE_MISMATCH'; END IF;
  IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('fulfillment:'||p_work_order_id::TEXT,0)) THEN
    RAISE EXCEPTION 'HXUV1-COWORKERMATERIALIZE-13-LOCK_BUSY'; END IF;
  adjustment_id:=p_adjustment_event_id;
  SELECT * INTO STRICT base_scope FROM public.task_scope_versions s WHERE s.id=witness.base_scope_version_id;
  SELECT * INTO STRICT replacement FROM public.task_scope_versions s WHERE s.id=witness.replacement_scope_version_id;
  -- Immutable scope evidence is checked on replay as well as first creation;
  -- current mutable proposal/approval authority is checked only for a new effect.
  IF base_scope.task_id IS DISTINCT FROM witness.task_id OR base_scope.version IS DISTINCT FROM witness.expected_scope_version
    OR base_scope.universal_contract_version IS DISTINCT FROM 1
    OR replacement.universal_contract_version IS DISTINCT FROM 1 OR replacement.task_id IS DISTINCT FROM witness.task_id
    OR replacement.version::BIGINT IS DISTINCT FROM witness.expected_scope_version::BIGINT+1
    OR replacement.supersedes_version_id IS DISTINCT FROM base_scope.id OR replacement.source IS DISTINCT FROM 'APPROVED_CHANGE'
    OR replacement.created_by IS DISTINCT FROM witness.actor_user_id
    OR replacement.customer_total_cents IS DISTINCT FROM witness.customer_total_cents
    OR replacement.hustler_payout_cents IS DISTINCT FROM witness.provider_payout_cents
    OR replacement.currency IS DISTINCT FROM witness.currency OR replacement.currency IS DISTINCT FROM base_scope.currency
    OR witness.customer_total_cents=base_scope.customer_total_cents OR witness.customer_total_cents<=0
    OR witness.provider_payout_cents<=0 OR witness.provider_payout_cents>witness.customer_total_cents
    OR replacement.scope_hash IS DISTINCT FROM public.universal_v1_change_scope_sha256(replacement.title,
      replacement.description,replacement.requirements,replacement.checklist,replacement.customer_total_cents,
      replacement.hustler_payout_cents,replacement.currency) THEN
    RAISE EXCEPTION 'HXUV1-COWORKERMATERIALIZE-13: CHANGE_ORDER_SCOPE_HASH_MISMATCH'; END IF;
  -- These immutable facts remain exact on historical replay even when a newer
  -- financial or execution fact now exists. Fresh-effect head checks follow.
  SELECT * INTO financial FROM public.task_financial_security_events f WHERE f.id=adjustment_id FOR SHARE NOWAIT;
  SELECT b.bridge_id,b.task_financial_security_event_id,b.fake_operation_id,b.fake_operation_kind,
    b.lifecycle_event_kind,b.lifecycle_status,b.command_id,b.outcome_fact_id,b.prepared_command_id
    INTO bridge FROM public.universal_v1_fake_financial_lifecycle_bridges b
    WHERE b.task_financial_security_event_id=adjustment_id;
  SELECT j.command_id,j.operation_id,j.operation_kind,j.provider_kind,j.provider_expected_version,
    j.idempotency_key,j.recorded_actor_id,j.task_draft_id,j.task_id,j.work_order_id,j.prepared_financial_command_id
    INTO journal FROM public.financial_provider_command_journal j WHERE j.command_id=bridge.command_id;
  SELECT o.outcome_fact_id,o.command_id,o.outcome_kind,o.retryable INTO outcome
    FROM public.financial_provider_command_outcome_facts o WHERE o.outcome_fact_id=bridge.outcome_fact_id;
  IF financial.id IS NULL OR bridge.bridge_id IS NULL OR journal.command_id IS NULL OR outcome.outcome_fact_id IS NULL
     OR financial.operation_id IS DISTINCT FROM witness.adjustment_operation_id::TEXT
     OR financial.idempotency_key IS DISTINCT FROM witness.idempotency_key||':adjust'
     OR financial.event_kind IS DISTINCT FROM 'ADJUSTMENT_AUTHORIZED' OR financial.status IS DISTINCT FROM 'SUCCEEDED'
     OR financial.provider_kind IS DISTINCT FROM 'FAKE' OR financial.recorded_by IS DISTINCT FROM witness.actor_user_id
     OR financial.task_draft_id IS DISTINCT FROM witness.task_draft_id OR financial.task_id IS DISTINCT FROM witness.task_id
     OR financial.eligibility_decision_id IS DISTINCT FROM witness.eligibility_decision_id
     OR financial.scope_version_id IS DISTINCT FROM witness.replacement_scope_version_id
     OR financial.change_order_id IS DISTINCT FROM witness.proposal_id
     OR financial.predecessor_event_id IS DISTINCT FROM witness.predecessor_event_id
     OR financial.expected_version::BIGINT IS DISTINCT FROM witness.expected_financial_version::BIGINT+1
     OR financial.amount_cents IS DISTINCT FROM witness.customer_total_cents OR financial.currency IS DISTINCT FROM witness.currency
     OR bridge.fake_operation_id IS DISTINCT FROM witness.adjustment_operation_id
     OR bridge.fake_operation_kind IS DISTINCT FROM 'ADJUST'
     OR bridge.lifecycle_event_kind IS DISTINCT FROM 'ADJUSTMENT_AUTHORIZED' OR bridge.lifecycle_status IS DISTINCT FROM 'SUCCEEDED'
     OR journal.operation_id IS DISTINCT FROM witness.adjustment_operation_id OR journal.operation_kind IS DISTINCT FROM 'ADJUST'
     OR journal.provider_kind IS DISTINCT FROM 'FAKE' OR journal.provider_expected_version IS DISTINCT FROM 0
     OR journal.idempotency_key IS DISTINCT FROM witness.idempotency_key||':adjust'
     OR journal.recorded_actor_id IS DISTINCT FROM witness.actor_user_id
     OR journal.task_draft_id IS DISTINCT FROM witness.task_draft_id OR journal.task_id IS DISTINCT FROM witness.task_id
     OR journal.work_order_id IS DISTINCT FROM witness.work_order_id
     OR journal.prepared_financial_command_id IS DISTINCT FROM bridge.prepared_command_id
     OR outcome.command_id IS DISTINCT FROM journal.command_id OR outcome.outcome_kind IS DISTINCT FROM 'OUTCOME_OBSERVED'
     OR outcome.retryable IS NOT FALSE THEN
    RAISE EXCEPTION 'HXUV1-COWORKERMATERIALIZE-13: CHANGE_ORDER_AUTHORITY_REVOKED';
  END IF;
  IF EXISTS(SELECT 1 FROM public.universal_v1_change_order_compensation_commands c WHERE c.proposal_id=witness.proposal_id)
     OR EXISTS(SELECT 1 FROM public.universal_v1_change_order_recovery_terminal_facts t
       WHERE t.proposal_id=witness.proposal_id AND t.outcome_state='CANCELLED') THEN
    RAISE EXCEPTION 'HXUV1-COWORKERMATERIALIZE-13: CHANGE_ORDER_AUTHORITY_REVOKED';
  END IF;


  SELECT r.command_id,r.target_authority_id,r.target_database_name,r.release_environment,r.release_manifest_digest
    INTO historical_request FROM hx_authority.fake_financial_command_outbox_requests_v13 r WHERE r.command_id=journal.command_id;
  SELECT * INTO historical_target FROM hx_authority.universal_v1_work_order_target_authority_facts t
    WHERE t.target_authority_id=historical_request.target_authority_id;
  IF historical_request.command_id IS NULL OR historical_target.target_authority_id IS NULL
    OR historical_request.target_database_name IS DISTINCT FROM p_target_database_name
    OR historical_request.release_environment IS DISTINCT FROM p_release_environment
    OR historical_target.target_database_name IS DISTINCT FROM p_target_database_name
    OR historical_target.environment IS DISTINCT FROM p_release_environment
    OR historical_request.release_manifest_digest IS DISTINCT FROM historical_target.release_manifest_sha256
    OR NOT EXISTS(WITH RECURSIVE lineage AS (
      SELECT t.target_authority_id,t.supersedes_target_authority_id FROM hx_authority.universal_v1_work_order_target_authority_facts t WHERE t.target_authority_id=p_target_authority_id
      UNION ALL SELECT t.target_authority_id,t.supersedes_target_authority_id FROM hx_authority.universal_v1_work_order_target_authority_facts t JOIN lineage l ON t.target_authority_id=l.supersedes_target_authority_id
    ) SELECT 1 FROM lineage exact_target WHERE exact_target.target_authority_id=historical_request.target_authority_id) THEN
    RAISE EXCEPTION 'HXUV1-COWORKERMATERIALIZE-13-HISTORICAL_TARGET_MISMATCH'; END IF;
  SELECT a.id,a.work_order_id,a.amendment_version,a.supersedes_amendment_id,a.change_order_id,a.scope_version_id,
    a.adjustment_event_id,a.expected_financial_version,a.idempotency_key,a.request_sha256,a.materialized_by
    INTO amendment FROM public.task_work_order_amendments a
    WHERE a.change_order_id=witness.proposal_id OR a.idempotency_key=witness.idempotency_key
    ORDER BY (a.change_order_id=witness.proposal_id) DESC,a.id LIMIT 1;
  IF amendment.id IS NOT NULL THEN
    SELECT e.id,e.work_order_id,e.task_id,e.scope_version_id,e.execution_version,e.supersedes_fact_id,e.state,
      e.transition_kind,e.completion_fact_id,e.work_order_amendment_id,e.actor_role,e.actor_user_id,e.reason,
      e.idempotency_key,e.request_sha256,e.client_occurred_at,e.policy_version
      INTO execution FROM public.task_work_order_execution_facts e
      WHERE e.work_order_amendment_id=amendment.id AND e.transition_kind='APPLY_AMENDMENT';
    SELECT e.id,e.work_order_id,e.task_id,e.scope_version_id,e.execution_version,e.state
      INTO predecessor_execution FROM public.task_work_order_execution_facts e WHERE e.id=execution.supersedes_fact_id;
    SELECT a.id,a.work_order_id,a.amendment_version,a.scope_version_id
      INTO predecessor_amendment FROM public.task_work_order_amendments a WHERE a.id=amendment.supersedes_amendment_id;
    amendment_sha:=public.universal_v1_change_amendment_request_sha256(
      witness.work_order_id,witness.expected_amendment_version+1,amendment.supersedes_amendment_id,
      witness.proposal_id,witness.replacement_scope_version_id,adjustment_id,witness.expected_financial_version,
      witness.actor_user_id,witness.idempotency_key);
    IF amendment.work_order_id IS DISTINCT FROM witness.work_order_id OR amendment.change_order_id IS DISTINCT FROM witness.proposal_id
       OR amendment.amendment_version::BIGINT IS DISTINCT FROM witness.expected_amendment_version::BIGINT+1
       OR amendment.scope_version_id IS DISTINCT FROM witness.replacement_scope_version_id
       OR amendment.adjustment_event_id IS DISTINCT FROM adjustment_id
       OR amendment.expected_financial_version IS DISTINCT FROM witness.expected_financial_version
       OR amendment.idempotency_key IS DISTINCT FROM witness.idempotency_key OR amendment.materialized_by IS DISTINCT FROM witness.actor_user_id
       OR amendment.request_sha256 IS DISTINCT FROM amendment_sha
       OR (witness.expected_amendment_version=0 AND amendment.supersedes_amendment_id IS NOT NULL)
       OR (witness.expected_amendment_version>0 AND (predecessor_amendment.id IS NULL
         OR predecessor_amendment.work_order_id IS DISTINCT FROM witness.work_order_id
         OR predecessor_amendment.amendment_version IS DISTINCT FROM witness.expected_amendment_version
         OR predecessor_amendment.scope_version_id IS DISTINCT FROM witness.base_scope_version_id))
       OR execution.id IS NULL OR execution.work_order_id IS DISTINCT FROM witness.work_order_id
       OR execution.task_id IS DISTINCT FROM witness.task_id OR execution.scope_version_id IS DISTINCT FROM witness.replacement_scope_version_id
       OR execution.execution_version::BIGINT IS DISTINCT FROM witness.expected_execution_version::BIGINT+1
       OR execution.actor_user_id IS DISTINCT FROM witness.actor_user_id OR execution.actor_role IS DISTINCT FROM 'CUSTOMER'
       OR execution.idempotency_key IS DISTINCT FROM witness.idempotency_key||':execution'
       OR execution.completion_fact_id IS NOT NULL OR execution.reason IS NOT NULL
       OR execution.policy_version IS DISTINCT FROM 'universal-v1-work-order-execution-1.0.0'
       OR predecessor_execution.id IS NULL OR predecessor_execution.work_order_id IS DISTINCT FROM witness.work_order_id
       OR predecessor_execution.task_id IS DISTINCT FROM witness.task_id
       OR predecessor_execution.scope_version_id IS DISTINCT FROM witness.base_scope_version_id
       OR predecessor_execution.execution_version IS DISTINCT FROM witness.expected_execution_version
       OR execution.state IS DISTINCT FROM predecessor_execution.state
       OR predecessor_execution.state NOT IN ('MATERIALIZED','ACKNOWLEDGED','EN_ROUTE','ARRIVED','PAUSED')
       OR execution.request_sha256 IS DISTINCT FROM public.universal_v1_execution_internal_request_sha256(
         witness.actor_user_id,witness.work_order_id,'APPLY_AMENDMENT',execution.state,witness.expected_execution_version,
         witness.replacement_scope_version_id,NULL,amendment.id,witness.idempotency_key||':execution',
         execution.client_occurred_at,NULL) THEN
      RAISE EXCEPTION 'HXUV1-COWORKERMATERIALIZE-13: CHANGE_ORDER_IDEMPOTENCY_CONFLICT';
    END IF;
    amendment_id_value:=amendment.id; next_amendment_version:=amendment.amendment_version; replay:=TRUE;

  ELSE
    IF lease_expires_at<=pg_catalog.clock_timestamp() THEN RAISE EXCEPTION 'HXUV1-COWORKERMATERIALIZE-13-LEASE_EXPIRED'; END IF;
      FOR pass IN 0..1 LOOP
        SELECT t.poster_id,t.business_organization_id AS customer_organization_id,
          w.provider_user_id,w.provider_organization_id,e.trade_credential_id,
          ca.actor_id AS customer_approval_actor_id,pa.actor_id AS provider_approval_actor_id INTO context
        FROM public.tasks t
        JOIN public.task_drafts d ON d.id=witness.task_draft_id AND d.task_id=t.id
        JOIN public.task_work_orders w ON w.id=witness.work_order_id AND w.task_id=t.id
          AND w.task_draft_id=d.id AND w.eligibility_decision_id=witness.eligibility_decision_id
        JOIN public.task_provider_eligibility_decisions e ON e.id=witness.eligibility_decision_id
        LEFT JOIN public.task_scope_change_approvals ca ON ca.proposal_id=p_proposal_id AND ca.approver_role='CUSTOMER'
        LEFT JOIN public.task_scope_change_approvals pa ON pa.proposal_id=p_proposal_id AND pa.approver_role='PROVIDER'
        WHERE t.id=witness.task_id AND t.work_order_id=w.id AND t.active_scope_version_id=witness.base_scope_version_id
          AND t.universal_contract_version=1 AND t.automation_classification='CONTROLLED_TEST'
          AND t.universal_payment_posture='PAYMENT_CREATION_FROZEN' AND t.worker_id IS NULL
          AND d.poster_user_id=t.poster_id AND d.claimed_at IS NOT NULL
          AND d.universal_contract_version=1 AND d.ingress_origin='BACKEND_POSTGRESQL';
        IF NOT FOUND THEN RAISE EXCEPTION 'HXUV1-COWORKERMATERIALIZE-13-CONTEXT_MISMATCH'; END IF;
        IF pass=1 THEN
          IF pg_catalog.to_jsonb(context) IS DISTINCT FROM context_before THEN
            RAISE EXCEPTION 'HXUV1-COWORKERMATERIALIZE-13-DEPENDENCY_CHANGED'; END IF;
          EXIT;
        END IF;
        context_before:=pg_catalog.to_jsonb(context);
        PERFORM 1 FROM public.task_work_orders WHERE id=witness.work_order_id FOR UPDATE NOWAIT;
        PERFORM 1 FROM public.tasks WHERE id=witness.task_id FOR UPDATE NOWAIT;
        PERFORM 1 FROM public.task_drafts WHERE id=witness.task_draft_id FOR SHARE NOWAIT;
        PERFORM 1 FROM public.task_scope_change_proposals WHERE id=p_proposal_id FOR UPDATE NOWAIT;
        PERFORM 1 FROM public.task_provider_eligibility_decisions WHERE id=witness.eligibility_decision_id FOR SHARE NOWAIT;
        PERFORM 1 FROM public.task_scope_versions WHERE id IN(witness.base_scope_version_id,witness.replacement_scope_version_id)
          ORDER BY id FOR SHARE NOWAIT;
        PERFORM 1 FROM public.task_scope_change_approvals WHERE proposal_id=p_proposal_id ORDER BY id FOR SHARE NOWAIT;
        SELECT pg_catalog.array_agg(id ORDER BY id) INTO actor_ids FROM (
          SELECT witness.actor_user_id AS id UNION SELECT context.poster_id UNION SELECT context.provider_user_id
          UNION SELECT context.customer_approval_actor_id UNION SELECT context.provider_approval_actor_id
        ) actors WHERE id IS NOT NULL;
        -- UPDATE blocks users FK KEY SHARE for newly inserted memberships.
        PERFORM 1 FROM public.users WHERE id=ANY(actor_ids) ORDER BY id FOR UPDATE NOWAIT;
        PERFORM 1 FROM public.business_organizations WHERE id IN(context.customer_organization_id,context.provider_organization_id)
          ORDER BY id FOR SHARE NOWAIT;
        PERFORM 1 FROM public.business_memberships
          WHERE organization_id IN(context.customer_organization_id,context.provider_organization_id) AND user_id=ANY(actor_ids)
          ORDER BY organization_id,user_id,id FOR SHARE NOWAIT;
        PERFORM 1 FROM public.capability_profiles WHERE user_id=context.provider_user_id ORDER BY user_id FOR SHARE NOWAIT;
        PERFORM 1 FROM public.business_credentials WHERE id=context.trade_credential_id FOR SHARE NOWAIT;
        PERFORM 1 FROM public.verified_trades WHERE user_id=context.provider_user_id
          AND provider_organization_id IS NOT DISTINCT FROM context.provider_organization_id
          AND business_credential_id IS NOT DISTINCT FROM context.trade_credential_id ORDER BY user_id,trade FOR SHARE NOWAIT;
      END LOOP;

    SELECT t.region_policy_id INTO region_policy_id_value FROM public.tasks t WHERE t.id=witness.task_id;
    IF region_policy_id_value IS NULL THEN RAISE EXCEPTION 'HXUV1-COWORKERMATERIALIZE-13-REGION_POLICY_REQUIRED'; END IF;
    PERFORM 1 FROM public.region_policies WHERE id=region_policy_id_value FOR SHARE NOWAIT;
  SELECT * INTO STRICT proposal FROM public.task_scope_change_proposals p WHERE p.id=witness.proposal_id;
  SELECT * INTO STRICT base_scope FROM public.task_scope_versions s WHERE s.id=witness.base_scope_version_id;
  SELECT * INTO STRICT replacement FROM public.task_scope_versions s WHERE s.id=witness.replacement_scope_version_id;
  IF proposal.universal_contract_version IS DISTINCT FROM 1 OR proposal.application_contract_version IS DISTINCT FROM 1
     OR proposal.task_id IS DISTINCT FROM witness.task_id OR proposal.status IS DISTINCT FROM 'APPROVED'
     OR proposal.change_order_kind IS DISTINCT FROM 'PRICE_AND_SCOPE' OR proposal.financial_adjustment_required IS NOT TRUE
     OR proposal.proposal_version IS DISTINCT FROM witness.expected_proposal_version
     OR proposal.base_version_id IS DISTINCT FROM witness.base_scope_version_id
     OR proposal.approved_version_id IS DISTINCT FROM witness.replacement_scope_version_id
     OR proposal.reviewed_by IS DISTINCT FROM witness.actor_user_id
     OR proposal.proposed_customer_total_cents IS DISTINCT FROM witness.customer_total_cents
     OR proposal.proposed_provider_payout_cents IS DISTINCT FROM witness.provider_payout_cents
     OR base_scope.task_id IS DISTINCT FROM witness.task_id OR base_scope.version IS DISTINCT FROM witness.expected_scope_version
     OR base_scope.universal_contract_version IS DISTINCT FROM 1
     OR replacement.universal_contract_version IS DISTINCT FROM 1 OR replacement.task_id IS DISTINCT FROM witness.task_id
     OR replacement.version::BIGINT IS DISTINCT FROM witness.expected_scope_version::BIGINT+1
     OR replacement.supersedes_version_id IS DISTINCT FROM base_scope.id
     OR replacement.source IS DISTINCT FROM 'APPROVED_CHANGE'
     OR replacement.created_by IS DISTINCT FROM witness.actor_user_id
     OR replacement.change_summary IS DISTINCT FROM proposal.observed_scope_summary
     OR replacement.title IS DISTINCT FROM proposal.proposed_title
     OR replacement.description IS DISTINCT FROM proposal.proposed_description
     OR replacement.requirements IS DISTINCT FROM proposal.proposed_requirements
     OR replacement.checklist IS DISTINCT FROM proposal.proposed_checklist
     OR replacement.customer_total_cents IS DISTINCT FROM witness.customer_total_cents
     OR replacement.hustler_payout_cents IS DISTINCT FROM witness.provider_payout_cents
     OR replacement.currency IS DISTINCT FROM witness.currency OR replacement.currency IS DISTINCT FROM base_scope.currency
     OR witness.customer_total_cents=base_scope.customer_total_cents
     OR witness.customer_total_cents<=0 OR witness.provider_payout_cents<=0
     OR witness.provider_payout_cents>witness.customer_total_cents
     OR replacement.scope_hash IS DISTINCT FROM proposal.proposed_scope_sha256
     OR replacement.scope_hash IS DISTINCT FROM public.universal_v1_change_scope_sha256(
       replacement.title,replacement.description,replacement.requirements,replacement.checklist,
       replacement.customer_total_cents,replacement.hustler_payout_cents,replacement.currency) THEN
    RAISE EXCEPTION 'HXUV1-COWORKERMATERIALIZE-13: CHANGE_ORDER_SCOPE_HASH_MISMATCH';
  END IF;


    IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtext('financial-provider-command-recovery-v1'),pg_catalog.hashtext(journal.command_id::TEXT))
      OR NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtext('fake-financial-operation'),pg_catalog.hashtext(witness.adjustment_operation_id::TEXT)) THEN
      RAISE EXCEPTION 'HXUV1-COWORKERMATERIALIZE-13-LOCK_BUSY'; END IF;
    -- The admitted projection verifies exact outbox/admission/outcome/provider
    -- event/bridge provenance. An unadmitted legacy journal cannot authorize a
    -- new foreground effect. All mutable principal rows remain locked while
    -- the finance projection waits on its own recovery locks.
    financial_progress:=hx_authority.read_fake_financial_public_progress_v13(journal.command_id);
    IF financial_progress IS NULL
       OR financial_progress->>'commandId' IS DISTINCT FROM journal.command_id::TEXT
       OR financial_progress->>'operationId' IS DISTINCT FROM witness.adjustment_operation_id::TEXT
       OR financial_progress->>'operationKind' IS DISTINCT FROM 'ADJUST'
       OR financial_progress->>'ownerActorId' IS DISTINCT FROM witness.actor_user_id::TEXT
       OR financial_progress->>'environment' IS DISTINCT FROM p_release_environment
       OR financial_progress->>'taskDraftId' IS DISTINCT FROM witness.task_draft_id::TEXT
       OR financial_progress->>'taskId' IS DISTINCT FROM witness.task_id::TEXT
       OR financial_progress->>'progressState' IS DISTINCT FROM 'MATERIALIZED'
       OR financial_progress->'financialEvent' IS DISTINCT FROM pg_catalog.jsonb_build_object(
         'id',adjustment_id,'eventKind','ADJUSTMENT_AUTHORIZED','status','SUCCEEDED') THEN
      RAISE EXCEPTION 'HXUV1-COWORKERMATERIALIZE-13: CHANGE_ORDER_AUTHORITY_REVOKED';
    END IF;
    SELECT e.id,e.execution_version,e.state,e.scope_version_id
      INTO current_execution FROM public.task_work_order_execution_facts e WHERE e.work_order_id=witness.work_order_id
      ORDER BY e.execution_version DESC LIMIT 1;
    SELECT a.id,a.amendment_version,a.scope_version_id INTO predecessor_amendment
      FROM public.task_work_order_amendments a WHERE a.work_order_id=witness.work_order_id
      ORDER BY a.amendment_version DESC LIMIT 1;
    -- A fresh READ COMMITTED statement after all locks and financial progress:
    -- immutable Phase A is retained, but each new domain effect needs current
    -- actors, independent approvals, provider credentials, head and expiry.
    SELECT EXISTS(
      SELECT 1 FROM public.tasks task
      JOIN public.task_drafts draft ON draft.id=witness.task_draft_id AND draft.task_id=task.id
      JOIN public.task_work_orders work_order ON work_order.id=witness.work_order_id
      JOIN public.task_provider_eligibility_decisions eligibility ON eligibility.id=witness.eligibility_decision_id
      JOIN public.users current_actor ON current_actor.id=witness.actor_user_id
      JOIN public.users provider ON provider.id=work_order.provider_user_id
      JOIN public.task_scope_change_approvals customer_approval
        ON customer_approval.proposal_id=witness.proposal_id AND customer_approval.approver_role='CUSTOMER'
      JOIN public.task_scope_change_approvals provider_approval
        ON provider_approval.proposal_id=witness.proposal_id AND provider_approval.approver_role='PROVIDER'
      JOIN public.users customer_approval_actor ON customer_approval_actor.id=customer_approval.actor_id
      JOIN public.users provider_approval_actor ON provider_approval_actor.id=provider_approval.actor_id
      LEFT JOIN public.business_organizations customer_organization ON customer_organization.id=task.business_organization_id
      LEFT JOIN public.business_organizations provider_organization ON provider_organization.id=work_order.provider_organization_id
      WHERE task.id=witness.task_id AND task.work_order_id=work_order.id
        AND task.active_scope_version_id=witness.base_scope_version_id
        AND task.universal_contract_version=1 AND task.automation_classification='CONTROLLED_TEST'
        AND task.universal_payment_posture='PAYMENT_CREATION_FROZEN' AND task.worker_id IS NULL
        AND draft.universal_contract_version=1 AND draft.ingress_origin='BACKEND_POSTGRESQL'
        AND draft.claimed_at IS NOT NULL AND draft.poster_user_id=task.poster_id
        AND work_order.task_id=task.id AND work_order.task_draft_id=draft.id
        AND work_order.eligibility_decision_id=eligibility.id AND work_order.execution_contract_version=1
        AND eligibility.task_id=task.id AND eligibility.task_draft_id=draft.id AND eligibility.task_eligible IS TRUE
        AND eligibility.provider_user_id=work_order.provider_user_id
        AND eligibility.provider_organization_id IS NOT DISTINCT FROM work_order.provider_organization_id
        AND current_actor.account_status='ACTIVE' AND current_actor.is_minor IS FALSE
        AND COALESCE(current_actor.is_banned,FALSE) IS FALSE
        AND provider.account_status='ACTIVE' AND provider.is_minor IS FALSE AND COALESCE(provider.is_banned,FALSE) IS FALSE
        AND NOT (provider.trust_hold IS TRUE
          AND (provider.trust_hold_until IS NULL OR provider.trust_hold_until>pg_catalog.clock_timestamp()))
        AND customer_approval.decision='APPROVED' AND provider_approval.decision='APPROVED'
        AND customer_approval.expected_proposal_version=witness.expected_proposal_version
        AND provider_approval.expected_proposal_version=witness.expected_proposal_version
        AND customer_approval.actor_id<>provider_approval.actor_id
        AND customer_approval_actor.account_status='ACTIVE' AND customer_approval_actor.is_minor IS FALSE
        AND COALESCE(customer_approval_actor.is_banned,FALSE) IS FALSE
        AND provider_approval_actor.account_status='ACTIVE' AND provider_approval_actor.is_minor IS FALSE
        AND COALESCE(provider_approval_actor.is_banned,FALSE) IS FALSE
        AND ((task.business_organization_id IS NULL AND task.poster_id=witness.actor_user_id)
          OR (task.business_organization_id IS NOT NULL AND customer_organization.status='ACTIVE'
            AND customer_organization.client_enabled IS TRUE
            AND public.business_membership_has_action(task.business_organization_id,witness.actor_user_id,'APPROVE_SPEND') IS TRUE))
        AND ((task.business_organization_id IS NULL AND customer_approval.actor_id=task.poster_id)
          OR (task.business_organization_id IS NOT NULL AND customer_organization.status='ACTIVE'
            AND customer_organization.client_enabled IS TRUE
            AND public.business_membership_has_action(task.business_organization_id,customer_approval.actor_id,'APPROVE_SPEND') IS TRUE))
        AND (provider_approval.actor_id=work_order.provider_user_id
          OR (work_order.provider_organization_id IS NOT NULL AND provider_organization.status='ACTIVE'
            AND provider_organization.provider_enabled IS TRUE
            AND public.business_membership_has_action(work_order.provider_organization_id,provider_approval.actor_id,'APPROVE_SPEND') IS TRUE))
        AND public.universal_v1_invited_provider_authority_is_current(eligibility.provider_user_id,
          eligibility.provider_organization_id,eligibility.provider_class,eligibility.trade_credential_id,
          task.category,task.region_code) IS TRUE
        AND NOT EXISTS(SELECT 1 FROM public.task_financial_security_events f
          WHERE f.task_draft_id=witness.task_draft_id AND f.expected_version>financial.expected_version)
        AND NOT EXISTS(SELECT 1 FROM public.task_completion_facts c WHERE c.work_order_id=work_order.id)
        AND NOT EXISTS(SELECT 1 FROM public.task_reconciliation_facts r WHERE r.work_order_id=work_order.id)
        AND NOT EXISTS(SELECT 1 FROM public.universal_v1_change_order_compensation_commands c WHERE c.proposal_id=witness.proposal_id)
        AND NOT EXISTS(SELECT 1 FROM public.universal_v1_change_order_recovery_terminal_facts t WHERE t.proposal_id=witness.proposal_id)
    ) INTO authority_current;
    IF authority_current IS NOT TRUE OR current_execution.id IS NULL
       OR current_execution.execution_version IS DISTINCT FROM witness.expected_execution_version
       OR current_execution.scope_version_id IS DISTINCT FROM witness.base_scope_version_id
       OR current_execution.state NOT IN ('MATERIALIZED','ACKNOWLEDGED','EN_ROUTE','ARRIVED','PAUSED')
       OR COALESCE(predecessor_amendment.amendment_version,0) IS DISTINCT FROM witness.expected_amendment_version
       OR (predecessor_amendment.id IS NOT NULL AND predecessor_amendment.scope_version_id IS DISTINCT FROM witness.base_scope_version_id)
       OR witness.expected_amendment_version=2147483647 OR witness.expected_execution_version=2147483647
       OR public.universal_v1_financial_security_is_current_v1(
         public.universal_v1_effective_financial_security_expiry_v1(adjustment_id),
         pg_catalog.clock_timestamp()) IS NOT TRUE THEN
      RAISE EXCEPTION 'HXUV1-COWORKERMATERIALIZE-13: CHANGE_ORDER_AUTHORITY_REVOKED';
    END IF;
    finalization_at:=pg_catalog.clock_timestamp();
    next_amendment_version:=witness.expected_amendment_version+1;
    next_execution_version:=witness.expected_execution_version+1;
    amendment_sha:=public.universal_v1_change_amendment_request_sha256(
      witness.work_order_id,next_amendment_version,predecessor_amendment.id,witness.proposal_id,
      witness.replacement_scope_version_id,adjustment_id,witness.expected_financial_version,
      witness.actor_user_id,witness.idempotency_key);
    UPDATE public.tasks task SET title=replacement.title,description=replacement.description,
      requirements=replacement.requirements,price=replacement.customer_total_cents,
      hustler_payout_cents=replacement.hustler_payout_cents,
      platform_margin_cents=replacement.customer_total_cents-replacement.hustler_payout_cents,
      scope_hash=replacement.scope_hash,active_scope_version_id=replacement.id,updated_at=pg_catalog.clock_timestamp()
    WHERE task.id=witness.task_id AND task.active_scope_version_id=witness.base_scope_version_id
      AND task.worker_id IS NULL AND task.universal_contract_version=1
      AND task.automation_classification='CONTROLLED_TEST' AND task.universal_payment_posture='PAYMENT_CREATION_FROZEN';
    GET DIAGNOSTICS changed_count=ROW_COUNT;
    IF changed_count<>1 THEN RAISE EXCEPTION 'HXUV1-COWORKERMATERIALIZE-13: CHANGE_ORDER_HARD_ASSIGNMENT_FORBIDDEN'; END IF;
    INSERT INTO public.task_work_order_amendments AS inserted(
      work_order_id,amendment_version,supersedes_amendment_id,change_order_id,scope_version_id,
      adjustment_event_id,expected_financial_version,idempotency_key,request_sha256,materialized_by
    ) VALUES(witness.work_order_id,next_amendment_version,predecessor_amendment.id,witness.proposal_id,
      witness.replacement_scope_version_id,adjustment_id,witness.expected_financial_version,
      witness.idempotency_key,amendment_sha,witness.actor_user_id)
    RETURNING inserted.id INTO amendment_id_value;
    IF amendment_id_value IS NULL THEN RAISE EXCEPTION 'HXUV1-COWORKERMATERIALIZE-13: CHANGE_ORDER_MATERIALIZATION_FAILED'; END IF;
    execution_key:=witness.idempotency_key||':execution';
    execution_sha:=public.universal_v1_execution_internal_request_sha256(witness.actor_user_id,witness.work_order_id,
      'APPLY_AMENDMENT',current_execution.state,witness.expected_execution_version,witness.replacement_scope_version_id,
      NULL,amendment_id_value,execution_key,finalization_at,NULL);
    INSERT INTO public.task_work_order_execution_facts AS inserted(
      work_order_id,task_id,scope_version_id,execution_version,supersedes_fact_id,state,transition_kind,
      completion_fact_id,work_order_amendment_id,actor_role,actor_user_id,reason,idempotency_key,
      request_sha256,client_occurred_at,policy_version
    ) VALUES(witness.work_order_id,witness.task_id,witness.replacement_scope_version_id,next_execution_version,
      current_execution.id,current_execution.state,'APPLY_AMENDMENT',NULL,amendment_id_value,'CUSTOMER',
      witness.actor_user_id,NULL,execution_key,execution_sha,finalization_at,'universal-v1-work-order-execution-1.0.0')
    RETURNING inserted.id INTO execution;
    IF execution.id IS NULL THEN RAISE EXCEPTION 'HXUV1-COWORKERMATERIALIZE-13: CHANGE_ORDER_MATERIALIZATION_FAILED'; END IF;

    INSERT INTO hx_authority.fake_financial_change_order_materialization_origins_v13 (
      amendment_id,execution_fact_id,proposal_id,recovery_lease_id,lease_owner_id,target_authority_id,
      release_environment,release_manifest_digest,service_database_role,witness_request_sha256,adjustment_event_id
    ) VALUES(amendment_id_value,execution.id,p_proposal_id,p_recovery_lease_id,p_lease_owner_id,p_target_authority_id,
      p_release_environment,p_release_manifest_digest,SESSION_USER,p_witness_request_sha256,p_adjustment_event_id)
    RETURNING * INTO origin;
    IF lease_expires_at<=pg_catalog.clock_timestamp()
      OR public.universal_v1_financial_security_is_current_v1(public.universal_v1_effective_financial_security_expiry_v1(adjustment_id),pg_catalog.clock_timestamp()) IS NOT TRUE THEN
      RAISE EXCEPTION 'HXUV1-COWORKERMATERIALIZE-13-LEASE_OR_SECURITY_EXPIRED'; END IF;
  END IF;
  SELECT * INTO origin FROM hx_authority.fake_financial_change_order_materialization_origins_v13 o WHERE o.amendment_id=amendment_id_value;
  IF origin.amendment_id IS NOT NULL THEN
    SELECT * INTO original_target FROM hx_authority.universal_v1_work_order_target_authority_facts t WHERE t.target_authority_id=origin.target_authority_id;
    SELECT l.proposal_id,l.lease_owner_id,l.acquired_at,l.expires_at INTO original_lease FROM public.universal_v1_change_order_recovery_leases l WHERE l.recovery_lease_id=origin.recovery_lease_id;
    IF origin.proposal_id IS DISTINCT FROM p_proposal_id OR origin.execution_fact_id IS DISTINCT FROM execution.id
      OR origin.witness_request_sha256 IS DISTINCT FROM p_witness_request_sha256 OR origin.adjustment_event_id IS DISTINCT FROM adjustment_id
      OR original_lease.proposal_id IS DISTINCT FROM p_proposal_id OR original_lease.lease_owner_id IS DISTINCT FROM origin.lease_owner_id
      OR origin.recorded_at<original_lease.acquired_at OR origin.recorded_at>=original_lease.expires_at
      OR origin.service_database_role='' OR origin.recorded_at>pg_catalog.clock_timestamp()
      OR original_target.target_database_name IS DISTINCT FROM p_target_database_name OR original_target.environment IS DISTINCT FROM p_release_environment
      OR original_target.environment IS DISTINCT FROM origin.release_environment OR original_target.release_manifest_sha256 IS DISTINCT FROM origin.release_manifest_digest
      OR NOT EXISTS(WITH RECURSIVE lineage AS (
        SELECT t.target_authority_id,t.supersedes_target_authority_id FROM hx_authority.universal_v1_work_order_target_authority_facts t WHERE t.target_authority_id=p_target_authority_id
        UNION ALL SELECT t.target_authority_id,t.supersedes_target_authority_id FROM hx_authority.universal_v1_work_order_target_authority_facts t JOIN lineage l ON t.target_authority_id=l.supersedes_target_authority_id
      ) SELECT 1 FROM lineage exact_target WHERE exact_target.target_authority_id=origin.target_authority_id)
      OR NOT EXISTS(WITH RECURSIVE lineage AS (
        SELECT t.target_authority_id,t.supersedes_target_authority_id FROM hx_authority.universal_v1_work_order_target_authority_facts t WHERE t.target_authority_id=origin.target_authority_id
        UNION ALL SELECT t.target_authority_id,t.supersedes_target_authority_id FROM hx_authority.universal_v1_work_order_target_authority_facts t JOIN lineage l ON t.target_authority_id=l.supersedes_target_authority_id
      ) SELECT 1 FROM lineage exact_target WHERE exact_target.target_authority_id=historical_request.target_authority_id) THEN
      RAISE EXCEPTION 'HXUV1-COWORKERMATERIALIZE-13-ORIGIN_MISMATCH'; END IF;
    worker_origin:=pg_catalog.to_jsonb(origin);
  END IF;
  result:=pg_catalog.jsonb_build_object('amendment_id',amendment_id_value,'amendment_version',next_amendment_version,
    'proposal_id',witness.proposal_id,'scope_version_id',witness.replacement_scope_version_id,
    'scope_version',replacement.version,'adjustment_event_id',adjustment_id,'provider_kind','FAKE',
    'replayed',replay,'payment_creation_performed',FALSE,'hard_assignment_created',FALSE);

  actor_user_id:=witness.actor_user_id;observed_at:=pg_catalog.clock_timestamp();
  IF NOT replay AND observed_at>=lease_expires_at THEN RAISE EXCEPTION 'HXUV1-COWORKERMATERIALIZE-13-LEASE_EXPIRED'; END IF;
  target_authority_id:=p_target_authority_id;release_manifest_digest:=p_release_manifest_digest;RETURN NEXT;
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'HXUV1-COWORKERMATERIALIZE-13: CHANGE_ORDER_IDEMPOTENCY_CONFLICT';
WHEN lock_not_available THEN RAISE EXCEPTION 'HXUV1-COWORKERMATERIALIZE-13-LOCK_BUSY';
END;
$$;
REVOKE ALL ON FUNCTION public.hxos_finalize_worker_change_order_v13(UUID,TEXT,TEXT,TEXT,UUID,UUID,UUID,TEXT,UUID,UUID) FROM PUBLIC;
DO $$ DECLARE grantee TEXT; BEGIN
  FOR grantee IN SELECT DISTINCT CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(r.rolname) END
    FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
    LEFT JOIN pg_catalog.pg_roles r ON r.oid=a.grantee
    WHERE p.oid='public.hxos_finalize_worker_change_order_v13(uuid,text,text,text,uuid,uuid,uuid,text,uuid,uuid)'::pg_catalog.regprocedure AND a.grantee<>p.proowner LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION public.hxos_finalize_worker_change_order_v13(uuid,text,text,text,uuid,uuid,uuid,text,uuid,uuid) FROM '||grantee||' CASCADE';
  END LOOP;
END $$;
DO $$ DECLARE permission RECORD; grantee TEXT; BEGIN
  FOR permission IN SELECT a.grantee FROM pg_catalog.pg_class c,
    LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
    WHERE c.oid='hx_authority.fake_financial_change_order_materialization_origins_v13'::pg_catalog.regclass AND a.grantee<>c.relowner LOOP
    grantee:=CASE WHEN permission.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(permission.grantee)) END;
    EXECUTE 'REVOKE ALL ON TABLE hx_authority.fake_financial_change_order_materialization_origins_v13 FROM '||grantee||' CASCADE';
  END LOOP;
  FOR permission IN SELECT a.grantee,attribute.attname FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_attribute attribute ON attribute.attrelid=c.oid AND attribute.attnum>0 AND NOT attribute.attisdropped
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) a
    WHERE c.oid='hx_authority.fake_financial_change_order_materialization_origins_v13'::pg_catalog.regclass AND a.grantee<>c.relowner LOOP
    grantee:=CASE WHEN permission.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(permission.grantee)) END;
    EXECUTE 'REVOKE ALL ('||pg_catalog.quote_ident(permission.attname)||') ON TABLE hx_authority.fake_financial_change_order_materialization_origins_v13 FROM '||grantee||' CASCADE';
  END LOOP;
END $$;

-- Recover Phase-A/PREPARED crashes through the existing durable request rail.
-- The human actor remains historical; service continuation has its own provenance.
CREATE TABLE hx_authority.fake_financial_change_order_adjustment_preparations_v13 (
  preparation_origin_id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  prepared_command_id UUID NOT NULL REFERENCES public.universal_v1_prepared_financial_commands(prepared_command_id),
  proposal_id UUID NOT NULL REFERENCES public.universal_v1_change_order_materialization_commands(proposal_id),
  recovery_lease_id UUID NOT NULL REFERENCES public.universal_v1_change_order_recovery_leases(recovery_lease_id),
  lease_owner_id UUID NOT NULL,
  witness_request_sha256 TEXT NOT NULL CHECK(witness_request_sha256 ~ '^[a-f0-9]{64}$'),
  target_authority_id UUID NOT NULL REFERENCES hx_authority.universal_v1_work_order_target_authority_facts(target_authority_id),
  release_manifest_sha256 TEXT NOT NULL CHECK(release_manifest_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  service_database_role TEXT NOT NULL CHECK(service_database_role<>''),
  provider_request_sha256 TEXT NOT NULL CHECK(provider_request_sha256 ~ '^[a-f0-9]{64}$'),
  prepared_authority_sha256 TEXT NOT NULL CHECK(prepared_authority_sha256 ~ '^[a-f0-9]{64}$'),
  created_prepared BOOLEAN NOT NULL,
  preparation_transaction_id XID8 NOT NULL DEFAULT pg_catalog.pg_current_xact_id(),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  UNIQUE(prepared_command_id,target_authority_id,recovery_lease_id)
);
CREATE UNIQUE INDEX one_worker_adjustment_creator_v13 ON hx_authority.fake_financial_change_order_adjustment_preparations_v13(prepared_command_id) WHERE created_prepared;
CREATE TRIGGER immutable_worker_adjustment_preparation_v13
BEFORE UPDATE OR DELETE ON hx_authority.fake_financial_change_order_adjustment_preparations_v13
FOR EACH ROW EXECUTE FUNCTION hx_authority.reject_fake_financial_outbox_mutation_v13();
CREATE TRIGGER immutable_worker_adjustment_preparation_truncate_v13
BEFORE TRUNCATE ON hx_authority.fake_financial_change_order_adjustment_preparations_v13
FOR EACH STATEMENT EXECUTE FUNCTION hx_authority.reject_fake_financial_outbox_mutation_v13();

CREATE OR REPLACE FUNCTION hx_authority.assert_worker_change_order_adjustment_v13(
  p_target_authority_id UUID,p_target_database_name TEXT,p_release_environment TEXT,p_release_manifest_digest TEXT,
  p_proposal_id UUID,p_recovery_lease_id UUID,p_lease_owner_id UUID,p_witness_request_sha256 TEXT,p_work_order_id UUID,
  p_require_open BOOLEAN
) RETURNS public.universal_v1_change_order_materialization_commands
LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE SET search_path=pg_catalog AS $$
DECLARE
  witness public.universal_v1_change_order_materialization_commands%ROWTYPE;
  base_scope RECORD; replacement RECORD; context RECORD; context_before JSONB;
  witness_sha TEXT; lease_expires_at TIMESTAMPTZ; pass INTEGER; actor_ids UUID[]; reason TEXT;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation')<>'read committed' OR p_require_open IS NULL
    OR p_target_authority_id IS NULL OR p_proposal_id IS NULL OR p_work_order_id IS NULL
    OR p_recovery_lease_id IS NULL OR p_lease_owner_id IS NULL OR p_witness_request_sha256 IS NULL
    OR p_witness_request_sha256 !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'HXUV1-COWORKERADJUST-13-INPUT_INVALID'; END IF;
  PERFORM hx_authority.assert_fake_financial_outbox_target_v13(p_target_authority_id,p_target_database_name,p_release_environment,p_release_manifest_digest);
  IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('universal-v1-change-order-proposal:'||p_proposal_id::TEXT,0)) THEN
    RAISE EXCEPTION 'HXUV1-COWORKERADJUST-13-LOCK_BUSY'; END IF;
  SELECT * INTO witness FROM public.universal_v1_change_order_materialization_commands WHERE proposal_id=p_proposal_id FOR SHARE NOWAIT;
  IF witness.proposal_id IS NULL OR witness.work_order_id IS DISTINCT FROM p_work_order_id
    OR pg_catalog.btrim(witness.request_sha256) IS DISTINCT FROM p_witness_request_sha256 THEN
    RAISE EXCEPTION 'HXUV1-COWORKERADJUST-13-WITNESS_MISMATCH'; END IF;
    witness_sha:=public.universal_v1_change_order_materialization_request_sha256(
    witness.proposal_id,witness.idempotency_key,witness.actor_user_id,witness.work_order_id,
    witness.task_id,witness.task_draft_id,witness.eligibility_decision_id,
    witness.base_scope_version_id,witness.replacement_scope_version_id,
    witness.expected_proposal_version,witness.expected_scope_version,witness.expected_amendment_version,
    witness.expected_execution_version,witness.expected_financial_version,witness.predecessor_event_id,
    witness.predecessor_operation_id,witness.adjustment_operation_id);
  IF witness.request_sha256 IS DISTINCT FROM witness_sha
     OR witness.adjustment_operation_id IS DISTINCT FROM
       public.universal_v1_work_order_operation_id_v1(witness.idempotency_key,'adjust') THEN
    RAISE EXCEPTION 'HXUV1-COWORKERADJUST-13: CHANGE_ORDER_IDEMPOTENCY_CONFLICT';
  END IF;


  SELECT expires_at INTO lease_expires_at FROM public.universal_v1_change_order_recovery_leases
    WHERE proposal_id=p_proposal_id AND recovery_lease_id=p_recovery_lease_id AND lease_owner_id=p_lease_owner_id FOR SHARE NOWAIT;
  IF lease_expires_at IS NULL THEN RAISE EXCEPTION 'HXUV1-COWORKERADJUST-13-LEASE_MISMATCH'; END IF;
  IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('fulfillment:'||p_work_order_id::TEXT,0)) THEN
    RAISE EXCEPTION 'HXUV1-COWORKERADJUST-13-LOCK_BUSY'; END IF;
    SELECT s.id,s.task_id,s.version,s.universal_contract_version,s.currency,s.customer_total_cents INTO STRICT base_scope FROM public.task_scope_versions s WHERE s.id=witness.base_scope_version_id;
  SELECT s.id,s.task_id,s.version,s.universal_contract_version,s.currency,s.customer_total_cents,s.hustler_payout_cents,s.source,s.created_by,s.supersedes_version_id,s.scope_hash,s.title,s.description,s.requirements,s.checklist INTO STRICT replacement FROM public.task_scope_versions s WHERE s.id=witness.replacement_scope_version_id;
  -- Immutable scope evidence is checked on replay as well as first creation;
  -- current mutable proposal/approval authority is checked only for a new effect.
  IF base_scope.task_id IS DISTINCT FROM witness.task_id OR base_scope.version IS DISTINCT FROM witness.expected_scope_version
    OR base_scope.universal_contract_version IS DISTINCT FROM 1
    OR replacement.universal_contract_version IS DISTINCT FROM 1 OR replacement.task_id IS DISTINCT FROM witness.task_id
    OR replacement.version::BIGINT IS DISTINCT FROM witness.expected_scope_version::BIGINT+1
    OR replacement.supersedes_version_id IS DISTINCT FROM base_scope.id OR replacement.source IS DISTINCT FROM 'APPROVED_CHANGE'
    OR replacement.created_by IS DISTINCT FROM witness.actor_user_id
    OR replacement.customer_total_cents IS DISTINCT FROM witness.customer_total_cents
    OR replacement.hustler_payout_cents IS DISTINCT FROM witness.provider_payout_cents
    OR replacement.currency IS DISTINCT FROM witness.currency OR replacement.currency IS DISTINCT FROM base_scope.currency
    OR witness.customer_total_cents=base_scope.customer_total_cents OR witness.customer_total_cents<=0
    OR witness.provider_payout_cents<=0 OR witness.provider_payout_cents>witness.customer_total_cents
    OR replacement.scope_hash IS DISTINCT FROM public.universal_v1_change_scope_sha256(replacement.title,
      replacement.description,replacement.requirements,replacement.checklist,replacement.customer_total_cents,
      replacement.hustler_payout_cents,replacement.currency) THEN
    RAISE EXCEPTION 'HXUV1-COWORKERADJUST-13: CHANGE_ORDER_SCOPE_HASH_MISMATCH'; END IF;

  IF p_require_open THEN
          FOR pass IN 0..1 LOOP
        SELECT t.poster_id,t.business_organization_id AS customer_organization_id,
          w.provider_user_id,w.provider_organization_id,e.trade_credential_id,
          ca.actor_id AS customer_approval_actor_id,pa.actor_id AS provider_approval_actor_id INTO context
        FROM public.tasks t
        JOIN public.task_drafts d ON d.id=witness.task_draft_id AND d.task_id=t.id
        JOIN public.task_work_orders w ON w.id=witness.work_order_id AND w.task_id=t.id
          AND w.task_draft_id=d.id AND w.eligibility_decision_id=witness.eligibility_decision_id
        JOIN public.task_provider_eligibility_decisions e ON e.id=witness.eligibility_decision_id
        LEFT JOIN public.task_scope_change_approvals ca ON ca.proposal_id=p_proposal_id AND ca.approver_role='CUSTOMER'
        LEFT JOIN public.task_scope_change_approvals pa ON pa.proposal_id=p_proposal_id AND pa.approver_role='PROVIDER'
        WHERE t.id=witness.task_id AND t.work_order_id=w.id AND t.active_scope_version_id=witness.base_scope_version_id
          AND t.universal_contract_version=1 AND t.automation_classification='CONTROLLED_TEST'
          AND t.universal_payment_posture='PAYMENT_CREATION_FROZEN' AND t.worker_id IS NULL
          AND d.poster_user_id=t.poster_id AND d.claimed_at IS NOT NULL
          AND d.universal_contract_version=1 AND d.ingress_origin='BACKEND_POSTGRESQL';
        IF NOT FOUND THEN RAISE EXCEPTION 'HXUV1-COWORKERADJUST-13-CONTEXT_MISMATCH'; END IF;
        IF pass=1 THEN
          IF pg_catalog.to_jsonb(context) IS DISTINCT FROM context_before THEN
            RAISE EXCEPTION 'HXUV1-COWORKERADJUST-13-DEPENDENCY_CHANGED'; END IF;
          EXIT;
        END IF;
        context_before:=pg_catalog.to_jsonb(context);
        PERFORM 1 FROM public.task_work_orders WHERE id=witness.work_order_id FOR UPDATE NOWAIT;
        PERFORM 1 FROM public.tasks WHERE id=witness.task_id FOR UPDATE NOWAIT;
        PERFORM 1 FROM public.task_drafts WHERE id=witness.task_draft_id FOR SHARE NOWAIT;
        PERFORM 1 FROM public.task_scope_change_proposals WHERE id=p_proposal_id FOR UPDATE NOWAIT;
        PERFORM 1 FROM public.task_provider_eligibility_decisions WHERE id=witness.eligibility_decision_id FOR SHARE NOWAIT;
        PERFORM 1 FROM public.task_scope_versions WHERE id IN(witness.base_scope_version_id,witness.replacement_scope_version_id)
          ORDER BY id FOR SHARE NOWAIT;
        PERFORM 1 FROM public.task_scope_change_approvals WHERE proposal_id=p_proposal_id ORDER BY id FOR SHARE NOWAIT;
        SELECT pg_catalog.array_agg(id ORDER BY id) INTO actor_ids FROM (
          SELECT witness.actor_user_id AS id UNION SELECT context.poster_id UNION SELECT context.provider_user_id
          UNION SELECT context.customer_approval_actor_id UNION SELECT context.provider_approval_actor_id
        ) actors WHERE id IS NOT NULL;
        -- UPDATE blocks users FK KEY SHARE for newly inserted memberships.
        PERFORM 1 FROM public.users WHERE id=ANY(actor_ids) ORDER BY id FOR UPDATE NOWAIT;
        PERFORM 1 FROM public.business_organizations WHERE id IN(context.customer_organization_id,context.provider_organization_id)
          ORDER BY id FOR SHARE NOWAIT;
        PERFORM 1 FROM public.business_memberships
          WHERE organization_id IN(context.customer_organization_id,context.provider_organization_id) AND user_id=ANY(actor_ids)
          ORDER BY organization_id,user_id,id FOR SHARE NOWAIT;
        PERFORM 1 FROM public.capability_profiles WHERE user_id=context.provider_user_id ORDER BY user_id FOR SHARE NOWAIT;
        PERFORM 1 FROM public.business_credentials WHERE id=context.trade_credential_id FOR SHARE NOWAIT;
        PERFORM 1 FROM public.verified_trades WHERE user_id=context.provider_user_id
          AND provider_organization_id IS NOT DISTINCT FROM context.provider_organization_id
          AND business_credential_id IS NOT DISTINCT FROM context.trade_credential_id ORDER BY user_id,trade FOR SHARE NOWAIT;
      END LOOP;

    PERFORM 1 FROM public.task_financial_security_events f WHERE f.id=witness.predecessor_event_id FOR SHARE NOWAIT;
    reason:=public.universal_v1_change_order_recovery_revocation_reason_v1(p_proposal_id);
    IF reason IS NOT NULL THEN RAISE EXCEPTION 'HXUV1-COWORKERADJUST-13-AUTHORITY_REVOKED:%',reason; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.task_scope_versions s JOIN public.task_scope_change_proposals p ON p.id=witness.proposal_id
      WHERE s.id=witness.replacement_scope_version_id AND s.change_summary IS NOT DISTINCT FROM p.observed_scope_summary
        AND s.title IS NOT DISTINCT FROM p.proposed_title AND s.description IS NOT DISTINCT FROM p.proposed_description
        AND s.requirements IS NOT DISTINCT FROM p.proposed_requirements AND s.checklist IS NOT DISTINCT FROM p.proposed_checklist) THEN
      RAISE EXCEPTION 'HXUV1-COWORKERADJUST-13-PROPOSAL_SCOPE_MISMATCH'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.task_work_orders w
      JOIN public.task_provider_eligibility_decisions e ON e.id=w.eligibility_decision_id
      JOIN public.users provider ON provider.id=w.provider_user_id
      WHERE w.id=witness.work_order_id AND e.task_eligible IS TRUE AND e.provider_user_id=w.provider_user_id
        AND e.provider_organization_id IS NOT DISTINCT FROM w.provider_organization_id
        AND NOT(provider.trust_hold IS TRUE AND (provider.trust_hold_until IS NULL OR provider.trust_hold_until>pg_catalog.clock_timestamp())))
      OR NOT EXISTS(SELECT 1 FROM public.task_scope_change_approvals c JOIN public.task_scope_change_approvals p ON p.proposal_id=c.proposal_id
        WHERE c.proposal_id=witness.proposal_id AND c.approver_role='CUSTOMER' AND p.approver_role='PROVIDER'
          AND c.expected_proposal_version=witness.expected_proposal_version AND p.expected_proposal_version=witness.expected_proposal_version AND c.actor_id<>p.actor_id)
      OR NOT EXISTS(SELECT 1 FROM public.task_financial_security_events f WHERE f.id=witness.predecessor_event_id
        AND f.operation_id=witness.predecessor_operation_id::TEXT AND f.task_draft_id=witness.task_draft_id
        AND f.task_id=witness.task_id AND f.eligibility_decision_id=witness.eligibility_decision_id
        AND f.scope_version_id=witness.base_scope_version_id AND f.expected_version=witness.expected_financial_version
        AND f.provider_kind='FAKE' AND f.status='SUCCEEDED' AND f.event_kind IN ('SECURED','ADJUSTMENT_AUTHORIZED'))
      OR EXISTS(SELECT 1 FROM public.task_financial_security_events f WHERE f.task_draft_id=witness.task_draft_id AND f.expected_version>witness.expected_financial_version) THEN
      RAISE EXCEPTION 'HXUV1-COWORKERADJUST-13-CURRENT_AUTHORITY_MISMATCH'; END IF;
    IF lease_expires_at<=pg_catalog.clock_timestamp() OR NOT public.universal_v1_change_order_recovery_lease_is_active_v1(p_proposal_id,p_recovery_lease_id,p_lease_owner_id) THEN
      RAISE EXCEPTION 'HXUV1-COWORKERADJUST-13-LEASE_EXPIRED'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.task_drafts d WHERE d.id=witness.task_draft_id AND d.claimed_at IS NOT NULL
      AND d.ingress_origin='BACKEND_POSTGRESQL' AND d.universal_contract_version=1 AND d.task_id=witness.task_id)
      OR EXISTS(SELECT 1 FROM public.universal_v1_change_order_compensation_commands c WHERE c.work_order_id=witness.work_order_id)
      OR EXISTS(SELECT 1 FROM public.universal_v1_change_order_materialization_commands w
        JOIN public.universal_v1_change_order_recovery_terminal_facts t ON t.proposal_id=w.proposal_id
        WHERE w.work_order_id=witness.work_order_id AND t.outcome_state='CANCELLED')
      OR EXISTS(SELECT 1 FROM public.task_work_order_amendments a WHERE a.change_order_id=witness.proposal_id) THEN
      RAISE EXCEPTION 'HXUV1-COWORKERADJUST-13-RECOVERY_CLOSED'; END IF;
  END IF;
  RETURN witness;
EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION 'HXUV1-COWORKERADJUST-13-LOCK_BUSY';
END;
$$;

CREATE OR REPLACE FUNCTION public.hxos_prepare_worker_change_order_adjustment_v13(
  p_target_authority_id UUID,p_target_database_name TEXT,p_release_environment TEXT,p_release_manifest_digest TEXT,
  p_proposal_id UUID,p_recovery_lease_id UUID,p_lease_owner_id UUID,p_witness_request_sha256 TEXT,p_work_order_id UUID,
  p_canonical_provider_request TEXT
) RETURNS TABLE(prepared_command JSONB,idempotency_replayed BOOLEAN,worker_provenance JSONB,requested_command JSONB,canonical_provider_request TEXT,
  target_authority_id UUID,release_manifest_digest TEXT)
LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE SET search_path=pg_catalog AS $$
DECLARE
  witness public.universal_v1_change_order_materialization_commands%ROWTYPE;
  prepared public.universal_v1_prepared_financial_commands%ROWTYPE;
  command public.financial_provider_command_journal%ROWTYPE;
  provenance hx_authority.fake_financial_change_order_adjustment_preparations_v13%ROWTYPE;
  creator hx_authority.fake_financial_change_order_adjustment_preparations_v13%ROWTYPE;
  authenticated RECORD;
  original_target RECORD; queued RECORD; origin_target UUID; prepared_origin_target UUID; request_count BIGINT;
  request JSONB; payload JSONB; request_sha TEXT; lock_name TEXT; replay BOOLEAN:=FALSE;
  candidate JSONB; scenario TEXT; recovered_request TEXT;
BEGIN
  witness:=hx_authority.assert_worker_change_order_adjustment_v13(p_target_authority_id,p_target_database_name,p_release_environment,p_release_manifest_digest,
    p_proposal_id,p_recovery_lease_id,p_lease_owner_id,p_witness_request_sha256,p_work_order_id,FALSE);
  FOR lock_name IN SELECT value FROM pg_catalog.unnest(ARRAY[
    'draft-version:'||witness.task_draft_id::TEXT||':'||(witness.expected_financial_version::BIGINT+1)::TEXT,
    'idempotency:'||witness.idempotency_key||':adjust',
    'operation-version:FAKE:ADJUST:'||witness.adjustment_operation_id::TEXT||':0'
  ]) locks(value) ORDER BY value COLLATE "C" LOOP
    IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtext('universal-v1-prepared-financial-command-v1'),pg_catalog.hashtext(lock_name))
      OR NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtext('financial-provider-command-journal-v1'),pg_catalog.hashtext(lock_name)) THEN
      RAISE EXCEPTION 'HXUV1-COWORKERADJUST-13-LOCK_BUSY'; END IF;
  END LOOP;
  SELECT * INTO prepared FROM public.universal_v1_prepared_financial_commands p
    WHERE p.idempotency_key=witness.idempotency_key||':adjust'
      OR (p.provider_kind='FAKE' AND p.operation_kind='ADJUST' AND p.operation_id=witness.adjustment_operation_id AND p.provider_expected_version=0)
      OR (p.task_draft_id=witness.task_draft_id AND p.lifecycle_expected_version=witness.expected_financial_version::BIGINT+1)
    ORDER BY (p.idempotency_key=witness.idempotency_key||':adjust') DESC,p.prepared_command_id LIMIT 1;
  -- Recover the finite canonical FAKE request from the immutable witness and
  -- PREPARED digest. No missing scenario is silently replaced with SUCCESS.
  IF p_canonical_provider_request IS NULL THEN
    candidate:=pg_catalog.jsonb_build_object('amountCents',witness.customer_total_cents,'changeOrderId',witness.proposal_id,
      'currency',pg_catalog.lower(witness.currency),'expectedVersion',0,'idempotencyKey',witness.idempotency_key||':adjust',
      'operationId',witness.adjustment_operation_id,'relatedOperationId',witness.predecessor_operation_id,'scopeVersionId',witness.replacement_scope_version_id);
    FOREACH scenario IN ARRAY ARRAY['SUCCESS','DECLINE','TIMEOUT','RETRY',NULL]::TEXT[] LOOP
      request:=CASE WHEN scenario IS NULL THEN candidate ELSE candidate||pg_catalog.jsonb_build_object('scenario',scenario) END;
      SELECT '{'||pg_catalog.string_agg(pg_catalog.to_jsonb(e.key)::TEXT||':'||e.value::TEXT,',' ORDER BY e.key COLLATE "C")||'}'
        INTO recovered_request FROM pg_catalog.jsonb_each(request) e;
      IF prepared.prepared_command_id IS NULL OR pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(recovered_request,'UTF8')),'hex')=pg_catalog.btrim(prepared.provider_request_sha256) THEN
        p_canonical_provider_request:=recovered_request; EXIT;
      END IF;
    END LOOP;
    IF p_canonical_provider_request IS NULL THEN RAISE EXCEPTION 'HXUV1-COWORKERADJUST-13-EXACT_REQUEST_UNRECOVERABLE'; END IF;
  END IF;
  request:=hx_authority.parse_fake_financial_request_v13('ADJUST',p_canonical_provider_request);
  request_sha:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_canonical_provider_request,'UTF8')),'hex');
  IF request->>'operationId' IS DISTINCT FROM witness.adjustment_operation_id::TEXT
    OR request->>'scopeVersionId' IS DISTINCT FROM witness.replacement_scope_version_id::TEXT
    OR request->>'changeOrderId' IS DISTINCT FROM witness.proposal_id::TEXT
    OR request->>'idempotencyKey' IS DISTINCT FROM witness.idempotency_key||':adjust'
    OR request->>'expectedVersion' IS DISTINCT FROM '0'
    OR request->>'relatedOperationId' IS DISTINCT FROM witness.predecessor_operation_id::TEXT
    OR (request->>'amountCents')::BIGINT IS DISTINCT FROM witness.customer_total_cents
    OR request->>'currency' IS DISTINCT FROM pg_catalog.lower(witness.currency) THEN
    RAISE EXCEPTION 'HXUV1-COWORKERADJUST-13-REQUEST_MISMATCH'; END IF;
  payload:=pg_catalog.jsonb_build_object('operationKind','ADJUST','operationId',witness.adjustment_operation_id,'providerKind','FAKE',
    'idempotencyKey',witness.idempotency_key||':adjust','providerExpectedVersion',0,'lifecycleExpectedVersion',witness.expected_financial_version::BIGINT+1,
    'providerRequestSha256',request_sha,'taskDraftId',witness.task_draft_id,'taskId',witness.task_id,'eligibilityDecisionId',witness.eligibility_decision_id,
    'scopeVersionId',witness.replacement_scope_version_id,'changeOrderId',witness.proposal_id,'predecessorEventId',witness.predecessor_event_id,
    'completionFactId',NULL,'relatedOperationId',witness.predecessor_operation_id,'amountCents',witness.customer_total_cents,'currency',witness.currency);
  IF prepared.prepared_command_id IS NOT NULL THEN
    replay:=TRUE;
    IF prepared.command_state IS DISTINCT FROM 'PREPARED' OR prepared.operation_kind IS DISTINCT FROM 'ADJUST' OR prepared.event_kind IS DISTINCT FROM 'ADJUSTMENT_AUTHORIZED'
      OR prepared.provider_kind IS DISTINCT FROM 'FAKE' OR prepared.provider_expected_version IS DISTINCT FROM 0
      OR prepared.operation_id IS DISTINCT FROM witness.adjustment_operation_id OR prepared.idempotency_key IS DISTINCT FROM witness.idempotency_key||':adjust'
      OR prepared.lifecycle_expected_version IS DISTINCT FROM witness.expected_financial_version::BIGINT+1
      OR pg_catalog.btrim(prepared.provider_request_sha256) IS DISTINCT FROM request_sha
      OR prepared.task_draft_id IS DISTINCT FROM witness.task_draft_id OR prepared.task_id IS DISTINCT FROM witness.task_id
      OR prepared.work_order_id IS DISTINCT FROM witness.work_order_id OR prepared.eligibility_decision_id IS DISTINCT FROM witness.eligibility_decision_id
      OR prepared.scope_version_id IS DISTINCT FROM witness.replacement_scope_version_id OR prepared.scope_version IS DISTINCT FROM witness.expected_scope_version+1
      OR prepared.change_order_id IS DISTINCT FROM witness.proposal_id OR prepared.change_order_version IS DISTINCT FROM witness.expected_proposal_version
      OR prepared.predecessor_event_id IS DISTINCT FROM witness.predecessor_event_id OR prepared.predecessor_operation_id IS DISTINCT FROM witness.predecessor_operation_id
      OR prepared.related_operation_id IS DISTINCT FROM witness.predecessor_operation_id OR prepared.completion_fact_id IS NOT NULL
      OR prepared.amount_cents IS DISTINCT FROM witness.customer_total_cents OR prepared.currency IS DISTINCT FROM witness.currency
      OR prepared.recorded_by IS DISTINCT FROM witness.actor_user_id THEN
      RAISE EXCEPTION 'HXUV1-COWORKERADJUST-13-PREPARED_IDENTITY_MISMATCH'; END IF;
    SELECT a.prepared_command_id,a.actor_user_id,a.target_authority_id,a.release_manifest_sha256,a.command_payload
      INTO authenticated FROM hx_authority.fake_financial_preparation_authority_v13 a WHERE a.prepared_command_id=prepared.prepared_command_id;
    SELECT * INTO creator FROM hx_authority.fake_financial_change_order_adjustment_preparations_v13 o WHERE o.prepared_command_id=prepared.prepared_command_id AND o.created_prepared;
    IF authenticated.prepared_command_id IS NOT NULL THEN
      IF authenticated.actor_user_id IS DISTINCT FROM witness.actor_user_id OR authenticated.command_payload IS DISTINCT FROM payload
        OR creator.preparation_origin_id IS NOT NULL THEN RAISE EXCEPTION 'HXUV1-COWORKERADJUST-13-PREPARED_ORIGIN_MISMATCH'; END IF;
      origin_target:=authenticated.target_authority_id;
    ELSIF creator.preparation_origin_id IS NOT NULL THEN
      IF creator.proposal_id IS DISTINCT FROM witness.proposal_id OR creator.witness_request_sha256 IS DISTINCT FROM p_witness_request_sha256
        OR creator.provider_request_sha256 IS DISTINCT FROM request_sha OR creator.prepared_authority_sha256 IS DISTINCT FROM pg_catalog.btrim(prepared.authority_context_sha256) THEN
        RAISE EXCEPTION 'HXUV1-COWORKERADJUST-13-PREPARED_ORIGIN_MISMATCH'; END IF;
      origin_target:=creator.target_authority_id;
    ELSE RAISE EXCEPTION 'HXUV1-COWORKERADJUST-13-UNAUTHENTICATED_HISTORY'; END IF;
    prepared_origin_target:=origin_target;
    SELECT * INTO original_target FROM hx_authority.universal_v1_work_order_target_authority_facts t WHERE t.target_authority_id=origin_target;
    IF original_target.target_database_name IS DISTINCT FROM p_target_database_name OR original_target.environment IS DISTINCT FROM p_release_environment
      OR original_target.release_manifest_sha256 IS DISTINCT FROM COALESCE(authenticated.release_manifest_sha256,creator.release_manifest_sha256)
      OR NOT EXISTS(WITH RECURSIVE lineage AS (
 SELECT t.target_authority_id,t.supersedes_target_authority_id FROM hx_authority.universal_v1_work_order_target_authority_facts t WHERE t.target_authority_id=p_target_authority_id
 UNION SELECT t.target_authority_id,t.supersedes_target_authority_id FROM hx_authority.universal_v1_work_order_target_authority_facts t JOIN lineage l ON t.target_authority_id=l.supersedes_target_authority_id
) SELECT 1 FROM lineage WHERE lineage.target_authority_id=origin_target) THEN RAISE EXCEPTION 'HXUV1-COWORKERADJUST-13-HISTORICAL_TARGET_MISMATCH'; END IF;
    SELECT * INTO provenance FROM hx_authority.fake_financial_change_order_adjustment_preparations_v13 o
      WHERE o.prepared_command_id=prepared.prepared_command_id AND o.target_authority_id=p_target_authority_id AND o.recovery_lease_id=p_recovery_lease_id;
    IF provenance.preparation_origin_id IS NOT NULL AND (provenance.proposal_id IS DISTINCT FROM witness.proposal_id
      OR provenance.lease_owner_id IS DISTINCT FROM p_lease_owner_id OR provenance.witness_request_sha256 IS DISTINCT FROM p_witness_request_sha256
      OR provenance.provider_request_sha256 IS DISTINCT FROM request_sha OR provenance.prepared_authority_sha256 IS DISTINCT FROM pg_catalog.btrim(prepared.authority_context_sha256)
      OR provenance.release_manifest_sha256 IS DISTINCT FROM p_release_manifest_digest
      OR NOT EXISTS(SELECT 1 FROM public.universal_v1_change_order_recovery_leases l WHERE l.recovery_lease_id=provenance.recovery_lease_id
        AND l.proposal_id=witness.proposal_id AND l.lease_owner_id=provenance.lease_owner_id AND provenance.recorded_at>=l.acquired_at AND provenance.recorded_at<l.expires_at)) THEN
      RAISE EXCEPTION 'HXUV1-COWORKERADJUST-13-CONTINUATION_MISMATCH'; END IF;
    SELECT count(*) INTO request_count FROM public.financial_provider_command_journal j WHERE j.prepared_financial_command_id=prepared.prepared_command_id;
    IF request_count>1 THEN RAISE EXCEPTION 'HXUV1-COWORKERADJUST-13-REQUESTED_CARDINALITY'; END IF;
    SELECT * INTO command FROM public.financial_provider_command_journal j WHERE j.prepared_financial_command_id=prepared.prepared_command_id;
    IF command.command_id IS NOT NULL THEN
      SELECT * INTO queued FROM hx_authority.fake_financial_command_outbox_requests_v13 q WHERE q.command_id=command.command_id;
      origin_target:=queued.target_authority_id;
      SELECT * INTO original_target FROM hx_authority.universal_v1_work_order_target_authority_facts t WHERE t.target_authority_id=origin_target;
      IF queued.command_id IS NULL OR queued.target_database_name IS DISTINCT FROM p_target_database_name
        OR queued.release_environment IS DISTINCT FROM p_release_environment OR queued.release_manifest_digest IS DISTINCT FROM command.release_manifest_digest
        OR original_target.target_database_name IS DISTINCT FROM p_target_database_name OR original_target.environment IS DISTINCT FROM p_release_environment
        OR original_target.release_manifest_sha256 IS DISTINCT FROM queued.release_manifest_digest
        OR queued.prepared_command_id IS DISTINCT FROM prepared.prepared_command_id
        OR queued.command_identity_sha256 IS DISTINCT FROM command.command_identity_sha256
        OR command.command_state IS DISTINCT FROM 'REQUESTED' OR command.provider_kind IS DISTINCT FROM 'FAKE'
        OR command.provider_expected_version IS DISTINCT FROM 0 OR command.idempotency_key IS DISTINCT FROM witness.idempotency_key||':adjust'
        OR command.task_draft_id IS DISTINCT FROM witness.task_draft_id OR command.task_id IS DISTINCT FROM witness.task_id
        OR command.work_order_id IS DISTINCT FROM witness.work_order_id OR command.related_operation_id IS DISTINCT FROM witness.predecessor_operation_id
        OR command.amount_cents IS DISTINCT FROM witness.customer_total_cents OR command.currency IS DISTINCT FROM witness.currency
        OR command.operation_id IS DISTINCT FROM witness.adjustment_operation_id OR command.operation_kind IS DISTINCT FROM 'ADJUST'
        OR pg_catalog.btrim(command.request_sha256) IS DISTINCT FROM request_sha
        OR pg_catalog.btrim(command.prepared_authority_sha256) IS DISTINCT FROM pg_catalog.btrim(prepared.authority_context_sha256)
        OR command.recorded_actor_id IS DISTINCT FROM witness.actor_user_id OR command.recorded_actor_kind IS DISTINCT FROM 'PARTICIPANT'
        OR NOT EXISTS(SELECT 1 FROM hx_authority.fake_financial_exact_requests_v13 e WHERE e.command_id=command.command_id
          AND e.canonical_provider_request=p_canonical_provider_request AND e.provider_request_sha256=request_sha)
        OR NOT EXISTS(WITH RECURSIVE lineage AS (
 SELECT t.target_authority_id,t.supersedes_target_authority_id FROM hx_authority.universal_v1_work_order_target_authority_facts t WHERE t.target_authority_id=p_target_authority_id
 UNION SELECT t.target_authority_id,t.supersedes_target_authority_id FROM hx_authority.universal_v1_work_order_target_authority_facts t JOIN lineage l ON t.target_authority_id=l.supersedes_target_authority_id
) SELECT 1 FROM lineage WHERE lineage.target_authority_id=origin_target) OR NOT EXISTS(WITH RECURSIVE lineage AS (
 SELECT t.target_authority_id,t.supersedes_target_authority_id FROM hx_authority.universal_v1_work_order_target_authority_facts t WHERE t.target_authority_id=queued.target_authority_id
 UNION SELECT t.target_authority_id,t.supersedes_target_authority_id FROM hx_authority.universal_v1_work_order_target_authority_facts t JOIN lineage l ON t.target_authority_id=l.supersedes_target_authority_id
) SELECT 1 FROM lineage WHERE lineage.target_authority_id=prepared_origin_target)
        OR (queued.target_authority_id IS DISTINCT FROM prepared_origin_target AND NOT EXISTS(
          SELECT 1 FROM hx_authority.fake_financial_change_order_adjustment_preparations_v13 o
          WHERE o.prepared_command_id=prepared.prepared_command_id AND o.target_authority_id=queued.target_authority_id
            AND o.release_manifest_sha256=queued.release_manifest_digest AND o.provider_request_sha256=request_sha
            AND o.prepared_authority_sha256=pg_catalog.btrim(prepared.authority_context_sha256) AND o.recorded_at<=command.recorded_at)) THEN
        RAISE EXCEPTION 'HXUV1-COWORKERADJUST-13-REQUESTED_IDENTITY_MISMATCH'; END IF;
    END IF;
  END IF;
  -- An existing request is an immutable read. A new continuation needs current
  -- authority; an exact existing continuation can be read after lease expiry.
  IF command.command_id IS NULL AND provenance.preparation_origin_id IS NULL THEN
    PERFORM hx_authority.assert_worker_change_order_adjustment_v13(p_target_authority_id,p_target_database_name,p_release_environment,p_release_manifest_digest,
      p_proposal_id,p_recovery_lease_id,p_lease_owner_id,p_witness_request_sha256,p_work_order_id,TRUE);
    IF NOT replay THEN
      SELECT * INTO STRICT prepared FROM public.hxos_prepare_universal_v1_financial_command_v1(
        pg_catalog.gen_random_uuid(),'ADJUST',witness.adjustment_operation_id,'FAKE',witness.idempotency_key||':adjust',0::BIGINT,
        witness.expected_financial_version::BIGINT+1,request_sha,witness.task_draft_id,witness.task_id,witness.eligibility_decision_id,
        witness.replacement_scope_version_id,witness.proposal_id,witness.predecessor_event_id,NULL,witness.predecessor_operation_id,
        witness.customer_total_cents,witness.currency,witness.actor_user_id);
    END IF;
    INSERT INTO hx_authority.fake_financial_change_order_adjustment_preparations_v13(prepared_command_id,proposal_id,recovery_lease_id,lease_owner_id,
      witness_request_sha256,target_authority_id,release_manifest_sha256,service_database_role,provider_request_sha256,prepared_authority_sha256,created_prepared)
    VALUES(prepared.prepared_command_id,p_proposal_id,p_recovery_lease_id,p_lease_owner_id,p_witness_request_sha256,p_target_authority_id,
      p_release_manifest_digest,SESSION_USER,request_sha,pg_catalog.btrim(prepared.authority_context_sha256),NOT replay) RETURNING * INTO provenance;
    PERFORM hx_authority.assert_worker_change_order_adjustment_v13(p_target_authority_id,p_target_database_name,p_release_environment,p_release_manifest_digest,
      p_proposal_id,p_recovery_lease_id,p_lease_owner_id,p_witness_request_sha256,p_work_order_id,TRUE);
  END IF;
  prepared_command:=pg_catalog.to_jsonb(prepared);idempotency_replayed:=replay;
  worker_provenance:=CASE WHEN provenance.preparation_origin_id IS NULL THEN NULL ELSE pg_catalog.to_jsonb(provenance) END;
  requested_command:=CASE WHEN command.command_id IS NULL THEN NULL ELSE pg_catalog.to_jsonb(command) END;
  canonical_provider_request:=p_canonical_provider_request;
  target_authority_id:=p_target_authority_id;release_manifest_digest:=p_release_manifest_digest;RETURN NEXT;
EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION 'HXUV1-COWORKERADJUST-13-LOCK_BUSY';
END;
$$;

CREATE OR REPLACE FUNCTION hx_authority.assert_worker_change_order_adjustment_request_v13(p_prepared_id UUID,p_target_id UUID,p_manifest TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE SET search_path=pg_catalog AS $$
DECLARE origin hx_authority.fake_financial_change_order_adjustment_preparations_v13%ROWTYPE;
  prepared public.universal_v1_prepared_financial_commands%ROWTYPE; target RECORD; candidate_count BIGINT;
BEGIN
  SELECT count(*) INTO candidate_count FROM hx_authority.fake_financial_change_order_adjustment_preparations_v13 o
    JOIN public.universal_v1_change_order_recovery_leases l ON l.recovery_lease_id=o.recovery_lease_id AND l.proposal_id=o.proposal_id AND l.lease_owner_id=o.lease_owner_id
    WHERE o.prepared_command_id=p_prepared_id AND o.target_authority_id=p_target_id AND o.release_manifest_sha256=p_manifest
      AND o.service_database_role=SESSION_USER AND l.expires_at>pg_catalog.clock_timestamp();
  IF candidate_count<>1 THEN RAISE EXCEPTION 'HXUV1-COWORKERADJUST-13-ACTIVE_CONTINUATION_REQUIRED'; END IF;
  SELECT o.* INTO STRICT origin FROM hx_authority.fake_financial_change_order_adjustment_preparations_v13 o
    JOIN public.universal_v1_change_order_recovery_leases l ON l.recovery_lease_id=o.recovery_lease_id AND l.proposal_id=o.proposal_id AND l.lease_owner_id=o.lease_owner_id
    WHERE o.prepared_command_id=p_prepared_id AND o.target_authority_id=p_target_id AND o.release_manifest_sha256=p_manifest
      AND o.service_database_role=SESSION_USER AND l.expires_at>pg_catalog.clock_timestamp();
  SELECT * INTO prepared FROM public.universal_v1_prepared_financial_commands WHERE prepared_command_id=p_prepared_id;
  SELECT * INTO target FROM hx_authority.universal_v1_work_order_target_authority_facts WHERE target_authority_id=p_target_id;
  IF prepared.operation_kind IS DISTINCT FROM 'ADJUST' OR origin.provider_request_sha256 IS DISTINCT FROM pg_catalog.btrim(prepared.provider_request_sha256)
    OR origin.prepared_authority_sha256 IS DISTINCT FROM pg_catalog.btrim(prepared.authority_context_sha256)
    OR origin.proposal_id IS DISTINCT FROM prepared.change_order_id THEN RAISE EXCEPTION 'HXUV1-COWORKERADJUST-13-CONTINUATION_MISMATCH'; END IF;
  PERFORM hx_authority.assert_worker_change_order_adjustment_v13(p_target_id,pg_catalog.current_database(),target.environment,p_manifest,
    origin.proposal_id,origin.recovery_lease_id,origin.lease_owner_id,origin.witness_request_sha256,prepared.work_order_id,TRUE);
  RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION hx_authority.validate_fake_financial_outbox_request_v13()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
DECLARE
  command_record RECORD;
  prepared_record RECORD;
  target_record RECORD;
  expected_job_authority_sha256 CHAR(64);
  expected_bullmq_job_id TEXT;
BEGIN
  SELECT command.command_state,
         command.operation_kind,
         command.operation_id,
         command.provider_kind,
         command.idempotency_key,
         command.provider_expected_version,
         command.request_sha256,
         command.command_identity_sha256,
         command.prepared_financial_command_id,
         command.prepared_authority_sha256,
         command.release_manifest_digest,
         command.release_id,
         command.release_revision,
         command.release_environment,
         command.release_authentication_status
    INTO command_record
    FROM public.financial_provider_command_journal command
   WHERE command.command_id = NEW.command_id
   FOR SHARE;

  SELECT prepared.command_state,
         prepared.operation_kind,
         prepared.operation_id,
         prepared.provider_kind,
         prepared.idempotency_key,
         prepared.provider_expected_version,
         prepared.provider_request_sha256,
         prepared.authority_context_sha256
    INTO prepared_record
    FROM public.universal_v1_prepared_financial_commands prepared
   WHERE prepared.prepared_command_id = NEW.prepared_command_id
   FOR SHARE;

  SELECT target.authority_version,
         target.target_database_name,
         target.environment,
         target.release_manifest_sha256
    INTO target_record
    FROM hx_authority.universal_v1_work_order_target_authority_facts target
   WHERE target.target_authority_id = NEW.target_authority_id
   FOR SHARE;

  PERFORM hx_authority.assert_fake_financial_outbox_target_v13(
    NEW.target_authority_id,
    NEW.target_database_name,
    NEW.release_environment,
    NEW.release_manifest_digest
  );

  -- ADJUST creation must observe a terminal committed while target acquisition
  -- was waiting. Exact existing REQUESTED replay does not enter this trigger.
  IF prepared_record.operation_kind='ADJUST' THEN
    IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN
      RAISE EXCEPTION 'HXUV1-COTERMINAL-13-ADJUST_REQUEST_READ_COMMITTED_REQUIRED'; END IF;
    IF EXISTS(SELECT 1 FROM public.universal_v1_prepared_financial_commands p
      JOIN public.universal_v1_change_order_materialization_commands w ON w.work_order_id=p.work_order_id
      JOIN public.universal_v1_change_order_recovery_terminal_facts t ON t.proposal_id=w.proposal_id
      WHERE p.prepared_command_id=NEW.prepared_command_id AND w.work_order_id=p.work_order_id
        AND t.outcome_state='CANCELLED') THEN
      RAISE EXCEPTION 'HXUV1-COTERMINAL-13-ADJUST_REQUEST_CANCELLED'; END IF;
  END IF;

  -- A worker cannot use retained API provenance to bypass its recovery lease.
  IF prepared_record.operation_kind='ADJUST' AND EXISTS(SELECT 1 FROM pg_catalog.pg_proc f CROSS JOIN LATERAL pg_catalog.aclexplode(f.proacl) a JOIN pg_catalog.pg_roles caller ON caller.oid=a.grantee WHERE f.oid='public.hxos_prepare_worker_change_order_adjustment_v13(uuid,text,text,text,uuid,uuid,uuid,text,uuid,text)'::pg_catalog.regprocedure AND caller.rolname=SESSION_USER AND a.grantee<>f.proowner) THEN
    PERFORM hx_authority.assert_worker_change_order_adjustment_request_v13(NEW.prepared_command_id,NEW.target_authority_id,NEW.release_manifest_digest);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM hx_authority.fake_financial_preparation_authority_v13 provenance
    JOIN public.universal_v1_prepared_financial_commands prepared
      ON prepared.prepared_command_id = provenance.prepared_command_id
    JOIN public.financial_provider_command_journal command
      ON command.command_id = NEW.command_id
    WHERE provenance.prepared_command_id = NEW.prepared_command_id
      AND provenance.actor_user_id = prepared.recorded_by
      AND provenance.actor_user_id = command.recorded_actor_id
      AND command.recorded_actor_kind = 'PARTICIPANT'
      AND provenance.target_authority_id = NEW.target_authority_id
      AND provenance.release_manifest_sha256 = NEW.release_manifest_digest
      AND NOT EXISTS(SELECT 1 FROM public.universal_v1_change_order_compensation_commands c
        JOIN hx_authority.fake_financial_change_order_compensation_origins_v13 o USING(compensation_command_id)
        WHERE c.reversal_operation_id=prepared.operation_id AND prepared.operation_kind='REVERSAL')
  ) AND NOT EXISTS (
    SELECT 1 FROM hx_authority.fake_financial_change_order_reversal_preparations_v13 provenance
    JOIN public.universal_v1_prepared_financial_commands prepared ON prepared.prepared_command_id=provenance.prepared_command_id
    JOIN public.financial_provider_command_journal command ON command.command_id=NEW.command_id
    JOIN public.universal_v1_change_order_compensation_commands compensation ON compensation.compensation_command_id=provenance.compensation_command_id
    WHERE provenance.prepared_command_id=NEW.prepared_command_id AND provenance.service_database_role=SESSION_USER
      AND provenance.target_authority_id=NEW.target_authority_id AND provenance.release_manifest_sha256=NEW.release_manifest_digest
      AND provenance.provider_request_sha256=command.request_sha256 AND provenance.prepared_authority_sha256=command.prepared_authority_sha256
      AND prepared.recorded_by=compensation.requested_by AND command.recorded_actor_id=compensation.requested_by
      AND command.recorded_actor_kind='PARTICIPANT' AND prepared.operation_kind='REVERSAL'
      AND prepared.operation_id=compensation.reversal_operation_id
  ) AND NOT EXISTS (
    SELECT 1 FROM hx_authority.fake_financial_change_order_adjustment_preparations_v13 provenance
    JOIN public.universal_v1_prepared_financial_commands prepared ON prepared.prepared_command_id=provenance.prepared_command_id
    JOIN public.financial_provider_command_journal command ON command.command_id=NEW.command_id
    WHERE provenance.prepared_command_id=NEW.prepared_command_id AND provenance.service_database_role=SESSION_USER
      AND provenance.target_authority_id=NEW.target_authority_id AND provenance.release_manifest_sha256=NEW.release_manifest_digest
      AND provenance.provider_request_sha256=command.request_sha256 AND provenance.prepared_authority_sha256=command.prepared_authority_sha256
      AND prepared.operation_kind='ADJUST' AND prepared.change_order_id=provenance.proposal_id
      AND prepared.recorded_by=command.recorded_actor_id AND command.recorded_actor_kind='PARTICIPANT'
      AND EXISTS(SELECT 1 FROM pg_catalog.pg_proc f CROSS JOIN LATERAL pg_catalog.aclexplode(f.proacl) a JOIN pg_catalog.pg_roles caller ON caller.oid=a.grantee WHERE f.oid='public.hxos_prepare_worker_change_order_adjustment_v13(uuid,text,text,text,uuid,uuid,uuid,text,uuid,text)'::pg_catalog.regprocedure AND caller.rolname=SESSION_USER AND a.grantee<>f.proowner)
  ) THEN RAISE EXCEPTION 'HXUV1-FINREQ-13-AUTHENTICATED_PREPARATION_REQUIRED'; END IF;

  IF command_record.command_state IS DISTINCT FROM 'REQUESTED'
     OR command_record.provider_kind IS DISTINCT FROM 'FAKE'
     OR command_record.release_authentication_status IS DISTINCT FROM 'VERIFIED'
     OR command_record.release_environment NOT IN ('local', 'preview', 'staging')
     OR prepared_record.command_state IS DISTINCT FROM 'PREPARED'
     OR prepared_record.provider_kind IS DISTINCT FROM 'FAKE'
     OR command_record.prepared_financial_command_id IS DISTINCT FROM
          NEW.prepared_command_id
     OR command_record.prepared_authority_sha256 IS DISTINCT FROM
          prepared_record.authority_context_sha256
     OR command_record.request_sha256 IS DISTINCT FROM
          prepared_record.provider_request_sha256
     OR command_record.operation_kind IS DISTINCT FROM prepared_record.operation_kind
     OR command_record.operation_id IS DISTINCT FROM prepared_record.operation_id
     OR command_record.idempotency_key IS DISTINCT FROM prepared_record.idempotency_key
     OR command_record.provider_expected_version IS DISTINCT FROM
          prepared_record.provider_expected_version
     OR NEW.prepared_state IS DISTINCT FROM prepared_record.command_state
     OR NEW.command_state IS DISTINCT FROM command_record.command_state
     OR NEW.provider_kind IS DISTINCT FROM command_record.provider_kind
     OR NEW.operation_kind IS DISTINCT FROM command_record.operation_kind
     OR NEW.operation_id IS DISTINCT FROM command_record.operation_id
     OR NEW.idempotency_key IS DISTINCT FROM command_record.idempotency_key
     OR NEW.provider_expected_version IS DISTINCT FROM
          command_record.provider_expected_version
     OR NEW.provider_request_sha256 IS DISTINCT FROM command_record.request_sha256
     OR NEW.command_identity_sha256 IS DISTINCT FROM
          command_record.command_identity_sha256
     OR NEW.prepared_authority_sha256 IS DISTINCT FROM
          prepared_record.authority_context_sha256
     OR NEW.release_manifest_digest IS DISTINCT FROM
          command_record.release_manifest_digest
     OR NEW.release_id IS DISTINCT FROM command_record.release_id
     OR NEW.release_revision IS DISTINCT FROM command_record.release_revision
     OR NEW.release_environment IS DISTINCT FROM command_record.release_environment
     OR NEW.target_authority_version IS DISTINCT FROM target_record.authority_version
     OR NEW.target_database_name IS DISTINCT FROM target_record.target_database_name
     OR NEW.release_environment IS DISTINCT FROM target_record.environment
     OR NEW.release_manifest_digest IS DISTINCT FROM
          target_record.release_manifest_sha256 THEN
    RAISE EXCEPTION
      'HXUV1-FINOUT-13-8: outbox request lacks exact PREPARED/REQUESTED/target authority'
      USING ERRCODE = 'P0001';
  END IF;

  expected_job_authority_sha256 := hx_authority.fake_financial_job_digest_v13(
    ARRAY[
      'HXUV1_FAKE_FINANCIAL_BULLMQ_JOB_V13',
      NEW.outbox_request_id::TEXT,
      NEW.command_id::TEXT,
      NEW.prepared_command_id::TEXT,
      NEW.target_authority_id::TEXT,
      NEW.target_authority_version::TEXT,
      NEW.target_database_name,
      NEW.release_environment,
      NEW.release_manifest_digest,
      NEW.release_id,
      pg_catalog.btrim(NEW.release_revision),
      NEW.operation_kind,
      NEW.operation_id::TEXT,
      NEW.idempotency_key,
      NEW.provider_expected_version::TEXT,
      pg_catalog.btrim(NEW.provider_request_sha256),
      pg_catalog.btrim(NEW.command_identity_sha256),
      pg_catalog.btrim(NEW.prepared_authority_sha256),
      NEW.queue_name,
      NEW.job_name,
      NEW.payload_contract_version::TEXT
    ]::TEXT[]
  );
  expected_bullmq_job_id := 'hx-fake-fin-'
    || pg_catalog.replace(NEW.command_id::TEXT, '-', '')
    || '-' || pg_catalog.btrim(expected_job_authority_sha256);
  IF NEW.job_authority_sha256 IS DISTINCT FROM expected_job_authority_sha256
     OR NEW.bullmq_job_id IS DISTINCT FROM expected_bullmq_job_id THEN
    RAISE EXCEPTION
      'HXUV1-FINOUT-13-9: deterministic BullMQ job identity mismatch'
      USING ERRCODE = 'P0001';
  END IF;

  NEW.requested_at := pg_catalog.clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION hx_authority.require_worker_change_order_adjustment_request_v13()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE SET search_path=pg_catalog AS $$
DECLARE queued RECORD;
BEGIN
 IF NEW.operation_kind='ADJUST' AND EXISTS(SELECT 1 FROM pg_catalog.pg_proc f CROSS JOIN LATERAL pg_catalog.aclexplode(f.proacl) a JOIN pg_catalog.pg_roles caller ON caller.oid=a.grantee WHERE f.oid='public.hxos_prepare_worker_change_order_adjustment_v13(uuid,text,text,text,uuid,uuid,uuid,text,uuid,text)'::pg_catalog.regprocedure AND caller.rolname=SESSION_USER AND a.grantee<>f.proowner) THEN
   SELECT q.target_authority_id,q.release_manifest_digest INTO STRICT queued FROM hx_authority.fake_financial_command_outbox_requests_v13 q WHERE q.command_id=NEW.command_id;
   PERFORM hx_authority.assert_worker_change_order_adjustment_request_v13(NEW.prepared_financial_command_id,queued.target_authority_id,queued.release_manifest_digest);
 END IF;
 RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER require_worker_change_order_adjustment_request_v13
AFTER INSERT ON public.financial_provider_command_journal DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION hx_authority.require_worker_change_order_adjustment_request_v13();

DO $$ DECLARE f TEXT; grantee TEXT; permission RECORD; BEGIN
 FOREACH f IN ARRAY ARRAY['public.hxos_prepare_worker_change_order_adjustment_v13(uuid,text,text,text,uuid,uuid,uuid,text,uuid,text)','hx_authority.assert_worker_change_order_adjustment_v13(uuid,text,text,text,uuid,uuid,uuid,text,uuid,boolean)','hx_authority.assert_worker_change_order_adjustment_request_v13(uuid,uuid,text)','hx_authority.require_worker_change_order_adjustment_request_v13()'] LOOP
  FOR grantee IN SELECT DISTINCT CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(r.rolname) END
   FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
   LEFT JOIN pg_catalog.pg_roles r ON r.oid=a.grantee WHERE p.oid=f::pg_catalog.regprocedure AND a.grantee<>p.proowner LOOP
   EXECUTE 'REVOKE ALL ON FUNCTION '||f||' FROM '||grantee||' CASCADE';
  END LOOP;
 END LOOP;
 FOR permission IN SELECT a.grantee FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
  WHERE c.oid='hx_authority.fake_financial_change_order_adjustment_preparations_v13'::pg_catalog.regclass AND a.grantee<>c.relowner LOOP
  grantee:=CASE WHEN permission.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(permission.grantee)) END;
  EXECUTE 'REVOKE ALL ON TABLE hx_authority.fake_financial_change_order_adjustment_preparations_v13 FROM '||grantee||' CASCADE';
 END LOOP;
END $$;
