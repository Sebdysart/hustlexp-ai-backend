-- Alpha Telemetry Table
-- Trust-system telemetry for detecting leaks, confusion, abuse vectors, and silent failure.

CREATE TABLE IF NOT EXISTS alpha_telemetry (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_group VARCHAR(50) NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL CHECK (role IN ('hustler', 'poster')),
  state VARCHAR(50),
  trust_tier SMALLINT,
  location_radius_miles DECIMAL(5, 2),
  instant_mode_enabled BOOLEAN,
  task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  trigger_state VARCHAR(50),
  time_since_completion_seconds INTEGER,
  reason_selected VARCHAR(100),
  time_on_screen_ms INTEGER,
  exit_type VARCHAR(50),
  submitted BOOLEAN,
  rejected_by_guard BOOLEAN,
  cooldown_hit BOOLEAN,
  attempt_number SMALLINT CHECK (attempt_number IN (1, 2)),
  proof_type VARCHAR(50),
  gps_verified BOOLEAN,
  verification_result VARCHAR(20) CHECK (verification_result IN ('pass', 'fail')),
  failure_reason TEXT,
  resolved BOOLEAN,
  xp_released BOOLEAN,
  escrow_released BOOLEAN,
  delta_type VARCHAR(20) CHECK (delta_type IN ('xp', 'tier', 'streak')),
  delta_amount INTEGER,
  reason_code VARCHAR(100),
  metadata JSONB DEFAULT '{}'::jsonb,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for query performance
CREATE INDEX idx_alpha_telemetry_event_group ON alpha_telemetry(event_group);
CREATE INDEX idx_alpha_telemetry_user_id ON alpha_telemetry(user_id);
CREATE INDEX idx_alpha_telemetry_state ON alpha_telemetry(state) WHERE state IS NOT NULL;
CREATE INDEX idx_alpha_telemetry_timestamp ON alpha_telemetry(timestamp DESC);
CREATE INDEX idx_alpha_telemetry_task_id ON alpha_telemetry(task_id) WHERE task_id IS NOT NULL;

-- Composite indexes for common queries
CREATE INDEX idx_alpha_telemetry_edge_states ON alpha_telemetry(event_group, state, timestamp DESC) 
  WHERE event_group IN ('edge_state_impression', 'edge_state_exit');
CREATE INDEX idx_alpha_telemetry_disputes ON alpha_telemetry(event_group, task_id, timestamp DESC) 
  WHERE event_group IN ('dispute_entry_attempt', 'dispute_submission_result');
CREATE INDEX idx_alpha_telemetry_proofs ON alpha_telemetry(event_group, task_id, timestamp DESC) 
  WHERE event_group IN ('proof_submission', 'proof_correction_outcome');
CREATE INDEX idx_alpha_telemetry_trust_deltas ON alpha_telemetry(event_group, user_id, timestamp DESC) 
  WHERE event_group = 'trust_delta_applied';

COMMENT ON TABLE alpha_telemetry IS 'Alpha instrumentation telemetry for trust-system behavior analysis';
COMMENT ON COLUMN alpha_telemetry.event_group IS 'Event group: edge_state_impression, edge_state_exit, dispute_entry_attempt, dispute_submission_result, proof_submission, proof_correction_outcome, trust_delta_applied';
COMMENT ON COLUMN alpha_telemetry.state IS 'Edge state type: E1_NO_TASKS_AVAILABLE, E2_ELIGIBILITY_MISMATCH, E3_TRUST_TIER_LOCKED';
COMMENT ON COLUMN alpha_telemetry.metadata IS 'Additional event-specific data in JSON format';
