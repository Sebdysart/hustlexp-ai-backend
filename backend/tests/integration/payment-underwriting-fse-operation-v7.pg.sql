BEGIN;

DO $$
<<d4_test>>
DECLARE
  poster_id UUID := gen_random_uuid();
  provider_id UUID := gen_random_uuid();
  second_provider_id UUID := gen_random_uuid();
  draft_id UUID := gen_random_uuid();
  lifecycle_id UUID := gen_random_uuid();
  opportunity_id UUID := gen_random_uuid();
  preview_id UUID := gen_random_uuid();
  link_id UUID := gen_random_uuid();
  interest_id UUID := gen_random_uuid();
  provider_ref_id UUID := gen_random_uuid();
  payment_method_ref_id UUID := gen_random_uuid();
  revalidation_id UUID := gen_random_uuid();
  hold_id UUID := gen_random_uuid();
  authority_id UUID := gen_random_uuid();
  overlong_authority_id UUID := gen_random_uuid();
  fse_id UUID := gen_random_uuid();
  operation_id UUID := gen_random_uuid();
  second_fse_id UUID := gen_random_uuid();
  second_operation_id UUID := gen_random_uuid();
  api_observation_id UUID := gen_random_uuid();
  expired_hold_observation_id UUID := gen_random_uuid();
  bad_webhook_observation_id UUID := gen_random_uuid();
  good_webhook_observation_id UUID := gen_random_uuid();
  bad_webhook_inbox_id UUID := gen_random_uuid();
  wrong_type_webhook_inbox_id UUID := gen_random_uuid();
  wrong_type_webhook_observation_id UUID := gen_random_uuid();
  conflicting_webhook_inbox_id UUID := gen_random_uuid();
  good_webhook_inbox_id UUID := gen_random_uuid();
  previous_event_id UUID;
  next_event_id UUID;
  initial_hold_event_id UUID;
  conflicting_webhook_observation_id UUID := gen_random_uuid();
  preview_sha TEXT;
  link_material_sha TEXT;
  link_signature_sha TEXT;
  authority_sha TEXT;
  overlong_authority_sha TEXT;
  operation_material_sha TEXT;
  api_material_sha TEXT;
  expired_hold_observation_material_sha TEXT;
  bad_webhook_material_sha TEXT;
  conflicting_webhook_material_sha TEXT;
  good_webhook_material_sha TEXT;
  provider_operation_sha TEXT := repeat('a', 64);
  merchant_context_sha TEXT := repeat('b', 64);
  fee_routing_sha TEXT := repeat('c', 64);
  request_sha TEXT := repeat('d', 64);
  provider_expires_at TIMESTAMPTZ := clock_timestamp() + INTERVAL '7 minutes';
  preview_start_at TIMESTAMPTZ;
  preview_end_at TIMESTAMPTZ;
  key_valid_from TIMESTAMPTZ;
  key_valid_until TIMESTAMPTZ;
  authority_approved_at TIMESTAMPTZ;
  authority_expires_at TIMESTAMPTZ;
  overlong_authority_expires_at TIMESTAMPTZ;
  fse_expires_at TIMESTAMPTZ;
  hold_accepted_at TIMESTAMPTZ := clock_timestamp();
  hold_expires_at TIMESTAMPTZ := clock_timestamp() + INTERVAL '10 minutes';
  observed_at TIMESTAMPTZ;
  link_verified_at TIMESTAMPTZ;
  link_expires_at TIMESTAMPTZ;
  sequence_number INTEGER := 0;
  stage_name TEXT;
  authority_actor_rejected BOOLEAN := FALSE;
  overlong_authority_rejected BOOLEAN := FALSE;
  expired_hold_rejected BOOLEAN := FALSE;
  wrong_idempotency_rejected BOOLEAN := FALSE;
  duplicate_fse_rejected BOOLEAN := FALSE;
  premature_secured_rejected BOOLEAN := FALSE;
  unauthenticated_webhook_rejected BOOLEAN := FALSE;
  wrong_webhook_type_rejected BOOLEAN := FALSE;
  conflicting_agreement_rejected BOOLEAN := FALSE;
  duplicate_webhook_rejected BOOLEAN := FALSE;
  premature_consumed_rejected BOOLEAN := FALSE;
  expired_hold_observation_rejected BOOLEAN := FALSE;
  expired_hold_secured_rejected BOOLEAN := FALSE;
  post_secured_consumption_deferred BOOLEAN := FALSE;
  work_order_deferred BOOLEAN := FALSE;
  authority_update_rejected BOOLEAN := FALSE;
  observation_delete_rejected BOOLEAN := FALSE;
  observation_truncate_rejected BOOLEAN := FALSE;
  agreement_state TEXT;
  provider_state TEXT;
  hold_state TEXT;
  public_relation_privileges INTEGER;
  public_function_privileges INTEGER;
BEGIN
  IF to_regclass('public.payment_financial_security_authorities_v7') IS NULL
     OR to_regclass('public.payment_financial_security_operation_observations_v7') IS NULL
     OR to_regclass('public.payment_financial_security_status_v7') IS NULL THEN
    RAISE EXCEPTION 'D4 catalog is incomplete';
  END IF;

  INSERT INTO users(id, email, full_name, default_mode) VALUES
    (poster_id, 'd4-poster-' || poster_id || '@example.invalid', 'D4 Poster', 'poster'),
    (provider_id, 'd4-provider-' || provider_id || '@example.invalid', 'D4 Provider', 'worker'),
    (second_provider_id, 'd4-second-' || second_provider_id || '@example.invalid', 'D4 Second', 'worker');

  INSERT INTO task_drafts(id, submission_id, card_token_hash, raw_input, poster_user_id)
  VALUES (draft_id, gen_random_uuid(), 'd4-' || draft_id, 'D4 source', poster_id);

  INSERT INTO payment_underwriting_lifecycles_v7(
    lifecycle_id, task_draft_id, request_id, pricing_lane,
    authority_document_id, authority_drive_revision,
    authority_docs_revision, authority_text_sha256
  ) VALUES (
    lifecycle_id, draft_id, gen_random_uuid(), 'PLATFORM_PRICED',
    '1PYpWdbnlhRBoovc6GfTyxMuu1IzMIdDQpV6hHHraXaQ', '7',
    'AIroW37g_sqKNU_dvvRNUndw-qUeooFwAYIHqN60aHvPSR178sKjMMu5rMzGTzODqgDKERue3ZbAT8UesInsUZvT6p1Z0bUvPByrgwaPDA',
    'ba8dc04bfc43feb24bd78698c6e5b820ecdf22177f915fb04856a55d8076bd26'
  );

  FOREACH stage_name IN ARRAY ARRAY[
    'TASK_DRAFT', 'SCOPE_READY', 'QUOTED', 'QUOTE_APPROVED',
    'PAYMENT_METHOD_READY', 'PROVIDER_SOURCING'
  ] LOOP
    sequence_number := sequence_number + 1;
    next_event_id := gen_random_uuid();
    INSERT INTO payment_underwriting_lifecycle_events_v7(
      event_id, lifecycle_id, task_draft_id, sequence_number, prior_event_id,
      command_id, stage, actor_type, evidence_sha256, event_material, event_sha256
    ) VALUES (
      next_event_id, lifecycle_id, draft_id, sequence_number, previous_event_id,
      gen_random_uuid(), stage_name, 'SYSTEM',
      encode(digest('d4-evidence-' || sequence_number, 'sha256'), 'hex'),
      jsonb_build_object('schema', 'HX_PAYMENT_D4_TEST_LIFECYCLE_EVENT_V7'),
      encode(digest(lifecycle_id::TEXT || ':event:' || sequence_number, 'sha256'), 'hex')
    );
    previous_event_id := next_event_id;
  END LOOP;

  preview_start_at := clock_timestamp() + INTERVAL '1 day';
  preview_end_at := preview_start_at + INTERVAL '2 hours';
  preview_sha := hxos_payment_opportunity_preview_sha256_v7(
    'YARD_WORK', 'US-WA-SEA-NORTH',
    preview_start_at, preview_end_at,
    repeat('1', 64), repeat('2', 64), 'PLATFORM_PRICED', 9000, 11000, 'usd'
  );
  INSERT INTO payment_task_opportunities_v7(
    opportunity_id, lifecycle_id, scope_sha256, economics_corridor_sha256,
    preview_sha256, state, expires_at, evidence_sha256
  ) VALUES (
    opportunity_id, lifecycle_id, repeat('3', 64), repeat('4', 64),
    preview_sha, 'OPEN', clock_timestamp() + INTERVAL '1 hour', repeat('5', 64)
  );
  INSERT INTO payment_task_opportunity_previews_v7(
    preview_id, opportunity_id, category_code, general_area_code,
    schedule_window_start, schedule_window_end, scope_summary_sha256,
    requirements_sha256, pricing_lane, gross_earnings_min_cents,
    gross_earnings_max_cents, currency, preview_sha256, redaction_evidence_sha256
  ) VALUES (
    preview_id, opportunity_id, 'YARD_WORK', 'US-WA-SEA-NORTH',
    preview_start_at, preview_end_at,
    repeat('1', 64), repeat('2', 64), 'PLATFORM_PRICED', 9000, 11000,
    'usd', preview_sha, repeat('6', 64)
  );

  PERFORM set_config('hxp.opportunity_link_signing_secret', 'd4-test-signing-secret-with-32-bytes', true);
  key_valid_from := clock_timestamp() - INTERVAL '1 minute';
  key_valid_until := clock_timestamp() + INTERVAL '1 day';
  INSERT INTO payment_opportunity_signing_keys_v7(
    signature_key_id, algorithm, secret_sha256, state,
    valid_from, valid_until, authority_sha256
  ) VALUES (
    'd4-key', 'HMAC_SHA256',
    encode(digest('d4-test-signing-secret-with-32-bytes', 'sha256'), 'hex'),
    'ACTIVE', key_valid_from, key_valid_until,
    hxos_payment_opportunity_signing_key_authority_sha256_v7(
      'd4-key', 'HMAC_SHA256',
      encode(digest('d4-test-signing-secret-with-32-bytes', 'sha256'), 'hex'),
      key_valid_from, key_valid_until
    )
  );
  link_verified_at := clock_timestamp();
  link_expires_at := clock_timestamp() + INTERVAL '30 minutes';
  link_material_sha := hxos_payment_opportunity_link_material_sha256_v7(
    link_id, opportunity_id, preview_sha, repeat('7', 64), 'OPEN_SHARE', NULL,
    link_expires_at, 'd4-key'
  );
  link_signature_sha := hxos_payment_opportunity_link_signature_sha256_v7(link_material_sha);
  INSERT INTO payment_task_opportunity_links_v7(
    opportunity_link_id, opportunity_id, token_sha256, link_kind,
    link_material_sha256, signature_sha256, signature_key_id,
    signature_verified_at, signature_verification_sha256,
    expires_at, evidence_sha256
  ) VALUES (
    link_id, opportunity_id, repeat('7', 64), 'OPEN_SHARE',
    link_material_sha, link_signature_sha, 'd4-key', link_verified_at,
    hxos_payment_opportunity_link_verification_sha256_v7(
      link_material_sha, link_signature_sha, 'd4-key', link_verified_at
    ), link_expires_at, repeat('8', 64)
  );
  INSERT INTO payment_task_opportunity_interests_v7(
    interest_id, opportunity_id, opportunity_link_id, provider_user_id,
    interest_kind, availability_start, availability_end,
    acknowledged_scope_sha256, acknowledged_economics_sha256,
    interest_material_sha256, evidence_sha256
  ) VALUES (
    interest_id, opportunity_id, link_id, provider_id, 'EXPRESS_INTEREST',
    clock_timestamp(), clock_timestamp() + INTERVAL '1 day',
    repeat('3', 64), repeat('4', 64), repeat('9', 64), repeat('a', 64)
  );

  INSERT INTO payment_provider_account_refs_v7(
    provider_account_ref_id, provider_user_id, processor_code,
    external_reference_sha256, eligibility_state, merchant_capabilities,
    funding_state, restrictions_sha256, bank_reference_sha256,
    evidence_sha256, observed_at, expires_at
  ) VALUES (
    provider_ref_id, provider_id, 'CANDIDATE_SANDBOX', repeat('b', 64), 'ELIGIBLE',
    '{"paymentEligible":true,"merchantContextApproved":true,"blockingRestrictions":false}',
    'READY', repeat('c', 64), repeat('d', 64), repeat('e', 64),
    clock_timestamp(), clock_timestamp() + INTERVAL '30 minutes'
  );
  INSERT INTO payment_method_refs_v7(
    payment_method_ref_id, customer_user_id, processor_code,
    external_reference_sha256, safe_metadata, consent_sha256,
    portability_scope, state
  ) VALUES (
    payment_method_ref_id, poster_id, 'CANDIDATE_SANDBOX', repeat('f', 64),
    '{"brand":"test","last4":"4242"}', repeat('0', 64),
    'SAME_MERCHANT_CONTEXT', 'READY'
  );

  sequence_number := sequence_number + 1;
  next_event_id := gen_random_uuid();
  INSERT INTO payment_underwriting_lifecycle_events_v7(
    event_id, lifecycle_id, task_draft_id, sequence_number, prior_event_id,
    command_id, stage, actor_type, evidence_sha256, event_material, event_sha256
  ) VALUES (
    next_event_id, lifecycle_id, draft_id, sequence_number, previous_event_id,
    gen_random_uuid(), 'PAYMENT_ELIGIBLE', 'SYSTEM', repeat('1', 64),
    '{"schema":"HX_PAYMENT_D4_TEST_ELIGIBLE_V7"}', repeat('2', 64)
  );
  previous_event_id := next_event_id;

  INSERT INTO payment_task_revalidations_v7(
    revalidation_id, lifecycle_id, opportunity_id, interest_id,
    provider_account_ref_id, provider_user_id, scope_sha256, economics_sha256,
    schedule_sha256, task_open, quote_current, schedule_valid,
    customer_proceeding, provider_available, scope_accepted, economics_accepted,
    category_eligible, credentials_eligible, trust_eligible, availability_eligible,
    observed_at, valid_until, evidence_sha256
  ) VALUES (
    revalidation_id, lifecycle_id, opportunity_id, interest_id,
    provider_ref_id, provider_id, repeat('3', 64), repeat('4', 64), repeat('5', 64),
    true, true, true, true, true, true, true, true, true, true, true,
    clock_timestamp(), clock_timestamp() + INTERVAL '4 minutes', repeat('6', 64)
  );
  INSERT INTO payment_conditional_provider_holds_v7(
    hold_id, lifecycle_id, opportunity_id, provider_account_ref_id,
    provider_user_id, interest_id, revalidation_id, scope_sha256,
    provider_economics_sha256, schedule_sha256, state,
    accepted_at, expires_at, evidence_sha256
  ) VALUES (
    hold_id, lifecycle_id, opportunity_id, provider_ref_id,
    provider_id, interest_id, revalidation_id, repeat('3', 64),
    repeat('4', 64), repeat('5', 64), 'SOFT_RESERVED',
    hold_accepted_at, hold_expires_at, repeat('7', 64)
  );
  SELECT event_id INTO initial_hold_event_id
    FROM payment_conditional_provider_hold_events_v7
   WHERE payment_conditional_provider_hold_events_v7.hold_id = d4_test.hold_id
     AND payment_conditional_provider_hold_events_v7.sequence_number = 1;

  sequence_number := sequence_number + 1;
  next_event_id := gen_random_uuid();
  INSERT INTO payment_underwriting_lifecycle_events_v7(
    event_id, lifecycle_id, task_draft_id, sequence_number, prior_event_id,
    command_id, stage, actor_type, evidence_sha256, event_material, event_sha256
  ) VALUES (
    next_event_id, lifecycle_id, draft_id, sequence_number, previous_event_id,
    gen_random_uuid(), 'PROVIDER_SOFT_RESERVED', 'SYSTEM', repeat('8', 64),
    '{"schema":"HX_PAYMENT_D4_TEST_SOFT_RESERVED_V7"}', repeat('9', 64)
  );
  previous_event_id := next_event_id;

  authority_approved_at := clock_timestamp();
  authority_expires_at := clock_timestamp() + INTERVAL '9 minutes';
  overlong_authority_expires_at := hold_expires_at + INTERVAL '1 minute';
  fse_expires_at := clock_timestamp() + INTERVAL '8 minutes';
  authority_sha := hxos_payment_fse_authority_sha256_v7(
    authority_id, lifecycle_id, draft_id, poster_id, hold_id, provider_ref_id,
    payment_method_ref_id, 'CANDIDATE_SANDBOX', merchant_context_sha, 10000,
    'usd', fee_routing_sha, repeat('e', 64), authority_approved_at, authority_expires_at
  );
  overlong_authority_sha := hxos_payment_fse_authority_sha256_v7(
    overlong_authority_id, lifecycle_id, draft_id, poster_id, hold_id, provider_ref_id,
    payment_method_ref_id, 'CANDIDATE_SANDBOX', merchant_context_sha, 10000,
    'usd', fee_routing_sha, repeat('e', 64), authority_approved_at,
    overlong_authority_expires_at
  );
  BEGIN
    INSERT INTO payment_financial_security_authorities_v7(
      payment_financial_security_authority_id, lifecycle_id, task_draft_id,
      customer_user_id, approved_by_user_id, hold_id, provider_account_ref_id,
      payment_method_ref_id, processor_code, merchant_context_sha256,
      amount_cents, currency, fee_routing_sha256, consent_sha256,
      approved_at, expires_at, authority_sha256
    ) VALUES (
      overlong_authority_id, lifecycle_id, draft_id, poster_id, poster_id,
      hold_id, provider_ref_id, payment_method_ref_id, 'CANDIDATE_SANDBOX',
      merchant_context_sha, 10000, 'usd', fee_routing_sha, repeat('e', 64),
      authority_approved_at, overlong_authority_expires_at, overlong_authority_sha
    );
    RAISE EXCEPTION 'D4_TEST_ACCEPTED_AUTHORITY_BEYOND_HOLD' USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN overlong_authority_rejected := TRUE;
    WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  BEGIN
    INSERT INTO payment_financial_security_authorities_v7(
      payment_financial_security_authority_id, lifecycle_id, task_draft_id,
      customer_user_id, approved_by_user_id, hold_id, provider_account_ref_id,
      payment_method_ref_id, processor_code, merchant_context_sha256,
      amount_cents, currency, fee_routing_sha256, consent_sha256,
      approved_at, expires_at, authority_sha256
    ) VALUES (
      gen_random_uuid(), lifecycle_id, draft_id, poster_id, second_provider_id,
      hold_id, provider_ref_id, payment_method_ref_id, 'CANDIDATE_SANDBOX',
      merchant_context_sha, 10000, 'usd', fee_routing_sha, repeat('e', 64),
      authority_approved_at, authority_expires_at, repeat('f', 64)
    );
    RAISE EXCEPTION 'D4_TEST_ACCEPTED_WRONG_CUSTOMER_AUTHORITY' USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN check_violation OR foreign_key_violation OR SQLSTATE 'P0001' THEN
      authority_actor_rejected := TRUE;
    WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  INSERT INTO payment_financial_security_authorities_v7(
    payment_financial_security_authority_id, lifecycle_id, task_draft_id,
    customer_user_id, approved_by_user_id, hold_id, provider_account_ref_id,
    payment_method_ref_id, processor_code, merchant_context_sha256,
    amount_cents, currency, fee_routing_sha256, consent_sha256,
    approved_at, expires_at, authority_sha256
  ) VALUES (
    authority_id, lifecycle_id, draft_id, poster_id, poster_id,
    hold_id, provider_ref_id, payment_method_ref_id, 'CANDIDATE_SANDBOX',
    merchant_context_sha, 10000, 'usd', fee_routing_sha, repeat('e', 64),
    authority_approved_at, authority_expires_at, authority_sha
  );

  operation_material_sha := hxos_payment_fse_operation_material_sha256_v7(
    fse_id, authority_id, lifecycle_id, draft_id, poster_id, hold_id,
    provider_ref_id, payment_method_ref_id, 'CANDIDATE_SANDBOX',
    merchant_context_sha, 10000, 'usd', fee_routing_sha, operation_id,
    'hx-fse-v7:' || operation_id, request_sha, fse_expires_at
  );

  PERFORM set_config('session_replication_role', 'replica', TRUE);
  UPDATE payment_conditional_provider_holds_v7
     SET accepted_at = clock_timestamp() - INTERVAL '10 minutes',
         expires_at = clock_timestamp() - INTERVAL '1 second'
   WHERE payment_conditional_provider_holds_v7.hold_id = d4_test.hold_id;
  PERFORM set_config('session_replication_role', 'origin', TRUE);
  BEGIN
    INSERT INTO payment_financial_security_events_v7(
      financial_security_event_id, lifecycle_id, task_draft_id, customer_user_id,
      hold_id, provider_account_ref_id, payment_method_ref_id, processor_code,
      merchant_context_sha256, amount_cents, currency, fee_routing_sha256,
      operation_id, idempotency_key, state, request_sha256,
      payment_financial_security_authority_id, expires_at, operation_material_sha256
    ) VALUES (
      second_fse_id, lifecycle_id, draft_id, poster_id, hold_id, provider_ref_id,
      payment_method_ref_id, 'CANDIDATE_SANDBOX', merchant_context_sha, 10000,
      'usd', fee_routing_sha, second_operation_id,
      'hx-fse-v7:' || second_operation_id, 'PLANNED', request_sha, authority_id,
      fse_expires_at,
      hxos_payment_fse_operation_material_sha256_v7(
        second_fse_id, authority_id, lifecycle_id, draft_id, poster_id, hold_id,
        provider_ref_id, payment_method_ref_id, 'CANDIDATE_SANDBOX',
        merchant_context_sha, 10000, 'usd', fee_routing_sha, second_operation_id,
        'hx-fse-v7:' || second_operation_id, request_sha, fse_expires_at
      )
    );
    RAISE EXCEPTION 'D4_TEST_ACCEPTED_EXPIRED_HOLD_OPERATION' USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN expired_hold_rejected := TRUE;
    WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  PERFORM set_config('session_replication_role', 'replica', TRUE);
  UPDATE payment_conditional_provider_holds_v7
     SET accepted_at = hold_accepted_at,
         expires_at = hold_expires_at
   WHERE payment_conditional_provider_holds_v7.hold_id = d4_test.hold_id;
  PERFORM set_config('session_replication_role', 'origin', TRUE);

  BEGIN
    INSERT INTO payment_financial_security_events_v7(
      financial_security_event_id, lifecycle_id, task_draft_id, customer_user_id,
      hold_id, provider_account_ref_id, payment_method_ref_id, processor_code,
      merchant_context_sha256, amount_cents, currency, fee_routing_sha256,
      operation_id, idempotency_key, state, request_sha256,
      payment_financial_security_authority_id, expires_at, operation_material_sha256
    ) VALUES (
      fse_id, lifecycle_id, draft_id, poster_id, hold_id, provider_ref_id,
      payment_method_ref_id, 'CANDIDATE_SANDBOX', merchant_context_sha, 10000,
      'usd', fee_routing_sha, operation_id, 'wrong-idempotency-key', 'PLANNED',
      request_sha, authority_id, fse_expires_at, operation_material_sha
    );
    RAISE EXCEPTION 'D4_TEST_ACCEPTED_WRONG_IDEMPOTENCY' USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN wrong_idempotency_rejected := TRUE;
    WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  INSERT INTO payment_financial_security_events_v7(
    financial_security_event_id, lifecycle_id, task_draft_id, customer_user_id,
    hold_id, provider_account_ref_id, payment_method_ref_id, processor_code,
    merchant_context_sha256, amount_cents, currency, fee_routing_sha256,
    operation_id, idempotency_key, state, request_sha256,
    payment_financial_security_authority_id, expires_at, operation_material_sha256
  ) VALUES (
    fse_id, lifecycle_id, draft_id, poster_id, hold_id, provider_ref_id,
    payment_method_ref_id, 'CANDIDATE_SANDBOX', merchant_context_sha, 10000,
    'usd', fee_routing_sha, operation_id, 'hx-fse-v7:' || operation_id, 'PLANNED',
    request_sha, authority_id, fse_expires_at, operation_material_sha
  );

  BEGIN
    INSERT INTO payment_financial_security_events_v7(
      financial_security_event_id, lifecycle_id, task_draft_id, customer_user_id,
      hold_id, provider_account_ref_id, payment_method_ref_id, processor_code,
      merchant_context_sha256, amount_cents, currency, fee_routing_sha256,
      operation_id, idempotency_key, state, request_sha256,
      payment_financial_security_authority_id, expires_at, operation_material_sha256
    ) VALUES (
      second_fse_id, lifecycle_id, draft_id, poster_id, hold_id, provider_ref_id,
      payment_method_ref_id, 'CANDIDATE_SANDBOX', merchant_context_sha, 10000,
      'usd', fee_routing_sha, second_operation_id,
      'hx-fse-v7:' || second_operation_id, 'PLANNED', request_sha, authority_id,
      fse_expires_at,
      hxos_payment_fse_operation_material_sha256_v7(
        second_fse_id, authority_id, lifecycle_id, draft_id, poster_id, hold_id,
        provider_ref_id, payment_method_ref_id, 'CANDIDATE_SANDBOX',
        merchant_context_sha, 10000, 'usd', fee_routing_sha, second_operation_id,
        'hx-fse-v7:' || second_operation_id, request_sha, fse_expires_at
      )
    );
    RAISE EXCEPTION 'D4_TEST_ACCEPTED_DUPLICATE_LIFECYCLE_FSE' USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN unique_violation THEN duplicate_fse_rejected := TRUE;
    WHEN SQLSTATE 'P0099' THEN NULL;
  END;

  sequence_number := sequence_number + 1;
  next_event_id := gen_random_uuid();
  INSERT INTO payment_underwriting_lifecycle_events_v7(
    event_id, lifecycle_id, task_draft_id, sequence_number, prior_event_id,
    command_id, stage, actor_type, evidence_sha256, event_material, event_sha256
  ) VALUES (
    next_event_id, lifecycle_id, draft_id, sequence_number, previous_event_id,
    gen_random_uuid(), 'FINANCIAL_SECURITY_PENDING', 'SYSTEM', operation_material_sha,
    '{"schema":"HX_PAYMENT_D4_TEST_FSE_PENDING_V7"}', repeat('b', 64)
  );
  previous_event_id := next_event_id;

  BEGIN
    INSERT INTO payment_conditional_provider_hold_events_v7(
      hold_id, sequence_number, prior_event_id, event_type,
      actor_type, event_material_sha256, evidence_sha256
    ) VALUES (
      hold_id, 2, initial_hold_event_id, 'CONSUMED',
      'SYSTEM', repeat('c', 64), repeat('d', 64)
    );
    RAISE EXCEPTION 'D4_TEST_ACCEPTED_PREMATURE_CONSUMED' USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN premature_consumed_rejected := TRUE;
    WHEN SQLSTATE 'P0099' THEN NULL;
  END;

  PERFORM set_config('session_replication_role', 'replica', TRUE);
  UPDATE payment_conditional_provider_holds_v7
     SET accepted_at = clock_timestamp() - INTERVAL '10 minutes',
         expires_at = clock_timestamp() - INTERVAL '1 second'
   WHERE payment_conditional_provider_holds_v7.hold_id = d4_test.hold_id;
  PERFORM set_config('session_replication_role', 'origin', TRUE);
  observed_at := clock_timestamp();
  expired_hold_observation_material_sha := hxos_payment_fse_observation_material_sha256_v7(
    expired_hold_observation_id, fse_id, lifecycle_id, operation_id,
    'CANDIDATE_SANDBOX', 'API_RESPONSE', 1, NULL, NULL, NULL,
    provider_operation_sha, 'SUCCEEDED', 10000, 'usd', merchant_context_sha,
    provider_expires_at, observed_at, repeat('6', 64)
  );
  BEGIN
    INSERT INTO payment_financial_security_operation_observations_v7(
      observation_id, financial_security_event_id, lifecycle_id, operation_id,
      processor_code, source, sequence_number,
      provider_operation_reference_sha256, provider_state,
      observed_amount_cents, observed_currency, observed_merchant_context_sha256,
      provider_expires_at, observed_at, provider_response_sha256,
      observation_material_sha256
    ) VALUES (
      expired_hold_observation_id, fse_id, lifecycle_id, operation_id,
      'CANDIDATE_SANDBOX', 'API_RESPONSE', 1, provider_operation_sha, 'SUCCEEDED',
      10000, 'usd', merchant_context_sha, provider_expires_at, observed_at,
      repeat('6', 64), expired_hold_observation_material_sha
    );
    RAISE EXCEPTION 'D4_TEST_ACCEPTED_OBSERVATION_AFTER_HOLD_EXPIRY'
      USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN expired_hold_observation_rejected := TRUE;
    WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  PERFORM set_config('session_replication_role', 'replica', TRUE);
  UPDATE payment_conditional_provider_holds_v7
     SET accepted_at = hold_accepted_at,
         expires_at = hold_expires_at
   WHERE payment_conditional_provider_holds_v7.hold_id = d4_test.hold_id;
  PERFORM set_config('session_replication_role', 'origin', TRUE);

  INSERT INTO payment_webhook_inbox_v7(
    webhook_inbox_id, processor_code, event_id_sha256, payload_sha256,
    authentication_state, normalized_event_type, processing_state,
    received_at, authentication_evidence_sha256, signature_verified_at
  ) VALUES (
    wrong_type_webhook_inbox_id, 'CANDIDATE_SANDBOX', repeat('a', 64), repeat('b', 64),
    'VERIFIED', 'PAYMENT_CAPTURE_SUCCEEDED', 'NORMALIZED',
    clock_timestamp(), repeat('c', 64), clock_timestamp()
  );
  observed_at := clock_timestamp();
  BEGIN
    INSERT INTO payment_financial_security_operation_observations_v7(
      observation_id, financial_security_event_id, lifecycle_id, operation_id,
      processor_code, source, sequence_number, webhook_inbox_id,
      provider_event_id_sha256, provider_operation_reference_sha256,
      provider_state, observed_amount_cents, observed_currency,
      observed_merchant_context_sha256, provider_expires_at, observed_at,
      provider_response_sha256, observation_material_sha256
    ) VALUES (
      wrong_type_webhook_observation_id, fse_id, lifecycle_id, operation_id,
      'CANDIDATE_SANDBOX', 'WEBHOOK', 1, wrong_type_webhook_inbox_id,
      repeat('a', 64), provider_operation_sha, 'SUCCEEDED', 10000, 'usd',
      merchant_context_sha, provider_expires_at, observed_at, repeat('b', 64),
      hxos_payment_fse_observation_material_sha256_v7(
        wrong_type_webhook_observation_id, fse_id, lifecycle_id, operation_id,
        'CANDIDATE_SANDBOX', 'WEBHOOK', 1, NULL, wrong_type_webhook_inbox_id,
        repeat('a', 64), provider_operation_sha, 'SUCCEEDED', 10000, 'usd',
        merchant_context_sha, provider_expires_at, observed_at, repeat('b', 64)
      )
    );
    RAISE EXCEPTION 'D4_TEST_ACCEPTED_WRONG_WEBHOOK_TYPE' USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN wrong_webhook_type_rejected := TRUE;
    WHEN SQLSTATE 'P0099' THEN NULL;
  END;

  observed_at := clock_timestamp();
  api_material_sha := hxos_payment_fse_observation_material_sha256_v7(
    api_observation_id, fse_id, lifecycle_id, operation_id, 'CANDIDATE_SANDBOX',
    'API_RESPONSE', 1, NULL, NULL, NULL, provider_operation_sha, 'SUCCEEDED',
    10000, 'usd', merchant_context_sha, provider_expires_at, observed_at, repeat('1', 64)
  );
  INSERT INTO payment_financial_security_operation_observations_v7(
    observation_id, financial_security_event_id, lifecycle_id, operation_id,
    processor_code, source, sequence_number, provider_operation_reference_sha256,
    provider_state, observed_amount_cents, observed_currency,
    observed_merchant_context_sha256, provider_expires_at, observed_at,
    provider_response_sha256, observation_material_sha256
  ) VALUES (
    api_observation_id, fse_id, lifecycle_id, operation_id, 'CANDIDATE_SANDBOX',
    'API_RESPONSE', 1, provider_operation_sha, 'SUCCEEDED', 10000, 'usd',
    merchant_context_sha, provider_expires_at, observed_at, repeat('1', 64), api_material_sha
  );

  BEGIN
    INSERT INTO payment_underwriting_lifecycle_events_v7(
      event_id, lifecycle_id, task_draft_id, sequence_number, prior_event_id,
      command_id, stage, actor_type, evidence_sha256, event_material, event_sha256
    ) VALUES (
      gen_random_uuid(), lifecycle_id, draft_id, sequence_number + 1, previous_event_id,
      gen_random_uuid(), 'FINANCIALLY_SECURED', 'SYSTEM', repeat('2', 64),
      '{"schema":"HX_PAYMENT_D4_TEST_PREMATURE_SECURED_V7"}', repeat('3', 64)
    );
    RAISE EXCEPTION 'D4_TEST_ACCEPTED_SECURED_WITHOUT_WEBHOOK' USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN premature_secured_rejected := TRUE;
    WHEN SQLSTATE 'P0099' THEN NULL;
  END;

  INSERT INTO payment_webhook_inbox_v7(
    webhook_inbox_id, processor_code, event_id_sha256, payload_sha256,
    authentication_state, normalized_event_type, processing_state,
    received_at, authentication_evidence_sha256, signature_verified_at
  ) VALUES (
    bad_webhook_inbox_id, 'CANDIDATE_SANDBOX', repeat('4', 64), repeat('5', 64),
    'REJECTED', 'FINANCIAL_SECURITY_SUCCEEDED', 'REJECTED',
    clock_timestamp(), repeat('6', 64), clock_timestamp()
  );
  bad_webhook_material_sha := hxos_payment_fse_observation_material_sha256_v7(
    bad_webhook_observation_id, fse_id, lifecycle_id, operation_id,
    'CANDIDATE_SANDBOX', 'WEBHOOK', 1, NULL, bad_webhook_inbox_id,
    repeat('4', 64), provider_operation_sha, 'SUCCEEDED', 10000, 'usd',
    merchant_context_sha, provider_expires_at, clock_timestamp(), repeat('5', 64)
  );
  BEGIN
    INSERT INTO payment_financial_security_operation_observations_v7(
      observation_id, financial_security_event_id, lifecycle_id, operation_id,
      processor_code, source, sequence_number, webhook_inbox_id,
      provider_event_id_sha256, provider_operation_reference_sha256,
      provider_state, observed_amount_cents, observed_currency,
      observed_merchant_context_sha256, provider_expires_at, observed_at,
      provider_response_sha256, observation_material_sha256
    ) VALUES (
      bad_webhook_observation_id, fse_id, lifecycle_id, operation_id,
      'CANDIDATE_SANDBOX', 'WEBHOOK', 1, bad_webhook_inbox_id,
      repeat('4', 64), provider_operation_sha, 'SUCCEEDED', 10000, 'usd',
      merchant_context_sha, provider_expires_at, clock_timestamp(),
      repeat('5', 64), bad_webhook_material_sha
    );
    RAISE EXCEPTION 'D4_TEST_ACCEPTED_UNAUTHENTICATED_WEBHOOK' USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN unauthenticated_webhook_rejected := TRUE;
    WHEN SQLSTATE 'P0099' THEN NULL;
  END;

  INSERT INTO payment_webhook_inbox_v7(
    webhook_inbox_id, processor_code, event_id_sha256, payload_sha256,
    authentication_state, normalized_event_type, processing_state,
    received_at, authentication_evidence_sha256, signature_verified_at
  ) VALUES (
    conflicting_webhook_inbox_id, 'CANDIDATE_SANDBOX', repeat('7', 64), repeat('8', 64),
    'VERIFIED', 'FINANCIAL_SECURITY_SUCCEEDED', 'NORMALIZED',
    clock_timestamp(), repeat('9', 64), clock_timestamp()
  );
  observed_at := clock_timestamp();
  conflicting_webhook_material_sha := hxos_payment_fse_observation_material_sha256_v7(
    conflicting_webhook_observation_id, fse_id, lifecycle_id, operation_id,
    'CANDIDATE_SANDBOX', 'WEBHOOK', 1, NULL, conflicting_webhook_inbox_id,
    repeat('7', 64), repeat('0', 64), 'SUCCEEDED', 10000, 'usd',
    merchant_context_sha, provider_expires_at, observed_at, repeat('8', 64)
  );
  INSERT INTO payment_financial_security_operation_observations_v7(
    observation_id, financial_security_event_id, lifecycle_id, operation_id,
    processor_code, source, sequence_number, webhook_inbox_id,
    provider_event_id_sha256, provider_operation_reference_sha256,
    provider_state, observed_amount_cents, observed_currency,
    observed_merchant_context_sha256, provider_expires_at, observed_at,
    provider_response_sha256, observation_material_sha256
  ) VALUES (
    conflicting_webhook_observation_id, fse_id, lifecycle_id, operation_id,
    'CANDIDATE_SANDBOX', 'WEBHOOK', 1, conflicting_webhook_inbox_id,
    repeat('7', 64), repeat('0', 64), 'SUCCEEDED', 10000, 'usd',
    merchant_context_sha, provider_expires_at, observed_at,
    repeat('8', 64), conflicting_webhook_material_sha
  );
  BEGIN
    INSERT INTO payment_underwriting_lifecycle_events_v7(
      event_id, lifecycle_id, task_draft_id, sequence_number, prior_event_id,
      command_id, stage, actor_type, evidence_sha256, event_material, event_sha256
    ) VALUES (
      gen_random_uuid(), lifecycle_id, draft_id, sequence_number + 1, previous_event_id,
      gen_random_uuid(), 'FINANCIALLY_SECURED', 'SYSTEM', repeat('a', 64),
      '{"schema":"HX_PAYMENT_D4_TEST_CONFLICTING_SECURED_V7"}', repeat('c', 64)
    );
    RAISE EXCEPTION 'D4_TEST_ACCEPTED_CONFLICTING_PROVIDER_EVIDENCE' USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN conflicting_agreement_rejected := TRUE;
    WHEN SQLSTATE 'P0099' THEN NULL;
  END;

  INSERT INTO payment_webhook_inbox_v7(
    webhook_inbox_id, processor_code, event_id_sha256, payload_sha256,
    authentication_state, normalized_event_type, processing_state,
    received_at, authentication_evidence_sha256, signature_verified_at
  ) VALUES (
    good_webhook_inbox_id, 'CANDIDATE_SANDBOX', repeat('d', 64), repeat('e', 64),
    'VERIFIED', 'FINANCIAL_SECURITY_SUCCEEDED', 'NORMALIZED',
    clock_timestamp(), repeat('f', 64), clock_timestamp()
  );
  observed_at := clock_timestamp();
  good_webhook_material_sha := hxos_payment_fse_observation_material_sha256_v7(
    good_webhook_observation_id, fse_id, lifecycle_id, operation_id,
    'CANDIDATE_SANDBOX', 'WEBHOOK', 2, conflicting_webhook_observation_id,
    good_webhook_inbox_id, repeat('d', 64), provider_operation_sha, 'SUCCEEDED',
    10000, 'usd', merchant_context_sha, provider_expires_at, observed_at, repeat('e', 64)
  );
  INSERT INTO payment_financial_security_operation_observations_v7(
    observation_id, financial_security_event_id, lifecycle_id, operation_id,
    processor_code, source, sequence_number, prior_observation_id,
    webhook_inbox_id, provider_event_id_sha256,
    provider_operation_reference_sha256, provider_state,
    observed_amount_cents, observed_currency, observed_merchant_context_sha256,
    provider_expires_at, observed_at, provider_response_sha256,
    observation_material_sha256
  ) VALUES (
    good_webhook_observation_id, fse_id, lifecycle_id, operation_id,
    'CANDIDATE_SANDBOX', 'WEBHOOK', 2, conflicting_webhook_observation_id,
    good_webhook_inbox_id, repeat('d', 64), provider_operation_sha, 'SUCCEEDED',
    10000, 'usd', merchant_context_sha, provider_expires_at, observed_at,
    repeat('e', 64), good_webhook_material_sha
  );

  SELECT payment_financial_security_status_v7.agreement_state,
         payment_financial_security_status_v7.provider_state
    INTO agreement_state, provider_state
    FROM payment_financial_security_status_v7
   WHERE financial_security_event_id = fse_id;
  IF agreement_state IS DISTINCT FROM 'AGREED'
     OR provider_state IS DISTINCT FROM 'SUCCEEDED' THEN
    RAISE EXCEPTION 'D4 exact agreement was not derived: %/%', agreement_state, provider_state;
  END IF;

  PERFORM set_config('session_replication_role', 'replica', TRUE);
  UPDATE payment_conditional_provider_holds_v7
     SET accepted_at = clock_timestamp() - INTERVAL '10 minutes',
         expires_at = clock_timestamp() - INTERVAL '1 second'
   WHERE payment_conditional_provider_holds_v7.hold_id = d4_test.hold_id;
  PERFORM set_config('session_replication_role', 'origin', TRUE);
  BEGIN
    INSERT INTO payment_underwriting_lifecycle_events_v7(
      event_id, lifecycle_id, task_draft_id, sequence_number, prior_event_id,
      command_id, stage, actor_type, evidence_sha256, event_material, event_sha256
    ) VALUES (
      gen_random_uuid(), lifecycle_id, draft_id, sequence_number + 1, previous_event_id,
      gen_random_uuid(), 'FINANCIALLY_SECURED', 'SYSTEM',
      hxos_payment_fse_agreement_sha256_v7(
        fse_id, api_material_sha, good_webhook_material_sha,
        provider_operation_sha, provider_expires_at
      ),
      '{"schema":"HX_PAYMENT_D4_TEST_EXPIRED_HOLD_SECURED_V7"}', repeat('6', 64)
    );
    RAISE EXCEPTION 'D4_TEST_ACCEPTED_SECURED_AFTER_HOLD_EXPIRY' USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN expired_hold_secured_rejected := TRUE;
    WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  PERFORM set_config('session_replication_role', 'replica', TRUE);
  UPDATE payment_conditional_provider_holds_v7
     SET accepted_at = hold_accepted_at,
         expires_at = hold_expires_at
   WHERE payment_conditional_provider_holds_v7.hold_id = d4_test.hold_id;
  PERFORM set_config('session_replication_role', 'origin', TRUE);

  sequence_number := sequence_number + 1;
  next_event_id := gen_random_uuid();
  INSERT INTO payment_underwriting_lifecycle_events_v7(
    event_id, lifecycle_id, task_draft_id, sequence_number, prior_event_id,
    command_id, stage, actor_type, evidence_sha256, event_material, event_sha256
  ) VALUES (
    next_event_id, lifecycle_id, draft_id, sequence_number, previous_event_id,
    gen_random_uuid(), 'FINANCIALLY_SECURED', 'SYSTEM',
    hxos_payment_fse_agreement_sha256_v7(
      fse_id, api_material_sha, good_webhook_material_sha,
      provider_operation_sha, provider_expires_at
    ),
    '{"schema":"HX_PAYMENT_D4_TEST_SECURED_V7"}', repeat('0', 64)
  );
  previous_event_id := next_event_id;

  BEGIN
    INSERT INTO payment_conditional_provider_hold_events_v7(
      hold_id, sequence_number, prior_event_id, event_type,
      actor_type, event_material_sha256, evidence_sha256
    ) VALUES (
      hold_id, 2, initial_hold_event_id, 'CONSUMED',
      'SYSTEM', repeat('1', 64), repeat('2', 64)
    );
    RAISE EXCEPTION 'D4_TEST_CONSUMED_HOLD_BEFORE_D5' USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN post_secured_consumption_deferred := TRUE;
    WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  SELECT state INTO hold_state FROM payment_conditional_provider_hold_status_v7
   WHERE payment_conditional_provider_hold_status_v7.hold_id = d4_test.hold_id;
  IF hold_state IS DISTINCT FROM 'SOFT_RESERVED' THEN
    RAISE EXCEPTION 'D4 consumed the hold before D5: %', hold_state;
  END IF;

  BEGIN
    INSERT INTO payment_underwriting_lifecycle_events_v7(
      event_id, lifecycle_id, task_draft_id, sequence_number, prior_event_id,
      command_id, stage, actor_type, evidence_sha256, event_material, event_sha256
    ) VALUES (
      gen_random_uuid(), lifecycle_id, draft_id, sequence_number + 1, previous_event_id,
      gen_random_uuid(), 'WORK_ORDER_MATERIALIZED', 'SYSTEM', repeat('3', 64),
      '{"schema":"HX_PAYMENT_D4_TEST_WORK_ORDER_V7"}', repeat('4', 64)
    );
    RAISE EXCEPTION 'D4_TEST_ACCEPTED_D5_WORK_ORDER' USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN work_order_deferred := TRUE;
    WHEN SQLSTATE 'P0099' THEN NULL;
  END;

  BEGIN
    INSERT INTO payment_webhook_inbox_v7(
      processor_code, event_id_sha256, payload_sha256, authentication_state,
      normalized_event_type, processing_state, received_at,
      authentication_evidence_sha256, signature_verified_at
    ) VALUES (
      'CANDIDATE_SANDBOX', repeat('d', 64), repeat('e', 64), 'VERIFIED',
      'FINANCIAL_SECURITY_SUCCEEDED', 'NORMALIZED', clock_timestamp(),
      repeat('f', 64), clock_timestamp()
    );
    RAISE EXCEPTION 'D4_TEST_ACCEPTED_DUPLICATE_WEBHOOK' USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN unique_violation THEN duplicate_webhook_rejected := TRUE;
    WHEN SQLSTATE 'P0099' THEN NULL;
  END;

  BEGIN
    UPDATE payment_financial_security_authorities_v7 SET consent_sha256 = repeat('9', 64)
     WHERE payment_financial_security_authority_id = authority_id;
    RAISE EXCEPTION 'D4_TEST_UPDATED_AUTHORITY' USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN authority_update_rejected := TRUE;
    WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  BEGIN
    DELETE FROM payment_financial_security_operation_observations_v7
     WHERE observation_id = api_observation_id;
    RAISE EXCEPTION 'D4_TEST_DELETED_OBSERVATION' USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN observation_delete_rejected := TRUE;
    WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  BEGIN
    TRUNCATE payment_financial_security_operation_observations_v7;
    RAISE EXCEPTION 'D4_TEST_TRUNCATED_OBSERVATIONS' USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN observation_truncate_rejected := TRUE;
    WHEN SQLSTATE 'P0099' THEN NULL;
  END;

  SELECT count(*) INTO public_relation_privileges
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl
   WHERE n.nspname = 'public'
     AND c.relname IN (
       'payment_financial_security_authorities_v7',
       'payment_financial_security_operation_observations_v7',
       'payment_financial_security_status_v7'
     )
     AND acl.grantee = 0
     AND acl.privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE');
  SELECT count(*) INTO public_function_privileges
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
   WHERE n.nspname = 'public'
     AND p.proname LIKE 'hxos_payment_fse_%'
     AND acl.grantee = 0
     AND acl.privilege_type = 'EXECUTE';

  IF NOT authority_actor_rejected
     OR NOT overlong_authority_rejected
     OR NOT expired_hold_rejected
     OR NOT wrong_idempotency_rejected
     OR NOT duplicate_fse_rejected
     OR NOT premature_secured_rejected
     OR NOT unauthenticated_webhook_rejected
     OR NOT wrong_webhook_type_rejected
     OR NOT conflicting_agreement_rejected
     OR NOT duplicate_webhook_rejected
     OR NOT premature_consumed_rejected
     OR NOT expired_hold_observation_rejected
     OR NOT expired_hold_secured_rejected
     OR NOT post_secured_consumption_deferred
     OR NOT work_order_deferred
     OR NOT authority_update_rejected
     OR NOT observation_delete_rejected
     OR NOT observation_truncate_rejected
     OR public_relation_privileges <> 0
     OR public_function_privileges <> 0 THEN
    RAISE EXCEPTION 'D4 invariant failure: %', jsonb_build_object(
      'authorityActor', authority_actor_rejected,
      'overlongAuthority', overlong_authority_rejected,
      'expiredHold', expired_hold_rejected,
      'idempotency', wrong_idempotency_rejected,
      'duplicateFse', duplicate_fse_rejected,
      'prematureSecured', premature_secured_rejected,
      'unauthenticatedWebhook', unauthenticated_webhook_rejected,
      'wrongWebhookType', wrong_webhook_type_rejected,
      'conflictingAgreement', conflicting_agreement_rejected,
      'duplicateWebhook', duplicate_webhook_rejected,
      'prematureConsumed', premature_consumed_rejected,
      'expiredHoldObservation', expired_hold_observation_rejected,
      'expiredHoldSecured', expired_hold_secured_rejected,
      'postSecuredConsumptionDeferred', post_secured_consumption_deferred,
      'workOrderDeferred', work_order_deferred,
      'authorityUpdate', authority_update_rejected,
      'observationDelete', observation_delete_rejected,
      'observationTruncate', observation_truncate_rejected,
      'publicRelations', public_relation_privileges,
      'publicFunctions', public_function_privileges
    );
  END IF;
END;
$$;

\ir ../../database/migrations/20260822_payment_underwriting_fse_operation_v7.sql

DO $$
DECLARE
  authority_count BIGINT;
  fse_count BIGINT;
  observation_count BIGINT;
  webhook_count BIGINT;
BEGIN
  SELECT count(*) INTO authority_count FROM payment_financial_security_authorities_v7;
  SELECT count(*) INTO fse_count FROM payment_financial_security_events_v7;
  SELECT count(*) INTO observation_count
    FROM payment_financial_security_operation_observations_v7;
  SELECT count(*) INTO webhook_count FROM payment_webhook_inbox_v7;
  IF authority_count <> 1
     OR fse_count <> 1
     OR observation_count <> 3
     OR webhook_count <> 4 THEN
    RAISE EXCEPTION 'D4 populated replay changed evidence: %', jsonb_build_object(
      'authorities', authority_count,
      'financialSecurityEvents', fse_count,
      'observations', observation_count,
      'webhooks', webhook_count
    );
  END IF;
END;
$$;

ROLLBACK;
