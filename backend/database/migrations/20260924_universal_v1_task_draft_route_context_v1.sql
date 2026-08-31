-- HustleXP Universal V1 TaskDraft route-context authority.
-- Authority: HustleXP Business and Universal V1 Charter v1.1.0.
--
-- This additive migration creates no Task, opportunity, assignment, Work
-- Order, financial operation, provider I/O, or production effect. It gives a
-- new public-intake policy one immutable, privacy-safe work-category and
-- service-cell snapshot. The table is intentionally empty on installation;
-- synthetic local/preview/staging fixtures and any future signed production
-- dataset are separately controlled artifacts.

CREATE TABLE IF NOT EXISTS public.universal_v1_service_cell_authorities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  postal_code TEXT NOT NULL CHECK (postal_code ~ '^[0-9]{5}$'),
  region_code TEXT NOT NULL CHECK (region_code ~ '^US-[A-Z]{2}$'),
  rough_location TEXT NOT NULL CHECK (
    char_length(btrim(rough_location)) BETWEEN 2 AND 120
  ),
  routing_availability TEXT NOT NULL CHECK (
    routing_availability IN ('ACTIVE', 'WAITLIST', 'UNAVAILABLE')
  ),
  authority_environment TEXT NOT NULL CHECK (
    authority_environment IN ('local', 'preview', 'staging', 'production')
  ),
  is_test BOOLEAN NOT NULL,
  authority_kind TEXT NOT NULL CHECK (
    authority_kind IN ('SYNTHETIC_FIXTURE', 'SIGNED_DATASET')
  ),
  authority_version INTEGER NOT NULL CHECK (authority_version > 0),
  supersedes_authority_id UUID
    REFERENCES public.universal_v1_service_cell_authorities(id) ON DELETE RESTRICT,
  evidence JSONB NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  evidence_sha256 CHAR(64) NOT NULL CHECK (
    evidence_sha256 ~ '^[a-f0-9]{64}$'
    AND evidence_sha256 = encode(digest(evidence::text, 'sha256'), 'hex')
  ),
  effective_from TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (postal_code, authority_environment, authority_version),
  UNIQUE (supersedes_authority_id),
  CHECK (
    (authority_version = 1 AND supersedes_authority_id IS NULL)
    OR (authority_version > 1 AND supersedes_authority_id IS NOT NULL)
  ),
  CHECK (expires_at IS NULL OR expires_at > effective_from),
  CHECK (
    (
      authority_environment IN ('local', 'preview', 'staging')
      AND is_test IS TRUE
      AND authority_kind = 'SYNTHETIC_FIXTURE'
    )
    OR (
      authority_environment = 'production'
      AND is_test IS FALSE
      AND authority_kind = 'SIGNED_DATASET'
    )
  )
);

CREATE INDEX IF NOT EXISTS universal_v1_service_cell_authorities_lookup_idx
  ON public.universal_v1_service_cell_authorities(
    postal_code,
    authority_environment,
    authority_version DESC
  );

CREATE OR REPLACE FUNCTION public.enforce_universal_v1_service_cell_sequence()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  predecessor public.universal_v1_service_cell_authorities%ROWTYPE;
BEGIN
  IF NEW.authority_version = 1 THEN
    RETURN NEW;
  END IF;

  SELECT * INTO predecessor
    FROM public.universal_v1_service_cell_authorities
   WHERE id = NEW.supersedes_authority_id
   FOR SHARE;
  IF NOT FOUND
     OR predecessor.postal_code IS DISTINCT FROM NEW.postal_code
     OR predecessor.authority_environment IS DISTINCT FROM NEW.authority_environment
     OR predecessor.authority_version <> NEW.authority_version - 1 THEN
    RAISE EXCEPTION 'HXUV1-ROUTE-CONTEXT-1: service-cell revisions require one exact predecessor chain'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS universal_v1_service_cell_sequence_guard
  ON public.universal_v1_service_cell_authorities;
CREATE TRIGGER universal_v1_service_cell_sequence_guard
BEFORE INSERT ON public.universal_v1_service_cell_authorities
FOR EACH ROW EXECUTE FUNCTION public.enforce_universal_v1_service_cell_sequence();

DROP TRIGGER IF EXISTS universal_v1_service_cell_authorities_immutable
  ON public.universal_v1_service_cell_authorities;
CREATE TRIGGER universal_v1_service_cell_authorities_immutable
BEFORE UPDATE OR DELETE ON public.universal_v1_service_cell_authorities
FOR EACH ROW EXECUTE FUNCTION public.prevent_universal_v1_fact_mutation();

DROP TRIGGER IF EXISTS universal_v1_service_cell_authorities_no_truncate
  ON public.universal_v1_service_cell_authorities;
CREATE TRIGGER universal_v1_service_cell_authorities_no_truncate
BEFORE TRUNCATE ON public.universal_v1_service_cell_authorities
FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_universal_v1_fact_mutation();

ALTER TABLE public.task_routing_decisions
  ADD COLUMN IF NOT EXISTS service_cell_authority_id UUID
    REFERENCES public.universal_v1_service_cell_authorities(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS task_routing_decisions_service_cell_authority_idx
  ON public.task_routing_decisions(service_cell_authority_id)
  WHERE service_cell_authority_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.enforce_universal_v1_task_draft_route_context_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  predecessor public.task_routing_decisions%ROWTYPE;
  authority public.universal_v1_service_cell_authorities%ROWTYPE;
  draft_zip TEXT;
  draft_region TEXT;
  ingress_action TEXT := NEW.evidence ->> 'ingress_action';
  blocker_codes TEXT[] := ARRAY[]::TEXT[];
  context_key TEXT;
BEGIN
  -- Estimate acceptance advances lifecycle state without changing the exact
  -- server-owned work category or service-cell provenance selected at intake.
  IF NEW.policy_version = 'universal-v1-estimate-acceptance-1.1.0' THEN
    SELECT * INTO predecessor
      FROM public.task_routing_decisions
     WHERE id = NEW.supersedes_decision_id;
    IF NOT FOUND
       OR predecessor.task_draft_id IS DISTINCT FROM NEW.task_draft_id
       OR predecessor.category_snapshot IS DISTINCT FROM NEW.category_snapshot
       OR predecessor.service_cell_snapshot IS DISTINCT FROM NEW.service_cell_snapshot
       OR predecessor.service_cell_authority_id
            IS DISTINCT FROM NEW.service_cell_authority_id THEN
      RAISE EXCEPTION 'HXUV1-ROUTE-CONTEXT-1: estimate acceptance must preserve the exact predecessor route context'
        USING ERRCODE = 'P0001';
    END IF;
    FOREACH context_key IN ARRAY ARRAY[
      'route_context_contract_version',
      'work_category_code',
      'region_code',
      'rough_location',
      'risk_level',
      'requires_proof',
      'final_availability_confirmation_required',
      'postal_code',
      'service_cell_authority_id',
      'service_cell_authority_version',
      'service_cell_authority_environment',
      'service_cell_authority_kind',
      'service_cell_evidence_sha256',
      'service_cell_availability',
      'routing_blocker_codes'
    ] LOOP
      IF predecessor.evidence -> context_key IS DISTINCT FROM NEW.evidence -> context_key THEN
        RAISE EXCEPTION 'HXUV1-ROUTE-CONTEXT-1: estimate acceptance cannot replace route context key %', context_key
          USING ERRCODE = 'P0001';
      END IF;
    END LOOP;
  END IF;

  -- A contact link advances the aggregate version but is never a reroute.
  -- Enforce exact predecessor preservation for every policy version.
  IF ingress_action = 'link_contact' THEN
    SELECT * INTO predecessor
      FROM public.task_routing_decisions
     WHERE id = NEW.supersedes_decision_id;
    IF NOT FOUND
       OR predecessor.task_draft_id IS DISTINCT FROM NEW.task_draft_id
       OR predecessor.outcome IS DISTINCT FROM NEW.outcome
       OR predecessor.reason_codes IS DISTINCT FROM NEW.reason_codes
       OR predecessor.policy_version IS DISTINCT FROM NEW.policy_version
       OR predecessor.category_snapshot IS DISTINCT FROM NEW.category_snapshot
       OR predecessor.service_cell_snapshot IS DISTINCT FROM NEW.service_cell_snapshot
       OR predecessor.service_cell_authority_id
            IS DISTINCT FROM NEW.service_cell_authority_id THEN
      RAISE EXCEPTION 'HXUV1-ROUTE-CONTEXT-2: contact linking must preserve the exact predecessor route'
        USING ERRCODE = 'P0001';
    END IF;
    FOREACH context_key IN ARRAY ARRAY[
      'route_context_contract_version',
      'work_category_code',
      'region_code',
      'rough_location',
      'risk_level',
      'requires_proof',
      'final_availability_confirmation_required',
      'postal_code',
      'service_cell_authority_id',
      'service_cell_authority_version',
      'service_cell_authority_environment',
      'service_cell_authority_kind',
      'service_cell_evidence_sha256',
      'service_cell_availability',
      'routing_blocker_codes'
    ] LOOP
      IF predecessor.evidence -> context_key IS DISTINCT FROM NEW.evidence -> context_key THEN
        RAISE EXCEPTION 'HXUV1-ROUTE-CONTEXT-3: contact linking cannot replace route context key %', context_key
          USING ERRCODE = 'P0001';
      END IF;
    END LOOP;
  END IF;

  -- Historical policies remain immutable evidence and are not backfilled or
  -- reinterpreted. Estimate acceptance is preservation-checked above; only
  -- newly emitted public-intake 1.2 decisions require full authority proof.
  IF NEW.policy_version <> 'universal-v1-intake-1.2.0' THEN
    RETURN NEW;
  END IF;

  IF ingress_action NOT IN ('create', 'update', 'link_contact')
     OR NEW.evidence -> 'route_context_contract_version' <> '1'::JSONB
     OR jsonb_typeof(NEW.evidence -> 'work_category_code') <> 'string'
     OR NEW.evidence ->> 'work_category_code'
          NOT IN (
            'moving', 'furniture_assembly', 'errands', 'yard', 'tech',
            'cleaning', 'handyman', 'other', 'plumbing', 'electrical',
            'hvac', 'roofing', 'general_contracting'
          )
     OR NEW.category_snapshot IS DISTINCT FROM NEW.evidence ->> 'work_category_code'
     OR jsonb_typeof(NEW.evidence -> 'risk_level') <> 'string'
     OR NEW.evidence ->> 'risk_level' NOT IN ('LOW', 'MEDIUM', 'HIGH', 'IN_HOME')
     OR NEW.evidence -> 'requires_proof' <> 'true'::JSONB
     OR NEW.evidence -> 'final_availability_confirmation_required' <> 'true'::JSONB
     OR jsonb_typeof(NEW.evidence -> 'routing_blocker_codes') <> 'array'
     OR EXISTS (
       SELECT 1
         FROM jsonb_array_elements(NEW.evidence -> 'routing_blocker_codes')
           AS blockers(value)
        WHERE jsonb_typeof(value) <> 'string'
     ) THEN
    RAISE EXCEPTION 'HXUV1-ROUTE-CONTEXT-4: policy 1.2 requires one normalized server-owned route snapshot'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(array_agg(value), ARRAY[]::TEXT[])
    INTO blocker_codes
    FROM jsonb_array_elements_text(NEW.evidence -> 'routing_blocker_codes')
      AS blockers(value);
  IF EXISTS (
    SELECT 1 FROM unnest(blocker_codes) blocker
     WHERE NOT (blocker = ANY(NEW.reason_codes))
  ) THEN
    RAISE EXCEPTION 'HXUV1-ROUTE-CONTEXT-5: every route blocker must remain in the routing reason codes'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT zip, region INTO draft_zip, draft_region
    FROM public.task_drafts
   WHERE id = NEW.task_draft_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HXUV1-ROUTE-CONTEXT-6: route context requires its exact TaskDraft'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.service_cell_authority_id IS NULL THEN
    IF NEW.service_cell_snapshot IS NOT NULL
       OR jsonb_typeof(NEW.evidence -> 'region_code') <> 'null'
       OR jsonb_typeof(NEW.evidence -> 'rough_location') <> 'null'
       OR jsonb_typeof(NEW.evidence -> 'service_cell_authority_id') <> 'null'
       OR jsonb_typeof(NEW.evidence -> 'service_cell_authority_version') <> 'null'
       OR jsonb_typeof(NEW.evidence -> 'service_cell_authority_environment') <> 'null'
       OR jsonb_typeof(NEW.evidence -> 'service_cell_authority_kind') <> 'null'
       OR jsonb_typeof(NEW.evidence -> 'service_cell_evidence_sha256') <> 'null'
       OR NEW.evidence ->> 'service_cell_availability' <> 'UNRESOLVED'
       OR cardinality(blocker_codes) = 0
       OR NEW.outcome IN ('FULFILLMENT_CANDIDATE', 'ESTIMATE_REQUIRED') THEN
      RAISE EXCEPTION 'HXUV1-ROUTE-CONTEXT-7: unresolved service cells must fail closed without transaction candidacy'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  SELECT * INTO authority
    FROM public.universal_v1_service_cell_authorities
   WHERE id = NEW.service_cell_authority_id;
  IF NOT FOUND
     OR split_part(COALESCE(draft_zip, ''), '-', 1) IS DISTINCT FROM authority.postal_code
     OR draft_region IS DISTINCT FROM authority.rough_location
     OR NEW.service_cell_snapshot IS DISTINCT FROM authority.region_code
     OR NEW.evidence ->> 'postal_code' IS DISTINCT FROM authority.postal_code
     OR NEW.evidence ->> 'region_code' IS DISTINCT FROM authority.region_code
     OR NEW.evidence ->> 'rough_location' IS DISTINCT FROM authority.rough_location
     OR NEW.evidence ->> 'service_cell_authority_id' IS DISTINCT FROM authority.id::TEXT
     OR jsonb_typeof(NEW.evidence -> 'service_cell_authority_version') <> 'number'
     OR (NEW.evidence ->> 'service_cell_authority_version')::INTEGER
          IS DISTINCT FROM authority.authority_version
     OR NEW.evidence ->> 'service_cell_authority_environment'
          IS DISTINCT FROM authority.authority_environment
     OR NEW.evidence ->> 'service_cell_authority_kind'
          IS DISTINCT FROM authority.authority_kind
     OR NEW.evidence ->> 'service_cell_evidence_sha256'
          IS DISTINCT FROM btrim(authority.evidence_sha256)
     OR NEW.evidence ->> 'service_cell_availability'
          IS DISTINCT FROM authority.routing_availability THEN
    RAISE EXCEPTION 'HXUV1-ROUTE-CONTEXT-8: route context must match its exact service-cell authority'
      USING ERRCODE = 'P0001';
  END IF;

  IF ingress_action <> 'link_contact'
     AND (
       authority.effective_from > NEW.created_at
       OR (authority.expires_at IS NOT NULL AND authority.expires_at <= NEW.created_at)
       OR EXISTS (
         SELECT 1
           FROM public.universal_v1_service_cell_authorities successor
          WHERE successor.supersedes_authority_id = authority.id
       )
     ) THEN
    RAISE EXCEPTION 'HXUV1-ROUTE-CONTEXT-9: semantic routing requires the current effective service-cell chain tip'
      USING ERRCODE = 'P0001';
  END IF;

  IF authority.routing_availability = 'ACTIVE'
     AND NEW.outcome IN ('FULFILLMENT_CANDIDATE', 'ESTIMATE_REQUIRED')
     AND cardinality(blocker_codes) > 0 THEN
    RAISE EXCEPTION 'HXUV1-ROUTE-CONTEXT-10: transaction candidacy cannot retain unresolved route blockers'
      USING ERRCODE = 'P0001';
  ELSIF authority.routing_availability = 'WAITLIST'
        AND NEW.outcome <> 'WAITLIST' THEN
    RAISE EXCEPTION 'HXUV1-ROUTE-CONTEXT-11: a waitlisted service cell must remain waitlisted'
      USING ERRCODE = 'P0001';
  ELSIF authority.routing_availability = 'UNAVAILABLE'
        AND NEW.outcome <> 'MANUAL_SOURCING' THEN
    RAISE EXCEPTION 'HXUV1-ROUTE-CONTEXT-12: an unavailable service cell requires manual sourcing'
      USING ERRCODE = 'P0001';
  ELSIF authority.routing_availability <> 'ACTIVE'
        AND NEW.outcome IN ('FULFILLMENT_CANDIDATE', 'ESTIMATE_REQUIRED') THEN
    RAISE EXCEPTION 'HXUV1-ROUTE-CONTEXT-13: fulfillment and estimate candidacy require an active service cell'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS universal_v1_task_draft_route_context_guard
  ON public.task_routing_decisions;
CREATE TRIGGER universal_v1_task_draft_route_context_guard
BEFORE INSERT ON public.task_routing_decisions
FOR EACH ROW EXECUTE FUNCTION public.enforce_universal_v1_task_draft_route_context_v1();

REVOKE ALL ON TABLE public.universal_v1_service_cell_authorities FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_universal_v1_service_cell_sequence() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_universal_v1_task_draft_route_context_v1() FROM PUBLIC;

COMMENT ON TABLE public.universal_v1_service_cell_authorities IS
  'Append-only coarse route coverage authority; ACTIVE never proves provider availability or assignment.';
COMMENT ON COLUMN public.task_routing_decisions.service_cell_authority_id IS
  'Exact immutable service-cell authority used by Universal V1 intake policy 1.2; null for preserved historical policies or unresolved cells.';
