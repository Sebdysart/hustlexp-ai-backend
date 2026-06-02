-- Migration: add_xp_tax_pi_row_idempotency_table.sql
-- Purpose:   Add a per-PI per-row dedup table for XPTaxService.payTax() FIFO loop.
--            Prevents double-XP-award when a serializableTransaction is retried due
--            to Postgres serialization failure (error 40001): on retry the callback
--            re-runs, but any row already processed in the prior attempt would be
--            processed again — double-awarding XP. The INSERT ON CONFLICT DO NOTHING
--            ensures each (stripe_payment_intent_id, ledger_row_id) pair is processed
--            at most once, even across retries.
-- Idempotent: Uses IF NOT EXISTS throughout.

CREATE TABLE IF NOT EXISTS xp_tax_payment_intent_idempotency (
  stripe_payment_intent_id  TEXT        NOT NULL,
  xp_tax_ledger_id          UUID        NOT NULL,
  processed_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (stripe_payment_intent_id, xp_tax_ledger_id)
);

COMMENT ON TABLE xp_tax_payment_intent_idempotency IS
  'Per-PI per-ledger-row dedup guard for XPTaxService.payTax() FIFO loop. '
  'Before awarding XP for a tax row, the loop INSERTs (pi_id, ledger_row_id) with '
  'ON CONFLICT DO NOTHING. If rowCount=0 the row was already processed (retry) and '
  'XP award is skipped. Prevents double-XP on serializableTransaction retries.';

CREATE INDEX IF NOT EXISTS idx_xp_tax_pi_idempotency_ledger_id
  ON xp_tax_payment_intent_idempotency (xp_tax_ledger_id);
