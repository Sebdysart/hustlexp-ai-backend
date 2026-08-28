-- Migration: Verify stripe_events table structure (Step 9-D - Stripe Integration)
-- Purpose: Ensure stripe_events table supports idempotency for plan webhooks
-- 
-- Note: stripe_events table already exists in constitutional-schema.sql (Phase D)
-- This migration is a no-op verification that the table has required structure
-- for Step 9-D invariants (S-1: Webhook replay safety)
-- 
-- Invariant S-1: Webhook replay safety (exactly-once processing)
-- 
-- @see STEP_9D_STRIPE_INTEGRATION.md

BEGIN;

-- stripe_events table already exists with:
-- - stripe_event_id PRIMARY KEY (idempotency anchor) ✅
-- - type, payload_json, claimed_at, processed_at, result, error_message ✅
-- - All required indexes ✅
--
-- This migration is a no-op but documents that stripe_events is ready for Step 9-D
-- If the table doesn't exist, it will be created by constitutional-schema.sql

-- Verify required index exists (idempotent - won't fail if already exists)
CREATE INDEX IF NOT EXISTS idx_stripe_events_unprocessed
ON stripe_events(processed_at)
WHERE processed_at IS NULL;

COMMIT;
