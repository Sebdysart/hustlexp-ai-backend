BEGIN;

ALTER TABLE business_organizations
  ADD COLUMN IF NOT EXISTS washington_ubi TEXT NULL;

ALTER TABLE business_organizations
  ADD COLUMN IF NOT EXISTS federal_ein TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'business_organizations_washington_ubi_check'
  ) THEN
    ALTER TABLE business_organizations
      ADD CONSTRAINT business_organizations_washington_ubi_check
      CHECK (washington_ubi IS NULL OR washington_ubi ~ '^[0-9]{9}$');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'business_organizations_federal_ein_check'
  ) THEN
    ALTER TABLE business_organizations
      ADD CONSTRAINT business_organizations_federal_ein_check
      CHECK (federal_ein IS NULL OR federal_ein ~ '^[0-9]{9}$');
  END IF;
END $$;

CREATE OR REPLACE FUNCTION create_business_organization(
  p_actor_id UUID,
  p_legal_name TEXT,
  p_display_name TEXT,
  p_provider_enabled BOOLEAN,
  p_client_enabled BOOLEAN,
  p_idempotency_key TEXT,
  p_washington_ubi TEXT,
  p_federal_ein TEXT
) RETURNS TABLE(organization_id UUID, actor_role TEXT)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_org business_organizations%ROWTYPE;
  v_created BOOLEAN := FALSE;
  v_washington_ubi TEXT := regexp_replace(p_washington_ubi, '[^0-9]', '', 'g');
  v_federal_ein TEXT := regexp_replace(p_federal_ein, '[^0-9]', '', 'g');
BEGIN
  INSERT INTO business_organizations(
    legal_name,
    display_name,
    provider_enabled,
    client_enabled,
    washington_ubi,
    federal_ein,
    verification_status,
    created_by,
    creation_idempotency_key
  ) VALUES (
    btrim(p_legal_name),
    btrim(p_display_name),
    p_provider_enabled,
    p_client_enabled,
    v_washington_ubi,
    v_federal_ein,
    'PENDING',
    p_actor_id,
    p_idempotency_key
  )
  ON CONFLICT (created_by, creation_idempotency_key) DO NOTHING
  RETURNING * INTO v_org;

  IF v_org.id IS NULL THEN
    SELECT * INTO v_org
    FROM business_organizations
    WHERE created_by = p_actor_id
      AND creation_idempotency_key = p_idempotency_key;

    IF v_org.legal_name IS DISTINCT FROM btrim(p_legal_name)
       OR v_org.display_name IS DISTINCT FROM btrim(p_display_name)
       OR v_org.provider_enabled IS DISTINCT FROM p_provider_enabled
       OR v_org.client_enabled IS DISTINCT FROM p_client_enabled
       OR v_org.washington_ubi IS DISTINCT FROM v_washington_ubi
       OR v_org.federal_ein IS DISTINCT FROM v_federal_ein THEN
      RAISE EXCEPTION 'HXBUS4: idempotency key payload conflict';
    END IF;
  ELSE
    v_created := TRUE;
  END IF;

  IF v_created THEN
    INSERT INTO business_memberships(
      organization_id, user_id, role, status, invited_by, accepted_at
    ) VALUES (
      v_org.id, p_actor_id, 'OWNER', 'ACTIVE', p_actor_id, NOW()
    );

    INSERT INTO business_audit_events(
      organization_id, actor_id, action, object_type, object_id, after_state
    ) VALUES (
      v_org.id,
      p_actor_id,
      'ORGANIZATION_CREATED',
      'ORGANIZATION',
      v_org.id,
      jsonb_build_object(
        'legal_name', v_org.legal_name,
        'display_name', v_org.display_name,
        'provider_enabled', v_org.provider_enabled,
        'client_enabled', v_org.client_enabled,
        'washington_ubi', v_org.washington_ubi,
        'federal_ein', v_org.federal_ein,
        'verification_status', v_org.verification_status
      )
    );
  END IF;

  RETURN QUERY SELECT v_org.id, 'OWNER'::TEXT;
END $$;

COMMIT;
