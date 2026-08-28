-- Universal V1 change-order application authority.
--
-- This migration does not create an assignment or a production money effect.
-- It makes proposal, independent decision, fake adjustment authorization, and
-- immutable Work Order amendment four distinct facts bound to one exact scope.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE public.task_scope_change_proposals
  ADD COLUMN IF NOT EXISTS application_contract_version SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS proposed_title TEXT,
  ADD COLUMN IF NOT EXISTS proposed_description TEXT,
  ADD COLUMN IF NOT EXISTS proposed_requirements TEXT,
  ADD COLUMN IF NOT EXISTS proposed_provider_payout_cents INTEGER,
  ADD COLUMN IF NOT EXISTS proposed_scope_sha256 CHAR(64),
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS request_sha256 CHAR(64);

ALTER TABLE public.task_scope_change_approvals
  ADD COLUMN IF NOT EXISTS request_sha256 CHAR(64);

ALTER TABLE public.task_work_order_amendments
  ADD COLUMN IF NOT EXISTS request_sha256 CHAR(64),
  ADD COLUMN IF NOT EXISTS expected_financial_version INTEGER;

-- An unresolved pre-application proposal cannot be interpreted as a complete
-- application command. Hold the upgrade rather than inventing missing facts.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.task_scope_change_proposals
    WHERE universal_contract_version = 1
      AND application_contract_version = 0
      AND status = 'PENDING'
  ) THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-APP-1: unresolved pre-application Universal V1 proposal requires explicit reconciliation'
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.universal_v1_change_scope_sha256(
  checked_title TEXT,
  checked_description TEXT,
  checked_requirements TEXT,
  checked_checklist JSONB,
  checked_customer_total_cents INTEGER,
  checked_provider_payout_cents INTEGER,
  checked_currency CHAR(3)
)
RETURNS CHAR(64)
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT encode(
    digest(
      jsonb_build_object(
        'contract', 'HUSTLEXP_UNIVERSAL_V1_SCOPE_V1',
        'title', checked_title,
        'description', checked_description,
        'requirements', checked_requirements,
        'checklist', checked_checklist,
        'customerTotalCents', checked_customer_total_cents,
        'providerPayoutCents', checked_provider_payout_cents,
        'currency', checked_currency
      )::text,
      'sha256'
    ),
    'hex'
  )::CHAR(64);
$$;

CREATE OR REPLACE FUNCTION public.universal_v1_change_proposal_request_sha256(
  checked_task_id UUID,
  checked_base_version_id UUID,
  checked_proposed_by UUID,
  checked_proposer_role TEXT,
  checked_proposal_version INTEGER,
  checked_supersedes_proposal_id UUID,
  checked_change_order_kind TEXT,
  checked_observed_scope_summary TEXT,
  checked_proposed_scope_sha256 CHAR(64),
  checked_idempotency_key TEXT
)
RETURNS CHAR(64)
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT encode(
    digest(
      jsonb_build_object(
        'contract', 'HUSTLEXP_UNIVERSAL_V1_CHANGE_ORDER_PROPOSAL_V1',
        'taskId', checked_task_id,
        'baseScopeVersionId', checked_base_version_id,
        'proposedBy', checked_proposed_by,
        'proposerRole', checked_proposer_role,
        'proposalVersion', checked_proposal_version,
        'supersedesProposalId', checked_supersedes_proposal_id,
        'changeOrderKind', checked_change_order_kind,
        'changeSummary', checked_observed_scope_summary,
        'proposedScopeSha256', checked_proposed_scope_sha256,
        'idempotencyKey', checked_idempotency_key
      )::text,
      'sha256'
    ),
    'hex'
  )::CHAR(64);
$$;

CREATE OR REPLACE FUNCTION public.universal_v1_change_decision_request_sha256(
  checked_proposal_id UUID,
  checked_expected_proposal_version INTEGER,
  checked_approver_role TEXT,
  checked_decision TEXT,
  checked_actor_id UUID,
  checked_reason TEXT,
  checked_idempotency_key TEXT
)
RETURNS CHAR(64)
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT encode(
    digest(
      jsonb_build_object(
        'contract', 'HUSTLEXP_UNIVERSAL_V1_CHANGE_ORDER_DECISION_V1',
        'proposalId', checked_proposal_id,
        'expectedProposalVersion', checked_expected_proposal_version,
        'approverRole', checked_approver_role,
        'decision', checked_decision,
        'actorId', checked_actor_id,
        'reason', checked_reason,
        'idempotencyKey', checked_idempotency_key
      )::text,
      'sha256'
    ),
    'hex'
  )::CHAR(64);
$$;

CREATE OR REPLACE FUNCTION public.universal_v1_change_amendment_request_sha256(
  checked_work_order_id UUID,
  checked_amendment_version INTEGER,
  checked_supersedes_amendment_id UUID,
  checked_change_order_id UUID,
  checked_scope_version_id UUID,
  checked_adjustment_event_id UUID,
  checked_expected_financial_version INTEGER,
  checked_materialized_by UUID,
  checked_idempotency_key TEXT
)
RETURNS CHAR(64)
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT encode(
    digest(
      jsonb_build_object(
        'contract', 'HUSTLEXP_UNIVERSAL_V1_WORK_ORDER_AMENDMENT_V1',
        'workOrderId', checked_work_order_id,
        'amendmentVersion', checked_amendment_version,
        'supersedesAmendmentId', checked_supersedes_amendment_id,
        'changeOrderId', checked_change_order_id,
        'scopeVersionId', checked_scope_version_id,
        'adjustmentEventId', checked_adjustment_event_id,
        'expectedFinancialVersion', checked_expected_financial_version,
        'materializedBy', checked_materialized_by,
        'idempotencyKey', checked_idempotency_key
      )::text,
      'sha256'
    ),
    'hex'
  )::CHAR(64);
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'task_scope_change_application_contract_check'
      AND conrelid = 'public.task_scope_change_proposals'::regclass
  ) THEN
    ALTER TABLE public.task_scope_change_proposals
      ADD CONSTRAINT task_scope_change_application_contract_check CHECK (
        application_contract_version IN (0, 1)
        AND (
          application_contract_version = 0
          OR (
            universal_contract_version = 1
            AND change_order_kind IN ('SCOPE_ONLY', 'PRICE_AND_SCOPE')
            AND schedule_effect IS NULL
            AND proposed_title IS NOT NULL
            AND char_length(proposed_title) BETWEEN 3 AND 200
            AND proposed_description IS NOT NULL
            AND char_length(proposed_description) BETWEEN 10 AND 5000
            AND (
              proposed_requirements IS NULL
              OR char_length(proposed_requirements) BETWEEN 3 AND 5000
            )
            AND proposed_scope_sha256 ~ '^[a-f0-9]{64}$'
            AND idempotency_key ~ '^[A-Za-z0-9:_-]{8,128}$'
            AND request_sha256 ~ '^[a-f0-9]{64}$'
            AND (
              (
                change_order_kind = 'SCOPE_ONLY'
                AND proposed_customer_total_cents IS NULL
                AND proposed_provider_payout_cents IS NULL
                AND financial_adjustment_required IS FALSE
              )
              OR (
                change_order_kind = 'PRICE_AND_SCOPE'
                AND proposed_customer_total_cents > 0
                AND proposed_provider_payout_cents > 0
                AND proposed_provider_payout_cents <= proposed_customer_total_cents
                AND financial_adjustment_required IS TRUE
              )
            )
          )
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'task_scope_change_approval_request_hash_check'
      AND conrelid = 'public.task_scope_change_approvals'::regclass
  ) THEN
    ALTER TABLE public.task_scope_change_approvals
      ADD CONSTRAINT task_scope_change_approval_request_hash_check CHECK (
        request_sha256 IS NULL OR request_sha256 ~ '^[a-f0-9]{64}$'
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'task_work_order_amendment_request_hash_check'
      AND conrelid = 'public.task_work_order_amendments'::regclass
  ) THEN
    ALTER TABLE public.task_work_order_amendments
      ADD CONSTRAINT task_work_order_amendment_request_hash_check CHECK (
        request_sha256 IS NULL OR request_sha256 ~ '^[a-f0-9]{64}$'
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'task_work_order_amendment_expected_financial_version_check'
      AND conrelid = 'public.task_work_order_amendments'::regclass
  ) THEN
    ALTER TABLE public.task_work_order_amendments
      ADD CONSTRAINT task_work_order_amendment_expected_financial_version_check CHECK (
        expected_financial_version IS NULL OR expected_financial_version >= 0
      );
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS task_scope_change_proposal_version_unique_v1
  ON public.task_scope_change_proposals(task_id, proposal_version)
  WHERE universal_contract_version = 1;

CREATE UNIQUE INDEX IF NOT EXISTS task_scope_change_proposal_predecessor_unique_v1
  ON public.task_scope_change_proposals(supersedes_proposal_id)
  WHERE universal_contract_version = 1 AND supersedes_proposal_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS task_scope_change_proposal_idempotency_unique_v1
  ON public.task_scope_change_proposals(idempotency_key)
  WHERE application_contract_version = 1;

CREATE OR REPLACE FUNCTION public.enforce_universal_change_order_proposal()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  task_record public.tasks%ROWTYPE;
  predecessor public.task_scope_change_proposals%ROWTYPE;
  base_scope public.task_scope_versions%ROWTYPE;
  work_order public.task_work_orders%ROWTYPE;
  eligibility public.task_provider_eligibility_decisions%ROWTYPE;
  calculated_scope_sha256 CHAR(64);
BEGIN
  SELECT * INTO task_record
  FROM public.tasks
  WHERE id = NEW.task_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-APP-2: proposal task is unavailable'
      USING ERRCODE = 'P0001';
  END IF;

  IF task_record.universal_contract_version = 1
     AND (
       NEW.universal_contract_version <> 1
       OR NEW.application_contract_version <> 1
     ) THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-APP-3: Universal V1 tasks require the exact change-order application contract'
      USING ERRCODE = 'P0001';
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.universal_contract_version = 1
     AND (
       NEW.universal_contract_version <> 1
       OR NEW.application_contract_version IS DISTINCT FROM OLD.application_contract_version
     ) THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-15: Universal V1 change-order authority cannot be downgraded or reclassified'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.universal_contract_version <> 1 THEN
    RETURN NEW;
  END IF;

  IF NEW.application_contract_version <> 1 THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-APP-4: new Universal V1 proposals require application contract version 1'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO base_scope
  FROM public.task_scope_versions
  WHERE id = NEW.base_version_id
  FOR SHARE;

  IF NOT FOUND
     OR base_scope.task_id <> NEW.task_id
     OR base_scope.universal_contract_version <> 1
     OR task_record.active_scope_version_id <> NEW.base_version_id THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-9: change order must start from the exact active Universal V1 scope'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.change_order_kind = 'SCHEDULE_AND_SCOPE'
     OR NEW.schedule_effect IS NOT NULL THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-APP-5: schedule changes require a future structured schedule contract'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.proposed_title IS DISTINCT FROM btrim(NEW.proposed_title)
     OR NEW.proposed_description IS DISTINCT FROM btrim(NEW.proposed_description)
     OR (
       NEW.proposed_requirements IS NOT NULL
       AND NEW.proposed_requirements IS DISTINCT FROM btrim(NEW.proposed_requirements)
     )
     OR NEW.observed_scope_summary IS DISTINCT FROM btrim(NEW.observed_scope_summary)
     OR jsonb_array_length(NEW.proposed_checklist) NOT BETWEEN 1 AND 50
     OR EXISTS (
       SELECT 1
       FROM jsonb_array_elements(NEW.proposed_checklist) checklist_item
       WHERE jsonb_typeof(checklist_item) <> 'string'
          OR char_length(btrim(checklist_item #>> '{}')) NOT BETWEEN 1 AND 500
     ) THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-APP-6: proposed scope text and checklist must be normalized and bounded'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.change_order_kind = 'PRICE_AND_SCOPE'
     AND NEW.proposed_customer_total_cents = base_scope.customer_total_cents THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-APP-7: price-and-scope proposal must change the customer total'
      USING ERRCODE = 'P0001';
  END IF;

  calculated_scope_sha256 := public.universal_v1_change_scope_sha256(
    NEW.proposed_title,
    NEW.proposed_description,
    NEW.proposed_requirements,
    NEW.proposed_checklist,
    COALESCE(NEW.proposed_customer_total_cents, base_scope.customer_total_cents),
    COALESCE(NEW.proposed_provider_payout_cents, base_scope.hustler_payout_cents),
    base_scope.currency
  );

  IF NEW.proposed_scope_sha256 IS DISTINCT FROM calculated_scope_sha256
     OR NEW.proposed_scope_sha256 = base_scope.scope_hash THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-APP-8: proposed scope digest is invalid or unchanged'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.request_sha256 IS DISTINCT FROM public.universal_v1_change_proposal_request_sha256(
    NEW.task_id,
    NEW.base_version_id,
    NEW.proposed_by,
    NEW.proposer_role,
    NEW.proposal_version,
    NEW.supersedes_proposal_id,
    NEW.change_order_kind,
    NEW.observed_scope_summary,
    NEW.proposed_scope_sha256,
    NEW.idempotency_key
  ) THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-APP-9: proposal request digest mismatch'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO work_order
  FROM public.task_work_orders
  WHERE task_id = NEW.task_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-APP-10: change order requires an existing Work Order'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO eligibility
  FROM public.task_provider_eligibility_decisions
  WHERE id = work_order.eligibility_decision_id
  FOR SHARE;

  IF NOT FOUND
     OR public.universal_v1_invited_provider_authority_is_current(
       work_order.provider_user_id,
       work_order.provider_organization_id,
       eligibility.provider_class,
       eligibility.trade_credential_id,
       task_record.category,
       task_record.region_code
     ) IS NOT TRUE
     OR (
       work_order.provider_organization_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
         FROM public.business_organizations organization
         WHERE organization.id = work_order.provider_organization_id
           AND organization.status = 'ACTIVE'
           AND organization.provider_enabled IS TRUE
       )
     ) THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-APP-11: current provider authority is required'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.proposer_role = 'POSTER' THEN
    IF (
      task_record.business_organization_id IS NULL
      AND NEW.proposed_by <> task_record.poster_id
    ) OR (
      task_record.business_organization_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.business_organizations organization
        WHERE organization.id = task_record.business_organization_id
          AND organization.status = 'ACTIVE'
          AND organization.client_enabled IS TRUE
          AND public.business_membership_has_action(
            organization.id,
            NEW.proposed_by,
            'CREATE_WORK_ORDER'
          )
      )
    ) THEN
      RAISE EXCEPTION 'HXUV1-CHANGE-APP-12: customer proposal authority is absent'
        USING ERRCODE = 'P0001';
    END IF;
  ELSIF NEW.proposer_role = 'HUSTLER' THEN
    IF NEW.proposed_by <> work_order.provider_user_id
       AND (
         work_order.provider_organization_id IS NULL
         OR public.business_membership_has_action(
           work_order.provider_organization_id,
           NEW.proposed_by,
           'CREATE_WORK_ORDER'
         ) IS NOT TRUE
       ) THEN
      RAISE EXCEPTION 'HXUV1-CHANGE-APP-13: provider proposal authority is absent'
        USING ERRCODE = 'P0001';
    END IF;
  ELSE
    RAISE EXCEPTION 'HXUV1-CHANGE-APP-14: unsupported proposer role'
      USING ERRCODE = 'P0001';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PENDING'
       OR NEW.reviewed_by IS NOT NULL
       OR NEW.reviewed_at IS NOT NULL
       OR NEW.decision_reason IS NOT NULL
       OR NEW.approved_version_id IS NOT NULL THEN
      RAISE EXCEPTION 'HXUV1-CHANGE-10: new change order must begin as an undecided pending proposal'
        USING ERRCODE = 'P0001';
    END IF;

    SELECT * INTO predecessor
    FROM public.task_scope_change_proposals
    WHERE task_id = NEW.task_id
      AND universal_contract_version = 1
    ORDER BY proposal_version DESC
    LIMIT 1
    FOR SHARE;

    IF NOT FOUND THEN
      IF NEW.proposal_version <> 1 OR NEW.supersedes_proposal_id IS NOT NULL THEN
        RAISE EXCEPTION 'HXUV1-CHANGE-APP-15: first proposal must begin the exact version chain'
          USING ERRCODE = 'P0001';
      END IF;
    ELSIF predecessor.status NOT IN ('APPROVED', 'REJECTED', 'CANCELED')
       OR NEW.proposal_version <> predecessor.proposal_version + 1
       OR NEW.supersedes_proposal_id <> predecessor.id THEN
      RAISE EXCEPTION 'HXUV1-CHANGE-11: change-order proposals must extend the latest terminal task chain'
        USING ERRCODE = 'P0001';
    END IF;

    RETURN NEW;
  END IF;

  IF OLD.application_contract_version <> 1
     OR OLD.status <> 'PENDING'
     OR NEW.status NOT IN ('APPROVED', 'REJECTED')
     OR OLD.task_id IS DISTINCT FROM NEW.task_id
     OR OLD.base_version_id IS DISTINCT FROM NEW.base_version_id
     OR OLD.proposed_by IS DISTINCT FROM NEW.proposed_by
     OR OLD.proposer_role IS DISTINCT FROM NEW.proposer_role
     OR OLD.observed_scope_summary IS DISTINCT FROM NEW.observed_scope_summary
     OR OLD.proposed_checklist IS DISTINCT FROM NEW.proposed_checklist
     OR OLD.proposal_version IS DISTINCT FROM NEW.proposal_version
     OR OLD.supersedes_proposal_id IS DISTINCT FROM NEW.supersedes_proposal_id
     OR OLD.change_order_kind IS DISTINCT FROM NEW.change_order_kind
     OR OLD.proposed_customer_total_cents IS DISTINCT FROM NEW.proposed_customer_total_cents
     OR OLD.schedule_effect IS DISTINCT FROM NEW.schedule_effect
     OR OLD.financial_adjustment_required IS DISTINCT FROM NEW.financial_adjustment_required
     OR OLD.proposed_title IS DISTINCT FROM NEW.proposed_title
     OR OLD.proposed_description IS DISTINCT FROM NEW.proposed_description
     OR OLD.proposed_requirements IS DISTINCT FROM NEW.proposed_requirements
     OR OLD.proposed_provider_payout_cents IS DISTINCT FROM NEW.proposed_provider_payout_cents
     OR OLD.proposed_scope_sha256 IS DISTINCT FROM NEW.proposed_scope_sha256
     OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key
     OR OLD.request_sha256 IS DISTINCT FROM NEW.request_sha256
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-12: change-order identity and proposal facts are immutable'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.reviewed_by IS NULL
     OR NEW.reviewed_at IS NULL
     OR NEW.decision_reason IS NULL
     OR NEW.decision_reason IS DISTINCT FROM btrim(NEW.decision_reason)
     OR char_length(NEW.decision_reason) NOT BETWEEN 3 AND 1000 THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-APP-16: terminal proposal requires an exact named review fact'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.status = 'REJECTED' THEN
    IF NEW.approved_version_id IS NOT NULL
       OR NOT EXISTS (
         SELECT 1
         FROM public.task_scope_change_approvals approval
         WHERE approval.proposal_id = NEW.id
           AND approval.decision = 'REJECTED'
           AND approval.actor_id = NEW.reviewed_by
           AND approval.reason = NEW.decision_reason
       ) THEN
      RAISE EXCEPTION 'HXUV1-CHANGE-APP-17: rejection must bind the exact immutable rejecting decision'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  IF (
    task_record.business_organization_id IS NULL
    AND NEW.reviewed_by <> task_record.poster_id
  ) OR (
    task_record.business_organization_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.business_organizations organization
      WHERE organization.id = task_record.business_organization_id
        AND organization.status = 'ACTIVE'
        AND organization.client_enabled IS TRUE
        AND public.business_membership_has_action(
          organization.id,
          NEW.reviewed_by,
          'APPROVE_SPEND'
        )
    )
  ) THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-APP-18: finalization requires current customer approval authority'
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.task_scope_change_approvals customer_approval
    JOIN public.task_scope_change_approvals provider_approval
      ON provider_approval.proposal_id = customer_approval.proposal_id
     AND provider_approval.approver_role = 'PROVIDER'
     AND provider_approval.decision = 'APPROVED'
    JOIN public.task_scope_versions approved_scope
      ON approved_scope.id = NEW.approved_version_id
    WHERE customer_approval.proposal_id = NEW.id
      AND customer_approval.approver_role = 'CUSTOMER'
      AND customer_approval.decision = 'APPROVED'
      AND customer_approval.actor_id <> provider_approval.actor_id
      AND approved_scope.task_id = NEW.task_id
      AND approved_scope.universal_contract_version = 1
      AND approved_scope.source = 'APPROVED_CHANGE'
      AND approved_scope.version = base_scope.version + 1
      AND approved_scope.supersedes_version_id = NEW.base_version_id
      AND approved_scope.scope_hash = NEW.proposed_scope_sha256
      AND approved_scope.title = NEW.proposed_title
      AND approved_scope.description = NEW.proposed_description
      AND approved_scope.requirements IS NOT DISTINCT FROM NEW.proposed_requirements
      AND approved_scope.checklist = NEW.proposed_checklist
      AND approved_scope.customer_total_cents = COALESCE(
        NEW.proposed_customer_total_cents,
        base_scope.customer_total_cents
      )
      AND approved_scope.hustler_payout_cents = COALESCE(
        NEW.proposed_provider_payout_cents,
        base_scope.hustler_payout_cents
      )
      AND approved_scope.currency = base_scope.currency
      AND approved_scope.change_summary = NEW.observed_scope_summary
      AND approved_scope.created_by = NEW.reviewed_by
  ) THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-13: approval requires independent parties and the exact immutable replacement scope'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_universal_change_order_approval()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  proposal public.task_scope_change_proposals%ROWTYPE;
  task_record public.tasks%ROWTYPE;
  work_order public.task_work_orders%ROWTYPE;
  eligibility public.task_provider_eligibility_decisions%ROWTYPE;
BEGIN
  SELECT * INTO proposal
  FROM public.task_scope_change_proposals
  WHERE id = NEW.proposal_id
  FOR SHARE;

  IF NOT FOUND
     OR proposal.universal_contract_version <> 1
     OR proposal.application_contract_version <> 1
     OR proposal.status <> 'PENDING'
     OR proposal.proposal_version <> NEW.expected_proposal_version THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-1: change-order decision must bind the exact current pending proposal version'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO task_record
  FROM public.tasks
  WHERE id = proposal.task_id
  FOR SHARE;

  SELECT * INTO work_order
  FROM public.task_work_orders
  WHERE task_id = proposal.task_id
  FOR SHARE;

  IF task_record.id IS NULL
     OR task_record.active_scope_version_id <> proposal.base_version_id
     OR work_order.id IS NULL THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-APP-19: decision requires the exact current Work Order scope'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.reason IS DISTINCT FROM btrim(NEW.reason)
     OR NEW.request_sha256 IS DISTINCT FROM public.universal_v1_change_decision_request_sha256(
       NEW.proposal_id,
       NEW.expected_proposal_version,
       NEW.approver_role,
       NEW.decision,
       NEW.actor_id,
       NEW.reason,
       NEW.idempotency_key
     ) THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-APP-20: decision request digest mismatch'
      USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.task_scope_change_approvals other_approval
    WHERE other_approval.proposal_id = NEW.proposal_id
      AND other_approval.approver_role <> NEW.approver_role
      AND other_approval.actor_id = NEW.actor_id
  ) THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-APP-21: customer and provider approvals require independent principals'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.approver_role = 'CUSTOMER' THEN
    IF (
      task_record.business_organization_id IS NULL
      AND NEW.actor_id <> task_record.poster_id
    ) OR (
      task_record.business_organization_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.business_organizations organization
        WHERE organization.id = task_record.business_organization_id
          AND organization.status = 'ACTIVE'
          AND organization.client_enabled IS TRUE
          AND public.business_membership_has_action(
            organization.id,
            NEW.actor_id,
            'APPROVE_SPEND'
          )
      )
    ) THEN
      RAISE EXCEPTION 'HXUV1-CHANGE-2: customer change-order decision requires current customer approval authority'
        USING ERRCODE = 'P0001';
    END IF;
  ELSIF NEW.approver_role = 'PROVIDER' THEN
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
         work_order.provider_organization_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1
           FROM public.business_organizations organization
           WHERE organization.id = work_order.provider_organization_id
             AND organization.status = 'ACTIVE'
             AND organization.provider_enabled IS TRUE
         )
       )
       OR (
         NEW.actor_id <> work_order.provider_user_id
         AND (
           work_order.provider_organization_id IS NULL
           OR public.business_membership_has_action(
             work_order.provider_organization_id,
             NEW.actor_id,
             'APPROVE_SPEND'
           ) IS NOT TRUE
         )
       ) THEN
      RAISE EXCEPTION 'HXUV1-CHANGE-3: provider change-order decision requires current approval authority'
        USING ERRCODE = 'P0001';
    END IF;
  ELSE
    RAISE EXCEPTION 'HXUV1-CHANGE-APP-22: unsupported approver role'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_universal_work_order_amendment()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  work_order public.task_work_orders%ROWTYPE;
  task_record public.tasks%ROWTYPE;
  proposal public.task_scope_change_proposals%ROWTYPE;
  new_scope public.task_scope_versions%ROWTYPE;
  previous_scope public.task_scope_versions%ROWTYPE;
  predecessor public.task_work_order_amendments%ROWTYPE;
  adjustment public.task_financial_security_events%ROWTYPE;
  current_financial_version INTEGER;
BEGIN
  SELECT * INTO work_order
  FROM public.task_work_orders
  WHERE id = NEW.work_order_id
  FOR SHARE;

  SELECT * INTO proposal
  FROM public.task_scope_change_proposals
  WHERE id = NEW.change_order_id
  FOR SHARE;

  SELECT * INTO new_scope
  FROM public.task_scope_versions
  WHERE id = NEW.scope_version_id
  FOR SHARE;

  SELECT * INTO task_record
  FROM public.tasks
  WHERE id = work_order.task_id
  FOR SHARE;

  IF work_order.id IS NULL
     OR proposal.id IS NULL
     OR new_scope.id IS NULL
     OR task_record.id IS NULL
     OR proposal.universal_contract_version <> 1
     OR proposal.application_contract_version <> 1
     OR proposal.status <> 'APPROVED'
     OR proposal.approved_version_id <> NEW.scope_version_id
     OR proposal.reviewed_by <> NEW.materialized_by
     OR NEW.expected_financial_version IS NULL
     OR new_scope.task_id <> work_order.task_id
     OR new_scope.universal_contract_version <> 1
     OR new_scope.source <> 'APPROVED_CHANGE'
     OR task_record.active_scope_version_id <> NEW.scope_version_id THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-4: Work Order amendment requires dual approval and the exact active scope'
      USING ERRCODE = 'P0001';
  END IF;

  IF (
    task_record.business_organization_id IS NULL
    AND NEW.materialized_by <> task_record.poster_id
  ) OR (
    task_record.business_organization_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.business_organizations organization
      WHERE organization.id = task_record.business_organization_id
        AND organization.status = 'ACTIVE'
        AND organization.client_enabled IS TRUE
        AND public.business_membership_has_action(
          organization.id,
          NEW.materialized_by,
          'APPROVE_SPEND'
        )
    )
  ) THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-APP-23: amendment materialization requires current customer approval authority'
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.task_scope_change_approvals customer_approval
    JOIN public.task_scope_change_approvals provider_approval
      ON provider_approval.proposal_id = customer_approval.proposal_id
     AND provider_approval.approver_role = 'PROVIDER'
     AND provider_approval.decision = 'APPROVED'
    WHERE customer_approval.proposal_id = proposal.id
      AND customer_approval.approver_role = 'CUSTOMER'
      AND customer_approval.decision = 'APPROVED'
      AND customer_approval.actor_id <> provider_approval.actor_id
  ) THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-APP-24: amendment requires independent customer and provider approvals'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.amendment_version = 1 THEN
    IF NEW.supersedes_amendment_id IS NOT NULL THEN
      RAISE EXCEPTION 'HXUV1-CHANGE-5: first amendment cannot have a predecessor'
        USING ERRCODE = 'P0001';
    END IF;
    SELECT * INTO previous_scope
    FROM public.task_scope_versions
    WHERE id = work_order.scope_version_id
    FOR SHARE;
  ELSE
    SELECT * INTO predecessor
    FROM public.task_work_order_amendments
    WHERE id = NEW.supersedes_amendment_id
    FOR SHARE;
    IF NOT FOUND
       OR predecessor.work_order_id <> NEW.work_order_id
       OR predecessor.amendment_version <> NEW.amendment_version - 1 THEN
      RAISE EXCEPTION 'HXUV1-CHANGE-5: Work Order amendments must form one exact scope chain'
        USING ERRCODE = 'P0001';
    END IF;
    SELECT * INTO previous_scope
    FROM public.task_scope_versions
    WHERE id = predecessor.scope_version_id
    FOR SHARE;
  END IF;

  IF previous_scope.id IS NULL
     OR proposal.task_id <> work_order.task_id
     OR proposal.base_version_id <> previous_scope.id
     OR new_scope.supersedes_version_id <> previous_scope.id
     OR new_scope.version <> previous_scope.version + 1 THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-14: amendment must advance the exact prior Work Order scope by one version'
      USING ERRCODE = 'P0001';
  END IF;

  IF new_scope.scope_hash <> proposal.proposed_scope_sha256
     OR new_scope.title <> proposal.proposed_title
     OR new_scope.description <> proposal.proposed_description
     OR new_scope.requirements IS DISTINCT FROM proposal.proposed_requirements
     OR new_scope.checklist <> proposal.proposed_checklist
     OR new_scope.customer_total_cents <> COALESCE(
       proposal.proposed_customer_total_cents,
       previous_scope.customer_total_cents
     )
     OR new_scope.hustler_payout_cents <> COALESCE(
       proposal.proposed_provider_payout_cents,
       previous_scope.hustler_payout_cents
     )
     OR new_scope.currency <> previous_scope.currency
     OR new_scope.change_summary <> proposal.observed_scope_summary
     OR new_scope.created_by <> NEW.materialized_by THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-APP-25: amendment scope differs from the approved proposal'
      USING ERRCODE = 'P0001';
  END IF;

  IF task_record.scope_hash <> new_scope.scope_hash
     OR task_record.title <> new_scope.title
     OR task_record.description <> new_scope.description
     OR task_record.requirements IS DISTINCT FROM new_scope.requirements
     OR task_record.price <> new_scope.customer_total_cents
     OR task_record.hustler_payout_cents <> new_scope.hustler_payout_cents
     OR task_record.platform_margin_cents <>
       new_scope.customer_total_cents - new_scope.hustler_payout_cents
     OR upper(task_record.currency) <> new_scope.currency THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-APP-26: task projection must match the exact approved scope and economics'
      USING ERRCODE = 'P0001';
  END IF;

  IF proposal.financial_adjustment_required IS FALSE THEN
    SELECT MAX(financial.expected_version) INTO current_financial_version
    FROM public.task_financial_security_events financial
    WHERE financial.task_id = work_order.task_id;

    IF NEW.adjustment_event_id IS NOT NULL
       OR current_financial_version IS DISTINCT FROM NEW.expected_financial_version
       OR new_scope.customer_total_cents <> previous_scope.customer_total_cents
       OR new_scope.hustler_payout_cents <> previous_scope.hustler_payout_cents
       OR new_scope.currency <> previous_scope.currency THEN
      RAISE EXCEPTION 'HXUV1-CHANGE-6: scope-only amendment cannot change financial authority'
        USING ERRCODE = 'P0001';
    END IF;
  ELSE
    SELECT * INTO adjustment
    FROM public.task_financial_security_events
    WHERE id = NEW.adjustment_event_id
    FOR SHARE;
    IF NOT FOUND
       OR adjustment.event_kind <> 'ADJUSTMENT_AUTHORIZED'
       OR adjustment.status <> 'SUCCEEDED'
       OR adjustment.provider_kind <> 'FAKE'
       OR adjustment.task_draft_id <> work_order.task_draft_id
       OR adjustment.task_id <> work_order.task_id
       OR adjustment.eligibility_decision_id <> work_order.eligibility_decision_id
       OR adjustment.scope_version_id <> NEW.scope_version_id
       OR adjustment.change_order_id <> proposal.id
       OR adjustment.recorded_by <> NEW.materialized_by
       OR adjustment.expected_version <> NEW.expected_financial_version + 1
       OR EXISTS (
         SELECT 1
         FROM public.task_financial_security_events newer_financial
         WHERE newer_financial.task_id = work_order.task_id
           AND newer_financial.expected_version > adjustment.expected_version
       )
       OR adjustment.amount_cents <> new_scope.customer_total_cents
       OR adjustment.currency <> new_scope.currency THEN
      RAISE EXCEPTION 'HXUV1-CHANGE-7: price amendment requires exact successful fake adjustment authorization'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF NEW.request_sha256 IS DISTINCT FROM public.universal_v1_change_amendment_request_sha256(
    NEW.work_order_id,
    NEW.amendment_version,
    NEW.supersedes_amendment_id,
    NEW.change_order_id,
    NEW.scope_version_id,
    NEW.adjustment_event_id,
    NEW.expected_financial_version,
    NEW.materialized_by,
    NEW.idempotency_key
  ) THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-APP-27: amendment request digest mismatch'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS universal_change_order_proposal_guard
  ON public.task_scope_change_proposals;
CREATE TRIGGER universal_change_order_proposal_guard
BEFORE INSERT OR UPDATE ON public.task_scope_change_proposals
FOR EACH ROW EXECUTE FUNCTION public.enforce_universal_change_order_proposal();

DROP TRIGGER IF EXISTS universal_change_order_approval_guard
  ON public.task_scope_change_approvals;
CREATE TRIGGER universal_change_order_approval_guard
BEFORE INSERT ON public.task_scope_change_approvals
FOR EACH ROW EXECUTE FUNCTION public.enforce_universal_change_order_approval();

DROP TRIGGER IF EXISTS universal_work_order_amendment_guard
  ON public.task_work_order_amendments;
CREATE TRIGGER universal_work_order_amendment_guard
BEFORE INSERT ON public.task_work_order_amendments
FOR EACH ROW EXECUTE FUNCTION public.enforce_universal_work_order_amendment();

CREATE OR REPLACE FUNCTION public.prevent_universal_v1_change_proposal_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.universal_contract_version = 1 THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-APP-28: Universal V1 proposals are preserved evidence'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS universal_change_order_proposal_no_delete
  ON public.task_scope_change_proposals;
CREATE TRIGGER universal_change_order_proposal_no_delete
BEFORE DELETE ON public.task_scope_change_proposals
FOR EACH ROW EXECUTE FUNCTION public.prevent_universal_v1_change_proposal_delete();

DROP TRIGGER IF EXISTS universal_change_order_proposal_no_truncate
  ON public.task_scope_change_proposals;
CREATE TRIGGER universal_change_order_proposal_no_truncate
BEFORE TRUNCATE ON public.task_scope_change_proposals
FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_universal_v1_fact_mutation();

REVOKE ALL ON FUNCTION public.universal_v1_change_scope_sha256(
  TEXT, TEXT, TEXT, JSONB, INTEGER, INTEGER, CHAR(3)
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.universal_v1_change_proposal_request_sha256(
  UUID, UUID, UUID, TEXT, INTEGER, UUID, TEXT, TEXT, CHAR(64), TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.universal_v1_change_decision_request_sha256(
  UUID, INTEGER, TEXT, TEXT, UUID, TEXT, TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.universal_v1_change_amendment_request_sha256(
  UUID, INTEGER, UUID, UUID, UUID, UUID, INTEGER, UUID, TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_universal_change_order_proposal() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_universal_change_order_approval() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_universal_work_order_amendment() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prevent_universal_v1_change_proposal_delete() FROM PUBLIC;

COMMENT ON COLUMN public.task_scope_change_proposals.application_contract_version IS
  'Version 1 binds exact scope/economics, named proposer authority, idempotency, and request digest; schedule changes are intentionally unsupported.';
COMMENT ON COLUMN public.task_scope_change_proposals.proposed_scope_sha256 IS
  'Canonical database-computed digest of the complete replacement scope and economics.';
COMMENT ON TABLE public.task_scope_change_approvals IS
  'Append-only independent customer/provider decisions; neither decision authorizes payment or materializes an amendment.';
COMMENT ON TABLE public.task_work_order_amendments IS
  'Append-only customer-finalized Work Order scope changes; price changes may reference only an exact successful FAKE adjustment event.';
COMMENT ON COLUMN public.task_work_order_amendments.expected_financial_version IS
  'Exact predecessor financial-chain version supplied by the customer finalization command, including scope-only replay authority.';
