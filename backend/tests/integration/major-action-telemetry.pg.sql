\set ON_ERROR_STOP on

BEGIN;
SET LOCAL hustlexp.is_test = 'true';

CREATE OR REPLACE FUNCTION hxobs_assert(condition BOOLEAN, message TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF condition IS NOT TRUE THEN RAISE EXCEPTION 'HXOBS assertion failed: %', message; END IF;
END;
$$;

SELECT hxobs_assert(
  (SELECT COUNT(*)=19 FROM major_action_class_contracts),
  'closed action taxonomy must contain exactly 19 classes'
);
SELECT hxobs_assert(
  (SELECT COUNT(DISTINCT action_class)=19 FROM major_action_source_registry),
  'every action class must have an authoritative source'
);
SELECT hxobs_assert(
  NOT EXISTS (
    SELECT 1 FROM major_action_source_registry registry
    WHERE registry.platform='ENGINE' AND NOT EXISTS (
      SELECT 1 FROM pg_trigger trigger
      JOIN pg_class source ON source.oid=trigger.tgrelid
      WHERE NOT trigger.tgisinternal
        AND trigger.tgname=registry.trigger_name
        AND source.relname=registry.source_table
    )
  ),
  'every registered engine source must have its declared real trigger'
);

INSERT INTO users(
  id,email,full_name,default_mode,date_of_birth,is_minor,is_verified,phone,
  account_status,trust_tier,trust_hold,is_banned,plan
) VALUES (
  '91000000-0000-4000-8000-000000000001','hxobs-user@e2e.invalid','HXOBS User',
  'worker','1990-01-01',FALSE,FALSE,'+12065550199','ACTIVE',2,FALSE,FALSE,'free'
) ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION pg_temp.hxobs_policy_snapshot(p region_policies,p_category TEXT,p_risk TEXT)
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

ALTER TABLE tasks DISABLE TRIGGER USER;
INSERT INTO tasks(
  id,poster_id,state,progress_state,title,description,price,
  hustler_payout_cents,platform_margin_cents,category,risk_level,requires_proof,
  automation_classification,region_code,region_policy_id,region_policy_version,
  region_policy_hash,region_policy_snapshot,trade_type,location_state,
  license_required,insurance_required,background_check_required,proof_min_photos,
  proof_max_photos,proof_gps_required,currency
)
SELECT
  '93000000-0000-4000-8000-000000000001','91000000-0000-4000-8000-000000000001',
  'OPEN','POSTED','HXOBS source task','Real source classification witness',7500,
  6000,1500,'moving','LOW',TRUE,'CONTROLLED_TEST',p.region_code,p.id,p.version,
  p.policy_hash,pg_temp.hxobs_policy_snapshot(p,'moving','LOW'),'moving','WA',
  FALSE,FALSE,FALSE,1,5,FALSE,'usd'
FROM region_policies p
WHERE p.region_code='US-WA' AND p.policy_state='ACTIVE'
ORDER BY p.effective_from DESC LIMIT 1
ON CONFLICT (id) DO NOTHING;

INSERT INTO ai_observation_events(
  id,surface_id,actor_user_id,affected_object_type,affected_object_id,
  action,scope_affected,reason,evidence_classes,expected_benefit,
  uncertainty,downside,authority_level,policy_version,provider,model_version,
  confidence_band,controls,outcome_source,execution_result,output_hash,latency_ms,occurred_at
) VALUES (
  '94000000-0000-4000-8000-000000000001','AI-TASK-SUGGESTION-PROPOSAL',
  '91000000-0000-4000-8000-000000000001','USER_OPPORTUNITY_FEED',
  '91000000-0000-4000-8000-000000000001','Select eligible task opportunities',
  'task_discovery_order','Worker requested qualified opportunities',
  '["VERIFIED_SKILLS","DISTANCE","MATCH_SCORE"]'::JSONB,'Faster opportunity review',
  'Fit and availability can change','Suggestion can waste review time','A2_PROPOSAL_ONLY',
  'hxobs-recommendation-policy-v1','hxobs-fixture-provider','hxobs-model-v1','UNKNOWN',
  '{"apply":true,"edit":false,"dismiss":true,"snooze":true,"why":true,"approve":false,"override":true,"autoExecute":false,"reversible":true}'::JSONB,
  'recommendation events and task outcomes','GENERATED',repeat('9',64),10,NOW()
);

INSERT INTO recommendations(
  id,recipient_user_id,subject_type,subject_id,recommendation_class,source_type,
  recommendation_text,reason,evidence_classes,expected_benefit,downside,
  confidence_band,model_version,policy_version,scope_affected,user_controls,
  ai_observation_id,request_hash,idempotency_key,expires_at
) VALUES (
  '92000000-0000-4000-8000-000000000001','91000000-0000-4000-8000-000000000001',
  'TASK','93000000-0000-4000-8000-000000000001','ECONOMIC','AI',
  'Review the bounded task recommendation','Policy-safe evidence classes matched',
  '["offer_economics"]'::jsonb,'May improve qualified review','Outcome is not guaranteed',
  'LIKELY','hxobs-model-v1','hxobs-recommendation-policy-v1','one task',
  '{"open":true,"dismiss":true,"why":true,"autoExecute":false}'::jsonb,
  '94000000-0000-4000-8000-000000000001',
  repeat('a',64),'hxobs-recommendation-0001',NOW()+INTERVAL '1 day'
) ON CONFLICT (id) DO NOTHING;

DO $$
DECLARE
  v_class RECORD;
  v_event_id UUID;
  v_replay_id UUID;
  v_recommendation_id UUID;
  v_sync_state TEXT;
  v_model_version TEXT;
  v_model_applicability TEXT;
  v_aggregate_id TEXT;
  v_hash TEXT;
BEGIN
  FOR v_class IN SELECT * FROM major_action_class_contracts ORDER BY action_class LOOP
    v_recommendation_id := CASE WHEN v_class.action_class='RECOMMENDATION'
      THEN '92000000-0000-4000-8000-000000000001'::UUID ELSE NULL END;
    v_sync_state := CASE WHEN v_class.action_class='OFFLINE_SYNC'
      THEN 'LOCAL_PENDING' ELSE 'SERVER_CONFIRMED' END;
    v_model_version := CASE WHEN v_class.action_class='RECOMMENDATION'
      THEN 'hxobs-model-v1' ELSE 'NOT_APPLICABLE' END;
    v_model_applicability := CASE WHEN v_class.action_class='RECOMMENDATION'
      THEN 'APPLIED' ELSE 'NOT_APPLICABLE' END;
    v_aggregate_id := encode(digest('aggregate:' || v_class.action_class,'sha256'),'hex');
    v_hash := encode(digest('payload:' || v_class.action_class,'sha256'),'hex');

    v_event_id := record_major_action_event(
      'test.' || lower(v_class.action_class),v_class.action_class,
      v_class.default_automation_class,'SYSTEM','SYSTEM','test_object',v_aggregate_id,
      'ROOT','RECORDED',v_sync_state,'PG_HARNESS','CANONICAL_ENGINE',
      'hxobs-pg-policy-v1','APPLIED',v_recommendation_id,
      v_model_version,v_model_applicability,'LOW',
      'test:' || v_aggregate_id,'test-cause:' || lower(v_class.action_class),
      'hxobs:' || lower(v_class.action_class) || ':0001',1,v_hash,'SUCCESS',NULL,NULL,
      'EVENT_RECORDED','NOT_APPLICABLE','NOT_APPLICABLE',TRUE,
      'major_action_pg_test','source:' || lower(v_class.action_class),clock_timestamp(),1
    );
    v_replay_id := record_major_action_event(
      'test.' || lower(v_class.action_class),v_class.action_class,
      v_class.default_automation_class,'SYSTEM','SYSTEM','test_object',v_aggregate_id,
      'ROOT','RECORDED',v_sync_state,'PG_HARNESS','CANONICAL_ENGINE',
      'hxobs-pg-policy-v1','APPLIED',v_recommendation_id,
      v_model_version,v_model_applicability,'LOW',
      'test:' || v_aggregate_id,'test-cause:' || lower(v_class.action_class),
      'hxobs:' || lower(v_class.action_class) || ':0001',1,v_hash,'SUCCESS',NULL,NULL,
      'EVENT_RECORDED','NOT_APPLICABLE','NOT_APPLICABLE',TRUE,
      'major_action_pg_test','source:' || lower(v_class.action_class),clock_timestamp(),1
    );
    IF v_event_id <> v_replay_id THEN
      RAISE EXCEPTION 'exact replay diverged for %',v_class.action_class;
    END IF;
  END LOOP;
END;
$$;

SELECT hxobs_assert(
  (SELECT COUNT(DISTINCT action_class)=19
   FROM major_action_events WHERE source_table='major_action_pg_test'),
  'the PostgreSQL harness must generate every major action class'
);
SELECT hxobs_assert(
  (SELECT bool_and(is_test AND environment='TEST')
   FROM major_action_events WHERE source_table='major_action_pg_test'),
  'test records must be separated from production records'
);

DO $$
BEGIN
  BEGIN
    PERFORM record_major_action_event(
      'test.execution','EXECUTION','A2','SYSTEM','SYSTEM','test_object',repeat('b',64),
      'ROOT','RECORDED','SERVER_CONFIRMED','PG_HARNESS','CANONICAL_ENGINE',
      'hxobs-pg-policy-v1','APPLIED',NULL,'NOT_APPLICABLE','NOT_APPLICABLE','LOW',
      'test:' || repeat('b',64),'test-cause:conflict','hxobs:execution:0001',1,
      repeat('f',64),'SUCCESS',NULL,NULL,'EVENT_RECORDED',
      'NOT_APPLICABLE','NOT_APPLICABLE',TRUE,'major_action_pg_test','source:conflict',NOW(),1
    );
    RAISE EXCEPTION 'conflicting replay unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXOBS2:%' THEN RAISE; END IF;
  END;

  BEGIN
    PERFORM record_major_action_event(
      'test.unsafe_actor','EXECUTION','A2','USER','2065550199','test_object',repeat('c',64),
      'ROOT','RECORDED','SERVER_CONFIRMED','PG_HARNESS','CANONICAL_ENGINE',
      'hxobs-pg-policy-v1','APPLIED',NULL,'NOT_APPLICABLE','NOT_APPLICABLE','LOW',
      'test:' || repeat('c',64),'test-cause:privacy','hxobs:privacy:0001',1,
      repeat('c',64),'SUCCESS',NULL,NULL,'EVENT_RECORDED',
      'NOT_APPLICABLE','NOT_APPLICABLE',TRUE,'major_action_pg_test','source:privacy',NOW(),1
    );
    RAISE EXCEPTION 'raw phone actor reference unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    PERFORM record_major_action_event(
      'test.failure','AUTOMATION','A1','SYSTEM','SYSTEM','test_object',repeat('d',64),
      'ROOT','FAILED','SERVER_CONFIRMED','PG_HARNESS','CANONICAL_ENGINE',
      'hxobs-pg-policy-v1','APPLIED',NULL,'NOT_APPLICABLE','NOT_APPLICABLE','LOW',
      'test:' || repeat('d',64),'test-cause:failure','hxobs:failure:0001',1,
      repeat('d',64),'FAILURE',NULL,NULL,'EVENT_FAILED',
      'NOT_APPLICABLE','NOT_APPLICABLE',TRUE,'major_action_pg_test','source:failure',NOW(),1
    );
    RAISE EXCEPTION 'failure without reason/recovery unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END;
$$;

SELECT record_major_action_event(
  'test.sequence_root','AUTOMATION','A1','SYSTEM','SYSTEM','test_sequence',repeat('e',64),
  'ROOT','RECORDED','SERVER_CONFIRMED','PG_HARNESS','CANONICAL_ENGINE',
  'hxobs-pg-policy-v1','APPLIED',NULL,'NOT_APPLICABLE','NOT_APPLICABLE','LOW',
  'sequence:' || repeat('e',64),'sequence:root','hxobs:sequence:0001',1,
  repeat('1',64),'SUCCESS',NULL,NULL,'EVENT_RECORDED',
  'NOT_APPLICABLE','NOT_APPLICABLE',TRUE,'major_action_pg_test','sequence:1',NOW(),1
);
SELECT record_major_action_event(
  'test.sequence_gap','AUTOMATION','A1','SYSTEM','SYSTEM','test_sequence',repeat('e',64),
  'RECORDED','RECORDED','SERVER_CONFIRMED','PG_HARNESS','CANONICAL_ENGINE',
  'hxobs-pg-policy-v1','APPLIED',NULL,'NOT_APPLICABLE','NOT_APPLICABLE','LOW',
  'sequence:' || repeat('e',64),'sequence:gap','hxobs:sequence:0003',3,
  repeat('3',64),'SUCCESS',NULL,NULL,'EVENT_RECORDED',
  'NOT_APPLICABLE','NOT_APPLICABLE',TRUE,'major_action_pg_test','sequence:3',NOW(),1
);
SELECT record_major_action_event(
  'test.sequence_stale','AUTOMATION','A1','SYSTEM','SYSTEM','test_sequence',repeat('e',64),
  'RECORDED','RECORDED','SERVER_CONFIRMED','PG_HARNESS','CANONICAL_ENGINE',
  'hxobs-pg-policy-v1','APPLIED',NULL,'NOT_APPLICABLE','NOT_APPLICABLE','LOW',
  'sequence:' || repeat('e',64),'sequence:stale','hxobs:sequence:0002',2,
  repeat('2',64),'NOOP',NULL,NULL,'EVENT_RECORDED',
  'NOT_APPLICABLE','NOT_APPLICABLE',TRUE,'major_action_pg_test','sequence:2',NOW(),1
);

SELECT hxobs_assert(
  (SELECT ordering_state='GAP' AND recovery_action_code='RECONCILE_SEQUENCE_GAP'
   FROM major_action_events WHERE idempotency_key='hxobs:sequence:0003'),
  'sequence gaps must be observable and recoverable'
);
SELECT hxobs_assert(
  (SELECT ordering_state='STALE'
   FROM major_action_events WHERE idempotency_key='hxobs:sequence:0002'),
  'reordered stale events must remain explicit'
);

DO $$
DECLARE
  v_event_id UUID;
  v_outcome_id UUID;
  v_replay_id UUID;
BEGIN
  SELECT id INTO v_event_id FROM major_action_events
  WHERE idempotency_key='hxobs:payout:0001';
  v_outcome_id := record_major_action_outcome(
    v_event_id,'PAYOUT_PAID','cash_out_request',repeat('9',64),'CONFIRMED',3900,'usd',
    repeat('9',64),'major_action_pg_test','outcome:payout',NOW()
  );
  v_replay_id := record_major_action_outcome(
    v_event_id,'PAYOUT_PAID','cash_out_request',repeat('9',64),'CONFIRMED',3900,'usd',
    repeat('9',64),'major_action_pg_test','outcome:payout',NOW()
  );
  IF v_outcome_id <> v_replay_id THEN RAISE EXCEPTION 'outcome replay diverged'; END IF;
  BEGIN
    PERFORM record_major_action_outcome(
      v_event_id,'PAYOUT_PAID','cash_out_request',repeat('9',64),'CONFIRMED',4000,'usd',
      repeat('8',64),'major_action_pg_test','outcome:payout',NOW()
    );
    RAISE EXCEPTION 'conflicting outcome replay unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXOBS4:%' THEN RAISE; END IF;
  END;
END;
$$;

INSERT INTO recommendation_events(
  recommendation_id,actor_id,event_type,idempotency_key,request_hash,ranking_penalty
) VALUES (
  '92000000-0000-4000-8000-000000000001','91000000-0000-4000-8000-000000000001',
  'OPENED','hxobs-opened-0001',repeat('b',64),0
);
INSERT INTO recommendation_outcomes(
  recommendation_id,outcome_type,source_object_id,realized_value,request_hash
) VALUES (
  '92000000-0000-4000-8000-000000000001','TASK_OPENED',
  '93000000-0000-4000-8000-000000000001','{"opened":true}'::jsonb,repeat('c',64)
);

INSERT INTO stripe_events(stripe_event_id,type,created,payload_json)
VALUES (
  'evt_hxobs_0001','payment_intent.succeeded',NOW(),
  '{"data":{"object":{"billing_details":{"email":"excluded@example.invalid"}}}}'::jsonb
);
UPDATE stripe_events SET result='success',processed_at=NOW()
WHERE stripe_event_id='evt_hxobs_0001';

INSERT INTO outbox_events(
  event_type,aggregate_type,aggregate_id,event_version,idempotency_key,
  payload,queue_name,status
) VALUES (
  'notification.hxobs','task','94000000-0000-4000-8000-000000000001',1,
  'notification:hxobs:0001','{"privateMessage":"excluded"}'::jsonb,
  'user_notifications','pending'
);

INSERT INTO engine_automation_events(task_id,event_type,idempotency_key,payload) VALUES
  ('93000000-0000-4000-8000-000000000001','TASK_IN_PROGRESS','hxobs-source-execution','{"workerId":"excluded"}'::jsonb),
  ('93000000-0000-4000-8000-000000000001','PAYOUT_READY','hxobs-source-proof-ready','{"mode":"excluded"}'::jsonb),
  ('93000000-0000-4000-8000-000000000001','POSTER_CONFIRMED_COMPLETION','hxobs-source-proof-confirmed','{"actorId":"excluded"}'::jsonb),
  ('93000000-0000-4000-8000-000000000001','TASK_EXPIRED_UNFILLED','hxobs-source-dispatch','{"reason":"excluded"}'::jsonb),
  ('93000000-0000-4000-8000-000000000001','PAYMENT_INTENT_CANCELED','hxobs-source-payment','{"provider":"excluded"}'::jsonb),
  ('93000000-0000-4000-8000-000000000001','COMPLETION_MESSAGE_DELIVERED','hxobs-source-notification','{"destination":"excluded"}'::jsonb),
  ('93000000-0000-4000-8000-000000000001','POSTER_RATING_RECORDED','hxobs-source-automation','{"score":5}'::jsonb);

SELECT hxobs_assert(
  (SELECT COUNT(*)=7 FROM major_action_events
   WHERE source_table='engine_automation_events'
     AND split_part(source_event_id,':',1) IN (
       SELECT id::TEXT FROM engine_automation_events
       WHERE idempotency_key IN (
         'hxobs-source-execution','hxobs-source-proof-ready',
         'hxobs-source-proof-confirmed','hxobs-source-dispatch',
         'hxobs-source-payment','hxobs-source-notification',
         'hxobs-source-automation'
       )
     )
     AND event_name IN (
       'execution.task_in_progress','proof_completion.payout_ready',
       'proof_completion.poster_confirmed_completion','dispatch.task_expired_unfilled',
       'payment.payment_intent_canceled','notification.completion_message_delivered',
       'automation.poster_rating_recorded'
     )),
  'real engine automation writes must project every dynamically classified domain exactly once'
);
SELECT hxobs_assert(
  (SELECT COUNT(*)=2 FROM major_action_events
   WHERE source_table='engine_automation_events' AND action_class='PROOF_COMPLETION'
     AND split_part(source_event_id,':',1) IN (
       SELECT id::TEXT FROM engine_automation_events
       WHERE idempotency_key IN ('hxobs-source-proof-ready','hxobs-source-proof-confirmed')
     )
     AND event_name IN ('proof_completion.payout_ready','proof_completion.poster_confirmed_completion')),
  'both payout-ready and verified poster confirmation must remain completion evidence'
);
SELECT hxobs_assert(
  (SELECT COUNT(*)=1 FROM major_action_events
   WHERE source_table='engine_automation_events' AND action_class='PAYMENT'
     AND split_part(source_event_id,':',1)=(
       SELECT id::TEXT FROM engine_automation_events
       WHERE idempotency_key='hxobs-source-payment'
     )
     AND event_name='payment.payment_intent_canceled'),
  'payment automation must be classified and registered as PAYMENT'
);
SELECT hxobs_assert(
  (SELECT COUNT(*)=1 FROM major_action_events
   WHERE source_table='engine_automation_events' AND action_class='NOTIFICATION'
     AND split_part(source_event_id,':',1)=(
       SELECT id::TEXT FROM engine_automation_events
       WHERE idempotency_key='hxobs-source-notification'
     )
     AND event_name='notification.completion_message_delivered'),
  'completion delivery evidence must be classified and registered as NOTIFICATION'
);

SELECT hxobs_assert(
  (SELECT COUNT(*)=2 FROM major_action_events
   WHERE source_table IN ('recommendation_events','recommendation_outcomes')
     AND recommendation_id='92000000-0000-4000-8000-000000000001'),
  'real recommendation interaction and outcome writers must project normalized records'
);
SELECT hxobs_assert(
  (SELECT COUNT(*)=2 FROM major_action_events
   WHERE source_table='stripe_events' AND aggregate_id='evt_hxobs_0001'),
  'provider receipt and terminal processing state must remain distinct events'
);
SELECT hxobs_assert(
  (SELECT result='QUEUED' AND sync_state='SERVER_CONFIRMED'
   FROM major_action_events WHERE source_table='outbox_events'
     AND split_part(source_event_id,':',1)=(
       SELECT id::TEXT FROM outbox_events
       WHERE idempotency_key='notification:hxobs:0001'
     )),
  'server-confirmed delivery request must remain queued rather than claimed delivered'
);

DO $$
BEGIN
  BEGIN
    UPDATE major_action_events SET lifecycle_state='TAMPERED'
    WHERE idempotency_key='hxobs:execution:0001';
    RAISE EXCEPTION 'major action mutation unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXOBS1:%' THEN RAISE; END IF;
  END;
  BEGIN
    TRUNCATE major_action_outcomes;
    RAISE EXCEPTION 'major action outcome truncate unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXOBS1:%' THEN RAISE; END IF;
  END;
END;
$$;

SELECT 'MAJOR_ACTION_TELEMETRY_DATABASE_CONTRACT_OK' AS result;
ROLLBACK;
