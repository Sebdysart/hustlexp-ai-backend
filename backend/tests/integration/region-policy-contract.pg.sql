\set ON_ERROR_STOP on

CREATE TABLE users (id UUID PRIMARY KEY DEFAULT gen_random_uuid());
CREATE TABLE tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  category TEXT,
  risk_level TEXT NOT NULL DEFAULT 'LOW',
  price INTEGER,
  hustler_payout_cents INTEGER,
  platform_margin_cents INTEGER,
  requires_proof BOOLEAN NOT NULL DEFAULT FALSE,
  automation_classification TEXT NOT NULL DEFAULT 'PRODUCTION',
  state TEXT NOT NULL DEFAULT 'OPEN',
  worker_id UUID REFERENCES users(id)
);
CREATE TABLE background_checks (
  user_id UUID REFERENCES users(id), status TEXT, expires_at TIMESTAMPTZ
);
CREATE TABLE insurance_verifications (
  user_id UUID REFERENCES users(id), status TEXT, expiration_date DATE
);
CREATE TABLE license_verifications (
  user_id UUID REFERENCES users(id), trade_type TEXT, issuing_state TEXT,
  status TEXT, expiration_date DATE
);

INSERT INTO users(id) VALUES ('00000000-0000-4000-8000-000000000001');
INSERT INTO tasks(
  id, category, risk_level, price, hustler_payout_cents,
  platform_margin_cents, requires_proof, automation_classification, state
) VALUES (
  '00000000-0000-4000-8000-000000000099', 'moving', 'LOW', 5000, 4000,
  1000, TRUE, 'CONTROLLED_TEST', 'OPEN'
);

\ir ../../database/migrations/20260718_region_policy_contract.sql

CREATE OR REPLACE FUNCTION hx_policy_snapshot(p region_policies, p_category TEXT, p_risk TEXT)
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

INSERT INTO tasks (
  id, category, risk_level, price, hustler_payout_cents, platform_margin_cents,
  requires_proof, automation_classification, state,
  region_code, region_policy_id, region_policy_version, region_policy_hash,
  region_policy_snapshot, trade_type, location_state, license_required,
  insurance_required, background_check_required, proof_min_photos,
  proof_max_photos, proof_gps_required, currency
)
SELECT
  '00000000-0000-4000-8000-000000000010', 'moving', 'LOW', 5000, 4000, 1000,
  TRUE, 'CONTROLLED_TEST', 'OPEN',
  p.region_code, p.id, p.version, p.policy_hash,
  hx_policy_snapshot(p, 'moving', 'LOW'), 'moving', 'WA', FALSE,
  FALSE, FALSE, 1, 5, FALSE, 'usd'
FROM region_policies p
WHERE p.region_code = 'US-WA' AND p.policy_state = 'ACTIVE';

DO $$
BEGIN
  BEGIN
    INSERT INTO tasks (
      category, risk_level, price, hustler_payout_cents, platform_margin_cents,
      requires_proof, automation_classification, state,
      region_code, region_policy_id, region_policy_version, region_policy_hash,
      region_policy_snapshot, trade_type, location_state, license_required,
      insurance_required, background_check_required, proof_min_photos,
      proof_max_photos, proof_gps_required, currency
    )
    SELECT
      'moving', 'LOW', 5000, 4000, 1000, TRUE, 'PRODUCTION', 'OPEN',
      p.region_code, p.id, p.version, p.policy_hash,
      hx_policy_snapshot(p, 'moving', 'LOW'), 'moving', 'WA', FALSE,
      FALSE, FALSE, 1, 5, FALSE, 'usd'
    FROM region_policies p WHERE p.region_code = 'US-WA' AND p.policy_state = 'ACTIVE';
    RAISE EXCEPTION 'expected HXRP10';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXRP10:%' THEN RAISE; END IF;
  END;

  BEGIN
    INSERT INTO tasks (
      category, risk_level, price, hustler_payout_cents, platform_margin_cents,
      requires_proof, automation_classification, state,
      region_code, region_policy_id, region_policy_version, region_policy_hash,
      region_policy_snapshot, trade_type, location_state, license_required,
      insurance_required, background_check_required, proof_min_photos,
      proof_max_photos, proof_gps_required, currency
    )
    SELECT
      'electrical', 'LOW', 5000, 4000, 1000, TRUE, 'CONTROLLED_TEST', 'OPEN',
      p.region_code, p.id, p.version, p.policy_hash,
      '{}'::JSONB, 'electrical', 'WA', FALSE,
      FALSE, FALSE, 1, 5, FALSE, 'usd'
    FROM region_policies p WHERE p.region_code = 'US-WA' AND p.policy_state = 'ACTIVE';
    RAISE EXCEPTION 'expected HXRP11';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXRP11:%' THEN RAISE; END IF;
  END;

  BEGIN
    INSERT INTO tasks (
      category, risk_level, price, hustler_payout_cents, platform_margin_cents,
      requires_proof, automation_classification, state,
      region_code, region_policy_id, region_policy_version, region_policy_hash,
      region_policy_snapshot, trade_type, location_state, license_required,
      insurance_required, background_check_required, proof_min_photos,
      proof_max_photos, proof_gps_required, currency
    )
    SELECT
      'moving', 'LOW', 5000, 4000, 1000, TRUE, 'CONTROLLED_TEST', 'OPEN',
      p.region_code, p.id, p.version, p.policy_hash,
      '{}'::JSONB, 'moving', 'WA', FALSE,
      FALSE, FALSE, 1, 5, FALSE, 'usd'
    FROM region_policies p WHERE p.region_code = 'US-WA' AND p.policy_state = 'ACTIVE';
    RAISE EXCEPTION 'expected HXRP15';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXRP15:%' THEN RAISE; END IF;
  END;

  BEGIN
    UPDATE tasks SET region_code = 'US-OR'
    WHERE id = '00000000-0000-4000-8000-000000000010';
    RAISE EXCEPTION 'expected HXRP6';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXRP6:%' THEN RAISE; END IF;
  END;

  BEGIN
    UPDATE tasks SET state = 'ACCEPTED', worker_id = '00000000-0000-4000-8000-000000000001'
    WHERE id = '00000000-0000-4000-8000-000000000099';
    RAISE EXCEPTION 'expected HXRP17';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXRP17:%' THEN RAISE; END IF;
  END;

  BEGIN
    UPDATE tasks SET state = 'ACCEPTED'
    WHERE id = '00000000-0000-4000-8000-000000000010';
    RAISE EXCEPTION 'expected HXRP18';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXRP18:%' THEN RAISE; END IF;
  END;
END
$$;

DO $$
BEGIN
  BEGIN
    UPDATE region_policies SET production_enabled = TRUE
    WHERE region_code = 'US-WA' AND policy_state = 'ACTIVE';
    RAISE EXCEPTION 'expected immutable policy rejection';
  EXCEPTION WHEN check_violation THEN
    NULL;
  WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXRP4:%' THEN RAISE; END IF;
  END;
END
$$;

DO $$
BEGIN
  IF (SELECT count(*) FROM tasks WHERE id = '00000000-0000-4000-8000-000000000010') <> 1 THEN
    RAISE EXCEPTION 'valid controlled task was not persisted';
  END IF;
  IF (SELECT count(*) FROM region_policies
      WHERE region_code = 'US-WA' AND policy_state = 'ACTIVE' AND production_enabled = FALSE) <> 1 THEN
    RAISE EXCEPTION 'test-only active policy invariant failed';
  END IF;
  IF (SELECT count(*) FROM region_policy_events WHERE event_type = 'ACTIVATED') <> 1 THEN
    RAISE EXCEPTION 'activation event invariant failed';
  END IF;
END
$$;

SELECT 'REGION_POLICY_DATABASE_CONTRACT_OK' AS result;
