\set ON_ERROR_STOP on

BEGIN;
SET LOCAL hustlexp.is_test='true';

CREATE OR REPLACE FUNCTION pg_temp.hxstand_assert(condition BOOLEAN,message TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF condition IS NOT TRUE THEN RAISE EXCEPTION 'HXSTAND assertion failed: %',message; END IF;
END;
$$;

INSERT INTO users(
  id,email,full_name,default_mode,date_of_birth,is_minor,is_verified,phone,
  account_status,trust_tier,trust_hold,is_banned,plan
) VALUES
  ('e1000000-0000-4000-8000-000000000001','hxstand-worker@e2e.invalid','HX Standing Worker','worker','1990-01-01',FALSE,FALSE,'+12065550301','ACTIVE',2,FALSE,TRUE,'free'),
  ('e1000000-0000-4000-8000-000000000002','hxstand-admin1@e2e.invalid','HX Standing Admin One','poster','1990-01-01',FALSE,FALSE,'+12065550302','ACTIVE',3,FALSE,FALSE,'free'),
  ('e1000000-0000-4000-8000-000000000003','hxstand-admin2@e2e.invalid','HX Standing Admin Two','poster','1990-01-01',FALSE,FALSE,'+12065550303','ACTIVE',3,FALSE,FALSE,'free'),
  ('e1000000-0000-4000-8000-000000000004','hxstand-other@e2e.invalid','HX Standing Other Worker','worker','1990-01-01',FALSE,FALSE,'+12065550304','ACTIVE',1,FALSE,FALSE,'free')
ON CONFLICT (id) DO NOTHING;

INSERT INTO worker_standing_decisions(
  id,worker_id,decision_type,decision_state,current_tier,target_tier,reason_codes,
  public_explanation,policy_version,decision_source,decided_by,
  source_idempotency_key,appeal_deadline_at
) VALUES (
  'e2000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000001',
  'DEACTIVATION','WORK_ACCESS_DEACTIVATED',2,NULL,ARRAY['WORK_ACCESS_DEACTIVATED'],
  'Work access was deactivated after a standing-policy decision.',
  'worker-standing-appeals-v1','ADMIN','e1000000-0000-4000-8000-000000000002',
  'hxstand-decision-0001',NOW()+INTERVAL '30 days'
);

INSERT INTO worker_standing_appeal_access(decision_id,token_hash,expires_at)
VALUES ('e2000000-0000-4000-8000-000000000001',repeat('a',64),NOW()+INTERVAL '30 days');

INSERT INTO worker_standing_appeals(
  id,decision_id,worker_id,reason,request_hash,idempotency_key,review_due_at
) VALUES (
  'e3000000-0000-4000-8000-000000000001','e2000000-0000-4000-8000-000000000001',
  'e1000000-0000-4000-8000-000000000001',
  'The standing decision relied on an incorrect incident record.',repeat('b',64),
  'hxstand-appeal-0001',NOW()+INTERVAL '7 days'
);

INSERT INTO worker_standing_appeal_events(
  id,appeal_id,event_type,actor_role,actor_id,public_message,idempotency_key
) VALUES (
  'e4000000-0000-4000-8000-000000000001','e3000000-0000-4000-8000-000000000001',
  'OPENED','WORKER','e1000000-0000-4000-8000-000000000001',
  'Your appeal is recorded and awaits independent human review.','hxstand-event-opened-0001'
);

SELECT pg_temp.hxstand_assert(
  (SELECT ranking_penalty=0 FROM worker_standing_appeals WHERE id='e3000000-0000-4000-8000-000000000001'),
  'appeal must carry zero ranking penalty'
);
SELECT pg_temp.hxstand_assert(
  EXISTS (SELECT 1 FROM major_action_events
    WHERE source_table='worker_standing_appeal_events'
      AND source_event_id='e4000000-0000-4000-8000-000000000001'),
  'appeal lifecycle must mirror to major-action telemetry without narrative content'
);

DO $$
BEGIN
  BEGIN
    UPDATE worker_standing_appeals SET reason='A different appeal narrative that must not replace history.'
    WHERE id='e3000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'appeal authority fields unexpectedly changed';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXSTAND4:%' THEN RAISE; END IF;
  END;

  BEGIN
    UPDATE worker_standing_appeals
    SET status='UPHELD',resolution_note='The original decision is upheld after review.',
        resolved_by='e1000000-0000-4000-8000-000000000002',resolved_at=NOW(),
        outcome_effect_applied=TRUE
    WHERE id='e3000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'original decision maker unexpectedly resolved the appeal';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXSTAND7:%' THEN RAISE; END IF;
  END;

  BEGIN
    INSERT INTO worker_standing_appeal_evidence(
      appeal_id,worker_id,statement,request_hash,idempotency_key
    ) VALUES (
      'e3000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000004',
      'Cross-worker evidence.',repeat('c',64),'hxstand-cross-worker-0001'
    );
    RAISE EXCEPTION 'cross-worker evidence unexpectedly inserted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXSTAND8:%' THEN RAISE; END IF;
  END;
END;
$$;

UPDATE worker_standing_appeals
SET status='OVERTURNED',resolution_note='Independent evidence proved the original standing decision was incorrect.',
    resolved_by='e1000000-0000-4000-8000-000000000003',resolved_at=NOW(),
    outcome_effect_applied=TRUE
WHERE id='e3000000-0000-4000-8000-000000000001';

DO $$
BEGIN
  BEGIN
    UPDATE worker_standing_appeals SET status='UPHELD'
    WHERE id='e3000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'terminal appeal unexpectedly changed';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXSTAND5:%' THEN RAISE; END IF;
  END;

  BEGIN
    DELETE FROM worker_standing_appeal_events
    WHERE id='e4000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'append-only appeal event unexpectedly deleted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'HXSTAND1:%' THEN RAISE; END IF;
  END;
END;
$$;

SELECT 'WORKER_STANDING_APPEALS_DATABASE_CONTRACT_OK' AS result;
ROLLBACK;
