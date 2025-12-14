-- Phase 14D: Control Plane Schema
-- Immutable snapshots + AI recommendation lifecycle

-- ============================================================
-- ANALYSIS SNAPSHOTS (Immutable, Versioned)
-- ============================================================

CREATE TABLE IF NOT EXISTS analysis_snapshots (
    id TEXT PRIMARY KEY,
    schema_version TEXT NOT NULL,
    snapshot_type TEXT NOT NULL CHECK (snapshot_type IN ('hourly', 'daily', 'manual')),
    data JSONB NOT NULL,
    period_start TIMESTAMPTZ NOT NULL,
    period_end TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_snapshots_type 
    ON analysis_snapshots(snapshot_type);
CREATE INDEX IF NOT EXISTS idx_snapshots_created 
    ON analysis_snapshots(created_at DESC);

COMMENT ON TABLE analysis_snapshots IS 'Control Plane: Immutable system state snapshots for AI analysis';
COMMENT ON COLUMN analysis_snapshots.schema_version IS 'Schema version for forward compatibility';
COMMENT ON COLUMN analysis_snapshots.data IS 'Full snapshot JSON (immutable after creation)';

-- ============================================================
-- AI RECOMMENDATIONS (State Machine)
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_recommendations (
    id TEXT PRIMARY KEY,
    snapshot_id TEXT NOT NULL REFERENCES analysis_snapshots(id),
    type TEXT NOT NULL CHECK (type IN (
        'risk_weight_tuning',
        'proof_threshold_adjustment', 
        'trust_tier_boundary',
        'metrics_threshold_adjustment',
        'ux_friction_adjustment',
        'other'
    )),
    status TEXT NOT NULL CHECK (status IN (
        'received', 'reviewed', 'accepted', 'rejected', 'archived'
    )) DEFAULT 'received',
    is_valid BOOLEAN NOT NULL DEFAULT TRUE,
    data JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_recommendations_status 
    ON ai_recommendations(status);
CREATE INDEX IF NOT EXISTS idx_recommendations_snapshot 
    ON ai_recommendations(snapshot_id);
CREATE INDEX IF NOT EXISTS idx_recommendations_pending 
    ON ai_recommendations(status) WHERE status IN ('received', 'reviewed');

COMMENT ON TABLE ai_recommendations IS 'Control Plane: AI-generated recommendations requiring human approval';
COMMENT ON COLUMN ai_recommendations.status IS 'State machine: received → reviewed → accepted/rejected → archived';
COMMENT ON COLUMN ai_recommendations.is_valid IS 'FALSE if auto-rejected due to forbidden target';

-- ============================================================
-- AI RECOMMENDATION AUDIT (Full Trail)
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_recommendation_audit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recommendation_id TEXT NOT NULL REFERENCES ai_recommendations(id),
    action TEXT NOT NULL,
    actor TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_rec_audit_recommendation 
    ON ai_recommendation_audit(recommendation_id);
CREATE INDEX IF NOT EXISTS idx_rec_audit_action 
    ON ai_recommendation_audit(action);
CREATE INDEX IF NOT EXISTS idx_rec_audit_time 
    ON ai_recommendation_audit(created_at DESC);

COMMENT ON TABLE ai_recommendation_audit IS 'Control Plane: Full audit trail for all recommendation state changes';
COMMENT ON COLUMN ai_recommendation_audit.actor IS 'Who performed the action (user ID or "system")';
