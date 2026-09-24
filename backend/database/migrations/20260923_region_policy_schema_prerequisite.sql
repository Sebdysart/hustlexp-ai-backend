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
