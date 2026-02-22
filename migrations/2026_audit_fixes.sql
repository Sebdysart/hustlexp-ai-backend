-- ============================================================================
-- HustleXP Audit Fix Migrations
-- Date: 2026-02-21
-- Purpose: Address forensic audit findings for COPPA, GDPR breach, AI cost
-- ============================================================================

-- --------------------------------------------------------------------------
-- 1. COPPA AGE VERIFICATION (AUDIT FIX)
-- Add date_of_birth and is_minor columns to users table
-- --------------------------------------------------------------------------

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS date_of_birth DATE,
  ADD COLUMN IF NOT EXISTS is_minor BOOLEAN DEFAULT FALSE;

-- Index for minor user queries (compliance reporting)
CREATE INDEX IF NOT EXISTS idx_users_is_minor ON users (is_minor) WHERE is_minor = TRUE;

COMMENT ON COLUMN users.date_of_birth IS 'COPPA compliance: User date of birth for age verification';
COMMENT ON COLUMN users.is_minor IS 'COPPA compliance: TRUE if user is 13-17 years old';

-- --------------------------------------------------------------------------
-- 2. GDPR BREACH NOTIFICATION TABLE (AUDIT FIX - Article 33)
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS breach_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  description TEXT NOT NULL,
  affected_users_count INTEGER NOT NULL DEFAULT 0,
  data_types_affected TEXT[] NOT NULL DEFAULT '{}',
  authority_notified_at TIMESTAMPTZ,
  users_notified_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'detected' CHECK (status IN (
    'detected', 'investigating', 'contained',
    'authority_notified', 'users_notified', 'closed'
  )),
  reporter_id UUID REFERENCES users(id),
  deadline TIMESTAMPTZ NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_breach_status ON breach_notifications (status);
CREATE INDEX IF NOT EXISTS idx_breach_severity ON breach_notifications (severity);
CREATE INDEX IF NOT EXISTS idx_breach_deadline ON breach_notifications (deadline);
CREATE INDEX IF NOT EXISTS idx_breach_reporter ON breach_notifications (reporter_id);

COMMENT ON TABLE breach_notifications IS 'GDPR Article 33: Breach notification tracking with 72-hour deadline';

-- --------------------------------------------------------------------------
-- 3. AI COST LOGS TABLE (AUDIT FIX - Cost Dashboard)
-- Ensure the ai_cost_logs table exists for cost tracking
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ai_cost_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_type TEXT NOT NULL,
  user_id UUID NOT NULL,
  provider TEXT NOT NULL,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  estimated_cost_cents INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_cost_logs_agent ON ai_cost_logs (agent_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_cost_logs_user ON ai_cost_logs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_cost_logs_provider ON ai_cost_logs (provider, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_cost_logs_daily ON ai_cost_logs (created_at DESC);

COMMENT ON TABLE ai_cost_logs IS 'AI cost tracking for per-agent, per-user, per-provider spend monitoring';
