-- Universal V1 nonproduction fake terminal-lifecycle authority v1.
--
-- A terminal intent is the immutable, pre-effect claim that fixes either the
-- SETTLED or FULL_REFUND plan for one completed Work Order. Provider-account
-- facts and reconciliation bridges then bind exact committed fake-provider
-- evidence to that claim. The tables are append-only. They create no money,
-- provider, assignment, deployment, scheduling, or production capability.
-- APPROVED_PROVIDER remains deliberately unsupported.
--
-- This fixture belongs after the ordered engine chain and the nonproduction
-- fake lifecycle bridge v4. It must never be placed in the production engine
-- registry. Production payment creation remains frozen.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF to_regclass('public.hxos_fake_financial_schema_evidence_v4') IS NULL
     OR to_regclass('public.hxos_fake_financial_operations_v1') IS NULL
     OR to_regclass('public.hxos_fake_financial_operation_events_v1') IS NULL
     OR to_regclass('public.universal_v1_fake_financial_lifecycle_bridges') IS NULL
     OR to_regclass('public.financial_provider_command_journal') IS NULL
     OR to_regclass('public.financial_provider_command_dispatch_attempts') IS NULL
     OR to_regclass('public.financial_provider_command_outcome_facts') IS NULL
     OR to_regclass('public.task_work_orders') IS NULL
     OR to_regclass('public.task_work_order_execution_facts') IS NULL
     OR to_regclass('public.task_completion_facts') IS NULL
     OR to_regclass('public.task_reconciliation_facts') IS NULL THEN
    RAISE EXCEPTION 'HXUV1-FTL-0: canonical engine chain and nonproduction fake lifecycle bridge v4 must be installed first'
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS public.hxos_fake_financial_schema_evidence_v5 (
  migration_name TEXT PRIMARY KEY CHECK (
    migration_name = '20260922_universal_v1_fake_terminal_lifecycle_intent_v1'
  ),
  migration_sql_sha256 CHAR(64) NOT NULL CHECK (
    migration_sql_sha256 ~ '^[0-9a-f]{64}$'
  ),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

DROP TRIGGER IF EXISTS hxos_fake_financial_schema_evidence_append_only_v5
  ON public.hxos_fake_financial_schema_evidence_v5;
CREATE TRIGGER hxos_fake_financial_schema_evidence_append_only_v5
BEFORE UPDATE OR DELETE ON public.hxos_fake_financial_schema_evidence_v5
FOR EACH ROW EXECUTE FUNCTION public.hxos_reject_fake_financial_mutation_v1();

DROP TRIGGER IF EXISTS hxos_fake_financial_schema_evidence_no_truncate_v5
  ON public.hxos_fake_financial_schema_evidence_v5;
CREATE TRIGGER hxos_fake_financial_schema_evidence_no_truncate_v5
BEFORE TRUNCATE ON public.hxos_fake_financial_schema_evidence_v5
FOR EACH STATEMENT EXECUTE FUNCTION public.hxos_reject_fake_financial_mutation_v1();

-- The helper and view are deliberately literal. Application code cannot add,
-- remove, reorder, or reinterpret steps. Lifecycle offsets are relative to the
-- exact successful SECURED/ADJUSTMENT_AUTHORIZED predecessor named by intent.
CREATE OR REPLACE FUNCTION public.universal_v1_fake_terminal_plan_v1(
  checked_terminal_path TEXT
)
RETURNS TABLE (
  terminal_path TEXT,
  step_ordinal SMALLINT,
  step_class TEXT,
  operation_kind TEXT,
  lifecycle_version_offset SMALLINT
)
LANGUAGE SQL
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT plan.terminal_path,
         plan.step_ordinal,
         plan.step_class,
         plan.operation_kind,
         plan.lifecycle_version_offset
    FROM (VALUES
      ('SETTLED'::TEXT, 1::SMALLINT, 'LIFECYCLE'::TEXT, 'CAPTURE'::TEXT, 1::SMALLINT),
      ('SETTLED'::TEXT, 2::SMALLINT, 'LIFECYCLE'::TEXT, 'SETTLE'::TEXT, 2::SMALLINT),
      ('SETTLED'::TEXT, 3::SMALLINT, 'LIFECYCLE'::TEXT, 'FUND'::TEXT, 3::SMALLINT),
      ('SETTLED'::TEXT, 4::SMALLINT, 'LIFECYCLE'::TEXT, 'PROVIDER_RELEASE'::TEXT, 4::SMALLINT),
      ('SETTLED'::TEXT, 5::SMALLINT, 'LIFECYCLE'::TEXT, 'PAYOUT'::TEXT, 5::SMALLINT),
      ('SETTLED'::TEXT, 6::SMALLINT, 'LIFECYCLE'::TEXT, 'OBSERVE_BANK_SETTLEMENT'::TEXT, 6::SMALLINT),
      ('SETTLED'::TEXT, 7::SMALLINT, 'RECONCILIATION'::TEXT, 'RECONCILE'::TEXT, NULL::SMALLINT),
      ('FULL_REFUND'::TEXT, 1::SMALLINT, 'LIFECYCLE'::TEXT, 'CAPTURE'::TEXT, 1::SMALLINT),
      ('FULL_REFUND'::TEXT, 2::SMALLINT, 'LIFECYCLE'::TEXT, 'REFUND'::TEXT, 2::SMALLINT),
      ('FULL_REFUND'::TEXT, 3::SMALLINT, 'RECONCILIATION'::TEXT, 'RECONCILE'::TEXT, NULL::SMALLINT)
    ) AS plan(
      terminal_path,
      step_ordinal,
      step_class,
      operation_kind,
      lifecycle_version_offset
    )
   WHERE plan.terminal_path = checked_terminal_path
   ORDER BY plan.step_ordinal;
$$;

CREATE OR REPLACE VIEW public.universal_v1_fake_terminal_plan_steps_v1 AS
SELECT * FROM public.universal_v1_fake_terminal_plan_v1('SETTLED')
UNION ALL
SELECT * FROM public.universal_v1_fake_terminal_plan_v1('FULL_REFUND');

COMMENT ON VIEW public.universal_v1_fake_terminal_plan_steps_v1 IS
  'Immutable SETTLED/FULL_REFUND nonproduction fake terminal plan. Capture, settlement, funding, release, payout, bank settlement, refund, and reconciliation remain distinct.';

CREATE TABLE IF NOT EXISTS public.universal_v1_fake_terminal_lifecycle_intents (
  terminal_intent_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Caller-supplied claim inputs. All other authority columns are derived by
  -- the validation trigger from canonical database facts.
  terminal_path TEXT NOT NULL CHECK (terminal_path IN ('SETTLED', 'FULL_REFUND')),
  work_order_id UUID NOT NULL UNIQUE
    REFERENCES public.task_work_orders(id) ON DELETE RESTRICT,
  completion_fact_id UUID NOT NULL UNIQUE
    REFERENCES public.task_completion_facts(id) ON DELETE RESTRICT,
  starting_financial_event_id UUID NOT NULL UNIQUE
    REFERENCES public.task_financial_security_events(id) ON DELETE RESTRICT,
  provider_account_fact_id UUID,
  expected_financial_version BIGINT NOT NULL CHECK (
    expected_financial_version BETWEEN 0 AND 9007199254740991
  ),
  expected_reconciliation_version INTEGER NOT NULL CHECK (
    expected_reconciliation_version >= 0
  ),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (
    idempotency_key ~ '^[A-Za-z0-9:_-]{16,128}$'
  ),
  request_sha256 CHAR(64) NOT NULL CHECK (
    request_sha256 ~ '^[a-f0-9]{64}$'
    AND request_sha256 <> repeat('0', 64)
  ),
  requested_by UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,

  -- Database-derived immutable authority snapshot.
  task_draft_id UUID NOT NULL REFERENCES public.task_drafts(id) ON DELETE RESTRICT,
  task_id UUID NOT NULL REFERENCES public.tasks(id) ON DELETE RESTRICT,
  scope_version_id UUID NOT NULL
    REFERENCES public.task_scope_versions(id) ON DELETE RESTRICT,
  eligibility_decision_id UUID NOT NULL
    REFERENCES public.task_provider_eligibility_decisions(id) ON DELETE RESTRICT,
  completion_execution_fact_id UUID NOT NULL UNIQUE
    REFERENCES public.task_work_order_execution_facts(id) ON DELETE RESTRICT,
  starting_financial_bridge_id UUID NOT NULL UNIQUE
    REFERENCES public.universal_v1_fake_financial_lifecycle_bridges(bridge_id)
    ON DELETE RESTRICT,
  prior_reconciliation_fact_id UUID
    REFERENCES public.task_reconciliation_facts(id) ON DELETE RESTRICT,
  starting_financial_version BIGINT NOT NULL CHECK (
    starting_financial_version BETWEEN 0 AND 9007199254740991
  ),
  starting_reconciliation_version INTEGER NOT NULL CHECK (
    starting_reconciliation_version >= 0
  ),
  provider_subject_kind TEXT NOT NULL CHECK (
    provider_subject_kind IN ('USER', 'ORGANIZATION')
  ),
  provider_subject_id UUID NOT NULL,
  customer_amount_cents BIGINT NOT NULL CHECK (
    customer_amount_cents BETWEEN 1 AND 9007199254740991
  ),
  provider_amount_cents BIGINT NOT NULL CHECK (
    provider_amount_cents BETWEEN 0 AND 9007199254740991
  ),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  plan_step_count SMALLINT NOT NULL CHECK (plan_step_count > 0),
  plan_sha256 CHAR(64) NOT NULL CHECK (plan_sha256 ~ '^[a-f0-9]{64}$'),
  authority_context_sha256 CHAR(64) NOT NULL CHECK (
    authority_context_sha256 ~ '^[a-f0-9]{64}$'
    AND authority_context_sha256 <> repeat('0', 64)
  ),
  materialized_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT universal_v1_fake_terminal_intent_versions_exact_chk CHECK (
    expected_financial_version = starting_financial_version
    AND expected_reconciliation_version = starting_reconciliation_version
  ),
  CONSTRAINT universal_v1_fake_terminal_intent_prior_reconciliation_chk CHECK (
    (starting_reconciliation_version = 0 AND prior_reconciliation_fact_id IS NULL)
    OR
    (starting_reconciliation_version > 0 AND prior_reconciliation_fact_id IS NOT NULL)
  ),
  CONSTRAINT universal_v1_fake_terminal_intent_provider_account_shape_chk CHECK (
    (terminal_path = 'SETTLED') = (provider_account_fact_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS universal_v1_fake_terminal_intent_task_idx
  ON public.universal_v1_fake_terminal_lifecycle_intents(task_id);
CREATE INDEX IF NOT EXISTS universal_v1_fake_terminal_intent_provider_idx
  ON public.universal_v1_fake_terminal_lifecycle_intents(
    provider_subject_kind, provider_subject_id
  );

CREATE OR REPLACE FUNCTION public.validate_universal_v1_fake_terminal_lifecycle_intent()
RETURNS TRIGGER
LANGUAGE plpgsql
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
           digest(
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
    digest(
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

DROP TRIGGER IF EXISTS universal_v1_fake_terminal_lifecycle_intent_validate
  ON public.universal_v1_fake_terminal_lifecycle_intents;
CREATE TRIGGER universal_v1_fake_terminal_lifecycle_intent_validate
BEFORE INSERT ON public.universal_v1_fake_terminal_lifecycle_intents
FOR EACH ROW
EXECUTE FUNCTION public.validate_universal_v1_fake_terminal_lifecycle_intent();

-- Provider-account readiness is provider-authored authority established before
-- terminal execution. One fact binds both exact onboarding and exact refresh
-- evidence chains. It is scoped to a provider user or organization, never to a
-- customer completion or terminal intent.
CREATE TABLE IF NOT EXISTS public.universal_v1_fake_provider_account_facts (
  provider_account_fact_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_subject_kind TEXT NOT NULL CHECK (
    provider_subject_kind IN ('USER', 'ORGANIZATION')
  ),
  provider_user_id UUID REFERENCES public.users(id) ON DELETE RESTRICT,
  provider_organization_id UUID
    REFERENCES public.business_organizations(id) ON DELETE RESTRICT,
  account_version BIGINT NOT NULL CHECK (
    account_version BETWEEN 1 AND 9007199254740991
  ),
  supersedes_fact_id UUID
    REFERENCES public.universal_v1_fake_provider_account_facts(provider_account_fact_id)
    ON DELETE RESTRICT,

  onboard_command_id UUID NOT NULL
    REFERENCES public.financial_provider_command_journal(command_id) ON DELETE RESTRICT,
  onboard_dispatch_attempt_id UUID NOT NULL
    REFERENCES public.financial_provider_command_dispatch_attempts(dispatch_attempt_id)
    ON DELETE RESTRICT,
  onboard_outcome_fact_id UUID NOT NULL
    REFERENCES public.financial_provider_command_outcome_facts(outcome_fact_id)
    ON DELETE RESTRICT,
  onboard_fake_event_id UUID NOT NULL
    REFERENCES public.hxos_fake_financial_operation_events_v1(event_id)
    ON DELETE RESTRICT,

  refresh_command_id UUID NOT NULL UNIQUE
    REFERENCES public.financial_provider_command_journal(command_id) ON DELETE RESTRICT,
  refresh_dispatch_attempt_id UUID NOT NULL UNIQUE
    REFERENCES public.financial_provider_command_dispatch_attempts(dispatch_attempt_id)
    ON DELETE RESTRICT,
  refresh_outcome_fact_id UUID NOT NULL UNIQUE
    REFERENCES public.financial_provider_command_outcome_facts(outcome_fact_id)
    ON DELETE RESTRICT,
  refresh_fake_event_id UUID NOT NULL UNIQUE
    REFERENCES public.hxos_fake_financial_operation_events_v1(event_id)
    ON DELETE RESTRICT,

  provider_account_reference_sha256 CHAR(64) NOT NULL CHECK (
    provider_account_reference_sha256 ~ '^[a-f0-9]{64}$'
  ),
  account_state TEXT NOT NULL CHECK (
    account_state IN ('PENDING', 'ENABLED', 'RESTRICTED', 'FAILED')
  ),
  charges_enabled BOOLEAN NOT NULL,
  payouts_enabled BOOLEAN NOT NULL,
  requirements_due_sha256 CHAR(64) NOT NULL CHECK (
    requirements_due_sha256 ~ '^[a-f0-9]{64}$'
  ),
  recorded_by UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  recorded_at TIMESTAMPTZ NOT NULL,
  materialized_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  fact_sha256 CHAR(64) NOT NULL CHECK (
    fact_sha256 ~ '^[a-f0-9]{64}$'
  ),
  authority_sha256 CHAR(64) NOT NULL CHECK (
    authority_sha256 ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT universal_v1_fake_provider_account_subject_version_uniq
    UNIQUE NULLS NOT DISTINCT (
      provider_subject_kind, provider_user_id, provider_organization_id, account_version
    ),
  UNIQUE (supersedes_fact_id),
  CONSTRAINT universal_v1_fake_provider_account_subject_shape_chk CHECK (
    (
      provider_subject_kind = 'USER'
      AND provider_user_id IS NOT NULL
      AND provider_organization_id IS NULL
    )
    OR
    (
      provider_subject_kind = 'ORGANIZATION'
      AND provider_user_id IS NULL
      AND provider_organization_id IS NOT NULL
    )
  ),
  CONSTRAINT universal_v1_fake_provider_account_state_flags_chk CHECK (
    (account_state = 'ENABLED' AND charges_enabled AND payouts_enabled)
    OR
    (account_state <> 'ENABLED' AND NOT charges_enabled AND NOT payouts_enabled)
  ),
  CONSTRAINT universal_v1_fake_provider_account_chain_shape_chk CHECK (
    (account_version = 1 AND supersedes_fact_id IS NULL)
    OR
    (account_version > 1 AND supersedes_fact_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS universal_v1_fake_provider_account_subject_idx
  ON public.universal_v1_fake_provider_account_facts(
    provider_subject_kind, provider_user_id, provider_organization_id, account_version DESC
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'universal_v1_fake_terminal_intent_provider_account_fk'
       AND conrelid = 'public.universal_v1_fake_terminal_lifecycle_intents'::regclass
  ) THEN
    ALTER TABLE public.universal_v1_fake_terminal_lifecycle_intents
      ADD CONSTRAINT universal_v1_fake_terminal_intent_provider_account_fk
      FOREIGN KEY (provider_account_fact_id)
      REFERENCES public.universal_v1_fake_provider_account_facts(provider_account_fact_id)
      ON DELETE RESTRICT;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.validate_universal_v1_fake_provider_account_fact()
RETURNS TRIGGER
LANGUAGE plpgsql
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
    digest(onboard_event.external_reference, 'sha256'),
    'hex'
  );
  refresh_external_reference_sha256 := encode(
    digest(refresh_event.external_reference, 'sha256'),
    'hex'
  );
  expected_onboard_result_sha256 := encode(
    digest(
      onboard_requested.operation_id::TEXT || ':' || onboard_requested.operation_kind || ':' ||
      onboard_requested.provider_kind || ':' || onboard_outcome.provider_state || ':' ||
      onboard_outcome.provider_result_version::TEXT || ':::' ||
      onboard_external_reference_sha256 || ':' || onboard_outcome.retryable::TEXT,
      'sha256'
    ),
    'hex'
  );
  expected_refresh_result_sha256 := encode(
    digest(
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
       encode(digest(onboard_request_without_scenario, 'sha256'), 'hex'),
       encode(digest(onboard_request_with_scenario, 'sha256'), 'hex')
     )
     OR refresh_requested.request_sha256 NOT IN (
       encode(digest(refresh_request_without_scenario, 'sha256'), 'hex'),
       encode(digest(refresh_request_with_scenario, 'sha256'), 'hex')
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
  derived_requirements_sha256 := encode(digest(derived_requirements, 'sha256'), 'hex');

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
    digest(provider_account_reference, 'sha256'),
    'hex'
  );
  NEW.account_state := derived_account_state;
  NEW.charges_enabled := derived_charges_enabled;
  NEW.payouts_enabled := derived_payouts_enabled;
  NEW.requirements_due_sha256 := derived_requirements_sha256;
  NEW.recorded_at := refresh_outcome.recorded_at;
  NEW.materialized_at := clock_timestamp();
  NEW.fact_sha256 := encode(
    digest(
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
    digest(
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

DROP TRIGGER IF EXISTS universal_v1_fake_provider_account_fact_validate
  ON public.universal_v1_fake_provider_account_facts;
CREATE TRIGGER universal_v1_fake_provider_account_fact_validate
BEFORE INSERT ON public.universal_v1_fake_provider_account_facts
FOR EACH ROW
EXECUTE FUNCTION public.validate_universal_v1_fake_provider_account_fact();

-- The application derives every terminal operation UUID from the immutable
-- intent idempotency key. PostgreSQL reproduces that exact SHA-256/UUID-v4
-- projection so an arbitrary operation cannot masquerade as a plan step.
CREATE OR REPLACE FUNCTION public.universal_v1_fake_terminal_operation_id_v1(
  terminal_idempotency_key TEXT,
  operation_label TEXT
)
RETURNS UUID
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
DECLARE
  hexadecimal TEXT;
  variant_nibble TEXT;
BEGIN
  hexadecimal := substr(
    encode(digest(terminal_idempotency_key || ':' || operation_label, 'sha256'), 'hex'),
    1,
    32
  );
  variant_nibble := CASE substr(hexadecimal, 17, 1)
    WHEN '0' THEN '8' WHEN '1' THEN '9' WHEN '2' THEN 'a' WHEN '3' THEN 'b'
    WHEN '4' THEN '8' WHEN '5' THEN '9' WHEN '6' THEN 'a' WHEN '7' THEN 'b'
    WHEN '8' THEN '8' WHEN '9' THEN '9' WHEN 'a' THEN 'a' WHEN 'b' THEN 'b'
    WHEN 'c' THEN '8' WHEN 'd' THEN '9' WHEN 'e' THEN 'a' WHEN 'f' THEN 'b'
  END;
  hexadecimal := overlay(hexadecimal placing '4' from 13 for 1);
  hexadecimal := overlay(hexadecimal placing variant_nibble from 17 for 1);
  RETURN (
    substr(hexadecimal, 1, 8) || '-' || substr(hexadecimal, 9, 4) || '-' ||
    substr(hexadecimal, 13, 4) || '-' || substr(hexadecimal, 17, 4) || '-' ||
    substr(hexadecimal, 21, 12)
  )::UUID;
END;
$$;

-- The existing PREPARED trigger derives the canonical Work Order snapshot.
-- This alphabetically-later trigger then proves each controlled-test terminal
-- step belongs to one immutable v5 intent before REQUESTED or provider I/O.
CREATE OR REPLACE FUNCTION public.validate_universal_v1_fake_terminal_prepared_command()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
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
       OR encode(digest(provider_account_reference, 'sha256'), 'hex')
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
    digest(expected_provider_request, 'sha256'),
    'hex'
  );
  IF NEW.provider_request_sha256 IS DISTINCT FROM expected_provider_request_sha256 THEN
    RAISE EXCEPTION 'HXUV1-FTL-45: terminal preparation request digest does not match the immutable intent step'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS zz_universal_v1_fake_terminal_prepared_command_guard
  ON public.universal_v1_prepared_financial_commands;
CREATE TRIGGER zz_universal_v1_fake_terminal_prepared_command_guard
BEFORE INSERT ON public.universal_v1_prepared_financial_commands
FOR EACH ROW
EXECUTE FUNCTION public.validate_universal_v1_fake_terminal_prepared_command();

-- Derive the exact application reconciliation snapshot from the immutable
-- intent and already-committed terminal lifecycle facts. This is evaluated
-- before the RECONCILE journal row commits, so an altered snapshot never
-- reaches a dispatch attempt or the fake adapter.
CREATE OR REPLACE FUNCTION public.universal_v1_fake_terminal_reconciliation_snapshot_sha256_v1(
  checked_terminal_intent_id UUID
)
RETURNS CHAR(64)
LANGUAGE plpgsql
STABLE
STRICT
PARALLEL SAFE
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

  -- Keep this lexical key order byte-identical to stableJson(snapshot).
  stable_snapshot := '{' ||
    CASE WHEN bank_settlement_event_id IS NULL THEN '' ELSE
      '"bankSettlementEventId":' || to_jsonb(bank_settlement_event_id::TEXT)::TEXT || ',' END ||
    '"bankSettlementState":' || to_jsonb(
      CASE intent.terminal_path WHEN 'SETTLED' THEN 'SETTLED' ELSE 'NOT_APPLICABLE' END
    )::TEXT || ',' ||
    '"captureEventId":' || to_jsonb(capture_event_id::TEXT)::TEXT || ',' ||
    '"captureState":"CAPTURED",' ||
    '"currency":' || to_jsonb(intent.currency::TEXT)::TEXT || ',' ||
    '"customerLedgerAmountCents":' || CASE intent.terminal_path
      WHEN 'SETTLED' THEN intent.customer_amount_cents::TEXT ELSE '0' END || ',' ||
    '"expectedVersion":' || intent.starting_reconciliation_version::TEXT || ',' ||
    CASE WHEN funding_event_id IS NULL THEN '' ELSE
      '"fundingEventId":' || to_jsonb(funding_event_id::TEXT)::TEXT || ',' END ||
    '"fundingState":' || to_jsonb(
      CASE intent.terminal_path WHEN 'SETTLED' THEN 'FUNDED' ELSE 'NOT_APPLICABLE' END
    )::TEXT || ',' ||
    '"ledgerState":"MATCHED",' ||
    '"mismatchCodes":[],' ||
    CASE WHEN payout_event_id IS NULL THEN '' ELSE
      '"payoutEventId":' || to_jsonb(payout_event_id::TEXT)::TEXT || ',' END ||
    '"payoutState":' || to_jsonb(
      CASE intent.terminal_path WHEN 'SETTLED' THEN 'PAID' ELSE 'NOT_APPLICABLE' END
    )::TEXT || ',' ||
    '"providerLedgerAmountCents":' || CASE intent.terminal_path
      WHEN 'SETTLED' THEN intent.provider_amount_cents::TEXT ELSE '0' END || ',' ||
    CASE WHEN provider_release_event_id IS NULL THEN '' ELSE
      '"providerReleaseEventId":' || to_jsonb(provider_release_event_id::TEXT)::TEXT || ',' END ||
    '"providerReleaseState":' || to_jsonb(
      CASE intent.terminal_path WHEN 'SETTLED' THEN 'RELEASED' ELSE 'NOT_APPLICABLE' END
    )::TEXT || ',' ||
    '"reconciliationState":' || to_jsonb(
      CASE intent.terminal_path WHEN 'SETTLED' THEN 'MATCHED' ELSE 'CLOSED' END
    )::TEXT || ',' ||
    '"reconciliationVersion":' || (intent.starting_reconciliation_version + 1)::TEXT || ',' ||
    '"recordedBy":' || to_jsonb(intent.requested_by::TEXT)::TEXT || ',' ||
    CASE WHEN refund_event_id IS NULL THEN '' ELSE
      '"refundEventId":' || to_jsonb(refund_event_id::TEXT)::TEXT || ',' END ||
    '"refundState":' || to_jsonb(
      CASE intent.terminal_path WHEN 'FULL_REFUND' THEN 'REFUNDED' ELSE 'NOT_APPLICABLE' END
    )::TEXT || ',' ||
    '"reversalState":"NOT_APPLICABLE",' ||
    CASE WHEN settlement_event_id IS NULL THEN '' ELSE
      '"settlementEventId":' || to_jsonb(settlement_event_id::TEXT)::TEXT || ',' END ||
    '"settlementState":' || to_jsonb(
      CASE intent.terminal_path WHEN 'SETTLED' THEN 'SETTLED' ELSE 'NOT_APPLICABLE' END
    )::TEXT || ',' ||
    CASE WHEN intent.prior_reconciliation_fact_id IS NULL THEN '' ELSE
      '"supersedesFactId":' ||
      to_jsonb(intent.prior_reconciliation_fact_id::TEXT)::TEXT || ',' END ||
    '"voidState":"NOT_APPLICABLE",' ||
    '"workOrderId":' || to_jsonb(intent.work_order_id::TEXT)::TEXT ||
    '}';

  RETURN encode(digest(stable_snapshot, 'sha256'), 'hex');
END;
$$;

-- RECONCILE has no PREPARED lifecycle row. Its REQUESTED fact must therefore
-- prove the same terminal intent identity directly before adapter dispatch.
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
  IF task_record.id IS NULL OR task_record.automation_classification <> 'CONTROLLED_TEST' THEN
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
    digest(expected_provider_request, 'sha256'),
    'hex'
  );
  IF NEW.provider_kind <> 'FAKE'
     OR NEW.provider_expected_version <> 0
     OR NEW.operation_id <> public.universal_v1_fake_terminal_operation_id_v1(
          intent.idempotency_key,
          'reconciliation'
        )
     OR NEW.idempotency_key <> intent.idempotency_key || ':reconciliation'
     OR NEW.work_order_id <> intent.work_order_id
     OR NEW.related_operation_id <> expected_related_operation_id
     OR num_nonnulls(
          NEW.prepared_financial_command_id,
          NEW.prepared_authority_sha256,
          NEW.task_draft_id,
          NEW.task_id,
          NEW.amount_cents,
          NEW.currency
        ) <> 0
     OR NEW.recorded_actor_id <> intent.requested_by
     OR NEW.recorded_actor_kind <> 'PARTICIPANT'
     OR expected_reconciliation_snapshot_sha256 IS NULL
     OR NEW.request_sha256 IS DISTINCT FROM expected_provider_request_sha256 THEN
    RAISE EXCEPTION 'HXUV1-FTL-44: reconciliation REQUESTED fact does not match the exact terminal intent identity'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS zz_universal_v1_fake_terminal_reconcile_command_guard
  ON public.financial_provider_command_journal;
CREATE TRIGGER zz_universal_v1_fake_terminal_reconcile_command_guard
BEFORE INSERT ON public.financial_provider_command_journal
FOR EACH ROW
EXECUTE FUNCTION public.validate_universal_v1_fake_terminal_reconcile_command();

-- The recovery-v1 dispatch trigger runs first and establishes the exact fake
-- lease/request identity. This alphabetically-later guard is the final
-- commit-before-I/O authority check for terminal lifecycle commands. It takes
-- the same subject lock as provider-account materialization, then refuses a
-- dispatch if task, incident, eligibility, account, or provider authority
-- changed after PREPARED or REQUESTED committed. Frozen/unassigned task,
-- incident, and eligibility authority apply to both terminal paths; account,
-- payout, and current-provider authority remain SETTLED-only.
CREATE OR REPLACE FUNCTION public.validate_universal_v1_fake_terminal_dispatch_attempt()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  requested public.financial_provider_command_journal%ROWTYPE;
  prepared public.universal_v1_prepared_financial_commands%ROWTYPE;
  intent public.universal_v1_fake_terminal_lifecycle_intents%ROWTYPE;
  task_record public.tasks%ROWTYPE;
  work_order public.task_work_orders%ROWTYPE;
  eligibility public.task_provider_eligibility_decisions%ROWTYPE;
  account_fact public.universal_v1_fake_provider_account_facts%ROWTYPE;
BEGIN
  SELECT * INTO requested
    FROM public.financial_provider_command_journal
   WHERE command_id = NEW.command_id
   FOR SHARE;
  IF requested.command_id IS NULL
     OR requested.prepared_financial_command_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO prepared
    FROM public.universal_v1_prepared_financial_commands
   WHERE prepared_command_id = requested.prepared_financial_command_id
   FOR SHARE;
  IF prepared.prepared_command_id IS NULL
     OR prepared.work_order_id IS NULL
     OR prepared.operation_kind NOT IN (
       'CAPTURE', 'REFUND', 'SETTLE', 'FUND',
       'PROVIDER_RELEASE', 'PAYOUT', 'OBSERVE_BANK_SETTLEMENT'
     ) THEN
    RETURN NEW;
  END IF;

  SELECT * INTO task_record
    FROM public.tasks
   WHERE id = prepared.task_id
   FOR SHARE;
  SELECT * INTO work_order
    FROM public.task_work_orders
   WHERE id = prepared.work_order_id
   FOR SHARE;
  IF task_record.id IS NULL OR task_record.automation_classification <> 'CONTROLLED_TEST' THEN
    RETURN NEW;
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
     OR NEW.request_sha256 <> requested.request_sha256 THEN
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
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS zz_universal_v1_fake_terminal_dispatch_attempt_guard
  ON public.financial_provider_command_dispatch_attempts;
CREATE TRIGGER zz_universal_v1_fake_terminal_dispatch_attempt_guard
BEFORE INSERT ON public.financial_provider_command_dispatch_attempts
FOR EACH ROW
EXECUTE FUNCTION public.validate_universal_v1_fake_terminal_dispatch_attempt();

-- This bridge proves that the provider RECONCILE result and the canonical
-- reconciliation snapshot are the exact terminal consequence of the immutable
-- plan. It never inserts or repurposes a task_reconciliation_facts row.
CREATE TABLE IF NOT EXISTS public.universal_v1_fake_reconciliation_bridges (
  reconciliation_bridge_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Runtime-supplied exact references.
  terminal_intent_id UUID NOT NULL UNIQUE
    REFERENCES public.universal_v1_fake_terminal_lifecycle_intents(terminal_intent_id)
    ON DELETE RESTRICT,
  reconciliation_fact_id UUID NOT NULL UNIQUE
    REFERENCES public.task_reconciliation_facts(id) ON DELETE RESTRICT,
  command_id UUID NOT NULL UNIQUE
    REFERENCES public.financial_provider_command_journal(command_id) ON DELETE RESTRICT,
  dispatch_attempt_id UUID NOT NULL UNIQUE
    REFERENCES public.financial_provider_command_dispatch_attempts(dispatch_attempt_id)
    ON DELETE RESTRICT,
  outcome_fact_id UUID NOT NULL UNIQUE
    REFERENCES public.financial_provider_command_outcome_facts(outcome_fact_id)
    ON DELETE RESTRICT,
  fake_operation_event_id UUID NOT NULL UNIQUE
    REFERENCES public.hxos_fake_financial_operation_events_v1(event_id)
    ON DELETE RESTRICT,

  -- Database-derived terminal and provider-account authority.
  provider_account_fact_id UUID
    REFERENCES public.universal_v1_fake_provider_account_facts(provider_account_fact_id)
    ON DELETE RESTRICT,
  terminal_lifecycle_event_id UUID NOT NULL
    REFERENCES public.task_financial_security_events(id) ON DELETE RESTRICT,
  provider_state TEXT NOT NULL CHECK (provider_state IN ('MATCHED', 'MISMATCH')),
  reconciliation_version INTEGER NOT NULL CHECK (reconciliation_version > 0),
  provider_result_version BIGINT NOT NULL CHECK (
    provider_result_version BETWEEN 1 AND 9007199254740991
  ),
  reconciliation_identity_sha256 CHAR(64) NOT NULL CHECK (
    reconciliation_identity_sha256 ~ '^[a-f0-9]{64}$'
  ),
  authority_chain_sha256 CHAR(64) NOT NULL CHECK (
    authority_chain_sha256 ~ '^[a-f0-9]{64}$'
  ),
  materialized_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- Reproduce the application's stableJson(snapshot) byte-for-byte from the
-- canonical reconciliation row. Keys are lexical, absent optional UUIDs are
-- omitted, arrays preserve ordinal order without whitespace, and UUIDs are
-- canonical lowercase strings.
CREATE OR REPLACE FUNCTION public.universal_v1_reconciliation_snapshot_sha256_v1(
  checked_reconciliation_fact_id UUID
)
RETURNS CHAR(64)
LANGUAGE plpgsql
STABLE
STRICT
PARALLEL SAFE
AS $$
DECLARE
  reconciliation public.task_reconciliation_facts%ROWTYPE;
  mismatch_json TEXT;
  stable_snapshot TEXT;
BEGIN
  SELECT * INTO reconciliation
    FROM public.task_reconciliation_facts
   WHERE id = checked_reconciliation_fact_id;
  IF reconciliation.id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(
           string_agg(to_jsonb(code)::TEXT, ',' ORDER BY ordinal),
           ''
         )
    INTO mismatch_json
    FROM unnest(reconciliation.mismatch_codes) WITH ORDINALITY AS mismatch(code, ordinal);

  stable_snapshot := '{' ||
    CASE WHEN reconciliation.bank_settlement_event_id IS NULL THEN '' ELSE
      '"bankSettlementEventId":' ||
      to_jsonb(reconciliation.bank_settlement_event_id::TEXT)::TEXT || ',' END ||
    '"bankSettlementState":' || to_jsonb(reconciliation.bank_settlement_state)::TEXT || ',' ||
    CASE WHEN reconciliation.capture_event_id IS NULL THEN '' ELSE
      '"captureEventId":' || to_jsonb(reconciliation.capture_event_id::TEXT)::TEXT || ',' END ||
    '"captureState":' || to_jsonb(reconciliation.capture_state)::TEXT || ',' ||
    '"currency":' || to_jsonb(reconciliation.currency::TEXT)::TEXT || ',' ||
    '"customerLedgerAmountCents":' || reconciliation.customer_ledger_amount_cents::TEXT || ',' ||
    '"expectedVersion":' || reconciliation.expected_version::TEXT || ',' ||
    CASE WHEN reconciliation.funding_event_id IS NULL THEN '' ELSE
      '"fundingEventId":' || to_jsonb(reconciliation.funding_event_id::TEXT)::TEXT || ',' END ||
    '"fundingState":' || to_jsonb(reconciliation.funding_state)::TEXT || ',' ||
    '"ledgerState":' || to_jsonb(reconciliation.ledger_state)::TEXT || ',' ||
    '"mismatchCodes":[' || mismatch_json || '],' ||
    CASE WHEN reconciliation.payout_event_id IS NULL THEN '' ELSE
      '"payoutEventId":' || to_jsonb(reconciliation.payout_event_id::TEXT)::TEXT || ',' END ||
    '"payoutState":' || to_jsonb(reconciliation.payout_state)::TEXT || ',' ||
    '"providerLedgerAmountCents":' || reconciliation.provider_ledger_amount_cents::TEXT || ',' ||
    CASE WHEN reconciliation.provider_release_event_id IS NULL THEN '' ELSE
      '"providerReleaseEventId":' ||
      to_jsonb(reconciliation.provider_release_event_id::TEXT)::TEXT || ',' END ||
    '"providerReleaseState":' || to_jsonb(reconciliation.provider_release_state)::TEXT || ',' ||
    '"reconciliationState":' || to_jsonb(reconciliation.reconciliation_state)::TEXT || ',' ||
    '"reconciliationVersion":' || reconciliation.reconciliation_version::TEXT || ',' ||
    '"recordedBy":' || to_jsonb(reconciliation.recorded_by::TEXT)::TEXT || ',' ||
    CASE WHEN reconciliation.refund_event_id IS NULL THEN '' ELSE
      '"refundEventId":' || to_jsonb(reconciliation.refund_event_id::TEXT)::TEXT || ',' END ||
    '"refundState":' || to_jsonb(reconciliation.refund_state)::TEXT || ',' ||
    CASE WHEN reconciliation.reversal_event_id IS NULL THEN '' ELSE
      '"reversalEventId":' || to_jsonb(reconciliation.reversal_event_id::TEXT)::TEXT || ',' END ||
    '"reversalState":' || to_jsonb(reconciliation.reversal_state)::TEXT || ',' ||
    CASE WHEN reconciliation.settlement_event_id IS NULL THEN '' ELSE
      '"settlementEventId":' || to_jsonb(reconciliation.settlement_event_id::TEXT)::TEXT || ',' END ||
    '"settlementState":' || to_jsonb(reconciliation.settlement_state)::TEXT || ',' ||
    CASE WHEN reconciliation.supersedes_fact_id IS NULL THEN '' ELSE
      '"supersedesFactId":' || to_jsonb(reconciliation.supersedes_fact_id::TEXT)::TEXT || ',' END ||
    CASE WHEN reconciliation.void_event_id IS NULL THEN '' ELSE
      '"voidEventId":' || to_jsonb(reconciliation.void_event_id::TEXT)::TEXT || ',' END ||
    '"voidState":' || to_jsonb(reconciliation.void_state)::TEXT || ',' ||
    '"workOrderId":' || to_jsonb(reconciliation.work_order_id::TEXT)::TEXT ||
    '}';

  RETURN encode(digest(stable_snapshot, 'sha256'), 'hex');
END;
$$;

CREATE OR REPLACE FUNCTION public.validate_universal_v1_fake_reconciliation_bridge()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  intent public.universal_v1_fake_terminal_lifecycle_intents%ROWTYPE;
  reconciliation public.task_reconciliation_facts%ROWTYPE;
  account_fact public.universal_v1_fake_provider_account_facts%ROWTYPE;
  requested public.financial_provider_command_journal%ROWTYPE;
  attempted public.financial_provider_command_dispatch_attempts%ROWTYPE;
  outcome public.financial_provider_command_outcome_facts%ROWTYPE;
  fake_event public.hxos_fake_financial_operation_events_v1%ROWTYPE;
  fake_operation public.hxos_fake_financial_operations_v1%ROWTYPE;
  capture_bridge public.universal_v1_fake_financial_lifecycle_bridges%ROWTYPE;
  refund_bridge public.universal_v1_fake_financial_lifecycle_bridges%ROWTYPE;
  settlement_bridge public.universal_v1_fake_financial_lifecycle_bridges%ROWTYPE;
  funding_bridge public.universal_v1_fake_financial_lifecycle_bridges%ROWTYPE;
  release_bridge public.universal_v1_fake_financial_lifecycle_bridges%ROWTYPE;
  payout_bridge public.universal_v1_fake_financial_lifecycle_bridges%ROWTYPE;
  bank_bridge public.universal_v1_fake_financial_lifecycle_bridges%ROWTYPE;
  payout_fake_event public.hxos_fake_financial_operation_events_v1%ROWTYPE;
  latest_attempt_id UUID;
  terminal_operation_id UUID;
  terminal_event_id UUID;
  external_reference_sha256 CHAR(64);
  expected_provider_result_sha256 CHAR(64);
  derived_reconciliation_identity CHAR(64);
  reconciliation_snapshot_sha256 CHAR(64);
BEGIN
  SELECT * INTO intent
    FROM public.universal_v1_fake_terminal_lifecycle_intents
   WHERE terminal_intent_id = NEW.terminal_intent_id
   FOR SHARE;
  SELECT * INTO reconciliation
    FROM public.task_reconciliation_facts
   WHERE id = NEW.reconciliation_fact_id
   FOR SHARE;
  IF intent.terminal_intent_id IS NULL OR reconciliation.id IS NULL THEN
    RAISE EXCEPTION 'HXUV1-FTL-20: reconciliation bridge requires exact intent and canonical reconciliation facts'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext('universal-v1-fake-terminal-lifecycle-intent-v1'),
    hashtext(intent.work_order_id::TEXT)
  );

  SELECT * INTO capture_bridge
    FROM public.universal_v1_fake_financial_lifecycle_bridges
   WHERE task_financial_security_event_id = reconciliation.capture_event_id
   FOR SHARE;
  IF reconciliation.refund_event_id IS NOT NULL THEN
    SELECT * INTO refund_bridge
      FROM public.universal_v1_fake_financial_lifecycle_bridges
     WHERE task_financial_security_event_id = reconciliation.refund_event_id
     FOR SHARE;
  END IF;
  IF reconciliation.settlement_event_id IS NOT NULL THEN
    SELECT * INTO settlement_bridge
      FROM public.universal_v1_fake_financial_lifecycle_bridges
     WHERE task_financial_security_event_id = reconciliation.settlement_event_id
     FOR SHARE;
  END IF;
  IF reconciliation.funding_event_id IS NOT NULL THEN
    SELECT * INTO funding_bridge
      FROM public.universal_v1_fake_financial_lifecycle_bridges
     WHERE task_financial_security_event_id = reconciliation.funding_event_id
     FOR SHARE;
  END IF;
  IF reconciliation.provider_release_event_id IS NOT NULL THEN
    SELECT * INTO release_bridge
      FROM public.universal_v1_fake_financial_lifecycle_bridges
     WHERE task_financial_security_event_id = reconciliation.provider_release_event_id
     FOR SHARE;
  END IF;
  IF reconciliation.payout_event_id IS NOT NULL THEN
    SELECT * INTO payout_bridge
      FROM public.universal_v1_fake_financial_lifecycle_bridges
     WHERE task_financial_security_event_id = reconciliation.payout_event_id
     FOR SHARE;
  END IF;
  IF reconciliation.bank_settlement_event_id IS NOT NULL THEN
    SELECT * INTO bank_bridge
      FROM public.universal_v1_fake_financial_lifecycle_bridges
     WHERE task_financial_security_event_id = reconciliation.bank_settlement_event_id
     FOR SHARE;
  END IF;

  IF reconciliation.work_order_id <> intent.work_order_id
     OR reconciliation.reconciliation_version <> intent.starting_reconciliation_version + 1
     OR reconciliation.expected_version <> intent.starting_reconciliation_version
     OR reconciliation.supersedes_fact_id IS DISTINCT FROM intent.prior_reconciliation_fact_id
     OR reconciliation.recorded_by IS DISTINCT FROM intent.requested_by
     OR reconciliation.ledger_state <> 'MATCHED'
     OR cardinality(reconciliation.mismatch_codes) <> 0
     OR capture_bridge.bridge_id IS NULL
     OR capture_bridge.task_id IS DISTINCT FROM intent.task_id
     OR capture_bridge.scope_version_id IS DISTINCT FROM intent.scope_version_id
     OR capture_bridge.lifecycle_event_kind <> 'CAPTURED'
     OR capture_bridge.lifecycle_status <> 'SUCCEEDED'
     OR capture_bridge.lifecycle_expected_version <> intent.starting_financial_version + 1
     OR capture_bridge.completion_fact_id IS DISTINCT FROM intent.completion_fact_id
     OR capture_bridge.predecessor_event_id IS DISTINCT FROM intent.starting_financial_event_id THEN
    RAISE EXCEPTION 'HXUV1-FTL-21: reconciliation does not bind the exact terminal intent and capture prefix'
      USING ERRCODE = 'P0001';
  END IF;

  IF intent.terminal_path = 'SETTLED' THEN
    SELECT * INTO account_fact
      FROM public.universal_v1_fake_provider_account_facts
     WHERE provider_account_fact_id = intent.provider_account_fact_id
     FOR SHARE;
    SELECT * INTO payout_fake_event
      FROM public.hxos_fake_financial_operation_events_v1
     WHERE event_id = payout_bridge.fake_operation_event_id
     FOR SHARE;
    IF reconciliation.reconciliation_state <> 'MATCHED'
       OR reconciliation.void_event_id IS NOT NULL
       OR reconciliation.refund_event_id IS NOT NULL
       OR reconciliation.reversal_event_id IS NOT NULL
       OR reconciliation.capture_state <> 'CAPTURED'
       OR reconciliation.refund_state <> 'NOT_APPLICABLE'
       OR reconciliation.settlement_state <> 'SETTLED'
       OR reconciliation.funding_state <> 'FUNDED'
       OR reconciliation.provider_release_state <> 'RELEASED'
       OR reconciliation.payout_state <> 'PAID'
       OR reconciliation.bank_settlement_state <> 'SETTLED'
       OR reconciliation.customer_ledger_amount_cents <> intent.customer_amount_cents
       OR reconciliation.provider_ledger_amount_cents <> intent.provider_amount_cents
       OR reconciliation.currency <> intent.currency
       OR settlement_bridge.lifecycle_event_kind <> 'SETTLEMENT_OBSERVED'
       OR settlement_bridge.lifecycle_expected_version <> intent.starting_financial_version + 2
       OR settlement_bridge.predecessor_event_id <> capture_bridge.task_financial_security_event_id
       OR funding_bridge.lifecycle_event_kind <> 'FUNDING_OBSERVED'
       OR funding_bridge.lifecycle_expected_version <> intent.starting_financial_version + 3
       OR funding_bridge.predecessor_event_id <> settlement_bridge.task_financial_security_event_id
       OR release_bridge.lifecycle_event_kind <> 'PROVIDER_RELEASED'
       OR release_bridge.lifecycle_expected_version <> intent.starting_financial_version + 4
       OR release_bridge.predecessor_event_id <> funding_bridge.task_financial_security_event_id
       OR payout_bridge.lifecycle_event_kind <> 'PAYOUT_OBSERVED'
       OR payout_bridge.lifecycle_expected_version <> intent.starting_financial_version + 5
       OR payout_bridge.predecessor_event_id <> release_bridge.task_financial_security_event_id
       OR bank_bridge.lifecycle_event_kind <> 'BANK_SETTLEMENT_OBSERVED'
       OR bank_bridge.lifecycle_expected_version <> intent.starting_financial_version + 6
       OR bank_bridge.predecessor_event_id <> payout_bridge.task_financial_security_event_id
       OR account_fact.provider_account_fact_id IS NULL
       OR account_fact.provider_account_fact_id IS DISTINCT FROM intent.provider_account_fact_id
       OR account_fact.account_state <> 'ENABLED'
       OR account_fact.payouts_enabled IS NOT TRUE
       OR encode(
            digest(payout_fake_event.metadata->>'providerAccountReference', 'sha256'),
            'hex'
          ) IS DISTINCT FROM account_fact.provider_account_reference_sha256 THEN
      RAISE EXCEPTION 'HXUV1-FTL-22: SETTLED reconciliation requires the fixed exact lifecycle and enabled provider-account authority'
        USING ERRCODE = 'P0001';
    END IF;
    terminal_operation_id := bank_bridge.fake_operation_id;
    terminal_event_id := bank_bridge.task_financial_security_event_id;
  ELSE
    IF reconciliation.reconciliation_state <> 'CLOSED'
       OR intent.provider_account_fact_id IS NOT NULL
       OR reconciliation.void_event_id IS NOT NULL
       OR reconciliation.reversal_event_id IS NOT NULL
       OR reconciliation.settlement_event_id IS NOT NULL
       OR reconciliation.funding_event_id IS NOT NULL
       OR reconciliation.provider_release_event_id IS NOT NULL
       OR reconciliation.payout_event_id IS NOT NULL
       OR reconciliation.bank_settlement_event_id IS NOT NULL
       OR reconciliation.capture_state <> 'CAPTURED'
       OR reconciliation.refund_state <> 'REFUNDED'
       OR reconciliation.settlement_state <> 'NOT_APPLICABLE'
       OR reconciliation.funding_state <> 'NOT_APPLICABLE'
       OR reconciliation.provider_release_state <> 'NOT_APPLICABLE'
       OR reconciliation.payout_state <> 'NOT_APPLICABLE'
       OR reconciliation.bank_settlement_state <> 'NOT_APPLICABLE'
       OR reconciliation.customer_ledger_amount_cents <> 0
       OR reconciliation.provider_ledger_amount_cents <> 0
       OR reconciliation.currency <> intent.currency
       OR refund_bridge.lifecycle_event_kind <> 'REFUNDED'
       OR refund_bridge.lifecycle_status <> 'SUCCEEDED'
       OR refund_bridge.lifecycle_expected_version <> intent.starting_financial_version + 2
       OR refund_bridge.predecessor_event_id <> capture_bridge.task_financial_security_event_id
       OR refund_bridge.amount_cents <> intent.customer_amount_cents THEN
      RAISE EXCEPTION 'HXUV1-FTL-23: FULL_REFUND reconciliation requires the fixed exact capture/refund plan and zero ledgers'
        USING ERRCODE = 'P0001';
    END IF;
    terminal_operation_id := refund_bridge.fake_operation_id;
    terminal_event_id := refund_bridge.task_financial_security_event_id;
  END IF;

  SELECT * INTO requested
    FROM public.financial_provider_command_journal
   WHERE command_id = NEW.command_id
   FOR SHARE;
  SELECT * INTO attempted
    FROM public.financial_provider_command_dispatch_attempts
   WHERE dispatch_attempt_id = NEW.dispatch_attempt_id
   FOR SHARE;
  SELECT * INTO outcome
    FROM public.financial_provider_command_outcome_facts
   WHERE outcome_fact_id = NEW.outcome_fact_id
   FOR SHARE;
  SELECT * INTO fake_event
    FROM public.hxos_fake_financial_operation_events_v1
   WHERE event_id = NEW.fake_operation_event_id
   FOR SHARE;
  SELECT * INTO fake_operation
    FROM public.hxos_fake_financial_operations_v1
   WHERE operation_id = fake_event.operation_id
   FOR SHARE;
  SELECT dispatch_attempt_id INTO latest_attempt_id
    FROM public.financial_provider_command_dispatch_attempts
   WHERE command_id = NEW.command_id
   ORDER BY attempt_number DESC
   LIMIT 1;

  external_reference_sha256 := encode(digest(fake_event.external_reference, 'sha256'), 'hex');
  expected_provider_result_sha256 := encode(
    digest(
      requested.operation_id::TEXT || ':' || requested.operation_kind || ':' ||
      requested.provider_kind || ':' || outcome.provider_state || ':' ||
      outcome.provider_result_version::TEXT || ':::' ||
      external_reference_sha256 || ':' || outcome.retryable::TEXT,
      'sha256'
    ),
    'hex'
  );
  reconciliation_snapshot_sha256 :=
    public.universal_v1_reconciliation_snapshot_sha256_v1(reconciliation.id);
  IF requested.command_id IS NULL
     OR requested.operation_kind <> 'RECONCILE'
     OR requested.provider_kind <> 'FAKE'
     OR requested.work_order_id IS DISTINCT FROM intent.work_order_id
     OR requested.related_operation_id IS DISTINCT FROM terminal_operation_id
     OR requested.recorded_actor_id IS DISTINCT FROM reconciliation.recorded_by
     OR requested.recorded_actor_kind IS DISTINCT FROM 'PARTICIPANT'
     OR attempted.command_id IS DISTINCT FROM requested.command_id
     OR attempted.request_sha256 IS DISTINCT FROM requested.request_sha256
     OR attempted.dispatch_attempt_id IS DISTINCT FROM latest_attempt_id
     OR outcome.command_id IS DISTINCT FROM requested.command_id
     OR outcome.dispatch_attempt_id IS DISTINCT FROM attempted.dispatch_attempt_id
     OR outcome.recovery_lease_id IS DISTINCT FROM attempted.recovery_lease_id
     OR outcome.outcome_kind <> 'OUTCOME_OBSERVED'
     OR outcome.retryable IS TRUE
     OR outcome.provider_state <> 'MATCHED'
     OR outcome.provider_result_sha256 IS DISTINCT FROM expected_provider_result_sha256
     OR outcome.provider_result_version IS DISTINCT FROM fake_event.event_version
     OR outcome.external_reference_sha256 IS DISTINCT FROM external_reference_sha256
     OR fake_operation.provider_kind <> 'FAKE'
     OR fake_operation.operation_kind <> 'RECONCILE'
     OR fake_operation.operation_id IS DISTINCT FROM requested.operation_id
     OR fake_operation.related_operation_id IS DISTINCT FROM terminal_operation_id
     OR fake_event.operation_id IS DISTINCT FROM requested.operation_id
     OR fake_event.operation_kind <> 'RECONCILE'
     OR fake_event.state <> 'MATCHED'
     OR fake_event.idempotency_key IS DISTINCT FROM requested.idempotency_key
     OR fake_event.event_version IS DISTINCT FROM requested.provider_expected_version + 1
     OR fake_event.provider_request_sha256 IS DISTINCT FROM requested.request_sha256
     OR fake_event.identity_sha256 IS DISTINCT FROM fake_operation.identity_sha256
     OR fake_event.related_operation_id IS DISTINCT FROM terminal_operation_id
     OR reconciliation.evidence->>'operationId' IS DISTINCT FROM requested.operation_id::TEXT
     OR reconciliation.evidence->>'providerState' IS DISTINCT FROM 'MATCHED'
     OR COALESCE(reconciliation.evidence->>'providerOperationVersion', '') !~ '^[0-9]+$'
     OR (reconciliation.evidence->>'providerOperationVersion')::BIGINT
          IS DISTINCT FROM fake_event.event_version
     OR reconciliation.evidence->>'providerExternalReference'
          IS DISTINCT FROM fake_event.external_reference
     OR COALESCE(reconciliation.evidence->>'reconciliationSnapshotSha256', '')
          !~ '^[a-f0-9]{64}$'
     OR reconciliation.evidence->>'reconciliationSnapshotSha256'
          IS DISTINCT FROM reconciliation_snapshot_sha256
     OR fake_event.metadata->>'reconciliationSnapshotSha256'
          IS DISTINCT FROM reconciliation_snapshot_sha256
     OR COALESCE(reconciliation.evidence->>'applicationRequestSha256', '')
          !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'HXUV1-FTL-24: reconciliation bridge requires the exact terminal fake RECONCILE command, outcome, raw event, and canonical snapshot'
      USING ERRCODE = 'P0001';
  END IF;

  derived_reconciliation_identity := encode(
    digest(
      'HUSTLEXP_UNIVERSAL_V1_FAKE_RECONCILIATION_FACT_V1:' ||
      reconciliation.id::TEXT || ':' || reconciliation.work_order_id::TEXT || ':' ||
      reconciliation.reconciliation_version::TEXT || ':' ||
      reconciliation.expected_version::TEXT || ':' || reconciliation.reconciliation_state || ':' ||
      reconciliation.ledger_state || ':' || reconciliation.customer_ledger_amount_cents::TEXT || ':' ||
      reconciliation.provider_ledger_amount_cents::TEXT || ':' || reconciliation.currency || ':' ||
      reconciliation.recorded_by::TEXT || ':' || reconciliation_snapshot_sha256,
      'sha256'
    ),
    'hex'
  );

  NEW.terminal_lifecycle_event_id := terminal_event_id;
  NEW.provider_account_fact_id := intent.provider_account_fact_id;
  NEW.provider_state := outcome.provider_state;
  NEW.reconciliation_version := reconciliation.reconciliation_version;
  NEW.provider_result_version := outcome.provider_result_version;
  NEW.reconciliation_identity_sha256 := derived_reconciliation_identity;
  NEW.materialized_at := clock_timestamp();
  NEW.authority_chain_sha256 := encode(
    digest(
      'HUSTLEXP_UNIVERSAL_V1_FAKE_RECONCILIATION_BRIDGE_V1:' ||
      intent.authority_context_sha256 || ':' || reconciliation.id::TEXT || ':' ||
      derived_reconciliation_identity || ':' ||
      reconciliation_snapshot_sha256 || ':' ||
      COALESCE(account_fact.authority_sha256, '') || ':' ||
      requested.command_id::TEXT || ':' || requested.command_identity_sha256 || ':' ||
      attempted.dispatch_attempt_id::TEXT || ':' || attempted.attempt_identity_sha256 || ':' ||
      outcome.outcome_fact_id::TEXT || ':' || outcome.outcome_identity_sha256 || ':' ||
      fake_event.event_id::TEXT || ':' || fake_event.response_sha256 || ':' ||
      terminal_event_id::TEXT,
      'sha256'
    ),
    'hex'
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS universal_v1_fake_reconciliation_bridge_validate
  ON public.universal_v1_fake_reconciliation_bridges;
CREATE TRIGGER universal_v1_fake_reconciliation_bridge_validate
BEFORE INSERT ON public.universal_v1_fake_reconciliation_bridges
FOR EACH ROW
EXECUTE FUNCTION public.validate_universal_v1_fake_reconciliation_bridge();

-- A newly inserted canonical terminal reconciliation for an existing intent
-- must receive its exact bridge in the same transaction. Historical rows are
-- neither backfilled nor reinterpreted.
CREATE OR REPLACE FUNCTION public.require_universal_v1_fake_reconciliation_bridge()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  matching_terminal_intent_id UUID;
  controlled_test_work_order BOOLEAN;
BEGIN
  SELECT task.automation_classification = 'CONTROLLED_TEST'
    INTO controlled_test_work_order
    FROM public.task_work_orders work_order
    JOIN public.tasks task ON task.id = work_order.task_id
   WHERE work_order.id = NEW.work_order_id;
  IF controlled_test_work_order IS NOT TRUE THEN
    RETURN NULL;
  END IF;

  SELECT intent.terminal_intent_id
    INTO matching_terminal_intent_id
    FROM public.universal_v1_fake_terminal_lifecycle_intents intent
   WHERE intent.work_order_id = NEW.work_order_id
     AND NEW.reconciliation_version = intent.starting_reconciliation_version + 1;
  IF matching_terminal_intent_id IS NULL
     OR NOT EXISTS (
       SELECT 1
         FROM public.universal_v1_fake_reconciliation_bridges bridge
        WHERE bridge.reconciliation_fact_id = NEW.id
          AND bridge.terminal_intent_id = matching_terminal_intent_id
     ) THEN
    RAISE EXCEPTION 'HXUV1-FTL-25: controlled-test canonical reconciliation requires its exact terminal intent and fake bridge in the same transaction'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS universal_v1_fake_reconciliation_bridge_required
  ON public.task_reconciliation_facts;
CREATE CONSTRAINT TRIGGER universal_v1_fake_reconciliation_bridge_required
AFTER INSERT ON public.task_reconciliation_facts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.require_universal_v1_fake_reconciliation_bridge();

CREATE OR REPLACE FUNCTION public.reject_universal_v1_fake_terminal_authority_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'HXUV1-FTL-30: fake terminal authority evidence is append-only'
    USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS universal_v1_fake_terminal_intent_no_update_delete
  ON public.universal_v1_fake_terminal_lifecycle_intents;
CREATE TRIGGER universal_v1_fake_terminal_intent_no_update_delete
BEFORE UPDATE OR DELETE ON public.universal_v1_fake_terminal_lifecycle_intents
FOR EACH ROW
EXECUTE FUNCTION public.reject_universal_v1_fake_terminal_authority_mutation();

DROP TRIGGER IF EXISTS universal_v1_fake_terminal_intent_no_truncate
  ON public.universal_v1_fake_terminal_lifecycle_intents;
CREATE TRIGGER universal_v1_fake_terminal_intent_no_truncate
BEFORE TRUNCATE ON public.universal_v1_fake_terminal_lifecycle_intents
FOR EACH STATEMENT
EXECUTE FUNCTION public.reject_universal_v1_fake_terminal_authority_mutation();

DROP TRIGGER IF EXISTS universal_v1_fake_provider_account_fact_no_update_delete
  ON public.universal_v1_fake_provider_account_facts;
CREATE TRIGGER universal_v1_fake_provider_account_fact_no_update_delete
BEFORE UPDATE OR DELETE ON public.universal_v1_fake_provider_account_facts
FOR EACH ROW
EXECUTE FUNCTION public.reject_universal_v1_fake_terminal_authority_mutation();

DROP TRIGGER IF EXISTS universal_v1_fake_provider_account_fact_no_truncate
  ON public.universal_v1_fake_provider_account_facts;
CREATE TRIGGER universal_v1_fake_provider_account_fact_no_truncate
BEFORE TRUNCATE ON public.universal_v1_fake_provider_account_facts
FOR EACH STATEMENT
EXECUTE FUNCTION public.reject_universal_v1_fake_terminal_authority_mutation();

DROP TRIGGER IF EXISTS universal_v1_fake_reconciliation_bridge_no_update_delete
  ON public.universal_v1_fake_reconciliation_bridges;
CREATE TRIGGER universal_v1_fake_reconciliation_bridge_no_update_delete
BEFORE UPDATE OR DELETE ON public.universal_v1_fake_reconciliation_bridges
FOR EACH ROW
EXECUTE FUNCTION public.reject_universal_v1_fake_terminal_authority_mutation();

DROP TRIGGER IF EXISTS universal_v1_fake_reconciliation_bridge_no_truncate
  ON public.universal_v1_fake_reconciliation_bridges;
CREATE TRIGGER universal_v1_fake_reconciliation_bridge_no_truncate
BEFORE TRUNCATE ON public.universal_v1_fake_reconciliation_bridges
FOR EACH STATEMENT
EXECUTE FUNCTION public.reject_universal_v1_fake_terminal_authority_mutation();

COMMENT ON TABLE public.universal_v1_fake_terminal_lifecycle_intents IS
  'Append-only, database-derived SETTLED/FULL_REFUND plan claim for one completed, unassigned, payment-frozen controlled-test Work Order.';
COMMENT ON TABLE public.universal_v1_fake_provider_account_facts IS
  'Append-only provider-authored fake account authority derived from exact provider-scoped onboarding and refresh command, dispatch, outcome, and raw-event facts before terminal execution. No raw account reference is stored.';
COMMENT ON TABLE public.universal_v1_fake_reconciliation_bridges IS
  'Append-only bridge from one immutable terminal plan and exact fake RECONCILE result to the canonical task_reconciliation_facts row. It is not a synthetic reconciliation intent.';
COMMENT ON TABLE public.hxos_fake_financial_schema_evidence_v5 IS
  'Append-only checksum evidence for the nonproduction fake terminal-lifecycle authority fixture.';

REVOKE ALL ON TABLE public.hxos_fake_financial_schema_evidence_v5 FROM PUBLIC;
REVOKE ALL ON TABLE public.universal_v1_fake_terminal_lifecycle_intents FROM PUBLIC;
REVOKE ALL ON TABLE public.universal_v1_fake_provider_account_facts FROM PUBLIC;
REVOKE ALL ON TABLE public.universal_v1_fake_reconciliation_bridges FROM PUBLIC;
REVOKE ALL ON TABLE public.universal_v1_fake_terminal_plan_steps_v1 FROM PUBLIC;
REVOKE ALL ON FUNCTION public.universal_v1_fake_terminal_plan_v1(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.universal_v1_fake_terminal_operation_id_v1(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.universal_v1_fake_terminal_reconciliation_snapshot_sha256_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.universal_v1_reconciliation_snapshot_sha256_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.validate_universal_v1_fake_terminal_lifecycle_intent() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.validate_universal_v1_fake_provider_account_fact() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.validate_universal_v1_fake_terminal_prepared_command() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.validate_universal_v1_fake_terminal_reconcile_command() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.validate_universal_v1_fake_terminal_dispatch_attempt() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.validate_universal_v1_fake_reconciliation_bridge() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.require_universal_v1_fake_reconciliation_bridge() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_universal_v1_fake_terminal_authority_mutation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.universal_v1_fake_terminal_plan_v1(TEXT) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.universal_v1_fake_terminal_operation_id_v1(TEXT, TEXT) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.universal_v1_fake_terminal_reconciliation_snapshot_sha256_v1(UUID) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.universal_v1_reconciliation_snapshot_sha256_v1(UUID) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.validate_universal_v1_fake_terminal_lifecycle_intent() TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.validate_universal_v1_fake_provider_account_fact() TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.validate_universal_v1_fake_terminal_prepared_command() TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.validate_universal_v1_fake_terminal_reconcile_command() TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.validate_universal_v1_fake_terminal_dispatch_attempt() TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.validate_universal_v1_fake_reconciliation_bridge() TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.require_universal_v1_fake_reconciliation_bridge() TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION public.reject_universal_v1_fake_terminal_authority_mutation() TO CURRENT_USER;
