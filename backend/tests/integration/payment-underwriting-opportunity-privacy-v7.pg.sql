BEGIN;

DO $$
DECLARE
  poster_id UUID := gen_random_uuid();
  provider_id UUID := gen_random_uuid();
  second_provider_id UUID := gen_random_uuid();
  admin_id UUID := gen_random_uuid();
  draft_id UUID := gen_random_uuid();
  lifecycle_id UUID := gen_random_uuid();
  opportunity_id UUID := gen_random_uuid();
  no_preview_opportunity_id UUID := gen_random_uuid();
  no_preview_link_id UUID := gen_random_uuid();
  forged_link_id UUID := gen_random_uuid();
  post_sourcing_link_id UUID := gen_random_uuid();
  preview_id UUID := gen_random_uuid();
  link_id UUID := gen_random_uuid();
  admin_link_id UUID := gen_random_uuid();
  direct_link_id UUID := gen_random_uuid();
  admin_authority_id UUID := gen_random_uuid();
  forged_admin_authority_id UUID := gen_random_uuid();
  fixture_interest_id UUID := gen_random_uuid();
  provider_account_ref_id UUID := gen_random_uuid();
  stale_provider_account_ref_id UUID := gen_random_uuid();
  expired_provider_account_ref_id UUID := gen_random_uuid();
  short_provider_account_ref_id UUID := gen_random_uuid();
  short_revalidation_id UUID := gen_random_uuid();
  revalidation_id UUID := gen_random_uuid();
  fixture_hold_id UUID := gen_random_uuid();
  initial_hold_event_id UUID;
  previous_event_id UUID;
  next_event_id UUID;
  preview_sha256 TEXT;
  link_material_sha256 TEXT;
  link_signature_sha256 TEXT;
  link_verified_at TIMESTAMPTZ;
  link_expires_at TIMESTAMPTZ;
  key_valid_from TIMESTAMPTZ;
  key_valid_until TIMESTAMPTZ;
  admin_valid_from TIMESTAMPTZ;
  admin_valid_until TIMESTAMPTZ;
  lifecycle_stages TEXT[] := ARRAY[
    'TASK_DRAFT', 'SCOPE_READY', 'QUOTED', 'QUOTE_APPROVED',
    'PAYMENT_METHOD_READY', 'PROVIDER_SOURCING'
  ];
  stage_name TEXT;
  sequence_number INTEGER := 0;
  task_count_before BIGINT;
  application_count_before BIGINT;
  fse_count_before BIGINT;
  no_preview_link_rejected BOOLEAN := FALSE;
  direct_recipient_rejected BOOLEAN := FALSE;
  forged_signature_rejected BOOLEAN := FALSE;
  post_sourcing_link_rejected BOOLEAN := FALSE;
  post_sourcing_interest_rejected BOOLEAN := FALSE;
  revoked_interest_rejected BOOLEAN := FALSE;
  stale_eligibility_rejected BOOLEAN := FALSE;
  expired_provider_revalidation_rejected BOOLEAN := FALSE;
  provider_validity_coverage_rejected BOOLEAN := FALSE;
  future_revalidation_rejected BOOLEAN := FALSE;
  backdated_hold_rejected BOOLEAN := FALSE;
  excessive_ttl_rejected BOOLEAN := FALSE;
  crossed_provider_rejected BOOLEAN := FALSE;
  wrong_hold_actor_rejected BOOLEAN := FALSE;
  wrong_admin_hold_actor_rejected BOOLEAN := FALSE;
  premature_consumed_rejected BOOLEAN := FALSE;
  wrong_revoker_rejected BOOLEAN := FALSE;
  provider_admin_revocation_rejected BOOLEAN := FALSE;
  provider_admin_authority_rejected BOOLEAN := FALSE;
  crossed_admin_authority_rejected BOOLEAN := FALSE;
  interest_update_rejected BOOLEAN := FALSE;
  interest_delete_rejected BOOLEAN := FALSE;
  interest_truncate_rejected BOOLEAN := FALSE;
  hold_state TEXT;
  actual_tables INTEGER;
  forbidden_preview_columns INTEGER;
BEGIN
  SELECT count(*)
    INTO actual_tables
    FROM unnest(ARRAY[
      'payment_task_opportunity_previews_v7',
      'payment_opportunity_signing_keys_v7',
      'payment_task_opportunity_links_v7',
      'payment_opportunity_admin_authorities_v7',
      'payment_task_opportunity_link_revocations_v7',
      'payment_task_opportunity_interests_v7',
      'payment_task_revalidations_v7',
      'payment_conditional_provider_hold_events_v7'
    ]) AS expected(table_name)
   WHERE to_regclass('public.' || expected.table_name) IS NOT NULL;

  IF actual_tables <> 8 THEN
    RAISE EXCEPTION 'D3 table coverage mismatch: %/8', actual_tables;
  END IF;

  SELECT count(*)
    INTO forbidden_preview_columns
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'payment_task_opportunity_previews_v7'
     AND column_name IN (
       'exact_address', 'customer_email', 'customer_phone', 'customer_name',
       'access_instructions', 'payment_method', 'payment_token'
     );

  IF forbidden_preview_columns <> 0 THEN
    RAISE EXCEPTION 'D3 preview exposes forbidden private columns';
  END IF;

  SELECT count(*) INTO task_count_before FROM tasks;
  SELECT count(*) INTO application_count_before FROM task_applications;
  SELECT count(*) INTO fse_count_before FROM payment_financial_security_events_v7;

  INSERT INTO users(id, email, full_name, default_mode)
  VALUES
    (poster_id, 'd3-poster-' || poster_id::text || '@example.invalid', 'D3 Poster', 'poster'),
    (provider_id, 'd3-provider-' || provider_id::text || '@example.invalid', 'D3 Provider', 'worker'),
    (second_provider_id, 'd3-second-' || second_provider_id::text || '@example.invalid', 'D3 Second Provider', 'worker'),
    (admin_id, 'd3-admin-' || admin_id::text || '@example.invalid', 'D3 Admin', 'poster');

  INSERT INTO admin_roles(user_id, role)
  VALUES (admin_id, 'admin');

  INSERT INTO task_drafts(id, submission_id, card_token_hash, raw_input, poster_user_id)
  VALUES (
    draft_id,
    gen_random_uuid(),
    'd3-draft-' || draft_id::text,
    'D3 redacted opportunity source',
    poster_id
  );

  PERFORM set_config(
    'hxp.opportunity_link_signing_secret',
    'd3-test-signing-secret-with-32-bytes',
    true
  );
  key_valid_from := clock_timestamp() - interval '1 minute';
  key_valid_until := clock_timestamp() + interval '1 day';
  INSERT INTO payment_opportunity_signing_keys_v7(
    signature_key_id, algorithm, secret_sha256, state,
    valid_from, valid_until, authority_sha256
  ) VALUES (
    'd3-test-key', 'HMAC_SHA256',
    encode(digest('d3-test-signing-secret-with-32-bytes', 'sha256'), 'hex'),
    'ACTIVE', key_valid_from, key_valid_until,
    hxos_payment_opportunity_signing_key_authority_sha256_v7(
      'd3-test-key', 'HMAC_SHA256',
      encode(digest('d3-test-signing-secret-with-32-bytes', 'sha256'), 'hex'),
      key_valid_from, key_valid_until
    )
  );

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

  FOREACH stage_name IN ARRAY lifecycle_stages
  LOOP
    sequence_number := sequence_number + 1;
    next_event_id := gen_random_uuid();
    INSERT INTO payment_underwriting_lifecycle_events_v7(
      event_id, lifecycle_id, task_draft_id, sequence_number, prior_event_id,
      command_id, stage, actor_type, evidence_sha256, event_material, event_sha256
    ) VALUES (
      next_event_id, lifecycle_id, draft_id, sequence_number, previous_event_id,
      gen_random_uuid(), stage_name, 'SYSTEM',
      encode(digest(lifecycle_id::text || ':evidence:' || sequence_number::text, 'sha256'), 'hex'),
      jsonb_build_object('schema', 'HX_PAYMENT_UNDERWRITING_D3_TEST_EVENT_V7'),
      encode(digest(lifecycle_id::text || ':event:' || sequence_number::text, 'sha256'), 'hex')
    );
    previous_event_id := next_event_id;
  END LOOP;

  preview_sha256 := hxos_payment_opportunity_preview_sha256_v7(
    'YARD_WORK',
    'US-WA-SEA-NORTH',
    '2026-08-23T18:00:00.000Z'::timestamptz,
    '2026-08-23T20:00:00.000Z'::timestamptz,
    repeat('a', 64),
    repeat('b', 64),
    'PLATFORM_PRICED',
    8000,
    10000,
    'usd'
  );

  INSERT INTO payment_task_opportunities_v7(
    opportunity_id, lifecycle_id, scope_sha256, economics_corridor_sha256,
    preview_sha256, state, expires_at, evidence_sha256
  ) VALUES
    (opportunity_id, lifecycle_id, repeat('c', 64), repeat('d', 64), preview_sha256,
     'OPEN', clock_timestamp() + interval '2 hours', repeat('e', 64)),
    (no_preview_opportunity_id, lifecycle_id, repeat('f', 64), repeat('0', 64), repeat('1', 64),
     'OPEN', clock_timestamp() + interval '2 hours', repeat('2', 64));

  BEGIN
    link_verified_at := clock_timestamp();
    link_expires_at := clock_timestamp() + interval '1 hour';
    link_material_sha256 := hxos_payment_opportunity_link_material_sha256_v7(
      no_preview_link_id, no_preview_opportunity_id, repeat('1', 64),
      repeat('3', 64), 'OPEN_SHARE', NULL, link_expires_at, 'd3-test-key'
    );
    link_signature_sha256 := hxos_payment_opportunity_link_signature_sha256_v7(
      link_material_sha256
    );
    INSERT INTO payment_task_opportunity_links_v7(
      opportunity_link_id, opportunity_id, token_sha256, link_kind,
      link_material_sha256, signature_sha256, signature_key_id,
      signature_verified_at, signature_verification_sha256,
      expires_at, evidence_sha256
    ) VALUES (
      no_preview_link_id, no_preview_opportunity_id, repeat('3', 64), 'OPEN_SHARE',
      link_material_sha256, link_signature_sha256, 'd3-test-key', link_verified_at,
      hxos_payment_opportunity_link_verification_sha256_v7(
        link_material_sha256, link_signature_sha256, 'd3-test-key', link_verified_at
      ),
      link_expires_at, repeat('6', 64)
    );
    RAISE EXCEPTION 'D3_TEST_ACCEPTED_LINK_WITHOUT_PREVIEW' USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN no_preview_link_rejected := TRUE;
    WHEN SQLSTATE 'P0099' THEN NULL;
  END;

  INSERT INTO payment_task_opportunity_previews_v7(
    preview_id, opportunity_id, category_code, general_area_code,
    schedule_window_start, schedule_window_end, scope_summary_sha256,
    requirements_sha256, pricing_lane, gross_earnings_min_cents,
    gross_earnings_max_cents, currency, preview_sha256, redaction_evidence_sha256
  ) VALUES (
    preview_id, opportunity_id, 'YARD_WORK', 'US-WA-SEA-NORTH',
    '2026-08-23T18:00:00.000Z', '2026-08-23T20:00:00.000Z',
    repeat('a', 64), repeat('b', 64), 'PLATFORM_PRICED', 8000, 10000,
    'usd', preview_sha256, repeat('6', 64)
  );

  BEGIN
    INSERT INTO payment_task_opportunity_links_v7(
      opportunity_link_id, opportunity_id, token_sha256, link_kind,
      link_material_sha256, signature_sha256, signature_key_id,
      signature_verified_at, signature_verification_sha256,
      expires_at, evidence_sha256
    ) VALUES (
      forged_link_id, opportunity_id, repeat('2', 64), 'OPEN_SHARE',
      hxos_payment_opportunity_link_material_sha256_v7(
        forged_link_id, opportunity_id, preview_sha256, repeat('2', 64),
        'OPEN_SHARE', NULL, statement_timestamp() + interval '1 hour', 'd3-test-key'
      ),
      encode(digest('not-a-signature', 'sha256'), 'hex'),
      'd3-test-key', statement_timestamp(), repeat('3', 64),
      statement_timestamp() + interval '1 hour', repeat('4', 64)
    );
    RAISE EXCEPTION 'D3_TEST_ACCEPTED_FORGED_LINK_SIGNATURE' USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN forged_signature_rejected := TRUE;
    WHEN SQLSTATE 'P0099' THEN NULL;
  END;

  link_verified_at := clock_timestamp();
  link_expires_at := clock_timestamp() + interval '1 hour';
  link_material_sha256 := hxos_payment_opportunity_link_material_sha256_v7(
    link_id, opportunity_id, preview_sha256, repeat('7', 64),
    'OPEN_SHARE', NULL, link_expires_at, 'd3-test-key'
  );
  link_signature_sha256 := hxos_payment_opportunity_link_signature_sha256_v7(
    link_material_sha256
  );
  INSERT INTO payment_task_opportunity_links_v7(
    opportunity_link_id, opportunity_id, token_sha256, link_kind,
    link_material_sha256, signature_sha256, signature_key_id,
    signature_verified_at, signature_verification_sha256,
    expires_at, evidence_sha256
  ) VALUES (
    link_id, opportunity_id, repeat('7', 64), 'OPEN_SHARE',
    link_material_sha256, link_signature_sha256, 'd3-test-key', link_verified_at,
    hxos_payment_opportunity_link_verification_sha256_v7(
      link_material_sha256, link_signature_sha256, 'd3-test-key', link_verified_at
    ),
    link_expires_at, repeat('9', 64)
  );

  link_verified_at := clock_timestamp();
  link_expires_at := clock_timestamp() + interval '1 hour';
  link_material_sha256 := hxos_payment_opportunity_link_material_sha256_v7(
    admin_link_id, opportunity_id, preview_sha256, repeat('e', 64),
    'OPEN_SHARE', NULL, link_expires_at, 'd3-test-key'
  );
  link_signature_sha256 := hxos_payment_opportunity_link_signature_sha256_v7(
    link_material_sha256
  );
  INSERT INTO payment_task_opportunity_links_v7(
    opportunity_link_id, opportunity_id, token_sha256, link_kind,
    link_material_sha256, signature_sha256, signature_key_id,
    signature_verified_at, signature_verification_sha256,
    expires_at, evidence_sha256
  ) VALUES (
    admin_link_id, opportunity_id, repeat('e', 64), 'OPEN_SHARE',
    link_material_sha256, link_signature_sha256, 'd3-test-key', link_verified_at,
    hxos_payment_opportunity_link_verification_sha256_v7(
      link_material_sha256, link_signature_sha256, 'd3-test-key', link_verified_at
    ),
    link_expires_at, repeat('1', 64)
  );

  BEGIN
    link_verified_at := clock_timestamp();
    link_expires_at := clock_timestamp() + interval '1 hour';
    link_material_sha256 := hxos_payment_opportunity_link_material_sha256_v7(
      direct_link_id, opportunity_id, preview_sha256, repeat('a', 64),
      'DIRECT_INVITE', NULL, link_expires_at, 'd3-test-key'
    );
    link_signature_sha256 := hxos_payment_opportunity_link_signature_sha256_v7(
      link_material_sha256
    );
    INSERT INTO payment_task_opportunity_links_v7(
      opportunity_link_id, opportunity_id, token_sha256, link_kind,
      link_material_sha256, signature_sha256, signature_key_id,
      signature_verified_at, signature_verification_sha256,
      expires_at, evidence_sha256
    ) VALUES (
      direct_link_id, opportunity_id, repeat('a', 64), 'DIRECT_INVITE',
      link_material_sha256, link_signature_sha256, 'd3-test-key', link_verified_at,
      hxos_payment_opportunity_link_verification_sha256_v7(
        link_material_sha256, link_signature_sha256, 'd3-test-key', link_verified_at
      ),
      link_expires_at, repeat('d', 64)
    );
    RAISE EXCEPTION 'D3_TEST_ACCEPTED_UNBOUND_DIRECT_LINK' USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN check_violation OR SQLSTATE 'P0001' THEN direct_recipient_rejected := TRUE;
    WHEN SQLSTATE 'P0099' THEN NULL;
  END;

  INSERT INTO payment_task_opportunity_interests_v7(
    interest_id, opportunity_id, opportunity_link_id, provider_user_id,
    interest_kind, availability_start, availability_end,
    acknowledged_scope_sha256, acknowledged_economics_sha256,
    interest_material_sha256, evidence_sha256
  ) VALUES (
    fixture_interest_id, opportunity_id, link_id, provider_id,
    'EXPRESS_INTEREST', clock_timestamp() + interval '20 minutes',
    clock_timestamp() + interval '2 hours', repeat('c', 64), repeat('d', 64),
    repeat('e', 64), repeat('f', 64)
  );

  IF (SELECT count(*) FROM tasks) <> task_count_before
     OR (SELECT count(*) FROM task_applications) <> application_count_before
     OR (SELECT count(*) FROM payment_financial_security_events_v7) <> fse_count_before THEN
    RAISE EXCEPTION 'D3 Express Interest created assignment/application/money authority';
  END IF;

  INSERT INTO payment_provider_account_refs_v7(
    provider_account_ref_id, provider_user_id, processor_code,
    external_reference_sha256, eligibility_state, merchant_capabilities,
    funding_state, restrictions_sha256, bank_reference_sha256,
    evidence_sha256, observed_at, expires_at
  ) VALUES
    (provider_account_ref_id, provider_id, 'PROCESSOR_TEST', repeat('0', 64),
     'ELIGIBLE', jsonb_build_object(
       'paymentEligible', true,
       'merchantContextApproved', true,
       'blockingRestrictions', false
     ),
     'READY', repeat('0', 64), repeat('1', 64), repeat('2', 64),
     clock_timestamp(), clock_timestamp() + interval '1 hour'),
    (stale_provider_account_ref_id, provider_id, 'PROCESSOR_TEST', repeat('3', 64),
     'ELIGIBLE', jsonb_build_object(
       'paymentEligible', true,
       'merchantContextApproved', true,
       'blockingRestrictions', false
     ),
     'READY', repeat('0', 64), repeat('4', 64), repeat('5', 64),
     clock_timestamp() - interval '2 hours', clock_timestamp() - interval '1 hour'),
    (expired_provider_account_ref_id, provider_id, 'PROCESSOR_EXPIRED', repeat('6', 64),
     'ELIGIBLE', jsonb_build_object(
       'paymentEligible', true,
       'merchantContextApproved', true,
       'blockingRestrictions', false
     ),
     'READY', repeat('6', 64), repeat('7', 64), repeat('8', 64),
     statement_timestamp() - interval '4 minutes',
     statement_timestamp() - interval '3 minutes 59 seconds'),
    (short_provider_account_ref_id, provider_id, 'PROCESSOR_SHORT', repeat('9', 64),
     'ELIGIBLE', jsonb_build_object(
       'paymentEligible', true,
       'merchantContextApproved', true,
       'blockingRestrictions', false
     ),
     'READY', repeat('9', 64), repeat('a', 64), repeat('b', 64),
     statement_timestamp(), statement_timestamp() + interval '8 minutes');

  sequence_number := sequence_number + 1;
  next_event_id := gen_random_uuid();
  INSERT INTO payment_underwriting_lifecycle_events_v7(
    event_id, lifecycle_id, task_draft_id, sequence_number, prior_event_id,
    command_id, stage, actor_type, evidence_sha256, event_material, event_sha256
  ) VALUES (
    next_event_id, lifecycle_id, draft_id, sequence_number, previous_event_id,
    gen_random_uuid(), 'PAYMENT_ELIGIBLE', 'SYSTEM',
    encode(digest(lifecycle_id::text || ':evidence:' || sequence_number::text, 'sha256'), 'hex'),
    jsonb_build_object('schema', 'HX_PAYMENT_UNDERWRITING_D3_TEST_EVENT_V7'),
    encode(digest(lifecycle_id::text || ':event:' || sequence_number::text, 'sha256'), 'hex')
  );
  previous_event_id := next_event_id;

  BEGIN
    link_verified_at := clock_timestamp();
    link_expires_at := clock_timestamp() + interval '1 hour';
    link_material_sha256 := hxos_payment_opportunity_link_material_sha256_v7(
      post_sourcing_link_id, opportunity_id, preview_sha256, repeat('d', 64),
      'OPEN_SHARE', NULL, link_expires_at, 'd3-test-key'
    );
    link_signature_sha256 := hxos_payment_opportunity_link_signature_sha256_v7(
      link_material_sha256
    );
    INSERT INTO payment_task_opportunity_links_v7(
      opportunity_link_id, opportunity_id, token_sha256, link_kind,
      link_material_sha256, signature_sha256, signature_key_id,
      signature_verified_at, signature_verification_sha256,
      expires_at, evidence_sha256
    ) VALUES (
      post_sourcing_link_id, opportunity_id, repeat('d', 64), 'OPEN_SHARE',
      link_material_sha256, link_signature_sha256, 'd3-test-key', link_verified_at,
      hxos_payment_opportunity_link_verification_sha256_v7(
        link_material_sha256, link_signature_sha256, 'd3-test-key', link_verified_at
      ),
      link_expires_at, repeat('0', 64)
    );
    RAISE EXCEPTION 'D3_TEST_ACCEPTED_LINK_AFTER_PROVIDER_SOURCING' USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN post_sourcing_link_rejected := TRUE;
    WHEN SQLSTATE 'P0099' THEN NULL;
  END;

  BEGIN
    INSERT INTO payment_task_opportunity_interests_v7(
      opportunity_id, opportunity_link_id, provider_user_id, interest_kind,
      availability_start, availability_end, acknowledged_scope_sha256,
      acknowledged_economics_sha256, interest_material_sha256, evidence_sha256
    ) VALUES (
      opportunity_id, link_id, second_provider_id, 'EXPRESS_INTEREST',
      clock_timestamp() + interval '20 minutes', clock_timestamp() + interval '1 hour',
      repeat('c', 64), repeat('d', 64), repeat('3', 64), repeat('4', 64)
    );
    RAISE EXCEPTION 'D3_TEST_ACCEPTED_INTEREST_AFTER_PROVIDER_SOURCING' USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN post_sourcing_interest_rejected := TRUE;
    WHEN SQLSTATE 'P0099' THEN NULL;
  END;

  BEGIN
    INSERT INTO payment_task_revalidations_v7(
      revalidation_id, lifecycle_id, opportunity_id, interest_id,
      provider_account_ref_id, provider_user_id, scope_sha256,
      economics_sha256, schedule_sha256, task_open, quote_current,
      schedule_valid, customer_proceeding, provider_available,
      scope_accepted, economics_accepted, category_eligible,
      credentials_eligible, trust_eligible, availability_eligible,
      observed_at, valid_until, evidence_sha256
    ) VALUES (
      gen_random_uuid(), lifecycle_id, opportunity_id, fixture_interest_id,
      stale_provider_account_ref_id, provider_id, repeat('c', 64), repeat('d', 64),
      repeat('6', 64), true, true, true, true, true, true, true, true, true, true, true,
      statement_timestamp(), statement_timestamp() + interval '5 minutes', repeat('7', 64)
    );
    RAISE EXCEPTION 'D3_TEST_ACCEPTED_STALE_PROVIDER_ELIGIBILITY' USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN stale_eligibility_rejected := TRUE;
    WHEN SQLSTATE 'P0099' THEN NULL;
  END;

  BEGIN
    INSERT INTO payment_task_revalidations_v7(
      revalidation_id, lifecycle_id, opportunity_id, interest_id,
      provider_account_ref_id, provider_user_id, scope_sha256,
      economics_sha256, schedule_sha256, task_open, quote_current,
      schedule_valid, customer_proceeding, provider_available,
      scope_accepted, economics_accepted, category_eligible,
      credentials_eligible, trust_eligible, availability_eligible,
      observed_at, valid_until, evidence_sha256
    ) VALUES (
      gen_random_uuid(), lifecycle_id, opportunity_id, fixture_interest_id,
      expired_provider_account_ref_id, provider_id, repeat('c', 64), repeat('d', 64),
      repeat('6', 64), true, true, true, true, true, true, true, true, true, true, true,
      statement_timestamp() - interval '4 minutes',
      statement_timestamp() + interval '30 seconds', repeat('a', 64)
    );
    RAISE EXCEPTION 'D3_TEST_ACCEPTED_EXPIRED_PROVIDER_REVALIDATION' USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN expired_provider_revalidation_rejected := TRUE;
    WHEN SQLSTATE 'P0099' THEN NULL;
  END;

  BEGIN
    INSERT INTO payment_task_revalidations_v7(
      revalidation_id, lifecycle_id, opportunity_id, interest_id,
      provider_account_ref_id, provider_user_id, scope_sha256,
      economics_sha256, schedule_sha256, task_open, quote_current,
      schedule_valid, customer_proceeding, provider_available,
      scope_accepted, economics_accepted, category_eligible,
      credentials_eligible, trust_eligible, availability_eligible,
      observed_at, valid_until, evidence_sha256
    ) VALUES (
      short_revalidation_id, lifecycle_id, opportunity_id, fixture_interest_id,
      short_provider_account_ref_id, provider_id, repeat('c', 64), repeat('d', 64),
      repeat('6', 64), true, true, true, true, true, true, true, true, true, true, true,
      statement_timestamp(), statement_timestamp() + interval '5 minutes', repeat('b', 64)
    );
    INSERT INTO payment_conditional_provider_holds_v7(
      lifecycle_id, opportunity_id, provider_account_ref_id,
      provider_user_id, interest_id, revalidation_id, scope_sha256,
      provider_economics_sha256, schedule_sha256, state,
      accepted_at, expires_at, evidence_sha256
    ) VALUES (
      lifecycle_id, opportunity_id, short_provider_account_ref_id,
      provider_id, fixture_interest_id, short_revalidation_id, repeat('c', 64), repeat('d', 64),
      repeat('6', 64), 'SOFT_RESERVED', clock_timestamp(),
      clock_timestamp() + interval '10 minutes', repeat('c', 64)
    );
    RAISE EXCEPTION 'D3_TEST_ACCEPTED_HOLD_BEYOND_PROVIDER_VALIDITY' USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN provider_validity_coverage_rejected := TRUE;
    WHEN SQLSTATE 'P0099' THEN NULL;
  END;

  BEGIN
    INSERT INTO payment_task_revalidations_v7(
      revalidation_id, lifecycle_id, opportunity_id, interest_id,
      provider_account_ref_id, provider_user_id, scope_sha256,
      economics_sha256, schedule_sha256, task_open, quote_current,
      schedule_valid, customer_proceeding, provider_available,
      scope_accepted, economics_accepted, category_eligible,
      credentials_eligible, trust_eligible, availability_eligible,
      observed_at, valid_until, evidence_sha256
    ) VALUES (
      gen_random_uuid(), lifecycle_id, opportunity_id, fixture_interest_id,
      provider_account_ref_id, provider_id, repeat('c', 64), repeat('d', 64),
      repeat('6', 64), true, true, true, true, true, true, true, true, true, true, true,
      clock_timestamp() + interval '10 minutes',
      clock_timestamp() + interval '15 minutes',
      repeat('9', 64)
    );
    RAISE EXCEPTION 'D3_TEST_ACCEPTED_FUTURE_REVALIDATION' USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN future_revalidation_rejected := TRUE;
    WHEN SQLSTATE 'P0099' THEN NULL;
  END;

  INSERT INTO payment_task_revalidations_v7(
    revalidation_id, lifecycle_id, opportunity_id, interest_id,
    provider_account_ref_id, provider_user_id, scope_sha256,
    economics_sha256, schedule_sha256, task_open, quote_current,
    schedule_valid, customer_proceeding, provider_available,
    scope_accepted, economics_accepted, category_eligible,
    credentials_eligible, trust_eligible, availability_eligible,
    observed_at, valid_until, evidence_sha256
  ) VALUES (
    revalidation_id, lifecycle_id, opportunity_id, fixture_interest_id,
    provider_account_ref_id, provider_id, repeat('c', 64), repeat('d', 64),
    repeat('6', 64), true, true, true, true, true, true, true, true, true, true, true,
    statement_timestamp(), statement_timestamp() + interval '5 minutes', repeat('8', 64)
  );

  BEGIN
    INSERT INTO payment_conditional_provider_holds_v7(
      hold_id, lifecycle_id, opportunity_id, provider_account_ref_id,
      provider_user_id, interest_id, revalidation_id, scope_sha256,
      provider_economics_sha256, schedule_sha256, state,
      accepted_at, expires_at, evidence_sha256
    ) VALUES (
      gen_random_uuid(), lifecycle_id, opportunity_id, provider_account_ref_id,
      provider_id, fixture_interest_id, revalidation_id, repeat('c', 64), repeat('d', 64),
      repeat('6', 64), 'SOFT_RESERVED',
      clock_timestamp() - interval '1 hour',
      clock_timestamp() - interval '50 minutes',
      repeat('0', 64)
    );
    RAISE EXCEPTION 'D3_TEST_ACCEPTED_BACKDATED_HOLD' USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN backdated_hold_rejected := TRUE;
    WHEN SQLSTATE 'P0099' THEN NULL;
  END;

  BEGIN
    INSERT INTO payment_conditional_provider_holds_v7(
      hold_id, lifecycle_id, opportunity_id, provider_account_ref_id,
      provider_user_id, interest_id, revalidation_id, scope_sha256,
      provider_economics_sha256, schedule_sha256, state,
      accepted_at, expires_at, evidence_sha256
    ) VALUES (
      gen_random_uuid(), lifecycle_id, opportunity_id, provider_account_ref_id,
      provider_id, fixture_interest_id, revalidation_id, repeat('c', 64), repeat('d', 64),
      repeat('6', 64), 'SOFT_RESERVED', clock_timestamp(),
      clock_timestamp() + interval '16 minutes', repeat('9', 64)
    );
    RAISE EXCEPTION 'D3_TEST_ACCEPTED_EXCESSIVE_HOLD_TTL' USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN check_violation OR SQLSTATE 'P0001' THEN excessive_ttl_rejected := TRUE;
    WHEN SQLSTATE 'P0099' THEN NULL;
  END;

  BEGIN
    INSERT INTO payment_conditional_provider_holds_v7(
      lifecycle_id, opportunity_id, provider_account_ref_id,
      provider_user_id, interest_id, revalidation_id, scope_sha256,
      provider_economics_sha256, schedule_sha256, state,
      accepted_at, expires_at, evidence_sha256
    ) VALUES (
      lifecycle_id, opportunity_id, provider_account_ref_id,
      second_provider_id, fixture_interest_id, revalidation_id, repeat('c', 64), repeat('d', 64),
      repeat('6', 64), 'SOFT_RESERVED', clock_timestamp(),
      clock_timestamp() + interval '10 minutes', repeat('a', 64)
    );
    RAISE EXCEPTION 'D3_TEST_ACCEPTED_CROSSED_PROVIDER' USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN foreign_key_violation OR SQLSTATE 'P0001' THEN crossed_provider_rejected := TRUE;
    WHEN SQLSTATE 'P0099' THEN NULL;
  END;

  INSERT INTO payment_conditional_provider_holds_v7(
    hold_id, lifecycle_id, opportunity_id, provider_account_ref_id,
    provider_user_id, interest_id, revalidation_id, scope_sha256,
    provider_economics_sha256, schedule_sha256, state,
    accepted_at, expires_at, evidence_sha256
  ) VALUES (
    fixture_hold_id, lifecycle_id, opportunity_id, provider_account_ref_id,
    provider_id, fixture_interest_id, revalidation_id, repeat('c', 64), repeat('d', 64),
    repeat('6', 64), 'SOFT_RESERVED', clock_timestamp(),
    clock_timestamp() + interval '10 minutes', repeat('b', 64)
  );

  SELECT event_id INTO initial_hold_event_id
   FROM payment_conditional_provider_hold_events_v7
   WHERE payment_conditional_provider_hold_events_v7.hold_id = fixture_hold_id
     AND payment_conditional_provider_hold_events_v7.sequence_number = 1;

  SELECT state INTO hold_state
    FROM payment_conditional_provider_hold_status_v7
   WHERE payment_conditional_provider_hold_status_v7.hold_id = fixture_hold_id;

  IF hold_state IS DISTINCT FROM 'SOFT_RESERVED' THEN
    RAISE EXCEPTION 'D3 initial hold state mismatch: %', hold_state;
  END IF;

  BEGIN
    INSERT INTO payment_conditional_provider_hold_events_v7(
      hold_id, sequence_number, prior_event_id, event_type,
      actor_type, actor_user_id, event_material_sha256, evidence_sha256
    ) VALUES (
      fixture_hold_id, 2, initial_hold_event_id, 'RELEASED',
      'POSTER', second_provider_id, repeat('2', 64), repeat('3', 64)
    );
    RAISE EXCEPTION 'D3_TEST_ACCEPTED_WRONG_HOLD_ACTOR' USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN wrong_hold_actor_rejected := TRUE;
    WHEN SQLSTATE 'P0099' THEN NULL;
  END;

  BEGIN
    INSERT INTO payment_conditional_provider_hold_events_v7(
      hold_id, sequence_number, prior_event_id, event_type,
      actor_type, actor_user_id, event_material_sha256, evidence_sha256
    ) VALUES (
      fixture_hold_id, 2, initial_hold_event_id, 'RELEASED',
      'ADMIN', second_provider_id, repeat('8', 64), repeat('9', 64)
    );
    RAISE EXCEPTION 'D3_TEST_ACCEPTED_WRONG_ADMIN_HOLD_ACTOR' USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN check_violation OR SQLSTATE 'P0001' THEN wrong_admin_hold_actor_rejected := TRUE;
    WHEN SQLSTATE 'P0099' THEN NULL;
  END;

  BEGIN
    INSERT INTO payment_conditional_provider_hold_events_v7(
      hold_id, sequence_number, prior_event_id, event_type,
      actor_type, actor_user_id, event_material_sha256, evidence_sha256
    ) VALUES (
      fixture_hold_id, 2, initial_hold_event_id, 'CONSUMED',
      'SYSTEM', NULL, repeat('4', 64), repeat('5', 64)
    );
    RAISE EXCEPTION 'D3_TEST_ACCEPTED_PREMATURE_CONSUMED' USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN premature_consumed_rejected := TRUE;
    WHEN SQLSTATE 'P0099' THEN NULL;
  END;

  INSERT INTO payment_conditional_provider_hold_events_v7(
    hold_id, sequence_number, prior_event_id, event_type,
    actor_type, actor_user_id, event_material_sha256, evidence_sha256
  ) VALUES (
    fixture_hold_id, 2, initial_hold_event_id, 'RELEASED',
    'SYSTEM', NULL, repeat('c', 64), repeat('d', 64)
  );

  SELECT state INTO hold_state
    FROM payment_conditional_provider_hold_status_v7
   WHERE payment_conditional_provider_hold_status_v7.hold_id = fixture_hold_id;

  IF hold_state IS DISTINCT FROM 'RELEASED' THEN
    RAISE EXCEPTION 'D3 released hold state mismatch: %', hold_state;
  END IF;

  BEGIN
    admin_valid_from := clock_timestamp() - interval '30 seconds';
    admin_valid_until := clock_timestamp() + interval '4 minutes';
    INSERT INTO payment_opportunity_admin_authorities_v7(
      admin_authority_id, admin_user_id, opportunity_link_id, authority_kind,
      reason_code, valid_from, valid_until, authority_sha256, evidence_sha256
    ) VALUES (
      forged_admin_authority_id, second_provider_id, link_id, 'LINK_REVOCATION',
      'ADMIN_REVOKED', admin_valid_from, admin_valid_until,
      hxos_payment_opportunity_admin_authority_sha256_v7(
        forged_admin_authority_id, second_provider_id, link_id, 'ADMIN_REVOKED',
        admin_valid_from, admin_valid_until, repeat('5', 64)
      ),
      repeat('5', 64)
    );
    RAISE EXCEPTION 'D3_TEST_ACCEPTED_PROVIDER_ADMIN_AUTHORITY' USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN provider_admin_authority_rejected := TRUE;
    WHEN SQLSTATE 'P0099' THEN NULL;
  END;

  BEGIN
    INSERT INTO payment_task_opportunity_link_revocations_v7(
      opportunity_link_id, revoked_by_user_id, reason_code,
      revocation_material_sha256, evidence_sha256
    ) VALUES (
      link_id, second_provider_id, 'POSTER_REVOKED', repeat('6', 64), repeat('7', 64)
    );
    RAISE EXCEPTION 'D3_TEST_ACCEPTED_WRONG_REVOKER' USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN wrong_revoker_rejected := TRUE;
    WHEN SQLSTATE 'P0099' THEN NULL;
  END;

  admin_valid_from := clock_timestamp() - interval '30 seconds';
  admin_valid_until := clock_timestamp() + interval '4 minutes';
  INSERT INTO payment_opportunity_admin_authorities_v7(
    admin_authority_id, admin_user_id, opportunity_link_id, authority_kind,
    reason_code, valid_from, valid_until, authority_sha256, evidence_sha256
  ) VALUES (
    admin_authority_id, admin_id, admin_link_id, 'LINK_REVOCATION',
    'ADMIN_REVOKED', admin_valid_from, admin_valid_until,
    hxos_payment_opportunity_admin_authority_sha256_v7(
      admin_authority_id, admin_id, admin_link_id, 'ADMIN_REVOKED',
      admin_valid_from, admin_valid_until, repeat('b', 64)
    ),
    repeat('b', 64)
  );

  BEGIN
    INSERT INTO payment_task_opportunity_link_revocations_v7(
      opportunity_link_id, revoked_by_user_id, admin_authority_id, reason_code,
      revocation_material_sha256, evidence_sha256
    ) VALUES (
      link_id, admin_id, admin_authority_id, 'ADMIN_REVOKED',
      repeat('4', 64), repeat('5', 64)
    );
    RAISE EXCEPTION 'D3_TEST_ACCEPTED_CROSSED_ADMIN_AUTHORITY' USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN foreign_key_violation OR SQLSTATE 'P0001' THEN crossed_admin_authority_rejected := TRUE;
    WHEN SQLSTATE 'P0099' THEN NULL;
  END;

  INSERT INTO payment_task_opportunity_link_revocations_v7(
    opportunity_link_id, revoked_by_user_id, admin_authority_id, reason_code,
    revocation_material_sha256, evidence_sha256
  ) VALUES (
    admin_link_id, admin_id, admin_authority_id, 'ADMIN_REVOKED',
    repeat('a', 64), repeat('b', 64)
  );

  BEGIN
    INSERT INTO payment_task_opportunity_link_revocations_v7(
      opportunity_link_id, revoked_by_user_id, reason_code,
      revocation_material_sha256, evidence_sha256
    ) VALUES (
      link_id, second_provider_id, 'ADMIN_REVOKED', repeat('8', 64), repeat('9', 64)
    );
    RAISE EXCEPTION 'D3_TEST_ACCEPTED_PROVIDER_ADMIN_REVOCATION' USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN provider_admin_revocation_rejected := TRUE;
    WHEN SQLSTATE 'P0099' THEN NULL;
  END;

  INSERT INTO payment_task_opportunity_link_revocations_v7(
    opportunity_link_id, revoked_by_user_id, reason_code,
    revocation_material_sha256, evidence_sha256
  ) VALUES (
    link_id, poster_id, 'POSTER_REVOKED', repeat('e', 64), repeat('f', 64)
  );

  BEGIN
    INSERT INTO payment_task_opportunity_interests_v7(
      opportunity_id, opportunity_link_id, provider_user_id, interest_kind,
      availability_start, availability_end, acknowledged_scope_sha256,
      acknowledged_economics_sha256, interest_material_sha256, evidence_sha256
    ) VALUES (
      opportunity_id, link_id, second_provider_id, 'EXPRESS_INTEREST',
      clock_timestamp() + interval '20 minutes', clock_timestamp() + interval '1 hour',
      repeat('c', 64), repeat('d', 64), repeat('0', 64), repeat('1', 64)
    );
    RAISE EXCEPTION 'D3_TEST_ACCEPTED_REVOKED_LINK_INTEREST' USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN revoked_interest_rejected := TRUE;
    WHEN SQLSTATE 'P0099' THEN NULL;
  END;

  BEGIN
    UPDATE payment_task_opportunity_interests_v7
       SET availability_end = availability_end + interval '1 hour'
     WHERE payment_task_opportunity_interests_v7.interest_id = fixture_interest_id;
  EXCEPTION WHEN SQLSTATE 'P0001' THEN interest_update_rejected := TRUE;
  END;

  BEGIN
    DELETE FROM payment_task_opportunity_interests_v7
     WHERE payment_task_opportunity_interests_v7.interest_id = fixture_interest_id;
  EXCEPTION WHEN SQLSTATE 'P0001' THEN interest_delete_rejected := TRUE;
  END;

  BEGIN
    TRUNCATE payment_task_opportunity_interests_v7 CASCADE;
  EXCEPTION WHEN SQLSTATE 'P0001' THEN interest_truncate_rejected := TRUE;
  END;

  IF (SELECT count(*) FROM tasks) <> task_count_before
     OR (SELECT count(*) FROM task_applications) <> application_count_before
     OR (SELECT count(*) FROM payment_financial_security_events_v7) <> fse_count_before THEN
    RAISE EXCEPTION 'D3 created forbidden task/application/FSE side effects';
  END IF;

  IF NOT no_preview_link_rejected
     OR NOT direct_recipient_rejected
     OR NOT forged_signature_rejected
     OR NOT post_sourcing_link_rejected
     OR NOT post_sourcing_interest_rejected
     OR NOT revoked_interest_rejected
     OR NOT stale_eligibility_rejected
     OR NOT expired_provider_revalidation_rejected
     OR NOT provider_validity_coverage_rejected
     OR NOT future_revalidation_rejected
     OR NOT backdated_hold_rejected
     OR NOT excessive_ttl_rejected
     OR NOT crossed_provider_rejected
     OR NOT wrong_hold_actor_rejected
     OR NOT wrong_admin_hold_actor_rejected
     OR NOT premature_consumed_rejected
     OR NOT wrong_revoker_rejected
     OR NOT provider_admin_revocation_rejected
     OR NOT provider_admin_authority_rejected
     OR NOT crossed_admin_authority_rejected
     OR NOT interest_update_rejected
     OR NOT interest_delete_rejected
     OR NOT interest_truncate_rejected THEN
    RAISE EXCEPTION 'D3 authority matrix failed: preview %, recipient %, forged %, post_sourcing %, post_sourcing_interest %, revoked %, stale %, expired_provider %, provider_coverage %, future %, backdated %, ttl %, provider %, actor %, admin_actor %, consumed %, revoker %, admin %, admin_authority %, crossed_admin_authority %, update %, delete %, truncate %',
      no_preview_link_rejected,
      direct_recipient_rejected,
      forged_signature_rejected,
      post_sourcing_link_rejected,
      post_sourcing_interest_rejected,
      revoked_interest_rejected,
      stale_eligibility_rejected,
      expired_provider_revalidation_rejected,
      provider_validity_coverage_rejected,
      future_revalidation_rejected,
      backdated_hold_rejected,
      excessive_ttl_rejected,
      crossed_provider_rejected,
      wrong_hold_actor_rejected,
      wrong_admin_hold_actor_rejected,
      premature_consumed_rejected,
      wrong_revoker_rejected,
      provider_admin_revocation_rejected,
      provider_admin_authority_rejected,
      crossed_admin_authority_rejected,
      interest_update_rejected,
      interest_delete_rejected,
      interest_truncate_rejected;
  END IF;
END;
$$;

ROLLBACK;
