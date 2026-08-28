-- Worker-rights offer snapshot: exact economics, logistics, scope, terms, rank
-- reasons, neutral pass, and an attributable appeal trail.

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS estimated_duration_minutes INTEGER CHECK (estimated_duration_minutes > 0),
  ADD COLUMN IF NOT EXISTS required_tools TEXT[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS cancellation_policy_version TEXT;

CREATE TABLE IF NOT EXISTS worker_offer_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  worker_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  policy_version TEXT NOT NULL,
  payload_hash CHAR(64) NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  decision_ready BOOLEAN NOT NULL,
  blocking_reasons JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(blocking_reasons) = 'array'),
  customer_total_cents INTEGER NOT NULL CHECK (customer_total_cents > 0),
  payout_cents INTEGER CHECK (payout_cents > 0),
  estimated_net_hourly_cents INTEGER CHECK (estimated_net_hourly_cents > 0),
  distance_miles NUMERIC(8,2) CHECK (distance_miles >= 0),
  estimated_duration_minutes INTEGER CHECK (estimated_duration_minutes > 0),
  scope_hash CHAR(64) CHECK (scope_hash ~ '^[a-f0-9]{64}$'),
  cancellation_policy_version TEXT,
  rank_score NUMERIC(6,5) CHECK (rank_score BETWEEN 0 AND 1),
  rank_reasons JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(rank_reasons) = 'array'),
  paid_promotion_affects_rank BOOLEAN NOT NULL DEFAULT FALSE CHECK (paid_promotion_affects_rank = FALSE),
  passing_has_rank_penalty BOOLEAN NOT NULL DEFAULT FALSE CHECK (passing_has_rank_penalty = FALSE),
  snapshot JSONB NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (task_id, worker_id, policy_version, payload_hash)
);

CREATE INDEX IF NOT EXISTS worker_offer_decisions_worker_time_idx
  ON worker_offer_decisions(worker_id, created_at DESC);

CREATE TABLE IF NOT EXISTS worker_offer_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_decision_id UUID NOT NULL REFERENCES worker_offer_decisions(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN ('VIEWED','CLARIFY','PASSED','APPLIED','ACCEPTED','APPEALED','EXPIRED')),
  idempotency_key TEXT NOT NULL,
  request_hash CHAR(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  public_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (offer_decision_id, idempotency_key)
);

CREATE OR REPLACE FUNCTION prevent_worker_offer_event_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'worker_offer_events is append-only';
END;
$$;

DROP TRIGGER IF EXISTS worker_offer_decisions_immutable ON worker_offer_decisions;
CREATE TRIGGER worker_offer_decisions_immutable
BEFORE UPDATE OR DELETE ON worker_offer_decisions
FOR EACH ROW EXECUTE FUNCTION prevent_worker_offer_event_mutation();

DROP TRIGGER IF EXISTS worker_offer_events_immutable ON worker_offer_events;
CREATE TRIGGER worker_offer_events_immutable
BEFORE UPDATE OR DELETE ON worker_offer_events
FOR EACH ROW EXECUTE FUNCTION prevent_worker_offer_event_mutation();

CREATE TABLE IF NOT EXISTS worker_decision_appeals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_decision_id UUID NOT NULL REFERENCES worker_offer_decisions(id) ON DELETE RESTRICT,
  worker_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 10 AND 2000),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ASSIGNED','RESOLVED','UPHELD','CLOSED')),
  assigned_admin_id UUID REFERENCES users(id) ON DELETE SET NULL,
  resolution TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  UNIQUE (offer_decision_id, worker_id)
);

CREATE TABLE IF NOT EXISTS worker_decision_appeal_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  appeal_id UUID NOT NULL REFERENCES worker_decision_appeals(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN ('OPENED','ASSIGNED','RESOLVED','UPHELD','CLOSED')),
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  public_message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS worker_decision_appeal_events_immutable ON worker_decision_appeal_events;
CREATE TRIGGER worker_decision_appeal_events_immutable
BEFORE UPDATE OR DELETE ON worker_decision_appeal_events
FOR EACH ROW EXECUTE FUNCTION prevent_worker_offer_event_mutation();

CREATE OR REPLACE FUNCTION enforce_worker_offer_decision_on_accept()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_offer worker_offer_decisions%ROWTYPE;
BEGIN
  IF NEW.state <> 'ACCEPTED' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD.state IN ('ACCEPTED', 'PROOF_SUBMITTED')
     AND OLD.worker_id IS NOT NULL
     AND OLD.worker_id IS NOT DISTINCT FROM NEW.worker_id THEN
    RETURN NEW;
  END IF;
  IF NEW.worker_id IS NULL THEN
    RAISE EXCEPTION 'HXWO1: accepted task requires a worker' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_offer
  FROM worker_offer_decisions
  WHERE task_id = NEW.id AND worker_id = NEW.worker_id
    AND decision_ready = TRUE AND expires_at > NOW()
  ORDER BY created_at DESC LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HXWO2: no current accept-ready worker offer decision' USING ERRCODE = 'P0001';
  END IF;
  IF v_offer.customer_total_cents <> NEW.price
     OR v_offer.payout_cents IS DISTINCT FROM NEW.hustler_payout_cents
     OR v_offer.scope_hash IS DISTINCT FROM NEW.scope_hash THEN
    RAISE EXCEPTION 'HXWO3: worker offer no longer matches task economics or scope' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS task_worker_offer_accept_gate ON tasks;
CREATE TRIGGER task_worker_offer_accept_gate
BEFORE INSERT OR UPDATE OF state, worker_id ON tasks
FOR EACH ROW EXECUTE FUNCTION enforce_worker_offer_decision_on_accept();
