-- Phase 14E: Counterfactual Simulations
-- Control Plane - ADVISORY ONLY

-- Stores simulation results for AI recommendations
CREATE TABLE IF NOT EXISTS counterfactual_simulations (
    id TEXT PRIMARY KEY,
    recommendation_id TEXT NOT NULL REFERENCES ai_recommendations(id),
    verdict TEXT NOT NULL CHECK (verdict IN (
        'STRONGLY_POSITIVE', 'POSITIVE', 'NEUTRAL', 
        'NEGATIVE', 'STRONGLY_NEGATIVE', 'INSUFFICIENT_DATA'
    )),
    confidence DECIMAL(3,2) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    snapshots_analyzed INTEGER NOT NULL DEFAULT 0,
    data JSONB NOT NULL,
    simulated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_simulations_recommendation 
    ON counterfactual_simulations(recommendation_id);
CREATE INDEX IF NOT EXISTS idx_simulations_verdict 
    ON counterfactual_simulations(verdict);
CREATE INDEX IF NOT EXISTS idx_simulations_time 
    ON counterfactual_simulations(simulated_at DESC);
CREATE INDEX IF NOT EXISTS idx_simulations_negative 
    ON counterfactual_simulations(verdict) 
    WHERE verdict IN ('NEGATIVE', 'STRONGLY_NEGATIVE');

-- Comments
COMMENT ON TABLE counterfactual_simulations IS 'Control Plane: What-if analysis for AI recommendations';
COMMENT ON COLUMN counterfactual_simulations.verdict IS 'Predicted net impact of implementing the recommendation';
COMMENT ON COLUMN counterfactual_simulations.confidence IS 'Confidence in prediction based on data availability';
COMMENT ON COLUMN counterfactual_simulations.data IS 'Full simulation result including baseline vs projected metrics';
