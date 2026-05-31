-- ============================================================================
-- Migration 009 — C7 escrow schema alignment
-- ============================================================================
-- Context: C7 (Stripe Elements funding) exercised EscrowService.fund() against
-- the live Neon DB for the first time. fund() uses optimistic concurrency
-- control (SELECT version ... ; UPDATE ... SET version = version + 1 WHERE
-- version = $n), but the live `escrows` table was missing the `version`
-- column. The canonical schema has always declared it:
--
--   backend/database/constitutional-schema.sql:289
--     version INTEGER NOT NULL DEFAULT 1,  -- Optimistic concurrency control
--
-- This is additive schema drift (same class as migration 008). Adding the
-- column with the canonical default backfills every existing row to version 1,
-- which is exactly what a freshly-created escrow would have had.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS. Re-running is a no-op.
-- No money logic changed. No new escrow architecture. PENDING/FUNDED state
-- machine untouched.
-- ============================================================================

ALTER TABLE escrows
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
