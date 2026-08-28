-- Migration: Add claimed_at column to stripe_events table
-- Purpose: Separate claim time (processing started) from processed time (terminal finalized)
-- Phase D: Operational correctness for payment event processing

-- Add claimed_at column
ALTER TABLE stripe_events
ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

-- Optional: Backfill claimed_at from processed_at for any events that were previously set
-- This handles any historical data where processed_at was used as claim time
UPDATE stripe_events
SET claimed_at = processed_at
WHERE claimed_at IS NULL
  AND result = 'processing'
  AND processed_at IS NOT NULL;

-- Add CHECK constraint on result (if not already exists)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'stripe_events_result_check'
    ) THEN
        ALTER TABLE stripe_events
        ADD CONSTRAINT stripe_events_result_check
        CHECK (result IS NULL OR result IN ('processing', 'success', 'failed', 'skipped'));
    END IF;
END $$;

-- Add new indexes for unclaimed events and stuck processing recovery
CREATE INDEX IF NOT EXISTS idx_stripe_events_unclaimed
ON stripe_events(created)
WHERE claimed_at IS NULL AND processed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_stripe_events_stuck_processing
ON stripe_events(claimed_at)
WHERE result = 'processing' AND processed_at IS NULL;
