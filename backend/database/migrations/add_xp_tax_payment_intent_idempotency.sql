-- Migration: add_xp_tax_payment_intent_idempotency.sql
-- Purpose:   Add stripe_payment_intent_id to xp_tax_ledger for idempotency.
--            Prevents double-charging when payTax() is retried with the same
--            Stripe payment intent (e.g. client network retry after server 5xx).
-- Idempotent: Uses IF NOT EXISTS / DO NOTHING guards throughout.

-- Add the column (nullable — existing rows predate this migration)
ALTER TABLE xp_tax_ledger
  ADD COLUMN IF NOT EXISTS stripe_payment_intent_id TEXT;

-- Unique index: one intent ID may pay at most one ledger entry.
-- Partial index (WHERE stripe_payment_intent_id IS NOT NULL) avoids false
-- conflicts on the many existing rows that have no intent ID.
CREATE UNIQUE INDEX IF NOT EXISTS idx_xp_tax_ledger_stripe_intent
  ON xp_tax_ledger (stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;

-- Index to accelerate the idempotency lookup in payTax():
--   SELECT id FROM xp_tax_ledger WHERE stripe_payment_intent_id = $1 AND tax_paid = TRUE
-- The unique index above already covers equality lookups, but the partial index
-- on (stripe_payment_intent_id, tax_paid) makes the paid-only filter cheap.
CREATE INDEX IF NOT EXISTS idx_xp_tax_ledger_intent_paid
  ON xp_tax_ledger (stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL AND tax_paid = TRUE;

COMMENT ON COLUMN xp_tax_ledger.stripe_payment_intent_id IS
  'Stripe PaymentIntent ID that satisfied this tax entry. NULL for pre-migration rows. '
  'Used by XPTaxService.payTax() for idempotency: if this intent was already processed '
  'the call returns early without re-applying XP or re-marking entries as paid.';
