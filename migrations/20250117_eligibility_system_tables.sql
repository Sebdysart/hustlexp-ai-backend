/**
 * Eligibility System Tables Migration
 * 
 * ============================================================================
 * PURPOSE
 * ============================================================================
 * 
 * Creates capability_profiles and verified_trades tables for the eligibility system.
 * These tables are derived from verification records and drive feed eligibility.
 * 
 * AUTHORITY MODEL:
 * - capability_profiles = SYSTEM-DERIVED (recomputed from verifications)
 * - verified_trades = SYSTEM-DERIVED (rebuilt from approved licenses)
 * - Never written directly by user submissions
 * 
 * ============================================================================
 * TABLES
 * ============================================================================
 * 
 * 1. capability_profiles
 *    - Derived profile for eligibility determination
 *    - Recomputed when verifications change status
 *    - Source of truth for feed JOINs
 * 
 * 2. verified_trades
 *    - Materialized view of approved licenses
 *    - Rebuilt (not patched) on recompute
 *    - Used for feed eligibility JOINs
 * 
 * Reference: CAPABILITY_PROFILE_SCHEMA_AND_INVARIANTS_LOCKED.md
 * Reference: FEED_QUERY_AND_ELIGIBILITY_RESOLVER_LOCKED.md
 */

BEGIN;

-- ============================================================================
-- 1. Capability Profiles Table
-- ============================================================================

CREATE TABLE IF NOT EXISTS capability_profiles (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  
  -- Trust and risk (from users.trust_tier, derived)
  trust_tier TEXT NOT NULL DEFAULT 'A' CHECK (trust_tier IN ('A', 'B', 'C', 'D')),
  risk_clearance TEXT[] NOT NULL DEFAULT ARRAY['low']::TEXT[],
  
  -- Location (from users, for jurisdiction matching)
  location_state TEXT,
  location_city TEXT,
  
  -- Insurance status (derived from insurance_verifications)
  insurance_valid BOOLEAN NOT NULL DEFAULT false,
  insurance_expires_at TIMESTAMPTZ,
  
  -- Background check status (derived from background_checks)
  background_check_valid BOOLEAN NOT NULL DEFAULT false,
  background_check_expires_at TIMESTAMPTZ,
  
  -- Expiry flags (JSONB for flexible expiry tracking)
  expires_at JSONB DEFAULT '{}',
  
  -- Audit
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_capability_profiles_trust_tier ON capability_profiles(trust_tier);
CREATE INDEX IF NOT EXISTS idx_capability_profiles_location_state ON capability_profiles(location_state);
CREATE INDEX IF NOT EXISTS idx_capability_profiles_insurance ON capability_profiles(insurance_valid) WHERE insurance_valid = true;
CREATE INDEX IF NOT EXISTS idx_capability_profiles_background_check ON capability_profiles(background_check_valid) WHERE background_check_valid = true;

-- ============================================================================
-- 2. Verified Trades Table
-- ============================================================================

CREATE TABLE IF NOT EXISTS verified_trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  
  -- Trade information (from approved license_verifications)
  trade TEXT NOT NULL,
  state TEXT NOT NULL, -- Issuing state
  
  -- Expiration (from license_verifications.expiration_date)
  expires_at TIMESTAMPTZ,
  
  -- Source verification (for audit trail)
  license_verification_id UUID REFERENCES license_verifications(id) ON DELETE SET NULL,
  
  -- Audit
  created_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- Unique constraint: one verified trade per (user, trade, state)
  CONSTRAINT unique_verified_trade UNIQUE (user_id, trade, state)
);

CREATE INDEX IF NOT EXISTS idx_verified_trades_user ON verified_trades(user_id);
CREATE INDEX IF NOT EXISTS idx_verified_trades_trade ON verified_trades(trade);
CREATE INDEX IF NOT EXISTS idx_verified_trades_state ON verified_trades(state);
CREATE INDEX IF NOT EXISTS idx_verified_trades_expires ON verified_trades(expires_at) WHERE expires_at IS NOT NULL;

COMMIT;
