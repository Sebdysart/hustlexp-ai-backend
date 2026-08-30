-- Universal V1 prepared financial command authority v1.
--
-- A PREPARED row is an immutable, database-validated authorization snapshot.
-- It binds the exact current Universal V1 lifecycle facts before provider I/O.
-- The authority remains fake-only: APPROVED_PROVIDER preparation is refused and
-- this migration creates no payment, deployment, assignment, or production
-- capability. Provider request secrets remain represented only by the separate
-- command-journal request digest.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.universal_v1_prepared_financial_commands (
  prepared_command_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  command_state TEXT NOT NULL DEFAULT 'PREPARED' CHECK (command_state = 'PREPARED'),
  operation_kind TEXT NOT NULL CHECK (operation_kind IN (
    'PREPARE_PAYMENT_METHOD',
    'AUTHORIZE',
    'SECURE',
    'VOID',
    'ADJUST',
    'CAPTURE',
    'REFUND',
    'REVERSAL',
    'SETTLE',
    'FUND',
    'PROVIDER_RELEASE',
    'PAYOUT',
    'OBSERVE_BANK_SETTLEMENT'
  )),
  event_kind TEXT NOT NULL CHECK (event_kind IN (
    'PAYMENT_METHOD_PREPARED',
    'AUTHORIZED',
    'SECURED',
    'VOIDED',
    'ADJUSTMENT_AUTHORIZED',
    'CAPTURED',
    'REFUNDED',
    'REVERSED',
    'SETTLEMENT_OBSERVED',
    'FUNDING_OBSERVED',
    'PROVIDER_RELEASED',
    'PAYOUT_OBSERVED',
    'BANK_SETTLEMENT_OBSERVED'
  )),
  operation_id UUID NOT NULL,
  provider_kind TEXT NOT NULL CHECK (provider_kind = 'FAKE'),
  idempotency_key TEXT NOT NULL CHECK (
    idempotency_key ~ '^[A-Za-z0-9:_-]{16,128}$'
  ),
  provider_expected_version BIGINT NOT NULL CHECK (
    provider_expected_version BETWEEN 0 AND 9007199254740991
  ),
  lifecycle_expected_version BIGINT NOT NULL CHECK (
    lifecycle_expected_version BETWEEN 0 AND 9007199254740991
  ),
  provider_request_sha256 CHAR(64) NOT NULL CHECK (
    provider_request_sha256 ~ '^[a-f0-9]{64}$'
  ),

  task_draft_id UUID NOT NULL REFERENCES public.task_drafts(id) ON DELETE RESTRICT,
  task_id UUID REFERENCES public.tasks(id) ON DELETE RESTRICT,
  eligibility_decision_id UUID
    REFERENCES public.task_provider_eligibility_decisions(id) ON DELETE RESTRICT,
  eligibility_decision_version INTEGER CHECK (
    eligibility_decision_version IS NULL OR eligibility_decision_version > 0
  ),
  eligibility_valid_until TIMESTAMPTZ,
  scope_version_id UUID REFERENCES public.task_scope_versions(id) ON DELETE RESTRICT,
  scope_version INTEGER CHECK (scope_version IS NULL OR scope_version > 0),
  scope_hash CHAR(64) CHECK (scope_hash IS NULL OR scope_hash ~ '^[a-f0-9]{64}$'),
  work_order_id UUID REFERENCES public.task_work_orders(id) ON DELETE RESTRICT,
  work_order_materialization_version INTEGER CHECK (
    work_order_materialization_version IS NULL OR work_order_materialization_version > 0
  ),
  work_order_execution_contract_version SMALLINT CHECK (
    work_order_execution_contract_version IS NULL
    OR work_order_execution_contract_version IN (0, 1)
  ),
  change_order_id UUID
    REFERENCES public.task_scope_change_proposals(id) ON DELETE RESTRICT,
  change_order_version INTEGER CHECK (
    change_order_version IS NULL OR change_order_version > 0
  ),
  completion_fact_id UUID REFERENCES public.task_completion_facts(id) ON DELETE RESTRICT,
  completion_version INTEGER CHECK (
    completion_version IS NULL OR completion_version > 0
  ),

  predecessor_event_id UUID
    REFERENCES public.task_financial_security_events(id) ON DELETE RESTRICT,
  predecessor_operation_id UUID,
  predecessor_event_kind TEXT,
  predecessor_status TEXT,
  predecessor_lifecycle_version BIGINT CHECK (
    predecessor_lifecycle_version IS NULL OR predecessor_lifecycle_version >= 0
  ),
  related_operation_id UUID,
  amount_cents BIGINT CHECK (
    amount_cents IS NULL OR amount_cents BETWEEN 1 AND 9007199254740991
  ),
  currency CHAR(3) CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  recorded_by UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  request_identity_sha256 CHAR(64) NOT NULL CHECK (
    request_identity_sha256 ~ '^[a-f0-9]{64}$'
  ),
  authority_context_sha256 CHAR(64) NOT NULL CHECK (
    authority_context_sha256 ~ '^[a-f0-9]{64}$'
  ),
  prepared_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT universal_v1_prepared_financial_idempotency_uniq
    UNIQUE (idempotency_key),
  CONSTRAINT universal_v1_prepared_financial_operation_version_uniq
    UNIQUE (provider_kind, operation_kind, operation_id, provider_expected_version),
  CONSTRAINT universal_v1_prepared_financial_lifecycle_version_uniq
    UNIQUE (task_draft_id, lifecycle_expected_version),
  CONSTRAINT universal_v1_prepared_financial_amount_currency_pair_chk CHECK (
    (amount_cents IS NULL) = (currency IS NULL)
  ),
  CONSTRAINT universal_v1_prepared_financial_binding_shape_chk CHECK (
    (
      operation_kind = 'PREPARE_PAYMENT_METHOD'
      AND lifecycle_expected_version = 0
      AND predecessor_event_id IS NULL
      AND predecessor_operation_id IS NULL
      AND predecessor_event_kind IS NULL
      AND predecessor_status IS NULL
      AND predecessor_lifecycle_version IS NULL
      AND related_operation_id IS NULL
      AND change_order_id IS NULL
      AND change_order_version IS NULL
      AND completion_fact_id IS NULL
      AND completion_version IS NULL
      AND amount_cents IS NULL
      AND currency IS NULL
      AND (
        num_nonnulls(task_id, eligibility_decision_id, scope_version_id) = 0
        OR num_nonnulls(task_id, eligibility_decision_id, scope_version_id) = 3
      )
    )
    OR (
      operation_kind <> 'PREPARE_PAYMENT_METHOD'
      AND lifecycle_expected_version > 0
      AND task_id IS NOT NULL
      AND eligibility_decision_id IS NOT NULL
      AND eligibility_decision_version IS NOT NULL
      AND eligibility_valid_until IS NOT NULL
      AND scope_version_id IS NOT NULL
      AND scope_version IS NOT NULL
      AND scope_hash IS NOT NULL
      AND predecessor_event_id IS NOT NULL
      AND predecessor_operation_id IS NOT NULL
      AND predecessor_event_kind IS NOT NULL
      AND predecessor_status IS NOT NULL
      AND predecessor_lifecycle_version IS NOT NULL
      AND related_operation_id IS NOT NULL
      AND amount_cents IS NOT NULL
      AND currency IS NOT NULL
    )
  ),
  CONSTRAINT universal_v1_prepared_financial_change_order_shape_chk CHECK (
    (operation_kind = 'ADJUST') =
    (change_order_id IS NOT NULL AND change_order_version IS NOT NULL)
  ),
  CONSTRAINT universal_v1_prepared_financial_completion_shape_chk CHECK (
    (operation_kind = 'CAPTURE') =
    (completion_fact_id IS NOT NULL AND completion_version IS NOT NULL)
  ),
  CONSTRAINT universal_v1_prepared_financial_work_order_snapshot_pair_chk CHECK (
    num_nonnulls(
      work_order_id,
      work_order_materialization_version,
      work_order_execution_contract_version
    ) IN (0, 3)
  )
);

CREATE INDEX IF NOT EXISTS universal_v1_prepared_financial_task_time_idx
  ON public.universal_v1_prepared_financial_commands(task_draft_id, prepared_at);

CREATE OR REPLACE FUNCTION public.enforce_universal_v1_financial_command_preparation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
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
         OR eligibility.valid_until <= clock_timestamp()
         OR EXISTS (
           SELECT 1
           FROM public.task_provider_eligibility_decisions newer
           WHERE newer.task_draft_id = eligibility.task_draft_id
             AND newer.provider_user_id = eligibility.provider_user_id
             AND newer.provider_organization_id IS NOT DISTINCT FROM eligibility.provider_organization_id
             AND newer.decision_version > eligibility.decision_version
         ) THEN
        RAISE EXCEPTION 'HXUV1-PFC-9: pre-Work-Order finance requires current unexpired eligibility and its exact scope'
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
      'ADJUST','CAPTURE','REFUND','SETTLE','FUND',
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

  NEW.request_identity_sha256 := encode(digest(jsonb_build_object(
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
  NEW.authority_context_sha256 := encode(digest(jsonb_build_object(
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
$$;

DROP TRIGGER IF EXISTS universal_v1_prepared_financial_command_guard
  ON public.universal_v1_prepared_financial_commands;
CREATE TRIGGER universal_v1_prepared_financial_command_guard
BEFORE INSERT ON public.universal_v1_prepared_financial_commands
FOR EACH ROW EXECUTE FUNCTION public.enforce_universal_v1_financial_command_preparation();

CREATE OR REPLACE FUNCTION public.reject_universal_v1_prepared_financial_command_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'HXUV1-PFC-24: PREPARED financial command authority is append-only'
    USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS universal_v1_prepared_financial_command_no_update_delete
  ON public.universal_v1_prepared_financial_commands;
CREATE TRIGGER universal_v1_prepared_financial_command_no_update_delete
BEFORE UPDATE OR DELETE ON public.universal_v1_prepared_financial_commands
FOR EACH ROW EXECUTE FUNCTION public.reject_universal_v1_prepared_financial_command_mutation();

DROP TRIGGER IF EXISTS universal_v1_prepared_financial_command_no_truncate
  ON public.universal_v1_prepared_financial_commands;
CREATE TRIGGER universal_v1_prepared_financial_command_no_truncate
BEFORE TRUNCATE ON public.universal_v1_prepared_financial_commands
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_universal_v1_prepared_financial_command_mutation();

ALTER TABLE public.financial_provider_command_journal
  ADD COLUMN IF NOT EXISTS prepared_financial_command_id UUID
    REFERENCES public.universal_v1_prepared_financial_commands(prepared_command_id)
    ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS prepared_authority_sha256 CHAR(64);

ALTER TABLE public.financial_provider_command_journal
  DROP CONSTRAINT IF EXISTS financial_provider_command_journal_recorded_actor_kind_check;
ALTER TABLE public.financial_provider_command_journal
  DROP CONSTRAINT IF EXISTS financial_provider_command_actor_kind_chk;
ALTER TABLE public.financial_provider_command_journal
  ADD CONSTRAINT financial_provider_command_actor_kind_chk CHECK (
    recorded_actor_kind IS NULL
    OR recorded_actor_kind IN ('NAMED_OPERATOR', 'SERVICE_PRINCIPAL', 'PARTICIPANT')
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'financial_provider_command_prepared_authority_pair_chk'
      AND conrelid = 'public.financial_provider_command_journal'::regclass
  ) THEN
    ALTER TABLE public.financial_provider_command_journal
      ADD CONSTRAINT financial_provider_command_prepared_authority_pair_chk CHECK (
        (prepared_financial_command_id IS NULL) = (prepared_authority_sha256 IS NULL)
        AND (
          prepared_authority_sha256 IS NULL
          OR prepared_authority_sha256 ~ '^[a-f0-9]{64}$'
        )
      );
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_financial_provider_command_prepared_authority()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  prepared public.universal_v1_prepared_financial_commands%ROWTYPE;
  lifecycle_operation BOOLEAN;
BEGIN
  lifecycle_operation := NEW.operation_kind IN (
    'PREPARE_PAYMENT_METHOD','AUTHORIZE','SECURE','VOID','ADJUST','CAPTURE',
    'REFUND','REVERSAL','SETTLE','FUND','PROVIDER_RELEASE','PAYOUT',
    'OBSERVE_BANK_SETTLEMENT'
  );
  IF NOT lifecycle_operation THEN
    IF NEW.prepared_financial_command_id IS NOT NULL
       OR NEW.prepared_authority_sha256 IS NOT NULL THEN
      RAISE EXCEPTION 'HXUV1-PFC-25: non-lifecycle provider command cannot claim PREPARED lifecycle authority'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  SELECT * INTO prepared
  FROM public.universal_v1_prepared_financial_commands
  WHERE prepared_command_id = NEW.prepared_financial_command_id
  FOR SHARE;
  IF prepared.prepared_command_id IS NULL
     OR prepared.command_state <> 'PREPARED'
     OR prepared.operation_kind <> NEW.operation_kind
     OR prepared.operation_id <> NEW.operation_id
     OR prepared.provider_kind <> NEW.provider_kind
     OR prepared.idempotency_key <> NEW.idempotency_key
     OR prepared.provider_expected_version <> NEW.provider_expected_version
     OR prepared.provider_request_sha256 <> NEW.request_sha256
     OR prepared.task_draft_id IS DISTINCT FROM NEW.task_draft_id
     OR prepared.task_id IS DISTINCT FROM NEW.task_id
     OR prepared.work_order_id IS DISTINCT FROM NEW.work_order_id
     OR prepared.related_operation_id IS DISTINCT FROM NEW.related_operation_id
     OR prepared.amount_cents IS DISTINCT FROM NEW.amount_cents
     OR prepared.currency IS DISTINCT FROM NEW.currency
     OR prepared.recorded_by IS DISTINCT FROM NEW.recorded_actor_id
     OR NEW.recorded_actor_kind IS DISTINCT FROM 'PARTICIPANT'
     OR prepared.authority_context_sha256 IS DISTINCT FROM NEW.prepared_authority_sha256 THEN
    RAISE EXCEPTION 'HXUV1-PFC-26: provider command requires its exact committed PREPARED lifecycle authority'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS financial_provider_command_prepared_authority_guard
  ON public.financial_provider_command_journal;
CREATE TRIGGER financial_provider_command_prepared_authority_guard
BEFORE INSERT ON public.financial_provider_command_journal
FOR EACH ROW EXECUTE FUNCTION public.enforce_financial_provider_command_prepared_authority();

COMMENT ON TABLE public.universal_v1_prepared_financial_commands IS
  'Append-only fake-only PREPARED command snapshots validated against exact authoritative lifecycle facts. PREPARED and REQUESTED do not authorize provider I/O or lifecycle DML; a future append-only authority must bind PREPARED, REQUESTED, DISPATCH_ATTEMPTED, provider outcome, and lifecycle materialization. Grants no real-money or production capability.';
COMMENT ON COLUMN public.universal_v1_prepared_financial_commands.request_identity_sha256 IS
  'Database-computed SHA-256 of the exact normalized lifecycle command identity, excluding provider secrets.';
COMMENT ON COLUMN public.universal_v1_prepared_financial_commands.provider_request_sha256 IS
  'SHA-256 of the exact canonical provider request, including every semantic adapter field; raw provider request material is not stored.';
COMMENT ON COLUMN public.universal_v1_prepared_financial_commands.authority_context_sha256 IS
  'Database-computed SHA-256 binding request identity to canonical eligibility, scope, Work Order, change-order, completion, and predecessor snapshots.';
COMMENT ON COLUMN public.financial_provider_command_journal.prepared_financial_command_id IS
  'Exact committed PREPARED lifecycle authority required before lifecycle adapter invocation.';

REVOKE ALL ON TABLE public.universal_v1_prepared_financial_commands FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_universal_v1_financial_command_preparation() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_universal_v1_prepared_financial_command_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_financial_provider_command_prepared_authority() FROM PUBLIC;
