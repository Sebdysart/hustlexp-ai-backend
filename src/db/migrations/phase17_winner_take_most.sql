-- Phase 17: Winner-Take-Most Dynamics
-- Tables for self-reinforcing dominance

-- ============================================================
-- LIQUIDITY LOCK-IN SNAPSHOTS
-- ============================================================

CREATE TABLE IF NOT EXISTS liquidity_lockin_snapshots (
    id TEXT PRIMARY KEY,
    zone TEXT NOT NULL,
    lockin_score INT NOT NULL,
    classification TEXT NOT NULL CHECK (classification IN ('loose', 'forming', 'sticky', 'locked')),
    velocity INT NOT NULL,
    data JSONB NOT NULL,
    generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lockin_zone ON liquidity_lockin_snapshots(zone);
CREATE INDEX IF NOT EXISTS idx_lockin_class ON liquidity_lockin_snapshots(classification);
CREATE INDEX IF NOT EXISTS idx_lockin_time ON liquidity_lockin_snapshots(generated_at DESC);

COMMENT ON TABLE liquidity_lockin_snapshots IS 'Phase 17: Zone stickiness measurement';

-- ============================================================
-- TASK CHAINS
-- ============================================================

CREATE TABLE IF NOT EXISTS task_chains (
    id TEXT PRIMARY KEY,
    hustler_id TEXT NOT NULL,
    zone TEXT NOT NULL,
    chain_date DATE NOT NULL,
    chain_length INT NOT NULL,
    total_earnings DECIMAL(10,2) NOT NULL,
    category_sequence TEXT[] NOT NULL,
    data JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chains_hustler ON task_chains(hustler_id);
CREATE INDEX IF NOT EXISTS idx_chains_zone ON task_chains(zone);
CREATE INDEX IF NOT EXISTS idx_chains_length ON task_chains(chain_length);
CREATE INDEX IF NOT EXISTS idx_chains_date ON task_chains(chain_date DESC);

COMMENT ON TABLE task_chains IS 'Phase 17: Multi-task sequences for workday conversion';

-- ============================================================
-- REPUTATION COMPOUNDING SNAPSHOTS
-- ============================================================

CREATE TABLE IF NOT EXISTS reputation_compounding_snapshots (
    id TEXT PRIMARY KEY,
    zone TEXT NOT NULL,
    compounding_rate DECIMAL(5,2) NOT NULL,
    velocity DECIMAL(5,2) NOT NULL,
    portability_penalty INT NOT NULL,
    data JSONB NOT NULL,
    generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reputation_zone ON reputation_compounding_snapshots(zone);
CREATE INDEX IF NOT EXISTS idx_reputation_time ON reputation_compounding_snapshots(generated_at DESC);

COMMENT ON TABLE reputation_compounding_snapshots IS 'Phase 17: Trust accumulation velocity';

-- ============================================================
-- EXIT FRICTION SNAPSHOTS
-- ============================================================

CREATE TABLE IF NOT EXISTS exit_friction_snapshots (
    id TEXT PRIMARY KEY,
    zone TEXT NOT NULL,
    exit_cost_index INT NOT NULL,
    primary_loss_factor TEXT NOT NULL,
    data JSONB NOT NULL,
    generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_exit_friction_zone ON exit_friction_snapshots(zone);
CREATE INDEX IF NOT EXISTS idx_exit_friction_cost ON exit_friction_snapshots(exit_cost_index);
CREATE INDEX IF NOT EXISTS idx_exit_friction_time ON exit_friction_snapshots(generated_at DESC);

COMMENT ON TABLE exit_friction_snapshots IS 'Phase 17: Natural exit cost analysis (non-coercive)';

-- ============================================================
-- ZONE TAKEOVER STATES
-- ============================================================

CREATE TABLE IF NOT EXISTS zone_takeover_states (
    id TEXT PRIMARY KEY,
    zone TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('contested', 'tipping', 'captured')),
    moat_depth INT NOT NULL,
    criteria_met INT NOT NULL,
    data JSONB NOT NULL,
    generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_takeover_zone ON zone_takeover_states(zone);
CREATE INDEX IF NOT EXISTS idx_takeover_status ON zone_takeover_states(status);
CREATE INDEX IF NOT EXISTS idx_takeover_moat ON zone_takeover_states(moat_depth);
CREATE INDEX IF NOT EXISTS idx_takeover_time ON zone_takeover_states(generated_at DESC);

COMMENT ON TABLE zone_takeover_states IS 'Phase 17: Winner-take-most threshold tracking';
