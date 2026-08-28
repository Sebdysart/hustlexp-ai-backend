\set ON_ERROR_STOP on

BEGIN;
\ir ../../database/migrations/20260720_operations_exception_contract.sql

CREATE OR REPLACE FUNCTION pg_temp.hxops_assert(condition boolean, message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF condition IS NOT TRUE THEN RAISE EXCEPTION 'HXOPS assertion failed: %', message; END IF;
END;
$$;

INSERT INTO users (id, firebase_uid, email, full_name, default_mode, date_of_birth, is_minor)
VALUES
  ('91000000-0000-4000-8000-000000000001', 'ops-poster', 'ops-poster@example.test', 'Ops Poster', 'poster', '1990-01-01', FALSE),
  ('91000000-0000-4000-8000-000000000002', 'ops-admin', 'ops-admin@example.test', 'Ops Admin', 'poster', '1990-01-01', FALSE);

CREATE OR REPLACE FUNCTION pg_temp.hxops_policy_snapshot(p region_policies,p_category TEXT,p_risk TEXT)
RETURNS JSONB LANGUAGE SQL IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'policyId',p.id::text,'policyVersion',p.version,'policyHash',p.policy_hash,
    'regionCode',p.region_code,'locationState',split_part(p.region_code,'-',2),
    'licenseRequired',(p.policy_document#>>ARRAY['categories',p_category,'credentials','licenseRequired'])::BOOLEAN,
    'insuranceRequired',(p.policy_document#>>ARRAY['categories',p_category,'credentials','insuranceRequired'])::BOOLEAN,
    'backgroundCheckRequired',(p.policy_document#>>ARRAY['categories',p_category,'credentials','backgroundCheckRequired'])::BOOLEAN,
    'proofRequired',(p.policy_document#>>ARRAY['categories',p_category,'evidence','proofRequired'])::BOOLEAN,
    'proofMinPhotos',(p.policy_document#>>ARRAY['categories',p_category,'evidence','minPhotos'])::INTEGER,
    'proofMaxPhotos',(p.policy_document#>>ARRAY['categories',p_category,'evidence','maxPhotos'])::INTEGER,
    'proofGpsRequired',(p.policy_document#>>ARRAY['categories',p_category,'evidence','gpsRequired'])::BOOLEAN,
    'recordingAllowed',(p.policy_document#>>'{recording,allowed}')::BOOLEAN,
    'recordingStandaloneConsentRequired',(p.policy_document#>>'{recording,standaloneConsentRequired}')::BOOLEAN,
    'screeningStandaloneConsentRequired',(p.policy_document#>>'{workerRights,standaloneScreeningConsentRequired}')::BOOLEAN,
    'screeningReportAccessRequired',(p.policy_document#>>'{workerRights,reportAccessRequired}')::BOOLEAN,
    'screeningDisputeAndAppealRequired',(p.policy_document#>>'{workerRights,disputeAndAppealRequired}')::BOOLEAN,
    'screeningAdverseActionNoticeRequired',(p.policy_document#>>'{workerRights,adverseActionNoticeRequired}')::BOOLEAN,
    'safetyIncidentIntakeRequired',(p.policy_document#>>'{safety,incidentIntakeRequired}')::BOOLEAN,
    'safetyTimedCheckinRequired',(p.policy_document#>'{safety,timedCheckinRiskLevels}') ? p_risk,
    'safetyCheckinIntervalsMinutes',p.policy_document#>'{safety,checkinIntervalsMinutes}',
    'safetyLocationRetentionDays',(p.policy_document#>>'{safety,locationRetentionDays}')::INTEGER,
    'safetyAlternateEmergencyActionRequired',(p.policy_document#>>'{safety,alternateEmergencyActionRequired}')::BOOLEAN,
    'currency',p.policy_document#>>'{financial,currency}'
  )
$$;

INSERT INTO tasks (
  id, poster_id, title, description, price, hustler_payout_cents,
  platform_margin_cents, state, progress_state, dispatch_expires_at,
  category, risk_level, requires_proof, automation_classification,
  region_code, region_policy_id, region_policy_version, region_policy_hash,
  region_policy_snapshot, trade_type, location_state, license_required,
  insurance_required, background_check_required, proof_min_photos,
  proof_max_photos, proof_gps_required, currency
)
SELECT
  '92000000-0000-4000-8000-000000000001',
  '91000000-0000-4000-8000-000000000001',
  'Masked Operations fixture', 'Never returned by the Operations signal view',
  7500, 6000, 1500, 'OPEN', 'POSTED', NOW() + INTERVAL '10 minutes',
  'moving', 'LOW', TRUE, 'CONTROLLED_TEST', p.region_code, p.id, p.version,
  p.policy_hash, pg_temp.hxops_policy_snapshot(p,'moving','LOW'), 'moving', 'WA',
  FALSE, FALSE, TRUE, 2, 5, FALSE, 'usd'
FROM region_policies p
WHERE p.region_code='US-WA' AND p.policy_state='ACTIVE'
ORDER BY p.effective_from DESC LIMIT 1;

INSERT INTO task_safety_incidents (
  id, task_id, reporter_user_id, category, urgency, description,
  contact_permission, idempotency_key
) VALUES (
  '93000000-0000-4000-8000-000000000001',
  '92000000-0000-4000-8000-000000000001',
  '91000000-0000-4000-8000-000000000001',
  'threat', 'urgent', 'Raw safety narrative must never enter the Operations view.',
  'in_app_only', '93000000-0000-4000-8000-000000000002'
);

INSERT INTO notifications (
  id, user_id, category, title, body, deep_link, task_id, channels, priority,
  notification_class, object_type, object_id, dedupe_key, supersession_key,
  delivery_state, terminal_failure_at, terminal_failure_reason
) VALUES (
  '94000000-0000-4000-8000-000000000001',
  '91000000-0000-4000-8000-000000000001',
  'message_received', 'Private destination title', 'Private notification body',
  '/task/status/92000000-0000-4000-8000-000000000001',
  '92000000-0000-4000-8000-000000000001', ARRAY['email'], 'HIGH',
  'action_required', 'task', '92000000-0000-4000-8000-000000000001',
  'ops-notification-fixture', 'ops:task:92000000-0000-4000-8000-000000000001',
  'failed_terminal', NOW(), 'Raw provider failure must remain private.'
);

INSERT INTO notification_deliveries (
  id, notification_id, channel, state, provider_name, attempt_count,
  max_attempts, last_error, terminal_failure_at
) VALUES (
  '95000000-0000-4000-8000-000000000001',
  '94000000-0000-4000-8000-000000000001',
  'email', 'failed_terminal', 'fixture-provider', 3, 3,
  'Raw provider error containing a private destination.', NOW()
);

SELECT pg_temp.hxops_assert(
  (SELECT array_agg(priority_class ORDER BY priority_rank, detected_at)
     FROM operations_exception_signals
    WHERE source_id IN (
      '93000000-0000-4000-8000-000000000001',
      '92000000-0000-4000-8000-000000000001',
      '95000000-0000-4000-8000-000000000001'
    ))
  = ARRAY['SAFETY','SLA','COMMUNICATION']::TEXT[],
  'signals must use canonical safety, SLA, communication priority'
);

SELECT pg_temp.hxops_assert(
  NOT EXISTS (
    SELECT 1 FROM operations_exception_signals
     WHERE source_id IN (
       '93000000-0000-4000-8000-000000000001',
       '92000000-0000-4000-8000-000000000001',
       '95000000-0000-4000-8000-000000000001'
     )
       AND (
         evidence_summary LIKE '%Raw safety narrative%'
         OR evidence_summary LIKE '%Private notification body%'
         OR evidence_summary LIKE '%private destination%'
       )
  ),
  'signal evidence must mask raw safety and notification content'
);

SELECT pg_temp.hxops_assert(
  (SELECT recovery_eligible FROM operations_exception_signals
    WHERE source_id='95000000-0000-4000-8000-000000000001'),
  'terminal missing-work delivery must be eligible for one bounded retry'
);

INSERT INTO operations_exception_access_log (
  cluster_key, admin_user_id, purpose, signal_count
) VALUES (
  'safety_case:93000000-0000-4000-8000-000000000001',
  '91000000-0000-4000-8000-000000000002',
  'Verify purpose-bound access evidence in the database harness.', 1
);

DO $$
BEGIN
  BEGIN
    UPDATE operations_exception_access_log SET signal_count=2
     WHERE cluster_key='safety_case:93000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'append-only update unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE 'HX830' THEN NULL;
  END;
  BEGIN
    DELETE FROM operations_exception_access_log
     WHERE cluster_key='safety_case:93000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'append-only delete unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE 'HX830' THEN NULL;
  END;
END
$$;

SELECT pg_temp.hxops_assert(
  (SELECT can_manage_operations FROM admin_roles LIMIT 1) IS NOT FALSE
  OR NOT EXISTS (SELECT 1 FROM admin_roles),
  'existing admin-role backfill must never create an explicit false for default Operations roles'
);

SELECT 'OPERATIONS_EXCEPTION_DATABASE_CONTRACT_OK' AS result;
ROLLBACK;
