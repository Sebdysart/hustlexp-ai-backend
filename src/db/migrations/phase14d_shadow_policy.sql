-- Phase 14D-2: Shadow Policy Logging Tables
-- Control Plane - SHADOW MODE ONLY

-- Shadow policy evaluations (what WOULD we do)
CREATE TABLE IF NOT EXISTS shadow_policy_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    evaluation_id TEXT NOT NULL UNIQUE,
    task_id TEXT NOT NULL,
    enforced_policy JSONB NOT NULL,
    shadow_policy JSONB NOT NULL,
    delta TEXT NOT NULL CHECK (delta IN ('SAME', 'MORE_STRICT', 'LESS_STRICT')),
    delta_details JSONB NOT NULL DEFAULT '[]',
    risk_tier TEXT NOT NULL CHECK (risk_tier IN ('minimal', 'low', 'medium', 'high', 'critical')),
    combined_risk INTEGER NOT NULL CHECK (combined_risk >= 0 AND combined_risk <= 100),
    recommendation TEXT,
    confidence DECIMAL(3,2) NOT NULL,
    evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Shadow outcome logs (counterfactual history)
CREATE TABLE IF NOT EXISTS shadow_outcome_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id TEXT NOT NULL,
    enforced_policy JSONB NOT NULL,
    shadow_policy JSONB NOT NULL,
    proof_outcome TEXT NOT NULL CHECK (proof_outcome IN ('not_required', 'submitted', 'verified', 'rejected', 'expired')),
    dispute_outcome TEXT NOT NULL CHECK (dispute_outcome IN ('none', 'opened', 'refunded', 'upheld')),
    payout_delay_hours DECIMAL(8,2) NOT NULL DEFAULT 0,
    would_have_differed BOOLEAN NOT NULL DEFAULT FALSE,
    potential_benefit TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for analysis
CREATE INDEX IF NOT EXISTS idx_shadow_policy_task 
    ON shadow_policy_log(task_id);
CREATE INDEX IF NOT EXISTS idx_shadow_policy_delta 
    ON shadow_policy_log(delta);
CREATE INDEX IF NOT EXISTS idx_shadow_policy_tier 
    ON shadow_policy_log(risk_tier);
CREATE INDEX IF NOT EXISTS idx_shadow_policy_time 
    ON shadow_policy_log(evaluated_at DESC);

CREATE INDEX IF NOT EXISTS idx_shadow_outcome_task 
    ON shadow_outcome_log(task_id);
CREATE INDEX IF NOT EXISTS idx_shadow_outcome_differed 
    ON shadow_outcome_log(would_have_differed) WHERE would_have_differed = TRUE;
CREATE INDEX IF NOT EXISTS idx_shadow_outcome_disputes 
    ON shadow_outcome_log(dispute_outcome) WHERE dispute_outcome != 'none';

-- Comments
COMMENT ON TABLE shadow_policy_log IS 'Control Plane: What policy WOULD apply vs what IS applied';
COMMENT ON TABLE shadow_outcome_log IS 'Control Plane: Counterfactual history - what would have happened';
COMMENT ON COLUMN shadow_outcome_log.would_have_differed IS 'TRUE if shadow policy would have changed the outcome';
COMMENT ON COLUMN shadow_outcome_log.potential_benefit IS 'Human-readable description of what could have been better';
