\set ON_ERROR_STOP on

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (id UUID PRIMARY KEY);
CREATE TABLE escrows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL UNIQUE,
  state TEXT NOT NULL,
  stripe_transfer_id TEXT
);

INSERT INTO users(id) VALUES ('00000000-0000-4000-8000-000000000001');

\ir ../../database/migrations/20260719_recommendation_contract.sql

CREATE OR REPLACE FUNCTION assert_true(condition BOOLEAN, message TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF condition IS NOT TRUE THEN RAISE EXCEPTION 'assertion failed: %', message; END IF;
END $$;

INSERT INTO escrows(id,task_id,state) VALUES
  ('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','FUNDED'),
  ('10000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000002','FUNDED');

INSERT INTO recommendations(
  id,recipient_user_id,subject_type,subject_id,recommendation_class,source_type,
  recommendation_text,reason,evidence_classes,expected_benefit,downside,
  confidence_band,model_version,policy_version,scope_affected,user_controls,
  request_hash,idempotency_key,expires_at
) VALUES
  (
    '30000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001',
    'TASK','20000000-0000-4000-8000-000000000001','ECONOMIC','DETERMINISTIC',
    'Review this exact task offer','Current availability and verified offer facts match',
    '["availability","offer_economics"]'::jsonb,'A nearby paid task may fit current availability',
    'Travel and duration can vary','LIKELY',NULL,'hxos-task-suggestion-v1','one task offer',
    '{"open":true,"dismiss":true,"snooze":true,"why":true,"autoExecute":false}'::jsonb,
    repeat('a',64),'recommendation:task:0001',NOW()+INTERVAL '1 day'
  ),
  (
    '30000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001',
    'TASK','20000000-0000-4000-8000-000000000002','ECONOMIC','DETERMINISTIC',
    'Review this second task offer','Verified task facts match current filters',
    '["offer_economics"]'::jsonb,'Another paid task may fit','Settlement rail may be incomplete',
    'SUGGESTION',NULL,'hxos-task-suggestion-v1','one task offer',
    '{"open":true,"dismiss":true,"why":true,"autoExecute":false}'::jsonb,
    repeat('b',64),'recommendation:task:0002',NOW()+INTERVAL '1 day'
  );

UPDATE escrows
SET state='RELEASED',stripe_transfer_id='tr_test_connected_balance'
WHERE task_id='20000000-0000-4000-8000-000000000001';

SELECT assert_true(
  (SELECT realized_value = '{"escrowState":"RELEASED","settlementRail":"CONNECTED_BALANCE","bankPayoutConfirmed":false}'::jsonb
   FROM recommendation_outcomes
   WHERE recommendation_id='30000000-0000-4000-8000-000000000001'),
  'provider transfer must record connected-balance settlement without claiming bank payout'
);

UPDATE escrows
SET state='RELEASED'
WHERE task_id='20000000-0000-4000-8000-000000000002';

SELECT assert_true(
  (SELECT realized_value->>'settlementRail' = 'RELEASE_STATE_ONLY'
   FROM recommendation_outcomes
   WHERE recommendation_id='30000000-0000-4000-8000-000000000002'),
  'release without provider transfer must not claim connected-balance settlement'
);

UPDATE escrows SET state='RELEASED'
WHERE task_id='20000000-0000-4000-8000-000000000001';

SELECT assert_true(
  (SELECT count(*)=1 FROM recommendation_outcomes
   WHERE recommendation_id='30000000-0000-4000-8000-000000000001'
     AND outcome_type='TASK_SETTLED'),
  'release replay must not duplicate settlement evidence'
);

DO $$
BEGIN
  BEGIN
    UPDATE recommendation_outcomes
    SET realized_value='{"bankPayoutConfirmed":true}'::jsonb
    WHERE recommendation_id='30000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'immutable outcome update unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXREC1:%' THEN RAISE; END IF;
  END;

  BEGIN
    INSERT INTO recommendation_events(
      recommendation_id,actor_id,event_type,idempotency_key,request_hash,ranking_penalty
    ) VALUES (
      '30000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001',
      'DISMISSED','dismiss:task:0001',repeat('c',64),-1
    );
    RAISE EXCEPTION 'non-zero dismissal penalty unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

SELECT 'RECOMMENDATION_DATABASE_CONTRACT_OK' AS result;
