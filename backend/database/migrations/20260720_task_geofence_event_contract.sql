-- Purpose-bound geofence evidence for active assigned work.
-- Raw worker coordinates are used transiently to calculate distance and are
-- never retained in this table or projected into general telemetry.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS task_geofence_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN ('enter','exit','checkin')),
  distance_meters NUMERIC NOT NULL CHECK (distance_meters >= 0),
  client_event_id UUID NOT NULL,
  client_sequence BIGINT NOT NULL CHECK (client_sequence > 0),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  request_hash CHAR(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  prior_task_version INTEGER NOT NULL CHECK (prior_task_version >= 0),
  local_occurred_at TIMESTAMPTZ NOT NULL,
  device_version TEXT NOT NULL CHECK (char_length(device_version) BETWEEN 1 AND 100),
  app_version TEXT NOT NULL CHECK (char_length(app_version) BETWEEN 1 AND 100),
  consent_basis TEXT NOT NULL DEFAULT 'ACTIVE_TASK_GEOFENCE'
    CHECK (consent_basis = 'ACTIVE_TASK_GEOFENCE'),
  purpose TEXT NOT NULL DEFAULT 'ACTIVE_TASK_PRESENCE'
    CHECK (purpose = 'ACTIVE_TASK_PRESENCE'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  purge_after TIMESTAMPTZ NOT NULL DEFAULT (NOW()+INTERVAL '30 days'),
  UNIQUE (user_id,idempotency_key),
  UNIQUE (user_id,client_event_id),
  CHECK (purge_after > created_at)
);

-- Align a legacy table created outside the production startup chain.
ALTER TABLE task_geofence_events
  ADD COLUMN IF NOT EXISTS client_event_id UUID,
  ADD COLUMN IF NOT EXISTS client_sequence BIGINT,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS request_hash CHAR(64),
  ADD COLUMN IF NOT EXISTS prior_task_version INTEGER,
  ADD COLUMN IF NOT EXISTS local_occurred_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS device_version TEXT,
  ADD COLUMN IF NOT EXISTS app_version TEXT,
  ADD COLUMN IF NOT EXISTS consent_basis TEXT,
  ADD COLUMN IF NOT EXISTS purpose TEXT,
  ADD COLUMN IF NOT EXISTS purge_after TIMESTAMPTZ;

-- Historical raw coordinates are not needed to prove presence and are outside
-- the 30-day minimized event contract. Purge them before enforcing null-only.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='task_geofence_events'
      AND column_name='location_lat'
  ) THEN
    ALTER TABLE task_geofence_events ALTER COLUMN location_lat DROP NOT NULL;
    ALTER TABLE task_geofence_events ALTER COLUMN location_lng DROP NOT NULL;
    UPDATE task_geofence_events SET location_lat=NULL,location_lng=NULL
      WHERE location_lat IS NOT NULL OR location_lng IS NOT NULL;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='task_geofence_raw_location_forbidden_ck') THEN
      ALTER TABLE task_geofence_events ADD CONSTRAINT task_geofence_raw_location_forbidden_ck
        CHECK (location_lat IS NULL AND location_lng IS NULL);
    END IF;
  END IF;
END;
$$;

DO $$
DECLARE
  v_constraint RECORD;
BEGIN
  FOR v_constraint IN
    SELECT constraint_name FROM information_schema.table_constraints
    WHERE table_schema='public' AND table_name='task_geofence_events'
      AND constraint_type='CHECK' AND constraint_name LIKE '%event_type%'
  LOOP
    EXECUTE format('ALTER TABLE task_geofence_events DROP CONSTRAINT %I',v_constraint.constraint_name);
  END LOOP;
END;
$$;

UPDATE task_geofence_events SET event_type=CASE upper(event_type)
  WHEN 'ENTER' THEN 'enter' WHEN 'EXIT' THEN 'exit' ELSE 'checkin' END;
UPDATE task_geofence_events SET
  client_event_id=COALESCE(client_event_id,id),
  client_sequence=COALESCE(client_sequence,1),
  idempotency_key=COALESCE(idempotency_key,'legacy-geofence:' || id::text),
  request_hash=COALESCE(request_hash,encode(digest(concat_ws('|',task_id::text,user_id::text,event_type,id::text),'sha256'),'hex')),
  prior_task_version=COALESCE(prior_task_version,0),
  local_occurred_at=COALESCE(local_occurred_at,created_at),
  device_version=COALESCE(device_version,'legacy-unattributed'),
  app_version=COALESCE(app_version,'legacy-unattributed'),
  consent_basis=COALESCE(consent_basis,'ACTIVE_TASK_GEOFENCE'),
  purpose=COALESCE(purpose,'ACTIVE_TASK_PRESENCE'),
  purge_after=COALESCE(purge_after,created_at+INTERVAL '30 days');

WITH ranked AS (
  SELECT id,ROW_NUMBER() OVER (PARTITION BY task_id,user_id ORDER BY created_at,id) AS sequence
  FROM task_geofence_events WHERE device_version='legacy-unattributed'
)
UPDATE task_geofence_events event SET client_sequence=ranked.sequence
FROM ranked WHERE ranked.id=event.id;

ALTER TABLE task_geofence_events
  ALTER COLUMN client_event_id SET NOT NULL,
  ALTER COLUMN client_sequence SET NOT NULL,
  ALTER COLUMN idempotency_key SET NOT NULL,
  ALTER COLUMN request_hash SET NOT NULL,
  ALTER COLUMN prior_task_version SET NOT NULL,
  ALTER COLUMN local_occurred_at SET NOT NULL,
  ALTER COLUMN device_version SET NOT NULL,
  ALTER COLUMN app_version SET NOT NULL,
  ALTER COLUMN consent_basis SET NOT NULL,
  ALTER COLUMN consent_basis SET DEFAULT 'ACTIVE_TASK_GEOFENCE',
  ALTER COLUMN purpose SET NOT NULL,
  ALTER COLUMN purpose SET DEFAULT 'ACTIVE_TASK_PRESENCE',
  ALTER COLUMN purge_after SET NOT NULL,
  ALTER COLUMN purge_after SET DEFAULT (NOW()+INTERVAL '30 days');

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='task_geofence_event_type_ck') THEN
    ALTER TABLE task_geofence_events ADD CONSTRAINT task_geofence_event_type_ck
      CHECK (event_type IN ('enter','exit','checkin'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='task_geofence_client_sequence_ck') THEN
    ALTER TABLE task_geofence_events ADD CONSTRAINT task_geofence_client_sequence_ck
      CHECK (client_sequence > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='task_geofence_request_hash_ck') THEN
    ALTER TABLE task_geofence_events ADD CONSTRAINT task_geofence_request_hash_ck
      CHECK (request_hash ~ '^[a-f0-9]{64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='task_geofence_prior_version_ck') THEN
    ALTER TABLE task_geofence_events ADD CONSTRAINT task_geofence_prior_version_ck
      CHECK (prior_task_version >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='task_geofence_purpose_ck') THEN
    ALTER TABLE task_geofence_events ADD CONSTRAINT task_geofence_purpose_ck
      CHECK (consent_basis='ACTIVE_TASK_GEOFENCE' AND purpose='ACTIVE_TASK_PRESENCE');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='task_geofence_purge_after_ck') THEN
    ALTER TABLE task_geofence_events ADD CONSTRAINT task_geofence_purge_after_ck
      CHECK (purge_after > created_at);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='task_geofence_local_time_ck') THEN
    ALTER TABLE task_geofence_events ADD CONSTRAINT task_geofence_local_time_ck
      CHECK (local_occurred_at <= created_at + INTERVAL '5 minutes');
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS task_geofence_events_user_key_uniq
  ON task_geofence_events(user_id,idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS task_geofence_events_user_client_uniq
  ON task_geofence_events(user_id,client_event_id);
CREATE UNIQUE INDEX IF NOT EXISTS task_geofence_events_task_sequence_uniq
  ON task_geofence_events(task_id,user_id,client_sequence);
CREATE INDEX IF NOT EXISTS task_geofence_events_task_time_idx
  ON task_geofence_events(task_id,created_at ASC);
CREATE INDEX IF NOT EXISTS task_geofence_events_retention_idx
  ON task_geofence_events(purge_after);

CREATE OR REPLACE FUNCTION prevent_task_geofence_event_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'HXGEO1: geofence evidence is append-only' USING ERRCODE='P0001';
END;
$$;

DROP TRIGGER IF EXISTS task_geofence_events_immutable ON task_geofence_events;
CREATE TRIGGER task_geofence_events_immutable
BEFORE UPDATE OR DELETE ON task_geofence_events
FOR EACH ROW EXECUTE FUNCTION prevent_task_geofence_event_mutation();

DROP TRIGGER IF EXISTS task_geofence_events_no_truncate ON task_geofence_events;
CREATE TRIGGER task_geofence_events_no_truncate
BEFORE TRUNCATE ON task_geofence_events
FOR EACH STATEMENT EXECUTE FUNCTION prevent_task_geofence_event_mutation();

COMMENT ON TABLE task_geofence_events IS
  'Purpose-bound active-task presence evidence. Exact coordinates are transient inputs and are not retained.';
