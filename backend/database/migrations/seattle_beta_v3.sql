-- ============================================================================
-- SEATTLE BETA v3.0.0 MIGRATION
-- Controlled revenue validation test: 100 users, 200 tasks, $10K GMV, 30 days
-- ============================================================================
-- Adds columns and indexes needed for beta tracking.
-- Safe to re-run (IF NOT EXISTS / idempotent).
-- ============================================================================

-- ============================================================================
-- 1. TASK LOCATION TIMESTAMPS
-- ============================================================================
-- Track when tasks are accepted and completed (for beta timing metrics).
-- These may already exist; ADD COLUMN IF NOT EXISTS makes it safe.

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

-- Auto-set accepted_at when task transitions to ACCEPTED
CREATE OR REPLACE FUNCTION trg_task_set_accepted_at()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.state = 'ACCEPTED' AND OLD.state != 'ACCEPTED' AND NEW.accepted_at IS NULL THEN
    NEW.accepted_at = NOW();
  END IF;
  IF NEW.state = 'COMPLETED' AND OLD.state != 'COMPLETED' AND NEW.completed_at IS NULL THEN
    NEW.completed_at = NOW();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop and recreate to ensure latest version
DROP TRIGGER IF EXISTS trg_task_timestamps ON tasks;
CREATE TRIGGER trg_task_timestamps
  BEFORE UPDATE ON tasks
  FOR EACH ROW
  EXECUTE FUNCTION trg_task_set_accepted_at();

-- ============================================================================
-- 2. USER SUBSCRIPTION TIER (for conversion-to-paid metric)
-- ============================================================================
-- Track subscription tier directly on users table for fast queries.
-- Canonical source remains the subscription service, but this denormalized
-- column enables efficient beta dashboard queries.

ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_tier VARCHAR(20) DEFAULT 'free';

-- ============================================================================
-- 3. ADMIN ROLES TABLE (for admin auth middleware)
-- ============================================================================
-- If not already created, create the admin_roles table referenced by trpc.ts

CREATE TABLE IF NOT EXISTS admin_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  role VARCHAR(50) NOT NULL DEFAULT 'admin',
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  granted_by UUID REFERENCES users(id),
  UNIQUE(user_id)
);

-- ============================================================================
-- 4. INDEXES FOR BETA DASHBOARD QUERIES
-- ============================================================================

-- Task state + created_at for daily task count queries
CREATE INDEX IF NOT EXISTS idx_tasks_state_created ON tasks(state, created_at DESC);

-- Task completed_at for completion timing queries
CREATE INDEX IF NOT EXISTS idx_tasks_completed_at ON tasks(completed_at DESC) WHERE completed_at IS NOT NULL;

-- Task accepted_at for acceptance timing queries
CREATE INDEX IF NOT EXISTS idx_tasks_accepted_at ON tasks(accepted_at DESC) WHERE accepted_at IS NOT NULL;

-- Task poster_id for repeat poster queries
CREATE INDEX IF NOT EXISTS idx_tasks_poster_id ON tasks(poster_id);

-- Task worker_id for repeat hustler queries
CREATE INDEX IF NOT EXISTS idx_tasks_worker_id ON tasks(worker_id) WHERE worker_id IS NOT NULL;

-- Task latitude/longitude for geo-fence filtering
CREATE INDEX IF NOT EXISTS idx_tasks_lat_lng ON tasks(latitude, longitude) WHERE latitude IS NOT NULL;

-- User subscription_tier for conversion metrics
CREATE INDEX IF NOT EXISTS idx_users_subscription_tier ON users(subscription_tier) WHERE subscription_tier != 'free';

-- Revenue ledger created_at for time-series queries
CREATE INDEX IF NOT EXISTS idx_revenue_ledger_created ON revenue_ledger(created_at DESC);

-- ============================================================================
-- 5. VALIDATION CHECK (run manually)
-- ============================================================================
-- SELECT
--   (SELECT COUNT(*) FROM tasks WHERE accepted_at IS NOT NULL) as tasks_with_accepted_at,
--   (SELECT COUNT(*) FROM tasks WHERE completed_at IS NOT NULL) as tasks_with_completed_at,
--   (SELECT COUNT(*) FROM admin_roles) as admin_count,
--   (SELECT COUNT(*) FROM users WHERE subscription_tier != 'free') as paid_users;
