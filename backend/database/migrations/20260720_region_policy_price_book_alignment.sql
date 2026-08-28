-- Version the TEST-only Washington policy so canonical Price Book furniture
-- assembly quotes can enter the engine without bypassing regional authority.
-- Production remains disabled pending the existing counsel approval contract.

UPDATE region_policies
SET policy_state = 'RETIRED'
WHERE region_code = 'US-WA'
  AND policy_state = 'ACTIVE'
  AND version <> 'us-wa-price-book-2026-07-20-v2';

INSERT INTO region_policy_events (
  region_policy_id, event_type, policy_hash, public_reason
)
SELECT p.id, 'RETIRED', p.policy_hash,
       'Superseded by the TEST-only Washington Price Book alignment policy.'
FROM region_policies p
WHERE p.region_code = 'US-WA'
  AND p.policy_state = 'RETIRED'
  AND p.version <> 'us-wa-price-book-2026-07-20-v2'
  AND NOT EXISTS (
    SELECT 1
    FROM region_policy_events e
    WHERE e.region_policy_id = p.id
      AND e.event_type = 'RETIRED'
  );

WITH policy(document) AS (
  VALUES (jsonb_build_object(
    'schemaVersion', 'hxos-region-policy-v1',
    'categories', jsonb_build_object(
      'moving', jsonb_build_object(
        'allowedRiskLevels', jsonb_build_array('LOW', 'MEDIUM'),
        'credentials', jsonb_build_object(
          'licenseRequired', FALSE,
          'insuranceRequired', FALSE,
          'backgroundCheckRequired', TRUE
        ),
        'evidence', jsonb_build_object(
          'proofRequired', TRUE,
          'minPhotos', 2,
          'maxPhotos', 5,
          'gpsRequired', FALSE
        )
      ),
      'yard', jsonb_build_object(
        'allowedRiskLevels', jsonb_build_array('LOW'),
        'credentials', jsonb_build_object(
          'licenseRequired', FALSE,
          'insuranceRequired', FALSE,
          'backgroundCheckRequired', FALSE
        ),
        'evidence', jsonb_build_object(
          'proofRequired', TRUE,
          'minPhotos', 1,
          'maxPhotos', 5,
          'gpsRequired', FALSE
        )
      ),
      'cleaning', jsonb_build_object(
        'allowedRiskLevels', jsonb_build_array('LOW', 'MEDIUM', 'IN_HOME'),
        'credentials', jsonb_build_object(
          'licenseRequired', FALSE,
          'insuranceRequired', FALSE,
          'backgroundCheckRequired', TRUE
        ),
        'evidence', jsonb_build_object(
          'proofRequired', TRUE,
          'minPhotos', 2,
          'maxPhotos', 5,
          'gpsRequired', FALSE
        )
      ),
      'furniture_assembly', jsonb_build_object(
        'allowedRiskLevels', jsonb_build_array('LOW', 'MEDIUM', 'IN_HOME'),
        'credentials', jsonb_build_object(
          'licenseRequired', FALSE,
          'insuranceRequired', FALSE,
          'backgroundCheckRequired', TRUE
        ),
        'evidence', jsonb_build_object(
          'proofRequired', TRUE,
          'minPhotos', 2,
          'maxPhotos', 5,
          'gpsRequired', FALSE
        )
      )
    ),
    'recording', jsonb_build_object(
      'allowed', FALSE,
      'standaloneConsentRequired', TRUE
    ),
    'workerRights', jsonb_build_object(
      'standaloneScreeningConsentRequired', TRUE,
      'reportAccessRequired', TRUE,
      'disputeAndAppealRequired', TRUE,
      'adverseActionNoticeRequired', TRUE
    ),
    'financial', jsonb_build_object(
      'currency', 'usd',
      'minimumCustomerCents', 5000,
      'minimumPayoutCents', 4000,
      'minimumMarginCents', 500
    ),
    'safety', jsonb_build_object(
      'incidentIntakeRequired', TRUE,
      'timedCheckinRiskLevels', jsonb_build_array('MEDIUM', 'HIGH', 'IN_HOME'),
      'checkinIntervalsMinutes', jsonb_build_array(15, 30, 60),
      'locationRetentionDays', 30,
      'alternateEmergencyActionRequired', TRUE
    )
  ))
)
INSERT INTO region_policies (
  region_code,
  version,
  policy_state,
  production_enabled,
  approval_state,
  effective_from,
  policy_document,
  policy_hash
)
SELECT
  'US-WA',
  'us-wa-price-book-2026-07-20-v2',
  'ACTIVE',
  FALSE,
  'COUNSEL_APPROVAL_REQUIRED',
  TIMESTAMPTZ '2026-07-20 00:00:00+00',
  document,
  encode(digest(document::text, 'sha256'), 'hex')
FROM policy
ON CONFLICT (region_code, version) DO NOTHING;

INSERT INTO region_policy_events (
  region_policy_id, event_type, policy_hash, public_reason
)
SELECT p.id, 'ACTIVATED', p.policy_hash,
       'TEST-only Washington Price Book categories activated; production remains disabled pending counsel approval.'
FROM region_policies p
WHERE p.region_code = 'US-WA'
  AND p.version = 'us-wa-price-book-2026-07-20-v2'
  AND p.policy_state = 'ACTIVE'
  AND p.production_enabled = FALSE
  AND NOT EXISTS (
    SELECT 1
    FROM region_policy_events e
    WHERE e.region_policy_id = p.id
      AND e.event_type = 'ACTIVATED'
  );
