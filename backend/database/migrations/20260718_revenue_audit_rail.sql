-- HustleXP production revenue audit rail
--
-- This migration is intentionally additive and idempotent. Production was
-- running money workers that reference revenue_ledger, but the table and its
-- reporting views were absent. The ledger is append-only and actual task
-- contribution remains UNKNOWN until Stripe's processing fee is present.

CREATE TABLE IF NOT EXISTS revenue_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  amount_cents INTEGER NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'usd',
  gross_amount_cents INTEGER,
  platform_fee_cents INTEGER CHECK (platform_fee_cents >= 0 OR platform_fee_cents IS NULL),
  net_amount_cents INTEGER,
  fee_basis_points INTEGER CHECK (fee_basis_points >= 0 OR fee_basis_points IS NULL),
  stripe_processing_fee_cents INTEGER CHECK (
    stripe_processing_fee_cents >= 0 OR stripe_processing_fee_cents IS NULL
  ),
  escrow_id UUID REFERENCES escrows(id) ON DELETE SET NULL,
  stripe_event_id TEXT UNIQUE,
  stripe_charge_id TEXT,
  stripe_payment_intent_id TEXT,
  stripe_subscription_id TEXT,
  stripe_transfer_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_revenue_ledger_type_created
  ON revenue_ledger(event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_revenue_ledger_user
  ON revenue_ledger(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_revenue_ledger_task
  ON revenue_ledger(task_id) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_revenue_ledger_escrow
  ON revenue_ledger(escrow_id) WHERE escrow_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_revenue_ledger_stripe_charge
  ON revenue_ledger(stripe_charge_id) WHERE stripe_charge_id IS NOT NULL;

CREATE OR REPLACE FUNCTION prevent_revenue_ledger_update()
RETURNS TRIGGER AS $$
DECLARE
  old_with_user_nulled revenue_ledger%ROWTYPE;
BEGIN
  -- Sole sanctioned mutation: GDPR unlinking of user_id, with every other
  -- field byte-for-byte unchanged. Corrections otherwise use compensating rows.
  IF OLD.user_id IS NOT NULL AND NEW.user_id IS NULL THEN
    old_with_user_nulled := OLD;
    old_with_user_nulled.user_id := NULL;
    IF NEW IS NOT DISTINCT FROM old_with_user_nulled THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION
    'INV-7_VIOLATION: revenue_ledger is append-only. Insert a compensating entry.'
    USING ERRCODE = 'HX701';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION prevent_revenue_ledger_delete()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'INV-7_VIOLATION: revenue_ledger rows are permanent financial records.'
    USING ERRCODE = 'HX702';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS revenue_ledger_no_update ON revenue_ledger;
CREATE TRIGGER revenue_ledger_no_update
  BEFORE UPDATE ON revenue_ledger
  FOR EACH ROW EXECUTE FUNCTION prevent_revenue_ledger_update();

DROP TRIGGER IF EXISTS revenue_ledger_no_delete ON revenue_ledger;
CREATE TRIGGER revenue_ledger_no_delete
  BEFORE DELETE ON revenue_ledger
  FOR EACH ROW EXECUTE FUNCTION prevent_revenue_ledger_delete();

CREATE OR REPLACE VIEW revenue_report_daily AS
SELECT
  date_trunc('day', created_at) AS day,
  event_type,
  currency,
  COUNT(*) AS event_count,
  SUM(gross_amount_cents) AS total_gross_cents,
  SUM(COALESCE(platform_fee_cents, 0)) AS total_platform_fee_cents,
  SUM(stripe_processing_fee_cents) AS total_stripe_fee_cents,
  COUNT(*) FILTER (WHERE stripe_processing_fee_cents IS NULL) AS stripe_fee_unknown_events,
  SUM(net_amount_cents) AS total_net_cents,
  SUM(amount_cents) AS total_amount_cents
FROM revenue_ledger
GROUP BY date_trunc('day', created_at), event_type, currency;

CREATE OR REPLACE VIEW revenue_pnl AS
SELECT * FROM revenue_report_daily;

CREATE OR REPLACE VIEW revenue_pnl_monthly AS
SELECT
  date_trunc('month', created_at) AS month,
  currency,
  SUM(CASE WHEN event_type = 'platform_fee' THEN amount_cents ELSE 0 END) AS platform_fee_revenue,
  SUM(CASE WHEN event_type = 'featured_listing' THEN amount_cents ELSE 0 END) AS featured_revenue,
  SUM(CASE WHEN event_type = 'skill_verification' THEN amount_cents ELSE 0 END) AS skill_verification_revenue,
  SUM(CASE WHEN event_type = 'insurance_premium' THEN amount_cents ELSE 0 END) AS insurance_revenue,
  SUM(CASE WHEN event_type = 'subscription' THEN amount_cents ELSE 0 END) AS subscription_revenue,
  SUM(CASE WHEN event_type = 'per_task_fee' THEN amount_cents ELSE 0 END) AS per_task_fee_revenue,
  SUM(CASE WHEN event_type = 'xp_tax' THEN amount_cents ELSE 0 END) AS xp_tax_revenue,
  SUM(CASE WHEN event_type = 'chargeback' THEN amount_cents ELSE 0 END) AS chargeback_losses,
  SUM(CASE WHEN event_type = 'chargeback_reversal' THEN amount_cents ELSE 0 END) AS chargeback_recoveries,
  SUM(CASE WHEN event_type = 'referral_payout' THEN amount_cents ELSE 0 END) AS referral_payouts,
  SUM(stripe_processing_fee_cents) AS total_stripe_processing_fees,
  COUNT(*) FILTER (WHERE stripe_processing_fee_cents IS NULL) AS stripe_fee_unknown_events,
  SUM(amount_cents) AS gross_revenue,
  CASE
    WHEN COUNT(*) FILTER (WHERE stripe_processing_fee_cents IS NULL) = 0
      THEN SUM(amount_cents) - SUM(stripe_processing_fee_cents)
    ELSE NULL
  END AS net_revenue,
  CASE
    WHEN COUNT(*) FILTER (WHERE stripe_processing_fee_cents IS NULL) = 0
      THEN SUM(amount_cents) - SUM(stripe_processing_fee_cents)
    ELSE NULL
  END AS net_revenue_after_stripe,
  COUNT(*) AS total_events,
  SUM(CASE WHEN event_type = 'platform_fee' THEN gross_amount_cents ELSE 0 END) AS total_gmv_cents,
  COUNT(*) FILTER (WHERE event_type = 'chargeback') AS dispute_count,
  COUNT(*) FILTER (WHERE event_type = 'chargeback_reversal') AS dispute_won_count
FROM revenue_ledger
GROUP BY date_trunc('month', created_at), currency;

-- Task-level north-star witness. contribution_cents is deliberately NULL when
-- the actual Stripe fee is missing; estimated margin must never masquerade as
-- profitable completed work.
CREATE OR REPLACE VIEW revenue_task_contribution AS
SELECT
  task_id,
  MAX(escrow_id::text)::uuid AS escrow_id,
  currency,
  SUM(CASE
    WHEN event_type IN ('platform_fee', 'platform_fee_reversal') THEN amount_cents
    ELSE 0
  END) AS platform_revenue_cents,
  SUM(stripe_processing_fee_cents) AS stripe_processing_fee_cents,
  COUNT(*) FILTER (
    WHERE event_type = 'platform_fee' AND stripe_processing_fee_cents IS NULL
  ) AS missing_stripe_fee_events,
  CASE
    WHEN COUNT(*) FILTER (WHERE event_type = 'platform_fee') > 0
     AND COUNT(*) FILTER (
       WHERE event_type = 'platform_fee' AND stripe_processing_fee_cents IS NULL
     ) = 0
      THEN SUM(CASE
        WHEN event_type IN ('platform_fee', 'platform_fee_reversal') THEN amount_cents
        ELSE 0
      END) - SUM(COALESCE(stripe_processing_fee_cents, 0))
    ELSE NULL
  END AS contribution_cents
FROM revenue_ledger
WHERE task_id IS NOT NULL
GROUP BY task_id, currency;
