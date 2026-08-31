-- Append-only Universal V1 Work Order execution authority.
--
-- Execution state is separate from assignment, evidence, completion, capture,
-- settlement, and bank settlement. This migration creates no money effect and
-- keeps every Universal V1 task hard-assignment-free.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE public.task_work_orders
  ADD COLUMN IF NOT EXISTS execution_contract_version SMALLINT NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'task_work_orders_execution_contract_check'
      AND conrelid = 'public.task_work_orders'::regclass
  ) THEN
    ALTER TABLE public.task_work_orders
      ADD CONSTRAINT task_work_orders_execution_contract_check
      CHECK (execution_contract_version IN (0, 1));
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS public.task_work_order_execution_facts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id UUID NOT NULL
    REFERENCES public.task_work_orders(id) ON DELETE RESTRICT,
  task_id UUID NOT NULL REFERENCES public.tasks(id) ON DELETE RESTRICT,
  scope_version_id UUID NOT NULL
    REFERENCES public.task_scope_versions(id) ON DELETE RESTRICT,
  execution_version INTEGER NOT NULL CHECK (execution_version > 0),
  supersedes_fact_id UUID
    REFERENCES public.task_work_order_execution_facts(id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN (
    'MATERIALIZED',
    'ACKNOWLEDGED',
    'EN_ROUTE',
    'ARRIVED',
    'IN_PROGRESS',
    'PAUSED',
    'COMPLETION_SUBMITTED',
    'REWORK_REQUIRED',
    'COMPLETED'
  )),
  transition_kind TEXT NOT NULL CHECK (transition_kind IN (
    'MATERIALIZED',
    'ACKNOWLEDGE',
    'MARK_EN_ROUTE',
    'MARK_ARRIVED',
    'START_WORK',
    'PAUSE_WORK',
    'RESUME_WORK',
    'RESUME_REWORK',
    'COMPLETION_SUBMITTED',
    'COMPLETION_APPROVED',
    'COMPLETION_REJECTED',
    'APPLY_AMENDMENT'
  )),
  completion_fact_id UUID
    REFERENCES public.task_completion_facts(id) ON DELETE RESTRICT,
  work_order_amendment_id UUID
    REFERENCES public.task_work_order_amendments(id) ON DELETE RESTRICT,
  actor_role TEXT NOT NULL CHECK (
    actor_role IN ('CUSTOMER', 'PROVIDER', 'NAMED_OPERATOR')
  ),
  actor_user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  reason TEXT CHECK (reason IS NULL OR char_length(btrim(reason)) BETWEEN 3 AND 2000),
  idempotency_key TEXT NOT NULL CHECK (
    idempotency_key ~ '^[A-Za-z0-9:_-]{8,128}$'
  ),
  request_sha256 CHAR(64) NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  client_occurred_at TIMESTAMPTZ NOT NULL,
  policy_version TEXT NOT NULL CHECK (
    policy_version = 'universal-v1-work-order-execution-1.0.0'
  ),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (work_order_id, execution_version),
  UNIQUE (supersedes_fact_id),
  UNIQUE (completion_fact_id),
  UNIQUE (work_order_amendment_id),
  UNIQUE (actor_user_id, idempotency_key),
  CHECK (
    (
      execution_version = 1
      AND supersedes_fact_id IS NULL
      AND transition_kind = 'MATERIALIZED'
    )
    OR (
      execution_version > 1
      AND supersedes_fact_id IS NOT NULL
      AND transition_kind <> 'MATERIALIZED'
    )
  ),
  CHECK (
    (completion_fact_id IS NOT NULL) =
    (transition_kind IN (
      'COMPLETION_SUBMITTED',
      'COMPLETION_APPROVED',
      'COMPLETION_REJECTED'
    ))
  ),
  CHECK (
    (work_order_amendment_id IS NOT NULL) =
    (transition_kind = 'APPLY_AMENDMENT')
  )
);

ALTER TABLE public.proofs
  ADD COLUMN IF NOT EXISTS execution_fact_id UUID
    REFERENCES public.task_work_order_execution_facts(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS task_work_order_execution_latest_idx
  ON public.task_work_order_execution_facts(work_order_id, execution_version DESC);

CREATE INDEX IF NOT EXISTS proofs_execution_fact_idx
  ON public.proofs(execution_fact_id)
  WHERE execution_fact_id IS NOT NULL;

-- This function reproduces UniversalV1ExecutionContracts.stableJson exactly:
-- keys are lexical, UUIDs are lowercase, timestamps are canonical UTC ISO, and
-- a missing reason is omitted instead of represented as JSON null.
CREATE OR REPLACE FUNCTION public.universal_v1_execution_command_request_sha256(
  checked_actor_user_id UUID,
  checked_work_order_id UUID,
  checked_action TEXT,
  checked_expected_execution_version INTEGER,
  checked_expected_scope_version INTEGER,
  checked_idempotency_key TEXT,
  checked_client_occurred_at TIMESTAMPTZ,
  checked_reason TEXT
)
RETURNS CHAR(64)
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT encode(
    digest(
      '{' ||
      '"actor_user_id":' || to_json(checked_actor_user_id::TEXT)::TEXT || ',' ||
      '"command":{' ||
        '"action":' || to_json(checked_action)::TEXT || ',' ||
        '"client_ts":' || to_json(
          to_char(
            checked_client_occurred_at AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          )
        )::TEXT || ',' ||
        '"expected_execution_version":' || checked_expected_execution_version::TEXT || ',' ||
        '"expected_scope_version":' || checked_expected_scope_version::TEXT || ',' ||
        '"idempotency_key":' || to_json(checked_idempotency_key)::TEXT || ',' ||
        CASE
          WHEN checked_reason IS NULL THEN ''
          ELSE '"reason":' || to_json(checked_reason)::TEXT || ','
        END ||
        '"work_order_id":' || to_json(checked_work_order_id::TEXT)::TEXT ||
      '},' ||
      '"contract_version":1,' ||
      '"operation":"ADVANCE_WORK_ORDER_EXECUTION"' ||
      '}',
      'sha256'
    ),
    'hex'
  )::CHAR(64);
$$;

CREATE OR REPLACE FUNCTION public.universal_v1_execution_internal_request_sha256(
  checked_actor_user_id UUID,
  checked_work_order_id UUID,
  checked_transition_kind TEXT,
  checked_state TEXT,
  checked_expected_execution_version INTEGER,
  checked_scope_version_id UUID,
  checked_completion_fact_id UUID,
  checked_work_order_amendment_id UUID,
  checked_idempotency_key TEXT,
  checked_client_occurred_at TIMESTAMPTZ,
  checked_reason TEXT
)
RETURNS CHAR(64)
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT encode(
    digest(
      jsonb_build_object(
        'contract', 'HUSTLEXP_UNIVERSAL_V1_EXECUTION_INTERNAL_V1',
        'actorUserId', checked_actor_user_id,
        'workOrderId', checked_work_order_id,
        'transitionKind', checked_transition_kind,
        'state', checked_state,
        'expectedExecutionVersion', checked_expected_execution_version,
        'scopeVersionId', checked_scope_version_id,
        'completionFactId', checked_completion_fact_id,
        'workOrderAmendmentId', checked_work_order_amendment_id,
        'idempotencyKey', checked_idempotency_key,
        'clientOccurredAt', to_char(
          checked_client_occurred_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ),
        'reason', checked_reason
      )::TEXT,
      'sha256'
    ),
    'hex'
  )::CHAR(64);
$$;

CREATE OR REPLACE FUNCTION public.universal_v1_effective_work_order_scope_id(
  checked_work_order_id UUID
)
RETURNS UUID
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    (
      SELECT amendment.scope_version_id
      FROM public.task_work_order_amendments amendment
      WHERE amendment.work_order_id = checked_work_order_id
      ORDER BY amendment.amendment_version DESC
      LIMIT 1
    ),
    (
      SELECT work_order.scope_version_id
      FROM public.task_work_orders work_order
      WHERE work_order.id = checked_work_order_id
    )
  );
$$;

CREATE OR REPLACE FUNCTION public.enforce_universal_v1_execution_fact()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  work_order public.task_work_orders%ROWTYPE;
  task_record public.tasks%ROWTYPE;
  scope_record public.task_scope_versions%ROWTYPE;
  predecessor public.task_work_order_execution_facts%ROWTYPE;
  eligibility public.task_provider_eligibility_decisions%ROWTYPE;
  completion public.task_completion_facts%ROWTYPE;
  amendment public.task_work_order_amendments%ROWTYPE;
  expected_state TEXT;
  expected_internal_sha256 CHAR(64);
BEGIN
  -- The database, not a caller-controlled INSERT value, owns audit time.
  NEW.recorded_at := clock_timestamp();

  SELECT * INTO work_order
  FROM public.task_work_orders
  WHERE id = NEW.work_order_id
  FOR SHARE;

  SELECT * INTO task_record
  FROM public.tasks
  WHERE id = NEW.task_id
  FOR SHARE;

  SELECT * INTO scope_record
  FROM public.task_scope_versions
  WHERE id = NEW.scope_version_id
  FOR SHARE;

  IF work_order.id IS NULL
     OR task_record.id IS NULL
     OR scope_record.id IS NULL
     OR work_order.execution_contract_version <> 1
     OR work_order.task_id <> NEW.task_id
     OR task_record.work_order_id <> NEW.work_order_id
     OR task_record.universal_contract_version <> 1
     OR task_record.automation_classification <> 'CONTROLLED_TEST'
     OR task_record.universal_payment_posture <> 'PAYMENT_CREATION_FROZEN'
     OR task_record.worker_id IS NOT NULL
     OR task_record.active_scope_version_id <> NEW.scope_version_id
     OR scope_record.task_id <> NEW.task_id
     OR scope_record.universal_contract_version <> 1
     OR NOT EXISTS (
       SELECT 1
       FROM public.task_drafts draft
       WHERE draft.id = work_order.task_draft_id
         AND draft.universal_contract_version = 1
     )
     OR NOT EXISTS (
       SELECT 1
       FROM public.task_provider_eligibility_decisions current_eligibility
       WHERE current_eligibility.id = work_order.eligibility_decision_id
         AND current_eligibility.task_id = NEW.task_id
         AND current_eligibility.task_eligible IS TRUE
         AND current_eligibility.provider_user_id IS NOT DISTINCT FROM work_order.provider_user_id
         AND current_eligibility.provider_organization_id IS NOT DISTINCT FROM work_order.provider_organization_id
         AND public.universal_v1_invited_provider_authority_is_current(
           current_eligibility.provider_user_id,
           current_eligibility.provider_organization_id,
           current_eligibility.provider_class,
           current_eligibility.trade_credential_id,
           task_record.category,
           task_record.region_code
         ) IS TRUE
     )
     OR NOT EXISTS (
       SELECT 1
       FROM public.users actor
       WHERE actor.id = NEW.actor_user_id
         AND actor.account_status = 'ACTIVE'
         AND actor.is_minor IS FALSE
         AND COALESCE(actor.is_banned, FALSE) IS FALSE
     )
     OR NEW.policy_version <> 'universal-v1-work-order-execution-1.0.0' THEN
    RAISE EXCEPTION 'HXUV1-EXEC-1: execution fact must bind an exact unassigned Universal V1 Work Order and scope'
      USING ERRCODE = 'P0001';
  END IF;

  IF abs(extract(epoch FROM (clock_timestamp() - NEW.client_occurred_at))) > 300 THEN
    RAISE EXCEPTION 'HXUV1-EXEC-2: execution command timestamp is outside the accepted window'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.execution_version = 1 THEN
    IF NEW.supersedes_fact_id IS NOT NULL
       OR NEW.state <> 'MATERIALIZED'
       OR NEW.transition_kind <> 'MATERIALIZED'
       OR NEW.scope_version_id <> work_order.scope_version_id
       OR NEW.actor_role <> 'CUSTOMER'
       OR NEW.actor_user_id <> work_order.materialized_by
       OR NEW.completion_fact_id IS NOT NULL
       OR NEW.work_order_amendment_id IS NOT NULL
       OR NEW.reason IS NOT NULL THEN
      RAISE EXCEPTION 'HXUV1-EXEC-3: execution chain must begin with exact Work Order materialization'
        USING ERRCODE = 'P0001';
    END IF;

    expected_internal_sha256 := public.universal_v1_execution_internal_request_sha256(
      NEW.actor_user_id,
      NEW.work_order_id,
      NEW.transition_kind,
      NEW.state,
      0,
      NEW.scope_version_id,
      NULL,
      NULL,
      NEW.idempotency_key,
      NEW.client_occurred_at,
      NULL
    );
    IF NEW.request_sha256 IS DISTINCT FROM expected_internal_sha256 THEN
      RAISE EXCEPTION 'HXUV1-EXEC-4: materialization execution digest mismatch'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  SELECT * INTO predecessor
  FROM public.task_work_order_execution_facts
  WHERE id = NEW.supersedes_fact_id
  FOR SHARE;

  IF NOT FOUND
     OR predecessor.work_order_id <> NEW.work_order_id
     OR predecessor.task_id <> NEW.task_id
     OR NEW.execution_version <> predecessor.execution_version + 1 THEN
    RAISE EXCEPTION 'HXUV1-EXEC-5: execution facts must extend the exact latest predecessor by one version'
      USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.task_work_order_execution_facts successor
    WHERE successor.supersedes_fact_id = predecessor.id
  ) THEN
    RAISE EXCEPTION 'HXUV1-EXEC-6: execution fact predecessor already has a successor'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.transition_kind IN (
    'ACKNOWLEDGE',
    'MARK_EN_ROUTE',
    'MARK_ARRIVED',
    'START_WORK',
    'PAUSE_WORK',
    'RESUME_WORK',
    'RESUME_REWORK'
  ) THEN
    expected_state := CASE
      WHEN predecessor.state = 'MATERIALIZED' AND NEW.transition_kind = 'ACKNOWLEDGE'
        THEN 'ACKNOWLEDGED'
      WHEN predecessor.state = 'ACKNOWLEDGED' AND NEW.transition_kind = 'MARK_EN_ROUTE'
        THEN 'EN_ROUTE'
      WHEN predecessor.state = 'ACKNOWLEDGED' AND NEW.transition_kind = 'MARK_ARRIVED'
        THEN 'ARRIVED'
      WHEN predecessor.state = 'ACKNOWLEDGED' AND NEW.transition_kind = 'START_WORK'
        THEN 'IN_PROGRESS'
      WHEN predecessor.state = 'EN_ROUTE' AND NEW.transition_kind = 'MARK_ARRIVED'
        THEN 'ARRIVED'
      WHEN predecessor.state = 'ARRIVED' AND NEW.transition_kind = 'START_WORK'
        THEN 'IN_PROGRESS'
      WHEN predecessor.state = 'IN_PROGRESS' AND NEW.transition_kind = 'PAUSE_WORK'
        THEN 'PAUSED'
      WHEN predecessor.state = 'PAUSED' AND NEW.transition_kind = 'RESUME_WORK'
        THEN 'IN_PROGRESS'
      WHEN predecessor.state = 'REWORK_REQUIRED' AND NEW.transition_kind = 'RESUME_REWORK'
        THEN 'IN_PROGRESS'
      ELSE NULL
    END;

    IF expected_state IS NULL
       OR NEW.state <> expected_state
       OR NEW.scope_version_id <> predecessor.scope_version_id
       OR NEW.scope_version_id <> public.universal_v1_effective_work_order_scope_id(NEW.work_order_id)
       OR NEW.actor_role <> 'PROVIDER'
       OR NEW.completion_fact_id IS NOT NULL
       OR NEW.work_order_amendment_id IS NOT NULL
       OR NEW.idempotency_key !~ '^[A-Za-z0-9:_-]{16,96}$'
       OR (
         NEW.transition_kind = 'PAUSE_WORK'
         AND (
           NEW.reason IS NULL
           OR NEW.reason IS DISTINCT FROM btrim(NEW.reason)
           OR char_length(NEW.reason) NOT BETWEEN 3 AND 500
         )
       )
       OR (NEW.transition_kind <> 'PAUSE_WORK' AND NEW.reason IS NOT NULL) THEN
      RAISE EXCEPTION 'HXUV1-EXEC-7: invalid provider execution transition or scope binding'
        USING ERRCODE = 'P0001';
    END IF;

    SELECT * INTO eligibility
    FROM public.task_provider_eligibility_decisions
    WHERE id = work_order.eligibility_decision_id
    FOR SHARE;

    IF eligibility.id IS NULL
       OR public.universal_v1_invited_provider_authority_is_current(
         work_order.provider_user_id,
         work_order.provider_organization_id,
         eligibility.provider_class,
         eligibility.trade_credential_id,
         task_record.category,
         task_record.region_code
       ) IS NOT TRUE
       OR (
         NEW.actor_user_id <> work_order.provider_user_id
         AND (
           work_order.provider_organization_id IS NULL
           OR NOT EXISTS (
             SELECT 1
             FROM public.business_memberships membership
             JOIN public.business_organizations organization
               ON organization.id = membership.organization_id
             WHERE membership.organization_id = work_order.provider_organization_id
               AND membership.user_id = NEW.actor_user_id
               AND membership.status = 'ACTIVE'
               AND membership.role IN ('OWNER', 'ADMIN', 'DISPATCHER', 'CREW')
               AND organization.status = 'ACTIVE'
               AND organization.provider_enabled IS TRUE
           )
         )
       ) THEN
      RAISE EXCEPTION 'HXUV1-EXEC-8: current provider execution authority is absent'
        USING ERRCODE = 'P0001';
    END IF;

    IF NEW.transition_kind <> 'PAUSE_WORK'
       AND (
         EXISTS (
           SELECT 1 FROM public.task_safety_incidents incident
           WHERE incident.task_id = NEW.task_id
             AND incident.status NOT IN ('resolved', 'closed')
         )
         OR EXISTS (
           SELECT 1 FROM public.task_scope_change_proposals proposal
           WHERE proposal.task_id = NEW.task_id
             AND proposal.status = 'PENDING'
         )
       ) THEN
      RAISE EXCEPTION 'HXUV1-EXEC-9: incident or pending scope change blocks forward execution'
        USING ERRCODE = 'P0001';
    END IF;

    IF NEW.request_sha256 IS DISTINCT FROM public.universal_v1_execution_command_request_sha256(
      NEW.actor_user_id,
      NEW.work_order_id,
      NEW.transition_kind,
      predecessor.execution_version,
      scope_record.version,
      NEW.idempotency_key,
      NEW.client_occurred_at,
      NEW.reason
    ) THEN
      RAISE EXCEPTION 'HXUV1-EXEC-10: provider execution request digest mismatch'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.transition_kind = 'APPLY_AMENDMENT' THEN
    SELECT * INTO amendment
    FROM public.task_work_order_amendments
    WHERE id = NEW.work_order_amendment_id
    FOR SHARE;

    IF amendment.id IS NULL
       OR amendment.work_order_id <> NEW.work_order_id
       OR amendment.scope_version_id <> NEW.scope_version_id
       OR amendment.materialized_by <> NEW.actor_user_id
       OR task_record.active_scope_version_id <> NEW.scope_version_id
       OR predecessor.scope_version_id = NEW.scope_version_id
       OR predecessor.state NOT IN (
         'MATERIALIZED', 'ACKNOWLEDGED', 'EN_ROUTE', 'ARRIVED', 'PAUSED'
       )
       OR NEW.state <> predecessor.state
       OR NEW.actor_role <> 'CUSTOMER'
       OR NEW.completion_fact_id IS NOT NULL
       OR NEW.reason IS NOT NULL
       OR (
         task_record.business_organization_id IS NULL
         AND NEW.actor_user_id <> task_record.poster_id
       )
       OR (
         task_record.business_organization_id IS NOT NULL
         AND public.business_membership_has_action(
           task_record.business_organization_id,
           NEW.actor_user_id,
           'APPROVE_SPEND'
         ) IS NOT TRUE
       ) THEN
      RAISE EXCEPTION 'HXUV1-EXEC-11: scope amendment must preserve a non-working execution state and bind the exact amendment'
        USING ERRCODE = 'P0001';
    END IF;
  ELSIF NEW.transition_kind IN (
    'COMPLETION_SUBMITTED',
    'COMPLETION_APPROVED',
    'COMPLETION_REJECTED'
  ) THEN
    SELECT * INTO completion
    FROM public.task_completion_facts
    WHERE id = NEW.completion_fact_id
    FOR SHARE;

    IF completion.id IS NULL
       OR completion.work_order_id <> NEW.work_order_id
       OR completion.task_id <> NEW.task_id
       OR completion.scope_version_id <> NEW.scope_version_id
       OR completion.actor_id <> NEW.actor_user_id
       OR NEW.scope_version_id <> predecessor.scope_version_id
       OR NEW.scope_version_id <> public.universal_v1_effective_work_order_scope_id(NEW.work_order_id)
       OR NEW.work_order_amendment_id IS NOT NULL
       OR NEW.reason IS DISTINCT FROM completion.decision_reason
       OR NOT (
         (
           NEW.transition_kind = 'COMPLETION_SUBMITTED'
           AND predecessor.state = 'IN_PROGRESS'
           AND NEW.state = 'COMPLETION_SUBMITTED'
           AND NEW.actor_role = 'PROVIDER'
           AND completion.fact_kind = 'SUBMITTED'
         )
         OR (
           NEW.transition_kind = 'COMPLETION_APPROVED'
           AND predecessor.state = 'COMPLETION_SUBMITTED'
           AND NEW.state = 'COMPLETED'
           AND NEW.actor_role IN ('CUSTOMER', 'NAMED_OPERATOR')
           AND completion.fact_kind = 'APPROVED'
         )
         OR (
           NEW.transition_kind = 'COMPLETION_REJECTED'
           AND predecessor.state = 'COMPLETION_SUBMITTED'
           AND NEW.state = 'REWORK_REQUIRED'
           AND NEW.actor_role IN ('CUSTOMER', 'NAMED_OPERATOR')
           AND completion.fact_kind = 'REJECTED'
         )
       ) THEN
      RAISE EXCEPTION 'HXUV1-EXEC-12: completion transition must bind the exact completion fact and actor'
        USING ERRCODE = 'P0001';
    END IF;

    IF NEW.actor_role = 'CUSTOMER' AND (
      (
        task_record.business_organization_id IS NULL
        AND NEW.actor_user_id <> task_record.poster_id
      )
      OR (
        task_record.business_organization_id IS NOT NULL
        AND public.business_membership_has_action(
          task_record.business_organization_id,
          NEW.actor_user_id,
          'APPROVE_SPEND'
        ) IS NOT TRUE
      )
    ) THEN
      RAISE EXCEPTION 'HXUV1-EXEC-13: completion review requires current customer authority'
        USING ERRCODE = 'P0001';
    END IF;

    IF NEW.actor_role = 'NAMED_OPERATOR' AND NOT EXISTS (
      SELECT 1
      FROM public.admin_roles operator
      WHERE operator.user_id = NEW.actor_user_id
        AND (
          operator.can_resolve_disputes IS TRUE
          OR operator.can_manage_incidents IS TRUE
        )
    ) THEN
      RAISE EXCEPTION 'HXUV1-EXEC-13: completion review requires current named-operator authority'
        USING ERRCODE = 'P0001';
    END IF;
  ELSE
    RAISE EXCEPTION 'HXUV1-EXEC-14: unsupported internal execution transition'
      USING ERRCODE = 'P0001';
  END IF;

  expected_internal_sha256 := public.universal_v1_execution_internal_request_sha256(
    NEW.actor_user_id,
    NEW.work_order_id,
    NEW.transition_kind,
    NEW.state,
    predecessor.execution_version,
    NEW.scope_version_id,
    NEW.completion_fact_id,
    NEW.work_order_amendment_id,
    NEW.idempotency_key,
    NEW.client_occurred_at,
    NEW.reason
  );
  IF NEW.request_sha256 IS DISTINCT FROM expected_internal_sha256 THEN
    RAISE EXCEPTION 'HXUV1-EXEC-15: internal execution request digest mismatch'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS universal_v1_execution_fact_guard
  ON public.task_work_order_execution_facts;
CREATE TRIGGER universal_v1_execution_fact_guard
BEFORE INSERT ON public.task_work_order_execution_facts
FOR EACH ROW EXECUTE FUNCTION public.enforce_universal_v1_execution_fact();

DROP TRIGGER IF EXISTS task_work_order_execution_facts_immutable
  ON public.task_work_order_execution_facts;
CREATE TRIGGER task_work_order_execution_facts_immutable
BEFORE UPDATE OR DELETE ON public.task_work_order_execution_facts
FOR EACH ROW EXECUTE FUNCTION public.prevent_universal_v1_fact_mutation();

DROP TRIGGER IF EXISTS task_work_order_execution_facts_no_truncate
  ON public.task_work_order_execution_facts;
CREATE TRIGGER task_work_order_execution_facts_no_truncate
BEFORE TRUNCATE ON public.task_work_order_execution_facts
FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_universal_v1_fact_mutation();

CREATE OR REPLACE FUNCTION public.enforce_universal_v1_work_order_execution_genesis()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.execution_contract_version = 1
     AND NOT EXISTS (
       SELECT 1
       FROM public.task_work_order_execution_facts fact
       WHERE fact.work_order_id = NEW.id
         AND fact.task_id = NEW.task_id
         AND fact.scope_version_id = NEW.scope_version_id
         AND fact.execution_version = 1
         AND fact.supersedes_fact_id IS NULL
         AND fact.state = 'MATERIALIZED'
         AND fact.transition_kind = 'MATERIALIZED'
         AND fact.actor_user_id = NEW.materialized_by
     ) THEN
    RAISE EXCEPTION 'HXUV1-EXEC-16: execution-contract Work Order requires an exact materialization genesis fact'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS universal_v1_work_order_execution_genesis_guard
  ON public.task_work_orders;
CREATE CONSTRAINT TRIGGER universal_v1_work_order_execution_genesis_guard
AFTER INSERT OR UPDATE OF execution_contract_version ON public.task_work_orders
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.enforce_universal_v1_work_order_execution_genesis();

CREATE OR REPLACE FUNCTION public.enforce_universal_v1_amendment_execution_fact()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.task_work_orders work_order
    WHERE work_order.id = NEW.work_order_id
      AND work_order.execution_contract_version = 1
  ) AND NOT EXISTS (
    SELECT 1
    FROM public.task_work_order_execution_facts fact
    WHERE fact.work_order_id = NEW.work_order_id
      AND fact.scope_version_id = NEW.scope_version_id
      AND fact.work_order_amendment_id = NEW.id
      AND fact.transition_kind = 'APPLY_AMENDMENT'
  ) THEN
    RAISE EXCEPTION 'HXUV1-EXEC-17: amendment requires its exact append-only execution fact'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS universal_v1_amendment_execution_fact_guard
  ON public.task_work_order_amendments;
CREATE CONSTRAINT TRIGGER universal_v1_amendment_execution_fact_guard
AFTER INSERT ON public.task_work_order_amendments
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.enforce_universal_v1_amendment_execution_fact();

CREATE OR REPLACE FUNCTION public.enforce_universal_v1_completion_execution_fact()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  expected_transition TEXT;
  expected_state TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.task_work_orders work_order
    WHERE work_order.id = NEW.work_order_id
      AND work_order.execution_contract_version = 1
  ) THEN
    RETURN NEW;
  END IF;

  expected_transition := CASE NEW.fact_kind
    WHEN 'SUBMITTED' THEN 'COMPLETION_SUBMITTED'
    WHEN 'APPROVED' THEN 'COMPLETION_APPROVED'
    WHEN 'REJECTED' THEN 'COMPLETION_REJECTED'
  END;
  expected_state := CASE NEW.fact_kind
    WHEN 'SUBMITTED' THEN 'COMPLETION_SUBMITTED'
    WHEN 'APPROVED' THEN 'COMPLETED'
    WHEN 'REJECTED' THEN 'REWORK_REQUIRED'
  END;

  IF NOT EXISTS (
    SELECT 1
    FROM public.task_work_order_execution_facts fact
    WHERE fact.work_order_id = NEW.work_order_id
      AND fact.task_id = NEW.task_id
      AND fact.scope_version_id = NEW.scope_version_id
      AND fact.completion_fact_id = NEW.id
      AND fact.transition_kind = expected_transition
      AND fact.state = expected_state
  ) THEN
    RAISE EXCEPTION 'HXUV1-EXEC-18: completion fact requires its exact execution transition'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS universal_v1_completion_execution_fact_guard
  ON public.task_completion_facts;
CREATE CONSTRAINT TRIGGER universal_v1_completion_execution_fact_guard
AFTER INSERT ON public.task_completion_facts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.enforce_universal_v1_completion_execution_fact();

CREATE OR REPLACE FUNCTION public.enforce_universal_v1_proof_execution_binding()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  work_order public.task_work_orders%ROWTYPE;
  execution public.task_work_order_execution_facts%ROWTYPE;
BEGIN
  IF NEW.work_order_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO work_order
  FROM public.task_work_orders
  WHERE id = NEW.work_order_id;

  IF work_order.execution_contract_version <> 1 THEN
    IF NEW.execution_fact_id IS NOT NULL THEN
      RAISE EXCEPTION 'HXUV1-EXEC-19: legacy Work Order proof cannot claim execution-contract authority'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  SELECT * INTO execution
  FROM public.task_work_order_execution_facts
  WHERE id = NEW.execution_fact_id;

  IF execution.id IS NULL
     OR execution.work_order_id <> NEW.work_order_id
     OR execution.task_id <> NEW.task_id
     OR execution.scope_version_id <> NEW.scope_version_id
     OR EXISTS (
       SELECT 1
       FROM public.task_work_order_execution_facts newer
       WHERE newer.work_order_id = execution.work_order_id
         AND newer.execution_version > execution.execution_version
     )
     OR NOT (
       (NEW.evidence_kind = 'BEFORE' AND execution.state IN (
         'ACKNOWLEDGED', 'EN_ROUTE', 'ARRIVED'
       ))
       OR (NEW.evidence_kind = 'PROGRESS' AND execution.state IN (
         'IN_PROGRESS', 'PAUSED'
       ))
       OR (NEW.evidence_kind = 'COMPLETION' AND execution.state = 'IN_PROGRESS')
       OR (NEW.evidence_kind IN ('INCIDENT', 'RECOVERY') AND execution.state <> 'COMPLETED')
     ) THEN
    RAISE EXCEPTION 'HXUV1-EXEC-20: proof must bind the exact current execution fact and permitted evidence phase'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS universal_v1_proof_execution_binding_guard
  ON public.proofs;
CREATE TRIGGER universal_v1_proof_execution_binding_guard
BEFORE INSERT ON public.proofs
FOR EACH ROW EXECUTE FUNCTION public.enforce_universal_v1_proof_execution_binding();

CREATE OR REPLACE FUNCTION public.enforce_universal_proof_binding_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (
      SELECT 1 FROM public.task_completion_facts completion
      WHERE completion.proof_id = OLD.id
    ) THEN
      RAISE EXCEPTION 'HXUV1-PROOF-1: proof referenced by a completion fact cannot be deleted'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.work_order_id IS NOT NULL AND (
    OLD.task_id IS DISTINCT FROM NEW.task_id
    OR OLD.submitter_id IS DISTINCT FROM NEW.submitter_id
    OR OLD.scope_version_id IS DISTINCT FROM NEW.scope_version_id
    OR OLD.scope_version_hash IS DISTINCT FROM NEW.scope_version_hash
    OR OLD.work_order_id IS DISTINCT FROM NEW.work_order_id
    OR OLD.evidence_kind IS DISTINCT FROM NEW.evidence_kind
    OR OLD.execution_fact_id IS DISTINCT FROM NEW.execution_fact_id
  ) THEN
    RAISE EXCEPTION 'HXUV1-PROOF-2: Work Order proof identity, scope, and execution bindings are immutable'
      USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.task_completion_facts completion
    WHERE completion.proof_id = OLD.id
  ) AND OLD.description IS DISTINCT FROM NEW.description THEN
    RAISE EXCEPTION 'HXUV1-PROOF-3: submitted completion proof content is immutable'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_universal_v1_financial_execution_completion()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.event_kind = 'CAPTURED'
     AND EXISTS (
       SELECT 1
       FROM public.task_work_orders work_order
       WHERE work_order.task_id = NEW.task_id
         AND work_order.execution_contract_version = 1
     )
     AND NOT EXISTS (
       SELECT 1
       FROM public.task_work_orders work_order
       JOIN public.task_work_order_execution_facts execution
         ON execution.work_order_id = work_order.id
       WHERE work_order.task_id = NEW.task_id
         AND execution.state = 'COMPLETED'
         AND execution.transition_kind = 'COMPLETION_APPROVED'
         AND execution.completion_fact_id = NEW.completion_fact_id
         AND NOT EXISTS (
           SELECT 1
           FROM public.task_work_order_execution_facts newer
           WHERE newer.work_order_id = work_order.id
             AND newer.execution_version > execution.execution_version
         )
     ) THEN
    RAISE EXCEPTION 'HXUV1-EXEC-21: capture requires the exact current COMPLETED execution fact'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS universal_v1_financial_execution_completion_guard
  ON public.task_financial_security_events;
CREATE TRIGGER universal_v1_financial_execution_completion_guard
BEFORE INSERT ON public.task_financial_security_events
FOR EACH ROW EXECUTE FUNCTION public.enforce_universal_v1_financial_execution_completion();

REVOKE ALL ON TABLE public.task_work_order_execution_facts FROM PUBLIC;
REVOKE ALL ON FUNCTION public.universal_v1_execution_command_request_sha256(
  UUID, UUID, TEXT, INTEGER, INTEGER, TEXT, TIMESTAMPTZ, TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.universal_v1_execution_internal_request_sha256(
  UUID, UUID, TEXT, TEXT, INTEGER, UUID, UUID, UUID, TEXT, TIMESTAMPTZ, TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.universal_v1_effective_work_order_scope_id(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_universal_v1_execution_fact() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_universal_v1_work_order_execution_genesis() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_universal_v1_amendment_execution_fact() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_universal_v1_completion_execution_fact() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_universal_v1_proof_execution_binding() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_universal_proof_binding_immutability() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_universal_v1_financial_execution_completion() FROM PUBLIC;

COMMENT ON TABLE public.task_work_order_execution_facts IS
  'Append-only exact Work Order execution state. Interest remains non-assignment; execution remains separate from completion, capture, release, payout, and bank settlement.';
COMMENT ON COLUMN public.proofs.execution_fact_id IS
  'Exact current execution-state fact under which this immutable Universal V1 evidence was submitted.';
