\set ON_ERROR_STOP on

SET hustlexp.is_test='true';

CREATE OR REPLACE FUNCTION pg_temp.hxupgrade_policy_snapshot(p region_policies,p_category text,p_risk text)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'policyId',p.id::text,'policyVersion',p.version,'policyHash',p.policy_hash,
    'regionCode',p.region_code,'locationState',split_part(p.region_code,'-',2),
    'licenseRequired',(p.policy_document#>>ARRAY['categories',p_category,'credentials','licenseRequired'])::boolean,
    'insuranceRequired',(p.policy_document#>>ARRAY['categories',p_category,'credentials','insuranceRequired'])::boolean,
    'backgroundCheckRequired',(p.policy_document#>>ARRAY['categories',p_category,'credentials','backgroundCheckRequired'])::boolean,
    'proofRequired',(p.policy_document#>>ARRAY['categories',p_category,'evidence','proofRequired'])::boolean,
    'proofMinPhotos',(p.policy_document#>>ARRAY['categories',p_category,'evidence','minPhotos'])::integer,
    'proofMaxPhotos',(p.policy_document#>>ARRAY['categories',p_category,'evidence','maxPhotos'])::integer,
    'proofGpsRequired',(p.policy_document#>>ARRAY['categories',p_category,'evidence','gpsRequired'])::boolean,
    'recordingAllowed',(p.policy_document#>>'{recording,allowed}')::boolean,
    'recordingStandaloneConsentRequired',(p.policy_document#>>'{recording,standaloneConsentRequired}')::boolean,
    'screeningStandaloneConsentRequired',(p.policy_document#>>'{workerRights,standaloneScreeningConsentRequired}')::boolean,
    'screeningReportAccessRequired',(p.policy_document#>>'{workerRights,reportAccessRequired}')::boolean,
    'screeningDisputeAndAppealRequired',(p.policy_document#>>'{workerRights,disputeAndAppealRequired}')::boolean,
    'screeningAdverseActionNoticeRequired',(p.policy_document#>>'{workerRights,adverseActionNoticeRequired}')::boolean,
    'safetyIncidentIntakeRequired',(p.policy_document#>>'{safety,incidentIntakeRequired}')::boolean,
    'safetyTimedCheckinRequired',(p.policy_document#>'{safety,timedCheckinRiskLevels}') ? p_risk,
    'safetyCheckinIntervalsMinutes',p.policy_document#>'{safety,checkinIntervalsMinutes}',
    'safetyLocationRetentionDays',(p.policy_document#>>'{safety,locationRetentionDays}')::integer,
    'safetyAlternateEmergencyActionRequired',(p.policy_document#>>'{safety,alternateEmergencyActionRequired}')::boolean,
    'currency',p.policy_document#>>'{financial,currency}'
  )
$$;

INSERT INTO users(id,email,full_name,default_mode,date_of_birth,is_minor,is_verified,account_status)
VALUES
  ('b1000000-0000-4000-8000-000000000001','hxupgrade-poster@e2e.invalid','HX Upgrade Poster','poster','1990-01-01',false,true,'ACTIVE'),
  ('b1000000-0000-4000-8000-000000000002','hxupgrade-worker@e2e.invalid','HX Upgrade Worker','worker','1990-01-01',false,true,'ACTIVE')
ON CONFLICT (id) DO NOTHING;

INSERT INTO tasks(
  id,poster_id,worker_id,state,progress_state,title,description,price,
  hustler_payout_cents,platform_margin_cents,category,risk_level,requires_proof,
  automation_classification,region_code,region_policy_id,region_policy_version,
  region_policy_hash,region_policy_snapshot,trade_type,location_state,
  license_required,insurance_required,background_check_required,proof_min_photos,
  proof_max_photos,proof_gps_required,currency
)
SELECT
  'b2000000-0000-4000-8000-000000000001',
  'b1000000-0000-4000-8000-000000000001',
  'b1000000-0000-4000-8000-000000000002',
  'OPEN','POSTED','Legacy upgrade task','Existing row before HX/OS July 20 contracts',7500,
  6000,1500,'moving','LOW',true,'CONTROLLED_TEST',p.region_code,p.id,p.version,
  p.policy_hash,pg_temp.hxupgrade_policy_snapshot(p,'moving','LOW'),'moving','WA',
  false,false,false,1,5,false,'usd'
FROM region_policies p
WHERE p.region_code='US-WA' AND p.policy_state='ACTIVE'
ORDER BY p.effective_from DESC LIMIT 1;

INSERT INTO proofs(id,task_id,submitter_id,state,description,submitted_at)
VALUES (
  'b3000000-0000-4000-8000-000000000001',
  'b2000000-0000-4000-8000-000000000001',
  'b1000000-0000-4000-8000-000000000002',
  'SUBMITTED','Legacy proof row',clock_timestamp()
);

INSERT INTO task_safety_incidents(
  id,task_id,reporter_user_id,category,urgency,description,
  location_sharing_enabled,contact_permission,idempotency_key,request_hash
) VALUES (
  'b4000000-0000-4000-8000-000000000001',
  'b2000000-0000-4000-8000-000000000001',
  'b1000000-0000-4000-8000-000000000002',
  'threat','high','Legacy safety case retained through the upgrade.',false,'in_app_only',
  'b5000000-0000-4000-8000-000000000001',repeat('b',64)
);

SELECT 'HXOS_UPGRADE_SEED_OK' AS result;
