-- HX/OS bounded worker counter and customer reauthorization contract.
-- A counter never edits funded money. Poster approval requires the original
-- payment to be provider-confirmed REFUNDED and the task CANCELLED before a
-- distinct, unassigned replacement task can be created with a fresh PENDING escrow.

CREATE TABLE IF NOT EXISTS worker_counter_offers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  worker_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  offer_decision_id UUID NOT NULL REFERENCES worker_offer_decisions(id) ON DELETE RESTRICT,
  source_scope_version_id UUID NOT NULL REFERENCES task_scope_versions(id) ON DELETE RESTRICT,
  proposed_scope_hash CHAR(64) NOT NULL CHECK (proposed_scope_hash ~ '^[a-f0-9]{64}$'),
  policy_version TEXT NOT NULL,
  request_hash CHAR(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 128),
  status TEXT NOT NULL CHECK (status IN (
    'PENDING_POSTER','REJECTED','APPROVED_REAUTH_REQUIRED','MATERIALIZED','EXPIRED'
  )),
  current_customer_total_cents INTEGER NOT NULL CHECK (current_customer_total_cents > 0),
  current_payout_cents INTEGER NOT NULL CHECK (current_payout_cents > 0),
  platform_margin_cents INTEGER NOT NULL CHECK (platform_margin_cents >= 0),
  minimum_counter_payout_cents INTEGER NOT NULL CHECK (minimum_counter_payout_cents > 0),
  maximum_counter_payout_cents INTEGER NOT NULL CHECK (maximum_counter_payout_cents >= minimum_counter_payout_cents),
  customer_maximum_cents INTEGER NOT NULL CHECK (customer_maximum_cents >= current_customer_total_cents),
  margin_floor_bps INTEGER NOT NULL CHECK (margin_floor_bps BETWEEN 0 AND 10000),
  proposed_payout_cents INTEGER NOT NULL,
  proposed_customer_total_cents INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 10 AND 500),
  reviewed_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  review_reason TEXT,
  reviewed_at TIMESTAMPTZ,
  replacement_task_id UUID REFERENCES tasks(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (worker_id, idempotency_key),
  UNIQUE (replacement_task_id),
  CHECK (proposed_payout_cents BETWEEN minimum_counter_payout_cents AND maximum_counter_payout_cents),
  CHECK (proposed_customer_total_cents = proposed_payout_cents + platform_margin_cents),
  CHECK (proposed_customer_total_cents <= customer_maximum_cents),
  CHECK (platform_margin_cents * 10000 >= proposed_customer_total_cents * margin_floor_bps),
  CHECK (
    (status IN ('PENDING_POSTER','EXPIRED') AND reviewed_by IS NULL AND reviewed_at IS NULL AND replacement_task_id IS NULL)
    OR (status IN ('REJECTED','APPROVED_REAUTH_REQUIRED') AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND replacement_task_id IS NULL)
    OR (status = 'MATERIALIZED' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND replacement_task_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS worker_counter_offers_one_active
  ON worker_counter_offers(task_id, worker_id)
  WHERE status IN ('PENDING_POSTER','APPROVED_REAUTH_REQUIRED');

CREATE INDEX IF NOT EXISTS worker_counter_offers_task_time
  ON worker_counter_offers(task_id, created_at DESC);

CREATE TABLE IF NOT EXISTS worker_counter_offer_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  counter_offer_id UUID NOT NULL REFERENCES worker_counter_offers(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN ('SUBMITTED','APPROVED','REJECTED','MATERIALIZED','EXPIRED')),
  actor_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 128),
  request_hash CHAR(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  details JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (actor_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS worker_counter_offer_events_counter_time
  ON worker_counter_offer_events(counter_offer_id, created_at ASC);

CREATE OR REPLACE FUNCTION prevent_worker_counter_event_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'worker_counter_offer_events is append-only';
END;
$$;

DROP TRIGGER IF EXISTS worker_counter_offer_events_immutable ON worker_counter_offer_events;
CREATE TRIGGER worker_counter_offer_events_immutable
BEFORE UPDATE OR DELETE ON worker_counter_offer_events
FOR EACH ROW EXECUTE FUNCTION prevent_worker_counter_event_mutation();

CREATE OR REPLACE FUNCTION enforce_worker_counter_offer_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.task_id IS DISTINCT FROM NEW.task_id
     OR OLD.worker_id IS DISTINCT FROM NEW.worker_id
     OR OLD.offer_decision_id IS DISTINCT FROM NEW.offer_decision_id
     OR OLD.source_scope_version_id IS DISTINCT FROM NEW.source_scope_version_id
     OR OLD.proposed_scope_hash IS DISTINCT FROM NEW.proposed_scope_hash
     OR OLD.policy_version IS DISTINCT FROM NEW.policy_version
     OR OLD.request_hash IS DISTINCT FROM NEW.request_hash
     OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key
     OR OLD.current_customer_total_cents IS DISTINCT FROM NEW.current_customer_total_cents
     OR OLD.current_payout_cents IS DISTINCT FROM NEW.current_payout_cents
     OR OLD.platform_margin_cents IS DISTINCT FROM NEW.platform_margin_cents
     OR OLD.minimum_counter_payout_cents IS DISTINCT FROM NEW.minimum_counter_payout_cents
     OR OLD.maximum_counter_payout_cents IS DISTINCT FROM NEW.maximum_counter_payout_cents
     OR OLD.customer_maximum_cents IS DISTINCT FROM NEW.customer_maximum_cents
     OR OLD.margin_floor_bps IS DISTINCT FROM NEW.margin_floor_bps
     OR OLD.proposed_payout_cents IS DISTINCT FROM NEW.proposed_payout_cents
     OR OLD.proposed_customer_total_cents IS DISTINCT FROM NEW.proposed_customer_total_cents
     OR OLD.reason IS DISTINCT FROM NEW.reason
     OR OLD.expires_at IS DISTINCT FROM NEW.expires_at
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'HXCO1: worker counter proposal is immutable' USING ERRCODE = 'P0001';
  END IF;
  IF NOT (
    (OLD.status='PENDING_POSTER' AND NEW.status IN ('REJECTED','APPROVED_REAUTH_REQUIRED','EXPIRED'))
    OR (OLD.status='APPROVED_REAUTH_REQUIRED' AND NEW.status='MATERIALIZED')
  ) THEN
    RAISE EXCEPTION 'HXCO2: invalid worker counter transition % -> %', OLD.status, NEW.status USING ERRCODE = 'P0001';
  END IF;
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS worker_counter_offer_transition_guard ON worker_counter_offers;
CREATE TRIGGER worker_counter_offer_transition_guard
BEFORE UPDATE ON worker_counter_offers
FOR EACH ROW EXECUTE FUNCTION enforce_worker_counter_offer_mutation();

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS counter_source_task_id UUID REFERENCES tasks(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS counter_offer_id UUID REFERENCES worker_counter_offers(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS counter_candidate_id UUID REFERENCES users(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS tasks_counter_offer_unique
  ON tasks(counter_offer_id) WHERE counter_offer_id IS NOT NULL;

CREATE OR REPLACE FUNCTION enforce_counter_replacement_task()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  counter_row worker_counter_offers%ROWTYPE;
  source_row tasks%ROWTYPE;
  source_escrow escrows%ROWTYPE;
BEGIN
  IF NEW.counter_source_task_id IS NULL AND NEW.counter_offer_id IS NULL AND NEW.counter_candidate_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.counter_source_task_id IS NULL OR NEW.counter_offer_id IS NULL OR NEW.counter_candidate_id IS NULL THEN
    RAISE EXCEPTION 'HXCO3: counter replacement binding must be complete' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.id = NEW.counter_source_task_id THEN
    RAISE EXCEPTION 'HXCO4: counter replacement cannot reference itself' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO counter_row FROM worker_counter_offers WHERE id=NEW.counter_offer_id FOR SHARE;
  SELECT * INTO source_row FROM tasks WHERE id=NEW.counter_source_task_id FOR SHARE;
  SELECT * INTO source_escrow FROM escrows WHERE task_id=NEW.counter_source_task_id FOR SHARE;
  IF counter_row.id IS NULL OR source_row.id IS NULL OR source_escrow.id IS NULL
     OR counter_row.status <> 'APPROVED_REAUTH_REQUIRED'
     OR counter_row.task_id <> NEW.counter_source_task_id
     OR counter_row.worker_id <> NEW.counter_candidate_id THEN
    RAISE EXCEPTION 'HXCO5: approved counter does not authorize replacement' USING ERRCODE = 'P0001';
  END IF;
  IF source_row.state <> 'CANCELLED' OR source_escrow.state <> 'REFUNDED'
     OR source_escrow.stripe_refund_id IS NULL THEN
    RAISE EXCEPTION 'HXCO6: replacement requires cancelled task and provider-confirmed refund' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.poster_id <> source_row.poster_id OR NEW.worker_id IS NOT NULL
     OR NEW.state NOT IN ('OPEN','MATCHING') THEN
    RAISE EXCEPTION 'HXCO7: replacement must preserve Poster and remain unassigned' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.price <> counter_row.proposed_customer_total_cents
     OR NEW.hustler_payout_cents <> counter_row.proposed_payout_cents
     OR NEW.platform_margin_cents <> counter_row.platform_margin_cents
     OR NEW.scope_hash <> counter_row.proposed_scope_hash THEN
    RAISE EXCEPTION 'HXCO8: replacement economics or scope drifted from approved counter' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.region_code IS DISTINCT FROM source_row.region_code
     OR NEW.trade_type IS DISTINCT FROM source_row.trade_type
     OR NEW.template_slug IS DISTINCT FROM source_row.template_slug THEN
    RAISE EXCEPTION 'HXCO9: replacement region or category drifted' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS counter_replacement_task_gate ON tasks;
CREATE TRIGGER counter_replacement_task_gate
BEFORE INSERT ON tasks
FOR EACH ROW EXECUTE FUNCTION enforce_counter_replacement_task();

CREATE OR REPLACE FUNCTION prevent_counter_replacement_binding_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.counter_source_task_id IS DISTINCT FROM NEW.counter_source_task_id
     OR OLD.counter_offer_id IS DISTINCT FROM NEW.counter_offer_id
     OR OLD.counter_candidate_id IS DISTINCT FROM NEW.counter_candidate_id THEN
    RAISE EXCEPTION 'HXCO10: counter replacement binding is immutable' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS counter_replacement_binding_immutable ON tasks;
CREATE TRIGGER counter_replacement_binding_immutable
BEFORE UPDATE OF counter_source_task_id,counter_offer_id,counter_candidate_id ON tasks
FOR EACH ROW EXECUTE FUNCTION prevent_counter_replacement_binding_mutation();
