-- BUILD_GUIDE Phase 6: Production Hardening Tables
-- Monitoring, alerting, and operational tables

-- ============================================================================
-- ALERTS TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS alerts (
  id VARCHAR(255) PRIMARY KEY,
  type VARCHAR(100) NOT NULL,
  severity VARCHAR(20) NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  title VARCHAR(500) NOT NULL,
  message TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acknowledged BOOLEAN NOT NULL DEFAULT false,
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by VARCHAR(255)
);

CREATE INDEX IF NOT EXISTS idx_alerts_unacknowledged ON alerts(acknowledged, severity)
  WHERE acknowledged = false;
CREATE INDEX IF NOT EXISTS idx_alerts_timestamp ON alerts(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_type ON alerts(type);

-- ============================================================================
-- INVARIANT VIOLATIONS TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS invariant_violations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invariant_id VARCHAR(50) NOT NULL,
  details TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invariant_violations_id ON invariant_violations(invariant_id);
CREATE INDEX IF NOT EXISTS idx_invariant_violations_created ON invariant_violations(created_at DESC);

-- ============================================================================
-- PAYMENT FAILURES TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS payment_failures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID REFERENCES tasks(id),
  error TEXT NOT NULL,
  stripe_error_code VARCHAR(100),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_failures_task ON payment_failures(task_id);
CREATE INDEX IF NOT EXISTS idx_payment_failures_created ON payment_failures(created_at DESC);

-- ============================================================================
-- METRICS SNAPSHOTS TABLE (for historical analysis)
-- ============================================================================

CREATE TABLE IF NOT EXISTS metrics_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  error_rate DECIMAL(5,2),
  response_time_p95 INTEGER,
  payment_failures_hourly INTEGER,
  dispute_rate DECIMAL(5,2),
  invariant_violations INTEGER,
  db_healthy BOOLEAN,
  webhook_delivery_rate DECIMAL(5,2),
  active_tasks INTEGER,
  pending_payouts INTEGER,
  queue_depth INTEGER
);

CREATE INDEX IF NOT EXISTS idx_metrics_timestamp ON metrics_snapshots(timestamp DESC);

-- ============================================================================
-- SYSTEM EVENTS TABLE (for audit)
-- ============================================================================

CREATE TABLE IF NOT EXISTS system_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type VARCHAR(100) NOT NULL,
  source VARCHAR(100) NOT NULL,
  data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_system_events_type ON system_events(event_type);
CREATE INDEX IF NOT EXISTS idx_system_events_created ON system_events(created_at DESC);

-- ============================================================================
-- CLEANUP FUNCTION
-- ============================================================================

-- Clean up old metrics snapshots (keep 30 days)
CREATE OR REPLACE FUNCTION cleanup_old_metrics(older_than_days INTEGER DEFAULT 30)
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM metrics_snapshots
  WHERE timestamp < NOW() - (older_than_days || ' days')::INTERVAL;
  
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- Clean up old acknowledged alerts (keep 7 days)
CREATE OR REPLACE FUNCTION cleanup_old_alerts(older_than_days INTEGER DEFAULT 7)
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM alerts
  WHERE acknowledged = true
    AND acknowledged_at < NOW() - (older_than_days || ' days')::INTERVAL;
  
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- MIGRATION COMPLETE
-- ============================================================================

INSERT INTO schema_migrations (version, name, applied_at)
VALUES ('20260107_003', 'production_hardening_tables', NOW())
ON CONFLICT (version) DO NOTHING;
