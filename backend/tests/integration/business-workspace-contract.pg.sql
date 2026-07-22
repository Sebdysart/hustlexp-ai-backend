\set ON_ERROR_STOP on

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id UUID PRIMARY KEY,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE
);

INSERT INTO users(id,full_name,email) VALUES
  ('00000000-0000-4000-8000-000000000001','Workspace Owner','owner@example.com'),
  ('00000000-0000-4000-8000-000000000002','Workspace Admin','admin@example.com'),
  ('00000000-0000-4000-8000-000000000003','Workspace Dispatcher','dispatcher@example.com'),
  ('00000000-0000-4000-8000-000000000004','Workspace Approver','approver@example.com'),
  ('00000000-0000-4000-8000-000000000005','Workspace Requester','requester@example.com'),
  ('00000000-0000-4000-8000-000000000006','Workspace Viewer','viewer@example.com'),
  ('00000000-0000-4000-8000-000000000007','Workspace Crew','crew@example.com'),
  ('00000000-0000-4000-8000-000000000008','Outside Organization','outside@example.com');

\ir ../../database/migrations/20260718_business_workspace_contract.sql

CREATE OR REPLACE FUNCTION assert_true(condition BOOLEAN, message TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF condition IS NOT TRUE THEN RAISE EXCEPTION 'assertion failed: %', message; END IF;
END $$;

SELECT * FROM create_business_organization(
  '00000000-0000-4000-8000-000000000001',
  'Eastside Property Services LLC','Eastside Property Services',TRUE,TRUE,
  'workspace:eps:001'
);

SELECT assert_true(
  (SELECT COUNT(*)=1 FROM business_organizations),
  'idempotent organization creation must produce one organization'
);
SELECT assert_true(
  (SELECT role='OWNER' AND status='ACTIVE' FROM business_memberships
   WHERE user_id='00000000-0000-4000-8000-000000000001'),
  'creator must become the active owner'
);
SELECT assert_true(
  (SELECT COUNT(*)=1 FROM business_audit_events WHERE action='ORGANIZATION_CREATED'),
  'organization creation must have one audit witness'
);

-- Exact replay is accepted without duplicate objects or audit rows.
SELECT * FROM create_business_organization(
  '00000000-0000-4000-8000-000000000001',
  'Eastside Property Services LLC','Eastside Property Services',TRUE,TRUE,
  'workspace:eps:001'
);
SELECT assert_true(
  (SELECT COUNT(*)=1 FROM business_organizations),
  'exact organization replay must remain singular'
);

DO $$
BEGIN
  BEGIN
    PERFORM create_business_organization(
      '00000000-0000-4000-8000-000000000001',
      'Different Legal Name LLC','Eastside Property Services',TRUE,TRUE,
      'workspace:eps:001'
    );
    RAISE EXCEPTION 'organization idempotency conflict unexpectedly accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%HXBUS4%' THEN RAISE; END IF;
  END;
END $$;

SELECT * FROM set_business_member_role(
  (SELECT id FROM business_organizations LIMIT 1),
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002','ADMIN'
);
SELECT * FROM set_business_member_role(
  (SELECT id FROM business_organizations LIMIT 1),
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000003','DISPATCHER'
);
SELECT * FROM set_business_member_role(
  (SELECT id FROM business_organizations LIMIT 1),
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000004','APPROVER'
);
SELECT * FROM set_business_member_role(
  (SELECT id FROM business_organizations LIMIT 1),
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000005','REQUESTER'
);
SELECT * FROM set_business_member_role(
  (SELECT id FROM business_organizations LIMIT 1),
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000006','VIEWER'
);
SELECT * FROM set_business_member_role(
  (SELECT id FROM business_organizations LIMIT 1),
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000007','CREW'
);

SELECT * FROM set_business_member_role_by_email(
  (SELECT id FROM business_organizations LIMIT 1),
  '00000000-0000-4000-8000-000000000001',
  'viewer@example.com','VIEWER'
);

SELECT assert_true(
  business_membership_has_action(
    (SELECT id FROM business_organizations LIMIT 1),
    '00000000-0000-4000-8000-000000000003','MANAGE_LOCATIONS'
  ),
  'dispatcher must manage locations'
);
SELECT assert_true(
  NOT business_membership_has_action(
    (SELECT id FROM business_organizations LIMIT 1),
    '00000000-0000-4000-8000-000000000003','APPROVE_SPEND'
  ),
  'dispatcher must not approve spend'
);
SELECT assert_true(
  business_membership_has_action(
    (SELECT id FROM business_organizations LIMIT 1),
    '00000000-0000-4000-8000-000000000004','APPROVE_SPEND'
  ),
  'approver must approve spend'
);
SELECT assert_true(
  NOT business_membership_has_action(
    (SELECT id FROM business_organizations LIMIT 1),
    '00000000-0000-4000-8000-000000000006','MANAGE_LOCATIONS'
  ),
  'viewer must not manage locations'
);

DO $$
BEGIN
  BEGIN
    PERFORM set_business_member_role(
      (SELECT id FROM business_organizations LIMIT 1),
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000002','OWNER'
    );
    RAISE EXCEPTION 'admin ownership escalation unexpectedly accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%HXBUS2%' THEN RAISE; END IF;
  END;
END $$;

DO $$
BEGIN
  BEGIN
    PERFORM set_business_member_role(
      (SELECT id FROM business_organizations LIMIT 1),
      '00000000-0000-4000-8000-000000000008',
      '00000000-0000-4000-8000-000000000008','VIEWER'
    );
    RAISE EXCEPTION 'outside membership write unexpectedly accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%HXBUS2%' THEN RAISE; END IF;
  END;
END $$;

SELECT * FROM create_business_location(
  (SELECT id FROM business_organizations LIMIT 1),
  '00000000-0000-4000-8000-000000000003',
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
  'location:bellevue:12'
);

SELECT assert_true(
  (SELECT exact_address_ciphertext='cipher-address' AND access_ciphertext='cipher-access'
   FROM business_locations WHERE id='40000000-0000-4000-8000-000000000001'),
  'dispatcher location write must persist only encrypted vault material'
);

DO $$
BEGIN
  BEGIN
    PERFORM create_business_location(
      (SELECT id FROM business_organizations LIMIT 1),
      '00000000-0000-4000-8000-000000000006',
      '40000000-0000-4000-8000-000000000002',
      'Viewer attack','Bellevue','98004','US-WA','America/Los_Angeles',
      jsonb_build_object('ciphertext','x','nonce','n','authTag','t','keyId','location-v1','fingerprint',repeat('c',64)),
      jsonb_build_object('ciphertext','x','nonce','n','authTag','t','keyId','location-v1','fingerprint',repeat('d',64)),
      'location:viewer:attack'
    );
    RAISE EXCEPTION 'viewer location write unexpectedly accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%HXBUS2%' THEN RAISE; END IF;
  END;
END $$;

DO $$
BEGIN
  BEGIN
    UPDATE business_memberships SET role='ADMIN'
    WHERE user_id='00000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'last-owner demotion unexpectedly accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%HXBUS3%' THEN RAISE; END IF;
  END;
END $$;

DO $$
BEGIN
  BEGIN
    UPDATE business_audit_events SET action='TAMPERED' WHERE action='ORGANIZATION_CREATED';
    RAISE EXCEPTION 'business audit mutation unexpectedly accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%HXBUS1%' THEN RAISE; END IF;
  END;
END $$;

SELECT 'BUSINESS_WORKSPACE_DATABASE_CONTRACT_OK' AS result;
