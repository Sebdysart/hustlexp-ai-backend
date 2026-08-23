-- HX payment-underwriting v7 D7: processor-neutral settlement evidence,
-- versioned economics, balanced double-entry posting, exact reconciliation,
-- and lifecycle closure. This artifact is intentionally unregistered and
-- grants no runtime or processor authority.

DO $$
DECLARE
  v_complete BOOLEAN;
  v_absent BOOLEAN;
BEGIN
  IF to_regclass('public.payment_capture_authorities_v7') IS NULL
     OR to_regclass('public.payment_capture_operation_observations_v7') IS NULL
     OR to_regclass('public.payment_captures_v7') IS NULL
     OR to_regclass('public.payment_settlement_records_v7') IS NULL
     OR to_regclass('public.payment_ledger_transactions_v7') IS NULL
     OR to_regclass('public.payment_ledger_entries_v7') IS NULL
     OR to_regclass('public.payment_reconciliation_runs_v7') IS NULL THEN
    RAISE EXCEPTION 'HXPV70: D7 requires the accepted D2 through D6 schema artifacts'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT
    to_regclass('public.payment_capture_economics_v7') IS NOT NULL
    AND to_regclass('public.payment_reconciliation_items_v7') IS NOT NULL
    AND to_regclass('public.payment_closure_attestations_v7') IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM pg_attribute
       WHERE attrelid = 'public.payment_settlement_records_v7'::regclass
         AND attname = 'settlement_material_sha256' AND NOT attisdropped
    )
    AND EXISTS (
      SELECT 1 FROM pg_attribute
       WHERE attrelid = 'public.payment_ledger_transactions_v7'::regclass
         AND attname = 'posting_material_sha256' AND NOT attisdropped
    )
    AND EXISTS (
      SELECT 1 FROM pg_attribute
       WHERE attrelid = 'public.payment_reconciliation_runs_v7'::regclass
         AND attname = 'run_material_sha256' AND NOT attisdropped
    )
  INTO v_complete;
  SELECT
    to_regclass('public.payment_capture_economics_v7') IS NULL
    AND to_regclass('public.payment_reconciliation_items_v7') IS NULL
    AND to_regclass('public.payment_closure_attestations_v7') IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM pg_attribute
       WHERE attrelid = 'public.payment_settlement_records_v7'::regclass
         AND attname = 'settlement_material_sha256' AND NOT attisdropped
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_attribute
       WHERE attrelid = 'public.payment_ledger_transactions_v7'::regclass
         AND attname = 'posting_material_sha256' AND NOT attisdropped
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_attribute
       WHERE attrelid = 'public.payment_reconciliation_runs_v7'::regclass
         AND attname = 'run_material_sha256' AND NOT attisdropped
    )
  INTO v_absent;
  IF NOT v_complete AND NOT v_absent THEN
    RAISE EXCEPTION 'HXPV70: D7 catalog is partial or contradictory'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_absent AND (
    EXISTS (SELECT 1 FROM payment_settlement_records_v7)
    OR EXISTS (SELECT 1 FROM payment_ledger_transactions_v7)
    OR EXISTS (SELECT 1 FROM payment_ledger_entries_v7)
    OR EXISTS (SELECT 1 FROM payment_reconciliation_runs_v7)
    OR EXISTS (
      SELECT 1 FROM payment_underwriting_lifecycle_events_v7
       WHERE stage IN ('SETTLING', 'PAYOUT_PENDING', 'FUNDED', 'PAID_OUT', 'RECONCILED', 'CLOSED')
    )
  ) THEN
    RAISE EXCEPTION 'HXPV70: D7 cannot retrofit unverified settlement history'
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION hxos_payment_capture_economics_sha256_v7(
  p_economics_id UUID, p_capture_id UUID, p_lifecycle_id UUID,
  p_work_order_id UUID, p_processor_code TEXT, p_pricing_policy_version INTEGER,
  p_pricing_policy_sha256 TEXT, p_relationship_origin TEXT,
  p_customer_amount_cents BIGINT, p_provider_amount_cents BIGINT,
  p_platform_amount_cents BIGINT, p_processor_cost_cents BIGINT,
  p_currency TEXT, p_evidence_sha256 TEXT, p_created_at TIMESTAMPTZ
) RETURNS TEXT LANGUAGE SQL IMMUTABLE PARALLEL SAFE AS $$
  SELECT encode(digest(jsonb_build_object(
    'schema', 'HX_PAYMENT_CAPTURE_ECONOMICS_V7',
    'economicsId', p_economics_id, 'captureId', p_capture_id,
    'lifecycleId', p_lifecycle_id, 'workOrderId', p_work_order_id,
    'processorCode', p_processor_code, 'pricingPolicyVersion', p_pricing_policy_version,
    'pricingPolicySha256', p_pricing_policy_sha256,
    'relationshipOrigin', p_relationship_origin,
    'customerAmountCents', p_customer_amount_cents,
    'providerAmountCents', p_provider_amount_cents,
    'platformAmountCents', p_platform_amount_cents,
    'processorCostCents', p_processor_cost_cents,
    'currency', p_currency, 'evidenceSha256', p_evidence_sha256,
    'createdAt', to_char(p_created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )::TEXT, 'sha256'), 'hex')
$$;

CREATE OR REPLACE FUNCTION hxos_payment_settlement_record_sha256_v7(
  p_settlement_record_id UUID, p_economics_id UUID, p_lifecycle_id UUID,
  p_capture_id UUID, p_processor_code TEXT, p_sequence_number INTEGER,
  p_prior_settlement_record_id UUID, p_state TEXT,
  p_customer_amount_cents BIGINT, p_provider_amount_cents BIGINT,
  p_platform_amount_cents BIGINT, p_currency TEXT, p_evidence_source TEXT,
  p_webhook_inbox_id UUID, p_external_reference_sha256 TEXT,
  p_evidence_sha256 TEXT, p_observed_at TIMESTAMPTZ
) RETURNS TEXT LANGUAGE SQL IMMUTABLE PARALLEL SAFE AS $$
  SELECT encode(digest(jsonb_build_object(
    'schema', 'HX_PAYMENT_SETTLEMENT_RECORD_V7',
    'settlementRecordId', p_settlement_record_id, 'economicsId', p_economics_id,
    'lifecycleId', p_lifecycle_id, 'captureId', p_capture_id,
    'processorCode', p_processor_code, 'sequenceNumber', p_sequence_number,
    'priorSettlementRecordId', p_prior_settlement_record_id, 'state', p_state,
    'customerAmountCents', p_customer_amount_cents,
    'providerAmountCents', p_provider_amount_cents,
    'platformAmountCents', p_platform_amount_cents, 'currency', p_currency,
    'evidenceSource', p_evidence_source, 'webhookInboxId', p_webhook_inbox_id,
    'externalReferenceSha256', p_external_reference_sha256,
    'evidenceSha256', p_evidence_sha256,
    'observedAt', to_char(p_observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )::TEXT, 'sha256'), 'hex')
$$;

CREATE OR REPLACE FUNCTION hxos_payment_ledger_transaction_sha256_v7(
  p_ledger_transaction_id UUID, p_lifecycle_id UUID, p_capture_id UUID,
  p_economics_id UUID, p_settlement_record_id UUID, p_currency TEXT,
  p_expected_entry_count INTEGER, p_debit_total_cents BIGINT,
  p_credit_total_cents BIGINT, p_source_operation_id UUID,
  p_created_at TIMESTAMPTZ
) RETURNS TEXT LANGUAGE SQL IMMUTABLE PARALLEL SAFE AS $$
  SELECT encode(digest(jsonb_build_object(
    'schema', 'HX_PAYMENT_LEDGER_TRANSACTION_V7',
    'ledgerTransactionId', p_ledger_transaction_id, 'lifecycleId', p_lifecycle_id,
    'captureId', p_capture_id, 'economicsId', p_economics_id,
    'settlementRecordId', p_settlement_record_id, 'transactionType', 'SETTLEMENT',
    'state', 'POSTED', 'currency', p_currency,
    'expectedEntryCount', p_expected_entry_count,
    'debitTotalCents', p_debit_total_cents, 'creditTotalCents', p_credit_total_cents,
    'sourceOperationId', p_source_operation_id,
    'createdAt', to_char(p_created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )::TEXT, 'sha256'), 'hex')
$$;

CREATE OR REPLACE FUNCTION hxos_payment_ledger_entry_sha256_v7(
  p_ledger_entry_id UUID, p_ledger_transaction_id UUID, p_lifecycle_id UUID,
  p_capture_id UUID, p_sequence_number INTEGER, p_economic_component TEXT,
  p_account_code TEXT, p_direction TEXT, p_amount_cents BIGINT,
  p_currency TEXT, p_created_at TIMESTAMPTZ
) RETURNS TEXT LANGUAGE SQL IMMUTABLE PARALLEL SAFE AS $$
  SELECT encode(digest(jsonb_build_object(
    'schema', 'HX_PAYMENT_LEDGER_ENTRY_V7',
    'ledgerEntryId', p_ledger_entry_id, 'ledgerTransactionId', p_ledger_transaction_id,
    'lifecycleId', p_lifecycle_id, 'captureId', p_capture_id,
    'sequenceNumber', p_sequence_number, 'economicComponent', p_economic_component,
    'accountCode', p_account_code, 'direction', p_direction,
    'amountCents', p_amount_cents, 'currency', p_currency,
    'createdAt', to_char(p_created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )::TEXT, 'sha256'), 'hex')
$$;

CREATE OR REPLACE FUNCTION hxos_payment_reconciliation_run_sha256_v7(
  p_reconciliation_run_id UUID, p_processor_code TEXT,
  p_period_start TIMESTAMPTZ, p_period_end TIMESTAMPTZ,
  p_source_material_sha256 TEXT, p_result_sha256 TEXT,
  p_item_count INTEGER, p_exception_count INTEGER, p_completed_at TIMESTAMPTZ
) RETURNS TEXT LANGUAGE SQL IMMUTABLE PARALLEL SAFE AS $$
  SELECT encode(digest(jsonb_build_object(
    'schema', 'HX_PAYMENT_RECONCILIATION_RUN_V7',
    'reconciliationRunId', p_reconciliation_run_id, 'processorCode', p_processor_code,
    'periodStart', to_char(p_period_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'periodEnd', to_char(p_period_end AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'state', 'COMPLETED', 'sourceMaterialSha256', p_source_material_sha256,
    'resultSha256', p_result_sha256, 'itemCount', p_item_count,
    'exceptionCount', p_exception_count,
    'completedAt', to_char(p_completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )::TEXT, 'sha256'), 'hex')
$$;

CREATE OR REPLACE FUNCTION hxos_payment_reconciliation_item_sha256_v7(
  p_reconciliation_item_id UUID, p_reconciliation_run_id UUID,
  p_lifecycle_id UUID, p_capture_id UUID, p_settlement_record_id UUID,
  p_ledger_transaction_id UUID, p_processor_code TEXT,
  p_reconciliation_state TEXT, p_processor_amount_cents BIGINT,
  p_ledger_amount_cents BIGINT, p_currency TEXT,
  p_settlement_material_sha256 TEXT, p_posting_material_sha256 TEXT,
  p_evidence_sha256 TEXT, p_created_at TIMESTAMPTZ
) RETURNS TEXT LANGUAGE SQL IMMUTABLE PARALLEL SAFE AS $$
  SELECT encode(digest(jsonb_build_object(
    'schema', 'HX_PAYMENT_RECONCILIATION_ITEM_V7',
    'reconciliationItemId', p_reconciliation_item_id,
    'reconciliationRunId', p_reconciliation_run_id, 'lifecycleId', p_lifecycle_id,
    'captureId', p_capture_id, 'settlementRecordId', p_settlement_record_id,
    'ledgerTransactionId', p_ledger_transaction_id, 'processorCode', p_processor_code,
    'reconciliationState', p_reconciliation_state,
    'processorAmountCents', p_processor_amount_cents,
    'ledgerAmountCents', p_ledger_amount_cents, 'currency', p_currency,
    'settlementMaterialSha256', p_settlement_material_sha256,
    'postingMaterialSha256', p_posting_material_sha256,
    'evidenceSha256', p_evidence_sha256,
    'createdAt', to_char(p_created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )::TEXT, 'sha256'), 'hex')
$$;

CREATE OR REPLACE FUNCTION hxos_payment_closure_attestation_sha256_v7(
  p_closure_attestation_id UUID, p_lifecycle_id UUID, p_capture_id UUID,
  p_settlement_record_id UUID, p_ledger_transaction_id UUID,
  p_reconciliation_run_id UUID, p_reconciliation_item_id UUID,
  p_open_post_funding_exposure_count INTEGER, p_closed_at TIMESTAMPTZ,
  p_evidence_sha256 TEXT
) RETURNS TEXT LANGUAGE SQL IMMUTABLE PARALLEL SAFE AS $$
  SELECT encode(digest(jsonb_build_object(
    'schema', 'HX_PAYMENT_CLOSURE_ATTESTATION_V7',
    'closureAttestationId', p_closure_attestation_id, 'lifecycleId', p_lifecycle_id,
    'captureId', p_capture_id, 'settlementRecordId', p_settlement_record_id,
    'ledgerTransactionId', p_ledger_transaction_id,
    'reconciliationRunId', p_reconciliation_run_id,
    'reconciliationItemId', p_reconciliation_item_id,
    'openPostFundingExposureCount', p_open_post_funding_exposure_count,
    'closedAt', to_char(p_closed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'evidenceSha256', p_evidence_sha256
  )::TEXT, 'sha256'), 'hex')
$$;

CREATE UNIQUE INDEX IF NOT EXISTS payment_captures_v7_d7_economics_binding_uq
  ON payment_captures_v7(
    capture_id, lifecycle_id, work_order_id, processor_code,
    approved_amount_cents, currency
  );

CREATE TABLE IF NOT EXISTS payment_capture_economics_v7 (
  economics_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  capture_id UUID NOT NULL UNIQUE,
  lifecycle_id UUID NOT NULL UNIQUE,
  work_order_id UUID NOT NULL UNIQUE,
  processor_code TEXT NOT NULL CHECK (processor_code ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  pricing_policy_version INTEGER NOT NULL CHECK (pricing_policy_version > 0),
  pricing_policy_sha256 CHAR(64) NOT NULL CHECK (pricing_policy_sha256 ~ '^[0-9a-f]{64}$'),
  relationship_origin TEXT NOT NULL CHECK (relationship_origin IN ('MARKETPLACE', 'PROVIDER_OS')),
  customer_amount_cents BIGINT NOT NULL CHECK (customer_amount_cents > 0),
  provider_amount_cents BIGINT NOT NULL CHECK (provider_amount_cents >= 0),
  platform_amount_cents BIGINT NOT NULL CHECK (platform_amount_cents >= 0),
  processor_cost_cents BIGINT NOT NULL CHECK (processor_cost_cents >= 0),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[a-z]{3}$'),
  evidence_sha256 CHAR(64) NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  economics_material_sha256 CHAR(64) NOT NULL UNIQUE CHECK (economics_material_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (
    economics_id, lifecycle_id, capture_id, processor_code,
    customer_amount_cents, provider_amount_cents, platform_amount_cents, currency
  ),
  FOREIGN KEY (
    capture_id, lifecycle_id, work_order_id, processor_code,
    customer_amount_cents, currency
  ) REFERENCES payment_captures_v7(
    capture_id, lifecycle_id, work_order_id, processor_code,
    approved_amount_cents, currency
  ) ON DELETE RESTRICT,
  CHECK (provider_amount_cents + platform_amount_cents = customer_amount_cents)
);

ALTER TABLE payment_settlement_records_v7
  ADD COLUMN IF NOT EXISTS economics_id UUID,
  ADD COLUMN IF NOT EXISTS sequence_number INTEGER,
  ADD COLUMN IF NOT EXISTS prior_settlement_record_id UUID,
  ADD COLUMN IF NOT EXISTS evidence_source TEXT,
  ADD COLUMN IF NOT EXISTS webhook_inbox_id UUID,
  ADD COLUMN IF NOT EXISTS observed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS settlement_material_sha256 CHAR(64);
ALTER TABLE payment_settlement_records_v7
  ALTER COLUMN economics_id SET NOT NULL,
  ALTER COLUMN sequence_number SET NOT NULL,
  ALTER COLUMN evidence_source SET NOT NULL,
  ALTER COLUMN observed_at SET NOT NULL,
  ALTER COLUMN settlement_material_sha256 SET NOT NULL,
  DROP CONSTRAINT IF EXISTS payment_settlement_records_v7_d7_economics_fk,
  ADD CONSTRAINT payment_settlement_records_v7_d7_economics_fk FOREIGN KEY (
    economics_id, lifecycle_id, capture_id, processor_code,
    customer_amount_cents, provider_amount_cents, platform_amount_cents, currency
  ) REFERENCES payment_capture_economics_v7(
    economics_id, lifecycle_id, capture_id, processor_code,
    customer_amount_cents, provider_amount_cents, platform_amount_cents, currency
  ) ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS payment_settlement_records_v7_d7_prior_fk,
  ADD CONSTRAINT payment_settlement_records_v7_d7_prior_fk
    FOREIGN KEY (prior_settlement_record_id) REFERENCES payment_settlement_records_v7(settlement_record_id) ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS payment_settlement_records_v7_d7_webhook_fk,
  ADD CONSTRAINT payment_settlement_records_v7_d7_webhook_fk
    FOREIGN KEY (webhook_inbox_id) REFERENCES payment_webhook_inbox_v7(webhook_inbox_id) ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS payment_settlement_records_v7_d7_sequence_ck,
  ADD CONSTRAINT payment_settlement_records_v7_d7_sequence_ck CHECK (sequence_number > 0),
  DROP CONSTRAINT IF EXISTS payment_settlement_records_v7_d7_source_ck,
  ADD CONSTRAINT payment_settlement_records_v7_d7_source_ck CHECK (
    evidence_source IN ('API_RESPONSE', 'WEBHOOK')
    AND (evidence_source = 'WEBHOOK') = (webhook_inbox_id IS NOT NULL)
  ),
  DROP CONSTRAINT IF EXISTS payment_settlement_records_v7_d7_material_ck,
  ADD CONSTRAINT payment_settlement_records_v7_d7_material_ck CHECK (
    settlement_material_sha256 ~ '^[0-9a-f]{64}$'
  );
CREATE UNIQUE INDEX IF NOT EXISTS payment_settlement_records_v7_d7_sequence_uq
  ON payment_settlement_records_v7(capture_id, sequence_number);
CREATE UNIQUE INDEX IF NOT EXISTS payment_settlement_records_v7_d7_material_uq
  ON payment_settlement_records_v7(settlement_material_sha256);
CREATE UNIQUE INDEX IF NOT EXISTS payment_settlement_records_v7_d7_ledger_binding_uq
  ON payment_settlement_records_v7(
    settlement_record_id, lifecycle_id, capture_id, economics_id,
    currency, customer_amount_cents
  );

ALTER TABLE payment_ledger_transactions_v7
  ADD COLUMN IF NOT EXISTS capture_id UUID,
  ADD COLUMN IF NOT EXISTS economics_id UUID,
  ADD COLUMN IF NOT EXISTS settlement_record_id UUID,
  ADD COLUMN IF NOT EXISTS expected_entry_count INTEGER,
  ADD COLUMN IF NOT EXISTS debit_total_cents BIGINT,
  ADD COLUMN IF NOT EXISTS credit_total_cents BIGINT,
  ADD COLUMN IF NOT EXISTS posting_material_sha256 CHAR(64);
ALTER TABLE payment_ledger_transactions_v7
  ALTER COLUMN capture_id SET NOT NULL,
  ALTER COLUMN economics_id SET NOT NULL,
  ALTER COLUMN settlement_record_id SET NOT NULL,
  ALTER COLUMN expected_entry_count SET NOT NULL,
  ALTER COLUMN debit_total_cents SET NOT NULL,
  ALTER COLUMN credit_total_cents SET NOT NULL,
  ALTER COLUMN posting_material_sha256 SET NOT NULL,
  DROP CONSTRAINT IF EXISTS payment_ledger_transactions_v7_d7_settlement_fk,
  ADD CONSTRAINT payment_ledger_transactions_v7_d7_settlement_fk FOREIGN KEY (
    settlement_record_id, lifecycle_id, capture_id, economics_id,
    currency, debit_total_cents
  ) REFERENCES payment_settlement_records_v7(
    settlement_record_id, lifecycle_id, capture_id, economics_id,
    currency, customer_amount_cents
  ) ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS payment_ledger_transactions_v7_d7_count_ck,
  ADD CONSTRAINT payment_ledger_transactions_v7_d7_count_ck CHECK (expected_entry_count BETWEEN 2 AND 5),
  DROP CONSTRAINT IF EXISTS payment_ledger_transactions_v7_d7_balance_ck,
  ADD CONSTRAINT payment_ledger_transactions_v7_d7_balance_ck CHECK (
    debit_total_cents > 0 AND debit_total_cents = credit_total_cents
  ),
  DROP CONSTRAINT IF EXISTS payment_ledger_transactions_v7_d7_material_ck,
  ADD CONSTRAINT payment_ledger_transactions_v7_d7_material_ck CHECK (
    posting_material_sha256 ~ '^[0-9a-f]{64}$'
  );
CREATE UNIQUE INDEX IF NOT EXISTS payment_ledger_transactions_v7_d7_binding_uq
  ON payment_ledger_transactions_v7(
    ledger_transaction_id, lifecycle_id, capture_id, economics_id,
    settlement_record_id, currency, debit_total_cents
  );
CREATE UNIQUE INDEX IF NOT EXISTS payment_ledger_transactions_v7_d7_settlement_uq
  ON payment_ledger_transactions_v7(settlement_record_id);
CREATE UNIQUE INDEX IF NOT EXISTS payment_ledger_transactions_v7_d7_entry_fk_uq
  ON payment_ledger_transactions_v7(
    ledger_transaction_id, lifecycle_id, capture_id, currency
  );

ALTER TABLE payment_ledger_entries_v7
  ADD COLUMN IF NOT EXISTS lifecycle_id UUID,
  ADD COLUMN IF NOT EXISTS capture_id UUID,
  ADD COLUMN IF NOT EXISTS sequence_number INTEGER,
  ADD COLUMN IF NOT EXISTS economic_component TEXT,
  ADD COLUMN IF NOT EXISTS currency CHAR(3),
  ADD COLUMN IF NOT EXISTS entry_material_sha256 CHAR(64);
ALTER TABLE payment_ledger_entries_v7
  ALTER COLUMN lifecycle_id SET NOT NULL,
  ALTER COLUMN capture_id SET NOT NULL,
  ALTER COLUMN sequence_number SET NOT NULL,
  ALTER COLUMN economic_component SET NOT NULL,
  ALTER COLUMN currency SET NOT NULL,
  ALTER COLUMN entry_material_sha256 SET NOT NULL,
  DROP CONSTRAINT IF EXISTS payment_ledger_entries_v7_d7_transaction_fk,
  ADD CONSTRAINT payment_ledger_entries_v7_d7_transaction_fk FOREIGN KEY (
    ledger_transaction_id, lifecycle_id, capture_id, currency
  ) REFERENCES payment_ledger_transactions_v7(
    ledger_transaction_id, lifecycle_id, capture_id, currency
  ) ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS payment_ledger_entries_v7_d7_sequence_ck,
  ADD CONSTRAINT payment_ledger_entries_v7_d7_sequence_ck CHECK (sequence_number > 0),
  DROP CONSTRAINT IF EXISTS payment_ledger_entries_v7_d7_component_ck,
  ADD CONSTRAINT payment_ledger_entries_v7_d7_component_ck CHECK (
    economic_component IN (
      'CUSTOMER_GMV', 'PROVIDER_ECONOMICS', 'PLATFORM_FEE',
      'PROCESSOR_COST', 'PROCESSOR_PAYABLE'
    )
  ),
  DROP CONSTRAINT IF EXISTS payment_ledger_entries_v7_d7_currency_ck,
  ADD CONSTRAINT payment_ledger_entries_v7_d7_currency_ck CHECK (currency ~ '^[a-z]{3}$'),
  DROP CONSTRAINT IF EXISTS payment_ledger_entries_v7_d7_material_ck,
  ADD CONSTRAINT payment_ledger_entries_v7_d7_material_ck CHECK (
    entry_material_sha256 ~ '^[0-9a-f]{64}$'
  );
CREATE UNIQUE INDEX IF NOT EXISTS payment_ledger_entries_v7_d7_sequence_uq
  ON payment_ledger_entries_v7(ledger_transaction_id, sequence_number);
CREATE UNIQUE INDEX IF NOT EXISTS payment_ledger_entries_v7_d7_component_uq
  ON payment_ledger_entries_v7(ledger_transaction_id, economic_component);
CREATE UNIQUE INDEX IF NOT EXISTS payment_ledger_entries_v7_d7_material_uq
  ON payment_ledger_entries_v7(entry_material_sha256);

ALTER TABLE payment_reconciliation_runs_v7
  ADD COLUMN IF NOT EXISTS item_count INTEGER,
  ADD COLUMN IF NOT EXISTS exception_count INTEGER,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS run_material_sha256 CHAR(64);
ALTER TABLE payment_reconciliation_runs_v7
  ALTER COLUMN item_count SET NOT NULL,
  ALTER COLUMN exception_count SET NOT NULL,
  ALTER COLUMN completed_at SET NOT NULL,
  ALTER COLUMN run_material_sha256 SET NOT NULL,
  DROP CONSTRAINT IF EXISTS payment_reconciliation_runs_v7_d7_count_ck,
  ADD CONSTRAINT payment_reconciliation_runs_v7_d7_count_ck CHECK (
    item_count > 0 AND exception_count BETWEEN 0 AND item_count
  ),
  DROP CONSTRAINT IF EXISTS payment_reconciliation_runs_v7_d7_material_ck,
  ADD CONSTRAINT payment_reconciliation_runs_v7_d7_material_ck CHECK (
    run_material_sha256 ~ '^[0-9a-f]{64}$'
  );
CREATE UNIQUE INDEX IF NOT EXISTS payment_reconciliation_runs_v7_d7_binding_uq
  ON payment_reconciliation_runs_v7(
    reconciliation_run_id, processor_code, item_count, exception_count
  );
CREATE UNIQUE INDEX IF NOT EXISTS payment_ledger_transactions_v7_d7_reconcile_fk_uq
  ON payment_ledger_transactions_v7(
    ledger_transaction_id, lifecycle_id, capture_id, settlement_record_id,
    currency, debit_total_cents
  );
CREATE UNIQUE INDEX IF NOT EXISTS payment_reconciliation_runs_v7_d7_processor_uq
  ON payment_reconciliation_runs_v7(reconciliation_run_id, processor_code);

CREATE TABLE IF NOT EXISTS payment_reconciliation_items_v7 (
  reconciliation_item_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reconciliation_run_id UUID NOT NULL,
  lifecycle_id UUID NOT NULL UNIQUE,
  capture_id UUID NOT NULL UNIQUE,
  settlement_record_id UUID NOT NULL UNIQUE,
  ledger_transaction_id UUID NOT NULL UNIQUE,
  processor_code TEXT NOT NULL CHECK (processor_code ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  reconciliation_state TEXT NOT NULL CHECK (reconciliation_state IN ('MATCHED', 'EXCEPTION')),
  processor_amount_cents BIGINT NOT NULL CHECK (processor_amount_cents > 0),
  ledger_amount_cents BIGINT NOT NULL CHECK (ledger_amount_cents > 0),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[a-z]{3}$'),
  settlement_material_sha256 CHAR(64) NOT NULL CHECK (settlement_material_sha256 ~ '^[0-9a-f]{64}$'),
  posting_material_sha256 CHAR(64) NOT NULL CHECK (posting_material_sha256 ~ '^[0-9a-f]{64}$'),
  evidence_sha256 CHAR(64) NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  item_material_sha256 CHAR(64) NOT NULL UNIQUE CHECK (item_material_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (
    reconciliation_item_id, reconciliation_run_id, lifecycle_id,
    capture_id, settlement_record_id, ledger_transaction_id
  ),
  FOREIGN KEY (reconciliation_run_id, processor_code)
    REFERENCES payment_reconciliation_runs_v7(reconciliation_run_id, processor_code) ON DELETE RESTRICT,
  FOREIGN KEY (
    ledger_transaction_id, lifecycle_id, capture_id, settlement_record_id,
    currency, ledger_amount_cents
  ) REFERENCES payment_ledger_transactions_v7(
    ledger_transaction_id, lifecycle_id, capture_id, settlement_record_id,
    currency, debit_total_cents
  ) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS payment_closure_attestations_v7 (
  closure_attestation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lifecycle_id UUID NOT NULL UNIQUE,
  capture_id UUID NOT NULL UNIQUE,
  settlement_record_id UUID NOT NULL UNIQUE,
  ledger_transaction_id UUID NOT NULL UNIQUE,
  reconciliation_run_id UUID NOT NULL,
  reconciliation_item_id UUID NOT NULL UNIQUE,
  open_post_funding_exposure_count INTEGER NOT NULL CHECK (open_post_funding_exposure_count = 0),
  closed_at TIMESTAMPTZ NOT NULL,
  evidence_sha256 CHAR(64) NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  closure_material_sha256 CHAR(64) NOT NULL UNIQUE CHECK (closure_material_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (
    reconciliation_item_id, reconciliation_run_id, lifecycle_id,
    capture_id, settlement_record_id, ledger_transaction_id
  ) REFERENCES payment_reconciliation_items_v7(
    reconciliation_item_id, reconciliation_run_id, lifecycle_id,
    capture_id, settlement_record_id, ledger_transaction_id
  ) ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION hxos_reject_payment_underwriting_d7_mutation_v7()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'HXPV71: payment underwriting D7 evidence is append-only'
    USING ERRCODE = 'P0001';
END;
$$;

CREATE OR REPLACE FUNCTION hxos_enforce_payment_capture_economics_v7()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_capture payment_capture_status_v7%ROWTYPE;
  v_stage TEXT;
  v_expected TEXT;
  v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  SELECT * INTO v_capture FROM payment_capture_status_v7
   WHERE capture_id = NEW.capture_id;
  SELECT stage INTO v_stage FROM payment_underwriting_lifecycle_status_v7
   WHERE lifecycle_id = NEW.lifecycle_id;
  v_expected := hxos_payment_capture_economics_sha256_v7(
    NEW.economics_id, NEW.capture_id, NEW.lifecycle_id, NEW.work_order_id,
    NEW.processor_code, NEW.pricing_policy_version,
    NEW.pricing_policy_sha256::TEXT, NEW.relationship_origin,
    NEW.customer_amount_cents, NEW.provider_amount_cents,
    NEW.platform_amount_cents, NEW.processor_cost_cents, NEW.currency,
    NEW.evidence_sha256::TEXT, NEW.created_at
  );
  IF v_capture.capture_id IS NULL
     OR v_stage IS DISTINCT FROM 'CAPTURED'
     OR v_capture.agreement_state IS DISTINCT FROM 'AGREED'
     OR v_capture.approved_amount_cents IS DISTINCT FROM NEW.customer_amount_cents
     OR v_capture.currency IS DISTINCT FROM NEW.currency
     OR NEW.provider_amount_cents + NEW.platform_amount_cents
        IS DISTINCT FROM NEW.customer_amount_cents
     OR NEW.created_at < v_now - INTERVAL '5 minutes'
     OR NEW.created_at > v_now + INTERVAL '5 seconds'
     OR NEW.economics_material_sha256::TEXT IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'HXPV72: economics lack exact capture agreement or versioned balance'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION hxos_enforce_payment_settlement_record_v7()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_economics payment_capture_economics_v7%ROWTYPE;
  v_capture payment_capture_status_v7%ROWTYPE;
  v_latest payment_settlement_records_v7%ROWTYPE;
  v_webhook payment_webhook_inbox_v7%ROWTYPE;
  v_expected TEXT;
  v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  SELECT * INTO v_economics FROM payment_capture_economics_v7
   WHERE economics_id = NEW.economics_id FOR SHARE;
  SELECT * INTO v_capture FROM payment_capture_status_v7
   WHERE capture_id = NEW.capture_id;
  SELECT * INTO v_latest FROM payment_settlement_records_v7
   WHERE capture_id = NEW.capture_id
   ORDER BY sequence_number DESC LIMIT 1 FOR UPDATE;
  IF NEW.evidence_source = 'WEBHOOK' THEN
    SELECT * INTO v_webhook FROM payment_webhook_inbox_v7
     WHERE webhook_inbox_id = NEW.webhook_inbox_id FOR SHARE;
  END IF;
  v_expected := hxos_payment_settlement_record_sha256_v7(
    NEW.settlement_record_id, NEW.economics_id, NEW.lifecycle_id,
    NEW.capture_id, NEW.processor_code, NEW.sequence_number,
    NEW.prior_settlement_record_id, NEW.state, NEW.customer_amount_cents,
    NEW.provider_amount_cents, NEW.platform_amount_cents, NEW.currency,
    NEW.evidence_source, NEW.webhook_inbox_id,
    NEW.external_reference_sha256::TEXT, NEW.evidence_sha256::TEXT,
    NEW.observed_at
  );
  IF v_economics.economics_id IS NULL
     OR v_capture.agreement_state IS DISTINCT FROM 'AGREED'
     OR NEW.observed_at < v_economics.created_at
     OR NEW.observed_at > v_now + INTERVAL '5 seconds'
     OR (v_latest.settlement_record_id IS NULL AND (
       NEW.sequence_number <> 1 OR NEW.prior_settlement_record_id IS NOT NULL
       OR NEW.state <> 'SETTLING'
     ))
     OR (v_latest.settlement_record_id IS NOT NULL AND (
       NEW.sequence_number <> v_latest.sequence_number + 1
       OR NEW.prior_settlement_record_id IS DISTINCT FROM v_latest.settlement_record_id
       OR NEW.observed_at < v_latest.observed_at
       OR CASE v_latest.state
         WHEN 'SETTLING' THEN NEW.state NOT IN ('FUNDED', 'PAYOUT_PENDING')
         WHEN 'PAYOUT_PENDING' THEN NEW.state <> 'PAID_OUT'
         ELSE TRUE
       END
     ))
     OR (NEW.state IN ('FUNDED', 'PAID_OUT') AND (
       NEW.evidence_source <> 'WEBHOOK'
       OR v_webhook.webhook_inbox_id IS NULL
       OR v_webhook.authentication_state <> 'VERIFIED'
       OR v_webhook.processing_state NOT IN ('NORMALIZED', 'APPLIED')
       OR v_webhook.processor_code IS DISTINCT FROM NEW.processor_code
       OR v_webhook.normalized_event_type IS DISTINCT FROM 'SETTLEMENT_' || NEW.state
       OR v_webhook.event_id_sha256 IS DISTINCT FROM NEW.external_reference_sha256
     ))
     OR NEW.settlement_material_sha256::TEXT IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'HXPV73: settlement evidence is unauthenticated, crossed, or nonterminal'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION hxos_enforce_payment_ledger_transaction_v7()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_settlement payment_settlement_records_v7%ROWTYPE;
  v_economics payment_capture_economics_v7%ROWTYPE;
  v_expected_count INTEGER;
  v_expected_total BIGINT;
  v_expected TEXT;
BEGIN
  SELECT * INTO v_settlement FROM payment_settlement_records_v7
   WHERE settlement_record_id = NEW.settlement_record_id FOR SHARE;
  SELECT * INTO v_economics FROM payment_capture_economics_v7
   WHERE economics_id = NEW.economics_id FOR SHARE;
  v_expected_count := 1
    + CASE WHEN v_economics.provider_amount_cents > 0 THEN 1 ELSE 0 END
    + CASE WHEN v_economics.platform_amount_cents > 0 THEN 1 ELSE 0 END
    + CASE WHEN v_economics.processor_cost_cents > 0 THEN 2 ELSE 0 END;
  v_expected_total := v_economics.customer_amount_cents + v_economics.processor_cost_cents;
  v_expected := hxos_payment_ledger_transaction_sha256_v7(
    NEW.ledger_transaction_id, NEW.lifecycle_id, NEW.capture_id,
    NEW.economics_id, NEW.settlement_record_id, NEW.currency,
    NEW.expected_entry_count, NEW.debit_total_cents, NEW.credit_total_cents,
    NEW.source_operation_id, NEW.created_at
  );
  IF v_settlement.settlement_record_id IS NULL
     OR v_settlement.state NOT IN ('FUNDED', 'PAID_OUT')
     OR v_economics.economics_id IS NULL
     OR NEW.transaction_type <> 'SETTLEMENT'
     OR NEW.state <> 'POSTED'
     OR NEW.source_operation_id IS DISTINCT FROM NEW.settlement_record_id
     OR NEW.expected_entry_count IS DISTINCT FROM v_expected_count
     OR NEW.debit_total_cents IS DISTINCT FROM v_expected_total
     OR NEW.credit_total_cents IS DISTINCT FROM v_expected_total
     OR NEW.material_sha256::TEXT IS DISTINCT FROM v_expected
     OR NEW.posting_material_sha256::TEXT IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'HXPV74: ledger posting lacks terminal settlement or exact economics'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION hxos_enforce_payment_ledger_entry_v7()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_transaction payment_ledger_transactions_v7%ROWTYPE;
  v_economics payment_capture_economics_v7%ROWTYPE;
  v_expected_amount BIGINT;
  v_expected_direction TEXT;
  v_expected_account TEXT;
  v_expected_sequence INTEGER;
  v_expected TEXT;
BEGIN
  SELECT * INTO v_transaction FROM payment_ledger_transactions_v7
   WHERE ledger_transaction_id = NEW.ledger_transaction_id FOR SHARE;
  SELECT * INTO v_economics FROM payment_capture_economics_v7
   WHERE economics_id = v_transaction.economics_id FOR SHARE;
  SELECT amount, direction, account, sequence_number
    INTO v_expected_amount, v_expected_direction, v_expected_account, v_expected_sequence
    FROM (VALUES
      ('CUSTOMER_GMV', v_economics.customer_amount_cents, 'DEBIT', 'CUSTOMER_SETTLEMENT_CLEARING', 1),
      ('PROVIDER_ECONOMICS', v_economics.provider_amount_cents, 'CREDIT', 'PROVIDER_PAYABLE', 2),
      ('PLATFORM_FEE', v_economics.platform_amount_cents, 'CREDIT', 'PLATFORM_REVENUE', 3),
      ('PROCESSOR_COST', v_economics.processor_cost_cents, 'DEBIT', 'PROCESSOR_COST_EXPENSE', 4),
      ('PROCESSOR_PAYABLE', v_economics.processor_cost_cents, 'CREDIT', 'PROCESSOR_PAYABLE', 5)
    ) AS expected(component, amount, direction, account, sequence_number)
   WHERE component = NEW.economic_component;
  v_expected := hxos_payment_ledger_entry_sha256_v7(
    NEW.ledger_entry_id, NEW.ledger_transaction_id, NEW.lifecycle_id,
    NEW.capture_id, NEW.sequence_number, NEW.economic_component,
    NEW.account_code, NEW.direction, NEW.amount_cents, NEW.currency, NEW.created_at
  );
  IF v_transaction.ledger_transaction_id IS NULL
     OR v_economics.economics_id IS NULL
     OR v_expected_amount IS NULL OR v_expected_amount <= 0
     OR NEW.amount_cents IS DISTINCT FROM v_expected_amount
     OR NEW.direction IS DISTINCT FROM v_expected_direction
     OR NEW.account_code IS DISTINCT FROM v_expected_account
     OR NEW.sequence_number IS DISTINCT FROM v_expected_sequence
     OR NEW.entry_sha256::TEXT IS DISTINCT FROM v_expected
     OR NEW.entry_material_sha256::TEXT IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'HXPV75: ledger entry is crossed or does not match versioned economics'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION hxos_assert_payment_ledger_balanced_v7()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_transaction_id UUID;
  v_transaction payment_ledger_transactions_v7%ROWTYPE;
  v_count BIGINT;
  v_debits BIGINT;
  v_credits BIGINT;
BEGIN
  v_transaction_id := CASE
    WHEN TG_TABLE_NAME = 'payment_ledger_transactions_v7' THEN NEW.ledger_transaction_id
    ELSE NEW.ledger_transaction_id
  END;
  SELECT * INTO v_transaction FROM payment_ledger_transactions_v7
   WHERE ledger_transaction_id = v_transaction_id;
  SELECT count(*),
         COALESCE(sum(CASE WHEN direction = 'DEBIT' THEN amount_cents ELSE 0 END), 0),
         COALESCE(sum(CASE WHEN direction = 'CREDIT' THEN amount_cents ELSE 0 END), 0)
    INTO v_count, v_debits, v_credits
    FROM payment_ledger_entries_v7
   WHERE ledger_transaction_id = v_transaction_id;
  IF v_transaction.ledger_transaction_id IS NULL
     OR v_count IS DISTINCT FROM v_transaction.expected_entry_count::BIGINT
     OR v_debits IS DISTINCT FROM v_transaction.debit_total_cents
     OR v_credits IS DISTINCT FROM v_transaction.credit_total_cents
     OR v_debits IS DISTINCT FROM v_credits THEN
    RAISE EXCEPTION 'HXPV76: posted ledger is not component-complete and balanced'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION hxos_enforce_payment_reconciliation_run_v7()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_expected TEXT;
  v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  v_expected := hxos_payment_reconciliation_run_sha256_v7(
    NEW.reconciliation_run_id, NEW.processor_code, NEW.period_start,
    NEW.period_end, NEW.source_material_sha256::TEXT, NEW.result_sha256::TEXT,
    NEW.item_count, NEW.exception_count, NEW.completed_at
  );
  IF NEW.state <> 'COMPLETED'
     OR NEW.result_sha256 IS NULL
     OR NEW.completed_at < NEW.period_end
     OR NEW.completed_at > v_now + INTERVAL '5 seconds'
     OR NEW.run_material_sha256::TEXT IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'HXPV77: reconciliation run is incomplete or unauthenticated'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION hxos_enforce_payment_reconciliation_item_v7()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_run payment_reconciliation_runs_v7%ROWTYPE;
  v_settlement payment_settlement_records_v7%ROWTYPE;
  v_transaction payment_ledger_transactions_v7%ROWTYPE;
  v_expected TEXT;
  v_exact BOOLEAN;
BEGIN
  SELECT * INTO v_run FROM payment_reconciliation_runs_v7
   WHERE reconciliation_run_id = NEW.reconciliation_run_id FOR SHARE;
  SELECT * INTO v_settlement FROM payment_settlement_records_v7
   WHERE settlement_record_id = NEW.settlement_record_id FOR SHARE;
  SELECT * INTO v_transaction FROM payment_ledger_transactions_v7
   WHERE ledger_transaction_id = NEW.ledger_transaction_id FOR SHARE;
  v_exact := v_run.state = 'COMPLETED'
    AND v_settlement.state IN ('FUNDED', 'PAID_OUT')
    AND v_transaction.state = 'POSTED'
    AND NEW.processor_amount_cents = v_settlement.customer_amount_cents
    AND NEW.ledger_amount_cents = v_transaction.debit_total_cents
    AND NEW.processor_amount_cents = NEW.ledger_amount_cents
    AND NEW.currency = v_settlement.currency
    AND NEW.currency = v_transaction.currency
    AND NEW.settlement_material_sha256 = v_settlement.settlement_material_sha256
    AND NEW.posting_material_sha256 = v_transaction.posting_material_sha256;
  v_expected := hxos_payment_reconciliation_item_sha256_v7(
    NEW.reconciliation_item_id, NEW.reconciliation_run_id, NEW.lifecycle_id,
    NEW.capture_id, NEW.settlement_record_id, NEW.ledger_transaction_id,
    NEW.processor_code, NEW.reconciliation_state,
    NEW.processor_amount_cents, NEW.ledger_amount_cents, NEW.currency,
    NEW.settlement_material_sha256::TEXT, NEW.posting_material_sha256::TEXT,
    NEW.evidence_sha256::TEXT, NEW.created_at
  );
  IF v_run.reconciliation_run_id IS NULL
     OR v_settlement.settlement_record_id IS NULL
     OR v_transaction.ledger_transaction_id IS NULL
     OR (NEW.reconciliation_state = 'MATCHED' AND NOT v_exact)
     OR (NEW.reconciliation_state = 'EXCEPTION' AND v_exact)
     OR NEW.item_material_sha256::TEXT IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'HXPV78: reconciliation item does not bind processor and ledger facts'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION hxos_assert_payment_reconciliation_complete_v7()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_run_id UUID;
  v_run payment_reconciliation_runs_v7%ROWTYPE;
  v_count BIGINT;
  v_exceptions BIGINT;
BEGIN
  v_run_id := CASE
    WHEN TG_TABLE_NAME = 'payment_reconciliation_runs_v7' THEN NEW.reconciliation_run_id
    ELSE NEW.reconciliation_run_id
  END;
  SELECT * INTO v_run FROM payment_reconciliation_runs_v7
   WHERE reconciliation_run_id = v_run_id;
  SELECT count(*), count(*) FILTER (WHERE reconciliation_state = 'EXCEPTION')
    INTO v_count, v_exceptions
    FROM payment_reconciliation_items_v7
   WHERE reconciliation_run_id = v_run_id;
  IF v_run.reconciliation_run_id IS NULL
     OR v_count IS DISTINCT FROM v_run.item_count::BIGINT
     OR v_exceptions IS DISTINCT FROM v_run.exception_count::BIGINT THEN
    RAISE EXCEPTION 'HXPV79: reconciliation run item or exception count is incomplete'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
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
  v_expected TEXT;
  v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  SELECT * INTO v_item FROM payment_reconciliation_items_v7
   WHERE reconciliation_item_id = NEW.reconciliation_item_id FOR SHARE;
  SELECT * INTO v_run FROM payment_reconciliation_runs_v7
   WHERE reconciliation_run_id = NEW.reconciliation_run_id FOR SHARE;
  SELECT * INTO v_settlement FROM payment_settlement_records_v7
   WHERE settlement_record_id = NEW.settlement_record_id FOR SHARE;
  SELECT * INTO v_transaction FROM payment_ledger_transactions_v7
   WHERE ledger_transaction_id = NEW.ledger_transaction_id FOR SHARE;
  SELECT stage INTO v_stage FROM payment_underwriting_lifecycle_status_v7
   WHERE lifecycle_id = NEW.lifecycle_id;
  SELECT count(*),
         COALESCE(sum(CASE WHEN direction = 'DEBIT' THEN amount_cents ELSE 0 END), 0),
         COALESCE(sum(CASE WHEN direction = 'CREDIT' THEN amount_cents ELSE 0 END), 0)
    INTO v_entry_count, v_debits, v_credits
    FROM payment_ledger_entries_v7
   WHERE ledger_transaction_id = NEW.ledger_transaction_id;
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
     OR NEW.closed_at < v_run.completed_at
     OR NEW.closed_at > v_now + INTERVAL '5 seconds'
     OR NEW.closure_material_sha256::TEXT IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'HXPV80: closure lacks terminal processor and balanced ledger agreement'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION hxos_enforce_payment_closure_transition_v7()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_settlement payment_settlement_records_v7%ROWTYPE;
  v_item payment_reconciliation_items_v7%ROWTYPE;
  v_attestation payment_closure_attestations_v7%ROWTYPE;
BEGIN
  IF NEW.stage IN ('SETTLING', 'PAYOUT_PENDING', 'FUNDED', 'PAID_OUT') THEN
    SELECT * INTO v_settlement FROM payment_settlement_records_v7
     WHERE lifecycle_id = NEW.lifecycle_id
     ORDER BY sequence_number DESC LIMIT 1;
    IF v_settlement.settlement_record_id IS NULL
       OR v_settlement.state IS DISTINCT FROM NEW.stage
       OR NEW.evidence_sha256 IS DISTINCT FROM v_settlement.settlement_material_sha256 THEN
      RAISE EXCEPTION 'HXPV81: settlement transition lacks exact processor evidence'
        USING ERRCODE = 'P0001';
    END IF;
  ELSIF NEW.stage = 'RECONCILED' THEN
    SELECT * INTO v_item FROM payment_reconciliation_items_v7
     WHERE lifecycle_id = NEW.lifecycle_id;
    IF v_item.reconciliation_item_id IS NULL
       OR v_item.reconciliation_state IS DISTINCT FROM 'MATCHED'
       OR NEW.evidence_sha256 IS DISTINCT FROM v_item.item_material_sha256 THEN
      RAISE EXCEPTION 'HXPV81: reconciled transition lacks processor-ledger agreement'
        USING ERRCODE = 'P0001';
    END IF;
  ELSIF NEW.stage = 'CLOSED' THEN
    SELECT * INTO v_attestation FROM payment_closure_attestations_v7
     WHERE lifecycle_id = NEW.lifecycle_id;
    IF v_attestation.closure_attestation_id IS NULL
       OR NEW.evidence_sha256 IS DISTINCT FROM v_attestation.closure_material_sha256 THEN
      RAISE EXCEPTION 'HXPV81: closed transition lacks exact closure attestation'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE VIEW payment_settlement_close_status_v7
WITH (security_invoker = true, security_barrier = true) AS
SELECT
  economics.lifecycle_id,
  economics.capture_id,
  economics.economics_id,
  economics.customer_amount_cents,
  economics.provider_amount_cents,
  economics.platform_amount_cents,
  economics.processor_cost_cents,
  economics.currency,
  settlement.settlement_record_id,
  settlement.state AS settlement_state,
  settlement.settlement_material_sha256,
  ledger.ledger_transaction_id,
  ledger.state AS ledger_state,
  ledger.debit_total_cents,
  ledger.credit_total_cents,
  item.reconciliation_item_id,
  item.reconciliation_state,
  run.reconciliation_run_id,
  run.state AS reconciliation_run_state,
  run.exception_count,
  closure.closure_attestation_id,
  closure.open_post_funding_exposure_count,
  closure.closure_material_sha256
FROM payment_capture_economics_v7 economics
LEFT JOIN LATERAL (
  SELECT * FROM payment_settlement_records_v7 candidate
   WHERE candidate.capture_id = economics.capture_id
   ORDER BY candidate.sequence_number DESC LIMIT 1
) settlement ON TRUE
LEFT JOIN payment_ledger_transactions_v7 ledger
  ON ledger.settlement_record_id = settlement.settlement_record_id
LEFT JOIN payment_reconciliation_items_v7 item
  ON item.ledger_transaction_id = ledger.ledger_transaction_id
LEFT JOIN payment_reconciliation_runs_v7 run
  ON run.reconciliation_run_id = item.reconciliation_run_id
LEFT JOIN payment_closure_attestations_v7 closure
  ON closure.reconciliation_item_id = item.reconciliation_item_id;

DROP TRIGGER IF EXISTS payment_capture_economics_insert_guard_v7
  ON payment_capture_economics_v7;
CREATE TRIGGER payment_capture_economics_insert_guard_v7
BEFORE INSERT ON payment_capture_economics_v7
FOR EACH ROW EXECUTE FUNCTION hxos_enforce_payment_capture_economics_v7();
DROP TRIGGER IF EXISTS payment_settlement_record_insert_guard_v7
  ON payment_settlement_records_v7;
CREATE TRIGGER payment_settlement_record_insert_guard_v7
BEFORE INSERT ON payment_settlement_records_v7
FOR EACH ROW EXECUTE FUNCTION hxos_enforce_payment_settlement_record_v7();
DROP TRIGGER IF EXISTS payment_ledger_transaction_insert_guard_v7
  ON payment_ledger_transactions_v7;
CREATE TRIGGER payment_ledger_transaction_insert_guard_v7
BEFORE INSERT ON payment_ledger_transactions_v7
FOR EACH ROW EXECUTE FUNCTION hxos_enforce_payment_ledger_transaction_v7();
DROP TRIGGER IF EXISTS payment_ledger_entry_insert_guard_v7
  ON payment_ledger_entries_v7;
CREATE TRIGGER payment_ledger_entry_insert_guard_v7
BEFORE INSERT ON payment_ledger_entries_v7
FOR EACH ROW EXECUTE FUNCTION hxos_enforce_payment_ledger_entry_v7();
DROP TRIGGER IF EXISTS payment_reconciliation_run_insert_guard_v7
  ON payment_reconciliation_runs_v7;
CREATE TRIGGER payment_reconciliation_run_insert_guard_v7
BEFORE INSERT ON payment_reconciliation_runs_v7
FOR EACH ROW EXECUTE FUNCTION hxos_enforce_payment_reconciliation_run_v7();
DROP TRIGGER IF EXISTS payment_reconciliation_item_insert_guard_v7
  ON payment_reconciliation_items_v7;
CREATE TRIGGER payment_reconciliation_item_insert_guard_v7
BEFORE INSERT ON payment_reconciliation_items_v7
FOR EACH ROW EXECUTE FUNCTION hxos_enforce_payment_reconciliation_item_v7();
DROP TRIGGER IF EXISTS payment_closure_attestation_insert_guard_v7
  ON payment_closure_attestations_v7;
CREATE TRIGGER payment_closure_attestation_insert_guard_v7
BEFORE INSERT ON payment_closure_attestations_v7
FOR EACH ROW EXECUTE FUNCTION hxos_enforce_payment_closure_attestation_v7();
DROP TRIGGER IF EXISTS payment_closure_transition_guard_v7
  ON payment_underwriting_lifecycle_events_v7;
CREATE TRIGGER payment_closure_transition_guard_v7
BEFORE INSERT ON payment_underwriting_lifecycle_events_v7
FOR EACH ROW EXECUTE FUNCTION hxos_enforce_payment_closure_transition_v7();

DROP TRIGGER IF EXISTS payment_ledger_transaction_balance_v7
  ON payment_ledger_transactions_v7;
CREATE CONSTRAINT TRIGGER payment_ledger_transaction_balance_v7
AFTER INSERT ON payment_ledger_transactions_v7
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION hxos_assert_payment_ledger_balanced_v7();
DROP TRIGGER IF EXISTS payment_ledger_entry_balance_v7 ON payment_ledger_entries_v7;
CREATE CONSTRAINT TRIGGER payment_ledger_entry_balance_v7
AFTER INSERT ON payment_ledger_entries_v7
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION hxos_assert_payment_ledger_balanced_v7();
DROP TRIGGER IF EXISTS payment_reconciliation_run_complete_v7
  ON payment_reconciliation_runs_v7;
CREATE CONSTRAINT TRIGGER payment_reconciliation_run_complete_v7
AFTER INSERT ON payment_reconciliation_runs_v7
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION hxos_assert_payment_reconciliation_complete_v7();
DROP TRIGGER IF EXISTS payment_reconciliation_item_complete_v7
  ON payment_reconciliation_items_v7;
CREATE CONSTRAINT TRIGGER payment_reconciliation_item_complete_v7
AFTER INSERT ON payment_reconciliation_items_v7
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION hxos_assert_payment_reconciliation_complete_v7();

DO $$
DECLARE relation_name TEXT;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'payment_capture_economics_v7',
    'payment_reconciliation_items_v7',
    'payment_closure_attestations_v7'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', relation_name || '_append_only_v7', relation_name);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE OR TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION hxos_reject_payment_underwriting_d7_mutation_v7()',
      relation_name || '_append_only_v7', relation_name
    );
  END LOOP;
END;
$$;

REVOKE ALL ON TABLE
  payment_capture_economics_v7,
  payment_settlement_records_v7,
  payment_ledger_transactions_v7,
  payment_ledger_entries_v7,
  payment_reconciliation_runs_v7,
  payment_reconciliation_items_v7,
  payment_closure_attestations_v7,
  payment_settlement_close_status_v7
FROM PUBLIC;

DO $$
DECLARE function_oid OID;
BEGIN
  FOR function_oid IN
    SELECT oid FROM pg_proc
     WHERE pronamespace = 'public'::regnamespace
       AND proname IN (
         'hxos_payment_capture_economics_sha256_v7',
         'hxos_payment_settlement_record_sha256_v7',
         'hxos_payment_ledger_transaction_sha256_v7',
         'hxos_payment_ledger_entry_sha256_v7',
         'hxos_payment_reconciliation_run_sha256_v7',
         'hxos_payment_reconciliation_item_sha256_v7',
         'hxos_payment_closure_attestation_sha256_v7',
         'hxos_reject_payment_underwriting_d7_mutation_v7',
         'hxos_enforce_payment_capture_economics_v7',
         'hxos_enforce_payment_settlement_record_v7',
         'hxos_enforce_payment_ledger_transaction_v7',
         'hxos_enforce_payment_ledger_entry_v7',
         'hxos_assert_payment_ledger_balanced_v7',
         'hxos_enforce_payment_reconciliation_run_v7',
         'hxos_enforce_payment_reconciliation_item_v7',
         'hxos_assert_payment_reconciliation_complete_v7',
         'hxos_enforce_payment_closure_attestation_v7',
         'hxos_enforce_payment_closure_transition_v7'
       )
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', function_oid::regprocedure);
  END LOOP;
END;
$$;
