-- Migration: XP Tax System (Constitutional Enforcement via Layer 0 Trigger)
-- Version: 1.8.0
-- Date: 2026-02-06
-- Purpose: Block XP award for offline payments until 10% tax paid

-- XP tax ledger for offline payment blocking
CREATE TABLE IF NOT EXISTS xp_tax_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  task_id UUID NOT NULL REFERENCES tasks(id),

  -- Tax calculation
  gross_payout_cents INTEGER NOT NULL CHECK (gross_payout_cents > 0),
  tax_percentage DECIMAL(5,2) NOT NULL CHECK (tax_percentage >= 0), -- 0-100
  tax_amount_cents INTEGER NOT NULL CHECK (tax_amount_cents >= 0),
  net_payout_cents INTEGER NOT NULL CHECK (net_payout_cents > 0),

  -- Payment tracking
  payment_method TEXT NOT NULL CHECK (payment_method IN ('escrow', 'offline_cash', 'offline_venmo', 'offline_cashapp')),
  tax_paid BOOLEAN NOT NULL DEFAULT FALSE,
  tax_paid_at TIMESTAMPTZ,

  -- Enforcement
  xp_held_back BOOLEAN NOT NULL DEFAULT FALSE, -- TRUE if tax unpaid for offline payment
  xp_released BOOLEAN NOT NULL DEFAULT FALSE,
  xp_released_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(task_id, user_id) -- One tax entry per task per user
);

-- User XP tax summary
CREATE TABLE IF NOT EXISTS user_xp_tax_status (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,

  total_unpaid_tax_cents INTEGER NOT NULL DEFAULT 0 CHECK (total_unpaid_tax_cents >= 0),
  total_xp_held_back INTEGER NOT NULL DEFAULT 0 CHECK (total_xp_held_back >= 0),

  offline_payments_blocked BOOLEAN NOT NULL DEFAULT FALSE,

  last_updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX idx_xp_tax_user ON xp_tax_ledger(user_id);
CREATE INDEX idx_xp_tax_unpaid ON xp_tax_ledger(user_id, tax_paid) WHERE tax_paid = FALSE;
CREATE INDEX idx_xp_tax_held_back ON xp_tax_ledger(user_id, xp_held_back) WHERE xp_held_back = TRUE;
CREATE INDEX idx_xp_tax_status_unpaid ON user_xp_tax_status(total_unpaid_tax_cents) WHERE total_unpaid_tax_cents > 0;

-- Comments for documentation
COMMENT ON TABLE xp_tax_ledger IS 'Tracks offline payment taxes (10%). XP blocked until paid.';
COMMENT ON TABLE user_xp_tax_status IS 'Summary table: total unpaid taxes and held XP per user';
COMMENT ON COLUMN xp_tax_ledger.tax_percentage IS 'Tax rate: 0% for escrow, 10% for offline payments';
COMMENT ON COLUMN xp_tax_ledger.payment_method IS 'escrow=on-platform (no tax), offline_*=off-platform (10% tax)';
COMMENT ON COLUMN xp_tax_ledger.xp_held_back IS 'TRUE if XP award blocked due to unpaid tax';
COMMENT ON COLUMN xp_tax_ledger.xp_released IS 'TRUE if XP awarded after tax paid';

-- CRITICAL TRIGGER: Constitutional Enforcement (Layer 0)
-- Blocks XP insertion if offline tax unpaid
CREATE OR REPLACE FUNCTION enforce_xp_tax_payment()
RETURNS TRIGGER AS $$
DECLARE
  v_unpaid_tax_cents INTEGER;
BEGIN
  -- Check for unpaid offline taxes
  SELECT COALESCE(SUM(tax_amount_cents), 0)
  INTO v_unpaid_tax_cents
  FROM xp_tax_ledger
  WHERE user_id = NEW.user_id
    AND tax_paid = FALSE
    AND payment_method IN ('offline_cash', 'offline_venmo', 'offline_cashapp');

  -- If unpaid tax exists, block XP award
  IF v_unpaid_tax_cents > 0 THEN
    RAISE EXCEPTION 'XP-TAX-BLOCK: Cannot award XP. User has $% in unpaid offline taxes. Task ID: %',
      (v_unpaid_tax_cents::DECIMAL / 100), NEW.task_id
      USING ERRCODE = 'HX201';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply trigger to xp_ledger (existing table)
-- This trigger operates at Layer 0 (database constitutional layer)
-- Even if application code is compromised, XP cannot be inserted if tax unpaid
DROP TRIGGER IF EXISTS trigger_enforce_xp_tax_payment ON xp_ledger;
CREATE TRIGGER trigger_enforce_xp_tax_payment
BEFORE INSERT ON xp_ledger
FOR EACH ROW
EXECUTE FUNCTION enforce_xp_tax_payment();

-- Explanation comment
COMMENT ON FUNCTION enforce_xp_tax_payment IS 'Layer 0 constitutional trigger: Blocks XP insertion if offline taxes unpaid. Error code HX201. Enforced at database level (cannot be bypassed by application code).';
