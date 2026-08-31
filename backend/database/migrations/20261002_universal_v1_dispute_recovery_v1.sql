-- Provider-neutral Universal V1 dispute and recovery authority v1.
--
-- This contract succeeds the legacy dispute/escrow editor for the canonical
-- Universal V1 occurrence kernel. It records immutable incident, evidence,
-- review, proposal, and independent-approval facts. It never edits a Task,
-- Work Order, completion fact, financial history, provider account, or ledger;
-- never invokes a provider; and never fabricates a refund, reversal, release,
-- payout, assignment, or settlement.
--
-- The shared runtime login cannot yet let PostgreSQL attest that a supplied
-- actor UUID is the physical database caller. Authenticated participant intake
-- and non-effect operator review are therefore application-bound and rechecked
-- against current database roles. RESOLVED and DISMISSED remain structurally
-- held pending a dedicated, caller-attested command role. While a material
-- dispute is open, closure plus every new provider-release/payout authority
-- edge is denied under the same Work Order advisory lock.

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;

CREATE TABLE IF NOT EXISTS public.universal_v1_dispute_incidents (
  dispute_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_draft_id UUID NOT NULL
    REFERENCES public.task_drafts(id) ON DELETE RESTRICT,
  task_id UUID NOT NULL REFERENCES public.tasks(id) ON DELETE RESTRICT,
  task_version BIGINT NOT NULL CHECK (task_version > 0),
  routing_decision_id UUID NOT NULL
    REFERENCES public.task_routing_decisions(id) ON DELETE RESTRICT,
  routing_decision_version INTEGER NOT NULL CHECK (routing_decision_version > 0),
  routing_outcome TEXT NOT NULL CHECK (routing_outcome IN (
    'FULFILLMENT_CANDIDATE',
    'ESTIMATE_REQUIRED',
    'MANUAL_SOURCING',
    'REFERRAL',
    'WAITLIST',
    'DECLINE'
  )),
  work_order_id UUID NOT NULL
    REFERENCES public.task_work_orders(id) ON DELETE RESTRICT,
  work_order_materialization_version INTEGER NOT NULL CHECK (
    work_order_materialization_version > 0
  ),
  completion_fact_id UUID NOT NULL
    REFERENCES public.task_completion_facts(id) ON DELETE RESTRICT,
  completion_version INTEGER NOT NULL CHECK (completion_version > 0),
  execution_fact_id UUID NOT NULL
    REFERENCES public.task_work_order_execution_facts(id) ON DELETE RESTRICT,
  execution_version INTEGER NOT NULL CHECK (execution_version > 0),
  opened_by_user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  opened_by_role TEXT NOT NULL CHECK (opened_by_role IN ('CUSTOMER', 'PROVIDER')),
  incident_kind TEXT NOT NULL CHECK (incident_kind IN (
    'QUALITY', 'SAFETY', 'SCOPE', 'PROPERTY_DAMAGE', 'ACCESS', 'CONDUCT', 'OTHER'
  )),
  materiality TEXT NOT NULL DEFAULT 'MATERIAL' CHECK (materiality = 'MATERIAL'),
  opening_evidence_sha256 CHAR(64) NOT NULL CHECK (
    opening_evidence_sha256 ~ '^[a-f0-9]{64}$'
    AND opening_evidence_sha256 <> repeat('0', 64)
  ),
  idempotency_key TEXT NOT NULL CHECK (
    idempotency_key ~ '^[A-Za-z0-9:_-]{16,128}$'
  ),
  request_sha256 CHAR(64) NOT NULL CHECK (
    request_sha256 ~ '^[a-f0-9]{64}$'
    AND request_sha256 <> repeat('0', 64)
  ),
  contract_version TEXT NOT NULL DEFAULT 'universal-v1-dispute-recovery-1.0.0'
    CHECK (contract_version = 'universal-v1-dispute-recovery-1.0.0'),
  opened_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (opened_by_user_id, idempotency_key),
  UNIQUE (dispute_id, work_order_id),
  UNIQUE (dispute_id, completion_fact_id)
);

CREATE INDEX IF NOT EXISTS universal_v1_dispute_incidents_work_order_idx
  ON public.universal_v1_dispute_incidents(work_order_id, opened_at DESC);
CREATE INDEX IF NOT EXISTS universal_v1_dispute_incidents_task_idx
  ON public.universal_v1_dispute_incidents(task_id, opened_at DESC);

CREATE TABLE IF NOT EXISTS public.universal_v1_dispute_evidence_facts (
  evidence_fact_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id UUID NOT NULL
    REFERENCES public.universal_v1_dispute_incidents(dispute_id) ON DELETE RESTRICT,
  expected_dispute_version INTEGER NOT NULL CHECK (expected_dispute_version > 0),
  evidence_version INTEGER NOT NULL CHECK (
    evidence_version = expected_dispute_version + 1
  ),
  evidence_kind TEXT NOT NULL CHECK (evidence_kind IN (
    'PHOTO', 'VIDEO', 'DOCUMENT', 'MESSAGE', 'SYSTEM_EVENT', 'OTHER'
  )),
  evidence_sha256 CHAR(64) NOT NULL CHECK (
    evidence_sha256 ~ '^[a-f0-9]{64}$'
    AND evidence_sha256 <> repeat('0', 64)
  ),
  content_type TEXT NOT NULL CHECK (
    char_length(btrim(content_type)) BETWEEN 3 AND 120
    AND content_type !~ '[[:cntrl:]]'
  ),
  byte_size BIGINT NOT NULL CHECK (byte_size BETWEEN 1 AND 104857600),
  submitted_by_user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  submitted_by_role TEXT NOT NULL CHECK (submitted_by_role IN ('CUSTOMER', 'PROVIDER')),
  idempotency_key TEXT NOT NULL CHECK (
    idempotency_key ~ '^[A-Za-z0-9:_-]{16,128}$'
  ),
  request_sha256 CHAR(64) NOT NULL CHECK (
    request_sha256 ~ '^[a-f0-9]{64}$'
    AND request_sha256 <> repeat('0', 64)
  ),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (dispute_id, evidence_version),
  UNIQUE (submitted_by_user_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS public.universal_v1_dispute_recovery_intents (
  recovery_intent_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id UUID NOT NULL
    REFERENCES public.universal_v1_dispute_incidents(dispute_id) ON DELETE RESTRICT,
  expected_dispute_version INTEGER NOT NULL CHECK (expected_dispute_version > 0),
  proposal_version INTEGER NOT NULL CHECK (
    proposal_version = expected_dispute_version + 1
  ),
  recovery_kind TEXT NOT NULL CHECK (recovery_kind IN (
    'REFUND', 'REVERSAL', 'REWORK', 'REPLACEMENT', 'CANCEL', 'NO_EFFECT'
  )),
  proposal_evidence_sha256 CHAR(64) NOT NULL CHECK (
    proposal_evidence_sha256 ~ '^[a-f0-9]{64}$'
    AND proposal_evidence_sha256 <> repeat('0', 64)
  ),
  authority_state TEXT NOT NULL DEFAULT
    'HELD_TWO_PERSON_DATABASE_CALLER_UNATTESTED'
    CHECK (authority_state = 'HELD_TWO_PERSON_DATABASE_CALLER_UNATTESTED'),
  proposed_by_user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL CHECK (
    idempotency_key ~ '^[A-Za-z0-9:_-]{16,128}$'
  ),
  request_sha256 CHAR(64) NOT NULL CHECK (
    request_sha256 ~ '^[a-f0-9]{64}$'
    AND request_sha256 <> repeat('0', 64)
  ),
  proposed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (dispute_id, proposal_version),
  UNIQUE (proposed_by_user_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS public.universal_v1_dispute_recovery_approval_facts (
  approval_fact_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id UUID NOT NULL
    REFERENCES public.universal_v1_dispute_incidents(dispute_id) ON DELETE RESTRICT,
  recovery_intent_id UUID NOT NULL
    REFERENCES public.universal_v1_dispute_recovery_intents(recovery_intent_id)
    ON DELETE RESTRICT,
  expected_dispute_version INTEGER NOT NULL CHECK (expected_dispute_version > 0),
  approval_version INTEGER NOT NULL CHECK (
    approval_version = expected_dispute_version + 1
  ),
  approval_kind TEXT NOT NULL DEFAULT 'INDEPENDENT_REVIEW_APPROVED_HELD'
    CHECK (approval_kind = 'INDEPENDENT_REVIEW_APPROVED_HELD'),
  approval_evidence_sha256 CHAR(64) NOT NULL CHECK (
    approval_evidence_sha256 ~ '^[a-f0-9]{64}$'
    AND approval_evidence_sha256 <> repeat('0', 64)
  ),
  approved_by_user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL CHECK (
    idempotency_key ~ '^[A-Za-z0-9:_-]{16,128}$'
  ),
  request_sha256 CHAR(64) NOT NULL CHECK (
    request_sha256 ~ '^[a-f0-9]{64}$'
    AND request_sha256 <> repeat('0', 64)
  ),
  approved_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (recovery_intent_id),
  UNIQUE (dispute_id, approval_version),
  UNIQUE (approved_by_user_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS public.universal_v1_dispute_timeline_events (
  timeline_event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id UUID NOT NULL
    REFERENCES public.universal_v1_dispute_incidents(dispute_id) ON DELETE RESTRICT,
  event_version INTEGER NOT NULL CHECK (event_version > 0),
  expected_version INTEGER NOT NULL CHECK (
    expected_version >= 0 AND event_version = expected_version + 1
  ),
  supersedes_event_id UUID UNIQUE
    REFERENCES public.universal_v1_dispute_timeline_events(timeline_event_id)
    ON DELETE RESTRICT,
  event_kind TEXT NOT NULL CHECK (event_kind IN (
    'OPENED',
    'EVIDENCE_ADDED',
    'REVIEW_STARTED',
    'RESOLUTION_PROPOSED',
    'INDEPENDENT_APPROVAL_RECORDED',
    'RESOLVED',
    'DISMISSED'
  )),
  from_state TEXT CHECK (from_state IS NULL OR from_state IN (
    'OPEN', 'UNDER_REVIEW', 'RESOLUTION_PROPOSED', 'RESOLVED', 'DISMISSED'
  )),
  to_state TEXT NOT NULL CHECK (to_state IN (
    'OPEN', 'UNDER_REVIEW', 'RESOLUTION_PROPOSED', 'RESOLVED', 'DISMISSED'
  )),
  actor_user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  actor_role TEXT NOT NULL CHECK (
    actor_role IN ('CUSTOMER', 'PROVIDER', 'NAMED_OPERATOR')
  ),
  evidence_sha256 CHAR(64) NOT NULL CHECK (
    evidence_sha256 ~ '^[a-f0-9]{64}$'
    AND evidence_sha256 <> repeat('0', 64)
  ),
  evidence_fact_id UUID UNIQUE
    REFERENCES public.universal_v1_dispute_evidence_facts(evidence_fact_id)
    ON DELETE RESTRICT,
  recovery_intent_id UUID UNIQUE
    REFERENCES public.universal_v1_dispute_recovery_intents(recovery_intent_id)
    ON DELETE RESTRICT,
  approval_fact_id UUID UNIQUE
    REFERENCES public.universal_v1_dispute_recovery_approval_facts(approval_fact_id)
    ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL CHECK (
    idempotency_key ~ '^[A-Za-z0-9:_-]{16,128}$'
  ),
  request_sha256 CHAR(64) NOT NULL CHECK (
    request_sha256 ~ '^[a-f0-9]{64}$'
    AND request_sha256 <> repeat('0', 64)
  ),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (dispute_id, event_version),
  UNIQUE (actor_user_id, idempotency_key),
  CHECK (
    (event_version = 1 AND supersedes_event_id IS NULL AND from_state IS NULL)
    OR
    (event_version > 1 AND supersedes_event_id IS NOT NULL AND from_state IS NOT NULL)
  ),
  CHECK ((event_kind = 'EVIDENCE_ADDED') = (evidence_fact_id IS NOT NULL)),
  CHECK ((event_kind = 'RESOLUTION_PROPOSED') = (recovery_intent_id IS NOT NULL)),
  CHECK (
    (event_kind = 'INDEPENDENT_APPROVAL_RECORDED') = (approval_fact_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS universal_v1_dispute_timeline_latest_idx
  ON public.universal_v1_dispute_timeline_events(dispute_id, event_version DESC);

CREATE OR REPLACE VIEW public.universal_v1_dispute_current_v1 AS
SELECT
  incident.*,
  latest.timeline_event_id AS latest_timeline_event_id,
  latest.event_version AS dispute_version,
  latest.to_state AS dispute_state,
  latest.event_kind AS latest_event_kind,
  latest.recorded_at AS last_transition_at
FROM public.universal_v1_dispute_incidents incident
JOIN LATERAL (
  SELECT event.timeline_event_id, event.event_version, event.to_state,
         event.event_kind, event.recorded_at
  FROM public.universal_v1_dispute_timeline_events event
  WHERE event.dispute_id = incident.dispute_id
  ORDER BY event.event_version DESC
  LIMIT 1
) latest ON TRUE;

COMMENT ON VIEW public.universal_v1_dispute_current_v1 IS
  'Derived current state only. The incident and complete timeline remain immutable authority.';

CREATE OR REPLACE FUNCTION public.universal_v1_dispute_lock_v1(
  checked_work_order_id UUID
) RETURNS VOID
LANGUAGE plpgsql VOLATILE
SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('universal-v1-dispute:' || checked_work_order_id::TEXT, 0)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.universal_v1_dispute_idempotency_lock_v1(
  checked_actor_user_id UUID,
  checked_idempotency_key TEXT
) RETURNS VOID
LANGUAGE plpgsql VOLATILE
SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'universal-v1-dispute-idempotency:' || checked_actor_user_id::TEXT || ':'
        || checked_idempotency_key,
      0
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.assert_universal_v1_dispute_participant_v1(
  checked_work_order_id UUID,
  checked_actor_user_id UUID
) RETURNS TEXT
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE
  is_customer BOOLEAN;
  is_provider BOOLEAN;
BEGIN
  SELECT
    task.poster_id = checked_actor_user_id,
    (
      work_order.provider_user_id = checked_actor_user_id
      OR (
        work_order.provider_organization_id IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM public.business_memberships membership
          WHERE membership.organization_id = work_order.provider_organization_id
            AND membership.user_id = checked_actor_user_id
            AND membership.status = 'ACTIVE'
            AND membership.role IN ('OWNER', 'ADMIN', 'DISPATCHER', 'CREW')
        )
      )
    )
  INTO is_customer, is_provider
  FROM public.task_work_orders work_order
  JOIN public.tasks task ON task.id = work_order.task_id
  JOIN public.users actor ON actor.id = checked_actor_user_id
  WHERE work_order.id = checked_work_order_id
    AND actor.account_status = 'ACTIVE'
    AND COALESCE(actor.is_banned, FALSE) IS FALSE
    AND actor.is_minor IS FALSE;

  IF COALESCE(is_customer, FALSE) = COALESCE(is_provider, FALSE) THEN
    RAISE EXCEPTION 'HXUDR1: actor is not exactly one current customer/provider participant'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN CASE WHEN is_customer THEN 'CUSTOMER' ELSE 'PROVIDER' END;
END;
$$;

CREATE OR REPLACE FUNCTION public.assert_universal_v1_dispute_operator_v1(
  checked_actor_user_id UUID
) RETURNS TEXT
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE
  operator_role TEXT;
BEGIN
  SELECT role.role INTO operator_role
  FROM public.admin_roles role
  JOIN public.users actor ON actor.id = role.user_id
  WHERE role.user_id = checked_actor_user_id
    AND role.role IN ('admin', 'support', 'finance', 'moderator', 'founder')
    AND (
      role.role IN ('admin', 'founder')
      OR (
        COALESCE(role.can_resolve_disputes, FALSE)
        AND COALESCE(role.can_manage_operations, FALSE)
      )
    )
    AND actor.account_status = 'ACTIVE'
    AND COALESCE(actor.is_banned, FALSE) IS FALSE
    AND actor.is_minor IS FALSE
  LIMIT 1;

  IF operator_role IS NULL THEN
    RAISE EXCEPTION 'HXUDR7: current named dispute operator authority is required'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN operator_role;
END;
$$;

CREATE OR REPLACE FUNCTION public.validate_universal_v1_dispute_timeline_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public AS $$
DECLARE
  incident public.universal_v1_dispute_incidents%ROWTYPE;
  prior public.universal_v1_dispute_timeline_events%ROWTYPE;
  participant_role TEXT;
  recovery public.universal_v1_dispute_recovery_intents%ROWTYPE;
  approval public.universal_v1_dispute_recovery_approval_facts%ROWTYPE;
BEGIN
  SELECT * INTO incident
  FROM public.universal_v1_dispute_incidents
  WHERE dispute_id = NEW.dispute_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HXUDR5: dispute incident was not found' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO prior
  FROM public.universal_v1_dispute_timeline_events
  WHERE dispute_id = NEW.dispute_id
  ORDER BY event_version DESC
  LIMIT 1;

  IF prior.timeline_event_id IS NULL THEN
    IF NEW.event_version <> 1 OR NEW.expected_version <> 0
       OR NEW.event_kind <> 'OPENED' OR NEW.from_state IS NOT NULL
       OR NEW.to_state <> 'OPEN'
       OR NEW.actor_user_id <> incident.opened_by_user_id
       OR NEW.actor_role <> incident.opened_by_role
       OR NEW.evidence_sha256 <> incident.opening_evidence_sha256 THEN
      RAISE EXCEPTION 'HXUDR6: dispute timeline genesis is not the exact opening fact'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.expected_version <> prior.event_version
     OR NEW.event_version <> prior.event_version + 1
     OR NEW.supersedes_event_id <> prior.timeline_event_id
     OR NEW.from_state <> prior.to_state THEN
    RAISE EXCEPTION 'HXUDR3: dispute timeline expected version changed'
      USING ERRCODE = 'P0001';
  END IF;

  IF prior.to_state IN ('RESOLVED', 'DISMISSED') THEN
    RAISE EXCEPTION 'HXUDR6: terminal dispute state is immutable'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.to_state IN ('RESOLVED', 'DISMISSED') THEN
    RAISE EXCEPTION 'HXUDR8: terminal dispute authority is held pending caller-attested two-person command authority'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.event_kind = 'EVIDENCE_ADDED' THEN
    participant_role := public.assert_universal_v1_dispute_participant_v1(
      incident.work_order_id, NEW.actor_user_id
    );
    IF NEW.actor_role <> participant_role OR NEW.to_state <> prior.to_state
       OR NOT EXISTS (
         SELECT 1 FROM public.universal_v1_dispute_evidence_facts evidence
         WHERE evidence.evidence_fact_id = NEW.evidence_fact_id
           AND evidence.dispute_id = NEW.dispute_id
           AND evidence.expected_dispute_version = NEW.expected_version
           AND evidence.evidence_version = NEW.event_version
           AND evidence.submitted_by_user_id = NEW.actor_user_id
           AND evidence.submitted_by_role = NEW.actor_role
           AND evidence.evidence_sha256 = NEW.evidence_sha256
           AND evidence.request_sha256 = NEW.request_sha256
       ) THEN
      RAISE EXCEPTION 'HXUDR10: evidence event is not its exact participant-authored digest fact'
        USING ERRCODE = 'P0001';
    END IF;
  ELSIF NEW.event_kind = 'REVIEW_STARTED' THEN
    PERFORM public.assert_universal_v1_dispute_operator_v1(NEW.actor_user_id);
    IF NEW.actor_role <> 'NAMED_OPERATOR'
       OR prior.to_state <> 'OPEN' OR NEW.to_state <> 'UNDER_REVIEW' THEN
      RAISE EXCEPTION 'HXUDR6: review must transition OPEN to UNDER_REVIEW'
        USING ERRCODE = 'P0001';
    END IF;
  ELSIF NEW.event_kind = 'RESOLUTION_PROPOSED' THEN
    PERFORM public.assert_universal_v1_dispute_operator_v1(NEW.actor_user_id);
    SELECT * INTO recovery
    FROM public.universal_v1_dispute_recovery_intents
    WHERE recovery_intent_id = NEW.recovery_intent_id;
    IF NEW.actor_role <> 'NAMED_OPERATOR'
       OR prior.to_state <> 'UNDER_REVIEW'
       OR NEW.to_state <> 'RESOLUTION_PROPOSED'
       OR recovery.recovery_intent_id IS NULL
       OR recovery.dispute_id <> NEW.dispute_id
       OR recovery.expected_dispute_version <> NEW.expected_version
       OR recovery.proposal_version <> NEW.event_version
       OR recovery.proposed_by_user_id <> NEW.actor_user_id
       OR recovery.proposal_evidence_sha256 <> NEW.evidence_sha256
       OR recovery.request_sha256 <> NEW.request_sha256 THEN
      RAISE EXCEPTION 'HXUDR6: recovery proposal is not the exact held intent'
        USING ERRCODE = 'P0001';
    END IF;
  ELSIF NEW.event_kind = 'INDEPENDENT_APPROVAL_RECORDED' THEN
    PERFORM public.assert_universal_v1_dispute_operator_v1(NEW.actor_user_id);
    SELECT * INTO approval
    FROM public.universal_v1_dispute_recovery_approval_facts
    WHERE approval_fact_id = NEW.approval_fact_id;
    SELECT * INTO recovery
    FROM public.universal_v1_dispute_recovery_intents
    WHERE recovery_intent_id = approval.recovery_intent_id;
    IF NEW.actor_role <> 'NAMED_OPERATOR'
       OR prior.to_state <> 'RESOLUTION_PROPOSED'
       OR NEW.to_state <> 'RESOLUTION_PROPOSED'
       OR approval.approval_fact_id IS NULL
       OR approval.dispute_id <> NEW.dispute_id
       OR approval.expected_dispute_version <> NEW.expected_version
       OR approval.approval_version <> NEW.event_version
       OR approval.approved_by_user_id <> NEW.actor_user_id
       OR approval.approval_evidence_sha256 <> NEW.evidence_sha256
       OR approval.request_sha256 <> NEW.request_sha256
       OR recovery.proposed_by_user_id = NEW.actor_user_id THEN
      RAISE EXCEPTION 'HXUDR11: recovery review must be one exact independent held approval'
        USING ERRCODE = 'P0001';
    END IF;
  ELSE
    RAISE EXCEPTION 'HXUDR6: dispute transition is outside the bounded state machine'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS universal_v1_dispute_timeline_validate
  ON public.universal_v1_dispute_timeline_events;
CREATE TRIGGER universal_v1_dispute_timeline_validate
BEFORE INSERT ON public.universal_v1_dispute_timeline_events
FOR EACH ROW EXECUTE FUNCTION public.validate_universal_v1_dispute_timeline_v1();

CREATE OR REPLACE FUNCTION public.open_universal_v1_dispute_v1(
  checked_task_id UUID,
  checked_expected_task_version BIGINT,
  checked_work_order_id UUID,
  checked_expected_work_order_version INTEGER,
  checked_completion_fact_id UUID,
  checked_expected_completion_version INTEGER,
  checked_expected_execution_version INTEGER,
  checked_incident_kind TEXT,
  checked_evidence_sha256 TEXT,
  checked_actor_user_id UUID,
  checked_idempotency_key TEXT
) RETURNS TABLE (
  dispute_id UUID,
  dispute_state TEXT,
  dispute_version INTEGER,
  idempotency_replayed BOOLEAN
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE
  work_order public.task_work_orders%ROWTYPE;
  task_record public.tasks%ROWTYPE;
  draft public.task_drafts%ROWTYPE;
  route public.task_routing_decisions%ROWTYPE;
  completion public.task_completion_facts%ROWTYPE;
  execution public.task_work_order_execution_facts%ROWTYPE;
  actor_role TEXT;
  request_hash CHAR(64);
  prior public.universal_v1_dispute_incidents%ROWTYPE;
  prior_timeline public.universal_v1_dispute_timeline_events%ROWTYPE;
  created_dispute_id UUID;
BEGIN
  IF checked_incident_kind NOT IN (
    'QUALITY', 'SAFETY', 'SCOPE', 'PROPERTY_DAMAGE', 'ACCESS', 'CONDUCT', 'OTHER'
  ) OR checked_evidence_sha256 !~ '^[a-f0-9]{64}$'
     OR checked_evidence_sha256 = repeat('0', 64)
     OR checked_idempotency_key !~ '^[A-Za-z0-9:_-]{16,128}$' THEN
    RAISE EXCEPTION 'HXUDR2: incident command shape is invalid' USING ERRCODE = 'P0001';
  END IF;

  request_hash := pg_catalog.encode(public.digest(pg_catalog.concat_ws(':',
    'universal-v1-dispute-open-1.0.0',
    checked_actor_user_id::TEXT,
    checked_task_id::TEXT,
    checked_expected_task_version::TEXT,
    checked_work_order_id::TEXT,
    checked_expected_work_order_version::TEXT,
    checked_completion_fact_id::TEXT,
    checked_expected_completion_version::TEXT,
    checked_expected_execution_version::TEXT,
    checked_incident_kind,
    checked_evidence_sha256,
    checked_idempotency_key
  ), 'sha256'), 'hex');

  SELECT * INTO prior
  FROM public.universal_v1_dispute_incidents incident
  WHERE incident.opened_by_user_id = checked_actor_user_id
    AND incident.idempotency_key = checked_idempotency_key;
  IF prior.dispute_id IS NOT NULL THEN
    PERFORM public.assert_universal_v1_dispute_participant_v1(
      prior.work_order_id, checked_actor_user_id
    );
    IF prior.request_sha256 <> request_hash THEN
      RAISE EXCEPTION 'HXUDR4: idempotency key was reused for another incident command'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN QUERY
      SELECT prior.dispute_id, event.to_state, event.event_version, TRUE
      FROM public.universal_v1_dispute_timeline_events event
      WHERE event.dispute_id = prior.dispute_id
        AND event.actor_user_id = checked_actor_user_id
        AND event.idempotency_key = checked_idempotency_key
        AND event.request_sha256 = request_hash
        AND event.event_kind = 'OPENED';
    RETURN;
  END IF;

  PERFORM public.universal_v1_dispute_idempotency_lock_v1(
    checked_actor_user_id, checked_idempotency_key
  );
  PERFORM public.universal_v1_dispute_lock_v1(checked_work_order_id);

  -- A fast-path idempotency read above avoids unnecessary contention. This
  -- second read is authoritative: a concurrent identical call may have
  -- committed while this transaction waited for the Work Order lock.
  SELECT * INTO prior
  FROM public.universal_v1_dispute_incidents incident
  WHERE incident.opened_by_user_id = checked_actor_user_id
    AND incident.idempotency_key = checked_idempotency_key;
  IF prior.dispute_id IS NOT NULL THEN
    PERFORM public.assert_universal_v1_dispute_participant_v1(
      prior.work_order_id, checked_actor_user_id
    );
    IF prior.request_sha256 <> request_hash THEN
      RAISE EXCEPTION 'HXUDR4: idempotency key was reused for another incident command'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN QUERY
      SELECT prior.dispute_id, event.to_state, event.event_version, TRUE
      FROM public.universal_v1_dispute_timeline_events event
      WHERE event.dispute_id = prior.dispute_id
        AND event.actor_user_id = checked_actor_user_id
        AND event.idempotency_key = checked_idempotency_key
        AND event.request_sha256 = request_hash
        AND event.event_kind = 'OPENED';
    RETURN;
  END IF;
  SELECT * INTO prior_timeline
  FROM public.universal_v1_dispute_timeline_events event
  WHERE event.actor_user_id = checked_actor_user_id
    AND event.idempotency_key = checked_idempotency_key;
  IF prior_timeline.timeline_event_id IS NOT NULL THEN
    RAISE EXCEPTION 'HXUDR4: idempotency key was reused across dispute commands'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO work_order
  FROM public.task_work_orders
  WHERE id = checked_work_order_id;
  SELECT * INTO task_record FROM public.tasks WHERE id = checked_task_id;
  IF work_order.id IS NULL OR task_record.id IS NULL
     OR work_order.task_id <> task_record.id
     OR task_record.work_order_id IS DISTINCT FROM work_order.id
     OR work_order.materialization_version <> checked_expected_work_order_version
     OR task_record.version <> checked_expected_task_version
     OR task_record.universal_contract_version <> 1 THEN
    RAISE EXCEPTION 'HXUDR2: exact Task and Work Order authority mismatched'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO draft
  FROM public.task_drafts
  WHERE id = work_order.task_draft_id
    AND task_id = task_record.id
    AND universal_contract_version = 1;
  SELECT * INTO route
  FROM public.task_routing_decisions
  WHERE id = draft.active_routing_decision_id
    AND task_draft_id = draft.id;
  IF draft.id IS NULL OR route.id IS NULL THEN
    RAISE EXCEPTION 'HXUDR2: exact six-outcome routing authority is absent'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO completion
  FROM public.task_completion_facts fact
  WHERE fact.id = checked_completion_fact_id
    AND fact.work_order_id = work_order.id
    AND fact.task_id = task_record.id
    AND fact.completion_version = checked_expected_completion_version
    AND NOT EXISTS (
      SELECT 1 FROM public.task_completion_facts newer
      WHERE newer.work_order_id = fact.work_order_id
        AND newer.completion_version > fact.completion_version
    );
  SELECT * INTO execution
  FROM public.task_work_order_execution_facts fact
  WHERE fact.work_order_id = work_order.id
    AND fact.task_id = task_record.id
    AND fact.completion_fact_id = checked_completion_fact_id
    AND fact.execution_version = checked_expected_execution_version
    AND NOT EXISTS (
      SELECT 1 FROM public.task_work_order_execution_facts newer
      WHERE newer.work_order_id = fact.work_order_id
        AND newer.execution_version > fact.execution_version
    );
  IF completion.id IS NULL OR execution.id IS NULL THEN
    RAISE EXCEPTION 'HXUDR2: exact latest completion/execution authority mismatched'
      USING ERRCODE = 'P0001';
  END IF;

  actor_role := public.assert_universal_v1_dispute_participant_v1(
    work_order.id, checked_actor_user_id
  );

  INSERT INTO public.universal_v1_dispute_incidents (
    task_draft_id, task_id, task_version,
    routing_decision_id, routing_decision_version, routing_outcome,
    work_order_id, work_order_materialization_version,
    completion_fact_id, completion_version,
    execution_fact_id, execution_version,
    opened_by_user_id, opened_by_role, incident_kind,
    opening_evidence_sha256, idempotency_key, request_sha256
  ) VALUES (
    draft.id, task_record.id, task_record.version,
    route.id, route.decision_version, route.outcome,
    work_order.id, work_order.materialization_version,
    completion.id, completion.completion_version,
    execution.id, execution.execution_version,
    checked_actor_user_id, actor_role, checked_incident_kind,
    checked_evidence_sha256, checked_idempotency_key, request_hash
  ) RETURNING universal_v1_dispute_incidents.dispute_id INTO created_dispute_id;

  INSERT INTO public.universal_v1_dispute_timeline_events (
    dispute_id, event_version, expected_version, supersedes_event_id,
    event_kind, from_state, to_state, actor_user_id, actor_role,
    evidence_sha256, idempotency_key, request_sha256
  ) VALUES (
    created_dispute_id, 1, 0, NULL,
    'OPENED', NULL, 'OPEN', checked_actor_user_id, actor_role,
    checked_evidence_sha256, checked_idempotency_key, request_hash
  );

  RETURN QUERY SELECT created_dispute_id, 'OPEN'::TEXT, 1, FALSE;
END;
$$;

CREATE OR REPLACE FUNCTION public.add_universal_v1_dispute_evidence_v1(
  checked_dispute_id UUID,
  checked_expected_dispute_version INTEGER,
  checked_evidence_kind TEXT,
  checked_evidence_sha256 TEXT,
  checked_content_type TEXT,
  checked_byte_size BIGINT,
  checked_actor_user_id UUID,
  checked_idempotency_key TEXT
) RETURNS TABLE (
  evidence_fact_id UUID,
  dispute_state TEXT,
  dispute_version INTEGER,
  idempotency_replayed BOOLEAN
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE
  incident public.universal_v1_dispute_incidents%ROWTYPE;
  current_event public.universal_v1_dispute_timeline_events%ROWTYPE;
  prior public.universal_v1_dispute_evidence_facts%ROWTYPE;
  prior_timeline public.universal_v1_dispute_timeline_events%ROWTYPE;
  actor_role TEXT;
  request_hash CHAR(64);
  created_evidence_id UUID;
BEGIN
  IF checked_evidence_kind NOT IN (
    'PHOTO', 'VIDEO', 'DOCUMENT', 'MESSAGE', 'SYSTEM_EVENT', 'OTHER'
  ) OR checked_evidence_sha256 !~ '^[a-f0-9]{64}$'
     OR checked_evidence_sha256 = repeat('0', 64)
     OR char_length(btrim(checked_content_type)) NOT BETWEEN 3 AND 120
     OR checked_content_type ~ '[[:cntrl:]]'
     OR checked_byte_size NOT BETWEEN 1 AND 104857600
     OR checked_idempotency_key !~ '^[A-Za-z0-9:_-]{16,128}$' THEN
    RAISE EXCEPTION 'HXUDR10: evidence command shape is invalid' USING ERRCODE = 'P0001';
  END IF;

  request_hash := pg_catalog.encode(public.digest(pg_catalog.concat_ws(':',
    'universal-v1-dispute-evidence-1.0.0', checked_actor_user_id::TEXT,
    checked_dispute_id::TEXT, checked_expected_dispute_version::TEXT,
    checked_evidence_kind, checked_evidence_sha256, checked_content_type,
    checked_byte_size::TEXT, checked_idempotency_key
  ), 'sha256'), 'hex');
  SELECT * INTO prior
  FROM public.universal_v1_dispute_evidence_facts evidence
  WHERE evidence.submitted_by_user_id = checked_actor_user_id
    AND evidence.idempotency_key = checked_idempotency_key;
  IF prior.evidence_fact_id IS NOT NULL THEN
    SELECT * INTO incident
    FROM public.universal_v1_dispute_incidents
    WHERE dispute_id = prior.dispute_id;
    PERFORM public.assert_universal_v1_dispute_participant_v1(
      incident.work_order_id, checked_actor_user_id
    );
    IF prior.request_sha256 <> request_hash THEN
      RAISE EXCEPTION 'HXUDR4: idempotency key was reused for another evidence command'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN QUERY SELECT prior.evidence_fact_id, event.to_state,
      event.event_version, TRUE
    FROM public.universal_v1_dispute_timeline_events event
    WHERE event.dispute_id = prior.dispute_id
      AND event.evidence_fact_id = prior.evidence_fact_id
      AND event.actor_user_id = checked_actor_user_id
      AND event.idempotency_key = checked_idempotency_key
      AND event.request_sha256 = request_hash
      AND event.event_kind = 'EVIDENCE_ADDED';
    RETURN;
  END IF;

  PERFORM public.universal_v1_dispute_idempotency_lock_v1(
    checked_actor_user_id, checked_idempotency_key
  );
  SELECT * INTO incident FROM public.universal_v1_dispute_incidents
  WHERE dispute_id = checked_dispute_id FOR UPDATE;
  IF incident.dispute_id IS NULL THEN
    RAISE EXCEPTION 'HXUDR5: dispute incident was not found' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO prior
  FROM public.universal_v1_dispute_evidence_facts evidence
  WHERE evidence.submitted_by_user_id = checked_actor_user_id
    AND evidence.idempotency_key = checked_idempotency_key;
  IF prior.evidence_fact_id IS NOT NULL THEN
    PERFORM public.assert_universal_v1_dispute_participant_v1(
      incident.work_order_id, checked_actor_user_id
    );
    IF prior.request_sha256 <> request_hash THEN
      RAISE EXCEPTION 'HXUDR4: idempotency key was reused for another evidence command'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN QUERY SELECT prior.evidence_fact_id, event.to_state,
      event.event_version, TRUE
    FROM public.universal_v1_dispute_timeline_events event
    WHERE event.dispute_id = prior.dispute_id
      AND event.evidence_fact_id = prior.evidence_fact_id
      AND event.actor_user_id = checked_actor_user_id
      AND event.idempotency_key = checked_idempotency_key
      AND event.request_sha256 = request_hash
      AND event.event_kind = 'EVIDENCE_ADDED';
    RETURN;
  END IF;
  SELECT * INTO prior_timeline
  FROM public.universal_v1_dispute_timeline_events event
  WHERE event.actor_user_id = checked_actor_user_id
    AND event.idempotency_key = checked_idempotency_key;
  IF prior_timeline.timeline_event_id IS NOT NULL THEN
    RAISE EXCEPTION 'HXUDR4: idempotency key was reused across dispute commands'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO current_event FROM public.universal_v1_dispute_timeline_events
  WHERE dispute_id = incident.dispute_id ORDER BY event_version DESC LIMIT 1;
  IF current_event.event_version <> checked_expected_dispute_version
     OR current_event.to_state IN ('RESOLVED', 'DISMISSED') THEN
    RAISE EXCEPTION 'HXUDR3: dispute expected version changed' USING ERRCODE = 'P0001';
  END IF;
  actor_role := public.assert_universal_v1_dispute_participant_v1(
    incident.work_order_id, checked_actor_user_id
  );

  INSERT INTO public.universal_v1_dispute_evidence_facts (
    dispute_id, expected_dispute_version, evidence_version,
    evidence_kind, evidence_sha256, content_type, byte_size,
    submitted_by_user_id, submitted_by_role, idempotency_key, request_sha256
  ) VALUES (
    incident.dispute_id, current_event.event_version, current_event.event_version + 1,
    checked_evidence_kind, checked_evidence_sha256, btrim(checked_content_type),
    checked_byte_size, checked_actor_user_id, actor_role,
    checked_idempotency_key, request_hash
  ) RETURNING universal_v1_dispute_evidence_facts.evidence_fact_id
    INTO created_evidence_id;

  INSERT INTO public.universal_v1_dispute_timeline_events (
    dispute_id, event_version, expected_version, supersedes_event_id,
    event_kind, from_state, to_state, actor_user_id, actor_role,
    evidence_sha256, evidence_fact_id, idempotency_key, request_sha256
  ) VALUES (
    incident.dispute_id, current_event.event_version + 1, current_event.event_version,
    current_event.timeline_event_id, 'EVIDENCE_ADDED', current_event.to_state,
    current_event.to_state, checked_actor_user_id, actor_role,
    checked_evidence_sha256, created_evidence_id, checked_idempotency_key, request_hash
  );

  RETURN QUERY SELECT created_evidence_id, current_event.to_state,
    current_event.event_version + 1, FALSE;
END;
$$;

CREATE OR REPLACE FUNCTION public.begin_universal_v1_dispute_review_v1(
  checked_dispute_id UUID,
  checked_expected_dispute_version INTEGER,
  checked_review_evidence_sha256 TEXT,
  checked_actor_user_id UUID,
  checked_idempotency_key TEXT
) RETURNS TABLE (
  dispute_id UUID,
  dispute_state TEXT,
  dispute_version INTEGER,
  idempotency_replayed BOOLEAN
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE
  current_event public.universal_v1_dispute_timeline_events%ROWTYPE;
  prior public.universal_v1_dispute_timeline_events%ROWTYPE;
  request_hash CHAR(64);
BEGIN
  PERFORM public.assert_universal_v1_dispute_operator_v1(checked_actor_user_id);
  IF checked_review_evidence_sha256 !~ '^[a-f0-9]{64}$'
     OR checked_review_evidence_sha256 = repeat('0', 64)
     OR checked_idempotency_key !~ '^[A-Za-z0-9:_-]{16,128}$' THEN
    RAISE EXCEPTION 'HXUDR6: review command shape is invalid' USING ERRCODE = 'P0001';
  END IF;
  request_hash := pg_catalog.encode(public.digest(pg_catalog.concat_ws(':',
    'universal-v1-dispute-review-1.0.0', checked_actor_user_id::TEXT,
    checked_dispute_id::TEXT, checked_expected_dispute_version::TEXT,
    checked_review_evidence_sha256, checked_idempotency_key
  ), 'sha256'), 'hex');
  SELECT * INTO prior FROM public.universal_v1_dispute_timeline_events event
  WHERE event.actor_user_id = checked_actor_user_id
    AND event.idempotency_key = checked_idempotency_key;
  IF prior.timeline_event_id IS NOT NULL THEN
    IF prior.request_sha256 <> request_hash THEN
      RAISE EXCEPTION 'HXUDR4: idempotency key was reused for another review command'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN QUERY SELECT prior.dispute_id, prior.to_state, prior.event_version, TRUE;
    RETURN;
  END IF;
  PERFORM public.universal_v1_dispute_idempotency_lock_v1(
    checked_actor_user_id, checked_idempotency_key
  );
  PERFORM 1 FROM public.universal_v1_dispute_incidents
  WHERE universal_v1_dispute_incidents.dispute_id = checked_dispute_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HXUDR5: dispute incident was not found' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO prior FROM public.universal_v1_dispute_timeline_events event
  WHERE event.actor_user_id = checked_actor_user_id
    AND event.idempotency_key = checked_idempotency_key;
  IF prior.timeline_event_id IS NOT NULL THEN
    IF prior.request_sha256 <> request_hash OR prior.event_kind <> 'REVIEW_STARTED' THEN
      RAISE EXCEPTION 'HXUDR4: idempotency key was reused for another review command'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN QUERY SELECT prior.dispute_id, prior.to_state, prior.event_version, TRUE;
    RETURN;
  END IF;
  SELECT * INTO current_event FROM public.universal_v1_dispute_timeline_events
  WHERE universal_v1_dispute_timeline_events.dispute_id = checked_dispute_id
  ORDER BY event_version DESC LIMIT 1;
  IF current_event.event_version <> checked_expected_dispute_version
     OR current_event.to_state <> 'OPEN' THEN
    RAISE EXCEPTION 'HXUDR3: OPEN dispute expected version changed'
      USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO public.universal_v1_dispute_timeline_events (
    dispute_id, event_version, expected_version, supersedes_event_id,
    event_kind, from_state, to_state, actor_user_id, actor_role,
    evidence_sha256, idempotency_key, request_sha256
  ) VALUES (
    checked_dispute_id, current_event.event_version + 1, current_event.event_version,
    current_event.timeline_event_id, 'REVIEW_STARTED', 'OPEN', 'UNDER_REVIEW',
    checked_actor_user_id, 'NAMED_OPERATOR', checked_review_evidence_sha256,
    checked_idempotency_key, request_hash
  );
  RETURN QUERY SELECT checked_dispute_id, 'UNDER_REVIEW'::TEXT,
    current_event.event_version + 1, FALSE;
END;
$$;

CREATE OR REPLACE FUNCTION public.propose_universal_v1_dispute_recovery_v1(
  checked_dispute_id UUID,
  checked_expected_dispute_version INTEGER,
  checked_recovery_kind TEXT,
  checked_proposal_evidence_sha256 TEXT,
  checked_actor_user_id UUID,
  checked_idempotency_key TEXT
) RETURNS TABLE (
  recovery_intent_id UUID,
  dispute_state TEXT,
  dispute_version INTEGER,
  authority_state TEXT,
  idempotency_replayed BOOLEAN
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE
  current_event public.universal_v1_dispute_timeline_events%ROWTYPE;
  prior public.universal_v1_dispute_recovery_intents%ROWTYPE;
  prior_timeline public.universal_v1_dispute_timeline_events%ROWTYPE;
  request_hash CHAR(64);
  created_intent_id UUID;
BEGIN
  PERFORM public.assert_universal_v1_dispute_operator_v1(checked_actor_user_id);
  IF checked_recovery_kind NOT IN (
    'REFUND', 'REVERSAL', 'REWORK', 'REPLACEMENT', 'CANCEL', 'NO_EFFECT'
  ) OR checked_proposal_evidence_sha256 !~ '^[a-f0-9]{64}$'
     OR checked_proposal_evidence_sha256 = repeat('0', 64)
     OR checked_idempotency_key !~ '^[A-Za-z0-9:_-]{16,128}$' THEN
    RAISE EXCEPTION 'HXUDR6: recovery proposal shape is invalid' USING ERRCODE = 'P0001';
  END IF;
  request_hash := pg_catalog.encode(public.digest(pg_catalog.concat_ws(':',
    'universal-v1-dispute-recovery-proposal-1.0.0', checked_actor_user_id::TEXT,
    checked_dispute_id::TEXT, checked_expected_dispute_version::TEXT,
    checked_recovery_kind, checked_proposal_evidence_sha256, checked_idempotency_key
  ), 'sha256'), 'hex');
  SELECT * INTO prior FROM public.universal_v1_dispute_recovery_intents intent
  WHERE intent.proposed_by_user_id = checked_actor_user_id
    AND intent.idempotency_key = checked_idempotency_key;
  IF prior.recovery_intent_id IS NOT NULL THEN
    IF prior.request_sha256 <> request_hash THEN
      RAISE EXCEPTION 'HXUDR4: idempotency key was reused for another proposal command'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN QUERY SELECT prior.recovery_intent_id, 'RESOLUTION_PROPOSED'::TEXT,
      prior.proposal_version, prior.authority_state, TRUE;
    RETURN;
  END IF;
  PERFORM public.universal_v1_dispute_idempotency_lock_v1(
    checked_actor_user_id, checked_idempotency_key
  );
  PERFORM 1 FROM public.universal_v1_dispute_incidents
  WHERE universal_v1_dispute_incidents.dispute_id = checked_dispute_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HXUDR5: dispute incident was not found' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO prior FROM public.universal_v1_dispute_recovery_intents intent
  WHERE intent.proposed_by_user_id = checked_actor_user_id
    AND intent.idempotency_key = checked_idempotency_key;
  IF prior.recovery_intent_id IS NOT NULL THEN
    IF prior.request_sha256 <> request_hash THEN
      RAISE EXCEPTION 'HXUDR4: idempotency key was reused for another proposal command'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN QUERY SELECT prior.recovery_intent_id, 'RESOLUTION_PROPOSED'::TEXT,
      prior.proposal_version, prior.authority_state, TRUE;
    RETURN;
  END IF;
  SELECT * INTO prior_timeline
  FROM public.universal_v1_dispute_timeline_events event
  WHERE event.actor_user_id = checked_actor_user_id
    AND event.idempotency_key = checked_idempotency_key;
  IF prior_timeline.timeline_event_id IS NOT NULL THEN
    RAISE EXCEPTION 'HXUDR4: idempotency key was reused across dispute commands'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO current_event FROM public.universal_v1_dispute_timeline_events
  WHERE universal_v1_dispute_timeline_events.dispute_id = checked_dispute_id
  ORDER BY event_version DESC LIMIT 1;
  IF current_event.event_version <> checked_expected_dispute_version
     OR current_event.to_state <> 'UNDER_REVIEW' THEN
    RAISE EXCEPTION 'HXUDR3: UNDER_REVIEW dispute expected version changed'
      USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO public.universal_v1_dispute_recovery_intents (
    dispute_id, expected_dispute_version, proposal_version,
    recovery_kind, proposal_evidence_sha256, proposed_by_user_id,
    idempotency_key, request_sha256
  ) VALUES (
    checked_dispute_id, current_event.event_version, current_event.event_version + 1,
    checked_recovery_kind, checked_proposal_evidence_sha256, checked_actor_user_id,
    checked_idempotency_key, request_hash
  ) RETURNING universal_v1_dispute_recovery_intents.recovery_intent_id
    INTO created_intent_id;
  INSERT INTO public.universal_v1_dispute_timeline_events (
    dispute_id, event_version, expected_version, supersedes_event_id,
    event_kind, from_state, to_state, actor_user_id, actor_role,
    evidence_sha256, recovery_intent_id, idempotency_key, request_sha256
  ) VALUES (
    checked_dispute_id, current_event.event_version + 1, current_event.event_version,
    current_event.timeline_event_id, 'RESOLUTION_PROPOSED', 'UNDER_REVIEW',
    'RESOLUTION_PROPOSED', checked_actor_user_id, 'NAMED_OPERATOR',
    checked_proposal_evidence_sha256, created_intent_id,
    checked_idempotency_key, request_hash
  );
  RETURN QUERY SELECT created_intent_id, 'RESOLUTION_PROPOSED'::TEXT,
    current_event.event_version + 1,
    'HELD_TWO_PERSON_DATABASE_CALLER_UNATTESTED'::TEXT, FALSE;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_universal_v1_recovery_approval_v1(
  checked_recovery_intent_id UUID,
  checked_expected_dispute_version INTEGER,
  checked_approval_evidence_sha256 TEXT,
  checked_actor_user_id UUID,
  checked_idempotency_key TEXT
) RETURNS TABLE (
  approval_fact_id UUID,
  dispute_state TEXT,
  dispute_version INTEGER,
  authority_state TEXT,
  idempotency_replayed BOOLEAN
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE
  recovery public.universal_v1_dispute_recovery_intents%ROWTYPE;
  current_event public.universal_v1_dispute_timeline_events%ROWTYPE;
  prior public.universal_v1_dispute_recovery_approval_facts%ROWTYPE;
  prior_timeline public.universal_v1_dispute_timeline_events%ROWTYPE;
  request_hash CHAR(64);
  created_approval_id UUID;
BEGIN
  PERFORM public.assert_universal_v1_dispute_operator_v1(checked_actor_user_id);
  IF checked_approval_evidence_sha256 !~ '^[a-f0-9]{64}$'
     OR checked_approval_evidence_sha256 = repeat('0', 64)
     OR checked_idempotency_key !~ '^[A-Za-z0-9:_-]{16,128}$' THEN
    RAISE EXCEPTION 'HXUDR11: recovery approval shape is invalid' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO recovery FROM public.universal_v1_dispute_recovery_intents
  WHERE recovery_intent_id = checked_recovery_intent_id;
  IF recovery.recovery_intent_id IS NULL THEN
    RAISE EXCEPTION 'HXUDR5: recovery intent was not found' USING ERRCODE = 'P0001';
  END IF;
  request_hash := pg_catalog.encode(public.digest(pg_catalog.concat_ws(':',
    'universal-v1-dispute-recovery-approval-1.0.0', checked_actor_user_id::TEXT,
    checked_recovery_intent_id::TEXT, checked_expected_dispute_version::TEXT,
    checked_approval_evidence_sha256, checked_idempotency_key
  ), 'sha256'), 'hex');
  SELECT * INTO prior FROM public.universal_v1_dispute_recovery_approval_facts approval
  WHERE approval.approved_by_user_id = checked_actor_user_id
    AND approval.idempotency_key = checked_idempotency_key;
  IF prior.approval_fact_id IS NOT NULL THEN
    IF prior.request_sha256 <> request_hash THEN
      RAISE EXCEPTION 'HXUDR4: idempotency key was reused for another approval command'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN QUERY SELECT prior.approval_fact_id, 'RESOLUTION_PROPOSED'::TEXT,
      prior.approval_version,
      'HELD_TWO_PERSON_DATABASE_CALLER_UNATTESTED'::TEXT, TRUE;
    RETURN;
  END IF;
  IF recovery.proposed_by_user_id = checked_actor_user_id THEN
    RAISE EXCEPTION 'HXUDR11: recovery proposer cannot independently approve their own intent'
      USING ERRCODE = 'P0001';
  END IF;
  PERFORM public.universal_v1_dispute_idempotency_lock_v1(
    checked_actor_user_id, checked_idempotency_key
  );
  PERFORM 1 FROM public.universal_v1_dispute_incidents
  WHERE dispute_id = recovery.dispute_id FOR UPDATE;
  SELECT * INTO prior FROM public.universal_v1_dispute_recovery_approval_facts approval
  WHERE approval.approved_by_user_id = checked_actor_user_id
    AND approval.idempotency_key = checked_idempotency_key;
  IF prior.approval_fact_id IS NOT NULL THEN
    IF prior.request_sha256 <> request_hash THEN
      RAISE EXCEPTION 'HXUDR4: idempotency key was reused for another approval command'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN QUERY SELECT prior.approval_fact_id, 'RESOLUTION_PROPOSED'::TEXT,
      prior.approval_version,
      'HELD_TWO_PERSON_DATABASE_CALLER_UNATTESTED'::TEXT, TRUE;
    RETURN;
  END IF;
  SELECT * INTO prior_timeline
  FROM public.universal_v1_dispute_timeline_events event
  WHERE event.actor_user_id = checked_actor_user_id
    AND event.idempotency_key = checked_idempotency_key;
  IF prior_timeline.timeline_event_id IS NOT NULL THEN
    RAISE EXCEPTION 'HXUDR4: idempotency key was reused across dispute commands'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO current_event FROM public.universal_v1_dispute_timeline_events
  WHERE dispute_id = recovery.dispute_id ORDER BY event_version DESC LIMIT 1;
  IF current_event.event_version <> checked_expected_dispute_version
     OR current_event.to_state <> 'RESOLUTION_PROPOSED'
     OR current_event.recovery_intent_id IS DISTINCT FROM recovery.recovery_intent_id THEN
    RAISE EXCEPTION 'HXUDR3: proposed recovery expected version changed'
      USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO public.universal_v1_dispute_recovery_approval_facts (
    dispute_id, recovery_intent_id, expected_dispute_version, approval_version,
    approval_evidence_sha256, approved_by_user_id, idempotency_key, request_sha256
  ) VALUES (
    recovery.dispute_id, recovery.recovery_intent_id, current_event.event_version,
    current_event.event_version + 1, checked_approval_evidence_sha256,
    checked_actor_user_id, checked_idempotency_key, request_hash
  ) RETURNING universal_v1_dispute_recovery_approval_facts.approval_fact_id
    INTO created_approval_id;
  INSERT INTO public.universal_v1_dispute_timeline_events (
    dispute_id, event_version, expected_version, supersedes_event_id,
    event_kind, from_state, to_state, actor_user_id, actor_role,
    evidence_sha256, approval_fact_id, idempotency_key, request_sha256
  ) VALUES (
    recovery.dispute_id, current_event.event_version + 1, current_event.event_version,
    current_event.timeline_event_id, 'INDEPENDENT_APPROVAL_RECORDED',
    'RESOLUTION_PROPOSED', 'RESOLUTION_PROPOSED', checked_actor_user_id,
    'NAMED_OPERATOR', checked_approval_evidence_sha256, created_approval_id,
    checked_idempotency_key, request_hash
  );
  RETURN QUERY SELECT created_approval_id, 'RESOLUTION_PROPOSED'::TEXT,
    current_event.event_version + 1,
    'HELD_TWO_PERSON_DATABASE_CALLER_UNATTESTED'::TEXT, FALSE;
END;
$$;

CREATE OR REPLACE FUNCTION public.universal_v1_has_open_material_dispute_v1(
  checked_work_order_id UUID
) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.universal_v1_dispute_current_v1 dispute
    WHERE dispute.work_order_id = checked_work_order_id
      AND dispute.materiality = 'MATERIAL'
      AND dispute.dispute_state NOT IN ('RESOLVED', 'DISMISSED')
  );
$$;

CREATE OR REPLACE FUNCTION public.enforce_universal_v1_dispute_closure_gate_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public AS $$
DECLARE
  checked_work_order_id UUID;
BEGIN
  checked_work_order_id := NEW.work_order_id;
  PERFORM public.universal_v1_dispute_lock_v1(checked_work_order_id);
  IF public.universal_v1_has_open_material_dispute_v1(checked_work_order_id) THEN
    IF TG_TABLE_NAME = 'task_completion_facts' THEN
      IF NEW.fact_kind = 'APPROVED' THEN
        RAISE EXCEPTION 'HXUDR9: material dispute blocks completion approval'
          USING ERRCODE = 'P0001';
      END IF;
    ELSIF TG_TABLE_NAME = 'task_work_order_execution_facts' THEN
      IF NEW.state = 'COMPLETED' OR NEW.transition_kind = 'COMPLETION_APPROVED' THEN
        RAISE EXCEPTION 'HXUDR9: material dispute blocks Work Order closure'
          USING ERRCODE = 'P0001';
      END IF;
    ELSIF TG_TABLE_NAME = 'task_reconciliation_facts' THEN
      IF NEW.reconciliation_state IN ('MATCHED', 'CLOSED') THEN
        RAISE EXCEPTION 'HXUDR9: material dispute blocks reconciliation closure'
          USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_universal_v1_dispute_release_gate_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public AS $$
DECLARE
  checked_work_order_id UUID;
BEGIN
  IF TG_TABLE_NAME = 'universal_v1_fake_terminal_lifecycle_intents' THEN
    IF NEW.terminal_path <> 'SETTLED' THEN RETURN NEW; END IF;
    checked_work_order_id := NEW.work_order_id;
  ELSIF TG_TABLE_NAME = 'universal_v1_prepared_financial_commands' THEN
    IF NEW.operation_kind NOT IN ('PROVIDER_RELEASE', 'PAYOUT') THEN RETURN NEW; END IF;
    -- This gate sorts before the prepared-command authority trigger. Derive the
    -- same exact current Work Order from PostgreSQL instead of trusting a
    -- caller value that the later authority trigger deliberately overwrites.
    SELECT work_order.id INTO checked_work_order_id
      FROM public.tasks task
      JOIN public.task_work_orders work_order
        ON work_order.id = task.work_order_id
       AND work_order.task_id = task.id
       AND work_order.task_draft_id = NEW.task_draft_id
     WHERE task.id = NEW.task_id;
  ELSIF TG_TABLE_NAME = 'financial_provider_command_journal' THEN
    IF NEW.operation_kind NOT IN ('PROVIDER_RELEASE', 'PAYOUT') THEN RETURN NEW; END IF;
    checked_work_order_id := NEW.work_order_id;
  ELSIF TG_TABLE_NAME = 'task_financial_security_events' THEN
    IF NEW.event_kind NOT IN ('PROVIDER_RELEASED', 'PAYOUT_OBSERVED') THEN RETURN NEW; END IF;
    SELECT work_order.id INTO checked_work_order_id
    FROM public.task_work_orders work_order
    WHERE work_order.task_id = NEW.task_id;
  END IF;

  IF checked_work_order_id IS NULL THEN
    RAISE EXCEPTION 'HXUDR9: release/payout authority lacks an exact Work Order binding'
      USING ERRCODE = 'P0001';
  END IF;
  PERFORM public.universal_v1_dispute_lock_v1(checked_work_order_id);
  IF public.universal_v1_has_open_material_dispute_v1(checked_work_order_id) THEN
    RAISE EXCEPTION 'HXUDR9: material dispute blocks new provider release or payout intent'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS aa_universal_v1_dispute_completion_gate
  ON public.task_completion_facts;
CREATE TRIGGER aa_universal_v1_dispute_completion_gate
BEFORE INSERT ON public.task_completion_facts
FOR EACH ROW EXECUTE FUNCTION public.enforce_universal_v1_dispute_closure_gate_v1();

DROP TRIGGER IF EXISTS aa_universal_v1_dispute_execution_gate
  ON public.task_work_order_execution_facts;
CREATE TRIGGER aa_universal_v1_dispute_execution_gate
BEFORE INSERT ON public.task_work_order_execution_facts
FOR EACH ROW EXECUTE FUNCTION public.enforce_universal_v1_dispute_closure_gate_v1();

DROP TRIGGER IF EXISTS aa_universal_v1_dispute_reconciliation_gate
  ON public.task_reconciliation_facts;
CREATE TRIGGER aa_universal_v1_dispute_reconciliation_gate
BEFORE INSERT ON public.task_reconciliation_facts
FOR EACH ROW EXECUTE FUNCTION public.enforce_universal_v1_dispute_closure_gate_v1();

DROP TRIGGER IF EXISTS aa_universal_v1_dispute_prepared_release_gate
  ON public.universal_v1_prepared_financial_commands;
CREATE TRIGGER aa_universal_v1_dispute_prepared_release_gate
BEFORE INSERT ON public.universal_v1_prepared_financial_commands
FOR EACH ROW EXECUTE FUNCTION public.enforce_universal_v1_dispute_release_gate_v1();

DROP TRIGGER IF EXISTS aa_universal_v1_dispute_command_release_gate
  ON public.financial_provider_command_journal;
CREATE TRIGGER aa_universal_v1_dispute_command_release_gate
BEFORE INSERT ON public.financial_provider_command_journal
FOR EACH ROW EXECUTE FUNCTION public.enforce_universal_v1_dispute_release_gate_v1();

DROP TRIGGER IF EXISTS aa_universal_v1_dispute_financial_release_gate
  ON public.task_financial_security_events;
CREATE TRIGGER aa_universal_v1_dispute_financial_release_gate
BEFORE INSERT ON public.task_financial_security_events
FOR EACH ROW EXECUTE FUNCTION public.enforce_universal_v1_dispute_release_gate_v1();

DO $$
DECLARE
  relation_name TEXT;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'universal_v1_dispute_incidents',
    'universal_v1_dispute_evidence_facts',
    'universal_v1_dispute_recovery_intents',
    'universal_v1_dispute_recovery_approval_facts',
    'universal_v1_dispute_timeline_events'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I',
      relation_name || '_immutable', relation_name);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.prevent_universal_v1_fact_mutation()',
      relation_name || '_immutable', relation_name
    );
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I',
      relation_name || '_no_truncate', relation_name);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_universal_v1_fact_mutation()',
      relation_name || '_no_truncate', relation_name
    );
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', relation_name);
  END LOOP;
END;
$$;

REVOKE ALL ON TABLE public.universal_v1_dispute_current_v1 FROM PUBLIC;
REVOKE ALL ON FUNCTION public.universal_v1_dispute_lock_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.universal_v1_dispute_idempotency_lock_v1(UUID, TEXT)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_universal_v1_dispute_participant_v1(UUID, UUID)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_universal_v1_dispute_operator_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.validate_universal_v1_dispute_timeline_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.open_universal_v1_dispute_v1(
  UUID, BIGINT, UUID, INTEGER, UUID, INTEGER, INTEGER, TEXT, TEXT, UUID, TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.add_universal_v1_dispute_evidence_v1(
  UUID, INTEGER, TEXT, TEXT, TEXT, BIGINT, UUID, TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.begin_universal_v1_dispute_review_v1(
  UUID, INTEGER, TEXT, UUID, TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.propose_universal_v1_dispute_recovery_v1(
  UUID, INTEGER, TEXT, TEXT, UUID, TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_universal_v1_recovery_approval_v1(
  UUID, INTEGER, TEXT, UUID, TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.universal_v1_has_open_material_dispute_v1(UUID)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_universal_v1_dispute_closure_gate_v1()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_universal_v1_dispute_release_gate_v1()
  FROM PUBLIC;

COMMENT ON TABLE public.universal_v1_dispute_incidents IS
  'Exact-version participant-authored Universal V1 material incidents. No raw narrative, address, provider secret, or money effect is stored.';
COMMENT ON TABLE public.universal_v1_dispute_recovery_intents IS
  'Typed provider-neutral recovery proposals only. Every proposal remains held and creates no refund, reversal, rework, replacement, cancellation, provider, or money effect.';
COMMENT ON FUNCTION public.record_universal_v1_recovery_approval_v1(
  UUID, INTEGER, TEXT, UUID, TEXT
) IS
  'Records one distinct second-operator review fact but deliberately cannot resolve/dismiss or execute its recovery proposal.';
