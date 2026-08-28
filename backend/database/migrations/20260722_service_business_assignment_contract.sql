-- HustleXP Service Business provider assignment contract v1.
-- Provider principal, verified fulfiller, and provider-backed payee remain
-- distinct while canonical tasks, escrows, proof, disputes, and reviews stay
-- the only work and money lifecycle.

BEGIN;

CREATE TABLE IF NOT EXISTS business_provider_payout_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES business_organizations(id) ON DELETE RESTRICT,
  payout_membership_id UUID NOT NULL REFERENCES business_memberships(id) ON DELETE RESTRICT,
  payout_recipient_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  provider_account_fingerprint CHAR(64) NOT NULL
    CHECK (provider_account_fingerprint ~ '^[a-f0-9]{64}$'),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','RESTRICTED','DISABLED')),
  provider_status_snapshot JSONB NOT NULL CHECK (jsonb_typeof(provider_status_snapshot)='object'),
  verified_at TIMESTAMPTZ NOT NULL,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS business_provider_payout_one_active
  ON business_provider_payout_accounts(organization_id) WHERE status='ACTIVE';

CREATE TABLE IF NOT EXISTS business_provider_payout_link_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES business_organizations(id) ON DELETE RESTRICT,
  actor_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  payout_membership_id UUID NOT NULL REFERENCES business_memberships(id) ON DELETE RESTRICT,
  provider_account_fingerprint CHAR(64) NOT NULL
    CHECK (provider_account_fingerprint ~ '^[a-f0-9]{64}$'),
  payout_account_id UUID NOT NULL REFERENCES business_provider_payout_accounts(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_-]{8,128}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id,idempotency_key)
);

CREATE TABLE IF NOT EXISTS business_provider_payout_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_account_id UUID NOT NULL REFERENCES business_provider_payout_accounts(id) ON DELETE RESTRICT,
  organization_id UUID NOT NULL REFERENCES business_organizations(id) ON DELETE RESTRICT,
  actor_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN ('LINKED','RESTRICTED','DISABLED')),
  evidence JSONB NOT NULL CHECK (jsonb_typeof(evidence)='object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE worker_offer_decisions
  ADD COLUMN IF NOT EXISTS provider_organization_id UUID REFERENCES business_organizations(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS provider_service_profile_id UUID REFERENCES business_service_profiles(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS provider_crew_assignment_id UUID REFERENCES business_service_crew_assignments(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES users(id) ON DELETE RESTRICT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='worker_offer_provider_context_complete'
  ) THEN
    ALTER TABLE worker_offer_decisions
      ADD CONSTRAINT worker_offer_provider_context_complete CHECK (
        (provider_organization_id IS NULL AND provider_service_profile_id IS NULL
          AND provider_crew_assignment_id IS NULL AND reviewed_by IS NULL)
        OR
        (provider_organization_id IS NOT NULL AND provider_service_profile_id IS NOT NULL
          AND provider_crew_assignment_id IS NOT NULL AND reviewed_by IS NOT NULL)
      );
  END IF;
END $$;

ALTER TABLE worker_counter_offers
  ADD COLUMN IF NOT EXISTS provider_organization_id UUID REFERENCES business_organizations(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS provider_service_profile_id UUID REFERENCES business_service_profiles(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS provider_crew_assignment_id UUID REFERENCES business_service_crew_assignments(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS requested_by UUID REFERENCES users(id) ON DELETE RESTRICT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='worker_counter_provider_context_complete'
  ) THEN
    ALTER TABLE worker_counter_offers
      ADD CONSTRAINT worker_counter_provider_context_complete CHECK (
        (provider_organization_id IS NULL AND provider_service_profile_id IS NULL
          AND provider_crew_assignment_id IS NULL AND requested_by IS NULL)
        OR
        (provider_organization_id IS NOT NULL AND provider_service_profile_id IS NOT NULL
          AND provider_crew_assignment_id IS NOT NULL AND requested_by IS NOT NULL)
      );
  END IF;
END $$;

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS provider_organization_id UUID REFERENCES business_organizations(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS provider_service_profile_id UUID REFERENCES business_service_profiles(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS payout_recipient_user_id UUID REFERENCES users(id) ON DELETE RESTRICT;

CREATE TABLE IF NOT EXISTS business_service_task_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE RESTRICT,
  provider_organization_id UUID NOT NULL REFERENCES business_organizations(id) ON DELETE RESTRICT,
  service_profile_id UUID NOT NULL REFERENCES business_service_profiles(id) ON DELETE RESTRICT,
  crew_assignment_id UUID NOT NULL REFERENCES business_service_crew_assignments(id) ON DELETE RESTRICT,
  fulfiller_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  payout_account_id UUID NOT NULL REFERENCES business_provider_payout_accounts(id) ON DELETE RESTRICT,
  payout_recipient_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  offer_decision_id UUID NOT NULL REFERENCES worker_offer_decisions(id) ON DELETE RESTRICT,
  accepted_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  eligibility_snapshot JSONB NOT NULL CHECK (jsonb_typeof(eligibility_snapshot)='object'),
  credential_snapshot JSONB NOT NULL CHECK (jsonb_typeof(credential_snapshot)='object'),
  payout_snapshot JSONB NOT NULL CHECK (jsonb_typeof(payout_snapshot)='object'),
  proof_recipe_snapshot JSONB NOT NULL CHECK (jsonb_typeof(proof_recipe_snapshot)='array'),
  idempotency_key TEXT NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_-]{8,128}$'),
  request_hash CHAR(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider_organization_id,idempotency_key)
);

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS provider_assignment_id UUID
    REFERENCES business_service_task_assignments(id) ON DELETE RESTRICT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='tasks_service_business_provider_complete'
  ) THEN
    ALTER TABLE tasks
      ADD CONSTRAINT tasks_service_business_provider_complete CHECK (
        (provider_organization_id IS NULL AND provider_service_profile_id IS NULL
          AND provider_assignment_id IS NULL AND payout_recipient_user_id IS NULL)
        OR
        (provider_organization_id IS NOT NULL AND provider_service_profile_id IS NOT NULL
          AND provider_assignment_id IS NOT NULL AND payout_recipient_user_id IS NOT NULL)
      );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS business_service_offer_response_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_decision_id UUID NOT NULL REFERENCES worker_offer_decisions(id) ON DELETE RESTRICT,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  organization_id UUID NOT NULL REFERENCES business_organizations(id) ON DELETE RESTRICT,
  actor_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN (
    'DECLINED','CLARIFICATION_REQUESTED','QUOTED','ACCEPTED'
  )),
  idempotency_key TEXT NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_-]{8,128}$'),
  request_hash CHAR(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  details JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(details)='object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id,actor_id,idempotency_key)
);

CREATE TABLE IF NOT EXISTS business_service_offer_review_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES business_organizations(id) ON DELETE RESTRICT,
  actor_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  service_profile_id UUID NOT NULL REFERENCES business_service_profiles(id) ON DELETE RESTRICT,
  crew_assignment_id UUID NOT NULL REFERENCES business_service_crew_assignments(id) ON DELETE RESTRICT,
  offer_decision_id UUID NOT NULL REFERENCES worker_offer_decisions(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_-]{8,128}$'),
  request_hash CHAR(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id,actor_id,idempotency_key)
);

CREATE OR REPLACE FUNCTION prevent_service_business_assignment_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'HXSB1: Service Business assignment and response evidence is append-only'
    USING ERRCODE='P0001';
END $$;

DROP TRIGGER IF EXISTS business_provider_payout_events_immutable ON business_provider_payout_events;
CREATE TRIGGER business_provider_payout_events_immutable
BEFORE UPDATE OR DELETE ON business_provider_payout_events
FOR EACH ROW EXECUTE FUNCTION prevent_service_business_assignment_mutation();

DROP TRIGGER IF EXISTS business_provider_payout_link_requests_immutable ON business_provider_payout_link_requests;
CREATE TRIGGER business_provider_payout_link_requests_immutable
BEFORE UPDATE OR DELETE ON business_provider_payout_link_requests
FOR EACH ROW EXECUTE FUNCTION prevent_service_business_assignment_mutation();

DROP TRIGGER IF EXISTS business_service_task_assignments_immutable ON business_service_task_assignments;
CREATE TRIGGER business_service_task_assignments_immutable
BEFORE UPDATE OR DELETE ON business_service_task_assignments
FOR EACH ROW EXECUTE FUNCTION prevent_service_business_assignment_mutation();

DROP TRIGGER IF EXISTS business_service_offer_response_events_immutable ON business_service_offer_response_events;
CREATE TRIGGER business_service_offer_response_events_immutable
BEFORE UPDATE OR DELETE ON business_service_offer_response_events
FOR EACH ROW EXECUTE FUNCTION prevent_service_business_assignment_mutation();

DROP TRIGGER IF EXISTS business_service_offer_review_requests_immutable ON business_service_offer_review_requests;
CREATE TRIGGER business_service_offer_review_requests_immutable
BEFORE UPDATE OR DELETE ON business_service_offer_review_requests
FOR EACH ROW EXECUTE FUNCTION prevent_service_business_assignment_mutation();

DROP TRIGGER IF EXISTS business_provider_payout_events_no_truncate ON business_provider_payout_events;
CREATE TRIGGER business_provider_payout_events_no_truncate
BEFORE TRUNCATE ON business_provider_payout_events
FOR EACH STATEMENT EXECUTE FUNCTION prevent_append_only_truncate();

DROP TRIGGER IF EXISTS business_provider_payout_link_requests_no_truncate ON business_provider_payout_link_requests;
CREATE TRIGGER business_provider_payout_link_requests_no_truncate
BEFORE TRUNCATE ON business_provider_payout_link_requests
FOR EACH STATEMENT EXECUTE FUNCTION prevent_append_only_truncate();

DROP TRIGGER IF EXISTS business_service_task_assignments_no_truncate ON business_service_task_assignments;
CREATE TRIGGER business_service_task_assignments_no_truncate
BEFORE TRUNCATE ON business_service_task_assignments
FOR EACH STATEMENT EXECUTE FUNCTION prevent_append_only_truncate();

DROP TRIGGER IF EXISTS business_service_offer_response_events_no_truncate ON business_service_offer_response_events;
CREATE TRIGGER business_service_offer_response_events_no_truncate
BEFORE TRUNCATE ON business_service_offer_response_events
FOR EACH STATEMENT EXECUTE FUNCTION prevent_append_only_truncate();

DROP TRIGGER IF EXISTS business_service_offer_review_requests_no_truncate ON business_service_offer_review_requests;
CREATE TRIGGER business_service_offer_review_requests_no_truncate
BEFORE TRUNCATE ON business_service_offer_review_requests
FOR EACH STATEMENT EXECUTE FUNCTION prevent_append_only_truncate();

CREATE OR REPLACE FUNCTION link_business_provider_payout_account(
  p_organization_id UUID,
  p_actor_id UUID,
  p_payout_membership_id UUID,
  p_idempotency_key TEXT
) RETURNS TABLE(
  payout_account_id UUID,
  payout_recipient_user_id UUID,
  payout_status TEXT
) LANGUAGE plpgsql SECURITY DEFINER
SET search_path=public,pg_temp AS $$
DECLARE
  v_org business_organizations%ROWTYPE;
  v_membership business_memberships%ROWTYPE;
  v_user users%ROWTYPE;
  v_account business_provider_payout_accounts%ROWTYPE;
  v_request business_provider_payout_link_requests%ROWTYPE;
  v_disabled business_provider_payout_accounts%ROWTYPE;
  v_fingerprint TEXT;
BEGIN
  PERFORM business_require_action(p_organization_id,p_actor_id,'MANAGE_BILLING');
  SELECT * INTO v_org FROM business_organizations
   WHERE id=p_organization_id FOR UPDATE;
  SELECT * INTO v_membership FROM business_memberships
   WHERE id=p_payout_membership_id AND organization_id=p_organization_id FOR SHARE;
  IF v_org.id IS NULL OR v_org.status<>'ACTIVE' OR v_org.provider_enabled IS NOT TRUE
     OR v_org.verification_status<>'VERIFIED' THEN
    RAISE EXCEPTION 'HXSB2: verified active provider organization required' USING ERRCODE='P0001';
  END IF;
  IF v_membership.id IS NULL OR v_membership.status<>'ACTIVE'
     OR v_membership.role NOT IN ('OWNER','ADMIN') THEN
    RAISE EXCEPTION 'HXSB3: payout delegate must be an active OWNER or ADMIN' USING ERRCODE='P0001';
  END IF;
  SELECT * INTO v_user FROM users WHERE id=v_membership.user_id FOR SHARE;
  IF v_user.id IS NULL OR v_user.account_status<>'ACTIVE' OR v_user.is_minor IS TRUE
     OR v_user.stripe_connect_id IS NULL OR v_user.payouts_enabled IS NOT TRUE THEN
    RAISE EXCEPTION 'HXSB4: provider-backed payout account is not active' USING ERRCODE='P0001';
  END IF;
  v_fingerprint:=encode(digest(v_user.stripe_connect_id,'sha256'),'hex');

  SELECT * INTO v_request FROM business_provider_payout_link_requests
   WHERE organization_id=p_organization_id AND idempotency_key=p_idempotency_key FOR SHARE;
  IF v_request.id IS NOT NULL THEN
    IF v_request.payout_membership_id<>p_payout_membership_id
       OR v_request.provider_account_fingerprint<>v_fingerprint THEN
      RAISE EXCEPTION 'HXBUS4: idempotency key payload conflict' USING ERRCODE='P0001';
    END IF;
    SELECT * INTO v_account FROM business_provider_payout_accounts
     WHERE id=v_request.payout_account_id FOR SHARE;
    IF v_account.status<>'ACTIVE' THEN
      RAISE EXCEPTION 'HXSB4: prior payout link is no longer active' USING ERRCODE='P0001';
    END IF;
    RETURN QUERY SELECT v_account.id,v_account.payout_recipient_user_id,v_account.status;
    RETURN;
  END IF;

  SELECT * INTO v_account FROM business_provider_payout_accounts
   WHERE organization_id=p_organization_id AND status='ACTIVE' FOR UPDATE;
  IF v_account.id IS NOT NULL
     AND v_account.payout_membership_id=p_payout_membership_id
     AND v_account.provider_account_fingerprint=v_fingerprint THEN
    INSERT INTO business_provider_payout_link_requests(
      organization_id,actor_id,payout_membership_id,provider_account_fingerprint,
      payout_account_id,idempotency_key
    ) VALUES (
      p_organization_id,p_actor_id,p_payout_membership_id,v_fingerprint,
      v_account.id,p_idempotency_key
    );
    RETURN QUERY SELECT v_account.id,v_account.payout_recipient_user_id,v_account.status;
    RETURN;
  END IF;

  FOR v_disabled IN
    UPDATE business_provider_payout_accounts SET status='DISABLED',updated_at=NOW()
     WHERE organization_id=p_organization_id AND status='ACTIVE'
     RETURNING *
  LOOP
    INSERT INTO business_provider_payout_events(
      payout_account_id,organization_id,actor_id,event_type,evidence
    ) VALUES (
      v_disabled.id,p_organization_id,p_actor_id,'DISABLED',
      jsonb_build_object('reason','PROVIDER_PAYOUT_REPLACED',
        'replacement_fingerprint',v_fingerprint)
    );
  END LOOP;
  INSERT INTO business_provider_payout_accounts(
    organization_id,payout_membership_id,payout_recipient_user_id,
    provider_account_fingerprint,status,provider_status_snapshot,verified_at,
    created_by
  ) VALUES (
    p_organization_id,p_payout_membership_id,v_user.id,v_fingerprint,'ACTIVE',
    jsonb_build_object(
      'stripe_connect_status',v_user.stripe_connect_status,
      'payouts_enabled',v_user.payouts_enabled,
      'charges_enabled',v_user.charges_enabled
    ),NOW(),p_actor_id
  ) RETURNING * INTO v_account;
  INSERT INTO business_provider_payout_link_requests(
    organization_id,actor_id,payout_membership_id,provider_account_fingerprint,
    payout_account_id,idempotency_key
  ) VALUES (
    p_organization_id,p_actor_id,p_payout_membership_id,v_fingerprint,
    v_account.id,p_idempotency_key
  );
  UPDATE business_organizations SET payout_status='ACTIVE',updated_at=NOW()
   WHERE id=p_organization_id;
  INSERT INTO business_provider_payout_events(
    payout_account_id,organization_id,actor_id,event_type,evidence
  ) VALUES (
    v_account.id,p_organization_id,p_actor_id,'LINKED',
    jsonb_build_object('payout_recipient_user_id',v_user.id,
      'provider_account_fingerprint',v_fingerprint)
  );
  INSERT INTO business_audit_events(
    organization_id,actor_id,action,object_type,object_id,after_state
  ) VALUES (
    p_organization_id,p_actor_id,'PROVIDER_PAYOUT_LINKED','PROVIDER_PAYOUT',v_account.id,
    jsonb_build_object('payout_recipient_user_id',v_user.id,'status','ACTIVE')
  );
  RETURN QUERY SELECT v_account.id,v_account.payout_recipient_user_id,v_account.status;
END $$;

CREATE OR REPLACE FUNCTION restrict_business_payout_on_provider_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_account RECORD;
BEGIN
  IF OLD.stripe_connect_id IS NOT DISTINCT FROM NEW.stripe_connect_id
     AND NEW.stripe_connect_id IS NOT NULL AND NEW.payouts_enabled IS TRUE
     AND NEW.account_status='ACTIVE' THEN
    RETURN NEW;
  END IF;
  FOR v_account IN
    UPDATE business_provider_payout_accounts
       SET status='RESTRICTED',updated_at=NOW()
     WHERE payout_recipient_user_id=NEW.id AND status='ACTIVE'
     RETURNING id,organization_id
  LOOP
    UPDATE business_organizations SET payout_status='RESTRICTED',updated_at=NOW()
     WHERE id=v_account.organization_id;
    UPDATE business_service_profiles SET status='PAUSED',updated_at=NOW()
     WHERE organization_id=v_account.organization_id AND status='ACTIVE';
    INSERT INTO business_provider_payout_events(
      payout_account_id,organization_id,event_type,evidence
    ) VALUES (
      v_account.id,v_account.organization_id,'RESTRICTED',
      jsonb_build_object('reason','PROVIDER_ACCOUNT_CHANGED','payouts_enabled',NEW.payouts_enabled,
        'account_status',NEW.account_status)
    );
  END LOOP;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS business_provider_payout_provider_change ON users;
CREATE TRIGGER business_provider_payout_provider_change
AFTER UPDATE OF stripe_connect_id,payouts_enabled,account_status ON users
FOR EACH ROW WHEN (
  OLD.stripe_connect_id IS DISTINCT FROM NEW.stripe_connect_id
  OR OLD.payouts_enabled IS DISTINCT FROM NEW.payouts_enabled
  OR OLD.account_status IS DISTINCT FROM NEW.account_status
) EXECUTE FUNCTION restrict_business_payout_on_provider_change();

CREATE OR REPLACE FUNCTION evaluate_service_business_assignment(
  p_organization_id UUID,
  p_actor_id UUID,
  p_service_profile_id UUID,
  p_crew_assignment_id UUID,
  p_task_id UUID,
  p_offer_decision_id UUID DEFAULT NULL
) RETURNS TABLE(
  ready BOOLEAN,
  blockers TEXT[],
  payout_recipient_user_id UUID,
  fulfiller_user_id UUID
) LANGUAGE plpgsql SECURITY DEFINER
SET search_path=public,pg_temp AS $$
DECLARE
  v_org business_organizations%ROWTYPE;
  v_profile business_service_profiles%ROWTYPE;
  v_crew business_service_crew_assignments%ROWTYPE;
  v_member business_memberships%ROWTYPE;
  v_worker users%ROWTYPE;
  v_capability capability_profiles%ROWTYPE;
  v_task tasks%ROWTYPE;
  v_location business_locations%ROWTYPE;
  v_payout business_provider_payout_accounts%ROWTYPE;
  v_payee users%ROWTYPE;
  v_offer worker_offer_decisions%ROWTYPE;
  v_escrow_state TEXT;
  v_cell_ready BOOLEAN := FALSE;
  v_active_count INTEGER := 0;
  v_worker_active_count INTEGER := 0;
  v_blockers TEXT[] := ARRAY[]::TEXT[];
BEGIN
  PERFORM business_require_action(p_organization_id,p_actor_id,'ASSIGN_CREW');
  SELECT * INTO v_org FROM business_organizations WHERE id=p_organization_id FOR SHARE;
  SELECT * INTO v_profile FROM business_service_profiles
   WHERE id=p_service_profile_id AND organization_id=p_organization_id FOR SHARE;
  SELECT * INTO v_crew FROM business_service_crew_assignments
   WHERE id=p_crew_assignment_id AND organization_id=p_organization_id
     AND service_profile_id=p_service_profile_id FOR SHARE;
  SELECT * INTO v_member FROM business_memberships WHERE id=v_crew.membership_id FOR SHARE;
  SELECT * INTO v_worker FROM users WHERE id=v_member.user_id FOR SHARE;
  SELECT * INTO v_capability FROM capability_profiles WHERE user_id=v_worker.id FOR SHARE;
  SELECT * INTO v_task FROM tasks WHERE id=p_task_id FOR SHARE;
  IF v_task.business_location_id IS NOT NULL THEN
    SELECT * INTO v_location FROM business_locations WHERE id=v_task.business_location_id FOR SHARE;
  END IF;
  SELECT * INTO v_payout FROM business_provider_payout_accounts
   WHERE organization_id=p_organization_id AND status='ACTIVE' ORDER BY verified_at DESC LIMIT 1 FOR SHARE;
  SELECT * INTO v_payee FROM users WHERE id=v_payout.payout_recipient_user_id FOR SHARE;
  SELECT state INTO v_escrow_state FROM escrows WHERE task_id=p_task_id ORDER BY created_at DESC LIMIT 1 FOR SHARE;
  SELECT EXISTS(
    SELECT 1 FROM zone_category_cells cell
     WHERE cell.id=v_task.liquidity_cell_id AND cell.environment='PRODUCTION'
       AND cell.is_test IS FALSE AND cell.launch_cell_enabled IS TRUE
       AND cell.dispatch_allowed IS TRUE AND cell.state IN ('LIMITED','OPEN','DENSE')
       AND cell.metrics_computed_at>=NOW()-INTERVAL '15 minutes'
       AND cell.evaluated_at>=NOW()-INTERVAL '15 minutes'
  ) INTO v_cell_ready;
  SELECT COUNT(*) INTO v_active_count FROM tasks active
   WHERE active.provider_organization_id=p_organization_id
     AND active.provider_service_profile_id=p_service_profile_id
     AND active.id<>p_task_id AND active.state IN ('ACCEPTED','PROOF_SUBMITTED','DISPUTED');
  SELECT COUNT(*) INTO v_worker_active_count FROM tasks active
   WHERE active.worker_id=v_worker.id AND active.id<>p_task_id
     AND active.state IN ('ACCEPTED','PROOF_SUBMITTED','DISPUTED');

  IF v_org.id IS NULL OR v_org.status<>'ACTIVE' OR v_org.provider_enabled IS NOT TRUE
    THEN v_blockers:=array_append(v_blockers,'PROVIDER_ORGANIZATION_INACTIVE'); END IF;
  IF v_org.verification_status IS DISTINCT FROM 'VERIFIED'
    THEN v_blockers:=array_append(v_blockers,'PROVIDER_ORGANIZATION_UNVERIFIED'); END IF;
  IF v_payout.id IS NULL OR v_payee.id IS NULL OR v_payee.account_status<>'ACTIVE'
     OR v_payee.stripe_connect_id IS NULL OR v_payee.payouts_enabled IS NOT TRUE
    THEN v_blockers:=array_append(v_blockers,'PAYOUT_ACCOUNT_NOT_READY'); END IF;
  IF v_profile.id IS NULL OR v_profile.status<>'ACTIVE'
    THEN v_blockers:=array_append(v_blockers,'SERVICE_PROFILE_INACTIVE'); END IF;
  IF v_profile.id IS NOT NULL AND lower(v_profile.service_code)<>lower(COALESCE(v_task.category,''))
    THEN v_blockers:=array_append(v_blockers,'SERVICE_CATEGORY_MISMATCH'); END IF;
  IF v_crew.id IS NULL OR v_crew.eligible IS NOT TRUE OR v_member.id IS NULL
     OR v_member.status<>'ACTIVE' OR v_member.role NOT IN ('CREW','DISPATCHER','ADMIN','OWNER')
    THEN v_blockers:=array_append(v_blockers,'CREW_NOT_ELIGIBLE'); END IF;
  IF v_worker.id IS NULL OR v_worker.default_mode<>'worker' OR v_worker.account_status<>'ACTIVE'
     OR v_worker.is_minor IS TRUE OR COALESCE(v_worker.is_banned,FALSE) IS TRUE
     OR v_worker.is_verified IS NOT TRUE OR NULLIF(BTRIM(v_worker.phone),'') IS NULL
     OR NOT identity_verification_is_current_v1(v_worker.id,'PRODUCTION')
     OR (v_worker.trust_hold AND (v_worker.trust_hold_until IS NULL OR v_worker.trust_hold_until>NOW()))
    THEN v_blockers:=array_append(v_blockers,'CREW_NOT_ELIGIBLE'); END IF;
  IF v_capability.user_id IS NULL OR v_capability.trust_tier IS DISTINCT FROM v_worker.trust_tier
    THEN v_blockers:=array_append(v_blockers,'CREW_CAPABILITY_STALE'); END IF;
  IF v_profile.id IS NOT NULL AND EXISTS(
    SELECT 1 FROM jsonb_array_elements_text(v_profile.credential_requirements) requirement
     WHERE NOT EXISTS(
       SELECT 1 FROM business_credentials credential
        WHERE credential.organization_id=p_organization_id
          AND (credential.membership_id=v_member.id OR credential.membership_id IS NULL)
          AND credential.credential_type=requirement AND credential.status='ACTIVE'
          AND (credential.expires_at IS NULL OR credential.expires_at>NOW())
     )
  ) THEN v_blockers:=array_append(v_blockers,'CREW_CREDENTIAL_EXPIRED'); END IF;
  IF v_profile.id IS NULL OR v_profile.weekly_capacity_slots<=v_active_count
    THEN v_blockers:=array_append(v_blockers,'SERVICE_CAPACITY_UNAVAILABLE'); END IF;
  IF v_location.id IS NULL OR v_location.status<>'ACTIVE'
     OR NOT (v_location.postal_code=ANY(COALESCE(v_profile.coverage_postal_codes,ARRAY[]::TEXT[])))
    THEN v_blockers:=array_append(v_blockers,'SERVICE_COVERAGE_MISMATCH'); END IF;
  IF v_profile.id IS NOT NULL AND v_task.deadline IS NOT NULL
     AND (v_task.deadline AT TIME ZONE v_location.timezone)::DATE=ANY(v_profile.blackout_dates)
    THEN v_blockers:=array_append(v_blockers,'SERVICE_BLACKOUT_DATE'); END IF;
  IF v_task.id IS NULL OR v_task.state NOT IN ('OPEN','MATCHING') OR v_task.worker_id IS NOT NULL
    THEN v_blockers:=array_append(v_blockers,'TASK_NOT_AVAILABLE'); END IF;
  IF v_task.poster_id IS NOT NULL AND v_task.poster_id=v_worker.id
    THEN v_blockers:=array_append(v_blockers,'SELF_ASSIGNMENT_FORBIDDEN'); END IF;
  IF v_escrow_state IS DISTINCT FROM 'FUNDED'
    THEN v_blockers:=array_append(v_blockers,'TASK_NOT_FUNDED'); END IF;
  IF v_task.clarification_state IS DISTINCT FROM 'READY'
    THEN v_blockers:=array_append(v_blockers,'CLARIFICATION_UNRESOLVED'); END IF;
  IF NOT v_cell_ready THEN v_blockers:=array_append(v_blockers,'LIQUIDITY_CELL_NOT_READY'); END IF;
  IF v_worker.id IS NOT NULL AND v_task.id IS NOT NULL AND (
    v_worker.trust_tier<COALESCE(v_task.trust_tier_required,1)
    OR lower(v_task.risk_level)<>ALL(COALESCE(v_capability.risk_clearance,ARRAY[]::TEXT[]))
    OR v_task.risk_level='IN_HOME'
    OR v_task.price>CASE WHEN v_worker.trust_tier=1 THEN 5000
      WHEN v_worker.trust_tier=2 THEN 20000 ELSE 9999900 END
    OR (v_task.risk_level='HIGH' AND v_worker.plan<>'pro' AND NOT EXISTS(
      SELECT 1 FROM plan_entitlements entitlement
       WHERE entitlement.user_id=v_worker.id
         AND (entitlement.task_id IS NULL OR entitlement.task_id=v_task.id)
         AND entitlement.risk_level='HIGH' AND entitlement.expires_at>NOW()))
  ) THEN v_blockers:=array_append(v_blockers,'CREW_TRUST_OR_RISK_BLOCKED'); END IF;
  IF v_worker.id IS NOT NULL AND EXISTS(
    SELECT 1 FROM disputes dispute WHERE dispute.worker_id=v_worker.id
      AND dispute.state IN ('OPEN','EVIDENCE_REQUESTED','ESCALATED')
  ) THEN v_blockers:=array_append(v_blockers,'CREW_ACTIVE_DISPUTE'); END IF;
  IF v_worker_active_count>=5
    THEN v_blockers:=array_append(v_blockers,'CREW_CAPACITY_UNAVAILABLE'); END IF;
  IF v_task.license_required IS TRUE AND NOT EXISTS(
    SELECT 1 FROM license_verifications license WHERE license.user_id=v_worker.id
      AND license.trade_type=v_task.trade_type AND license.issuing_state=v_task.location_state
      AND lower(license.status) IN ('approved','verified')
      AND (license.expiration_date IS NULL OR license.expiration_date>=CURRENT_DATE)
  ) THEN v_blockers:=array_append(v_blockers,'CREW_LICENSE_REQUIRED'); END IF;
  IF v_task.insurance_required IS TRUE AND NOT EXISTS(
    SELECT 1 FROM insurance_verifications insurance WHERE insurance.user_id=v_worker.id
      AND lower(insurance.status) IN ('approved','verified')
      AND (insurance.expiration_date IS NULL OR insurance.expiration_date>=CURRENT_DATE)
  ) THEN v_blockers:=array_append(v_blockers,'CREW_INSURANCE_REQUIRED'); END IF;
  IF v_task.background_check_required IS TRUE AND (
    v_capability.background_check_valid IS NOT TRUE
    OR v_capability.background_check_source_id IS NULL
    OR v_capability.background_check_environment IS DISTINCT FROM 'PRODUCTION'
    OR v_capability.background_check_is_test IS NOT FALSE
    OR (v_capability.background_check_expires_at IS NOT NULL
      AND v_capability.background_check_expires_at<=NOW())
    OR NOT EXISTS(
      SELECT 1 FROM background_checks screening
       WHERE screening.id=v_capability.background_check_source_id
         AND screening.user_id=v_worker.id AND screening.status='CLEAR'
         AND screening.provider_environment='PRODUCTION' AND screening.is_test IS FALSE
         AND (screening.expires_at IS NULL OR screening.expires_at>NOW())
    )
  ) THEN v_blockers:=array_append(v_blockers,'CREW_SCREENING_REQUIRED'); END IF;

  IF p_offer_decision_id IS NOT NULL THEN
    SELECT * INTO v_offer FROM worker_offer_decisions WHERE id=p_offer_decision_id FOR SHARE;
    IF v_offer.id IS NULL OR v_offer.task_id<>p_task_id OR v_offer.worker_id<>v_worker.id
       OR v_offer.provider_organization_id<>p_organization_id
       OR v_offer.provider_service_profile_id<>p_service_profile_id
       OR v_offer.provider_crew_assignment_id<>p_crew_assignment_id
       OR v_offer.decision_ready IS NOT TRUE OR v_offer.expires_at<=NOW()
       OR v_offer.customer_total_cents<>v_task.price
       OR v_offer.payout_cents IS DISTINCT FROM v_task.hustler_payout_cents
       OR v_offer.scope_hash IS DISTINCT FROM v_task.scope_hash
       OR v_offer.cancellation_policy_version IS DISTINCT FROM v_task.cancellation_policy_version
       OR v_offer.estimated_duration_minutes IS DISTINCT FROM v_task.estimated_duration_minutes
    THEN v_blockers:=array_append(v_blockers,'OFFER_NOT_CURRENT'); END IF;
  END IF;

  RETURN QUERY SELECT cardinality(v_blockers)=0,v_blockers,v_payout.payout_recipient_user_id,v_worker.id;
END $$;

CREATE OR REPLACE FUNCTION record_business_service_offer_response(
  p_offer_decision_id UUID,
  p_organization_id UUID,
  p_actor_id UUID,
  p_action TEXT,
  p_idempotency_key TEXT,
  p_request_hash TEXT,
  p_details JSONB DEFAULT '{}'::JSONB
) RETURNS TABLE(event_id UUID,replayed BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_offer worker_offer_decisions%ROWTYPE; v_event business_service_offer_response_events%ROWTYPE;
BEGIN
  PERFORM business_require_action(p_organization_id,p_actor_id,'ASSIGN_CREW');
  IF p_action NOT IN ('DECLINED','CLARIFICATION_REQUESTED','QUOTED','ACCEPTED') THEN
    RAISE EXCEPTION 'HXSB5: invalid Service Business response action' USING ERRCODE='P0001';
  END IF;
  SELECT * INTO v_offer FROM worker_offer_decisions
   WHERE id=p_offer_decision_id AND provider_organization_id=p_organization_id FOR SHARE;
  IF v_offer.id IS NULL THEN RAISE EXCEPTION 'HXSB6: Service Business offer not found' USING ERRCODE='P0001'; END IF;
  SELECT * INTO v_event FROM business_service_offer_response_events
   WHERE organization_id=p_organization_id AND actor_id=p_actor_id AND idempotency_key=p_idempotency_key;
  IF v_event.id IS NOT NULL THEN
    IF v_event.request_hash<>p_request_hash THEN
      RAISE EXCEPTION 'HXBUS4: idempotency key payload conflict' USING ERRCODE='P0001';
    END IF;
    RETURN QUERY SELECT v_event.id,TRUE;
    RETURN;
  END IF;
  INSERT INTO business_service_offer_response_events(
    offer_decision_id,task_id,organization_id,actor_id,action,idempotency_key,request_hash,details
  ) VALUES (
    v_offer.id,v_offer.task_id,p_organization_id,p_actor_id,p_action,p_idempotency_key,
    p_request_hash,COALESCE(p_details,'{}'::JSONB)
  ) RETURNING * INTO v_event;
  RETURN QUERY SELECT v_event.id,FALSE;
END $$;

CREATE OR REPLACE FUNCTION commit_service_business_task_assignment(
  p_task_id UUID,
  p_organization_id UUID,
  p_actor_id UUID,
  p_service_profile_id UUID,
  p_crew_assignment_id UUID,
  p_offer_decision_id UUID,
  p_idempotency_key TEXT,
  p_request_hash TEXT
) RETURNS TABLE(
  assignment_id UUID,
  fulfiller_user_id UUID,
  payout_recipient_user_id UUID
) LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_evaluation RECORD;
  v_assignment business_service_task_assignments%ROWTYPE;
  v_payout business_provider_payout_accounts%ROWTYPE;
  v_profile business_service_profiles%ROWTYPE;
  v_member business_memberships%ROWTYPE;
  v_task tasks%ROWTYPE;
BEGIN
  SELECT * INTO v_evaluation FROM evaluate_service_business_assignment(
    p_organization_id,p_actor_id,p_service_profile_id,p_crew_assignment_id,p_task_id,p_offer_decision_id
  );
  IF v_evaluation.ready IS NOT TRUE THEN
    RAISE EXCEPTION 'HXSB7: Service Business assignment blocked: %',array_to_string(v_evaluation.blockers,',')
      USING ERRCODE='P0001';
  END IF;
  SELECT * INTO v_task FROM tasks WHERE id=p_task_id FOR UPDATE;
  SELECT * INTO v_payout FROM business_provider_payout_accounts
   WHERE organization_id=p_organization_id AND status='ACTIVE' ORDER BY verified_at DESC LIMIT 1 FOR SHARE;
  SELECT * INTO v_profile FROM business_service_profiles WHERE id=p_service_profile_id FOR SHARE;
  SELECT membership.* INTO v_member
    FROM business_service_crew_assignments crew
    JOIN business_memberships membership ON membership.id=crew.membership_id
   WHERE crew.id=p_crew_assignment_id FOR SHARE;
  INSERT INTO business_service_task_assignments(
    task_id,provider_organization_id,service_profile_id,crew_assignment_id,
    fulfiller_user_id,payout_account_id,payout_recipient_user_id,offer_decision_id,
    accepted_by,eligibility_snapshot,credential_snapshot,payout_snapshot,
    proof_recipe_snapshot,idempotency_key,request_hash
  ) VALUES (
    p_task_id,p_organization_id,p_service_profile_id,p_crew_assignment_id,
    v_evaluation.fulfiller_user_id,v_payout.id,v_evaluation.payout_recipient_user_id,
    p_offer_decision_id,p_actor_id,
    jsonb_build_object('evaluated_at',NOW(),'task_state',v_task.state,
      'service_profile_status',v_profile.status,'crew_membership_status',v_member.status),
    COALESCE((SELECT jsonb_object_agg(requirement,TRUE)
      FROM jsonb_array_elements_text(v_profile.credential_requirements) requirement),'{}'::JSONB),
    jsonb_build_object('payout_account_id',v_payout.id,
      'payout_recipient_user_id',v_evaluation.payout_recipient_user_id,
      'provider_account_fingerprint',v_payout.provider_account_fingerprint),
    v_profile.proof_checklist,p_idempotency_key,p_request_hash
  ) RETURNING * INTO v_assignment;
  UPDATE tasks SET
    state='ACCEPTED',progress_state='ACCEPTED',progress_updated_at=NOW(),progress_by=NULL,
    worker_id=v_evaluation.fulfiller_user_id,accepted_at=NOW(),updated_at=NOW(),
    provider_organization_id=p_organization_id,
    provider_service_profile_id=p_service_profile_id,
    provider_assignment_id=v_assignment.id,
    payout_recipient_user_id=v_evaluation.payout_recipient_user_id
  WHERE id=p_task_id AND state IN ('OPEN','MATCHING') AND worker_id IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'HXSB8: concurrent assignment won' USING ERRCODE='P0001'; END IF;
  RETURN QUERY SELECT v_assignment.id,v_assignment.fulfiller_user_id,v_assignment.payout_recipient_user_id;
END $$;

CREATE OR REPLACE FUNCTION enforce_service_business_task_assignment()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_assignment business_service_task_assignments%ROWTYPE;
BEGIN
  IF NEW.provider_organization_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.state<>'ACCEPTED' AND TG_OP='UPDATE' AND OLD.provider_organization_id IS NULL THEN
    RAISE EXCEPTION 'HXSB9: Service Business binding begins only with canonical acceptance' USING ERRCODE='P0001';
  END IF;
  SELECT * INTO v_assignment FROM business_service_task_assignments
   WHERE id=NEW.provider_assignment_id AND task_id=NEW.id FOR SHARE;
  IF v_assignment.id IS NULL
     OR v_assignment.provider_organization_id<>NEW.provider_organization_id
     OR v_assignment.service_profile_id<>NEW.provider_service_profile_id
     OR v_assignment.fulfiller_user_id<>NEW.worker_id
     OR v_assignment.payout_recipient_user_id<>NEW.payout_recipient_user_id THEN
    RAISE EXCEPTION 'HXSB10: canonical task provider binding does not match immutable assignment evidence'
      USING ERRCODE='P0001';
  END IF;
  IF TG_OP='UPDATE' AND OLD.provider_organization_id IS NOT NULL AND ROW(
    NEW.provider_organization_id,NEW.provider_service_profile_id,
    NEW.provider_assignment_id,NEW.payout_recipient_user_id,NEW.worker_id
  ) IS DISTINCT FROM ROW(
    OLD.provider_organization_id,OLD.provider_service_profile_id,
    OLD.provider_assignment_id,OLD.payout_recipient_user_id,OLD.worker_id
  ) THEN
    RAISE EXCEPTION 'HXSB11: accepted Service Business provider binding is immutable'
      USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS task_service_business_assignment_gate ON tasks;
CREATE TRIGGER task_service_business_assignment_gate
BEFORE UPDATE OF state,worker_id,provider_organization_id,provider_service_profile_id,
  provider_assignment_id,payout_recipient_user_id ON tasks
FOR EACH ROW EXECUTE FUNCTION enforce_service_business_task_assignment();

-- Preserve the full worker eligibility backstop while allowing a verified
-- Service Business payee to remain distinct from the actual crew fulfiller.
-- Individual Hustlers still require their own provider-backed payout account.
CREATE OR REPLACE FUNCTION enforce_task_worker_eligibility_on_accept()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_worker RECORD;
  v_active_tasks INTEGER;
  v_local_test_payout BOOLEAN;
  v_local_test_screening BOOLEAN;
  v_business_payout_ready BOOLEAN := FALSE;
BEGIN
  IF NEW.state <> 'ACCEPTED'
     OR (TG_OP = 'UPDATE' AND OLD.state = 'ACCEPTED' AND OLD.worker_id IS NOT DISTINCT FROM NEW.worker_id) THEN
    RETURN NEW;
  END IF;
  IF NEW.worker_id IS NULL THEN
    RAISE EXCEPTION 'HXWE1: accepted task requires a worker' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.poster_id = NEW.worker_id THEN
    RAISE EXCEPTION 'HXWE2: poster cannot accept their own task' USING ERRCODE = 'P0001';
  END IF;

  SELECT
    user_row.default_mode,
    user_row.account_status,
    user_row.is_minor,
    user_row.is_banned,
    user_row.trust_hold,
    user_row.trust_hold_until,
    user_row.trust_tier AS worker_trust_tier,
    user_row.is_verified,
    user_row.phone,
    user_row.plan,
    user_row.stripe_connect_id,
    user_row.payouts_enabled,
    profile.trust_tier AS profile_trust_tier,
    profile.risk_clearance,
    profile.background_check_valid,
    profile.background_check_expires_at,
    profile.background_check_source_id,
    profile.background_check_provider,
    profile.background_check_environment,
    profile.background_check_is_test
  INTO v_worker
  FROM users user_row
  JOIN capability_profiles profile ON profile.user_id = user_row.id
  WHERE user_row.id = NEW.worker_id;

  IF NOT FOUND OR v_worker.default_mode <> 'worker' THEN
    RAISE EXCEPTION 'HXWE3: eligible worker authority is missing' USING ERRCODE = 'P0001';
  END IF;

  v_local_test_payout := NEW.provider_organization_id IS NULL
    AND NEW.automation_classification = 'CONTROLLED_TEST'
    AND current_setting('hustlexp.local_test_payout_enabled', TRUE) = 'true'
    AND EXISTS (
      SELECT 1 FROM hxos_local_test_payout_destinations destination
      WHERE destination.worker_id = NEW.worker_id
        AND destination.status = 'ACTIVE'
        AND destination.is_test IS TRUE
    );
  v_local_test_screening := NEW.automation_classification = 'CONTROLLED_TEST'
    AND current_setting('hustlexp.local_test_screening_enabled', TRUE) = 'true';

  IF NEW.provider_organization_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
      FROM business_service_task_assignments assignment
      JOIN business_provider_payout_accounts payout
        ON payout.id = assignment.payout_account_id
       AND payout.organization_id = assignment.provider_organization_id
       AND payout.payout_recipient_user_id = assignment.payout_recipient_user_id
       AND payout.status = 'ACTIVE'
      JOIN users payee
        ON payee.id = payout.payout_recipient_user_id
       AND payee.account_status = 'ACTIVE'
       AND payee.stripe_connect_id IS NOT NULL
       AND payee.payouts_enabled IS TRUE
      WHERE assignment.id = NEW.provider_assignment_id
        AND assignment.task_id = NEW.id
        AND assignment.provider_organization_id = NEW.provider_organization_id
        AND assignment.service_profile_id = NEW.provider_service_profile_id
        AND assignment.fulfiller_user_id = NEW.worker_id
        AND assignment.payout_recipient_user_id = NEW.payout_recipient_user_id
    ) INTO v_business_payout_ready;
  END IF;

  IF v_worker.account_status <> 'ACTIVE' OR v_worker.is_minor OR v_worker.is_banned THEN
    RAISE EXCEPTION 'HXWE4: worker account is not active and eligible' USING ERRCODE = 'P0001';
  END IF;
  IF v_worker.trust_hold
     AND (v_worker.trust_hold_until IS NULL OR v_worker.trust_hold_until > clock_timestamp()) THEN
    RAISE EXCEPTION 'HXWE5: worker has an active trust hold' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.provider_organization_id IS NULL
     AND (v_worker.stripe_connect_id IS NULL OR NOT v_worker.payouts_enabled)
     AND NOT v_local_test_payout THEN
    RAISE EXCEPTION 'HXWE6: worker payout account is not ready' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.provider_organization_id IS NOT NULL AND NOT v_business_payout_ready THEN
    RAISE EXCEPTION 'HXWE6: Service Business payout account is not ready' USING ERRCODE = 'P0001';
  END IF;
  IF v_worker.profile_trust_tier IS DISTINCT FROM v_worker.worker_trust_tier THEN
    RAISE EXCEPTION 'HXWE7: worker capability profile is stale' USING ERRCODE = 'P0001';
  END IF;
  IF v_worker.worker_trust_tier < 1
     OR NOT v_worker.is_verified
     OR NULLIF(BTRIM(v_worker.phone), '') IS NULL THEN
    RAISE EXCEPTION 'HXWE15: Tier 0 is browse-only; verified identity and phone are required' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.risk_level = 'IN_HOME' OR NOT (lower(NEW.risk_level) = ANY(v_worker.risk_clearance)) THEN
    RAISE EXCEPTION 'HXWE8: worker lacks task risk clearance' USING ERRCODE = 'P0001';
  END IF;
  IF v_worker.worker_trust_tier < COALESCE(NEW.trust_tier_required, 1) THEN
    RAISE EXCEPTION 'HXWE9: worker trust tier is insufficient' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.price > (CASE
      WHEN v_worker.worker_trust_tier = 1 THEN 5000
      WHEN v_worker.worker_trust_tier = 2 THEN 20000
      ELSE 9999900
    END) THEN
    RAISE EXCEPTION 'HXWE10: task value exceeds worker trust authority' USING ERRCODE = 'P0001';
  END IF;

  IF NEW.background_check_required THEN
    IF v_worker.background_check_valid IS NOT TRUE
       OR v_worker.background_check_source_id IS NULL
       OR (v_worker.background_check_expires_at IS NOT NULL
           AND v_worker.background_check_expires_at <= clock_timestamp()) THEN
      RAISE EXCEPTION 'HXWE17: task requires a current derived screening capability' USING ERRCODE = 'P0001';
    END IF;
    IF v_worker.background_check_is_test IS TRUE THEN
      IF NOT v_local_test_screening
         OR v_worker.background_check_provider <> 'local_certification_test'
         OR v_worker.background_check_environment <> 'CONTROLLED_TEST'
         OR NOT EXISTS (
           SELECT 1
           FROM background_checks background
           JOIN hxos_local_test_screening_reports report
             ON report.background_check_id = background.id
           WHERE background.id = v_worker.background_check_source_id
             AND background.user_id = NEW.worker_id
             AND background.status = 'CLEAR'
             AND background.is_test IS TRUE
             AND report.status = 'CLEAR'
             AND report.is_test IS TRUE
         ) THEN
        RAISE EXCEPTION 'HXWE16: TEST screening cannot authorize production work' USING ERRCODE = 'P0001';
      END IF;
    ELSIF v_worker.background_check_environment <> 'PRODUCTION'
          OR NOT EXISTS (
            SELECT 1 FROM background_checks background
            WHERE background.id = v_worker.background_check_source_id
              AND background.user_id = NEW.worker_id
              AND background.status = 'CLEAR'
              AND background.provider_environment = 'PRODUCTION'
              AND background.is_test IS FALSE
              AND (background.expires_at IS NULL OR background.expires_at > clock_timestamp())
          ) THEN
      RAISE EXCEPTION 'HXWE18: production screening provenance is invalid' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF NEW.risk_level = 'HIGH'
     AND v_worker.plan <> 'pro'
     AND NOT EXISTS (
       SELECT 1 FROM plan_entitlements entitlement
       WHERE entitlement.user_id = NEW.worker_id
         AND (entitlement.task_id IS NULL OR entitlement.task_id = NEW.id)
         AND entitlement.risk_level = 'HIGH'
         AND entitlement.expires_at > clock_timestamp()
     ) THEN
    RAISE EXCEPTION 'HXWE11: high-risk work requires Pro or an active entitlement' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM escrows escrow
    WHERE escrow.task_id = NEW.id AND escrow.state = 'FUNDED'
  ) THEN
    RAISE EXCEPTION 'HXWE12: task is not funded' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM disputes dispute
    WHERE dispute.worker_id = NEW.worker_id
      AND dispute.state IN ('OPEN', 'EVIDENCE_REQUESTED', 'ESCALATED')
  ) THEN
    RAISE EXCEPTION 'HXWE13: worker has an active dispute' USING ERRCODE = 'P0001';
  END IF;

  SELECT COUNT(*) INTO v_active_tasks
  FROM tasks active_task
  WHERE active_task.worker_id = NEW.worker_id
    AND active_task.id <> NEW.id
    AND active_task.state IN ('ACCEPTED', 'PROOF_SUBMITTED', 'DISPUTED');
  IF v_active_tasks >= 5 THEN
    RAISE EXCEPTION 'HXWE14: worker active-task capacity is exhausted' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION enforce_task_worker_eligibility_on_accept() IS
  'HX/OS acceptance backstop: actual fulfiller eligibility remains worker-bound; individual payout is worker-bound while Service Business payout is verified against immutable organization payee evidence.';

CREATE OR REPLACE FUNCTION enforce_active_business_service_payout()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status='ACTIVE' AND NOT EXISTS(
    SELECT 1 FROM business_provider_payout_accounts payout
    JOIN users payee ON payee.id=payout.payout_recipient_user_id
    WHERE payout.organization_id=NEW.organization_id AND payout.status='ACTIVE'
      AND payee.account_status='ACTIVE' AND payee.stripe_connect_id IS NOT NULL
      AND payee.payouts_enabled IS TRUE
  ) THEN
    RAISE EXCEPTION 'HXSB12: active service requires current provider-backed payout evidence'
      USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END $$;

-- Repair provider readiness that previously trusted a mutable status flag.
UPDATE business_service_profiles profile SET status='PAUSED',updated_at=NOW()
 WHERE profile.status='ACTIVE' AND NOT EXISTS(
  SELECT 1 FROM business_provider_payout_accounts payout
   WHERE payout.organization_id=profile.organization_id AND payout.status='ACTIVE'
 );
UPDATE business_organizations organization SET payout_status='RESTRICTED',updated_at=NOW()
 WHERE organization.provider_enabled IS TRUE AND organization.payout_status='ACTIVE'
   AND NOT EXISTS(
    SELECT 1 FROM business_provider_payout_accounts payout
     WHERE payout.organization_id=organization.id AND payout.status='ACTIVE'
   );

DROP TRIGGER IF EXISTS business_service_active_payout_gate ON business_service_profiles;
CREATE TRIGGER business_service_active_payout_gate
BEFORE INSERT OR UPDATE OF status ON business_service_profiles
FOR EACH ROW EXECUTE FUNCTION enforce_active_business_service_payout();

-- Extend the current complete-offer acceptance gate without weakening the
-- individual Hustler branch. Business acceptance must match its immutable
-- assignment and attributable provider review.
CREATE OR REPLACE FUNCTION enforce_worker_offer_decision_on_accept()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_offer worker_offer_decisions%ROWTYPE;
  v_cell zone_category_cells%ROWTYPE;
  v_assignment business_service_task_assignments%ROWTYPE;
BEGIN
  IF NEW.state<>'ACCEPTED' THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND OLD.state IN ('ACCEPTED','PROOF_SUBMITTED')
     AND OLD.worker_id IS NOT NULL AND OLD.worker_id IS NOT DISTINCT FROM NEW.worker_id THEN
    RETURN NEW;
  END IF;
  IF NEW.worker_id IS NULL THEN
    RAISE EXCEPTION 'HXWO1: accepted task requires a worker' USING ERRCODE='P0001';
  END IF;
  SELECT * INTO v_cell FROM zone_category_cells WHERE id=NEW.liquidity_cell_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'HXWO4: worker offer lacks current provider economics' USING ERRCODE='P0001'; END IF;
  IF NEW.provider_organization_id IS NULL THEN
    SELECT * INTO v_offer FROM worker_offer_decisions
     WHERE task_id=NEW.id AND worker_id=NEW.worker_id
       AND provider_organization_id IS NULL
       AND policy_version='hxos-worker-offer-v3' AND decision_ready=TRUE AND expires_at>NOW()
     ORDER BY created_at DESC LIMIT 1;
  ELSE
    SELECT * INTO v_assignment FROM business_service_task_assignments
     WHERE id=NEW.provider_assignment_id AND task_id=NEW.id FOR SHARE;
    SELECT * INTO v_offer FROM worker_offer_decisions
     WHERE id=v_assignment.offer_decision_id AND task_id=NEW.id AND worker_id=NEW.worker_id
       AND provider_organization_id=NEW.provider_organization_id
       AND provider_service_profile_id=NEW.provider_service_profile_id
       AND provider_crew_assignment_id=v_assignment.crew_assignment_id
       AND reviewed_by=v_assignment.accepted_by
       AND policy_version='hxos-worker-offer-v3' AND decision_ready=TRUE AND expires_at>NOW();
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'HXWO2: no current accept-ready worker offer decision' USING ERRCODE='P0001'; END IF;
  IF v_offer.customer_total_cents<>NEW.price
     OR v_offer.payout_cents IS DISTINCT FROM NEW.hustler_payout_cents
     OR v_offer.scope_hash IS DISTINCT FROM NEW.scope_hash
     OR v_offer.cancellation_policy_version IS DISTINCT FROM NEW.cancellation_policy_version
     OR v_offer.estimated_duration_minutes IS DISTINCT FROM NEW.estimated_duration_minutes THEN
    RAISE EXCEPTION 'HXWO3: worker offer no longer matches task economics or scope' USING ERRCODE='P0001';
  END IF;
  IF v_offer.insurance_adjustment_cents<>ROUND(NEW.price*0.02)
     OR v_offer.net_payout_cents<>NEW.hustler_payout_cents-ROUND(NEW.price*0.02)
     OR v_offer.estimated_travel_time_minutes IS NULL OR v_offer.estimated_travel_time_minutes<=0
     OR NULLIF(BTRIM(v_offer.travel_time_policy_version),'') IS NULL
     OR v_offer.minimum_net_hourly_cents IS DISTINCT FROM v_cell.minimum_provider_net_hourly_cents
     OR v_offer.provider_earnings_policy_version IS DISTINCT FROM v_cell.provider_earnings_policy_version
     OR v_offer.provider_earnings_floor_met IS NOT TRUE
     OR v_offer.estimated_net_hourly_cents<v_offer.minimum_net_hourly_cents THEN
    RAISE EXCEPTION 'HXWO4: worker offer lacks current provider economics' USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END $$;

-- Business dispatchers may open the same public, task-bound clarification
-- channel only when a current provider offer proves eligibility.
CREATE OR REPLACE FUNCTION enforce_public_question_lifecycle()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_task tasks%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'HXCL1: public clarification records cannot be deleted' USING ERRCODE='P0001'; END IF;
  SELECT * INTO v_task FROM tasks WHERE id=NEW.task_id;
  IF TG_OP='INSERT' THEN
    IF NOT FOUND OR NEW.asked_by IS NOT DISTINCT FROM v_task.poster_id OR NEW.status<>'OPEN'
       OR NOT (
         EXISTS(
           SELECT 1 FROM worker_offer_decisions d
            WHERE d.task_id=NEW.task_id AND d.worker_id=NEW.asked_by
              AND d.provider_organization_id IS NULL AND d.decision_ready=TRUE AND d.expires_at>NOW()
              AND d.customer_total_cents=v_task.price
              AND d.payout_cents IS NOT DISTINCT FROM v_task.hustler_payout_cents
              AND d.scope_hash IS NOT DISTINCT FROM v_task.scope_hash
         ) OR EXISTS(
           SELECT 1 FROM worker_offer_decisions d
            WHERE d.task_id=NEW.task_id AND d.provider_organization_id IS NOT NULL
              AND d.decision_ready=TRUE AND d.expires_at>NOW()
              AND d.customer_total_cents=v_task.price
              AND d.payout_cents IS NOT DISTINCT FROM v_task.hustler_payout_cents
              AND d.scope_hash IS NOT DISTINCT FROM v_task.scope_hash
              AND business_membership_has_action(d.provider_organization_id,NEW.asked_by,'ASSIGN_CREW')
         )
       ) THEN
      RAISE EXCEPTION 'HXCL4: only a currently eligible candidate can open a public question' USING ERRCODE='P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.task_id IS DISTINCT FROM OLD.task_id OR NEW.asked_by IS DISTINCT FROM OLD.asked_by
     OR NEW.question_text IS DISTINCT FROM OLD.question_text OR NEW.question_hash IS DISTINCT FROM OLD.question_hash
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'HXCL2: public clarification identity and content are immutable' USING ERRCODE='P0001';
  END IF;
  IF OLD.status<>'OPEN' AND ROW(NEW.answer_text,NEW.answer_hash,NEW.status,NEW.material_change,
    NEW.answered_by,NEW.answered_at) IS DISTINCT FROM ROW(OLD.answer_text,OLD.answer_hash,OLD.status,
    OLD.material_change,OLD.answered_by,OLD.answered_at) THEN
    RAISE EXCEPTION 'HXCL3: public clarification answer is immutable after publication' USING ERRCODE='P0001';
  END IF;
  IF OLD.status='OPEN' AND NEW.status='ANSWERED' AND NEW.answered_by IS DISTINCT FROM v_task.poster_id THEN
    RAISE EXCEPTION 'HXCL4: only the task Poster can publish a clarification answer' USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION enforce_worker_counter_offer_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.task_id IS DISTINCT FROM NEW.task_id OR OLD.worker_id IS DISTINCT FROM NEW.worker_id
     OR OLD.offer_decision_id IS DISTINCT FROM NEW.offer_decision_id
     OR OLD.source_scope_version_id IS DISTINCT FROM NEW.source_scope_version_id
     OR OLD.proposed_scope_hash IS DISTINCT FROM NEW.proposed_scope_hash
     OR OLD.policy_version IS DISTINCT FROM NEW.policy_version OR OLD.request_hash IS DISTINCT FROM NEW.request_hash
     OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key
     OR OLD.current_customer_total_cents IS DISTINCT FROM NEW.current_customer_total_cents
     OR OLD.current_payout_cents IS DISTINCT FROM NEW.current_payout_cents
     OR OLD.platform_margin_cents IS DISTINCT FROM NEW.platform_margin_cents
     OR OLD.minimum_counter_payout_cents IS DISTINCT FROM NEW.minimum_counter_payout_cents
     OR OLD.maximum_counter_payout_cents IS DISTINCT FROM NEW.maximum_counter_payout_cents
     OR OLD.customer_maximum_cents IS DISTINCT FROM NEW.customer_maximum_cents
     OR OLD.margin_floor_bps IS DISTINCT FROM NEW.margin_floor_bps
     OR OLD.proposed_payout_cents IS DISTINCT FROM NEW.proposed_payout_cents
     OR OLD.proposed_customer_total_cents IS DISTINCT FROM NEW.proposed_customer_total_cents
     OR OLD.reason IS DISTINCT FROM NEW.reason OR OLD.expires_at IS DISTINCT FROM NEW.expires_at
     OR OLD.created_at IS DISTINCT FROM NEW.created_at
     OR OLD.provider_organization_id IS DISTINCT FROM NEW.provider_organization_id
     OR OLD.provider_service_profile_id IS DISTINCT FROM NEW.provider_service_profile_id
     OR OLD.provider_crew_assignment_id IS DISTINCT FROM NEW.provider_crew_assignment_id
     OR OLD.requested_by IS DISTINCT FROM NEW.requested_by THEN
    RAISE EXCEPTION 'HXCO1: worker counter proposal is immutable' USING ERRCODE='P0001';
  END IF;
  IF NOT ((OLD.status='PENDING_POSTER' AND NEW.status IN ('REJECTED','APPROVED_REAUTH_REQUIRED','EXPIRED'))
    OR (OLD.status='APPROVED_REAUTH_REQUIRED' AND NEW.status='MATERIALIZED')) THEN
    RAISE EXCEPTION 'HXCO2: invalid worker counter transition % -> %',OLD.status,NEW.status USING ERRCODE='P0001';
  END IF;
  NEW.updated_at:=NOW(); RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.link_business_provider_payout_account(UUID,UUID,UUID,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.evaluate_service_business_assignment(UUID,UUID,UUID,UUID,UUID,UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_business_service_offer_response(UUID,UUID,UUID,TEXT,TEXT,TEXT,JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commit_service_business_task_assignment(UUID,UUID,UUID,UUID,UUID,UUID,TEXT,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.restrict_business_payout_on_provider_change() FROM PUBLIC;

COMMIT;
