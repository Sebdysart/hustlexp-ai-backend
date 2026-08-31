-- Exact authority-bearing object definitions reconstructed from the twelve
-- retired Stage-1 SQL blobs at public-main d42975be9691c6dbe99f7580fac1b0d8258a3f7a.
-- Transaction wrappers and explanatory comments are omitted so this fixture
-- can install the same objects as one isolated proof-database transaction.

ALTER TABLE feature_flags ADD COLUMN IF NOT EXISTS key TEXT;
UPDATE feature_flags SET key = name WHERE key IS NULL;
ALTER TABLE feature_flags ALTER COLUMN key SET NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feature_flags_key_unique') THEN
    ALTER TABLE feature_flags ADD CONSTRAINT feature_flags_key_unique UNIQUE (key);
  END IF;
END $$;
CREATE OR REPLACE FUNCTION sync_feature_flags_key_from_name()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.key IS NULL OR BTRIM(NEW.key) = '' THEN NEW.key := NEW.name; END IF;
  IF NEW.name IS NULL OR BTRIM(NEW.name) = '' THEN NEW.name := NEW.key; END IF;
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_feature_flags_sync_key ON feature_flags;
CREATE TRIGGER trg_feature_flags_sync_key
BEFORE INSERT OR UPDATE ON feature_flags
FOR EACH ROW EXECUTE FUNCTION sync_feature_flags_key_from_name();
CREATE TABLE IF NOT EXISTS ops_action_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id UUID,
  actor_label TEXT NOT NULL DEFAULT 'ops',
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ops_action_audit_created ON ops_action_audit(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ops_action_audit_action ON ops_action_audit(action, created_at DESC);

CREATE TABLE IF NOT EXISTS public.ops_business_claim_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_draft_id UUID NOT NULL REFERENCES public.task_drafts(id) ON DELETE RESTRICT,
  token_hash TEXT NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLAIMED','EXPIRED','REVOKED')),
  created_by UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  claimed_by_business_user_id UUID NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  claimed_at TIMESTAMPTZ NULL,
  revoked_at TIMESTAMPTZ NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ops_business_claim_links_token_hash_uq
  ON public.ops_business_claim_links(token_hash);
CREATE UNIQUE INDEX IF NOT EXISTS ops_business_claim_links_one_open_per_draft_uq
  ON public.ops_business_claim_links(task_draft_id) WHERE status = 'OPEN';
CREATE INDEX IF NOT EXISTS ops_business_claim_links_draft_idx
  ON public.ops_business_claim_links(task_draft_id);
CREATE INDEX IF NOT EXISTS ops_business_claim_links_expires_idx
  ON public.ops_business_claim_links(status, expires_at);

ALTER TABLE public.ops_business_claim_links
  ADD COLUMN IF NOT EXISTS claimed_by_organization_id UUID
  REFERENCES public.business_organizations(id) ON DELETE RESTRICT;
ALTER TABLE public.ops_business_claim_links
  ADD COLUMN IF NOT EXISTS claimed_by_service_profile_id UUID
  REFERENCES public.business_service_profiles(id) ON DELETE RESTRICT;
ALTER TABLE public.ops_business_claim_links
  ADD COLUMN IF NOT EXISTS claimed_by_business_location_id UUID
  REFERENCES public.business_locations(id) ON DELETE RESTRICT;
ALTER TABLE public.ops_business_claim_links ADD COLUMN IF NOT EXISTS proposed_customer_total_cents INTEGER;
ALTER TABLE public.ops_business_claim_links ADD COLUMN IF NOT EXISTS proposed_payout_cents INTEGER;

ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS business_organization_id UUID
  REFERENCES public.business_organizations(id) ON DELETE RESTRICT;
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS business_location_id UUID
  REFERENCES public.business_locations(id) ON DELETE RESTRICT;
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS provider_service_profile_id UUID
  REFERENCES public.business_service_profiles(id) ON DELETE RESTRICT;
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS claimed_by_user_id UUID
  REFERENCES public.users(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS quotes_business_org_idx ON public.quotes(business_organization_id)
  WHERE business_organization_id IS NOT NULL;

ALTER TABLE public.tasks ADD COLUMN IF NOT EXISTS business_fulfiller_organization_id UUID
  REFERENCES public.business_organizations(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS tasks_business_fulfiller_org_idx
  ON public.tasks(business_fulfiller_organization_id, created_at DESC)
  WHERE business_fulfiller_organization_id IS NOT NULL;
ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS tasks_fulfiller_entity_check;
ALTER TABLE public.tasks ADD CONSTRAINT tasks_fulfiller_entity_check CHECK (
  NOT (worker_id IS NOT NULL AND business_fulfiller_organization_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS public.hxos_local_test_business_payout_destinations (
  id TEXT PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.business_organizations(id) ON DELETE RESTRICT,
  payout_recipient_user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  destination_fingerprint TEXT NOT NULL CHECK (destination_fingerprint ~ '^[a-f0-9]{64}$'),
  provider_mode TEXT NOT NULL DEFAULT 'local_certification_test'
    CHECK (provider_mode = 'local_certification_test'),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status = 'ACTIVE'),
  is_test BOOLEAN NOT NULL DEFAULT TRUE CHECK (is_test IS TRUE),
  activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id)
);
CREATE TABLE IF NOT EXISTS public.hxos_local_test_business_payout_transfers (
  id TEXT PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES public.tasks(id) ON DELETE RESTRICT,
  escrow_id UUID NOT NULL REFERENCES public.escrows(id) ON DELETE RESTRICT,
  organization_id UUID NOT NULL REFERENCES public.business_organizations(id) ON DELETE RESTRICT,
  payout_recipient_user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  destination_id TEXT NOT NULL
    REFERENCES public.hxos_local_test_business_payout_destinations(id) ON DELETE RESTRICT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL DEFAULT 'usd' CHECK (currency = 'usd'),
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','processing','paid')),
  provider_mode TEXT NOT NULL DEFAULT 'local_certification_test'
    CHECK (provider_mode = 'local_certification_test'),
  is_test BOOLEAN NOT NULL DEFAULT TRUE CHECK (is_test IS TRUE),
  idempotency_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processing_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (task_id),
  UNIQUE (escrow_id),
  CHECK (
    (status = 'submitted' AND processing_at IS NULL AND paid_at IS NULL)
    OR (status = 'processing' AND processing_at IS NOT NULL AND paid_at IS NULL)
    OR (status = 'paid' AND processing_at IS NOT NULL AND paid_at IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS hxos_local_test_business_payout_org_idx
  ON public.hxos_local_test_business_payout_destinations(organization_id);

CREATE OR REPLACE FUNCTION enforce_controlled_test_business_acceptance()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state = 'ACCEPTED' AND NEW.automation_classification = 'CONTROLLED_TEST' THEN
    IF NEW.business_fulfiller_organization_id IS NULL OR NEW.worker_id IS NOT NULL THEN RETURN NEW; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM business_organizations organization
      WHERE organization.id = NEW.business_fulfiller_organization_id
        AND organization.status = 'ACTIVE' AND organization.provider_enabled = TRUE
    ) THEN RAISE EXCEPTION 'HXBC1: Business fulfiller is not active or provider-enabled' USING ERRCODE='P0001'; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM escrows escrow WHERE escrow.task_id = NEW.id AND escrow.state = 'FUNDED'
    ) THEN RAISE EXCEPTION 'HXBC2: Business task is not funded' USING ERRCODE='P0001'; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM hxos_local_test_business_payout_destinations destination
      WHERE destination.organization_id = NEW.business_fulfiller_organization_id
        AND destination.status = 'ACTIVE' AND destination.is_test IS TRUE
    ) THEN RAISE EXCEPTION 'HXBC3: Business TEST payout destination is not active' USING ERRCODE='P0001'; END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS task_region_policy_accept_insert_gate ON public.tasks;
DROP TRIGGER IF EXISTS task_region_policy_accept_gate ON public.tasks;
CREATE TRIGGER task_region_policy_accept_insert_gate BEFORE INSERT ON public.tasks
FOR EACH ROW WHEN (
  NEW.state='ACCEPTED' AND (NEW.business_fulfiller_organization_id IS NULL OR NEW.worker_id IS NOT NULL)
) EXECUTE FUNCTION public.enforce_task_region_policy_on_accept();
CREATE TRIGGER task_region_policy_accept_gate
BEFORE UPDATE OF state,worker_id,business_fulfiller_organization_id ON public.tasks
FOR EACH ROW WHEN (
  NEW.state='ACCEPTED'
  AND (NEW.business_fulfiller_organization_id IS NULL OR NEW.worker_id IS NOT NULL)
  AND NOT hxos_same_worker_proof_retake_continuation(OLD.state::TEXT,NEW.state::TEXT,OLD.worker_id,NEW.worker_id)
) EXECUTE FUNCTION public.enforce_task_region_policy_on_accept();

DROP TRIGGER IF EXISTS task_worker_eligibility_accept_insert_gate ON public.tasks;
DROP TRIGGER IF EXISTS task_worker_eligibility_accept_gate ON public.tasks;
CREATE TRIGGER task_worker_eligibility_accept_insert_gate BEFORE INSERT ON public.tasks
FOR EACH ROW WHEN (
  NEW.state='ACCEPTED' AND (NEW.business_fulfiller_organization_id IS NULL OR NEW.worker_id IS NOT NULL)
) EXECUTE FUNCTION public.enforce_task_worker_eligibility_on_accept();
CREATE TRIGGER task_worker_eligibility_accept_gate
BEFORE UPDATE OF state,worker_id,business_fulfiller_organization_id ON public.tasks
FOR EACH ROW WHEN (
  NEW.state='ACCEPTED'
  AND (NEW.business_fulfiller_organization_id IS NULL OR NEW.worker_id IS NOT NULL)
  AND NOT hxos_same_worker_proof_retake_continuation(OLD.state::TEXT,NEW.state::TEXT,OLD.worker_id,NEW.worker_id)
) EXECUTE FUNCTION public.enforce_task_worker_eligibility_on_accept();

DROP TRIGGER IF EXISTS controlled_test_provider_capability_accept_guard ON public.tasks;
CREATE TRIGGER controlled_test_provider_capability_accept_guard
BEFORE INSERT OR UPDATE OF state,worker_id,business_fulfiller_organization_id ON public.tasks
FOR EACH ROW WHEN (
  NEW.state='ACCEPTED' AND NEW.automation_classification='CONTROLLED_TEST'
  AND (NEW.business_fulfiller_organization_id IS NULL OR NEW.worker_id IS NOT NULL)
) EXECUTE FUNCTION public.enforce_controlled_test_provider_capability_on_accept();
DROP TRIGGER IF EXISTS controlled_test_offer_accept_guard ON public.tasks;
CREATE TRIGGER controlled_test_offer_accept_guard
BEFORE INSERT OR UPDATE OF state,worker_id,business_fulfiller_organization_id ON public.tasks
FOR EACH ROW WHEN (
  NEW.state='ACCEPTED' AND NEW.automation_classification='CONTROLLED_TEST'
  AND (NEW.business_fulfiller_organization_id IS NULL OR NEW.worker_id IS NOT NULL)
) EXECUTE FUNCTION public.enforce_controlled_test_offer_acceptance();
DROP TRIGGER IF EXISTS controlled_test_business_acceptance_guard ON public.tasks;
CREATE TRIGGER controlled_test_business_acceptance_guard
BEFORE INSERT OR UPDATE OF state,worker_id,business_fulfiller_organization_id ON public.tasks
FOR EACH ROW EXECUTE FUNCTION public.enforce_controlled_test_business_acceptance();

ALTER TABLE public.tasks ADD COLUMN IF NOT EXISTS orchestration_mode TEXT NOT NULL DEFAULT 'AUTOMATED';
ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS tasks_orchestration_mode_check;
ALTER TABLE public.tasks ADD CONSTRAINT tasks_orchestration_mode_check
  CHECK (orchestration_mode IN ('AUTOMATED','OPS_MANUAL'));
CREATE INDEX IF NOT EXISTS tasks_manual_business_idx
  ON public.tasks(business_fulfiller_organization_id,created_at DESC)
  WHERE orchestration_mode='OPS_MANUAL';

DROP TRIGGER IF EXISTS task_liquidity_cell_accept_gate ON public.tasks;
CREATE TRIGGER task_liquidity_cell_accept_gate
BEFORE INSERT OR UPDATE OF state,worker_id,liquidity_cell_id,orchestration_mode ON public.tasks
FOR EACH ROW WHEN (NEW.orchestration_mode <> 'OPS_MANUAL')
EXECUTE FUNCTION public.enforce_task_liquidity_cell_on_accept();
DROP TRIGGER IF EXISTS task_worker_offer_accept_gate ON public.tasks;
CREATE TRIGGER task_worker_offer_accept_gate
BEFORE INSERT OR UPDATE OF state,worker_id,orchestration_mode ON public.tasks
FOR EACH ROW WHEN (NEW.orchestration_mode <> 'OPS_MANUAL')
EXECUTE FUNCTION public.enforce_worker_offer_decision_on_accept();

CREATE OR REPLACE FUNCTION enforce_escrow_payout_provider_evidence()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE
  task_row RECORD;
  has_worker_evidence BOOLEAN := FALSE;
  has_business_evidence BOOLEAN := FALSE;
BEGIN
  IF NEW.state <> 'RELEASED' OR OLD.state = 'RELEASED' THEN RETURN NEW; END IF;
  SELECT worker_id,business_fulfiller_organization_id,orchestration_mode,automation_classification
    INTO task_row FROM tasks WHERE id=NEW.task_id;
  IF NEW.payout_provider='LOCAL_CERTIFICATION_TEST' THEN
    IF task_row.worker_id IS NOT NULL THEN
      SELECT EXISTS (
        SELECT 1 FROM hxos_local_test_payout_transfers transfer
        WHERE transfer.id=NEW.provider_transfer_id AND transfer.task_id=NEW.task_id
          AND transfer.escrow_id=NEW.id AND transfer.worker_id=task_row.worker_id
          AND transfer.status='paid' AND transfer.paid_at IS NOT NULL AND transfer.is_test IS TRUE
      ) INTO has_worker_evidence;
    END IF;
    IF task_row.orchestration_mode='OPS_MANUAL'
       AND task_row.business_fulfiller_organization_id IS NOT NULL
       AND task_row.worker_id IS NULL THEN
      SELECT EXISTS (
        SELECT 1 FROM hxos_local_test_business_payout_transfers transfer
        JOIN hxos_local_test_business_payout_destinations destination ON destination.id=transfer.destination_id
        WHERE transfer.id=NEW.provider_transfer_id AND transfer.task_id=NEW.task_id
          AND transfer.escrow_id=NEW.id
          AND transfer.organization_id=task_row.business_fulfiller_organization_id
          AND transfer.status='paid' AND transfer.paid_at IS NOT NULL AND transfer.is_test IS TRUE
          AND destination.organization_id=transfer.organization_id
          AND destination.payout_recipient_user_id=transfer.payout_recipient_user_id
          AND destination.status='ACTIVE' AND destination.is_test IS TRUE
      ) INTO has_business_evidence;
    END IF;
    IF task_row.automation_classification <> 'CONTROLLED_TEST'
       OR NEW.stripe_transfer_id IS NOT NULL OR NEW.provider_transfer_status <> 'paid'
       OR NEW.provider_transfer_paid_at IS NULL OR NOT (has_worker_evidence OR has_business_evidence) THEN
      RAISE EXCEPTION 'HXLPO8: local TEST escrow release lacks exact paid provider evidence';
    END IF;
  ELSIF NEW.payout_provider='STRIPE' THEN
    IF NEW.stripe_transfer_id IS NULL OR NEW.provider_transfer_id IS DISTINCT FROM NEW.stripe_transfer_id
       OR NEW.provider_transfer_status NOT IN ('submitted','processing','paid') THEN
      RAISE EXCEPTION 'HXLPO9: Stripe escrow release lacks provider transfer identity';
    END IF;
  ELSIF NEW.payout_provider='MANUAL_RECONCILIATION' THEN
    IF NEW.provider_transfer_status <> 'manual_reconciliation' OR NEW.provider_transfer_paid_at IS NOT NULL THEN
      RAISE EXCEPTION 'HXLPO10: manual release must remain visibly unreconciled';
    END IF;
  ELSE
    RAISE EXCEPTION 'HXLPO11: released escrow requires an explicit payout provider';
  END IF;
  RETURN NEW;
END;
$$;
