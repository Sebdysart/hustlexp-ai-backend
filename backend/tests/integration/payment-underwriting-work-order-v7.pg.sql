\if :{?HXP_D6_COMPOSED}
\else
BEGIN;
\endif

SET LOCAL hustlexp.local_test_identity_enabled = 'true';

CREATE OR REPLACE FUNCTION pg_temp.hxp_d5_policy_snapshot_v7(
  p region_policies,
  p_category TEXT,
  p_risk TEXT
)
RETURNS JSONB LANGUAGE SQL IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'policyId', p.id::TEXT,
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

\set HXP_D5_COMPOSED true
\ir payment-underwriting-fse-operation-v7.pg.sql
\unset HXP_D5_COMPOSED
\ir ../../database/migrations/20260823_payment_underwriting_work_order_materialization_v7.sql

SAVEPOINT d5_void_outcome;

DO $$
DECLARE
  fixture hxp_d4_composed_fixture_v7%ROWTYPE;
  materialization_authority_id UUID := gen_random_uuid();
  planned_task_id UUID := gen_random_uuid();
  materialization_command_id UUID := gen_random_uuid();
  obligation_id UUID := gen_random_uuid();
  void_operation_id UUID := gen_random_uuid();
  authorized_at TIMESTAMPTZ := clock_timestamp();
  expires_at TIMESTAMPTZ;
  planned_at TIMESTAMPTZ;
  authority_sha TEXT;
  obligation_sha TEXT;
BEGIN
  SELECT * INTO fixture FROM hxp_d4_composed_fixture_v7;
  expires_at := fixture.provider_expires_at - INTERVAL '30 seconds';
  planned_at := authorized_at + INTERVAL '1 millisecond';
  authority_sha := hxos_payment_work_order_materialization_authority_sha256_v7(
    materialization_authority_id, fixture.lifecycle_id, fixture.draft_id,
    fixture.poster_id, fixture.financial_security_event_id, fixture.hold_id,
    fixture.provider_account_ref_id, fixture.provider_id, 'CANDIDATE_SANDBOX',
    planned_task_id, materialization_command_id, fixture.agreement_sha256::TEXT,
    fixture.scope_sha256::TEXT, fixture.economics_sha256::TEXT,
    authorized_at, expires_at
  );
  INSERT INTO payment_work_order_materialization_authorities_v7(
    materialization_authority_id, lifecycle_id, task_draft_id, customer_user_id,
    financial_security_event_id, hold_id, provider_account_ref_id,
    provider_user_id, processor_code, planned_task_id,
    materialization_command_id, agreement_sha256, scope_sha256,
    economics_sha256, authorized_at, expires_at, authority_sha256
  ) VALUES (
    materialization_authority_id, fixture.lifecycle_id, fixture.draft_id,
    fixture.poster_id, fixture.financial_security_event_id, fixture.hold_id,
    fixture.provider_account_ref_id, fixture.provider_id, 'CANDIDATE_SANDBOX',
    planned_task_id, materialization_command_id, fixture.agreement_sha256,
    fixture.scope_sha256, fixture.economics_sha256, authorized_at, expires_at,
    authority_sha
  );

  obligation_sha := hxos_payment_work_order_void_obligation_sha256_v7(
    obligation_id, materialization_authority_id, fixture.lifecycle_id,
    fixture.financial_security_event_id, fixture.operation_id,
    void_operation_id, 'CANDIDATE_SANDBOX',
    'hx-fse-void-v7:' || void_operation_id::TEXT,
    'TASK_MATERIALIZATION_FAILED', repeat('a', 64), planned_at, repeat('b', 64)
  );
  INSERT INTO payment_work_order_void_obligations_v7(
    obligation_id, materialization_authority_id, lifecycle_id,
    financial_security_event_id, original_operation_id, void_operation_id,
    processor_code, idempotency_key, reason_code, request_sha256,
    evidence_sha256, planned_at, obligation_sha256
  ) VALUES (
    obligation_id, materialization_authority_id, fixture.lifecycle_id,
    fixture.financial_security_event_id, fixture.operation_id, void_operation_id,
    'CANDIDATE_SANDBOX', 'hx-fse-void-v7:' || void_operation_id::TEXT,
    'TASK_MATERIALIZATION_FAILED', repeat('a', 64), repeat('b', 64),
    planned_at, obligation_sha
  );
END;
$$;

SET CONSTRAINTS ALL IMMEDIATE;

DO $$
DECLARE
  authority_count BIGINT;
  obligation_count BIGINT;
  work_order_count BIGINT;
BEGIN
  SELECT count(*) INTO authority_count
    FROM payment_work_order_materialization_authorities_v7;
  SELECT count(*) INTO obligation_count FROM payment_work_order_void_obligations_v7;
  SELECT count(*) INTO work_order_count FROM payment_canonical_work_orders_v7;
  IF authority_count <> 1 OR obligation_count <> 1 OR work_order_count <> 0 THEN
    RAISE EXCEPTION 'D5 void outcome is not exclusive: %', jsonb_build_object(
      'authorities', authority_count,
      'obligations', obligation_count,
      'workOrders', work_order_count
    );
  END IF;
END;
$$;

ROLLBACK TO SAVEPOINT d5_void_outcome;
SET CONSTRAINTS payment_work_order_materialization_bundle_v7 DEFERRED;

-- A full canonical startup installs assignment identity guards. Establish
-- provider-owned CONTROLLED_TEST evidence when that contract is present so
-- this rollback-only harness reaches the D5 materialization invariants instead
-- of failing on unrelated production-identity policy.
DO $$
DECLARE
  fixture hxp_d4_composed_fixture_v7%ROWTYPE;
  consent_id UUID := gen_random_uuid();
  identity_case_id UUID;
BEGIN
  SELECT * INTO fixture FROM hxp_d4_composed_fixture_v7;
  IF to_regclass('public.identity_verification_consents') IS NOT NULL
     AND to_regprocedure(
       'begin_identity_verification_case_v1(uuid,uuid,text,text,text,boolean,text,text,timestamptz)'
     ) IS NOT NULL
     AND to_regprocedure(
       'record_identity_verification_event_v1(uuid,uuid,text,text,text,text,timestamptz,timestamptz,uuid)'
     ) IS NOT NULL THEN
    INSERT INTO identity_verification_consents(
      id, user_id, provider, provider_environment, is_test, policy_version,
      disclosure_hash, purpose, idempotency_key
    ) VALUES (
      consent_id, fixture.provider_id, 'local_certification_identity',
      'CONTROLLED_TEST', TRUE, 'hxos-d5-controlled-identity-v1', repeat('4', 64),
      'Controlled TEST identity evidence for the rollback-only D5 contract.',
      'hxp-d5-identity-consent-' || fixture.provider_id::TEXT
    );
    SELECT identity.case_id INTO identity_case_id
      FROM begin_identity_verification_case_v1(
        fixture.provider_id, consent_id, 'local_certification_identity',
        'idv_hxos_test_' || replace(fixture.provider_id::TEXT, '-', ''),
        'CONTROLLED_TEST', TRUE, 'hxos-d5-controlled-identity-v1',
        repeat('5', 64), clock_timestamp() + INTERVAL '90 days'
      ) AS identity;
    PERFORM * FROM record_identity_verification_event_v1(
      fixture.provider_id, identity_case_id,
      'hxp-d5-identity-verified-' || fixture.provider_id::TEXT,
      'VERIFIED', repeat('6', 64), repeat('7', 64), clock_timestamp(),
      clock_timestamp() + INTERVAL '90 days', fixture.provider_id
    );
  END IF;
END;
$$;

-- Reproduce the canonical controlled-TEST worker prerequisites inside this
-- transaction. These rows remain isolated from production providers and are
-- rolled back with the contract fixture.
SET LOCAL hustlexp.local_test_screening_enabled = 'true';
SET LOCAL hustlexp.local_test_payout_enabled = 'true';
SET LOCAL hustlexp.local_test_duration_enabled = 'true';
SET LOCAL hustlexp.local_test_provider_capability_enabled = 'true';
SET LOCAL hustlexp.local_test_liquidity_enabled = 'true';
SET LOCAL hustlexp.local_test_offer_review_enabled = 'true';

DO $$
DECLARE
  fixture hxp_d4_composed_fixture_v7%ROWTYPE;
  screening_consent_id UUID := gen_random_uuid();
  background_check_id UUID := gen_random_uuid();
  provider_phone TEXT;
  screening_report_id TEXT;
  payout_destination_id TEXT;
BEGIN
  SELECT * INTO fixture FROM hxp_d4_composed_fixture_v7;
  provider_phone := '+1206' || translate(
    substr(replace(fixture.provider_id::TEXT, '-', ''), 1, 7),
    'abcdef', '012345'
  );
  screening_report_id := 'scr_hxos_test_' || replace(fixture.provider_id::TEXT, '-', '');
  payout_destination_id := 'pd_hxos_test_' || replace(fixture.provider_id::TEXT, '-', '');

  UPDATE users
     SET phone = provider_phone,
         date_of_birth = DATE '1990-01-01',
         is_minor = FALSE,
         account_status = 'ACTIVE',
         trust_hold = FALSE,
         is_banned = FALSE
   WHERE id = fixture.provider_id;

  INSERT INTO engine_hustler_identity_links(
    provider_claim_id, user_id, phone_hash
  ) VALUES (
    gen_random_uuid(), fixture.provider_id,
    encode(digest(provider_phone, 'sha256'), 'hex')
  );

  INSERT INTO worker_screening_consents(
    id, worker_id, provider, disclosure_version, disclosure_hash,
    policy_version, purpose, consent_granted,
    disclosure_presented_standalone, purpose_acknowledged,
    rights_summary_acknowledged, request_hash, idempotency_key
  ) VALUES (
    screening_consent_id, fixture.provider_id, 'local_certification_test',
    'hx-worker-screening-local-test-v1',
    'c059a2d7b341b9f951a97f9e28a93afe3f763015a0c7ffd8bd9f7f15ab2e8565',
    'worker-screening-rights-v1',
    'Exercise consent-bound eligibility controls for CONTROLLED_TEST work only; no external background or consumer report is ordered.',
    TRUE, TRUE, TRUE, TRUE, repeat('1', 64),
    'hxp-d5-screening-consent-' || fixture.provider_id::TEXT
  );

  INSERT INTO background_checks(
    id, user_id, provider, check_id, status, initiated_at, expires_at,
    details, screening_consent_id, provider_environment, is_test
  ) VALUES (
    background_check_id, fixture.provider_id, 'local_certification_test',
    screening_report_id, 'PENDING', clock_timestamp(),
    clock_timestamp() + INTERVAL '1 year',
    jsonb_build_object('providerEnvironment', 'CONTROLLED_TEST', 'isTest', TRUE),
    screening_consent_id, 'CONTROLLED_TEST', TRUE
  );
  INSERT INTO hxos_local_test_screening_reports(
    id, background_check_id, worker_id, consent_id, status,
    request_hash, idempotency_key, expires_at
  ) VALUES (
    screening_report_id, background_check_id, fixture.provider_id,
    screening_consent_id, 'PENDING', repeat('2', 64),
    'hxp-d5-screening-report-' || fixture.provider_id::TEXT,
    clock_timestamp() + INTERVAL '1 year'
  );
  UPDATE hxos_local_test_screening_reports
     SET status = 'PROCESSING', updated_at = clock_timestamp()
   WHERE id = screening_report_id;
  UPDATE hxos_local_test_screening_reports
     SET status = 'CLEAR',
         result_summary = 'Controlled TEST clear fixture; no external report ordered.',
         completed_at = clock_timestamp(),
         updated_at = clock_timestamp()
   WHERE id = screening_report_id;
  UPDATE background_checks
     SET status = 'CLEAR',
         completed_at = clock_timestamp(),
         result_summary = 'Controlled TEST clear fixture; no external report ordered.'
   WHERE id = background_check_id;

  INSERT INTO capability_profiles(
    user_id, trust_tier, risk_clearance, location_state, location_city,
    background_check_valid, background_check_expires_at,
    background_check_source_id, background_check_provider,
    background_check_environment, background_check_is_test, updated_at
  ) VALUES (
    fixture.provider_id, 2, ARRAY['low']::TEXT[], 'WA', 'Seattle',
    TRUE, clock_timestamp() + INTERVAL '1 year', background_check_id,
    'local_certification_test', 'CONTROLLED_TEST', TRUE, clock_timestamp()
  ) ON CONFLICT (user_id) DO UPDATE SET
    trust_tier = EXCLUDED.trust_tier,
    risk_clearance = EXCLUDED.risk_clearance,
    location_state = EXCLUDED.location_state,
    location_city = EXCLUDED.location_city,
    background_check_valid = EXCLUDED.background_check_valid,
    background_check_expires_at = EXCLUDED.background_check_expires_at,
    background_check_source_id = EXCLUDED.background_check_source_id,
    background_check_provider = EXCLUDED.background_check_provider,
    background_check_environment = EXCLUDED.background_check_environment,
    background_check_is_test = EXCLUDED.background_check_is_test,
    updated_at = EXCLUDED.updated_at;

  INSERT INTO hxos_local_test_payout_destinations(
    id, worker_id, destination_fingerprint, status, is_test
  ) VALUES (
    payout_destination_id, fixture.provider_id, repeat('3', 64), 'ACTIVE', TRUE
  );
END;
$$;

DO $$
<<d5_test>>
DECLARE
  fixture hxp_d4_composed_fixture_v7%ROWTYPE;
  materialization_authority_id UUID := gen_random_uuid();
  task_id UUID := gen_random_uuid();
  materialization_command_id UUID := gen_random_uuid();
  work_order_id UUID := gen_random_uuid();
  assignment_id UUID := gen_random_uuid();
  grant_id UUID := gen_random_uuid();
  access_event_id UUID := gen_random_uuid();
  regression_access_event_id UUID := gen_random_uuid();
  expired_access_event_id UUID := gen_random_uuid();
  duration_evidence_id UUID := gen_random_uuid();
  provider_capability_evidence_id UUID := gen_random_uuid();
  liquidity_cell_id UUID := gen_random_uuid();
  liquidity_witness_id UUID := gen_random_uuid();
  offer_decision_id UUID := gen_random_uuid();
  review_action_id UUID := gen_random_uuid();
  accepted_action_id UUID := gen_random_uuid();
  wrong_void_obligation_id UUID := gen_random_uuid();
  wrong_void_operation_id UUID := gen_random_uuid();
  work_order_event_id UUID := gen_random_uuid();
  assigned_event_id UUID := gen_random_uuid();
  authorized_at TIMESTAMPTZ := clock_timestamp();
  expires_at TIMESTAMPTZ;
  work_order_created_at TIMESTAMPTZ;
  assigned_at TIMESTAMPTZ;
  granted_at TIMESTAMPTZ;
  wrong_void_planned_at TIMESTAMPTZ;
  offer_issued_at TIMESTAMPTZ;
  offer_expires_at TIMESTAMPTZ;
  capability_expires_at TIMESTAMPTZ;
  authority_sha TEXT;
  wrong_scope_authority_sha TEXT;
  work_order_sha TEXT;
  assignment_sha TEXT;
  grant_sha TEXT;
  wrong_void_sha TEXT;
  offer_snapshot JSONB;
  wrong_customer_rejected BOOLEAN := FALSE;
  wrong_scope_rejected BOOLEAN := FALSE;
  preconverted_draft_rejected BOOLEAN := FALSE;
  partial_graph_rejected BOOLEAN := FALSE;
  wrong_void_rejected BOOLEAN := FALSE;
  authority_update_rejected BOOLEAN := FALSE;
  grant_delete_rejected BOOLEAN := FALSE;
  access_truncate_rejected BOOLEAN := FALSE;
  access_hash_tamper_rejected BOOLEAN := FALSE;
  access_time_regression_rejected BOOLEAN := FALSE;
  expired_vault_access_rejected BOOLEAN := FALSE;
BEGIN
  SELECT * INTO fixture FROM hxp_d4_composed_fixture_v7;
  expires_at := fixture.provider_expires_at - INTERVAL '30 seconds';

  authority_sha := hxos_payment_work_order_materialization_authority_sha256_v7(
    materialization_authority_id, fixture.lifecycle_id, fixture.draft_id,
    fixture.poster_id, fixture.financial_security_event_id, fixture.hold_id,
    fixture.provider_account_ref_id, fixture.provider_id, 'CANDIDATE_SANDBOX',
    task_id, materialization_command_id, fixture.agreement_sha256::TEXT,
    fixture.scope_sha256::TEXT, fixture.economics_sha256::TEXT,
    authorized_at, expires_at
  );
  wrong_scope_authority_sha := hxos_payment_work_order_materialization_authority_sha256_v7(
    materialization_authority_id, fixture.lifecycle_id, fixture.draft_id,
    fixture.poster_id, fixture.financial_security_event_id, fixture.hold_id,
    fixture.provider_account_ref_id, fixture.provider_id, 'CANDIDATE_SANDBOX',
    task_id, materialization_command_id, fixture.agreement_sha256::TEXT,
    repeat('9', 64), fixture.economics_sha256::TEXT,
    authorized_at, expires_at
  );
  BEGIN
    INSERT INTO payment_work_order_materialization_authorities_v7(
      materialization_authority_id, lifecycle_id, task_draft_id, customer_user_id,
      financial_security_event_id, hold_id, provider_account_ref_id,
      provider_user_id, processor_code, planned_task_id,
      materialization_command_id, agreement_sha256, scope_sha256,
      economics_sha256, authorized_at, expires_at, authority_sha256
    ) VALUES (
      materialization_authority_id, fixture.lifecycle_id, fixture.draft_id,
      fixture.poster_id, fixture.financial_security_event_id, fixture.hold_id,
      fixture.provider_account_ref_id, fixture.provider_id, 'CANDIDATE_SANDBOX',
      task_id, materialization_command_id, fixture.agreement_sha256,
      repeat('9', 64), fixture.economics_sha256, authorized_at, expires_at,
      wrong_scope_authority_sha
    );
    RAISE EXCEPTION 'D5_TEST_ACCEPTED_CROSSED_SCOPE' USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN wrong_scope_rejected := TRUE;
    WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  BEGIN
    INSERT INTO tasks(
      id, poster_id, title, description, category, price,
      hustler_payout_cents, platform_margin_cents, state, scope_hash,
      automation_classification, rough_location, region_code,
      region_policy_id, region_policy_version, region_policy_hash,
      region_policy_snapshot, trade_type, location_state,
      license_required, insurance_required, background_check_required,
      requires_proof, proof_min_photos, proof_max_photos,
      proof_gps_required, currency, template_slug, trust_tier_required,
      completion_criteria, cancellation_window_hours, late_cancel_pct,
      cancellation_policy_version, required_tools
    )
    SELECT
      task_id, fixture.poster_id,
      'D5 preconverted attack', 'D5 preconverted attack', 'yard', 5000,
      4000, 1000, 'OPEN', fixture.scope_sha256,
      'CONTROLLED_TEST', 'Seattle, WA', p.region_code,
      p.id, p.version, p.policy_hash,
      pg_temp.hxp_d5_policy_snapshot_v7(p, 'yard', 'LOW'),
      'yard', 'WA', FALSE, FALSE, FALSE,
      TRUE, 1, 5, FALSE, 'usd', 'standard_physical', 1,
      jsonb_build_object('steps', jsonb_build_array('Complete the yard work.')),
      24, 0, 'task-template-v2:standard_physical:0', ARRAY['hand truck']::TEXT[]
    FROM region_policies p
    WHERE p.region_code = 'US-WA' AND p.policy_state = 'ACTIVE';
    UPDATE task_drafts SET task_id = d5_test.task_id WHERE id = fixture.draft_id;
    INSERT INTO payment_work_order_materialization_authorities_v7(
      materialization_authority_id, lifecycle_id, task_draft_id, customer_user_id,
      financial_security_event_id, hold_id, provider_account_ref_id,
      provider_user_id, processor_code, planned_task_id,
      materialization_command_id, agreement_sha256, scope_sha256,
      economics_sha256, authorized_at, expires_at, authority_sha256
    ) VALUES (
      materialization_authority_id, fixture.lifecycle_id, fixture.draft_id,
      fixture.poster_id, fixture.financial_security_event_id, fixture.hold_id,
      fixture.provider_account_ref_id, fixture.provider_id, 'CANDIDATE_SANDBOX',
      task_id, materialization_command_id, fixture.agreement_sha256,
      fixture.scope_sha256, fixture.economics_sha256, authorized_at, expires_at,
      authority_sha
    );
    RAISE EXCEPTION 'D5_TEST_ACCEPTED_PRECONVERTED_DRAFT' USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN preconverted_draft_rejected := TRUE;
    WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  BEGIN
    INSERT INTO payment_work_order_materialization_authorities_v7(
      materialization_authority_id, lifecycle_id, task_draft_id, customer_user_id,
      financial_security_event_id, hold_id, provider_account_ref_id,
      provider_user_id, processor_code, planned_task_id,
      materialization_command_id, agreement_sha256, scope_sha256,
      economics_sha256, authorized_at, expires_at, authority_sha256
    ) VALUES (
      materialization_authority_id, fixture.lifecycle_id, fixture.draft_id,
      fixture.poster_id, fixture.financial_security_event_id, fixture.hold_id,
      fixture.provider_account_ref_id, fixture.provider_id, 'CANDIDATE_SANDBOX',
      task_id, materialization_command_id, fixture.agreement_sha256,
      fixture.scope_sha256, fixture.economics_sha256, authorized_at, expires_at,
      authority_sha
    );
    EXECUTE 'SET CONSTRAINTS payment_work_order_materialization_bundle_v7 IMMEDIATE';
    RAISE EXCEPTION 'D5_TEST_ACCEPTED_PARTIAL_GRAPH' USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN partial_graph_rejected := TRUE;
    WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  INSERT INTO payment_work_order_materialization_authorities_v7(
    materialization_authority_id, lifecycle_id, task_draft_id, customer_user_id,
    financial_security_event_id, hold_id, provider_account_ref_id,
    provider_user_id, processor_code, planned_task_id,
    materialization_command_id, agreement_sha256, scope_sha256,
    economics_sha256, authorized_at, expires_at, authority_sha256
  ) VALUES (
    materialization_authority_id, fixture.lifecycle_id, fixture.draft_id,
    fixture.poster_id, fixture.financial_security_event_id, fixture.hold_id,
    fixture.provider_account_ref_id, fixture.provider_id, 'CANDIDATE_SANDBOX',
    task_id, materialization_command_id, fixture.agreement_sha256,
    fixture.scope_sha256, fixture.economics_sha256, authorized_at, expires_at,
    authority_sha
  );

  INSERT INTO tasks(
    id, poster_id, title, description, category, price,
    hustler_payout_cents, platform_margin_cents, state, scope_hash,
    automation_classification, rough_location, region_code,
    region_policy_id, region_policy_version, region_policy_hash,
    region_policy_snapshot, trade_type, location_state,
    license_required, insurance_required, background_check_required,
    requires_proof, proof_min_photos, proof_max_photos,
    proof_gps_required, currency, template_slug, trust_tier_required,
    completion_criteria, cancellation_window_hours, late_cancel_pct,
    cancellation_policy_version, required_tools
  )
  SELECT
    task_id, fixture.poster_id,
    'D5 atomic Work Order', 'D5 sealed materialization fixture', 'yard', 5000,
    4000, 1000, 'OPEN', fixture.scope_sha256,
    'CONTROLLED_TEST', 'Seattle, WA', p.region_code,
    p.id, p.version, p.policy_hash,
    pg_temp.hxp_d5_policy_snapshot_v7(p, 'yard', 'LOW'),
    'yard', 'WA', FALSE, FALSE, FALSE,
    TRUE, 1, 5, FALSE, 'usd', 'standard_physical', 1,
    jsonb_build_object('steps', jsonb_build_array('Complete the yard work.')),
    24, 0, 'task-template-v2:standard_physical:0', ARRAY['hand truck']::TEXT[]
  FROM region_policies p
  WHERE p.region_code = 'US-WA' AND p.policy_state = 'ACTIVE';

  INSERT INTO escrows(
    task_id, amount, state, funded_at, platform_fee_cents
  ) VALUES (
    task_id, 5000, 'FUNDED', clock_timestamp(), 1000
  );

  INSERT INTO hxos_local_test_duration_evidence(
    id, task_id, source_quote_version_id,
    duration_min_minutes, duration_expected_minutes, duration_max_minutes,
    policy_version, source_evidence_hash, source_environment,
    request_hash, attestation_hash, prior_duration_minutes, reason,
    idempotency_key, actor_id, environment, is_test
  ) VALUES (
    duration_evidence_id, task_id, gen_random_uuid(),
    45, 60, 90, 'price-book-duration-v1', repeat('4', 64), 'TEST',
    repeat('5', 64), repeat('6', 64), NULL,
    'LEGACY_ACCEPTED_QUOTE_PRICE_BOOK_SUPPLEMENT',
    'hxp-d5-duration-' || task_id::TEXT, fixture.provider_id::TEXT,
    'CONTROLLED_TEST', TRUE
  );
  UPDATE tasks
     SET estimated_duration_minutes = 60
   WHERE tasks.id = d5_test.task_id;

  capability_expires_at := clock_timestamp() + INTERVAL '2 hours';
  INSERT INTO hxos_local_test_provider_capability_evidence(
    id, task_id, worker_id, source_hustler_id, category, tools,
    service_city, service_state, service_radius_miles,
    source_policy_version, source_evidence_hash, source_expires_at,
    request_hash, attestation_hash, idempotency_key, actor_id,
    environment, is_test, expires_at
  ) VALUES (
    provider_capability_evidence_id, task_id, fixture.provider_id,
    fixture.provider_id, 'yard', ARRAY['hand truck']::TEXT[],
    'Seattle', 'WA', 10, 'hxos-d5-capability-test-v1', repeat('7', 64),
    capability_expires_at, repeat('8', 64), repeat('9', 64),
    'hxp-d5-capability-' || task_id::TEXT, fixture.provider_id::TEXT,
    'CONTROLLED_TEST', TRUE, capability_expires_at
  );

  INSERT INTO zone_category_cells(
    id, geo_zone, geography_label, category, operating_window, state,
    policy_version, environment, is_test, launch_cell_enabled, green_category,
    metrics_computed_at, evaluated_at, stable_since, state_reasons,
    completed_tasks_total, paid_tasks_30d, fill_rate_30d,
    active_verified_providers, anchor_demand_accounts,
    average_contribution_cents, minimum_provider_net_hourly_cents,
    provider_earnings_policy_version, provider_earnings_policy_state,
    provider_earnings_sample_size, average_provider_net_hourly_cents,
    dispute_rate_30d, no_show_rate_30d, cancellation_rate_30d,
    repeat_demand_rate_30d, dispatch_allowed,
    public_instant_requests_allowed, expansion_eligible,
    max_concurrent_dispatches
  ) VALUES (
    liquidity_cell_id,
    'hxos-test-us-wa-seattle-d5-' || substr(replace(task_id::TEXT, '-', ''), 1, 8),
    'Seattle D5 controlled TEST cell', 'yard', 'controlled-certification',
    'LIMITED', 'hxos-local-certification-liquidity-v1',
    'CONTROLLED_TEST', TRUE, FALSE, FALSE,
    clock_timestamp(), clock_timestamp(), clock_timestamp(),
    '["controlled_test_only","one_eligible_provider","not_public_liquidity","no_production_coverage_claim"]'::JSONB,
    0, 0, 0, 1, 1, 1000, 2000,
    'hxos-provider-economics-test-v1', 'TEST_HYPOTHESIS', 0, 0,
    0, 0, 0, 0, TRUE, FALSE, FALSE, 1
  );

  INSERT INTO hxos_local_test_liquidity_witnesses(
    id, cell_id, task_id, worker_id, background_check_id,
    payout_destination_id, provider_count, contribution_cents,
    policy_version, request_hash, metrics_hash, idempotency_key,
    actor_id, is_test, provider_capability_evidence_id
  )
  SELECT
    liquidity_witness_id, liquidity_cell_id, task_id, fixture.provider_id,
    background.id,
    'pd_hxos_test_' || replace(fixture.provider_id::TEXT, '-', ''),
    1, 1000, 'hxos-local-certification-liquidity-v1',
    repeat('a', 64), repeat('b', 64),
    'hxp-d5-liquidity-' || task_id::TEXT, fixture.provider_id::TEXT,
    TRUE, provider_capability_evidence_id
  FROM background_checks background
  WHERE background.user_id = fixture.provider_id
    AND background.provider = 'local_certification_test'
    AND background.status = 'CLEAR';

  UPDATE tasks
     SET geo_zone = 'hxos-test-us-wa-seattle-d5-' ||
           substr(replace(task_id::TEXT, '-', ''), 1, 8),
         liquidity_cell_id = d5_test.liquidity_cell_id
   WHERE tasks.id = d5_test.task_id;

  offer_issued_at := date_trunc('milliseconds', clock_timestamp());
  offer_expires_at := offer_issued_at + INTERVAL '30 minutes';
  offer_snapshot := jsonb_build_object(
    'decisionReady', TRUE,
    'logistics', jsonb_build_object(
      'distanceEstimateKind', 'SERVICE_ZONE_RANGE',
      'distanceRangeMiles', jsonb_build_object('minimum', 0, 'maximum', 10),
      'exactAddressDisclosed', FALSE,
      'distanceLabel', 'Within the 10-mile Seattle service zone',
      'estimatedTravelTimeMinutes', 30,
      'travelTimePolicyVersion', 'hxos-conservative-travel-v1',
      'travelTimeDisclosure', 'Conservative controlled TEST travel estimate.',
      'estimatedDurationMinutes', 60,
      'durationRangeMinutes', jsonb_build_object('minimum', 45, 'maximum', 90),
      'durationPolicyVersion', 'price-book-duration-v1'
    ),
    'economics', jsonb_build_object(
      'netPayoutCents', 3900,
      'estimatedNetHourlyCents', 2600,
      'minimumNetHourlyCents', 2000,
      'providerEarningsFloorMet', TRUE
    ),
    'scope', jsonb_build_object(
      'scopeHash', fixture.scope_sha256,
      'risk', 'LOW',
      'requiredTools', jsonb_build_array('hand truck')
    ),
    'cancellation', jsonb_build_object(
      'policyVersion', 'task-template-v2:standard_physical:0'
    ),
    'payment', jsonb_build_object(
      'availabilityState', 'PENDING_UNTIL_SERVER_CONFIRMED_SETTLEMENT',
      'timingDisclosure', 'Payment remains server-confirmed.',
      'externalDeliveryDisclosure', 'No external delivery is implied.'
    ),
    'ranking', jsonb_build_object(
      'paidPromotionAffectsRank', FALSE,
      'reasons', jsonb_build_array('controlled_test_complete_offer')
    ),
    'rights', jsonb_build_object('passingHasRankPenalty', FALSE),
    'evidence', jsonb_build_object(
      'reviewActionId', review_action_id,
      'durationEvidenceId', duration_evidence_id,
      'providerCapabilityEvidenceId', provider_capability_evidence_id,
      'liquidityWitnessId', liquidity_witness_id
    ),
    'issuedAt', to_char(
      offer_issued_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'expiresAt', to_char(
      offer_expires_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    )
  );
  INSERT INTO worker_offer_decisions(
    id, task_id, worker_id, policy_version, payload_hash,
    decision_ready, blocking_reasons, customer_total_cents, payout_cents,
    insurance_adjustment_cents, net_payout_cents,
    estimated_net_hourly_cents, minimum_net_hourly_cents,
    provider_earnings_policy_version, provider_earnings_floor_met,
    distance_miles, estimated_travel_time_minutes,
    travel_time_policy_version, estimated_duration_minutes, scope_hash,
    cancellation_policy_version, rank_score, rank_reasons,
    paid_promotion_affects_rank, passing_has_rank_penalty,
    snapshot, expires_at
  ) VALUES (
    offer_decision_id, task_id, fixture.provider_id,
    'hxos-worker-offer-v3', repeat('c', 64), TRUE, '[]'::JSONB,
    5000, 4000, 100, 3900, 2600, 2000,
    'hxos-provider-economics-test-v1', TRUE,
    NULL, 30, 'hxos-conservative-travel-v1', 60,
    fixture.scope_sha256, 'task-template-v2:standard_physical:0',
    1, jsonb_build_array('controlled_test_complete_offer'), FALSE, FALSE,
    offer_snapshot, offer_expires_at
  );

  INSERT INTO worker_offer_events(
    offer_decision_id, event_type, idempotency_key, request_hash, public_note
  ) VALUES (
    offer_decision_id, 'VIEWED', 'hxp-d5-offer-viewed-' || task_id::TEXT,
    repeat('d', 64), 'Controlled TEST worker reviewed the complete offer.'
  );
  INSERT INTO hxos_local_test_offer_actions(
    id, action_type, task_id, worker_id, offer_decision_id,
    duration_evidence_id, provider_capability_evidence_id,
    liquidity_witness_id, review_action_id, request_hash, attestation_hash,
    idempotency_key, actor_id, environment, is_test
  ) VALUES (
    review_action_id, 'VIEWED', task_id, fixture.provider_id,
    offer_decision_id, duration_evidence_id, provider_capability_evidence_id,
    liquidity_witness_id, NULL, repeat('d', 64), repeat('e', 64),
    'hxp-d5-offer-viewed-' || task_id::TEXT, fixture.provider_id,
    'CONTROLLED_TEST', TRUE
  );
  INSERT INTO worker_offer_events(
    offer_decision_id, event_type, idempotency_key, request_hash, public_note
  ) VALUES (
    offer_decision_id, 'ACCEPTED', 'hxp-d5-offer-accepted-' || task_id::TEXT,
    repeat('f', 64), 'Controlled TEST worker explicitly accepted the offer.'
  );
  INSERT INTO hxos_local_test_offer_actions(
    id, action_type, task_id, worker_id, offer_decision_id,
    duration_evidence_id, provider_capability_evidence_id,
    liquidity_witness_id, review_action_id, request_hash, attestation_hash,
    idempotency_key, actor_id, environment, is_test
  ) VALUES (
    accepted_action_id, 'ACCEPTED', task_id, fixture.provider_id,
    offer_decision_id, duration_evidence_id, provider_capability_evidence_id,
    liquidity_witness_id, review_action_id, repeat('f', 64), repeat('0', 64),
    'hxp-d5-offer-accepted-' || task_id::TEXT, fixture.provider_id,
    'CONTROLLED_TEST', TRUE
  );
  UPDATE task_drafts SET task_id = d5_test.task_id WHERE id = fixture.draft_id;
  INSERT INTO task_location_vault(
    task_id, location_ciphertext, location_nonce, location_auth_tag,
    location_key_id, location_fingerprint
  ) VALUES (
    task_id, 'sealed-d5-ciphertext', 'sealed-d5-nonce', 'sealed-d5-tag',
    'd5-location-key', repeat('c', 64)
  );

  UPDATE tasks
     SET worker_id = fixture.provider_id,
         state = 'ACCEPTED',
         accepted_at = clock_timestamp()
   WHERE tasks.id = d5_test.task_id;

  BEGIN
    INSERT INTO payment_canonical_work_orders_v7(
      lifecycle_id, task_draft_id, customer_user_id,
      financial_security_event_id, provider_account_ref_id, processor_code,
      task_id, assigned_provider_user_id, scope_sha256, economics_sha256,
      materialization_command_id, materialization_sha256,
      materialization_authority_id, hold_id
    ) VALUES (
      fixture.lifecycle_id, fixture.draft_id, gen_random_uuid(),
      fixture.financial_security_event_id, fixture.provider_account_ref_id,
      'CANDIDATE_SANDBOX', task_id, fixture.provider_id,
      fixture.scope_sha256, fixture.economics_sha256,
      materialization_command_id, repeat('d', 64),
      materialization_authority_id, fixture.hold_id
    );
    RAISE EXCEPTION 'D5_TEST_ACCEPTED_CROSSED_CUSTOMER' USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN foreign_key_violation THEN wrong_customer_rejected := TRUE;
    WHEN SQLSTATE 'P0001' THEN wrong_customer_rejected := TRUE;
    WHEN SQLSTATE 'P0099' THEN NULL;
  END;

  work_order_created_at := clock_timestamp();
  work_order_sha := encode(digest(jsonb_build_object(
    'schema', 'HX_PAYMENT_CANONICAL_WORK_ORDER_MATERIALIZATION_V7',
    'workOrderId', work_order_id,
    'authorityId', materialization_authority_id,
    'lifecycleId', fixture.lifecycle_id,
    'taskDraftId', fixture.draft_id,
    'customerUserId', fixture.poster_id,
    'financialSecurityEventId', fixture.financial_security_event_id,
    'holdId', fixture.hold_id,
    'providerAccountRefId', fixture.provider_account_ref_id,
    'providerUserId', fixture.provider_id,
    'processorCode', 'CANDIDATE_SANDBOX',
    'taskId', task_id,
    'scopeSha256', fixture.scope_sha256,
    'economicsSha256', fixture.economics_sha256,
    'materializationCommandId', materialization_command_id,
    'createdAt', to_char(work_order_created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )::TEXT, 'sha256'), 'hex');
  INSERT INTO payment_canonical_work_orders_v7(
    work_order_id, lifecycle_id, task_draft_id, customer_user_id,
    financial_security_event_id, provider_account_ref_id, processor_code,
    task_id, assigned_provider_user_id, scope_sha256, economics_sha256,
    materialization_command_id, materialization_sha256,
    materialization_authority_id, hold_id, created_at
  ) VALUES (
    work_order_id, fixture.lifecycle_id, fixture.draft_id, fixture.poster_id,
    fixture.financial_security_event_id, fixture.provider_account_ref_id,
    'CANDIDATE_SANDBOX', task_id, fixture.provider_id,
    fixture.scope_sha256, fixture.economics_sha256,
    materialization_command_id, work_order_sha,
    materialization_authority_id, fixture.hold_id, work_order_created_at
  );

  assigned_at := clock_timestamp();
  assignment_sha := hxos_payment_work_order_assignment_sha256_v7(
    assignment_id, materialization_authority_id, work_order_id,
    fixture.lifecycle_id, task_id, fixture.provider_account_ref_id,
    fixture.provider_id, 'CANDIDATE_SANDBOX', assigned_at, repeat('e', 64)
  );
  INSERT INTO payment_work_order_assignments_v7(
    assignment_id, materialization_authority_id, work_order_id, lifecycle_id,
    task_draft_id, customer_user_id, financial_security_event_id, hold_id,
    task_id, provider_account_ref_id, provider_user_id, processor_code,
    assigned_at, evidence_sha256, assignment_sha256
  ) VALUES (
    assignment_id, materialization_authority_id, work_order_id,
    fixture.lifecycle_id, fixture.draft_id, fixture.poster_id,
    fixture.financial_security_event_id, fixture.hold_id, task_id,
    fixture.provider_account_ref_id, fixture.provider_id, 'CANDIDATE_SANDBOX',
    assigned_at, repeat('e', 64), assignment_sha
  );

  granted_at := clock_timestamp();
  grant_sha := hxos_payment_private_fulfillment_grant_sha256_v7(
    grant_id, assignment_id, work_order_id, fixture.lifecycle_id,
    task_id, fixture.provider_id, 'EXACT_FULFILLMENT_LOCATION',
    'd5-location-key', repeat('c', 64), granted_at, expires_at
  );
  INSERT INTO payment_private_fulfillment_grants_v7(
    grant_id, assignment_id, materialization_authority_id, work_order_id,
    lifecycle_id, task_id, provider_account_ref_id, provider_user_id,
    processor_code, access_scope, location_key_id, location_fingerprint,
    granted_at, expires_at, grant_sha256
  ) VALUES (
    grant_id, assignment_id, materialization_authority_id, work_order_id,
    fixture.lifecycle_id, task_id, fixture.provider_account_ref_id,
    fixture.provider_id, 'CANDIDATE_SANDBOX', 'EXACT_FULFILLMENT_LOCATION',
    'd5-location-key', repeat('c', 64), granted_at, expires_at, grant_sha
  );

  INSERT INTO payment_conditional_provider_hold_events_v7(
    hold_id, sequence_number, prior_event_id, event_type,
    actor_type, event_material_sha256, evidence_sha256
  ) VALUES (
    fixture.hold_id, 2, fixture.initial_hold_event_id, 'CONSUMED',
    'SYSTEM', work_order_sha, authority_sha
  );
  INSERT INTO payment_underwriting_lifecycle_events_v7(
    event_id, lifecycle_id, task_draft_id, sequence_number, prior_event_id,
    command_id, stage, actor_type, evidence_sha256, event_material, event_sha256
  ) VALUES (
    work_order_event_id, fixture.lifecycle_id, fixture.draft_id,
    fixture.lifecycle_sequence_number + 1, fixture.prior_lifecycle_event_id,
    materialization_command_id, 'WORK_ORDER_MATERIALIZED', 'SYSTEM',
    work_order_sha, jsonb_build_object('schema', 'HX_PAYMENT_D5_WORK_ORDER_EVENT_V7'),
    encode(digest(work_order_id::TEXT || ':materialized', 'sha256'), 'hex')
  );
  INSERT INTO payment_underwriting_lifecycle_events_v7(
    event_id, lifecycle_id, task_draft_id, sequence_number, prior_event_id,
    command_id, stage, actor_type, evidence_sha256, event_material, event_sha256
  ) VALUES (
    assigned_event_id, fixture.lifecycle_id, fixture.draft_id,
    fixture.lifecycle_sequence_number + 2, work_order_event_id,
    gen_random_uuid(), 'ASSIGNED', 'SYSTEM', assignment_sha,
    jsonb_build_object('schema', 'HX_PAYMENT_D5_ASSIGNED_EVENT_V7'),
    encode(digest(assignment_id::TEXT || ':assigned', 'sha256'), 'hex')
  );
  INSERT INTO payment_private_fulfillment_access_events_v7(
    access_event_id, grant_id, lifecycle_id, task_id, provider_user_id,
    sequence_number, outcome, access_reason, evidence_sha256,
    access_material_sha256, accessed_at
  ) VALUES (
    access_event_id, grant_id, fixture.lifecycle_id, task_id, fixture.provider_id,
    1, 'AUTHORIZED', 'FULFILLMENT_EXECUTION', repeat('f', 64),
    hxos_payment_private_fulfillment_access_event_sha256_v7(
      access_event_id, grant_id, fixture.lifecycle_id, task_id,
      fixture.provider_id, 1, NULL, 'AUTHORIZED',
      'FULFILLMENT_EXECUTION', repeat('f', 64),
      granted_at + INTERVAL '1 millisecond'
    ),
    granted_at + INTERVAL '1 millisecond'
  );
  BEGIN
    INSERT INTO payment_private_fulfillment_access_events_v7(
      grant_id, lifecycle_id, task_id, provider_user_id, sequence_number,
      prior_access_event_id, outcome, access_reason, evidence_sha256,
      access_material_sha256, accessed_at
    ) VALUES (
      grant_id, fixture.lifecycle_id, task_id, fixture.provider_id, 2,
      access_event_id, 'AUTHORIZED', 'FULFILLMENT_EXECUTION', repeat('8', 64),
      repeat('9', 64), granted_at + INTERVAL '2 milliseconds'
    );
    RAISE EXCEPTION 'D5_TEST_ACCEPTED_TAMPERED_ACCESS_HASH' USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN access_hash_tamper_rejected := TRUE;
    WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  BEGIN
    INSERT INTO payment_private_fulfillment_access_events_v7(
      access_event_id, grant_id, lifecycle_id, task_id, provider_user_id,
      sequence_number, prior_access_event_id, outcome, access_reason,
      evidence_sha256, access_material_sha256, accessed_at
    ) VALUES (
      regression_access_event_id, grant_id, fixture.lifecycle_id, task_id,
      fixture.provider_id, 2, access_event_id, 'AUTHORIZED',
      'FULFILLMENT_EXECUTION', repeat('8', 64),
      hxos_payment_private_fulfillment_access_event_sha256_v7(
        regression_access_event_id, grant_id, fixture.lifecycle_id, task_id,
        fixture.provider_id, 2, access_event_id, 'AUTHORIZED',
        'FULFILLMENT_EXECUTION', repeat('8', 64),
        granted_at + INTERVAL '0.5 milliseconds'
      ),
      granted_at + INTERVAL '0.5 milliseconds'
    );
    RAISE EXCEPTION 'D5_TEST_ACCEPTED_REGRESSED_ACCESS_TIME' USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN access_time_regression_rejected := TRUE;
    WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  BEGIN
    UPDATE task_location_vault
       SET location_ciphertext = NULL,
           location_nonce = NULL,
           location_auth_tag = NULL,
           location_key_id = NULL,
           location_fingerprint = NULL,
           expired_at = clock_timestamp(),
           expiration_reason = 'D5_TEST_EXPIRED'
     WHERE task_location_vault.task_id = d5_test.task_id;
    INSERT INTO payment_private_fulfillment_access_events_v7(
      access_event_id, grant_id, lifecycle_id, task_id, provider_user_id,
      sequence_number, prior_access_event_id, outcome, access_reason,
      evidence_sha256, access_material_sha256, accessed_at
    ) VALUES (
      expired_access_event_id, grant_id, fixture.lifecycle_id, task_id,
      fixture.provider_id, 2, access_event_id, 'AUTHORIZED',
      'FULFILLMENT_EXECUTION', repeat('8', 64),
      hxos_payment_private_fulfillment_access_event_sha256_v7(
        expired_access_event_id, grant_id, fixture.lifecycle_id, task_id,
        fixture.provider_id, 2, access_event_id, 'AUTHORIZED',
        'FULFILLMENT_EXECUTION', repeat('8', 64),
        granted_at + INTERVAL '2 milliseconds'
      ),
      granted_at + INTERVAL '2 milliseconds'
    );
    RAISE EXCEPTION 'D5_TEST_ACCEPTED_EXPIRED_VAULT_ACCESS' USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN expired_vault_access_rejected := TRUE;
    WHEN SQLSTATE 'P0099' THEN NULL;
  END;

  BEGIN
    wrong_void_planned_at := clock_timestamp();
    wrong_void_sha := hxos_payment_work_order_void_obligation_sha256_v7(
      wrong_void_obligation_id, materialization_authority_id,
      fixture.lifecycle_id, fixture.financial_security_event_id,
      fixture.operation_id, wrong_void_operation_id, 'CANDIDATE_SANDBOX',
      'hx-fse-void-v7:' || wrong_void_operation_id::TEXT,
      'TASK_MATERIALIZATION_FAILED', repeat('1', 64),
      wrong_void_planned_at, repeat('2', 64)
    );
    INSERT INTO payment_work_order_void_obligations_v7(
      obligation_id, materialization_authority_id, lifecycle_id,
      financial_security_event_id,
      original_operation_id, void_operation_id, processor_code,
      idempotency_key, reason_code, request_sha256, evidence_sha256,
      planned_at, obligation_sha256
    ) VALUES (
      wrong_void_obligation_id, materialization_authority_id, fixture.lifecycle_id,
      fixture.financial_security_event_id, fixture.operation_id,
      wrong_void_operation_id, 'CANDIDATE_SANDBOX',
      'hx-fse-void-v7:' || wrong_void_operation_id::TEXT,
      'TASK_MATERIALIZATION_FAILED', repeat('1', 64), repeat('2', 64),
      wrong_void_planned_at, wrong_void_sha
    );
    RAISE EXCEPTION 'D5_TEST_ACCEPTED_SUCCESS_AND_VOID' USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN wrong_void_rejected := TRUE;
    WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  BEGIN
    UPDATE payment_work_order_materialization_authorities_v7 authority
       SET scope_sha256 = repeat('9', 64)
     WHERE authority.materialization_authority_id = d5_test.materialization_authority_id;
    RAISE EXCEPTION 'D5_TEST_UPDATED_AUTHORITY' USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN authority_update_rejected := TRUE;
    WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  BEGIN
    DELETE FROM payment_private_fulfillment_grants_v7
     WHERE payment_private_fulfillment_grants_v7.grant_id = d5_test.grant_id;
    RAISE EXCEPTION 'D5_TEST_DELETED_GRANT' USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN grant_delete_rejected := TRUE;
    WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  BEGIN
    TRUNCATE payment_private_fulfillment_access_events_v7;
    RAISE EXCEPTION 'D5_TEST_TRUNCATED_ACCESS' USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN access_truncate_rejected := TRUE;
    WHEN SQLSTATE 'P0099' THEN NULL;
  END;

  IF NOT wrong_customer_rejected
     OR NOT wrong_scope_rejected
     OR NOT preconverted_draft_rejected
     OR NOT partial_graph_rejected
     OR NOT wrong_void_rejected
     OR NOT authority_update_rejected
     OR NOT grant_delete_rejected
     OR NOT access_truncate_rejected
     OR NOT access_hash_tamper_rejected
     OR NOT access_time_regression_rejected
     OR NOT expired_vault_access_rejected THEN
    RAISE EXCEPTION 'D5 negative invariant failed: %', jsonb_build_object(
      'wrongCustomer', wrong_customer_rejected,
      'wrongScope', wrong_scope_rejected,
      'preconvertedDraft', preconverted_draft_rejected,
      'partialGraph', partial_graph_rejected,
      'successAndVoid', wrong_void_rejected,
      'authorityUpdate', authority_update_rejected,
      'grantDelete', grant_delete_rejected,
      'accessTruncate', access_truncate_rejected,
      'accessHashTamper', access_hash_tamper_rejected,
      'accessTimeRegression', access_time_regression_rejected,
      'expiredVaultAccess', expired_vault_access_rejected
    );
  END IF;
END;
$$;

SET CONSTRAINTS ALL IMMEDIATE;

DO $$
DECLARE
  fixture hxp_d4_composed_fixture_v7%ROWTYPE;
  lifecycle_stage TEXT;
  hold_state TEXT;
  work_order_count BIGINT;
  assignment_count BIGINT;
  grant_count BIGINT;
  access_count BIGINT;
  void_count BIGINT;
  public_relation_privileges BIGINT;
  public_function_privileges BIGINT;
BEGIN
  SELECT * INTO fixture FROM hxp_d4_composed_fixture_v7;
  SELECT stage INTO lifecycle_stage FROM payment_underwriting_lifecycle_status_v7
   WHERE lifecycle_id = fixture.lifecycle_id;
  SELECT state INTO hold_state FROM payment_conditional_provider_hold_status_v7
   WHERE hold_id = fixture.hold_id;
  SELECT count(*) INTO work_order_count FROM payment_canonical_work_orders_v7;
  SELECT count(*) INTO assignment_count FROM payment_work_order_assignments_v7;
  SELECT count(*) INTO grant_count FROM payment_private_fulfillment_grants_v7;
  SELECT count(*) INTO access_count FROM payment_private_fulfillment_access_events_v7;
  SELECT count(*) INTO void_count FROM payment_work_order_void_obligations_v7;
  SELECT count(*) INTO public_relation_privileges
    FROM information_schema.role_table_grants
   WHERE grantee = 'PUBLIC'
     AND table_name IN (
       'payment_work_order_materialization_authorities_v7',
       'payment_work_order_assignments_v7',
       'payment_private_fulfillment_grants_v7',
       'payment_private_fulfillment_access_events_v7',
       'payment_work_order_void_obligations_v7'
     );
  SELECT count(*) INTO public_function_privileges
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
   WHERE n.nspname = 'public'
     AND (p.proname LIKE 'hxos_payment_work_order_%'
       OR p.proname LIKE 'hxos_payment_private_fulfillment_%')
     AND acl.grantee = 0
     AND acl.privilege_type = 'EXECUTE';
  IF lifecycle_stage IS DISTINCT FROM 'ASSIGNED'
     OR hold_state IS DISTINCT FROM 'CONSUMED'
     OR work_order_count <> 1
     OR assignment_count <> 1
     OR grant_count <> 1
     OR access_count <> 1
     OR void_count <> 0
     OR public_relation_privileges <> 0
     OR public_function_privileges <> 0 THEN
    RAISE EXCEPTION 'D5 success graph mismatch: %', jsonb_build_object(
      'stage', lifecycle_stage,
      'hold', hold_state,
      'workOrders', work_order_count,
      'assignments', assignment_count,
      'grants', grant_count,
      'accessEvents', access_count,
      'voids', void_count,
      'publicRelations', public_relation_privileges,
      'publicFunctions', public_function_privileges
    );
  END IF;
END;
$$;

SAVEPOINT d5_predecessor_time_regression;
ALTER TABLE payment_private_fulfillment_access_events_v7
  DISABLE TRIGGER payment_private_fulfillment_access_insert_guard_v7;
WITH bound AS (
  SELECT
    access.grant_id,
    access.lifecycle_id,
    access.task_id,
    access.provider_user_id,
    access.access_event_id AS prior_access_event_id,
    access.sequence_number + 1 AS sequence_number,
    access.accessed_at - INTERVAL '0.5 milliseconds' AS accessed_at,
    gen_random_uuid() AS access_event_id
  FROM payment_private_fulfillment_access_events_v7 access
  ORDER BY access.sequence_number DESC
  LIMIT 1
)
INSERT INTO payment_private_fulfillment_access_events_v7(
  access_event_id, grant_id, lifecycle_id, task_id, provider_user_id,
  sequence_number, prior_access_event_id, outcome, access_reason,
  evidence_sha256, access_material_sha256, accessed_at
)
SELECT
  bound.access_event_id, bound.grant_id, bound.lifecycle_id, bound.task_id,
  bound.provider_user_id, bound.sequence_number, bound.prior_access_event_id,
  'AUTHORIZED', 'FULFILLMENT_EXECUTION', repeat('7', 64),
  hxos_payment_private_fulfillment_access_event_sha256_v7(
    bound.access_event_id, bound.grant_id, bound.lifecycle_id, bound.task_id,
    bound.provider_user_id, bound.sequence_number, bound.prior_access_event_id,
    'AUTHORIZED', 'FULFILLMENT_EXECUTION', repeat('7', 64), bound.accessed_at
  ),
  bound.accessed_at
FROM bound;
ALTER TABLE payment_private_fulfillment_access_events_v7
  ENABLE TRIGGER payment_private_fulfillment_access_insert_guard_v7;
DO $$
DECLARE rejected BOOLEAN := FALSE;
BEGIN
  BEGIN
    PERFORM hxos_assert_payment_private_fulfillment_access_history_v7();
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    rejected := TRUE;
  END;
  IF NOT rejected THEN
    RAISE EXCEPTION 'D5_TEST_ACCEPTED_PREDECESSOR_TIME_REGRESSION';
  END IF;
END;
$$;
ROLLBACK TO SAVEPOINT d5_predecessor_time_regression;

SAVEPOINT d5_predecessor_expired_vault;
UPDATE task_location_vault
   SET expired_at = clock_timestamp() - INTERVAL '1 millisecond',
       expiration_reason = 'D5_PREDECESSOR_EXPIRED_RECEIPT'
 WHERE task_id = (
   SELECT task_id FROM payment_private_fulfillment_grants_v7 LIMIT 1
 );
ALTER TABLE payment_private_fulfillment_access_events_v7
  DISABLE TRIGGER payment_private_fulfillment_access_insert_guard_v7;
WITH bound AS (
  SELECT
    access.grant_id,
    access.lifecycle_id,
    access.task_id,
    access.provider_user_id,
    access.access_event_id AS prior_access_event_id,
    access.sequence_number + 1 AS sequence_number,
    access.accessed_at + INTERVAL '1 millisecond' AS accessed_at,
    gen_random_uuid() AS access_event_id
  FROM payment_private_fulfillment_access_events_v7 access
  ORDER BY access.sequence_number DESC
  LIMIT 1
)
INSERT INTO payment_private_fulfillment_access_events_v7(
  access_event_id, grant_id, lifecycle_id, task_id, provider_user_id,
  sequence_number, prior_access_event_id, outcome, access_reason,
  evidence_sha256, access_material_sha256, accessed_at
)
SELECT
  bound.access_event_id, bound.grant_id, bound.lifecycle_id, bound.task_id,
  bound.provider_user_id, bound.sequence_number, bound.prior_access_event_id,
  'AUTHORIZED', 'FULFILLMENT_EXECUTION', repeat('6', 64),
  hxos_payment_private_fulfillment_access_event_sha256_v7(
    bound.access_event_id, bound.grant_id, bound.lifecycle_id, bound.task_id,
    bound.provider_user_id, bound.sequence_number, bound.prior_access_event_id,
    'AUTHORIZED', 'FULFILLMENT_EXECUTION', repeat('6', 64), bound.accessed_at
  ),
  bound.accessed_at
FROM bound;
ALTER TABLE payment_private_fulfillment_access_events_v7
  ENABLE TRIGGER payment_private_fulfillment_access_insert_guard_v7;
DO $$
DECLARE rejected BOOLEAN := FALSE;
BEGIN
  BEGIN
    PERFORM hxos_assert_payment_private_fulfillment_access_history_v7();
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    rejected := TRUE;
  END;
  IF NOT rejected THEN
    RAISE EXCEPTION 'D5_TEST_ACCEPTED_PREDECESSOR_EXPIRED_VAULT_RECEIPT';
  END IF;
END;
$$;
ROLLBACK TO SAVEPOINT d5_predecessor_expired_vault;

\ir ../../database/migrations/20260823_payment_underwriting_work_order_materialization_v7.sql

DO $$
DECLARE
  counts BIGINT[];
BEGIN
  SELECT ARRAY[
    (SELECT count(*) FROM payment_work_order_materialization_authorities_v7),
    (SELECT count(*) FROM payment_canonical_work_orders_v7),
    (SELECT count(*) FROM payment_work_order_assignments_v7),
    (SELECT count(*) FROM payment_private_fulfillment_grants_v7),
    (SELECT count(*) FROM payment_private_fulfillment_access_events_v7),
    (SELECT count(*) FROM payment_work_order_void_obligations_v7)
  ] INTO counts;
  IF counts IS DISTINCT FROM ARRAY[1, 1, 1, 1, 1, 0]::BIGINT[] THEN
    RAISE EXCEPTION 'D5 replay changed evidence: %', counts;
  END IF;
END;
$$;

\if :{?HXP_D6_COMPOSED}
\else
ROLLBACK;
\endif
