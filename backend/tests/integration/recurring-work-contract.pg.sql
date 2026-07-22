\set ON_ERROR_STOP on

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id UUID PRIMARY KEY,
  trust_tier INTEGER NOT NULL DEFAULT 3
);

CREATE TABLE tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  poster_id UUID NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  price INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'OPEN'
);

INSERT INTO users(id) VALUES
  ('00000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000002'),
  ('00000000-0000-0000-0000-000000000003'),
  ('00000000-0000-0000-0000-000000000004');

\ir ../../database/migrations/20260718_recurring_work_contract.sql

CREATE OR REPLACE FUNCTION assert_true(condition BOOLEAN, message TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF condition IS NOT TRUE THEN RAISE EXCEPTION 'assertion failed: %', message; END IF;
END $$;

DO $$
BEGIN
  BEGIN
    INSERT INTO recurring_task_series(
      poster_id,pattern,day_of_week,start_date,title,description,payment_cents,status,contract_version
    ) VALUES (
      '00000000-0000-0000-0000-000000000001','weekly',6,CURRENT_DATE,
      'Incomplete','Incomplete controlled template',10000,'active',2
    );
    RAISE EXCEPTION 'incomplete controlled template unexpectedly activated';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%HXREC1%' THEN RAISE; END IF;
  END;
END $$;

INSERT INTO recurring_task_series(
  id,poster_id,pattern,day_of_week,time_of_day,start_date,title,description,payment_cents,
  location,category,estimated_duration,required_tier,status,next_occurrence_at,
  contract_version,client_principal_type,client_principal_id,template_lineage_id,
  region_code,risk_level,rough_location,location_ciphertext,location_nonce,location_auth_tag,
  location_key_id,location_fingerprint,access_ciphertext,access_nonce,access_auth_tag,
  access_key_id,access_fingerprint,task_recipe,timezone,service_window_start,
  service_window_end,expected_duration_minutes,corridor_minimum_cents,
  corridor_maximum_cents,maximum_adjustment_cents,provider_payout_cents,
  platform_margin_cents,license_requirements,insurance_requirements,
  credentials_valid_until,required_tools,required_vehicle,completion_checklist,
  preferred_worker_id,backup_worker_ids,cancellation_rules,holiday_rules,
  budget_cap_cents,approver_id,escalation_rules,invoice_grouping,next_review_date,pause_code
) VALUES (
  '10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001',
  'weekly',6,'09:00',CURRENT_DATE,'Controlled cleaning','Complete the approved cleaning recipe',10000,
  'Bellevue','cleaning','120 minutes',3,'paused',NOW(),2,'HOUSEHOLD',
  '00000000-0000-0000-0000-000000000001','11000000-0000-0000-0000-000000000001',
  'US-WA','LOW','Bellevue','cipher-location','nonce-location','tag-location','key-v1','finger-location',
  'cipher-access','nonce-access','tag-access','key-v1','finger-access',
  '{"recipe":"commercial-cleaning-v1"}'::jsonb,'America/Los_Angeles','09:00','11:00',120,
  9000,12000,3000,8000,2000,'{}'::jsonb,'{}'::jsonb,NOW()+INTERVAL '30 days',
  ARRAY['vacuum','cleaning supplies'],NULL,'["Complete every checklist item","Upload final proof"]'::jsonb,
  '00000000-0000-0000-0000-000000000003',
  ARRAY['00000000-0000-0000-0000-000000000004']::uuid[],
  '{"notice_hours":24}'::jsonb,'{"skip_public_holidays":true}'::jsonb,50000,
  '00000000-0000-0000-0000-000000000002','{"on_exception":"pause"}'::jsonb,
  '{"group_by":"monthly"}'::jsonb,CURRENT_DATE+30,'ACTIVATION_PENDING'
);

INSERT INTO recurring_task_template_revisions(
  id,template_id,version,snapshot,snapshot_hash,change_reason,created_by
) VALUES (
  '12000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',1,
  '{"contract_version":2,"title":"Controlled cleaning"}'::jsonb,
  repeat('a',64),'Initial approved template','00000000-0000-0000-0000-000000000001'
);

UPDATE recurring_task_series SET
  current_revision_id='12000000-0000-0000-0000-000000000001',status='active',pause_code=NULL
WHERE id='10000000-0000-0000-0000-000000000001';

INSERT INTO tasks(id,poster_id,title,description,price,state,parent_series_id,occurrence_number,recurring_template_revision_id)
VALUES (
  '20000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001',
  'Occurrence 1','Separate canonical recurring task',10000,'OPEN',
  '10000000-0000-0000-0000-000000000001',1,'12000000-0000-0000-0000-000000000001'
);

INSERT INTO recurring_task_occurrences(
  id,series_id,task_id,occurrence_number,scheduled_date,status,template_revision_id,
  scheduled_start,scheduled_end,customer_total_cents,provider_payout_cents,
  platform_margin_cents,generation_key
) VALUES (
  '21000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000001',1,CURRENT_DATE,'posted',
  '12000000-0000-0000-0000-000000000001',NOW(),NOW()+INTERVAL '2 hours',10000,8000,2000,
  'recurring:10000000-0000-0000-0000-000000000001:1'
);

DO $$
BEGIN
  BEGIN
    INSERT INTO recurring_task_occurrences(
      series_id,task_id,occurrence_number,scheduled_date,status,template_revision_id,
      customer_total_cents,provider_payout_cents,platform_margin_cents,generation_key
    ) VALUES (
      '10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001',2,
      CURRENT_DATE+1,'posted','12000000-0000-0000-0000-000000000001',10000,8000,2000,'duplicate-task'
    );
    RAISE EXCEPTION 'duplicate task witness unexpectedly accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END $$;

SELECT record_recurring_safeguard_signal(
  '10000000-0000-0000-0000-000000000001','PRICE_CORRIDOR_BREACH','{}'::jsonb,NULL
);
SELECT record_recurring_safeguard_signal(
  '10000000-0000-0000-0000-000000000001','PRICE_CORRIDOR_BREACH','{}'::jsonb,NULL
);
SELECT assert_true(
  (SELECT status='paused' AND pause_code='PRICE_CORRIDOR_REPEATED' FROM recurring_task_series
   WHERE id='10000000-0000-0000-0000-000000000001'),
  'repeated corridor breach must pause'
);

UPDATE recurring_task_series SET status='active',pause_code=NULL,recovery_revision=recovery_revision+1,
  repeated_corridor_breach_count=0 WHERE id='10000000-0000-0000-0000-000000000001';
SELECT record_recurring_safeguard_signal(
  '10000000-0000-0000-0000-000000000001','PROVIDER_FAILURE','{}'::jsonb,NULL
);
SELECT record_recurring_safeguard_signal(
  '10000000-0000-0000-0000-000000000001','PROVIDER_FAILURE','{}'::jsonb,NULL
);
SELECT assert_true((SELECT pause_code='PROVIDER_FAILURE_REPEATED' FROM recurring_task_series
  WHERE id='10000000-0000-0000-0000-000000000001'),'provider failure must pause');

UPDATE recurring_task_series SET status='active',pause_code=NULL,recovery_revision=recovery_revision+1,
  repeated_provider_failure_count=0 WHERE id='10000000-0000-0000-0000-000000000001';
SELECT record_recurring_safeguard_signal(
  '10000000-0000-0000-0000-000000000001','BUDGET_SPEND','{"amount_cents":45000}'::jsonb,NULL
);
SELECT assert_true((SELECT pause_code='BUDGET_WOULD_EXCEED' FROM recurring_task_series
  WHERE id='10000000-0000-0000-0000-000000000001'),'budget breach must pause');

UPDATE recurring_task_series SET status='active',pause_code=NULL,recovery_revision=recovery_revision+1,
  budget_spend_cents=0 WHERE id='10000000-0000-0000-0000-000000000001';
SELECT record_recurring_safeguard_signal(
  '10000000-0000-0000-0000-000000000001','CREDENTIAL_EXPIRY',
  jsonb_build_object('valid_until',(NOW()-INTERVAL '1 second')::text),NULL
);
-- Credentials are optional while requirements are empty; make the requirement explicit and re-evaluate.
UPDATE recurring_task_series SET license_requirements='{"license":"required"}'::jsonb
WHERE id='10000000-0000-0000-0000-000000000001';
SELECT record_recurring_safeguard_signal(
  '10000000-0000-0000-0000-000000000001','CREDENTIAL_EXPIRY',
  jsonb_build_object('valid_until',(NOW()-INTERVAL '1 second')::text),NULL
);
SELECT assert_true((SELECT pause_code='CREDENTIAL_EXPIRED' FROM recurring_task_series
  WHERE id='10000000-0000-0000-0000-000000000001'),'credential expiry must pause');

UPDATE recurring_task_series SET status='active',pause_code=NULL,recovery_revision=recovery_revision+1,
  license_requirements='{}'::jsonb,credentials_valid_until=NOW()+INTERVAL '30 days'
WHERE id='10000000-0000-0000-0000-000000000001';
SELECT record_recurring_safeguard_signal(
  '10000000-0000-0000-0000-000000000001','LOCATION_CLOSED','{}'::jsonb,NULL
);
SELECT assert_true((SELECT pause_code='LOCATION_CLOSED' FROM recurring_task_series
  WHERE id='10000000-0000-0000-0000-000000000001'),'location closure must pause');

UPDATE recurring_task_series SET status='active',pause_code=NULL,recovery_revision=recovery_revision+1,
  location_closed_at=NULL WHERE id='10000000-0000-0000-0000-000000000001';
SELECT record_recurring_safeguard_signal(
  '10000000-0000-0000-0000-000000000001','DISPUTE_OPENED','{}'::jsonb,NULL
);
SELECT assert_true((SELECT pause_code='RECENT_DISPUTE' FROM recurring_task_series
  WHERE id='10000000-0000-0000-0000-000000000001'),'dispute must pause');

UPDATE recurring_task_series SET status='active',pause_code=NULL,recovery_revision=recovery_revision+1,
  open_dispute_count=0 WHERE id='10000000-0000-0000-0000-000000000001';
SELECT record_recurring_safeguard_signal(
  '10000000-0000-0000-0000-000000000001','MATERIAL_SCOPE_CHANGE','{}'::jsonb,NULL
);
SELECT assert_true((SELECT pause_code='MATERIAL_SCOPE_CHANGE' FROM recurring_task_series
  WHERE id='10000000-0000-0000-0000-000000000001'),'material scope change must pause');

UPDATE recurring_task_series SET status='active',pause_code=NULL,recovery_revision=recovery_revision+1,
  material_scope_change=FALSE WHERE id='10000000-0000-0000-0000-000000000001';
SELECT record_recurring_safeguard_signal(
  '10000000-0000-0000-0000-000000000001','FULFILLMENT_FAILURE','{}'::jsonb,NULL
);
SELECT record_recurring_safeguard_signal(
  '10000000-0000-0000-0000-000000000001','FULFILLMENT_FAILURE','{}'::jsonb,NULL
);
SELECT record_recurring_safeguard_signal(
  '10000000-0000-0000-0000-000000000001','FULFILLMENT_FAILURE','{}'::jsonb,NULL
);
SELECT assert_true((SELECT pause_code='FULFILLMENT_ATTEMPTS_EXHAUSTED' FROM recurring_task_series
  WHERE id='10000000-0000-0000-0000-000000000001'),'failed attempts must pause');

DO $$
BEGIN
  BEGIN
    PERFORM recover_recurring_template(
      '10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002',
      'Attempt before the failure counter is resolved','{"conditions_resolved":true}'::jsonb
    );
    RAISE EXCEPTION 'unresolved recovery unexpectedly accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%HXREC7%' THEN RAISE; END IF;
  END;
END $$;

UPDATE recurring_task_series SET failed_fulfillment_attempts=0
WHERE id='10000000-0000-0000-0000-000000000001';
SELECT recover_recurring_template(
  '10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002',
  'All failed fulfillment conditions were independently resolved',
  '{"conditions_resolved":true,"ticket":"REC-42"}'::jsonb
);
SELECT assert_true((SELECT status='active' AND pause_code IS NULL FROM recurring_task_series
  WHERE id='10000000-0000-0000-0000-000000000001'),'authorized recovery must reactivate');

UPDATE tasks SET state='DISPUTED' WHERE id='20000000-0000-0000-0000-000000000001';
SELECT assert_true((SELECT status='paused' AND pause_code='RECENT_DISPUTE' FROM recurring_task_series
  WHERE id='10000000-0000-0000-0000-000000000001'),'task dispute trigger must pause template');

INSERT INTO recurring_schedule_exceptions(
  template_id,template_revision_id,scheduled_start,reason,generation_key,evidence
) VALUES (
  '10000000-0000-0000-0000-000000000001','12000000-0000-0000-0000-000000000001',
  NOW()+INTERVAL '7 days','BLACKOUT_DATE','recurring:blackout:contract:001',
  '{"blackoutDate":"2026-12-25"}'::JSONB
);
DO $$
BEGIN
  BEGIN
    UPDATE recurring_schedule_exceptions SET reason='END_DATE_REACHED'
    WHERE generation_key='recurring:blackout:contract:001';
    RAISE EXCEPTION 'schedule exception mutation unexpectedly accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%append-only%' THEN RAISE; END IF;
  END;
END $$;

SELECT 'RECURRING_WORK_DATABASE_CONTRACT_OK' AS result;
