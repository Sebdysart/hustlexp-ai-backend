-- ============================================================================
-- AUDIT FIXES — concurrency backstops (2026-06-11)
--
-- M8: referral double-redeem. routers/referral.ts redeemCode was a
-- check-then-act with no constraint — two concurrent requests could both
-- redeem. The application now uses INSERT ... ON CONFLICT (referred_id)
-- DO NOTHING inside a transaction; this unique index is the DB guarantee.
-- A user can redeem exactly ONE referral code, ever.
--
-- IDEMPOTENT: IF NOT EXISTS — safe to re-run.
-- NOTE: if pre-existing duplicate referred_id rows exist, this CREATE will
-- fail — resolve duplicates first (keep the earliest redemption):
--   DELETE FROM referral_redemptions a USING referral_redemptions b
--   WHERE a.referred_id = b.referred_id AND a.created_at > b.created_at;
-- ============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS referral_redemptions_referred_id_uniq
    ON referral_redemptions (referred_id);
