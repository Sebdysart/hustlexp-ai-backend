-- HustleXP Universal V1 provider-estimate invitation contract.
-- Authority: HustleXP Business and Universal V1 Charter v1.1.0.
--
-- This migration closes provider self-selection. A provider-estimate quote is
-- an empty, authority-created shell bound to one pre-existing current
-- task-specific eligibility decision. The provider can propose commercial
-- scope only after that invitation exists; the category, region, risk, proof,
-- and privacy-safe rough location remain server-owned eligibility evidence.
--
-- Schema assumption for new eligibility facts: evidence is a JSON object with
-- normalized snake_case keys work_category_code, region_code, risk_level,
-- requires_proof (a JSON boolean), and rough_location. The invitation copies
-- those values in a BEFORE INSERT trigger, so they are never provider input.
--
-- This contract creates no Task, Work Order, assignment, conditional hold,
-- escrow, Financial Security Event, payment, payout, capability, or external
-- effect. Invitation and estimate expiration is quote_versions.expires_at;
-- there is deliberately no competing quote-validity field.

CREATE TABLE IF NOT EXISTS public.task_provider_estimate_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_draft_id UUID NOT NULL
    REFERENCES public.task_drafts(id) ON DELETE RESTRICT,
  routing_decision_id UUID NOT NULL
    REFERENCES public.task_routing_decisions(id) ON DELETE RESTRICT,
  eligibility_decision_id UUID NOT NULL
    REFERENCES public.task_provider_eligibility_decisions(id) ON DELETE RESTRICT,
  quote_id UUID NOT NULL
    REFERENCES public.quotes(id) ON DELETE RESTRICT,
  quote_created_by TEXT NOT NULL CHECK (
    char_length(btrim(quote_created_by)) BETWEEN 1 AND 240
  ),
  provider_user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  provider_organization_id UUID
    REFERENCES public.business_organizations(id) ON DELETE RESTRICT,
  provider_class TEXT NOT NULL CHECK (
    provider_class IN ('GENERAL_SERVICE_PROVIDER','VERIFIED_TRADE_BUSINESS')
  ),
  trade_credential_id UUID
    REFERENCES public.business_credentials(id) ON DELETE RESTRICT,
  routing_decision_version INTEGER NOT NULL CHECK (routing_decision_version > 0),
  routing_policy_version TEXT NOT NULL CHECK (
    char_length(btrim(routing_policy_version)) BETWEEN 3 AND 128
  ),
  eligibility_decision_version INTEGER NOT NULL CHECK (
    eligibility_decision_version > 0
  ),
  eligibility_policy_version TEXT NOT NULL CHECK (
    char_length(btrim(eligibility_policy_version)) BETWEEN 3 AND 128
  ),
  eligibility_evidence_sha256 CHAR(64) NOT NULL CHECK (
    eligibility_evidence_sha256 ~ '^[a-f0-9]{64}$'
  ),
  work_category_code TEXT NOT NULL CHECK (
    work_category_code ~ '^[a-z][a-z0-9_]{1,63}$'
  ),
  region_code TEXT NOT NULL CHECK (region_code ~ '^US-[A-Z]{2}$'),
  risk_level TEXT NOT NULL CHECK (
    risk_level IN ('LOW','MEDIUM','HIGH','IN_HOME')
  ),
  requires_proof BOOLEAN NOT NULL,
  rough_location TEXT NOT NULL CHECK (
    char_length(btrim(rough_location)) BETWEEN 2 AND 120
  ),
  decision_authority TEXT NOT NULL CHECK (
    decision_authority = 'NAMED_OPERATOR'
  ),
  decided_by UUID REFERENCES public.users(id) ON DELETE RESTRICT,
  authority_policy_version TEXT NOT NULL CHECK (
    char_length(btrim(authority_policy_version)) BETWEEN 3 AND 128
  ),
  valid_until TIMESTAMPTZ NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (
    idempotency_key ~ '^[A-Za-z0-9:_-]{8,128}$'
  ),
  request_sha256 CHAR(64) NOT NULL CHECK (
    request_sha256 ~ '^[a-f0-9]{64}$'
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT task_provider_estimate_invitation_one_quote UNIQUE (quote_id),
  CONSTRAINT task_provider_estimate_invitation_one_eligibility UNIQUE (
    eligibility_decision_id
  ),
  CONSTRAINT task_provider_estimate_invitation_idempotency UNIQUE NULLS NOT DISTINCT (
    decision_authority,
    decided_by,
    idempotency_key
  ),
  CONSTRAINT task_provider_estimate_invitation_validity CHECK (
    valid_until > created_at
  ),
  CONSTRAINT task_provider_estimate_invitation_authority_shape CHECK (
    decision_authority = 'NAMED_OPERATOR' AND decided_by IS NOT NULL
  ),
  CONSTRAINT task_provider_estimate_invitation_provider_shape CHECK (
    (
      provider_class = 'GENERAL_SERVICE_PROVIDER'
      AND trade_credential_id IS NULL
    )
    OR (
      provider_class = 'VERIFIED_TRADE_BUSINESS'
      AND provider_organization_id IS NOT NULL
      AND trade_credential_id IS NOT NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS task_provider_estimate_invitation_active_lookup
  ON public.task_provider_estimate_invitations(
    task_draft_id,
    provider_user_id,
    provider_organization_id,
    valid_until
  );

CREATE OR REPLACE FUNCTION public.business_membership_has_action(
  p_organization_id UUID,
  p_user_id UUID,
  p_action TEXT
) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.business_memberships membership
     WHERE membership.organization_id = p_organization_id
       AND membership.user_id = p_user_id
       AND membership.status = 'ACTIVE'
       AND CASE membership.role
         WHEN 'OWNER' THEN p_action = ANY(ARRAY[
           'READ_WORKSPACE','MANAGE_ORGANIZATION','MANAGE_MEMBERS','MANAGE_LOCATIONS',
           'MANAGE_SERVICES','MANAGE_CREWS','CREATE_WORK_ORDER','APPROVE_SPEND',
           'VIEW_BILLING','MANAGE_BILLING','ASSIGN_CREW','SUBMIT_ESTIMATE','SUBMIT_PROOF'
         ])
         WHEN 'ADMIN' THEN p_action = ANY(ARRAY[
           'READ_WORKSPACE','MANAGE_ORGANIZATION','MANAGE_MEMBERS','MANAGE_LOCATIONS',
           'MANAGE_SERVICES','MANAGE_CREWS','CREATE_WORK_ORDER','APPROVE_SPEND',
           'VIEW_BILLING','MANAGE_BILLING','ASSIGN_CREW','SUBMIT_ESTIMATE','SUBMIT_PROOF'
         ])
         WHEN 'DISPATCHER' THEN p_action = ANY(ARRAY[
           'READ_WORKSPACE','MANAGE_LOCATIONS','MANAGE_SERVICES','MANAGE_CREWS',
           'CREATE_WORK_ORDER','ASSIGN_CREW','SUBMIT_PROOF'
         ])
         WHEN 'APPROVER' THEN p_action = ANY(ARRAY['READ_WORKSPACE','APPROVE_SPEND','VIEW_BILLING'])
         WHEN 'REQUESTER' THEN p_action = ANY(ARRAY['READ_WORKSPACE','CREATE_WORK_ORDER'])
         WHEN 'VIEWER' THEN p_action = ANY(ARRAY['READ_WORKSPACE','VIEW_BILLING'])
         WHEN 'CREW' THEN p_action = ANY(ARRAY['READ_WORKSPACE','SUBMIT_PROOF'])
         ELSE FALSE
       END
  );
$$;

CREATE OR REPLACE FUNCTION public.lock_universal_v1_estimate_authority(
  p_task_draft_id UUID,
  p_provider_user_id UUID,
  p_provider_organization_id UUID,
  p_trade_credential_id UUID,
  p_actor_user_id UUID
) RETURNS VOID
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'eligibility:' || p_task_draft_id::text || ':' || p_provider_user_id::text || ':' ||
    COALESCE(p_provider_organization_id::text, 'individual'), 0
  ));

  PERFORM 1 FROM public.users WHERE id = p_actor_user_id FOR SHARE;
  PERFORM 1 FROM public.admin_roles WHERE user_id = p_actor_user_id FOR SHARE;
  PERFORM 1 FROM public.users WHERE id = p_provider_user_id FOR SHARE;
  PERFORM 1 FROM public.capability_profiles
    WHERE user_id = p_provider_user_id ORDER BY user_id FOR SHARE;
  PERFORM 1 FROM public.business_organizations
    WHERE id = p_provider_organization_id FOR SHARE;
  PERFORM 1 FROM public.business_memberships
    WHERE organization_id = p_provider_organization_id
      AND user_id IN (p_actor_user_id, p_provider_user_id)
    ORDER BY user_id, id FOR SHARE;
  PERFORM 1 FROM public.business_credentials
    WHERE id = p_trade_credential_id FOR SHARE;
  PERFORM 1 FROM public.verified_trades
    WHERE user_id = p_provider_user_id
      AND provider_organization_id IS NOT DISTINCT FROM p_provider_organization_id
      AND business_credential_id IS NOT DISTINCT FROM p_trade_credential_id
    ORDER BY user_id, trade FOR SHARE;
END;
$$;

CREATE OR REPLACE FUNCTION public.universal_v1_invited_provider_authority_is_current(
  checked_provider_user_id UUID,
  checked_provider_organization_id UUID,
  checked_provider_class TEXT,
  checked_trade_credential_id UUID,
  checked_work_category_code TEXT,
  checked_region_code TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.users provider
    WHERE provider.id = checked_provider_user_id
      AND provider.account_status = 'ACTIVE'
      AND provider.is_minor IS FALSE
      AND COALESCE(provider.is_banned, FALSE) IS FALSE
  ) AND CASE
    WHEN checked_provider_class = 'GENERAL_SERVICE_PROVIDER' THEN
      checked_trade_credential_id IS NULL
      AND EXISTS (
        SELECT 1
        FROM public.capability_profiles profile
        WHERE profile.user_id = checked_provider_user_id
          AND profile.provider_class = 'GENERAL_SERVICE_PROVIDER'
      )
      AND (
        checked_provider_organization_id IS NULL
        OR EXISTS (
          SELECT 1
          FROM public.business_organizations organization
          JOIN public.business_memberships membership
            ON membership.organization_id = organization.id
          WHERE organization.id = checked_provider_organization_id
            AND organization.provider_class = 'GENERAL_SERVICE_PROVIDER'
            AND organization.status = 'ACTIVE'
            AND organization.verification_status = 'VERIFIED'
            AND organization.provider_enabled IS TRUE
            AND membership.user_id = checked_provider_user_id
            AND membership.status = 'ACTIVE'
            AND membership.role IN ('OWNER','ADMIN','DISPATCHER','CREW')
        )
      )
    WHEN checked_provider_class = 'VERIFIED_TRADE_BUSINESS' THEN
      checked_provider_organization_id IS NOT NULL
      AND checked_trade_credential_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM public.current_verified_trade_qualifications qualification
        CROSS JOIN LATERAL unnest(qualification.permitted_work_categories)
          permitted(category)
        WHERE qualification.business_credential_id = checked_trade_credential_id
          AND qualification.provider_user_id = checked_provider_user_id
          AND qualification.organization_id = checked_provider_organization_id
          AND qualification.jurisdiction_code = checked_region_code
          AND lower(permitted.category) = checked_work_category_code
      )
    ELSE FALSE
  END;
$$;

CREATE OR REPLACE FUNCTION public.materialize_universal_v1_provider_estimate_invitation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  eligibility public.task_provider_eligibility_decisions%ROWTYPE;
  routing public.task_routing_decisions%ROWTYPE;
  draft public.task_drafts%ROWTYPE;
  quote_shell public.quotes%ROWTYPE;
  evidence_work_category TEXT;
  evidence_region TEXT;
  evidence_risk TEXT;
  evidence_rough_location TEXT;
  evidence_requires_proof BOOLEAN;
BEGIN
  IF NEW.decision_authority <> 'NAMED_OPERATOR' OR NEW.decided_by IS NULL THEN
    RAISE EXCEPTION 'HXUV1-INVITE-10: invitation authority requires one named operator; deterministic policy issuance is disabled'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO eligibility
  FROM public.task_provider_eligibility_decisions
  WHERE id = NEW.eligibility_decision_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HXUV1-INVITE-1: provider estimate invitation requires a pre-existing exact eligibility fact'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM public.lock_universal_v1_estimate_authority(
    eligibility.task_draft_id,
    eligibility.provider_user_id,
    eligibility.provider_organization_id,
    eligibility.trade_credential_id,
    NEW.decided_by
  );

  SELECT * INTO eligibility
  FROM public.task_provider_eligibility_decisions
  WHERE id = NEW.eligibility_decision_id
  FOR SHARE;

  SELECT * INTO routing
  FROM public.task_routing_decisions
  WHERE id = eligibility.routing_decision_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HXUV1-INVITE-2: invitation eligibility lacks its exact routing fact'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO draft
  FROM public.task_drafts
  WHERE id = eligibility.task_draft_id
  FOR SHARE;
  IF NOT FOUND
     OR draft.universal_contract_version <> 1
     OR draft.active_routing_decision_id IS DISTINCT FROM routing.id
     OR routing.task_draft_id IS DISTINCT FROM draft.id
     OR routing.outcome <> 'ESTIMATE_REQUIRED' THEN
    RAISE EXCEPTION 'HXUV1-INVITE-3: invitation requires the exact active ESTIMATE_REQUIRED TaskDraft route'
      USING ERRCODE = 'P0001';
  END IF;

  IF eligibility.task_eligible IS NOT TRUE
     OR eligibility.valid_until <= clock_timestamp()
     OR eligibility.evaluated_at > clock_timestamp()
     OR EXISTS (
       SELECT 1
       FROM public.task_provider_eligibility_decisions newer
       WHERE newer.task_draft_id = eligibility.task_draft_id
         AND newer.provider_user_id IS NOT DISTINCT FROM eligibility.provider_user_id
         AND newer.provider_organization_id IS NOT DISTINCT FROM eligibility.provider_organization_id
         AND newer.decision_version > eligibility.decision_version
     ) THEN
    RAISE EXCEPTION 'HXUV1-INVITE-4: invitation requires current unexpired task-specific provider eligibility'
      USING ERRCODE = 'P0001';
  END IF;

  IF jsonb_typeof(eligibility.evidence) <> 'object'
     OR jsonb_typeof(eligibility.evidence -> 'work_category_code') <> 'string'
     OR jsonb_typeof(eligibility.evidence -> 'region_code') <> 'string'
     OR jsonb_typeof(eligibility.evidence -> 'risk_level') <> 'string'
     OR jsonb_typeof(eligibility.evidence -> 'requires_proof') <> 'boolean'
     OR jsonb_typeof(eligibility.evidence -> 'rough_location') <> 'string' THEN
    RAISE EXCEPTION 'HXUV1-INVITE-5: eligibility evidence lacks the server-authoritative estimate invitation snapshot'
      USING ERRCODE = 'P0001';
  END IF;

  evidence_work_category := eligibility.evidence ->> 'work_category_code';
  evidence_region := eligibility.evidence ->> 'region_code';
  evidence_risk := eligibility.evidence ->> 'risk_level';
  evidence_requires_proof := (eligibility.evidence ->> 'requires_proof')::BOOLEAN;
  evidence_rough_location := eligibility.evidence ->> 'rough_location';

  IF evidence_work_category !~ '^[a-z][a-z0-9_]{1,63}$'
     OR routing.category_snapshot IS DISTINCT FROM evidence_work_category
     OR evidence_region !~ '^US-[A-Z]{2}$'
     OR evidence_risk NOT IN ('LOW','MEDIUM','HIGH','IN_HOME')
     OR char_length(btrim(evidence_rough_location)) NOT BETWEEN 2 AND 120 THEN
    RAISE EXCEPTION 'HXUV1-INVITE-6: eligibility evidence is not normalized or does not match the exact route category'
      USING ERRCODE = 'P0001';
  END IF;

  NEW.task_draft_id := eligibility.task_draft_id;
  NEW.routing_decision_id := eligibility.routing_decision_id;
  NEW.provider_user_id := eligibility.provider_user_id;
  NEW.provider_organization_id := eligibility.provider_organization_id;
  NEW.provider_class := eligibility.provider_class;
  NEW.trade_credential_id := eligibility.trade_credential_id;
  NEW.routing_decision_version := routing.decision_version;
  NEW.routing_policy_version := routing.policy_version;
  NEW.eligibility_decision_version := eligibility.decision_version;
  NEW.eligibility_policy_version := eligibility.policy_version;
  NEW.eligibility_evidence_sha256 := encode(
    digest(eligibility.evidence::text, 'sha256'),
    'hex'
  );
  NEW.work_category_code := evidence_work_category;
  NEW.region_code := evidence_region;
  NEW.risk_level := evidence_risk;
  NEW.requires_proof := evidence_requires_proof;
  NEW.rough_location := evidence_rough_location;
  NEW.created_at := clock_timestamp();

  IF NEW.valid_until <= NEW.created_at
     OR NEW.valid_until > eligibility.valid_until THEN
    RAISE EXCEPTION 'HXUV1-INVITE-7: invitation validity must be positive and cannot outlive provider eligibility'
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.users operator_user
      JOIN public.admin_roles operator_role ON operator_role.user_id = operator_user.id
     WHERE operator_user.id = NEW.decided_by
       AND operator_user.account_status = 'ACTIVE'
       AND operator_user.is_minor IS FALSE
       AND COALESCE(operator_user.is_banned, FALSE) IS FALSE
       AND operator_role.can_manage_operations IS TRUE
  ) THEN
    RAISE EXCEPTION 'HXUV1-INVITE-8: named invitation authority requires an active adult non-banned scoped operator identity'
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.decided_by IS NOT DISTINCT FROM eligibility.provider_user_id
       OR (
         eligibility.provider_organization_id IS NOT NULL
         AND EXISTS (
           SELECT 1
           FROM public.business_memberships provider_membership
           WHERE provider_membership.organization_id = eligibility.provider_organization_id
             AND provider_membership.user_id = NEW.decided_by
             AND provider_membership.status = 'ACTIVE'
         )
       ) THEN
    RAISE EXCEPTION 'HXUV1-INVITE-9: a provider cannot select itself through named operator authority'
      USING ERRCODE = 'P0001';
  END IF;

  IF 'CREDENTIALED_TRADE_REVIEW_REQUIRED' = ANY(routing.reason_codes)
     AND eligibility.provider_class <> 'VERIFIED_TRADE_BUSINESS' THEN
    RAISE EXCEPTION 'HXUV1-INVITE-11: credentialed trade routes require an exact Verified Trade Business eligibility fact'
      USING ERRCODE = 'P0001';
  END IF;

  IF public.universal_v1_invited_provider_authority_is_current(
    eligibility.provider_user_id,
    eligibility.provider_organization_id,
    eligibility.provider_class,
    eligibility.trade_credential_id,
    evidence_work_category,
    evidence_region
  ) IS NOT TRUE THEN
    RAISE EXCEPTION 'HXUV1-INVITE-12: current provider class, organization, credential, category, or jurisdiction authority is absent'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO quote_shell
  FROM public.quotes
  WHERE id = NEW.quote_id
  FOR UPDATE;
  IF NOT FOUND
     OR quote_shell.task_draft_id IS DISTINCT FROM draft.id
     OR quote_shell.task_id IS NOT NULL
     OR quote_shell.quote_kind <> 'PROVIDER_ESTIMATE'
     OR quote_shell.provider_user_id IS DISTINCT FROM eligibility.provider_user_id
     OR quote_shell.provider_organization_id IS DISTINCT FROM eligibility.provider_organization_id
     OR quote_shell.routing_decision_id IS DISTINCT FROM routing.id
     OR quote_shell.status <> 'draft'
     OR quote_shell.active_version_id IS NOT NULL
     OR quote_shell.negotiation_status <> 'none'
     OR quote_shell.locked_at IS NOT NULL
     OR quote_shell.lost_reason IS NOT NULL
     OR quote_shell.created_by IS NULL
     OR char_length(btrim(quote_shell.created_by)) NOT BETWEEN 1 AND 240
     OR EXISTS (
       SELECT 1 FROM public.quote_versions version
       WHERE version.quote_id = quote_shell.id
     ) THEN
    RAISE EXCEPTION 'HXUV1-INVITE-13: invitation must bind one exact empty PROVIDER_ESTIMATE quote shell'
      USING ERRCODE = 'P0001';
  END IF;

  IF eligibility.evaluated_at > quote_shell.created_at
     OR quote_shell.created_at > NEW.created_at THEN
    RAISE EXCEPTION 'HXUV1-INVITE-14: eligibility must pre-exist the quote shell and invitation fact'
      USING ERRCODE = 'P0001';
  END IF;

  NEW.quote_created_by := quote_shell.created_by;
  NEW.request_sha256 := encode(digest(jsonb_build_object(
    'contractVersion', 1,
    'taskDraftId', NEW.task_draft_id,
    'routingDecisionId', NEW.routing_decision_id,
    'eligibilityDecisionId', NEW.eligibility_decision_id,
    'quoteId', NEW.quote_id,
    'quoteCreatedBy', NEW.quote_created_by,
    'providerUserId', NEW.provider_user_id,
    'providerOrganizationId', NEW.provider_organization_id,
    'providerClass', NEW.provider_class,
    'tradeCredentialId', NEW.trade_credential_id,
    'workCategoryCode', NEW.work_category_code,
    'regionCode', NEW.region_code,
    'riskLevel', NEW.risk_level,
    'requiresProof', NEW.requires_proof,
    'roughLocation', NEW.rough_location,
    'decisionAuthority', NEW.decision_authority,
    'decidedBy', NEW.decided_by,
    'authorityPolicyVersion', NEW.authority_policy_version,
    'validUntilEpochMicros', (extract(epoch FROM NEW.valid_until) * 1000000)::BIGINT,
    'idempotencyKey', NEW.idempotency_key
  )::text, 'sha256'), 'hex');

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS universal_provider_estimate_invitation_materialize
  ON public.task_provider_estimate_invitations;
CREATE TRIGGER universal_provider_estimate_invitation_materialize
BEFORE INSERT ON public.task_provider_estimate_invitations
FOR EACH ROW EXECUTE FUNCTION public.materialize_universal_v1_provider_estimate_invitation();

CREATE OR REPLACE FUNCTION public.enforce_provider_estimate_quote_invitation_presence()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.quote_kind = 'PROVIDER_ESTIMATE'
     AND NOT EXISTS (
       SELECT 1
       FROM public.task_provider_estimate_invitations invitation
       WHERE invitation.quote_id = NEW.id
         AND invitation.task_draft_id = NEW.task_draft_id
         AND invitation.routing_decision_id = NEW.routing_decision_id
         AND invitation.provider_user_id = NEW.provider_user_id
         AND invitation.provider_organization_id IS NOT DISTINCT FROM NEW.provider_organization_id
         AND invitation.quote_created_by = NEW.created_by
     ) THEN
    RAISE EXCEPTION 'HXUV1-INVITE-15: a PROVIDER_ESTIMATE quote shell requires its exact immutable invitation'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS provider_estimate_quote_invitation_on_insert ON public.quotes;
CREATE CONSTRAINT TRIGGER provider_estimate_quote_invitation_on_insert
AFTER INSERT ON public.quotes
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.enforce_provider_estimate_quote_invitation_presence();

DROP TRIGGER IF EXISTS provider_estimate_quote_invitation_on_identity_update
  ON public.quotes;
CREATE CONSTRAINT TRIGGER provider_estimate_quote_invitation_on_identity_update
AFTER UPDATE OF task_draft_id, quote_kind, provider_user_id,
  provider_organization_id, routing_decision_id, created_by ON public.quotes
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.enforce_provider_estimate_quote_invitation_presence();

CREATE OR REPLACE FUNCTION public.freeze_invited_provider_estimate_quote_identity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.task_provider_estimate_invitations invitation
    WHERE invitation.quote_id = OLD.id
  ) AND (
    NEW.id IS DISTINCT FROM OLD.id
    OR NEW.task_draft_id IS DISTINCT FROM OLD.task_draft_id
    OR NEW.quote_kind IS DISTINCT FROM OLD.quote_kind
    OR NEW.provider_user_id IS DISTINCT FROM OLD.provider_user_id
    OR NEW.provider_organization_id IS DISTINCT FROM OLD.provider_organization_id
    OR NEW.routing_decision_id IS DISTINCT FROM OLD.routing_decision_id
    OR NEW.created_by IS DISTINCT FROM OLD.created_by
  ) THEN
    RAISE EXCEPTION 'HXUV1-INVITE-16: issued provider-estimate quote identity and invitation binding are immutable'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS invited_provider_estimate_quote_identity_immutable
  ON public.quotes;
CREATE TRIGGER invited_provider_estimate_quote_identity_immutable
BEFORE UPDATE ON public.quotes
FOR EACH ROW EXECUTE FUNCTION public.freeze_invited_provider_estimate_quote_identity();

CREATE OR REPLACE FUNCTION public.enforce_invited_provider_estimate_submission()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  invitation public.task_provider_estimate_invitations%ROWTYPE;
BEGIN
  SELECT * INTO invitation
  FROM public.task_provider_estimate_invitations
  WHERE quote_id = NEW.quote_id;
  IF FOUND THEN
    PERFORM public.lock_universal_v1_estimate_authority(
      invitation.task_draft_id,
      invitation.provider_user_id,
      invitation.provider_organization_id,
      invitation.trade_credential_id,
      NEW.submitted_by
    );
    SELECT * INTO invitation
      FROM public.task_provider_estimate_invitations
     WHERE quote_id = NEW.quote_id
     FOR SHARE;
  END IF;
  IF NOT FOUND
     OR invitation.routing_decision_id IS DISTINCT FROM NEW.routing_decision_id
     OR invitation.provider_user_id IS DISTINCT FROM NEW.provider_user_id
     OR invitation.provider_organization_id IS DISTINCT FROM NEW.provider_organization_id
     OR invitation.work_category_code IS DISTINCT FROM NEW.work_category_code
     OR invitation.valid_until <= clock_timestamp()
     OR NEW.created_at < invitation.created_at
     OR NEW.created_at >= invitation.valid_until
     OR EXISTS (
       SELECT 1
       FROM public.task_provider_eligibility_decisions newer
       WHERE newer.task_draft_id = invitation.task_draft_id
         AND newer.provider_user_id IS NOT DISTINCT FROM invitation.provider_user_id
         AND newer.provider_organization_id IS NOT DISTINCT FROM invitation.provider_organization_id
         AND newer.decision_version > invitation.eligibility_decision_version
     ) THEN
    RAISE EXCEPTION 'HXUV1-INVITE-17: provider estimate submission requires its current exact unexpired invitation'
      USING ERRCODE = 'P0001';
  END IF;

  IF (
    invitation.provider_organization_id IS NULL
    AND NEW.submitted_by IS DISTINCT FROM invitation.provider_user_id
  ) OR (
    invitation.provider_organization_id IS NOT NULL
    AND public.business_membership_has_action(
      invitation.provider_organization_id,
      NEW.submitted_by,
      'SUBMIT_ESTIMATE'
    ) IS NOT TRUE
  ) THEN
    RAISE EXCEPTION 'HXUV1-INVITE-22: estimate pricing submission requires the individual provider or an owner/admin with SUBMIT_ESTIMATE authority'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.scope_snapshot ->> 'work_category_code' IS DISTINCT FROM invitation.work_category_code
     OR NEW.scope_snapshot ->> 'region_code' IS DISTINCT FROM invitation.region_code
     OR NEW.scope_snapshot ->> 'risk_level' IS DISTINCT FROM invitation.risk_level
     OR jsonb_typeof(NEW.scope_snapshot -> 'requires_proof') <> 'boolean'
     OR (NEW.scope_snapshot ->> 'requires_proof')::BOOLEAN IS DISTINCT FROM invitation.requires_proof
     OR NEW.scope_snapshot ->> 'rough_location' IS DISTINCT FROM invitation.rough_location THEN
    RAISE EXCEPTION 'HXUV1-INVITE-18: provider input cannot replace server-authoritative category, region, risk, proof, or rough location'
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.quote_versions version
    WHERE version.id = NEW.quote_version_id
      AND version.quote_id = NEW.quote_id
      AND version.expires_at = invitation.valid_until
      AND version.expires_at > clock_timestamp()
  ) THEN
    RAISE EXCEPTION 'HXUV1-INVITE-19: provider estimate version expiration must equal its invitation validity'
      USING ERRCODE = 'P0001';
  END IF;

  IF public.universal_v1_invited_provider_authority_is_current(
    invitation.provider_user_id,
    invitation.provider_organization_id,
    invitation.provider_class,
    invitation.trade_credential_id,
    invitation.work_category_code,
    invitation.region_code
  ) IS NOT TRUE THEN
    RAISE EXCEPTION 'HXUV1-INVITE-20: provider authority is no longer current for this exact estimate'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS universal_provider_estimate_invitation_guard
  ON public.provider_estimate_submissions;
CREATE TRIGGER universal_provider_estimate_invitation_guard
BEFORE INSERT ON public.provider_estimate_submissions
FOR EACH ROW EXECUTE FUNCTION public.enforce_invited_provider_estimate_submission();

CREATE OR REPLACE FUNCTION public.enforce_current_invitation_on_estimate_acceptance()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  invitation public.task_provider_estimate_invitations%ROWTYPE;
BEGIN
  SELECT invite.* INTO invitation
  FROM public.task_provider_estimate_invitations invite
  JOIN public.provider_estimate_submissions estimate
    ON estimate.id = NEW.provider_estimate_submission_id
   AND estimate.quote_id = invite.quote_id
  JOIN public.quote_versions version
    ON version.id = estimate.quote_version_id
   AND version.quote_id = invite.quote_id
  WHERE invite.quote_id = NEW.quote_id
    AND invite.task_draft_id = NEW.task_draft_id
    AND invite.routing_decision_id = NEW.prior_routing_decision_id
    AND version.expires_at = invite.valid_until;

  IF NOT FOUND
     OR invitation.valid_until <= clock_timestamp()
     OR EXISTS (
       SELECT 1
       FROM public.task_provider_eligibility_decisions newer
       WHERE newer.task_draft_id = invitation.task_draft_id
         AND newer.provider_user_id IS NOT DISTINCT FROM invitation.provider_user_id
         AND newer.provider_organization_id IS NOT DISTINCT FROM invitation.provider_organization_id
         AND newer.decision_version > invitation.eligibility_decision_version
     )
     OR public.universal_v1_invited_provider_authority_is_current(
       invitation.provider_user_id,
       invitation.provider_organization_id,
       invitation.provider_class,
       invitation.trade_credential_id,
       invitation.work_category_code,
       invitation.region_code
     ) IS NOT TRUE THEN
    RAISE EXCEPTION 'HXUV1-INVITE-21: estimate acceptance requires an unexpired invitation and current exact provider authority'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS task_estimate_acceptance_current_invitation_guard
  ON public.task_estimate_acceptance_materializations;
CREATE TRIGGER task_estimate_acceptance_current_invitation_guard
BEFORE INSERT ON public.task_estimate_acceptance_materializations
FOR EACH ROW EXECUTE FUNCTION public.enforce_current_invitation_on_estimate_acceptance();

DROP TRIGGER IF EXISTS task_provider_estimate_invitations_immutable
  ON public.task_provider_estimate_invitations;
CREATE TRIGGER task_provider_estimate_invitations_immutable
BEFORE UPDATE OR DELETE ON public.task_provider_estimate_invitations
FOR EACH ROW EXECUTE FUNCTION public.prevent_universal_v1_fact_mutation();

DROP TRIGGER IF EXISTS task_provider_estimate_invitations_no_truncate
  ON public.task_provider_estimate_invitations;
CREATE TRIGGER task_provider_estimate_invitations_no_truncate
BEFORE TRUNCATE ON public.task_provider_estimate_invitations
FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_universal_v1_fact_mutation();

REVOKE ALL ON TABLE public.task_provider_estimate_invitations FROM PUBLIC;
REVOKE ALL ON FUNCTION public.universal_v1_invited_provider_authority_is_current(
  UUID, UUID, TEXT, UUID, TEXT, TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.business_membership_has_action(UUID, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lock_universal_v1_estimate_authority(
  UUID, UUID, UUID, UUID, UUID
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.materialize_universal_v1_provider_estimate_invitation() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_provider_estimate_quote_invitation_presence() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.freeze_invited_provider_estimate_quote_identity() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_invited_provider_estimate_submission() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_current_invitation_on_estimate_acceptance() FROM PUBLIC;

COMMENT ON TABLE public.task_provider_estimate_invitations IS
  'Append-only, payment-free authority invitation binding one exact eligible provider to one empty PROVIDER_ESTIMATE quote shell; expiration creates no assignment or financial effect.';
COMMENT ON COLUMN public.task_provider_estimate_invitations.eligibility_evidence_sha256 IS
  'Digest of the immutable eligibility evidence from which all server-owned routing and privacy-safe task snapshots were copied.';
COMMENT ON COLUMN public.task_provider_estimate_invitations.valid_until IS
  'Natural invitation expiry; every Universal V1 provider-estimate quote version must use this same quote_versions.expires_at instant.';
