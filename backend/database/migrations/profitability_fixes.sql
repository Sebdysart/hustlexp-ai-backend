-- P0 Profitability Fixes Migration
-- Adds revenue tracking, payment status columns, and subscription support.

-- 1. Add platform_fee_cents to escrows
ALTER TABLE escrows ADD COLUMN IF NOT EXISTS platform_fee_cents INTEGER CHECK (platform_fee_cents >= 0);

-- 2. Add stripe_subscription_id to users for recurring billing
ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_subscription_id VARCHAR(255);

-- 3. Add recurring task limits
ALTER TABLE users ADD COLUMN IF NOT EXISTS recurring_task_limit INTEGER DEFAULT 0;

-- 4. Create unified revenue_ledger
CREATE TABLE IF NOT EXISTS revenue_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type VARCHAR(50) NOT NULL, -- 'platform_fee', 'featured_listing', 'skill_verification', 'insurance_premium', 'subscription', 'xp_tax', 'per_task_fee', 'referral_payout'
  user_id UUID REFERENCES users(id),
  task_id UUID REFERENCES tasks(id),
  amount_cents INTEGER NOT NULL, -- positive = revenue, negative = payout
  stripe_payment_intent_id TEXT,
  stripe_subscription_id TEXT,
  stripe_transfer_id TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_revenue_ledger_type ON revenue_ledger(event_type);
CREATE INDEX idx_revenue_ledger_user ON revenue_ledger(user_id);
CREATE INDEX idx_revenue_ledger_created ON revenue_ledger(created_at DESC);

-- 5. Add stripe_transfer_id to referral_redemptions
ALTER TABLE referral_redemptions ADD COLUMN IF NOT EXISTS referrer_stripe_transfer_id TEXT;
ALTER TABLE referral_redemptions ADD COLUMN IF NOT EXISTS referred_stripe_transfer_id TEXT;

-- 6. Add stripe_transfer_id to insurance_claims
ALTER TABLE insurance_claims ADD COLUMN IF NOT EXISTS stripe_transfer_id TEXT;

-- 7. Add payment_status to featured_listings
ALTER TABLE featured_listings ADD COLUMN IF NOT EXISTS payment_status VARCHAR(20) DEFAULT 'pending' CHECK (payment_status IN ('pending', 'paid', 'failed'));

-- 8. Add payment_status to skill_verifications
ALTER TABLE skill_verifications ADD COLUMN IF NOT EXISTS payment_status VARCHAR(20) DEFAULT 'pending' CHECK (payment_status IN ('pending', 'paid', 'failed', 'free'));

-- 9. Add stripe_payment_intent_id to skill_verifications (for linking payment)
ALTER TABLE skill_verifications ADD COLUMN IF NOT EXISTS stripe_payment_intent_id TEXT;

-- 10. Add stripe_subscription_id to insurance_subscriptions (for linking subscription)
ALTER TABLE insurance_subscriptions ADD COLUMN IF NOT EXISTS stripe_subscription_id VARCHAR(255);

-- 11. Add missing indexes
CREATE INDEX IF NOT EXISTS idx_users_stripe_connect ON users(stripe_connect_id) WHERE stripe_connect_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_stripe_subscription ON users(stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_featured_listings_payment ON featured_listings(payment_status);
CREATE INDEX IF NOT EXISTS idx_skill_verifications_payment ON skill_verifications(payment_status);
