-- Migration: Add support for UNVERIFIED (0) and BANNED (9) trust tiers
-- Pre-Alpha Prerequisite: Update schema to match TrustTier enum

-- Drop existing constraint
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_trust_tier_check;

-- Add new constraint allowing 0 (UNVERIFIED), 1-4 (tiers), and 9 (BANNED)
ALTER TABLE users 
ADD CONSTRAINT users_trust_tier_check 
CHECK (trust_tier IN (0, 1, 2, 3, 4, 9));

-- Update default to 0 (UNVERIFIED) instead of 1
ALTER TABLE users ALTER COLUMN trust_tier SET DEFAULT 0;

-- Note: Existing users with trust_tier = 1 are considered VERIFIED (Tier A)
-- New users start at UNVERIFIED (0) and must verify to reach VERIFIED (1)
