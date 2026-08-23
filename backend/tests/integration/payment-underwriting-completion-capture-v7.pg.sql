\if :{?HXP_D7_COMPOSED}
\else
BEGIN;
\endif

SET LOCAL hustlexp.local_test_identity_enabled = 'true';

\set HXP_D6_COMPOSED true
\ir payment-underwriting-work-order-v7.pg.sql
\unset HXP_D6_COMPOSED
\ir ../../database/migrations/20260824_payment_underwriting_completion_capture_v7.sql

DO $$
<<d6_test>>
DECLARE
  work_order payment_canonical_work_orders_v7%ROWTYPE;
  assignment payment_work_order_assignments_v7%ROWTYPE;
  latest_event payment_underwriting_lifecycle_events_v7%ROWTYPE;
  fse payment_financial_security_events_v7%ROWTYPE;
  completion_evidence_id UUID := gen_random_uuid();
  completion_approval_id UUID := gen_random_uuid();
  missing_notice_approval_id UUID := gen_random_uuid();
  amount_mismatch_approval_id UUID := gen_random_uuid();
  capture_authority_id UUID := gen_random_uuid();
  expired_capture_authority_id UUID := gen_random_uuid();
  capture_id UUID := gen_random_uuid();
  operation_id UUID := gen_random_uuid();
  crossed_capture_id UUID := gen_random_uuid();
  crossed_operation_id UUID := gen_random_uuid();
  stale_capture_id UUID := gen_random_uuid();
  stale_operation_id UUID := gen_random_uuid();
  in_progress_event_id UUID := gen_random_uuid();
  completion_event_id UUID := gen_random_uuid();
  capture_pending_event_id UUID := gen_random_uuid();
  captured_event_id UUID := gen_random_uuid();
  api_observation_id UUID := gen_random_uuid();
  regressed_observation_id UUID := gen_random_uuid();
  wrong_webhook_observation_id UUID := gen_random_uuid();
  webhook_observation_id UUID := gen_random_uuid();
  wrong_webhook_inbox_id UUID := gen_random_uuid();
  webhook_inbox_id UUID := gen_random_uuid();
  proof_bundle_sha TEXT := repeat('1', 64);
  evidence_sha TEXT := repeat('2', 64);
  customer_notice_sha TEXT := repeat('3', 64);
  amount_approval_sha TEXT := repeat('4', 64);
  incident_clearance_sha TEXT := repeat('5', 64);
  approval_evidence_sha TEXT := repeat('6', 64);
  request_sha TEXT := repeat('7', 64);
  provider_operation_sha TEXT := repeat('8', 64);
  completion_material_sha TEXT;
  approval_material_sha TEXT;
  authority_sha TEXT;
  operation_material_sha TEXT;
  crossed_operation_material_sha TEXT;
  api_material_sha TEXT;
  regressed_material_sha TEXT;
  wrong_webhook_material_sha TEXT;
  webhook_material_sha TEXT;
  agreement_sha TEXT;
  wrong_event_sha TEXT;
  webhook_event_sha TEXT;
  submitted_at TIMESTAMPTZ;
  approved_at TIMESTAMPTZ;
  authorized_at TIMESTAMPTZ;
  expires_at TIMESTAMPTZ;
  capture_created_at TIMESTAMPTZ;
  api_observed_at TIMESTAMPTZ;
  webhook_observed_at TIMESTAMPTZ;
  missing_notice_rejected BOOLEAN := FALSE;
  amount_mismatch_rejected BOOLEAN := FALSE;
  expired_authority_rejected BOOLEAN := FALSE;
  stale_operation_rejected BOOLEAN := FALSE;
  crossed_capture_evidence_rejected BOOLEAN := FALSE;
  regressed_observation_rejected BOOLEAN := FALSE;
  webhook_hash_rejected BOOLEAN := FALSE;
BEGIN
  SELECT * INTO work_order FROM payment_canonical_work_orders_v7 LIMIT 1;
  SELECT * INTO assignment FROM payment_work_order_assignments_v7
   WHERE work_order_id = work_order.work_order_id;
  SELECT * INTO fse FROM payment_financial_security_events_v7
   WHERE financial_security_event_id = work_order.financial_security_event_id;
  SELECT * INTO latest_event FROM payment_underwriting_lifecycle_events_v7
   WHERE lifecycle_id = work_order.lifecycle_id
   ORDER BY sequence_number DESC LIMIT 1;

  UPDATE tasks SET state = 'PROOF_SUBMITTED'
   WHERE id = work_order.task_id;
  INSERT INTO payment_underwriting_lifecycle_events_v7(
    event_id, lifecycle_id, task_draft_id, sequence_number, prior_event_id,
    command_id, stage, actor_type, evidence_sha256, event_material, event_sha256
  ) VALUES (
    in_progress_event_id, work_order.lifecycle_id, work_order.task_draft_id,
    latest_event.sequence_number + 1, latest_event.event_id, gen_random_uuid(),
    'IN_PROGRESS', 'SYSTEM', assignment.assignment_sha256,
    jsonb_build_object('schema', 'HX_PAYMENT_D6_IN_PROGRESS_EVENT_V7'),
    encode(digest(in_progress_event_id::TEXT || ':in-progress', 'sha256'), 'hex')
  );

  submitted_at := date_trunc('milliseconds', clock_timestamp());
  completion_material_sha := hxos_payment_completion_evidence_sha256_v7(
    completion_evidence_id, work_order.lifecycle_id, work_order.work_order_id,
    assignment.assignment_id, work_order.task_id,
    work_order.assigned_provider_user_id, proof_bundle_sha,
    work_order.scope_sha256::TEXT, submitted_at, evidence_sha
  );
  INSERT INTO payment_completion_evidence_v7(
    completion_evidence_id, lifecycle_id, work_order_id, assignment_id,
    task_id, provider_account_ref_id, provider_user_id, submitted_by_user_id,
    proof_bundle_sha256, completion_scope_sha256, submitted_at,
    evidence_sha256, completion_material_sha256
  ) VALUES (
    completion_evidence_id, work_order.lifecycle_id, work_order.work_order_id,
    assignment.assignment_id, work_order.task_id,
    work_order.provider_account_ref_id, work_order.assigned_provider_user_id,
    work_order.assigned_provider_user_id, proof_bundle_sha,
    work_order.scope_sha256, submitted_at, evidence_sha, completion_material_sha
  );
  INSERT INTO payment_underwriting_lifecycle_events_v7(
    event_id, lifecycle_id, task_draft_id, sequence_number, prior_event_id,
    command_id, stage, actor_type, actor_user_id, evidence_sha256,
    event_material, event_sha256
  ) VALUES (
    completion_event_id, work_order.lifecycle_id, work_order.task_draft_id,
    latest_event.sequence_number + 2, in_progress_event_id, gen_random_uuid(),
    'COMPLETION_SUBMITTED', 'PROVIDER', work_order.assigned_provider_user_id,
    completion_material_sha,
    jsonb_build_object('schema', 'HX_PAYMENT_D6_COMPLETION_EVENT_V7'),
    encode(digest(completion_event_id::TEXT || ':completion', 'sha256'), 'hex')
  );

  approved_at := date_trunc('milliseconds', clock_timestamp());
  BEGIN
    approval_material_sha := hxos_payment_completion_approval_sha256_v7(
      missing_notice_approval_id, completion_evidence_id, work_order.lifecycle_id,
      work_order.work_order_id, work_order.task_id, work_order.customer_user_id,
      'MISSING', customer_notice_sha, fse.amount_cents, fse.currency,
      amount_approval_sha, incident_clearance_sha, approved_at,
      approval_evidence_sha
    );
    INSERT INTO payment_completion_approvals_v7(
      completion_approval_id, completion_evidence_id, lifecycle_id, work_order_id, task_id,
      poster_user_id, approved_by_user_id, approval_state,
      customer_notice_state, customer_notice_sha256, approved_amount_cents,
      currency, amount_approval_sha256, incident_clearance_state,
      incident_clearance_sha256, approved_at, evidence_sha256,
      approval_material_sha256
    ) VALUES (
      missing_notice_approval_id, completion_evidence_id,
      work_order.lifecycle_id, work_order.work_order_id,
      work_order.task_id, work_order.customer_user_id, work_order.customer_user_id,
      'APPROVED', 'MISSING', customer_notice_sha, fse.amount_cents, fse.currency,
      amount_approval_sha, 'CLEAR', incident_clearance_sha, approved_at,
      approval_evidence_sha, approval_material_sha
    );
  EXCEPTION WHEN check_violation THEN
    missing_notice_rejected := TRUE;
  END;

  BEGIN
    approval_material_sha := hxos_payment_completion_approval_sha256_v7(
      amount_mismatch_approval_id, completion_evidence_id, work_order.lifecycle_id,
      work_order.work_order_id, work_order.task_id, work_order.customer_user_id,
      'ACKNOWLEDGED', customer_notice_sha, fse.amount_cents - 1, fse.currency,
      amount_approval_sha, incident_clearance_sha, approved_at,
      approval_evidence_sha
    );
    INSERT INTO payment_completion_approvals_v7(
      completion_approval_id, completion_evidence_id, lifecycle_id, work_order_id, task_id,
      poster_user_id, approved_by_user_id, approval_state,
      customer_notice_state, customer_notice_sha256, approved_amount_cents,
      currency, amount_approval_sha256, incident_clearance_state,
      incident_clearance_sha256, approved_at, evidence_sha256,
      approval_material_sha256
    ) VALUES (
      amount_mismatch_approval_id, completion_evidence_id,
      work_order.lifecycle_id, work_order.work_order_id,
      work_order.task_id, work_order.customer_user_id, work_order.customer_user_id,
      'APPROVED', 'ACKNOWLEDGED', customer_notice_sha, fse.amount_cents - 1,
      fse.currency, amount_approval_sha, 'CLEAR', incident_clearance_sha,
      approved_at, approval_evidence_sha, approval_material_sha
    );
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    amount_mismatch_rejected := TRUE;
  END;

  approval_material_sha := hxos_payment_completion_approval_sha256_v7(
    completion_approval_id, completion_evidence_id, work_order.lifecycle_id,
    work_order.work_order_id, work_order.task_id, work_order.customer_user_id,
    'ACKNOWLEDGED', customer_notice_sha, fse.amount_cents, fse.currency,
    amount_approval_sha, incident_clearance_sha, approved_at,
    approval_evidence_sha
  );
  INSERT INTO payment_completion_approvals_v7(
    completion_approval_id, completion_evidence_id, lifecycle_id,
    work_order_id, task_id, poster_user_id, approved_by_user_id,
    approval_state, customer_notice_state, customer_notice_sha256,
    approved_amount_cents, currency, amount_approval_sha256,
    incident_clearance_state, incident_clearance_sha256, approved_at,
    evidence_sha256, approval_material_sha256
  ) VALUES (
    completion_approval_id, completion_evidence_id, work_order.lifecycle_id,
    work_order.work_order_id, work_order.task_id, work_order.customer_user_id,
    work_order.customer_user_id, 'APPROVED', 'ACKNOWLEDGED',
    customer_notice_sha, fse.amount_cents, fse.currency, amount_approval_sha,
    'CLEAR', incident_clearance_sha, approved_at, approval_evidence_sha,
    approval_material_sha
  );

  BEGIN
    authorized_at := date_trunc('milliseconds', clock_timestamp()) - INTERVAL '2 seconds';
    expires_at := authorized_at + INTERVAL '1 second';
    authority_sha := hxos_payment_capture_authority_sha256_v7(
      expired_capture_authority_id, completion_approval_id, completion_evidence_id,
      work_order.lifecycle_id, work_order.work_order_id,
      work_order.financial_security_event_id, work_order.provider_account_ref_id,
      work_order.processor_code, fse.amount_cents, fse.currency,
      work_order.customer_user_id, authorized_at, expires_at
    );
    INSERT INTO payment_capture_authorities_v7(
      capture_authority_id, completion_approval_id, completion_evidence_id, lifecycle_id,
      work_order_id, financial_security_event_id, provider_account_ref_id,
      processor_code, approved_amount_cents, currency, authorized_by_user_id,
      authorized_at, expires_at, authority_sha256
    ) VALUES (
      expired_capture_authority_id, completion_approval_id,
      completion_evidence_id, work_order.lifecycle_id,
      work_order.work_order_id, work_order.financial_security_event_id,
      work_order.provider_account_ref_id, work_order.processor_code,
      fse.amount_cents, fse.currency, work_order.customer_user_id,
      authorized_at, expires_at, authority_sha
    );
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    expired_authority_rejected := TRUE;
  END;

  authorized_at := date_trunc('milliseconds', clock_timestamp());
  expires_at := LEAST(fse.expires_at, authorized_at + INTERVAL '2 minutes');
  authority_sha := hxos_payment_capture_authority_sha256_v7(
    capture_authority_id, completion_approval_id, completion_evidence_id,
    work_order.lifecycle_id, work_order.work_order_id,
    work_order.financial_security_event_id, work_order.provider_account_ref_id,
    work_order.processor_code, fse.amount_cents, fse.currency,
    work_order.customer_user_id, authorized_at, expires_at
  );
  INSERT INTO payment_capture_authorities_v7(
    capture_authority_id, completion_approval_id, completion_evidence_id,
    lifecycle_id, work_order_id, financial_security_event_id,
    provider_account_ref_id, processor_code, approved_amount_cents, currency,
    authorized_by_user_id, authorized_at, expires_at, authority_sha256
  ) VALUES (
    capture_authority_id, completion_approval_id, completion_evidence_id,
    work_order.lifecycle_id, work_order.work_order_id,
    work_order.financial_security_event_id, work_order.provider_account_ref_id,
    work_order.processor_code, fse.amount_cents, fse.currency,
    work_order.customer_user_id, authorized_at, expires_at, authority_sha
  );

  BEGIN
    capture_created_at := date_trunc('milliseconds', clock_timestamp());
    crossed_operation_material_sha := hxos_payment_capture_operation_sha256_v7(
      crossed_capture_id, capture_authority_id, work_order.lifecycle_id,
      work_order.work_order_id, work_order.financial_security_event_id,
      work_order.processor_code, fse.amount_cents, fse.currency,
      repeat('a', 64), repeat('b', 64), repeat('c', 64),
      crossed_operation_id, 'hx-capture-v7:' || crossed_operation_id::TEXT,
      request_sha, capture_created_at, expires_at
    );
    INSERT INTO payment_captures_v7(
      capture_id, lifecycle_id, work_order_id, financial_security_event_id,
      processor_code, approved_amount_cents, currency,
      completion_evidence_sha256, amount_approval_sha256,
      incident_clearance_sha256, operation_id, idempotency_key,
      request_sha256, capture_authority_id, expires_at,
      operation_material_sha256, created_at
    ) VALUES (
      crossed_capture_id, work_order.lifecycle_id, work_order.work_order_id,
      work_order.financial_security_event_id, work_order.processor_code,
      fse.amount_cents, fse.currency, repeat('a', 64), repeat('b', 64),
      repeat('c', 64), crossed_operation_id,
      'hx-capture-v7:' || crossed_operation_id::TEXT, request_sha,
      capture_authority_id, expires_at, crossed_operation_material_sha,
      capture_created_at
    );
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    crossed_capture_evidence_rejected := TRUE;
  END;
  IF NOT crossed_capture_evidence_rejected THEN
    RAISE EXCEPTION 'D6 accepted forged completion, amount, or incident evidence';
  END IF;

  BEGIN
    capture_created_at := authorized_at - INTERVAL '1 millisecond';
    operation_material_sha := hxos_payment_capture_operation_sha256_v7(
      stale_capture_id, capture_authority_id, work_order.lifecycle_id,
      work_order.work_order_id, work_order.financial_security_event_id,
      work_order.processor_code, fse.amount_cents, fse.currency,
      completion_material_sha, amount_approval_sha, incident_clearance_sha,
      stale_operation_id, 'hx-capture-v7:' || stale_operation_id::TEXT, request_sha,
      capture_created_at, expires_at
    );
    INSERT INTO payment_captures_v7(
      capture_id, lifecycle_id, work_order_id, financial_security_event_id, processor_code,
      approved_amount_cents, currency, completion_evidence_sha256,
      amount_approval_sha256, incident_clearance_sha256, operation_id,
      idempotency_key, request_sha256, capture_authority_id, expires_at,
      operation_material_sha256, created_at
    ) VALUES (
      stale_capture_id, work_order.lifecycle_id, work_order.work_order_id,
      work_order.financial_security_event_id, work_order.processor_code,
      fse.amount_cents, fse.currency, completion_material_sha,
      amount_approval_sha, incident_clearance_sha, stale_operation_id,
      'hx-capture-v7:' || stale_operation_id::TEXT, request_sha,
      capture_authority_id, expires_at, operation_material_sha,
      capture_created_at
    );
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    stale_operation_rejected := TRUE;
  END;

  capture_created_at := date_trunc('milliseconds', clock_timestamp());
  operation_material_sha := hxos_payment_capture_operation_sha256_v7(
    capture_id, capture_authority_id, work_order.lifecycle_id,
    work_order.work_order_id, work_order.financial_security_event_id,
    work_order.processor_code, fse.amount_cents, fse.currency,
    completion_material_sha, amount_approval_sha, incident_clearance_sha,
    operation_id,
    'hx-capture-v7:' || operation_id::TEXT, request_sha,
    capture_created_at, expires_at
  );
  INSERT INTO payment_captures_v7(
    capture_id, lifecycle_id, work_order_id, financial_security_event_id,
    processor_code, approved_amount_cents, currency,
    completion_evidence_sha256, amount_approval_sha256,
    incident_clearance_sha256, operation_id, idempotency_key,
    request_sha256, capture_authority_id, expires_at,
    operation_material_sha256, created_at
  ) VALUES (
    capture_id, work_order.lifecycle_id, work_order.work_order_id,
    work_order.financial_security_event_id, work_order.processor_code,
    fse.amount_cents, fse.currency, completion_material_sha,
    amount_approval_sha, incident_clearance_sha, operation_id,
    'hx-capture-v7:' || operation_id::TEXT, request_sha,
    capture_authority_id, expires_at, operation_material_sha,
    capture_created_at
  );
  INSERT INTO payment_underwriting_lifecycle_events_v7(
    event_id, lifecycle_id, task_draft_id, sequence_number, prior_event_id,
    command_id, stage, actor_type, evidence_sha256, event_material, event_sha256
  ) VALUES (
    capture_pending_event_id, work_order.lifecycle_id, work_order.task_draft_id,
    latest_event.sequence_number + 3, completion_event_id, operation_id,
    'CAPTURE_PENDING', 'SYSTEM', operation_material_sha,
    jsonb_build_object('schema', 'HX_PAYMENT_D6_CAPTURE_PENDING_EVENT_V7'),
    encode(digest(capture_pending_event_id::TEXT || ':pending', 'sha256'), 'hex')
  );

  api_observed_at := date_trunc('milliseconds', clock_timestamp());
  api_material_sha := hxos_payment_capture_observation_sha256_v7(
    api_observation_id, capture_id, work_order.lifecycle_id, operation_id,
    work_order.processor_code, 'API_RESPONSE', 1, NULL, NULL, NULL,
    provider_operation_sha, 'SUCCEEDED', fse.amount_cents, fse.currency,
    api_observed_at, repeat('9', 64)
  );
  INSERT INTO payment_capture_operation_observations_v7(
    observation_id, capture_id, lifecycle_id, operation_id, processor_code,
    source, sequence_number, provider_operation_reference_sha256,
    provider_state, observed_amount_cents, observed_currency, observed_at,
    provider_response_sha256, observation_material_sha256
  ) VALUES (
    api_observation_id, capture_id, work_order.lifecycle_id, operation_id,
    work_order.processor_code, 'API_RESPONSE', 1, provider_operation_sha,
    'SUCCEEDED', fse.amount_cents, fse.currency, api_observed_at,
    repeat('9', 64), api_material_sha
  );

  BEGIN
    regressed_material_sha := hxos_payment_capture_observation_sha256_v7(
      regressed_observation_id, capture_id, work_order.lifecycle_id, operation_id,
      work_order.processor_code, 'API_RESPONSE', 2, api_observation_id, NULL,
      NULL, provider_operation_sha, 'SUCCEEDED', fse.amount_cents,
      fse.currency, api_observed_at - INTERVAL '1 millisecond', repeat('a', 64)
    );
    INSERT INTO payment_capture_operation_observations_v7(
      observation_id, capture_id, lifecycle_id, operation_id, processor_code,
      source, sequence_number, prior_observation_id,
      provider_operation_reference_sha256, provider_state,
      observed_amount_cents, observed_currency, observed_at,
      provider_response_sha256, observation_material_sha256
    ) VALUES (
      regressed_observation_id, capture_id, work_order.lifecycle_id, operation_id,
      work_order.processor_code, 'API_RESPONSE', 2, api_observation_id,
      provider_operation_sha, 'SUCCEEDED', fse.amount_cents, fse.currency,
      api_observed_at - INTERVAL '1 millisecond', repeat('a', 64),
      regressed_material_sha
    );
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    regressed_observation_rejected := TRUE;
  END;

  wrong_event_sha := encode(digest(wrong_webhook_inbox_id::TEXT || ':event', 'sha256'), 'hex');
  INSERT INTO payment_webhook_inbox_v7(
    webhook_inbox_id, processor_code, event_id_sha256, payload_sha256,
    authentication_state, normalized_event_type, processing_state,
    received_at, authentication_evidence_sha256, signature_verified_at
  ) VALUES (
    wrong_webhook_inbox_id, work_order.processor_code, wrong_event_sha,
    repeat('b', 64), 'VERIFIED', 'CAPTURE_SUCCEEDED', 'NORMALIZED',
    clock_timestamp(), repeat('c', 64), clock_timestamp()
  );
  BEGIN
    wrong_webhook_material_sha := hxos_payment_capture_observation_sha256_v7(
      wrong_webhook_observation_id, capture_id, work_order.lifecycle_id,
      operation_id, work_order.processor_code, 'WEBHOOK', 1, NULL,
      wrong_webhook_inbox_id, repeat('d', 64), provider_operation_sha,
      'SUCCEEDED', fse.amount_cents, fse.currency, clock_timestamp(),
      repeat('e', 64)
    );
    INSERT INTO payment_capture_operation_observations_v7(
      observation_id, capture_id, lifecycle_id, operation_id, processor_code,
      source, sequence_number, webhook_inbox_id, provider_event_id_sha256,
      provider_operation_reference_sha256, provider_state,
      observed_amount_cents, observed_currency, observed_at,
      provider_response_sha256, observation_material_sha256
    ) VALUES (
      wrong_webhook_observation_id, capture_id, work_order.lifecycle_id,
      operation_id, work_order.processor_code, 'WEBHOOK', 1,
      wrong_webhook_inbox_id, repeat('d', 64), provider_operation_sha,
      'SUCCEEDED', fse.amount_cents, fse.currency, clock_timestamp(),
      repeat('e', 64), wrong_webhook_material_sha
    );
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    webhook_hash_rejected := TRUE;
  END;

  webhook_event_sha := encode(digest(webhook_inbox_id::TEXT || ':event', 'sha256'), 'hex');
  INSERT INTO payment_webhook_inbox_v7(
    webhook_inbox_id, processor_code, event_id_sha256, payload_sha256,
    authentication_state, normalized_event_type, processing_state,
    received_at, authentication_evidence_sha256, signature_verified_at
  ) VALUES (
    webhook_inbox_id, work_order.processor_code, webhook_event_sha,
    repeat('f', 64), 'VERIFIED', 'CAPTURE_SUCCEEDED', 'NORMALIZED',
    clock_timestamp(), repeat('0', 64), clock_timestamp()
  );
  webhook_observed_at := date_trunc('milliseconds', clock_timestamp());
  webhook_material_sha := hxos_payment_capture_observation_sha256_v7(
    webhook_observation_id, capture_id, work_order.lifecycle_id, operation_id,
    work_order.processor_code, 'WEBHOOK', 1, NULL, webhook_inbox_id,
    webhook_event_sha, provider_operation_sha, 'SUCCEEDED', fse.amount_cents,
    fse.currency, webhook_observed_at, repeat('1', 64)
  );
  INSERT INTO payment_capture_operation_observations_v7(
    observation_id, capture_id, lifecycle_id, operation_id, processor_code,
    source, sequence_number, webhook_inbox_id, provider_event_id_sha256,
    provider_operation_reference_sha256, provider_state,
    observed_amount_cents, observed_currency, observed_at,
    provider_response_sha256, observation_material_sha256
  ) VALUES (
    webhook_observation_id, capture_id, work_order.lifecycle_id, operation_id,
    work_order.processor_code, 'WEBHOOK', 1, webhook_inbox_id,
    webhook_event_sha, provider_operation_sha, 'SUCCEEDED', fse.amount_cents,
    fse.currency, webhook_observed_at, repeat('1', 64), webhook_material_sha
  );
  SELECT status.agreement_sha256 INTO agreement_sha
    FROM payment_capture_status_v7 status
   WHERE status.capture_id = d6_test.capture_id;
  INSERT INTO payment_underwriting_lifecycle_events_v7(
    event_id, lifecycle_id, task_draft_id, sequence_number, prior_event_id,
    command_id, stage, actor_type, evidence_sha256, event_material, event_sha256
  ) VALUES (
    captured_event_id, work_order.lifecycle_id, work_order.task_draft_id,
    latest_event.sequence_number + 4, capture_pending_event_id, gen_random_uuid(),
    'CAPTURED', 'SYSTEM', agreement_sha,
    jsonb_build_object('schema', 'HX_PAYMENT_D6_CAPTURED_EVENT_V7'),
    encode(digest(captured_event_id::TEXT || ':captured', 'sha256'), 'hex')
  );

  IF NOT missing_notice_rejected
     OR NOT amount_mismatch_rejected
     OR NOT expired_authority_rejected
     OR NOT stale_operation_rejected
     OR NOT crossed_capture_evidence_rejected
     OR NOT regressed_observation_rejected
     OR NOT webhook_hash_rejected THEN
    RAISE EXCEPTION 'D6 negative invariant failure: %', jsonb_build_object(
      'missingNotice', missing_notice_rejected,
      'amountMismatch', amount_mismatch_rejected,
      'expiredAuthority', expired_authority_rejected,
      'staleOperation', stale_operation_rejected,
      'crossedCaptureEvidence', crossed_capture_evidence_rejected,
      'regressedObservation', regressed_observation_rejected,
      'webhookHash', webhook_hash_rejected
    );
  END IF;
END;
$$;

SET CONSTRAINTS ALL IMMEDIATE;

DO $$
DECLARE
  lifecycle_stage TEXT;
  agreement_state TEXT;
  counts BIGINT[];
BEGIN
  SELECT stage INTO lifecycle_stage FROM payment_underwriting_lifecycle_status_v7
   WHERE lifecycle_id = (SELECT lifecycle_id FROM payment_captures_v7 LIMIT 1);
  SELECT status.agreement_state INTO agreement_state
    FROM payment_capture_status_v7 status LIMIT 1;
  SELECT ARRAY[
    (SELECT count(*) FROM payment_completion_evidence_v7),
    (SELECT count(*) FROM payment_completion_approvals_v7),
    (SELECT count(*) FROM payment_capture_authorities_v7),
    (SELECT count(*) FROM payment_captures_v7),
    (SELECT count(*) FROM payment_capture_operation_observations_v7)
  ] INTO counts;
  IF lifecycle_stage IS DISTINCT FROM 'CAPTURED'
     OR agreement_state IS DISTINCT FROM 'AGREED'
     OR counts IS DISTINCT FROM ARRAY[1, 1, 1, 1, 2]::BIGINT[] THEN
    RAISE EXCEPTION 'D6 valid path mismatch: %', jsonb_build_object(
      'stage', lifecycle_stage, 'agreement', agreement_state, 'counts', counts
    );
  END IF;
END;
$$;

\ir ../../database/migrations/20260824_payment_underwriting_completion_capture_v7.sql

DO $$
DECLARE counts BIGINT[];
BEGIN
  SELECT ARRAY[
    (SELECT count(*) FROM payment_completion_evidence_v7),
    (SELECT count(*) FROM payment_completion_approvals_v7),
    (SELECT count(*) FROM payment_capture_authorities_v7),
    (SELECT count(*) FROM payment_captures_v7),
    (SELECT count(*) FROM payment_capture_operation_observations_v7)
  ] INTO counts;
  IF counts IS DISTINCT FROM ARRAY[1, 1, 1, 1, 2]::BIGINT[] THEN
    RAISE EXCEPTION 'D6 replay changed evidence: %', counts;
  END IF;
END;
$$;

\if :{?HXP_D7_COMPOSED}
\else
ROLLBACK;
\endif
