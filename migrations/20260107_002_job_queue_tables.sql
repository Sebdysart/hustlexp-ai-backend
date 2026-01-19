-- BUILD_GUIDE Phase 4: Job Queue Tables
-- Database-backed job queue for serverless compatibility
-- Run this migration to enable background job processing

-- ============================================================================
-- JOB QUEUE TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS job_queue (
  id VARCHAR(255) PRIMARY KEY,
  type VARCHAR(50) NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'processing', 'completed', 'failed', 'dead'
  )),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  priority INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_job_queue_status ON job_queue(status);
CREATE INDEX IF NOT EXISTS idx_job_queue_scheduled ON job_queue(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_job_queue_type ON job_queue(type);
CREATE INDEX IF NOT EXISTS idx_job_queue_pending ON job_queue(status, scheduled_at) 
  WHERE status = 'pending';

-- ============================================================================
-- STRIPE EVENTS TABLE (FIX 2 from BUILD_GUIDE)
-- ============================================================================

CREATE TABLE IF NOT EXISTS stripe_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_event_id VARCHAR(255) NOT NULL,
  event_type VARCHAR(100) NOT NULL,
  payload JSONB NOT NULL,
  processed_at TIMESTAMPTZ,
  processing_error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- Idempotency: Each Stripe event processed exactly once
  CONSTRAINT unique_stripe_event UNIQUE (stripe_event_id)
);

CREATE INDEX IF NOT EXISTS idx_stripe_events_type ON stripe_events(event_type);
CREATE INDEX IF NOT EXISTS idx_stripe_events_processed ON stripe_events(processed_at);
CREATE INDEX IF NOT EXISTS idx_stripe_events_created ON stripe_events(created_at);

-- ============================================================================
-- NOTIFICATIONS TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  type VARCHAR(50) NOT NULL,
  title VARCHAR(255) NOT NULL,
  body TEXT,
  data JSONB DEFAULT '{}',
  read BOOLEAN NOT NULL DEFAULT false,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(user_id, read) 
  WHERE read = false;
CREATE INDEX IF NOT EXISTS idx_notifications_type ON notifications(type);

-- ============================================================================
-- ADMIN ROLES TABLE (FIX 5 from BUILD_GUIDE)
-- ============================================================================

CREATE TABLE IF NOT EXISTS admin_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  role VARCHAR(50) NOT NULL CHECK (role IN (
    'founder',
    'lead_engineer',
    'trust_officer',
    'support_lead'
  )),
  granted_by UUID REFERENCES users(id),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  
  -- One active role per user per type
  CONSTRAINT unique_active_role UNIQUE (user_id, role)
);

CREATE INDEX IF NOT EXISTS idx_admin_roles_user ON admin_roles(user_id);
CREATE INDEX IF NOT EXISTS idx_admin_roles_active ON admin_roles(user_id) 
  WHERE revoked_at IS NULL;

-- ============================================================================
-- ADMIN ACTIONS LOG
-- ============================================================================

CREATE TABLE IF NOT EXISTS admin_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id UUID NOT NULL REFERENCES users(id),
  action_type VARCHAR(100) NOT NULL,
  target_type VARCHAR(50) NOT NULL,
  target_id UUID,
  reason TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_actions_admin ON admin_actions(admin_id);
CREATE INDEX IF NOT EXISTS idx_admin_actions_target ON admin_actions(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_admin_actions_created ON admin_actions(created_at);

-- ============================================================================
-- JOB PROCESSING FUNCTION (for cron)
-- ============================================================================

-- Function to get jobs that are ready to process
CREATE OR REPLACE FUNCTION get_pending_jobs(batch_size INTEGER DEFAULT 10)
RETURNS SETOF job_queue AS $$
BEGIN
  RETURN QUERY
  SELECT *
  FROM job_queue
  WHERE status = 'pending'
    AND scheduled_at <= NOW()
    AND attempts < max_attempts
  ORDER BY priority DESC, scheduled_at ASC
  LIMIT batch_size
  FOR UPDATE SKIP LOCKED;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- CLEANUP FUNCTION
-- ============================================================================

-- Function to clean up old completed jobs
CREATE OR REPLACE FUNCTION cleanup_old_jobs(older_than_days INTEGER DEFAULT 7)
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM job_queue
  WHERE status IN ('completed', 'dead')
    AND completed_at < NOW() - (older_than_days || ' days')::INTERVAL;
  
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- MIGRATION COMPLETE
-- ============================================================================

-- Log migration
INSERT INTO schema_migrations (version, name, applied_at)
VALUES ('20260107_002', 'job_queue_tables', NOW())
ON CONFLICT (version) DO NOTHING;
