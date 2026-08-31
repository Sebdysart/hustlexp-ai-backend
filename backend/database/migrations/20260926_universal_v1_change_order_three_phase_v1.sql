-- Universal V1 price-and-scope change-order three-phase authority.
--
-- Phase A commits one immutable command witness and replacement scope before
-- any provider adapter can run. Phase B is fake-only provider I/O through the
-- independently committed PREPARED/REQUESTED journal. Phase C accepts only the
-- exact bridged adjustment event and materializes the amendment. This migration
-- grants no production-money, payout, deployment, or hard-assignment capability.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF to_regclass('public.hxos_fake_financial_schema_evidence_v5') IS NULL
     OR to_regclass('public.universal_v1_fake_financial_lifecycle_bridges') IS NULL
     OR to_regclass('public.universal_v1_prepared_financial_commands') IS NULL THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-3P-0: canonical engine chain and nonproduction fake financial fixtures v1-v5 must be installed first'
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS public.hxos_fake_financial_schema_evidence_v6 (
  migration_name TEXT PRIMARY KEY CHECK (
    migration_name = '20260926_universal_v1_change_order_three_phase_v1'
  ),
  migration_sql_sha256 CHAR(64) NOT NULL CHECK (
    migration_sql_sha256 ~ '^[0-9a-f]{64}$'
  ),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

DROP TRIGGER IF EXISTS hxos_fake_financial_schema_evidence_append_only_v6
  ON public.hxos_fake_financial_schema_evidence_v6;
CREATE TRIGGER hxos_fake_financial_schema_evidence_append_only_v6
BEFORE UPDATE OR DELETE ON public.hxos_fake_financial_schema_evidence_v6
FOR EACH ROW EXECUTE FUNCTION public.hxos_reject_fake_financial_mutation_v1();

DROP TRIGGER IF EXISTS hxos_fake_financial_schema_evidence_no_truncate_v6
  ON public.hxos_fake_financial_schema_evidence_v6;
CREATE TRIGGER hxos_fake_financial_schema_evidence_no_truncate_v6
BEFORE TRUNCATE ON public.hxos_fake_financial_schema_evidence_v6
FOR EACH STATEMENT EXECUTE FUNCTION public.hxos_reject_fake_financial_mutation_v1();

CREATE TABLE IF NOT EXISTS public.universal_v1_change_order_materialization_commands (
  proposal_id UUID PRIMARY KEY
    REFERENCES public.task_scope_change_proposals(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL UNIQUE CHECK (
    idempotency_key ~ '^[A-Za-z0-9:_-]{16,96}$'
  ),
  request_sha256 CHAR(64) NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  actor_user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  work_order_id UUID NOT NULL REFERENCES public.task_work_orders(id) ON DELETE RESTRICT,
  task_id UUID NOT NULL REFERENCES public.tasks(id) ON DELETE RESTRICT,
  task_draft_id UUID NOT NULL REFERENCES public.task_drafts(id) ON DELETE RESTRICT,
  eligibility_decision_id UUID NOT NULL
    REFERENCES public.task_provider_eligibility_decisions(id) ON DELETE RESTRICT,
  base_scope_version_id UUID NOT NULL
    REFERENCES public.task_scope_versions(id) ON DELETE RESTRICT,
  replacement_scope_version_id UUID NOT NULL UNIQUE
    REFERENCES public.task_scope_versions(id) ON DELETE RESTRICT,
  expected_proposal_version INTEGER NOT NULL CHECK (expected_proposal_version > 0),
  expected_scope_version INTEGER NOT NULL CHECK (expected_scope_version > 0),
  expected_amendment_version INTEGER NOT NULL CHECK (expected_amendment_version >= 0),
  expected_execution_version INTEGER NOT NULL CHECK (expected_execution_version > 0),
  expected_financial_version INTEGER NOT NULL CHECK (expected_financial_version >= 0),
  predecessor_event_id UUID NOT NULL
    REFERENCES public.task_financial_security_events(id) ON DELETE RESTRICT,
  predecessor_operation_id UUID NOT NULL,
  adjustment_operation_id UUID NOT NULL UNIQUE,
  customer_total_cents INTEGER NOT NULL CHECK (customer_total_cents > 0),
  provider_payout_cents INTEGER NOT NULL CHECK (
    provider_payout_cents > 0 AND provider_payout_cents <= customer_total_cents
  ),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  occurred_at TIMESTAMPTZ NOT NULL,
  prepared_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- Task economics remain immutable for every ordinary UPDATE. The one narrow
-- exception is Phase C of this contract: the exact approved replacement scope
-- and a successfully bridged fake ADJUST must already exist, and no amendment
-- may have consumed the witness yet. This preserves the task projection used by
-- legacy readers without turning arbitrary task DML into financial authority.
CREATE OR REPLACE FUNCTION public.enforce_task_region_policy_binding()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_policy public.region_policies%ROWTYPE;
  v_category JSONB;
  v_expected JSONB;
  v_license BOOLEAN;
  v_insurance BOOLEAN;
  v_background BOOLEAN;
  v_proof_required BOOLEAN;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (
      OLD.price IS DISTINCT FROM NEW.price
      OR OLD.hustler_payout_cents IS DISTINCT FROM NEW.hustler_payout_cents
      OR OLD.platform_margin_cents IS DISTINCT FROM NEW.platform_margin_cents
    )
    AND OLD.category IS NOT DISTINCT FROM NEW.category
    AND OLD.risk_level IS NOT DISTINCT FROM NEW.risk_level
    AND OLD.requires_proof IS NOT DISTINCT FROM NEW.requires_proof
    AND OLD.automation_classification IS NOT DISTINCT FROM NEW.automation_classification
    AND OLD.region_code IS NOT DISTINCT FROM NEW.region_code
    AND OLD.region_policy_id IS NOT DISTINCT FROM NEW.region_policy_id
    AND OLD.region_policy_version IS NOT DISTINCT FROM NEW.region_policy_version
    AND OLD.region_policy_hash IS NOT DISTINCT FROM NEW.region_policy_hash
    AND OLD.region_policy_snapshot IS NOT DISTINCT FROM NEW.region_policy_snapshot
    AND OLD.trade_type IS NOT DISTINCT FROM NEW.trade_type
    AND OLD.location_state IS NOT DISTINCT FROM NEW.location_state
    AND OLD.license_required IS NOT DISTINCT FROM NEW.license_required
    AND OLD.insurance_required IS NOT DISTINCT FROM NEW.insurance_required
    AND OLD.background_check_required IS NOT DISTINCT FROM NEW.background_check_required
    AND OLD.proof_min_photos IS NOT DISTINCT FROM NEW.proof_min_photos
    AND OLD.proof_max_photos IS NOT DISTINCT FROM NEW.proof_max_photos
    AND OLD.proof_gps_required IS NOT DISTINCT FROM NEW.proof_gps_required
    AND OLD.currency IS NOT DISTINCT FROM NEW.currency
    AND EXISTS (
      SELECT 1
      FROM public.universal_v1_change_order_materialization_commands command
      JOIN public.task_scope_change_proposals proposal
        ON proposal.id = command.proposal_id
      JOIN public.task_scope_versions replacement
        ON replacement.id = command.replacement_scope_version_id
      JOIN public.task_financial_security_events adjustment
        ON adjustment.change_order_id = command.proposal_id
       AND adjustment.operation_id = command.adjustment_operation_id::TEXT
      JOIN public.universal_v1_fake_financial_lifecycle_bridges bridge
        ON bridge.task_financial_security_event_id = adjustment.id
      WHERE command.task_id = NEW.id
        AND command.base_scope_version_id = OLD.active_scope_version_id
        AND command.replacement_scope_version_id = NEW.active_scope_version_id
        AND proposal.status = 'APPROVED'
        AND proposal.change_order_kind = 'PRICE_AND_SCOPE'
        AND proposal.approved_version_id = replacement.id
        AND replacement.task_id = NEW.id
        AND replacement.customer_total_cents = NEW.price
        AND replacement.hustler_payout_cents = NEW.hustler_payout_cents
        AND replacement.customer_total_cents - replacement.hustler_payout_cents =
          NEW.platform_margin_cents
        AND replacement.currency = upper(NEW.currency)
        AND adjustment.predecessor_event_id = command.predecessor_event_id
        AND adjustment.eligibility_decision_id = command.eligibility_decision_id
        AND adjustment.scope_version_id = replacement.id
        AND adjustment.event_kind = 'ADJUSTMENT_AUTHORIZED'
        AND adjustment.status = 'SUCCEEDED'
        AND adjustment.provider_kind = 'FAKE'
        AND adjustment.expected_version = command.expected_financial_version + 1
        AND adjustment.amount_cents = command.customer_total_cents
        AND adjustment.currency = command.currency
        AND adjustment.recorded_by = command.actor_user_id
        AND bridge.fake_operation_id = command.adjustment_operation_id
        AND bridge.fake_operation_kind = 'ADJUST'
        AND bridge.fake_provider_state = 'SUCCEEDED'
        AND bridge.lifecycle_event_kind = 'ADJUSTMENT_AUTHORIZED'
        AND bridge.lifecycle_status = 'SUCCEEDED'
        AND NOT EXISTS (
          SELECT 1
          FROM public.task_work_order_amendments amendment
          WHERE amendment.change_order_id = command.proposal_id
        )
    ) THEN
      SELECT * INTO v_policy
      FROM public.region_policies
      WHERE id = NEW.region_policy_id
      FOR SHARE;
      IF NOT FOUND
         OR v_policy.region_code <> NEW.region_code
         OR v_policy.version <> NEW.region_policy_version
         OR v_policy.policy_hash <> NEW.region_policy_hash
         OR NEW.price <
           (v_policy.policy_document#>>'{financial,minimumCustomerCents}')::INTEGER
         OR NEW.hustler_payout_cents IS NULL
         OR NEW.hustler_payout_cents <
           (v_policy.policy_document#>>'{financial,minimumPayoutCents}')::INTEGER
         OR NEW.platform_margin_cents IS NULL
         OR NEW.platform_margin_cents <
           (v_policy.policy_document#>>'{financial,minimumMarginCents}')::INTEGER
         OR upper(NEW.currency) <>
           upper(v_policy.policy_document#>>'{financial,currency}') THEN
        RAISE EXCEPTION 'HXRP13: task economics violate region policy'
          USING ERRCODE = 'P0001';
      END IF;
      RETURN NEW;
    END IF;

    IF OLD.category IS DISTINCT FROM NEW.category
       OR OLD.risk_level IS DISTINCT FROM NEW.risk_level
       OR OLD.requires_proof IS DISTINCT FROM NEW.requires_proof
       OR OLD.automation_classification IS DISTINCT FROM NEW.automation_classification
       OR OLD.price IS DISTINCT FROM NEW.price
       OR OLD.hustler_payout_cents IS DISTINCT FROM NEW.hustler_payout_cents
       OR OLD.platform_margin_cents IS DISTINCT FROM NEW.platform_margin_cents
       OR OLD.region_code IS DISTINCT FROM NEW.region_code
       OR OLD.region_policy_id IS DISTINCT FROM NEW.region_policy_id
       OR OLD.region_policy_version IS DISTINCT FROM NEW.region_policy_version
       OR OLD.region_policy_hash IS DISTINCT FROM NEW.region_policy_hash
       OR OLD.region_policy_snapshot IS DISTINCT FROM NEW.region_policy_snapshot
       OR OLD.trade_type IS DISTINCT FROM NEW.trade_type
       OR OLD.location_state IS DISTINCT FROM NEW.location_state
       OR OLD.license_required IS DISTINCT FROM NEW.license_required
       OR OLD.insurance_required IS DISTINCT FROM NEW.insurance_required
       OR OLD.background_check_required IS DISTINCT FROM NEW.background_check_required
       OR OLD.proof_min_photos IS DISTINCT FROM NEW.proof_min_photos
       OR OLD.proof_max_photos IS DISTINCT FROM NEW.proof_max_photos
       OR OLD.proof_gps_required IS DISTINCT FROM NEW.proof_gps_required
       OR OLD.currency IS DISTINCT FROM NEW.currency THEN
      RAISE EXCEPTION 'HXRP6: region policy binding is immutable'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.region_policy_id IS NULL OR NEW.region_code IS NULL
     OR NEW.region_policy_version IS NULL OR NEW.region_policy_hash IS NULL
     OR NEW.region_policy_snapshot IS NULL THEN
    RAISE EXCEPTION 'HXRP7: task requires a complete region policy binding'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_policy FROM public.region_policies
  WHERE id = NEW.region_policy_id AND policy_state = 'ACTIVE'
    AND effective_from <= clock_timestamp()
    AND (effective_until IS NULL OR effective_until > clock_timestamp())
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HXRP8: task region policy is unavailable or ineffective'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_policy.region_code <> NEW.region_code
     OR v_policy.version <> NEW.region_policy_version
     OR v_policy.policy_hash <> NEW.region_policy_hash THEN
    RAISE EXCEPTION 'HXRP9: task region policy identity mismatch'
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.automation_classification = 'PRODUCTION' AND v_policy.production_enabled = FALSE THEN
    RAISE EXCEPTION 'HXRP10: production policy is not approved'
      USING ERRCODE = 'P0001';
  END IF;

  v_category := v_policy.policy_document->'categories'->NEW.category;
  IF v_category IS NULL THEN
    RAISE EXCEPTION 'HXRP11: category is not permitted by region policy'
      USING ERRCODE = 'P0001';
  END IF;
  IF NOT ((v_category->'allowedRiskLevels') ? NEW.risk_level) THEN
    RAISE EXCEPTION 'HXRP12: risk level is not permitted by region policy'
      USING ERRCODE = 'P0001';
  END IF;

  v_license := (v_category#>>'{credentials,licenseRequired}')::BOOLEAN;
  v_insurance := (v_category#>>'{credentials,insuranceRequired}')::BOOLEAN;
  v_background := (v_category#>>'{credentials,backgroundCheckRequired}')::BOOLEAN;
  v_proof_required := (v_category#>>'{evidence,proofRequired}')::BOOLEAN;

  IF NEW.price < (v_policy.policy_document#>>'{financial,minimumCustomerCents}')::INTEGER
     OR NEW.hustler_payout_cents IS NULL
     OR NEW.hustler_payout_cents <
       (v_policy.policy_document#>>'{financial,minimumPayoutCents}')::INTEGER
     OR NEW.platform_margin_cents IS NULL
     OR NEW.platform_margin_cents <
       (v_policy.policy_document#>>'{financial,minimumMarginCents}')::INTEGER THEN
    RAISE EXCEPTION 'HXRP13: task economics violate region policy'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_proof_required AND NEW.requires_proof IS NOT TRUE THEN
    RAISE EXCEPTION 'HXRP14: completion proof is required by region policy'
      USING ERRCODE = 'P0001';
  END IF;

  v_expected := jsonb_build_object(
    'policyId', v_policy.id::text,
    'policyVersion', v_policy.version,
    'policyHash', v_policy.policy_hash,
    'regionCode', v_policy.region_code,
    'locationState', split_part(v_policy.region_code, '-', 2),
    'licenseRequired', v_license,
    'insuranceRequired', v_insurance,
    'backgroundCheckRequired', v_background,
    'proofRequired', v_proof_required,
    'proofMinPhotos', (v_category#>>'{evidence,minPhotos}')::INTEGER,
    'proofMaxPhotos', (v_category#>>'{evidence,maxPhotos}')::INTEGER,
    'proofGpsRequired', (v_category#>>'{evidence,gpsRequired}')::BOOLEAN,
    'recordingAllowed', (v_policy.policy_document#>>'{recording,allowed}')::BOOLEAN,
    'recordingStandaloneConsentRequired',
      (v_policy.policy_document#>>'{recording,standaloneConsentRequired}')::BOOLEAN,
    'screeningStandaloneConsentRequired',
      (v_policy.policy_document#>>'{workerRights,standaloneScreeningConsentRequired}')::BOOLEAN,
    'screeningReportAccessRequired',
      (v_policy.policy_document#>>'{workerRights,reportAccessRequired}')::BOOLEAN,
    'screeningDisputeAndAppealRequired',
      (v_policy.policy_document#>>'{workerRights,disputeAndAppealRequired}')::BOOLEAN,
    'screeningAdverseActionNoticeRequired',
      (v_policy.policy_document#>>'{workerRights,adverseActionNoticeRequired}')::BOOLEAN,
    'safetyIncidentIntakeRequired',
      (v_policy.policy_document#>>'{safety,incidentIntakeRequired}')::BOOLEAN,
    'safetyTimedCheckinRequired',
      (v_policy.policy_document#>'{safety,timedCheckinRiskLevels}') ? NEW.risk_level,
    'safetyCheckinIntervalsMinutes',
      v_policy.policy_document#>'{safety,checkinIntervalsMinutes}',
    'safetyLocationRetentionDays',
      (v_policy.policy_document#>>'{safety,locationRetentionDays}')::INTEGER,
    'safetyAlternateEmergencyActionRequired',
      (v_policy.policy_document#>>'{safety,alternateEmergencyActionRequired}')::BOOLEAN,
    'currency', v_policy.policy_document#>>'{financial,currency}'
  );
  IF NEW.region_policy_snapshot IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'HXRP15: region policy snapshot mismatch'
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.trade_type <> NEW.category
     OR NEW.location_state <> split_part(NEW.region_code, '-', 2)
     OR NEW.license_required <> v_license
     OR NEW.insurance_required <> v_insurance
     OR NEW.background_check_required <> v_background
     OR NEW.proof_min_photos <> (v_category#>>'{evidence,minPhotos}')::INTEGER
     OR NEW.proof_max_photos <> (v_category#>>'{evidence,maxPhotos}')::INTEGER
     OR NEW.proof_gps_required <> (v_category#>>'{evidence,gpsRequired}')::BOOLEAN
     OR NEW.currency <> v_policy.policy_document#>>'{financial,currency}' THEN
    RAISE EXCEPTION 'HXRP16: task policy projection mismatch'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.universal_v1_change_order_materialization_request_sha256(
  checked_proposal_id UUID,
  checked_idempotency_key TEXT,
  checked_actor_user_id UUID,
  checked_work_order_id UUID,
  checked_task_id UUID,
  checked_task_draft_id UUID,
  checked_eligibility_decision_id UUID,
  checked_base_scope_version_id UUID,
  checked_replacement_scope_version_id UUID,
  checked_expected_proposal_version INTEGER,
  checked_expected_scope_version INTEGER,
  checked_expected_amendment_version INTEGER,
  checked_expected_execution_version INTEGER,
  checked_expected_financial_version INTEGER,
  checked_predecessor_event_id UUID,
  checked_predecessor_operation_id UUID,
  checked_adjustment_operation_id UUID
)
RETURNS CHAR(64)
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT encode(
    digest(
      jsonb_build_object(
        'contract', 'HUSTLEXP_UNIVERSAL_V1_CHANGE_ORDER_MATERIALIZATION_V1',
        'proposalId', checked_proposal_id,
        'idempotencyKey', checked_idempotency_key,
        'actorUserId', checked_actor_user_id,
        'workOrderId', checked_work_order_id,
        'taskId', checked_task_id,
        'taskDraftId', checked_task_draft_id,
        'eligibilityDecisionId', checked_eligibility_decision_id,
        'baseScopeVersionId', checked_base_scope_version_id,
        'replacementScopeVersionId', checked_replacement_scope_version_id,
        'expectedProposalVersion', checked_expected_proposal_version,
        'expectedScopeVersion', checked_expected_scope_version,
        'expectedAmendmentVersion', checked_expected_amendment_version,
        'expectedExecutionVersion', checked_expected_execution_version,
        'expectedFinancialVersion', checked_expected_financial_version,
        'predecessorEventId', checked_predecessor_event_id,
        'predecessorOperationId', checked_predecessor_operation_id,
        'adjustmentOperationId', checked_adjustment_operation_id
      )::TEXT,
      'sha256'
    ),
    'hex'
  )::CHAR(64);
$$;

CREATE OR REPLACE FUNCTION public.enforce_universal_v1_change_order_materialization_command()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  predecessor_time TIMESTAMPTZ;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('universal-v1-change-order-proposal:' || NEW.proposal_id::TEXT, 0)
  );
  PERFORM pg_advisory_xact_lock(hashtextextended('fulfillment:' || NEW.work_order_id::TEXT, 0));

  IF NEW.request_sha256 IS DISTINCT FROM
    public.universal_v1_change_order_materialization_request_sha256(
      NEW.proposal_id,
      NEW.idempotency_key,
      NEW.actor_user_id,
      NEW.work_order_id,
      NEW.task_id,
      NEW.task_draft_id,
      NEW.eligibility_decision_id,
      NEW.base_scope_version_id,
      NEW.replacement_scope_version_id,
      NEW.expected_proposal_version,
      NEW.expected_scope_version,
      NEW.expected_amendment_version,
      NEW.expected_execution_version,
      NEW.expected_financial_version,
      NEW.predecessor_event_id,
      NEW.predecessor_operation_id,
      NEW.adjustment_operation_id
    ) THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-3P-1: materialization command digest mismatch'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT financial.occurred_at INTO predecessor_time
  FROM public.task_financial_security_events financial
  WHERE financial.id = NEW.predecessor_event_id
  FOR SHARE;
  IF predecessor_time IS NULL THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-3P-2: exact financial predecessor is unavailable'
      USING ERRCODE = 'P0001';
  END IF;
  NEW.occurred_at := GREATEST(clock_timestamp(), predecessor_time + interval '1 millisecond');
  NEW.prepared_at := clock_timestamp();

  IF NOT EXISTS (
    SELECT 1
    FROM public.task_scope_change_proposals proposal
    JOIN public.tasks task ON task.id = proposal.task_id
    JOIN public.task_drafts draft ON draft.id = NEW.task_draft_id
    JOIN public.task_work_orders work_order ON work_order.id = NEW.work_order_id
    JOIN public.task_provider_eligibility_decisions eligibility
      ON eligibility.id = NEW.eligibility_decision_id
    JOIN public.task_scope_versions base_scope ON base_scope.id = NEW.base_scope_version_id
    JOIN public.task_scope_versions replacement
      ON replacement.id = NEW.replacement_scope_version_id
    JOIN public.users actor ON actor.id = NEW.actor_user_id
    JOIN public.users provider ON provider.id = work_order.provider_user_id
    LEFT JOIN public.business_organizations customer_organization
      ON customer_organization.id = task.business_organization_id
    LEFT JOIN public.business_organizations provider_organization
      ON provider_organization.id = work_order.provider_organization_id
    JOIN public.task_scope_change_approvals customer_approval
      ON customer_approval.proposal_id = proposal.id
     AND customer_approval.approver_role = 'CUSTOMER'
     AND customer_approval.decision = 'APPROVED'
    JOIN public.task_scope_change_approvals provider_approval
      ON provider_approval.proposal_id = proposal.id
     AND provider_approval.approver_role = 'PROVIDER'
     AND provider_approval.decision = 'APPROVED'
    JOIN public.users customer_approval_actor
      ON customer_approval_actor.id = customer_approval.actor_id
    JOIN public.users provider_approval_actor
      ON provider_approval_actor.id = provider_approval.actor_id
    JOIN public.task_financial_security_events predecessor
      ON predecessor.id = NEW.predecessor_event_id
    JOIN public.task_work_order_execution_facts execution
      ON execution.work_order_id = work_order.id
     AND execution.scope_version_id = base_scope.id
     AND execution.execution_version = NEW.expected_execution_version
     AND NOT EXISTS (
       SELECT 1 FROM public.task_work_order_execution_facts newer_execution
       WHERE newer_execution.work_order_id = execution.work_order_id
         AND newer_execution.execution_version > execution.execution_version
     )
    WHERE proposal.id = NEW.proposal_id
      AND proposal.universal_contract_version = 1
      AND proposal.application_contract_version = 1
      AND proposal.status = 'APPROVED'
      AND proposal.change_order_kind = 'PRICE_AND_SCOPE'
      AND proposal.financial_adjustment_required IS TRUE
      AND proposal.proposal_version = NEW.expected_proposal_version
      AND proposal.base_version_id = base_scope.id
      AND proposal.approved_version_id = replacement.id
      AND proposal.reviewed_by = NEW.actor_user_id
      AND task.id = NEW.task_id
      AND task.work_order_id = work_order.id
      AND task.active_scope_version_id = base_scope.id
      AND task.universal_contract_version = 1
      AND task.automation_classification = 'CONTROLLED_TEST'
      AND task.universal_payment_posture = 'PAYMENT_CREATION_FROZEN'
      AND task.worker_id IS NULL
      AND draft.id = NEW.task_draft_id
      AND draft.task_id = task.id
      AND draft.universal_contract_version = 1
      AND work_order.task_id = task.id
      AND work_order.task_draft_id = draft.id
      AND work_order.eligibility_decision_id = eligibility.id
      AND work_order.execution_contract_version = 1
      AND public.universal_v1_effective_work_order_scope_id(work_order.id) = base_scope.id
      AND base_scope.version = NEW.expected_scope_version
      AND replacement.task_id = task.id
      AND replacement.version = NEW.expected_scope_version + 1
      AND replacement.supersedes_version_id = base_scope.id
      AND replacement.source = 'APPROVED_CHANGE'
      AND replacement.scope_hash = proposal.proposed_scope_sha256
      AND replacement.customer_total_cents = NEW.customer_total_cents
      AND replacement.hustler_payout_cents = NEW.provider_payout_cents
      AND replacement.currency = NEW.currency
      AND predecessor.task_draft_id = draft.id
      AND predecessor.task_id = task.id
      AND predecessor.eligibility_decision_id = eligibility.id
      AND predecessor.scope_version_id = base_scope.id
      AND predecessor.operation_id = NEW.predecessor_operation_id::TEXT
      AND predecessor.expected_version = NEW.expected_financial_version
      AND predecessor.event_kind IN ('SECURED', 'ADJUSTMENT_AUTHORIZED')
      AND predecessor.status = 'SUCCEEDED'
      AND predecessor.provider_kind = 'FAKE'
      AND NOT EXISTS (
        SELECT 1 FROM public.task_financial_security_events newer_financial
        WHERE newer_financial.task_draft_id = draft.id
          AND newer_financial.expected_version > predecessor.expected_version
      )
      AND COALESCE((
        SELECT MAX(amendment.amendment_version)
        FROM public.task_work_order_amendments amendment
        WHERE amendment.work_order_id = work_order.id
      ), 0) = NEW.expected_amendment_version
      AND execution.state IN ('MATERIALIZED','ACKNOWLEDGED','EN_ROUTE','ARRIVED','PAUSED')
      AND actor.account_status = 'ACTIVE'
      AND actor.is_minor IS FALSE
      AND COALESCE(actor.is_banned, FALSE) IS FALSE
      AND provider.account_status = 'ACTIVE'
      AND provider.is_minor IS FALSE
      AND COALESCE(provider.is_banned, FALSE) IS FALSE
      AND customer_approval_actor.account_status = 'ACTIVE'
      AND customer_approval_actor.is_minor IS FALSE
      AND COALESCE(customer_approval_actor.is_banned, FALSE) IS FALSE
      AND provider_approval_actor.account_status = 'ACTIVE'
      AND provider_approval_actor.is_minor IS FALSE
      AND COALESCE(provider_approval_actor.is_banned, FALSE) IS FALSE
      AND (
        (task.business_organization_id IS NULL AND task.poster_id = NEW.actor_user_id)
        OR (
          task.business_organization_id IS NOT NULL
          AND customer_organization.status = 'ACTIVE'
          AND customer_organization.client_enabled IS TRUE
          AND public.business_membership_has_action(
            task.business_organization_id, NEW.actor_user_id, 'APPROVE_SPEND'
          )
        )
      )
      AND (
        (task.business_organization_id IS NULL AND customer_approval.actor_id = task.poster_id)
        OR (
          task.business_organization_id IS NOT NULL
          AND customer_organization.status = 'ACTIVE'
          AND customer_organization.client_enabled IS TRUE
          AND public.business_membership_has_action(
            task.business_organization_id, customer_approval.actor_id, 'APPROVE_SPEND'
          )
        )
      )
      AND (
        provider_approval.actor_id = work_order.provider_user_id
        OR (
          work_order.provider_organization_id IS NOT NULL
          AND provider_organization.status = 'ACTIVE'
          AND provider_organization.provider_enabled IS TRUE
          AND public.business_membership_has_action(
            work_order.provider_organization_id,
            provider_approval.actor_id,
            'APPROVE_SPEND'
          )
        )
      )
      AND customer_approval.actor_id <> provider_approval.actor_id
      AND public.universal_v1_invited_provider_authority_is_current(
        eligibility.provider_user_id,
        eligibility.provider_organization_id,
        eligibility.provider_class,
        eligibility.trade_credential_id,
        task.category,
        task.region_code
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.task_completion_facts completion
        WHERE completion.work_order_id = work_order.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.task_reconciliation_facts reconciliation
        WHERE reconciliation.work_order_id = work_order.id
      )
  ) THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-3P-3: materialization command lacks exact current authority'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_universal_v1_prepared_adjustment_witness()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.operation_kind <> 'ADJUST' THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.universal_v1_change_order_materialization_commands command
    JOIN public.task_scope_change_proposals proposal ON proposal.id = command.proposal_id
    JOIN public.tasks task ON task.id = command.task_id
    JOIN public.task_work_orders work_order ON work_order.id = command.work_order_id
    JOIN public.task_provider_eligibility_decisions eligibility
      ON eligibility.id = command.eligibility_decision_id
    JOIN public.task_scope_versions base_scope
      ON base_scope.id = command.base_scope_version_id
    JOIN public.task_scope_versions replacement
      ON replacement.id = command.replacement_scope_version_id
    JOIN public.task_financial_security_events predecessor
      ON predecessor.id = command.predecessor_event_id
    JOIN public.task_work_order_execution_facts execution
      ON execution.work_order_id = work_order.id
     AND execution.scope_version_id = base_scope.id
     AND execution.execution_version = command.expected_execution_version
    JOIN public.users actor ON actor.id = NEW.recorded_by
    JOIN public.users provider ON provider.id = work_order.provider_user_id
    JOIN public.task_scope_change_approvals customer_approval
      ON customer_approval.proposal_id = proposal.id
     AND customer_approval.approver_role = 'CUSTOMER'
     AND customer_approval.decision = 'APPROVED'
    JOIN public.task_scope_change_approvals provider_approval
      ON provider_approval.proposal_id = proposal.id
     AND provider_approval.approver_role = 'PROVIDER'
     AND provider_approval.decision = 'APPROVED'
    JOIN public.users customer_approval_actor
      ON customer_approval_actor.id = customer_approval.actor_id
    JOIN public.users provider_approval_actor
      ON provider_approval_actor.id = provider_approval.actor_id
    LEFT JOIN public.business_organizations customer_organization
      ON customer_organization.id = task.business_organization_id
    LEFT JOIN public.business_organizations provider_organization
      ON provider_organization.id = work_order.provider_organization_id
    WHERE command.proposal_id = NEW.change_order_id
      AND command.idempotency_key || ':adjust' = NEW.idempotency_key
      AND command.adjustment_operation_id = NEW.operation_id
      AND command.actor_user_id = NEW.recorded_by
      AND command.task_draft_id = NEW.task_draft_id
      AND command.task_id = NEW.task_id
      AND command.eligibility_decision_id = NEW.eligibility_decision_id
      AND command.replacement_scope_version_id = NEW.scope_version_id
      AND command.predecessor_event_id = NEW.predecessor_event_id
      AND command.predecessor_operation_id = NEW.related_operation_id
      AND command.customer_total_cents = NEW.amount_cents
      AND command.currency = NEW.currency
      AND command.expected_financial_version + 1 = NEW.lifecycle_expected_version
      AND NEW.provider_kind = 'FAKE'
      AND NEW.provider_expected_version = 0
      AND proposal.status = 'APPROVED'
      AND proposal.change_order_kind = 'PRICE_AND_SCOPE'
      AND proposal.financial_adjustment_required IS TRUE
      AND proposal.proposal_version = command.expected_proposal_version
      AND proposal.base_version_id = command.base_scope_version_id
      AND proposal.approved_version_id = command.replacement_scope_version_id
      AND proposal.reviewed_by = command.actor_user_id
      AND task.work_order_id = work_order.id
      AND task.active_scope_version_id = command.base_scope_version_id
      AND task.worker_id IS NULL
      AND task.universal_contract_version = 1
      AND task.automation_classification = 'CONTROLLED_TEST'
      AND task.universal_payment_posture = 'PAYMENT_CREATION_FROZEN'
      AND public.universal_v1_effective_work_order_scope_id(work_order.id) =
        command.base_scope_version_id
      AND base_scope.version = command.expected_scope_version
      AND replacement.task_id = task.id
      AND replacement.version = command.expected_scope_version + 1
      AND replacement.supersedes_version_id = base_scope.id
      AND replacement.source = 'APPROVED_CHANGE'
      AND replacement.scope_hash = proposal.proposed_scope_sha256
      AND replacement.customer_total_cents = command.customer_total_cents
      AND replacement.hustler_payout_cents = command.provider_payout_cents
      AND replacement.currency = command.currency
      AND predecessor.task_draft_id = command.task_draft_id
      AND predecessor.task_id = command.task_id
      AND predecessor.eligibility_decision_id = command.eligibility_decision_id
      AND predecessor.scope_version_id = command.base_scope_version_id
      AND predecessor.operation_id = command.predecessor_operation_id::TEXT
      AND predecessor.expected_version = command.expected_financial_version
      AND predecessor.event_kind IN ('SECURED', 'ADJUSTMENT_AUTHORIZED')
      AND predecessor.status = 'SUCCEEDED'
      AND predecessor.provider_kind = 'FAKE'
      AND NOT EXISTS (
        SELECT 1 FROM public.task_financial_security_events newer_financial
        WHERE newer_financial.task_draft_id = command.task_draft_id
          AND newer_financial.expected_version > predecessor.expected_version
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.task_work_order_execution_facts newer_execution
        WHERE newer_execution.work_order_id = work_order.id
          AND newer_execution.execution_version > execution.execution_version
      )
      AND execution.state IN ('MATERIALIZED','ACKNOWLEDGED','EN_ROUTE','ARRIVED','PAUSED')
      AND actor.account_status = 'ACTIVE'
      AND actor.is_minor IS FALSE
      AND COALESCE(actor.is_banned, FALSE) IS FALSE
      AND provider.account_status = 'ACTIVE'
      AND provider.is_minor IS FALSE
      AND COALESCE(provider.is_banned, FALSE) IS FALSE
      AND customer_approval_actor.account_status = 'ACTIVE'
      AND customer_approval_actor.is_minor IS FALSE
      AND COALESCE(customer_approval_actor.is_banned, FALSE) IS FALSE
      AND provider_approval_actor.account_status = 'ACTIVE'
      AND provider_approval_actor.is_minor IS FALSE
      AND COALESCE(provider_approval_actor.is_banned, FALSE) IS FALSE
      AND (
        (task.business_organization_id IS NULL AND task.poster_id = NEW.recorded_by)
        OR (
          task.business_organization_id IS NOT NULL
          AND customer_organization.status = 'ACTIVE'
          AND customer_organization.client_enabled IS TRUE
          AND public.business_membership_has_action(
            task.business_organization_id, NEW.recorded_by, 'APPROVE_SPEND'
          )
        )
      )
      AND (
        (task.business_organization_id IS NULL AND customer_approval.actor_id = task.poster_id)
        OR (
          task.business_organization_id IS NOT NULL
          AND customer_organization.status = 'ACTIVE'
          AND customer_organization.client_enabled IS TRUE
          AND public.business_membership_has_action(
            task.business_organization_id, customer_approval.actor_id, 'APPROVE_SPEND'
          )
        )
      )
      AND (
        provider_approval.actor_id = work_order.provider_user_id
        OR (
          work_order.provider_organization_id IS NOT NULL
          AND provider_organization.status = 'ACTIVE'
          AND provider_organization.provider_enabled IS TRUE
          AND public.business_membership_has_action(
            work_order.provider_organization_id,
            provider_approval.actor_id,
            'APPROVE_SPEND'
          )
        )
      )
      AND customer_approval.actor_id <> provider_approval.actor_id
      AND public.universal_v1_invited_provider_authority_is_current(
        eligibility.provider_user_id,
        eligibility.provider_organization_id,
        eligibility.provider_class,
        eligibility.trade_credential_id,
        task.category,
        task.region_code
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.task_work_order_amendments amendment
        WHERE amendment.change_order_id = command.proposal_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.task_completion_facts completion
        WHERE completion.work_order_id = work_order.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.task_reconciliation_facts reconciliation
        WHERE reconciliation.work_order_id = work_order.id
      )
  ) THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-3P-4: ADJUST requires the exact committed materialization witness'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.prevent_universal_v1_change_order_materialization_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'HXUV1-CHANGE-3P-5: price amendment command evidence is append-only'
    USING ERRCODE = 'P0001';
END;
$$;

CREATE OR REPLACE FUNCTION public.prevent_execution_during_prepared_change_order()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('fulfillment:' || NEW.work_order_id::TEXT, 0));
  IF EXISTS (
    SELECT 1
    FROM public.universal_v1_change_order_materialization_commands command
    WHERE command.work_order_id = NEW.work_order_id
      AND NOT EXISTS (
        SELECT 1 FROM public.task_work_order_amendments amendment
        WHERE amendment.change_order_id = command.proposal_id
      )
  ) THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-3P-6: execution is held until the prepared amendment finalizes or compensates'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.prevent_proposal_during_prepared_change_order()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  checked_work_order_id UUID;
BEGIN
  SELECT work_order.id INTO checked_work_order_id
  FROM public.tasks task
  JOIN public.task_work_orders work_order ON work_order.id = task.work_order_id
  WHERE task.id = NEW.task_id
  FOR SHARE OF task, work_order;
  IF checked_work_order_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('fulfillment:' || checked_work_order_id::TEXT, 0)
    );
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.universal_v1_change_order_materialization_commands command
    JOIN public.task_scope_change_proposals prepared
      ON prepared.id = command.proposal_id
    WHERE prepared.task_id = NEW.task_id
      AND NOT EXISTS (
        SELECT 1 FROM public.task_work_order_amendments amendment
        WHERE amendment.change_order_id = command.proposal_id
      )
  ) THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-3P-7: a prepared amendment already owns this Work Order transition'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS universal_v1_change_order_materialization_command_guard
  ON public.universal_v1_change_order_materialization_commands;
CREATE TRIGGER universal_v1_change_order_materialization_command_guard
BEFORE INSERT ON public.universal_v1_change_order_materialization_commands
FOR EACH ROW EXECUTE FUNCTION public.enforce_universal_v1_change_order_materialization_command();

DROP TRIGGER IF EXISTS universal_v1_change_order_materialization_command_immutable
  ON public.universal_v1_change_order_materialization_commands;
CREATE TRIGGER universal_v1_change_order_materialization_command_immutable
BEFORE UPDATE OR DELETE ON public.universal_v1_change_order_materialization_commands
FOR EACH ROW EXECUTE FUNCTION public.prevent_universal_v1_change_order_materialization_mutation();

DROP TRIGGER IF EXISTS universal_v1_change_order_materialization_command_no_truncate
  ON public.universal_v1_change_order_materialization_commands;
CREATE TRIGGER universal_v1_change_order_materialization_command_no_truncate
BEFORE TRUNCATE ON public.universal_v1_change_order_materialization_commands
FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_universal_v1_change_order_materialization_mutation();

DROP TRIGGER IF EXISTS a_universal_v1_prepared_adjustment_witness
  ON public.universal_v1_prepared_financial_commands;
CREATE TRIGGER a_universal_v1_prepared_adjustment_witness
BEFORE INSERT ON public.universal_v1_prepared_financial_commands
FOR EACH ROW EXECUTE FUNCTION public.enforce_universal_v1_prepared_adjustment_witness();

DROP TRIGGER IF EXISTS a_universal_v1_prepared_change_execution_hold
  ON public.task_work_order_execution_facts;
CREATE TRIGGER a_universal_v1_prepared_change_execution_hold
BEFORE INSERT ON public.task_work_order_execution_facts
FOR EACH ROW EXECUTE FUNCTION public.prevent_execution_during_prepared_change_order();

DROP TRIGGER IF EXISTS a_universal_v1_prepared_change_proposal_hold
  ON public.task_scope_change_proposals;
CREATE TRIGGER a_universal_v1_prepared_change_proposal_hold
BEFORE INSERT ON public.task_scope_change_proposals
FOR EACH ROW EXECUTE FUNCTION public.prevent_proposal_during_prepared_change_order();

COMMENT ON TABLE public.universal_v1_change_order_materialization_commands IS
  'Append-only Phase-A command witness for fake-only Universal V1 price amendments; it is not payment, assignment, deployment, or production authority.';
COMMENT ON TABLE public.hxos_fake_financial_schema_evidence_v6 IS
  'Append-only checksum evidence for the nonproduction fake price-and-scope change-order fixture.';

REVOKE ALL ON TABLE public.hxos_fake_financial_schema_evidence_v6 FROM PUBLIC;
REVOKE ALL ON TABLE public.universal_v1_change_order_materialization_commands FROM PUBLIC;
