\set ON_ERROR_STOP on

BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_true(condition BOOLEAN, message TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF condition IS NOT TRUE THEN RAISE EXCEPTION 'assertion failed: %', message; END IF;
END $$;

INSERT INTO users(id,email,full_name,default_mode,is_minor) VALUES
  ('81000000-0000-4000-8000-000000000001','ai-observer-one@example.test','AI Observer One','poster',FALSE),
  ('81000000-0000-4000-8000-000000000002','ai-observer-two@example.test','AI Observer Two','poster',FALSE);

INSERT INTO ai_observation_events(
  id,surface_id,actor_user_id,affected_object_type,affected_object_id,
  action,scope_affected,reason,evidence_classes,expected_benefit,
  uncertainty,downside,authority_level,policy_version,provider,model_version,
  confidence_band,controls,outcome_source,execution_result,output_hash,latency_ms,occurred_at
) VALUES
  (
    '82000000-0000-4000-8000-000000000001','AI-SCOPER-PROPOSAL',
    '81000000-0000-4000-8000-000000000001','TASK_DRAFT','draft-one',
    'Propose editable task scope','task_draft_scope','Poster supplied free-form task intent',
    '["SANITIZED_TASK_DESCRIPTION","TEMPLATE_POLICY"]'::JSONB,'Faster editable task draft',
    'Physical conditions remain unknown','Proposal can under-scope the work','A2_PROPOSAL_ONLY',
    'hxos-scoper-proposal-v1','fixture-provider','fixture-scoper-v1','UNKNOWN',
    '{"apply":true,"edit":true,"dismiss":true,"snooze":true,"why":true,"approve":false,"override":true,"autoExecute":false,"reversible":true}'::JSONB,
    'scope confirmation and task outcomes','GENERATED',repeat('a',64),12,NOW()
  ),
  (
    '82000000-0000-4000-8000-000000000002','AI-TASK-SUGGESTION-PROPOSAL',
    '81000000-0000-4000-8000-000000000001','USER_OPPORTUNITY_FEED','81000000-0000-4000-8000-000000000001',
    'Select eligible task opportunities','task_discovery_order','Worker requested qualified opportunities',
    '["VERIFIED_SKILLS","DISTANCE","MATCH_SCORE"]'::JSONB,'Faster opportunity review',
    'Fit and availability can change','Suggestion can waste review time','A2_PROPOSAL_ONLY',
    'hxos-task-suggestion-v1','fixture-provider','fixture-suggestion-v1','UNKNOWN',
    '{"apply":true,"edit":false,"dismiss":true,"snooze":true,"why":true,"approve":false,"override":true,"autoExecute":false,"reversible":true}'::JSONB,
    'recommendation events and task outcomes','GENERATED',repeat('b',64),18,NOW()
  ),
  (
    '82000000-0000-4000-8000-000000000003','AI-SCOPER-PROPOSAL',
    '81000000-0000-4000-8000-000000000002','TASK_DRAFT','foreign-draft',
    'Propose editable task scope','task_draft_scope','Another Poster supplied task intent',
    '["SANITIZED_TASK_DESCRIPTION"]'::JSONB,'Faster editable task draft',
    'Physical conditions remain unknown','Proposal can under-scope the work','A2_PROPOSAL_ONLY',
    'hxos-scoper-proposal-v1','fixture-provider','fixture-scoper-v1','UNKNOWN',
    '{"apply":true,"edit":true,"dismiss":true,"why":true,"autoExecute":false,"reversible":true}'::JSONB,
    'scope confirmation and task outcomes','GENERATED',repeat('c',64),9,NOW()
  );

WITH binding AS (
  SELECT category,price,risk_level,requires_proof,automation_classification,
         hustler_payout_cents,platform_margin_cents,region_code,region_policy_id,
         region_policy_version,region_policy_hash,region_policy_snapshot,trade_type,
         location_state,license_required,insurance_required,background_check_required,
         proof_min_photos,proof_max_photos,proof_gps_required,currency
    FROM tasks
   WHERE region_policy_id IS NOT NULL
   ORDER BY created_at DESC,id
   LIMIT 1
)
INSERT INTO tasks(
  id,poster_id,title,description,category,price,risk_level,state,mode,requires_proof,
  automation_classification,hustler_payout_cents,platform_margin_cents,
  region_code,region_policy_id,region_policy_version,region_policy_hash,
  region_policy_snapshot,trade_type,location_state,license_required,insurance_required,
  background_check_required,proof_min_photos,proof_max_photos,proof_gps_required,currency,
  required_tools,ai_scope_observation_id
)
SELECT
  '83000000-0000-4000-8000-000000000001',
  '81000000-0000-4000-8000-000000000001',
  'AI observation contract fixture','A reversible local task scope fixture',
  category,price,risk_level,'OPEN','STANDARD',requires_proof,automation_classification,
  hustler_payout_cents,platform_margin_cents,region_code,region_policy_id,
  region_policy_version,region_policy_hash,region_policy_snapshot,trade_type,
  location_state,license_required,insurance_required,background_check_required,
  proof_min_photos,proof_max_photos,proof_gps_required,currency,
  ARRAY[]::TEXT[],'82000000-0000-4000-8000-000000000001'
FROM binding;

SELECT pg_temp.assert_true(
  (SELECT count(*) = 1 FROM ai_observation_outcomes
    WHERE observation_id='82000000-0000-4000-8000-000000000001'
      AND outcome_type='TASK_CREATED'
      AND realized_result @> '{"taskCreated":true,"proposalAuthorizedState":false,"executablePolicyRevalidated":true}'::JSONB),
  'same-Poster task creation must record a non-authorizing realized outcome'
);

DO $$
BEGIN
  BEGIN
    INSERT INTO tasks(
      id,poster_id,title,description,category,price,risk_level,state,mode,requires_proof,
      automation_classification,hustler_payout_cents,platform_margin_cents,
      region_code,region_policy_id,region_policy_version,region_policy_hash,
      region_policy_snapshot,trade_type,location_state,license_required,insurance_required,
      background_check_required,proof_min_photos,proof_max_photos,proof_gps_required,currency,
      required_tools,ai_scope_observation_id
    ) SELECT
      '83000000-0000-4000-8000-000000000002',
      '81000000-0000-4000-8000-000000000001',
      'Foreign observation fixture','This insert must fail',category,price,risk_level,
      'OPEN','STANDARD',requires_proof,automation_classification,hustler_payout_cents,
      platform_margin_cents,region_code,region_policy_id,region_policy_version,
      region_policy_hash,region_policy_snapshot,trade_type,location_state,license_required,
      insurance_required,background_check_required,proof_min_photos,proof_max_photos,
      proof_gps_required,currency,ARRAY[]::TEXT[],
      '82000000-0000-4000-8000-000000000003'
    FROM tasks WHERE id='83000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'foreign scope observation unexpectedly linked';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXAI2:%' THEN RAISE; END IF;
  END;
END $$;

INSERT INTO recommendations(
  id,recipient_user_id,subject_type,subject_id,recommendation_class,source_type,
  recommendation_text,reason,evidence_classes,expected_benefit,downside,
  confidence_band,model_version,policy_version,scope_affected,user_controls,
  ai_observation_id,request_hash,idempotency_key,expires_at
) VALUES (
  '84000000-0000-4000-8000-000000000001','81000000-0000-4000-8000-000000000001',
  'TASK','83000000-0000-4000-8000-000000000001','ECONOMIC','AI',
  'Review this task','Verified fit evidence supports review','["VERIFIED_SKILLS","DISTANCE"]'::JSONB,
  'Find suitable work faster','Review exact scope and economics','LIKELY','fixture-provider:fixture-suggestion-v1',
  'hxos-task-suggestion-v1','task_discovery_order',
  '{"open":true,"edit":false,"dismiss":true,"snooze":true,"why":true,"autoExecute":false}'::JSONB,
  '82000000-0000-4000-8000-000000000002',repeat('d',64),'ai-recommendation:fixture:0001',NOW()+INTERVAL '1 day'
);

INSERT INTO recommendation_events(
  id,recommendation_id,actor_id,event_type,idempotency_key,request_hash,ranking_penalty
) VALUES
  ('85000000-0000-4000-8000-000000000001','84000000-0000-4000-8000-000000000001',
   '81000000-0000-4000-8000-000000000001','DISPLAYED','displayed:fixture:0001',repeat('e',64),0),
  ('85000000-0000-4000-8000-000000000002','84000000-0000-4000-8000-000000000001',
   '81000000-0000-4000-8000-000000000001','DISMISSED','dismissed:fixture:0001',repeat('f',64),0);

INSERT INTO recommendation_outcomes(
  id,recommendation_id,outcome_type,source_object_id,realized_value,request_hash
) VALUES (
  '86000000-0000-4000-8000-000000000001','84000000-0000-4000-8000-000000000001',
  'TASK_OPENED','83000000-0000-4000-8000-000000000001','{"taskOpened":true,"autoExecuted":false}'::JSONB,repeat('1',64)
);

SELECT pg_temp.assert_true(
  (SELECT count(*) = 3 FROM ai_observation_outcomes
    WHERE observation_id='82000000-0000-4000-8000-000000000002'
      AND outcome_type IN ('RECOMMENDATION_DISPLAYED','USER_DISMISSED','TASK_OPENED')),
  'recommendation display, user response, and task outcome must retain exact observation provenance'
);

DO $$
BEGIN
  BEGIN
    INSERT INTO recommendations(
      id,recipient_user_id,subject_type,subject_id,recommendation_class,source_type,
      recommendation_text,reason,evidence_classes,expected_benefit,downside,
      confidence_band,model_version,policy_version,scope_affected,user_controls,
      ai_observation_id,request_hash,idempotency_key,expires_at
    ) VALUES (
      '84000000-0000-4000-8000-000000000002','81000000-0000-4000-8000-000000000001',
      'TASK','83000000-0000-4000-8000-000000000001','ECONOMIC','AI','Wrong surface',
      'This must fail','["MATCH_SCORE"]'::JSONB,'None','False provenance','UNKNOWN','fixture-model',
      'hxos-task-suggestion-v1','task_discovery_order','{"dismiss":true,"why":true,"autoExecute":false}'::JSONB,
      '82000000-0000-4000-8000-000000000001',repeat('2',64),'wrong-surface:fixture:0001',NOW()+INTERVAL '1 day'
    );
    RAISE EXCEPTION 'wrong-surface recommendation unexpectedly linked';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXAI3:%' THEN RAISE; END IF;
  END;

  BEGIN
    INSERT INTO recommendations(
      id,recipient_user_id,subject_type,subject_id,recommendation_class,source_type,
      recommendation_text,reason,evidence_classes,expected_benefit,downside,
      confidence_band,model_version,policy_version,scope_affected,user_controls,
      ai_observation_id,request_hash,idempotency_key,expires_at
    ) VALUES (
      '84000000-0000-4000-8000-000000000003','81000000-0000-4000-8000-000000000001',
      'TASK','83000000-0000-4000-8000-000000000001','ECONOMIC','DETERMINISTIC','False AI provenance',
      'This must fail','["MATCH_SCORE"]'::JSONB,'None','False provenance','UNKNOWN',NULL,
      'hxos-task-suggestion-v1','task_discovery_order','{"dismiss":true,"why":true,"autoExecute":false}'::JSONB,
      '82000000-0000-4000-8000-000000000002',repeat('3',64),'deterministic-ai:fixture:0001',NOW()+INTERVAL '1 day'
    );
    RAISE EXCEPTION 'deterministic recommendation unexpectedly claimed AI provenance';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXAI4:%' THEN RAISE; END IF;
  END;

  BEGIN
    UPDATE ai_observation_events SET reason='rewritten' WHERE id='82000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'AI observation mutation unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXAI1:%' THEN RAISE; END IF;
  END;

  BEGIN
    DELETE FROM ai_observation_outcomes
     WHERE id = (
       SELECT id FROM ai_observation_outcomes
        WHERE observation_id='82000000-0000-4000-8000-000000000002'
        ORDER BY recorded_at,id LIMIT 1
     );
    RAISE EXCEPTION 'AI outcome deletion unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXAI1:%' THEN RAISE; END IF;
  END;
END $$;

SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='ai_observation_events'
       AND column_name IN ('prompt','raw_prompt','prompt_text','output','raw_output','output_text')
  ),
  'AI observation schema must not expose raw prompt or output storage'
);

SELECT 'AI_OBSERVABILITY_DATABASE_CONTRACT_OK' AS result;

ROLLBACK;
