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

\ir ../../database/migrations/20260718_region_policy_contract.sql
\ir ../../database/migrations/20260720_region_policy_price_book_alignment.sql
\ir ../../database/migrations/20260722_region_policy_legal_approval_activation.sql

CREATE OR REPLACE FUNCTION hx_legal_approval_document(
  p_policy region_policies,
  p_review_at TIMESTAMPTZ
)
RETURNS JSONB LANGUAGE SQL STABLE AS $$
  SELECT jsonb_build_object(
    'schema_version', 1,
    'gate_id', 'EXT-LEGAL-001',
    'decision', 'APPROVED',
    'scope', jsonb_build_object(
      'jurisdiction_code', p_policy.region_code,
      'local_jurisdictions', jsonb_build_array('Bellevue', 'Kirkland'),
      'policy_version', p_policy.version,
      'policy_hash', p_policy.policy_hash,
      'permitted_categories', (
        SELECT jsonb_agg(key ORDER BY key)
        FROM jsonb_object_keys(p_policy.policy_document->'categories') AS key
      ),
      'prohibited_scope', jsonb_build_array('licensed work without verified credentials')
    ),
    'release_bindings', jsonb_build_object(
      'engine', jsonb_build_object(
        'repository', 'Sebdysart/hustlexp-ai-backend',
        'approved_revision', repeat('1', 40),
        'deployed_revision', repeat('1', 40),
        'deployment_id', 'engine-deployment-1'
      ),
      'site', jsonb_build_object(
        'repository', 'Sebdysart/hustlexp-site',
        'approved_revision', repeat('2', 40),
        'deployed_revision', repeat('2', 40),
        'deployment_id', 'site-deployment-1'
      )
    ),
    'approval', jsonb_build_object(
      'counsel', jsonb_build_object(
        'name', 'Qualified Counsel',
        'organization', 'Example Law',
        'licensed_jurisdictions', jsonb_build_array('WA')
      ),
      'policy_owner', 'HustleXP Policy Owner',
      'activation_owner', 'HustleXP Release Owner',
      'approved_at', to_jsonb(clock_timestamp() - INTERVAL '2 minutes'),
      'effective_at', to_jsonb(clock_timestamp() - INTERVAL '1 minute'),
      'review_at', to_jsonb(p_review_at),
      'exceptions', '[]'::JSONB,
      'determinations', jsonb_build_object(
        'worker_classification', 'APPROVED',
        'category_licensing', 'APPROVED',
        'screening_and_adverse_action', 'APPROVED',
        'privacy_and_retention', 'APPROVED',
        'payments_payouts_and_tax', 'APPROVED',
        'disputes_arbitration_and_liability', 'APPROVED',
        'safety_location_and_recording', 'APPROVED'
      ),
      'evidence', jsonb_build_object(
        'uri', 'https://evidence.example.test/legal/approval.pdf',
        'sha256', repeat('b', 64),
        'signature_method', 'qualified-counsel-signed-record'
      )
    )
  )
$$;

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

DO $$
DECLARE
  v_policy region_policies%ROWTYPE;
  v_document JSONB;
BEGIN
  SELECT * INTO v_policy FROM region_policies
  WHERE region_code = 'US-WA' AND policy_state = 'ACTIVE';

  v_document := jsonb_set(
    hx_legal_approval_document(v_policy, clock_timestamp() + INTERVAL '10 minutes'),
    '{scope,permitted_categories}',
    '["yard"]'::JSONB
  );
  BEGIN
    PERFORM activate_region_policy_with_legal_approval(
      v_policy.id,
      v_document,
      encode(digest(v_document::TEXT, 'sha256'), 'hex'),
      '00000000-0000-4000-8000-000000000001'
    );
    RAISE EXCEPTION 'expected HXRPLA8';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXRPLA8:%' THEN RAISE; END IF;
  END;

  v_document := jsonb_set(
    hx_legal_approval_document(v_policy, clock_timestamp() + INTERVAL '10 minutes'),
    '{release_bindings,site,deployed_revision}',
    to_jsonb(repeat('3', 40))
  );
  BEGIN
    PERFORM activate_region_policy_with_legal_approval(
      v_policy.id,
      v_document,
      encode(digest(v_document::TEXT, 'sha256'), 'hex'),
      '00000000-0000-4000-8000-000000000001'
    );
    RAISE EXCEPTION 'expected HXRPLA12';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXRPLA12:%' THEN RAISE; END IF;
  END;
END
$$;

DO $$
DECLARE
  v_policy region_policies%ROWTYPE;
  v_document JSONB;
  v_approval_id UUID;
BEGIN
  SELECT * INTO v_policy FROM region_policies
  WHERE region_code = 'US-WA' AND policy_state = 'ACTIVE';
  v_document := hx_legal_approval_document(
    v_policy,
    clock_timestamp() + INTERVAL '1 second'
  );
  v_approval_id := activate_region_policy_with_legal_approval(
    v_policy.id,
    v_document,
    encode(digest(v_document::TEXT, 'sha256'), 'hex'),
    '00000000-0000-4000-8000-000000000001'
  );
  IF v_approval_id IS NULL THEN RAISE EXCEPTION 'activation returned no approval identity'; END IF;
  IF (SELECT count(*) FROM region_policies
      WHERE id = v_policy.id AND production_enabled = TRUE
        AND approval_state = 'COUNSEL_APPROVED'
        AND approval_reference = 'region-policy-legal-approval:' || v_approval_id::TEXT) <> 1 THEN
    RAISE EXCEPTION 'production policy activation was not exact';
  END IF;
  IF (SELECT count(*) FROM region_policy_events
      WHERE region_policy_id = v_policy.id AND event_type = 'PRODUCTION_APPROVED'
        AND actor_id = '00000000-0000-4000-8000-000000000001') <> 1 THEN
    RAISE EXCEPTION 'production approval event was not appended';
  END IF;

  BEGIN
    UPDATE region_policy_legal_approvals
    SET policy_owner = 'Mutated owner'
    WHERE id = v_approval_id;
    RAISE EXCEPTION 'expected immutable approval rejection';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXRPLA19:%' THEN RAISE; END IF;
  END;

  BEGIN
    TRUNCATE region_policy_legal_approvals;
    RAISE EXCEPTION 'expected immutable approval rejection on truncate';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXRPLA19:%' THEN RAISE; END IF;
  END;
END
$$;

SELECT pg_sleep(1.2);

DO $$
BEGIN
  BEGIN
    INSERT INTO tasks (
      id, category, risk_level, price, hustler_payout_cents, platform_margin_cents,
      requires_proof, automation_classification, state,
      region_code, region_policy_id, region_policy_version, region_policy_hash,
      region_policy_snapshot, trade_type, location_state, license_required,
      insurance_required, background_check_required, proof_min_photos,
      proof_max_photos, proof_gps_required, currency
    )
    SELECT
      '00000000-0000-4000-8000-000000000020', 'moving', 'LOW', 5000, 4000, 1000,
      TRUE, 'PRODUCTION', 'OPEN',
      p.region_code, p.id, p.version, p.policy_hash,
      hx_policy_snapshot(p, 'moving', 'LOW'), 'moving', 'WA', FALSE,
      FALSE, TRUE, 2, 5, FALSE, 'usd'
    FROM region_policies p
    WHERE p.region_code = 'US-WA' AND p.policy_state = 'ACTIVE';
    RAISE EXCEPTION 'expected HXRPLA18';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXRPLA18:%' THEN RAISE; END IF;
  END;
END
$$;

DO $$
BEGIN
  IF (SELECT count(*) FROM region_policy_legal_approvals) <> 1 THEN
    RAISE EXCEPTION 'approval append-only cardinality failed';
  END IF;
  IF (SELECT count(*) FROM tasks WHERE automation_classification = 'PRODUCTION') <> 0 THEN
    RAISE EXCEPTION 'expired approval permitted a production task';
  END IF;
END
$$;

SELECT 'REGION_POLICY_LEGAL_APPROVAL_ACTIVATION_OK' AS result;
