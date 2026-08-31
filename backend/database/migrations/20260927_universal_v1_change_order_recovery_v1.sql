-- Universal V1 price-and-scope change-order recovery authority v1.
--
-- Recovery remains nonproduction and fake-only. It can replay the exact Phase-A
-- ADJUST, finish the exact amendment, or terminally compensate a successful
-- adjustment with one exact REVERSAL after Phase-C authority is permanently gone.
-- Compensation records CANCELLED / RECOVERY_REQUIRED; it does not restore the
-- predecessor SECURED state and grants no execution, capture, assignment,
-- production-money, payout, deployment, or approved-provider capability.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF to_regclass('public.hxos_fake_financial_schema_evidence_v6') IS NULL
     OR to_regclass('public.universal_v1_change_order_materialization_commands') IS NULL
     OR to_regclass('public.universal_v1_fake_financial_lifecycle_bridges') IS NULL
     OR to_regclass('public.financial_provider_command_outcome_facts') IS NULL
     OR to_regclass('public.universal_v1_prepared_financial_commands') IS NULL
     OR to_regclass('public.task_work_order_amendments') IS NULL
     OR to_regprocedure(
       'public.enforce_universal_v1_change_order_materialization_command()'
     ) IS NULL THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-RECOVERY-0: exact three-phase change-order authority must be installed first'
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS public.hxos_fake_financial_schema_evidence_v7 (
  migration_name TEXT PRIMARY KEY CHECK (
    migration_name = '20260927_universal_v1_change_order_recovery_v1'
  ),
  migration_sql_sha256 CHAR(64) NOT NULL CHECK (
    migration_sql_sha256 ~ '^[0-9a-f]{64}$'
  ),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

DROP TRIGGER IF EXISTS hxos_fake_financial_schema_evidence_append_only_v7
  ON public.hxos_fake_financial_schema_evidence_v7;
CREATE TRIGGER hxos_fake_financial_schema_evidence_append_only_v7
BEFORE UPDATE OR DELETE ON public.hxos_fake_financial_schema_evidence_v7
FOR EACH ROW EXECUTE FUNCTION public.hxos_reject_fake_financial_mutation_v1();

DROP TRIGGER IF EXISTS hxos_fake_financial_schema_evidence_no_truncate_v7
  ON public.hxos_fake_financial_schema_evidence_v7;
CREATE TRIGGER hxos_fake_financial_schema_evidence_no_truncate_v7
BEFORE TRUNCATE ON public.hxos_fake_financial_schema_evidence_v7
FOR EACH STATEMENT EXECUTE FUNCTION public.hxos_reject_fake_financial_mutation_v1();

CREATE OR REPLACE FUNCTION public.universal_v1_change_order_recovery_uuid_v1(
  recovery_idempotency_key TEXT,
  recovery_label TEXT
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
    encode(digest(recovery_idempotency_key || ':' || recovery_label, 'sha256'), 'hex'),
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

CREATE TABLE IF NOT EXISTS public.universal_v1_change_order_recovery_leases (
  recovery_lease_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id UUID NOT NULL
    REFERENCES public.universal_v1_change_order_materialization_commands(proposal_id)
    ON DELETE RESTRICT,
  lease_owner_id UUID NOT NULL,
  lease_duration_seconds INTEGER NOT NULL CHECK (
    lease_duration_seconds BETWEEN 5 AND 900
  ),
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL,
  lease_identity_sha256 CHAR(64) GENERATED ALWAYS AS (
    encode(digest(
      proposal_id::TEXT || ':' || recovery_lease_id::TEXT || ':' ||
      lease_owner_id::TEXT || ':' || lease_duration_seconds::TEXT,
      'sha256'
    ), 'hex')
  ) STORED,
  CONSTRAINT universal_v1_change_order_recovery_lease_window_chk CHECK (
    expires_at = acquired_at + make_interval(secs => lease_duration_seconds)
  ),
  CONSTRAINT universal_v1_change_order_recovery_lease_proposal_id_uniq
    UNIQUE (proposal_id, recovery_lease_id)
);

CREATE INDEX IF NOT EXISTS universal_v1_change_order_recovery_lease_due_idx
  ON public.universal_v1_change_order_recovery_leases(proposal_id, expires_at);

CREATE TABLE IF NOT EXISTS public.universal_v1_change_order_compensation_commands (
  compensation_command_id UUID PRIMARY KEY,
  proposal_id UUID NOT NULL UNIQUE
    REFERENCES public.universal_v1_change_order_materialization_commands(proposal_id)
    ON DELETE RESTRICT,
  witness_request_sha256 CHAR(64) NOT NULL CHECK (
    witness_request_sha256 ~ '^[a-f0-9]{64}$'
  ),
  recovery_lease_id UUID NOT NULL,
  lease_owner_id UUID NOT NULL,
  task_draft_id UUID NOT NULL REFERENCES public.task_drafts(id) ON DELETE RESTRICT,
  task_id UUID NOT NULL REFERENCES public.tasks(id) ON DELETE RESTRICT,
  work_order_id UUID NOT NULL REFERENCES public.task_work_orders(id) ON DELETE RESTRICT,
  eligibility_decision_id UUID NOT NULL
    REFERENCES public.task_provider_eligibility_decisions(id) ON DELETE RESTRICT,
  base_scope_version_id UUID NOT NULL
    REFERENCES public.task_scope_versions(id) ON DELETE RESTRICT,
  adjustment_event_id UUID NOT NULL UNIQUE
    REFERENCES public.task_financial_security_events(id) ON DELETE RESTRICT,
  adjustment_operation_id UUID NOT NULL,
  reversal_operation_id UUID NOT NULL UNIQUE,
  reversal_idempotency_key TEXT NOT NULL UNIQUE CHECK (
    reversal_idempotency_key ~ '^[A-Za-z0-9:_-]{16,128}$'
  ),
  lifecycle_expected_version BIGINT NOT NULL CHECK (
    lifecycle_expected_version BETWEEN 1 AND 9007199254740991
  ),
  amount_cents BIGINT NOT NULL CHECK (
    amount_cents BETWEEN 1 AND 9007199254740991
  ),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  requested_by UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  reason_code TEXT NOT NULL CHECK (
    reason_code = 'FINALIZATION_AUTHORITY_REVOKED'
  ),
  authority_revocation_reason TEXT NOT NULL CHECK (
    authority_revocation_reason IN (
      'PROPOSAL_NOT_APPROVED',
      'TASK_AUTHORITY_REVOKED',
      'CUSTOMER_ACTOR_AUTHORITY_REVOKED',
      'CUSTOMER_APPROVAL_AUTHORITY_REVOKED',
      'PROVIDER_ACTOR_AUTHORITY_REVOKED',
      'PROVIDER_APPROVAL_AUTHORITY_REVOKED',
      'PROVIDER_ELIGIBILITY_REVOKED',
      'EXECUTION_AUTHORITY_REVOKED',
      'WORK_ORDER_TERMINALIZED'
    )
  ),
  semantic_limitation TEXT NOT NULL CHECK (
    semantic_limitation = 'PRIOR_SECURED_STATE_NOT_RESTORED'
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT universal_v1_change_order_compensation_lease_fk
    FOREIGN KEY (proposal_id, recovery_lease_id)
    REFERENCES public.universal_v1_change_order_recovery_leases(
      proposal_id, recovery_lease_id
    ) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS public.universal_v1_change_order_recovery_terminal_facts (
  terminal_fact_id UUID PRIMARY KEY,
  proposal_id UUID NOT NULL UNIQUE
    REFERENCES public.universal_v1_change_order_materialization_commands(proposal_id)
    ON DELETE RESTRICT,
  witness_request_sha256 CHAR(64) NOT NULL CHECK (
    witness_request_sha256 ~ '^[a-f0-9]{64}$'
  ),
  recovery_lease_id UUID NOT NULL,
  lease_owner_id UUID NOT NULL,
  outcome_state TEXT NOT NULL CHECK (
    outcome_state IN ('MATERIALIZED', 'CANCELLED')
  ),
  recovery_state TEXT NOT NULL CHECK (
    recovery_state IN ('NOT_REQUIRED', 'RECOVERY_REQUIRED')
  ),
  amendment_id UUID REFERENCES public.task_work_order_amendments(id) ON DELETE RESTRICT,
  adjustment_event_id UUID
    REFERENCES public.task_financial_security_events(id) ON DELETE RESTRICT,
  compensation_command_id UUID
    REFERENCES public.universal_v1_change_order_compensation_commands(
      compensation_command_id
    ) ON DELETE RESTRICT,
  compensation_event_id UUID
    REFERENCES public.task_financial_security_events(id) ON DELETE RESTRICT,
  no_effect_outcome_fact_id UUID
    REFERENCES public.financial_provider_command_outcome_facts(outcome_fact_id)
    ON DELETE RESTRICT,
  authority_revocation_reason TEXT CHECK (
    authority_revocation_reason IS NULL OR authority_revocation_reason IN (
      'PROPOSAL_NOT_APPROVED',
      'TASK_AUTHORITY_REVOKED',
      'CUSTOMER_ACTOR_AUTHORITY_REVOKED',
      'CUSTOMER_APPROVAL_AUTHORITY_REVOKED',
      'PROVIDER_ACTOR_AUTHORITY_REVOKED',
      'PROVIDER_APPROVAL_AUTHORITY_REVOKED',
      'PROVIDER_ELIGIBILITY_REVOKED',
      'EXECUTION_AUTHORITY_REVOKED',
      'AMENDMENT_CHAIN_CHANGED',
      'FINANCIAL_CHAIN_CHANGED',
      'WORK_ORDER_TERMINALIZED'
    )
  ),
  resolution_evidence_kind TEXT NOT NULL CHECK (
    resolution_evidence_kind IN ('AMENDMENT', 'REVERSAL', 'NO_EFFECT')
  ),
  hold_clearance_kind TEXT NOT NULL CHECK (
    hold_clearance_kind IN ('EXACT_AMENDMENT', 'BOUNDED_CANCELLATION_RECOVERY')
  ),
  prior_secured_state_restored BOOLEAN NOT NULL DEFAULT FALSE CHECK (
    prior_secured_state_restored = FALSE
  ),
  execution_resume_authorized BOOLEAN NOT NULL,
  capture_resume_authorized BOOLEAN NOT NULL DEFAULT FALSE CHECK (
    capture_resume_authorized = FALSE
  ),
  payment_creation_performed BOOLEAN NOT NULL DEFAULT FALSE CHECK (
    payment_creation_performed = FALSE
  ),
  hard_assignment_created BOOLEAN NOT NULL DEFAULT FALSE CHECK (
    hard_assignment_created = FALSE
  ),
  recorded_by UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  terminal_fact_sha256 CHAR(64) GENERATED ALWAYS AS (
    encode(digest(
      proposal_id::TEXT || ':' || witness_request_sha256 || ':' ||
      outcome_state || ':' || recovery_state || ':' ||
      COALESCE(amendment_id::TEXT, '') || ':' ||
      COALESCE(adjustment_event_id::TEXT, '') || ':' ||
      COALESCE(compensation_command_id::TEXT, '') || ':' ||
      COALESCE(compensation_event_id::TEXT, '') || ':' ||
      COALESCE(no_effect_outcome_fact_id::TEXT, '') || ':' ||
      COALESCE(authority_revocation_reason, '') || ':' ||
      resolution_evidence_kind || ':' || hold_clearance_kind || ':' ||
      prior_secured_state_restored::TEXT || ':' ||
      execution_resume_authorized::TEXT || ':' || capture_resume_authorized::TEXT,
      'sha256'
    ), 'hex')
  ) STORED,
  CONSTRAINT universal_v1_change_order_recovery_terminal_lease_fk
    FOREIGN KEY (proposal_id, recovery_lease_id)
    REFERENCES public.universal_v1_change_order_recovery_leases(
      proposal_id, recovery_lease_id
    ) ON DELETE RESTRICT,
  CONSTRAINT universal_v1_change_order_recovery_terminal_shape_chk CHECK (
    (
      outcome_state = 'MATERIALIZED'
      AND recovery_state = 'NOT_REQUIRED'
      AND amendment_id IS NOT NULL
      AND adjustment_event_id IS NOT NULL
      AND compensation_command_id IS NULL
      AND compensation_event_id IS NULL
      AND no_effect_outcome_fact_id IS NULL
      AND authority_revocation_reason IS NULL
      AND resolution_evidence_kind = 'AMENDMENT'
      AND hold_clearance_kind = 'EXACT_AMENDMENT'
      AND execution_resume_authorized = TRUE
    )
    OR (
      outcome_state = 'CANCELLED'
      AND recovery_state = 'RECOVERY_REQUIRED'
      AND amendment_id IS NULL
      AND (
        (
          compensation_command_id IS NOT NULL
          AND compensation_event_id IS NOT NULL
          AND adjustment_event_id IS NOT NULL
          AND no_effect_outcome_fact_id IS NULL
          AND authority_revocation_reason IS NULL
          AND resolution_evidence_kind = 'REVERSAL'
        )
        OR (
          compensation_command_id IS NULL
          AND compensation_event_id IS NULL
          AND resolution_evidence_kind = 'NO_EFFECT'
          AND num_nonnulls(no_effect_outcome_fact_id, authority_revocation_reason) = 1
          AND (
            no_effect_outcome_fact_id IS NOT NULL
            OR adjustment_event_id IS NULL
          )
        )
      )
      AND hold_clearance_kind = 'BOUNDED_CANCELLATION_RECOVERY'
      AND execution_resume_authorized = FALSE
    )
  )
);

-- REVERSAL was intentionally provider-neutral but not yet WorkOrder-required in
-- the predecessor PFC list. Patch only that exact allowlist and fail closed if
-- its installed definition drifted. All other PFC checks remain unchanged.
DO $migration$
DECLARE
  definition TEXT;
  needle TEXT := $needle$    IF NEW.operation_kind IN (
      'ADJUST','CAPTURE','REFUND','SETTLE','FUND',
      'PROVIDER_RELEASE','PAYOUT','OBSERVE_BANK_SETTLEMENT'
    ) AND work_order.id IS NULL THEN$needle$;
  replacement TEXT := $replacement$    IF NEW.operation_kind IN (
      'ADJUST','CAPTURE','REFUND','REVERSAL','SETTLE','FUND',
      'PROVIDER_RELEASE','PAYOUT','OBSERVE_BANK_SETTLEMENT'
    ) AND work_order.id IS NULL THEN$replacement$;
BEGIN
  definition := pg_get_functiondef(
    'public.enforce_universal_v1_financial_command_preparation()'::regprocedure
  );
  IF (length(definition) - length(replace(definition, replacement, '')))
       / length(replacement) = 1
     AND (length(definition) - length(replace(definition, needle, '')))
       / length(needle) = 0 THEN
    NULL;
  ELSIF (length(definition) - length(replace(definition, needle, '')))
          / length(needle) = 1
        AND (length(definition) - length(replace(definition, replacement, '')))
          / length(replacement) = 0 THEN
    EXECUTE replace(definition, needle, replacement);
  ELSE
    RAISE EXCEPTION 'HXUV1-CHANGE-RECOVERY-16: prepared-finance WorkOrder allowlist drifted'
      USING ERRCODE = 'P0001';
  END IF;
END;
$migration$;

CREATE OR REPLACE FUNCTION public.reject_universal_v1_change_order_recovery_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'HXUV1-CHANGE-RECOVERY-1: recovery evidence is append-only'
    USING ERRCODE = 'P0001';
END;
$$;

CREATE OR REPLACE FUNCTION public.validate_universal_v1_change_order_recovery_lease()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('universal-v1-change-order-proposal:' || NEW.proposal_id::TEXT, 0)
  );
  NEW.acquired_at := clock_timestamp();
  NEW.expires_at := NEW.acquired_at + make_interval(secs => NEW.lease_duration_seconds);

  IF NOT EXISTS (
    SELECT 1
      FROM public.universal_v1_change_order_materialization_commands command
     WHERE command.proposal_id = NEW.proposal_id
  ) OR EXISTS (
    SELECT 1
      FROM public.universal_v1_change_order_recovery_terminal_facts terminal
     WHERE terminal.proposal_id = NEW.proposal_id
  ) OR EXISTS (
    SELECT 1
      FROM public.universal_v1_change_order_recovery_leases active
     WHERE active.proposal_id = NEW.proposal_id
       AND active.expires_at > NEW.acquired_at
  ) THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-RECOVERY-2: lease lacks one unresolved exact witness'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER universal_v1_change_order_recovery_lease_guard
BEFORE INSERT ON public.universal_v1_change_order_recovery_leases
FOR EACH ROW EXECUTE FUNCTION public.validate_universal_v1_change_order_recovery_lease();

CREATE TRIGGER universal_v1_change_order_recovery_lease_no_update_delete
BEFORE UPDATE OR DELETE ON public.universal_v1_change_order_recovery_leases
FOR EACH ROW EXECUTE FUNCTION public.reject_universal_v1_change_order_recovery_mutation();

CREATE TRIGGER universal_v1_change_order_recovery_lease_no_truncate
BEFORE TRUNCATE ON public.universal_v1_change_order_recovery_leases
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_universal_v1_change_order_recovery_mutation();

CREATE OR REPLACE FUNCTION public.universal_v1_change_order_recovery_lease_is_active_v1(
  checked_proposal_id UUID,
  checked_recovery_lease_id UUID,
  checked_lease_owner_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.universal_v1_change_order_recovery_leases lease
     WHERE lease.proposal_id = checked_proposal_id
       AND lease.recovery_lease_id = checked_recovery_lease_id
       AND lease.lease_owner_id = checked_lease_owner_id
       AND lease.expires_at > clock_timestamp()
  );
$$;

-- Returns only explicit, durable revocation classes. NULL means recovery has
-- not proved permanent authority loss and therefore must not cancel NO_EFFECT.
CREATE OR REPLACE FUNCTION public.universal_v1_change_order_recovery_revocation_reason_v1(
  checked_proposal_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
PARALLEL UNSAFE
AS $$
DECLARE
  witness public.universal_v1_change_order_materialization_commands%ROWTYPE;
BEGIN
  SELECT * INTO witness
    FROM public.universal_v1_change_order_materialization_commands command
   WHERE command.proposal_id = checked_proposal_id;
  IF witness.proposal_id IS NULL THEN
    RETURN NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.task_scope_change_proposals proposal
     WHERE proposal.id = witness.proposal_id
       AND proposal.universal_contract_version = 1
       AND proposal.application_contract_version = 1
       AND proposal.status = 'APPROVED'
       AND proposal.change_order_kind = 'PRICE_AND_SCOPE'
       AND proposal.financial_adjustment_required IS TRUE
       AND proposal.proposal_version = witness.expected_proposal_version
       AND proposal.base_version_id = witness.base_scope_version_id
       AND proposal.approved_version_id = witness.replacement_scope_version_id
       AND proposal.reviewed_by = witness.actor_user_id
       AND proposal.proposed_customer_total_cents = witness.customer_total_cents
       AND proposal.proposed_provider_payout_cents = witness.provider_payout_cents
       AND EXISTS (
         SELECT 1 FROM public.task_scope_change_approvals approval
          WHERE approval.proposal_id = proposal.id
            AND approval.approver_role = 'CUSTOMER'
            AND approval.decision = 'APPROVED'
       )
       AND EXISTS (
         SELECT 1 FROM public.task_scope_change_approvals approval
          WHERE approval.proposal_id = proposal.id
            AND approval.approver_role = 'PROVIDER'
            AND approval.decision = 'APPROVED'
       )
  ) THEN
    RETURN 'PROPOSAL_NOT_APPROVED';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.tasks task_record
      JOIN public.task_drafts draft ON draft.id = witness.task_draft_id
      JOIN public.task_work_orders work_order ON work_order.id = witness.work_order_id
      JOIN public.task_scope_change_proposals proposal
        ON proposal.id = witness.proposal_id
      JOIN public.task_scope_versions base_scope
        ON base_scope.id = witness.base_scope_version_id
      JOIN public.task_scope_versions replacement
        ON replacement.id = witness.replacement_scope_version_id
     WHERE task_record.id = witness.task_id
       AND task_record.work_order_id = work_order.id
       AND task_record.active_scope_version_id = witness.base_scope_version_id
       AND task_record.universal_contract_version = 1
       AND task_record.automation_classification = 'CONTROLLED_TEST'
       AND task_record.universal_payment_posture = 'PAYMENT_CREATION_FROZEN'
       AND task_record.worker_id IS NULL
       AND draft.task_id = task_record.id
       AND draft.universal_contract_version = 1
       AND work_order.task_id = task_record.id
       AND work_order.task_draft_id = draft.id
       AND work_order.eligibility_decision_id = witness.eligibility_decision_id
       AND work_order.execution_contract_version = 1
       AND public.universal_v1_effective_work_order_scope_id(work_order.id) =
           witness.base_scope_version_id
       AND base_scope.task_id = task_record.id
       AND base_scope.version = witness.expected_scope_version
       AND replacement.task_id = task_record.id
       AND replacement.version = witness.expected_scope_version + 1
       AND replacement.supersedes_version_id = base_scope.id
       AND replacement.source = 'APPROVED_CHANGE'
       AND replacement.scope_hash = proposal.proposed_scope_sha256
       AND replacement.customer_total_cents = witness.customer_total_cents
       AND replacement.hustler_payout_cents = witness.provider_payout_cents
       AND replacement.currency = witness.currency
  ) THEN
    RETURN 'TASK_AUTHORITY_REVOKED';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.users actor
      JOIN public.tasks task_record ON task_record.id = witness.task_id
      LEFT JOIN public.business_organizations organization
        ON organization.id = task_record.business_organization_id
     WHERE actor.id = witness.actor_user_id
       AND actor.account_status = 'ACTIVE'
       AND actor.is_minor IS FALSE
       AND COALESCE(actor.is_banned, FALSE) IS FALSE
       AND (
         (task_record.business_organization_id IS NULL
           AND task_record.poster_id = actor.id)
         OR (
           task_record.business_organization_id IS NOT NULL
           AND organization.status = 'ACTIVE'
           AND organization.client_enabled IS TRUE
           AND public.business_membership_has_action(
             task_record.business_organization_id, actor.id, 'APPROVE_SPEND'
           )
         )
       )
  ) THEN
    RETURN 'CUSTOMER_ACTOR_AUTHORITY_REVOKED';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.task_scope_change_approvals approval
      JOIN public.tasks task_record ON task_record.id = witness.task_id
      JOIN public.users approval_actor ON approval_actor.id = approval.actor_id
      LEFT JOIN public.business_organizations organization
        ON organization.id = task_record.business_organization_id
     WHERE approval.proposal_id = witness.proposal_id
       AND approval.approver_role = 'CUSTOMER'
       AND approval.decision = 'APPROVED'
       AND approval_actor.account_status = 'ACTIVE'
       AND approval_actor.is_minor IS FALSE
       AND COALESCE(approval_actor.is_banned, FALSE) IS FALSE
       AND (
         (task_record.business_organization_id IS NULL
           AND approval.actor_id = task_record.poster_id)
         OR (
           task_record.business_organization_id IS NOT NULL
           AND organization.status = 'ACTIVE'
           AND organization.client_enabled IS TRUE
           AND public.business_membership_has_action(
             task_record.business_organization_id,
             approval.actor_id,
             'APPROVE_SPEND'
           )
         )
       )
  ) THEN
    RETURN 'CUSTOMER_APPROVAL_AUTHORITY_REVOKED';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.task_work_orders work_order
      JOIN public.users provider ON provider.id = work_order.provider_user_id
     WHERE work_order.id = witness.work_order_id
       AND provider.account_status = 'ACTIVE'
       AND provider.is_minor IS FALSE
       AND COALESCE(provider.is_banned, FALSE) IS FALSE
  ) THEN
    RETURN 'PROVIDER_ACTOR_AUTHORITY_REVOKED';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.task_scope_change_approvals approval
      JOIN public.task_work_orders work_order ON work_order.id = witness.work_order_id
      JOIN public.users approval_actor ON approval_actor.id = approval.actor_id
      LEFT JOIN public.business_organizations organization
        ON organization.id = work_order.provider_organization_id
     WHERE approval.proposal_id = witness.proposal_id
       AND approval.approver_role = 'PROVIDER'
       AND approval.decision = 'APPROVED'
       AND approval_actor.account_status = 'ACTIVE'
       AND approval_actor.is_minor IS FALSE
       AND COALESCE(approval_actor.is_banned, FALSE) IS FALSE
       AND (
         approval.actor_id = work_order.provider_user_id
         OR (
           work_order.provider_organization_id IS NOT NULL
           AND organization.status = 'ACTIVE'
           AND organization.provider_enabled IS TRUE
           AND public.business_membership_has_action(
             work_order.provider_organization_id,
             approval.actor_id,
             'APPROVE_SPEND'
           )
         )
       )
       AND approval.actor_id <> (
         SELECT customer.actor_id
           FROM public.task_scope_change_approvals customer
          WHERE customer.proposal_id = witness.proposal_id
            AND customer.approver_role = 'CUSTOMER'
            AND customer.decision = 'APPROVED'
          LIMIT 1
       )
  ) THEN
    RETURN 'PROVIDER_APPROVAL_AUTHORITY_REVOKED';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.task_provider_eligibility_decisions eligibility
      JOIN public.tasks task_record ON task_record.id = witness.task_id
     WHERE eligibility.id = witness.eligibility_decision_id
       AND eligibility.task_draft_id = witness.task_draft_id
       AND eligibility.task_id = witness.task_id
       AND public.universal_v1_invited_provider_authority_is_current(
         eligibility.provider_user_id,
         eligibility.provider_organization_id,
         eligibility.provider_class,
         eligibility.trade_credential_id,
         task_record.category,
         task_record.region_code
       )
  ) THEN
    RETURN 'PROVIDER_ELIGIBILITY_REVOKED';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.task_work_order_execution_facts execution
     WHERE execution.work_order_id = witness.work_order_id
       AND execution.scope_version_id = witness.base_scope_version_id
       AND execution.execution_version = witness.expected_execution_version
       AND execution.state IN ('MATERIALIZED','ACKNOWLEDGED','EN_ROUTE','ARRIVED','PAUSED')
       AND NOT EXISTS (
         SELECT 1 FROM public.task_work_order_execution_facts newer
          WHERE newer.work_order_id = execution.work_order_id
            AND newer.execution_version > execution.execution_version
       )
  ) THEN
    RETURN 'EXECUTION_AUTHORITY_REVOKED';
  END IF;

  IF COALESCE((
    SELECT MAX(amendment.amendment_version)
      FROM public.task_work_order_amendments amendment
     WHERE amendment.work_order_id = witness.work_order_id
  ), 0) <> witness.expected_amendment_version THEN
    RETURN 'AMENDMENT_CHAIN_CHANGED';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.task_financial_security_events adjustment
     WHERE adjustment.operation_id = witness.adjustment_operation_id::TEXT
       AND adjustment.idempotency_key = witness.idempotency_key || ':adjust'
       AND adjustment.event_kind = 'ADJUSTMENT_AUTHORIZED'
       AND adjustment.status = 'SUCCEEDED'
       AND adjustment.provider_kind = 'FAKE'
       AND adjustment.expected_version = witness.expected_financial_version + 1
  ) THEN
    IF NOT EXISTS (
      SELECT 1
        FROM public.task_financial_security_events adjustment
       WHERE adjustment.operation_id = witness.adjustment_operation_id::TEXT
         AND adjustment.idempotency_key = witness.idempotency_key || ':adjust'
         AND adjustment.task_draft_id = witness.task_draft_id
         AND adjustment.task_id = witness.task_id
         AND adjustment.eligibility_decision_id = witness.eligibility_decision_id
         AND adjustment.scope_version_id = witness.replacement_scope_version_id
         AND adjustment.change_order_id = witness.proposal_id
         AND adjustment.predecessor_event_id = witness.predecessor_event_id
         AND adjustment.event_kind = 'ADJUSTMENT_AUTHORIZED'
         AND adjustment.status = 'SUCCEEDED'
         AND adjustment.provider_kind = 'FAKE'
         AND adjustment.expected_version = witness.expected_financial_version + 1
         AND adjustment.amount_cents = witness.customer_total_cents
         AND adjustment.currency = witness.currency
         AND NOT EXISTS (
           SELECT 1 FROM public.task_financial_security_events newer
            WHERE newer.task_draft_id = witness.task_draft_id
              AND newer.expected_version > adjustment.expected_version
         )
    ) THEN
      RETURN 'FINANCIAL_CHAIN_CHANGED';
    END IF;
  ELSIF NOT EXISTS (
    SELECT 1
      FROM public.task_financial_security_events predecessor
     WHERE predecessor.id = witness.predecessor_event_id
       AND predecessor.operation_id = witness.predecessor_operation_id::TEXT
       AND predecessor.task_draft_id = witness.task_draft_id
       AND predecessor.task_id = witness.task_id
       AND predecessor.eligibility_decision_id = witness.eligibility_decision_id
       AND predecessor.scope_version_id = witness.base_scope_version_id
       AND predecessor.status = 'SUCCEEDED'
       AND predecessor.provider_kind = 'FAKE'
       AND predecessor.expected_version = witness.expected_financial_version
       AND predecessor.event_kind IN ('SECURED', 'ADJUSTMENT_AUTHORIZED')
       AND NOT EXISTS (
         SELECT 1 FROM public.task_financial_security_events newer
          WHERE newer.task_draft_id = witness.task_draft_id
            AND newer.expected_version > predecessor.expected_version
       )
  ) THEN
    RETURN 'FINANCIAL_CHAIN_CHANGED';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.task_completion_facts completion
     WHERE completion.work_order_id = witness.work_order_id
  ) OR EXISTS (
    SELECT 1 FROM public.task_reconciliation_facts reconciliation
     WHERE reconciliation.work_order_id = witness.work_order_id
  ) THEN
    RETURN 'WORK_ORDER_TERMINALIZED';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.validate_universal_v1_change_order_compensation_command()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  witness public.universal_v1_change_order_materialization_commands%ROWTYPE;
  adjustment public.task_financial_security_events%ROWTYPE;
  bridge public.universal_v1_fake_financial_lifecycle_bridges%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('universal-v1-change-order-proposal:' || NEW.proposal_id::TEXT, 0)
  );
  SELECT * INTO witness
    FROM public.universal_v1_change_order_materialization_commands command
   WHERE command.proposal_id = NEW.proposal_id
   FOR SHARE;
  IF witness.proposal_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('fulfillment:' || witness.work_order_id::TEXT, 0)
    );
  END IF;
  SELECT * INTO adjustment
    FROM public.task_financial_security_events financial
   WHERE financial.id = NEW.adjustment_event_id
   FOR SHARE;
  SELECT * INTO bridge
    FROM public.universal_v1_fake_financial_lifecycle_bridges lifecycle_bridge
   WHERE lifecycle_bridge.task_financial_security_event_id = NEW.adjustment_event_id
   FOR SHARE;

  IF witness.proposal_id IS NULL
     OR adjustment.id IS NULL
     OR bridge.bridge_id IS NULL
     OR NOT public.universal_v1_change_order_recovery_lease_is_active_v1(
       NEW.proposal_id, NEW.recovery_lease_id, NEW.lease_owner_id
     )
     OR NEW.reason_code <> 'FINALIZATION_AUTHORITY_REVOKED'
     OR public.universal_v1_change_order_recovery_revocation_reason_v1(
       NEW.proposal_id
     ) IS NULL
     OR public.universal_v1_change_order_recovery_revocation_reason_v1(
       NEW.proposal_id
     ) IN ('AMENDMENT_CHAIN_CHANGED', 'FINANCIAL_CHAIN_CHANGED')
     OR NEW.requested_by IS DISTINCT FROM witness.actor_user_id
     OR adjustment.operation_id IS DISTINCT FROM witness.adjustment_operation_id::TEXT
     OR adjustment.idempotency_key IS DISTINCT FROM witness.idempotency_key || ':adjust'
     OR adjustment.event_kind <> 'ADJUSTMENT_AUTHORIZED'
     OR adjustment.status <> 'SUCCEEDED'
     OR adjustment.provider_kind <> 'FAKE'
     OR adjustment.expected_version <> witness.expected_financial_version + 1
     OR adjustment.task_draft_id IS DISTINCT FROM witness.task_draft_id
     OR adjustment.task_id IS DISTINCT FROM witness.task_id
     OR adjustment.eligibility_decision_id IS DISTINCT FROM witness.eligibility_decision_id
     OR adjustment.scope_version_id IS DISTINCT FROM witness.replacement_scope_version_id
     OR adjustment.change_order_id IS DISTINCT FROM witness.proposal_id
     OR adjustment.predecessor_event_id IS DISTINCT FROM witness.predecessor_event_id
     OR adjustment.amount_cents IS DISTINCT FROM witness.customer_total_cents
     OR adjustment.currency IS DISTINCT FROM witness.currency
     OR adjustment.recorded_by IS DISTINCT FROM witness.actor_user_id
     OR bridge.fake_operation_id IS DISTINCT FROM witness.adjustment_operation_id
     OR bridge.fake_operation_kind <> 'ADJUST'
     OR bridge.fake_provider_state <> 'SUCCEEDED'
     OR bridge.lifecycle_event_kind <> 'ADJUSTMENT_AUTHORIZED'
     OR bridge.lifecycle_status <> 'SUCCEEDED'
     OR bridge.lifecycle_expected_version <> witness.expected_financial_version + 1
     OR bridge.task_financial_security_event_id IS DISTINCT FROM adjustment.id
     OR EXISTS (
       SELECT 1 FROM public.task_financial_security_events successor
        WHERE successor.task_draft_id = witness.task_draft_id
          AND successor.expected_version > adjustment.expected_version
     )
     OR EXISTS (
       SELECT 1 FROM public.task_work_order_amendments amendment
        WHERE amendment.change_order_id = witness.proposal_id
     )
     OR EXISTS (
       SELECT 1 FROM public.universal_v1_change_order_recovery_terminal_facts terminal
        WHERE terminal.proposal_id = witness.proposal_id
     )
     OR NOT EXISTS (
       SELECT 1
         FROM public.tasks task_record
        WHERE task_record.id = witness.task_id
          AND task_record.work_order_id = witness.work_order_id
          AND task_record.active_scope_version_id = witness.base_scope_version_id
          AND task_record.worker_id IS NULL
          AND task_record.universal_contract_version = 1
          AND task_record.automation_classification = 'CONTROLLED_TEST'
          AND task_record.universal_payment_posture = 'PAYMENT_CREATION_FROZEN'
     ) THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-RECOVERY-3: compensation lacks exact successful adjustment and frozen witness authority'
      USING ERRCODE = 'P0001';
  END IF;

  NEW.compensation_command_id :=
    public.universal_v1_change_order_recovery_uuid_v1(
      witness.idempotency_key, 'compensation-command'
    );
  NEW.witness_request_sha256 := witness.request_sha256;
  NEW.task_draft_id := witness.task_draft_id;
  NEW.task_id := witness.task_id;
  NEW.work_order_id := witness.work_order_id;
  NEW.eligibility_decision_id := witness.eligibility_decision_id;
  NEW.base_scope_version_id := witness.base_scope_version_id;
  NEW.adjustment_operation_id := witness.adjustment_operation_id;
  NEW.reversal_operation_id := public.universal_v1_change_order_recovery_uuid_v1(
    witness.idempotency_key, 'compensating-reversal'
  );
  NEW.reversal_idempotency_key := witness.idempotency_key || ':recovery:reversal';
  NEW.lifecycle_expected_version := witness.expected_financial_version + 2;
  NEW.amount_cents := adjustment.amount_cents;
  NEW.currency := adjustment.currency;
  NEW.semantic_limitation := 'PRIOR_SECURED_STATE_NOT_RESTORED';
  NEW.authority_revocation_reason :=
    public.universal_v1_change_order_recovery_revocation_reason_v1(NEW.proposal_id);
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER universal_v1_change_order_compensation_command_guard
BEFORE INSERT ON public.universal_v1_change_order_compensation_commands
FOR EACH ROW EXECUTE FUNCTION public.validate_universal_v1_change_order_compensation_command();

CREATE TRIGGER universal_v1_change_order_compensation_no_update_delete
BEFORE UPDATE OR DELETE ON public.universal_v1_change_order_compensation_commands
FOR EACH ROW EXECUTE FUNCTION public.reject_universal_v1_change_order_recovery_mutation();

CREATE TRIGGER universal_v1_change_order_compensation_no_truncate
BEFORE TRUNCATE ON public.universal_v1_change_order_compensation_commands
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_universal_v1_change_order_recovery_mutation();

-- The base lifecycle contract correctly rejects arbitrary successor scope
-- drift. The one bounded exception is an exact migration-133 compensation:
-- ADJUST is bound to the unmaterialized replacement scope, while its terminal
-- REVERSAL is bound to the still-active base scope. This predicate re-proves
-- the entire immutable command/provider chain; it is not general scope-drift
-- authority and it does not restore the predecessor SECURED state.
CREATE OR REPLACE FUNCTION public.universal_v1_change_order_compensating_reversal_is_exact_v1(
  checked_event public.task_financial_security_events,
  checked_predecessor public.task_financial_security_events
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
PARALLEL UNSAFE
SET search_path = pg_catalog, public
AS $$
  SELECT checked_event.event_kind = 'REVERSED'
    AND checked_event.status = 'SUCCEEDED'
    AND checked_event.provider_kind = 'FAKE'
    AND checked_event.change_order_id IS NULL
    AND checked_event.completion_fact_id IS NULL
    AND checked_predecessor.event_kind = 'ADJUSTMENT_AUTHORIZED'
    AND checked_predecessor.status = 'SUCCEEDED'
    AND checked_predecessor.provider_kind = 'FAKE'
    AND EXISTS (
      SELECT 1
        FROM public.universal_v1_change_order_compensation_commands compensation
        JOIN public.universal_v1_change_order_materialization_commands witness
          ON witness.proposal_id = compensation.proposal_id
         AND witness.request_sha256 = compensation.witness_request_sha256
         AND witness.task_draft_id = compensation.task_draft_id
         AND witness.task_id = compensation.task_id
         AND witness.work_order_id = compensation.work_order_id
         AND witness.eligibility_decision_id = compensation.eligibility_decision_id
         AND witness.base_scope_version_id = compensation.base_scope_version_id
         AND witness.adjustment_operation_id = compensation.adjustment_operation_id
        JOIN public.universal_v1_prepared_financial_commands prepared
          ON prepared.operation_kind = 'REVERSAL'
         AND prepared.operation_id = compensation.reversal_operation_id
         AND prepared.provider_kind = 'FAKE'
         AND prepared.provider_expected_version = 0
         AND prepared.idempotency_key = compensation.reversal_idempotency_key
         AND prepared.lifecycle_expected_version = compensation.lifecycle_expected_version
         AND prepared.task_draft_id = compensation.task_draft_id
         AND prepared.task_id = compensation.task_id
         AND prepared.work_order_id = compensation.work_order_id
         AND prepared.eligibility_decision_id = compensation.eligibility_decision_id
         AND prepared.scope_version_id = compensation.base_scope_version_id
         AND prepared.change_order_id IS NULL
         AND prepared.predecessor_event_id = compensation.adjustment_event_id
         AND prepared.completion_fact_id IS NULL
         AND prepared.related_operation_id = compensation.adjustment_operation_id
         AND prepared.amount_cents = compensation.amount_cents
         AND prepared.currency = compensation.currency
         AND prepared.recorded_by = compensation.requested_by
        JOIN public.financial_provider_command_journal journal
          ON journal.prepared_financial_command_id = prepared.prepared_command_id
         AND journal.prepared_authority_sha256 = prepared.authority_context_sha256
         AND journal.request_sha256 = prepared.provider_request_sha256
         AND journal.operation_kind = 'REVERSAL'
         AND journal.operation_id = compensation.reversal_operation_id
         AND journal.provider_kind = 'FAKE'
         AND journal.provider_expected_version = 0
         AND journal.idempotency_key = compensation.reversal_idempotency_key
         AND journal.task_draft_id = compensation.task_draft_id
         AND journal.task_id = compensation.task_id
         AND journal.work_order_id = compensation.work_order_id
         AND journal.related_operation_id = compensation.adjustment_operation_id
         AND journal.amount_cents = compensation.amount_cents
         AND journal.currency = compensation.currency
         AND journal.recorded_actor_id = compensation.requested_by
        JOIN public.financial_provider_command_dispatch_attempts dispatch
          ON dispatch.command_id = journal.command_id
        JOIN public.financial_provider_command_outcome_facts outcome
          ON outcome.command_id = journal.command_id
         AND outcome.outcome_kind = 'OUTCOME_OBSERVED'
         AND outcome.effect_certainty = 'CONFIRMED_EFFECT'
         AND outcome.provider_state = 'REVERSED'
         AND outcome.retryable = FALSE
       WHERE compensation.reversal_operation_id::TEXT = checked_event.operation_id
         AND compensation.reversal_idempotency_key = checked_event.idempotency_key
         AND compensation.lifecycle_expected_version = checked_event.expected_version
         AND compensation.task_draft_id = checked_event.task_draft_id
         AND compensation.task_id = checked_event.task_id
         AND compensation.eligibility_decision_id = checked_event.eligibility_decision_id
         AND compensation.base_scope_version_id = checked_event.scope_version_id
         AND compensation.adjustment_event_id = checked_event.predecessor_event_id
         AND compensation.amount_cents = checked_event.amount_cents
         AND compensation.currency = checked_event.currency
         AND compensation.requested_by = checked_event.recorded_by
         AND checked_predecessor.id = compensation.adjustment_event_id
         AND checked_predecessor.operation_id = compensation.adjustment_operation_id::TEXT
         AND checked_predecessor.idempotency_key = witness.idempotency_key || ':adjust'
         AND checked_predecessor.expected_version = witness.expected_financial_version + 1
         AND checked_predecessor.task_draft_id = witness.task_draft_id
         AND checked_predecessor.task_id = witness.task_id
         AND checked_predecessor.eligibility_decision_id = witness.eligibility_decision_id
         AND checked_predecessor.scope_version_id = witness.replacement_scope_version_id
         AND checked_predecessor.change_order_id = witness.proposal_id
         AND checked_predecessor.predecessor_event_id = witness.predecessor_event_id
         AND checked_predecessor.amount_cents = witness.customer_total_cents
         AND checked_predecessor.currency = witness.currency
         AND checked_predecessor.recorded_by = witness.actor_user_id
    );
$$;

-- Replace only the exact FIN-12 predicate from the append-only lifecycle
-- function. The migration fails closed if the inherited definition differs or
-- contains more than one matching fragment, preventing a silent broad rewrite.
DO $change_order_fin_12_patch$
DECLARE
  inherited_definition TEXT;
  inherited_fragment CONSTANT TEXT := $inherited_fin_12$
  IF NEW.event_kind NOT IN ('AUTHORIZED','ADJUSTMENT_AUTHORIZED')
     AND predecessor.scope_version_id IS NOT NULL
     AND NEW.scope_version_id IS DISTINCT FROM predecessor.scope_version_id THEN
    RAISE EXCEPTION 'HXUV1-FIN-12: financial successor cannot drift from its authorized scope'
      USING ERRCODE = 'P0001';
  END IF;
$inherited_fin_12$;
  replacement_fragment CONSTANT TEXT := $replacement_fin_12$
  IF NEW.event_kind NOT IN ('AUTHORIZED','ADJUSTMENT_AUTHORIZED')
     AND predecessor.scope_version_id IS NOT NULL
     AND NEW.scope_version_id IS DISTINCT FROM predecessor.scope_version_id
     AND NOT public.universal_v1_change_order_compensating_reversal_is_exact_v1(
       NEW, predecessor
     ) THEN
    RAISE EXCEPTION 'HXUV1-FIN-12: financial successor cannot drift from its authorized scope'
      USING ERRCODE = 'P0001';
  END IF;
$replacement_fin_12$;
  first_match INTEGER;
BEGIN
  SELECT pg_get_functiondef(
    'public.enforce_universal_financial_event_sequence()'::regprocedure
  ) INTO inherited_definition;
  first_match := strpos(inherited_definition, inherited_fragment);
  IF first_match = 0
     OR strpos(
       substring(inherited_definition FROM first_match + length(inherited_fragment)),
       inherited_fragment
     ) > 0 THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-RECOVERY-34: inherited FIN-12 predicate is not exact'
      USING ERRCODE = 'P0001';
  END IF;
  EXECUTE replace(inherited_definition, inherited_fragment, replacement_fragment);
END;
$change_order_fin_12_patch$;

REVOKE ALL ON FUNCTION public.universal_v1_change_order_compensating_reversal_is_exact_v1(
  public.task_financial_security_events,
  public.task_financial_security_events
) FROM PUBLIC;

-- Serialize every WorkOrder-bound financial preparation with Phase A before
-- the predecessor migration's guards run. The post-main guard below can then
-- observe either the committed witness or the committed competing finance row;
-- it cannot miss an in-flight witness and consume that witness's lifecycle slot.
CREATE OR REPLACE FUNCTION public.lock_universal_v1_change_order_financial_slot_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  checked_work_order_id UUID;
  checked_task_id UUID;
BEGIN
  SELECT work_order.id, work_order.task_id
    INTO checked_work_order_id, checked_task_id
    FROM public.task_work_orders work_order
   WHERE work_order.task_draft_id = NEW.task_draft_id
   FOR SHARE;
  IF checked_work_order_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('fulfillment:' || checked_work_order_id::TEXT, 0)
    );
    IF NEW.task_id IS NOT NULL AND NEW.task_id IS DISTINCT FROM checked_task_id THEN
      RAISE EXCEPTION 'HXUV1-CHANGE-RECOVERY-31: prepared command task binding conflicts with immutable draft WorkOrder'
        USING ERRCODE = 'P0001';
    END IF;
    IF NEW.work_order_id IS NOT NULL
       AND NEW.work_order_id IS DISTINCT FROM checked_work_order_id THEN
      RAISE EXCEPTION 'HXUV1-CHANGE-RECOVERY-32: prepared command WorkOrder binding conflicts with immutable draft WorkOrder'
        USING ERRCODE = 'P0001';
    END IF;
  ELSIF NEW.work_order_id IS NOT NULL THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-RECOVERY-33: prepared command supplied a WorkOrder not bound to its immutable draft'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS a0_universal_v1_change_order_financial_slot_lock
  ON public.universal_v1_prepared_financial_commands;
CREATE TRIGGER a0_universal_v1_change_order_financial_slot_lock
BEFORE INSERT ON public.universal_v1_prepared_financial_commands
FOR EACH ROW EXECUTE FUNCTION public.lock_universal_v1_change_order_financial_slot_v1();

-- Close the opposite race direction. Migration 132's command guard has already
-- acquired proposal -> fulfillment locks when this alphabetically-last trigger
-- runs. A finance preparation that committed first therefore makes Phase A
-- fail instead of leaving an immutable witness behind a consumed N+1 slot.
CREATE OR REPLACE FUNCTION public.reject_change_order_witness_after_financial_slot_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.universal_v1_prepared_financial_commands prepared
     WHERE prepared.task_draft_id = NEW.task_draft_id
       AND prepared.lifecycle_expected_version = NEW.expected_financial_version + 1
  ) THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-RECOVERY-30: financial lifecycle slot was prepared before Phase A'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS zz_universal_v1_change_order_phase_a_financial_slot_guard
  ON public.universal_v1_change_order_materialization_commands;
CREATE TRIGGER zz_universal_v1_change_order_phase_a_financial_slot_guard
BEFORE INSERT ON public.universal_v1_change_order_materialization_commands
FOR EACH ROW EXECUTE FUNCTION public.reject_change_order_witness_after_financial_slot_v1();

-- An unresolved Phase-A witness exclusively owns the WorkOrder financial
-- transition. Before ADJUST success only its exact ADJUST is permitted; after
-- success only its exact migration-133 compensation REVERSAL is permitted.
-- Every WorkOrder-bound REVERSAL is also sealed to that exact compensation row.
CREATE OR REPLACE FUNCTION public.validate_universal_v1_change_order_compensating_reversal()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  cancelled_proposal_id UUID;
  unresolved public.universal_v1_change_order_materialization_commands%ROWTYPE;
  adjustment_succeeded BOOLEAN := FALSE;
  exact_adjust BOOLEAN := FALSE;
  exact_reversal BOOLEAN := FALSE;
BEGIN
  IF NEW.work_order_id IS NOT NULL THEN
    SELECT terminal.proposal_id INTO cancelled_proposal_id
      FROM public.universal_v1_change_order_recovery_terminal_facts terminal
      JOIN public.universal_v1_change_order_materialization_commands witness
        ON witness.proposal_id = terminal.proposal_id
     WHERE witness.work_order_id = NEW.work_order_id
       AND terminal.outcome_state = 'CANCELLED'
       AND terminal.recovery_state = 'RECOVERY_REQUIRED'
     LIMIT 1;
    IF cancelled_proposal_id IS NOT NULL THEN
      -- Terminal facts are immutable. The a0 trigger already owns fulfillment;
      -- taking proposal here would invert the proposal -> fulfillment order.
      RAISE EXCEPTION 'HXUV1-CHANGE-RECOVERY-20: CANCELLED_RECOVERY_REQUIRED forbids new financial lifecycle commands'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF NEW.work_order_id IS NOT NULL THEN
    SELECT command.* INTO unresolved
      FROM public.universal_v1_change_order_materialization_commands command
     WHERE command.work_order_id = NEW.work_order_id
       AND NOT EXISTS (
         SELECT 1 FROM public.task_work_order_amendments amendment
          WHERE amendment.change_order_id = command.proposal_id
       )
       AND NOT EXISTS (
         SELECT 1
           FROM public.universal_v1_change_order_recovery_terminal_facts terminal
          WHERE terminal.proposal_id = command.proposal_id
       )
     ORDER BY command.prepared_at DESC, command.proposal_id
     LIMIT 1;
  END IF;

  IF unresolved.proposal_id IS NOT NULL THEN
    -- The fulfillment lock was acquired by the a0 trigger. A concurrent
    -- recovery transaction may already own proposal -> fulfillment; fail with
    -- a retryable serialization error instead of reversing lock order.
    IF NOT pg_try_advisory_xact_lock(
      hashtextextended(
        'universal-v1-change-order-proposal:' || unresolved.proposal_id::TEXT,
        0
      )
    ) THEN
      RAISE EXCEPTION 'HXUV1-CHANGE-RECOVERY-28: proposal authority is concurrently resolving'
        USING ERRCODE = '40001';
    END IF;

    -- Re-check after both exact locks. A resolution that committed while the
    -- trigger waited converts this insertion into a fresh, normally governed
    -- lifecycle command; cancellation remains denied by the guard above.
    IF EXISTS (
      SELECT 1 FROM public.task_work_order_amendments amendment
       WHERE amendment.change_order_id = unresolved.proposal_id
    ) OR EXISTS (
      SELECT 1 FROM public.universal_v1_change_order_recovery_terminal_facts terminal
       WHERE terminal.proposal_id = unresolved.proposal_id
    ) THEN
      unresolved.proposal_id := NULL;
    END IF;
  END IF;

  IF unresolved.proposal_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
        FROM public.task_financial_security_events adjustment
       WHERE adjustment.operation_id = unresolved.adjustment_operation_id::TEXT
         AND adjustment.idempotency_key = unresolved.idempotency_key || ':adjust'
         AND adjustment.task_draft_id = unresolved.task_draft_id
         AND adjustment.change_order_id = unresolved.proposal_id
         AND adjustment.event_kind = 'ADJUSTMENT_AUTHORIZED'
         AND adjustment.status = 'SUCCEEDED'
         AND adjustment.provider_kind = 'FAKE'
         AND adjustment.expected_version = unresolved.expected_financial_version + 1
    ) INTO adjustment_succeeded;

    exact_adjust := NEW.operation_kind = 'ADJUST'
      AND NEW.change_order_id IS NOT DISTINCT FROM unresolved.proposal_id
      AND NEW.operation_id IS NOT DISTINCT FROM unresolved.adjustment_operation_id
      AND NEW.idempotency_key IS NOT DISTINCT FROM unresolved.idempotency_key || ':adjust'
      AND NEW.task_draft_id IS NOT DISTINCT FROM unresolved.task_draft_id
      AND NEW.task_id IS NOT DISTINCT FROM unresolved.task_id
      AND NEW.work_order_id IS NOT DISTINCT FROM unresolved.work_order_id
      AND NEW.eligibility_decision_id IS NOT DISTINCT FROM unresolved.eligibility_decision_id
      AND NEW.scope_version_id IS NOT DISTINCT FROM unresolved.replacement_scope_version_id
      AND NEW.predecessor_event_id IS NOT DISTINCT FROM unresolved.predecessor_event_id
      AND NEW.related_operation_id IS NOT DISTINCT FROM unresolved.predecessor_operation_id
      AND NEW.lifecycle_expected_version = unresolved.expected_financial_version + 1
      AND NEW.amount_cents IS NOT DISTINCT FROM unresolved.customer_total_cents
      AND NEW.currency IS NOT DISTINCT FROM unresolved.currency
      AND NEW.recorded_by IS NOT DISTINCT FROM unresolved.actor_user_id;

    SELECT EXISTS (
      SELECT 1
        FROM public.universal_v1_change_order_compensation_commands compensation
       WHERE compensation.proposal_id = unresolved.proposal_id
         AND compensation.work_order_id = NEW.work_order_id
         AND compensation.reversal_operation_id = NEW.operation_id
         AND compensation.reversal_idempotency_key = NEW.idempotency_key
         AND compensation.lifecycle_expected_version = NEW.lifecycle_expected_version
         AND compensation.task_draft_id = NEW.task_draft_id
         AND compensation.task_id = NEW.task_id
         AND compensation.eligibility_decision_id = NEW.eligibility_decision_id
         AND compensation.base_scope_version_id = NEW.scope_version_id
         AND compensation.adjustment_event_id = NEW.predecessor_event_id
         AND compensation.adjustment_operation_id = NEW.related_operation_id
         AND compensation.amount_cents = NEW.amount_cents
         AND compensation.currency = NEW.currency
         AND compensation.requested_by = NEW.recorded_by
         AND compensation.witness_request_sha256 = unresolved.request_sha256
    ) INTO exact_reversal;

    IF (NOT adjustment_succeeded AND NOT exact_adjust)
       OR (adjustment_succeeded AND NOT (
         NEW.operation_kind = 'REVERSAL' AND exact_reversal
       )) THEN
      RAISE EXCEPTION 'HXUV1-CHANGE-RECOVERY-29: unresolved change-order witness owns the exact financial lifecycle slot'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF NEW.operation_kind = 'REVERSAL'
     AND NEW.work_order_id IS NOT NULL
     AND (NEW.provider_kind <> 'FAKE'
       OR NEW.provider_expected_version <> 0
       OR NOT exact_reversal) THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-RECOVERY-4: WorkOrder REVERSAL requires the exact migration-133 compensation command'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS zz_universal_v1_change_order_compensating_reversal_guard
  ON public.universal_v1_prepared_financial_commands;
CREATE TRIGGER zz_universal_v1_change_order_compensating_reversal_guard
BEFORE INSERT ON public.universal_v1_prepared_financial_commands
FOR EACH ROW EXECUTE FUNCTION public.validate_universal_v1_change_order_compensating_reversal();

CREATE OR REPLACE FUNCTION public.prevent_change_order_adjust_after_terminal_recovery()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  checked_proposal_id UUID;
  checked_work_order_id UUID;
BEGIN
  IF TG_TABLE_NAME = 'financial_provider_command_journal' THEN
    SELECT prepared.change_order_id, prepared.work_order_id
      INTO checked_proposal_id, checked_work_order_id
      FROM public.universal_v1_prepared_financial_commands prepared
     WHERE prepared.prepared_command_id = NEW.prepared_financial_command_id;
  ELSE
    SELECT prepared.change_order_id, prepared.work_order_id
      INTO checked_proposal_id, checked_work_order_id
      FROM public.financial_provider_command_journal journal
      JOIN public.universal_v1_prepared_financial_commands prepared
        ON prepared.prepared_command_id = journal.prepared_financial_command_id
     WHERE journal.command_id = NEW.command_id;
  END IF;

  IF checked_work_order_id IS NOT NULL THEN
    SELECT terminal.proposal_id INTO checked_proposal_id
      FROM public.universal_v1_change_order_recovery_terminal_facts terminal
      JOIN public.universal_v1_change_order_materialization_commands witness
        ON witness.proposal_id = terminal.proposal_id
     WHERE witness.work_order_id = checked_work_order_id
       AND terminal.outcome_state = 'CANCELLED'
       AND terminal.recovery_state = 'RECOVERY_REQUIRED'
     LIMIT 1;
  END IF;
  IF checked_proposal_id IS NULL THEN RETURN NEW; END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'universal-v1-change-order-proposal:' || checked_proposal_id::TEXT,
      0
    )
  );
  IF EXISTS (
    SELECT 1
      FROM public.universal_v1_change_order_recovery_terminal_facts terminal
     WHERE terminal.proposal_id = checked_proposal_id
       AND terminal.outcome_state = 'CANCELLED'
  ) THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-RECOVERY-18: terminal recovery won before financial journal or dispatch'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER aa_universal_v1_change_order_terminal_journal_guard
BEFORE INSERT ON public.financial_provider_command_journal
FOR EACH ROW EXECUTE FUNCTION public.prevent_change_order_adjust_after_terminal_recovery();

CREATE TRIGGER aa_universal_v1_change_order_terminal_dispatch_guard
BEFORE INSERT ON public.financial_provider_command_dispatch_attempts
FOR EACH ROW EXECUTE FUNCTION public.prevent_change_order_adjust_after_terminal_recovery();

-- Whichever immutable row is inserted first wins. The finalizer holds the same
-- proposal advisory lock, so a failed amendment insert rolls back its preceding
-- task projection update in the same SERIALIZABLE transaction.
CREATE OR REPLACE FUNCTION public.reject_amendment_after_change_order_compensation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.change_order_id IS NULL THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'universal-v1-change-order-proposal:' || NEW.change_order_id::TEXT,
      0
    )
  );
  IF EXISTS (
    SELECT 1
      FROM public.universal_v1_change_order_compensation_commands compensation
     WHERE compensation.proposal_id = NEW.change_order_id
  ) OR EXISTS (
    SELECT 1
      FROM public.universal_v1_change_order_recovery_terminal_facts terminal
     WHERE terminal.proposal_id = NEW.change_order_id
       AND terminal.outcome_state = 'CANCELLED'
       AND terminal.recovery_state = 'RECOVERY_REQUIRED'
  ) THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-RECOVERY-5: compensation already won the amendment resolution race'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER aa_universal_v1_change_order_compensation_winner_guard
BEFORE INSERT ON public.task_work_order_amendments
FOR EACH ROW EXECUTE FUNCTION public.reject_amendment_after_change_order_compensation();

CREATE OR REPLACE FUNCTION public.validate_universal_v1_change_order_recovery_terminal_fact()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  witness public.universal_v1_change_order_materialization_commands%ROWTYPE;
  adjustment public.task_financial_security_events%ROWTYPE;
  amendment public.task_work_order_amendments%ROWTYPE;
  compensation public.universal_v1_change_order_compensation_commands%ROWTYPE;
  compensation_event public.task_financial_security_events%ROWTYPE;
  prepared public.universal_v1_prepared_financial_commands%ROWTYPE;
  journal public.financial_provider_command_journal%ROWTYPE;
  no_effect public.financial_provider_command_outcome_facts%ROWTYPE;
  latest_attempt_id UUID;
  derived_revocation_reason TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('universal-v1-change-order-proposal:' || NEW.proposal_id::TEXT, 0)
  );
  SELECT * INTO witness
    FROM public.universal_v1_change_order_materialization_commands command
   WHERE command.proposal_id = NEW.proposal_id
   FOR SHARE;
  IF witness.proposal_id IS NULL
     OR NOT public.universal_v1_change_order_recovery_lease_is_active_v1(
       NEW.proposal_id, NEW.recovery_lease_id, NEW.lease_owner_id
     )
     OR NEW.witness_request_sha256 IS DISTINCT FROM witness.request_sha256
     OR NEW.recorded_by IS DISTINCT FROM witness.actor_user_id THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-RECOVERY-6: terminal fact lacks its exact immutable Phase-A witness and lease'
      USING ERRCODE = 'P0001';
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended('fulfillment:' || witness.work_order_id::TEXT, 0)
  );

  NEW.terminal_fact_id := public.universal_v1_change_order_recovery_uuid_v1(
    witness.idempotency_key, 'terminal-fact'
  );
  NEW.witness_request_sha256 := witness.request_sha256;
  NEW.prior_secured_state_restored := FALSE;
  NEW.capture_resume_authorized := FALSE;
  NEW.payment_creation_performed := FALSE;
  NEW.hard_assignment_created := FALSE;
  NEW.recorded_by := witness.actor_user_id;
  NEW.recorded_at := clock_timestamp();

  IF NEW.outcome_state = 'MATERIALIZED'
     OR NEW.compensation_command_id IS NOT NULL THEN
    IF NEW.adjustment_event_id IS NULL THEN
      RAISE EXCEPTION 'HXUV1-CHANGE-RECOVERY-21: effect terminalization requires exact ADJUST success'
        USING ERRCODE = 'P0001';
    END IF;
    SELECT * INTO adjustment
      FROM public.task_financial_security_events financial
     WHERE financial.id = NEW.adjustment_event_id
     FOR SHARE;
    IF adjustment.id IS NULL
       OR adjustment.operation_id IS DISTINCT FROM witness.adjustment_operation_id::TEXT
       OR adjustment.idempotency_key IS DISTINCT FROM witness.idempotency_key || ':adjust'
       OR adjustment.event_kind <> 'ADJUSTMENT_AUTHORIZED'
       OR adjustment.status <> 'SUCCEEDED'
       OR adjustment.provider_kind <> 'FAKE'
       OR adjustment.expected_version <> witness.expected_financial_version + 1
       OR adjustment.task_draft_id IS DISTINCT FROM witness.task_draft_id
       OR adjustment.task_id IS DISTINCT FROM witness.task_id
       OR adjustment.eligibility_decision_id IS DISTINCT FROM witness.eligibility_decision_id
       OR adjustment.scope_version_id IS DISTINCT FROM witness.replacement_scope_version_id
       OR adjustment.change_order_id IS DISTINCT FROM witness.proposal_id
       OR adjustment.predecessor_event_id IS DISTINCT FROM witness.predecessor_event_id
       OR adjustment.amount_cents IS DISTINCT FROM witness.customer_total_cents
       OR adjustment.currency IS DISTINCT FROM witness.currency
       OR NOT EXISTS (
         SELECT 1
           FROM public.universal_v1_fake_financial_lifecycle_bridges bridge
          WHERE bridge.task_financial_security_event_id = adjustment.id
            AND bridge.fake_operation_id = witness.adjustment_operation_id
            AND bridge.fake_operation_kind = 'ADJUST'
            AND bridge.fake_provider_state = 'SUCCEEDED'
            AND bridge.lifecycle_event_kind = 'ADJUSTMENT_AUTHORIZED'
            AND bridge.lifecycle_status = 'SUCCEEDED'
       ) THEN
      RAISE EXCEPTION 'HXUV1-CHANGE-RECOVERY-21: effect terminalization requires exact ADJUST success'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF NEW.outcome_state = 'MATERIALIZED' THEN
    SELECT * INTO amendment
      FROM public.task_work_order_amendments materialized
     WHERE materialized.id = NEW.amendment_id
     FOR SHARE;
    IF amendment.id IS NULL
       OR amendment.change_order_id IS DISTINCT FROM witness.proposal_id
       OR amendment.work_order_id IS DISTINCT FROM witness.work_order_id
       OR amendment.scope_version_id IS DISTINCT FROM witness.replacement_scope_version_id
       OR amendment.adjustment_event_id IS DISTINCT FROM adjustment.id
       OR amendment.expected_financial_version IS DISTINCT FROM witness.expected_financial_version
       OR amendment.idempotency_key IS DISTINCT FROM witness.idempotency_key
       OR amendment.materialized_by IS DISTINCT FROM witness.actor_user_id
       OR NEW.compensation_command_id IS NOT NULL
       OR NEW.compensation_event_id IS NOT NULL
       OR NEW.no_effect_outcome_fact_id IS NOT NULL
       OR NEW.authority_revocation_reason IS NOT NULL THEN
      RAISE EXCEPTION 'HXUV1-CHANGE-RECOVERY-7: MATERIALIZED requires the exact amendment winner'
        USING ERRCODE = 'P0001';
    END IF;
    NEW.recovery_state := 'NOT_REQUIRED';
    NEW.resolution_evidence_kind := 'AMENDMENT';
    NEW.hold_clearance_kind := 'EXACT_AMENDMENT';
    NEW.execution_resume_authorized := TRUE;
  ELSIF NEW.outcome_state = 'CANCELLED'
        AND NEW.compensation_command_id IS NOT NULL THEN
    SELECT * INTO compensation
      FROM public.universal_v1_change_order_compensation_commands command
     WHERE command.compensation_command_id = NEW.compensation_command_id
     FOR SHARE;
    SELECT * INTO compensation_event
      FROM public.task_financial_security_events financial
     WHERE financial.id = NEW.compensation_event_id
     FOR SHARE;
    IF compensation.compensation_command_id IS NULL
       OR compensation_event.id IS NULL
       OR NEW.amendment_id IS NOT NULL
       OR compensation.proposal_id IS DISTINCT FROM witness.proposal_id
       OR compensation.witness_request_sha256 IS DISTINCT FROM witness.request_sha256
       OR compensation.adjustment_event_id IS DISTINCT FROM adjustment.id
       OR compensation_event.operation_id IS DISTINCT FROM compensation.reversal_operation_id::TEXT
       OR compensation_event.idempotency_key IS DISTINCT FROM compensation.reversal_idempotency_key
       OR compensation_event.event_kind <> 'REVERSED'
       OR compensation_event.status <> 'SUCCEEDED'
       OR compensation_event.provider_kind <> 'FAKE'
       OR compensation_event.expected_version <> compensation.lifecycle_expected_version
       OR compensation_event.task_draft_id IS DISTINCT FROM compensation.task_draft_id
       OR compensation_event.task_id IS DISTINCT FROM compensation.task_id
       OR compensation_event.eligibility_decision_id IS DISTINCT FROM
          compensation.eligibility_decision_id
       OR compensation_event.scope_version_id IS DISTINCT FROM compensation.base_scope_version_id
       OR compensation_event.change_order_id IS NOT NULL
       OR compensation_event.predecessor_event_id IS DISTINCT FROM adjustment.id
       OR compensation_event.amount_cents IS DISTINCT FROM compensation.amount_cents
       OR compensation_event.currency IS DISTINCT FROM compensation.currency
       OR compensation_event.recorded_by IS DISTINCT FROM compensation.requested_by
       OR NEW.no_effect_outcome_fact_id IS NOT NULL
       OR NEW.authority_revocation_reason IS NOT NULL
       OR NOT EXISTS (
         SELECT 1
           FROM public.universal_v1_fake_financial_lifecycle_bridges bridge
          WHERE bridge.task_financial_security_event_id = compensation_event.id
            AND bridge.fake_operation_id = compensation.reversal_operation_id
            AND bridge.fake_operation_kind = 'REVERSAL'
            AND bridge.fake_provider_state = 'REVERSED'
            AND bridge.lifecycle_event_kind = 'REVERSED'
            AND bridge.lifecycle_status = 'SUCCEEDED'
       )
       OR EXISTS (
         SELECT 1 FROM public.task_work_order_amendments materialized
          WHERE materialized.change_order_id = witness.proposal_id
       ) THEN
      RAISE EXCEPTION 'HXUV1-CHANGE-RECOVERY-8: CANCELLED requires exact bridged compensating fake REVERSAL success'
        USING ERRCODE = 'P0001';
    END IF;
    NEW.recovery_state := 'RECOVERY_REQUIRED';
    NEW.resolution_evidence_kind := 'REVERSAL';
    NEW.hold_clearance_kind := 'BOUNDED_CANCELLATION_RECOVERY';
    NEW.execution_resume_authorized := FALSE;
  ELSIF NEW.outcome_state = 'CANCELLED'
        AND NEW.compensation_command_id IS NULL
        AND NEW.compensation_event_id IS NULL THEN
    IF NEW.no_effect_outcome_fact_id IS NOT NULL THEN
      SELECT * INTO no_effect
        FROM public.financial_provider_command_outcome_facts outcome
       WHERE outcome.outcome_fact_id = NEW.no_effect_outcome_fact_id
       FOR SHARE;
      SELECT * INTO journal
        FROM public.financial_provider_command_journal requested
       WHERE requested.command_id = no_effect.command_id
       FOR SHARE;
      SELECT * INTO prepared
        FROM public.universal_v1_prepared_financial_commands authority
       WHERE authority.prepared_command_id = journal.prepared_financial_command_id
       FOR SHARE;
      SELECT attempt.dispatch_attempt_id INTO latest_attempt_id
        FROM public.financial_provider_command_dispatch_attempts attempt
       WHERE attempt.command_id = journal.command_id
       ORDER BY attempt.attempt_number DESC
       LIMIT 1;
      IF no_effect.outcome_fact_id IS NULL
         OR journal.command_id IS NULL
         OR prepared.prepared_command_id IS NULL
         OR no_effect.command_id IS DISTINCT FROM journal.command_id
         OR no_effect.dispatch_attempt_id IS DISTINCT FROM latest_attempt_id
         OR no_effect.effect_certainty <> 'CONFIRMED_NO_EFFECT'
         OR no_effect.retryable IS TRUE
         OR NOT (
           no_effect.outcome_kind = 'FAILED'
           OR (
             no_effect.outcome_kind = 'OUTCOME_OBSERVED'
             AND no_effect.provider_state IN ('DECLINED', 'FAILED')
           )
         )
         OR prepared.operation_kind <> 'ADJUST'
         OR prepared.operation_id IS DISTINCT FROM witness.adjustment_operation_id
         OR prepared.provider_kind <> 'FAKE'
         OR prepared.provider_expected_version <> 0
         OR prepared.lifecycle_expected_version <> witness.expected_financial_version + 1
         OR prepared.idempotency_key IS DISTINCT FROM witness.idempotency_key || ':adjust'
         OR prepared.task_draft_id IS DISTINCT FROM witness.task_draft_id
         OR prepared.task_id IS DISTINCT FROM witness.task_id
         OR prepared.eligibility_decision_id IS DISTINCT FROM witness.eligibility_decision_id
         OR prepared.scope_version_id IS DISTINCT FROM witness.replacement_scope_version_id
         OR prepared.change_order_id IS DISTINCT FROM witness.proposal_id
         OR prepared.predecessor_event_id IS DISTINCT FROM witness.predecessor_event_id
         OR prepared.related_operation_id IS DISTINCT FROM witness.predecessor_operation_id
         OR prepared.amount_cents IS DISTINCT FROM witness.customer_total_cents
         OR prepared.currency IS DISTINCT FROM witness.currency
         OR journal.operation_kind <> 'ADJUST'
         OR journal.operation_id IS DISTINCT FROM witness.adjustment_operation_id
         OR journal.idempotency_key IS DISTINCT FROM witness.idempotency_key || ':adjust'
         OR journal.provider_kind <> 'FAKE'
         OR journal.provider_expected_version <> 0
         OR journal.prepared_financial_command_id IS DISTINCT FROM prepared.prepared_command_id
         OR journal.prepared_authority_sha256 IS DISTINCT FROM prepared.authority_context_sha256
         OR EXISTS (
           SELECT 1 FROM public.task_work_order_amendments materialized
            WHERE materialized.change_order_id = witness.proposal_id
         ) THEN
        RAISE EXCEPTION 'HXUV1-CHANGE-RECOVERY-22: NO_EFFECT outcome is not the exact terminal ADJUST no-effect fact'
          USING ERRCODE = 'P0001';
      END IF;

      SELECT * INTO adjustment
        FROM public.task_financial_security_events financial
       WHERE financial.operation_id = witness.adjustment_operation_id::TEXT
         AND financial.idempotency_key = witness.idempotency_key || ':adjust'
         AND financial.expected_version = witness.expected_financial_version + 1
       LIMIT 1;
      IF adjustment.id IS NOT NULL AND (
        adjustment.event_kind <> 'ADJUSTMENT_AUTHORIZED'
        OR adjustment.status NOT IN ('DECLINED', 'FAILED')
        OR adjustment.provider_kind <> 'FAKE'
        OR adjustment.task_draft_id IS DISTINCT FROM witness.task_draft_id
        OR adjustment.task_id IS DISTINCT FROM witness.task_id
        OR adjustment.eligibility_decision_id IS DISTINCT FROM witness.eligibility_decision_id
        OR adjustment.scope_version_id IS DISTINCT FROM witness.replacement_scope_version_id
        OR adjustment.change_order_id IS DISTINCT FROM witness.proposal_id
        OR adjustment.predecessor_event_id IS DISTINCT FROM witness.predecessor_event_id
        OR NOT EXISTS (
          SELECT 1
            FROM public.universal_v1_fake_financial_lifecycle_bridges bridge
           WHERE bridge.task_financial_security_event_id = adjustment.id
             AND bridge.command_id = journal.command_id
             AND bridge.outcome_fact_id = no_effect.outcome_fact_id
             AND bridge.fake_operation_kind = 'ADJUST'
             AND bridge.fake_provider_state = no_effect.provider_state
             AND bridge.lifecycle_event_kind = 'ADJUSTMENT_AUTHORIZED'
             AND bridge.lifecycle_status = adjustment.status
        )
      ) THEN
        RAISE EXCEPTION 'HXUV1-CHANGE-RECOVERY-23: materialized NO_EFFECT lifecycle event is not exact'
          USING ERRCODE = 'P0001';
      END IF;
      NEW.adjustment_event_id := adjustment.id;
      NEW.authority_revocation_reason := NULL;
    ELSE
      derived_revocation_reason :=
        public.universal_v1_change_order_recovery_revocation_reason_v1(
          witness.proposal_id
        );
      IF NEW.authority_revocation_reason IS NULL
         OR NEW.authority_revocation_reason IS DISTINCT FROM derived_revocation_reason
         OR derived_revocation_reason IN (
           'AMENDMENT_CHAIN_CHANGED',
           'FINANCIAL_CHAIN_CHANGED',
           'WORK_ORDER_TERMINALIZED'
         )
         OR NEW.adjustment_event_id IS NOT NULL
         OR EXISTS (
           SELECT 1
             FROM public.universal_v1_prepared_financial_commands authority
             JOIN public.financial_provider_command_journal requested
               ON requested.prepared_financial_command_id = authority.prepared_command_id
             JOIN public.financial_provider_command_dispatch_attempts attempt
               ON attempt.command_id = requested.command_id
            WHERE authority.operation_kind = 'ADJUST'
              AND authority.operation_id = witness.adjustment_operation_id
              AND authority.idempotency_key = witness.idempotency_key || ':adjust'
         )
         OR EXISTS (
           SELECT 1 FROM public.task_work_order_amendments materialized
            WHERE materialized.change_order_id = witness.proposal_id
         ) THEN
        RAISE EXCEPTION 'HXUV1-CHANGE-RECOVERY-24: no-dispatch NO_EFFECT requires exact permanent authority revocation'
          USING ERRCODE = 'P0001';
      END IF;
      NEW.adjustment_event_id := NULL;
      NEW.no_effect_outcome_fact_id := NULL;
    END IF;
    NEW.recovery_state := 'RECOVERY_REQUIRED';
    NEW.resolution_evidence_kind := 'NO_EFFECT';
    NEW.hold_clearance_kind := 'BOUNDED_CANCELLATION_RECOVERY';
    NEW.execution_resume_authorized := FALSE;
  ELSE
    RAISE EXCEPTION 'HXUV1-CHANGE-RECOVERY-9: unsupported terminal outcome'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER universal_v1_change_order_recovery_terminal_guard
BEFORE INSERT ON public.universal_v1_change_order_recovery_terminal_facts
FOR EACH ROW EXECUTE FUNCTION public.validate_universal_v1_change_order_recovery_terminal_fact();

CREATE TRIGGER universal_v1_change_order_recovery_terminal_no_update_delete
BEFORE UPDATE OR DELETE ON public.universal_v1_change_order_recovery_terminal_facts
FOR EACH ROW EXECUTE FUNCTION public.reject_universal_v1_change_order_recovery_mutation();

CREATE TRIGGER universal_v1_change_order_recovery_terminal_no_truncate
BEFORE TRUNCATE ON public.universal_v1_change_order_recovery_terminal_facts
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_universal_v1_change_order_recovery_mutation();

-- Redefine migration 132's already-bound hold functions without changing its
-- file. MATERIALIZED resolves normally; CANCELLED is a permanent typed denial;
-- an unresolved witness remains held. No terminal path grants ordinary flow.
CREATE OR REPLACE FUNCTION public.prevent_execution_during_prepared_change_order()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('fulfillment:' || NEW.work_order_id::TEXT, 0)
  );
  IF EXISTS (
    SELECT 1
      FROM public.universal_v1_change_order_materialization_commands witness
      JOIN public.universal_v1_change_order_recovery_terminal_facts terminal
        ON terminal.proposal_id = witness.proposal_id
     WHERE witness.work_order_id = NEW.work_order_id
       AND terminal.outcome_state = 'CANCELLED'
       AND terminal.recovery_state = 'RECOVERY_REQUIRED'
  ) THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-RECOVERY-27: CANCELLED_RECOVERY_REQUIRED permits bounded recovery only, not execution'
      USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.universal_v1_change_order_materialization_commands witness
     WHERE witness.work_order_id = NEW.work_order_id
       AND NOT EXISTS (
         SELECT 1 FROM public.task_work_order_amendments amendment
          WHERE amendment.change_order_id = witness.proposal_id
       )
       AND NOT EXISTS (
         SELECT 1
           FROM public.universal_v1_change_order_recovery_terminal_facts terminal
          WHERE terminal.proposal_id = witness.proposal_id
            AND terminal.outcome_state = 'MATERIALIZED'
       )
  ) THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-3P-6: execution is held until the prepared amendment finalizes or terminally recovers'
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
    FROM public.tasks task_record
    JOIN public.task_work_orders work_order ON work_order.id = task_record.work_order_id
   WHERE task_record.id = NEW.task_id
   FOR SHARE OF task_record, work_order;
  IF checked_work_order_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('fulfillment:' || checked_work_order_id::TEXT, 0)
    );
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.universal_v1_change_order_materialization_commands witness
      JOIN public.universal_v1_change_order_recovery_terminal_facts terminal
        ON terminal.proposal_id = witness.proposal_id
     WHERE witness.task_id = NEW.task_id
       AND terminal.outcome_state = 'CANCELLED'
       AND terminal.recovery_state = 'RECOVERY_REQUIRED'
  ) THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-RECOVERY-28: CANCELLED_RECOVERY_REQUIRED permits bounded recovery only, not another proposal'
      USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.universal_v1_change_order_materialization_commands witness
     WHERE witness.task_id = NEW.task_id
       AND NOT EXISTS (
         SELECT 1 FROM public.task_work_order_amendments amendment
          WHERE amendment.change_order_id = witness.proposal_id
       )
       AND NOT EXISTS (
         SELECT 1
           FROM public.universal_v1_change_order_recovery_terminal_facts terminal
          WHERE terminal.proposal_id = witness.proposal_id
            AND terminal.outcome_state = 'MATERIALIZED'
       )
  ) THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-3P-7: a prepared amendment owns this Work Order until terminal resolution'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_universal_v1_change_order_recovery_v1(
  requested_lease_owner_id UUID,
  requested_limit INTEGER,
  requested_lease_duration_seconds INTEGER,
  minimum_age_seconds INTEGER
)
RETURNS TABLE (
  proposal_id UUID,
  recovery_lease_id UUID,
  lease_owner_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
VOLATILE
AS $$
DECLARE
  candidate RECORD;
  inserted_lease public.universal_v1_change_order_recovery_leases%ROWTYPE;
BEGIN
  IF requested_lease_owner_id IS NULL
     OR requested_limit IS NULL OR requested_limit < 1 OR requested_limit > 100
     OR requested_lease_duration_seconds IS NULL
     OR requested_lease_duration_seconds < 5
     OR requested_lease_duration_seconds > 900
     OR minimum_age_seconds IS NULL
     OR minimum_age_seconds < 5 OR minimum_age_seconds > 3600 THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-RECOVERY-10: recovery claim bounds are invalid'
      USING ERRCODE = '22023';
  END IF;

  FOR candidate IN
    SELECT command.proposal_id
      FROM public.universal_v1_change_order_materialization_commands command
     WHERE command.prepared_at <=
       clock_timestamp() - make_interval(secs => minimum_age_seconds)
       AND NOT EXISTS (
         SELECT 1
           FROM public.universal_v1_change_order_recovery_terminal_facts terminal
          WHERE terminal.proposal_id = command.proposal_id
       )
       AND NOT EXISTS (
         SELECT 1
           FROM public.universal_v1_change_order_recovery_leases active
          WHERE active.proposal_id = command.proposal_id
            AND active.expires_at > clock_timestamp()
       )
     ORDER BY command.prepared_at, command.proposal_id
     FOR UPDATE OF command SKIP LOCKED
     LIMIT requested_limit
  LOOP
    INSERT INTO public.universal_v1_change_order_recovery_leases (
      proposal_id, lease_owner_id, lease_duration_seconds, expires_at
    ) VALUES (
      candidate.proposal_id,
      requested_lease_owner_id,
      requested_lease_duration_seconds,
      clock_timestamp() + make_interval(secs => requested_lease_duration_seconds)
    )
    RETURNING * INTO inserted_lease;

    RETURN QUERY SELECT inserted_lease.proposal_id,
                        inserted_lease.recovery_lease_id,
                        inserted_lease.lease_owner_id;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_universal_v1_change_order_compensation_v1(
  checked_proposal_id UUID,
  checked_recovery_lease_id UUID,
  checked_lease_owner_id UUID,
  checked_adjustment_event_id UUID
)
RETURNS TABLE (
  resolution_kind TEXT,
  amendment_id UUID,
  adjustment_event_id UUID,
  compensation_command_id UUID,
  proposal_id UUID,
  witness_request_sha256 CHAR(64),
  task_draft_id UUID,
  task_id UUID,
  eligibility_decision_id UUID,
  base_scope_version_id UUID,
  adjustment_operation_id UUID,
  reversal_operation_id UUID,
  reversal_idempotency_key TEXT,
  lifecycle_expected_version BIGINT,
  amount_cents BIGINT,
  currency CHAR(3),
  requested_by UUID,
  created_at TIMESTAMPTZ,
  semantic_limitation TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
VOLATILE
AS $$
DECLARE
  witness public.universal_v1_change_order_materialization_commands%ROWTYPE;
  materialized public.task_work_order_amendments%ROWTYPE;
  compensation public.universal_v1_change_order_compensation_commands%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('universal-v1-change-order-proposal:' || checked_proposal_id::TEXT, 0)
  );
  IF NOT public.universal_v1_change_order_recovery_lease_is_active_v1(
    checked_proposal_id, checked_recovery_lease_id, checked_lease_owner_id
  ) THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-RECOVERY-11: compensation claim requires its active exact lease'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO witness
    FROM public.universal_v1_change_order_materialization_commands command
   WHERE command.proposal_id = checked_proposal_id
   FOR SHARE;
  IF witness.proposal_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('fulfillment:' || witness.work_order_id::TEXT, 0)
    );
  END IF;
  IF witness.proposal_id IS NULL OR NOT EXISTS (
    SELECT 1
      FROM public.task_financial_security_events adjustment
      JOIN public.universal_v1_fake_financial_lifecycle_bridges bridge
        ON bridge.task_financial_security_event_id = adjustment.id
     WHERE adjustment.id = checked_adjustment_event_id
       AND adjustment.operation_id = witness.adjustment_operation_id::TEXT
       AND adjustment.idempotency_key = witness.idempotency_key || ':adjust'
       AND adjustment.event_kind = 'ADJUSTMENT_AUTHORIZED'
       AND adjustment.status = 'SUCCEEDED'
       AND adjustment.provider_kind = 'FAKE'
       AND adjustment.expected_version = witness.expected_financial_version + 1
       AND adjustment.change_order_id = witness.proposal_id
       AND bridge.fake_operation_kind = 'ADJUST'
       AND bridge.fake_provider_state = 'SUCCEEDED'
       AND bridge.lifecycle_event_kind = 'ADJUSTMENT_AUTHORIZED'
       AND bridge.lifecycle_status = 'SUCCEEDED'
  ) THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-RECOVERY-12: compensation claim lacks exact bridged ADJUST success'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO materialized
    FROM public.task_work_order_amendments amendment
   WHERE amendment.change_order_id = checked_proposal_id
   FOR SHARE;
  IF materialized.id IS NOT NULL THEN
    RETURN QUERY SELECT
      'AMENDMENT_MATERIALIZED'::TEXT,
      materialized.id,
      checked_adjustment_event_id,
      NULL::UUID,
      checked_proposal_id,
      NULL::CHAR(64), NULL::UUID, NULL::UUID, NULL::UUID, NULL::UUID,
      NULL::UUID, NULL::UUID, NULL::TEXT, NULL::BIGINT, NULL::BIGINT,
      NULL::CHAR(3), NULL::UUID, NULL::TIMESTAMPTZ, NULL::TEXT;
    RETURN;
  END IF;

  IF public.universal_v1_change_order_recovery_revocation_reason_v1(
       checked_proposal_id
     ) IS NULL
     OR public.universal_v1_change_order_recovery_revocation_reason_v1(
       checked_proposal_id
     ) IN ('AMENDMENT_CHAIN_CHANGED', 'FINANCIAL_CHAIN_CHANGED') THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-RECOVERY-19: compensation requires exact permanent Phase-C revocation'
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.universal_v1_change_order_compensation_commands (
    proposal_id, recovery_lease_id, lease_owner_id,
    adjustment_event_id, requested_by, reason_code
  ) VALUES (
    checked_proposal_id, checked_recovery_lease_id, checked_lease_owner_id,
    checked_adjustment_event_id, witness.actor_user_id,
    'FINALIZATION_AUTHORITY_REVOKED'
  ) ON CONFLICT ON CONSTRAINT
      universal_v1_change_order_compensation_commands_proposal_id_key
    DO NOTHING;

  SELECT * INTO compensation
    FROM public.universal_v1_change_order_compensation_commands command
   WHERE command.proposal_id = checked_proposal_id
   FOR SHARE;
  IF compensation.compensation_command_id IS NULL
     OR compensation.adjustment_event_id IS DISTINCT FROM checked_adjustment_event_id
     OR compensation.witness_request_sha256 IS DISTINCT FROM witness.request_sha256 THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-RECOVERY-13: compensation winner identity conflicts'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN QUERY SELECT
    'COMPENSATE'::TEXT,
    NULL::UUID,
    compensation.adjustment_event_id,
    compensation.compensation_command_id,
    compensation.proposal_id,
    compensation.witness_request_sha256,
    compensation.task_draft_id,
    compensation.task_id,
    compensation.eligibility_decision_id,
    compensation.base_scope_version_id,
    compensation.adjustment_operation_id,
    compensation.reversal_operation_id,
    compensation.reversal_idempotency_key,
    compensation.lifecycle_expected_version,
    compensation.amount_cents,
    compensation.currency,
    compensation.requested_by,
    compensation.created_at,
    compensation.semantic_limitation;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_universal_v1_change_order_materialized_recovery_v1(
  checked_proposal_id UUID,
  checked_recovery_lease_id UUID,
  checked_lease_owner_id UUID,
  checked_amendment_id UUID,
  checked_adjustment_event_id UUID
)
RETURNS SETOF public.universal_v1_change_order_recovery_terminal_facts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
VOLATILE
AS $$
DECLARE
  witness public.universal_v1_change_order_materialization_commands%ROWTYPE;
  terminal public.universal_v1_change_order_recovery_terminal_facts%ROWTYPE;
BEGIN
  SELECT * INTO witness
    FROM public.universal_v1_change_order_materialization_commands command
   WHERE command.proposal_id = checked_proposal_id;
  INSERT INTO public.universal_v1_change_order_recovery_terminal_facts (
    proposal_id, witness_request_sha256, recovery_lease_id, lease_owner_id,
    outcome_state, recovery_state, amendment_id, adjustment_event_id,
    hold_clearance_kind, execution_resume_authorized, recorded_by
  ) VALUES (
    checked_proposal_id, witness.request_sha256, checked_recovery_lease_id,
    checked_lease_owner_id, 'MATERIALIZED', 'NOT_REQUIRED', checked_amendment_id,
    checked_adjustment_event_id, 'EXACT_AMENDMENT', TRUE, witness.actor_user_id
  ) ON CONFLICT (proposal_id) DO NOTHING;

  SELECT * INTO terminal
    FROM public.universal_v1_change_order_recovery_terminal_facts fact
   WHERE fact.proposal_id = checked_proposal_id;
  IF terminal.terminal_fact_id IS NULL
     OR terminal.outcome_state <> 'MATERIALIZED'
     OR terminal.amendment_id IS DISTINCT FROM checked_amendment_id
     OR terminal.adjustment_event_id IS DISTINCT FROM checked_adjustment_event_id THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-RECOVERY-14: materialized terminal winner conflicts'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEXT terminal;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_universal_v1_change_order_compensated_recovery_v1(
  checked_proposal_id UUID,
  checked_recovery_lease_id UUID,
  checked_lease_owner_id UUID,
  checked_compensation_command_id UUID,
  checked_compensation_event_id UUID
)
RETURNS SETOF public.universal_v1_change_order_recovery_terminal_facts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
VOLATILE
AS $$
DECLARE
  witness public.universal_v1_change_order_materialization_commands%ROWTYPE;
  compensation public.universal_v1_change_order_compensation_commands%ROWTYPE;
  terminal public.universal_v1_change_order_recovery_terminal_facts%ROWTYPE;
BEGIN
  SELECT * INTO witness
    FROM public.universal_v1_change_order_materialization_commands command
   WHERE command.proposal_id = checked_proposal_id;
  SELECT * INTO compensation
    FROM public.universal_v1_change_order_compensation_commands command
   WHERE command.compensation_command_id = checked_compensation_command_id;
  INSERT INTO public.universal_v1_change_order_recovery_terminal_facts (
    proposal_id, witness_request_sha256, recovery_lease_id, lease_owner_id,
    outcome_state, recovery_state, adjustment_event_id,
    compensation_command_id, compensation_event_id, hold_clearance_kind,
    execution_resume_authorized, recorded_by
  ) VALUES (
    checked_proposal_id, witness.request_sha256, checked_recovery_lease_id,
    checked_lease_owner_id, 'CANCELLED', 'RECOVERY_REQUIRED',
    compensation.adjustment_event_id, checked_compensation_command_id,
    checked_compensation_event_id, 'BOUNDED_CANCELLATION_RECOVERY', FALSE,
    witness.actor_user_id
  ) ON CONFLICT (proposal_id) DO NOTHING;

  SELECT * INTO terminal
    FROM public.universal_v1_change_order_recovery_terminal_facts fact
   WHERE fact.proposal_id = checked_proposal_id;
  IF terminal.terminal_fact_id IS NULL
     OR terminal.outcome_state <> 'CANCELLED'
     OR terminal.recovery_state <> 'RECOVERY_REQUIRED'
     OR terminal.compensation_command_id IS DISTINCT FROM checked_compensation_command_id
     OR terminal.compensation_event_id IS DISTINCT FROM checked_compensation_event_id THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-RECOVERY-15: compensated terminal winner conflicts'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEXT terminal;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_universal_v1_change_order_no_effect_recovery_v1(
  checked_proposal_id UUID,
  checked_recovery_lease_id UUID,
  checked_lease_owner_id UUID,
  checked_no_effect_outcome_fact_id UUID,
  checked_authority_revocation_reason TEXT
)
RETURNS SETOF public.universal_v1_change_order_recovery_terminal_facts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
VOLATILE
AS $$
DECLARE
  witness public.universal_v1_change_order_materialization_commands%ROWTYPE;
  observed_adjustment_id UUID;
  terminal public.universal_v1_change_order_recovery_terminal_facts%ROWTYPE;
BEGIN
  IF num_nonnulls(
    checked_no_effect_outcome_fact_id,
    checked_authority_revocation_reason
  ) <> 1 THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-RECOVERY-25: NO_EFFECT requires exactly one evidence source'
      USING ERRCODE = '22023';
  END IF;
  SELECT * INTO witness
    FROM public.universal_v1_change_order_materialization_commands command
   WHERE command.proposal_id = checked_proposal_id;
  IF checked_no_effect_outcome_fact_id IS NOT NULL THEN
    SELECT financial.id INTO observed_adjustment_id
      FROM public.task_financial_security_events financial
     WHERE financial.operation_id = witness.adjustment_operation_id::TEXT
       AND financial.idempotency_key = witness.idempotency_key || ':adjust'
       AND financial.expected_version = witness.expected_financial_version + 1
     LIMIT 1;
  END IF;

  INSERT INTO public.universal_v1_change_order_recovery_terminal_facts (
    proposal_id, witness_request_sha256, recovery_lease_id, lease_owner_id,
    outcome_state, recovery_state, adjustment_event_id,
    no_effect_outcome_fact_id, authority_revocation_reason,
    resolution_evidence_kind, hold_clearance_kind,
    execution_resume_authorized, recorded_by
  ) VALUES (
    checked_proposal_id, witness.request_sha256, checked_recovery_lease_id,
    checked_lease_owner_id, 'CANCELLED', 'RECOVERY_REQUIRED',
    observed_adjustment_id, checked_no_effect_outcome_fact_id,
    checked_authority_revocation_reason, 'NO_EFFECT',
    'BOUNDED_CANCELLATION_RECOVERY', FALSE, witness.actor_user_id
  ) ON CONFLICT (proposal_id) DO NOTHING;

  SELECT * INTO terminal
    FROM public.universal_v1_change_order_recovery_terminal_facts fact
   WHERE fact.proposal_id = checked_proposal_id;
  IF terminal.terminal_fact_id IS NULL
     OR terminal.outcome_state <> 'CANCELLED'
     OR terminal.recovery_state <> 'RECOVERY_REQUIRED'
     OR terminal.resolution_evidence_kind <> 'NO_EFFECT'
     OR terminal.no_effect_outcome_fact_id IS DISTINCT FROM
        checked_no_effect_outcome_fact_id
     OR terminal.authority_revocation_reason IS DISTINCT FROM
        checked_authority_revocation_reason THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-RECOVERY-26: NO_EFFECT terminal winner conflicts'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEXT terminal;
END;
$$;

-- Later hold integration must use this exact predicate. This migration does
-- not weaken migration 132's existing hold triggers. In particular, a terminal
-- compensated fact permits bounded cancellation/recovery commands only; it is
-- not ordinary execution or new-change-order authority.
CREATE OR REPLACE FUNCTION public.universal_v1_change_order_recovery_resolution_v1(
  checked_proposal_id UUID
)
RETURNS TEXT
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN EXISTS (
      SELECT 1
        FROM public.task_work_order_amendments amendment
        JOIN public.universal_v1_change_order_materialization_commands witness
          ON witness.proposal_id = amendment.change_order_id
       WHERE witness.proposal_id = checked_proposal_id
         AND amendment.scope_version_id = witness.replacement_scope_version_id
         AND amendment.adjustment_event_id IS NOT NULL
    ) THEN 'AMENDMENT_MATERIALIZED'
    WHEN EXISTS (
      SELECT 1
        FROM public.universal_v1_change_order_recovery_terminal_facts terminal
       WHERE terminal.proposal_id = checked_proposal_id
         AND terminal.outcome_state = 'CANCELLED'
         AND terminal.recovery_state = 'RECOVERY_REQUIRED'
         AND terminal.hold_clearance_kind = 'BOUNDED_CANCELLATION_RECOVERY'
         AND terminal.prior_secured_state_restored = FALSE
         AND terminal.execution_resume_authorized = FALSE
         AND terminal.capture_resume_authorized = FALSE
    ) THEN 'CANCELLED_RECOVERY_REQUIRED'
    ELSE NULL
  END;
$$;

COMMENT ON TABLE public.universal_v1_change_order_compensation_commands IS
  'Append-only exact fake REVERSAL authority after successful ADJUST and permanent Phase-C revocation; not restore, execution, capture, or production authority.';
COMMENT ON TABLE public.universal_v1_change_order_recovery_terminal_facts IS
  'Append-only MATERIALIZED or CANCELLED/RECOVERY_REQUIRED fact; cancellation requires exact bridged fake REVERSAL or exact confirmed NO_EFFECT evidence.';
COMMENT ON FUNCTION public.universal_v1_change_order_recovery_resolution_v1(UUID) IS
  'Exact resolution for later hold integration. CANCELLED_RECOVERY_REQUIRED permits bounded cancellation/recovery only, never ordinary execution.';
COMMENT ON TABLE public.hxos_fake_financial_schema_evidence_v7 IS
  'Append-only checksum evidence for the nonproduction fake change-order recovery fixture.';

REVOKE ALL ON TABLE public.hxos_fake_financial_schema_evidence_v7 FROM PUBLIC;
REVOKE ALL ON TABLE public.universal_v1_change_order_recovery_leases FROM PUBLIC;
REVOKE ALL ON TABLE public.universal_v1_change_order_compensation_commands FROM PUBLIC;
REVOKE ALL ON TABLE public.universal_v1_change_order_recovery_terminal_facts FROM PUBLIC;
REVOKE ALL ON FUNCTION public.universal_v1_change_order_recovery_uuid_v1(TEXT, TEXT)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.universal_v1_change_order_recovery_lease_is_active_v1(
  UUID, UUID, UUID
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.universal_v1_change_order_recovery_revocation_reason_v1(UUID)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_universal_v1_change_order_recovery_v1(
  UUID, INTEGER, INTEGER, INTEGER
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_universal_v1_change_order_compensation_v1(
  UUID, UUID, UUID, UUID
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_universal_v1_change_order_materialized_recovery_v1(
  UUID, UUID, UUID, UUID, UUID
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_universal_v1_change_order_compensated_recovery_v1(
  UUID, UUID, UUID, UUID, UUID
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_universal_v1_change_order_no_effect_recovery_v1(
  UUID, UUID, UUID, UUID, TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.universal_v1_change_order_recovery_resolution_v1(UUID)
  FROM PUBLIC;

-- No runtime-role grant is made here. The deployment authority must grant only
-- SELECT plus these typed SECURITY DEFINER entry points to its independently
-- attested non-owner worker role. The migration owner retains owner privileges;
-- it is not a valid runtime-role test subject.
