-- HustleXP Business operations contract v1.
-- Authority: supplied E2E specification §8 and HX/OS business workspaces.
-- Spend and provider readiness are always derived by the database. Browser
-- clients may request transitions but cannot assert authorization or readiness.

BEGIN;

CREATE TABLE IF NOT EXISTS business_budget_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES business_organizations(id) ON DELETE RESTRICT,
  location_id UUID REFERENCES business_locations(id) ON DELETE RESTRICT,
  service_category TEXT NOT NULL DEFAULT '*'
    CHECK (char_length(btrim(service_category)) BETWEEN 1 AND 80),
  per_task_cap_cents BIGINT NOT NULL CHECK (per_task_cap_cents > 0),
  monthly_cap_cents BIGINT NOT NULL CHECK (monthly_cap_cents >= per_task_cap_cents),
  auto_approve_limit_cents BIGINT NOT NULL
    CHECK (auto_approve_limit_cents >= 0 AND auto_approve_limit_cents <= per_task_cap_cents),
  po_required BOOLEAN NOT NULL DEFAULT FALSE,
  cost_center_required BOOLEAN NOT NULL DEFAULT FALSE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS business_budget_policy_scope_unique
  ON business_budget_policies(
    organization_id,
    COALESCE(location_id, '00000000-0000-0000-0000-000000000000'::UUID),
    lower(service_category)
  );

CREATE TABLE IF NOT EXISTS business_approval_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES business_organizations(id) ON DELETE RESTRICT,
  location_id UUID REFERENCES business_locations(id) ON DELETE RESTRICT,
  budget_policy_id UUID REFERENCES business_budget_policies(id) ON DELETE RESTRICT,
  requester_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  service_category TEXT NOT NULL CHECK (char_length(btrim(service_category)) BETWEEN 1 AND 80),
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  po_number TEXT,
  cost_center TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'AUTO_APPROVED','PENDING_APPROVAL','APPROVED','REJECTED','BLOCKED','CANCELLED'
  )),
  blockers TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  policy_snapshot JSONB NOT NULL,
  request_payload_hash TEXT NOT NULL CHECK (request_payload_hash ~ '^[a-f0-9]{64}$'),
  idempotency_key TEXT NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_-]{8,128}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at TIMESTAMPTZ,
  UNIQUE (organization_id, requester_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS business_approval_queue_idx
  ON business_approval_requests(organization_id, created_at ASC)
  WHERE status='PENDING_APPROVAL';

CREATE TABLE IF NOT EXISTS business_approval_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES business_organizations(id) ON DELETE RESTRICT,
  approval_request_id UUID NOT NULL REFERENCES business_approval_requests(id) ON DELETE RESTRICT,
  actor_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  decision TEXT NOT NULL CHECK (decision IN ('APPROVED','REJECTED')),
  reason TEXT NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (approval_request_id)
);

CREATE TABLE IF NOT EXISTS business_spend_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES business_organizations(id) ON DELETE RESTRICT,
  location_id UUID REFERENCES business_locations(id) ON DELETE RESTRICT,
  approval_request_id UUID REFERENCES business_approval_requests(id) ON DELETE RESTRICT,
  work_order_id UUID,
  amount_cents BIGINT NOT NULL CHECK (amount_cents <> 0),
  entry_type TEXT NOT NULL CHECK (entry_type IN ('COMMITTED','SETTLED','REVERSED','REFUNDED')),
  source_event_id TEXT NOT NULL CHECK (char_length(source_event_id) BETWEEN 8 AND 160),
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, source_event_id)
);

CREATE INDEX IF NOT EXISTS business_spend_month_idx
  ON business_spend_ledger(organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS business_service_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES business_organizations(id) ON DELETE RESTRICT,
  service_code TEXT NOT NULL CHECK (service_code ~ '^[A-Z0-9_-]{2,40}$'),
  service_name TEXT NOT NULL CHECK (char_length(btrim(service_name)) BETWEEN 2 AND 120),
  service_description TEXT NOT NULL CHECK (char_length(btrim(service_description)) BETWEEN 10 AND 4000),
  service_exclusions TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  booking_questions JSONB NOT NULL DEFAULT '[]'::JSONB CHECK (jsonb_typeof(booking_questions)='array'),
  coverage_postal_codes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  maximum_travel_miles INTEGER NOT NULL DEFAULT 0 CHECK (maximum_travel_miles BETWEEN 0 AND 500),
  weekly_capacity_slots INTEGER NOT NULL DEFAULT 0 CHECK (weekly_capacity_slots BETWEEN 0 AND 10000),
  blackout_dates DATE[] NOT NULL DEFAULT ARRAY[]::DATE[],
  pricing_mode TEXT NOT NULL CHECK (pricing_mode IN (
    'INSTANT_CORRIDOR','STARTING_PRICE','QUOTE_REQUIRED'
  )),
  corridor_minimum_cents BIGINT CHECK (corridor_minimum_cents > 0),
  corridor_maximum_cents BIGINT CHECK (corridor_maximum_cents > 0),
  response_mode TEXT NOT NULL CHECK (response_mode IN (
    'INDIVIDUAL_OFFERS','ROUTE_BUNDLES','RECURRING_CONTRACTS'
  )),
  proof_checklist JSONB NOT NULL DEFAULT '[]'::JSONB CHECK (jsonb_typeof(proof_checklist)='array'),
  credential_requirements JSONB NOT NULL DEFAULT '[]'::JSONB
    CHECK (jsonb_typeof(credential_requirements)='array'),
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ACTIVE','PAUSED','RETIRED')),
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  creation_idempotency_key TEXT NOT NULL
    CHECK (creation_idempotency_key ~ '^[A-Za-z0-9:_-]{8,128}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, service_code),
  UNIQUE (organization_id, creation_idempotency_key)
);

CREATE TABLE IF NOT EXISTS business_service_crew_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES business_organizations(id) ON DELETE RESTRICT,
  service_profile_id UUID NOT NULL REFERENCES business_service_profiles(id) ON DELETE RESTRICT,
  membership_id UUID NOT NULL REFERENCES business_memberships(id) ON DELETE RESTRICT,
  eligible BOOLEAN NOT NULL DEFAULT FALSE,
  eligibility_reason TEXT,
  assigned_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (service_profile_id, membership_id)
);

CREATE TABLE IF NOT EXISTS business_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES business_organizations(id) ON DELETE RESTRICT,
  membership_id UUID REFERENCES business_memberships(id) ON DELETE RESTRICT,
  credential_type TEXT NOT NULL CHECK (credential_type ~ '^[A-Z0-9_-]{2,80}$'),
  status TEXT NOT NULL CHECK (status IN ('PENDING','ACTIVE','EXPIRED','REVOKED','REJECTED')),
  expires_at TIMESTAMPTZ,
  evidence_hash TEXT NOT NULL CHECK (evidence_hash ~ '^[a-f0-9]{64}$'),
  verified_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE NULLS NOT DISTINCT (organization_id, membership_id, credential_type)
);

CREATE TABLE IF NOT EXISTS business_service_activation_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES business_organizations(id) ON DELETE RESTRICT,
  service_profile_id UUID NOT NULL REFERENCES business_service_profiles(id) ON DELETE RESTRICT,
  actor_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  outcome TEXT NOT NULL CHECK (outcome IN ('ACTIVATED','BLOCKED')),
  blockers TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  readiness_snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION validate_business_operations_scope()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='business_budget_policies' THEN
    IF NEW.location_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM business_locations
      WHERE id=NEW.location_id AND organization_id=NEW.organization_id
    ) THEN
      RAISE EXCEPTION 'HXBUS22: location is outside this organization';
    END IF;
  ELSIF TG_TABLE_NAME='business_approval_requests' THEN
    IF (NEW.location_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM business_locations
        WHERE id=NEW.location_id AND organization_id=NEW.organization_id
      )) OR (NEW.budget_policy_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM business_budget_policies
        WHERE id=NEW.budget_policy_id AND organization_id=NEW.organization_id
      )) THEN
      RAISE EXCEPTION 'HXBUS28: approval scope is outside this organization';
    END IF;
  ELSIF TG_TABLE_NAME='business_service_crew_assignments' THEN
    IF NOT EXISTS (
        SELECT 1 FROM business_service_profiles
        WHERE id=NEW.service_profile_id AND organization_id=NEW.organization_id
      ) OR NOT EXISTS (
        SELECT 1 FROM business_memberships
        WHERE id=NEW.membership_id AND organization_id=NEW.organization_id
      ) THEN
      RAISE EXCEPTION 'HXBUS29: crew assignment scope is outside this organization';
    END IF;
  ELSIF TG_TABLE_NAME='business_credentials' THEN
    IF NEW.membership_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM business_memberships
      WHERE id=NEW.membership_id AND organization_id=NEW.organization_id
    ) THEN
      RAISE EXCEPTION 'HXBUS30: credential scope is outside this organization';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS business_budget_policy_scope_guard ON business_budget_policies;
CREATE TRIGGER business_budget_policy_scope_guard
BEFORE INSERT OR UPDATE ON business_budget_policies
FOR EACH ROW EXECUTE FUNCTION validate_business_operations_scope();

DROP TRIGGER IF EXISTS business_approval_request_scope_guard ON business_approval_requests;
CREATE TRIGGER business_approval_request_scope_guard
BEFORE INSERT OR UPDATE ON business_approval_requests
FOR EACH ROW EXECUTE FUNCTION validate_business_operations_scope();

DROP TRIGGER IF EXISTS business_service_crew_scope_guard ON business_service_crew_assignments;
CREATE TRIGGER business_service_crew_scope_guard
BEFORE INSERT OR UPDATE ON business_service_crew_assignments
FOR EACH ROW EXECUTE FUNCTION validate_business_operations_scope();

DROP TRIGGER IF EXISTS business_credential_scope_guard ON business_credentials;
CREATE TRIGGER business_credential_scope_guard
BEFORE INSERT OR UPDATE ON business_credentials
FOR EACH ROW EXECUTE FUNCTION validate_business_operations_scope();

CREATE OR REPLACE FUNCTION prevent_business_operations_audit_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'HXBUS20: business operations evidence is append-only';
END $$;

DROP TRIGGER IF EXISTS business_approval_decision_immutable ON business_approval_decisions;
CREATE TRIGGER business_approval_decision_immutable
BEFORE UPDATE OR DELETE ON business_approval_decisions
FOR EACH ROW EXECUTE FUNCTION prevent_business_operations_audit_mutation();

DROP TRIGGER IF EXISTS business_spend_ledger_immutable ON business_spend_ledger;
CREATE TRIGGER business_spend_ledger_immutable
BEFORE UPDATE OR DELETE ON business_spend_ledger
FOR EACH ROW EXECUTE FUNCTION prevent_business_operations_audit_mutation();

DROP TRIGGER IF EXISTS business_service_activation_event_immutable
  ON business_service_activation_events;
CREATE TRIGGER business_service_activation_event_immutable
BEFORE UPDATE OR DELETE ON business_service_activation_events
FOR EACH ROW EXECUTE FUNCTION prevent_business_operations_audit_mutation();

CREATE OR REPLACE FUNCTION upsert_business_budget_policy(
  p_organization_id UUID,
  p_actor_id UUID,
  p_location_id UUID,
  p_service_category TEXT,
  p_per_task_cap_cents BIGINT,
  p_monthly_cap_cents BIGINT,
  p_auto_approve_limit_cents BIGINT,
  p_po_required BOOLEAN,
  p_cost_center_required BOOLEAN
) RETURNS TABLE(policy_id UUID, policy_revision INTEGER)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_policy business_budget_policies%ROWTYPE;
BEGIN
  PERFORM business_require_action(p_organization_id,p_actor_id,'MANAGE_BILLING');
  IF NOT EXISTS (
    SELECT 1 FROM business_organizations
    WHERE id=p_organization_id AND client_enabled=TRUE AND status='ACTIVE'
  ) THEN
    RAISE EXCEPTION 'HXBUS21: client mode is not active';
  END IF;
  IF p_location_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM business_locations
    WHERE id=p_location_id AND organization_id=p_organization_id AND status='ACTIVE'
  ) THEN
    RAISE EXCEPTION 'HXBUS22: location is outside this organization';
  END IF;

  SELECT * INTO v_policy
  FROM business_budget_policies
  WHERE organization_id=p_organization_id
    AND location_id IS NOT DISTINCT FROM p_location_id
    AND lower(service_category)=lower(btrim(p_service_category))
  FOR UPDATE;

  IF v_policy.id IS NULL THEN
    INSERT INTO business_budget_policies(
      organization_id,location_id,service_category,per_task_cap_cents,monthly_cap_cents,
      auto_approve_limit_cents,po_required,cost_center_required,created_by,updated_by
    ) VALUES (
      p_organization_id,p_location_id,btrim(p_service_category),p_per_task_cap_cents,
      p_monthly_cap_cents,p_auto_approve_limit_cents,p_po_required,
      p_cost_center_required,p_actor_id,p_actor_id
    ) RETURNING * INTO v_policy;
  ELSE
    UPDATE business_budget_policies SET
      per_task_cap_cents=p_per_task_cap_cents,
      monthly_cap_cents=p_monthly_cap_cents,
      auto_approve_limit_cents=p_auto_approve_limit_cents,
      po_required=p_po_required,
      cost_center_required=p_cost_center_required,
      active=TRUE,
      revision=revision+1,
      updated_by=p_actor_id,
      updated_at=NOW()
    WHERE id=v_policy.id
    RETURNING * INTO v_policy;
  END IF;

  INSERT INTO business_audit_events(
    organization_id,actor_id,action,object_type,object_id,after_state
  ) VALUES (
    p_organization_id,p_actor_id,'BUDGET_POLICY_SET','BUDGET_POLICY',v_policy.id,
    jsonb_build_object(
      'location_id',v_policy.location_id,'service_category',v_policy.service_category,
      'per_task_cap_cents',v_policy.per_task_cap_cents,
      'monthly_cap_cents',v_policy.monthly_cap_cents,
      'auto_approve_limit_cents',v_policy.auto_approve_limit_cents,
      'po_required',v_policy.po_required,'cost_center_required',v_policy.cost_center_required,
      'revision',v_policy.revision
    )
  );
  RETURN QUERY SELECT v_policy.id,v_policy.revision;
END $$;

CREATE OR REPLACE FUNCTION request_business_spend(
  p_organization_id UUID,
  p_actor_id UUID,
  p_location_id UUID,
  p_service_category TEXT,
  p_amount_cents BIGINT,
  p_po_number TEXT,
  p_cost_center TEXT,
  p_idempotency_key TEXT
) RETURNS TABLE(approval_request_id UUID, approval_status TEXT, approval_blockers TEXT[])
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_policy business_budget_policies%ROWTYPE;
  v_request business_approval_requests%ROWTYPE;
  v_month_spend BIGINT := 0;
  v_projected BIGINT;
  v_status TEXT;
  v_blockers TEXT[] := ARRAY[]::TEXT[];
  v_snapshot JSONB;
  v_payload_hash TEXT;
BEGIN
  PERFORM business_require_action(p_organization_id,p_actor_id,'CREATE_WORK_ORDER');
  IF p_amount_cents <= 0 THEN
    RAISE EXCEPTION 'HXBUS23: spend amount must be positive';
  END IF;
  IF p_location_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM business_locations
    WHERE id=p_location_id AND organization_id=p_organization_id AND status='ACTIVE'
  ) THEN
    RAISE EXCEPTION 'HXBUS22: location is outside this organization';
  END IF;

  SELECT * INTO v_policy
  FROM business_budget_policies
  WHERE organization_id=p_organization_id AND active=TRUE
    AND (location_id IS NULL OR location_id=p_location_id)
    AND (service_category='*' OR lower(service_category)=lower(btrim(p_service_category)))
  ORDER BY (location_id IS NOT NULL)::INTEGER DESC,
           (service_category <> '*')::INTEGER DESC,
           revision DESC
  LIMIT 1;

  IF v_policy.id IS NULL THEN
    v_status := 'BLOCKED';
    v_blockers := array_append(v_blockers,'BUDGET_POLICY_REQUIRED');
    v_snapshot := jsonb_build_object('policy_found',FALSE);
  ELSE
    SELECT COALESCE(SUM(amount_cents),0) INTO v_month_spend
    FROM business_spend_ledger
    WHERE organization_id=p_organization_id
      AND created_at >= date_trunc('month',NOW())
      AND entry_type IN ('COMMITTED','SETTLED','REVERSED','REFUNDED');
    v_projected := v_month_spend+p_amount_cents;
    IF p_amount_cents > v_policy.per_task_cap_cents THEN
      v_blockers := array_append(v_blockers,'PER_TASK_CAP_EXCEEDED');
    END IF;
    IF v_projected > v_policy.monthly_cap_cents THEN
      v_blockers := array_append(v_blockers,'MONTHLY_CAP_EXCEEDED');
    END IF;
    IF v_policy.po_required AND COALESCE(char_length(btrim(p_po_number)),0)=0 THEN
      v_blockers := array_append(v_blockers,'PURCHASE_ORDER_REQUIRED');
    END IF;
    IF v_policy.cost_center_required AND COALESCE(char_length(btrim(p_cost_center)),0)=0 THEN
      v_blockers := array_append(v_blockers,'COST_CENTER_REQUIRED');
    END IF;
    v_status := CASE
      WHEN cardinality(v_blockers)>0 THEN 'BLOCKED'
      WHEN p_amount_cents<=v_policy.auto_approve_limit_cents THEN 'AUTO_APPROVED'
      ELSE 'PENDING_APPROVAL'
    END;
    v_snapshot := jsonb_build_object(
      'policy_id',v_policy.id,'revision',v_policy.revision,
      'per_task_cap_cents',v_policy.per_task_cap_cents,
      'monthly_cap_cents',v_policy.monthly_cap_cents,
      'auto_approve_limit_cents',v_policy.auto_approve_limit_cents,
      'po_required',v_policy.po_required,'cost_center_required',v_policy.cost_center_required,
      'month_spend_cents',v_month_spend,'projected_month_spend_cents',v_projected
    );
  END IF;

  v_payload_hash := encode(digest(
    concat_ws('|',p_organization_id,p_actor_id,COALESCE(p_location_id::TEXT,''),
      lower(btrim(p_service_category)),p_amount_cents,COALESCE(btrim(p_po_number),''),
      COALESCE(btrim(p_cost_center),'')),
    'sha256'
  ),'hex');

  INSERT INTO business_approval_requests(
    organization_id,location_id,budget_policy_id,requester_id,service_category,
    amount_cents,po_number,cost_center,status,blockers,policy_snapshot,
    request_payload_hash,idempotency_key
  ) VALUES (
    p_organization_id,p_location_id,v_policy.id,p_actor_id,btrim(p_service_category),
    p_amount_cents,NULLIF(btrim(p_po_number),''),NULLIF(btrim(p_cost_center),''),
    v_status,v_blockers,v_snapshot,v_payload_hash,p_idempotency_key
  ) ON CONFLICT (organization_id,requester_id,idempotency_key) DO NOTHING
  RETURNING * INTO v_request;

  IF v_request.id IS NULL THEN
    SELECT * INTO v_request FROM business_approval_requests
    WHERE organization_id=p_organization_id AND requester_id=p_actor_id
      AND idempotency_key=p_idempotency_key;
    IF v_request.request_payload_hash<>v_payload_hash THEN
      RAISE EXCEPTION 'HXBUS4: idempotency key payload conflict';
    END IF;
  ELSE
    INSERT INTO business_audit_events(
      organization_id,actor_id,action,object_type,object_id,after_state
    ) VALUES (
      p_organization_id,p_actor_id,'SPEND_REQUESTED','APPROVAL_REQUEST',v_request.id,
      jsonb_build_object('amount_cents',v_request.amount_cents,'status',v_request.status,
        'blockers',v_request.blockers,'policy_snapshot',v_request.policy_snapshot)
    );
  END IF;
  RETURN QUERY SELECT v_request.id,v_request.status,v_request.blockers;
END $$;

CREATE OR REPLACE FUNCTION decide_business_approval(
  p_organization_id UUID,
  p_actor_id UUID,
  p_approval_request_id UUID,
  p_decision TEXT,
  p_reason TEXT
) RETURNS TABLE(approval_request_id UUID, approval_status TEXT)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_request business_approval_requests%ROWTYPE;
BEGIN
  PERFORM business_require_action(p_organization_id,p_actor_id,'APPROVE_SPEND');
  IF p_decision NOT IN ('APPROVED','REJECTED') THEN
    RAISE EXCEPTION 'HXBUS24: invalid approval decision';
  END IF;
  SELECT * INTO v_request FROM business_approval_requests
  WHERE id=p_approval_request_id AND organization_id=p_organization_id
  FOR UPDATE;
  IF v_request.id IS NULL OR v_request.status<>'PENDING_APPROVAL' THEN
    RAISE EXCEPTION 'HXBUS25: approval request is not pending';
  END IF;
  IF v_request.requester_id=p_actor_id THEN
    RAISE EXCEPTION 'HXBUS26: requester cannot approve their own spend';
  END IF;

  INSERT INTO business_approval_decisions(
    organization_id,approval_request_id,actor_id,decision,reason
  ) VALUES (
    p_organization_id,p_approval_request_id,p_actor_id,p_decision,btrim(p_reason)
  );
  UPDATE business_approval_requests
  SET status=p_decision,decided_at=NOW()
  WHERE id=p_approval_request_id
  RETURNING * INTO v_request;
  INSERT INTO business_audit_events(
    organization_id,actor_id,action,object_type,object_id,after_state
  ) VALUES (
    p_organization_id,p_actor_id,'SPEND_DECIDED','APPROVAL_REQUEST',v_request.id,
    jsonb_build_object('status',v_request.status,'reason',btrim(p_reason))
  );
  RETURN QUERY SELECT v_request.id,v_request.status;
END $$;

CREATE OR REPLACE FUNCTION create_business_service_profile(
  p_organization_id UUID,
  p_actor_id UUID,
  p_service_code TEXT,
  p_service_name TEXT,
  p_service_description TEXT,
  p_service_exclusions TEXT[],
  p_booking_questions JSONB,
  p_coverage_postal_codes TEXT[],
  p_maximum_travel_miles INTEGER,
  p_weekly_capacity_slots INTEGER,
  p_blackout_dates DATE[],
  p_pricing_mode TEXT,
  p_corridor_minimum_cents BIGINT,
  p_corridor_maximum_cents BIGINT,
  p_response_mode TEXT,
  p_proof_checklist JSONB,
  p_credential_requirements JSONB,
  p_idempotency_key TEXT
) RETURNS TABLE(service_profile_id UUID, profile_status TEXT)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_profile business_service_profiles%ROWTYPE;
BEGIN
  PERFORM business_require_action(p_organization_id,p_actor_id,'MANAGE_SERVICES');
  INSERT INTO business_service_profiles(
    organization_id,service_code,service_name,service_description,service_exclusions,
    booking_questions,coverage_postal_codes,maximum_travel_miles,weekly_capacity_slots,
    blackout_dates,pricing_mode,corridor_minimum_cents,corridor_maximum_cents,
    response_mode,proof_checklist,credential_requirements,status,created_by,
    creation_idempotency_key
  ) VALUES (
    p_organization_id,upper(btrim(p_service_code)),btrim(p_service_name),
    btrim(p_service_description),COALESCE(p_service_exclusions,ARRAY[]::TEXT[]),
    COALESCE(p_booking_questions,'[]'::JSONB),COALESCE(p_coverage_postal_codes,ARRAY[]::TEXT[]),
    p_maximum_travel_miles,p_weekly_capacity_slots,COALESCE(p_blackout_dates,ARRAY[]::DATE[]),
    p_pricing_mode,p_corridor_minimum_cents,p_corridor_maximum_cents,p_response_mode,
    COALESCE(p_proof_checklist,'[]'::JSONB),COALESCE(p_credential_requirements,'[]'::JSONB),
    'DRAFT',p_actor_id,p_idempotency_key
  ) ON CONFLICT (organization_id,creation_idempotency_key) DO NOTHING
  RETURNING * INTO v_profile;

  IF v_profile.id IS NULL THEN
    SELECT * INTO v_profile FROM business_service_profiles
    WHERE organization_id=p_organization_id AND creation_idempotency_key=p_idempotency_key;
    IF v_profile.service_code IS DISTINCT FROM upper(btrim(p_service_code))
       OR v_profile.service_name IS DISTINCT FROM btrim(p_service_name)
       OR v_profile.pricing_mode IS DISTINCT FROM p_pricing_mode
       OR v_profile.response_mode IS DISTINCT FROM p_response_mode THEN
      RAISE EXCEPTION 'HXBUS4: idempotency key payload conflict';
    END IF;
  ELSE
    INSERT INTO business_audit_events(
      organization_id,actor_id,action,object_type,object_id,after_state
    ) VALUES (
      p_organization_id,p_actor_id,'SERVICE_PROFILE_CREATED','SERVICE_PROFILE',v_profile.id,
      jsonb_build_object('service_code',v_profile.service_code,'status',v_profile.status,
        'pricing_mode',v_profile.pricing_mode,'response_mode',v_profile.response_mode)
    );
  END IF;
  RETURN QUERY SELECT v_profile.id,v_profile.status;
END $$;

CREATE OR REPLACE FUNCTION submit_business_credential(
  p_organization_id UUID,
  p_actor_id UUID,
  p_membership_id UUID,
  p_credential_type TEXT,
  p_evidence_hash TEXT
) RETURNS TABLE(credential_id UUID, credential_status TEXT)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_credential business_credentials%ROWTYPE;
BEGIN
  PERFORM business_require_action(p_organization_id,p_actor_id,'MANAGE_CREWS');
  IF NOT EXISTS (
    SELECT 1 FROM business_memberships
    WHERE id=p_membership_id AND organization_id=p_organization_id AND status='ACTIVE'
  ) THEN
    RAISE EXCEPTION 'HXBUS30: credential scope is outside this organization';
  END IF;
  INSERT INTO business_credentials(
    organization_id,membership_id,credential_type,status,evidence_hash,
    verified_by,verified_at,updated_at
  ) VALUES (
    p_organization_id,p_membership_id,upper(btrim(p_credential_type)),'PENDING',
    lower(p_evidence_hash),NULL,NULL,NOW()
  ) ON CONFLICT (organization_id,membership_id,credential_type) DO UPDATE SET
    status='PENDING',evidence_hash=EXCLUDED.evidence_hash,expires_at=NULL,
    verified_by=NULL,verified_at=NULL,updated_at=NOW()
  RETURNING * INTO v_credential;
  INSERT INTO business_audit_events(
    organization_id,actor_id,action,object_type,object_id,after_state
  ) VALUES (
    p_organization_id,p_actor_id,'CREDENTIAL_SUBMITTED','CREDENTIAL',v_credential.id,
    jsonb_build_object('membership_id',p_membership_id,
      'credential_type',v_credential.credential_type,'status',v_credential.status)
  );
  RETURN QUERY SELECT v_credential.id,v_credential.status;
END $$;

CREATE OR REPLACE FUNCTION assign_business_service_crew(
  p_organization_id UUID,
  p_actor_id UUID,
  p_service_profile_id UUID,
  p_membership_id UUID
) RETURNS TABLE(crew_assignment_id UUID, crew_eligible BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_profile business_service_profiles%ROWTYPE;
  v_assignment business_service_crew_assignments%ROWTYPE;
  v_eligible BOOLEAN;
BEGIN
  PERFORM business_require_action(p_organization_id,p_actor_id,'MANAGE_CREWS');
  SELECT * INTO v_profile FROM business_service_profiles
  WHERE id=p_service_profile_id AND organization_id=p_organization_id;
  IF v_profile.id IS NULL OR NOT EXISTS (
    SELECT 1 FROM business_memberships
    WHERE id=p_membership_id AND organization_id=p_organization_id
      AND status='ACTIVE' AND role IN ('CREW','DISPATCHER','ADMIN','OWNER')
  ) THEN
    RAISE EXCEPTION 'HXBUS29: crew assignment scope is outside this organization';
  END IF;

  SELECT NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(v_profile.credential_requirements) requirement
    WHERE NOT EXISTS (
      SELECT 1 FROM business_credentials credential
      WHERE credential.organization_id=p_organization_id
        AND (credential.membership_id=p_membership_id OR credential.membership_id IS NULL)
        AND credential.credential_type=requirement
        AND credential.status='ACTIVE'
        AND (credential.expires_at IS NULL OR credential.expires_at>NOW())
    )
  ) INTO v_eligible;

  INSERT INTO business_service_crew_assignments(
    organization_id,service_profile_id,membership_id,eligible,eligibility_reason,assigned_by
  ) VALUES (
    p_organization_id,p_service_profile_id,p_membership_id,v_eligible,
    CASE WHEN v_eligible THEN 'CURRENT_REQUIREMENTS_MET' ELSE 'CREDENTIALS_REQUIRED' END,
    p_actor_id
  ) ON CONFLICT (service_profile_id,membership_id) DO UPDATE SET
    eligible=v_eligible,
    eligibility_reason=CASE WHEN v_eligible THEN 'CURRENT_REQUIREMENTS_MET' ELSE 'CREDENTIALS_REQUIRED' END,
    assigned_by=p_actor_id,updated_at=NOW()
  RETURNING * INTO v_assignment;
  INSERT INTO business_audit_events(
    organization_id,actor_id,action,object_type,object_id,after_state
  ) VALUES (
    p_organization_id,p_actor_id,'SERVICE_CREW_ASSIGNED','CREW_ASSIGNMENT',v_assignment.id,
    jsonb_build_object('service_profile_id',p_service_profile_id,
      'membership_id',p_membership_id,'eligible',v_eligible)
  );
  RETURN QUERY SELECT v_assignment.id,v_eligible;
END $$;

CREATE OR REPLACE FUNCTION activate_business_service_profile(
  p_organization_id UUID,
  p_actor_id UUID,
  p_service_profile_id UUID
) RETURNS TABLE(service_profile_id UUID, ready BOOLEAN, blockers TEXT[])
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_profile business_service_profiles%ROWTYPE;
  v_org business_organizations%ROWTYPE;
  v_blockers TEXT[] := ARRAY[]::TEXT[];
  v_eligible_crew INTEGER := 0;
  v_credentials_met BOOLEAN := TRUE;
  v_ready BOOLEAN;
  v_snapshot JSONB;
BEGIN
  PERFORM business_require_action(p_organization_id,p_actor_id,'MANAGE_SERVICES');
  SELECT * INTO v_profile FROM business_service_profiles
  WHERE id=p_service_profile_id AND organization_id=p_organization_id
  FOR UPDATE;
  SELECT * INTO v_org FROM business_organizations WHERE id=p_organization_id;
  IF v_profile.id IS NULL OR v_org.id IS NULL THEN
    RAISE EXCEPTION 'HXBUS27: service profile was not found';
  END IF;

  SELECT COUNT(*) INTO v_eligible_crew
  FROM business_service_crew_assignments assignment
  JOIN business_memberships membership ON membership.id=assignment.membership_id
  WHERE assignment.organization_id=p_organization_id
    AND assignment.service_profile_id=p_service_profile_id
    AND membership.organization_id=p_organization_id
    AND membership.status='ACTIVE'
    AND membership.role IN ('CREW','DISPATCHER','ADMIN','OWNER')
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(v_profile.credential_requirements) requirement
      WHERE NOT EXISTS (
        SELECT 1 FROM business_credentials credential
        WHERE credential.organization_id=p_organization_id
          AND (credential.membership_id=membership.id OR credential.membership_id IS NULL)
          AND credential.credential_type=requirement
          AND credential.status='ACTIVE'
          AND (credential.expires_at IS NULL OR credential.expires_at>NOW())
      )
    );

  SELECT NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(v_profile.credential_requirements) requirement
    WHERE NOT EXISTS (
      SELECT 1 FROM business_credentials credential
      WHERE credential.organization_id=p_organization_id
        AND credential.credential_type=requirement
        AND credential.status='ACTIVE'
        AND (credential.expires_at IS NULL OR credential.expires_at>NOW())
    )
  ) INTO v_credentials_met;

  IF NOT v_org.provider_enabled THEN v_blockers:=array_append(v_blockers,'PROVIDER_MODE_DISABLED'); END IF;
  IF v_org.verification_status<>'VERIFIED' THEN v_blockers:=array_append(v_blockers,'LEGAL_ENTITY_NOT_VERIFIED'); END IF;
  IF v_org.payout_status<>'ACTIVE' THEN v_blockers:=array_append(v_blockers,'PAYOUT_NOT_ACTIVE'); END IF;
  IF cardinality(v_profile.coverage_postal_codes)=0 THEN v_blockers:=array_append(v_blockers,'COVERAGE_REQUIRED'); END IF;
  IF v_profile.weekly_capacity_slots<=0 THEN v_blockers:=array_append(v_blockers,'CAPACITY_REQUIRED'); END IF;
  IF v_eligible_crew<=0 THEN v_blockers:=array_append(v_blockers,'ELIGIBLE_CREW_REQUIRED'); END IF;
  IF v_profile.pricing_mode<>'QUOTE_REQUIRED' AND (
    v_profile.corridor_minimum_cents IS NULL OR v_profile.corridor_maximum_cents IS NULL
    OR v_profile.corridor_minimum_cents<=0
    OR v_profile.corridor_maximum_cents<v_profile.corridor_minimum_cents
  ) THEN v_blockers:=array_append(v_blockers,'INVALID_PRICE_CORRIDOR'); END IF;
  IF jsonb_array_length(v_profile.proof_checklist)=0 THEN v_blockers:=array_append(v_blockers,'PROOF_RECIPE_REQUIRED'); END IF;
  IF NOT v_credentials_met THEN v_blockers:=array_append(v_blockers,'CREDENTIALS_NOT_MET'); END IF;

  v_ready := cardinality(v_blockers)=0;
  v_snapshot := jsonb_build_object(
    'provider_enabled',v_org.provider_enabled,
    'verification_status',v_org.verification_status,
    'payout_status',v_org.payout_status,
    'coverage_count',cardinality(v_profile.coverage_postal_codes),
    'weekly_capacity_slots',v_profile.weekly_capacity_slots,
    'eligible_crew_count',v_eligible_crew,
    'pricing_mode',v_profile.pricing_mode,
    'proof_step_count',jsonb_array_length(v_profile.proof_checklist),
    'credentials_met',v_credentials_met
  );

  IF v_ready THEN
    UPDATE business_service_profiles SET status='ACTIVE',updated_at=NOW()
    WHERE id=p_service_profile_id;
  END IF;
  INSERT INTO business_service_activation_events(
    organization_id,service_profile_id,actor_id,outcome,blockers,readiness_snapshot
  ) VALUES (
    p_organization_id,p_service_profile_id,p_actor_id,
    CASE WHEN v_ready THEN 'ACTIVATED' ELSE 'BLOCKED' END,
    v_blockers,v_snapshot
  );
  INSERT INTO business_audit_events(
    organization_id,actor_id,action,object_type,object_id,after_state
  ) VALUES (
    p_organization_id,p_actor_id,
    CASE WHEN v_ready THEN 'SERVICE_PROFILE_ACTIVATED' ELSE 'SERVICE_PROFILE_ACTIVATION_BLOCKED' END,
    'SERVICE_PROFILE',p_service_profile_id,
    jsonb_build_object('ready',v_ready,'blockers',v_blockers,'readiness',v_snapshot)
  );
  RETURN QUERY SELECT v_profile.id,v_ready,v_blockers;
END $$;

REVOKE ALL ON FUNCTION public.upsert_business_budget_policy(UUID,UUID,UUID,TEXT,BIGINT,BIGINT,BIGINT,BOOLEAN,BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.request_business_spend(UUID,UUID,UUID,TEXT,BIGINT,TEXT,TEXT,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.decide_business_approval(UUID,UUID,UUID,TEXT,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_business_service_profile(UUID,UUID,TEXT,TEXT,TEXT,TEXT[],JSONB,TEXT[],INTEGER,INTEGER,DATE[],TEXT,BIGINT,BIGINT,TEXT,JSONB,JSONB,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.submit_business_credential(UUID,UUID,UUID,TEXT,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assign_business_service_crew(UUID,UUID,UUID,UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.activate_business_service_profile(UUID,UUID,UUID) FROM PUBLIC;

COMMIT;
