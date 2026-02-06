-- Migration: Fraud Detection Events
-- Version: 1.8.0
-- Date: 2026-02-06
-- Purpose: Track impossible travel, GPS spoofing, and other fraud patterns

-- Fraud detection events (impossible travel, GPS spoofing, etc.)
CREATE TABLE IF NOT EXISTS fraud_detection_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),

  event_type TEXT NOT NULL CHECK (event_type IN (
    'impossible_travel',
    'gps_spoofing',
    'deepfake_detected',
    'time_manipulation',
    'device_fingerprint_mismatch'
  )),

  severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),

  -- Event details
  task_id UUID REFERENCES tasks(id),
  proof_id UUID REFERENCES proofs(id),

  evidence JSONB NOT NULL, -- Event-specific evidence

  -- Location data (for impossible travel)
  location_a POINT,
  location_b POINT,
  time_a TIMESTAMPTZ,
  time_b TIMESTAMPTZ,
  distance_km DECIMAL(10,2),
  time_delta_seconds INTEGER,

  -- Action taken
  action_taken TEXT, -- 'flagged', 'suspended', 'banned', 'cleared'
  reviewed_by UUID REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX idx_fraud_events_user ON fraud_detection_events(user_id);
CREATE INDEX idx_fraud_events_type ON fraud_detection_events(event_type);
CREATE INDEX idx_fraud_events_severity ON fraud_detection_events(severity);
CREATE INDEX idx_fraud_events_created_at ON fraud_detection_events(created_at DESC);
CREATE INDEX idx_fraud_events_action_taken ON fraud_detection_events(action_taken) WHERE action_taken IS NOT NULL;
CREATE INDEX idx_fraud_events_unreviewed ON fraud_detection_events(severity, reviewed_by) WHERE reviewed_by IS NULL;

-- Spatial index for location queries
CREATE INDEX IF NOT EXISTS idx_fraud_events_location_a ON fraud_detection_events USING GIST (location_a);
CREATE INDEX IF NOT EXISTS idx_fraud_events_location_b ON fraud_detection_events USING GIST (location_b);

-- Comments for documentation
COMMENT ON TABLE fraud_detection_events IS 'Audit log for detected fraud patterns (impossible travel, GPS spoofing, etc.)';
COMMENT ON COLUMN fraud_detection_events.event_type IS 'Type of fraud detected. See LOGISTICS_AGENT_SPEC_LOCKED.md for definitions.';
COMMENT ON COLUMN fraud_detection_events.severity IS 'low=minor flag, medium=review required, high=suspend, critical=ban';
COMMENT ON COLUMN fraud_detection_events.evidence IS 'JSON object with event-specific data (speed_kmh, accuracy_delta, etc.)';
COMMENT ON COLUMN fraud_detection_events.location_a IS 'Starting location (for impossible travel detection)';
COMMENT ON COLUMN fraud_detection_events.location_b IS 'Ending location (for impossible travel detection)';
COMMENT ON COLUMN fraud_detection_events.distance_km IS 'Haversine distance between location_a and location_b';
COMMENT ON COLUMN fraud_detection_events.time_delta_seconds IS 'Time elapsed between location_a and location_b';
COMMENT ON COLUMN fraud_detection_events.action_taken IS 'Action taken by system or admin';
