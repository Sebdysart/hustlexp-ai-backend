CREATE TABLE IF NOT EXISTS user_xp_tax_status (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  total_unpaid_tax_cents INTEGER NOT NULL DEFAULT 0,
  total_xp_held_back INTEGER NOT NULL DEFAULT 0,
  offline_payments_blocked BOOLEAN NOT NULL DEFAULT FALSE,
  last_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS xp_tax_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id UUID NOT NULL,
  gross_payout_cents INTEGER NOT NULL,
  tax_percentage NUMERIC(5,2) NOT NULL DEFAULT 10.0,
  tax_amount_cents INTEGER NOT NULL,
  net_payout_cents INTEGER NOT NULL,
  payment_method TEXT NOT NULL CHECK (
    payment_method IN ('escrow','offline_cash','offline_venmo','offline_cashapp')
  ),
  tax_paid BOOLEAN NOT NULL DEFAULT FALSE,
  tax_paid_at TIMESTAMPTZ,
  xp_held_back BOOLEAN NOT NULL DEFAULT FALSE,
  xp_released BOOLEAN NOT NULL DEFAULT FALSE,
  xp_released_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (task_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_xp_tax_ledger_user_id ON xp_tax_ledger(user_id);
CREATE INDEX IF NOT EXISTS idx_xp_tax_ledger_unpaid
  ON xp_tax_ledger(user_id) WHERE tax_paid = FALSE;

CREATE TABLE IF NOT EXISTS self_insurance_pool (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  total_deposits_cents INTEGER NOT NULL DEFAULT 0,
  total_claims_cents INTEGER NOT NULL DEFAULT 0,
  available_balance_cents INTEGER
    GENERATED ALWAYS AS (total_deposits_cents - total_claims_cents) STORED,
  coverage_percentage NUMERIC(5,2) NOT NULL DEFAULT 80.0,
  max_claim_cents INTEGER NOT NULL DEFAULT 500000,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO self_insurance_pool (id)
SELECT gen_random_uuid() WHERE NOT EXISTS (SELECT 1 FROM self_insurance_pool);

CREATE TABLE IF NOT EXISTS insurance_contributions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL,
  hustler_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contribution_cents INTEGER NOT NULL,
  contribution_percentage NUMERIC(5,2) NOT NULL DEFAULT 2.0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (task_id, hustler_id)
);

CREATE TABLE IF NOT EXISTS insurance_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL,
  hustler_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  claim_amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','denied','paid')),
  claim_reason TEXT NOT NULL,
  evidence_urls TEXT[] NOT NULL DEFAULT '{}',
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  review_notes TEXT,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS skill_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  icon_name TEXT NOT NULL DEFAULT 'default',
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS skills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id UUID NOT NULL REFERENCES skill_categories(id) ON DELETE CASCADE,
  name TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  description TEXT,
  icon_name TEXT,
  gate_type TEXT NOT NULL DEFAULT 'soft' CHECK (gate_type IN ('soft','hard')),
  min_trust_tier INTEGER NOT NULL DEFAULT 1,
  requires_license BOOLEAN NOT NULL DEFAULT FALSE,
  requires_background_check BOOLEAN NOT NULL DEFAULT FALSE,
  risk_level TEXT NOT NULL DEFAULT 'LOW'
    CHECK (risk_level IN ('LOW','MEDIUM','HIGH','IN_HOME')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS worker_skills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  skill_id UUID NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  verified_at TIMESTAMPTZ,
  license_url TEXT,
  license_expiry TIMESTAMPTZ,
  tasks_completed INTEGER NOT NULL DEFAULT 0,
  avg_rating NUMERIC(3,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, skill_id)
);

CREATE TABLE IF NOT EXISTS processed_stripe_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS device_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fcm_token TEXT NOT NULL,
  device_type TEXT NOT NULL DEFAULT 'ios' CHECK (device_type IN ('ios','android')),
  device_name TEXT,
  app_version TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, fcm_token)
);
CREATE INDEX IF NOT EXISTS idx_device_tokens_user_active
  ON device_tokens(user_id) WHERE is_active = TRUE;

CREATE TABLE IF NOT EXISTS alpha_telemetry (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_group TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('hustler','poster')),
  state TEXT,
  trust_tier INTEGER,
  location_radius_miles NUMERIC,
  instant_mode_enabled BOOLEAN,
  time_on_screen_ms INTEGER,
  exit_type TEXT,
  task_id UUID,
  trigger_state TEXT,
  time_since_completion_seconds INTEGER,
  reason_selected TEXT,
  submitted BOOLEAN,
  rejected_by_guard BOOLEAN,
  cooldown_hit BOOLEAN,
  attempt_number INTEGER,
  proof_type TEXT,
  gps_verified BOOLEAN,
  verification_result TEXT,
  failure_reason TEXT,
  resolved BOOLEAN,
  xp_released BOOLEAN,
  escrow_released BOOLEAN,
  delta_type TEXT,
  delta_amount NUMERIC,
  reason_code TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_alpha_telemetry_event_group ON alpha_telemetry(event_group);
CREATE INDEX IF NOT EXISTS idx_alpha_telemetry_user ON alpha_telemetry(user_id);
CREATE INDEX IF NOT EXISTS idx_alpha_telemetry_timestamp ON alpha_telemetry(timestamp);

CREATE TABLE IF NOT EXISTS ai_agent_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_type TEXT NOT NULL
    CHECK (agent_type IN ('scoper','logistics','dispute','reputation')),
  task_id UUID,
  proof_id UUID,
  proposal JSONB NOT NULL DEFAULT '{}',
  confidence_score NUMERIC(4,3) NOT NULL DEFAULT 0.0,
  reasoning TEXT,
  accepted BOOLEAN,
  validator_override BOOLEAN DEFAULT FALSE,
  validator_reason TEXT,
  authority_level TEXT NOT NULL DEFAULT 'A2',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dispute_jury_votes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id UUID NOT NULL,
  juror_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vote TEXT NOT NULL
    CHECK (vote IN ('worker_complete','worker_incomplete','inconclusive')),
  confidence NUMERIC(4,3) NOT NULL DEFAULT 0.0,
  xp_reward INTEGER NOT NULL DEFAULT 5,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (dispute_id, juror_id)
);

CREATE TABLE IF NOT EXISTS plan_entitlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id UUID,
  risk_level TEXT NOT NULL CHECK (risk_level IN ('LOW','MEDIUM','HIGH','IN_HOME')),
  source_event_id TEXT NOT NULL UNIQUE,
  source_payment_intent TEXT,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS task_geofence_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type VARCHAR(20) NOT NULL CHECK (event_type IN ('ENTER','EXIT','DWELL')),
  location_lat DECIMAL(10,8) NOT NULL,
  location_lng DECIMAL(11,8) NOT NULL,
  distance_meters NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS price_modifier_percent NUMERIC DEFAULT 0;
