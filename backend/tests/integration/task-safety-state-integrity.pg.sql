\set ON_ERROR_STOP on

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (id UUID PRIMARY KEY);
CREATE TABLE tasks (
  id UUID PRIMARY KEY,
  poster_id UUID NOT NULL REFERENCES users(id),
  worker_id UUID REFERENCES users(id),
  state TEXT NOT NULL
);

INSERT INTO users(id) VALUES
  ('51000000-0000-4000-8000-000000000001'),
  ('51000000-0000-4000-8000-000000000002'),
  ('51000000-0000-4000-8000-000000000003'),
  ('51000000-0000-4000-8000-000000000004');

INSERT INTO tasks(id,poster_id,worker_id,state) VALUES (
  '52000000-0000-4000-8000-000000000001',
  '51000000-0000-4000-8000-000000000001',
  '51000000-0000-4000-8000-000000000002',
  'ACCEPTED'
);

\ir ../../database/migrations/20260718_task_safety_incident_cases.sql
\ir ../../database/migrations/20260718_task_safety_delivery_contract.sql
\ir ../../database/migrations/20260718_task_safety_checkins.sql
\ir ../../database/migrations/20260720_task_safety_state_integrity.sql
\ir ../../database/migrations/20260720_task_safety_resolution_integrity.sql
\ir ../../database/migrations/20260720_task_safety_case_access_integrity.sql

CREATE OR REPLACE FUNCTION pg_temp.hxsafety_assert(condition BOOLEAN,message TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF condition IS NOT TRUE THEN RAISE EXCEPTION 'HXSAFETY assertion failed: %',message; END IF;
END;
$$;

INSERT INTO task_safety_incidents(
  id,task_id,reporter_user_id,category,urgency,description,
  location_sharing_enabled,contact_permission,idempotency_key,request_hash
) VALUES (
  '53000000-0000-4000-8000-000000000001',
  '52000000-0000-4000-8000-000000000001',
  '51000000-0000-4000-8000-000000000002',
  'threat','urgent','A participant reported an immediate safety threat.',
  FALSE,'call','54000000-0000-4000-8000-000000000001',repeat('a',64)
);

SELECT pg_temp.hxsafety_assert(
  (SELECT status='received' AND delivery_state='received'
      AND acknowledged_at IS NULL AND delivery_event_id IS NULL
   FROM task_safety_incidents WHERE id='53000000-0000-4000-8000-000000000001'),
  'a new report must start received without contact delivery or human acknowledgment'
);

INSERT INTO task_safety_incident_events(
  id,incident_id,event_type,actor_user_id,public_message,
  provider_event_id,contact_channel,request_hash
) VALUES (
  '55000000-0000-4000-8000-000000000001',
  '53000000-0000-4000-8000-000000000001','contact_attempted',
  '51000000-0000-4000-8000-000000000003',
  'A safety call was attempted; delivery is not confirmed.',
  'voice:attempt:integrity:0001','call',repeat('b',64)
);
UPDATE task_safety_incidents
SET delivery_state='contact_attempted',
    delivery_event_id='55000000-0000-4000-8000-000000000001',updated_at=NOW()
WHERE id='53000000-0000-4000-8000-000000000001';

UPDATE task_safety_incidents
SET status='acknowledged',acknowledged_at=NOW(),
    assigned_admin_id='51000000-0000-4000-8000-000000000003',updated_at=NOW()
WHERE id='53000000-0000-4000-8000-000000000001';

SELECT pg_temp.hxsafety_assert(
  (SELECT status='acknowledged' AND delivery_state='contact_attempted'
      AND acknowledged_at IS NOT NULL
   FROM task_safety_incidents WHERE id='53000000-0000-4000-8000-000000000001'),
  'human acknowledgment must not overwrite contact-delivery truth'
);

INSERT INTO task_safety_incident_events(
  id,incident_id,event_type,actor_user_id,public_message,
  provider_event_id,contact_channel,request_hash
) VALUES (
  '55000000-0000-4000-8000-000000000002',
  '53000000-0000-4000-8000-000000000001','contact_delivered',
  '51000000-0000-4000-8000-000000000003',
  'The safety call was delivered; case acknowledgment remains separate.',
  'voice:delivered:integrity:0001','call',repeat('c',64)
);
UPDATE task_safety_incidents
SET delivery_state='contact_delivered',
    delivery_event_id='55000000-0000-4000-8000-000000000002',updated_at=NOW()
WHERE id='53000000-0000-4000-8000-000000000001';

INSERT INTO task_safety_incident_events(
  id,incident_id,event_type,actor_user_id,public_message,metadata
) VALUES (
  '55000000-0000-4000-8000-000000000005',
  '53000000-0000-4000-8000-000000000001','resolved',
  '51000000-0000-4000-8000-000000000003',
  'A safety operator confirmed the resolution plan with the participant.',
  jsonb_build_object(
    'resolution_code','safety_plan_confirmed',
    'idempotency_key','58000000-0000-4000-8000-000000000001',
    'request_hash',repeat('9',64)
  )
);
UPDATE task_safety_incidents
SET status='resolved',resolved_at=NOW(),updated_at=NOW()
WHERE id='53000000-0000-4000-8000-000000000001';

SELECT pg_temp.hxsafety_assert(
  (SELECT status='resolved' AND assigned_admin_id='51000000-0000-4000-8000-000000000003'
      AND resolved_at IS NOT NULL AND delivery_state='contact_delivered'
   FROM task_safety_incidents WHERE id='53000000-0000-4000-8000-000000000001'),
  'terminal resolution must retain owner, timestamp, and independent contact-delivery truth'
);

INSERT INTO task_safety_incidents(
  id,task_id,reporter_user_id,category,urgency,description,
  location_sharing_enabled,contact_permission,idempotency_key,request_hash
) VALUES (
  '53000000-0000-4000-8000-000000000002',
  '52000000-0000-4000-8000-000000000001',
  '51000000-0000-4000-8000-000000000001',
  'injury','urgent','A participant reported an injury requiring assistance.',
  FALSE,'text','54000000-0000-4000-8000-000000000002',repeat('d',64)
);
INSERT INTO task_safety_incident_events(
  id,incident_id,event_type,actor_user_id,public_message,
  provider_event_id,contact_channel,request_hash
) VALUES (
  '55000000-0000-4000-8000-000000000003',
  '53000000-0000-4000-8000-000000000002','contact_attempted',
  '51000000-0000-4000-8000-000000000003',
  'A safety text was attempted; delivery is not confirmed.',
  'sms:attempt:integrity:0002','text',repeat('e',64)
);
UPDATE task_safety_incidents
SET delivery_state='contact_attempted',
    delivery_event_id='55000000-0000-4000-8000-000000000003',updated_at=NOW()
WHERE id='53000000-0000-4000-8000-000000000002';

INSERT INTO task_safety_case_access_log(
  incident_id,admin_user_id,purpose,access_scope
) VALUES (
  '53000000-0000-4000-8000-000000000002',
  '51000000-0000-4000-8000-000000000003',
  'Review and respond to this active task safety case.',
  'CASE_DETAIL'
);
INSERT INTO task_safety_incident_events(
  id,incident_id,event_type,actor_user_id,public_message,
  provider_event_id,contact_channel,request_hash
) VALUES (
  '55000000-0000-4000-8000-000000000004',
  '53000000-0000-4000-8000-000000000002','contact_failed',
  '51000000-0000-4000-8000-000000000003',
  'The safety text failed; use the alternate emergency action.',
  'sms:failed:integrity:0002','text',repeat('f',64)
);
UPDATE task_safety_incidents
SET delivery_state='contact_failed',
    delivery_event_id='55000000-0000-4000-8000-000000000004',updated_at=NOW()
WHERE id='53000000-0000-4000-8000-000000000002';

SELECT pg_temp.hxsafety_assert(
  (SELECT delivery_state='contact_failed' AND status='received'
   FROM task_safety_incidents WHERE id='53000000-0000-4000-8000-000000000002'),
  'failed contact must remain distinct from platform receipt and acknowledgment'
);

UPDATE task_safety_incidents
SET status='acknowledged',acknowledged_at=NOW(),
    assigned_admin_id='51000000-0000-4000-8000-000000000003',updated_at=NOW()
WHERE id='53000000-0000-4000-8000-000000000002';

INSERT INTO task_safety_checkins(
  id,task_id,participant_user_id,duration_minutes,idempotency_key,request_hash,
  started_at,due_at
) VALUES (
  '56000000-0000-4000-8000-000000000001',
  '52000000-0000-4000-8000-000000000001',
  '51000000-0000-4000-8000-000000000002',15,
  '57000000-0000-4000-8000-000000000001',repeat('1',64),
  date_trunc('second',NOW()),date_trunc('second',NOW())+INTERVAL '15 minutes'
);
UPDATE task_safety_checkins
SET status='confirmed',confirmed_at=NOW(),updated_at=NOW()
WHERE id='56000000-0000-4000-8000-000000000001';

DO $$
BEGIN
  BEGIN
    UPDATE task_safety_case_access_log
    SET purpose='Rewritten safety access purpose.'
    WHERE incident_id='53000000-0000-4000-8000-000000000002';
    RAISE EXCEPTION 'safety case access evidence mutation unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE 'HX829' THEN NULL;
  END;

  BEGIN
    TRUNCATE task_safety_case_access_log;
    RAISE EXCEPTION 'safety case access evidence truncate unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE 'HX829' THEN NULL;
  END;

  BEGIN
    UPDATE task_safety_incidents
    SET assigned_admin_id='51000000-0000-4000-8000-000000000004'
    WHERE id='53000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'safety owner mutation unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE 'HX827' THEN NULL;
  END;

  BEGIN
    UPDATE task_safety_incidents SET status='resolved',resolved_at=NOW()
    WHERE id='53000000-0000-4000-8000-000000000002';
    RAISE EXCEPTION 'evidence-free safety resolution unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE 'HX828' THEN NULL;
  END;

  BEGIN
    INSERT INTO task_safety_incidents(
      task_id,reporter_user_id,category,urgency,description,
      location_sharing_enabled,contact_permission,idempotency_key,request_hash
    ) VALUES (
      '52000000-0000-4000-8000-000000000001',
      '51000000-0000-4000-8000-000000000004','other','standard',
      'A nonparticipant attempted to create a safety case.',FALSE,'in_app_only',
      '54000000-0000-4000-8000-000000000004',repeat('2',64)
    );
    RAISE EXCEPTION 'nonparticipant safety report unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE 'HX819' THEN NULL;
  END;

  BEGIN
    UPDATE task_safety_incidents SET description='Mutated safety evidence.'
    WHERE id='53000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'safety narrative mutation unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE 'HX821' THEN NULL;
  END;

  BEGIN
    UPDATE task_safety_incidents SET status='received',acknowledged_at=NULL
    WHERE id='53000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'acknowledgment rollback unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE 'HX822' THEN NULL;
  END;

  BEGIN
    UPDATE task_safety_incidents
    SET delivery_state='contact_delivered',
        delivery_event_id='55000000-0000-4000-8000-000000000003'
    WHERE id='53000000-0000-4000-8000-000000000002';
    RAISE EXCEPTION 'mismatched provider evidence unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE 'HX826' THEN NULL;
  END;

  BEGIN
    UPDATE task_safety_incidents
    SET delivery_state='acknowledged',delivery_event_id=NULL
    WHERE id='53000000-0000-4000-8000-000000000002';
    RAISE EXCEPTION 'human acknowledgment leaked into delivery state';
  EXCEPTION WHEN SQLSTATE 'HX825' THEN NULL;
  END;

  BEGIN
    UPDATE task_safety_incident_events SET public_message='Rewritten evidence'
    WHERE id='55000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'append-only safety event unexpectedly mutated';
  EXCEPTION WHEN SQLSTATE 'HX812' THEN NULL;
  END;

  BEGIN
    UPDATE task_safety_checkins SET status='active',confirmed_at=NULL
    WHERE id='56000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'confirmed check-in unexpectedly reopened';
  EXCEPTION WHEN SQLSTATE 'HX816' THEN NULL;
  END;
END;
$$;

SELECT 'TASK_SAFETY_STATE_INTEGRITY_DATABASE_CONTRACT_OK' AS result;
ROLLBACK;
