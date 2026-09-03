-- Provider OS notification ledger: durable idempotency for SMS domain events.
-- Delivery still goes through sms_outbox + Twilio worker; this table prevents
-- duplicate emits across retries/webhooks for the same Provider OS event.

CREATE TABLE IF NOT EXISTS provider_os_notification_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL
    CHECK (event_type IN (
      'CLIENT_ONBOARDED',
      'CLIENT_TASK_CREATED',
      'PROVIDER_QUOTE_APPROVED',
      'TASK_PAYMENT_CONFIRMED'
    )),
  provider_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  poster_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  entity_type TEXT NOT NULL
    CHECK (entity_type IN (
      'relationship',
      'task_draft',
      'quote',
      'task'
    )),
  entity_id UUID NOT NULL,
  message_body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'skipped_no_phone', 'skipped_duplicate')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT provider_os_notification_events_unique
    UNIQUE (event_type, provider_user_id, entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_provider_os_notification_events_provider
  ON provider_os_notification_events (provider_user_id, created_at DESC);
