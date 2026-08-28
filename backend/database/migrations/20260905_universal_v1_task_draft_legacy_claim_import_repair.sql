-- Universal V1 legacy TaskDraft claim-import repair.
--
-- The canonical account-claim contract must continue to reject inferred
-- ownership and fabricated claim events. A reviewed legacy Supabase import is
-- different: it is immutable version-zero source evidence backed by the exact
-- 20260902 batch/receipt contract. This repair permits that evidence to retain
-- claim-like source state after 20260903 and records one immutable unverified
-- observation. It grants no canonical account, Task, assignment, or money
-- authority. Under the source-locked underwriting contract, an external
-- provider "claim" is only EXPRESS_INTEREST. This source observation is not
-- provider interest and creates no reservation, assignment, private-data
-- release, provider eligibility, Financial Security Event, capture,
-- settlement, funding, payout, or other money state.

-- Close any observation gap that predates this repair. This is deliberately
-- idempotent and never creates authenticated canonical claim evidence.
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

CREATE OR REPLACE FUNCTION enforce_task_draft_account_claim_transition()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A reviewed legacy import may retain claim-like source state only as a
    -- version-zero, receipt-backed, read-only evidence projection. The
    -- 20260902 deferred receipt guard proves the exact receipt by commit, and
    -- its immutability guard prevents later adoption by mutation. A canonical
    -- poster_user_id is never valid on that projection.
    IF NEW.ingress_origin = 'LEGACY_SUPABASE_TASK_DRAFT_PUBLIC' THEN
      IF NEW.poster_user_id IS NOT NULL THEN
        RAISE EXCEPTION 'HXUV1-TD-CLAIM-2: TaskDraft claim requires exact canonical event evidence'
          USING ERRCODE = 'P0001';
      END IF;
      RETURN NEW;
    END IF;

    -- Canonical and unclassified inserts cannot introduce any claim-like
    -- state. In particular, poster_user_id by itself is claim-like evidence
    -- and must not bypass the status/claimed_at checks.
    IF NEW.status = 'account_claimed'
       OR NEW.claimed_at IS NOT NULL
       OR NEW.poster_user_id IS NOT NULL THEN
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

CREATE OR REPLACE FUNCTION record_legacy_task_draft_claim_observation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.ingress_origin = 'LEGACY_SUPABASE_TASK_DRAFT_PUBLIC'
     AND (
       NEW.status = 'account_claimed'
       OR NEW.claimed_at IS NOT NULL
       OR NEW.poster_user_id IS NOT NULL
     ) THEN
    INSERT INTO public.task_draft_precontract_claim_observations (
      task_draft_id,
      observed_status,
      observed_poster_user_id,
      observed_claimed_at,
      ingress_origin,
      classification
    ) VALUES (
      NEW.id,
      NEW.status,
      NEW.poster_user_id,
      NEW.claimed_at,
      NEW.ingress_origin,
      'PRECONTRACT_UNVERIFIED_NO_CANONICAL_EVENT'
    )
    ON CONFLICT (task_draft_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS task_draft_legacy_claim_observation
  ON public.task_drafts;
CREATE TRIGGER task_draft_legacy_claim_observation
AFTER INSERT ON public.task_drafts
FOR EACH ROW EXECUTE FUNCTION record_legacy_task_draft_claim_observation();

-- Refuse a partially repaired target. Every noncanonical claim-like aggregate
-- must have one exact immutable observation, and none may be promoted into a
-- canonical claim event by inference.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.task_drafts draft
    LEFT JOIN public.task_draft_precontract_claim_observations observation
      ON observation.task_draft_id = draft.id
    WHERE draft.ingress_origin <> 'BACKEND_POSTGRESQL'
      AND (
        draft.status = 'account_claimed'
        OR draft.claimed_at IS NOT NULL
        OR draft.poster_user_id IS NOT NULL
      )
      AND (
        observation.task_draft_id IS NULL
        OR observation.observed_status IS DISTINCT FROM draft.status
        OR observation.observed_poster_user_id IS DISTINCT FROM draft.poster_user_id
        OR observation.observed_claimed_at IS DISTINCT FROM draft.claimed_at
        OR observation.ingress_origin IS DISTINCT FROM draft.ingress_origin
        OR observation.classification IS DISTINCT FROM
          'PRECONTRACT_UNVERIFIED_NO_CANONICAL_EVENT'
      )
  ) THEN
    RAISE EXCEPTION 'HXUV1-TD-CLAIM-6: noncanonical claim-like state requires one exact immutable observation'
      USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.task_draft_account_claim_events event
    JOIN public.task_drafts draft ON draft.id = event.task_draft_id
    WHERE draft.ingress_origin <> 'BACKEND_POSTGRESQL'
  ) THEN
    RAISE EXCEPTION 'HXUV1-TD-CLAIM-7: noncanonical TaskDraft cannot carry canonical claim evidence'
      USING ERRCODE = 'P0001';
  END IF;
END
$$;

REVOKE ALL ON FUNCTION record_legacy_task_draft_claim_observation() FROM PUBLIC;

COMMENT ON FUNCTION record_legacy_task_draft_claim_observation() IS
  'Records immutable unverified source-state evidence for exact receipt-backed legacy TaskDraft imports; creates no canonical claim authority.';
