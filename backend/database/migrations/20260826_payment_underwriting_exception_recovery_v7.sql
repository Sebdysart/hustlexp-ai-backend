-- Payment Underwriting D8: processor-neutral exception, recovery, and
-- recurring-occurrence containment. This artifact is intentionally
-- unregistered and grants no runtime or provider authority.

DO $$
DECLARE
  v_present INTEGER;
BEGIN
  SELECT count(*) INTO v_present
  FROM (VALUES
    (to_regclass('public.payment_processor_policy_decisions_v7')),
    (to_regclass('public.payment_post_funding_exception_cases_v7')),
    (to_regclass('public.payment_post_funding_exception_events_v7')),
    (to_regclass('public.payment_exception_ledger_adjustments_v7')),
    (to_regclass('public.payment_exception_reconciliations_v7')),
    (to_regclass('public.payment_recurring_occurrences_v7'))
  ) AS expected(relation_name)
  WHERE relation_name IS NOT NULL;
  IF v_present NOT IN (0, 6) THEN
    RAISE EXCEPTION 'HXPV82: D8 catalog is partially applied'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_present = 0 AND (
    to_regclass('public.payment_closure_attestations_v7') IS NULL
    OR to_regclass('public.payment_reconciliation_items_v7') IS NULL
    OR to_regclass('public.payment_capture_economics_v7') IS NULL
  ) THEN
    RAISE EXCEPTION 'HXPV82: D8 requires the complete D7 catalog'
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION hxos_payment_policy_decision_sha256_v7(
  p_decision_id UUID, p_processor_code TEXT, p_policy_domain TEXT,
  p_policy_version INTEGER, p_decision_state TEXT,
  p_effective_at TIMESTAMPTZ, p_expires_at TIMESTAMPTZ,
  p_evidence_sha256 TEXT, p_created_at TIMESTAMPTZ
) RETURNS TEXT LANGUAGE SQL IMMUTABLE AS $$
  SELECT encode(digest(jsonb_build_object(
    'schema', 'HX_PAYMENT_PROCESSOR_POLICY_DECISION_V7',
    'decisionId', p_decision_id, 'processorCode', p_processor_code,
    'policyDomain', p_policy_domain, 'policyVersion', p_policy_version,
    'decisionState', p_decision_state,
    'effectiveAt', to_char(p_effective_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'expiresAt', CASE WHEN p_expires_at IS NULL THEN NULL
      ELSE to_char(p_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
    'evidenceSha256', p_evidence_sha256,
    'createdAt', to_char(p_created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )::TEXT, 'sha256'), 'hex');
$$;

CREATE OR REPLACE FUNCTION hxos_payment_exception_case_sha256_v7(
  p_case_id UUID, p_lifecycle_id UUID, p_capture_id UUID,
  p_settlement_record_id UUID, p_ledger_transaction_id UUID,
  p_processor_code TEXT, p_case_kind TEXT, p_amount_cents BIGINT,
  p_currency TEXT, p_policy_decision_id UUID, p_opened_at TIMESTAMPTZ,
  p_evidence_sha256 TEXT
) RETURNS TEXT LANGUAGE SQL IMMUTABLE AS $$
  SELECT encode(digest(jsonb_build_object(
    'schema', 'HX_PAYMENT_POST_FUNDING_EXCEPTION_CASE_V7',
    'caseId', p_case_id, 'lifecycleId', p_lifecycle_id,
    'captureId', p_capture_id, 'settlementRecordId', p_settlement_record_id,
    'ledgerTransactionId', p_ledger_transaction_id,
    'processorCode', p_processor_code, 'caseKind', p_case_kind,
    'amountCents', p_amount_cents, 'currency', p_currency,
    'policyDecisionId', p_policy_decision_id,
    'openedAt', to_char(p_opened_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'evidenceSha256', p_evidence_sha256
  )::TEXT, 'sha256'), 'hex');
$$;

CREATE OR REPLACE FUNCTION hxos_payment_exception_event_sha256_v7(
  p_event_id UUID, p_case_id UUID, p_sequence_number INTEGER,
  p_prior_event_id UUID, p_state TEXT, p_policy_decision_id UUID,
  p_evidence_source TEXT, p_webhook_inbox_id UUID, p_resolution_code TEXT,
  p_provider_reference_sha256 TEXT, p_customer_refund_cents BIGINT,
  p_provider_loss_cents BIGINT, p_platform_loss_cents BIGINT,
  p_processor_loss_cents BIGINT, p_evidence_sha256 TEXT,
  p_observed_at TIMESTAMPTZ
) RETURNS TEXT LANGUAGE SQL IMMUTABLE AS $$
  SELECT encode(digest(jsonb_build_object(
    'schema', 'HX_PAYMENT_POST_FUNDING_EXCEPTION_EVENT_V7',
    'eventId', p_event_id, 'caseId', p_case_id,
    'sequenceNumber', p_sequence_number, 'priorEventId', p_prior_event_id,
    'state', p_state, 'policyDecisionId', p_policy_decision_id,
    'evidenceSource', p_evidence_source, 'webhookInboxId', p_webhook_inbox_id,
    'resolutionCode', p_resolution_code,
    'providerReferenceSha256', p_provider_reference_sha256,
    'customerRefundCents', p_customer_refund_cents,
    'providerLossCents', p_provider_loss_cents,
    'platformLossCents', p_platform_loss_cents,
    'processorLossCents', p_processor_loss_cents,
    'evidenceSha256', p_evidence_sha256,
    'observedAt', to_char(p_observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )::TEXT, 'sha256'), 'hex');
$$;

CREATE OR REPLACE FUNCTION hxos_payment_exception_adjustment_sha256_v7(
  p_adjustment_id UUID, p_case_id UUID, p_terminal_event_id UUID,
  p_lifecycle_id UUID, p_capture_id UUID, p_transaction_type TEXT,
  p_adjustment_amount_cents BIGINT, p_debit_total_cents BIGINT,
  p_credit_total_cents BIGINT, p_currency TEXT,
  p_evidence_sha256 TEXT, p_created_at TIMESTAMPTZ
) RETURNS TEXT LANGUAGE SQL IMMUTABLE AS $$
  SELECT encode(digest(jsonb_build_object(
    'schema', 'HX_PAYMENT_EXCEPTION_LEDGER_ADJUSTMENT_V7',
    'adjustmentId', p_adjustment_id, 'caseId', p_case_id,
    'terminalEventId', p_terminal_event_id, 'lifecycleId', p_lifecycle_id,
    'captureId', p_capture_id, 'transactionType', p_transaction_type,
    'adjustmentAmountCents', p_adjustment_amount_cents,
    'debitTotalCents', p_debit_total_cents,
    'creditTotalCents', p_credit_total_cents, 'currency', p_currency,
    'evidenceSha256', p_evidence_sha256,
    'createdAt', to_char(p_created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )::TEXT, 'sha256'), 'hex');
$$;

CREATE OR REPLACE FUNCTION hxos_payment_exception_reconciliation_sha256_v7(
  p_reconciliation_id UUID, p_case_id UUID, p_terminal_event_id UUID,
  p_adjustment_id UUID, p_processor_amount_cents BIGINT,
  p_ledger_amount_cents BIGINT, p_currency TEXT,
  p_reconciliation_state TEXT, p_evidence_sha256 TEXT,
  p_reconciled_at TIMESTAMPTZ
) RETURNS TEXT LANGUAGE SQL IMMUTABLE AS $$
  SELECT encode(digest(jsonb_build_object(
    'schema', 'HX_PAYMENT_EXCEPTION_RECONCILIATION_V7',
    'reconciliationId', p_reconciliation_id, 'caseId', p_case_id,
    'terminalEventId', p_terminal_event_id, 'adjustmentId', p_adjustment_id,
    'processorAmountCents', p_processor_amount_cents,
    'ledgerAmountCents', p_ledger_amount_cents, 'currency', p_currency,
    'reconciliationState', p_reconciliation_state,
    'evidenceSha256', p_evidence_sha256,
    'reconciledAt', to_char(p_reconciled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )::TEXT, 'sha256'), 'hex');
$$;

CREATE OR REPLACE FUNCTION hxos_payment_recurring_occurrence_sha256_v7(
  p_occurrence_id UUID, p_series_sha256 TEXT, p_sequence_number INTEGER,
  p_prior_occurrence_id UUID, p_task_draft_id UUID, p_lifecycle_id UUID,
  p_policy_decision_id UUID, p_service_date DATE, p_prepayment_mode TEXT,
  p_evidence_sha256 TEXT, p_created_at TIMESTAMPTZ
) RETURNS TEXT LANGUAGE SQL IMMUTABLE AS $$
  SELECT encode(digest(jsonb_build_object(
    'schema', 'HX_PAYMENT_RECURRING_OCCURRENCE_V7',
    'occurrenceId', p_occurrence_id, 'seriesSha256', p_series_sha256,
    'sequenceNumber', p_sequence_number, 'priorOccurrenceId', p_prior_occurrence_id,
    'taskDraftId', p_task_draft_id, 'lifecycleId', p_lifecycle_id,
    'policyDecisionId', p_policy_decision_id, 'serviceDate', p_service_date,
    'prepaymentMode', p_prepayment_mode, 'evidenceSha256', p_evidence_sha256,
    'createdAt', to_char(p_created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )::TEXT, 'sha256'), 'hex');
$$;

CREATE TABLE IF NOT EXISTS payment_processor_policy_decisions_v7 (
  decision_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  processor_code TEXT NOT NULL CHECK (processor_code ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  policy_domain TEXT NOT NULL CHECK (policy_domain IN ('REFUND', 'DISPUTE', 'REPLACEMENT', 'ADJUSTMENT', 'RECURRING', 'LOSS_ALLOCATION')),
  policy_version INTEGER NOT NULL CHECK (policy_version > 0),
  decision_state TEXT NOT NULL CHECK (decision_state IN ('APPROVED', 'REJECTED', 'REDLINE_REQUIRED')),
  effective_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ CHECK (expires_at IS NULL OR expires_at > effective_at),
  evidence_sha256 CHAR(64) NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  decision_material_sha256 CHAR(64) NOT NULL UNIQUE CHECK (decision_material_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (processor_code, policy_domain, policy_version)
);

CREATE TABLE IF NOT EXISTS payment_post_funding_exception_cases_v7 (
  case_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lifecycle_id UUID NOT NULL REFERENCES payment_underwriting_lifecycles_v7(lifecycle_id) ON DELETE RESTRICT,
  capture_id UUID NOT NULL REFERENCES payment_captures_v7(capture_id) ON DELETE RESTRICT,
  settlement_record_id UUID NOT NULL REFERENCES payment_settlement_records_v7(settlement_record_id) ON DELETE RESTRICT,
  ledger_transaction_id UUID NOT NULL REFERENCES payment_ledger_transactions_v7(ledger_transaction_id) ON DELETE RESTRICT,
  processor_code TEXT NOT NULL CHECK (processor_code ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  case_kind TEXT NOT NULL CHECK (case_kind IN ('REFUND', 'DISPUTE', 'CHARGEBACK', 'RETURN', 'NEGATIVE_BALANCE', 'RECOVERY', 'PROVIDER_REPLACEMENT', 'AMOUNT_CHANGE')),
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[a-z]{3}$'),
  policy_decision_id UUID NOT NULL REFERENCES payment_processor_policy_decisions_v7(decision_id) ON DELETE RESTRICT,
  opened_at TIMESTAMPTZ NOT NULL,
  evidence_sha256 CHAR(64) NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  case_material_sha256 CHAR(64) NOT NULL UNIQUE CHECK (case_material_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (case_id, lifecycle_id, capture_id, processor_code, amount_cents, currency)
);
CREATE UNIQUE INDEX IF NOT EXISTS payment_exception_cases_v7_d8_adjustment_fk_uq
  ON payment_post_funding_exception_cases_v7(
    case_id, lifecycle_id, capture_id, amount_cents, currency
  );

CREATE TABLE IF NOT EXISTS payment_post_funding_exception_events_v7 (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID NOT NULL REFERENCES payment_post_funding_exception_cases_v7(case_id) ON DELETE RESTRICT,
  sequence_number INTEGER NOT NULL CHECK (sequence_number > 0),
  prior_event_id UUID REFERENCES payment_post_funding_exception_events_v7(event_id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN ('OPEN', 'UNDER_REVIEW', 'RESOLVED', 'CANCELED')),
  policy_decision_id UUID NOT NULL REFERENCES payment_processor_policy_decisions_v7(decision_id) ON DELETE RESTRICT,
  evidence_source TEXT NOT NULL CHECK (evidence_source IN ('API_RESPONSE', 'WEBHOOK', 'HUMAN_REVIEW', 'LEDGER_RECONCILIATION')),
  webhook_inbox_id UUID REFERENCES payment_webhook_inbox_v7(webhook_inbox_id) ON DELETE RESTRICT,
  resolution_code TEXT CHECK (resolution_code IS NULL OR resolution_code IN ('REFUNDED', 'DISPUTE_WON', 'DISPUTE_LOST', 'RETURNED', 'RECOVERED', 'WRITTEN_OFF', 'REPLACED', 'CHANGE_REJECTED', 'NO_ACTION')),
  provider_reference_sha256 CHAR(64) CHECK (provider_reference_sha256 IS NULL OR provider_reference_sha256 ~ '^[0-9a-f]{64}$'),
  customer_refund_cents BIGINT CHECK (customer_refund_cents IS NULL OR customer_refund_cents >= 0),
  provider_loss_cents BIGINT CHECK (provider_loss_cents IS NULL OR provider_loss_cents >= 0),
  platform_loss_cents BIGINT CHECK (platform_loss_cents IS NULL OR platform_loss_cents >= 0),
  processor_loss_cents BIGINT CHECK (processor_loss_cents IS NULL OR processor_loss_cents >= 0),
  evidence_sha256 CHAR(64) NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  observed_at TIMESTAMPTZ NOT NULL,
  event_material_sha256 CHAR(64) NOT NULL UNIQUE CHECK (event_material_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (case_id, sequence_number),
  UNIQUE (case_id, event_id)
);

CREATE TABLE IF NOT EXISTS payment_exception_ledger_adjustments_v7 (
  adjustment_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID NOT NULL,
  terminal_event_id UUID NOT NULL UNIQUE,
  lifecycle_id UUID NOT NULL,
  capture_id UUID NOT NULL,
  transaction_type TEXT NOT NULL CHECK (transaction_type IN ('REFUND', 'LOSS', 'ADJUSTMENT', 'REVERSAL')),
  adjustment_amount_cents BIGINT NOT NULL CHECK (adjustment_amount_cents > 0),
  debit_total_cents BIGINT NOT NULL CHECK (debit_total_cents > 0),
  credit_total_cents BIGINT NOT NULL CHECK (credit_total_cents > 0),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[a-z]{3}$'),
  evidence_sha256 CHAR(64) NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  adjustment_material_sha256 CHAR(64) NOT NULL UNIQUE CHECK (adjustment_material_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (case_id, lifecycle_id, capture_id, adjustment_amount_cents, currency)
    REFERENCES payment_post_funding_exception_cases_v7(case_id, lifecycle_id, capture_id, amount_cents, currency) ON DELETE RESTRICT,
  FOREIGN KEY (case_id, terminal_event_id)
    REFERENCES payment_post_funding_exception_events_v7(case_id, event_id) ON DELETE RESTRICT,
  CHECK (debit_total_cents = credit_total_cents)
);

CREATE TABLE IF NOT EXISTS payment_exception_reconciliations_v7 (
  reconciliation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID NOT NULL UNIQUE,
  terminal_event_id UUID NOT NULL UNIQUE,
  adjustment_id UUID NOT NULL UNIQUE REFERENCES payment_exception_ledger_adjustments_v7(adjustment_id) ON DELETE RESTRICT,
  processor_amount_cents BIGINT NOT NULL CHECK (processor_amount_cents > 0),
  ledger_amount_cents BIGINT NOT NULL CHECK (ledger_amount_cents > 0),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[a-z]{3}$'),
  reconciliation_state TEXT NOT NULL CHECK (reconciliation_state IN ('MATCHED', 'EXCEPTION')),
  evidence_sha256 CHAR(64) NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  reconciled_at TIMESTAMPTZ NOT NULL,
  reconciliation_material_sha256 CHAR(64) NOT NULL UNIQUE CHECK (reconciliation_material_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (case_id, terminal_event_id)
    REFERENCES payment_post_funding_exception_events_v7(case_id, event_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS payment_recurring_occurrences_v7 (
  occurrence_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  series_sha256 CHAR(64) NOT NULL CHECK (series_sha256 ~ '^[0-9a-f]{64}$'),
  sequence_number INTEGER NOT NULL CHECK (sequence_number > 0),
  prior_occurrence_id UUID REFERENCES payment_recurring_occurrences_v7(occurrence_id) ON DELETE RESTRICT,
  task_draft_id UUID NOT NULL UNIQUE REFERENCES task_drafts(id) ON DELETE RESTRICT,
  lifecycle_id UUID NOT NULL UNIQUE REFERENCES payment_underwriting_lifecycles_v7(lifecycle_id) ON DELETE RESTRICT,
  policy_decision_id UUID NOT NULL REFERENCES payment_processor_policy_decisions_v7(decision_id) ON DELETE RESTRICT,
  service_date DATE NOT NULL,
  prepayment_mode TEXT NOT NULL CHECK (prepayment_mode = 'PER_OCCURRENCE_ONLY'),
  evidence_sha256 CHAR(64) NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  occurrence_material_sha256 CHAR(64) NOT NULL UNIQUE CHECK (occurrence_material_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (series_sha256, sequence_number)
);

CREATE OR REPLACE FUNCTION hxos_enforce_payment_policy_decision_v7()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_expected TEXT; v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  v_expected := hxos_payment_policy_decision_sha256_v7(
    NEW.decision_id, NEW.processor_code, NEW.policy_domain,
    NEW.policy_version, NEW.decision_state, NEW.effective_at,
    NEW.expires_at, NEW.evidence_sha256::TEXT, NEW.created_at
  );
  IF NEW.created_at > v_now + INTERVAL '5 seconds'
     OR NEW.effective_at > NEW.created_at
     OR NEW.decision_material_sha256::TEXT IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'HXPV83: processor policy decision is malformed or unauthenticated'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION hxos_payment_policy_domain_for_case_v7(p_case_kind TEXT)
RETURNS TEXT LANGUAGE SQL IMMUTABLE AS $$
  SELECT CASE
    WHEN p_case_kind IN ('REFUND', 'RETURN', 'RECOVERY', 'NEGATIVE_BALANCE') THEN 'REFUND'
    WHEN p_case_kind IN ('DISPUTE', 'CHARGEBACK') THEN 'DISPUTE'
    WHEN p_case_kind = 'PROVIDER_REPLACEMENT' THEN 'REPLACEMENT'
    WHEN p_case_kind = 'AMOUNT_CHANGE' THEN 'ADJUSTMENT'
    ELSE NULL
  END;
$$;

CREATE OR REPLACE FUNCTION hxos_enforce_payment_exception_case_v7()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_capture payment_captures_v7%ROWTYPE;
  v_settlement payment_settlement_records_v7%ROWTYPE;
  v_ledger payment_ledger_transactions_v7%ROWTYPE;
  v_policy payment_processor_policy_decisions_v7%ROWTYPE;
  v_expected TEXT;
  v_conflict BIGINT;
  v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  SELECT * INTO v_capture FROM payment_captures_v7 WHERE capture_id = NEW.capture_id FOR SHARE;
  SELECT * INTO v_settlement FROM payment_settlement_records_v7 WHERE settlement_record_id = NEW.settlement_record_id FOR SHARE;
  SELECT * INTO v_ledger FROM payment_ledger_transactions_v7 WHERE ledger_transaction_id = NEW.ledger_transaction_id FOR SHARE;
  SELECT * INTO v_policy FROM payment_processor_policy_decisions_v7 WHERE decision_id = NEW.policy_decision_id FOR SHARE;
  SELECT count(*) INTO v_conflict
  FROM payment_post_funding_exception_cases_v7 existing
  LEFT JOIN LATERAL (
    SELECT event_id, state FROM payment_post_funding_exception_events_v7 event
    WHERE event.case_id = existing.case_id ORDER BY sequence_number DESC LIMIT 1
  ) latest ON TRUE
  LEFT JOIN payment_exception_reconciliations_v7 reconciliation
    ON reconciliation.case_id = existing.case_id
   AND reconciliation.terminal_event_id = latest.event_id
   AND reconciliation.reconciliation_state = 'MATCHED'
  WHERE existing.lifecycle_id = NEW.lifecycle_id
    AND (
      COALESCE(latest.state, 'OPEN') NOT IN ('RESOLVED', 'CANCELED')
      OR reconciliation.reconciliation_id IS NULL
    )
    AND (
      (NEW.case_kind = 'REFUND' AND existing.case_kind IN ('DISPUTE', 'CHARGEBACK'))
      OR (NEW.case_kind IN ('DISPUTE', 'CHARGEBACK') AND existing.case_kind = 'REFUND')
    );
  v_expected := hxos_payment_exception_case_sha256_v7(
    NEW.case_id, NEW.lifecycle_id, NEW.capture_id, NEW.settlement_record_id,
    NEW.ledger_transaction_id, NEW.processor_code, NEW.case_kind,
    NEW.amount_cents, NEW.currency, NEW.policy_decision_id,
    NEW.opened_at, NEW.evidence_sha256::TEXT
  );
  IF v_capture.capture_id IS NULL OR v_settlement.settlement_record_id IS NULL
     OR v_ledger.ledger_transaction_id IS NULL
     OR v_capture.lifecycle_id IS DISTINCT FROM NEW.lifecycle_id
     OR v_settlement.lifecycle_id IS DISTINCT FROM NEW.lifecycle_id
     OR v_ledger.lifecycle_id IS DISTINCT FROM NEW.lifecycle_id
     OR v_capture.processor_code IS DISTINCT FROM NEW.processor_code
     OR v_settlement.processor_code IS DISTINCT FROM NEW.processor_code
     OR v_capture.currency IS DISTINCT FROM NEW.currency
     OR v_settlement.currency IS DISTINCT FROM NEW.currency
     OR NEW.amount_cents > v_settlement.customer_amount_cents
     OR v_policy.decision_id IS NULL OR v_policy.decision_state <> 'APPROVED'
     OR v_policy.processor_code IS DISTINCT FROM NEW.processor_code
     OR v_policy.policy_domain IS DISTINCT FROM hxos_payment_policy_domain_for_case_v7(NEW.case_kind)
     OR v_policy.created_at > NEW.opened_at
     OR v_policy.effective_at > NEW.opened_at
     OR (v_policy.expires_at IS NOT NULL AND v_policy.expires_at <= NEW.opened_at)
     OR NEW.opened_at < v_settlement.observed_at
     OR NEW.opened_at > v_now + INTERVAL '5 seconds'
     OR NEW.case_kind = 'PROVIDER_REPLACEMENT'
     OR v_conflict <> 0
     OR NEW.case_material_sha256::TEXT IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'HXPV84: exception case is crossed, conflicting, or lacks written policy'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION hxos_enforce_payment_exception_event_v7()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_case payment_post_funding_exception_cases_v7%ROWTYPE;
  v_latest payment_post_funding_exception_events_v7%ROWTYPE;
  v_policy payment_processor_policy_decisions_v7%ROWTYPE;
  v_webhook payment_webhook_inbox_v7%ROWTYPE;
  v_expected TEXT;
  v_terminal BOOLEAN := NEW.state IN ('RESOLVED', 'CANCELED');
  v_allocation BIGINT;
  v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  SELECT * INTO v_case FROM payment_post_funding_exception_cases_v7 WHERE case_id = NEW.case_id FOR SHARE;
  SELECT * INTO v_latest FROM payment_post_funding_exception_events_v7
    WHERE case_id = NEW.case_id ORDER BY sequence_number DESC LIMIT 1 FOR UPDATE;
  SELECT * INTO v_policy FROM payment_processor_policy_decisions_v7 WHERE decision_id = NEW.policy_decision_id FOR SHARE;
  IF NEW.webhook_inbox_id IS NOT NULL THEN
    SELECT * INTO v_webhook FROM payment_webhook_inbox_v7 WHERE webhook_inbox_id = NEW.webhook_inbox_id FOR SHARE;
  END IF;
  v_allocation := COALESCE(NEW.customer_refund_cents, 0)
    + COALESCE(NEW.provider_loss_cents, 0)
    + COALESCE(NEW.platform_loss_cents, 0)
    + COALESCE(NEW.processor_loss_cents, 0);
  v_expected := hxos_payment_exception_event_sha256_v7(
    NEW.event_id, NEW.case_id, NEW.sequence_number, NEW.prior_event_id,
    NEW.state, NEW.policy_decision_id, NEW.evidence_source,
    NEW.webhook_inbox_id, NEW.resolution_code,
    NEW.provider_reference_sha256::TEXT, NEW.customer_refund_cents,
    NEW.provider_loss_cents, NEW.platform_loss_cents,
    NEW.processor_loss_cents, NEW.evidence_sha256::TEXT, NEW.observed_at
  );
  IF v_case.case_id IS NULL
     OR v_policy.decision_id IS NULL OR v_policy.decision_state <> 'APPROVED'
     OR v_policy.decision_id IS DISTINCT FROM v_case.policy_decision_id
     OR v_policy.processor_code IS DISTINCT FROM v_case.processor_code
     OR v_policy.policy_domain IS DISTINCT FROM hxos_payment_policy_domain_for_case_v7(v_case.case_kind)
     OR v_policy.created_at > NEW.observed_at
     OR v_policy.effective_at > NEW.observed_at
     OR (v_policy.expires_at IS NOT NULL AND v_policy.expires_at <= NEW.observed_at)
     OR NEW.observed_at < v_case.opened_at
     OR NEW.observed_at > v_now + INTERVAL '5 seconds'
     OR (v_latest.event_id IS NULL AND (
       NEW.sequence_number <> 1 OR NEW.prior_event_id IS NOT NULL OR NEW.state <> 'OPEN'
     ))
     OR (v_latest.event_id IS NOT NULL AND (
       NEW.sequence_number <> v_latest.sequence_number + 1
       OR NEW.prior_event_id IS DISTINCT FROM v_latest.event_id
       OR NEW.observed_at < v_latest.observed_at
       OR v_latest.state IN ('RESOLVED', 'CANCELED')
       OR (v_latest.state = 'OPEN' AND NEW.state NOT IN ('UNDER_REVIEW', 'RESOLVED', 'CANCELED'))
       OR (v_latest.state = 'UNDER_REVIEW' AND NEW.state NOT IN ('RESOLVED', 'CANCELED'))
     ))
     OR (NEW.evidence_source = 'WEBHOOK' AND (
       v_webhook.webhook_inbox_id IS NULL
       OR v_webhook.processor_code IS DISTINCT FROM v_case.processor_code
       OR v_webhook.authentication_state <> 'VERIFIED'
       OR v_webhook.processing_state NOT IN ('NORMALIZED', 'APPLIED')
       OR v_webhook.normalized_event_type IS DISTINCT FROM
          'EXCEPTION_' || v_case.case_kind || '_' || NEW.resolution_code
       OR v_webhook.event_id_sha256 IS DISTINCT FROM NEW.provider_reference_sha256
       OR v_webhook.payload_sha256 IS DISTINCT FROM NEW.evidence_sha256
       OR NEW.observed_at < v_webhook.received_at
       OR NEW.observed_at < v_webhook.signature_verified_at
       OR NEW.observed_at < v_webhook.created_at
     ))
     OR (NEW.evidence_source <> 'WEBHOOK' AND NEW.webhook_inbox_id IS NOT NULL)
     OR (v_terminal AND (
       NEW.resolution_code IS NULL OR NEW.provider_reference_sha256 IS NULL
       OR NEW.customer_refund_cents IS NULL OR NEW.provider_loss_cents IS NULL
       OR NEW.platform_loss_cents IS NULL OR NEW.processor_loss_cents IS NULL
       OR v_allocation <> v_case.amount_cents
     ))
     OR (NOT v_terminal AND (
       NEW.resolution_code IS NOT NULL OR NEW.provider_reference_sha256 IS NOT NULL
       OR NEW.customer_refund_cents IS NOT NULL OR NEW.provider_loss_cents IS NOT NULL
       OR NEW.platform_loss_cents IS NOT NULL OR NEW.processor_loss_cents IS NOT NULL
     ))
     OR NEW.event_material_sha256::TEXT IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'HXPV85: exception event is stale, unauthenticated, or unallocated'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION hxos_enforce_payment_exception_adjustment_v7()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_case payment_post_funding_exception_cases_v7%ROWTYPE;
  v_event payment_post_funding_exception_events_v7%ROWTYPE;
  v_expected TEXT;
  v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  SELECT * INTO v_case FROM payment_post_funding_exception_cases_v7 WHERE case_id = NEW.case_id FOR SHARE;
  SELECT * INTO v_event FROM payment_post_funding_exception_events_v7 WHERE event_id = NEW.terminal_event_id FOR SHARE;
  v_expected := hxos_payment_exception_adjustment_sha256_v7(
    NEW.adjustment_id, NEW.case_id, NEW.terminal_event_id,
    NEW.lifecycle_id, NEW.capture_id, NEW.transaction_type,
    NEW.adjustment_amount_cents, NEW.debit_total_cents,
    NEW.credit_total_cents, NEW.currency, NEW.evidence_sha256::TEXT,
    NEW.created_at
  );
  IF v_case.case_id IS NULL OR v_event.event_id IS NULL
     OR v_event.case_id IS DISTINCT FROM NEW.case_id
     OR v_event.state NOT IN ('RESOLVED', 'CANCELED')
     OR v_case.lifecycle_id IS DISTINCT FROM NEW.lifecycle_id
     OR v_case.capture_id IS DISTINCT FROM NEW.capture_id
     OR v_case.amount_cents IS DISTINCT FROM NEW.adjustment_amount_cents
     OR v_case.currency IS DISTINCT FROM NEW.currency
     OR NEW.created_at < v_event.observed_at
     OR NEW.created_at > v_now + INTERVAL '5 seconds'
     OR NEW.debit_total_cents IS DISTINCT FROM NEW.adjustment_amount_cents
     OR NEW.credit_total_cents IS DISTINCT FROM NEW.adjustment_amount_cents
     OR NEW.adjustment_material_sha256::TEXT IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'HXPV86: exception ledger adjustment is crossed or unbalanced'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION hxos_enforce_payment_exception_reconciliation_v7()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_case payment_post_funding_exception_cases_v7%ROWTYPE;
  v_event payment_post_funding_exception_events_v7%ROWTYPE;
  v_adjustment payment_exception_ledger_adjustments_v7%ROWTYPE;
  v_expected TEXT;
  v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  SELECT * INTO v_case FROM payment_post_funding_exception_cases_v7 WHERE case_id = NEW.case_id FOR SHARE;
  SELECT * INTO v_event FROM payment_post_funding_exception_events_v7 WHERE event_id = NEW.terminal_event_id FOR SHARE;
  SELECT * INTO v_adjustment FROM payment_exception_ledger_adjustments_v7 WHERE adjustment_id = NEW.adjustment_id FOR SHARE;
  v_expected := hxos_payment_exception_reconciliation_sha256_v7(
    NEW.reconciliation_id, NEW.case_id, NEW.terminal_event_id,
    NEW.adjustment_id, NEW.processor_amount_cents,
    NEW.ledger_amount_cents, NEW.currency, NEW.reconciliation_state,
    NEW.evidence_sha256::TEXT, NEW.reconciled_at
  );
  IF v_case.case_id IS NULL OR v_event.event_id IS NULL
     OR v_adjustment.adjustment_id IS NULL
     OR v_event.case_id IS DISTINCT FROM NEW.case_id
     OR v_event.state NOT IN ('RESOLVED', 'CANCELED')
     OR v_adjustment.case_id IS DISTINCT FROM NEW.case_id
     OR v_adjustment.terminal_event_id IS DISTINCT FROM NEW.terminal_event_id
     OR NEW.reconciliation_state <> 'MATCHED'
     OR NEW.processor_amount_cents IS DISTINCT FROM v_case.amount_cents
     OR NEW.ledger_amount_cents IS DISTINCT FROM v_adjustment.adjustment_amount_cents
     OR NEW.processor_amount_cents IS DISTINCT FROM NEW.ledger_amount_cents
     OR NEW.currency IS DISTINCT FROM v_case.currency
     OR NEW.currency IS DISTINCT FROM v_adjustment.currency
     OR NEW.reconciled_at < v_event.observed_at
     OR NEW.reconciled_at < v_adjustment.created_at
     OR NEW.reconciled_at > v_now + INTERVAL '5 seconds'
     OR NEW.reconciliation_material_sha256::TEXT IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'HXPV87: exception reconciliation lacks exact processor-ledger agreement'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION hxos_enforce_payment_recurring_occurrence_v7()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_lifecycle payment_underwriting_lifecycles_v7%ROWTYPE;
  v_stage TEXT;
  v_policy payment_processor_policy_decisions_v7%ROWTYPE;
  v_prior payment_recurring_occurrences_v7%ROWTYPE;
  v_expected TEXT;
  v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  SELECT * INTO v_lifecycle FROM payment_underwriting_lifecycles_v7 WHERE lifecycle_id = NEW.lifecycle_id FOR SHARE;
  SELECT stage INTO v_stage FROM payment_underwriting_lifecycle_status_v7 WHERE lifecycle_id = NEW.lifecycle_id;
  SELECT * INTO v_policy FROM payment_processor_policy_decisions_v7 WHERE decision_id = NEW.policy_decision_id FOR SHARE;
  IF NEW.prior_occurrence_id IS NOT NULL THEN
    SELECT * INTO v_prior FROM payment_recurring_occurrences_v7 WHERE occurrence_id = NEW.prior_occurrence_id FOR SHARE;
  END IF;
  v_expected := hxos_payment_recurring_occurrence_sha256_v7(
    NEW.occurrence_id, NEW.series_sha256::TEXT, NEW.sequence_number,
    NEW.prior_occurrence_id, NEW.task_draft_id, NEW.lifecycle_id,
    NEW.policy_decision_id, NEW.service_date, NEW.prepayment_mode,
    NEW.evidence_sha256::TEXT, NEW.created_at
  );
  IF v_lifecycle.lifecycle_id IS NULL
     OR v_lifecycle.task_draft_id IS DISTINCT FROM NEW.task_draft_id
     OR v_stage IS DISTINCT FROM 'TASK_DRAFT'
     OR v_policy.decision_id IS NULL OR v_policy.decision_state <> 'APPROVED'
     OR v_policy.policy_domain <> 'RECURRING'
     OR v_policy.effective_at > NEW.created_at
     OR (v_policy.expires_at IS NOT NULL AND v_policy.expires_at <= NEW.created_at)
     OR NEW.created_at > v_now + INTERVAL '5 seconds'
     OR (NEW.sequence_number = 1 AND NEW.prior_occurrence_id IS NOT NULL)
     OR (NEW.sequence_number > 1 AND (
       v_prior.occurrence_id IS NULL OR v_prior.series_sha256 IS DISTINCT FROM NEW.series_sha256
       OR v_prior.sequence_number + 1 IS DISTINCT FROM NEW.sequence_number
       OR v_prior.service_date >= NEW.service_date
     ))
     OR NEW.occurrence_material_sha256::TEXT IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'HXPV88: recurring occurrence is not an independent per-occurrence lifecycle'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION hxos_payment_open_exception_count_v7(p_lifecycle_id UUID)
RETURNS BIGINT LANGUAGE SQL STABLE AS $$
  SELECT count(*)
  FROM payment_post_funding_exception_cases_v7 exception_case
  LEFT JOIN LATERAL (
    SELECT event_id, state
    FROM payment_post_funding_exception_events_v7 event
    WHERE event.case_id = exception_case.case_id
    ORDER BY sequence_number DESC LIMIT 1
  ) latest ON TRUE
  LEFT JOIN payment_exception_reconciliations_v7 reconciliation
    ON reconciliation.case_id = exception_case.case_id
   AND reconciliation.terminal_event_id = latest.event_id
   AND reconciliation.reconciliation_state = 'MATCHED'
  WHERE exception_case.lifecycle_id = p_lifecycle_id
    AND (
      latest.event_id IS NULL
      OR latest.state NOT IN ('RESOLVED', 'CANCELED')
      OR reconciliation.reconciliation_id IS NULL
    );
$$;

CREATE OR REPLACE FUNCTION hxos_enforce_payment_closure_attestation_v7()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_item payment_reconciliation_items_v7%ROWTYPE;
  v_run payment_reconciliation_runs_v7%ROWTYPE;
  v_settlement payment_settlement_records_v7%ROWTYPE;
  v_transaction payment_ledger_transactions_v7%ROWTYPE;
  v_stage TEXT;
  v_entry_count BIGINT;
  v_debits BIGINT;
  v_credits BIGINT;
  v_open_cases BIGINT;
  v_latest_exception_reconciled_at TIMESTAMPTZ;
  v_expected TEXT;
  v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  SELECT * INTO v_item FROM payment_reconciliation_items_v7 WHERE reconciliation_item_id = NEW.reconciliation_item_id FOR SHARE;
  SELECT * INTO v_run FROM payment_reconciliation_runs_v7 WHERE reconciliation_run_id = NEW.reconciliation_run_id FOR SHARE;
  SELECT * INTO v_settlement FROM payment_settlement_records_v7 WHERE settlement_record_id = NEW.settlement_record_id FOR SHARE;
  SELECT * INTO v_transaction FROM payment_ledger_transactions_v7 WHERE ledger_transaction_id = NEW.ledger_transaction_id FOR SHARE;
  SELECT stage INTO v_stage FROM payment_underwriting_lifecycle_status_v7 WHERE lifecycle_id = NEW.lifecycle_id;
  SELECT count(*),
         COALESCE(sum(CASE WHEN direction = 'DEBIT' THEN amount_cents ELSE 0 END), 0),
         COALESCE(sum(CASE WHEN direction = 'CREDIT' THEN amount_cents ELSE 0 END), 0)
    INTO v_entry_count, v_debits, v_credits
    FROM payment_ledger_entries_v7 WHERE ledger_transaction_id = NEW.ledger_transaction_id;
  v_open_cases := hxos_payment_open_exception_count_v7(NEW.lifecycle_id);
  SELECT max(reconciliation.reconciled_at)
    INTO v_latest_exception_reconciled_at
    FROM payment_post_funding_exception_cases_v7 exception_case
    JOIN payment_exception_reconciliations_v7 reconciliation
      ON reconciliation.case_id = exception_case.case_id
     AND reconciliation.reconciliation_state = 'MATCHED'
   WHERE exception_case.lifecycle_id = NEW.lifecycle_id;
  v_expected := hxos_payment_closure_attestation_sha256_v7(
    NEW.closure_attestation_id, NEW.lifecycle_id, NEW.capture_id,
    NEW.settlement_record_id, NEW.ledger_transaction_id,
    NEW.reconciliation_run_id, NEW.reconciliation_item_id,
    NEW.open_post_funding_exposure_count, NEW.closed_at,
    NEW.evidence_sha256::TEXT
  );
  IF v_stage IS DISTINCT FROM 'RECONCILED'
     OR v_item.reconciliation_state IS DISTINCT FROM 'MATCHED'
     OR v_run.state IS DISTINCT FROM 'COMPLETED'
     OR v_run.exception_count <> 0
     OR v_settlement.state NOT IN ('FUNDED', 'PAID_OUT')
     OR v_transaction.state IS DISTINCT FROM 'POSTED'
     OR v_entry_count IS DISTINCT FROM v_transaction.expected_entry_count::BIGINT
     OR v_debits IS DISTINCT FROM v_transaction.debit_total_cents
     OR v_credits IS DISTINCT FROM v_transaction.credit_total_cents
     OR v_debits IS DISTINCT FROM v_credits
     OR NEW.open_post_funding_exposure_count <> 0
     OR v_open_cases <> 0
     OR NEW.closed_at < v_run.completed_at
     OR (v_latest_exception_reconciled_at IS NOT NULL
       AND NEW.closed_at < v_latest_exception_reconciled_at)
     OR NEW.closed_at > v_now + INTERVAL '5 seconds'
     OR NEW.closure_material_sha256::TEXT IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'HXPV89: closure has open or unreconciled post-funding exposure'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE VIEW payment_exception_recovery_status_v7
WITH (security_invoker = true, security_barrier = true) AS
SELECT
  close_status.*,
  hxos_payment_open_exception_count_v7(close_status.lifecycle_id) AS open_exception_case_count,
  CASE
    WHEN hxos_payment_open_exception_count_v7(close_status.lifecycle_id) <> 0 THEN 'EXCEPTION_OPEN'
    WHEN close_status.closure_attestation_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM payment_post_funding_exception_cases_v7 exception_case
        WHERE exception_case.lifecycle_id = close_status.lifecycle_id
          AND exception_case.opened_at > closure.closed_at
      )
      THEN 'RECOVERY_RECONCILED_AWAITING_RECLOSURE'
    WHEN close_status.closure_attestation_id IS NOT NULL THEN 'CLOSED'
    ELSE lifecycle.stage
  END AS effective_financial_state
FROM payment_settlement_close_status_v7 close_status
LEFT JOIN payment_underwriting_lifecycle_status_v7 lifecycle
  ON lifecycle.lifecycle_id = close_status.lifecycle_id
LEFT JOIN payment_closure_attestations_v7 closure
  ON closure.closure_attestation_id = close_status.closure_attestation_id;

DROP TRIGGER IF EXISTS payment_processor_policy_decision_guard_v7 ON payment_processor_policy_decisions_v7;
CREATE TRIGGER payment_processor_policy_decision_guard_v7 BEFORE INSERT ON payment_processor_policy_decisions_v7
FOR EACH ROW EXECUTE FUNCTION hxos_enforce_payment_policy_decision_v7();
DROP TRIGGER IF EXISTS payment_exception_case_guard_v7 ON payment_post_funding_exception_cases_v7;
CREATE TRIGGER payment_exception_case_guard_v7 BEFORE INSERT ON payment_post_funding_exception_cases_v7
FOR EACH ROW EXECUTE FUNCTION hxos_enforce_payment_exception_case_v7();
DROP TRIGGER IF EXISTS payment_exception_event_guard_v7 ON payment_post_funding_exception_events_v7;
CREATE TRIGGER payment_exception_event_guard_v7 BEFORE INSERT ON payment_post_funding_exception_events_v7
FOR EACH ROW EXECUTE FUNCTION hxos_enforce_payment_exception_event_v7();
DROP TRIGGER IF EXISTS payment_exception_adjustment_guard_v7 ON payment_exception_ledger_adjustments_v7;
CREATE TRIGGER payment_exception_adjustment_guard_v7 BEFORE INSERT ON payment_exception_ledger_adjustments_v7
FOR EACH ROW EXECUTE FUNCTION hxos_enforce_payment_exception_adjustment_v7();
DROP TRIGGER IF EXISTS payment_exception_reconciliation_guard_v7 ON payment_exception_reconciliations_v7;
CREATE TRIGGER payment_exception_reconciliation_guard_v7 BEFORE INSERT ON payment_exception_reconciliations_v7
FOR EACH ROW EXECUTE FUNCTION hxos_enforce_payment_exception_reconciliation_v7();
DROP TRIGGER IF EXISTS payment_recurring_occurrence_guard_v7 ON payment_recurring_occurrences_v7;
CREATE TRIGGER payment_recurring_occurrence_guard_v7 BEFORE INSERT ON payment_recurring_occurrences_v7
FOR EACH ROW EXECUTE FUNCTION hxos_enforce_payment_recurring_occurrence_v7();
DROP TRIGGER IF EXISTS payment_closure_attestation_insert_guard_v7 ON payment_closure_attestations_v7;
CREATE TRIGGER payment_closure_attestation_insert_guard_v7 BEFORE INSERT ON payment_closure_attestations_v7
FOR EACH ROW EXECUTE FUNCTION hxos_enforce_payment_closure_attestation_v7();

CREATE OR REPLACE FUNCTION hxos_reject_payment_underwriting_d8_mutation_v7()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'HXPV90: payment underwriting D8 evidence is append-only'
    USING ERRCODE = 'P0001';
END;
$$;

DO $$
DECLARE v_table TEXT;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'payment_processor_policy_decisions_v7',
    'payment_post_funding_exception_cases_v7',
    'payment_post_funding_exception_events_v7',
    'payment_exception_ledger_adjustments_v7',
    'payment_exception_reconciliations_v7',
    'payment_recurring_occurrences_v7'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', v_table || '_append_only_v7', v_table);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION hxos_reject_payment_underwriting_d8_mutation_v7()',
      v_table || '_append_only_v7', v_table
    );
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', v_table || '_no_truncate_v7', v_table);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION hxos_reject_payment_underwriting_d8_mutation_v7()',
      v_table || '_no_truncate_v7', v_table
    );
  END LOOP;
END;
$$;

REVOKE ALL ON
  payment_processor_policy_decisions_v7,
  payment_post_funding_exception_cases_v7,
  payment_post_funding_exception_events_v7,
  payment_exception_ledger_adjustments_v7,
  payment_exception_reconciliations_v7,
  payment_recurring_occurrences_v7,
  payment_exception_recovery_status_v7
FROM PUBLIC;

DO $$
DECLARE v_signature TEXT;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'hxos_payment_policy_decision_sha256_v7(uuid,text,text,integer,text,timestamp with time zone,timestamp with time zone,text,timestamp with time zone)',
    'hxos_payment_exception_case_sha256_v7(uuid,uuid,uuid,uuid,uuid,text,text,bigint,text,uuid,timestamp with time zone,text)',
    'hxos_payment_exception_event_sha256_v7(uuid,uuid,integer,uuid,text,uuid,text,uuid,text,text,bigint,bigint,bigint,bigint,text,timestamp with time zone)',
    'hxos_payment_exception_adjustment_sha256_v7(uuid,uuid,uuid,uuid,uuid,text,bigint,bigint,bigint,text,text,timestamp with time zone)',
    'hxos_payment_exception_reconciliation_sha256_v7(uuid,uuid,uuid,uuid,bigint,bigint,text,text,text,timestamp with time zone)',
    'hxos_payment_recurring_occurrence_sha256_v7(uuid,text,integer,uuid,uuid,uuid,uuid,date,text,text,timestamp with time zone)',
    'hxos_payment_policy_domain_for_case_v7(text)',
    'hxos_payment_open_exception_count_v7(uuid)',
    'hxos_enforce_payment_policy_decision_v7()',
    'hxos_enforce_payment_exception_case_v7()',
    'hxos_enforce_payment_exception_event_v7()',
    'hxos_enforce_payment_exception_adjustment_v7()',
    'hxos_enforce_payment_exception_reconciliation_v7()',
    'hxos_enforce_payment_recurring_occurrence_v7()',
    'hxos_reject_payment_underwriting_d8_mutation_v7()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_signature);
  END LOOP;
END;
$$;

DO $$
BEGIN
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON
      payment_processor_policy_decisions_v7,
      payment_post_funding_exception_cases_v7,
      payment_post_funding_exception_events_v7,
      payment_exception_ledger_adjustments_v7,
      payment_exception_reconciliations_v7,
      payment_recurring_occurrences_v7,
      payment_exception_recovery_status_v7
    FROM service_role;
  END IF;
END;
$$;
