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

UPDATE users
   SET stripe_connect_id='acct_hxdispute_worker',payouts_enabled=TRUE
 WHERE id='d1000000-0000-4000-8000-000000000002';

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
  ('d2000000-0000-4000-8000-000000000003'::UUID,'Administrator override release'),
  ('d2000000-0000-4000-8000-000000000004'::UUID,'Terminal provider-status authority'),
  ('d2000000-0000-4000-8000-000000000005'::UUID,'Exact released-dispute restore')
) AS seed(id,title)
CROSS JOIN LATERAL (
  SELECT * FROM region_policies
  WHERE region_code='US-WA' AND policy_state='ACTIVE'
  ORDER BY effective_from DESC LIMIT 1
) p;

INSERT INTO escrows(
  id,task_id,amount,platform_fee_cents,state,stripe_payment_intent_id,funded_at,
  stripe_transfer_id,payout_provider,provider_transfer_id,provider_transfer_status,released_at,
  version
)
VALUES
  ('d3000000-0000-4000-8000-000000000001','d2000000-0000-4000-8000-000000000001',7500,1500,'LOCKED_DISPUTE','pi_hxdispute_1',clock_timestamp(),NULL,NULL,NULL,NULL,NULL,1),
  ('d3000000-0000-4000-8000-000000000002','d2000000-0000-4000-8000-000000000002',7500,1500,'LOCKED_DISPUTE','pi_hxdispute_2',clock_timestamp(),NULL,NULL,NULL,NULL,NULL,1),
  ('d3000000-0000-4000-8000-000000000003','d2000000-0000-4000-8000-000000000003',7500,1500,'LOCKED_DISPUTE','pi_hxdispute_3',clock_timestamp(),NULL,NULL,NULL,NULL,NULL,1),
  ('d3000000-0000-4000-8000-000000000004','d2000000-0000-4000-8000-000000000004',7500,1500,'RELEASED','pi_hxdispute_4',clock_timestamp(),'tr_hxdispute_status','STRIPE','tr_hxdispute_status','submitted',clock_timestamp(),1),
  ('d3000000-0000-4000-8000-000000000005','d2000000-0000-4000-8000-000000000005',7500,1500,'LOCKED_DISPUTE','pi_hxdispute_5',clock_timestamp(),'tr_hxdispute_restore','STRIPE','tr_hxdispute_restore','submitted',clock_timestamp(),3);

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

INSERT INTO disputes(
  id,task_id,escrow_id,initiated_by,poster_id,worker_id,state,reason,description,
  resolution,resolved_by,resolved_at,outcome_escrow_action,
  outcome_refund_amount,outcome_release_amount,version
) VALUES (
  'd4000000-0000-4000-8000-000000000005','d2000000-0000-4000-8000-000000000005',
  'd3000000-0000-4000-8000-000000000005','d1000000-0000-4000-8000-000000000001',
  'd1000000-0000-4000-8000-000000000001','d1000000-0000-4000-8000-000000000002',
  'RESOLVED','proof_quality','Exact released-dispute restore authority','WORKER_FAVOR',
  'd1000000-0000-4000-8000-000000000003',clock_timestamp(),'RELEASE',0,7500,2
);

INSERT INTO escrow_events(
  escrow_id,from_state,to_state,actor_id,actor_type,idempotency_key,metadata
) VALUES
  (
    'd3000000-0000-4000-8000-000000000005','FUNDED','RELEASED',NULL,'system',
    'escrow.released:d3000000-0000-4000-8000-000000000005',
    jsonb_build_object(
      'payout_provider','STRIPE',
      'payout_recipient_user_id','d1000000-0000-4000-8000-000000000002',
      'provider_transfer_id','tr_hxdispute_restore',
      'provider_transfer_status','submitted'
    )
  ),
  (
    'd3000000-0000-4000-8000-000000000005','RELEASED','LOCKED_DISPUTE',NULL,'system',
    'released-dispute-origin-v1:d3000000-0000-4000-8000-000000000005:2',
    jsonb_build_object(
      'event_type','dispute_locked_after_release',
      'task_id','d2000000-0000-4000-8000-000000000005',
      'initiated_by','d1000000-0000-4000-8000-000000000001',
      'original_transfer_id','tr_hxdispute_restore',
      'escrow_version',2
    )
  );

DO $$
BEGIN
  BEGIN
    UPDATE escrows SET state='RELEASED',stripe_transfer_id='tr_hxdispute_resolved',
      payout_provider='STRIPE',provider_transfer_id='tr_hxdispute_resolved',
      provider_transfer_status='submitted',released_at=clock_timestamp()
    WHERE id='d3000000-0000-4000-8000-000000000002';
    RAISE EXCEPTION 'historical resolved dispute release unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE 'HX002' THEN NULL;
  END;
END;
$$;
SELECT pg_temp.hxdispute_assert(
  (SELECT state='LOCKED_DISPUTE' AND stripe_transfer_id IS NULL FROM escrows
   WHERE id='d3000000-0000-4000-8000-000000000002'),
  'historical resolved dispute must not authorize provider release'
);

SELECT set_config('hustlexp.dispute_release_override','true',true);
DO $$
BEGIN
  BEGIN
    UPDATE escrows SET state='RELEASED',stripe_transfer_id='tr_hxdispute_override',
      payout_provider='STRIPE',provider_transfer_id='tr_hxdispute_override',
      provider_transfer_status='submitted',released_at=clock_timestamp()
    WHERE id='d3000000-0000-4000-8000-000000000003';
    RAISE EXCEPTION 'boolean dispute release override unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE 'HX002' THEN NULL;
  END;
END;
$$;
SELECT pg_temp.hxdispute_assert(
  (SELECT state='LOCKED_DISPUTE' AND stripe_transfer_id IS NULL FROM escrows
   WHERE id='d3000000-0000-4000-8000-000000000003'),
  'freely writable boolean GUC must not authorize provider release'
);

DO $$
BEGIN
  BEGIN
    UPDATE escrows
       SET stripe_transfer_id='tr_hxdispute_rewritten',version=version+1,updated_at=clock_timestamp()
     WHERE id='d3000000-0000-4000-8000-000000000004';
    RAISE EXCEPTION 'terminal transfer identity rewrite unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE 'HX002' THEN NULL;
  END;
END;
$$;

INSERT INTO escrow_events(
  escrow_id,from_state,to_state,actor_id,actor_type,idempotency_key,metadata
)
SELECT
  id,'RELEASED','RELEASED',NULL,'system',
  'provider-transfer-status-authority-v1:' || id::text || ':' || version::text ||
    ':evt_hxdispute_status:paid',
  jsonb_build_object(
    'event_type','provider_transfer_status_authority_v1',
    'reason','terminal_provider_status_test',
    'stripe_event_id','evt_hxdispute_status',
    'escrow_id',id::text,
    'task_id',task_id::text,
    'canonical_state',state,
    'canonical_version',version,
    'transfer_id',stripe_transfer_id,
    'provider_transfer_status_before',provider_transfer_status,
    'provider_transfer_status_after','paid'
  )
FROM escrows
WHERE id='d3000000-0000-4000-8000-000000000004';

SELECT set_config(
  'hustlexp.provider_transfer_status_authority',
  'd3000000-0000-4000-8000-000000000004',
  true
);
UPDATE escrows
   SET provider_transfer_status='paid',version=version+1,updated_at=clock_timestamp()
 WHERE id='d3000000-0000-4000-8000-000000000004';
SELECT pg_temp.hxdispute_assert(
  (SELECT state='RELEASED' AND stripe_transfer_id='tr_hxdispute_status'
          AND provider_transfer_status='paid'
     FROM escrows WHERE id='d3000000-0000-4000-8000-000000000004'),
  'exact provider-status authority must preserve terminal identity'
);

DO $$
DECLARE
  v_escrow escrows%ROWTYPE;
  v_task tasks%ROWTYPE;
  v_dispute disputes%ROWTYPE;
BEGIN
  SELECT * INTO STRICT v_escrow FROM escrows
   WHERE id='d3000000-0000-4000-8000-000000000005';
  SELECT * INTO STRICT v_task FROM tasks WHERE id=v_escrow.task_id;
  SELECT * INTO STRICT v_dispute FROM disputes WHERE escrow_id=v_escrow.id;

  BEGIN
    INSERT INTO escrow_events(
      escrow_id,from_state,to_state,actor_id,actor_type,idempotency_key,metadata
    ) VALUES (
      v_escrow.id,'LOCKED_DISPUTE','RELEASED',NULL,'system',
      'dispute-release-restore-authority-v1:' || v_escrow.id::text || ':' ||
        v_dispute.id::text || ':' || v_dispute.version::text || ':' || v_escrow.version::text,
      jsonb_build_object(
        'event_type','dispute_release_restore_authority_v1',
        'dispute_id',v_dispute.id::text,
        'dispute_version',v_dispute.version,
        'resolved_by',v_dispute.resolved_by::text,
        'task_id',v_task.id::text,
        'task_version',v_task.version,
        'escrow_id',v_escrow.id::text,
        'canonical_state_before','LOCKED_DISPUTE',
        'canonical_version_before',v_escrow.version,
        'original_transfer_id','tr_hxdispute_restore',
        'payout_recipient_user_id','d1000000-0000-4000-8000-000000000002',
        'destination_account_id','acct_forged_destination',
        'transfer_amount_cents',5850,
        'currency','usd',
        'provider_status','not_reversed'
      )
    );
    PERFORM set_config('hustlexp.dispute_release_restore_authority',v_escrow.id::text,true);
    UPDATE escrows
       SET state='RELEASED',version=version+1,updated_at=clock_timestamp()
     WHERE id=v_escrow.id;
    RAISE EXCEPTION 'forged dispute restore authority unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE 'HX002' THEN NULL;
  END;
END;
$$;
SELECT pg_temp.hxdispute_assert(
  (SELECT state='LOCKED_DISPUTE' AND version=3
          AND stripe_transfer_id='tr_hxdispute_restore'
          AND provider_transfer_id='tr_hxdispute_restore'
     FROM escrows WHERE id='d3000000-0000-4000-8000-000000000005'),
  'forged destination authority must preserve locked canonical transfer truth'
);

INSERT INTO escrow_events(
  escrow_id,from_state,to_state,actor_id,actor_type,idempotency_key,metadata
)
SELECT
  escrow.id,'LOCKED_DISPUTE','RELEASED',NULL,'system',
  'dispute-release-restore-authority-v1:' || escrow.id::text || ':' ||
    dispute.id::text || ':' || dispute.version::text || ':' || escrow.version::text,
  jsonb_build_object(
    'event_type','dispute_release_restore_authority_v1',
    'dispute_id',dispute.id::text,
    'dispute_version',dispute.version,
    'resolved_by',dispute.resolved_by::text,
    'task_id',task.id::text,
    'task_version',task.version,
    'escrow_id',escrow.id::text,
    'canonical_state_before','LOCKED_DISPUTE',
    'canonical_version_before',escrow.version,
    'original_transfer_id',escrow.stripe_transfer_id,
    'payout_recipient_user_id',COALESCE(task.payout_recipient_user_id,task.worker_id)::text,
    'destination_account_id',payee.stripe_connect_id,
    'transfer_amount_cents',5850,
    'currency','usd',
    'provider_status','not_reversed'
  )
FROM escrows escrow
JOIN tasks task ON task.id=escrow.task_id
JOIN disputes dispute ON dispute.escrow_id=escrow.id
JOIN users payee ON payee.id=COALESCE(task.payout_recipient_user_id,task.worker_id)
WHERE escrow.id='d3000000-0000-4000-8000-000000000005';

SELECT set_config(
  'hustlexp.dispute_release_restore_authority',
  'd3000000-0000-4000-8000-000000000005',
  true
);
UPDATE escrows
   SET state='RELEASED',version=version+1,updated_at=clock_timestamp()
 WHERE id='d3000000-0000-4000-8000-000000000005';
SELECT pg_temp.hxdispute_assert(
  (SELECT state='RELEASED' AND version=4
          AND amount=7500 AND platform_fee_cents=1500
          AND stripe_transfer_id='tr_hxdispute_restore'
          AND payout_provider='STRIPE'
          AND provider_transfer_id='tr_hxdispute_restore'
          AND provider_transfer_status='submitted'
     FROM escrows WHERE id='d3000000-0000-4000-8000-000000000005'),
  'exact dispute restore must change only state, version, and timestamp without a second transfer'
);

DO $$
BEGIN
  BEGIN
    UPDATE escrow_events
       SET metadata=metadata || jsonb_build_object('tampered',true)
     WHERE escrow_id='d3000000-0000-4000-8000-000000000004';
    RAISE EXCEPTION 'escrow event update unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM <> 'HXIC5: escrow events are append-only' THEN RAISE; END IF;
  END;

  BEGIN
    DELETE FROM escrow_events
     WHERE escrow_id='d3000000-0000-4000-8000-000000000004';
    RAISE EXCEPTION 'escrow event delete unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM <> 'HXIC5: escrow events are append-only' THEN RAISE; END IF;
  END;

  BEGIN
    TRUNCATE TABLE escrow_events;
    RAISE EXCEPTION 'escrow event truncate unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM <> 'HXIC5: escrow events are append-only' THEN RAISE; END IF;
  END;
END;
$$;
SELECT pg_temp.hxdispute_assert(
  NOT EXISTS (
    SELECT 1
      FROM escrow_events
     WHERE escrow_id='d3000000-0000-4000-8000-000000000004'
       AND metadata @> '{"tampered":true}'::jsonb
  ),
  'escrow event ledger must reject update, delete, and truncate'
);

SELECT 'DISPUTE_RELEASE_AUTHORITY_DATABASE_CONTRACT_OK' AS result;
ROLLBACK;
