\set ON_ERROR_STOP on

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE users (
  id UUID PRIMARY KEY,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE
);
CREATE TABLE tasks (
  id UUID PRIMARY KEY,
  poster_id UUID NOT NULL REFERENCES users(id),
  worker_id UUID REFERENCES users(id),
  title TEXT NOT NULL,
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
  ('00000000-0000-4000-8000-000000000005','Backup Provider','backup@example.com'),
  ('00000000-0000-4000-8000-000000000006','Outside Actor','outside@example.com');

\ir ../../database/migrations/20260718_business_workspace_contract.sql
\ir ../../database/migrations/20260718_business_operations_contract.sql
\ir ../../database/migrations/20260718_business_execution_contract.sql

CREATE OR REPLACE FUNCTION assert_true(condition BOOLEAN, message TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF condition IS NOT TRUE THEN RAISE EXCEPTION 'assertion failed: %', message; END IF;
END $$;

SELECT * FROM create_business_organization(
  '00000000-0000-4000-8000-000000000001',
  'Eastside Field Services LLC','Eastside Field Services',TRUE,TRUE,
  'workspace:execution:001'
);
SELECT * FROM set_business_member_role(
  (SELECT id FROM business_organizations LIMIT 1),
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002','APPROVER'
);
SELECT * FROM set_business_member_role(
  (SELECT id FROM business_organizations LIMIT 1),
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000003','REQUESTER'
);
SELECT * FROM create_business_location(
  (SELECT id FROM business_organizations LIMIT 1),
  '00000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000001',
  'Bellevue Store 12','Downtown Bellevue','98004','US-WA','America/Los_Angeles',
  jsonb_build_object('ciphertext','address-cipher','nonce','n','authTag','t','keyId','v1','fingerprint',repeat('a',64)),
  jsonb_build_object('ciphertext','access-cipher','nonce','n','authTag','t','keyId','v1','fingerprint',repeat('b',64)),
  'location:execution:001'
);

SELECT * FROM upsert_business_budget_policy(
  (SELECT id FROM business_organizations LIMIT 1),
  '00000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000001','FACILITIES',
  10000,15000,0,FALSE,FALSE
);

-- Create and approve both requests before either commitment. The second bind
-- must recheck the cap and fail after the first commitment consumes budget.
SELECT * FROM request_business_spend(
  (SELECT id FROM business_organizations LIMIT 1),
  '00000000-0000-4000-8000-000000000003',
  '40000000-0000-4000-8000-000000000001','FACILITIES',
  8000,NULL,NULL,'spend:execution:001'
);
SELECT * FROM request_business_spend(
  (SELECT id FROM business_organizations LIMIT 1),
  '00000000-0000-4000-8000-000000000003',
  '40000000-0000-4000-8000-000000000001','FACILITIES',
  8000,NULL,NULL,'spend:execution:002'
);
SELECT * FROM decide_business_approval(
  (SELECT id FROM business_organizations LIMIT 1),
  '00000000-0000-4000-8000-000000000002',
  (SELECT id FROM business_approval_requests WHERE idempotency_key='spend:execution:001'),
  'APPROVED','Approved before commitment'
);
SELECT * FROM decide_business_approval(
  (SELECT id FROM business_organizations LIMIT 1),
  '00000000-0000-4000-8000-000000000002',
  (SELECT id FROM business_approval_requests WHERE idempotency_key='spend:execution:002'),
  'APPROVED','Approved before commitment'
);

SELECT * FROM set_business_provider_preference(
  (SELECT id FROM business_organizations LIMIT 1),
  '00000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000001','FACILITIES',
  '00000000-0000-4000-8000-000000000004','PRIMARY'
);
SELECT * FROM set_business_provider_preference(
  (SELECT id FROM business_organizations LIMIT 1),
  '00000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000001','FACILITIES',
  '00000000-0000-4000-8000-000000000005','BACKUP'
);

INSERT INTO tasks(id,poster_id,title,category,price,deadline) VALUES
  ('50000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000003',
   'Repair storefront fixture','FACILITIES',8000,NOW()+INTERVAL '1 day'),
  ('50000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000003',
   'Repair second fixture','FACILITIES',8000,NOW()+INTERVAL '1 day');
INSERT INTO escrows(task_id,amount,state) VALUES
  ('50000000-0000-4000-8000-000000000001',8000,'PENDING'),
  ('50000000-0000-4000-8000-000000000002',8000,'PENDING');

SELECT * FROM bind_business_work_order(
  (SELECT id FROM business_organizations LIMIT 1),
  '00000000-0000-4000-8000-000000000003',
  (SELECT id FROM business_approval_requests WHERE idempotency_key='spend:execution:001'),
  '50000000-0000-4000-8000-000000000001'
);
SELECT assert_true(
  (SELECT business_organization_id=(SELECT id FROM business_organizations LIMIT 1)
      AND business_location_id='40000000-0000-4000-8000-000000000001'
      AND business_requester_id='00000000-0000-4000-8000-000000000003'
      AND business_approver_id='00000000-0000-4000-8000-000000000002'
      AND preferred_worker_id='00000000-0000-4000-8000-000000000004'
      AND worker_id IS NULL
   FROM tasks WHERE id='50000000-0000-4000-8000-000000000001'),
  'binding must record provenance and preference without assigning the worker'
);
SELECT assert_true(
  (SELECT COUNT(*)=1 FROM business_spend_ledger WHERE entry_type='COMMITTED'),
  'binding must commit one spend ledger row'
);

-- Exact replay is accepted.
SELECT * FROM bind_business_work_order(
  (SELECT id FROM business_organizations LIMIT 1),
  '00000000-0000-4000-8000-000000000003',
  (SELECT id FROM business_approval_requests WHERE idempotency_key='spend:execution:001'),
  '50000000-0000-4000-8000-000000000001'
);
SELECT assert_true(
  (SELECT COUNT(*)=1 FROM business_spend_ledger WHERE entry_type='COMMITTED'),
  'binding replay must not duplicate committed spend'
);

DO $$
BEGIN
  BEGIN
    PERFORM bind_business_work_order(
      (SELECT id FROM business_organizations LIMIT 1),
      '00000000-0000-4000-8000-000000000003',
      (SELECT id FROM business_approval_requests WHERE idempotency_key='spend:execution:002'),
      '50000000-0000-4000-8000-000000000002'
    );
    RAISE EXCEPTION 'commit-time budget breach unexpectedly accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%HXBUS33%' THEN RAISE; END IF;
  END;
END $$;
SELECT assert_true(
  (SELECT business_organization_id IS NULL FROM tasks
   WHERE id='50000000-0000-4000-8000-000000000002'),
  'failed bind must not leave business provenance on the task'
);

DO $$
BEGIN
  BEGIN
    PERFORM bind_business_work_order(
      (SELECT id FROM business_organizations LIMIT 1),
      '00000000-0000-4000-8000-000000000006',
      (SELECT id FROM business_approval_requests WHERE idempotency_key='spend:execution:001'),
      '50000000-0000-4000-8000-000000000001'
    );
    RAISE EXCEPTION 'outside actor bind unexpectedly accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%HXBUS2%' THEN RAISE; END IF;
  END;
END $$;

-- Only terminal canonical escrow outcomes enter an invoice snapshot.
UPDATE tasks SET state='COMPLETED',progress_state='COMPLETED',completed_at=NOW()
WHERE id='50000000-0000-4000-8000-000000000001';
UPDATE escrows SET state='RELEASED',release_amount=8000
WHERE task_id='50000000-0000-4000-8000-000000000001';
SELECT * FROM create_business_invoice_snapshot(
  (SELECT id FROM business_organizations LIMIT 1),
  '00000000-0000-4000-8000-000000000001',
  NOW()-INTERVAL '1 day',NOW()+INTERVAL '1 hour',
  '{"groupBy":"monthly"}'::JSONB,'invoice:execution:001'
);
SELECT assert_true(
  (SELECT transaction_count=1 AND customer_total_cents=8000
      AND refunded_total_cents=0 AND settled_total_cents=8000
   FROM business_invoice_snapshots WHERE idempotency_key='invoice:execution:001'),
  'invoice snapshot must include exactly one terminal settled transaction'
);
SELECT assert_true(
  (SELECT COUNT(*)=1 FROM business_work_order_reporting
   WHERE organization_id=(SELECT id FROM business_organizations LIMIT 1)),
  'reporting must derive from the one canonical bound task'
);

DO $$
BEGIN
  BEGIN
    UPDATE business_invoice_snapshots SET settled_total_cents=0;
    RAISE EXCEPTION 'invoice snapshot mutation unexpectedly accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%HXBUS40%' THEN RAISE; END IF;
  END;
END $$;

SELECT 'BUSINESS_EXECUTION_DATABASE_CONTRACT_OK' AS result;
