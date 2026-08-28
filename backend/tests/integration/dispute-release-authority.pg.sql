\set ON_ERROR_STOP on

BEGIN;
SET LOCAL hustlexp.is_test='true';
SET LOCAL hustlexp.local_test_identity_enabled='true';

CREATE OR REPLACE FUNCTION pg_temp.hxdispute_assert(condition BOOLEAN,message TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF condition IS NOT TRUE THEN RAISE EXCEPTION 'HXDISPUTE assertion failed: %',message; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.hxdispute_policy_snapshot(p region_policies,p_category TEXT,p_risk TEXT)
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

INSERT INTO users(id,email,full_name,default_mode,date_of_birth,is_minor,is_verified,account_status)
VALUES
  ('d1000000-0000-4000-8000-000000000001','hxdispute-poster@e2e.invalid','HX Dispute Poster','poster','1990-01-01',FALSE,FALSE,'ACTIVE'),
  ('d1000000-0000-4000-8000-000000000002','hxdispute-worker@e2e.invalid','HX Dispute Worker','worker','1990-01-01',FALSE,FALSE,'ACTIVE'),
  ('d1000000-0000-4000-8000-000000000003','hxdispute-admin@e2e.invalid','HX Dispute Admin','poster','1990-01-01',FALSE,FALSE,'ACTIVE');

-- Dispute authority is downstream of assignment. Use provider-owned
-- CONTROLLED_TEST identity evidence instead of forging users.is_verified.
INSERT INTO identity_verification_consents(
  id,user_id,provider,provider_environment,is_test,policy_version,
  disclosure_hash,purpose,idempotency_key
) VALUES (
  'd1500000-0000-4000-8000-000000000001',
  'd1000000-0000-4000-8000-000000000002',
  'local_certification_identity','CONTROLLED_TEST',TRUE,
  'hxos-dispute-authority-identity-v1',repeat('4',64),
  'Controlled TEST identity evidence for the rollback-only dispute release contract.',
  'hxdispute-identity-consent-0001'
);

CREATE TEMP TABLE hxdispute_identity_case AS
SELECT * FROM begin_identity_verification_case_v1(
  'd1000000-0000-4000-8000-000000000002',
  'd1500000-0000-4000-8000-000000000001',
  'local_certification_identity','idv_hxos_test_dddddddddddddddddddddddddddddddd',
  'CONTROLLED_TEST',TRUE,'hxos-dispute-authority-identity-v1',repeat('5',64),
  NOW()+INTERVAL '90 days'
);

SELECT * FROM record_identity_verification_event_v1(
  'd1000000-0000-4000-8000-000000000002',
  (SELECT case_id FROM hxdispute_identity_case),
  'hxdispute-identity-verified-0001','VERIFIED',repeat('6',64),repeat('7',64),
  NOW(),NOW()+INTERVAL '90 days','d1000000-0000-4000-8000-000000000002'
);

INSERT INTO tasks(
  id,poster_id,worker_id,state,progress_state,title,description,price,
  hustler_payout_cents,platform_margin_cents,category,risk_level,requires_proof,
  automation_classification,region_code,region_policy_id,region_policy_version,
  region_policy_hash,region_policy_snapshot,trade_type,location_state,
  license_required,insurance_required,background_check_required,proof_min_photos,
  proof_max_photos,proof_gps_required,currency,completed_at
)
SELECT
  seed.id,'d1000000-0000-4000-8000-000000000001','d1000000-0000-4000-8000-000000000002',
  'COMPLETED','COMPLETED',seed.title,'Dispute release authority contract',7500,
  6000,1500,'moving','LOW',TRUE,'CONTROLLED_TEST',p.region_code,p.id,p.version,
  p.policy_hash,pg_temp.hxdispute_policy_snapshot(p,'moving','LOW'),'moving','WA',
  (p.policy_document#>>'{categories,moving,credentials,licenseRequired}')::BOOLEAN,
  (p.policy_document#>>'{categories,moving,credentials,insuranceRequired}')::BOOLEAN,
  (p.policy_document#>>'{categories,moving,credentials,backgroundCheckRequired}')::BOOLEAN,
  (p.policy_document#>>'{categories,moving,evidence,minPhotos}')::INTEGER,
  (p.policy_document#>>'{categories,moving,evidence,maxPhotos}')::INTEGER,
  (p.policy_document#>>'{categories,moving,evidence,gpsRequired}')::BOOLEAN,
  p.policy_document#>>'{financial,currency}',clock_timestamp()
FROM (VALUES
  ('d2000000-0000-4000-8000-000000000001'::UUID,'Unresolved dispute hold'),
  ('d2000000-0000-4000-8000-000000000002'::UUID,'Resolved worker-favor release'),
  ('d2000000-0000-4000-8000-000000000003'::UUID,'Administrator override release')
) AS seed(id,title)
CROSS JOIN LATERAL (
  SELECT * FROM region_policies
  WHERE region_code='US-WA' AND policy_state='ACTIVE'
  ORDER BY effective_from DESC LIMIT 1
) p;

INSERT INTO escrows(id,task_id,amount,state,stripe_payment_intent_id,funded_at)
VALUES
  ('d3000000-0000-4000-8000-000000000001','d2000000-0000-4000-8000-000000000001',7500,'LOCKED_DISPUTE','pi_hxdispute_1',clock_timestamp()),
  ('d3000000-0000-4000-8000-000000000002','d2000000-0000-4000-8000-000000000002',7500,'LOCKED_DISPUTE','pi_hxdispute_2',clock_timestamp()),
  ('d3000000-0000-4000-8000-000000000003','d2000000-0000-4000-8000-000000000003',7500,'LOCKED_DISPUTE','pi_hxdispute_3',clock_timestamp());

DO $$
BEGIN
  BEGIN
    UPDATE escrows SET state='RELEASED',stripe_transfer_id='tr_hxdispute_unresolved',
      payout_provider='STRIPE',provider_transfer_id='tr_hxdispute_unresolved',
      provider_transfer_status='submitted',released_at=clock_timestamp()
    WHERE id='d3000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'unresolved dispute release unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE 'HX002' THEN NULL;
  END;
END;
$$;

SELECT pg_temp.hxdispute_assert(
  (SELECT state='LOCKED_DISPUTE' AND stripe_transfer_id IS NULL FROM escrows
   WHERE id='d3000000-0000-4000-8000-000000000001'),
  'unresolved dispute must remain locked without a transfer identity'
);

INSERT INTO disputes(
  id,task_id,escrow_id,initiated_by,poster_id,worker_id,state,reason,description,
  resolution,resolved_by,resolved_at,outcome_escrow_action
) VALUES (
  'd4000000-0000-4000-8000-000000000002','d2000000-0000-4000-8000-000000000002',
  'd3000000-0000-4000-8000-000000000002','d1000000-0000-4000-8000-000000000001',
  'd1000000-0000-4000-8000-000000000001','d1000000-0000-4000-8000-000000000002',
  'RESOLVED','proof_quality','Purpose-bound dispute record','WORKER_FAVOR',
  'd1000000-0000-4000-8000-000000000003',clock_timestamp(),'RELEASE'
);

UPDATE escrows SET state='RELEASED',stripe_transfer_id='tr_hxdispute_resolved',
  payout_provider='STRIPE',provider_transfer_id='tr_hxdispute_resolved',
  provider_transfer_status='submitted',released_at=clock_timestamp()
WHERE id='d3000000-0000-4000-8000-000000000002';
SELECT pg_temp.hxdispute_assert(
  (SELECT state='RELEASED' AND stripe_transfer_id='tr_hxdispute_resolved' FROM escrows
   WHERE id='d3000000-0000-4000-8000-000000000002'),
  'resolved worker-favor release was rejected'
);

SELECT set_config('hustlexp.dispute_release_override','true',true);
UPDATE escrows SET state='RELEASED',stripe_transfer_id='tr_hxdispute_override',
  payout_provider='STRIPE',provider_transfer_id='tr_hxdispute_override',
  provider_transfer_status='submitted',released_at=clock_timestamp()
WHERE id='d3000000-0000-4000-8000-000000000003';
SELECT pg_temp.hxdispute_assert(
  (SELECT state='RELEASED' AND stripe_transfer_id='tr_hxdispute_override' FROM escrows
   WHERE id='d3000000-0000-4000-8000-000000000003'),
  'administrator override release was rejected'
);

SELECT 'DISPUTE_RELEASE_AUTHORITY_DATABASE_CONTRACT_OK' AS result;
ROLLBACK;
