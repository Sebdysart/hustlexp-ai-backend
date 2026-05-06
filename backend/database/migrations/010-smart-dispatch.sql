-- ============================================================================
-- Migration 010: Smart Dispatch / Ping System
--
-- Adds infrastructure for wave-based smart dispatch:
--   • dispatch_state + wave tracking on tasks
--   • go_mode / location / dispatch performance columns on users
--   • dispatch_events audit table
--   • hustler_dispatch_prefs preferences table
-- ============================================================================

BEGIN;

-- ─── tasks: dispatch columns ─────────────────────────────────────────────────

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS dispatch_state TEXT NOT NULL DEFAULT 'idle'
    CHECK (dispatch_state IN ('idle','broadcasting','wave_1','wave_2','wave_3','soft_held','fulfilled','expired')),
  ADD COLUMN IF NOT EXISTS wave_number INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS soft_hold_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS soft_hold_hustler_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS fulfillment_mode TEXT NOT NULL DEFAULT 'broadcast'
    CHECK (fulfillment_mode IN ('broadcast','smart_dispatch')),
  ADD COLUMN IF NOT EXISTS last_dispatched_at TIMESTAMPTZ;

-- ─── users: go_mode, location, dispatch performance ──────────────────────────

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS go_mode BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS last_location_lat NUMERIC(10,7),
  ADD COLUMN IF NOT EXISTS last_location_lng NUMERIC(10,7),
  ADD COLUMN IF NOT EXISTS location_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS preferred_categories TEXT[],
  ADD COLUMN IF NOT EXISTS min_payout_cents INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS acceptance_rate NUMERIC(5,4) NOT NULL DEFAULT 1.0,
  ADD COLUMN IF NOT EXISTS avg_response_time_seconds INTEGER,
  ADD COLUMN IF NOT EXISTS cancellation_rate NUMERIC(5,4) NOT NULL DEFAULT 0.0;

-- ─── dispatch_events: full audit trail ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS dispatch_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id         UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  hustler_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  event_type      TEXT NOT NULL CHECK (event_type IN (
    'wave_started',
    'ping_sent',
    'ping_viewed',
    'ping_accepted',
    'ping_declined',
    'ping_expired',
    'soft_hold_acquired',
    'soft_hold_released',
    'task_fulfilled',
    'dispatch_expired'
  )),
  wave_number     INTEGER,
  dispatch_score  NUMERIC(5,4),
  metadata        JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dispatch_events_task_id
  ON dispatch_events(task_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dispatch_events_hustler_id
  ON dispatch_events(hustler_id, created_at DESC);

-- ─── hustler_dispatch_prefs: per-hustler dispatch settings ───────────────────

CREATE TABLE IF NOT EXISTS hustler_dispatch_prefs (
  user_id                UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  max_distance_miles     INTEGER NOT NULL DEFAULT 10,
  min_payout_cents       INTEGER NOT NULL DEFAULT 0,
  preferred_categories   TEXT[],
  auto_accept            BOOLEAN NOT NULL DEFAULT FALSE,
  ping_sound_enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── indexes for online hustler queries ──────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_users_go_mode_location
  ON users(go_mode, location_updated_at)
  WHERE go_mode = TRUE;

CREATE INDEX IF NOT EXISTS idx_tasks_dispatch_state
  ON tasks(dispatch_state, created_at)
  WHERE dispatch_state NOT IN ('fulfilled','expired','idle');

-- ─── record migration ─────────────────────────────────────────────────────────

INSERT INTO schema_versions (version, notes, applied_by, checksum)
VALUES ('010', 'Smart Dispatch / Ping System infrastructure', 'migration', 'sha256-010-smart-dispatch')
ON CONFLICT (version) DO NOTHING;

COMMIT;
