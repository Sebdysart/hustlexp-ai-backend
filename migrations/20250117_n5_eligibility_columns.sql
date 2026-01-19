/**
 * N5 Eligibility Columns Migration
 * 
 * ============================================================================
 * PURPOSE
 * ============================================================================
 * 
 * Adds eligibility requirement columns to tasks table for full feed filtering.
 * Enables trade-specific, trust tier, and insurance enforcement at SQL level.
 * 
 * ============================================================================
 * CHANGES
 * ============================================================================
 * 
 * 1. Add required_trade column (TEXT, nullable - if null, any trade eligible)
 * 2. Add required_trust_tier column (TEXT, nullable - if null, any tier eligible)
 * 3. Add insurance_required column (BOOLEAN, default false)
 * 4. Add background_check_required column (BOOLEAN, default false)
 * 5. Create indexes for eligibility JOIN performance
 * 
 * ============================================================================
 * AUTHORITY MODEL
 * ============================================================================
 * 
 * These columns drive feed eligibility JOINs:
 * - required_trade → verified_trades.trade
 * - required_trust_tier → capability_profiles.trust_tier
 * - insurance_required → capability_profiles.insurance_valid
 * - background_check_required → capability_profiles.background_check_valid
 * 
 * Reference: Phase N5 — Execution Hardening (LOCKED)
 */

BEGIN;

-- ============================================================================
-- 1. Add eligibility requirement columns
-- ============================================================================

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS required_trade TEXT,
  ADD COLUMN IF NOT EXISTS required_trust_tier TEXT CHECK (required_trust_tier IN ('A', 'B', 'C', 'D')),
  ADD COLUMN IF NOT EXISTS insurance_required BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS background_check_required BOOLEAN NOT NULL DEFAULT false;

-- ============================================================================
-- 2. Create indexes for eligibility JOIN performance
-- ============================================================================

-- Index for trade-specific filtering
CREATE INDEX IF NOT EXISTS idx_tasks_required_trade ON tasks(required_trade) WHERE required_trade IS NOT NULL;

-- Index for trust tier filtering
CREATE INDEX IF NOT EXISTS idx_tasks_required_trust_tier ON tasks(required_trust_tier) WHERE required_trust_tier IS NOT NULL;

-- Index for insurance requirement filtering
CREATE INDEX IF NOT EXISTS idx_tasks_insurance_required ON tasks(insurance_required) WHERE insurance_required = true;

-- Index for background check requirement filtering
CREATE INDEX IF NOT EXISTS idx_tasks_background_check_required ON tasks(background_check_required) WHERE background_check_required = true;

-- Composite index for common eligibility queries
CREATE INDEX IF NOT EXISTS idx_tasks_eligibility ON tasks(state, required_trade, required_trust_tier, insurance_required, background_check_required) WHERE state = 'OPEN';

COMMIT;
