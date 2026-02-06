-- Migration: Earned Verification Unlock System
-- Version: 1.8.0
-- Date: 2026-02-06
-- Purpose: Track cumulative earnings for $40 verification unlock threshold

-- Track cumulative earnings for earned verification unlock
CREATE TABLE IF NOT EXISTS verification_earnings_tracking (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,

  -- Cumulative earnings (post-fee)
  total_net_earnings_cents INTEGER NOT NULL DEFAULT 0 CHECK (total_net_earnings_cents >= 0),

  -- Unlock thresholds
  earned_unlock_threshold_cents INTEGER NOT NULL DEFAULT 4000, -- $40 net profit
  earned_unlock_achieved BOOLEAN NOT NULL DEFAULT FALSE,
  earned_unlock_achieved_at TIMESTAMPTZ,

  -- Task count for eligibility
  completed_task_count INTEGER NOT NULL DEFAULT 0 CHECK (completed_task_count >= 0),

  -- Audit
  last_updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Append-only ledger for earnings (idempotent)
CREATE TABLE IF NOT EXISTS verification_earnings_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  task_id UUID NOT NULL REFERENCES tasks(id),
  escrow_id UUID NOT NULL, -- Links to escrow release

  net_payout_cents INTEGER NOT NULL CHECK (net_payout_cents > 0),

  cumulative_earnings_before_cents INTEGER NOT NULL,
  cumulative_earnings_after_cents INTEGER NOT NULL,

  awarded_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(escrow_id) -- Idempotent: one entry per escrow release
);

-- Indexes for performance
CREATE INDEX idx_verification_earnings_ledger_user ON verification_earnings_ledger(user_id);
CREATE INDEX idx_verification_earnings_ledger_awarded ON verification_earnings_ledger(awarded_at DESC);
CREATE INDEX idx_verification_earnings_tracking_unlocked ON verification_earnings_tracking(earned_unlock_achieved) WHERE earned_unlock_achieved = TRUE;

-- Trigger: Update tracking table on ledger insert
CREATE OR REPLACE FUNCTION update_verification_earnings_tracking()
RETURNS TRIGGER AS $$
BEGIN
  -- Update tracking table
  INSERT INTO verification_earnings_tracking (
    user_id,
    total_net_earnings_cents,
    completed_task_count
  )
  VALUES (
    NEW.user_id,
    NEW.cumulative_earnings_after_cents,
    1
  )
  ON CONFLICT (user_id) DO UPDATE SET
    total_net_earnings_cents = NEW.cumulative_earnings_after_cents,
    completed_task_count = verification_earnings_tracking.completed_task_count + 1,
    last_updated_at = NOW();

  -- Check if threshold achieved
  UPDATE verification_earnings_tracking
  SET
    earned_unlock_achieved = TRUE,
    earned_unlock_achieved_at = COALESCE(earned_unlock_achieved_at, NOW())
  WHERE user_id = NEW.user_id
    AND total_net_earnings_cents >= earned_unlock_threshold_cents
    AND earned_unlock_achieved = FALSE;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_verification_earnings_tracking ON verification_earnings_ledger;
CREATE TRIGGER trigger_update_verification_earnings_tracking
AFTER INSERT ON verification_earnings_ledger
FOR EACH ROW
EXECUTE FUNCTION update_verification_earnings_tracking();

-- Comments for documentation
COMMENT ON TABLE verification_earnings_tracking IS 'Snapshot table tracking cumulative earnings toward $40 unlock threshold';
COMMENT ON TABLE verification_earnings_ledger IS 'Append-only ledger of all earnings (idempotent via escrow_id)';
COMMENT ON COLUMN verification_earnings_tracking.total_net_earnings_cents IS 'Cumulative net earnings after platform fee (20%)';
COMMENT ON COLUMN verification_earnings_tracking.earned_unlock_threshold_cents IS 'Threshold for free verification unlock (default $40)';
COMMENT ON COLUMN verification_earnings_tracking.earned_unlock_achieved IS 'TRUE when threshold reached, unlocks verification submission';
COMMENT ON COLUMN verification_earnings_ledger.escrow_id IS 'Links to escrow release, ensures idempotency (UNIQUE constraint)';
COMMENT ON COLUMN verification_earnings_ledger.cumulative_earnings_before_cents IS 'Earnings before this task';
COMMENT ON COLUMN verification_earnings_ledger.cumulative_earnings_after_cents IS 'Earnings after this task (before + net_payout)';
