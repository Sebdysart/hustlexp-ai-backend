-- Migration: Self-Insurance Pool System
-- Version: 1.8.0
-- Date: 2026-02-06
-- Purpose: Platform-managed insurance pool funded by task contributions

-- Self-insurance coverage pool (singleton table)
CREATE TABLE IF NOT EXISTS self_insurance_pool (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Pool state
  total_deposits_cents INTEGER NOT NULL DEFAULT 0 CHECK (total_deposits_cents >= 0),
  total_claims_cents INTEGER NOT NULL DEFAULT 0 CHECK (total_claims_cents >= 0),
  available_balance_cents INTEGER GENERATED ALWAYS AS (total_deposits_cents - total_claims_cents) STORED,

  -- Risk parameters
  coverage_percentage DECIMAL(5,2) NOT NULL DEFAULT 80.00 CHECK (coverage_percentage >= 0 AND coverage_percentage <= 100),
  max_claim_cents INTEGER NOT NULL DEFAULT 500000, -- $5000 max per claim

  -- Audit
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Ensure only one pool record exists
CREATE UNIQUE INDEX IF NOT EXISTS idx_self_insurance_pool_singleton ON self_insurance_pool ((1));

-- Insurance contributions (per task)
CREATE TABLE IF NOT EXISTS insurance_contributions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  hustler_id UUID NOT NULL REFERENCES users(id),

  contribution_cents INTEGER NOT NULL CHECK (contribution_cents > 0),
  contribution_percentage DECIMAL(5,2) NOT NULL, -- % of task price (default 2%)

  created_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(task_id, hustler_id) -- One contribution per task per hustler
);

-- Insurance claims
CREATE TABLE IF NOT EXISTS insurance_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id),
  hustler_id UUID NOT NULL REFERENCES users(id),

  claim_amount_cents INTEGER NOT NULL CHECK (claim_amount_cents > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'paid')),

  claim_reason TEXT NOT NULL,
  evidence_urls TEXT[],

  reviewed_by UUID REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  review_notes TEXT,

  paid_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX idx_insurance_contributions_task ON insurance_contributions(task_id);
CREATE INDEX idx_insurance_contributions_hustler ON insurance_contributions(hustler_id);
CREATE INDEX idx_insurance_claims_status ON insurance_claims(status);
CREATE INDEX idx_insurance_claims_hustler ON insurance_claims(hustler_id);
CREATE INDEX idx_insurance_claims_created_at ON insurance_claims(created_at DESC);

-- Comments for documentation
COMMENT ON TABLE self_insurance_pool IS 'Platform-managed insurance pool. Singleton table with one record.';
COMMENT ON COLUMN self_insurance_pool.total_deposits_cents IS 'Cumulative contributions from all tasks';
COMMENT ON COLUMN self_insurance_pool.total_claims_cents IS 'Cumulative claims paid out';
COMMENT ON COLUMN self_insurance_pool.available_balance_cents IS 'Computed: total_deposits - total_claims';
COMMENT ON COLUMN self_insurance_pool.coverage_percentage IS 'Percentage of claim amount covered by pool (default 80%)';
COMMENT ON COLUMN self_insurance_pool.max_claim_cents IS 'Maximum claimable amount per incident ($5000 default)';

COMMENT ON TABLE insurance_contributions IS 'Contributions deducted from task payouts (default 2%)';
COMMENT ON TABLE insurance_claims IS 'Claims filed by hustlers for damages/disputes';
COMMENT ON COLUMN insurance_claims.status IS 'pending → approved/denied → paid';
COMMENT ON COLUMN insurance_claims.evidence_urls IS 'Photos/videos supporting claim';

-- Initialize pool with default parameters (idempotent)
INSERT INTO self_insurance_pool (coverage_percentage, max_claim_cents)
VALUES (80.00, 500000)
ON CONFLICT DO NOTHING;
