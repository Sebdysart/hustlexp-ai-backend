-- ============================================================================
-- HustleXP Audit Log Table
-- Stores audit trail for compliance, security, and admin operations
-- ============================================================================

CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  details JSONB NOT NULL DEFAULT '{}',
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- User audit history
CREATE INDEX idx_audit_log_user_id ON audit_log(user_id, created_at DESC);

-- Action type filtering
CREATE INDEX idx_audit_log_action ON audit_log(action, created_at DESC);

-- Resource audit trail
CREATE INDEX idx_audit_log_resource ON audit_log(resource_type, resource_id, created_at DESC);

-- Cleanup: auto-delete audit logs older than 1 year (optional, apply manually)
-- DELETE FROM audit_log WHERE created_at < NOW() - INTERVAL '1 year';
