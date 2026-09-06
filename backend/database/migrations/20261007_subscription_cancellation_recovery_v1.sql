-- Append-only recovery evidence for provider subscription cancellation.
-- The users.stripe_subscription_id reference is cleared only after a
-- provider-confirmed cancellation event has been recorded.

CREATE TABLE IF NOT EXISTS subscription_cancellation_events_v1 (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  operation_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  provider_kind TEXT NOT NULL CHECK (provider_kind = 'stripe'),
  external_subscription_id TEXT NOT NULL CHECK (length(btrim(external_subscription_id)) > 0),
  status TEXT NOT NULL CHECK (
    status IN (
      'CANCELLATION_PENDING',
      'PROVIDER_FAILED',
      'CANCELLATION_UNCERTAIN',
      'CANCELLED_CONFIRMED'
    )
  ),
  error_code TEXT,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (status IN ('PROVIDER_FAILED', 'CANCELLATION_UNCERTAIN') AND error_code IS NOT NULL)
    OR (status NOT IN ('PROVIDER_FAILED', 'CANCELLATION_UNCERTAIN') AND error_code IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS subscription_cancellation_events_one_pending_idx
  ON subscription_cancellation_events_v1 (operation_id)
  WHERE status = 'CANCELLATION_PENDING';

CREATE UNIQUE INDEX IF NOT EXISTS subscription_cancellation_events_one_confirmed_idx
  ON subscription_cancellation_events_v1 (operation_id)
  WHERE status = 'CANCELLED_CONFIRMED';

CREATE INDEX IF NOT EXISTS subscription_cancellation_events_user_idx
  ON subscription_cancellation_events_v1 (user_id, event_sequence DESC);

CREATE INDEX IF NOT EXISTS subscription_cancellation_events_external_idx
  ON subscription_cancellation_events_v1
    (user_id, provider_kind, external_subscription_id, event_sequence DESC);

DROP TRIGGER IF EXISTS subscription_cancellation_events_no_mutation
  ON subscription_cancellation_events_v1;
CREATE TRIGGER subscription_cancellation_events_no_mutation
BEFORE UPDATE OR DELETE ON subscription_cancellation_events_v1
FOR EACH ROW EXECUTE FUNCTION prevent_append_only_row_mutation();

DROP TRIGGER IF EXISTS subscription_cancellation_events_no_truncate
  ON subscription_cancellation_events_v1;
CREATE TRIGGER subscription_cancellation_events_no_truncate
BEFORE TRUNCATE ON subscription_cancellation_events_v1
FOR EACH STATEMENT EXECUTE FUNCTION prevent_append_only_truncate();
