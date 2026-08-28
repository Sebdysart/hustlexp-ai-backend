-- Active lifecycle-service foundations omitted by the constitutional baseline.
-- This migration is intentionally additive and idempotent so it can align both
-- fresh databases and long-lived installations without replaying the legacy
-- mega-schema.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS date_of_birth DATE,
  ADD COLUMN IF NOT EXISTS is_minor BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS is_banned BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS plan VARCHAR(20) NOT NULL DEFAULT 'free',
  ADD COLUMN IF NOT EXISTS plan_subscribed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS plan_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS stripe_connect_status VARCHAR(30),
  ADD COLUMN IF NOT EXISTS payouts_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS charges_enabled BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS location_state TEXT,
  ADD COLUMN IF NOT EXISTS location_city TEXT;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_plan_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_plan_check CHECK (plan IN ('free', 'premium', 'pro'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_users_plan ON users(plan);
CREATE INDEX IF NOT EXISTS idx_users_active_adults
  ON users(account_status, default_mode) WHERE is_minor = FALSE AND is_banned = FALSE;

-- Region acceptance gates reference both verification authorities even when a
-- particular category does not require those credentials. PL/pgSQL resolves
-- the relations at execution time, so omitting either table makes every first
-- reservation fail before the boolean policy branch can be evaluated.
CREATE TABLE IF NOT EXISTS license_verifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trade_type TEXT NOT NULL,
  issuing_state TEXT,
  license_number TEXT,
  expiration_date DATE,
  document_url TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  rejection_reason TEXT,
  notes TEXT,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE license_verifications
  ADD COLUMN IF NOT EXISTS document_url TEXT,
  ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT,
  ADD COLUMN IF NOT EXISTS notes TEXT;

ALTER TABLE license_verifications ALTER COLUMN status SET DEFAULT 'PENDING';
UPDATE license_verifications SET status = UPPER(status)
WHERE status IN ('pending','approved','rejected','expired');
CREATE INDEX IF NOT EXISTS idx_license_verifications_user_trade
  ON license_verifications(user_id, trade_type, issuing_state, submitted_at DESC);

CREATE TABLE IF NOT EXISTS insurance_verifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT,
  policy_number TEXT,
  expiration_date DATE,
  coverage_amount_cents INTEGER,
  document_url TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  rejection_reason TEXT,
  notes TEXT,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE insurance_verifications
  ADD COLUMN IF NOT EXISTS document_url TEXT,
  ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT,
  ADD COLUMN IF NOT EXISTS notes TEXT;

ALTER TABLE insurance_verifications ALTER COLUMN status SET DEFAULT 'PENDING';
UPDATE insurance_verifications SET status = UPPER(status)
WHERE status IN ('pending','approved','rejected','expired');
CREATE INDEX IF NOT EXISTS idx_insurance_verifications_user_status
  ON insurance_verifications(user_id, status, expiration_date DESC, submitted_at DESC);

-- Capability recomputation and feed eligibility are active runtime paths. A
-- fresh deployment must not depend on the retired mega-schema to provide their
-- derived, rebuildable outputs.
CREATE TABLE IF NOT EXISTS capability_profiles (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  trust_tier INTEGER NOT NULL DEFAULT 1 CHECK (trust_tier BETWEEN 1 AND 4),
  risk_clearance TEXT[] NOT NULL DEFAULT ARRAY['low']::text[],
  location_state TEXT,
  location_city TEXT,
  insurance_valid BOOLEAN NOT NULL DEFAULT FALSE,
  insurance_expires_at DATE,
  background_check_valid BOOLEAN NOT NULL DEFAULT FALSE,
  background_check_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE capability_profiles
  ADD COLUMN IF NOT EXISTS trust_tier INTEGER,
  ADD COLUMN IF NOT EXISTS risk_clearance TEXT[] NOT NULL DEFAULT ARRAY['low']::text[],
  ADD COLUMN IF NOT EXISTS location_state TEXT,
  ADD COLUMN IF NOT EXISTS location_city TEXT,
  ADD COLUMN IF NOT EXISTS insurance_valid BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS insurance_expires_at DATE,
  ADD COLUMN IF NOT EXISTS background_check_valid BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS background_check_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

DO $$
DECLARE v_type TEXT;
BEGIN
  SELECT data_type INTO v_type
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'capability_profiles' AND column_name = 'trust_tier';
  IF v_type IS NOT NULL AND v_type NOT IN ('smallint','integer','bigint') THEN
    ALTER TABLE capability_profiles ALTER COLUMN trust_tier TYPE INTEGER USING
      CASE upper(trust_tier::text)
        WHEN 'A' THEN 4 WHEN 'B' THEN 3 WHEN 'C' THEN 2 WHEN 'D' THEN 1
        ELSE greatest(1, least(4, trust_tier::text::integer))
      END;
  END IF;
END $$;

UPDATE capability_profiles cp
SET trust_tier = greatest(1, least(4, u.trust_tier))
FROM users u
WHERE cp.user_id = u.id AND cp.trust_tier IS NULL;
ALTER TABLE capability_profiles ALTER COLUMN trust_tier SET DEFAULT 1;
ALTER TABLE capability_profiles ALTER COLUMN trust_tier SET NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'capability_profiles_trust_tier_check') THEN
    ALTER TABLE capability_profiles ADD CONSTRAINT capability_profiles_trust_tier_check
      CHECK (trust_tier BETWEEN 1 AND 4);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_capability_profiles_risk_clearance
  ON capability_profiles USING GIN(risk_clearance);

CREATE TABLE IF NOT EXISTS verified_trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trade TEXT NOT NULL,
  state TEXT NOT NULL,
  expires_at DATE,
  license_verification_id UUID REFERENCES license_verifications(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, trade, state)
);

ALTER TABLE verified_trades
  ADD COLUMN IF NOT EXISTS expires_at DATE,
  ADD COLUMN IF NOT EXISTS license_verification_id UUID,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
CREATE UNIQUE INDEX IF NOT EXISTS idx_verified_trades_user_trade_state
  ON verified_trades(user_id, trade, state);
CREATE INDEX IF NOT EXISTS idx_verified_trades_eligibility
  ON verified_trades(user_id, trade, state, expires_at);

-- Judge/Scoper/Logistics agents are proposal-only, but their human-review
-- evidence is still a durable audit requirement. The active services write
-- this table while the constitutional baseline only carries older AI tables.
CREATE TABLE IF NOT EXISTS ai_agent_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_type TEXT NOT NULL CHECK (agent_type IN (
    'scoper','judge','matchmaker','dispute','reputation','onboarding','logistics'
  )),
  task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  proof_id UUID REFERENCES proofs(id) ON DELETE SET NULL,
  proposal JSONB NOT NULL DEFAULT '{}'::jsonb,
  confidence_score NUMERIC(4,3) NOT NULL DEFAULT 0.0
    CHECK (confidence_score BETWEEN 0 AND 1),
  reasoning TEXT,
  accepted BOOLEAN,
  validator_override BOOLEAN NOT NULL DEFAULT FALSE,
  validator_reason TEXT,
  authority_level TEXT NOT NULL DEFAULT 'A2' CHECK (authority_level = 'A2'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_agent_decisions_agent_type
  ON ai_agent_decisions(agent_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_agent_decisions_task
  ON ai_agent_decisions(task_id, created_at DESC) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_agent_decisions_proof
  ON ai_agent_decisions(proof_id, created_at DESC) WHERE proof_id IS NOT NULL;

-- Trust-system telemetry is an active runtime dependency, not optional launch
-- scaffolding. Fresh deployments must support every AlphaInstrumentation shape.
CREATE TABLE IF NOT EXISTS alpha_telemetry (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_group TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('hustler','poster')),
  state TEXT,
  trust_tier INTEGER,
  location_radius_miles NUMERIC(5,2),
  instant_mode_enabled BOOLEAN,
  task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  trigger_state TEXT,
  time_since_completion_seconds INTEGER,
  reason_selected TEXT,
  time_on_screen_ms INTEGER,
  exit_type TEXT,
  submitted BOOLEAN,
  rejected_by_guard BOOLEAN,
  cooldown_hit BOOLEAN,
  attempt_number INTEGER CHECK (attempt_number IN (1,2)),
  proof_type TEXT,
  gps_verified BOOLEAN,
  verification_result TEXT CHECK (verification_result IN ('pass','fail')),
  failure_reason TEXT,
  resolved BOOLEAN,
  xp_released BOOLEAN,
  escrow_released BOOLEAN,
  delta_type TEXT CHECK (delta_type IN ('xp','tier','streak')),
  delta_amount NUMERIC,
  reason_code TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alpha_telemetry_event_group
  ON alpha_telemetry(event_group, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_alpha_telemetry_user_id
  ON alpha_telemetry(user_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_alpha_telemetry_task_id
  ON alpha_telemetry(task_id, timestamp DESC) WHERE task_id IS NOT NULL;

-- Worker economics must be decision-complete before acceptance. The original
-- offer contract persisted only the gross worker share while the release path
-- later applied a 2% self-insurance adjustment. Persist the exact adjustment
-- and net transfer amount in the immutable offer witness as well.
ALTER TABLE worker_offer_decisions
  ADD COLUMN IF NOT EXISTS insurance_adjustment_cents INTEGER
    CHECK (insurance_adjustment_cents >= 0),
  ADD COLUMN IF NOT EXISTS net_payout_cents INTEGER
    CHECK (net_payout_cents > 0);

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS xp_reward INTEGER NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS instant_mode BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS sensitive BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS template_slug VARCHAR(50),
  ADD COLUMN IF NOT EXISTS matched_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS progress_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS progress_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS surge_level INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS surge_multiplier NUMERIC(4,2) NOT NULL DEFAULT 1.00,
  ADD COLUMN IF NOT EXISTS asap_bump_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS trust_tier_required INTEGER,
  ADD COLUMN IF NOT EXISTS payment_method TEXT NOT NULL DEFAULT 'escrow',
  ADD COLUMN IF NOT EXISTS completion_criteria JSONB,
  ADD COLUMN IF NOT EXISTS content_release BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS cancellation_window_hours INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS illegal_risk_score INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS compliance_guardian_notes JSONB,
  ADD COLUMN IF NOT EXISTS mutual_consent_accepted BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS late_cancel_pct INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS task_applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  hustler_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  message TEXT,
  status VARCHAR(30) NOT NULL DEFAULT 'pending'
    CHECK (status IN (
      'pending', 'accepted', 'rejected', 'countered',
      'counter_rejected', 'withdrawn', 'expired'
    )),
  counter_offer_round INTEGER NOT NULL DEFAULT 0 CHECK (counter_offer_round >= 0),
  rejection_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_task_applications_task_status
  ON task_applications(task_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_task_applications_hustler_created
  ON task_applications(hustler_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_app_active_per_hustler
  ON task_applications(task_id, hustler_id)
  WHERE status NOT IN ('rejected', 'counter_rejected', 'withdrawn', 'expired');

CREATE INDEX IF NOT EXISTS idx_tasks_actionable_feed
  ON tasks(risk_level, created_at DESC, id DESC)
  WHERE state = 'OPEN' AND worker_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_worker_active
  ON tasks(worker_id, state)
  WHERE worker_id IS NOT NULL AND state IN ('ACCEPTED', 'PROOF_SUBMITTED', 'DISPUTED');
CREATE INDEX IF NOT EXISTS idx_disputes_worker_active
  ON disputes(worker_id, state)
  WHERE state IN ('OPEN', 'EVIDENCE_REQUESTED', 'ESCALATED');

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_xp_reward_check') THEN
    ALTER TABLE tasks ADD CONSTRAINT tasks_xp_reward_check
      CHECK (xp_reward > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_surge_level_check') THEN
    ALTER TABLE tasks ADD CONSTRAINT tasks_surge_level_check
      CHECK (surge_level BETWEEN 0 AND 3);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_surge_multiplier_check') THEN
    ALTER TABLE tasks ADD CONSTRAINT tasks_surge_multiplier_check
      CHECK (surge_multiplier >= 1.00 AND surge_multiplier <= 2.00);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_asap_bump_count_check') THEN
    ALTER TABLE tasks ADD CONSTRAINT tasks_asap_bump_count_check
      CHECK (asap_bump_count >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_trust_tier_required_check') THEN
    ALTER TABLE tasks ADD CONSTRAINT tasks_trust_tier_required_check
      CHECK (trust_tier_required IS NULL OR trust_tier_required BETWEEN 1 AND 4);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_payment_method_check') THEN
    ALTER TABLE tasks ADD CONSTRAINT tasks_payment_method_check
      CHECK (payment_method IN ('escrow', 'offline_cash', 'offline_venmo', 'offline_cashapp'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_illegal_risk_score_check') THEN
    ALTER TABLE tasks ADD CONSTRAINT tasks_illegal_risk_score_check
      CHECK (illegal_risk_score BETWEEN 0 AND 100);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_late_cancel_pct_check') THEN
    ALTER TABLE tasks ADD CONSTRAINT tasks_late_cancel_pct_check
      CHECK (late_cancel_pct BETWEEN 0 AND 100);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_cancellation_window_hours_check') THEN
    ALTER TABLE tasks ADD CONSTRAINT tasks_cancellation_window_hours_check
      CHECK (cancellation_window_hours >= 0);
  END IF;
END $$;

-- XPService persists every multiplier used to derive an award. The
-- constitutional baseline predates trust, live-mode, and surge multipliers,
-- so fresh deployments must add the audit columns before the service can
-- issue its first post-settlement award.
ALTER TABLE xp_ledger
  ADD COLUMN IF NOT EXISTS trust_multiplier NUMERIC(4,2) NOT NULL DEFAULT 1.00,
  ADD COLUMN IF NOT EXISTS live_mode_multiplier NUMERIC(4,2) NOT NULL DEFAULT 1.00,
  ADD COLUMN IF NOT EXISTS surge_multiplier NUMERIC(4,2) NOT NULL DEFAULT 1.00;

CREATE TABLE IF NOT EXISTS plan_entitlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
  risk_level TEXT NOT NULL CHECK (risk_level IN ('LOW', 'MEDIUM', 'HIGH', 'IN_HOME')),
  source_event_id TEXT NOT NULL UNIQUE,
  source_payment_intent TEXT,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_plan_entitlements_user ON plan_entitlements(user_id);
CREATE INDEX IF NOT EXISTS idx_plan_entitlements_active ON plan_entitlements(user_id, risk_level, expires_at);

CREATE TABLE IF NOT EXISTS worker_payout_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  payout_method VARCHAR(20) NOT NULL DEFAULT 'standard'
    CHECK (payout_method IN ('standard', 'instant')),
  payout_schedule VARCHAR(20) NOT NULL DEFAULT 'weekly'
    CHECK (payout_schedule IN ('daily', 'weekly', 'monthly')),
  minimum_payout_amount_cents INTEGER NOT NULL DEFAULT 100
    CHECK (minimum_payout_amount_cents >= 0),
  bank_account_last4 VARCHAR(4),
  bank_account_type VARCHAR(20) CHECK (bank_account_type IN ('checking', 'savings')),
  bank_name VARCHAR(100),
  instant_payout_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  instant_payout_fee_accepted BOOLEAN NOT NULL DEFAULT FALSE,
  weekly_payout_day INTEGER CHECK (weekly_payout_day BETWEEN 0 AND 6),
  monthly_payout_day INTEGER CHECK (monthly_payout_day BETWEEN 1 AND 31),
  next_scheduled_payout_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS escrow_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  escrow_id UUID NOT NULL REFERENCES escrows(id) ON DELETE RESTRICT,
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_type TEXT NOT NULL DEFAULT 'system',
  idempotency_key TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE escrow_events
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_escrow_events_idempotency_key
  ON escrow_events(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_escrow_events_escrow_created
  ON escrow_events(escrow_id, created_at);

-- A RELEASED state is not sufficient settlement evidence by itself. Enqueue a
-- replay-safe reconciliation job in the same transaction as the terminal state
-- change so insurance, earnings, XP, progress, and the release witness can be
-- repaired after any process crash between commit and post-commit side effects.
CREATE OR REPLACE FUNCTION enqueue_escrow_release_reconciliation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state = 'RELEASED' AND OLD.state IS DISTINCT FROM NEW.state THEN
    INSERT INTO outbox_events (
      event_type, aggregate_type, aggregate_id, event_version,
      idempotency_key, payload, queue_name, status
    ) VALUES (
      'escrow.released', 'escrow', NEW.id, NEW.version,
      'escrow.released:' || NEW.id::text,
      jsonb_build_object(
        'escrowId', NEW.id,
        'transferId', NEW.stripe_transfer_id,
        'fromState', OLD.state,
        'version', NEW.version
      ),
      'critical_payments', 'pending'
    )
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS escrow_release_reconciliation_outbox ON escrows;
CREATE TRIGGER escrow_release_reconciliation_outbox
AFTER UPDATE OF state ON escrows
FOR EACH ROW EXECUTE FUNCTION enqueue_escrow_release_reconciliation();

-- Existing released escrows may predate the trigger. Backfill only the durable
-- request; the consumer is idempotent and verifies current state/transfer facts.
INSERT INTO outbox_events (
  event_type, aggregate_type, aggregate_id, event_version,
  idempotency_key, payload, queue_name, status
)
SELECT
  'escrow.released', 'escrow', e.id, e.version,
  'escrow.released:' || e.id::text,
  jsonb_build_object(
    'escrowId', e.id,
    'transferId', e.stripe_transfer_id,
    'fromState', 'MIGRATION_BACKFILL',
    'version', e.version
  ),
  'critical_payments', 'pending'
FROM escrows e
WHERE e.state = 'RELEASED'
ON CONFLICT (idempotency_key) DO NOTHING;

-- A task can earn one platform fee. Stripe may redeliver the same transfer in a
-- second envelope, so event-id uniqueness alone is insufficient.
CREATE UNIQUE INDEX IF NOT EXISTS idx_revenue_platform_fee_one_per_escrow
  ON revenue_ledger(escrow_id)
  WHERE event_type = 'platform_fee' AND escrow_id IS NOT NULL;

-- HX002 is the canonical terminal-escrow invariant. Older baseline schemas
-- accidentally reused HX301, which belongs to proof-gated task completion.
CREATE OR REPLACE FUNCTION prevent_escrow_terminal_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state IN ('RELEASED', 'REFUNDED', 'REFUND_PARTIAL')
     AND NEW.state <> OLD.state THEN
    RAISE EXCEPTION 'HX002: Cannot transition terminal escrow state % (escrow % is terminal and immutable)',
      OLD.state, OLD.id
      USING ERRCODE = 'HX002';
  END IF;
  IF OLD.state = 'LOCKED_DISPUTE' AND NEW.state = 'RELEASED' THEN
    RAISE EXCEPTION 'HX002: Cannot release dispute-locked escrow % before dispute resolution', OLD.id
      USING ERRCODE = 'HX002';
  END IF;
  RETURN NEW;
END;
$$;

-- Align upgraded installations with the constitutional post-completion dispute
-- window without weakening any other terminal task transition.
CREATE OR REPLACE FUNCTION prevent_task_terminal_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state = 'COMPLETED' AND NEW.state = 'DISPUTED' THEN
    IF OLD.completed_at IS NULL OR clock_timestamp() > OLD.completed_at + INTERVAL '48 hours' THEN
      RAISE EXCEPTION 'TERMINAL_STATE_VIOLATION: Completed task % is outside the dispute window', OLD.id
        USING ERRCODE = 'HX001';
    END IF;
    IF NEW.price IS DISTINCT FROM OLD.price OR
       NEW.poster_id IS DISTINCT FROM OLD.poster_id OR
       NEW.worker_id IS DISTINCT FROM OLD.worker_id OR
       NEW.title IS DISTINCT FROM OLD.title OR
       NEW.description IS DISTINCT FROM OLD.description OR
       NEW.risk_level IS DISTINCT FROM OLD.risk_level OR
       NOT EXISTS (
         SELECT 1 FROM disputes d
         JOIN escrows e ON e.id = d.escrow_id
         WHERE d.task_id = OLD.id
           AND d.poster_id = OLD.poster_id
           AND d.worker_id = OLD.worker_id
           AND d.state IN ('OPEN', 'EVIDENCE_REQUESTED', 'ESCALATED')
           AND e.state = 'LOCKED_DISPUTE'
       ) THEN
      RAISE EXCEPTION 'TERMINAL_STATE_VIOLATION: Completed task % lacks a valid locked dispute', OLD.id
        USING ERRCODE = 'HX001';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.state IN ('COMPLETED', 'CANCELLED', 'EXPIRED') THEN
    IF NEW.state IS DISTINCT FROM OLD.state OR
       NEW.price IS DISTINCT FROM OLD.price OR
       NEW.poster_id IS DISTINCT FROM OLD.poster_id OR
       NEW.worker_id IS DISTINCT FROM OLD.worker_id OR
       NEW.title IS DISTINCT FROM OLD.title OR
       NEW.description IS DISTINCT FROM OLD.description OR
       NEW.risk_level IS DISTINCT FROM OLD.risk_level THEN
      RAISE EXCEPTION 'TERMINAL_STATE_VIOLATION: Cannot modify task % in terminal state %', OLD.id, OLD.state
        USING ERRCODE = 'HX001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION prevent_escrow_amount_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.amount IS DISTINCT FROM OLD.amount THEN
    RAISE EXCEPTION 'INV-4_VIOLATION: Cannot change escrow amount after creation. Escrow: %, Old: %, New: %',
      OLD.id, OLD.amount, NEW.amount
      USING ERRCODE = 'HX004';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS self_insurance_pool (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  total_deposits_cents INTEGER NOT NULL DEFAULT 0,
  total_claims_cents INTEGER NOT NULL DEFAULT 0,
  available_balance_cents INTEGER GENERATED ALWAYS AS
    (total_deposits_cents - total_claims_cents) STORED,
  coverage_percentage NUMERIC(5,2) NOT NULL DEFAULT 80.0,
  max_claim_cents INTEGER NOT NULL DEFAULT 500000,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO self_insurance_pool (id)
SELECT gen_random_uuid() WHERE NOT EXISTS (SELECT 1 FROM self_insurance_pool);

CREATE TABLE IF NOT EXISTS insurance_contributions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  hustler_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  contribution_cents INTEGER NOT NULL CHECK (contribution_cents >= 0),
  contribution_percentage NUMERIC(5,2) NOT NULL DEFAULT 2.0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (task_id, hustler_id)
);

CREATE TABLE IF NOT EXISTS verification_earnings_tracking (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  total_net_earnings_cents INTEGER NOT NULL DEFAULT 0,
  earned_unlock_threshold_cents INTEGER NOT NULL DEFAULT 4000,
  earned_unlock_achieved BOOLEAN NOT NULL DEFAULT FALSE,
  earned_unlock_achieved_at TIMESTAMPTZ,
  unlock_notified_at TIMESTAMPTZ,
  completed_task_count INTEGER NOT NULL DEFAULT 0,
  last_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS verification_earnings_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  escrow_id UUID NOT NULL REFERENCES escrows(id) ON DELETE RESTRICT UNIQUE,
  net_payout_cents INTEGER NOT NULL,
  cumulative_earnings_before_cents INTEGER NOT NULL,
  cumulative_earnings_after_cents INTEGER NOT NULL,
  awarded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION update_verification_earnings_tracking()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO verification_earnings_tracking (
    user_id,total_net_earnings_cents,earned_unlock_achieved,
    earned_unlock_achieved_at,completed_task_count,last_updated_at
  ) VALUES (
    NEW.user_id,NEW.cumulative_earnings_after_cents,NEW.cumulative_earnings_after_cents >= 4000,
    CASE WHEN NEW.cumulative_earnings_after_cents >= 4000 THEN NOW() ELSE NULL END,1,NOW()
  )
  ON CONFLICT (user_id) DO UPDATE SET
    total_net_earnings_cents = GREATEST(
      verification_earnings_tracking.total_net_earnings_cents,
      EXCLUDED.total_net_earnings_cents
    ),
    earned_unlock_achieved = verification_earnings_tracking.earned_unlock_achieved
      OR EXCLUDED.earned_unlock_achieved,
    earned_unlock_achieved_at = COALESCE(
      verification_earnings_tracking.earned_unlock_achieved_at,
      EXCLUDED.earned_unlock_achieved_at
    ),
    completed_task_count = verification_earnings_tracking.completed_task_count + 1,
    last_updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS verification_earnings_ledger_tracking ON verification_earnings_ledger;
CREATE TRIGGER verification_earnings_ledger_tracking
AFTER INSERT ON verification_earnings_ledger
FOR EACH ROW EXECUTE FUNCTION update_verification_earnings_tracking();
