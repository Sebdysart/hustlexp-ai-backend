BEGIN;

SET LOCAL hustlexp.local_test_identity_enabled = 'true';

\set HXP_D8_COMPOSED true
\ir payment-underwriting-settlement-close-v7.pg.sql
\unset HXP_D8_COMPOSED
\ir ../../database/migrations/20260826_payment_underwriting_exception_recovery_v7.sql

DO $$
<<d8_test>>
DECLARE
  capture payment_captures_v7%ROWTYPE;
  settlement payment_settlement_records_v7%ROWTYPE;
  ledger payment_ledger_transactions_v7%ROWTYPE;
  reconciliation_item payment_reconciliation_items_v7%ROWTYPE;
  reconciliation_run payment_reconciliation_runs_v7%ROWTYPE;
  lifecycle payment_underwriting_lifecycles_v7%ROWTYPE;
  latest_event payment_underwriting_lifecycle_events_v7%ROWTYPE;
  rejected_policy_id UUID := gen_random_uuid();
  refund_policy_id UUID := gen_random_uuid();
  dispute_policy_id UUID := gen_random_uuid();
  postdated_policy_id UUID := gen_random_uuid();
  replacement_policy_id UUID := gen_random_uuid();
  recurring_policy_id UUID := gen_random_uuid();
  bad_case_id UUID := gen_random_uuid();
  postdated_case_id UUID := gen_random_uuid();
  replacement_case_id UUID := gen_random_uuid();
  refund_case_id UUID := gen_random_uuid();
  dispute_case_id UUID := gen_random_uuid();
  open_event_id UUID := gen_random_uuid();
  resolved_event_id UUID := gen_random_uuid();
  unrelated_webhook_event_id UUID := gen_random_uuid();
  unrelated_webhook_id UUID := gen_random_uuid();
  adjustment_id UUID := gen_random_uuid();
  crossed_reconciliation_id UUID := gen_random_uuid();
  exception_reconciliation_id UUID := gen_random_uuid();
  closure_attestation_id UUID := gen_random_uuid();
  closed_event_id UUID := gen_random_uuid();
  recurring_task_draft_id UUID := gen_random_uuid();
  recurring_lifecycle_id UUID := gen_random_uuid();
  recurring_lifecycle_event_id UUID := gen_random_uuid();
  recurring_occurrence_id UUID := gen_random_uuid();
  long_term_occurrence_id UUID := gen_random_uuid();
  duplicate_occurrence_id UUID := gen_random_uuid();
  policy_evidence_sha TEXT := repeat('1', 64);
  case_evidence_sha TEXT := repeat('2', 64);
  open_evidence_sha TEXT := repeat('3', 64);
  resolution_evidence_sha TEXT := repeat('4', 64);
  adjustment_evidence_sha TEXT := repeat('5', 64);
  reconciliation_evidence_sha TEXT := repeat('6', 64);
  closure_evidence_sha TEXT := repeat('7', 64);
  recurring_evidence_sha TEXT := repeat('8', 64);
  provider_reference_sha TEXT := repeat('9', 64);
  series_sha TEXT := repeat('a', 64);
  rejected_policy_material_sha TEXT;
  refund_policy_material_sha TEXT;
  dispute_policy_material_sha TEXT;
  postdated_policy_material_sha TEXT;
  replacement_policy_material_sha TEXT;
  recurring_policy_material_sha TEXT;
  bad_case_material_sha TEXT;
  postdated_case_material_sha TEXT;
  replacement_case_material_sha TEXT;
  refund_case_material_sha TEXT;
  dispute_case_material_sha TEXT;
  open_event_material_sha TEXT;
  resolved_event_material_sha TEXT;
  unrelated_webhook_event_material_sha TEXT;
  unrelated_webhook_event_sha TEXT;
  unrelated_webhook_payload_sha TEXT;
  adjustment_material_sha TEXT;
  crossed_reconciliation_material_sha TEXT;
  exception_reconciliation_material_sha TEXT;
  closure_material_sha TEXT;
  recurring_occurrence_material_sha TEXT;
  long_term_occurrence_material_sha TEXT;
  duplicate_occurrence_material_sha TEXT;
  policy_time TIMESTAMPTZ;
  opened_at TIMESTAMPTZ;
  resolved_at TIMESTAMPTZ;
  reconciled_at TIMESTAMPTZ;
  closed_at TIMESTAMPTZ;
  recurring_created_at TIMESTAMPTZ;
  unapproved_policy_rejected BOOLEAN := FALSE;
  postdated_policy_rejected BOOLEAN := FALSE;
  unrelated_webhook_rejected BOOLEAN := FALSE;
  provider_replacement_rejected BOOLEAN := FALSE;
  conflicting_refund_dispute_rejected BOOLEAN := FALSE;
  open_exception_blocks_closure BOOLEAN := FALSE;
  unreconciled_resolution_blocks_closure BOOLEAN := FALSE;
  crossed_exception_reconciliation_rejected BOOLEAN := FALSE;
  long_term_prepayment_rejected BOOLEAN := FALSE;
  duplicate_lifecycle_occurrence_rejected BOOLEAN := FALSE;
  exception_event_update_rejected BOOLEAN := FALSE;
  exception_case_truncate_rejected BOOLEAN := FALSE;
  runtime_relation_privilege_count BIGINT;
  runtime_function_authority_count BIGINT;
  effective_financial_state TEXT;
  open_exception_case_count BIGINT;
BEGIN
  SELECT * INTO capture FROM payment_captures_v7 LIMIT 1;
  SELECT * INTO settlement FROM payment_settlement_records_v7
   WHERE capture_id = capture.capture_id ORDER BY sequence_number DESC LIMIT 1;
  SELECT * INTO ledger FROM payment_ledger_transactions_v7
   WHERE capture_id = capture.capture_id;
  SELECT * INTO reconciliation_item FROM payment_reconciliation_items_v7
   WHERE capture_id = capture.capture_id;
  SELECT * INTO reconciliation_run FROM payment_reconciliation_runs_v7
   WHERE reconciliation_run_id = reconciliation_item.reconciliation_run_id;
  SELECT * INTO lifecycle FROM payment_underwriting_lifecycles_v7
   WHERE lifecycle_id = capture.lifecycle_id;
  SELECT * INTO latest_event FROM payment_underwriting_lifecycle_events_v7
   WHERE lifecycle_id = capture.lifecycle_id ORDER BY sequence_number DESC LIMIT 1;
  IF latest_event.stage IS DISTINCT FROM 'RECONCILED' THEN
    RAISE EXCEPTION 'D8 requires the composed D7 RECONCILED state';
  END IF;

  policy_time := date_trunc('milliseconds', clock_timestamp());
  rejected_policy_material_sha := hxos_payment_policy_decision_sha256_v7(
    rejected_policy_id, capture.processor_code, 'REFUND', 1, 'REJECTED',
    policy_time, NULL, policy_evidence_sha, policy_time
  );
  refund_policy_material_sha := hxos_payment_policy_decision_sha256_v7(
    refund_policy_id, capture.processor_code, 'REFUND', 2, 'APPROVED',
    policy_time, NULL, policy_evidence_sha, policy_time
  );
  dispute_policy_material_sha := hxos_payment_policy_decision_sha256_v7(
    dispute_policy_id, capture.processor_code, 'DISPUTE', 1, 'APPROVED',
    policy_time, NULL, policy_evidence_sha, policy_time
  );
  postdated_policy_material_sha := hxos_payment_policy_decision_sha256_v7(
    postdated_policy_id, capture.processor_code, 'REFUND', 99, 'APPROVED',
    policy_time, NULL, policy_evidence_sha, policy_time + INTERVAL '1 second'
  );
  replacement_policy_material_sha := hxos_payment_policy_decision_sha256_v7(
    replacement_policy_id, capture.processor_code, 'REPLACEMENT', 1, 'APPROVED',
    policy_time, NULL, policy_evidence_sha, policy_time
  );
  recurring_policy_material_sha := hxos_payment_policy_decision_sha256_v7(
    recurring_policy_id, capture.processor_code, 'RECURRING', 1, 'APPROVED',
    policy_time, NULL, policy_evidence_sha, policy_time
  );
  INSERT INTO payment_processor_policy_decisions_v7(
    decision_id, processor_code, policy_domain, policy_version,
    decision_state, effective_at, expires_at, evidence_sha256,
    decision_material_sha256, created_at
  ) VALUES
    (rejected_policy_id, capture.processor_code, 'REFUND', 1, 'REJECTED',
     policy_time, NULL, policy_evidence_sha, rejected_policy_material_sha, policy_time),
    (refund_policy_id, capture.processor_code, 'REFUND', 2, 'APPROVED',
     policy_time, NULL, policy_evidence_sha, refund_policy_material_sha, policy_time),
    (dispute_policy_id, capture.processor_code, 'DISPUTE', 1, 'APPROVED',
     policy_time, NULL, policy_evidence_sha, dispute_policy_material_sha, policy_time),
    (postdated_policy_id, capture.processor_code, 'REFUND', 99, 'APPROVED',
     policy_time, NULL, policy_evidence_sha, postdated_policy_material_sha,
     policy_time + INTERVAL '1 second'),
    (replacement_policy_id, capture.processor_code, 'REPLACEMENT', 1, 'APPROVED',
     policy_time, NULL, policy_evidence_sha, replacement_policy_material_sha, policy_time),
    (recurring_policy_id, capture.processor_code, 'RECURRING', 1, 'APPROVED',
     policy_time, NULL, policy_evidence_sha, recurring_policy_material_sha, policy_time);

  opened_at := date_trunc('milliseconds', clock_timestamp());
  bad_case_material_sha := hxos_payment_exception_case_sha256_v7(
    bad_case_id, capture.lifecycle_id, capture.capture_id,
    settlement.settlement_record_id, ledger.ledger_transaction_id,
    capture.processor_code, 'REFUND', capture.approved_amount_cents,
    capture.currency, rejected_policy_id, opened_at, case_evidence_sha
  );
  BEGIN
    INSERT INTO payment_post_funding_exception_cases_v7(
      case_id, lifecycle_id, capture_id, settlement_record_id,
      ledger_transaction_id, processor_code, case_kind, amount_cents,
      currency, policy_decision_id, opened_at, evidence_sha256,
      case_material_sha256
    ) VALUES (
      bad_case_id, capture.lifecycle_id, capture.capture_id,
      settlement.settlement_record_id, ledger.ledger_transaction_id,
      capture.processor_code, 'REFUND', capture.approved_amount_cents,
      capture.currency, rejected_policy_id, opened_at, case_evidence_sha,
      bad_case_material_sha
    );
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    unapproved_policy_rejected := TRUE;
  END;

  postdated_case_material_sha := hxos_payment_exception_case_sha256_v7(
    postdated_case_id, capture.lifecycle_id, capture.capture_id,
    settlement.settlement_record_id, ledger.ledger_transaction_id,
    capture.processor_code, 'REFUND', capture.approved_amount_cents,
    capture.currency, postdated_policy_id, opened_at, case_evidence_sha
  );
  BEGIN
    INSERT INTO payment_post_funding_exception_cases_v7(
      case_id, lifecycle_id, capture_id, settlement_record_id,
      ledger_transaction_id, processor_code, case_kind, amount_cents,
      currency, policy_decision_id, opened_at, evidence_sha256,
      case_material_sha256
    ) VALUES (
      postdated_case_id, capture.lifecycle_id, capture.capture_id,
      settlement.settlement_record_id, ledger.ledger_transaction_id,
      capture.processor_code, 'REFUND', capture.approved_amount_cents,
      capture.currency, postdated_policy_id, opened_at, case_evidence_sha,
      postdated_case_material_sha
    );
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    postdated_policy_rejected := TRUE;
  END;

  replacement_case_material_sha := hxos_payment_exception_case_sha256_v7(
    replacement_case_id, capture.lifecycle_id, capture.capture_id,
    settlement.settlement_record_id, ledger.ledger_transaction_id,
    capture.processor_code, 'PROVIDER_REPLACEMENT', capture.approved_amount_cents,
    capture.currency, replacement_policy_id, opened_at, case_evidence_sha
  );
  BEGIN
    INSERT INTO payment_post_funding_exception_cases_v7(
      case_id, lifecycle_id, capture_id, settlement_record_id,
      ledger_transaction_id, processor_code, case_kind, amount_cents,
      currency, policy_decision_id, opened_at, evidence_sha256,
      case_material_sha256
    ) VALUES (
      replacement_case_id, capture.lifecycle_id, capture.capture_id,
      settlement.settlement_record_id, ledger.ledger_transaction_id,
      capture.processor_code, 'PROVIDER_REPLACEMENT', capture.approved_amount_cents,
      capture.currency, replacement_policy_id, opened_at, case_evidence_sha,
      replacement_case_material_sha
    );
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    provider_replacement_rejected := TRUE;
  END;

  refund_case_material_sha := hxos_payment_exception_case_sha256_v7(
    refund_case_id, capture.lifecycle_id, capture.capture_id,
    settlement.settlement_record_id, ledger.ledger_transaction_id,
    capture.processor_code, 'REFUND', capture.approved_amount_cents,
    capture.currency, refund_policy_id, opened_at, case_evidence_sha
  );
  INSERT INTO payment_post_funding_exception_cases_v7(
    case_id, lifecycle_id, capture_id, settlement_record_id,
    ledger_transaction_id, processor_code, case_kind, amount_cents,
    currency, policy_decision_id, opened_at, evidence_sha256,
    case_material_sha256
  ) VALUES (
    refund_case_id, capture.lifecycle_id, capture.capture_id,
    settlement.settlement_record_id, ledger.ledger_transaction_id,
    capture.processor_code, 'REFUND', capture.approved_amount_cents,
    capture.currency, refund_policy_id, opened_at, case_evidence_sha,
    refund_case_material_sha
  );

  open_event_material_sha := hxos_payment_exception_event_sha256_v7(
    open_event_id, refund_case_id, 1, NULL, 'OPEN', refund_policy_id,
    'HUMAN_REVIEW', NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    open_evidence_sha, opened_at
  );
  INSERT INTO payment_post_funding_exception_events_v7(
    event_id, case_id, sequence_number, prior_event_id, state,
    policy_decision_id, evidence_source, webhook_inbox_id, resolution_code,
    provider_reference_sha256, customer_refund_cents, provider_loss_cents,
    platform_loss_cents, processor_loss_cents, evidence_sha256, observed_at,
    event_material_sha256
  ) VALUES (
    open_event_id, refund_case_id, 1, NULL, 'OPEN', refund_policy_id,
    'HUMAN_REVIEW', NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    open_evidence_sha, opened_at, open_event_material_sha
  );

  INSERT INTO payment_webhook_inbox_v7(
    webhook_inbox_id, processor_code, event_id_sha256, payload_sha256,
    authentication_state, normalized_event_type, processing_state,
    received_at, created_at, authentication_evidence_sha256,
    signature_verified_at
  ) VALUES (
    unrelated_webhook_id, capture.processor_code,
    encode(digest(unrelated_webhook_id::TEXT, 'sha256'), 'hex'),
    encode(digest(unrelated_webhook_id::TEXT || ':payload', 'sha256'), 'hex'),
    'VERIFIED', 'CAPTURE_SUCCEEDED', 'NORMALIZED',
    opened_at + INTERVAL '1 second', opened_at + INTERVAL '1 second',
    repeat('f', 64), opened_at + INTERVAL '1 second'
  );
  unrelated_webhook_event_sha :=
    encode(digest(unrelated_webhook_id::TEXT, 'sha256'), 'hex');
  unrelated_webhook_payload_sha :=
    encode(digest(unrelated_webhook_id::TEXT || ':payload', 'sha256'), 'hex');
  unrelated_webhook_event_material_sha := hxos_payment_exception_event_sha256_v7(
    unrelated_webhook_event_id, refund_case_id, 2, open_event_id,
    'RESOLVED', refund_policy_id, 'WEBHOOK', unrelated_webhook_id,
    'REFUNDED', unrelated_webhook_event_sha, capture.approved_amount_cents,
    0, 0, 0, unrelated_webhook_payload_sha, opened_at
  );
  BEGIN
    INSERT INTO payment_post_funding_exception_events_v7(
      event_id, case_id, sequence_number, prior_event_id, state,
      policy_decision_id, evidence_source, webhook_inbox_id, resolution_code,
      provider_reference_sha256, customer_refund_cents, provider_loss_cents,
      platform_loss_cents, processor_loss_cents, evidence_sha256, observed_at,
      event_material_sha256
    ) VALUES (
      unrelated_webhook_event_id, refund_case_id, 2, open_event_id,
      'RESOLVED', refund_policy_id, 'WEBHOOK', unrelated_webhook_id,
      'REFUNDED', unrelated_webhook_event_sha, capture.approved_amount_cents,
      0, 0, 0, unrelated_webhook_payload_sha, opened_at,
      unrelated_webhook_event_material_sha
    );
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    unrelated_webhook_rejected := TRUE;
  END;

  dispute_case_material_sha := hxos_payment_exception_case_sha256_v7(
    dispute_case_id, capture.lifecycle_id, capture.capture_id,
    settlement.settlement_record_id, ledger.ledger_transaction_id,
    capture.processor_code, 'DISPUTE', capture.approved_amount_cents,
    capture.currency, dispute_policy_id, opened_at, case_evidence_sha
  );
  BEGIN
    INSERT INTO payment_post_funding_exception_cases_v7(
      case_id, lifecycle_id, capture_id, settlement_record_id,
      ledger_transaction_id, processor_code, case_kind, amount_cents,
      currency, policy_decision_id, opened_at, evidence_sha256,
      case_material_sha256
    ) VALUES (
      dispute_case_id, capture.lifecycle_id, capture.capture_id,
      settlement.settlement_record_id, ledger.ledger_transaction_id,
      capture.processor_code, 'DISPUTE', capture.approved_amount_cents,
      capture.currency, dispute_policy_id, opened_at, case_evidence_sha,
      dispute_case_material_sha
    );
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    conflicting_refund_dispute_rejected := TRUE;
  END;

  closed_at := date_trunc('milliseconds', clock_timestamp());
  closure_material_sha := hxos_payment_closure_attestation_sha256_v7(
    closure_attestation_id, capture.lifecycle_id, capture.capture_id,
    settlement.settlement_record_id, ledger.ledger_transaction_id,
    reconciliation_run.reconciliation_run_id,
    reconciliation_item.reconciliation_item_id, 0, closed_at,
    closure_evidence_sha
  );
  BEGIN
    INSERT INTO payment_closure_attestations_v7(
      closure_attestation_id, lifecycle_id, capture_id, settlement_record_id,
      ledger_transaction_id, reconciliation_run_id, reconciliation_item_id,
      open_post_funding_exposure_count, closed_at, evidence_sha256,
      closure_material_sha256
    ) VALUES (
      closure_attestation_id, capture.lifecycle_id, capture.capture_id,
      settlement.settlement_record_id, ledger.ledger_transaction_id,
      reconciliation_run.reconciliation_run_id,
      reconciliation_item.reconciliation_item_id, 0, closed_at,
      closure_evidence_sha, closure_material_sha
    );
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    open_exception_blocks_closure := TRUE;
  END;

  resolved_at := date_trunc('milliseconds', clock_timestamp());
  resolved_event_material_sha := hxos_payment_exception_event_sha256_v7(
    resolved_event_id, refund_case_id, 2, open_event_id, 'RESOLVED',
    refund_policy_id, 'HUMAN_REVIEW', NULL, 'REFUNDED',
    provider_reference_sha, capture.approved_amount_cents, 0, 0, 0,
    resolution_evidence_sha, resolved_at
  );
  INSERT INTO payment_post_funding_exception_events_v7(
    event_id, case_id, sequence_number, prior_event_id, state,
    policy_decision_id, evidence_source, webhook_inbox_id, resolution_code,
    provider_reference_sha256, customer_refund_cents, provider_loss_cents,
    platform_loss_cents, processor_loss_cents, evidence_sha256, observed_at,
    event_material_sha256
  ) VALUES (
    resolved_event_id, refund_case_id, 2, open_event_id, 'RESOLVED',
    refund_policy_id, 'HUMAN_REVIEW', NULL, 'REFUNDED',
    provider_reference_sha, capture.approved_amount_cents, 0, 0, 0,
    resolution_evidence_sha, resolved_at, resolved_event_material_sha
  );

  BEGIN
    INSERT INTO payment_closure_attestations_v7(
      closure_attestation_id, lifecycle_id, capture_id, settlement_record_id,
      ledger_transaction_id, reconciliation_run_id, reconciliation_item_id,
      open_post_funding_exposure_count, closed_at, evidence_sha256,
      closure_material_sha256
    ) VALUES (
      closure_attestation_id, capture.lifecycle_id, capture.capture_id,
      settlement.settlement_record_id, ledger.ledger_transaction_id,
      reconciliation_run.reconciliation_run_id,
      reconciliation_item.reconciliation_item_id, 0, closed_at,
      closure_evidence_sha, closure_material_sha
    );
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    unreconciled_resolution_blocks_closure := TRUE;
  END;

  adjustment_material_sha := hxos_payment_exception_adjustment_sha256_v7(
    adjustment_id, refund_case_id, resolved_event_id, capture.lifecycle_id,
    capture.capture_id, 'REFUND', capture.approved_amount_cents,
    capture.approved_amount_cents, capture.approved_amount_cents,
    capture.currency, adjustment_evidence_sha, resolved_at
  );
  INSERT INTO payment_exception_ledger_adjustments_v7(
    adjustment_id, case_id, terminal_event_id, lifecycle_id, capture_id,
    transaction_type, adjustment_amount_cents, debit_total_cents,
    credit_total_cents, currency, evidence_sha256,
    adjustment_material_sha256, created_at
  ) VALUES (
    adjustment_id, refund_case_id, resolved_event_id, capture.lifecycle_id,
    capture.capture_id, 'REFUND', capture.approved_amount_cents,
    capture.approved_amount_cents, capture.approved_amount_cents,
    capture.currency, adjustment_evidence_sha, adjustment_material_sha,
    resolved_at
  );

  reconciled_at := date_trunc('milliseconds', clock_timestamp());
  crossed_reconciliation_material_sha :=
    hxos_payment_exception_reconciliation_sha256_v7(
      crossed_reconciliation_id, refund_case_id, resolved_event_id,
      adjustment_id, capture.approved_amount_cents - 1,
      capture.approved_amount_cents, capture.currency, 'MATCHED',
      reconciliation_evidence_sha, reconciled_at
    );
  BEGIN
    INSERT INTO payment_exception_reconciliations_v7(
      reconciliation_id, case_id, terminal_event_id, adjustment_id,
      processor_amount_cents, ledger_amount_cents, currency,
      reconciliation_state, evidence_sha256, reconciled_at,
      reconciliation_material_sha256
    ) VALUES (
      crossed_reconciliation_id, refund_case_id, resolved_event_id,
      adjustment_id, capture.approved_amount_cents - 1,
      capture.approved_amount_cents, capture.currency, 'MATCHED',
      reconciliation_evidence_sha, reconciled_at,
      crossed_reconciliation_material_sha
    );
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    crossed_exception_reconciliation_rejected := TRUE;
  END;

  exception_reconciliation_material_sha :=
    hxos_payment_exception_reconciliation_sha256_v7(
      exception_reconciliation_id, refund_case_id, resolved_event_id,
      adjustment_id, capture.approved_amount_cents,
      capture.approved_amount_cents, capture.currency, 'MATCHED',
      reconciliation_evidence_sha, reconciled_at
    );
  INSERT INTO payment_exception_reconciliations_v7(
    reconciliation_id, case_id, terminal_event_id, adjustment_id,
    processor_amount_cents, ledger_amount_cents, currency,
    reconciliation_state, evidence_sha256, reconciled_at,
    reconciliation_material_sha256
  ) VALUES (
    exception_reconciliation_id, refund_case_id, resolved_event_id,
    adjustment_id, capture.approved_amount_cents,
    capture.approved_amount_cents, capture.currency, 'MATCHED',
    reconciliation_evidence_sha, reconciled_at,
    exception_reconciliation_material_sha
  );

  closed_at := date_trunc('milliseconds', clock_timestamp());
  closure_material_sha := hxos_payment_closure_attestation_sha256_v7(
    closure_attestation_id, capture.lifecycle_id, capture.capture_id,
    settlement.settlement_record_id, ledger.ledger_transaction_id,
    reconciliation_run.reconciliation_run_id,
    reconciliation_item.reconciliation_item_id, 0, closed_at,
    closure_evidence_sha
  );
  INSERT INTO payment_closure_attestations_v7(
    closure_attestation_id, lifecycle_id, capture_id, settlement_record_id,
    ledger_transaction_id, reconciliation_run_id, reconciliation_item_id,
    open_post_funding_exposure_count, closed_at, evidence_sha256,
    closure_material_sha256
  ) VALUES (
    closure_attestation_id, capture.lifecycle_id, capture.capture_id,
    settlement.settlement_record_id, ledger.ledger_transaction_id,
    reconciliation_run.reconciliation_run_id,
    reconciliation_item.reconciliation_item_id, 0, closed_at,
    closure_evidence_sha, closure_material_sha
  );
  INSERT INTO payment_underwriting_lifecycle_events_v7(
    event_id, lifecycle_id, task_draft_id, sequence_number, prior_event_id,
    command_id, stage, actor_type, evidence_sha256, event_material, event_sha256
  ) VALUES (
    closed_event_id, capture.lifecycle_id, lifecycle.task_draft_id,
    latest_event.sequence_number + 1, latest_event.event_id, gen_random_uuid(),
    'CLOSED', 'SYSTEM', closure_material_sha,
    jsonb_build_object('schema', 'HX_PAYMENT_D8_CLOSED_EVENT_V7'),
    encode(digest(closed_event_id::TEXT || ':d8-closed', 'sha256'), 'hex')
  );

  SELECT status.effective_financial_state, status.open_exception_case_count
    INTO effective_financial_state, open_exception_case_count
  FROM payment_exception_recovery_status_v7 status
  WHERE status.lifecycle_id = capture.lifecycle_id;
  IF effective_financial_state IS DISTINCT FROM 'CLOSED'
     OR open_exception_case_count <> 0 THEN
    RAISE EXCEPTION 'D8 resolved exception did not restore financial closure';
  END IF;

  INSERT INTO task_drafts(
    id, submission_id, card_token_hash, raw_input, poster_user_id
  )
  SELECT recurring_task_draft_id, gen_random_uuid(),
    'd8-recurring-' || recurring_task_draft_id, 'D8 recurring occurrence',
    draft.poster_user_id
  FROM task_drafts draft WHERE draft.id = lifecycle.task_draft_id;
  INSERT INTO payment_underwriting_lifecycles_v7(
    lifecycle_id, task_draft_id, request_id, pricing_lane,
    authority_document_id, authority_drive_revision,
    authority_docs_revision, authority_text_sha256
  ) VALUES (
    recurring_lifecycle_id, recurring_task_draft_id, gen_random_uuid(),
    'PLATFORM_PRICED',
    '1PYpWdbnlhRBoovc6GfTyxMuu1IzMIdDQpV6hHHraXaQ', '7',
    'AIroW37g_sqKNU_dvvRNUndw-qUeooFwAYIHqN60aHvPSR178sKjMMu5rMzGTzODqgDKERue3ZbAT8UesInsUZvT6p1Z0bUvPByrgwaPDA',
    'ba8dc04bfc43feb24bd78698c6e5b820ecdf22177f915fb04856a55d8076bd26'
  );
  INSERT INTO payment_underwriting_lifecycle_events_v7(
    event_id, lifecycle_id, task_draft_id, sequence_number, prior_event_id,
    command_id, stage, actor_type, evidence_sha256, event_material, event_sha256
  ) VALUES (
    recurring_lifecycle_event_id, recurring_lifecycle_id,
    recurring_task_draft_id, 1, NULL, gen_random_uuid(), 'TASK_DRAFT',
    'SYSTEM', recurring_evidence_sha,
    jsonb_build_object('schema', 'HX_PAYMENT_D8_RECURRING_DRAFT_EVENT_V7'),
    encode(digest(recurring_lifecycle_event_id::TEXT, 'sha256'), 'hex')
  );
  recurring_created_at := date_trunc('milliseconds', clock_timestamp());
  long_term_occurrence_material_sha := hxos_payment_recurring_occurrence_sha256_v7(
    long_term_occurrence_id, series_sha, 1, NULL, recurring_task_draft_id,
    recurring_lifecycle_id, recurring_policy_id, current_date + 7,
    'ANNUAL_PREPAID', recurring_evidence_sha, recurring_created_at
  );
  BEGIN
    INSERT INTO payment_recurring_occurrences_v7(
      occurrence_id, series_sha256, sequence_number, prior_occurrence_id,
      task_draft_id, lifecycle_id, policy_decision_id, service_date,
      prepayment_mode, evidence_sha256, occurrence_material_sha256, created_at
    ) VALUES (
      long_term_occurrence_id, series_sha, 1, NULL, recurring_task_draft_id,
      recurring_lifecycle_id, recurring_policy_id, current_date + 7,
      'ANNUAL_PREPAID', recurring_evidence_sha,
      long_term_occurrence_material_sha, recurring_created_at
    );
  EXCEPTION WHEN check_violation THEN
    long_term_prepayment_rejected := TRUE;
  END;

  recurring_occurrence_material_sha := hxos_payment_recurring_occurrence_sha256_v7(
    recurring_occurrence_id, series_sha, 1, NULL, recurring_task_draft_id,
    recurring_lifecycle_id, recurring_policy_id, current_date + 7,
    'PER_OCCURRENCE_ONLY', recurring_evidence_sha, recurring_created_at
  );
  INSERT INTO payment_recurring_occurrences_v7(
    occurrence_id, series_sha256, sequence_number, prior_occurrence_id,
    task_draft_id, lifecycle_id, policy_decision_id, service_date,
    prepayment_mode, evidence_sha256, occurrence_material_sha256, created_at
  ) VALUES (
    recurring_occurrence_id, series_sha, 1, NULL, recurring_task_draft_id,
    recurring_lifecycle_id, recurring_policy_id, current_date + 7,
    'PER_OCCURRENCE_ONLY', recurring_evidence_sha,
    recurring_occurrence_material_sha, recurring_created_at
  );
  duplicate_occurrence_material_sha := hxos_payment_recurring_occurrence_sha256_v7(
    duplicate_occurrence_id, repeat('b', 64), 1, NULL,
    recurring_task_draft_id, recurring_lifecycle_id, recurring_policy_id,
    current_date + 14, 'PER_OCCURRENCE_ONLY', recurring_evidence_sha,
    recurring_created_at
  );
  BEGIN
    INSERT INTO payment_recurring_occurrences_v7(
      occurrence_id, series_sha256, sequence_number, prior_occurrence_id,
      task_draft_id, lifecycle_id, policy_decision_id, service_date,
      prepayment_mode, evidence_sha256, occurrence_material_sha256, created_at
    ) VALUES (
      duplicate_occurrence_id, repeat('b', 64), 1, NULL,
      recurring_task_draft_id, recurring_lifecycle_id, recurring_policy_id,
      current_date + 14, 'PER_OCCURRENCE_ONLY', recurring_evidence_sha,
      duplicate_occurrence_material_sha, recurring_created_at
    );
  EXCEPTION WHEN unique_violation THEN
    duplicate_lifecycle_occurrence_rejected := TRUE;
  END;

  BEGIN
    UPDATE payment_post_funding_exception_events_v7
       SET evidence_sha256 = evidence_sha256
     WHERE event_id = open_event_id;
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    exception_event_update_rejected := TRUE;
  END;
  BEGIN
    TRUNCATE
      payment_processor_policy_decisions_v7,
      payment_post_funding_exception_cases_v7,
      payment_post_funding_exception_events_v7,
      payment_exception_ledger_adjustments_v7,
      payment_exception_reconciliations_v7,
      payment_recurring_occurrences_v7;
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    exception_case_truncate_rejected := TRUE;
  END;

  SELECT count(*) INTO runtime_relation_privilege_count
  FROM information_schema.table_privileges grant_row
  WHERE grant_row.table_schema = 'public'
    AND grant_row.grantee IN ('PUBLIC', 'service_role')
    AND grant_row.table_name IN (
      'payment_processor_policy_decisions_v7',
      'payment_post_funding_exception_cases_v7',
      'payment_post_funding_exception_events_v7',
      'payment_exception_ledger_adjustments_v7',
      'payment_exception_reconciliations_v7',
      'payment_recurring_occurrences_v7',
      'payment_exception_recovery_status_v7'
    );
  SELECT count(*) INTO runtime_function_authority_count
  FROM pg_proc procedure
  JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
  WHERE namespace.nspname = 'public'
    AND (
      procedure.proname LIKE 'hxos_payment_exception_%_v7'
      OR procedure.proname LIKE 'hxos_enforce_payment_exception_%_v7'
      OR procedure.proname IN (
        'hxos_payment_policy_decision_sha256_v7',
        'hxos_payment_recurring_occurrence_sha256_v7',
        'hxos_payment_policy_domain_for_case_v7',
        'hxos_payment_open_exception_count_v7',
        'hxos_enforce_payment_policy_decision_v7',
        'hxos_enforce_payment_recurring_occurrence_v7',
        'hxos_reject_payment_underwriting_d8_mutation_v7'
      )
    )
    AND (
      procedure.prosecdef
      OR has_function_privilege('service_role', procedure.oid, 'EXECUTE')
      OR EXISTS (
        SELECT 1
        FROM aclexplode(COALESCE(procedure.proacl, acldefault('f', procedure.proowner))) acl
        WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
      )
    );

  IF NOT unapproved_policy_rejected
     OR NOT postdated_policy_rejected
     OR NOT unrelated_webhook_rejected
     OR NOT provider_replacement_rejected
     OR NOT conflicting_refund_dispute_rejected
     OR NOT open_exception_blocks_closure
     OR NOT unreconciled_resolution_blocks_closure
     OR NOT crossed_exception_reconciliation_rejected
     OR NOT long_term_prepayment_rejected
     OR NOT duplicate_lifecycle_occurrence_rejected
     OR NOT exception_event_update_rejected
     OR NOT exception_case_truncate_rejected
     OR runtime_relation_privilege_count <> 0
     OR runtime_function_authority_count <> 0 THEN
    RAISE EXCEPTION 'D8 negative invariant failure: %', jsonb_build_object(
      'unapprovedPolicy', unapproved_policy_rejected,
      'postdatedPolicy', postdated_policy_rejected,
      'unrelatedWebhook', unrelated_webhook_rejected,
      'providerReplacement', provider_replacement_rejected,
      'conflictingRefundDispute', conflicting_refund_dispute_rejected,
      'openException', open_exception_blocks_closure,
      'unreconciledResolution', unreconciled_resolution_blocks_closure,
      'crossedReconciliation', crossed_exception_reconciliation_rejected,
      'longTermPrepayment', long_term_prepayment_rejected,
      'duplicateOccurrence', duplicate_lifecycle_occurrence_rejected,
      'eventUpdate', exception_event_update_rejected,
      'caseTruncate', exception_case_truncate_rejected,
      'runtimeRelationPrivileges', runtime_relation_privilege_count,
      'runtimeFunctionAuthority', runtime_function_authority_count
    );
  END IF;
END;
$$;

DO $$
DECLARE
  capture payment_captures_v7%ROWTYPE;
  settlement payment_settlement_records_v7%ROWTYPE;
  ledger payment_ledger_transactions_v7%ROWTYPE;
  policy payment_processor_policy_decisions_v7%ROWTYPE;
  prior_closure payment_closure_attestations_v7%ROWTYPE;
  later_case_id UUID := gen_random_uuid();
  later_open_event_id UUID := gen_random_uuid();
  later_resolved_event_id UUID := gen_random_uuid();
  later_adjustment_id UUID := gen_random_uuid();
  later_reconciliation_id UUID := gen_random_uuid();
  later_case_material_sha TEXT;
  later_open_material_sha TEXT;
  later_resolved_material_sha TEXT;
  later_adjustment_material_sha TEXT;
  later_reconciliation_material_sha TEXT;
  later_opened_at TIMESTAMPTZ;
  later_resolved_at TIMESTAMPTZ;
  later_reconciled_at TIMESTAMPTZ;
  evidence_sha TEXT := repeat('c', 64);
  provider_reference_sha TEXT := repeat('b', 64);
  effective_financial_state TEXT;
  open_exception_case_count BIGINT;
  stale_closure_not_reused BOOLEAN := FALSE;
BEGIN
  SELECT * INTO capture FROM payment_captures_v7 LIMIT 1;
  SELECT * INTO settlement FROM payment_settlement_records_v7
   WHERE capture_id = capture.capture_id ORDER BY sequence_number DESC LIMIT 1;
  SELECT * INTO ledger FROM payment_ledger_transactions_v7
   WHERE capture_id = capture.capture_id;
  SELECT * INTO policy FROM payment_processor_policy_decisions_v7
   WHERE processor_code = capture.processor_code
     AND policy_domain = 'REFUND'
     AND decision_state = 'APPROVED'
     AND policy_version = 2;
  SELECT * INTO prior_closure FROM payment_closure_attestations_v7
   WHERE lifecycle_id = capture.lifecycle_id;

  later_opened_at := prior_closure.closed_at + INTERVAL '1 millisecond';
  later_case_material_sha := hxos_payment_exception_case_sha256_v7(
    later_case_id, capture.lifecycle_id, capture.capture_id,
    settlement.settlement_record_id, ledger.ledger_transaction_id,
    capture.processor_code, 'REFUND', capture.approved_amount_cents,
    capture.currency, policy.decision_id, later_opened_at, evidence_sha
  );
  INSERT INTO payment_post_funding_exception_cases_v7(
    case_id, lifecycle_id, capture_id, settlement_record_id,
    ledger_transaction_id, processor_code, case_kind, amount_cents,
    currency, policy_decision_id, opened_at, evidence_sha256,
    case_material_sha256
  ) VALUES (
    later_case_id, capture.lifecycle_id, capture.capture_id,
    settlement.settlement_record_id, ledger.ledger_transaction_id,
    capture.processor_code, 'REFUND', capture.approved_amount_cents,
    capture.currency, policy.decision_id, later_opened_at, evidence_sha,
    later_case_material_sha
  );

  later_open_material_sha := hxos_payment_exception_event_sha256_v7(
    later_open_event_id, later_case_id, 1, NULL, 'OPEN', policy.decision_id,
    'HUMAN_REVIEW', NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    evidence_sha, later_opened_at
  );
  INSERT INTO payment_post_funding_exception_events_v7(
    event_id, case_id, sequence_number, prior_event_id, state,
    policy_decision_id, evidence_source, webhook_inbox_id, resolution_code,
    provider_reference_sha256, customer_refund_cents, provider_loss_cents,
    platform_loss_cents, processor_loss_cents, evidence_sha256, observed_at,
    event_material_sha256
  ) VALUES (
    later_open_event_id, later_case_id, 1, NULL, 'OPEN', policy.decision_id,
    'HUMAN_REVIEW', NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    evidence_sha, later_opened_at, later_open_material_sha
  );

  later_resolved_at := later_opened_at + INTERVAL '1 millisecond';
  later_resolved_material_sha := hxos_payment_exception_event_sha256_v7(
    later_resolved_event_id, later_case_id, 2, later_open_event_id,
    'RESOLVED', policy.decision_id, 'HUMAN_REVIEW', NULL, 'REFUNDED',
    provider_reference_sha, capture.approved_amount_cents, 0, 0, 0,
    evidence_sha, later_resolved_at
  );
  INSERT INTO payment_post_funding_exception_events_v7(
    event_id, case_id, sequence_number, prior_event_id, state,
    policy_decision_id, evidence_source, webhook_inbox_id, resolution_code,
    provider_reference_sha256, customer_refund_cents, provider_loss_cents,
    platform_loss_cents, processor_loss_cents, evidence_sha256, observed_at,
    event_material_sha256
  ) VALUES (
    later_resolved_event_id, later_case_id, 2, later_open_event_id,
    'RESOLVED', policy.decision_id, 'HUMAN_REVIEW', NULL, 'REFUNDED',
    provider_reference_sha, capture.approved_amount_cents, 0, 0, 0,
    evidence_sha, later_resolved_at, later_resolved_material_sha
  );

  later_adjustment_material_sha := hxos_payment_exception_adjustment_sha256_v7(
    later_adjustment_id, later_case_id, later_resolved_event_id,
    capture.lifecycle_id, capture.capture_id, 'REFUND',
    capture.approved_amount_cents, capture.approved_amount_cents,
    capture.approved_amount_cents, capture.currency, evidence_sha,
    later_resolved_at
  );
  INSERT INTO payment_exception_ledger_adjustments_v7(
    adjustment_id, case_id, terminal_event_id, lifecycle_id, capture_id,
    transaction_type, adjustment_amount_cents, debit_total_cents,
    credit_total_cents, currency, evidence_sha256,
    adjustment_material_sha256, created_at
  ) VALUES (
    later_adjustment_id, later_case_id, later_resolved_event_id,
    capture.lifecycle_id, capture.capture_id, 'REFUND',
    capture.approved_amount_cents, capture.approved_amount_cents,
    capture.approved_amount_cents, capture.currency, evidence_sha,
    later_adjustment_material_sha, later_resolved_at
  );

  later_reconciled_at := later_resolved_at + INTERVAL '1 millisecond';
  later_reconciliation_material_sha :=
    hxos_payment_exception_reconciliation_sha256_v7(
      later_reconciliation_id, later_case_id, later_resolved_event_id,
      later_adjustment_id, capture.approved_amount_cents,
      capture.approved_amount_cents, capture.currency, 'MATCHED',
      evidence_sha, later_reconciled_at
    );
  INSERT INTO payment_exception_reconciliations_v7(
    reconciliation_id, case_id, terminal_event_id, adjustment_id,
    processor_amount_cents, ledger_amount_cents, currency,
    reconciliation_state, evidence_sha256, reconciled_at,
    reconciliation_material_sha256
  ) VALUES (
    later_reconciliation_id, later_case_id, later_resolved_event_id,
    later_adjustment_id, capture.approved_amount_cents,
    capture.approved_amount_cents, capture.currency, 'MATCHED',
    evidence_sha, later_reconciled_at, later_reconciliation_material_sha
  );

  SELECT status.effective_financial_state, status.open_exception_case_count
    INTO effective_financial_state, open_exception_case_count
  FROM payment_exception_recovery_status_v7 status
  WHERE status.lifecycle_id = capture.lifecycle_id;
  stale_closure_not_reused :=
    effective_financial_state = 'RECOVERY_RECONCILED_AWAITING_RECLOSURE'
    AND open_exception_case_count = 0;
  IF NOT stale_closure_not_reused THEN
    RAISE EXCEPTION 'D8 reused stale closure after post-close exception: %/%',
      effective_financial_state, open_exception_case_count;
  END IF;
END;
$$;

\ir ../../database/migrations/20260826_payment_underwriting_exception_recovery_v7.sql

DO $$
DECLARE counts BIGINT[];
BEGIN
  SELECT ARRAY[
    (SELECT count(*) FROM payment_processor_policy_decisions_v7),
    (SELECT count(*) FROM payment_post_funding_exception_cases_v7),
    (SELECT count(*) FROM payment_post_funding_exception_events_v7),
    (SELECT count(*) FROM payment_exception_ledger_adjustments_v7),
    (SELECT count(*) FROM payment_exception_reconciliations_v7),
    (SELECT count(*) FROM payment_recurring_occurrences_v7)
  ] INTO counts;
  IF counts IS DISTINCT FROM ARRAY[6, 2, 4, 2, 2, 1]::BIGINT[] THEN
    RAISE EXCEPTION 'D8 replay changed evidence: %', counts;
  END IF;
END;
$$;

ROLLBACK;
