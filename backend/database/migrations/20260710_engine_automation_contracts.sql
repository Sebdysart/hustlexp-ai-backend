-- HustleXP canonical engine contracts for automated task creation, privacy,
-- and engine-owned reservation. Additive and backwards-compatible.

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS rough_location TEXT,
  ADD COLUMN IF NOT EXISTS dispatch_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS expiration_reason TEXT,
  ADD COLUMN IF NOT EXISTS refund_state TEXT NOT NULL DEFAULT 'NOT_REQUIRED',
  ADD COLUMN IF NOT EXISTS refund_blocker TEXT,
  ADD COLUMN IF NOT EXISTS refund_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completion_message_delivered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completion_message_delivery_id TEXT,
  ADD COLUMN IF NOT EXISTS completion_confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS payout_ready_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS payout_ready_reason TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_expiration_reason_check') THEN
    ALTER TABLE tasks ADD CONSTRAINT tasks_expiration_reason_check
      CHECK (expiration_reason IS NULL OR expiration_reason IN ('UNFILLED', 'DEADLINE'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_refund_state_check') THEN
    ALTER TABLE tasks ADD CONSTRAINT tasks_refund_state_check
      CHECK (refund_state IN ('NOT_REQUIRED', 'PENDING', 'REFUNDED', 'BLOCKED'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_tasks_dispatch_expiry_due
  ON tasks (dispatch_expires_at, id)
  WHERE state IN ('OPEN', 'MATCHING') AND worker_id IS NULL;

-- task.create idempotency witness. Keeping the client key out of `tasks`
-- prevents it from leaking through legacy SELECT * task reads.
CREATE TABLE IF NOT EXISTS task_create_requests (
  poster_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 128),
  request_hash CHAR(64) NOT NULL,
  task_id UUID NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (poster_id, idempotency_key)
);

-- Exact addresses never live in the public task row. `tasks.location` and
-- `tasks.rough_location` contain only generalized city/region text.
CREATE TABLE IF NOT EXISTS task_location_vault (
  task_id UUID PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  exact_location TEXT NOT NULL CHECK (char_length(exact_location) BETWEEN 1 AND 500),
  released_at TIMESTAMPTZ,
  released_to UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Eliminate pre-existing exact-location exposure. Preserve the original value
-- in the vault, then fail closed in every public task row. Operators can later
-- populate a city/region rough area without ever restoring the exact address.
INSERT INTO task_location_vault (task_id, exact_location)
SELECT id, location
FROM tasks
WHERE location IS NOT NULL AND btrim(location) <> '' AND rough_location IS NULL
ON CONFLICT (task_id) DO NOTHING;

UPDATE tasks
SET rough_location = COALESCE(rough_location, 'Location protected until reservation'),
    location = COALESCE(rough_location, 'Location protected until reservation')
WHERE location IS NOT NULL AND btrim(location) <> '' AND rough_location IS NULL;

CREATE TABLE IF NOT EXISTS task_location_access_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  worker_id UUID NOT NULL REFERENCES users(id),
  access_reason TEXT NOT NULL,
  accessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (task_id, worker_id)
);

-- Canonical reservation row: one engine reservation per task.
CREATE TABLE IF NOT EXISTS task_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
  hustler_id UUID NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'RELEASED', 'CANCELLED')),
  reserved_by UUID NOT NULL REFERENCES users(id),
  reserved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_task_reservations_hustler_active
  ON task_reservations (hustler_id)
  WHERE status = 'ACTIVE';

-- Every automation call gets an immutable request witness. Same key + same
-- hash replays; same key + changed request is a deterministic conflict.
CREATE TABLE IF NOT EXISTS task_reservation_requests (
  idempotency_key TEXT PRIMARY KEY CHECK (char_length(idempotency_key) BETWEEN 8 AND 128),
  request_hash CHAR(64) NOT NULL,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  hustler_id UUID NOT NULL REFERENCES users(id),
  reservation_id UUID NOT NULL REFERENCES task_reservations(id) ON DELETE CASCADE,
  requested_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- E2: immutable request witness for the unfilled-expiry/refund command.
-- Same key + same hash replays; a changed request is a hard conflict.
CREATE TABLE IF NOT EXISTS task_dispatch_expiry_requests (
  idempotency_key TEXT PRIMARY KEY CHECK (char_length(idempotency_key) BETWEEN 8 AND 128),
  request_hash CHAR(64) NOT NULL,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  result_code TEXT NOT NULL,
  refund_state TEXT NOT NULL,
  blocker_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- E4: provider-authenticated evidence that the poster was actually notified.
-- Unattended completion is forbidden without one of these immutable rows.
CREATE TABLE IF NOT EXISTS task_completion_delivery_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  provider_delivery_id TEXT NOT NULL UNIQUE,
  channel TEXT NOT NULL CHECK (channel IN ('SMS', 'EMAIL', 'PUSH')),
  delivered_at TIMESTAMPTZ NOT NULL,
  recorded_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_task_completion_delivery_task
  ON task_completion_delivery_events (task_id, delivered_at DESC);

CREATE TABLE IF NOT EXISTS task_unattended_completion_requests (
  idempotency_key TEXT PRIMARY KEY CHECK (char_length(idempotency_key) BETWEEN 8 AND 128),
  request_hash CHAR(64) NOT NULL,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  result_code TEXT NOT NULL,
  blocker_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Shared append-only evidence rail for automation state changes. It contains
-- IDs and policy codes only; no address or proof media is admitted.
CREATE TABLE IF NOT EXISTS engine_automation_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
