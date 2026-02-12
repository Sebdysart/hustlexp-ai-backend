-- ============================================================================
-- Migration: add_missing_tables_v2.sql
-- Description: Creates all missing tables referenced in service/router code
-- Idempotent: All statements use CREATE TABLE IF NOT EXISTS
-- ============================================================================

-- ============================================================================
-- 1. user_xp_tax_status
--    Source: services/XPTaxService.ts
--    Summary table for per-user unpaid XP tax state
-- ============================================================================
CREATE TABLE IF NOT EXISTS user_xp_tax_status (
  user_id              UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  total_unpaid_tax_cents INTEGER NOT NULL DEFAULT 0,
  total_xp_held_back   INTEGER NOT NULL DEFAULT 0,
  offline_payments_blocked BOOLEAN NOT NULL DEFAULT FALSE,
  last_updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- 2. xp_tax_ledger
--    Source: services/XPTaxService.ts
--    Per-task offline-payment tax records
-- ============================================================================
CREATE TABLE IF NOT EXISTS xp_tax_ledger (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id              UUID NOT NULL,
  gross_payout_cents   INTEGER NOT NULL,
  tax_percentage       NUMERIC(5,2) NOT NULL DEFAULT 10.0,
  tax_amount_cents     INTEGER NOT NULL,
  net_payout_cents     INTEGER NOT NULL,
  payment_method       TEXT NOT NULL CHECK (payment_method IN ('escrow', 'offline_cash', 'offline_venmo', 'offline_cashapp')),
  tax_paid             BOOLEAN NOT NULL DEFAULT FALSE,
  tax_paid_at          TIMESTAMPTZ,
  xp_held_back         BOOLEAN NOT NULL DEFAULT FALSE,
  xp_released          BOOLEAN NOT NULL DEFAULT FALSE,
  xp_released_at       TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (task_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_xp_tax_ledger_user_id ON xp_tax_ledger(user_id);
CREATE INDEX IF NOT EXISTS idx_xp_tax_ledger_unpaid ON xp_tax_ledger(user_id) WHERE tax_paid = FALSE;

-- ============================================================================
-- 3. self_insurance_pool
--    Source: services/SelfInsurancePoolService.ts
--    Singleton row tracking the platform insurance pool balance
-- ============================================================================
CREATE TABLE IF NOT EXISTS self_insurance_pool (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  total_deposits_cents      INTEGER NOT NULL DEFAULT 0,
  total_claims_cents        INTEGER NOT NULL DEFAULT 0,
  available_balance_cents   INTEGER GENERATED ALWAYS AS (total_deposits_cents - total_claims_cents) STORED,
  coverage_percentage       NUMERIC(5,2) NOT NULL DEFAULT 80.0,
  max_claim_cents           INTEGER NOT NULL DEFAULT 500000,
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed the singleton row if it does not already exist
INSERT INTO self_insurance_pool (id)
SELECT gen_random_uuid()
WHERE NOT EXISTS (SELECT 1 FROM self_insurance_pool);

-- ============================================================================
-- 4. insurance_contributions
--    Source: services/SelfInsurancePoolService.ts
--    Per-task contribution records into the insurance pool
-- ============================================================================
CREATE TABLE IF NOT EXISTS insurance_contributions (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id                  UUID NOT NULL,
  hustler_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contribution_cents       INTEGER NOT NULL,
  contribution_percentage  NUMERIC(5,2) NOT NULL DEFAULT 2.0,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (task_id, hustler_id)
);

CREATE INDEX IF NOT EXISTS idx_insurance_contributions_hustler ON insurance_contributions(hustler_id);
CREATE INDEX IF NOT EXISTS idx_insurance_contributions_task ON insurance_contributions(task_id);

-- ============================================================================
-- 5. insurance_claims
--    Source: services/SelfInsurancePoolService.ts, routers/insurance.ts
--    Claims filed by hustlers against the insurance pool
-- ============================================================================
CREATE TABLE IF NOT EXISTS insurance_claims (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id           UUID NOT NULL,
  hustler_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  claim_amount_cents INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'paid')),
  claim_reason      TEXT NOT NULL,
  evidence_urls     TEXT[] NOT NULL DEFAULT '{}',
  reviewed_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at       TIMESTAMPTZ,
  review_notes      TEXT,
  paid_at           TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_insurance_claims_hustler ON insurance_claims(hustler_id);
CREATE INDEX IF NOT EXISTS idx_insurance_claims_status ON insurance_claims(status);
CREATE INDEX IF NOT EXISTS idx_insurance_claims_task ON insurance_claims(task_id);

-- ============================================================================
-- 6. skill_categories
--    Source: services/WorkerSkillService.ts
--    Top-level groupings for the skill catalog
-- ============================================================================
CREATE TABLE IF NOT EXISTS skill_categories (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  icon_name     TEXT NOT NULL DEFAULT 'default',
  sort_order    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_skill_categories_sort ON skill_categories(sort_order);

-- ============================================================================
-- 7. skills
--    Source: services/WorkerSkillService.ts, services/TaskDiscoveryService.ts,
--           services/HeatMapService.ts
--    Individual skills within categories
-- ============================================================================
CREATE TABLE IF NOT EXISTS skills (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id               UUID NOT NULL REFERENCES skill_categories(id) ON DELETE CASCADE,
  name                      TEXT NOT NULL UNIQUE,
  display_name              TEXT NOT NULL,
  description               TEXT,
  icon_name                 TEXT,
  gate_type                 TEXT NOT NULL DEFAULT 'soft' CHECK (gate_type IN ('soft', 'hard')),
  min_trust_tier            INTEGER NOT NULL DEFAULT 1,
  requires_license          BOOLEAN NOT NULL DEFAULT FALSE,
  requires_background_check BOOLEAN NOT NULL DEFAULT FALSE,
  risk_level                TEXT NOT NULL DEFAULT 'LOW' CHECK (risk_level IN ('LOW', 'MEDIUM', 'HIGH', 'IN_HOME')),
  is_active                 BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order                INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_skills_category ON skills(category_id);
CREATE INDEX IF NOT EXISTS idx_skills_active ON skills(is_active) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_skills_gate_type ON skills(gate_type);

-- ============================================================================
-- 8. worker_skills
--    Source: services/WorkerSkillService.ts, routers/skills.ts
--    Junction table linking workers to their selected skills
-- ============================================================================
CREATE TABLE IF NOT EXISTS worker_skills (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  skill_id         UUID NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  verified         BOOLEAN NOT NULL DEFAULT FALSE,
  verified_at      TIMESTAMPTZ,
  license_url      TEXT,
  license_expiry   TIMESTAMPTZ,
  tasks_completed  INTEGER NOT NULL DEFAULT 0,
  avg_rating       NUMERIC(3,2),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, skill_id)
);

CREATE INDEX IF NOT EXISTS idx_worker_skills_user ON worker_skills(user_id);
CREATE INDEX IF NOT EXISTS idx_worker_skills_skill ON worker_skills(skill_id);
CREATE INDEX IF NOT EXISTS idx_worker_skills_verified ON worker_skills(user_id, skill_id) WHERE verified = TRUE;

-- ============================================================================
-- 9. processed_stripe_events
--    Source: services/StripeService.ts
--    Idempotency table for Stripe webhook event processing
-- ============================================================================
CREATE TABLE IF NOT EXISTS processed_stripe_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    TEXT NOT NULL UNIQUE,
  event_type  TEXT NOT NULL,
  object_id   TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_processed_stripe_events_event_id ON processed_stripe_events(event_id);

-- ============================================================================
-- 10. device_tokens
--     Source: routers/notification.ts, services/PushNotificationService.ts
--     FCM device tokens for push notifications
-- ============================================================================
CREATE TABLE IF NOT EXISTS device_tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fcm_token    TEXT NOT NULL,
  device_type  TEXT NOT NULL DEFAULT 'ios' CHECK (device_type IN ('ios', 'android')),
  device_name  TEXT,
  app_version  TEXT,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, fcm_token)
);

CREATE INDEX IF NOT EXISTS idx_device_tokens_user_active ON device_tokens(user_id) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_device_tokens_fcm ON device_tokens(fcm_token);

-- ============================================================================
-- 11. alpha_telemetry
--     Source: services/AlphaInstrumentation.ts, routers/alpha-telemetry.ts
--     Trust-system telemetry for edge state, dispute, proof, and trust events
-- ============================================================================
CREATE TABLE IF NOT EXISTS alpha_telemetry (
  id                           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_group                  TEXT NOT NULL,
  user_id                      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role                         TEXT NOT NULL CHECK (role IN ('hustler', 'poster')),
  -- edge state fields
  state                        TEXT,
  trust_tier                   INTEGER,
  location_radius_miles        NUMERIC,
  instant_mode_enabled         BOOLEAN,
  time_on_screen_ms            INTEGER,
  exit_type                    TEXT,
  -- dispute fields
  task_id                      UUID,
  trigger_state                TEXT,
  time_since_completion_seconds INTEGER,
  reason_selected              TEXT,
  submitted                    BOOLEAN,
  rejected_by_guard            BOOLEAN,
  cooldown_hit                 BOOLEAN,
  -- proof fields
  attempt_number               INTEGER,
  proof_type                   TEXT,
  gps_verified                 BOOLEAN,
  verification_result          TEXT,
  failure_reason               TEXT,
  resolved                     BOOLEAN,
  xp_released                  BOOLEAN,
  escrow_released              BOOLEAN,
  -- trust delta fields
  delta_type                   TEXT,
  delta_amount                 NUMERIC,
  reason_code                  TEXT,
  -- generic
  metadata                     JSONB NOT NULL DEFAULT '{}',
  timestamp                    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alpha_telemetry_event_group ON alpha_telemetry(event_group);
CREATE INDEX IF NOT EXISTS idx_alpha_telemetry_user ON alpha_telemetry(user_id);
CREATE INDEX IF NOT EXISTS idx_alpha_telemetry_timestamp ON alpha_telemetry(timestamp);
CREATE INDEX IF NOT EXISTS idx_alpha_telemetry_state ON alpha_telemetry(state) WHERE state IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_alpha_telemetry_event_ts ON alpha_telemetry(event_group, timestamp);

-- ============================================================================
-- 12. ai_agent_decisions
--     Source: services/ScoperAIService.ts, services/LogisticsAIService.ts
--     Audit log for AI agent proposals (Scoper, Logistics)
-- ============================================================================
CREATE TABLE IF NOT EXISTS ai_agent_decisions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_type         TEXT NOT NULL CHECK (agent_type IN ('scoper', 'logistics')),
  task_id            UUID,
  proof_id           UUID,
  proposal           JSONB NOT NULL DEFAULT '{}',
  confidence_score   NUMERIC(4,3) NOT NULL DEFAULT 0.0,
  reasoning          TEXT,
  accepted           BOOLEAN,
  validator_override BOOLEAN DEFAULT FALSE,
  validator_reason   TEXT,
  authority_level    TEXT NOT NULL DEFAULT 'A2',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_agent_decisions_agent ON ai_agent_decisions(agent_type);
CREATE INDEX IF NOT EXISTS idx_ai_agent_decisions_task ON ai_agent_decisions(task_id) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_agent_decisions_proof ON ai_agent_decisions(proof_id) WHERE proof_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_agent_decisions_created ON ai_agent_decisions(created_at);

-- ============================================================================
-- 13. dispute_jury_votes
--     Source: services/JuryPoolService.ts
--     Jury votes on escalated disputes
-- ============================================================================
CREATE TABLE IF NOT EXISTS dispute_jury_votes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id   UUID NOT NULL,
  juror_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vote         TEXT NOT NULL CHECK (vote IN ('worker_complete', 'worker_incomplete', 'inconclusive')),
  confidence   NUMERIC(4,3) NOT NULL DEFAULT 0.0,
  xp_reward    INTEGER NOT NULL DEFAULT 5,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (dispute_id, juror_id)
);

CREATE INDEX IF NOT EXISTS idx_dispute_jury_votes_dispute ON dispute_jury_votes(dispute_id);
CREATE INDEX IF NOT EXISTS idx_dispute_jury_votes_juror ON dispute_jury_votes(juror_id);

-- ============================================================================
-- 14. plan_entitlements
--     Source: services/PlanService.ts, services/StripeEntitlementProcessor.ts
--     Per-task risk-level entitlements purchased via Stripe
-- ============================================================================
CREATE TABLE IF NOT EXISTS plan_entitlements (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id                UUID,
  risk_level             TEXT NOT NULL CHECK (risk_level IN ('LOW', 'MEDIUM', 'HIGH', 'IN_HOME')),
  source_event_id        TEXT NOT NULL UNIQUE,
  source_payment_intent  TEXT,
  expires_at             TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_plan_entitlements_user ON plan_entitlements(user_id);
CREATE INDEX IF NOT EXISTS idx_plan_entitlements_active ON plan_entitlements(user_id, risk_level) WHERE expires_at > NOW();
CREATE INDEX IF NOT EXISTS idx_plan_entitlements_source ON plan_entitlements(source_event_id);

-- ============================================================================
-- 15. task_geofence_events
--     Source: services/GeofenceService.ts
--     Records proximity/geofence events for task locations
-- ============================================================================
CREATE TABLE IF NOT EXISTS task_geofence_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id          UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type       VARCHAR(20) NOT NULL CHECK (event_type IN ('ENTER', 'EXIT', 'DWELL')),
  location_lat     DECIMAL(10, 8) NOT NULL,
  location_lng     DECIMAL(11, 8) NOT NULL,
  distance_meters  NUMERIC NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_task_geofence_events_task_user ON task_geofence_events(task_id, user_id);
CREATE INDEX IF NOT EXISTS idx_task_geofence_events_task_created ON task_geofence_events(task_id, created_at);

-- ============================================================================
-- 16. Add price_modifier_percent to users (for DynamicPricingService)
-- ============================================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS price_modifier_percent NUMERIC DEFAULT 0;
