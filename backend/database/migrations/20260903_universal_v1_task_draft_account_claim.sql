-- Universal V1 TaskDraft account-claim authority.
--
-- This append-only contract moves account claim into the canonical backend and
-- PostgreSQL domain. It deliberately refuses imported/unclassified TaskDrafts,
-- records one immutable authenticated claim fact, and creates no Task, Work
-- Order, assignment, authorization, capture, payout, or other money effect.

CREATE TABLE IF NOT EXISTS public.task_draft_account_claim_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_draft_id UUID NOT NULL
    REFERENCES public.task_drafts(id) ON DELETE RESTRICT,
  actor_user_id UUID NOT NULL
    REFERENCES public.users(id) ON DELETE RESTRICT,
  event_version INTEGER NOT NULL,
  expected_version INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_sha256 CHAR(64) NOT NULL,
  status_before TEXT NOT NULL,
  status_after TEXT NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT task_draft_account_claim_event_version_check CHECK (
    expected_version = 0 AND event_version = expected_version + 1
  ),
  CONSTRAINT task_draft_account_claim_event_status_check CHECK (
    status_before = 'contact_captured' AND status_after = 'account_claimed'
  ),
  CONSTRAINT task_draft_account_claim_event_request_hash_check CHECK (
    request_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT task_draft_account_claim_event_idempotency_check CHECK (
    idempotency_key ~ '^[A-Za-z0-9:_-]{8,128}$'
  ),
  CONSTRAINT task_draft_account_claim_event_one_per_draft UNIQUE (task_draft_id),
  CONSTRAINT task_draft_account_claim_event_actor_idempotency UNIQUE (
    actor_user_id,
    idempotency_key
  )
);

CREATE INDEX IF NOT EXISTS idx_task_draft_account_claim_events_actor
  ON public.task_draft_account_claim_events(actor_user_id, created_at DESC);

-- Upgraded databases may already contain pre-contract claim-like state. Do
-- not fabricate a canonical event for it. Preserve one immutable observation
-- so the row remains explicitly unverified and cannot be mistaken for this
-- contract's authenticated claim evidence.
CREATE TABLE IF NOT EXISTS public.task_draft_precontract_claim_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_draft_id UUID NOT NULL UNIQUE
    REFERENCES public.task_drafts(id) ON DELETE RESTRICT,
  observed_status TEXT NOT NULL,
  observed_poster_user_id UUID,
  observed_claimed_at TIMESTAMPTZ,
  ingress_origin TEXT NOT NULL,
  classification TEXT NOT NULL CHECK (
    classification = 'PRECONTRACT_UNVERIFIED_NO_CANONICAL_EVENT'
  ),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION prevent_task_draft_account_claim_event_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'HXUV1-TD-CLAIM-1: TaskDraft account-claim evidence is append-only'
    USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS task_draft_account_claim_events_immutable
  ON public.task_draft_account_claim_events;
CREATE TRIGGER task_draft_account_claim_events_immutable
BEFORE UPDATE OR DELETE ON public.task_draft_account_claim_events
FOR EACH ROW EXECUTE FUNCTION prevent_task_draft_account_claim_event_mutation();

DROP TRIGGER IF EXISTS task_draft_account_claim_events_no_truncate
  ON public.task_draft_account_claim_events;
CREATE TRIGGER task_draft_account_claim_events_no_truncate
BEFORE TRUNCATE ON public.task_draft_account_claim_events
FOR EACH STATEMENT EXECUTE FUNCTION prevent_task_draft_account_claim_event_mutation();

DROP TRIGGER IF EXISTS task_draft_precontract_claim_observations_immutable
  ON public.task_draft_precontract_claim_observations;
CREATE TRIGGER task_draft_precontract_claim_observations_immutable
BEFORE UPDATE OR DELETE ON public.task_draft_precontract_claim_observations
FOR EACH ROW EXECUTE FUNCTION prevent_task_draft_account_claim_event_mutation();

DROP TRIGGER IF EXISTS task_draft_precontract_claim_observations_no_truncate
  ON public.task_draft_precontract_claim_observations;
CREATE TRIGGER task_draft_precontract_claim_observations_no_truncate
BEFORE TRUNCATE ON public.task_draft_precontract_claim_observations
FOR EACH STATEMENT EXECUTE FUNCTION prevent_task_draft_account_claim_event_mutation();

INSERT INTO public.task_draft_precontract_claim_observations (
  task_draft_id,
  observed_status,
  observed_poster_user_id,
  observed_claimed_at,
  ingress_origin,
  classification
)
SELECT
  draft.id,
  draft.status,
  draft.poster_user_id,
  draft.claimed_at,
  draft.ingress_origin,
  'PRECONTRACT_UNVERIFIED_NO_CANONICAL_EVENT'
FROM public.task_drafts draft
WHERE draft.ingress_origin <> 'BACKEND_POSTGRESQL'
  AND (
    draft.status = 'account_claimed'
    OR draft.claimed_at IS NOT NULL
    OR draft.poster_user_id IS NOT NULL
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.task_draft_account_claim_events event
    WHERE event.task_draft_id = draft.id
  )
ON CONFLICT (task_draft_id) DO NOTHING;

-- Canonical backend claim-like state cannot be adopted by inference. If an
-- upgraded target already contains it without the exact event, abort the
-- migration so a separately reviewed evidence/adoption repair can decide the
-- row disposition.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.task_drafts draft
    WHERE draft.ingress_origin = 'BACKEND_POSTGRESQL'
      AND (
        draft.status = 'account_claimed'
        OR draft.poster_user_id IS NOT NULL
        OR draft.claimed_at IS NOT NULL
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.task_draft_account_claim_events event
        WHERE event.task_draft_id = draft.id
          AND event.actor_user_id = draft.poster_user_id
          AND event.expected_version = 0
          AND event.event_version = 1
          AND event.status_before = 'contact_captured'
          AND event.status_after = 'account_claimed'
      )
  ) THEN
    RAISE EXCEPTION 'HXUV1-TD-CLAIM-4: canonical precontract claim-like state requires reviewed adoption evidence'
      USING ERRCODE = 'P0001';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION enforce_task_draft_account_claim_transition()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'account_claimed'
       OR NEW.claimed_at IS NOT NULL
       OR (
         NEW.ingress_origin = 'BACKEND_POSTGRESQL'
         AND NEW.poster_user_id IS NOT NULL
       ) THEN
      RAISE EXCEPTION 'HXUV1-TD-CLAIM-2: TaskDraft claim requires exact canonical event evidence'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'account_claimed'
     AND NEW.status IN ('draft', 'anonymous_task_draft', 'contact_captured') THEN
    RAISE EXCEPTION 'HXUV1-TD-CLAIM-2: TaskDraft claim requires exact canonical event evidence'
      USING ERRCODE = 'P0001';
  END IF;

  IF OLD.poster_user_id IS NOT DISTINCT FROM NEW.poster_user_id
     AND OLD.claimed_at IS NOT DISTINCT FROM NEW.claimed_at
     AND NOT (OLD.status <> 'account_claimed' AND NEW.status = 'account_claimed') THEN
    RETURN NEW;
  END IF;

  IF OLD.ingress_origin <> 'BACKEND_POSTGRESQL'
     OR NEW.ingress_origin <> 'BACKEND_POSTGRESQL'
     OR OLD.status <> 'contact_captured'
     OR NEW.status <> 'account_claimed'
     OR OLD.poster_user_id IS NOT NULL
     OR NEW.poster_user_id IS NULL
     OR OLD.claimed_at IS NOT NULL
     OR NEW.claimed_at IS NULL
     OR NOT EXISTS (
       SELECT 1
       FROM public.task_draft_account_claim_events event
       WHERE event.task_draft_id = NEW.id
         AND event.actor_user_id = NEW.poster_user_id
         AND event.expected_version = 0
         AND event.event_version = 1
         AND event.status_before = OLD.status
         AND event.status_after = NEW.status
     ) THEN
    RAISE EXCEPTION 'HXUV1-TD-CLAIM-2: TaskDraft claim requires exact canonical event evidence'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS task_draft_account_claim_transition_guard
  ON public.task_drafts;
CREATE TRIGGER task_draft_account_claim_transition_guard
BEFORE INSERT OR UPDATE ON public.task_drafts
FOR EACH ROW EXECUTE FUNCTION enforce_task_draft_account_claim_transition();

CREATE OR REPLACE FUNCTION enforce_task_draft_account_claim_event_state()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.task_drafts draft
    WHERE draft.id = NEW.task_draft_id
      AND draft.ingress_origin = 'BACKEND_POSTGRESQL'
      AND draft.status = 'account_claimed'
      AND draft.poster_user_id = NEW.actor_user_id
      AND draft.claimed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'HXUV1-TD-CLAIM-3: TaskDraft claim event lacks matching claimed aggregate state'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_task_draft_account_claim_presence()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.ingress_origin <> 'BACKEND_POSTGRESQL' THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'account_claimed'
     OR NEW.poster_user_id IS NOT NULL
     OR NEW.claimed_at IS NOT NULL THEN
    IF NEW.lead_id IS NULL
       OR NEW.poster_user_id IS NULL
       OR NEW.claimed_at IS NULL
       OR NOT EXISTS (
         SELECT 1
         FROM public.task_draft_account_claim_events event
         WHERE event.task_draft_id = NEW.id
           AND event.actor_user_id = NEW.poster_user_id
           AND event.expected_version = 0
           AND event.event_version = 1
           AND event.status_before = 'contact_captured'
           AND event.status_after = 'account_claimed'
       ) THEN
      RAISE EXCEPTION 'HXUV1-TD-CLAIM-5: canonical claim-like aggregate state requires exact event and contact evidence'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS task_draft_account_claim_presence_guard
  ON public.task_drafts;
CREATE CONSTRAINT TRIGGER task_draft_account_claim_presence_guard
AFTER INSERT OR UPDATE ON public.task_drafts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_task_draft_account_claim_presence();

DROP TRIGGER IF EXISTS task_draft_account_claim_event_state_guard
  ON public.task_draft_account_claim_events;
CREATE CONSTRAINT TRIGGER task_draft_account_claim_event_state_guard
AFTER INSERT ON public.task_draft_account_claim_events
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_task_draft_account_claim_event_state();

REVOKE ALL ON TABLE public.task_draft_account_claim_events FROM PUBLIC;
REVOKE ALL ON TABLE public.task_draft_precontract_claim_observations FROM PUBLIC;
REVOKE ALL ON FUNCTION prevent_task_draft_account_claim_event_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION enforce_task_draft_account_claim_transition() FROM PUBLIC;
REVOKE ALL ON FUNCTION enforce_task_draft_account_claim_event_state() FROM PUBLIC;
REVOKE ALL ON FUNCTION enforce_task_draft_account_claim_presence() FROM PUBLIC;

COMMENT ON TABLE public.task_draft_account_claim_events IS
  'Immutable authenticated claim facts for canonical backend TaskDrafts; no assignment or financial authority.';

COMMENT ON TABLE public.task_draft_precontract_claim_observations IS
  'Immutable observations of claim-like TaskDraft state that predates canonical authenticated claim evidence.';
