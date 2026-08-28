-- ============================================================================
-- HustleXP Business Enhancement Migration v2.5.0
-- Adds: tips, daily_challenges, referrals, featured_listings,
--        skill_verification, premium_insurance, last_task_completed_at
-- ============================================================================

-- 1. TIPPING TABLE
CREATE TABLE IF NOT EXISTS tips (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id),
  poster_id UUID NOT NULL REFERENCES users(id),
  worker_id UUID NOT NULL REFERENCES users(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 100),
  stripe_payment_intent_id TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  UNIQUE(task_id, poster_id) -- One tip per task per poster
);
CREATE INDEX IF NOT EXISTS idx_tips_worker ON tips(worker_id);
CREATE INDEX IF NOT EXISTS idx_tips_task ON tips(task_id);

-- 2. ADD last_task_completed_at TO USERS (for streak tracking)
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_task_completed_at TIMESTAMPTZ;

-- 3. DAILY CHALLENGES TABLE
CREATE TABLE IF NOT EXISTS daily_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge_date DATE NOT NULL DEFAULT CURRENT_DATE,
  title VARCHAR(100) NOT NULL,
  description TEXT,
  challenge_type VARCHAR(50) NOT NULL CHECK (challenge_type IN (
    'complete_task', 'earn_rating', 'fast_completion', 'specific_category', 'streak_maintain'
  )),
  target_value INTEGER NOT NULL DEFAULT 1,
  xp_reward INTEGER NOT NULL DEFAULT 10,
  bonus_cents INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_daily_challenges_date ON daily_challenges(challenge_date);

CREATE TABLE IF NOT EXISTS daily_challenge_completions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge_id UUID NOT NULL REFERENCES daily_challenges(id),
  user_id UUID NOT NULL REFERENCES users(id),
  progress INTEGER NOT NULL DEFAULT 0,
  completed BOOLEAN DEFAULT FALSE,
  completed_at TIMESTAMPTZ,
  xp_awarded BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(challenge_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_challenge_completions_user ON daily_challenge_completions(user_id);

-- 4. REFERRAL SYSTEM
CREATE TABLE IF NOT EXISTS referral_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  code VARCHAR(20) NOT NULL UNIQUE,
  uses_count INTEGER NOT NULL DEFAULT 0,
  max_uses INTEGER DEFAULT NULL, -- NULL = unlimited
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_referral_codes_code ON referral_codes(code);
CREATE INDEX IF NOT EXISTS idx_referral_codes_user ON referral_codes(user_id);

CREATE TABLE IF NOT EXISTS referral_redemptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referral_code_id UUID NOT NULL REFERENCES referral_codes(id),
  referrer_id UUID NOT NULL REFERENCES users(id),
  referred_id UUID NOT NULL REFERENCES users(id),
  referrer_reward_cents INTEGER NOT NULL DEFAULT 500, -- $5 for referrer
  referred_reward_cents INTEGER NOT NULL DEFAULT 500, -- $5 for referred
  referrer_reward_paid BOOLEAN DEFAULT FALSE,
  referred_reward_paid BOOLEAN DEFAULT FALSE,
  qualified BOOLEAN DEFAULT FALSE, -- True after referred user completes first task
  qualified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(referred_id) -- Each user can only be referred once
);
CREATE INDEX IF NOT EXISTS idx_referral_redemptions_referrer ON referral_redemptions(referrer_id);

-- 5. FEATURED/PROMOTED LISTINGS
CREATE TABLE IF NOT EXISTS featured_listings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id),
  poster_id UUID NOT NULL REFERENCES users(id),
  feature_type VARCHAR(30) NOT NULL CHECK (feature_type IN ('promoted', 'highlighted', 'urgent_boost')),
  fee_cents INTEGER NOT NULL,
  stripe_payment_intent_id TEXT,
  starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_featured_listings_task ON featured_listings(task_id);
CREATE INDEX IF NOT EXISTS idx_featured_listings_active ON featured_listings(active, expires_at);

-- 6. SKILL VERIFICATION
CREATE TABLE IF NOT EXISTS skill_verifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  skill_name VARCHAR(100) NOT NULL,
  verification_type VARCHAR(30) NOT NULL CHECK (verification_type IN ('self_declared', 'quiz_passed', 'peer_endorsed', 'admin_verified')),
  verified_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ, -- NULL = never expires
  fee_paid_cents INTEGER DEFAULT 0,
  stripe_payment_intent_id TEXT,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, skill_name)
);
CREATE INDEX IF NOT EXISTS idx_skill_verifications_user ON skill_verifications(user_id);

-- 7. PREMIUM INSURANCE TIERS
CREATE TABLE IF NOT EXISTS insurance_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  tier VARCHAR(20) NOT NULL CHECK (tier IN ('basic', 'premium')),
  coverage_percent NUMERIC(5,2) NOT NULL DEFAULT 80.00,
  max_claim_cents INTEGER NOT NULL DEFAULT 500000, -- $5,000 basic
  monthly_premium_cents INTEGER NOT NULL DEFAULT 0, -- 0 for basic (included in pool)
  stripe_subscription_id TEXT,
  active BOOLEAN DEFAULT TRUE,
  starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id) -- One insurance subscription per user
);
CREATE INDEX IF NOT EXISTS idx_insurance_subs_user ON insurance_subscriptions(user_id);

-- 8. LEVEL-UP NOTIFICATIONS TRACKING
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_notified_level INTEGER DEFAULT 1;

-- Done
