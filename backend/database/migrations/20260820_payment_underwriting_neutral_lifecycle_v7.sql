-- HX payment-underwriting v7 neutral schema.
--
-- This schema artifact is intentionally absent from the startup migration
-- registry while migrations and application queries share one DATABASE_URL
-- principal. Registering it requires a separately proven runtime role boundary
-- plus evidence-bound SECURITY DEFINER callables from later dependency slices.
-- It records immutable canonical identities and planned operations only.

CREATE UNIQUE INDEX IF NOT EXISTS task_drafts_id_poster_user_id_uq
  ON task_drafts(id, poster_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS task_drafts_id_poster_user_id_task_id_uq
  ON task_drafts(id, poster_user_id, task_id);
CREATE UNIQUE INDEX IF NOT EXISTS tasks_id_poster_id_uq
  ON tasks(id, poster_id);

CREATE TABLE IF NOT EXISTS payment_underwriting_lifecycles_v7 (
  lifecycle_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_draft_id UUID NOT NULL UNIQUE REFERENCES task_drafts(id) ON DELETE RESTRICT,
  request_id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  pricing_lane TEXT NOT NULL CHECK (pricing_lane IN ('PLATFORM_PRICED', 'PROVIDER_ESTIMATE')),
  contract_version INTEGER NOT NULL DEFAULT 7 CHECK (contract_version = 7),
  authority_document_id TEXT NOT NULL CHECK (authority_document_id = '1PYpWdbnlhRBoovc6GfTyxMuu1IzMIdDQpV6hHHraXaQ'),
  authority_drive_revision TEXT NOT NULL CHECK (authority_drive_revision = '7'),
  authority_docs_revision TEXT NOT NULL CHECK (authority_docs_revision = 'AIroW37g_sqKNU_dvvRNUndw-qUeooFwAYIHqN60aHvPSR178sKjMMu5rMzGTzODqgDKERue3ZbAT8UesInsUZvT6p1Z0bUvPByrgwaPDA'),
  authority_text_sha256 CHAR(64) NOT NULL CHECK (authority_text_sha256 = 'ba8dc04bfc43feb24bd78698c6e5b820ecdf22177f915fb04856a55d8076bd26'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (lifecycle_id, task_draft_id)
);

CREATE TABLE IF NOT EXISTS payment_underwriting_lifecycle_events_v7 (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lifecycle_id UUID NOT NULL REFERENCES payment_underwriting_lifecycles_v7(lifecycle_id) ON DELETE RESTRICT,
  task_draft_id UUID NOT NULL,
  sequence_number INTEGER NOT NULL CHECK (sequence_number > 0),
  prior_event_id UUID REFERENCES payment_underwriting_lifecycle_events_v7(event_id) ON DELETE RESTRICT,
  command_id UUID NOT NULL UNIQUE,
  stage TEXT NOT NULL CHECK (stage IN (
    'TASK_DRAFT', 'SCOPE_READY', 'QUOTED', 'ESTIMATE_REQUIRED',
    'QUOTE_APPROVED', 'PAYMENT_METHOD_READY', 'PROVIDER_SOURCING',
    'PAYMENT_ELIGIBLE', 'PROVIDER_SOFT_RESERVED',
    'FINANCIAL_SECURITY_PENDING', 'FINANCIALLY_SECURED',
    'WORK_ORDER_MATERIALIZED', 'ASSIGNED', 'IN_PROGRESS',
    'COMPLETION_SUBMITTED', 'CAPTURE_PENDING', 'CAPTURED', 'SETTLING',
    'PAYOUT_PENDING', 'FUNDED', 'PAID_OUT', 'RECONCILED', 'CLOSED'
  )),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('POSTER', 'PROVIDER', 'SYSTEM', 'ADMIN', 'WEBHOOK', 'RECONCILER')),
  actor_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  poster_user_id UUID,
  evidence_sha256 CHAR(64) NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  event_material JSONB NOT NULL CHECK (jsonb_typeof(event_material) = 'object'),
  event_sha256 CHAR(64) NOT NULL UNIQUE CHECK (event_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (lifecycle_id, sequence_number),
  FOREIGN KEY (lifecycle_id, task_draft_id)
    REFERENCES payment_underwriting_lifecycles_v7(lifecycle_id, task_draft_id) ON DELETE RESTRICT,
  FOREIGN KEY (task_draft_id, poster_user_id)
    REFERENCES task_drafts(id, poster_user_id) ON DELETE RESTRICT,
  CHECK (
    (
      actor_type = 'POSTER'
      AND actor_user_id IS NOT NULL
      AND poster_user_id IS NOT NULL
      AND poster_user_id = actor_user_id
    )
    OR (
      actor_type IN ('PROVIDER', 'ADMIN')
      AND actor_user_id IS NOT NULL
      AND poster_user_id IS NULL
    )
    OR (
      actor_type IN ('SYSTEM', 'WEBHOOK', 'RECONCILER')
      AND actor_user_id IS NULL
      AND poster_user_id IS NULL
    )
  )
);

CREATE TABLE IF NOT EXISTS payment_task_opportunities_v7 (
  opportunity_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lifecycle_id UUID NOT NULL REFERENCES payment_underwriting_lifecycles_v7(lifecycle_id) ON DELETE RESTRICT,
  scope_sha256 CHAR(64) NOT NULL CHECK (scope_sha256 ~ '^[0-9a-f]{64}$'),
  economics_corridor_sha256 CHAR(64) NOT NULL CHECK (economics_corridor_sha256 ~ '^[0-9a-f]{64}$'),
  preview_sha256 CHAR(64) NOT NULL CHECK (preview_sha256 ~ '^[0-9a-f]{64}$'),
  recipient_binding_sha256 CHAR(64) CHECK (recipient_binding_sha256 IS NULL OR recipient_binding_sha256 ~ '^[0-9a-f]{64}$'),
  state TEXT NOT NULL CHECK (state IN ('OPEN', 'EXPIRED', 'REVOKED', 'FILLED')),
  expires_at TIMESTAMPTZ NOT NULL,
  evidence_sha256 CHAR(64) NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (opportunity_id, lifecycle_id)
);

CREATE TABLE IF NOT EXISTS payment_provider_account_refs_v7 (
  provider_account_ref_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  processor_code TEXT NOT NULL CHECK (processor_code ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  external_reference_sha256 CHAR(64) NOT NULL CHECK (external_reference_sha256 ~ '^[0-9a-f]{64}$'),
  eligibility_state TEXT NOT NULL CHECK (eligibility_state IN ('ELIGIBLE', 'RESTRICTED', 'TERMINATED')),
  merchant_capabilities JSONB NOT NULL CHECK (jsonb_typeof(merchant_capabilities) = 'object'),
  funding_state TEXT NOT NULL CHECK (funding_state IN ('READY', 'PENDING', 'RESTRICTED', 'UNKNOWN')),
  restrictions_sha256 CHAR(64) NOT NULL CHECK (restrictions_sha256 ~ '^[0-9a-f]{64}$'),
  bank_reference_sha256 CHAR(64) CHECK (bank_reference_sha256 IS NULL OR bank_reference_sha256 ~ '^[0-9a-f]{64}$'),
  evidence_sha256 CHAR(64) NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  observed_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (processor_code, external_reference_sha256, observed_at),
  UNIQUE (provider_account_ref_id, processor_code),
  UNIQUE (provider_account_ref_id, provider_user_id)
);

CREATE TABLE IF NOT EXISTS payment_conditional_provider_holds_v7 (
  hold_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lifecycle_id UUID NOT NULL REFERENCES payment_underwriting_lifecycles_v7(lifecycle_id) ON DELETE RESTRICT,
  opportunity_id UUID NOT NULL,
  provider_account_ref_id UUID NOT NULL REFERENCES payment_provider_account_refs_v7(provider_account_ref_id) ON DELETE RESTRICT,
  scope_sha256 CHAR(64) NOT NULL CHECK (scope_sha256 ~ '^[0-9a-f]{64}$'),
  provider_economics_sha256 CHAR(64) NOT NULL CHECK (provider_economics_sha256 ~ '^[0-9a-f]{64}$'),
  schedule_sha256 CHAR(64) NOT NULL CHECK (schedule_sha256 ~ '^[0-9a-f]{64}$'),
  state TEXT NOT NULL CHECK (state IN ('SOFT_RESERVED', 'RELEASED', 'EXPIRED', 'CONSUMED')),
  accepted_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL CHECK (expires_at > accepted_at),
  evidence_sha256 CHAR(64) NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (hold_id, lifecycle_id, provider_account_ref_id),
  FOREIGN KEY (opportunity_id, lifecycle_id)
    REFERENCES payment_task_opportunities_v7(opportunity_id, lifecycle_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS payment_method_refs_v7 (
  payment_method_ref_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  processor_code TEXT NOT NULL CHECK (processor_code ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  external_reference_sha256 CHAR(64) NOT NULL CHECK (external_reference_sha256 ~ '^[0-9a-f]{64}$'),
  safe_metadata JSONB NOT NULL CHECK (jsonb_typeof(safe_metadata) = 'object'),
  consent_sha256 CHAR(64) NOT NULL CHECK (consent_sha256 ~ '^[0-9a-f]{64}$'),
  portability_scope TEXT NOT NULL CHECK (portability_scope IN ('NONE', 'SAME_MERCHANT_CONTEXT', 'APPROVED_CROSS_CONTEXT')),
  state TEXT NOT NULL CHECK (state IN ('READY', 'REVOKED', 'EXPIRED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (processor_code, external_reference_sha256),
  UNIQUE (payment_method_ref_id, customer_user_id, processor_code)
);

CREATE TABLE IF NOT EXISTS payment_financial_security_events_v7 (
  financial_security_event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lifecycle_id UUID NOT NULL REFERENCES payment_underwriting_lifecycles_v7(lifecycle_id) ON DELETE RESTRICT,
  task_draft_id UUID NOT NULL,
  customer_user_id UUID NOT NULL,
  hold_id UUID NOT NULL,
  provider_account_ref_id UUID NOT NULL,
  payment_method_ref_id UUID NOT NULL,
  processor_code TEXT NOT NULL CHECK (processor_code ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  merchant_context_sha256 CHAR(64) NOT NULL CHECK (merchant_context_sha256 ~ '^[0-9a-f]{64}$'),
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[a-z]{3}$'),
  fee_routing_sha256 CHAR(64) NOT NULL CHECK (fee_routing_sha256 ~ '^[0-9a-f]{64}$'),
  operation_id UUID NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 16 AND 160),
  state TEXT NOT NULL DEFAULT 'PLANNED' CHECK (state = 'PLANNED'),
  request_sha256 CHAR(64) NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (financial_security_event_id, lifecycle_id, provider_account_ref_id, processor_code),
  UNIQUE (
    financial_security_event_id, lifecycle_id, task_draft_id, customer_user_id,
    provider_account_ref_id, processor_code
  ),
  FOREIGN KEY (lifecycle_id, task_draft_id)
    REFERENCES payment_underwriting_lifecycles_v7(lifecycle_id, task_draft_id) ON DELETE RESTRICT,
  FOREIGN KEY (task_draft_id, customer_user_id)
    REFERENCES task_drafts(id, poster_user_id) ON DELETE RESTRICT,
  FOREIGN KEY (hold_id, lifecycle_id, provider_account_ref_id)
    REFERENCES payment_conditional_provider_holds_v7(hold_id, lifecycle_id, provider_account_ref_id) ON DELETE RESTRICT,
  FOREIGN KEY (provider_account_ref_id, processor_code)
    REFERENCES payment_provider_account_refs_v7(provider_account_ref_id, processor_code) ON DELETE RESTRICT,
  FOREIGN KEY (payment_method_ref_id, customer_user_id, processor_code)
    REFERENCES payment_method_refs_v7(payment_method_ref_id, customer_user_id, processor_code) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS payment_canonical_work_orders_v7 (
  work_order_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lifecycle_id UUID NOT NULL UNIQUE REFERENCES payment_underwriting_lifecycles_v7(lifecycle_id) ON DELETE RESTRICT,
  task_draft_id UUID NOT NULL,
  customer_user_id UUID NOT NULL,
  financial_security_event_id UUID NOT NULL UNIQUE,
  provider_account_ref_id UUID NOT NULL,
  processor_code TEXT NOT NULL CHECK (processor_code ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  task_id UUID NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE RESTRICT,
  assigned_provider_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  scope_sha256 CHAR(64) NOT NULL CHECK (scope_sha256 ~ '^[0-9a-f]{64}$'),
  economics_sha256 CHAR(64) NOT NULL CHECK (economics_sha256 ~ '^[0-9a-f]{64}$'),
  materialization_command_id UUID NOT NULL UNIQUE,
  materialization_sha256 CHAR(64) NOT NULL UNIQUE CHECK (materialization_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (work_order_id, lifecycle_id, financial_security_event_id, processor_code),
  UNIQUE (
    work_order_id, lifecycle_id, task_draft_id, customer_user_id,
    financial_security_event_id, processor_code
  ),
  FOREIGN KEY (
    financial_security_event_id, lifecycle_id, task_draft_id, customer_user_id,
    provider_account_ref_id, processor_code
  ) REFERENCES payment_financial_security_events_v7(
    financial_security_event_id, lifecycle_id, task_draft_id, customer_user_id,
    provider_account_ref_id, processor_code
  ) ON DELETE RESTRICT,
  FOREIGN KEY (task_draft_id, customer_user_id, task_id)
    REFERENCES task_drafts(id, poster_user_id, task_id) ON DELETE RESTRICT,
  FOREIGN KEY (task_id, customer_user_id)
    REFERENCES tasks(id, poster_id) ON DELETE RESTRICT,
  FOREIGN KEY (provider_account_ref_id, assigned_provider_user_id)
    REFERENCES payment_provider_account_refs_v7(provider_account_ref_id, provider_user_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS payment_captures_v7 (
  capture_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lifecycle_id UUID NOT NULL REFERENCES payment_underwriting_lifecycles_v7(lifecycle_id) ON DELETE RESTRICT,
  work_order_id UUID NOT NULL,
  financial_security_event_id UUID NOT NULL,
  processor_code TEXT NOT NULL CHECK (processor_code ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  approved_amount_cents BIGINT NOT NULL CHECK (approved_amount_cents > 0),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[a-z]{3}$'),
  completion_evidence_sha256 CHAR(64) NOT NULL CHECK (completion_evidence_sha256 ~ '^[0-9a-f]{64}$'),
  amount_approval_sha256 CHAR(64) NOT NULL CHECK (amount_approval_sha256 ~ '^[0-9a-f]{64}$'),
  incident_clearance_sha256 CHAR(64) NOT NULL CHECK (incident_clearance_sha256 ~ '^[0-9a-f]{64}$'),
  operation_id UUID NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 16 AND 160),
  state TEXT NOT NULL DEFAULT 'PLANNED' CHECK (state = 'PLANNED'),
  request_sha256 CHAR(64) NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (capture_id, lifecycle_id, processor_code),
  FOREIGN KEY (work_order_id, lifecycle_id, financial_security_event_id, processor_code)
    REFERENCES payment_canonical_work_orders_v7(work_order_id, lifecycle_id, financial_security_event_id, processor_code) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS payment_ledger_transactions_v7 (
  ledger_transaction_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lifecycle_id UUID NOT NULL REFERENCES payment_underwriting_lifecycles_v7(lifecycle_id) ON DELETE RESTRICT,
  transaction_type TEXT NOT NULL CHECK (transaction_type IN ('AUTHORIZATION', 'CAPTURE', 'SETTLEMENT', 'PAYOUT', 'REFUND', 'LOSS', 'ADJUSTMENT', 'REVERSAL')),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[a-z]{3}$'),
  state TEXT NOT NULL CHECK (state IN ('PENDING', 'POSTED', 'REVERSED')),
  source_operation_id UUID NOT NULL UNIQUE,
  material_sha256 CHAR(64) NOT NULL UNIQUE CHECK (material_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS payment_ledger_entries_v7 (
  ledger_entry_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ledger_transaction_id UUID NOT NULL REFERENCES payment_ledger_transactions_v7(ledger_transaction_id) ON DELETE RESTRICT,
  account_code TEXT NOT NULL CHECK (account_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  direction TEXT NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  entry_sha256 CHAR(64) NOT NULL UNIQUE CHECK (entry_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS payment_settlement_records_v7 (
  settlement_record_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lifecycle_id UUID NOT NULL REFERENCES payment_underwriting_lifecycles_v7(lifecycle_id) ON DELETE RESTRICT,
  capture_id UUID NOT NULL,
  processor_code TEXT NOT NULL CHECK (processor_code ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  state TEXT NOT NULL CHECK (state IN ('SETTLING', 'PAYOUT_PENDING', 'FUNDED', 'PAID_OUT', 'FAILED', 'RETURNED')),
  customer_amount_cents BIGINT NOT NULL CHECK (customer_amount_cents > 0),
  provider_amount_cents BIGINT NOT NULL CHECK (provider_amount_cents >= 0),
  platform_amount_cents BIGINT NOT NULL CHECK (platform_amount_cents >= 0),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[a-z]{3}$'),
  external_reference_sha256 CHAR(64) NOT NULL CHECK (external_reference_sha256 ~ '^[0-9a-f]{64}$'),
  evidence_sha256 CHAR(64) NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (capture_id, lifecycle_id, processor_code)
    REFERENCES payment_captures_v7(capture_id, lifecycle_id, processor_code) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS payment_webhook_inbox_v7 (
  webhook_inbox_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  processor_code TEXT NOT NULL CHECK (processor_code ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  event_id_sha256 CHAR(64) NOT NULL CHECK (event_id_sha256 ~ '^[0-9a-f]{64}$'),
  payload_sha256 CHAR(64) NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  authentication_state TEXT NOT NULL CHECK (authentication_state IN ('VERIFIED', 'REJECTED')),
  normalized_event_type TEXT,
  processing_state TEXT NOT NULL CHECK (processing_state IN ('RECEIVED', 'NORMALIZED', 'APPLIED', 'REJECTED', 'DEAD_LETTER')),
  received_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (processor_code, event_id_sha256)
);

CREATE TABLE IF NOT EXISTS payment_reconciliation_runs_v7 (
  reconciliation_run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  processor_code TEXT NOT NULL CHECK (processor_code ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL CHECK (period_end > period_start),
  state TEXT NOT NULL CHECK (state IN ('PLANNED', 'RUNNING', 'EXCEPTION', 'COMPLETED')),
  source_material_sha256 CHAR(64) NOT NULL CHECK (source_material_sha256 ~ '^[0-9a-f]{64}$'),
  result_sha256 CHAR(64) CHECK (result_sha256 IS NULL OR result_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (processor_code, period_start, period_end)
);

CREATE TABLE IF NOT EXISTS payment_legacy_classifications_v7 (
  legacy_classification_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_draft_id UUID REFERENCES task_drafts(id) ON DELETE RESTRICT,
  task_id UUID REFERENCES tasks(id) ON DELETE RESTRICT,
  escrow_id UUID REFERENCES escrows(id) ON DELETE RESTRICT,
  quote_payment_id UUID REFERENCES quote_payments(id) ON DELETE RESTRICT,
  processor_code TEXT NOT NULL CHECK (processor_code ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  legacy_path TEXT NOT NULL CHECK (legacy_path = 'CAPTURE_BEFORE_PROVIDER'),
  disposition TEXT NOT NULL CHECK (disposition IN ('RECOVERY_ONLY', 'REFUND_VOID_DISPUTE_ONLY', 'FROZEN_NEW_MONEY')),
  classification_sha256 CHAR(64) NOT NULL UNIQUE CHECK (classification_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (num_nonnulls(task_draft_id, task_id, escrow_id, quote_payment_id) > 0)
);

CREATE OR REPLACE FUNCTION hxos_reject_payment_underwriting_event_mutation_v7()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'HXPV1: payment underwriting v7 evidence is append-only'
    USING ERRCODE = 'P0001';
END;
$$;

CREATE OR REPLACE FUNCTION hxos_enforce_payment_underwriting_transition_v7()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  lifecycle_record payment_underwriting_lifecycles_v7%ROWTYPE;
  latest_event payment_underwriting_lifecycle_events_v7%ROWTYPE;
  allowed_stages TEXT[];
BEGIN
  SELECT *
  INTO lifecycle_record
  FROM payment_underwriting_lifecycles_v7
  WHERE lifecycle_id = NEW.lifecycle_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'HXPV2: payment underwriting lifecycle does not exist'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT *
  INTO latest_event
  FROM payment_underwriting_lifecycle_events_v7
  WHERE lifecycle_id = NEW.lifecycle_id
  ORDER BY sequence_number DESC
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    IF NEW.sequence_number <> 1
      OR NEW.prior_event_id IS NOT NULL
      OR NEW.stage <> 'TASK_DRAFT'
    THEN
      RAISE EXCEPTION 'HXPV3: lifecycle must begin at TASK_DRAFT sequence 1 without a predecessor'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.sequence_number <> latest_event.sequence_number + 1
    OR NEW.prior_event_id IS DISTINCT FROM latest_event.event_id
  THEN
    RAISE EXCEPTION 'HXPV4: lifecycle transition must bind the exact latest event and next sequence'
      USING ERRCODE = 'P0001';
  END IF;

  allowed_stages := CASE latest_event.stage
    WHEN 'TASK_DRAFT' THEN ARRAY['SCOPE_READY']
    WHEN 'SCOPE_READY' THEN CASE
      WHEN lifecycle_record.pricing_lane = 'PLATFORM_PRICED' THEN ARRAY['QUOTED']
      WHEN lifecycle_record.pricing_lane = 'PROVIDER_ESTIMATE' THEN ARRAY['ESTIMATE_REQUIRED']
      ELSE ARRAY[]::TEXT[]
    END
    WHEN 'QUOTED' THEN ARRAY['QUOTE_APPROVED']
    WHEN 'ESTIMATE_REQUIRED' THEN ARRAY['QUOTE_APPROVED']
    WHEN 'QUOTE_APPROVED' THEN ARRAY['PAYMENT_METHOD_READY']
    WHEN 'PAYMENT_METHOD_READY' THEN ARRAY['PROVIDER_SOURCING']
    WHEN 'PROVIDER_SOURCING' THEN ARRAY['PAYMENT_ELIGIBLE']
    WHEN 'PAYMENT_ELIGIBLE' THEN ARRAY['PROVIDER_SOFT_RESERVED']
    WHEN 'PROVIDER_SOFT_RESERVED' THEN ARRAY['FINANCIAL_SECURITY_PENDING']
    WHEN 'FINANCIAL_SECURITY_PENDING' THEN ARRAY['FINANCIALLY_SECURED']
    WHEN 'FINANCIALLY_SECURED' THEN ARRAY['WORK_ORDER_MATERIALIZED']
    WHEN 'WORK_ORDER_MATERIALIZED' THEN ARRAY['ASSIGNED']
    WHEN 'ASSIGNED' THEN ARRAY['IN_PROGRESS']
    WHEN 'IN_PROGRESS' THEN ARRAY['COMPLETION_SUBMITTED']
    WHEN 'COMPLETION_SUBMITTED' THEN ARRAY['CAPTURE_PENDING']
    WHEN 'CAPTURE_PENDING' THEN ARRAY['CAPTURED']
    WHEN 'CAPTURED' THEN ARRAY['SETTLING', 'PAYOUT_PENDING']
    WHEN 'SETTLING' THEN ARRAY['FUNDED']
    WHEN 'PAYOUT_PENDING' THEN ARRAY['PAID_OUT']
    WHEN 'FUNDED' THEN ARRAY['RECONCILED']
    WHEN 'PAID_OUT' THEN ARRAY['RECONCILED']
    WHEN 'RECONCILED' THEN ARRAY['CLOSED']
    WHEN 'CLOSED' THEN ARRAY[]::TEXT[]
    ELSE ARRAY[]::TEXT[]
  END;

  IF NOT (NEW.stage = ANY(allowed_stages)) THEN
    RAISE EXCEPTION 'HXPV5: illegal payment underwriting transition % -> %',
      latest_event.stage,
      NEW.stage
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DO $$
DECLARE
  relation_name TEXT;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'payment_underwriting_lifecycles_v7',
    'payment_underwriting_lifecycle_events_v7',
    'payment_task_opportunities_v7',
    'payment_provider_account_refs_v7',
    'payment_conditional_provider_holds_v7',
    'payment_method_refs_v7',
    'payment_financial_security_events_v7',
    'payment_canonical_work_orders_v7',
    'payment_captures_v7',
    'payment_ledger_transactions_v7',
    'payment_ledger_entries_v7',
    'payment_settlement_records_v7',
    'payment_webhook_inbox_v7',
    'payment_reconciliation_runs_v7',
    'payment_legacy_classifications_v7'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', relation_name || '_append_only_v7', relation_name);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE OR TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION hxos_reject_payment_underwriting_event_mutation_v7()',
      relation_name || '_append_only_v7',
      relation_name
    );
  END LOOP;
END;
$$;

DROP TRIGGER IF EXISTS payment_underwriting_lifecycle_transition_guard_v7
ON payment_underwriting_lifecycle_events_v7;
CREATE TRIGGER payment_underwriting_lifecycle_transition_guard_v7
BEFORE INSERT ON payment_underwriting_lifecycle_events_v7
FOR EACH ROW
EXECUTE FUNCTION hxos_enforce_payment_underwriting_transition_v7();

CREATE OR REPLACE VIEW payment_underwriting_lifecycle_status_v7
WITH (security_barrier = true, security_invoker = true)
AS
SELECT DISTINCT ON (l.lifecycle_id)
  l.lifecycle_id,
  l.task_draft_id,
  l.request_id,
  l.pricing_lane,
  e.event_id,
  e.sequence_number,
  e.stage,
  e.evidence_sha256,
  e.created_at AS stage_recorded_at
FROM payment_underwriting_lifecycles_v7 l
JOIN payment_underwriting_lifecycle_events_v7 e
  ON e.lifecycle_id = l.lifecycle_id
ORDER BY l.lifecycle_id, e.sequence_number DESC;

REVOKE ALL ON TABLE
  payment_underwriting_lifecycles_v7,
  payment_underwriting_lifecycle_events_v7,
  payment_task_opportunities_v7,
  payment_provider_account_refs_v7,
  payment_conditional_provider_holds_v7,
  payment_method_refs_v7,
  payment_financial_security_events_v7,
  payment_canonical_work_orders_v7,
  payment_captures_v7,
  payment_ledger_transactions_v7,
  payment_ledger_entries_v7,
  payment_settlement_records_v7,
  payment_webhook_inbox_v7,
  payment_reconciliation_runs_v7,
  payment_legacy_classifications_v7,
  payment_underwriting_lifecycle_status_v7
FROM PUBLIC;

REVOKE ALL ON FUNCTION hxos_reject_payment_underwriting_event_mutation_v7() FROM PUBLIC;
REVOKE ALL ON FUNCTION hxos_enforce_payment_underwriting_transition_v7() FROM PUBLIC;
