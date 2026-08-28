-- ============================================================================
-- REVENUE LEDGER V2 MIGRATION
-- Sprint 2: Audit-grade financial ledger
-- ============================================================================
-- Upgrades revenue_ledger from a simple tracking table to a fintech-grade
-- financial record that can independently reproduce P&L without cross-referencing
-- escrows, tasks, or Stripe.
--
-- New columns:
--   currency, gross_amount_cents, platform_fee_cents, net_amount_cents,
--   fee_basis_points, escrow_id, stripe_event_id, stripe_charge_id
--
-- CRITICAL: revenue_ledger is append-only (INV-7). The existing
-- revenue_ledger_no_update and revenue_ledger_no_delete triggers in
-- hardening_invariants.sql prevent all UPDATE/DELETE operations.
-- This migration uses ADD COLUMN IF NOT EXISTS — safe to re-run.
-- ============================================================================

-- ============================================================================
-- 1. ADD V2 COLUMNS
-- ============================================================================

-- Currency: defaults to USD, but records the actual currency for every event
ALTER TABLE revenue_ledger ADD COLUMN IF NOT EXISTS currency VARCHAR(3) DEFAULT 'usd';

-- Gross/Net/Fee decomposition:
-- For platform_fee events:  gross = task price, fee = platform fee, net = worker payout
-- For other events:         gross = amount charged, fee = 0, net = gross (simple pass-through)
-- For chargebacks:          gross = disputed amount (negative), fee = 0, net = gross
ALTER TABLE revenue_ledger ADD COLUMN IF NOT EXISTS gross_amount_cents INTEGER;
ALTER TABLE revenue_ledger ADD COLUMN IF NOT EXISTS platform_fee_cents INTEGER CHECK (platform_fee_cents >= 0 OR platform_fee_cents IS NULL);
ALTER TABLE revenue_ledger ADD COLUMN IF NOT EXISTS net_amount_cents INTEGER;

-- Fee basis points: platform fee as basis points (1500 = 15%)
-- Allows fee structure changes without losing historical context
ALTER TABLE revenue_ledger ADD COLUMN IF NOT EXISTS fee_basis_points INTEGER CHECK (fee_basis_points >= 0 OR fee_basis_points IS NULL);

-- Stripe processing fee: populated from balance_transaction webhooks.
-- Without this, the ledger is a Revenue Report, not a true P&L.
-- Populated by: invoice.payment_succeeded → balance_transaction.fee
ALTER TABLE revenue_ledger ADD COLUMN IF NOT EXISTS stripe_processing_fee_cents INTEGER CHECK (stripe_processing_fee_cents >= 0 OR stripe_processing_fee_cents IS NULL);

-- Foreign key references that make the ledger self-contained
ALTER TABLE revenue_ledger ADD COLUMN IF NOT EXISTS escrow_id UUID;
ALTER TABLE revenue_ledger ADD COLUMN IF NOT EXISTS stripe_event_id VARCHAR(255);
ALTER TABLE revenue_ledger ADD COLUMN IF NOT EXISTS stripe_charge_id VARCHAR(255);

-- ============================================================================
-- 2. INDEXES FOR V2 COLUMNS
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_revenue_ledger_escrow ON revenue_ledger(escrow_id) WHERE escrow_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_revenue_ledger_currency ON revenue_ledger(currency);
CREATE INDEX IF NOT EXISTS idx_revenue_ledger_stripe_event ON revenue_ledger(stripe_event_id) WHERE stripe_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_revenue_ledger_stripe_charge ON revenue_ledger(stripe_charge_id) WHERE stripe_charge_id IS NOT NULL;

-- Composite index for financial replay: type + created_at for time-range P&L
CREATE INDEX IF NOT EXISTS idx_revenue_ledger_type_created ON revenue_ledger(event_type, created_at DESC);

-- ============================================================================
-- 3. BACKFILL EXISTING ROWS
-- ============================================================================
-- Best-effort backfill from metadata JSONB for historical records.
-- Uses conditional updates to avoid touching rows that already have v2 data.
--
-- NOTE: Because revenue_ledger has the append-only trigger (INV-7), we must
-- temporarily disable the update trigger, backfill, then re-enable it.
-- This is the ONLY acceptable use of disabling INV-7.
-- ============================================================================

-- WRAPPED IN TRANSACTION: If anything fails, trigger stays enabled.
-- DDL (ALTER TABLE DISABLE/ENABLE TRIGGER) is transactional in PostgreSQL.
BEGIN;

ALTER TABLE revenue_ledger DISABLE TRIGGER revenue_ledger_no_update;

-- 3a. Backfill platform_fee events (richest data — has gross/net in metadata)
UPDATE revenue_ledger
SET gross_amount_cents = (metadata->>'grossPayoutCents')::INTEGER,
    net_amount_cents = (metadata->>'netPayoutCents')::INTEGER,
    platform_fee_cents = amount_cents,
    fee_basis_points = 1500,  -- 15% was the rate when these were created
    escrow_id = (metadata->>'escrowId')::UUID,
    currency = 'usd'
WHERE event_type = 'platform_fee'
  AND gross_amount_cents IS NULL
  AND metadata->>'grossPayoutCents' IS NOT NULL;

-- 3b. Backfill chargeback events (has stripe_charge_id, currency in metadata)
UPDATE revenue_ledger
SET currency = COALESCE(metadata->>'currency', 'usd'),
    stripe_charge_id = metadata->>'stripe_charge_id',
    gross_amount_cents = amount_cents,  -- For chargebacks, gross = amount (negative)
    net_amount_cents = amount_cents,
    platform_fee_cents = 0,
    fee_basis_points = 0
WHERE event_type IN ('chargeback', 'chargeback_reversal')
  AND gross_amount_cents IS NULL;

-- 3c. Backfill simple revenue events (featured, insurance, skill, subscription, per_task_fee)
-- These are pure revenue — gross = net = amount, fee = 0
UPDATE revenue_ledger
SET gross_amount_cents = amount_cents,
    net_amount_cents = amount_cents,
    platform_fee_cents = 0,
    fee_basis_points = 0,
    currency = 'usd'
WHERE event_type IN ('featured_listing', 'insurance_premium', 'skill_verification',
                      'subscription', 'per_task_fee', 'xp_tax', 'referral_payout')
  AND gross_amount_cents IS NULL;

ALTER TABLE revenue_ledger ENABLE TRIGGER revenue_ledger_no_update;

COMMIT;

-- ============================================================================
-- 4. VALIDATION CHECK (run manually to verify backfill)
-- ============================================================================
-- SELECT event_type,
--        COUNT(*) as total,
--        COUNT(gross_amount_cents) as has_gross,
--        COUNT(currency) as has_currency,
--        SUM(CASE WHEN gross_amount_cents IS NULL THEN 1 ELSE 0 END) as missing_gross
-- FROM revenue_ledger
-- GROUP BY event_type
-- ORDER BY event_type;
--
-- Expected: missing_gross = 0 for all event types after backfill

-- ============================================================================
-- 5. FINANCIAL REPLAY VIEWS
-- ============================================================================
-- These views generate reports from the ledger alone — no escrow or task joins.
-- NOTE: Without stripe_processing_fee_cents populated from balance_transaction
-- webhooks, these are REVENUE REPORTS, not true P&L. The column exists to
-- support future P&L once charge.succeeded events populate it.
-- ============================================================================

-- Daily revenue report by event type
CREATE OR REPLACE VIEW revenue_report_daily AS
SELECT
    date_trunc('day', created_at) AS day,
    event_type,
    currency,
    COUNT(*) AS event_count,
    SUM(gross_amount_cents) AS total_gross_cents,
    SUM(COALESCE(platform_fee_cents, 0)) AS total_platform_fee_cents,
    SUM(COALESCE(stripe_processing_fee_cents, 0)) AS total_stripe_fee_cents,
    SUM(net_amount_cents) AS total_net_cents,
    SUM(amount_cents) AS total_amount_cents
FROM revenue_ledger
GROUP BY date_trunc('day', created_at), event_type, currency
ORDER BY day DESC, event_type;

-- Backward-compatible alias
CREATE OR REPLACE VIEW revenue_pnl AS
SELECT * FROM revenue_report_daily;

-- Monthly revenue report with margin computation
CREATE OR REPLACE VIEW revenue_pnl_monthly AS
SELECT
    date_trunc('month', created_at) AS month,
    currency,
    -- Revenue streams
    SUM(CASE WHEN event_type = 'platform_fee' THEN amount_cents ELSE 0 END) AS platform_fee_revenue,
    SUM(CASE WHEN event_type = 'featured_listing' THEN amount_cents ELSE 0 END) AS featured_revenue,
    SUM(CASE WHEN event_type = 'skill_verification' THEN amount_cents ELSE 0 END) AS skill_verification_revenue,
    SUM(CASE WHEN event_type = 'insurance_premium' THEN amount_cents ELSE 0 END) AS insurance_revenue,
    SUM(CASE WHEN event_type = 'subscription' THEN amount_cents ELSE 0 END) AS subscription_revenue,
    SUM(CASE WHEN event_type = 'per_task_fee' THEN amount_cents ELSE 0 END) AS per_task_fee_revenue,
    SUM(CASE WHEN event_type = 'xp_tax' THEN amount_cents ELSE 0 END) AS xp_tax_revenue,
    -- Losses
    SUM(CASE WHEN event_type = 'chargeback' THEN amount_cents ELSE 0 END) AS chargeback_losses,
    SUM(CASE WHEN event_type = 'chargeback_reversal' THEN amount_cents ELSE 0 END) AS chargeback_recoveries,
    SUM(CASE WHEN event_type = 'referral_payout' THEN amount_cents ELSE 0 END) AS referral_payouts,
    -- Cost of revenue (Stripe fees)
    SUM(COALESCE(stripe_processing_fee_cents, 0)) AS total_stripe_processing_fees,
    -- Totals
    SUM(amount_cents) AS gross_revenue,
    SUM(amount_cents) - SUM(COALESCE(stripe_processing_fee_cents, 0)) AS net_revenue_after_stripe,
    COUNT(*) AS total_events,
    -- Gross through escrow (GMV)
    SUM(CASE WHEN event_type = 'platform_fee' THEN gross_amount_cents ELSE 0 END) AS total_gmv_cents,
    -- Dispute rate (count)
    SUM(CASE WHEN event_type = 'chargeback' THEN 1 ELSE 0 END) AS dispute_count,
    SUM(CASE WHEN event_type = 'chargeback_reversal' THEN 1 ELSE 0 END) AS dispute_won_count
FROM revenue_ledger
GROUP BY date_trunc('month', created_at), currency
ORDER BY month DESC;
