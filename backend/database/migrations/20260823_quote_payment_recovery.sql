-- Bounded recovery rail for quote payments created before task-first
-- underwriting containment. This table records normalized recovery facts only;
-- processor payloads and arbitrary reason text are prohibited.

CREATE TABLE IF NOT EXISTS public.quote_payment_recovery_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_payment_id UUID NOT NULL
    REFERENCES public.quote_payments(id) ON DELETE RESTRICT,
  actor_id UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  reason_code TEXT NOT NULL CHECK (reason_code IN (
    'UNDERWRITING_CONTAINMENT',
    'POSTER_REQUESTED_CANCELLATION'
  )),
  recovery_action TEXT NOT NULL CHECK (recovery_action IN ('VOIDED', 'REFUNDED')),
  from_status TEXT NOT NULL CHECK (from_status IN ('PENDING', 'SUCCEEDED')),
  to_status TEXT NOT NULL CHECK (to_status IN ('FAILED', 'REFUNDED')),
  provider_status TEXT NOT NULL CHECK (char_length(provider_status) BETWEEN 2 AND 64),
  provider_operation_id TEXT NOT NULL
    CHECK (char_length(provider_operation_id) BETWEEN 3 AND 255),
  idempotency_key TEXT NOT NULL UNIQUE
    CHECK (idempotency_key ~ '^[A-Za-z0-9:_-]{8,240}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (quote_payment_id),
  CHECK (
    (recovery_action = 'VOIDED' AND to_status = 'FAILED')
    OR (recovery_action = 'REFUNDED' AND to_status = 'REFUNDED')
  )
);

CREATE INDEX IF NOT EXISTS quote_payment_recovery_events_payment_idx
  ON public.quote_payment_recovery_events(quote_payment_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.reject_quote_payment_recovery_event_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'HXQPR1: quote payment recovery events are append-only';
END;
$$;

DROP TRIGGER IF EXISTS quote_payment_recovery_events_append_only
  ON public.quote_payment_recovery_events;
CREATE TRIGGER quote_payment_recovery_events_append_only
BEFORE UPDATE OR DELETE ON public.quote_payment_recovery_events
FOR EACH ROW EXECUTE FUNCTION public.reject_quote_payment_recovery_event_mutation();

DROP TRIGGER IF EXISTS quote_payment_recovery_events_no_truncate
  ON public.quote_payment_recovery_events;
CREATE TRIGGER quote_payment_recovery_events_no_truncate
BEFORE TRUNCATE ON public.quote_payment_recovery_events
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_quote_payment_recovery_event_mutation();
