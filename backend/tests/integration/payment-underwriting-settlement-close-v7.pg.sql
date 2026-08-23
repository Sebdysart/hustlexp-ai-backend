\if :{?HXP_D8_COMPOSED}
\else
BEGIN;
\endif

SET LOCAL hustlexp.local_test_identity_enabled = 'true';
\if :{?HXP_D8_COMPOSED}
SET LOCAL hustlexp.d8_composed = 'true';
\else
SET LOCAL hustlexp.d8_composed = 'false';
\endif

\set HXP_D7_COMPOSED true
\ir payment-underwriting-completion-capture-v7.pg.sql
\unset HXP_D7_COMPOSED
\ir ../../database/migrations/20260825_payment_underwriting_settlement_close_v7.sql

DO $$
<<d7_test>>
DECLARE
  capture payment_captures_v7%ROWTYPE;
  latest_event payment_underwriting_lifecycle_events_v7%ROWTYPE;
  economics_id UUID := gen_random_uuid();
  bad_economics_id UUID := gen_random_uuid();
  settling_record_id UUID := gen_random_uuid();
  funded_record_id UUID := gen_random_uuid();
  settlement_webhook_id UUID := gen_random_uuid();
  bad_ledger_transaction_id UUID := gen_random_uuid();
  ledger_transaction_id UUID := gen_random_uuid();
  customer_entry_id UUID := gen_random_uuid();
  provider_entry_id UUID := gen_random_uuid();
  platform_entry_id UUID := gen_random_uuid();
  bad_customer_entry_id UUID := gen_random_uuid();
  bad_provider_entry_id UUID := gen_random_uuid();
  crossed_run_id UUID := gen_random_uuid();
  crossed_item_id UUID := gen_random_uuid();
  exception_run_id UUID := gen_random_uuid();
  exception_item_id UUID := gen_random_uuid();
  reconciliation_run_id UUID := gen_random_uuid();
  reconciliation_item_id UUID := gen_random_uuid();
  closure_attestation_id UUID := gen_random_uuid();
  settling_event_id UUID := gen_random_uuid();
  funded_event_id UUID := gen_random_uuid();
  reconciled_event_id UUID := gen_random_uuid();
  closed_event_id UUID := gen_random_uuid();
  policy_sha TEXT := repeat('2', 64);
  economics_evidence_sha TEXT := repeat('3', 64);
  settlement_api_evidence_sha TEXT := repeat('4', 64);
  settlement_webhook_evidence_sha TEXT := repeat('5', 64);
  settlement_external_sha TEXT := repeat('6', 64);
  funded_external_sha TEXT := 'ca91335fd68b4ece38980c27396c5db6215813dc8d5c3e9542f660f79f56bd88';
  reconciliation_source_sha TEXT := repeat('8', 64);
  reconciliation_result_sha TEXT := repeat('9', 64);
  reconciliation_evidence_sha TEXT := repeat('a', 64);
  closure_evidence_sha TEXT := repeat('b', 64);
  economics_material_sha TEXT;
  settling_material_sha TEXT;
  funded_material_sha TEXT;
  posting_material_sha TEXT;
  customer_entry_sha TEXT;
  provider_entry_sha TEXT;
  platform_entry_sha TEXT;
  run_material_sha TEXT;
  item_material_sha TEXT;
  closure_material_sha TEXT;
  created_at TIMESTAMPTZ;
  settling_observed_at TIMESTAMPTZ;
  funded_observed_at TIMESTAMPTZ;
  period_start TIMESTAMPTZ;
  period_end TIMESTAMPTZ;
  completed_at TIMESTAMPTZ;
  closed_at TIMESTAMPTZ;
  customer_amount BIGINT;
  provider_amount BIGINT;
  platform_amount BIGINT;
  expected_entry_count INTEGER := 3;
  unbalanced_economics_rejected BOOLEAN := FALSE;
  unauthenticated_settlement_rejected BOOLEAN := FALSE;
  unbalanced_ledger_rejected BOOLEAN := FALSE;
  crossed_reconciliation_rejected BOOLEAN := FALSE;
  reconciliation_exception_blocks_close BOOLEAN := FALSE;
  premature_closed_rejected BOOLEAN := FALSE;
  d8_composed BOOLEAN := current_setting('hustlexp.d8_composed', true) = 'true';
BEGIN
  SELECT * INTO capture FROM payment_captures_v7 LIMIT 1;
  SELECT * INTO latest_event FROM payment_underwriting_lifecycle_events_v7
   WHERE lifecycle_id = capture.lifecycle_id
   ORDER BY sequence_number DESC LIMIT 1;
  IF latest_event.stage IS DISTINCT FROM 'CAPTURED' THEN
    RAISE EXCEPTION 'D7 requires the composed D6 CAPTURED state';
  END IF;
  customer_amount := capture.approved_amount_cents;
  platform_amount := LEAST(1000, customer_amount);
  provider_amount := customer_amount - platform_amount;
  created_at := date_trunc('milliseconds', clock_timestamp());

  BEGIN
    INSERT INTO payment_capture_economics_v7(
      economics_id, capture_id, lifecycle_id, work_order_id, processor_code,
      pricing_policy_version, pricing_policy_sha256, relationship_origin,
      customer_amount_cents, provider_amount_cents, platform_amount_cents,
      processor_cost_cents, currency, evidence_sha256,
      economics_material_sha256, created_at
    ) VALUES (
      bad_economics_id, capture.capture_id, capture.lifecycle_id,
      capture.work_order_id, capture.processor_code, 1, policy_sha, 'MARKETPLACE',
      customer_amount, provider_amount - 1, platform_amount, 0,
      capture.currency, economics_evidence_sha, repeat('c', 64), created_at
    );
  EXCEPTION WHEN check_violation OR SQLSTATE 'P0001' THEN
    unbalanced_economics_rejected := TRUE;
  END;

  economics_material_sha := hxos_payment_capture_economics_sha256_v7(
    economics_id, capture.capture_id, capture.lifecycle_id, capture.work_order_id,
    capture.processor_code, 1, policy_sha, 'MARKETPLACE', customer_amount,
    provider_amount, platform_amount, 0, capture.currency,
    economics_evidence_sha, created_at
  );
  INSERT INTO payment_capture_economics_v7(
    economics_id, capture_id, lifecycle_id, work_order_id, processor_code,
    pricing_policy_version, pricing_policy_sha256, relationship_origin,
    customer_amount_cents, provider_amount_cents, platform_amount_cents,
    processor_cost_cents, currency, evidence_sha256,
    economics_material_sha256, created_at
  ) VALUES (
    economics_id, capture.capture_id, capture.lifecycle_id, capture.work_order_id,
    capture.processor_code, 1, policy_sha, 'MARKETPLACE', customer_amount,
    provider_amount, platform_amount, 0, capture.currency,
    economics_evidence_sha, economics_material_sha, created_at
  );

  settling_observed_at := date_trunc('milliseconds', clock_timestamp());
  settling_material_sha := hxos_payment_settlement_record_sha256_v7(
    settling_record_id, economics_id, capture.lifecycle_id, capture.capture_id,
    capture.processor_code, 1, NULL, 'SETTLING', customer_amount,
    provider_amount, platform_amount, capture.currency, 'API_RESPONSE', NULL,
    settlement_external_sha, settlement_api_evidence_sha, settling_observed_at
  );
  INSERT INTO payment_settlement_records_v7(
    settlement_record_id, economics_id, lifecycle_id, capture_id,
    processor_code, sequence_number, prior_settlement_record_id, state,
    customer_amount_cents, provider_amount_cents, platform_amount_cents,
    currency, evidence_source, webhook_inbox_id, external_reference_sha256,
    evidence_sha256, observed_at, settlement_material_sha256
  ) VALUES (
    settling_record_id, economics_id, capture.lifecycle_id, capture.capture_id,
    capture.processor_code, 1, NULL, 'SETTLING', customer_amount,
    provider_amount, platform_amount, capture.currency, 'API_RESPONSE', NULL,
    settlement_external_sha, settlement_api_evidence_sha,
    settling_observed_at, settling_material_sha
  );
  INSERT INTO payment_underwriting_lifecycle_events_v7(
    event_id, lifecycle_id, task_draft_id, sequence_number, prior_event_id,
    command_id, stage, actor_type, evidence_sha256, event_material, event_sha256
  )
  SELECT settling_event_id, capture.lifecycle_id, event.task_draft_id,
    event.sequence_number + 1, event.event_id, gen_random_uuid(),
    'SETTLING', 'SYSTEM', settling_material_sha,
    jsonb_build_object('schema', 'HX_PAYMENT_D7_SETTLING_EVENT_V7'),
    encode(digest(settling_event_id::TEXT || ':settling', 'sha256'), 'hex')
  FROM payment_underwriting_lifecycle_events_v7 event
  WHERE event.lifecycle_id = capture.lifecycle_id
  ORDER BY event.sequence_number DESC LIMIT 1;

  funded_observed_at := date_trunc('milliseconds', clock_timestamp());
  BEGIN
    funded_material_sha := hxos_payment_settlement_record_sha256_v7(
      funded_record_id, economics_id, capture.lifecycle_id, capture.capture_id,
      capture.processor_code, 2, settling_record_id, 'FUNDED', customer_amount,
      provider_amount, platform_amount, capture.currency, 'API_RESPONSE', NULL,
      funded_external_sha, settlement_webhook_evidence_sha, funded_observed_at
    );
    INSERT INTO payment_settlement_records_v7(
      settlement_record_id, economics_id, lifecycle_id, capture_id,
      processor_code, sequence_number, prior_settlement_record_id, state,
      customer_amount_cents, provider_amount_cents, platform_amount_cents,
      currency, evidence_source, external_reference_sha256,
      evidence_sha256, observed_at, settlement_material_sha256
    ) VALUES (
      funded_record_id, economics_id, capture.lifecycle_id, capture.capture_id,
      capture.processor_code, 2, settling_record_id, 'FUNDED', customer_amount,
      provider_amount, platform_amount, capture.currency, 'API_RESPONSE',
      funded_external_sha, settlement_webhook_evidence_sha,
      funded_observed_at, funded_material_sha
    );
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    unauthenticated_settlement_rejected := TRUE;
  END;

  INSERT INTO payment_webhook_inbox_v7(
    webhook_inbox_id, processor_code, event_id_sha256, payload_sha256,
    authentication_state, normalized_event_type, processing_state,
    received_at, authentication_evidence_sha256, signature_verified_at
  ) VALUES (
    settlement_webhook_id, capture.processor_code, funded_external_sha,
    repeat('d', 64), 'VERIFIED', 'SETTLEMENT_FUNDED', 'NORMALIZED',
    funded_observed_at, repeat('e', 64), funded_observed_at
  );
  funded_material_sha := hxos_payment_settlement_record_sha256_v7(
    funded_record_id, economics_id, capture.lifecycle_id, capture.capture_id,
    capture.processor_code, 2, settling_record_id, 'FUNDED', customer_amount,
    provider_amount, platform_amount, capture.currency, 'WEBHOOK',
    settlement_webhook_id, funded_external_sha,
    settlement_webhook_evidence_sha, funded_observed_at
  );
  INSERT INTO payment_settlement_records_v7(
    settlement_record_id, economics_id, lifecycle_id, capture_id,
    processor_code, sequence_number, prior_settlement_record_id, state,
    customer_amount_cents, provider_amount_cents, platform_amount_cents,
    currency, evidence_source, webhook_inbox_id, external_reference_sha256,
    evidence_sha256, observed_at, settlement_material_sha256
  ) VALUES (
    funded_record_id, economics_id, capture.lifecycle_id, capture.capture_id,
    capture.processor_code, 2, settling_record_id, 'FUNDED', customer_amount,
    provider_amount, platform_amount, capture.currency, 'WEBHOOK',
    settlement_webhook_id, funded_external_sha,
    settlement_webhook_evidence_sha, funded_observed_at, funded_material_sha
  );
  INSERT INTO payment_underwriting_lifecycle_events_v7(
    event_id, lifecycle_id, task_draft_id, sequence_number, prior_event_id,
    command_id, stage, actor_type, evidence_sha256, event_material, event_sha256
  )
  SELECT funded_event_id, capture.lifecycle_id, event.task_draft_id,
    event.sequence_number + 1, event.event_id, gen_random_uuid(),
    'FUNDED', 'SYSTEM', funded_material_sha,
    jsonb_build_object('schema', 'HX_PAYMENT_D7_FUNDED_EVENT_V7'),
    encode(digest(funded_event_id::TEXT || ':funded', 'sha256'), 'hex')
  FROM payment_underwriting_lifecycle_events_v7 event
  WHERE event.lifecycle_id = capture.lifecycle_id
  ORDER BY event.sequence_number DESC LIMIT 1;

  posting_material_sha := hxos_payment_ledger_transaction_sha256_v7(
    bad_ledger_transaction_id, capture.lifecycle_id, capture.capture_id,
    economics_id, funded_record_id, capture.currency, expected_entry_count,
    customer_amount, customer_amount, funded_record_id, created_at
  );
  BEGIN
    INSERT INTO payment_ledger_transactions_v7(
      ledger_transaction_id, lifecycle_id, capture_id, economics_id,
      settlement_record_id, transaction_type, currency, state,
      source_operation_id, expected_entry_count, debit_total_cents,
      credit_total_cents, material_sha256, posting_material_sha256, created_at
    ) VALUES (
      bad_ledger_transaction_id, capture.lifecycle_id, capture.capture_id,
      economics_id, funded_record_id, 'SETTLEMENT', capture.currency, 'POSTED',
      funded_record_id, expected_entry_count, customer_amount, customer_amount,
      posting_material_sha, posting_material_sha, created_at
    );
    customer_entry_sha := hxos_payment_ledger_entry_sha256_v7(
      bad_customer_entry_id, bad_ledger_transaction_id, capture.lifecycle_id,
      capture.capture_id, 1, 'CUSTOMER_GMV', 'CUSTOMER_SETTLEMENT_CLEARING',
      'DEBIT', customer_amount, capture.currency, created_at
    );
    INSERT INTO payment_ledger_entries_v7(
      ledger_entry_id, ledger_transaction_id, lifecycle_id, capture_id,
      sequence_number, economic_component, account_code, direction,
      amount_cents, currency, entry_sha256, entry_material_sha256, created_at
    ) VALUES (
      bad_customer_entry_id, bad_ledger_transaction_id, capture.lifecycle_id,
      capture.capture_id, 1, 'CUSTOMER_GMV', 'CUSTOMER_SETTLEMENT_CLEARING',
      'DEBIT', customer_amount, capture.currency, customer_entry_sha,
      customer_entry_sha, created_at
    );
    provider_entry_sha := hxos_payment_ledger_entry_sha256_v7(
      bad_provider_entry_id, bad_ledger_transaction_id, capture.lifecycle_id,
      capture.capture_id, 2, 'PROVIDER_ECONOMICS', 'PROVIDER_PAYABLE',
      'CREDIT', provider_amount, capture.currency, created_at
    );
    INSERT INTO payment_ledger_entries_v7(
      ledger_entry_id, ledger_transaction_id, lifecycle_id, capture_id,
      sequence_number, economic_component, account_code, direction,
      amount_cents, currency, entry_sha256, entry_material_sha256, created_at
    ) VALUES (
      bad_provider_entry_id, bad_ledger_transaction_id, capture.lifecycle_id,
      capture.capture_id, 2, 'PROVIDER_ECONOMICS', 'PROVIDER_PAYABLE',
      'CREDIT', provider_amount, capture.currency, provider_entry_sha,
      provider_entry_sha, created_at
    );
    SET CONSTRAINTS ALL IMMEDIATE;
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    unbalanced_ledger_rejected := TRUE;
  END;
  SET CONSTRAINTS ALL DEFERRED;

  posting_material_sha := hxos_payment_ledger_transaction_sha256_v7(
    ledger_transaction_id, capture.lifecycle_id, capture.capture_id,
    economics_id, funded_record_id, capture.currency, expected_entry_count,
    customer_amount, customer_amount, funded_record_id, created_at
  );
  INSERT INTO payment_ledger_transactions_v7(
    ledger_transaction_id, lifecycle_id, capture_id, economics_id,
    settlement_record_id, transaction_type, currency, state,
    source_operation_id, expected_entry_count, debit_total_cents,
    credit_total_cents, material_sha256, posting_material_sha256, created_at
  ) VALUES (
    ledger_transaction_id, capture.lifecycle_id, capture.capture_id,
    economics_id, funded_record_id, 'SETTLEMENT', capture.currency, 'POSTED',
    funded_record_id, expected_entry_count, customer_amount, customer_amount,
    posting_material_sha, posting_material_sha, created_at
  );
  customer_entry_sha := hxos_payment_ledger_entry_sha256_v7(
    customer_entry_id, ledger_transaction_id, capture.lifecycle_id,
    capture.capture_id, 1, 'CUSTOMER_GMV', 'CUSTOMER_SETTLEMENT_CLEARING',
    'DEBIT', customer_amount, capture.currency, created_at
  );
  provider_entry_sha := hxos_payment_ledger_entry_sha256_v7(
    provider_entry_id, ledger_transaction_id, capture.lifecycle_id,
    capture.capture_id, 2, 'PROVIDER_ECONOMICS', 'PROVIDER_PAYABLE',
    'CREDIT', provider_amount, capture.currency, created_at
  );
  platform_entry_sha := hxos_payment_ledger_entry_sha256_v7(
    platform_entry_id, ledger_transaction_id, capture.lifecycle_id,
    capture.capture_id, 3, 'PLATFORM_FEE', 'PLATFORM_REVENUE',
    'CREDIT', platform_amount, capture.currency, created_at
  );
  INSERT INTO payment_ledger_entries_v7(
    ledger_entry_id, ledger_transaction_id, lifecycle_id, capture_id,
    sequence_number, economic_component, account_code, direction,
    amount_cents, currency, entry_sha256, entry_material_sha256, created_at
  ) VALUES
    (customer_entry_id, ledger_transaction_id, capture.lifecycle_id,
     capture.capture_id, 1, 'CUSTOMER_GMV', 'CUSTOMER_SETTLEMENT_CLEARING',
     'DEBIT', customer_amount, capture.currency, customer_entry_sha,
     customer_entry_sha, created_at),
    (provider_entry_id, ledger_transaction_id, capture.lifecycle_id,
     capture.capture_id, 2, 'PROVIDER_ECONOMICS', 'PROVIDER_PAYABLE',
     'CREDIT', provider_amount, capture.currency, provider_entry_sha,
     provider_entry_sha, created_at),
    (platform_entry_id, ledger_transaction_id, capture.lifecycle_id,
     capture.capture_id, 3, 'PLATFORM_FEE', 'PLATFORM_REVENUE',
     'CREDIT', platform_amount, capture.currency, platform_entry_sha,
     platform_entry_sha, created_at);
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;

  period_start := created_at - INTERVAL '1 minute';
  period_end := date_trunc('milliseconds', clock_timestamp()) - INTERVAL '1 millisecond';
  completed_at := date_trunc('milliseconds', clock_timestamp());

  BEGIN
    run_material_sha := hxos_payment_reconciliation_run_sha256_v7(
      crossed_run_id, capture.processor_code, period_start, period_end,
      reconciliation_source_sha, reconciliation_result_sha, 1, 0, completed_at
    );
    INSERT INTO payment_reconciliation_runs_v7(
      reconciliation_run_id, processor_code, period_start, period_end, state,
      source_material_sha256, result_sha256, item_count, exception_count,
      completed_at, run_material_sha256
    ) VALUES (
      crossed_run_id, capture.processor_code, period_start, period_end,
      'COMPLETED', reconciliation_source_sha, reconciliation_result_sha,
      1, 0, completed_at, run_material_sha
    );
    item_material_sha := hxos_payment_reconciliation_item_sha256_v7(
      crossed_item_id, crossed_run_id, capture.lifecycle_id, capture.capture_id,
      funded_record_id, ledger_transaction_id, capture.processor_code,
      'MATCHED', customer_amount, customer_amount, capture.currency,
      repeat('f', 64), posting_material_sha, reconciliation_evidence_sha, completed_at
    );
    INSERT INTO payment_reconciliation_items_v7(
      reconciliation_item_id, reconciliation_run_id, lifecycle_id, capture_id,
      settlement_record_id, ledger_transaction_id, processor_code,
      reconciliation_state, processor_amount_cents, ledger_amount_cents,
      currency, settlement_material_sha256, posting_material_sha256,
      evidence_sha256, item_material_sha256, created_at
    ) VALUES (
      crossed_item_id, crossed_run_id, capture.lifecycle_id, capture.capture_id,
      funded_record_id, ledger_transaction_id, capture.processor_code,
      'MATCHED', customer_amount, customer_amount, capture.currency,
      repeat('f', 64), posting_material_sha, reconciliation_evidence_sha,
      item_material_sha, completed_at
    );
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    crossed_reconciliation_rejected := TRUE;
  END;

  BEGIN
    run_material_sha := hxos_payment_reconciliation_run_sha256_v7(
      exception_run_id, capture.processor_code, period_start, period_end,
      reconciliation_source_sha, reconciliation_result_sha, 1, 1, completed_at
    );
    INSERT INTO payment_reconciliation_runs_v7(
      reconciliation_run_id, processor_code, period_start, period_end, state,
      source_material_sha256, result_sha256, item_count, exception_count,
      completed_at, run_material_sha256
    ) VALUES (
      exception_run_id, capture.processor_code, period_start, period_end,
      'COMPLETED', reconciliation_source_sha, reconciliation_result_sha,
      1, 1, completed_at, run_material_sha
    );
    item_material_sha := hxos_payment_reconciliation_item_sha256_v7(
      exception_item_id, exception_run_id, capture.lifecycle_id, capture.capture_id,
      funded_record_id, ledger_transaction_id, capture.processor_code,
      'EXCEPTION', customer_amount, customer_amount, capture.currency,
      repeat('f', 64), posting_material_sha, reconciliation_evidence_sha, completed_at
    );
    INSERT INTO payment_reconciliation_items_v7(
      reconciliation_item_id, reconciliation_run_id, lifecycle_id, capture_id,
      settlement_record_id, ledger_transaction_id, processor_code,
      reconciliation_state, processor_amount_cents, ledger_amount_cents,
      currency, settlement_material_sha256, posting_material_sha256,
      evidence_sha256, item_material_sha256, created_at
    ) VALUES (
      exception_item_id, exception_run_id, capture.lifecycle_id, capture.capture_id,
      funded_record_id, ledger_transaction_id, capture.processor_code,
      'EXCEPTION', customer_amount, customer_amount, capture.currency,
      repeat('f', 64), posting_material_sha, reconciliation_evidence_sha,
      item_material_sha, completed_at
    );
    SET CONSTRAINTS ALL IMMEDIATE;
    INSERT INTO payment_underwriting_lifecycle_events_v7(
      event_id, lifecycle_id, task_draft_id, sequence_number, prior_event_id,
      command_id, stage, actor_type, evidence_sha256, event_material, event_sha256
    )
    SELECT gen_random_uuid(), capture.lifecycle_id, event.task_draft_id,
      event.sequence_number + 1, event.event_id, gen_random_uuid(),
      'RECONCILED', 'SYSTEM', item_material_sha,
      jsonb_build_object('schema', 'HX_PAYMENT_D7_EXCEPTION_RECONCILE_V7'),
      repeat('1', 64)
    FROM payment_underwriting_lifecycle_events_v7 event
    WHERE event.lifecycle_id = capture.lifecycle_id
    ORDER BY event.sequence_number DESC LIMIT 1;
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    reconciliation_exception_blocks_close := TRUE;
  END;
  SET CONSTRAINTS ALL DEFERRED;

  run_material_sha := hxos_payment_reconciliation_run_sha256_v7(
    reconciliation_run_id, capture.processor_code, period_start, period_end,
    reconciliation_source_sha, reconciliation_result_sha, 1, 0, completed_at
  );
  INSERT INTO payment_reconciliation_runs_v7(
    reconciliation_run_id, processor_code, period_start, period_end, state,
    source_material_sha256, result_sha256, item_count, exception_count,
    completed_at, run_material_sha256
  ) VALUES (
    reconciliation_run_id, capture.processor_code, period_start, period_end,
    'COMPLETED', reconciliation_source_sha, reconciliation_result_sha,
    1, 0, completed_at, run_material_sha
  );
  item_material_sha := hxos_payment_reconciliation_item_sha256_v7(
    reconciliation_item_id, reconciliation_run_id, capture.lifecycle_id,
    capture.capture_id, funded_record_id, ledger_transaction_id,
    capture.processor_code, 'MATCHED', customer_amount, customer_amount,
    capture.currency, funded_material_sha, posting_material_sha,
    reconciliation_evidence_sha, completed_at
  );
  INSERT INTO payment_reconciliation_items_v7(
    reconciliation_item_id, reconciliation_run_id, lifecycle_id, capture_id,
    settlement_record_id, ledger_transaction_id, processor_code,
    reconciliation_state, processor_amount_cents, ledger_amount_cents,
    currency, settlement_material_sha256, posting_material_sha256,
    evidence_sha256, item_material_sha256, created_at
  ) VALUES (
    reconciliation_item_id, reconciliation_run_id, capture.lifecycle_id,
    capture.capture_id, funded_record_id, ledger_transaction_id,
    capture.processor_code, 'MATCHED', customer_amount, customer_amount,
    capture.currency, funded_material_sha, posting_material_sha,
    reconciliation_evidence_sha, item_material_sha, completed_at
  );
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;

  INSERT INTO payment_underwriting_lifecycle_events_v7(
    event_id, lifecycle_id, task_draft_id, sequence_number, prior_event_id,
    command_id, stage, actor_type, evidence_sha256, event_material, event_sha256
  )
  SELECT reconciled_event_id, capture.lifecycle_id, event.task_draft_id,
    event.sequence_number + 1, event.event_id, gen_random_uuid(),
    'RECONCILED', 'SYSTEM', item_material_sha,
    jsonb_build_object('schema', 'HX_PAYMENT_D7_RECONCILED_EVENT_V7'),
    encode(digest(reconciled_event_id::TEXT || ':reconciled', 'sha256'), 'hex')
  FROM payment_underwriting_lifecycle_events_v7 event
  WHERE event.lifecycle_id = capture.lifecycle_id
  ORDER BY event.sequence_number DESC LIMIT 1;

  BEGIN
    INSERT INTO payment_underwriting_lifecycle_events_v7(
      event_id, lifecycle_id, task_draft_id, sequence_number, prior_event_id,
      command_id, stage, actor_type, evidence_sha256, event_material, event_sha256
    )
    SELECT closed_event_id, capture.lifecycle_id, event.task_draft_id,
      event.sequence_number + 1, event.event_id, gen_random_uuid(),
      'CLOSED', 'SYSTEM', repeat('0', 64),
      jsonb_build_object('schema', 'HX_PAYMENT_D7_PREMATURE_CLOSED_EVENT_V7'),
      encode(digest(closed_event_id::TEXT || ':premature', 'sha256'), 'hex')
    FROM payment_underwriting_lifecycle_events_v7 event
    WHERE event.lifecycle_id = capture.lifecycle_id
    ORDER BY event.sequence_number DESC LIMIT 1;
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    premature_closed_rejected := TRUE;
  END;

  IF NOT d8_composed THEN
    closed_at := date_trunc('milliseconds', clock_timestamp());
    closure_material_sha := hxos_payment_closure_attestation_sha256_v7(
      closure_attestation_id, capture.lifecycle_id, capture.capture_id,
      funded_record_id, ledger_transaction_id, reconciliation_run_id,
      reconciliation_item_id, 0, closed_at, closure_evidence_sha
    );
    INSERT INTO payment_closure_attestations_v7(
      closure_attestation_id, lifecycle_id, capture_id, settlement_record_id,
      ledger_transaction_id, reconciliation_run_id, reconciliation_item_id,
      open_post_funding_exposure_count, closed_at, evidence_sha256,
      closure_material_sha256
    ) VALUES (
      closure_attestation_id, capture.lifecycle_id, capture.capture_id,
      funded_record_id, ledger_transaction_id, reconciliation_run_id,
      reconciliation_item_id, 0, closed_at, closure_evidence_sha,
      closure_material_sha
    );
    INSERT INTO payment_underwriting_lifecycle_events_v7(
      event_id, lifecycle_id, task_draft_id, sequence_number, prior_event_id,
      command_id, stage, actor_type, evidence_sha256, event_material, event_sha256
    )
    SELECT closed_event_id, capture.lifecycle_id, event.task_draft_id,
      event.sequence_number + 1, event.event_id, gen_random_uuid(),
      'CLOSED', 'SYSTEM', closure_material_sha,
      jsonb_build_object('schema', 'HX_PAYMENT_D7_CLOSED_EVENT_V7'),
      encode(digest(closed_event_id::TEXT || ':closed', 'sha256'), 'hex')
    FROM payment_underwriting_lifecycle_events_v7 event
    WHERE event.lifecycle_id = capture.lifecycle_id
    ORDER BY event.sequence_number DESC LIMIT 1;
  END IF;

  IF NOT unbalanced_economics_rejected
     OR NOT unauthenticated_settlement_rejected
     OR NOT unbalanced_ledger_rejected
     OR NOT crossed_reconciliation_rejected
     OR NOT reconciliation_exception_blocks_close
     OR NOT premature_closed_rejected THEN
    RAISE EXCEPTION 'D7 negative invariant failure: %', jsonb_build_object(
      'unbalancedEconomics', unbalanced_economics_rejected,
      'unauthenticatedSettlement', unauthenticated_settlement_rejected,
      'unbalancedLedger', unbalanced_ledger_rejected,
      'crossedReconciliation', crossed_reconciliation_rejected,
      'reconciliationException', reconciliation_exception_blocks_close,
      'prematureClosed', premature_closed_rejected
    );
  END IF;
END;
$$;

SET CONSTRAINTS ALL IMMEDIATE;

DO $$
DECLARE
  lifecycle_stage TEXT;
  counts BIGINT[];
  d8_composed BOOLEAN := current_setting('hustlexp.d8_composed', true) = 'true';
BEGIN
  SELECT stage INTO lifecycle_stage FROM payment_underwriting_lifecycle_status_v7
   WHERE lifecycle_id = (SELECT lifecycle_id FROM payment_capture_economics_v7 LIMIT 1);
  SELECT ARRAY[
    (SELECT count(*) FROM payment_capture_economics_v7),
    (SELECT count(*) FROM payment_settlement_records_v7),
    (SELECT count(*) FROM payment_ledger_transactions_v7),
    (SELECT count(*) FROM payment_ledger_entries_v7),
    (SELECT count(*) FROM payment_reconciliation_runs_v7),
    (SELECT count(*) FROM payment_reconciliation_items_v7),
    (SELECT count(*) FROM payment_closure_attestations_v7)
  ] INTO counts;
  IF lifecycle_stage IS DISTINCT FROM (CASE WHEN d8_composed THEN 'RECONCILED' ELSE 'CLOSED' END)
     OR counts IS DISTINCT FROM (CASE WHEN d8_composed
       THEN ARRAY[1, 2, 1, 3, 1, 1, 0]::BIGINT[]
       ELSE ARRAY[1, 2, 1, 3, 1, 1, 1]::BIGINT[] END) THEN
    RAISE EXCEPTION 'D7 valid path mismatch: %', jsonb_build_object(
      'stage', lifecycle_stage, 'counts', counts
    );
  END IF;
END;
$$;

\ir ../../database/migrations/20260825_payment_underwriting_settlement_close_v7.sql

DO $$
DECLARE
  counts BIGINT[];
  d8_composed BOOLEAN := current_setting('hustlexp.d8_composed', true) = 'true';
BEGIN
  SELECT ARRAY[
    (SELECT count(*) FROM payment_capture_economics_v7),
    (SELECT count(*) FROM payment_settlement_records_v7),
    (SELECT count(*) FROM payment_ledger_transactions_v7),
    (SELECT count(*) FROM payment_ledger_entries_v7),
    (SELECT count(*) FROM payment_reconciliation_runs_v7),
    (SELECT count(*) FROM payment_reconciliation_items_v7),
    (SELECT count(*) FROM payment_closure_attestations_v7)
  ] INTO counts;
  IF counts IS DISTINCT FROM (CASE WHEN d8_composed
    THEN ARRAY[1, 2, 1, 3, 1, 1, 0]::BIGINT[]
    ELSE ARRAY[1, 2, 1, 3, 1, 1, 1]::BIGINT[] END) THEN
    RAISE EXCEPTION 'D7 replay changed evidence: %', counts;
  END IF;
END;
$$;

\if :{?HXP_D8_COMPOSED}
\else
ROLLBACK;
\endif
