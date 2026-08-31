-- Bounded recovery rail for quote payments created before task-first
-- underwriting containment. A durable operation claim and immutable CLAIMED
-- event must commit before any processor call; terminal facts are appended
-- after provider reconciliation. Processor payloads and free-form reasons are
-- prohibited.

CREATE TABLE IF NOT EXISTS public.quote_payment_recovery_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_payment_id UUID NOT NULL UNIQUE
    REFERENCES public.quote_payments(id) ON DELETE RESTRICT,
  actor_id UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  reason_code TEXT NOT NULL CHECK (reason_code IN (
    'UNDERWRITING_CONTAINMENT',
    'POSTER_REQUESTED_CANCELLATION'
  )),
  expected_status TEXT NOT NULL CHECK (expected_status IN (
    'PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED'
  )),
  expected_payment_updated_at TIMESTAMPTZ NOT NULL,
  operation_state TEXT NOT NULL DEFAULT 'CLAIMED' CHECK (operation_state IN (
    'CLAIMED', 'COMPLETED', 'RECONCILIATION_REQUIRED'
  )),
  claim_token UUID NOT NULL UNIQUE,
  correlation_id UUID NOT NULL UNIQUE,
  lease_expires_at TIMESTAMPTZ NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count > 0),
  recovery_action TEXT CHECK (recovery_action IN ('VOIDED', 'REFUNDED')),
  provider_status TEXT CHECK (
    provider_status IS NULL OR char_length(provider_status) BETWEEN 2 AND 64
  ),
  provider_operation_id TEXT CHECK (
    provider_operation_id IS NULL OR char_length(provider_operation_id) BETWEEN 3 AND 255
  ),
  last_error_code TEXT CHECK (
    last_error_code IS NULL OR last_error_code ~ '^[A-Z0-9_]{3,96}$'
  ),
  idempotency_key TEXT NOT NULL UNIQUE
    CHECK (idempotency_key ~ '^[A-Za-z0-9:_-]{8,240}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (operation_state = 'CLAIMED'
      AND recovery_action IS NULL
      AND provider_status IS NULL
      AND provider_operation_id IS NULL)
    OR
    (operation_state IN ('COMPLETED', 'RECONCILIATION_REQUIRED')
      AND recovery_action IS NOT NULL
      AND provider_status IS NOT NULL
      AND provider_operation_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS quote_payment_recovery_operations_state_idx
  ON public.quote_payment_recovery_operations(operation_state, lease_expires_at);

CREATE TABLE IF NOT EXISTS public.quote_payment_recovery_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recovery_operation_id UUID NOT NULL
    REFERENCES public.quote_payment_recovery_operations(id) ON DELETE RESTRICT,
  quote_payment_id UUID NOT NULL
    REFERENCES public.quote_payments(id) ON DELETE RESTRICT,
  actor_id UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'CLAIMED', 'CLAIM_RENEWED', 'COMPLETED', 'RECONCILIATION_REQUIRED'
  )),
  reason_code TEXT NOT NULL CHECK (reason_code IN (
    'UNDERWRITING_CONTAINMENT',
    'POSTER_REQUESTED_CANCELLATION'
  )),
  recovery_action TEXT CHECK (recovery_action IN ('VOIDED', 'REFUNDED')),
  from_status TEXT NOT NULL CHECK (from_status IN (
    'PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED'
  )),
  canonical_status TEXT NOT NULL CHECK (canonical_status IN (
    'PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED'
  )),
  provider_status TEXT CHECK (
    provider_status IS NULL OR char_length(provider_status) BETWEEN 2 AND 64
  ),
  provider_operation_id TEXT CHECK (
    provider_operation_id IS NULL OR char_length(provider_operation_id) BETWEEN 3 AND 255
  ),
  idempotency_key TEXT NOT NULL UNIQUE
    CHECK (idempotency_key ~ '^[A-Za-z0-9:_-]{8,240}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (event_type IN ('CLAIMED', 'CLAIM_RENEWED')
      AND recovery_action IS NULL
      AND provider_status IS NULL
      AND provider_operation_id IS NULL
      AND canonical_status = from_status)
    OR
    (event_type = 'COMPLETED'
      AND recovery_action IS NOT NULL
      AND provider_status IS NOT NULL
      AND provider_operation_id IS NOT NULL
      AND (
        (recovery_action = 'VOIDED' AND canonical_status = 'FAILED')
        OR (recovery_action = 'REFUNDED' AND canonical_status = 'REFUNDED')
      ))
    OR
    (event_type = 'RECONCILIATION_REQUIRED'
      AND recovery_action IS NOT NULL
      AND provider_status IS NOT NULL
      AND provider_operation_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS quote_payment_recovery_events_payment_idx
  ON public.quote_payment_recovery_events(quote_payment_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS quote_payment_recovery_terminal_event_uq
  ON public.quote_payment_recovery_events(recovery_operation_id)
  WHERE event_type IN ('COMPLETED', 'RECONCILIATION_REQUIRED');

CREATE OR REPLACE FUNCTION public.guard_quote_payment_recovery_operation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'HXQPR1: quote payment recovery operations cannot be removed';
  END IF;
  IF NEW.id <> OLD.id
     OR NEW.quote_payment_id <> OLD.quote_payment_id
     OR NEW.actor_id <> OLD.actor_id
     OR NEW.reason_code <> OLD.reason_code
     OR NEW.expected_status <> OLD.expected_status
     OR NEW.expected_payment_updated_at <> OLD.expected_payment_updated_at
     OR NEW.correlation_id <> OLD.correlation_id
     OR NEW.idempotency_key <> OLD.idempotency_key
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'HXQPR2: quote payment recovery identity is immutable';
  END IF;
  IF OLD.operation_state <> 'CLAIMED' THEN
    RAISE EXCEPTION 'HXQPR3: terminal quote payment recovery operation is immutable';
  END IF;
  IF NEW.operation_state NOT IN ('CLAIMED', 'COMPLETED', 'RECONCILIATION_REQUIRED') THEN
    RAISE EXCEPTION 'HXQPR4: invalid quote payment recovery transition';
  END IF;
  IF NEW.attempt_count < OLD.attempt_count THEN
    RAISE EXCEPTION 'HXQPR4: recovery attempt count cannot decrease';
  END IF;
  IF NEW.operation_state = 'CLAIMED'
     AND NEW.claim_token <> OLD.claim_token
     AND NEW.attempt_count <> OLD.attempt_count + 1 THEN
    RAISE EXCEPTION 'HXQPR4: claim renewal must increment the attempt count once';
  END IF;
  IF NEW.operation_state = 'CLAIMED'
     AND NEW.claim_token = OLD.claim_token
     AND NEW.attempt_count <> OLD.attempt_count THEN
    RAISE EXCEPTION 'HXQPR4: provider observation cannot change attempt ownership';
  END IF;
  IF NEW.operation_state = 'CLAIMED'
     AND NEW.claim_token = OLD.claim_token
     AND NEW.lease_expires_at <> OLD.lease_expires_at THEN
    RAISE EXCEPTION 'HXQPR4: provider observation cannot extend its processor lease';
  END IF;
  IF NEW.operation_state = 'CLAIMED'
     AND NEW.claim_token <> OLD.claim_token
     AND NEW.lease_expires_at <= OLD.lease_expires_at THEN
    RAISE EXCEPTION 'HXQPR4: claim renewal must advance the processor lease';
  END IF;
  IF NEW.operation_state <> 'CLAIMED'
     AND (NEW.claim_token <> OLD.claim_token
       OR NEW.attempt_count <> OLD.attempt_count
       OR NEW.lease_expires_at <> OLD.lease_expires_at) THEN
    RAISE EXCEPTION 'HXQPR4: terminalization cannot rewrite claim ownership';
  END IF;
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS quote_payment_recovery_operations_guard
  ON public.quote_payment_recovery_operations;
CREATE TRIGGER quote_payment_recovery_operations_guard
BEFORE UPDATE OR DELETE ON public.quote_payment_recovery_operations
FOR EACH ROW EXECUTE FUNCTION public.guard_quote_payment_recovery_operation();

DROP TRIGGER IF EXISTS quote_payment_recovery_operations_no_truncate
  ON public.quote_payment_recovery_operations;
CREATE TRIGGER quote_payment_recovery_operations_no_truncate
BEFORE TRUNCATE ON public.quote_payment_recovery_operations
FOR EACH STATEMENT EXECUTE FUNCTION public.guard_quote_payment_recovery_operation();

CREATE OR REPLACE FUNCTION public.reject_quote_payment_recovery_event_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'HXQPR5: quote payment recovery events are append-only';
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
