-- HX/OS region-policy authority: one immutable version governs category,
-- credentials, evidence, recording, worker rights, money, and safety.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS region_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  region_code TEXT NOT NULL CHECK (region_code ~ '^US-[A-Z]{2}$'),
  version TEXT NOT NULL CHECK (char_length(version) BETWEEN 1 AND 120),
  policy_state TEXT NOT NULL DEFAULT 'DRAFT' CHECK (policy_state IN ('DRAFT','ACTIVE','RETIRED')),
  production_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  approval_state TEXT NOT NULL DEFAULT 'COUNSEL_APPROVAL_REQUIRED'
    CHECK (approval_state IN ('COUNSEL_APPROVAL_REQUIRED','COUNSEL_APPROVED')),
  approval_reference TEXT,
  effective_from TIMESTAMPTZ NOT NULL,
  effective_until TIMESTAMPTZ,
  policy_document JSONB NOT NULL CHECK (jsonb_typeof(policy_document) = 'object'),
  policy_hash CHAR(64) NOT NULL CHECK (policy_hash ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (region_code, version),
  CHECK (effective_until IS NULL OR effective_until > effective_from),
  CHECK (
    production_enabled = FALSE OR
    (approval_state = 'COUNSEL_APPROVED' AND nullif(btrim(approval_reference), '') IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS region_policies_one_active
  ON region_policies(region_code)
  WHERE policy_state = 'ACTIVE';

CREATE TABLE IF NOT EXISTS region_policy_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  region_policy_id UUID NOT NULL REFERENCES region_policies(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN ('CREATED','ACTIVATED','RETIRED','PRODUCTION_APPROVED')),
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  policy_hash CHAR(64) NOT NULL CHECK (policy_hash ~ '^[a-f0-9]{64}$'),
  public_reason TEXT NOT NULL CHECK (char_length(public_reason) BETWEEN 3 AND 1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION validate_region_policy_document()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.policy_hash <> encode(digest(NEW.policy_document::text, 'sha256'), 'hex') THEN
    RAISE EXCEPTION 'HXRP1: region policy hash does not match its document' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.policy_document->>'schemaVersion' <> 'hxos-region-policy-v1'
     OR jsonb_typeof(NEW.policy_document->'categories') <> 'object'
     OR NEW.policy_document->'categories' = '{}'::jsonb
     OR jsonb_typeof(NEW.policy_document->'recording') <> 'object'
     OR jsonb_typeof(NEW.policy_document->'workerRights') <> 'object'
     OR jsonb_typeof(NEW.policy_document->'financial') <> 'object'
     OR jsonb_typeof(NEW.policy_document->'safety') <> 'object' THEN
    RAISE EXCEPTION 'HXRP2: region policy document is incomplete' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS region_policy_document_valid ON region_policies;
CREATE TRIGGER region_policy_document_valid
BEFORE INSERT OR UPDATE ON region_policies
FOR EACH ROW EXECUTE FUNCTION validate_region_policy_document();

CREATE OR REPLACE FUNCTION prevent_region_policy_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'HXRP3: region policies cannot be deleted' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.policy_state = 'DRAFT' THEN
    RETURN NEW;
  END IF;
  IF OLD.policy_state = 'ACTIVE'
     AND NEW.policy_state = 'RETIRED'
     AND (to_jsonb(NEW) - 'policy_state') = (to_jsonb(OLD) - 'policy_state') THEN
    RETURN NEW;
  END IF;
  IF to_jsonb(NEW) = to_jsonb(OLD) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'HXRP4: active or retired region policy is immutable' USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS region_policy_immutable ON region_policies;
CREATE TRIGGER region_policy_immutable
BEFORE UPDATE OR DELETE ON region_policies
FOR EACH ROW EXECUTE FUNCTION prevent_region_policy_mutation();

CREATE OR REPLACE FUNCTION prevent_region_policy_event_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'HXRP5: region policy events are append-only' USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS region_policy_events_immutable ON region_policy_events;
CREATE TRIGGER region_policy_events_immutable
BEFORE UPDATE OR DELETE ON region_policy_events
FOR EACH ROW EXECUTE FUNCTION prevent_region_policy_event_mutation();

WITH policy(document) AS (
  VALUES (jsonb_build_object(
    'schemaVersion', 'hxos-region-policy-v1',
    'categories', jsonb_build_object(
      'moving', jsonb_build_object(
        'allowedRiskLevels', jsonb_build_array('LOW','MEDIUM'),
        'credentials', jsonb_build_object(
          'licenseRequired', FALSE, 'insuranceRequired', FALSE, 'backgroundCheckRequired', FALSE),
        'evidence', jsonb_build_object('proofRequired', TRUE, 'minPhotos', 1, 'maxPhotos', 5, 'gpsRequired', FALSE)
      ),
      'yard', jsonb_build_object(
        'allowedRiskLevels', jsonb_build_array('LOW'),
        'credentials', jsonb_build_object(
          'licenseRequired', FALSE, 'insuranceRequired', FALSE, 'backgroundCheckRequired', FALSE),
        'evidence', jsonb_build_object('proofRequired', TRUE, 'minPhotos', 1, 'maxPhotos', 5, 'gpsRequired', FALSE)
      ),
      'cleaning', jsonb_build_object(
        'allowedRiskLevels', jsonb_build_array('LOW','MEDIUM'),
        'credentials', jsonb_build_object(
          'licenseRequired', FALSE, 'insuranceRequired', FALSE, 'backgroundCheckRequired', FALSE),
        'evidence', jsonb_build_object('proofRequired', TRUE, 'minPhotos', 1, 'maxPhotos', 5, 'gpsRequired', FALSE)
      )
    ),
    'recording', jsonb_build_object('allowed', FALSE, 'standaloneConsentRequired', TRUE),
    'workerRights', jsonb_build_object(
      'standaloneScreeningConsentRequired', TRUE,
      'reportAccessRequired', TRUE,
      'disputeAndAppealRequired', TRUE,
      'adverseActionNoticeRequired', TRUE
    ),
    'financial', jsonb_build_object(
      'currency', 'usd', 'minimumCustomerCents', 5000,
      'minimumPayoutCents', 4000, 'minimumMarginCents', 500
    ),
    'safety', jsonb_build_object(
      'incidentIntakeRequired', TRUE,
      'timedCheckinRiskLevels', jsonb_build_array('MEDIUM','HIGH','IN_HOME'),
      'checkinIntervalsMinutes', jsonb_build_array(15,30,60),
      'locationRetentionDays', 30,
      'alternateEmergencyActionRequired', TRUE
    )
  ))
)
INSERT INTO region_policies (
  region_code, version, policy_state, production_enabled, approval_state,
  effective_from, policy_document, policy_hash
)
SELECT
  'US-WA', 'us-wa-launch-2026-07-18-v1', 'ACTIVE', FALSE, 'COUNSEL_APPROVAL_REQUIRED',
  TIMESTAMPTZ '2026-07-18 00:00:00+00', document,
  encode(digest(document::text, 'sha256'), 'hex')
FROM policy
ON CONFLICT (region_code, version) DO NOTHING;

INSERT INTO region_policy_events (region_policy_id, event_type, policy_hash, public_reason)
SELECT p.id, 'ACTIVATED', p.policy_hash,
       'Engineering test policy activated; production remains disabled pending counsel approval.'
FROM region_policies p
WHERE p.region_code = 'US-WA' AND p.version = 'us-wa-launch-2026-07-18-v1'
  AND NOT EXISTS (
    SELECT 1 FROM region_policy_events e
    WHERE e.region_policy_id = p.id AND e.event_type = 'ACTIVATED'
  );

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS region_code TEXT,
  ADD COLUMN IF NOT EXISTS region_policy_id UUID,
  ADD COLUMN IF NOT EXISTS region_policy_version TEXT,
  ADD COLUMN IF NOT EXISTS region_policy_hash CHAR(64),
  ADD COLUMN IF NOT EXISTS region_policy_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS trade_type TEXT,
  ADD COLUMN IF NOT EXISTS location_state TEXT,
  ADD COLUMN IF NOT EXISTS license_required BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS insurance_required BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS background_check_required BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS proof_min_photos INTEGER,
  ADD COLUMN IF NOT EXISTS proof_max_photos INTEGER,
  ADD COLUMN IF NOT EXISTS proof_gps_required BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS currency TEXT;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_region_policy_fk') THEN
    ALTER TABLE tasks ADD CONSTRAINT tasks_region_policy_fk
      FOREIGN KEY (region_policy_id) REFERENCES region_policies(id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS tasks_region_policy_idx ON tasks(region_policy_id, created_at DESC);

CREATE OR REPLACE FUNCTION enforce_task_region_policy_binding()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_policy region_policies%ROWTYPE;
  v_category JSONB;
  v_expected JSONB;
  v_license BOOLEAN;
  v_insurance BOOLEAN;
  v_background BOOLEAN;
  v_proof_required BOOLEAN;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.category IS DISTINCT FROM NEW.category
       OR OLD.risk_level IS DISTINCT FROM NEW.risk_level
       OR OLD.requires_proof IS DISTINCT FROM NEW.requires_proof
       OR OLD.automation_classification IS DISTINCT FROM NEW.automation_classification
       OR OLD.price IS DISTINCT FROM NEW.price
       OR OLD.hustler_payout_cents IS DISTINCT FROM NEW.hustler_payout_cents
       OR OLD.platform_margin_cents IS DISTINCT FROM NEW.platform_margin_cents
       OR OLD.region_code IS DISTINCT FROM NEW.region_code
       OR OLD.region_policy_id IS DISTINCT FROM NEW.region_policy_id
       OR OLD.region_policy_version IS DISTINCT FROM NEW.region_policy_version
       OR OLD.region_policy_hash IS DISTINCT FROM NEW.region_policy_hash
       OR OLD.region_policy_snapshot IS DISTINCT FROM NEW.region_policy_snapshot
       OR OLD.trade_type IS DISTINCT FROM NEW.trade_type
       OR OLD.location_state IS DISTINCT FROM NEW.location_state
       OR OLD.license_required IS DISTINCT FROM NEW.license_required
       OR OLD.insurance_required IS DISTINCT FROM NEW.insurance_required
       OR OLD.background_check_required IS DISTINCT FROM NEW.background_check_required
       OR OLD.proof_min_photos IS DISTINCT FROM NEW.proof_min_photos
       OR OLD.proof_max_photos IS DISTINCT FROM NEW.proof_max_photos
       OR OLD.proof_gps_required IS DISTINCT FROM NEW.proof_gps_required
       OR OLD.currency IS DISTINCT FROM NEW.currency THEN
      RAISE EXCEPTION 'HXRP6: region policy binding is immutable' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.region_policy_id IS NULL OR NEW.region_code IS NULL
     OR NEW.region_policy_version IS NULL OR NEW.region_policy_hash IS NULL
     OR NEW.region_policy_snapshot IS NULL THEN
    RAISE EXCEPTION 'HXRP7: task requires a complete region policy binding' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_policy FROM region_policies
  WHERE id = NEW.region_policy_id AND policy_state = 'ACTIVE'
    AND effective_from <= clock_timestamp()
    AND (effective_until IS NULL OR effective_until > clock_timestamp())
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HXRP8: task region policy is unavailable or ineffective' USING ERRCODE = 'P0001';
  END IF;
  IF v_policy.region_code <> NEW.region_code
     OR v_policy.version <> NEW.region_policy_version
     OR v_policy.policy_hash <> NEW.region_policy_hash THEN
    RAISE EXCEPTION 'HXRP9: task region policy identity mismatch' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.automation_classification = 'PRODUCTION' AND v_policy.production_enabled = FALSE THEN
    RAISE EXCEPTION 'HXRP10: production policy is not approved' USING ERRCODE = 'P0001';
  END IF;

  v_category := v_policy.policy_document->'categories'->NEW.category;
  IF v_category IS NULL THEN
    RAISE EXCEPTION 'HXRP11: category is not permitted by region policy' USING ERRCODE = 'P0001';
  END IF;
  IF NOT ((v_category->'allowedRiskLevels') ? NEW.risk_level) THEN
    RAISE EXCEPTION 'HXRP12: risk level is not permitted by region policy' USING ERRCODE = 'P0001';
  END IF;

  v_license := (v_category#>>'{credentials,licenseRequired}')::BOOLEAN;
  v_insurance := (v_category#>>'{credentials,insuranceRequired}')::BOOLEAN;
  v_background := (v_category#>>'{credentials,backgroundCheckRequired}')::BOOLEAN;
  v_proof_required := (v_category#>>'{evidence,proofRequired}')::BOOLEAN;

  IF NEW.price < (v_policy.policy_document#>>'{financial,minimumCustomerCents}')::INTEGER
     OR NEW.hustler_payout_cents IS NULL
     OR NEW.hustler_payout_cents < (v_policy.policy_document#>>'{financial,minimumPayoutCents}')::INTEGER
     OR NEW.platform_margin_cents IS NULL
     OR NEW.platform_margin_cents < (v_policy.policy_document#>>'{financial,minimumMarginCents}')::INTEGER THEN
    RAISE EXCEPTION 'HXRP13: task economics violate region policy' USING ERRCODE = 'P0001';
  END IF;
  IF v_proof_required AND NEW.requires_proof IS NOT TRUE THEN
    RAISE EXCEPTION 'HXRP14: completion proof is required by region policy' USING ERRCODE = 'P0001';
  END IF;

  v_expected := jsonb_build_object(
    'policyId', v_policy.id::text,
    'policyVersion', v_policy.version,
    'policyHash', v_policy.policy_hash,
    'regionCode', v_policy.region_code,
    'locationState', split_part(v_policy.region_code, '-', 2),
    'licenseRequired', v_license,
    'insuranceRequired', v_insurance,
    'backgroundCheckRequired', v_background,
    'proofRequired', v_proof_required,
    'proofMinPhotos', (v_category#>>'{evidence,minPhotos}')::INTEGER,
    'proofMaxPhotos', (v_category#>>'{evidence,maxPhotos}')::INTEGER,
    'proofGpsRequired', (v_category#>>'{evidence,gpsRequired}')::BOOLEAN,
    'recordingAllowed', (v_policy.policy_document#>>'{recording,allowed}')::BOOLEAN,
    'recordingStandaloneConsentRequired', (v_policy.policy_document#>>'{recording,standaloneConsentRequired}')::BOOLEAN,
    'screeningStandaloneConsentRequired', (v_policy.policy_document#>>'{workerRights,standaloneScreeningConsentRequired}')::BOOLEAN,
    'screeningReportAccessRequired', (v_policy.policy_document#>>'{workerRights,reportAccessRequired}')::BOOLEAN,
    'screeningDisputeAndAppealRequired', (v_policy.policy_document#>>'{workerRights,disputeAndAppealRequired}')::BOOLEAN,
    'screeningAdverseActionNoticeRequired', (v_policy.policy_document#>>'{workerRights,adverseActionNoticeRequired}')::BOOLEAN,
    'safetyIncidentIntakeRequired', (v_policy.policy_document#>>'{safety,incidentIntakeRequired}')::BOOLEAN,
    'safetyTimedCheckinRequired', (v_policy.policy_document#>'{safety,timedCheckinRiskLevels}') ? NEW.risk_level,
    'safetyCheckinIntervalsMinutes', v_policy.policy_document#>'{safety,checkinIntervalsMinutes}',
    'safetyLocationRetentionDays', (v_policy.policy_document#>>'{safety,locationRetentionDays}')::INTEGER,
    'safetyAlternateEmergencyActionRequired', (v_policy.policy_document#>>'{safety,alternateEmergencyActionRequired}')::BOOLEAN,
    'currency', v_policy.policy_document#>>'{financial,currency}'
  );
  IF NEW.region_policy_snapshot IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'HXRP15: region policy snapshot mismatch' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.trade_type <> NEW.category
     OR NEW.location_state <> split_part(NEW.region_code, '-', 2)
     OR NEW.license_required <> v_license
     OR NEW.insurance_required <> v_insurance
     OR NEW.background_check_required <> v_background
     OR NEW.proof_min_photos <> (v_category#>>'{evidence,minPhotos}')::INTEGER
     OR NEW.proof_max_photos <> (v_category#>>'{evidence,maxPhotos}')::INTEGER
     OR NEW.proof_gps_required <> (v_category#>>'{evidence,gpsRequired}')::BOOLEAN
     OR NEW.currency <> v_policy.policy_document#>>'{financial,currency}' THEN
    RAISE EXCEPTION 'HXRP16: task policy projection mismatch' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS task_region_policy_binding ON tasks;
CREATE TRIGGER task_region_policy_binding
BEFORE INSERT OR UPDATE OF
  category, risk_level, requires_proof, automation_classification,
  price, hustler_payout_cents, platform_margin_cents,
  region_code, region_policy_id, region_policy_version, region_policy_hash,
  region_policy_snapshot, trade_type, location_state, license_required,
  insurance_required, background_check_required, proof_min_photos,
  proof_max_photos, proof_gps_required, currency
ON tasks FOR EACH ROW EXECUTE FUNCTION enforce_task_region_policy_binding();

CREATE OR REPLACE FUNCTION enforce_task_region_policy_on_accept()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state <> 'ACCEPTED'
     OR (TG_OP = 'UPDATE' AND OLD.state = 'ACCEPTED' AND OLD.worker_id IS NOT DISTINCT FROM NEW.worker_id) THEN
    RETURN NEW;
  END IF;
  IF NEW.region_policy_id IS NULL OR NEW.region_policy_snapshot IS NULL THEN
    RAISE EXCEPTION 'HXRP17: accepted task has no region policy binding' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.worker_id IS NULL THEN
    RAISE EXCEPTION 'HXRP18: accepted task requires a worker' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.background_check_required AND NOT EXISTS (
    SELECT 1 FROM background_checks b
    WHERE b.user_id = NEW.worker_id AND upper(b.status) = 'CLEAR'
      AND (b.expires_at IS NULL OR b.expires_at > clock_timestamp())
  ) THEN
    RAISE EXCEPTION 'HXRP19: background check required by region policy' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.insurance_required AND NOT EXISTS (
    SELECT 1 FROM insurance_verifications i
    WHERE i.user_id = NEW.worker_id AND lower(i.status) IN ('approved','verified')
      AND (i.expiration_date IS NULL OR i.expiration_date >= CURRENT_DATE)
  ) THEN
    RAISE EXCEPTION 'HXRP20: insurance required by region policy' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.license_required AND NOT EXISTS (
    SELECT 1 FROM license_verifications l
    WHERE l.user_id = NEW.worker_id AND l.trade_type = NEW.trade_type
      AND l.issuing_state = NEW.location_state
      AND lower(l.status) IN ('approved','verified')
      AND (l.expiration_date IS NULL OR l.expiration_date >= CURRENT_DATE)
  ) THEN
    RAISE EXCEPTION 'HXRP21: license required by region policy' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS task_region_policy_accept_gate ON tasks;
CREATE TRIGGER task_region_policy_accept_gate
BEFORE INSERT OR UPDATE OF state, worker_id ON tasks
FOR EACH ROW EXECUTE FUNCTION enforce_task_region_policy_on_accept();
