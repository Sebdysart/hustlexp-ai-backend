-- Stripe Webhook Idempotency Table
--
-- Purpose: Prevent duplicate processing when Stripe delivers the same webhook
-- event more than once (retries, network glitches, etc.).
--
-- Design: The event_id column is the PRIMARY KEY, so a concurrent or retried
-- INSERT … ON CONFLICT DO NOTHING is atomic and race-condition-safe at the
-- database level. No application-level locking is required.
--
-- Note: processed_at and event_type are captured for audit and monitoring.
--       The idx_processed_stripe_events_processed_at index supports TTL cleanup
--       queries (e.g. DELETE WHERE processed_at < NOW() - INTERVAL '90 days').

CREATE TABLE IF NOT EXISTS processed_stripe_events (
  event_id      TEXT PRIMARY KEY,
  processed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  event_type    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_processed_stripe_events_processed_at
  ON processed_stripe_events (processed_at);
