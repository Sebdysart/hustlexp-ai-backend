-- Disabled-by-default provider ledger for controlled local HX/OS certification.
-- Rows can only represent CONTROLLED_TEST tasks; production Stripe state remains
-- authoritative for every other task.

CREATE TABLE IF NOT EXISTS hxos_local_test_payment_intents (
  id TEXT PRIMARY KEY CHECK (id ~ '^pi_hxos_test_[a-f0-9]{32}$'),
  task_id UUID NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE RESTRICT,
  escrow_id UUID NOT NULL UNIQUE REFERENCES escrows(id) ON DELETE RESTRICT,
  poster_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL DEFAULT 'usd' CHECK (currency = 'usd'),
  status TEXT NOT NULL DEFAULT 'requires_confirmation'
    CHECK (status IN ('requires_confirmation', 'succeeded')),
  client_secret_hash TEXT NOT NULL CHECK (client_secret_hash ~ '^[a-f0-9]{64}$'),
  provider_mode TEXT NOT NULL DEFAULT 'test' CHECK (provider_mode = 'test'),
  is_test BOOLEAN NOT NULL DEFAULT TRUE CHECK (is_test IS TRUE),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  succeeded_at TIMESTAMPTZ,
  CHECK (
    (status = 'requires_confirmation' AND succeeded_at IS NULL)
    OR (status = 'succeeded' AND succeeded_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS hxos_local_test_payment_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_intent_id TEXT NOT NULL
    REFERENCES hxos_local_test_payment_intents(id) ON DELETE RESTRICT,
  from_status TEXT,
  to_status TEXT NOT NULL CHECK (to_status IN ('requires_confirmation', 'succeeded')),
  event_type TEXT NOT NULL CHECK (event_type IN ('intent_created', 'intent_succeeded')),
  idempotency_key TEXT NOT NULL UNIQUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_test BOOLEAN NOT NULL DEFAULT TRUE CHECK (is_test IS TRUE),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION guard_hxos_local_test_payment_intent()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.id <> OLD.id
     OR NEW.task_id <> OLD.task_id
     OR NEW.escrow_id <> OLD.escrow_id
     OR NEW.poster_id <> OLD.poster_id
     OR NEW.amount_cents <> OLD.amount_cents
     OR NEW.currency <> OLD.currency
     OR NEW.client_secret_hash <> OLD.client_secret_hash
     OR NEW.provider_mode <> OLD.provider_mode
     OR NEW.is_test <> OLD.is_test
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'HXLP1: local TEST payment identity and economics are immutable';
  END IF;
  IF OLD.status = 'succeeded' AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'HXLP2: succeeded local TEST payment is terminal';
  END IF;
  IF OLD.status = 'requires_confirmation' AND NEW.status NOT IN ('requires_confirmation', 'succeeded') THEN
    RAISE EXCEPTION 'HXLP3: invalid local TEST payment transition';
  END IF;
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS hxos_local_test_payment_intent_guard
  ON hxos_local_test_payment_intents;
CREATE TRIGGER hxos_local_test_payment_intent_guard
BEFORE UPDATE ON hxos_local_test_payment_intents
FOR EACH ROW EXECUTE FUNCTION guard_hxos_local_test_payment_intent();

CREATE OR REPLACE FUNCTION reject_hxos_local_test_payment_event_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'HXLP4: local TEST payment events are append-only';
END;
$$;

DROP TRIGGER IF EXISTS hxos_local_test_payment_events_append_only
  ON hxos_local_test_payment_events;
CREATE TRIGGER hxos_local_test_payment_events_append_only
BEFORE UPDATE OR DELETE ON hxos_local_test_payment_events
FOR EACH ROW EXECUTE FUNCTION reject_hxos_local_test_payment_event_mutation();

CREATE OR REPLACE FUNCTION enforce_hxos_local_test_payment_task()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  task_row RECORD;
  escrow_row RECORD;
BEGIN
  SELECT poster_id, price, automation_classification
    INTO task_row
  FROM tasks
  WHERE id = NEW.task_id;
  SELECT task_id, amount, state
    INTO escrow_row
  FROM escrows
  WHERE id = NEW.escrow_id;
  IF task_row.automation_classification <> 'CONTROLLED_TEST'
     OR task_row.poster_id <> NEW.poster_id
     OR task_row.price <> NEW.amount_cents
     OR escrow_row.task_id <> NEW.task_id
     OR escrow_row.amount <> NEW.amount_cents
     OR escrow_row.state <> 'PENDING' THEN
    RAISE EXCEPTION 'HXLP5: local payment requires a matching pending CONTROLLED_TEST task and escrow';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS hxos_local_test_payment_task_gate
  ON hxos_local_test_payment_intents;
CREATE TRIGGER hxos_local_test_payment_task_gate
BEFORE INSERT ON hxos_local_test_payment_intents
FOR EACH ROW EXECUTE FUNCTION enforce_hxos_local_test_payment_task();
