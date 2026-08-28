\set ON_ERROR_STOP on

BEGIN;
SET LOCAL hustlexp.is_test='true';
SET LOCAL hustlexp.local_test_identity_enabled='true';

CREATE OR REPLACE FUNCTION pg_temp.hxsync_assert(condition BOOLEAN,message TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF condition IS NOT TRUE THEN RAISE EXCEPTION 'HXSYNC assertion failed: %',message; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.hx_policy_snapshot(p region_policies,p_category TEXT,p_risk TEXT)
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

INSERT INTO users(id,email,full_name) VALUES
  ('a1000000-0000-4000-8000-000000000001','hxsync-poster@e2e.invalid','HX Sync Poster'),
  ('a1000000-0000-4000-8000-000000000002','hxsync-worker@e2e.invalid','HX Sync Worker')
ON CONFLICT (id) DO NOTHING;

-- The offline contract starts from an already assigned CONTROLLED_TEST task.
-- Establish provider-owned identity evidence so assignment eligibility remains
-- enforced while this harness isolates reconciliation behavior.
INSERT INTO identity_verification_consents(
  id,user_id,provider,provider_environment,is_test,policy_version,
  disclosure_hash,purpose,idempotency_key
) VALUES (
  'a1500000-0000-4000-8000-000000000001',
  'a1000000-0000-4000-8000-000000000002',
  'local_certification_identity','CONTROLLED_TEST',TRUE,
  'hxos-offline-sync-identity-v1',repeat('4',64),
  'Controlled TEST identity evidence for the rollback-only offline reconciliation contract.',
  'hxsync-identity-consent-0001'
);

CREATE TEMP TABLE hxsync_identity_case AS
SELECT * FROM begin_identity_verification_case_v1(
  'a1000000-0000-4000-8000-000000000002',
  'a1500000-0000-4000-8000-000000000001',
  'local_certification_identity','idv_hxos_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'CONTROLLED_TEST',TRUE,'hxos-offline-sync-identity-v1',repeat('5',64),
  NOW()+INTERVAL '90 days'
);

SELECT * FROM record_identity_verification_event_v1(
  'a1000000-0000-4000-8000-000000000002',
  (SELECT case_id FROM hxsync_identity_case),
  'hxsync-identity-verified-0001','VERIFIED',repeat('6',64),repeat('7',64),
  NOW(),NOW()+INTERVAL '90 days','a1000000-0000-4000-8000-000000000002'
);

INSERT INTO tasks(
  id,poster_id,worker_id,state,progress_state,title,description,price,
  hustler_payout_cents,platform_margin_cents,category,risk_level,requires_proof,
  automation_classification,region_code,region_policy_id,region_policy_version,
  region_policy_hash,region_policy_snapshot,trade_type,location_state,
  license_required,insurance_required,background_check_required,proof_min_photos,
  proof_max_photos,proof_gps_required,currency
)
SELECT
  'a2000000-0000-4000-8000-000000000001',
  'a1000000-0000-4000-8000-000000000001',
  'a1000000-0000-4000-8000-000000000002',
  'OPEN','POSTED','Offline sync test','Versioned client action test',7500,
  6000,1500,'moving','LOW',TRUE,'CONTROLLED_TEST',p.region_code,p.id,p.version,
  p.policy_hash,pg_temp.hx_policy_snapshot(p,'moving','LOW'),'moving','WA',
  (p.policy_document#>>'{categories,moving,credentials,licenseRequired}')::BOOLEAN,
  (p.policy_document#>>'{categories,moving,credentials,insuranceRequired}')::BOOLEAN,
  (p.policy_document#>>'{categories,moving,credentials,backgroundCheckRequired}')::BOOLEAN,
  (p.policy_document#>>'{categories,moving,evidence,minPhotos}')::INTEGER,
  (p.policy_document#>>'{categories,moving,evidence,maxPhotos}')::INTEGER,
  (p.policy_document#>>'{categories,moving,evidence,gpsRequired}')::BOOLEAN,
  p.policy_document#>>'{financial,currency}'
FROM region_policies p
WHERE p.region_code='US-WA' AND p.policy_state='ACTIVE'
ORDER BY p.effective_from DESC LIMIT 1;

SELECT pg_temp.hxsync_assert(
  (SELECT version=1 FROM tasks WHERE id='a2000000-0000-4000-8000-000000000001'),
  'new task must begin at aggregate version 1'
);

UPDATE tasks SET updated_at=updated_at
WHERE id='a2000000-0000-4000-8000-000000000001';
SELECT pg_temp.hxsync_assert(
  (SELECT version=1 FROM tasks WHERE id='a2000000-0000-4000-8000-000000000001'),
  'metadata-only update must not advance the aggregate version'
);

UPDATE tasks SET title='Offline sync test changed'
WHERE id='a2000000-0000-4000-8000-000000000001';
SELECT pg_temp.hxsync_assert(
  (SELECT version=2 FROM tasks WHERE id='a2000000-0000-4000-8000-000000000001'),
  'business update must advance aggregate version exactly once'
);

UPDATE tasks SET version=99
WHERE id='a2000000-0000-4000-8000-000000000001';
SELECT pg_temp.hxsync_assert(
  (SELECT version=2 FROM tasks WHERE id='a2000000-0000-4000-8000-000000000001'),
  'caller must not forge aggregate version'
);

INSERT INTO task_geofence_events(
  task_id,user_id,event_type,distance_meters,client_event_id,client_sequence,
  idempotency_key,request_hash,prior_task_version,local_occurred_at,
  device_version,app_version,reconciliation_contract_version,offline_payload_hash
) VALUES (
  'a2000000-0000-4000-8000-000000000001',
  'a1000000-0000-4000-8000-000000000002','checkin',25,
  'a3000000-0000-4000-8000-000000000001',1,
  'geofence:a1000000:a3000000',repeat('a',64),2,NOW(),
  'web-idb-aes-gcm-v1','web-test',1,repeat('1',64)
);

INSERT INTO proofs(
  task_id,submitter_id,state,description,client_submission_id,submission_hash,
  sync_contract_version,client_sequence,prior_task_version,local_occurred_at,
  device_version,app_version,entry_surface,context_source,intended_transition,
  reconciliation_contract_version,offline_payload_hash
) VALUES (
  'a2000000-0000-4000-8000-000000000001',
  'a1000000-0000-4000-8000-000000000002','SUBMITTED','Purpose-bound proof narrative',
  'proof-submit:offline-action-0001',repeat('b',64),1,1,2,NOW(),
  'web-idb-aes-gcm-v1','web-test','TASK_PROOF_COMPOSER','ACTIVE_TASK',
  'ACCEPTED_TO_PROOF_SUBMITTED',1,repeat('2',64)
);

INSERT INTO task_safety_incidents(
  task_id,reporter_user_id,category,urgency,description,location_sharing_enabled,
  contact_permission,idempotency_key,request_hash,sync_contract_version,
  client_sequence,prior_task_version,local_occurred_at,device_version,app_version,
  entry_surface,context_source,intended_transition,reconciliation_contract_version,
  offline_payload_hash
) VALUES (
  'a2000000-0000-4000-8000-000000000001',
  'a1000000-0000-4000-8000-000000000001','threat','urgent',
  'Purpose-bound safety narrative for the exact case.',FALSE,'in_app_only',
  'a4000000-0000-4000-8000-000000000001',repeat('c',64),1,1,2,NOW(),
  'web-idb-aes-gcm-v1','web-test','TASK_SAFETY_CENTER','ACTIVE_TASK',
  'ANY_TO_SAFETY_REPORT_RECEIVED',1,repeat('3',64)
);

SELECT pg_temp.hxsync_assert(
  (SELECT reconciliation_contract_version=1 AND offline_payload_hash=repeat('2',64)
     FROM proofs WHERE client_submission_id='proof-submit:offline-action-0001'),
  'proof must retain its privacy-minimized reconciliation witness'
);
SELECT pg_temp.hxsync_assert(
  (SELECT reconciliation_contract_version=1 AND offline_payload_hash=repeat('3',64)
     FROM task_safety_incidents WHERE idempotency_key='a4000000-0000-4000-8000-000000000001'),
  'safety report must retain its privacy-minimized reconciliation witness'
);

DO $$
BEGIN
  BEGIN
    INSERT INTO proofs(
      task_id,submitter_id,state,description,client_submission_id,submission_hash,
      sync_contract_version,client_sequence,prior_task_version,local_occurred_at,
      device_version,app_version,entry_surface,context_source,intended_transition
    ) VALUES (
      'a2000000-0000-4000-8000-000000000001',
      'a1000000-0000-4000-8000-000000000002','SUBMITTED','Conflicting sequence',
      'proof-submit:offline-action-0002',repeat('d',64),1,1,2,NOW(),
      'web-idb-aes-gcm-v1','web-test','TASK_PROOF_COMPOSER','ACTIVE_TASK',
      'ACCEPTED_TO_PROOF_SUBMITTED'
    );
    RAISE EXCEPTION 'duplicate proof sequence unexpectedly succeeded';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO task_safety_incidents(
      task_id,reporter_user_id,category,urgency,description,location_sharing_enabled,
      contact_permission,idempotency_key,request_hash,sync_contract_version,
      client_sequence,prior_task_version,local_occurred_at,device_version,app_version,
      entry_surface,context_source,intended_transition
    ) VALUES (
      'a2000000-0000-4000-8000-000000000001',
      'a1000000-0000-4000-8000-000000000001','threat','urgent',
      'Incomplete tuple must fail closed at the database.',FALSE,'in_app_only',
      'a4000000-0000-4000-8000-000000000002',repeat('e',64),1,2,2,NOW(),
      NULL,'web-test','TASK_SAFETY_CENTER','ACTIVE_TASK','ANY_TO_SAFETY_REPORT_RECEIVED'
    );
    RAISE EXCEPTION 'incomplete safety sync tuple unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO task_geofence_events(
      task_id,user_id,event_type,distance_meters,client_event_id,client_sequence,
      idempotency_key,request_hash,prior_task_version,local_occurred_at,
      device_version,app_version
    ) VALUES (
      'a2000000-0000-4000-8000-000000000001',
      'a1000000-0000-4000-8000-000000000002','enter',100,
      'a3000000-0000-4000-8000-000000000002',2,
      'geofence:a1000000:a3000001',repeat('f',64),2,NOW()+INTERVAL '10 minutes',
      'web-idb-aes-gcm-v1','web-test'
    );
    RAISE EXCEPTION 'future geofence evidence unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    UPDATE proofs SET offline_payload_hash=NULL
    WHERE client_submission_id='proof-submit:offline-action-0001';
    RAISE EXCEPTION 'proof reconciliation witness unexpectedly became partial';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    UPDATE task_safety_incidents SET offline_payload_hash=repeat('A',64)
    WHERE idempotency_key='a4000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'uppercase safety reconciliation hash unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO task_geofence_events(
      task_id,user_id,event_type,distance_meters,client_event_id,client_sequence,
      idempotency_key,request_hash,prior_task_version,local_occurred_at,
      device_version,app_version,reconciliation_contract_version,offline_payload_hash
    ) VALUES (
      'a2000000-0000-4000-8000-000000000001',
      'a1000000-0000-4000-8000-000000000002','exit',30,
      'a3000000-0000-4000-8000-000000000003',3,
      'geofence:a1000000:a3000003',repeat('9',64),2,NOW(),
      'web-idb-aes-gcm-v1','web-test',1,NULL
    );
    RAISE EXCEPTION 'presence reconciliation witness unexpectedly became partial';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END;
$$;

SELECT pg_temp.hxsync_assert(
  (SELECT data_type='bigint' FROM information_schema.columns
   WHERE table_schema='public' AND table_name='task_geofence_events'
     AND column_name='prior_task_version'),
  'geofence prior_task_version must share the bigint task version domain'
);

SELECT 'OFFLINE_ACTION_SYNC_DATABASE_CONTRACT_OK' AS result;
ROLLBACK;
