-- Migration: Add user plan tracking (Step 9-C - Monetization Hooks)
-- Adds plan, plan_subscribed_at, plan_expires_at to users table
-- 
-- Purpose: Enable Premium/Pro subscription gating
-- Plans: 'free' | 'premium' | 'pro'
-- 
-- @see STEP_9_MONETIZATION_PRICING.md

BEGIN;

-- Add plan column with CHECK constraint
ALTER TABLE users
ADD COLUMN IF NOT EXISTS plan VARCHAR(20) NOT NULL DEFAULT 'free'
  CHECK (plan IN ('free', 'premium', 'pro'));

-- Add plan subscription tracking
ALTER TABLE users
ADD COLUMN IF NOT EXISTS plan_subscribed_at TIMESTAMPTZ;

ALTER TABLE users
ADD COLUMN IF NOT EXISTS plan_expires_at TIMESTAMPTZ;

-- Add index for plan queries (useful for analytics and filtering)
CREATE INDEX IF NOT EXISTS idx_users_plan ON users(plan);

COMMIT;
