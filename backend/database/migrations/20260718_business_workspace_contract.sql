-- HustleXP Business workspace contract v1.
-- Authority: supplied E2E specification §8 and HX/OS business workspaces.
-- Organizations may buy work, provide work, or do both, but every action is
-- bound to an authenticated membership and recorded in an append-only audit.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS business_organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name TEXT NOT NULL CHECK (char_length(btrim(legal_name)) BETWEEN 2 AND 200),
  display_name TEXT NOT NULL CHECK (char_length(btrim(display_name)) BETWEEN 2 AND 120),
  provider_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  client_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  verification_status TEXT NOT NULL DEFAULT 'UNVERIFIED'
    CHECK (verification_status IN ('UNVERIFIED','PENDING','VERIFIED','REJECTED','SUSPENDED')),
  payout_status TEXT NOT NULL DEFAULT 'NOT_STARTED'
    CHECK (payout_status IN ('NOT_STARTED','PENDING','ACTIVE','RESTRICTED','DISABLED')),
  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','SUSPENDED','CLOSED')),
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  creation_idempotency_key TEXT NOT NULL
    CHECK (creation_idempotency_key ~ '^[A-Za-z0-9:_-]{8,128}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT business_organization_requires_mode
    CHECK (provider_enabled OR client_enabled),
  UNIQUE (created_by, creation_idempotency_key)
);

CREATE TABLE IF NOT EXISTS business_memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES business_organizations(id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN (
    'OWNER','ADMIN','DISPATCHER','APPROVER','REQUESTER','VIEWER','CREW'
  )),
  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('INVITED','ACTIVE','SUSPENDED','REVOKED')),
  invited_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, user_id)
);

CREATE INDEX IF NOT EXISTS business_memberships_user_active_idx
  ON business_memberships(user_id, organization_id) WHERE status='ACTIVE';

CREATE TABLE IF NOT EXISTS business_locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES business_organizations(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 2 AND 120),
  rough_location TEXT NOT NULL CHECK (char_length(btrim(rough_location)) BETWEEN 2 AND 120),
  postal_code TEXT NOT NULL CHECK (char_length(btrim(postal_code)) BETWEEN 3 AND 12),
  region_code TEXT NOT NULL CHECK (region_code ~ '^US-[A-Z]{2}$'),
  timezone TEXT NOT NULL CHECK (char_length(timezone) BETWEEN 3 AND 64),
  exact_address_ciphertext TEXT NOT NULL,
  exact_address_nonce TEXT NOT NULL,
  exact_address_auth_tag TEXT NOT NULL,
  exact_address_key_id TEXT NOT NULL,
  exact_address_fingerprint TEXT NOT NULL CHECK (exact_address_fingerprint ~ '^[a-f0-9]{64}$'),
  access_ciphertext TEXT NOT NULL,
  access_nonce TEXT NOT NULL,
  access_auth_tag TEXT NOT NULL,
  access_key_id TEXT NOT NULL,
  access_fingerprint TEXT NOT NULL CHECK (access_fingerprint ~ '^[a-f0-9]{64}$'),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','CLOSED')),
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  creation_idempotency_key TEXT NOT NULL
    CHECK (creation_idempotency_key ~ '^[A-Za-z0-9:_-]{8,128}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, creation_idempotency_key)
);

CREATE INDEX IF NOT EXISTS business_locations_org_active_idx
  ON business_locations(organization_id, created_at DESC) WHERE status='ACTIVE';

CREATE TABLE IF NOT EXISTS business_audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES business_organizations(id) ON DELETE RESTRICT,
  actor_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (char_length(action) BETWEEN 3 AND 100),
  object_type TEXT NOT NULL CHECK (char_length(object_type) BETWEEN 3 AND 50),
  object_id UUID NOT NULL,
  before_state JSONB,
  after_state JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS business_audit_org_created_idx
  ON business_audit_events(organization_id, created_at DESC);

CREATE OR REPLACE FUNCTION prevent_business_audit_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'HXBUS1: business audit events are append-only';
END $$;

DROP TRIGGER IF EXISTS business_audit_immutable ON business_audit_events;
CREATE TRIGGER business_audit_immutable
BEFORE UPDATE OR DELETE ON business_audit_events
FOR EACH ROW EXECUTE FUNCTION prevent_business_audit_mutation();

CREATE OR REPLACE FUNCTION business_membership_has_action(
  p_organization_id UUID,
  p_user_id UUID,
  p_action TEXT
) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
    FROM business_memberships membership
    WHERE membership.organization_id = p_organization_id
      AND membership.user_id = p_user_id
      AND membership.status = 'ACTIVE'
      AND CASE membership.role
        WHEN 'OWNER' THEN p_action = ANY(ARRAY[
          'READ_WORKSPACE','MANAGE_ORGANIZATION','MANAGE_MEMBERS','MANAGE_LOCATIONS',
          'MANAGE_SERVICES','MANAGE_CREWS','CREATE_WORK_ORDER','APPROVE_SPEND',
          'VIEW_BILLING','MANAGE_BILLING','ASSIGN_CREW','SUBMIT_PROOF'
        ])
        WHEN 'ADMIN' THEN p_action = ANY(ARRAY[
          'READ_WORKSPACE','MANAGE_ORGANIZATION','MANAGE_MEMBERS','MANAGE_LOCATIONS',
          'MANAGE_SERVICES','MANAGE_CREWS','CREATE_WORK_ORDER','APPROVE_SPEND',
          'VIEW_BILLING','MANAGE_BILLING','ASSIGN_CREW','SUBMIT_PROOF'
        ])
        WHEN 'DISPATCHER' THEN p_action = ANY(ARRAY[
          'READ_WORKSPACE','MANAGE_LOCATIONS','MANAGE_SERVICES','MANAGE_CREWS',
          'CREATE_WORK_ORDER','ASSIGN_CREW','SUBMIT_PROOF'
        ])
        WHEN 'APPROVER' THEN p_action = ANY(ARRAY[
          'READ_WORKSPACE','APPROVE_SPEND','VIEW_BILLING'
        ])
        WHEN 'REQUESTER' THEN p_action = ANY(ARRAY['READ_WORKSPACE','CREATE_WORK_ORDER'])
        WHEN 'VIEWER' THEN p_action = ANY(ARRAY['READ_WORKSPACE','VIEW_BILLING'])
        WHEN 'CREW' THEN p_action = ANY(ARRAY['READ_WORKSPACE','SUBMIT_PROOF'])
        ELSE FALSE
      END
  );
$$;

CREATE OR REPLACE FUNCTION business_require_action(
  p_organization_id UUID,
  p_user_id UUID,
  p_action TEXT
) RETURNS VOID
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT business_membership_has_action(p_organization_id,p_user_id,p_action) THEN
    RAISE EXCEPTION 'HXBUS2: business action is not permitted';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION protect_business_last_owner()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_remaining INTEGER;
BEGIN
  IF OLD.role <> 'OWNER' OR OLD.status <> 'ACTIVE' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.role = 'OWNER' AND NEW.status = 'ACTIVE' THEN
    RETURN NEW;
  END IF;
  SELECT COUNT(*) INTO v_remaining
  FROM business_memberships
  WHERE organization_id=OLD.organization_id AND role='OWNER' AND status='ACTIVE'
    AND id<>OLD.id;
  IF v_remaining = 0 THEN
    RAISE EXCEPTION 'HXBUS3: an active organization must retain an owner';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

DROP TRIGGER IF EXISTS business_last_owner_guard ON business_memberships;
CREATE TRIGGER business_last_owner_guard
BEFORE UPDATE OR DELETE ON business_memberships
FOR EACH ROW EXECUTE FUNCTION protect_business_last_owner();

CREATE OR REPLACE FUNCTION create_business_organization(
  p_actor_id UUID,
  p_legal_name TEXT,
  p_display_name TEXT,
  p_provider_enabled BOOLEAN,
  p_client_enabled BOOLEAN,
  p_idempotency_key TEXT
) RETURNS TABLE(organization_id UUID, actor_role TEXT)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_org business_organizations%ROWTYPE;
  v_created BOOLEAN := FALSE;
BEGIN
  INSERT INTO business_organizations(
    legal_name,display_name,provider_enabled,client_enabled,created_by,creation_idempotency_key
  ) VALUES (
    btrim(p_legal_name),btrim(p_display_name),p_provider_enabled,p_client_enabled,
    p_actor_id,p_idempotency_key
  )
  ON CONFLICT (created_by,creation_idempotency_key) DO NOTHING
  RETURNING * INTO v_org;

  IF v_org.id IS NULL THEN
    SELECT * INTO v_org FROM business_organizations
    WHERE created_by=p_actor_id AND creation_idempotency_key=p_idempotency_key;
    IF v_org.legal_name IS DISTINCT FROM btrim(p_legal_name)
       OR v_org.display_name IS DISTINCT FROM btrim(p_display_name)
       OR v_org.provider_enabled IS DISTINCT FROM p_provider_enabled
       OR v_org.client_enabled IS DISTINCT FROM p_client_enabled THEN
      RAISE EXCEPTION 'HXBUS4: idempotency key payload conflict';
    END IF;
  ELSE
    v_created := TRUE;
  END IF;

  IF v_created THEN
    INSERT INTO business_memberships(
      organization_id,user_id,role,status,invited_by,accepted_at
    ) VALUES (v_org.id,p_actor_id,'OWNER','ACTIVE',p_actor_id,NOW());
    INSERT INTO business_audit_events(
      organization_id,actor_id,action,object_type,object_id,after_state
    ) VALUES (
      v_org.id,p_actor_id,'ORGANIZATION_CREATED','ORGANIZATION',v_org.id,
      jsonb_build_object(
        'legal_name',v_org.legal_name,'display_name',v_org.display_name,
        'provider_enabled',v_org.provider_enabled,'client_enabled',v_org.client_enabled
      )
    );
  END IF;

  RETURN QUERY SELECT v_org.id, 'OWNER'::TEXT;
END $$;

CREATE OR REPLACE FUNCTION set_business_member_role(
  p_organization_id UUID,
  p_actor_id UUID,
  p_member_user_id UUID,
  p_role TEXT
) RETURNS TABLE(membership_id UUID, member_role TEXT)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_actor_role TEXT;
  v_existing business_memberships%ROWTYPE;
  v_membership business_memberships%ROWTYPE;
BEGIN
  IF p_role NOT IN ('OWNER','ADMIN','DISPATCHER','APPROVER','REQUESTER','VIEWER','CREW') THEN
    RAISE EXCEPTION 'HXBUS5: invalid business role';
  END IF;
  SELECT role INTO v_actor_role FROM business_memberships
  WHERE organization_id=p_organization_id AND user_id=p_actor_id AND status='ACTIVE';
  SELECT * INTO v_existing FROM business_memberships
  WHERE organization_id=p_organization_id AND user_id=p_member_user_id;

  IF v_actor_role IS NULL OR (
    v_actor_role <> 'OWNER' AND NOT (
      v_actor_role='ADMIN' AND p_role<>'OWNER' AND COALESCE(v_existing.role,'VIEWER')<>'OWNER'
    )
  ) THEN
    RAISE EXCEPTION 'HXBUS2: business membership action is not permitted';
  END IF;

  INSERT INTO business_memberships(
    organization_id,user_id,role,status,invited_by,accepted_at
  ) VALUES (
    p_organization_id,p_member_user_id,p_role,'ACTIVE',p_actor_id,NOW()
  )
  ON CONFLICT (organization_id,user_id) DO UPDATE SET
    role=EXCLUDED.role,status='ACTIVE',invited_by=p_actor_id,
    accepted_at=COALESCE(business_memberships.accepted_at,NOW()),updated_at=NOW()
  RETURNING * INTO v_membership;

  INSERT INTO business_audit_events(
    organization_id,actor_id,action,object_type,object_id,before_state,after_state
  ) VALUES (
    p_organization_id,p_actor_id,'MEMBERSHIP_ROLE_SET','MEMBERSHIP',v_membership.id,
    CASE WHEN v_existing.id IS NULL THEN NULL ELSE jsonb_build_object(
      'role',v_existing.role,'status',v_existing.status
    ) END,
    jsonb_build_object('user_id',p_member_user_id,'role',v_membership.role,'status',v_membership.status)
  );
  RETURN QUERY SELECT v_membership.id, v_membership.role;
END $$;

CREATE OR REPLACE FUNCTION set_business_member_role_by_email(
  p_organization_id UUID,
  p_actor_id UUID,
  p_member_email TEXT,
  p_role TEXT
) RETURNS TABLE(membership_id UUID, member_role TEXT)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE v_member_user_id UUID;
BEGIN
  -- Permission must be established before resolving whether an account exists;
  -- this prevents cross-organization email enumeration.
  PERFORM business_require_action(p_organization_id,p_actor_id,'MANAGE_MEMBERS');
  SELECT id INTO v_member_user_id
  FROM users
  WHERE lower(email)=lower(btrim(p_member_email))
  LIMIT 1;
  IF v_member_user_id IS NULL THEN
    RAISE EXCEPTION 'HXBUS6: no eligible user account matched';
  END IF;
  RETURN QUERY
  SELECT assigned.membership_id,assigned.member_role
  FROM set_business_member_role(
    p_organization_id,p_actor_id,v_member_user_id,p_role
  ) assigned;
END $$;

CREATE OR REPLACE FUNCTION create_business_location(
  p_organization_id UUID,
  p_actor_id UUID,
  p_location_id UUID,
  p_name TEXT,
  p_rough_location TEXT,
  p_postal_code TEXT,
  p_region_code TEXT,
  p_timezone TEXT,
  p_exact_address JSONB,
  p_access JSONB,
  p_idempotency_key TEXT
) RETURNS TABLE(location_id UUID)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_location business_locations%ROWTYPE;
  v_created BOOLEAN := FALSE;
BEGIN
  IF NOT business_membership_has_action(p_organization_id,p_actor_id,'MANAGE_LOCATIONS') THEN
    RAISE EXCEPTION 'HXBUS2: business location action is not permitted';
  END IF;
  INSERT INTO business_locations(
    id,organization_id,name,rough_location,postal_code,region_code,timezone,
    exact_address_ciphertext,exact_address_nonce,exact_address_auth_tag,
    exact_address_key_id,exact_address_fingerprint,
    access_ciphertext,access_nonce,access_auth_tag,access_key_id,access_fingerprint,
    created_by,creation_idempotency_key
  ) VALUES (
    p_location_id,p_organization_id,btrim(p_name),btrim(p_rough_location),upper(btrim(p_postal_code)),
    p_region_code,p_timezone,
    p_exact_address->>'ciphertext',p_exact_address->>'nonce',p_exact_address->>'authTag',
    p_exact_address->>'keyId',p_exact_address->>'fingerprint',
    p_access->>'ciphertext',p_access->>'nonce',p_access->>'authTag',
    p_access->>'keyId',p_access->>'fingerprint',p_actor_id,p_idempotency_key
  )
  ON CONFLICT (organization_id,creation_idempotency_key) DO NOTHING
  RETURNING * INTO v_location;

  IF v_location.id IS NULL THEN
    SELECT * INTO v_location FROM business_locations
    WHERE organization_id=p_organization_id AND creation_idempotency_key=p_idempotency_key;
    IF v_location.name IS DISTINCT FROM btrim(p_name)
       OR v_location.rough_location IS DISTINCT FROM btrim(p_rough_location)
       OR v_location.postal_code IS DISTINCT FROM upper(btrim(p_postal_code))
       OR v_location.exact_address_fingerprint IS DISTINCT FROM p_exact_address->>'fingerprint'
       OR v_location.access_fingerprint IS DISTINCT FROM p_access->>'fingerprint' THEN
      RAISE EXCEPTION 'HXBUS4: idempotency key payload conflict';
    END IF;
  ELSE
    v_created := TRUE;
  END IF;

  IF v_created THEN
    INSERT INTO business_audit_events(
      organization_id,actor_id,action,object_type,object_id,after_state
    ) VALUES (
      p_organization_id,p_actor_id,'LOCATION_CREATED','LOCATION',v_location.id,
      jsonb_build_object(
        'name',v_location.name,'rough_location',v_location.rough_location,
        'postal_code',v_location.postal_code,'region_code',v_location.region_code,
        'access_configured',TRUE
      )
    );
  END IF;
  RETURN QUERY SELECT v_location.id;
END $$;

REVOKE ALL ON FUNCTION public.create_business_organization(UUID,TEXT,TEXT,BOOLEAN,BOOLEAN,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_business_member_role(UUID,UUID,UUID,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_business_member_role_by_email(UUID,UUID,TEXT,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_business_location(UUID,UUID,UUID,TEXT,TEXT,TEXT,TEXT,TEXT,JSONB,JSONB,TEXT) FROM PUBLIC;

COMMIT;
