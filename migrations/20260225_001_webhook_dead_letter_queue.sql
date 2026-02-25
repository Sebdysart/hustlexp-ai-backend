-- Webhook Dead Letter Queue (DLQ)
--
-- Purpose: Persist failed webhook events (Stripe, etc.) for later retry/investigation.
-- This prevents silent loss of financial webhook processing failures.

CREATE TABLE IF NOT EXISTS webhook_dead_letter_queue (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  error_message TEXT,
  failed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhook_dlq_failed_at ON webhook_dead_letter_queue (failed_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_dlq_event_type ON webhook_dead_letter_queue (event_type);
