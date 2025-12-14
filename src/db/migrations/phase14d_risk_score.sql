-- Phase 14D-1: Risk Score Log Table
-- Part of the Control Plane - READ ONLY logging for learning

-- Risk score evaluation log
-- Every risk assessment is recorded for model improvement
CREATE TABLE IF NOT EXISTS risk_score_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    evaluation_id TEXT NOT NULL UNIQUE,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('user', 'task')),
    entity_id TEXT NOT NULL,
    score INTEGER NOT NULL CHECK (score >= 0 AND score <= 100),
    tier TEXT NOT NULL CHECK (tier IN ('minimal', 'low', 'medium', 'high', 'critical')),
    confidence DECIMAL(3,2) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    reasons JSONB NOT NULL DEFAULT '[]',
    evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for analysis queries
CREATE INDEX IF NOT EXISTS idx_risk_score_entity 
    ON risk_score_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_risk_score_tier 
    ON risk_score_log(tier);
CREATE INDEX IF NOT EXISTS idx_risk_score_time 
    ON risk_score_log(evaluated_at DESC);
CREATE INDEX IF NOT EXISTS idx_risk_score_high_risk 
    ON risk_score_log(score) WHERE score >= 50;

-- Comments
COMMENT ON TABLE risk_score_log IS 'Control Plane: Risk score evaluation history for learning loop';
COMMENT ON COLUMN risk_score_log.entity_type IS 'Type of entity scored: user or task';
COMMENT ON COLUMN risk_score_log.tier IS 'Risk tier: minimal, low, medium, high, critical';
COMMENT ON COLUMN risk_score_log.reasons IS 'Explainable factors that contributed to the score';
