BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.hx_d2_policy_snapshot(
  p region_policies,
  p_category TEXT,
  p_risk TEXT
)
RETURNS JSONB LANGUAGE SQL IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'policyId', p.id::text,
    'policyVersion', p.version,
    'policyHash', p.policy_hash,
    'regionCode', p.region_code,
    'locationState', split_part(p.region_code, '-', 2),
    'licenseRequired', (p.policy_document#>>ARRAY['categories', p_category, 'credentials', 'licenseRequired'])::BOOLEAN,
    'insuranceRequired', (p.policy_document#>>ARRAY['categories', p_category, 'credentials', 'insuranceRequired'])::BOOLEAN,
    'backgroundCheckRequired', (p.policy_document#>>ARRAY['categories', p_category, 'credentials', 'backgroundCheckRequired'])::BOOLEAN,
    'proofRequired', (p.policy_document#>>ARRAY['categories', p_category, 'evidence', 'proofRequired'])::BOOLEAN,
    'proofMinPhotos', (p.policy_document#>>ARRAY['categories', p_category, 'evidence', 'minPhotos'])::INTEGER,
    'proofMaxPhotos', (p.policy_document#>>ARRAY['categories', p_category, 'evidence', 'maxPhotos'])::INTEGER,
    'proofGpsRequired', (p.policy_document#>>ARRAY['categories', p_category, 'evidence', 'gpsRequired'])::BOOLEAN,
    'recordingAllowed', (p.policy_document#>>'{recording,allowed}')::BOOLEAN,
    'recordingStandaloneConsentRequired', (p.policy_document#>>'{recording,standaloneConsentRequired}')::BOOLEAN,
    'screeningStandaloneConsentRequired', (p.policy_document#>>'{workerRights,standaloneScreeningConsentRequired}')::BOOLEAN,
    'screeningReportAccessRequired', (p.policy_document#>>'{workerRights,reportAccessRequired}')::BOOLEAN,
    'screeningDisputeAndAppealRequired', (p.policy_document#>>'{workerRights,disputeAndAppealRequired}')::BOOLEAN,
    'screeningAdverseActionNoticeRequired', (p.policy_document#>>'{workerRights,adverseActionNoticeRequired}')::BOOLEAN,
    'safetyIncidentIntakeRequired', (p.policy_document#>>'{safety,incidentIntakeRequired}')::BOOLEAN,
    'safetyTimedCheckinRequired', (p.policy_document#>'{safety,timedCheckinRiskLevels}') ? p_risk,
    'safetyCheckinIntervalsMinutes', p.policy_document#>'{safety,checkinIntervalsMinutes}',
    'safetyLocationRetentionDays', (p.policy_document#>>'{safety,locationRetentionDays}')::INTEGER,
    'safetyAlternateEmergencyActionRequired', (p.policy_document#>>'{safety,alternateEmergencyActionRequired}')::BOOLEAN,
    'currency', p.policy_document#>>'{financial,currency}'
  )
$$;

DO $$
DECLARE
  expected_tables TEXT[] := ARRAY[
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
  ];
  actual_count INTEGER;
  draft_id UUID := gen_random_uuid();
  lifecycle UUID := gen_random_uuid();
  initial_event UUID := gen_random_uuid();
  scope_ready_event UUID := gen_random_uuid();
  invalid_draft_id UUID := gen_random_uuid();
  invalid_lifecycle UUID := gen_random_uuid();
  provider_initial_event UUID := gen_random_uuid();
  provider_scope_event UUID := gen_random_uuid();
  invalid_initial_rejected BOOLEAN := FALSE;
  invalid_stage_rejected BOOLEAN := FALSE;
  stale_predecessor_rejected BOOLEAN := FALSE;
  platform_lane_rejected BOOLEAN := FALSE;
  provider_lane_rejected BOOLEAN := FALSE;
  update_rejected BOOLEAN := FALSE;
  delete_rejected BOOLEAN := FALSE;
  status_stage TEXT;
BEGIN
  SELECT count(*)
  INTO actual_count
  FROM unnest(expected_tables) AS expected(table_name)
  WHERE to_regclass('public.' || expected.table_name) IS NOT NULL;

  IF actual_count <> cardinality(expected_tables) THEN
    RAISE EXCEPTION 'neutral lifecycle table coverage mismatch: %/%', actual_count, cardinality(expected_tables);
  END IF;

  INSERT INTO task_drafts(id, submission_id, card_token_hash, raw_input)
  VALUES (draft_id, gen_random_uuid(), 'underwriting-v7-' || draft_id::text, 'neutral lifecycle contract');

  INSERT INTO payment_underwriting_lifecycles_v7(
    lifecycle_id,
    task_draft_id,
    request_id,
    pricing_lane,
    authority_document_id,
    authority_drive_revision,
    authority_docs_revision,
    authority_text_sha256
  )
  VALUES (
    lifecycle,
    draft_id,
    gen_random_uuid(),
    'PLATFORM_PRICED',
    '1PYpWdbnlhRBoovc6GfTyxMuu1IzMIdDQpV6hHHraXaQ',
    '7',
    'AIroW37g_sqKNU_dvvRNUndw-qUeooFwAYIHqN60aHvPSR178sKjMMu5rMzGTzODqgDKERue3ZbAT8UesInsUZvT6p1Z0bUvPByrgwaPDA',
    'ba8dc04bfc43feb24bd78698c6e5b820ecdf22177f915fb04856a55d8076bd26'
  );

  INSERT INTO payment_underwriting_lifecycle_events_v7(
    event_id,
    lifecycle_id,
    task_draft_id,
    sequence_number,
    command_id,
    stage,
    actor_type,
    evidence_sha256,
    event_material,
    event_sha256
  )
  VALUES (
    initial_event,
    lifecycle,
    draft_id,
    1,
    gen_random_uuid(),
    'TASK_DRAFT',
    'SYSTEM',
    repeat('a', 64),
    jsonb_build_object('schema', 'HX_PAYMENT_UNDERWRITING_LIFECYCLE_EVENT_V7'),
    repeat('b', 64)
  );

  SELECT stage
  INTO status_stage
  FROM payment_underwriting_lifecycle_status_v7
  WHERE lifecycle_id = lifecycle;

  IF status_stage IS DISTINCT FROM 'TASK_DRAFT' THEN
    RAISE EXCEPTION 'derived lifecycle status mismatch: %', status_stage;
  END IF;

  INSERT INTO task_drafts(id, submission_id, card_token_hash, raw_input)
  VALUES (
    invalid_draft_id,
    gen_random_uuid(),
    'underwriting-v7-invalid-' || invalid_draft_id::text,
    'invalid initial lifecycle contract'
  );

  INSERT INTO payment_underwriting_lifecycles_v7(
    lifecycle_id,
    task_draft_id,
    request_id,
    pricing_lane,
    authority_document_id,
    authority_drive_revision,
    authority_docs_revision,
    authority_text_sha256
  )
  VALUES (
    invalid_lifecycle,
    invalid_draft_id,
    gen_random_uuid(),
    'PROVIDER_ESTIMATE',
    '1PYpWdbnlhRBoovc6GfTyxMuu1IzMIdDQpV6hHHraXaQ',
    '7',
    'AIroW37g_sqKNU_dvvRNUndw-qUeooFwAYIHqN60aHvPSR178sKjMMu5rMzGTzODqgDKERue3ZbAT8UesInsUZvT6p1Z0bUvPByrgwaPDA',
    'ba8dc04bfc43feb24bd78698c6e5b820ecdf22177f915fb04856a55d8076bd26'
  );

  BEGIN
    INSERT INTO payment_underwriting_lifecycle_events_v7(
      lifecycle_id,
      task_draft_id,
      sequence_number,
      command_id,
      stage,
      actor_type,
      evidence_sha256,
      event_material,
      event_sha256
    )
    VALUES (
      invalid_lifecycle,
      invalid_draft_id,
      1,
      gen_random_uuid(),
      'SCOPE_READY',
      'SYSTEM',
      repeat('8', 64),
      '{}'::jsonb,
      repeat('9', 64)
    );
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    invalid_initial_rejected := TRUE;
  END;

  INSERT INTO payment_underwriting_lifecycle_events_v7(
    event_id,
    lifecycle_id,
    task_draft_id,
    sequence_number,
    command_id,
    stage,
    actor_type,
    evidence_sha256,
    event_material,
    event_sha256
  )
  VALUES (
    provider_initial_event,
    invalid_lifecycle,
    invalid_draft_id,
    1,
    gen_random_uuid(),
    'TASK_DRAFT',
    'SYSTEM',
    repeat('6', 64),
    '{}'::jsonb,
    repeat('7', 64)
  );

  INSERT INTO payment_underwriting_lifecycle_events_v7(
    event_id,
    lifecycle_id,
    task_draft_id,
    sequence_number,
    prior_event_id,
    command_id,
    stage,
    actor_type,
    evidence_sha256,
    event_material,
    event_sha256
  )
  VALUES (
    provider_scope_event,
    invalid_lifecycle,
    invalid_draft_id,
    2,
    provider_initial_event,
    gen_random_uuid(),
    'SCOPE_READY',
    'SYSTEM',
    repeat('8', 64),
    '{}'::jsonb,
    repeat('0', 64)
  );

  BEGIN
    INSERT INTO payment_underwriting_lifecycle_events_v7(
      lifecycle_id,
      task_draft_id,
      sequence_number,
      prior_event_id,
      command_id,
      stage,
      actor_type,
      evidence_sha256,
      event_material,
      event_sha256
    )
    VALUES (
      invalid_lifecycle,
      invalid_draft_id,
      3,
      provider_scope_event,
      gen_random_uuid(),
      'QUOTED',
      'SYSTEM',
      repeat('1', 64),
      '{}'::jsonb,
      repeat('2', 64)
    );
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    provider_lane_rejected := TRUE;
  END;

  INSERT INTO payment_underwriting_lifecycle_events_v7(
    lifecycle_id,
    task_draft_id,
    sequence_number,
    prior_event_id,
    command_id,
    stage,
    actor_type,
    evidence_sha256,
    event_material,
    event_sha256
  )
  VALUES (
    invalid_lifecycle,
    invalid_draft_id,
    3,
    provider_scope_event,
    gen_random_uuid(),
    'ESTIMATE_REQUIRED',
    'SYSTEM',
    repeat('1', 64),
    '{}'::jsonb,
    repeat('3', 64)
  );

  BEGIN
    INSERT INTO payment_underwriting_lifecycle_events_v7(
      lifecycle_id,
      task_draft_id,
      sequence_number,
      prior_event_id,
      command_id,
      stage,
      actor_type,
      evidence_sha256,
      event_material,
      event_sha256
    )
    VALUES (
      lifecycle,
      draft_id,
      2,
      initial_event,
      gen_random_uuid(),
      'PAID_WITHOUT_AUTHORITY',
      'SYSTEM',
      repeat('c', 64),
      '{}'::jsonb,
      repeat('d', 64)
    );
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    invalid_stage_rejected := TRUE;
  END;

  INSERT INTO payment_underwriting_lifecycle_events_v7(
    event_id,
    lifecycle_id,
    task_draft_id,
    sequence_number,
    prior_event_id,
    command_id,
    stage,
    actor_type,
    evidence_sha256,
    event_material,
    event_sha256
  )
  VALUES (
    scope_ready_event,
    lifecycle,
    draft_id,
    2,
    initial_event,
    gen_random_uuid(),
    'SCOPE_READY',
    'SYSTEM',
    repeat('c', 64),
    jsonb_build_object('schema', 'HX_PAYMENT_UNDERWRITING_LIFECYCLE_EVENT_V7'),
    repeat('d', 64)
  );

  SELECT stage
  INTO status_stage
  FROM payment_underwriting_lifecycle_status_v7
  WHERE lifecycle_id = lifecycle;

  IF status_stage IS DISTINCT FROM 'SCOPE_READY' THEN
    RAISE EXCEPTION 'derived lifecycle transition mismatch: %', status_stage;
  END IF;

  BEGIN
    INSERT INTO payment_underwriting_lifecycle_events_v7(
      lifecycle_id,
      task_draft_id,
      sequence_number,
      prior_event_id,
      command_id,
      stage,
      actor_type,
      evidence_sha256,
      event_material,
      event_sha256
    )
    VALUES (
      lifecycle,
      draft_id,
      3,
      initial_event,
      gen_random_uuid(),
      'QUOTED',
      'SYSTEM',
      repeat('4', 64),
      '{}'::jsonb,
      repeat('5', 64)
    );
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    stale_predecessor_rejected := TRUE;
  END;

  BEGIN
    INSERT INTO payment_underwriting_lifecycle_events_v7(
      lifecycle_id,
      task_draft_id,
      sequence_number,
      prior_event_id,
      command_id,
      stage,
      actor_type,
      evidence_sha256,
      event_material,
      event_sha256
    )
    VALUES (
      lifecycle,
      draft_id,
      3,
      scope_ready_event,
      gen_random_uuid(),
      'ESTIMATE_REQUIRED',
      'SYSTEM',
      repeat('4', 64),
      '{}'::jsonb,
      repeat('5', 64)
    );
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    platform_lane_rejected := TRUE;
  END;

  BEGIN
    UPDATE payment_underwriting_lifecycle_events_v7
    SET evidence_sha256 = repeat('e', 64)
    WHERE event_id = initial_event;
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    update_rejected := TRUE;
  END;

  BEGIN
    DELETE FROM payment_underwriting_lifecycle_events_v7
    WHERE event_id = initial_event;
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    delete_rejected := TRUE;
  END;

  IF NOT invalid_initial_rejected
    OR NOT invalid_stage_rejected
    OR NOT stale_predecessor_rejected
    OR NOT platform_lane_rejected
    OR NOT provider_lane_rejected
    OR NOT update_rejected
    OR NOT delete_rejected
  THEN
    RAISE EXCEPTION 'neutral lifecycle fail-closed matrix failed: initial %, invalid %, stale %, platform %, provider %, update %, delete %',
      invalid_initial_rejected,
      invalid_stage_rejected,
      stale_predecessor_rejected,
      platform_lane_rejected,
      provider_lane_rejected,
      update_rejected,
      delete_rejected;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    SELECT count(*)
    INTO actual_count
    FROM unnest(expected_tables) AS expected(table_name)
    WHERE has_table_privilege('service_role', expected.table_name, 'SELECT')
       OR has_table_privilege('service_role', expected.table_name, 'INSERT')
       OR has_table_privilege('service_role', expected.table_name, 'UPDATE')
       OR has_table_privilege('service_role', expected.table_name, 'DELETE')
       OR has_table_privilege('service_role', expected.table_name, 'TRUNCATE');

    IF actual_count <> 0 THEN
      RAISE EXCEPTION 'service_role received premature neutral lifecycle table authority';
    END IF;
  END IF;
END;
$$;

DO $$
DECLARE
  poster_id UUID := gen_random_uuid();
  other_customer_id UUID := gen_random_uuid();
  provider_a_user_id UUID := gen_random_uuid();
  provider_b_user_id UUID := gen_random_uuid();
  draft_a UUID := gen_random_uuid();
  draft_b UUID := gen_random_uuid();
  lifecycle_a UUID := gen_random_uuid();
  lifecycle_b UUID := gen_random_uuid();
  opportunity_a UUID := gen_random_uuid();
  opportunity_b UUID := gen_random_uuid();
  provider_a UUID := gen_random_uuid();
  provider_b UUID := gen_random_uuid();
  hold_a UUID := gen_random_uuid();
  hold_b UUID := gen_random_uuid();
  payment_method_a UUID := gen_random_uuid();
  payment_method_b UUID := gen_random_uuid();
  payment_method_other UUID := gen_random_uuid();
  fse_a UUID := gen_random_uuid();
  fse_b UUID := gen_random_uuid();
  task_a UUID := gen_random_uuid();
  task_b UUID := gen_random_uuid();
  cross_task UUID := gen_random_uuid();
  cross_customer_task UUID := gen_random_uuid();
  work_order_a UUID := gen_random_uuid();
  work_order_b UUID := gen_random_uuid();
  capture_a UUID := gen_random_uuid();
  capture_b UUID := gen_random_uuid();
  crossed_hold_rejected BOOLEAN := FALSE;
  crossed_fse_rejected BOOLEAN := FALSE;
  crossed_processor_rejected BOOLEAN := FALSE;
  crossed_customer_rejected BOOLEAN := FALSE;
  crossed_work_order_rejected BOOLEAN := FALSE;
  crossed_capture_rejected BOOLEAN := FALSE;
  crossed_settlement_rejected BOOLEAN := FALSE;
  nonplanned_fse_rejected BOOLEAN := FALSE;
  nonplanned_capture_rejected BOOLEAN := FALSE;
  spoofed_actor_rejected BOOLEAN := FALSE;
  spoofed_poster_identity_rejected BOOLEAN := FALSE;
  null_poster_identity_rejected BOOLEAN := FALSE;
  crossed_task_poster_rejected BOOLEAN := FALSE;
  task_poster_mutation_rejected BOOLEAN := FALSE;
BEGIN
  INSERT INTO users(id, email, full_name, default_mode)
  VALUES
    (poster_id, 'd2-poster-' || poster_id::text || '@example.invalid', 'D2 Poster', 'poster'),
    (other_customer_id, 'd2-customer-' || other_customer_id::text || '@example.invalid', 'D2 Other Customer', 'poster'),
    (provider_a_user_id, 'd2-provider-a-' || provider_a_user_id::text || '@example.invalid', 'D2 Provider A', 'worker'),
    (provider_b_user_id, 'd2-provider-b-' || provider_b_user_id::text || '@example.invalid', 'D2 Provider B', 'worker');

  INSERT INTO task_drafts(id, submission_id, card_token_hash, raw_input, poster_user_id)
  VALUES
    (draft_a, gen_random_uuid(), 'd2-bind-a-' || draft_a::text, 'binding A', poster_id),
    (draft_b, gen_random_uuid(), 'd2-bind-b-' || draft_b::text, 'binding B', poster_id);

  INSERT INTO payment_underwriting_lifecycles_v7(
    lifecycle_id, task_draft_id, request_id, pricing_lane,
    authority_document_id, authority_drive_revision, authority_docs_revision, authority_text_sha256
  )
  VALUES
    (lifecycle_a, draft_a, gen_random_uuid(), 'PLATFORM_PRICED',
     '1PYpWdbnlhRBoovc6GfTyxMuu1IzMIdDQpV6hHHraXaQ', '7',
     'AIroW37g_sqKNU_dvvRNUndw-qUeooFwAYIHqN60aHvPSR178sKjMMu5rMzGTzODqgDKERue3ZbAT8UesInsUZvT6p1Z0bUvPByrgwaPDA',
     'ba8dc04bfc43feb24bd78698c6e5b820ecdf22177f915fb04856a55d8076bd26'),
    (lifecycle_b, draft_b, gen_random_uuid(), 'PROVIDER_ESTIMATE',
     '1PYpWdbnlhRBoovc6GfTyxMuu1IzMIdDQpV6hHHraXaQ', '7',
     'AIroW37g_sqKNU_dvvRNUndw-qUeooFwAYIHqN60aHvPSR178sKjMMu5rMzGTzODqgDKERue3ZbAT8UesInsUZvT6p1Z0bUvPByrgwaPDA',
     'ba8dc04bfc43feb24bd78698c6e5b820ecdf22177f915fb04856a55d8076bd26');

  INSERT INTO payment_task_opportunities_v7(
    opportunity_id, lifecycle_id, scope_sha256, economics_corridor_sha256,
    preview_sha256, state, expires_at, evidence_sha256
  )
  VALUES
    (opportunity_a, lifecycle_a, repeat('a', 64), repeat('b', 64), repeat('c', 64), 'OPEN', clock_timestamp() + interval '1 hour', repeat('d', 64)),
    (opportunity_b, lifecycle_b, repeat('e', 64), repeat('f', 64), repeat('0', 64), 'OPEN', clock_timestamp() + interval '1 hour', repeat('1', 64));

  INSERT INTO payment_provider_account_refs_v7(
    provider_account_ref_id, provider_user_id, processor_code, external_reference_sha256,
    eligibility_state, merchant_capabilities, funding_state, restrictions_sha256,
    evidence_sha256, observed_at, expires_at
  )
  VALUES
    (provider_a, provider_a_user_id, 'PROCESSOR_A', repeat('2', 64), 'ELIGIBLE', '{}'::jsonb, 'READY', repeat('3', 64), repeat('4', 64), clock_timestamp(), clock_timestamp() + interval '1 hour'),
    (provider_b, provider_b_user_id, 'PROCESSOR_B', repeat('5', 64), 'ELIGIBLE', '{}'::jsonb, 'READY', repeat('6', 64), repeat('7', 64), clock_timestamp(), clock_timestamp() + interval '1 hour');

  INSERT INTO payment_conditional_provider_holds_v7(
    hold_id, lifecycle_id, opportunity_id, provider_account_ref_id, scope_sha256,
    provider_economics_sha256, schedule_sha256, state, accepted_at, expires_at, evidence_sha256
  )
  VALUES
    (hold_a, lifecycle_a, opportunity_a, provider_a, repeat('8', 64), repeat('9', 64), repeat('a', 64), 'SOFT_RESERVED', clock_timestamp(), clock_timestamp() + interval '30 minutes', repeat('b', 64)),
    (hold_b, lifecycle_b, opportunity_b, provider_b, repeat('c', 64), repeat('d', 64), repeat('e', 64), 'SOFT_RESERVED', clock_timestamp(), clock_timestamp() + interval '30 minutes', repeat('f', 64));

  INSERT INTO payment_method_refs_v7(
    payment_method_ref_id, customer_user_id, processor_code, external_reference_sha256,
    safe_metadata, consent_sha256, portability_scope, state
  )
  VALUES
    (payment_method_a, poster_id, 'PROCESSOR_A', repeat('0', 64), '{}'::jsonb, repeat('1', 64), 'NONE', 'READY'),
    (payment_method_b, poster_id, 'PROCESSOR_B', repeat('2', 64), '{}'::jsonb, repeat('3', 64), 'NONE', 'READY'),
    (payment_method_other, other_customer_id, 'PROCESSOR_A', repeat('4', 64), '{}'::jsonb, repeat('5', 64), 'NONE', 'READY');

  INSERT INTO payment_financial_security_events_v7(
    financial_security_event_id, lifecycle_id, task_draft_id, customer_user_id,
    hold_id, provider_account_ref_id, payment_method_ref_id, processor_code,
    merchant_context_sha256, amount_cents, currency, fee_routing_sha256,
    operation_id, idempotency_key, request_sha256
  )
  VALUES
    (fse_a, lifecycle_a, draft_a, poster_id, hold_a, provider_a, payment_method_a, 'PROCESSOR_A', repeat('4', 64), 5000, 'usd', repeat('5', 64), gen_random_uuid(), 'd2-fse-a-' || gen_random_uuid()::text, repeat('6', 64)),
    (fse_b, lifecycle_b, draft_b, poster_id, hold_b, provider_b, payment_method_b, 'PROCESSOR_B', repeat('7', 64), 7000, 'usd', repeat('8', 64), gen_random_uuid(), 'd2-fse-b-' || gen_random_uuid()::text, repeat('9', 64));

  INSERT INTO tasks(
    id, poster_id, title, description, price, state,
    hustler_payout_cents, platform_margin_cents, category, risk_level,
    requires_proof, automation_classification, region_code, region_policy_id,
    region_policy_version, region_policy_hash, region_policy_snapshot,
    trade_type, location_state, license_required, insurance_required,
    background_check_required, proof_min_photos, proof_max_photos,
    proof_gps_required, currency
  )
  SELECT
    fixture.id,
    fixture.task_poster_id,
    fixture.title,
    fixture.description,
    fixture.price,
    'OPEN',
    fixture.payout,
    fixture.margin,
    'moving',
    'LOW',
    TRUE,
    'CONTROLLED_TEST',
    p.region_code,
    p.id,
    p.version,
    p.policy_hash,
    pg_temp.hx_d2_policy_snapshot(p, 'moving', 'LOW'),
    'moving',
    'WA',
    (p.policy_document#>>'{categories,moving,credentials,licenseRequired}')::BOOLEAN,
    (p.policy_document#>>'{categories,moving,credentials,insuranceRequired}')::BOOLEAN,
    (p.policy_document#>>'{categories,moving,credentials,backgroundCheckRequired}')::BOOLEAN,
    (p.policy_document#>>'{categories,moving,evidence,minPhotos}')::INTEGER,
    (p.policy_document#>>'{categories,moving,evidence,maxPhotos}')::INTEGER,
    (p.policy_document#>>'{categories,moving,evidence,gpsRequired}')::BOOLEAN,
    p.policy_document#>>'{financial,currency}'
  FROM region_policies p
  CROSS JOIN (
    VALUES
      (task_a, poster_id, 'D2 task A', 'binding task A', 5000, 4000, 1000),
      (task_b, poster_id, 'D2 task B', 'binding task B', 7000, 5500, 1500),
      (cross_task, poster_id, 'D2 crossed task', 'binding attack task', 7000, 5500, 1500),
      (cross_customer_task, other_customer_id, 'D2 crossed-customer task', 'wrong poster binding attack', 5000, 4000, 1000)
  ) AS fixture(id, task_poster_id, title, description, price, payout, margin)
  WHERE p.region_code = 'US-WA'
    AND p.policy_state = 'ACTIVE'
  ORDER BY p.effective_from DESC
  LIMIT 4;

  UPDATE task_drafts
  SET task_id = CASE id
    WHEN draft_a THEN task_a
    WHEN draft_b THEN task_b
    ELSE task_id
  END
  WHERE id IN (draft_a, draft_b);

  BEGIN
    INSERT INTO payment_canonical_work_orders_v7(
      lifecycle_id, task_draft_id, customer_user_id,
      financial_security_event_id, provider_account_ref_id, processor_code,
      task_id, assigned_provider_user_id, scope_sha256, economics_sha256,
      materialization_command_id, materialization_sha256
    ) VALUES (
      lifecycle_a, draft_b, poster_id, fse_b, provider_b, 'PROCESSOR_B',
      cross_task, provider_b_user_id,
      repeat('2', 64), repeat('3', 64), gen_random_uuid(), repeat('4', 64)
    );
  EXCEPTION WHEN foreign_key_violation THEN
    crossed_work_order_rejected := TRUE;
  END;

  BEGIN
    INSERT INTO payment_canonical_work_orders_v7(
      lifecycle_id, task_draft_id, customer_user_id,
      financial_security_event_id, provider_account_ref_id, processor_code,
      task_id, assigned_provider_user_id, scope_sha256, economics_sha256,
      materialization_command_id, materialization_sha256
    ) VALUES (
      lifecycle_a, draft_a, poster_id, fse_a, provider_a, 'PROCESSOR_A',
      cross_customer_task, provider_a_user_id,
      repeat('5', 64), repeat('6', 64), gen_random_uuid(), repeat('7', 64)
    );
    RAISE EXCEPTION 'D2_TEST_ACCEPTED_CROSSED_TASK_POSTER' USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN foreign_key_violation OR check_violation OR SQLSTATE 'P0001' THEN
      crossed_task_poster_rejected := TRUE;
    WHEN SQLSTATE 'P0099' THEN
      NULL;
  END;

  INSERT INTO payment_canonical_work_orders_v7(
    work_order_id, lifecycle_id, task_draft_id, customer_user_id,
    financial_security_event_id, provider_account_ref_id,
    processor_code, task_id, assigned_provider_user_id, scope_sha256, economics_sha256,
    materialization_command_id, materialization_sha256
  )
  VALUES
    (work_order_a, lifecycle_a, draft_a, poster_id, fse_a, provider_a, 'PROCESSOR_A', task_a, provider_a_user_id, repeat('a', 64), repeat('b', 64), gen_random_uuid(), repeat('c', 64)),
    (work_order_b, lifecycle_b, draft_b, poster_id, fse_b, provider_b, 'PROCESSOR_B', task_b, provider_b_user_id, repeat('d', 64), repeat('e', 64), gen_random_uuid(), repeat('f', 64));

  BEGIN
    UPDATE tasks SET poster_id = other_customer_id WHERE id = task_a;
    RAISE EXCEPTION 'D2_TEST_ACCEPTED_TASK_POSTER_MUTATION' USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN foreign_key_violation OR check_violation OR SQLSTATE 'P0001' THEN
      task_poster_mutation_rejected := TRUE;
    WHEN SQLSTATE 'P0099' THEN
      NULL;
  END;

  BEGIN
    INSERT INTO payment_captures_v7(
      lifecycle_id, work_order_id, financial_security_event_id, processor_code,
      approved_amount_cents, currency, completion_evidence_sha256, amount_approval_sha256,
      incident_clearance_sha256, operation_id, idempotency_key, request_sha256
    ) VALUES (
      lifecycle_a, work_order_a, fse_b, 'PROCESSOR_A', 5000, 'usd', repeat('5', 64),
      repeat('6', 64), repeat('7', 64), gen_random_uuid(), 'd2-crossed-capture-' || gen_random_uuid()::text, repeat('8', 64)
    );
  EXCEPTION WHEN foreign_key_violation THEN
    crossed_capture_rejected := TRUE;
  END;

  INSERT INTO payment_captures_v7(
    capture_id, lifecycle_id, work_order_id, financial_security_event_id, processor_code,
    approved_amount_cents, currency, completion_evidence_sha256, amount_approval_sha256,
    incident_clearance_sha256, operation_id, idempotency_key, request_sha256
  )
  VALUES
    (capture_a, lifecycle_a, work_order_a, fse_a, 'PROCESSOR_A', 5000, 'usd', repeat('0', 64), repeat('1', 64), repeat('2', 64), gen_random_uuid(), 'd2-capture-a-' || gen_random_uuid()::text, repeat('3', 64)),
    (capture_b, lifecycle_b, work_order_b, fse_b, 'PROCESSOR_B', 7000, 'usd', repeat('4', 64), repeat('5', 64), repeat('6', 64), gen_random_uuid(), 'd2-capture-b-' || gen_random_uuid()::text, repeat('7', 64));

  BEGIN
    INSERT INTO payment_conditional_provider_holds_v7(
      lifecycle_id, opportunity_id, provider_account_ref_id, scope_sha256,
      provider_economics_sha256, schedule_sha256, state, accepted_at, expires_at, evidence_sha256
    ) VALUES (
      lifecycle_a, opportunity_b, provider_a, repeat('8', 64), repeat('9', 64), repeat('a', 64),
      'SOFT_RESERVED', clock_timestamp(), clock_timestamp() + interval '30 minutes', repeat('b', 64)
    );
  EXCEPTION WHEN foreign_key_violation THEN
    crossed_hold_rejected := TRUE;
  END;

  BEGIN
    INSERT INTO payment_financial_security_events_v7(
      lifecycle_id, task_draft_id, customer_user_id, hold_id, provider_account_ref_id,
      payment_method_ref_id, processor_code, merchant_context_sha256, amount_cents,
      currency, fee_routing_sha256, operation_id, idempotency_key, request_sha256
    ) VALUES (
      lifecycle_a, draft_b, poster_id, hold_b, provider_b, payment_method_b, 'PROCESSOR_B', repeat('c', 64),
      5000, 'usd', repeat('d', 64), gen_random_uuid(), 'd2-crossed-fse-' || gen_random_uuid()::text, repeat('e', 64)
    );
  EXCEPTION WHEN foreign_key_violation THEN
    crossed_fse_rejected := TRUE;
  END;

  BEGIN
    INSERT INTO payment_financial_security_events_v7(
      lifecycle_id, task_draft_id, customer_user_id, hold_id, provider_account_ref_id,
      payment_method_ref_id, processor_code, merchant_context_sha256, amount_cents,
      currency, fee_routing_sha256, operation_id, idempotency_key, request_sha256
    ) VALUES (
      lifecycle_a, draft_a, poster_id, hold_a, provider_a, payment_method_b, 'PROCESSOR_B', repeat('f', 64),
      5000, 'usd', repeat('0', 64), gen_random_uuid(), 'd2-crossed-processor-' || gen_random_uuid()::text, repeat('1', 64)
    );
  EXCEPTION WHEN foreign_key_violation THEN
    crossed_processor_rejected := TRUE;
  END;

  BEGIN
    INSERT INTO payment_financial_security_events_v7(
      lifecycle_id, task_draft_id, customer_user_id, hold_id, provider_account_ref_id,
      payment_method_ref_id, processor_code, merchant_context_sha256, amount_cents,
      currency, fee_routing_sha256, operation_id, idempotency_key, request_sha256
    ) VALUES (
      lifecycle_a, draft_a, other_customer_id, hold_a, provider_a, payment_method_other,
      'PROCESSOR_A', repeat('2', 64), 5000, 'usd', repeat('3', 64), gen_random_uuid(),
      'd2-crossed-customer-' || gen_random_uuid()::text, repeat('4', 64)
    );
  EXCEPTION WHEN foreign_key_violation THEN
    crossed_customer_rejected := TRUE;
  END;

  BEGIN
    INSERT INTO payment_settlement_records_v7(
      lifecycle_id, capture_id, processor_code, state, customer_amount_cents,
      provider_amount_cents, platform_amount_cents, currency,
      external_reference_sha256, evidence_sha256
    ) VALUES (
      lifecycle_b, capture_a, 'PROCESSOR_A', 'SETTLING', 5000, 4000, 1000, 'usd', repeat('9', 64), repeat('a', 64)
    );
  EXCEPTION WHEN foreign_key_violation THEN
    crossed_settlement_rejected := TRUE;
  END;

  BEGIN
    INSERT INTO payment_financial_security_events_v7(
      lifecycle_id, task_draft_id, customer_user_id, hold_id, provider_account_ref_id,
      payment_method_ref_id, processor_code, merchant_context_sha256, amount_cents,
      currency, fee_routing_sha256, operation_id, idempotency_key, state, request_sha256
    ) VALUES (
      lifecycle_a, draft_a, poster_id, hold_a, provider_a, payment_method_a, 'PROCESSOR_A', repeat('b', 64),
      5000, 'usd', repeat('c', 64), gen_random_uuid(), 'd2-nonplanned-fse-' || gen_random_uuid()::text, 'SECURED', repeat('d', 64)
    );
  EXCEPTION WHEN check_violation THEN
    nonplanned_fse_rejected := TRUE;
  END;

  BEGIN
    INSERT INTO payment_captures_v7(
      lifecycle_id, work_order_id, financial_security_event_id, processor_code,
      approved_amount_cents, currency, completion_evidence_sha256, amount_approval_sha256,
      incident_clearance_sha256, operation_id, idempotency_key, state, request_sha256
    ) VALUES (
      lifecycle_a, work_order_a, fse_a, 'PROCESSOR_A', 5000, 'usd', repeat('e', 64),
      repeat('f', 64), repeat('0', 64), gen_random_uuid(), 'd2-nonplanned-capture-' || gen_random_uuid()::text, 'CAPTURED', repeat('1', 64)
    );
  EXCEPTION WHEN check_violation THEN
    nonplanned_capture_rejected := TRUE;
  END;

  BEGIN
    INSERT INTO payment_underwriting_lifecycle_events_v7(
      lifecycle_id, task_draft_id, sequence_number, command_id, stage, actor_type,
      poster_user_id,
      evidence_sha256, event_material, event_sha256
    ) VALUES (
      lifecycle_a, draft_a, 1, gen_random_uuid(), 'TASK_DRAFT', 'POSTER', poster_id,
      repeat('2', 64), '{}'::jsonb, repeat('3', 64)
    );
  EXCEPTION WHEN check_violation THEN
    spoofed_actor_rejected := TRUE;
  END;

  BEGIN
    INSERT INTO payment_underwriting_lifecycle_events_v7(
      lifecycle_id, task_draft_id, sequence_number, command_id, stage,
      actor_type, actor_user_id, poster_user_id,
      evidence_sha256, event_material, event_sha256
    ) VALUES (
      lifecycle_a, draft_a, 1, gen_random_uuid(), 'TASK_DRAFT',
      'POSTER', other_customer_id, other_customer_id,
      repeat('4', 64), '{}'::jsonb, repeat('5', 64)
    );
    RAISE EXCEPTION 'D2_TEST_ACCEPTED_SPOOFED_POSTER' USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN foreign_key_violation OR check_violation OR SQLSTATE 'P0001' THEN
      spoofed_poster_identity_rejected := TRUE;
    WHEN SQLSTATE 'P0099' THEN
      NULL;
  END;

  BEGIN
    INSERT INTO payment_underwriting_lifecycle_events_v7(
      lifecycle_id, task_draft_id, sequence_number, command_id, stage,
      actor_type, actor_user_id,
      evidence_sha256, event_material, event_sha256
    ) VALUES (
      lifecycle_a, draft_a, 1, gen_random_uuid(), 'TASK_DRAFT',
      'POSTER', poster_id,
      repeat('6', 64), '{}'::jsonb,
      encode(digest(lifecycle_a::text || ':null-poster-bypass', 'sha256'), 'hex')
    );
    RAISE EXCEPTION 'D2_TEST_ACCEPTED_NULL_POSTER' USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN foreign_key_violation OR check_violation OR SQLSTATE 'P0001' THEN
      null_poster_identity_rejected := TRUE;
    WHEN SQLSTATE 'P0099' THEN
      NULL;
  END;

  INSERT INTO payment_underwriting_lifecycle_events_v7(
    lifecycle_id, task_draft_id, sequence_number, command_id, stage,
    actor_type, actor_user_id, poster_user_id,
    evidence_sha256, event_material, event_sha256
  ) VALUES (
    lifecycle_a, draft_a, 1, gen_random_uuid(), 'TASK_DRAFT',
    'POSTER', poster_id, poster_id,
    repeat('6', 64), '{}'::jsonb,
    encode(digest(lifecycle_a::text || ':valid-poster-event', 'sha256'), 'hex')
  );

  IF NOT crossed_hold_rejected
    OR NOT crossed_fse_rejected
    OR NOT crossed_processor_rejected
    OR NOT crossed_customer_rejected
    OR NOT crossed_work_order_rejected
    OR NOT crossed_capture_rejected
    OR NOT crossed_settlement_rejected
    OR NOT nonplanned_fse_rejected
    OR NOT nonplanned_capture_rejected
    OR NOT spoofed_actor_rejected
    OR NOT spoofed_poster_identity_rejected
    OR NOT null_poster_identity_rejected
    OR NOT crossed_task_poster_rejected
    OR NOT task_poster_mutation_rejected
  THEN
    RAISE EXCEPTION 'neutral lifecycle identity matrix failed: hold %, fse %, processor %, customer %, work %, task poster %, task poster mutation %, capture %, settlement %, fse state %, capture state %, actor %, poster actor %, null poster %',
      crossed_hold_rejected,
      crossed_fse_rejected,
      crossed_processor_rejected,
      crossed_customer_rejected,
      crossed_work_order_rejected,
      crossed_task_poster_rejected,
      task_poster_mutation_rejected,
      crossed_capture_rejected,
      crossed_settlement_rejected,
      nonplanned_fse_rejected,
      nonplanned_capture_rejected,
      spoofed_actor_rejected,
      spoofed_poster_identity_rejected,
      null_poster_identity_rejected;
  END IF;
END;
$$;

DO $$
DECLARE
  platform_draft UUID := gen_random_uuid();
  provider_draft UUID := gen_random_uuid();
  platform_lifecycle UUID := gen_random_uuid();
  provider_lifecycle UUID := gen_random_uuid();
  platform_stages TEXT[] := ARRAY[
    'TASK_DRAFT', 'SCOPE_READY', 'QUOTED', 'QUOTE_APPROVED',
    'PAYMENT_METHOD_READY', 'PROVIDER_SOURCING', 'PAYMENT_ELIGIBLE',
    'PROVIDER_SOFT_RESERVED', 'FINANCIAL_SECURITY_PENDING',
    'FINANCIALLY_SECURED', 'WORK_ORDER_MATERIALIZED', 'ASSIGNED',
    'IN_PROGRESS', 'COMPLETION_SUBMITTED', 'CAPTURE_PENDING', 'CAPTURED',
    'SETTLING', 'FUNDED', 'RECONCILED', 'CLOSED'
  ];
  provider_stages TEXT[] := ARRAY[
    'TASK_DRAFT', 'SCOPE_READY', 'ESTIMATE_REQUIRED', 'QUOTE_APPROVED',
    'PAYMENT_METHOD_READY', 'PROVIDER_SOURCING', 'PAYMENT_ELIGIBLE',
    'PROVIDER_SOFT_RESERVED', 'FINANCIAL_SECURITY_PENDING',
    'FINANCIALLY_SECURED', 'WORK_ORDER_MATERIALIZED', 'ASSIGNED',
    'IN_PROGRESS', 'COMPLETION_SUBMITTED', 'CAPTURE_PENDING', 'CAPTURED',
    'PAYOUT_PENDING', 'PAID_OUT', 'RECONCILED', 'CLOSED'
  ];
  current_stage TEXT;
  previous_event UUID;
  next_event UUID;
  sequence_number INTEGER;
  platform_closed_rejected BOOLEAN := FALSE;
  provider_closed_rejected BOOLEAN := FALSE;
BEGIN
  INSERT INTO task_drafts(id, submission_id, card_token_hash, raw_input)
  VALUES
    (platform_draft, gen_random_uuid(), 'd2-platform-walk-' || platform_draft::text, 'platform lifecycle walk'),
    (provider_draft, gen_random_uuid(), 'd2-provider-walk-' || provider_draft::text, 'provider lifecycle walk');

  INSERT INTO payment_underwriting_lifecycles_v7(
    lifecycle_id, task_draft_id, request_id, pricing_lane,
    authority_document_id, authority_drive_revision, authority_docs_revision,
    authority_text_sha256
  )
  VALUES
    (platform_lifecycle, platform_draft, gen_random_uuid(), 'PLATFORM_PRICED',
     '1PYpWdbnlhRBoovc6GfTyxMuu1IzMIdDQpV6hHHraXaQ', '7',
     'AIroW37g_sqKNU_dvvRNUndw-qUeooFwAYIHqN60aHvPSR178sKjMMu5rMzGTzODqgDKERue3ZbAT8UesInsUZvT6p1Z0bUvPByrgwaPDA',
     'ba8dc04bfc43feb24bd78698c6e5b820ecdf22177f915fb04856a55d8076bd26'),
    (provider_lifecycle, provider_draft, gen_random_uuid(), 'PROVIDER_ESTIMATE',
     '1PYpWdbnlhRBoovc6GfTyxMuu1IzMIdDQpV6hHHraXaQ', '7',
     'AIroW37g_sqKNU_dvvRNUndw-qUeooFwAYIHqN60aHvPSR178sKjMMu5rMzGTzODqgDKERue3ZbAT8UesInsUZvT6p1Z0bUvPByrgwaPDA',
     'ba8dc04bfc43feb24bd78698c6e5b820ecdf22177f915fb04856a55d8076bd26');

  previous_event := NULL;
  sequence_number := 0;
  FOREACH current_stage IN ARRAY platform_stages LOOP
    sequence_number := sequence_number + 1;
    next_event := gen_random_uuid();
    INSERT INTO payment_underwriting_lifecycle_events_v7(
      event_id, lifecycle_id, task_draft_id, sequence_number, prior_event_id, command_id, stage,
      actor_type, evidence_sha256, event_material, event_sha256
    ) VALUES (
      next_event, platform_lifecycle, platform_draft, sequence_number, previous_event, gen_random_uuid(),
      current_stage, 'SYSTEM',
      encode(digest('platform:evidence:' || sequence_number::text, 'sha256'), 'hex'),
      jsonb_build_object('schema', 'HX_PAYMENT_UNDERWRITING_LIFECYCLE_EVENT_V7'),
      encode(digest(platform_lifecycle::text || ':' || current_stage || ':' || sequence_number::text, 'sha256'), 'hex')
    );
    previous_event := next_event;
  END LOOP;

  IF (SELECT stage FROM payment_underwriting_lifecycle_status_v7 WHERE lifecycle_id = platform_lifecycle)
    IS DISTINCT FROM 'CLOSED'
  THEN
    RAISE EXCEPTION 'platform-priced lifecycle did not close';
  END IF;

  BEGIN
    INSERT INTO payment_underwriting_lifecycle_events_v7(
      lifecycle_id, task_draft_id, sequence_number, prior_event_id, command_id, stage,
      actor_type, evidence_sha256, event_material, event_sha256
    ) VALUES (
      platform_lifecycle, platform_draft, sequence_number + 1, previous_event, gen_random_uuid(), 'TASK_DRAFT',
      'SYSTEM', repeat('a', 64), '{}'::jsonb,
      encode(digest(platform_lifecycle::text || ':after-closed', 'sha256'), 'hex')
    );
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    platform_closed_rejected := TRUE;
  END;

  previous_event := NULL;
  sequence_number := 0;
  FOREACH current_stage IN ARRAY provider_stages LOOP
    sequence_number := sequence_number + 1;
    next_event := gen_random_uuid();
    INSERT INTO payment_underwriting_lifecycle_events_v7(
      event_id, lifecycle_id, task_draft_id, sequence_number, prior_event_id, command_id, stage,
      actor_type, evidence_sha256, event_material, event_sha256
    ) VALUES (
      next_event, provider_lifecycle, provider_draft, sequence_number, previous_event, gen_random_uuid(),
      current_stage, 'SYSTEM',
      encode(digest('provider:evidence:' || sequence_number::text, 'sha256'), 'hex'),
      jsonb_build_object('schema', 'HX_PAYMENT_UNDERWRITING_LIFECYCLE_EVENT_V7'),
      encode(digest(provider_lifecycle::text || ':' || current_stage || ':' || sequence_number::text, 'sha256'), 'hex')
    );
    previous_event := next_event;
  END LOOP;

  IF (SELECT stage FROM payment_underwriting_lifecycle_status_v7 WHERE lifecycle_id = provider_lifecycle)
    IS DISTINCT FROM 'CLOSED'
  THEN
    RAISE EXCEPTION 'provider-estimate lifecycle did not close';
  END IF;

  BEGIN
    INSERT INTO payment_underwriting_lifecycle_events_v7(
      lifecycle_id, task_draft_id, sequence_number, prior_event_id, command_id, stage,
      actor_type, evidence_sha256, event_material, event_sha256
    ) VALUES (
      provider_lifecycle, provider_draft, sequence_number + 1, previous_event, gen_random_uuid(), 'TASK_DRAFT',
      'SYSTEM', repeat('b', 64), '{}'::jsonb,
      encode(digest(provider_lifecycle::text || ':after-closed', 'sha256'), 'hex')
    );
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    provider_closed_rejected := TRUE;
  END;

  IF NOT platform_closed_rejected OR NOT provider_closed_rejected THEN
    RAISE EXCEPTION 'closed lifecycle accepted a successor: platform %, provider %',
      platform_closed_rejected, provider_closed_rejected;
  END IF;
END;
$$;

ROLLBACK;
