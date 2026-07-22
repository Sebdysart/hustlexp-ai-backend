-- Disabled-by-default payout rail for controlled local HX/OS certification.
-- This is an explicit TEST provider, never a Stripe or bank-payout substitute.
-- Production-classified tasks are rejected at every durable boundary.

CREATE TABLE IF NOT EXISTS hxos_local_test_payout_destinations (
  id TEXT PRIMARY KEY CHECK (id ~ '^pd_hxos_test_[a-f0-9]{32}$'),
  worker_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
  destination_fingerprint TEXT NOT NULL CHECK (destination_fingerprint ~ '^[a-f0-9]{64}$'),
  provider_mode TEXT NOT NULL DEFAULT 'local_certification_test'
    CHECK (provider_mode = 'local_certification_test'),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status = 'ACTIVE'),
  is_test BOOLEAN NOT NULL DEFAULT TRUE CHECK (is_test IS TRUE),
  activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS hxos_local_test_payout_destination_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  destination_id TEXT NOT NULL
    REFERENCES hxos_local_test_payout_destinations(id) ON DELETE RESTRICT,
  worker_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type = 'destination_activated'),
  actor_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL UNIQUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_test BOOLEAN NOT NULL DEFAULT TRUE CHECK (is_test IS TRUE),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS hxos_local_test_payout_transfers (
  id TEXT PRIMARY KEY CHECK (id ~ '^tr_hxos_test_[a-f0-9]{32}$'),
  task_id UUID NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE RESTRICT,
  escrow_id UUID NOT NULL UNIQUE REFERENCES escrows(id) ON DELETE RESTRICT,
  worker_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  destination_id TEXT NOT NULL
    REFERENCES hxos_local_test_payout_destinations(id) ON DELETE RESTRICT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL DEFAULT 'usd' CHECK (currency = 'usd'),
  status TEXT NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted', 'processing', 'paid')),
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
  CHECK (
    (status = 'submitted' AND processing_at IS NULL AND paid_at IS NULL)
    OR (status = 'processing' AND processing_at IS NOT NULL AND paid_at IS NULL)
    OR (status = 'paid' AND processing_at IS NOT NULL AND paid_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS hxos_local_test_payout_transfer_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id TEXT NOT NULL
    REFERENCES hxos_local_test_payout_transfers(id) ON DELETE RESTRICT,
  from_status TEXT,
  to_status TEXT NOT NULL CHECK (to_status IN ('submitted', 'processing', 'paid')),
  event_type TEXT NOT NULL
    CHECK (event_type IN ('transfer_submitted', 'transfer_processing', 'transfer_paid')),
  idempotency_key TEXT NOT NULL UNIQUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_test BOOLEAN NOT NULL DEFAULT TRUE CHECK (is_test IS TRUE),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE escrows
  ADD COLUMN IF NOT EXISTS payout_provider TEXT,
  ADD COLUMN IF NOT EXISTS provider_transfer_id TEXT,
  ADD COLUMN IF NOT EXISTS provider_transfer_status TEXT,
  ADD COLUMN IF NOT EXISTS provider_transfer_paid_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'escrows_payout_provider_ck'
  ) THEN
    ALTER TABLE escrows ADD CONSTRAINT escrows_payout_provider_ck CHECK (
      payout_provider IS NULL
      OR payout_provider IN ('STRIPE', 'LOCAL_CERTIFICATION_TEST', 'MANUAL_RECONCILIATION')
    );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'escrows_provider_transfer_status_ck'
  ) THEN
    ALTER TABLE escrows ADD CONSTRAINT escrows_provider_transfer_status_ck CHECK (
      provider_transfer_status IS NULL
      OR provider_transfer_status IN ('submitted', 'processing', 'paid', 'manual_reconciliation')
    );
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION guard_hxos_local_test_payout_destination()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  worker_row RECORD;
BEGIN
  SELECT default_mode, account_status, is_minor, is_banned
    INTO worker_row
  FROM users
  WHERE id = NEW.worker_id;

  IF worker_row.default_mode <> 'worker'
     OR worker_row.account_status <> 'ACTIVE'
     OR worker_row.is_minor
     OR worker_row.is_banned
     OR NOT EXISTS (
       SELECT 1 FROM engine_hustler_identity_links link
       WHERE link.user_id = NEW.worker_id
     ) THEN
    RAISE EXCEPTION 'HXLPO1: local TEST payout destination requires an active adult linked worker';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS hxos_local_test_payout_destination_gate
  ON hxos_local_test_payout_destinations;
CREATE TRIGGER hxos_local_test_payout_destination_gate
BEFORE INSERT ON hxos_local_test_payout_destinations
FOR EACH ROW EXECUTE FUNCTION guard_hxos_local_test_payout_destination();

CREATE OR REPLACE FUNCTION guard_hxos_local_test_payout_transfer()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  task_row RECORD;
  escrow_row RECORD;
  destination_row RECORD;
  expected_amount INTEGER;
BEGIN
  SELECT worker_id, state, payout_ready_at, automation_classification,
         price, hustler_payout_cents, platform_margin_cents
    INTO task_row
  FROM tasks
  WHERE id = NEW.task_id;

  SELECT task_id, state, amount, platform_fee_cents
    INTO escrow_row
  FROM escrows
  WHERE id = NEW.escrow_id;

  SELECT worker_id, status, is_test
    INTO destination_row
  FROM hxos_local_test_payout_destinations
  WHERE id = NEW.destination_id;

  expected_amount := task_row.hustler_payout_cents
    - ROUND(task_row.price * 0.02)::INTEGER;

  IF task_row.automation_classification <> 'CONTROLLED_TEST'
     OR task_row.state <> 'COMPLETED'
     OR task_row.payout_ready_at IS NULL
     OR task_row.worker_id IS DISTINCT FROM NEW.worker_id
     OR task_row.hustler_payout_cents IS NULL
     OR task_row.platform_margin_cents IS NULL
     OR task_row.hustler_payout_cents + task_row.platform_margin_cents <> task_row.price
     OR escrow_row.task_id IS DISTINCT FROM NEW.task_id
     OR escrow_row.state <> 'FUNDED'
     OR escrow_row.amount <> task_row.price
     OR escrow_row.platform_fee_cents IS DISTINCT FROM task_row.platform_margin_cents
     OR destination_row.worker_id IS DISTINCT FROM NEW.worker_id
     OR destination_row.status <> 'ACTIVE'
     OR destination_row.is_test IS NOT TRUE
     OR NEW.amount_cents <> expected_amount
     OR NEW.is_test IS NOT TRUE THEN
    RAISE EXCEPTION 'HXLPO2: local TEST transfer requires exact completed CONTROLLED_TEST economics';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS hxos_local_test_payout_transfer_gate
  ON hxos_local_test_payout_transfers;
CREATE TRIGGER hxos_local_test_payout_transfer_gate
BEFORE INSERT ON hxos_local_test_payout_transfers
FOR EACH ROW EXECUTE FUNCTION guard_hxos_local_test_payout_transfer();

CREATE OR REPLACE FUNCTION guard_hxos_local_test_payout_transfer_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.id <> OLD.id
     OR NEW.task_id <> OLD.task_id
     OR NEW.escrow_id <> OLD.escrow_id
     OR NEW.worker_id <> OLD.worker_id
     OR NEW.destination_id <> OLD.destination_id
     OR NEW.amount_cents <> OLD.amount_cents
     OR NEW.currency <> OLD.currency
     OR NEW.provider_mode <> OLD.provider_mode
     OR NEW.is_test <> OLD.is_test
     OR NEW.idempotency_key <> OLD.idempotency_key
     OR NEW.request_hash <> OLD.request_hash
     OR NEW.submitted_at <> OLD.submitted_at
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'HXLPO3: local TEST transfer identity and economics are immutable';
  END IF;
  IF OLD.status = 'submitted' AND NEW.status NOT IN ('submitted', 'processing') THEN
    RAISE EXCEPTION 'HXLPO4: local TEST transfer must enter processing before paid';
  END IF;
  IF OLD.status = 'processing' AND NEW.status NOT IN ('processing', 'paid') THEN
    RAISE EXCEPTION 'HXLPO5: invalid local TEST payout transition';
  END IF;
  IF OLD.status = 'paid' AND NEW.status <> 'paid' THEN
    RAISE EXCEPTION 'HXLPO6: paid local TEST transfer is terminal';
  END IF;
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS hxos_local_test_payout_transfer_update_gate
  ON hxos_local_test_payout_transfers;
CREATE TRIGGER hxos_local_test_payout_transfer_update_gate
BEFORE UPDATE ON hxos_local_test_payout_transfers
FOR EACH ROW EXECUTE FUNCTION guard_hxos_local_test_payout_transfer_update();

CREATE OR REPLACE FUNCTION reject_hxos_local_test_payout_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'HXLPO7: local TEST payout evidence is append-only';
END;
$$;

DROP TRIGGER IF EXISTS hxos_local_test_destination_events_append_only
  ON hxos_local_test_payout_destination_events;
CREATE TRIGGER hxos_local_test_destination_events_append_only
BEFORE UPDATE OR DELETE OR TRUNCATE ON hxos_local_test_payout_destination_events
FOR EACH STATEMENT EXECUTE FUNCTION reject_hxos_local_test_payout_mutation();

DROP TRIGGER IF EXISTS hxos_local_test_transfer_events_append_only
  ON hxos_local_test_payout_transfer_events;
CREATE TRIGGER hxos_local_test_transfer_events_append_only
BEFORE UPDATE OR DELETE OR TRUNCATE ON hxos_local_test_payout_transfer_events
FOR EACH STATEMENT EXECUTE FUNCTION reject_hxos_local_test_payout_mutation();

CREATE OR REPLACE FUNCTION enforce_escrow_payout_provider_evidence()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  task_row RECORD;
BEGIN
  IF NEW.state <> 'RELEASED' OR OLD.state = 'RELEASED' THEN
    RETURN NEW;
  END IF;

  SELECT worker_id, automation_classification
    INTO task_row
  FROM tasks
  WHERE id = NEW.task_id;

  IF NEW.payout_provider = 'LOCAL_CERTIFICATION_TEST' THEN
    IF task_row.automation_classification <> 'CONTROLLED_TEST'
       OR NEW.stripe_transfer_id IS NOT NULL
       OR NEW.provider_transfer_status <> 'paid'
       OR NEW.provider_transfer_paid_at IS NULL
       OR NOT EXISTS (
         SELECT 1
         FROM hxos_local_test_payout_transfers transfer
         WHERE transfer.id = NEW.provider_transfer_id
           AND transfer.task_id = NEW.task_id
           AND transfer.escrow_id = NEW.id
           AND transfer.worker_id = task_row.worker_id
           AND transfer.status = 'paid'
           AND transfer.is_test IS TRUE
       ) THEN
      RAISE EXCEPTION 'HXLPO8: local TEST escrow release lacks exact paid provider evidence';
    END IF;
  ELSIF NEW.payout_provider = 'STRIPE' THEN
    IF NEW.stripe_transfer_id IS NULL
       OR NEW.provider_transfer_id IS DISTINCT FROM NEW.stripe_transfer_id
       OR NEW.provider_transfer_status NOT IN ('submitted', 'processing', 'paid') THEN
      RAISE EXCEPTION 'HXLPO9: Stripe escrow release lacks provider transfer identity';
    END IF;
  ELSIF NEW.payout_provider = 'MANUAL_RECONCILIATION' THEN
    IF NEW.provider_transfer_status <> 'manual_reconciliation'
       OR NEW.provider_transfer_paid_at IS NOT NULL THEN
      RAISE EXCEPTION 'HXLPO10: manual release must remain visibly unreconciled';
    END IF;
  ELSE
    RAISE EXCEPTION 'HXLPO11: released escrow requires an explicit payout provider';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS escrow_payout_provider_evidence_gate ON escrows;
CREATE TRIGGER escrow_payout_provider_evidence_gate
BEFORE UPDATE OF state, payout_provider, provider_transfer_id,
  provider_transfer_status, provider_transfer_paid_at ON escrows
FOR EACH ROW EXECUTE FUNCTION enforce_escrow_payout_provider_evidence();

-- Replace the acceptance trigger with the same production gates plus an
-- explicit transaction-local opt-in for a verified local TEST destination.
CREATE OR REPLACE FUNCTION enforce_task_worker_eligibility_on_accept()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_worker RECORD;
  v_active_tasks INTEGER;
  v_local_test_payout BOOLEAN;
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
    u.default_mode,
    u.account_status,
    u.is_minor,
    u.is_banned,
    u.trust_hold,
    u.trust_hold_until,
    u.trust_tier AS worker_trust_tier,
    u.plan,
    u.stripe_connect_id,
    u.payouts_enabled,
    cp.trust_tier AS profile_trust_tier,
    cp.risk_clearance
  INTO v_worker
  FROM users u
  JOIN capability_profiles cp ON cp.user_id = u.id
  WHERE u.id = NEW.worker_id;

  IF NOT FOUND OR v_worker.default_mode <> 'worker' THEN
    RAISE EXCEPTION 'HXWE3: eligible worker authority is missing' USING ERRCODE = 'P0001';
  END IF;

  v_local_test_payout := NEW.automation_classification = 'CONTROLLED_TEST'
    AND current_setting('hustlexp.local_test_payout_enabled', TRUE) = 'true'
    AND EXISTS (
      SELECT 1 FROM hxos_local_test_payout_destinations destination
      WHERE destination.worker_id = NEW.worker_id
        AND destination.status = 'ACTIVE'
        AND destination.is_test IS TRUE
    );

  IF v_worker.account_status <> 'ACTIVE' OR v_worker.is_minor OR v_worker.is_banned THEN
    RAISE EXCEPTION 'HXWE4: worker account is not active and eligible' USING ERRCODE = 'P0001';
  END IF;
  IF v_worker.trust_hold
     AND (v_worker.trust_hold_until IS NULL OR v_worker.trust_hold_until > clock_timestamp()) THEN
    RAISE EXCEPTION 'HXWE5: worker has an active trust hold' USING ERRCODE = 'P0001';
  END IF;
  IF (v_worker.stripe_connect_id IS NULL OR NOT v_worker.payouts_enabled)
     AND NOT v_local_test_payout THEN
    RAISE EXCEPTION 'HXWE6: worker payout account is not ready' USING ERRCODE = 'P0001';
  END IF;
  IF v_worker.profile_trust_tier IS DISTINCT FROM v_worker.worker_trust_tier THEN
    RAISE EXCEPTION 'HXWE7: worker capability profile is stale' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.risk_level = 'IN_HOME' OR NOT (lower(NEW.risk_level) = ANY(v_worker.risk_clearance)) THEN
    RAISE EXCEPTION 'HXWE8: worker lacks task risk clearance' USING ERRCODE = 'P0001';
  END IF;
  IF v_worker.worker_trust_tier < COALESCE(NEW.trust_tier_required, 1) THEN
    RAISE EXCEPTION 'HXWE9: worker trust tier is insufficient' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.price > (CASE
      WHEN v_worker.worker_trust_tier <= 0 THEN 2000
      WHEN v_worker.worker_trust_tier = 1 THEN 5000
      WHEN v_worker.worker_trust_tier = 2 THEN 20000
      ELSE 9999900
    END) THEN
    RAISE EXCEPTION 'HXWE10: task value exceeds worker trust authority' USING ERRCODE = 'P0001';
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

COMMENT ON TABLE hxos_local_test_payout_transfers IS
  'Local TEST-only provider ledger. A paid row is certification evidence, never a claim of Stripe or bank settlement.';
COMMENT ON COLUMN escrows.payout_provider IS
  'Explicit settlement provider. LOCAL_CERTIFICATION_TEST is valid only for CONTROLLED_TEST tasks.';
COMMENT ON COLUMN escrows.provider_transfer_status IS
  'Provider-backed transfer state; escrow RELEASED and bank/provider paid remain distinguishable.';
