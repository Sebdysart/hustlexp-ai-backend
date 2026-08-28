-- Build-Now carries no cash-incentive or paid task-promotion budget. Preserve
-- historical records, but fail closed for every prospective spend or ranking-
-- adjacent promotion mutation until a capped, ledger-backed policy is approved.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS referral_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code TEXT NOT NULL UNIQUE,
  uses_count INTEGER NOT NULL DEFAULT 0,
  max_uses INTEGER,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS referral_redemptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referral_code_id UUID NOT NULL REFERENCES referral_codes(id) ON DELETE RESTRICT,
  referrer_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  referred_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  referrer_reward_cents INTEGER NOT NULL DEFAULT 0,
  referred_reward_cents INTEGER NOT NULL DEFAULT 0,
  referrer_reward_paid BOOLEAN NOT NULL DEFAULT FALSE,
  referred_reward_paid BOOLEAN NOT NULL DEFAULT FALSE,
  qualified BOOLEAN NOT NULL DEFAULT FALSE,
  qualified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(referred_id)
);

CREATE TABLE IF NOT EXISTS daily_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge_date DATE NOT NULL DEFAULT CURRENT_DATE,
  title VARCHAR(100) NOT NULL,
  description TEXT,
  challenge_type VARCHAR(50) NOT NULL,
  target_value INTEGER NOT NULL DEFAULT 1,
  xp_reward INTEGER NOT NULL DEFAULT 10,
  bonus_cents INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS featured_listings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  poster_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  feature_type VARCHAR(30) NOT NULL,
  fee_cents INTEGER NOT NULL,
  stripe_payment_intent_id TEXT,
  starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT FALSE,
  payment_status VARCHAR(20) DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE referral_redemptions
  ADD COLUMN IF NOT EXISTS referrer_reward_cents INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS referred_reward_cents INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS referrer_reward_paid BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS referred_reward_paid BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS qualified BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE referral_redemptions
   SET referrer_reward_cents = COALESCE(referrer_reward_cents, 0),
       referred_reward_cents = COALESCE(referred_reward_cents, 0),
       referrer_reward_paid = COALESCE(referrer_reward_paid, FALSE),
       referred_reward_paid = COALESCE(referred_reward_paid, FALSE),
       qualified = COALESCE(qualified, FALSE)
 WHERE referrer_reward_cents IS NULL OR referred_reward_cents IS NULL
    OR referrer_reward_paid IS NULL OR referred_reward_paid IS NULL
    OR qualified IS NULL;

ALTER TABLE referral_redemptions
  ALTER COLUMN referrer_reward_cents SET DEFAULT 0,
  ALTER COLUMN referred_reward_cents SET DEFAULT 0,
  ALTER COLUMN referrer_reward_cents SET NOT NULL,
  ALTER COLUMN referred_reward_cents SET NOT NULL,
  ALTER COLUMN referrer_reward_paid SET NOT NULL,
  ALTER COLUMN referred_reward_paid SET NOT NULL,
  ALTER COLUMN qualified SET NOT NULL;

-- Remove unearned future cash claims without rewriting historical paid amounts.
UPDATE referral_redemptions
   SET referrer_reward_cents = CASE
         WHEN referrer_reward_paid IS TRUE THEN referrer_reward_cents ELSE 0 END,
       referred_reward_cents = CASE
         WHEN referred_reward_paid IS TRUE THEN referred_reward_cents ELSE 0 END
 WHERE (referrer_reward_paid IS NOT TRUE AND referrer_reward_cents <> 0)
    OR (referred_reward_paid IS NOT TRUE AND referred_reward_cents <> 0);

CREATE OR REPLACE FUNCTION enforce_build_now_referral_incentive_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.referrer_reward_paid IS TRUE
       OR NEW.referred_reward_paid IS TRUE
       OR NEW.referrer_reward_cents <> 0
       OR NEW.referred_reward_cents <> 0 THEN
      RAISE EXCEPTION 'HXINC1: cash referral incentives are disabled'
        USING ERRCODE = 'P0001';
    END IF;
  ELSE
    IF (NEW.referrer_reward_paid IS TRUE AND OLD.referrer_reward_paid IS NOT TRUE)
       OR (NEW.referred_reward_paid IS TRUE AND OLD.referred_reward_paid IS NOT TRUE)
       OR (OLD.referrer_reward_paid IS NOT TRUE AND NEW.referrer_reward_cents <> 0)
       OR (OLD.referred_reward_paid IS NOT TRUE AND NEW.referred_reward_cents <> 0) THEN
      RAISE EXCEPTION 'HXINC1: cash referral incentives are disabled'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS build_now_referral_incentive_guard ON referral_redemptions;
CREATE TRIGGER build_now_referral_incentive_guard
BEFORE INSERT OR UPDATE ON referral_redemptions
FOR EACH ROW EXECUTE FUNCTION enforce_build_now_referral_incentive_guard();

ALTER TABLE daily_challenges
  ADD COLUMN IF NOT EXISTS bonus_cents INTEGER NOT NULL DEFAULT 0;
UPDATE daily_challenges SET bonus_cents=0 WHERE bonus_cents IS NULL;
ALTER TABLE daily_challenges
  ALTER COLUMN bonus_cents SET DEFAULT 0,
  ALTER COLUMN bonus_cents SET NOT NULL;

UPDATE daily_challenges
   SET active = FALSE
 WHERE bonus_cents <> 0 AND active IS TRUE;

CREATE OR REPLACE FUNCTION enforce_build_now_challenge_incentive_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.bonus_cents <> 0 THEN
    RAISE EXCEPTION 'HXINC2: cash challenge incentives are disabled'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS build_now_challenge_incentive_guard ON daily_challenges;
CREATE TRIGGER build_now_challenge_incentive_guard
BEFORE INSERT OR UPDATE ON daily_challenges
FOR EACH ROW EXECUTE FUNCTION enforce_build_now_challenge_incentive_guard();

ALTER TABLE featured_listings
  ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS payment_status VARCHAR(20) DEFAULT 'pending';

-- Historical paid records remain auditable, but none retain active placement.
UPDATE featured_listings SET active=FALSE WHERE active IS DISTINCT FROM FALSE;
ALTER TABLE featured_listings
  ALTER COLUMN active SET DEFAULT FALSE,
  ALTER COLUMN active SET NOT NULL;

CREATE OR REPLACE FUNCTION enforce_build_now_paid_promotion_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT'
     OR NEW.active IS TRUE
     OR (
       NEW.payment_status = 'paid'
       AND OLD.payment_status IS DISTINCT FROM 'paid'
     ) THEN
    RAISE EXCEPTION 'HXPROMO1: paid task promotion is disabled'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS build_now_paid_promotion_guard ON featured_listings;
CREATE TRIGGER build_now_paid_promotion_guard
BEFORE INSERT OR UPDATE ON featured_listings
FOR EACH ROW EXECUTE FUNCTION enforce_build_now_paid_promotion_guard();

COMMENT ON FUNCTION enforce_build_now_referral_incentive_guard() IS
  'Build-Now zero cash-incentive budget; historical paid records remain unchanged.';
COMMENT ON FUNCTION enforce_build_now_paid_promotion_guard() IS
  'Build-Now canonical matching remains independent of paid task promotion.';

COMMIT;
