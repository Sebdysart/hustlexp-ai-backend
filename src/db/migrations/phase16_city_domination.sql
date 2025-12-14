-- Phase 16: City Domination Engine
-- Tables for urban control layer

-- ============================================================
-- CITY GRID CELLS
-- ============================================================

CREATE TABLE IF NOT EXISTS city_grid_cells (
    id TEXT PRIMARY KEY,
    city TEXT NOT NULL,
    zone TEXT NOT NULL,
    micro_zone TEXT NOT NULL,
    supply_index INT NOT NULL,
    demand_index INT NOT NULL,
    liquidity_ratio DECIMAL(5,2) NOT NULL,
    fulfillment_latency_hours DECIMAL(5,2),
    completion_rate DECIMAL(5,4),
    dispute_rate DECIMAL(5,4),
    churn_risk INT,
    data JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_city_grid_city ON city_grid_cells(city);
CREATE INDEX IF NOT EXISTS idx_city_grid_zone ON city_grid_cells(zone);
CREATE INDEX IF NOT EXISTS idx_city_grid_micro ON city_grid_cells(city, zone, micro_zone);

COMMENT ON TABLE city_grid_cells IS 'Phase 16: Micro-zone grid for city domination';

-- ============================================================
-- LIQUIDITY HEAT SNAPSHOTS
-- ============================================================

CREATE TABLE IF NOT EXISTS liquidity_heat_snapshots (
    id TEXT PRIMARY KEY,
    city TEXT NOT NULL,
    avg_heat INT NOT NULL,
    data JSONB NOT NULL,
    generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_liquidity_heat_city ON liquidity_heat_snapshots(city);
CREATE INDEX IF NOT EXISTS idx_liquidity_heat_time ON liquidity_heat_snapshots(generated_at DESC);

COMMENT ON TABLE liquidity_heat_snapshots IS 'Phase 16: Market liquidity heat maps';

-- ============================================================
-- OPPORTUNITY BURSTS
-- ============================================================

CREATE TABLE IF NOT EXISTS opportunity_bursts (
    id TEXT PRIMARY KEY,
    city TEXT NOT NULL,
    zone TEXT NOT NULL,
    type TEXT NOT NULL,
    urgency TEXT NOT NULL,
    data JSONB NOT NULL,
    viewed BOOLEAN DEFAULT FALSE,
    viewed_at TIMESTAMPTZ,
    acted_on BOOLEAN DEFAULT FALSE,
    acted_on_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bursts_city_zone ON opportunity_bursts(city, zone);
CREATE INDEX IF NOT EXISTS idx_bursts_type ON opportunity_bursts(type);
CREATE INDEX IF NOT EXISTS idx_bursts_urgency ON opportunity_bursts(urgency);
CREATE INDEX IF NOT EXISTS idx_bursts_active ON opportunity_bursts(expires_at) WHERE viewed = FALSE;

COMMENT ON TABLE opportunity_bursts IS 'Phase 16: Non-monetary nudges for liquidity concentration';

-- ============================================================
-- MARKET DEFENSIBILITY SNAPSHOTS
-- ============================================================

CREATE TABLE IF NOT EXISTS market_defensibility_snapshots (
    id TEXT PRIMARY KEY,
    city TEXT NOT NULL,
    city_score INT NOT NULL,
    classification TEXT NOT NULL,
    data JSONB NOT NULL,
    generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_defensibility_city ON market_defensibility_snapshots(city);
CREATE INDEX IF NOT EXISTS idx_defensibility_time ON market_defensibility_snapshots(generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_defensibility_class ON market_defensibility_snapshots(classification);

COMMENT ON TABLE market_defensibility_snapshots IS 'Phase 16: Market moat strength tracking';

-- ============================================================
-- EXPANSION PLANS
-- ============================================================

CREATE TABLE IF NOT EXISTS expansion_plans (
    id TEXT PRIMARY KEY,
    city TEXT NOT NULL,
    phase TEXT NOT NULL,
    data JSONB NOT NULL,
    generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_expansion_city ON expansion_plans(city);
CREATE INDEX IF NOT EXISTS idx_expansion_phase ON expansion_plans(phase);
CREATE INDEX IF NOT EXISTS idx_expansion_time ON expansion_plans(generated_at DESC);

COMMENT ON TABLE expansion_plans IS 'Phase 16: City expansion decision intelligence';
