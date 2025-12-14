-- Phase 15C-1: Flywheel Feedback Surfaces
-- APPEND-ONLY tables for feedback loops

-- ============================================================
-- FLYWHEEL 1: Pricing Feedback (Posters)
-- ============================================================

CREATE TABLE IF NOT EXISTS pricing_feedback_events (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    category TEXT NOT NULL,
    zone TEXT,
    verdict TEXT NOT NULL CHECK (verdict IN ('underpriced', 'optimal', 'overpriced')),
    delta_percent DECIMAL(10,2) NOT NULL,
    data JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_pricing_feedback_task ON pricing_feedback_events(task_id);
CREATE INDEX IF NOT EXISTS idx_pricing_feedback_verdict ON pricing_feedback_events(verdict);
CREATE INDEX IF NOT EXISTS idx_pricing_feedback_time ON pricing_feedback_events(created_at DESC);

COMMENT ON TABLE pricing_feedback_events IS 'Flywheel 1: Pricing consequences for posters - APPEND-ONLY';

-- ============================================================
-- FLYWHEEL 2: Performance Feedback (Hustlers)
-- ============================================================

CREATE TABLE IF NOT EXISTS performance_feedback_events (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    category TEXT NOT NULL,
    zone TEXT,
    reputation_impact TEXT NOT NULL CHECK (reputation_impact IN ('positive', 'neutral', 'negative')),
    data JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_performance_feedback_user ON performance_feedback_events(user_id);
CREATE INDEX IF NOT EXISTS idx_performance_feedback_task ON performance_feedback_events(task_id);
CREATE INDEX IF NOT EXISTS idx_performance_feedback_impact ON performance_feedback_events(reputation_impact);
CREATE INDEX IF NOT EXISTS idx_performance_feedback_time ON performance_feedback_events(created_at DESC);

COMMENT ON TABLE performance_feedback_events IS 'Flywheel 2: Performance benefits for hustlers - APPEND-ONLY';

-- ============================================================
-- FLYWHEEL 3: Trust Feedback (All Users)
-- ============================================================

CREATE TABLE IF NOT EXISTS trust_feedback_events (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    user_role TEXT NOT NULL CHECK (user_role IN ('poster', 'hustler')),
    friction_level TEXT NOT NULL CHECK (friction_level IN ('minimal', 'standard', 'elevated', 'high')),
    risk_tier TEXT NOT NULL,
    data JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trust_feedback_task ON trust_feedback_events(task_id);
CREATE INDEX IF NOT EXISTS idx_trust_feedback_user ON trust_feedback_events(user_id);
CREATE INDEX IF NOT EXISTS idx_trust_feedback_level ON trust_feedback_events(friction_level);
CREATE INDEX IF NOT EXISTS idx_trust_feedback_time ON trust_feedback_events(created_at DESC);

COMMENT ON TABLE trust_feedback_events IS 'Flywheel 3: Friction explanation for users - APPEND-ONLY';

-- ============================================================
-- FLYWHEEL 4: Operator Learning
-- ============================================================

CREATE TABLE IF NOT EXISTS operator_learning_events (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL CHECK (event_type IN ('recommendation_review', 'override', 'dispute_resolution', 'policy_decision')),
    entity_id TEXT NOT NULL,
    operator_id TEXT NOT NULL,
    agreement TEXT NOT NULL CHECK (agreement IN ('full', 'partial', 'disagreement')),
    data JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_operator_learning_type ON operator_learning_events(event_type);
CREATE INDEX IF NOT EXISTS idx_operator_learning_operator ON operator_learning_events(operator_id);
CREATE INDEX IF NOT EXISTS idx_operator_learning_agreement ON operator_learning_events(agreement);
CREATE INDEX IF NOT EXISTS idx_operator_learning_time ON operator_learning_events(created_at DESC);

COMMENT ON TABLE operator_learning_events IS 'Flywheel 4: AI vs Human learning - APPEND-ONLY';
