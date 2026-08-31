-- HustleXP Universal V1 privacy-safe Task Opportunities and EXPRESS_INTEREST.
--
-- This successor reuses task_applications as the canonical provider-interest
-- aggregate. It does not create a competing task_provider_interests writer.
-- A current opportunity is a read-only projection of one real, account-owned,
-- open TaskDraft and its exact immutable route, relationship origin, and
-- privacy-safe route-context scope snapshot.
--
-- Browsing and EXPRESS_INTEREST observe provider class, capability, membership,
-- and credential facts. They never decide task-specific eligibility, reserve
-- work, assign a provider, reveal address/contact/customer identity, create a
-- Task or Work Order, create any financial/payable event, or guarantee work or
-- earnings. A provider-selected service cell is a discovery filter only;
-- geography eligibility remains pending a later task-specific decision.
--
-- Actor assurance limitation: the application binds its verified authenticated
-- user to hustler_id. The shared runtime database login cannot independently
-- attest that UUID as its physical caller, so direct database invocation is not
-- promoted into eligibility, assignment, private-data, or financial authority.

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;

DO $$
BEGIN
  IF to_regclass('public.universal_v1_relationship_origins') IS NULL
     OR to_regclass('public.universal_v1_service_cell_authorities') IS NULL
     OR to_regclass('public.task_applications') IS NULL THEN
    RAISE EXCEPTION 'HXUV1-OPPORTUNITY-0: required RelationshipOrigin and Universal V1 authorities must install first'
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

CREATE OR REPLACE VIEW public.current_universal_v1_task_opportunities_v1
WITH (security_invoker = true)
AS
SELECT
  public.universal_v1_relationship_deterministic_uuid(
    'TASK_OPPORTUNITY_V1:' || route.id::TEXT || ':' || origin.id::TEXT || ':' ||
    scope_digest.scope_artifact_sha256
  ) AS opportunity_id,
  route.decision_version AS opportunity_version,
  draft.id AS task_draft_id,
  route.id AS routing_decision_id,
  route.decision_version AS routing_decision_version,
  route.policy_version AS routing_policy_version,
  origin.id AS relationship_origin_id,
  origin.origin_version AS relationship_origin_version,
  origin.origin_kind AS relationship_origin_kind,
  origin.policy_version AS relationship_origin_policy_version,
  'TASK_DRAFT_ROUTE_CONTEXT_V1'::TEXT AS scope_artifact_kind,
  route.id AS scope_artifact_id,
  route.decision_version AS scope_artifact_version,
  scope_digest.scope_artifact_sha256,
  public_scope.public_scope,
  route.category_snapshot AS work_category_code,
  route.service_cell_authority_id,
  route.service_cell_snapshot AS region_code,
  route.evidence ->> 'rough_location' AS rough_location,
  route.evidence ->> 'risk_level' AS risk_level,
  TRUE AS requires_proof,
  route.outcome AS routing_outcome,
  cell.authority_version AS service_cell_authority_version,
  cell.evidence_sha256 AS service_cell_evidence_sha256,
  draft.updated_at AS draft_observed_at,
  route.created_at AS routed_at,
  'ROUTE_CONTEXT_ALLOWLIST_ONLY'::TEXT AS privacy_posture,
  'HELD_PENDING_TASK_SPECIFIC_EVALUATION'::TEXT AS eligibility_posture,
  'NONE'::TEXT AS assignment_authority,
  'NONE'::TEXT AS address_contact_authority,
  'NONE'::TEXT AS financial_authority,
  'NONE'::TEXT AS guaranteed_earning_authority
FROM public.task_drafts draft
JOIN public.task_routing_decisions route
  ON route.id = draft.active_routing_decision_id
 AND route.task_draft_id = draft.id
JOIN public.universal_v1_service_cell_authorities cell
  ON cell.id = route.service_cell_authority_id
 AND cell.region_code = route.service_cell_snapshot
 AND cell.routing_availability = 'ACTIVE'
JOIN LATERAL (
  SELECT candidate.*
  FROM public.universal_v1_relationship_origins candidate
  WHERE candidate.task_draft_id = draft.id
  ORDER BY candidate.origin_version DESC, candidate.id DESC
  LIMIT 1
) origin ON TRUE
CROSS JOIN LATERAL (
  SELECT jsonb_build_object(
    'artifactKind', 'TASK_DRAFT_ROUTE_CONTEXT_V1',
    'artifactId', route.id,
    'artifactVersion', route.decision_version,
    'routingPolicyVersion', route.policy_version,
    'routeContextEvidence', route.evidence
  ) AS scope_artifact
) scope_artifact
CROSS JOIN LATERAL (
  SELECT encode(
    public.digest(scope_artifact.scope_artifact::TEXT, 'sha256'),
    'hex'
  ) AS scope_artifact_sha256
) scope_digest
CROSS JOIN LATERAL (
  SELECT jsonb_build_object(
    'contractVersion', 1,
    'workCategoryCode', route.category_snapshot,
    'serviceCellAuthorityId', route.service_cell_authority_id,
    'serviceCellAuthorityVersion', cell.authority_version,
    'regionCode', route.service_cell_snapshot,
    'roughLocation', route.evidence ->> 'rough_location',
    'riskLevel', route.evidence ->> 'risk_level',
    'requiresProof', TRUE,
    'finalAvailabilityConfirmationRequired', TRUE,
    'routingOutcome', route.outcome
  ) AS public_scope
) public_scope
WHERE draft.universal_contract_version = 1
  AND draft.ingress_origin = 'BACKEND_POSTGRESQL'
  AND draft.status = 'account_claimed'
  AND draft.poster_user_id IS NOT NULL
  AND draft.task_id IS NULL
  AND draft.relationship_origin_contract_version = 1
  AND draft.relationship_origin_kind = 'MARKETPLACE'
  AND draft.relationship_origin_policy_version = 1
  AND origin.origin_kind = draft.relationship_origin_kind
  AND origin.policy_version = draft.relationship_origin_policy_version
  AND origin.routing_state = 'ROUTING_READY'
  AND cardinality(origin.hold_reason_codes) = 0
  AND NOT EXISTS (
    SELECT 1
    FROM public.universal_v1_relationship_origins successor
    WHERE successor.supersedes_origin_id = origin.id
  )
  AND route.outcome IN ('FULFILLMENT_CANDIDATE', 'ESTIMATE_REQUIRED')
  AND route.policy_version = 'universal-v1-intake-1.2.0'
  AND route.category_snapshot = route.evidence ->> 'work_category_code'
  AND route.service_cell_snapshot = route.evidence ->> 'region_code'
  AND route.service_cell_authority_id::TEXT =
      route.evidence ->> 'service_cell_authority_id'
  AND route.evidence ->> 'service_cell_availability' = 'ACTIVE'
  AND route.evidence -> 'route_context_contract_version' = '1'::JSONB
  AND jsonb_typeof(route.evidence -> 'rough_location') = 'string'
  AND char_length(btrim(route.evidence ->> 'rough_location')) BETWEEN 2 AND 120
  AND route.evidence ->> 'risk_level' IN ('LOW', 'MEDIUM', 'HIGH', 'IN_HOME')
  AND route.evidence -> 'requires_proof' = 'true'::JSONB
  AND route.evidence -> 'final_availability_confirmation_required' = 'true'::JSONB
  AND cell.effective_from <= clock_timestamp()
  AND (cell.expires_at IS NULL OR cell.expires_at > clock_timestamp())
  AND NOT EXISTS (
    SELECT 1
    FROM public.universal_v1_service_cell_authorities successor
    WHERE successor.supersedes_authority_id = cell.id
  );

ALTER TABLE public.task_applications
  ALTER COLUMN task_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS task_draft_id UUID
    REFERENCES public.task_drafts(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS opportunity_contract_version SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS opportunity_id UUID,
  ADD COLUMN IF NOT EXISTS opportunity_version INTEGER,
  ADD COLUMN IF NOT EXISTS interest_routing_decision_id UUID
    REFERENCES public.task_routing_decisions(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS interest_routing_decision_version INTEGER,
  ADD COLUMN IF NOT EXISTS interest_relationship_origin_id UUID
    REFERENCES public.universal_v1_relationship_origins(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS interest_relationship_origin_version INTEGER,
  ADD COLUMN IF NOT EXISTS interest_scope_artifact_kind TEXT,
  ADD COLUMN IF NOT EXISTS interest_scope_artifact_id UUID
    REFERENCES public.task_routing_decisions(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS interest_scope_artifact_version INTEGER,
  ADD COLUMN IF NOT EXISTS interest_scope_artifact_sha256 CHAR(64),
  ADD COLUMN IF NOT EXISTS provider_class_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS provider_capability_observed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS provider_capability_sha256 CHAR(64),
  ADD COLUMN IF NOT EXISTS observed_trade_credential_id UUID
    REFERENCES public.business_credentials(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS trade_credential_observed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS trade_credential_evidence_sha256 CHAR(64),
  ADD COLUMN IF NOT EXISTS trade_qualification_sha256 CHAR(64),
  ADD COLUMN IF NOT EXISTS provider_binding_sha256 CHAR(64);

ALTER TABLE public.task_applications
  DROP CONSTRAINT IF EXISTS task_applications_interest_authority_check;
ALTER TABLE public.task_applications
  ADD CONSTRAINT task_applications_interest_authority_check CHECK (
    (
      universal_contract_version = 0
      AND authority IS NULL
      AND task_id IS NOT NULL
      AND opportunity_contract_version = 0
      AND opportunity_id IS NULL
      AND task_draft_id IS NULL
      AND interest_routing_decision_id IS NULL
      AND interest_routing_decision_version IS NULL
      AND interest_relationship_origin_id IS NULL
      AND interest_relationship_origin_version IS NULL
      AND interest_scope_artifact_kind IS NULL
      AND interest_scope_artifact_id IS NULL
      AND interest_scope_artifact_version IS NULL
      AND interest_scope_artifact_sha256 IS NULL
      AND provider_class_snapshot IS NULL
      AND provider_capability_observed_at IS NULL
      AND provider_capability_sha256 IS NULL
      AND observed_trade_credential_id IS NULL
      AND trade_credential_observed_at IS NULL
      AND trade_credential_evidence_sha256 IS NULL
      AND trade_qualification_sha256 IS NULL
      AND provider_binding_sha256 IS NULL
    )
    OR (
      universal_contract_version = 1
      AND authority = 'EXPRESS_INTEREST'
      AND status IN ('pending', 'withdrawn', 'expired', 'rejected')
      AND (
        (
          opportunity_contract_version = 0
          AND task_id IS NOT NULL
          AND interest_scope_version_id IS NOT NULL
          AND opportunity_id IS NULL
          AND task_draft_id IS NULL
          AND interest_routing_decision_id IS NULL
          AND interest_routing_decision_version IS NULL
          AND interest_relationship_origin_id IS NULL
          AND interest_relationship_origin_version IS NULL
          AND interest_scope_artifact_kind IS NULL
          AND interest_scope_artifact_id IS NULL
          AND interest_scope_artifact_version IS NULL
          AND interest_scope_artifact_sha256 IS NULL
          AND provider_class_snapshot IS NULL
          AND provider_capability_observed_at IS NULL
          AND provider_capability_sha256 IS NULL
          AND observed_trade_credential_id IS NULL
          AND trade_credential_observed_at IS NULL
          AND trade_credential_evidence_sha256 IS NULL
          AND trade_qualification_sha256 IS NULL
          AND provider_binding_sha256 IS NULL
        )
        OR (
          opportunity_contract_version = 1
          AND status = 'pending'
          AND task_id IS NULL
          AND task_draft_id IS NOT NULL
          AND interest_scope_version_id IS NULL
          AND opportunity_id IS NOT NULL
          AND opportunity_version IS NOT NULL
          AND opportunity_version > 0
          AND interest_routing_decision_id IS NOT NULL
          AND interest_routing_decision_version IS NOT NULL
          AND interest_routing_decision_version > 0
          AND interest_relationship_origin_id IS NOT NULL
          AND interest_relationship_origin_version IS NOT NULL
          AND interest_relationship_origin_version > 0
          AND interest_scope_artifact_kind = 'TASK_DRAFT_ROUTE_CONTEXT_V1'
          AND interest_scope_artifact_id = interest_routing_decision_id
          AND interest_scope_artifact_version IS NOT NULL
          AND interest_scope_artifact_version = interest_routing_decision_version
          AND interest_scope_artifact_sha256 IS NOT NULL
          AND interest_scope_artifact_sha256 ~ '^[a-f0-9]{64}$'
          AND provider_class_snapshot IN (
            'GENERAL_SERVICE_PROVIDER', 'VERIFIED_TRADE_BUSINESS'
          )
          AND provider_capability_observed_at IS NOT NULL
          AND provider_capability_sha256 IS NOT NULL
          AND provider_capability_sha256 ~ '^[a-f0-9]{64}$'
          AND provider_binding_sha256 IS NOT NULL
          AND provider_binding_sha256 ~ '^[a-f0-9]{64}$'
          AND idempotency_key IS NOT NULL
          AND idempotency_key ~ '^[A-Za-z0-9:_-]{16,96}$'
          AND request_sha256 IS NOT NULL
          AND request_sha256 ~ '^[a-f0-9]{64}$'
          AND (
            (
              provider_class_snapshot = 'GENERAL_SERVICE_PROVIDER'
              AND observed_trade_credential_id IS NULL
              AND trade_credential_observed_at IS NULL
              AND trade_credential_evidence_sha256 IS NULL
              AND trade_qualification_sha256 IS NULL
            )
            OR (
              provider_class_snapshot = 'VERIFIED_TRADE_BUSINESS'
              AND provider_organization_id IS NOT NULL
              AND observed_trade_credential_id IS NOT NULL
              AND trade_credential_observed_at IS NOT NULL
              AND trade_credential_evidence_sha256 IS NOT NULL
              AND trade_credential_evidence_sha256 ~ '^[a-f0-9]{64}$'
              AND trade_qualification_sha256 IS NOT NULL
              AND trade_qualification_sha256 ~ '^[a-f0-9]{64}$'
            )
          )
        )
      )
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS task_applications_opportunity_provider_once_v1
  ON public.task_applications(
    opportunity_id, hustler_id, provider_organization_id
  ) NULLS NOT DISTINCT
  WHERE opportunity_contract_version = 1;

CREATE INDEX IF NOT EXISTS task_applications_provider_opportunity_read_v1
  ON public.task_applications(
    hustler_id, created_at DESC, opportunity_id
  )
  WHERE opportunity_contract_version = 1;

CREATE INDEX IF NOT EXISTS task_applications_ops_opportunity_read_v1
  ON public.task_applications(
    created_at DESC, provider_class_snapshot, opportunity_id
  )
  WHERE opportunity_contract_version = 1;

CREATE OR REPLACE FUNCTION public.universal_v1_task_opportunity_interest_request_sha256(
  p_actor_user_id UUID,
  p_opportunity_id UUID,
  p_expected_opportunity_version INTEGER,
  p_provider_organization_id UUID,
  p_business_credential_id UUID,
  p_idempotency_key TEXT
)
RETURNS CHAR(64)
LANGUAGE SQL
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  SELECT encode(public.digest(concat_ws('|',
    'HX_UNIVERSAL_V1_EXPRESS_INTEREST_V1',
    p_actor_user_id::TEXT,
    p_opportunity_id::TEXT,
    p_expected_opportunity_version::TEXT,
    COALESCE(p_provider_organization_id::TEXT, ''),
    COALESCE(p_business_credential_id::TEXT, ''),
    p_idempotency_key
  ), 'sha256'), 'hex')::CHAR(64)
$$;

-- Preserve the existing post-estimate interest guard exactly, while explicitly
-- routing the new pre-task observation to its dedicated stricter trigger.
CREATE OR REPLACE FUNCTION public.enforce_universal_post_estimate_interest()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.universal_contract_version <> 1
     OR NEW.opportunity_contract_version = 1 THEN
    RETURN NEW;
  END IF;
  IF NEW.idempotency_key IS NULL OR NEW.request_sha256 IS NULL THEN
    RAISE EXCEPTION 'HXUV1-INTEREST-3: new Universal V1 interest requires an immutable request witness'
      USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.tasks task
    JOIN public.task_drafts draft ON draft.task_id = task.id
    JOIN public.task_routing_decisions routing
      ON routing.id = draft.active_routing_decision_id
    JOIN public.task_scope_versions scope
      ON scope.id = task.active_scope_version_id
    WHERE task.id = NEW.task_id
      AND task.worker_id IS NULL
      AND task.automation_classification = 'CONTROLLED_TEST'
      AND routing.outcome = 'FULFILLMENT_CANDIDATE'
      AND scope.id = NEW.interest_scope_version_id
  ) THEN
    RAISE EXCEPTION 'HXUV1-INTEREST-2: interest requires the current unassigned controlled-test task, route, and scope'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_universal_v1_task_opportunity_interest_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  opportunity public.current_universal_v1_task_opportunities_v1%ROWTYPE;
  provider public.users%ROWTYPE;
  profile public.capability_profiles%ROWTYPE;
  organization public.business_organizations%ROWTYPE;
  credential public.business_credentials%ROWTYPE;
  expected_request_sha256 CHAR(64);
  capability_snapshot JSONB;
  trade_qualification RECORD;
  trade_qualification_snapshot JSONB;
BEGIN
  IF NEW.opportunity_contract_version <> 1 THEN
    RETURN NEW;
  END IF;

  IF NEW.universal_contract_version <> 1
     OR NEW.authority <> 'EXPRESS_INTEREST'
     OR NEW.status <> 'pending'
     OR NEW.task_id IS NOT NULL
     OR NEW.interest_scope_version_id IS NOT NULL
     OR NEW.idempotency_key IS NULL
     OR NEW.request_sha256 IS NULL
     OR NEW.message IS NOT NULL
     OR NEW.rejection_reason IS NOT NULL
     OR NEW.counter_offer_round <> 0 THEN
    RAISE EXCEPTION 'HXUV1-OPPORTUNITY-1: TaskDraft interest must remain a bounded EXPRESS_INTEREST observation'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO opportunity
  FROM public.current_universal_v1_task_opportunities_v1 current_opportunity
  WHERE current_opportunity.opportunity_id = NEW.opportunity_id
    AND current_opportunity.opportunity_version = NEW.opportunity_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HXUV1-OPPORTUNITY-2: exact current open TaskDraft opportunity version is unavailable'
      USING ERRCODE = 'P0001';
  END IF;

  IF (NEW.task_draft_id IS NOT NULL
        AND NEW.task_draft_id IS DISTINCT FROM opportunity.task_draft_id)
     OR (NEW.interest_routing_decision_id IS NOT NULL
        AND NEW.interest_routing_decision_id IS DISTINCT FROM opportunity.routing_decision_id)
     OR (NEW.interest_routing_decision_version IS NOT NULL
        AND NEW.interest_routing_decision_version IS DISTINCT FROM opportunity.routing_decision_version)
     OR (NEW.interest_relationship_origin_id IS NOT NULL
        AND NEW.interest_relationship_origin_id IS DISTINCT FROM opportunity.relationship_origin_id)
     OR (NEW.interest_relationship_origin_version IS NOT NULL
        AND NEW.interest_relationship_origin_version IS DISTINCT FROM opportunity.relationship_origin_version)
     OR (NEW.interest_scope_artifact_kind IS NOT NULL
        AND NEW.interest_scope_artifact_kind IS DISTINCT FROM opportunity.scope_artifact_kind)
     OR (NEW.interest_scope_artifact_id IS NOT NULL
        AND NEW.interest_scope_artifact_id IS DISTINCT FROM opportunity.scope_artifact_id)
     OR (NEW.interest_scope_artifact_version IS NOT NULL
        AND NEW.interest_scope_artifact_version IS DISTINCT FROM opportunity.scope_artifact_version)
     OR (NEW.interest_scope_artifact_sha256 IS NOT NULL
        AND btrim(NEW.interest_scope_artifact_sha256) IS DISTINCT FROM
            btrim(opportunity.scope_artifact_sha256)) THEN
    RAISE EXCEPTION 'HXUV1-OPPORTUNITY-3: forged route, origin, or scope artifact binding'
      USING ERRCODE = 'P0001';
  END IF;

  -- Lock the mutable TaskDraft pointer, then re-read the projection. Route,
  -- origin, cell, and scope evidence are append-only facts.
  PERFORM 1
  FROM public.task_drafts draft
  WHERE draft.id = opportunity.task_draft_id
  FOR SHARE;
  SELECT * INTO opportunity
  FROM public.current_universal_v1_task_opportunities_v1 current_opportunity
  WHERE current_opportunity.opportunity_id = NEW.opportunity_id
    AND current_opportunity.opportunity_version = NEW.opportunity_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HXUV1-OPPORTUNITY-3: TaskDraft opportunity changed before interest recording'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO provider
  FROM public.users actor
  WHERE actor.id = NEW.hustler_id
  FOR SHARE;
  IF NOT FOUND
     OR provider.account_status <> 'ACTIVE'
     OR provider.is_minor IS NOT FALSE
     OR COALESCE(provider.is_banned, FALSE) IS TRUE THEN
    RAISE EXCEPTION 'HXUV1-OPPORTUNITY-4: active adult provider identity observation is required'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO profile
  FROM public.capability_profiles capability
  WHERE capability.user_id = NEW.hustler_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HXUV1-OPPORTUNITY-5: provider capability observation is unresolved'
      USING ERRCODE = 'P0001';
  END IF;

  capability_snapshot := jsonb_build_object(
    'providerClass', profile.provider_class,
    'trustTier', profile.trust_tier,
    'riskClearance', profile.risk_clearance,
    'insuranceValid', profile.insurance_valid,
    'insuranceExpiresAt', profile.insurance_expires_at,
    'backgroundCheckValid', profile.background_check_valid,
    'backgroundCheckExpiresAt', profile.background_check_expires_at,
    'locationState', profile.location_state,
    'updatedAt', profile.updated_at
  );

  IF NEW.provider_organization_id IS NULL THEN
    IF NEW.observed_trade_credential_id IS NOT NULL
       OR profile.provider_class <> 'GENERAL_SERVICE_PROVIDER' THEN
      RAISE EXCEPTION 'HXUV1-OPPORTUNITY-6: individual general-provider observation is unresolved'
        USING ERRCODE = 'P0001';
    END IF;
    NEW.provider_class_snapshot := 'GENERAL_SERVICE_PROVIDER';
    NEW.trade_credential_observed_at := NULL;
    NEW.trade_credential_evidence_sha256 := NULL;
    NEW.trade_qualification_sha256 := NULL;
  ELSE
    SELECT * INTO organization
    FROM public.business_organizations candidate
    WHERE candidate.id = NEW.provider_organization_id
    FOR SHARE;
    IF NOT FOUND
       OR organization.status <> 'ACTIVE'
       OR organization.verification_status <> 'VERIFIED'
       OR organization.provider_enabled IS NOT TRUE
       OR NOT EXISTS (
         SELECT 1
         FROM public.business_memberships membership
         WHERE membership.organization_id = organization.id
           AND membership.user_id = NEW.hustler_id
           AND membership.status = 'ACTIVE'
           AND membership.role IN ('OWNER', 'ADMIN', 'DISPATCHER', 'CREW')
       ) THEN
      RAISE EXCEPTION 'HXUV1-OPPORTUNITY-7: active provider-business membership observation is unresolved'
        USING ERRCODE = 'P0001';
    END IF;

    IF organization.provider_class = 'GENERAL_SERVICE_PROVIDER' THEN
      IF NEW.observed_trade_credential_id IS NOT NULL
         OR profile.provider_class <> 'GENERAL_SERVICE_PROVIDER' THEN
        RAISE EXCEPTION 'HXUV1-OPPORTUNITY-8: general-provider business observation is inconsistent'
          USING ERRCODE = 'P0001';
      END IF;
      NEW.provider_class_snapshot := 'GENERAL_SERVICE_PROVIDER';
      NEW.trade_credential_observed_at := NULL;
      NEW.trade_credential_evidence_sha256 := NULL;
      NEW.trade_qualification_sha256 := NULL;
    ELSIF organization.provider_class = 'VERIFIED_TRADE_BUSINESS' THEN
      IF NEW.observed_trade_credential_id IS NULL THEN
        RAISE EXCEPTION 'HXUV1-OPPORTUNITY-9: Verified Trade Business interest requires one exact credential observation'
          USING ERRCODE = 'P0001';
      END IF;
      SELECT * INTO credential
      FROM public.business_credentials candidate
      WHERE candidate.id = NEW.observed_trade_credential_id
        AND candidate.organization_id = organization.id
      FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'HXUV1-OPPORTUNITY-9: Verified Trade Business credential observation is unavailable'
          USING ERRCODE = 'P0001';
      END IF;
      IF profile.provider_class <> 'VERIFIED_TRADE_BUSINESS' THEN
        RAISE EXCEPTION 'HXUV1-OPPORTUNITY-10: Verified Trade Business capability observation is unresolved'
          USING ERRCODE = 'P0001';
      END IF;
      SELECT
        qualification.issuing_authority,
        qualification.jurisdiction_code,
        qualification.license_scope,
        qualification.license_status,
        qualification.expires_at,
        qualification.evidence_hash,
        qualification.verified_at,
        qualification.official_source_checked_at,
        permitted.category AS permitted_category
      INTO trade_qualification
        FROM public.current_verified_trade_qualifications qualification
        CROSS JOIN LATERAL unnest(qualification.permitted_work_categories)
          permitted(category)
        WHERE qualification.provider_user_id = NEW.hustler_id
          AND qualification.organization_id = organization.id
          AND qualification.business_credential_id = credential.id
          AND qualification.jurisdiction_code = opportunity.region_code
          AND lower(permitted.category) = opportunity.work_category_code
        ORDER BY permitted.category
        LIMIT 1;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'HXUV1-OPPORTUNITY-10: active credential/category/jurisdiction observation is unresolved'
          USING ERRCODE = 'P0001';
      END IF;
      trade_qualification_snapshot := jsonb_build_object(
        'credentialId', credential.id,
        'organizationId', organization.id,
        'issuingAuthority', trade_qualification.issuing_authority,
        'jurisdictionCode', trade_qualification.jurisdiction_code,
        'licenseScope', trade_qualification.license_scope,
        'licenseStatus', trade_qualification.license_status,
        'expiresAt', trade_qualification.expires_at,
        'evidenceHash', trade_qualification.evidence_hash,
        'verifiedAt', trade_qualification.verified_at,
        'officialSourceCheckedAt', trade_qualification.official_source_checked_at,
        'permittedCategory', lower(trade_qualification.permitted_category)
      );
      NEW.provider_class_snapshot := 'VERIFIED_TRADE_BUSINESS';
      NEW.trade_credential_observed_at := credential.updated_at;
      NEW.trade_credential_evidence_sha256 := credential.evidence_hash;
      NEW.trade_qualification_sha256 := encode(
        public.digest(trade_qualification_snapshot::TEXT, 'sha256'),
        'hex'
      );
    ELSE
      RAISE EXCEPTION 'HXUV1-OPPORTUNITY-11: provider-business class observation is unresolved'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  expected_request_sha256 :=
    public.universal_v1_task_opportunity_interest_request_sha256(
      NEW.hustler_id,
      NEW.opportunity_id,
      NEW.opportunity_version,
      NEW.provider_organization_id,
      NEW.observed_trade_credential_id,
      NEW.idempotency_key
    );
  IF btrim(NEW.request_sha256) IS DISTINCT FROM btrim(expected_request_sha256) THEN
    RAISE EXCEPTION 'HXUV1-OPPORTUNITY-12: EXPRESS_INTEREST request witness mismatch'
      USING ERRCODE = 'P0001';
  END IF;

  NEW.task_id := NULL;
  NEW.task_draft_id := opportunity.task_draft_id;
  NEW.interest_routing_decision_id := opportunity.routing_decision_id;
  NEW.interest_routing_decision_version := opportunity.routing_decision_version;
  NEW.interest_relationship_origin_id := opportunity.relationship_origin_id;
  NEW.interest_relationship_origin_version := opportunity.relationship_origin_version;
  NEW.interest_scope_artifact_kind := opportunity.scope_artifact_kind;
  NEW.interest_scope_artifact_id := opportunity.scope_artifact_id;
  NEW.interest_scope_artifact_version := opportunity.scope_artifact_version;
  NEW.interest_scope_artifact_sha256 := opportunity.scope_artifact_sha256;
  NEW.provider_capability_observed_at := profile.updated_at;
  NEW.provider_capability_sha256 := encode(
    public.digest(capability_snapshot::TEXT, 'sha256'),
    'hex'
  );
  NEW.provider_binding_sha256 := encode(public.digest(concat_ws('|',
    'HX_UNIVERSAL_V1_PROVIDER_BINDING_V1',
    NEW.hustler_id::TEXT,
    COALESCE(NEW.provider_organization_id::TEXT, '')
  ), 'sha256'), 'hex');
  NEW.created_at := clock_timestamp();
  NEW.updated_at := NEW.created_at;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS universal_v1_task_opportunity_interest_guard
  ON public.task_applications;
CREATE TRIGGER universal_v1_task_opportunity_interest_guard
BEFORE INSERT ON public.task_applications
FOR EACH ROW
EXECUTE FUNCTION public.enforce_universal_v1_task_opportunity_interest_v1();

CREATE OR REPLACE FUNCTION public.enforce_universal_interest_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.opportunity_contract_version = 1
     OR NEW.opportunity_contract_version = 1 THEN
    RAISE EXCEPTION 'HXUV1-OPPORTUNITY-13: TaskDraft EXPRESS_INTEREST is append-only'
      USING ERRCODE = 'P0001';
  END IF;
  IF OLD.universal_contract_version <> 1 THEN
    RETURN NEW;
  END IF;
  IF NEW.universal_contract_version <> 1
     OR OLD.task_id IS DISTINCT FROM NEW.task_id
     OR OLD.hustler_id IS DISTINCT FROM NEW.hustler_id
     OR OLD.authority IS DISTINCT FROM NEW.authority
     OR OLD.provider_organization_id IS DISTINCT FROM NEW.provider_organization_id
     OR OLD.interest_scope_version_id IS DISTINCT FROM NEW.interest_scope_version_id
     OR NOT (
       NEW.status = OLD.status
       OR (
         OLD.status = 'pending'
         AND NEW.status IN ('withdrawn', 'expired', 'rejected')
       )
     ) THEN
    RAISE EXCEPTION 'HXUV1-INTEREST-1: provider interest identity is immutable and cannot become assignment'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.prevent_universal_v1_task_opportunity_interest_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.opportunity_contract_version = 1 THEN
    RAISE EXCEPTION 'HXUV1-OPPORTUNITY-14: TaskDraft EXPRESS_INTEREST cannot be deleted'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS universal_v1_task_opportunity_interest_no_delete
  ON public.task_applications;
CREATE TRIGGER universal_v1_task_opportunity_interest_no_delete
BEFORE DELETE ON public.task_applications
FOR EACH ROW
EXECUTE FUNCTION public.prevent_universal_v1_task_opportunity_interest_delete();

CREATE OR REPLACE FUNCTION public.prevent_universal_v1_task_opportunity_interest_truncate()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.task_applications
    WHERE opportunity_contract_version = 1
  ) THEN
    RAISE EXCEPTION 'HXUV1-OPPORTUNITY-15: TaskDraft EXPRESS_INTEREST cannot be truncated'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS universal_v1_task_opportunity_interest_no_truncate
  ON public.task_applications;
CREATE TRIGGER universal_v1_task_opportunity_interest_no_truncate
BEFORE TRUNCATE ON public.task_applications
FOR EACH STATEMENT
EXECUTE FUNCTION public.prevent_universal_v1_task_opportunity_interest_truncate();

REVOKE ALL ON TABLE public.current_universal_v1_task_opportunities_v1 FROM PUBLIC;
REVOKE ALL ON FUNCTION public.universal_v1_task_opportunity_interest_request_sha256(
  UUID, UUID, INTEGER, UUID, UUID, TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_universal_post_estimate_interest()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_universal_v1_task_opportunity_interest_v1()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_universal_interest_integrity()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prevent_universal_v1_task_opportunity_interest_delete()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prevent_universal_v1_task_opportunity_interest_truncate()
  FROM PUBLIC;

COMMENT ON VIEW public.current_universal_v1_task_opportunities_v1 IS
  'Current privacy-allowlisted Marketplace TaskDraft opportunities. It exposes no customer identity, contact, exact address, free-form raw input, eligibility, assignment, financial, payable, or guaranteed-earning authority.';
COMMENT ON COLUMN public.task_applications.opportunity_contract_version IS
  'Version 1 reuses task_applications for append-only pre-task EXPRESS_INTEREST; it remains observation-only and cannot become reservation or assignment.';
COMMENT ON COLUMN public.task_applications.provider_capability_sha256 IS
  'Digest of capability facts observed at interest time; never a task-specific eligibility decision.';
COMMENT ON COLUMN public.task_applications.interest_scope_artifact_sha256 IS
  'Exact digest of the named immutable TASK_DRAFT_ROUTE_CONTEXT_V1 artifact; the public read model exposes only its privacy allowlist.';
