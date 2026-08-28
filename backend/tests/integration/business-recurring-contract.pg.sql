\set ON_ERROR_STOP on

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id UUID PRIMARY KEY,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  trust_tier INTEGER NOT NULL DEFAULT 3
);
CREATE TABLE tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  poster_id UUID NOT NULL REFERENCES users(id),
  worker_id UUID REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT,
  state TEXT NOT NULL DEFAULT 'OPEN',
  progress_state TEXT NOT NULL DEFAULT 'POSTED',
  price INTEGER NOT NULL,
  preferred_worker_id UUID REFERENCES users(id),
  deadline TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE escrows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL UNIQUE REFERENCES tasks(id),
  amount INTEGER NOT NULL,
  state TEXT NOT NULL,
  refund_amount INTEGER,
  release_amount INTEGER
);

INSERT INTO users(id,full_name,email) VALUES
  ('00000000-0000-4000-8000-000000000001','Workspace Owner','owner@example.com'),
  ('00000000-0000-4000-8000-000000000002','Workspace Approver','approver@example.com'),
  ('00000000-0000-4000-8000-000000000003','Workspace Requester','requester@example.com'),
  ('00000000-0000-4000-8000-000000000004','Primary Provider','provider@example.com'),
  ('00000000-0000-4000-8000-000000000005','Outside Actor','outside@example.com');

\ir ../../database/migrations/20260718_business_workspace_contract.sql
\ir ../../database/migrations/20260718_business_operations_contract.sql
\ir ../../database/migrations/20260718_recurring_work_contract.sql
\ir ../../database/migrations/20260718_business_execution_contract.sql
\ir ../../database/migrations/20260718_business_recurring_contract.sql

CREATE OR REPLACE FUNCTION assert_true(condition BOOLEAN, message TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF condition IS NOT TRUE THEN RAISE EXCEPTION 'assertion failed: %', message; END IF;
END $$;

SELECT * FROM create_business_organization(
  '00000000-0000-4000-8000-000000000001',
  'Eastside Retail LLC','Eastside Retail',FALSE,TRUE,'workspace:recurring:001'
);
SELECT * FROM set_business_member_role(
  (SELECT id FROM business_organizations WHERE display_name='Eastside Retail'),
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002','APPROVER'
);
SELECT * FROM set_business_member_role(
  (SELECT id FROM business_organizations WHERE display_name='Eastside Retail'),
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000003','REQUESTER'
);
SELECT * FROM create_business_location(
  (SELECT id FROM business_organizations WHERE display_name='Eastside Retail'),
  '00000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000001','Bellevue Store','Downtown Bellevue',
  '98004','US-WA','America/Los_Angeles',
  jsonb_build_object('ciphertext','address','nonce','n','authTag','t','keyId','v1','fingerprint',repeat('a',64)),
  jsonb_build_object('ciphertext','access','nonce','n','authTag','t','keyId','v1','fingerprint',repeat('b',64)),
  'location:recurring:001'
);
SELECT * FROM upsert_business_budget_policy(
  (SELECT id FROM business_organizations WHERE display_name='Eastside Retail'),
  '00000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000001','FACILITIES',
  10000,50000,10000,FALSE,FALSE
);

-- A real second organization/location proves scope cannot be crossed while
-- still satisfying foreign keys.
SELECT * FROM create_business_organization(
  '00000000-0000-4000-8000-000000000005',
  'Outside Retail LLC','Outside Retail',FALSE,TRUE,'workspace:recurring:outside'
);
SELECT * FROM create_business_location(
  (SELECT id FROM business_organizations WHERE display_name='Outside Retail'),
  '00000000-0000-4000-8000-000000000005',
  '40000000-0000-4000-8000-000000000002','Outside Store','Seattle',
  '98101','US-WA','America/Los_Angeles',
  jsonb_build_object('ciphertext','address2','nonce','n','authTag','t','keyId','v1','fingerprint',repeat('c',64)),
  jsonb_build_object('ciphertext','access2','nonce','n','authTag','t','keyId','v1','fingerprint',repeat('d',64)),
  'location:recurring:outside'
);

DO $$
BEGIN
  BEGIN
    INSERT INTO recurring_task_series(
      id,poster_id,pattern,day_of_week,time_of_day,start_date,title,description,payment_cents,
      location,category,estimated_duration,required_tier,status,next_occurrence_at,
      contract_version,client_principal_type,client_principal_id,template_lineage_id,
      region_code,risk_level,rough_location,location_ciphertext,location_nonce,location_auth_tag,
      location_key_id,location_fingerprint,access_ciphertext,access_nonce,access_auth_tag,
      access_key_id,access_fingerprint,task_recipe,timezone,service_window_start,service_window_end,
      expected_duration_minutes,corridor_minimum_cents,corridor_maximum_cents,
      maximum_adjustment_cents,provider_payout_cents,platform_margin_cents,license_requirements,
      insurance_requirements,required_tools,completion_checklist,backup_worker_ids,
      cancellation_rules,holiday_rules,budget_cap_cents,approver_id,escalation_rules,
      invoice_grouping,next_review_date,pause_code,business_organization_id,business_location_id
    ) VALUES (
      '10000000-0000-4000-8000-000000000099','00000000-0000-4000-8000-000000000003',
      'weekly',2,'09:00',CURRENT_DATE,'Cross-scope template','Must be rejected',8000,
      'Bellevue','FACILITIES','120 minutes',2,'paused',NOW(),2,'ORGANIZATION',
      (SELECT id FROM business_organizations WHERE display_name='Eastside Retail'),
      '11000000-0000-4000-8000-000000000099','US-WA','MEDIUM','Bellevue',
      'cipher','nonce','tag','key','finger','cipher','nonce','tag','key','finger',
      '{}'::jsonb,'America/Los_Angeles','09:00','11:00',120,8000,8000,0,6800,1200,
      '{}'::jsonb,'{}'::jsonb,ARRAY[]::TEXT[],'["Upload proof"]'::jsonb,
      ARRAY[]::UUID[],'{}'::jsonb,'{}'::jsonb,50000,
      '00000000-0000-4000-8000-000000000003','{}'::jsonb,'{}'::jsonb,CURRENT_DATE+30,
      'ACTIVATION_PENDING',(SELECT id FROM business_organizations WHERE display_name='Eastside Retail'),
      '40000000-0000-4000-8000-000000000002'
    );
    RAISE EXCEPTION 'cross-organization recurring location unexpectedly accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%HXBUSREC1%' THEN RAISE; END IF;
  END;
END $$;

INSERT INTO recurring_task_series(
  id,poster_id,pattern,day_of_week,time_of_day,start_date,title,description,payment_cents,
  location,category,estimated_duration,required_tier,status,next_occurrence_at,
  contract_version,client_principal_type,client_principal_id,template_lineage_id,
  region_code,risk_level,rough_location,location_ciphertext,location_nonce,location_auth_tag,
  location_key_id,location_fingerprint,access_ciphertext,access_nonce,access_auth_tag,
  access_key_id,access_fingerprint,task_recipe,timezone,service_window_start,service_window_end,
  expected_duration_minutes,corridor_minimum_cents,corridor_maximum_cents,
  maximum_adjustment_cents,provider_payout_cents,platform_margin_cents,license_requirements,
  insurance_requirements,required_tools,completion_checklist,preferred_worker_id,backup_worker_ids,
  cancellation_rules,holiday_rules,budget_cap_cents,approver_id,escalation_rules,
  invoice_grouping,next_review_date,pause_code,business_organization_id,business_location_id
) VALUES (
  '10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000003',
  'weekly',2,'09:00',CURRENT_DATE,'Storefront reset','Reset and document storefront',8000,
  'Bellevue','FACILITIES','120 minutes',2,'paused',NOW(),2,'ORGANIZATION',
  (SELECT id FROM business_organizations WHERE display_name='Eastside Retail'),
  '11000000-0000-4000-8000-000000000001','US-WA','MEDIUM','Bellevue',
  'cipher','nonce','tag','key','finger','cipher','nonce','tag','key','finger',
  '{}'::jsonb,'America/Los_Angeles','09:00','11:00',120,8000,8000,0,6800,1200,
  '{}'::jsonb,'{}'::jsonb,ARRAY[]::TEXT[],'["Upload proof"]'::jsonb,
  '00000000-0000-4000-8000-000000000004',ARRAY[]::UUID[],
  '{}'::jsonb,'{}'::jsonb,50000,'00000000-0000-4000-8000-000000000003',
  '{}'::jsonb,'{}'::jsonb,CURRENT_DATE+30,'ACTIVATION_PENDING',
  (SELECT id FROM business_organizations WHERE display_name='Eastside Retail'),
  '40000000-0000-4000-8000-000000000001'
);
INSERT INTO recurring_task_template_revisions(
  id,template_id,version,snapshot,snapshot_hash,change_reason,created_by
) VALUES (
  '12000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',1,
  '{"contractVersion":2,"autoApproveLimitCents":10000}'::jsonb,repeat('a',64),
  'Initial approved Business template','00000000-0000-4000-8000-000000000003'
);
UPDATE recurring_task_series SET
  current_revision_id='12000000-0000-4000-8000-000000000001',status='active',pause_code=NULL
WHERE id='10000000-0000-4000-8000-000000000001';

INSERT INTO tasks(
  id,poster_id,title,description,category,price,parent_series_id,occurrence_number,
  recurring_template_revision_id
) VALUES (
  '50000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000003',
  'Unapproved occurrence','Must be rejected','FACILITIES',8000,
  '10000000-0000-4000-8000-000000000001',1,'12000000-0000-4000-8000-000000000001'
);
DO $$
BEGIN
  BEGIN
    INSERT INTO recurring_task_occurrences(
      series_id,task_id,occurrence_number,scheduled_date,status,template_revision_id,
      customer_total_cents,provider_payout_cents,platform_margin_cents,generation_key
    ) VALUES (
      '10000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001',1,
      CURRENT_DATE,'posted','12000000-0000-4000-8000-000000000001',8000,6800,1200,
      'recurring:business:unapproved'
    );
    RAISE EXCEPTION 'unapproved Business occurrence unexpectedly accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%HXBUSREC3%' THEN RAISE; END IF;
  END;
END $$;

SELECT * FROM request_business_spend(
  (SELECT id FROM business_organizations WHERE display_name='Eastside Retail'),
  '00000000-0000-4000-8000-000000000003',
  '40000000-0000-4000-8000-000000000001','FACILITIES',8000,NULL,NULL,
  'recurring:business:approved'
);
INSERT INTO tasks(
  id,poster_id,title,description,category,price,parent_series_id,occurrence_number,
  recurring_template_revision_id
) VALUES (
  '50000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000003',
  'Approved occurrence','Canonical Business occurrence','FACILITIES',8000,
  '10000000-0000-4000-8000-000000000001',1,'12000000-0000-4000-8000-000000000001'
);
INSERT INTO escrows(task_id,amount,state) VALUES
  ('50000000-0000-4000-8000-000000000002',8000,'PENDING');
SELECT * FROM bind_business_work_order(
  (SELECT id FROM business_organizations WHERE display_name='Eastside Retail'),
  '00000000-0000-4000-8000-000000000003',
  (SELECT id FROM business_approval_requests WHERE idempotency_key='recurring:business:approved'),
  '50000000-0000-4000-8000-000000000002'
);
INSERT INTO recurring_task_occurrences(
  series_id,task_id,occurrence_number,scheduled_date,status,template_revision_id,
  customer_total_cents,provider_payout_cents,platform_margin_cents,generation_key,
  business_approval_request_id
) VALUES (
  '10000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000002',1,
  CURRENT_DATE,'posted','12000000-0000-4000-8000-000000000001',8000,6800,1200,
  'recurring:business:approved',
  (SELECT id FROM business_approval_requests WHERE idempotency_key='recurring:business:approved')
);
SELECT assert_true(
  (SELECT COUNT(*)=1 FROM recurring_task_occurrences WHERE business_approval_request_id IS NOT NULL),
  'approved recurring occurrence must retain its Business approval witness'
);
SELECT assert_true(
  (SELECT COUNT(*)=1 FROM business_spend_ledger WHERE entry_type='COMMITTED'),
  'approved recurring occurrence must share the canonical Business spend ledger'
);

UPDATE business_locations SET status='CLOSED'
WHERE id='40000000-0000-4000-8000-000000000001';
SELECT assert_true(
  (SELECT status='paused' AND pause_code='LOCATION_CLOSED'
   FROM recurring_task_series WHERE id='10000000-0000-4000-8000-000000000001'),
  'closing the authoritative Business location must immediately pause recurrence'
);

UPDATE business_locations SET status='ACTIVE'
WHERE id='40000000-0000-4000-8000-000000000001';
UPDATE recurring_task_series SET status='active',pause_code=NULL,
  recovery_revision=recovery_revision+1
WHERE id='10000000-0000-4000-8000-000000000001';
SELECT * FROM set_business_member_role(
  (SELECT id FROM business_organizations WHERE display_name='Eastside Retail'),
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000003','VIEWER'
);
SELECT assert_true(
  (SELECT status='paused' AND pause_code='BUSINESS_AUTHORITY_REVOKED'
   FROM recurring_task_series WHERE id='10000000-0000-4000-8000-000000000001'),
  'revoking the template requester role must immediately pause recurrence'
);

SELECT * FROM set_business_member_role(
  (SELECT id FROM business_organizations WHERE display_name='Eastside Retail'),
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000003','REQUESTER'
);
UPDATE recurring_task_series SET status='active',pause_code=NULL,
  recovery_revision=recovery_revision+1
WHERE id='10000000-0000-4000-8000-000000000001';
UPDATE business_organizations SET provider_enabled=TRUE,client_enabled=FALSE
WHERE display_name='Eastside Retail';
SELECT assert_true(
  (SELECT status='paused' AND pause_code='BUSINESS_WORKSPACE_INACTIVE'
   FROM recurring_task_series WHERE id='10000000-0000-4000-8000-000000000001'),
  'disabling Business client mode must immediately pause recurrence'
);

SELECT 'BUSINESS_RECURRING_DATABASE_CONTRACT_OK' AS result;
