-- HX/OS 2.0 Hustler wallet and bank-payout contract.
--
-- A Stripe transfer proves that task earnings reached the Hustler's connected
-- balance. It does not prove that money reached a bank account. Bank cash-outs
-- therefore have their own constrained state projection and append-only event
-- trail. Browser callers can create only INITIATING requests; provider-backed
-- API responses and webhooks own every later state.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS worker_cash_out_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id UUID REFERENCES users(id) ON DELETE SET NULL,
  provider TEXT NOT NULL DEFAULT 'STRIPE' CHECK (provider = 'STRIPE'),
  provider_account_id TEXT,
  provider_payout_id TEXT UNIQUE,
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  request_hash CHAR(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  fee_cents INTEGER NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
  net_cents INTEGER NOT NULL CHECK (net_cents > 0),
  currency VARCHAR(3) NOT NULL DEFAULT 'usd' CHECK (currency = 'usd'),
  method TEXT NOT NULL CHECK (method IN ('STANDARD')),
  provider_destination_id TEXT,
  destination_type TEXT NOT NULL CHECK (destination_type IN ('BANK_ACCOUNT','DEBIT_CARD')),
  destination_last4 CHAR(4) NOT NULL CHECK (destination_last4 ~ '^[0-9]{4}$'),
  destination_label TEXT NOT NULL CHECK (char_length(destination_label) BETWEEN 1 AND 100),
  state TEXT NOT NULL DEFAULT 'INITIATING' CHECK (state IN (
    'INITIATING','SUBMITTED','PROVIDER_PROCESSING','PAID','FAILED','REVERSED'
  )),
  estimated_arrival_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  failure_code TEXT,
  failure_message TEXT,
  last_transition_source TEXT NOT NULL DEFAULT 'USER_REQUEST' CHECK (
    last_transition_source IN ('USER_REQUEST','PROVIDER_API','PROVIDER_WEBHOOK','RECOVERY')
  ),
  last_provider_event_id TEXT,
  policy_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (worker_id, idempotency_key),
  CHECK (net_cents = amount_cents - fee_cents),
  CHECK (fee_cents < amount_cents),
  CHECK ((state = 'PAID' AND paid_at IS NOT NULL) OR state <> 'PAID'),
  CHECK ((state = 'FAILED' AND failure_code IS NOT NULL) OR state <> 'FAILED'),
  CHECK (
    state = 'INITIATING'
    OR provider_payout_id IS NOT NULL
    OR (state = 'FAILED' AND last_transition_source = 'PROVIDER_API')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS worker_cash_out_one_active_idx
  ON worker_cash_out_requests(worker_id)
  WHERE state IN ('INITIATING','SUBMITTED','PROVIDER_PROCESSING');
CREATE INDEX IF NOT EXISTS worker_cash_out_worker_created_idx
  ON worker_cash_out_requests(worker_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS worker_cash_out_provider_event_idx
  ON worker_cash_out_requests(last_provider_event_id)
  WHERE last_provider_event_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS worker_cash_out_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cash_out_request_id UUID NOT NULL REFERENCES worker_cash_out_requests(id) ON DELETE RESTRICT,
  worker_id UUID REFERENCES users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'INITIATING','SUBMITTED','PROVIDER_PROCESSING','PAID','FAILED','REVERSED'
  )),
  source TEXT NOT NULL CHECK (source IN (
    'USER_REQUEST','PROVIDER_API','PROVIDER_WEBHOOK','RECOVERY'
  )),
  provider_event_id TEXT,
  provider_payout_id TEXT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  fee_cents INTEGER NOT NULL CHECK (fee_cents >= 0),
  net_cents INTEGER NOT NULL CHECK (net_cents > 0),
  currency VARCHAR(3) NOT NULL CHECK (currency = 'usd'),
  public_reason TEXT CHECK (public_reason IS NULL OR char_length(public_reason) BETWEEN 1 AND 500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (cash_out_request_id, event_type, provider_event_id),
  CHECK (net_cents = amount_cents - fee_cents)
);

CREATE INDEX IF NOT EXISTS worker_cash_out_events_request_idx
  ON worker_cash_out_events(cash_out_request_id, created_at ASC);
CREATE INDEX IF NOT EXISTS worker_cash_out_events_worker_idx
  ON worker_cash_out_events(worker_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS worker_cash_out_events_provider_event_idx
  ON worker_cash_out_events(provider_event_id)
  WHERE provider_event_id IS NOT NULL;

CREATE OR REPLACE FUNCTION guard_worker_cash_out_request_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'HXWAL1: cash-out requests are permanent financial records'
      USING ERRCODE = 'P0001';
  END IF;

  -- Sole privacy exception: unlink the person and scrub destination routing
  -- while preserving amounts, provider payout evidence, state and timestamps.
  IF OLD.worker_id IS NOT NULL
     AND NEW.worker_id IS NULL
     AND NEW.provider_account_id IS NULL
     AND NEW.provider_destination_id IS NULL
     AND NEW.destination_last4 = '0000'
     AND NEW.destination_label = 'Deleted payout destination'
     AND NEW.provider IS NOT DISTINCT FROM OLD.provider
     AND NEW.provider_payout_id IS NOT DISTINCT FROM OLD.provider_payout_id
     AND NEW.idempotency_key IS NOT DISTINCT FROM OLD.idempotency_key
     AND NEW.request_hash IS NOT DISTINCT FROM OLD.request_hash
     AND NEW.amount_cents IS NOT DISTINCT FROM OLD.amount_cents
     AND NEW.fee_cents IS NOT DISTINCT FROM OLD.fee_cents
     AND NEW.net_cents IS NOT DISTINCT FROM OLD.net_cents
     AND NEW.currency IS NOT DISTINCT FROM OLD.currency
     AND NEW.method IS NOT DISTINCT FROM OLD.method
     AND NEW.destination_type IS NOT DISTINCT FROM OLD.destination_type
     AND NEW.state IS NOT DISTINCT FROM OLD.state
     AND NEW.estimated_arrival_at IS NOT DISTINCT FROM OLD.estimated_arrival_at
     AND NEW.paid_at IS NOT DISTINCT FROM OLD.paid_at
     AND NEW.failure_code IS NOT DISTINCT FROM OLD.failure_code
     AND NEW.failure_message IS NOT DISTINCT FROM OLD.failure_message
     AND NEW.last_transition_source IS NOT DISTINCT FROM OLD.last_transition_source
     AND NEW.last_provider_event_id IS NOT DISTINCT FROM OLD.last_provider_event_id
     AND NEW.policy_version IS NOT DISTINCT FROM OLD.policy_version
     AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at THEN
    NEW.updated_at := NOW();
    RETURN NEW;
  END IF;

  IF NEW.worker_id IS DISTINCT FROM OLD.worker_id
     OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.provider_account_id IS DISTINCT FROM OLD.provider_account_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.amount_cents IS DISTINCT FROM OLD.amount_cents
     OR NEW.fee_cents IS DISTINCT FROM OLD.fee_cents
     OR NEW.net_cents IS DISTINCT FROM OLD.net_cents
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.method IS DISTINCT FROM OLD.method
     OR NEW.provider_destination_id IS DISTINCT FROM OLD.provider_destination_id
     OR NEW.destination_type IS DISTINCT FROM OLD.destination_type
     OR NEW.destination_last4 IS DISTINCT FROM OLD.destination_last4
     OR NEW.destination_label IS DISTINCT FROM OLD.destination_label
     OR NEW.policy_version IS DISTINCT FROM OLD.policy_version
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'HXWAL2: immutable cash-out terms cannot change'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF NOT (
      (OLD.state = 'INITIATING' AND NEW.state IN ('SUBMITTED','PROVIDER_PROCESSING','PAID','FAILED'))
      OR (OLD.state = 'SUBMITTED' AND NEW.state IN ('PROVIDER_PROCESSING','PAID','FAILED'))
      OR (OLD.state = 'PROVIDER_PROCESSING' AND NEW.state IN ('PAID','FAILED'))
      OR (OLD.state = 'PAID' AND NEW.state = 'REVERSED')
    ) THEN
      RAISE EXCEPTION 'HXWAL3: illegal cash-out transition % -> %', OLD.state, NEW.state
        USING ERRCODE = 'P0001';
    END IF;

    IF NEW.state IN ('SUBMITTED','PROVIDER_PROCESSING','PAID','REVERSED')
       AND NEW.provider_payout_id IS NULL THEN
      RAISE EXCEPTION 'HXWAL4: provider payout evidence is required for state %', NEW.state
        USING ERRCODE = 'P0001';
    END IF;

    IF NEW.state IN ('PAID','REVERSED')
       AND NEW.last_transition_source NOT IN ('PROVIDER_API','PROVIDER_WEBHOOK','RECOVERY') THEN
      RAISE EXCEPTION 'HXWAL5: provider-backed source required for state %', NEW.state
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS worker_cash_out_request_guard ON worker_cash_out_requests;
CREATE TRIGGER worker_cash_out_request_guard
BEFORE UPDATE OR DELETE ON worker_cash_out_requests
FOR EACH ROW EXECUTE FUNCTION guard_worker_cash_out_request_mutation();

CREATE OR REPLACE FUNCTION record_worker_cash_out_event()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.state IS DISTINCT FROM OLD.state THEN
    INSERT INTO worker_cash_out_events (
      cash_out_request_id,worker_id,event_type,source,provider_event_id,
      provider_payout_id,amount_cents,fee_cents,net_cents,currency,public_reason
    ) VALUES (
      NEW.id,NEW.worker_id,NEW.state,NEW.last_transition_source,NEW.last_provider_event_id,
      NEW.provider_payout_id,NEW.amount_cents,NEW.fee_cents,NEW.net_cents,NEW.currency,
      CASE
        WHEN NEW.state = 'FAILED' THEN COALESCE(NEW.failure_message,'Bank payout failed.')
        WHEN NEW.state = 'REVERSED' THEN 'The provider reversed this bank payout.'
        ELSE NULL
      END
    )
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS worker_cash_out_request_event ON worker_cash_out_requests;
CREATE TRIGGER worker_cash_out_request_event
AFTER INSERT OR UPDATE OF state ON worker_cash_out_requests
FOR EACH ROW EXECUTE FUNCTION record_worker_cash_out_event();

CREATE OR REPLACE FUNCTION prevent_worker_cash_out_event_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  old_unlinked worker_cash_out_events%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.worker_id IS NOT NULL
     AND NEW.worker_id IS NULL THEN
    old_unlinked := OLD;
    old_unlinked.worker_id := NULL;
    IF NEW IS NOT DISTINCT FROM old_unlinked THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'HXWAL6: cash-out events are append-only'
    USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS worker_cash_out_events_immutable ON worker_cash_out_events;
CREATE TRIGGER worker_cash_out_events_immutable
BEFORE UPDATE OR DELETE ON worker_cash_out_events
FOR EACH ROW EXECUTE FUNCTION prevent_worker_cash_out_event_mutation();

CREATE OR REPLACE FUNCTION anonymize_worker_wallet_on_user_deletion()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.account_status::text = 'DELETED'
     AND OLD.account_status::text IS DISTINCT FROM 'DELETED' THEN
    UPDATE worker_cash_out_requests
    SET worker_id = NULL,
        provider_account_id = NULL,
        provider_destination_id = NULL,
        destination_last4 = '0000',
        destination_label = 'Deleted payout destination'
    WHERE worker_id = NEW.id;

    UPDATE worker_cash_out_events
    SET worker_id = NULL
    WHERE worker_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_anonymize_worker_wallet ON users;
CREATE TRIGGER users_anonymize_worker_wallet
AFTER UPDATE OF account_status ON users
FOR EACH ROW EXECUTE FUNCTION anonymize_worker_wallet_on_user_deletion();

COMMENT ON TABLE worker_cash_out_requests IS
  'Current projection for Hustler bank cash-outs; never conflates connected-balance release with bank receipt.';
COMMENT ON TABLE worker_cash_out_events IS
  'Append-only provider-backed bank-payout state history with no raw bank credentials.';
