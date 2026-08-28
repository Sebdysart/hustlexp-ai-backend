\set ON_ERROR_STOP on

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id UUID PRIMARY KEY,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE
);

INSERT INTO users(id,full_name,email) VALUES
  ('00000000-0000-4000-8000-000000000001','Workspace Owner','owner@example.com'),
  ('00000000-0000-4000-8000-000000000002','Workspace Approver','approver@example.com'),
  ('00000000-0000-4000-8000-000000000003','Workspace Requester','requester@example.com'),
  ('00000000-0000-4000-8000-000000000004','Workspace Viewer','viewer@example.com'),
  ('00000000-0000-4000-8000-000000000005','Workspace Crew','crew@example.com'),
  ('00000000-0000-4000-8000-000000000006','Outside Organization','outside@example.com');

\ir ../../database/migrations/20260718_business_workspace_contract.sql
\ir ../../database/migrations/20260718_business_operations_contract.sql

CREATE OR REPLACE FUNCTION assert_true(condition BOOLEAN, message TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF condition IS NOT TRUE THEN RAISE EXCEPTION 'assertion failed: %', message; END IF;
END $$;

SELECT * FROM create_business_organization(
  '00000000-0000-4000-8000-000000000001',
  'Eastside Field Services LLC','Eastside Field Services',TRUE,TRUE,
  'workspace:operations:001'
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
SELECT * FROM set_business_member_role(
  (SELECT id FROM business_organizations LIMIT 1),
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000004','VIEWER'
);
SELECT * FROM set_business_member_role(
  (SELECT id FROM business_organizations LIMIT 1),
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000005','CREW'
);

SELECT * FROM create_business_location(
  (SELECT id FROM business_organizations LIMIT 1),
  '00000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000001',
  'Bellevue Store 12','Downtown Bellevue','98004','US-WA','America/Los_Angeles',
  jsonb_build_object(
    'ciphertext','cipher-address','nonce','nonce-address','authTag','tag-address',
    'keyId','location-v1','fingerprint',repeat('a',64)
  ),
  jsonb_build_object(
    'ciphertext','cipher-access','nonce','nonce-access','authTag','tag-access',
    'keyId','location-v1','fingerprint',repeat('b',64)
  ),
  'location:operations:12'
);

SELECT * FROM upsert_business_budget_policy(
  (SELECT id FROM business_organizations LIMIT 1),
  '00000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000001','FACILITIES',
  20000,100000,10000,TRUE,TRUE
);

SELECT * FROM request_business_spend(
  (SELECT id FROM business_organizations LIMIT 1),
  '00000000-0000-4000-8000-000000000003',
  '40000000-0000-4000-8000-000000000001','FACILITIES',
  8000,'PO-1042','FACILITIES','spend:auto:001'
);
SELECT assert_true(
  (SELECT status='AUTO_APPROVED' AND blockers=ARRAY[]::TEXT[]
   FROM business_approval_requests WHERE idempotency_key='spend:auto:001'),
  'compliant spend below threshold must auto-approve'
);

SELECT * FROM request_business_spend(
  (SELECT id FROM business_organizations LIMIT 1),
  '00000000-0000-4000-8000-000000000003',
  '40000000-0000-4000-8000-000000000001','FACILITIES',
  15000,'PO-1043','FACILITIES','spend:pending:001'
);
SELECT assert_true(
  (SELECT status='PENDING_APPROVAL' FROM business_approval_requests
   WHERE idempotency_key='spend:pending:001'),
  'spend above auto threshold must wait for a separate approver'
);
SELECT * FROM decide_business_approval(
  (SELECT id FROM business_organizations LIMIT 1),
  '00000000-0000-4000-8000-000000000002',
  (SELECT id FROM business_approval_requests WHERE idempotency_key='spend:pending:001'),
  'APPROVED','Necessary facilities response'
);
SELECT assert_true(
  (SELECT status='APPROVED' FROM business_approval_requests
   WHERE idempotency_key='spend:pending:001'),
  'separate authorized approver must be able to approve pending spend'
);

SELECT * FROM request_business_spend(
  (SELECT id FROM business_organizations LIMIT 1),
  '00000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000001','FACILITIES',
  15000,'PO-1044','FACILITIES','spend:self:001'
);
DO $$
BEGIN
  BEGIN
    PERFORM decide_business_approval(
      (SELECT id FROM business_organizations LIMIT 1),
      '00000000-0000-4000-8000-000000000001',
      (SELECT id FROM business_approval_requests WHERE idempotency_key='spend:self:001'),
      'APPROVED','Owner attempted self approval'
    );
    RAISE EXCEPTION 'self approval unexpectedly accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%HXBUS26%' THEN RAISE; END IF;
  END;
END $$;

SELECT * FROM request_business_spend(
  (SELECT id FROM business_organizations LIMIT 1),
  '00000000-0000-4000-8000-000000000003',
  '40000000-0000-4000-8000-000000000001','FACILITIES',
  25000,NULL,NULL,'spend:blocked:001'
);
SELECT assert_true(
  (SELECT status='BLOCKED' AND blockers=ARRAY[
    'PER_TASK_CAP_EXCEEDED','PURCHASE_ORDER_REQUIRED','COST_CENTER_REQUIRED'
   ]::TEXT[] FROM business_approval_requests WHERE idempotency_key='spend:blocked:001'),
  'hard caps and purchase controls must produce deterministic blockers'
);

DO $$
BEGIN
  BEGIN
    PERFORM request_business_spend(
      (SELECT id FROM business_organizations LIMIT 1),
      '00000000-0000-4000-8000-000000000004',
      '40000000-0000-4000-8000-000000000001','FACILITIES',
      8000,'PO-ATTACK','FACILITIES','spend:viewer:attack'
    );
    RAISE EXCEPTION 'viewer spend request unexpectedly accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%HXBUS2%' THEN RAISE; END IF;
  END;
END $$;

DO $$
BEGIN
  BEGIN
    PERFORM request_business_spend(
      (SELECT id FROM business_organizations LIMIT 1),
      '00000000-0000-4000-8000-000000000003',
      '40000000-0000-4000-8000-000000000001','FACILITIES',
      9000,'PO-DIFFERENT','FACILITIES','spend:auto:001'
    );
    RAISE EXCEPTION 'spend idempotency conflict unexpectedly accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%HXBUS4%' THEN RAISE; END IF;
  END;
END $$;

DO $$
BEGIN
  BEGIN
    UPDATE business_approval_decisions SET reason='tampered';
    RAISE EXCEPTION 'approval evidence mutation unexpectedly accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%HXBUS20%' THEN RAISE; END IF;
  END;
END $$;

SELECT * FROM create_business_service_profile(
  (SELECT id FROM business_organizations LIMIT 1),
  '00000000-0000-4000-8000-000000000001',
  'ELECTRICAL','Commercial electrical response',
  'Qualified commercial electrical response with documented proof.',
  ARRAY['Utility-owned equipment'],'[]'::JSONB,ARRAY[]::TEXT[],20,0,ARRAY[]::DATE[],
  'INSTANT_CORRIDOR',15000,10000,'INDIVIDUAL_OFFERS','[]'::JSONB,
  '["ELECTRICAL_LICENSE"]'::JSONB,'service:electrical:001'
);

SELECT * FROM activate_business_service_profile(
  (SELECT id FROM business_organizations LIMIT 1),
  '00000000-0000-4000-8000-000000000001',
  (SELECT id FROM business_service_profiles WHERE service_code='ELECTRICAL')
);
SELECT assert_true(
  (SELECT outcome='BLOCKED' AND blockers=ARRAY[
    'LEGAL_ENTITY_NOT_VERIFIED','PAYOUT_NOT_ACTIVE','COVERAGE_REQUIRED',
    'CAPACITY_REQUIRED','ELIGIBLE_CREW_REQUIRED','INVALID_PRICE_CORRIDOR',
    'PROOF_RECIPE_REQUIRED','CREDENTIALS_NOT_MET'
   ]::TEXT[] FROM business_service_activation_events ORDER BY created_at DESC LIMIT 1),
  'provider activation must enumerate every unmet readiness condition'
);
SELECT assert_true(
  (SELECT status='DRAFT' FROM business_service_profiles WHERE service_code='ELECTRICAL'),
  'blocked provider service must remain draft'
);

DO $$
BEGIN
  BEGIN
    PERFORM activate_business_service_profile(
      (SELECT id FROM business_organizations LIMIT 1),
      '00000000-0000-4000-8000-000000000004',
      (SELECT id FROM business_service_profiles WHERE service_code='ELECTRICAL')
    );
    RAISE EXCEPTION 'viewer activation unexpectedly accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%HXBUS2%' THEN RAISE; END IF;
  END;
END $$;

-- These writes represent trusted verification/operations systems, not browser inputs.
UPDATE business_organizations
SET verification_status='VERIFIED',payout_status='ACTIVE'
WHERE id=(SELECT id FROM business_organizations LIMIT 1);
UPDATE business_service_profiles
SET coverage_postal_codes=ARRAY['98004','98052'],weekly_capacity_slots=12,
    corridor_minimum_cents=9000,corridor_maximum_cents=14000,
    proof_checklist='["Complete service checklist","Upload final proof"]'::JSONB
WHERE service_code='ELECTRICAL';
SELECT * FROM submit_business_credential(
  (SELECT id FROM business_organizations LIMIT 1),
  '00000000-0000-4000-8000-000000000001',
  (SELECT id FROM business_memberships WHERE user_id='00000000-0000-4000-8000-000000000005'),
  'ELECTRICAL_LICENSE',repeat('c',64)
);
UPDATE business_credentials SET status='ACTIVE',
  verified_by='00000000-0000-4000-8000-000000000001',verified_at=NOW()
WHERE credential_type='ELECTRICAL_LICENSE';
SELECT * FROM assign_business_service_crew(
  (SELECT id FROM business_organizations LIMIT 1),
  '00000000-0000-4000-8000-000000000001',
  (SELECT id FROM business_service_profiles WHERE service_code='ELECTRICAL'),
  (SELECT id FROM business_memberships WHERE user_id='00000000-0000-4000-8000-000000000005')
);

SELECT * FROM activate_business_service_profile(
  (SELECT id FROM business_organizations LIMIT 1),
  '00000000-0000-4000-8000-000000000001',
  (SELECT id FROM business_service_profiles WHERE service_code='ELECTRICAL')
);
SELECT assert_true(
  (SELECT status='ACTIVE' FROM business_service_profiles WHERE service_code='ELECTRICAL'),
  'fully verified provider service must activate'
);
SELECT assert_true(
  (SELECT outcome='ACTIVATED' AND blockers=ARRAY[]::TEXT[]
   FROM business_service_activation_events ORDER BY created_at DESC LIMIT 1),
  'successful activation must retain an immutable readiness witness'
);

DO $$
BEGIN
  BEGIN
    DELETE FROM business_service_activation_events;
    RAISE EXCEPTION 'activation evidence deletion unexpectedly accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%HXBUS20%' THEN RAISE; END IF;
  END;
END $$;

SELECT 'BUSINESS_OPERATIONS_DATABASE_CONTRACT_OK' AS result;
