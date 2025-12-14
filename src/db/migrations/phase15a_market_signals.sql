-- Phase 15A: Market Signal Engine
-- Dominance Layer - READ-ONLY INTELLIGENCE

-- Market snapshots (competitive intelligence)
CREATE TABLE IF NOT EXISTS market_snapshots (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL,
    generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_market_snapshots_time 
    ON market_snapshots(generated_at DESC);

-- Comments
COMMENT ON TABLE market_snapshots IS 'Market Intelligence: Competitive position snapshots';
COMMENT ON COLUMN market_snapshots.data IS 'Full market snapshot with category, geo, pricing, and trust signals';
