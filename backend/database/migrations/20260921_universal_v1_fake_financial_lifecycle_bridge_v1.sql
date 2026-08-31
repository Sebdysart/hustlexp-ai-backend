-- Universal V1 fake financial lifecycle materialization bridge v1.
--
-- This migration closes the nonproduction evidence gap between a committed
-- PREPARED lifecycle command, its committed REQUESTED journal fact, the latest
-- DISPATCH_ATTEMPTED fact, a terminal observed provider outcome, the exact raw
-- fake-provider event, and the resulting lifecycle event. It is additive and
-- fake-only. It grants no provider, payment, assignment, deployment, or
-- production capability. APPROVED_PROVIDER remains deliberately unsupported.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- This bridge joins canonical lifecycle facts to the separately installed
-- nonproduction fake-provider store. It therefore belongs after both the
-- ordered engine migration chain and fake-provider v3; it must never be placed
-- in the production engine registry where the hxos_* tables do not exist.
DO $$
BEGIN
  IF to_regclass('public.hxos_fake_financial_operations_v1') IS NULL
     OR to_regclass('public.hxos_fake_financial_operation_events_v1') IS NULL
     OR to_regclass('public.hxos_fake_financial_schema_evidence_v3') IS NULL
     OR to_regclass('public.task_work_order_command_requests') IS NULL
     OR to_regclass('public.universal_v1_prepared_financial_commands') IS NULL
     OR to_regclass('public.financial_provider_command_journal') IS NULL
     OR to_regclass('public.financial_provider_command_dispatch_attempts') IS NULL
     OR to_regclass('public.financial_provider_command_outcome_facts') IS NULL
     OR to_regclass('public.task_financial_security_events') IS NULL THEN
    RAISE EXCEPTION 'HXUV1-FLB-0: canonical engine chain and nonproduction fake-provider v3 must be installed first'
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS public.hxos_fake_financial_schema_evidence_v4 (
  migration_name TEXT PRIMARY KEY CHECK (
    migration_name = '20260921_universal_v1_fake_financial_lifecycle_bridge_v1'
  ),
  migration_sql_sha256 CHAR(64) NOT NULL CHECK (
    migration_sql_sha256 ~ '^[0-9a-f]{64}$'
  ),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

DROP TRIGGER IF EXISTS hxos_fake_financial_schema_evidence_append_only_v4
  ON public.hxos_fake_financial_schema_evidence_v4;
CREATE TRIGGER hxos_fake_financial_schema_evidence_append_only_v4
BEFORE UPDATE OR DELETE ON public.hxos_fake_financial_schema_evidence_v4
FOR EACH ROW EXECUTE FUNCTION public.hxos_reject_fake_financial_mutation_v1();

DROP TRIGGER IF EXISTS hxos_fake_financial_schema_evidence_no_truncate_v4
  ON public.hxos_fake_financial_schema_evidence_v4;
CREATE TRIGGER hxos_fake_financial_schema_evidence_no_truncate_v4
BEFORE TRUNCATE ON public.hxos_fake_financial_schema_evidence_v4
FOR EACH STATEMENT EXECUTE FUNCTION public.hxos_reject_fake_financial_mutation_v1();

-- The original fake-event request_sha256 is the adapter's expanded internal
-- identity (operation kind, provider kind, scenario, and metadata included).
-- Preserve it. This separate nullable-on-history projection carries the exact
-- canonical adapter input digest already committed by PREPARED and REQUESTED.
ALTER TABLE public.hxos_fake_financial_operation_events_v1
  ADD COLUMN IF NOT EXISTS provider_request_sha256 CHAR(64);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'hxos_fake_financial_event_provider_request_sha256_chk'
       AND conrelid = 'public.hxos_fake_financial_operation_events_v1'::regclass
  ) THEN
    ALTER TABLE public.hxos_fake_financial_operation_events_v1
      ADD CONSTRAINT hxos_fake_financial_event_provider_request_sha256_chk CHECK (
        provider_request_sha256 IS NULL
        OR provider_request_sha256 ~ '^[a-f0-9]{64}$'
      );
  END IF;
END;
$$;

-- The immutable Work Order command witness is the Phase-A claim. A task and a
-- conditional hold may each be consumed by at most one such claim, regardless
-- of the idempotency key selected by concurrent callers.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.task_work_order_command_requests
     GROUP BY task_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'HXUV1-FLB-1: existing Work Order task claims are not single-winner'
      USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.task_work_order_command_requests
     GROUP BY conditional_hold_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'HXUV1-FLB-2: existing Work Order hold claims are not single-winner'
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS task_work_order_command_requests_task_single_winner_uidx
  ON public.task_work_order_command_requests(task_id);
CREATE UNIQUE INDEX IF NOT EXISTS task_work_order_command_requests_hold_single_winner_uidx
  ON public.task_work_order_command_requests(conditional_hold_id);

COMMENT ON INDEX public.task_work_order_command_requests_task_single_winner_uidx IS
  'Phase-A Work Order claim: exactly one immutable command witness may claim a task.';
COMMENT ON INDEX public.task_work_order_command_requests_hold_single_winner_uidx IS
  'Phase-A Work Order claim: exactly one immutable command witness may consume a conditional hold.';

CREATE TABLE IF NOT EXISTS public.universal_v1_fake_financial_lifecycle_bridges (
  bridge_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The runtime supplies only these six immutable references. The validation
  -- trigger derives every safe projection and digest below from canonical rows.
  prepared_command_id UUID NOT NULL UNIQUE
    REFERENCES public.universal_v1_prepared_financial_commands(prepared_command_id)
    ON DELETE RESTRICT,
  command_id UUID NOT NULL UNIQUE
    REFERENCES public.financial_provider_command_journal(command_id)
    ON DELETE RESTRICT,
  dispatch_attempt_id UUID NOT NULL UNIQUE
    REFERENCES public.financial_provider_command_dispatch_attempts(dispatch_attempt_id)
    ON DELETE RESTRICT,
  outcome_fact_id UUID NOT NULL UNIQUE
    REFERENCES public.financial_provider_command_outcome_facts(outcome_fact_id)
    ON DELETE RESTRICT,
  fake_operation_event_id UUID NOT NULL UNIQUE
    REFERENCES public.hxos_fake_financial_operation_events_v1(event_id)
    ON DELETE RESTRICT,
  task_financial_security_event_id UUID NOT NULL UNIQUE
    REFERENCES public.task_financial_security_events(id)
    ON DELETE RESTRICT,

  -- Database-derived exact operation and lifecycle snapshots.
  fake_operation_id UUID NOT NULL
    REFERENCES public.hxos_fake_financial_operations_v1(operation_id)
    ON DELETE RESTRICT,
  fake_operation_kind TEXT NOT NULL CHECK (fake_operation_kind IN (
    'PREPARE_PAYMENT_METHOD', 'AUTHORIZE', 'SECURE', 'VOID', 'ADJUST',
    'CAPTURE', 'REFUND', 'REVERSAL', 'SETTLE', 'FUND',
    'PROVIDER_RELEASE', 'PAYOUT', 'OBSERVE_BANK_SETTLEMENT'
  )),
  fake_event_version BIGINT NOT NULL CHECK (
    fake_event_version BETWEEN 1 AND 9007199254740991
  ),
  fake_provider_state TEXT NOT NULL CHECK (fake_provider_state IN (
    'SUCCEEDED', 'DECLINED', 'FAILED', 'VOIDED', 'REFUNDED',
    'PARTIALLY_REFUNDED', 'REVERSED'
  )),
  lifecycle_event_kind TEXT NOT NULL CHECK (lifecycle_event_kind IN (
    'PAYMENT_METHOD_PREPARED', 'AUTHORIZED', 'SECURED', 'VOIDED',
    'ADJUSTMENT_AUTHORIZED', 'CAPTURED', 'REFUNDED', 'REVERSED',
    'SETTLEMENT_OBSERVED', 'FUNDING_OBSERVED', 'PROVIDER_RELEASED',
    'PAYOUT_OBSERVED', 'BANK_SETTLEMENT_OBSERVED'
  )),
  lifecycle_status TEXT NOT NULL CHECK (
    lifecycle_status IN ('SUCCEEDED', 'DECLINED', 'FAILED')
  ),
  provider_expected_version BIGINT NOT NULL CHECK (
    provider_expected_version BETWEEN 0 AND 9007199254740991
  ),
  lifecycle_expected_version BIGINT NOT NULL CHECK (
    lifecycle_expected_version BETWEEN 0 AND 9007199254740991
  ),

  task_draft_id UUID NOT NULL,
  task_id UUID NOT NULL,
  eligibility_decision_id UUID NOT NULL,
  scope_version_id UUID NOT NULL,
  change_order_id UUID,
  completion_fact_id UUID,
  predecessor_event_id UUID,
  recorded_by UUID NOT NULL,
  amount_cents BIGINT CHECK (
    amount_cents IS NULL OR amount_cents BETWEEN 1 AND 9007199254740991
  ),
  currency CHAR(3) CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  related_operation_id UUID,
  CONSTRAINT universal_v1_fake_lifecycle_bridge_amount_currency_chk CHECK (
    (amount_cents IS NULL) = (currency IS NULL)
  ),

  -- Safe exact hashes only. Raw requests, raw provider payloads, payment-method
  -- references, and provider-account references have no storage column here.
  prepared_authority_sha256 CHAR(64) NOT NULL CHECK (
    prepared_authority_sha256 ~ '^[a-f0-9]{64}$'
  ),
  provider_request_sha256 CHAR(64) NOT NULL CHECK (
    provider_request_sha256 ~ '^[a-f0-9]{64}$'
  ),
  command_identity_sha256 CHAR(64) NOT NULL CHECK (
    command_identity_sha256 ~ '^[a-f0-9]{64}$'
  ),
  dispatch_attempt_identity_sha256 CHAR(64) NOT NULL CHECK (
    dispatch_attempt_identity_sha256 ~ '^[a-f0-9]{64}$'
  ),
  outcome_identity_sha256 CHAR(64) NOT NULL CHECK (
    outcome_identity_sha256 ~ '^[a-f0-9]{64}$'
  ),
  fake_operation_identity_sha256 CHAR(64) NOT NULL CHECK (
    fake_operation_identity_sha256 ~ '^[a-f0-9]{64}$'
  ),
  fake_event_request_sha256 CHAR(64) NOT NULL CHECK (
    fake_event_request_sha256 ~ '^[a-f0-9]{64}$'
  ),
  fake_event_response_sha256 CHAR(64) NOT NULL CHECK (
    fake_event_response_sha256 ~ '^[a-f0-9]{64}$'
  ),
  external_reference_sha256 CHAR(64) NOT NULL CHECK (
    external_reference_sha256 ~ '^[a-f0-9]{64}$'
  ),
  lifecycle_event_identity_sha256 CHAR(64) NOT NULL CHECK (
    lifecycle_event_identity_sha256 ~ '^[a-f0-9]{64}$'
  ),
  authority_chain_sha256 CHAR(64) NOT NULL CHECK (
    authority_chain_sha256 ~ '^[a-f0-9]{64}$'
  ),
  materialized_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS universal_v1_fake_financial_lifecycle_bridge_operation_idx
  ON public.universal_v1_fake_financial_lifecycle_bridges(
    fake_operation_id, fake_event_version
  );
CREATE INDEX IF NOT EXISTS universal_v1_fake_financial_lifecycle_bridge_task_idx
  ON public.universal_v1_fake_financial_lifecycle_bridges(
    task_id, lifecycle_expected_version
  );

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

  IF prepared.command_state <> 'PREPARED'
     OR prepared.provider_kind <> 'FAKE'
     OR requested.command_state <> 'REQUESTED'
     OR requested.provider_kind <> 'FAKE'
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
     OR outcome.outcome_kind <> 'OUTCOME_OBSERVED'
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
    digest(fake_event.external_reference, 'sha256'),
    'hex'
  );
  expected_provider_result_sha256 := encode(
    digest(
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

  IF fake_operation.provider_kind <> 'FAKE'
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
     OR lifecycle.provider_kind <> 'FAKE'
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

  IF prepared.operation_kind <> 'PREPARE_PAYMENT_METHOD' AND NOT EXISTS (
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
    digest(
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
    digest(
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

DROP TRIGGER IF EXISTS universal_v1_fake_financial_lifecycle_bridge_validate
  ON public.universal_v1_fake_financial_lifecycle_bridges;
CREATE TRIGGER universal_v1_fake_financial_lifecycle_bridge_validate
BEFORE INSERT ON public.universal_v1_fake_financial_lifecycle_bridges
FOR EACH ROW
EXECUTE FUNCTION public.validate_universal_v1_fake_financial_lifecycle_bridge();

CREATE OR REPLACE FUNCTION public.reject_universal_v1_fake_financial_lifecycle_bridge_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'HXUV1-FLB-20: fake financial lifecycle bridges are append-only'
    USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS universal_v1_fake_financial_lifecycle_bridge_no_update_delete
  ON public.universal_v1_fake_financial_lifecycle_bridges;
CREATE TRIGGER universal_v1_fake_financial_lifecycle_bridge_no_update_delete
BEFORE UPDATE OR DELETE ON public.universal_v1_fake_financial_lifecycle_bridges
FOR EACH ROW
EXECUTE FUNCTION public.reject_universal_v1_fake_financial_lifecycle_bridge_mutation();

DROP TRIGGER IF EXISTS universal_v1_fake_financial_lifecycle_bridge_no_truncate
  ON public.universal_v1_fake_financial_lifecycle_bridges;
CREATE TRIGGER universal_v1_fake_financial_lifecycle_bridge_no_truncate
BEFORE TRUNCATE ON public.universal_v1_fake_financial_lifecycle_bridges
FOR EACH STATEMENT
EXECUTE FUNCTION public.reject_universal_v1_fake_financial_lifecycle_bridge_mutation();

-- This constraint trigger is intentionally row- and transaction-scoped. It
-- applies only to lifecycle rows inserted after this migration; historical
-- evidence is not rewritten or retrospectively required to have a bridge.
CREATE OR REPLACE FUNCTION public.require_universal_v1_controlled_fake_lifecycle_bridge()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.provider_kind <> 'FAKE' OR NEW.task_id IS NULL THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.tasks task
     WHERE task.id = NEW.task_id
       AND task.universal_contract_version = 1
       AND task.automation_classification = 'CONTROLLED_TEST'
  ) THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.universal_v1_fake_financial_lifecycle_bridges bridge
     WHERE bridge.task_financial_security_event_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'HXUV1-FLB-21: newly inserted controlled-test fake lifecycle event requires its exact bridge in the same transaction'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS universal_v1_controlled_fake_lifecycle_bridge_required
  ON public.task_financial_security_events;
CREATE CONSTRAINT TRIGGER universal_v1_controlled_fake_lifecycle_bridge_required
AFTER INSERT ON public.task_financial_security_events
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.require_universal_v1_controlled_fake_lifecycle_bridge();

COMMENT ON TABLE public.universal_v1_fake_financial_lifecycle_bridges IS
  'Append-only, fake-only exact authority joining PREPARED, REQUESTED, latest DISPATCH_ATTEMPTED, terminal OUTCOME_OBSERVED, raw fake-provider event, and one controlled-test lifecycle event. No row represents money or production capability.';
COMMENT ON COLUMN public.universal_v1_fake_financial_lifecycle_bridges.authority_chain_sha256 IS
  'Database-derived SHA-256 over exact immutable command, dispatch, outcome, raw fake-event, and lifecycle identities.';
COMMENT ON TABLE public.hxos_fake_financial_schema_evidence_v4 IS
  'Append-only checksum evidence for the nonproduction Universal V1 fake lifecycle bridge.';

REVOKE ALL ON TABLE public.universal_v1_fake_financial_lifecycle_bridges FROM PUBLIC;
REVOKE ALL ON TABLE public.hxos_fake_financial_schema_evidence_v4 FROM PUBLIC;
REVOKE ALL ON FUNCTION public.validate_universal_v1_fake_financial_lifecycle_bridge() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_universal_v1_fake_financial_lifecycle_bridge_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.require_universal_v1_controlled_fake_lifecycle_bridge() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.validate_universal_v1_fake_financial_lifecycle_bridge() TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.reject_universal_v1_fake_financial_lifecycle_bridge_mutation() TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.require_universal_v1_controlled_fake_lifecycle_bridge() TO CURRENT_USER;
