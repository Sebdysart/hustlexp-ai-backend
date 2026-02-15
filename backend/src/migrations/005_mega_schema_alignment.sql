-- ============================================================================
-- Migration 005: Mega Schema Alignment
-- ============================================================================
-- Aligns the actual Neon database schema with what ALL 86+ backend service
-- files expect. This is THE migration that unblocks all 33 crashing routers.
--
-- Strategy:
--   1. ADD alias columns to existing tables (code expects poster_id, DB has client_id)
--   2. ADD missing columns to existing tables
--   3. CREATE missing tables referenced by services
--   4. CREATE views/aliases for table name mismatches (escrows → escrow)
--   5. ADD missing indexes
--   6. ADD constitutional triggers
--
-- All statements are idempotent (IF NOT EXISTS / DO $$ blocks).
-- ============================================================================


-- ============================================================================
-- PART 1: TASKS TABLE — Add columns the backend code references
-- ============================================================================
-- DB has: client_id, assigned_hustler_id, status, recommended_price, location_text
-- Code expects: poster_id, worker_id, state, price, location (+ many more)

-- 1a. poster_id — generated column aliasing client_id
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tasks' AND column_name = 'poster_id'
  ) THEN
    ALTER TABLE tasks ADD COLUMN poster_id UUID;
    -- Backfill from client_id
    UPDATE tasks SET poster_id = client_id WHERE poster_id IS NULL;
    -- Add trigger to keep in sync
    CREATE OR REPLACE FUNCTION sync_task_poster_id() RETURNS TRIGGER AS $fn$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.poster_id IS NULL AND NEW.client_id IS NOT NULL THEN
          NEW.poster_id := NEW.client_id;
        ELSIF NEW.client_id IS NULL AND NEW.poster_id IS NOT NULL THEN
          NEW.client_id := NEW.poster_id;
        END IF;
      ELSIF TG_OP = 'UPDATE' THEN
        IF NEW.poster_id IS DISTINCT FROM OLD.poster_id AND NEW.client_id = OLD.client_id THEN
          NEW.client_id := NEW.poster_id;
        ELSIF NEW.client_id IS DISTINCT FROM OLD.client_id AND NEW.poster_id = OLD.poster_id THEN
          NEW.poster_id := NEW.client_id;
        END IF;
      END IF;
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_sync_task_poster_id') THEN
    CREATE TRIGGER trg_sync_task_poster_id
      BEFORE INSERT OR UPDATE ON tasks
      FOR EACH ROW EXECUTE FUNCTION sync_task_poster_id();
  END IF;
END $$;

-- 1b. worker_id — alias for assigned_hustler_id
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tasks' AND column_name = 'worker_id'
  ) THEN
    ALTER TABLE tasks ADD COLUMN worker_id UUID;
    UPDATE tasks SET worker_id = assigned_hustler_id WHERE worker_id IS NULL;
    CREATE OR REPLACE FUNCTION sync_task_worker_id() RETURNS TRIGGER AS $fn$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.worker_id IS NULL AND NEW.assigned_hustler_id IS NOT NULL THEN
          NEW.worker_id := NEW.assigned_hustler_id;
        ELSIF NEW.assigned_hustler_id IS NULL AND NEW.worker_id IS NOT NULL THEN
          NEW.assigned_hustler_id := NEW.worker_id;
        END IF;
      ELSIF TG_OP = 'UPDATE' THEN
        IF NEW.worker_id IS DISTINCT FROM OLD.worker_id AND NEW.assigned_hustler_id = OLD.assigned_hustler_id THEN
          NEW.assigned_hustler_id := NEW.worker_id;
        ELSIF NEW.assigned_hustler_id IS DISTINCT FROM OLD.assigned_hustler_id AND NEW.worker_id = OLD.worker_id THEN
          NEW.worker_id := NEW.assigned_hustler_id;
        END IF;
      END IF;
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_sync_task_worker_id') THEN
    CREATE TRIGGER trg_sync_task_worker_id
      BEFORE INSERT OR UPDATE ON tasks
      FOR EACH ROW EXECUTE FUNCTION sync_task_worker_id();
  END IF;
END $$;

-- 1c. state — alias for status
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tasks' AND column_name = 'state'
  ) THEN
    ALTER TABLE tasks ADD COLUMN state VARCHAR;
    UPDATE tasks SET state = status WHERE state IS NULL;
    CREATE OR REPLACE FUNCTION sync_task_state() RETURNS TRIGGER AS $fn$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.state IS NULL AND NEW.status IS NOT NULL THEN
          NEW.state := NEW.status;
        ELSIF NEW.status IS NULL AND NEW.state IS NOT NULL THEN
          NEW.status := NEW.state;
        END IF;
      ELSIF TG_OP = 'UPDATE' THEN
        IF NEW.state IS DISTINCT FROM OLD.state AND NEW.status = OLD.status THEN
          NEW.status := NEW.state;
        ELSIF NEW.status IS DISTINCT FROM OLD.status AND NEW.state = OLD.state THEN
          NEW.state := NEW.status;
        END IF;
      END IF;
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_sync_task_state') THEN
    CREATE TRIGGER trg_sync_task_state
      BEFORE INSERT OR UPDATE ON tasks
      FOR EACH ROW EXECUTE FUNCTION sync_task_state();
  END IF;
END $$;

-- 1d. price — alias for recommended_price
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tasks' AND column_name = 'price'
  ) THEN
    ALTER TABLE tasks ADD COLUMN price NUMERIC;
    UPDATE tasks SET price = recommended_price WHERE price IS NULL;
    CREATE OR REPLACE FUNCTION sync_task_price() RETURNS TRIGGER AS $fn$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.price IS NULL AND NEW.recommended_price IS NOT NULL THEN
          NEW.price := NEW.recommended_price;
        ELSIF NEW.recommended_price IS NULL AND NEW.price IS NOT NULL THEN
          NEW.recommended_price := NEW.price;
        END IF;
      ELSIF TG_OP = 'UPDATE' THEN
        IF NEW.price IS DISTINCT FROM OLD.price AND NEW.recommended_price = OLD.recommended_price THEN
          NEW.recommended_price := NEW.price;
        ELSIF NEW.recommended_price IS DISTINCT FROM OLD.recommended_price AND NEW.price = OLD.price THEN
          NEW.price := NEW.recommended_price;
        END IF;
      END IF;
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_sync_task_price') THEN
    CREATE TRIGGER trg_sync_task_price
      BEFORE INSERT OR UPDATE ON tasks
      FOR EACH ROW EXECUTE FUNCTION sync_task_price();
  END IF;
END $$;

-- 1e. location — alias for location_text
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tasks' AND column_name = 'location'
  ) THEN
    ALTER TABLE tasks ADD COLUMN location VARCHAR;
    UPDATE tasks SET location = location_text WHERE location IS NULL;
    CREATE OR REPLACE FUNCTION sync_task_location() RETURNS TRIGGER AS $fn$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.location IS NULL AND NEW.location_text IS NOT NULL THEN
          NEW.location := NEW.location_text;
        ELSIF NEW.location_text IS NULL AND NEW.location IS NOT NULL THEN
          NEW.location_text := NEW.location;
        END IF;
      ELSIF TG_OP = 'UPDATE' THEN
        IF NEW.location IS DISTINCT FROM OLD.location AND NEW.location_text = OLD.location_text THEN
          NEW.location_text := NEW.location;
        ELSIF NEW.location_text IS DISTINCT FROM OLD.location_text AND NEW.location = OLD.location THEN
          NEW.location := NEW.location_text;
        END IF;
      END IF;
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_sync_task_location') THEN
    CREATE TRIGGER trg_sync_task_location
      BEFORE INSERT OR UPDATE ON tasks
      FOR EACH ROW EXECUTE FUNCTION sync_task_location();
  END IF;
END $$;

-- 1f. location_lat / location_lng — aliases for latitude / longitude
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tasks' AND column_name = 'location_lat'
  ) THEN
    ALTER TABLE tasks ADD COLUMN location_lat NUMERIC;
    UPDATE tasks SET location_lat = latitude WHERE location_lat IS NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tasks' AND column_name = 'location_lng'
  ) THEN
    ALTER TABLE tasks ADD COLUMN location_lng NUMERIC;
    UPDATE tasks SET location_lng = longitude WHERE location_lng IS NULL;
  END IF;
END $$;

-- 1g. Additional missing columns on tasks
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tasks' AND column_name='xp_reward') THEN
    ALTER TABLE tasks ADD COLUMN xp_reward INTEGER NOT NULL DEFAULT 10;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tasks' AND column_name='risk_level') THEN
    ALTER TABLE tasks ADD COLUMN risk_level TEXT NOT NULL DEFAULT 'LOW' CHECK (risk_level IN ('LOW','MEDIUM','HIGH','IN_HOME'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tasks' AND column_name='requirements') THEN
    ALTER TABLE tasks ADD COLUMN requirements TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tasks' AND column_name='scope_hash') THEN
    ALTER TABLE tasks ADD COLUMN scope_hash TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tasks' AND column_name='progress_state') THEN
    ALTER TABLE tasks ADD COLUMN progress_state TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tasks' AND column_name='progress_updated_at') THEN
    ALTER TABLE tasks ADD COLUMN progress_updated_at TIMESTAMPTZ;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tasks' AND column_name='progress_by') THEN
    ALTER TABLE tasks ADD COLUMN progress_by UUID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tasks' AND column_name='mode') THEN
    ALTER TABLE tasks ADD COLUMN mode TEXT DEFAULT 'standard';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tasks' AND column_name='live_broadcast_started_at') THEN
    ALTER TABLE tasks ADD COLUMN live_broadcast_started_at TIMESTAMPTZ;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tasks' AND column_name='live_broadcast_expired_at') THEN
    ALTER TABLE tasks ADD COLUMN live_broadcast_expired_at TIMESTAMPTZ;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tasks' AND column_name='live_broadcast_radius_miles') THEN
    ALTER TABLE tasks ADD COLUMN live_broadcast_radius_miles NUMERIC;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tasks' AND column_name='instant_mode') THEN
    ALTER TABLE tasks ADD COLUMN instant_mode BOOLEAN DEFAULT FALSE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tasks' AND column_name='surge_level') THEN
    ALTER TABLE tasks ADD COLUMN surge_level INTEGER DEFAULT 0;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tasks' AND column_name='surge_multiplier') THEN
    ALTER TABLE tasks ADD COLUMN surge_multiplier NUMERIC DEFAULT 1.0;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tasks' AND column_name='asap_bump_count') THEN
    ALTER TABLE tasks ADD COLUMN asap_bump_count INTEGER DEFAULT 0;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tasks' AND column_name='sensitive') THEN
    ALTER TABLE tasks ADD COLUMN sensitive BOOLEAN DEFAULT FALSE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tasks' AND column_name='deadline') THEN
    ALTER TABLE tasks ADD COLUMN deadline TIMESTAMPTZ;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tasks' AND column_name='matched_at') THEN
    ALTER TABLE tasks ADD COLUMN matched_at TIMESTAMPTZ;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tasks' AND column_name='accepted_at') THEN
    ALTER TABLE tasks ADD COLUMN accepted_at TIMESTAMPTZ;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tasks' AND column_name='proof_submitted_at') THEN
    ALTER TABLE tasks ADD COLUMN proof_submitted_at TIMESTAMPTZ;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tasks' AND column_name='completed_at') THEN
    ALTER TABLE tasks ADD COLUMN completed_at TIMESTAMPTZ;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tasks' AND column_name='cancelled_at') THEN
    ALTER TABLE tasks ADD COLUMN cancelled_at TIMESTAMPTZ;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tasks' AND column_name='expired_at') THEN
    ALTER TABLE tasks ADD COLUMN expired_at TIMESTAMPTZ;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tasks' AND column_name='requires_proof') THEN
    ALTER TABLE tasks ADD COLUMN requires_proof BOOLEAN DEFAULT TRUE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tasks' AND column_name='proof_instructions') THEN
    ALTER TABLE tasks ADD COLUMN proof_instructions TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tasks' AND column_name='before_photo_url') THEN
    ALTER TABLE tasks ADD COLUMN before_photo_url TEXT;
  END IF;
END $$;

-- Task indexes for new columns
CREATE INDEX IF NOT EXISTS idx_tasks_poster ON tasks(poster_id);
CREATE INDEX IF NOT EXISTS idx_tasks_worker ON tasks(worker_id);
CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state);
CREATE INDEX IF NOT EXISTS idx_tasks_instant ON tasks(instant_mode) WHERE instant_mode = TRUE;


-- ============================================================================
-- PART 2: ESCROWS VIEW — Code references "escrows" but table is "escrow"
-- ============================================================================

-- 2a. Add alias columns to escrow table
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='escrow' AND column_name='state') THEN
    ALTER TABLE escrow ADD COLUMN state VARCHAR;
    UPDATE escrow SET state = status WHERE state IS NULL;
    CREATE OR REPLACE FUNCTION sync_escrow_state() RETURNS TRIGGER AS $fn$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.state IS NULL AND NEW.status IS NOT NULL THEN NEW.state := NEW.status;
        ELSIF NEW.status IS NULL AND NEW.state IS NOT NULL THEN NEW.status := NEW.state;
        END IF;
      ELSIF TG_OP = 'UPDATE' THEN
        IF NEW.state IS DISTINCT FROM OLD.state AND NEW.status = OLD.status THEN NEW.status := NEW.state;
        ELSIF NEW.status IS DISTINCT FROM OLD.status AND NEW.state = OLD.state THEN NEW.state := NEW.status;
        END IF;
      END IF;
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_sync_escrow_state') THEN
    CREATE TRIGGER trg_sync_escrow_state
      BEFORE INSERT OR UPDATE ON escrow
      FOR EACH ROW EXECUTE FUNCTION sync_escrow_state();
  END IF;
END $$;

-- 2b. Add more missing escrow columns
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='escrow' AND column_name='amount_cents') THEN
    ALTER TABLE escrow ADD COLUMN amount_cents INTEGER;
    UPDATE escrow SET amount_cents = (amount * 100)::INTEGER WHERE amount_cents IS NULL AND amount IS NOT NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='escrow' AND column_name='refund_amount') THEN
    ALTER TABLE escrow ADD COLUMN refund_amount NUMERIC DEFAULT 0;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='escrow' AND column_name='release_amount') THEN
    ALTER TABLE escrow ADD COLUMN release_amount NUMERIC DEFAULT 0;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='escrow' AND column_name='stripe_payment_intent_id') THEN
    ALTER TABLE escrow ADD COLUMN stripe_payment_intent_id TEXT;
    UPDATE escrow SET stripe_payment_intent_id = payment_intent_id WHERE stripe_payment_intent_id IS NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='escrow' AND column_name='stripe_transfer_id') THEN
    ALTER TABLE escrow ADD COLUMN stripe_transfer_id TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='escrow' AND column_name='stripe_refund_id') THEN
    ALTER TABLE escrow ADD COLUMN stripe_refund_id TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='escrow' AND column_name='version') THEN
    ALTER TABLE escrow ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='escrow' AND column_name='funded_at') THEN
    ALTER TABLE escrow ADD COLUMN funded_at TIMESTAMPTZ;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='escrow' AND column_name='released_at') THEN
    ALTER TABLE escrow ADD COLUMN released_at TIMESTAMPTZ;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='escrow' AND column_name='refunded_at') THEN
    ALTER TABLE escrow ADD COLUMN refunded_at TIMESTAMPTZ;
  END IF;
END $$;

-- 2c. Create "escrows" view as alias for "escrow" table
CREATE OR REPLACE VIEW escrows AS SELECT * FROM escrow;


-- ============================================================================
-- PART 3: USERS TABLE — Add missing columns
-- ============================================================================

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='full_name') THEN
    ALTER TABLE users ADD COLUMN full_name VARCHAR;
    UPDATE users SET full_name = name WHERE full_name IS NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='default_mode') THEN
    ALTER TABLE users ADD COLUMN default_mode VARCHAR;
    UPDATE users SET default_mode = role WHERE default_mode IS NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='phone') THEN
    ALTER TABLE users ADD COLUMN phone TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='avatar_url') THEN
    ALTER TABLE users ADD COLUMN avatar_url TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='level') THEN
    ALTER TABLE users ADD COLUMN level INTEGER NOT NULL DEFAULT 1;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='longest_streak') THEN
    ALTER TABLE users ADD COLUMN longest_streak INTEGER NOT NULL DEFAULT 0;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='preferred_radius_miles') THEN
    ALTER TABLE users ADD COLUMN preferred_radius_miles NUMERIC DEFAULT 10;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='home_latitude') THEN
    ALTER TABLE users ADD COLUMN home_latitude NUMERIC;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='home_longitude') THEN
    ALTER TABLE users ADD COLUMN home_longitude NUMERIC;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='last_latitude') THEN
    ALTER TABLE users ADD COLUMN last_latitude NUMERIC;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='last_longitude') THEN
    ALTER TABLE users ADD COLUMN last_longitude NUMERIC;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='last_location_at') THEN
    ALTER TABLE users ADD COLUMN last_location_at TIMESTAMPTZ;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='city_id') THEN
    ALTER TABLE users ADD COLUMN city_id UUID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='zone_id') THEN
    ALTER TABLE users ADD COLUMN zone_id UUID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='stripe_customer_id') THEN
    ALTER TABLE users ADD COLUMN stripe_customer_id TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='emoji_density') THEN
    ALTER TABLE users ADD COLUMN emoji_density TEXT DEFAULT 'normal';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='copy_tone_variant') THEN
    ALTER TABLE users ADD COLUMN copy_tone_variant TEXT DEFAULT 'default';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='xp_first_celebration_shown_at') THEN
    ALTER TABLE users ADD COLUMN xp_first_celebration_shown_at TIMESTAMPTZ;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='live_mode_state') THEN
    ALTER TABLE users ADD COLUMN live_mode_state TEXT DEFAULT 'inactive';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='live_mode_session_started_at') THEN
    ALTER TABLE users ADD COLUMN live_mode_session_started_at TIMESTAMPTZ;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='live_mode_banned_until') THEN
    ALTER TABLE users ADD COLUMN live_mode_banned_until TIMESTAMPTZ;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='live_mode_total_tasks') THEN
    ALTER TABLE users ADD COLUMN live_mode_total_tasks INTEGER DEFAULT 0;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='live_mode_completion_rate') THEN
    ALTER TABLE users ADD COLUMN live_mode_completion_rate NUMERIC DEFAULT 0;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='daily_active_minutes') THEN
    ALTER TABLE users ADD COLUMN daily_active_minutes INTEGER DEFAULT 0;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='last_activity_date') THEN
    ALTER TABLE users ADD COLUMN last_activity_date DATE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='consecutive_active_days') THEN
    ALTER TABLE users ADD COLUMN consecutive_active_days INTEGER DEFAULT 0;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='last_mandatory_break_at') THEN
    ALTER TABLE users ADD COLUMN last_mandatory_break_at TIMESTAMPTZ;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='paused_at') THEN
    ALTER TABLE users ADD COLUMN paused_at TIMESTAMPTZ;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='pause_streak_snapshot') THEN
    ALTER TABLE users ADD COLUMN pause_streak_snapshot INTEGER;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='pause_trust_tier_snapshot') THEN
    ALTER TABLE users ADD COLUMN pause_trust_tier_snapshot INTEGER;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='shadow_score') THEN
    ALTER TABLE users ADD COLUMN shadow_score INTEGER DEFAULT 0;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='dispute_count') THEN
    ALTER TABLE users ADD COLUMN dispute_count INTEGER DEFAULT 0;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='payouts_frozen') THEN
    ALTER TABLE users ADD COLUMN payouts_frozen BOOLEAN DEFAULT FALSE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='do_not_email') THEN
    ALTER TABLE users ADD COLUMN do_not_email BOOLEAN DEFAULT FALSE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='background_check_passed') THEN
    ALTER TABLE users ADD COLUMN background_check_passed BOOLEAN DEFAULT FALSE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='tutorial_quest_score') THEN
    ALTER TABLE users ADD COLUMN tutorial_quest_score INTEGER DEFAULT 0;
  END IF;
END $$;


-- ============================================================================
-- PART 4: NOTIFICATIONS TABLE — Add missing columns
-- ============================================================================

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='notifications' AND column_name='title') THEN
    ALTER TABLE notifications ADD COLUMN title TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='notifications' AND column_name='body') THEN
    ALTER TABLE notifications ADD COLUMN body TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='notifications' AND column_name='data') THEN
    ALTER TABLE notifications ADD COLUMN data JSONB DEFAULT '{}';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='notifications' AND column_name='task_id') THEN
    ALTER TABLE notifications ADD COLUMN task_id UUID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='notifications' AND column_name='read_at') THEN
    ALTER TABLE notifications ADD COLUMN read_at TIMESTAMPTZ;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='notifications' AND column_name='group_id') THEN
    ALTER TABLE notifications ADD COLUMN group_id TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='notifications' AND column_name='group_position') THEN
    ALTER TABLE notifications ADD COLUMN group_position INTEGER;
  END IF;
END $$;


-- ============================================================================
-- PART 5: CREATE ALL MISSING TABLES
-- ============================================================================

-- 5a. proofs — referenced by ProofService, task router
CREATE TABLE IF NOT EXISTS proofs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  submitter_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'SUBMITTED'
    CHECK (state IN ('SUBMITTED','UNDER_REVIEW','ACCEPTED','REJECTED')),
  description TEXT,
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  rejection_reason TEXT,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_proofs_task ON proofs(task_id);
CREATE INDEX IF NOT EXISTS idx_proofs_submitter ON proofs(submitter_id);

-- 5b. proof_submissions — PhotoVerificationService, BiometricVerificationService
CREATE TABLE IF NOT EXISTS proof_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proof_id UUID REFERENCES proofs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  photo_url TEXT,
  gps_coordinates JSONB,
  gps_accuracy_meters NUMERIC,
  lidar_depth_map_url TEXT,
  biometric_verified BOOLEAN DEFAULT FALSE,
  biometric_confidence NUMERIC(4,3),
  face_match_score NUMERIC(4,3),
  liveness_score NUMERIC(4,3),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_proof_submissions_proof ON proof_submissions(proof_id);

-- 5c. xp_ledger — XPService, GDPRService (constitutional audit trail)
CREATE TABLE IF NOT EXISTS xp_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  escrow_id UUID,
  base_xp INTEGER NOT NULL,
  streak_multiplier NUMERIC(4,2) NOT NULL DEFAULT 1.0,
  decay_factor NUMERIC(4,3) NOT NULL DEFAULT 1.0,
  effective_xp INTEGER NOT NULL,
  reason TEXT NOT NULL,
  user_xp_before INTEGER NOT NULL DEFAULT 0,
  user_xp_after INTEGER NOT NULL DEFAULT 0,
  user_level_before INTEGER NOT NULL DEFAULT 1,
  user_level_after INTEGER NOT NULL DEFAULT 1,
  user_streak_at_award INTEGER NOT NULL DEFAULT 0,
  awarded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (escrow_id)
);
CREATE INDEX IF NOT EXISTS idx_xp_ledger_user ON xp_ledger(user_id);
CREATE INDEX IF NOT EXISTS idx_xp_ledger_task ON xp_ledger(task_id);

-- 5d. trust_ledger — TrustService, TrustTierService
CREATE TABLE IF NOT EXISTS trust_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  old_tier INTEGER NOT NULL,
  new_tier INTEGER NOT NULL,
  reason TEXT NOT NULL,
  reason_details TEXT,
  task_id UUID,
  dispute_id UUID,
  changed_by TEXT,
  idempotency_key TEXT UNIQUE,
  event_source TEXT,
  source_event_id TEXT,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_trust_ledger_user ON trust_ledger(user_id);

-- 5e. task_messages — MessagingService
CREATE TABLE IF NOT EXISTS task_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id UUID REFERENCES users(id) ON DELETE SET NULL,
  message_type TEXT NOT NULL DEFAULT 'text',
  content TEXT NOT NULL,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_task_messages_task ON task_messages(task_id);
CREATE INDEX IF NOT EXISTS idx_task_messages_sender ON task_messages(sender_id);

-- 5f. task_ratings — RatingService
CREATE TABLE IF NOT EXISTS task_ratings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  rater_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ratee_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stars INTEGER NOT NULL CHECK (stars >= 1 AND stars <= 5),
  rating NUMERIC(3,2),
  score NUMERIC(5,2),
  comment TEXT,
  is_public BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (task_id, rater_id)
);
CREATE INDEX IF NOT EXISTS idx_task_ratings_task ON task_ratings(task_id);
CREATE INDEX IF NOT EXISTS idx_task_ratings_ratee ON task_ratings(ratee_id);

-- ratings view — TrustTierService references "ratings" instead of "task_ratings"
CREATE OR REPLACE VIEW ratings AS SELECT * FROM task_ratings;

-- 5g. user_rating_summary — RatingService, ReputationAIService
CREATE OR REPLACE VIEW user_rating_summary AS
  SELECT
    ratee_id AS user_id,
    AVG(stars)::NUMERIC(3,2) AS avg_rating,
    COUNT(*) AS total_ratings,
    COUNT(*) FILTER (WHERE stars >= 4) AS positive_ratings,
    COUNT(*) FILTER (WHERE stars <= 2) AS negative_ratings
  FROM task_ratings
  GROUP BY ratee_id;

-- 5h. disputes — DisputeService, DisputeAIService
CREATE TABLE IF NOT EXISTS disputes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  escrow_id UUID,
  initiated_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  poster_id UUID REFERENCES users(id) ON DELETE SET NULL,
  worker_id UUID REFERENCES users(id) ON DELETE SET NULL,
  state TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (state IN ('OPEN','INVESTIGATING','EVIDENCE_REVIEW','JURY_VOTE','RESOLVED','CLOSED')),
  reason TEXT NOT NULL,
  description TEXT,
  resolution TEXT,
  resolution_notes TEXT,
  resolved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  outcome_escrow_action TEXT,
  outcome_worker_penalty TEXT,
  outcome_poster_penalty TEXT,
  outcome_refund_amount NUMERIC,
  outcome_release_amount NUMERIC,
  version INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5i. evidence — EvidenceService, DisputeAIService
CREATE TABLE IF NOT EXISTS evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
  dispute_id UUID,
  proof_id UUID,
  uploader_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requested_by UUID,
  request_reason_codes TEXT[],
  ai_request_proposal_id UUID,
  storage_key TEXT NOT NULL,
  content_type TEXT,
  file_size_bytes INTEGER,
  checksum_sha256 TEXT,
  capture_time TIMESTAMPTZ,
  device_metadata JSONB,
  access_scope TEXT DEFAULT 'dispute',
  retention_deadline TIMESTAMPTZ,
  legal_hold BOOLEAN DEFAULT FALSE,
  deleted_at TIMESTAMPTZ,
  moderation_status TEXT DEFAULT 'pending',
  moderation_flags TEXT[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_evidence_dispute ON evidence(dispute_id);
CREATE INDEX IF NOT EXISTS idx_evidence_task ON evidence(task_id);

-- 5j. notification_preferences — NotificationService, GDPRService
CREATE TABLE IF NOT EXISTS notification_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  push_enabled BOOLEAN DEFAULT TRUE,
  email_enabled BOOLEAN DEFAULT TRUE,
  sms_enabled BOOLEAN DEFAULT FALSE,
  task_updates BOOLEAN DEFAULT TRUE,
  payment_updates BOOLEAN DEFAULT TRUE,
  marketing BOOLEAN DEFAULT FALSE,
  dispute_updates BOOLEAN DEFAULT TRUE,
  xp_updates BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5k. analytics_events — AnalyticsService, GDPRService
CREATE TABLE IF NOT EXISTS analytics_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  properties JSONB DEFAULT '{}',
  session_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_analytics_events_user ON analytics_events(user_id);
CREATE INDEX IF NOT EXISTS idx_analytics_events_type ON analytics_events(event_type);

-- 5l. fraud_risk_scores — FraudDetectionService
CREATE TABLE IF NOT EXISTS fraud_risk_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  overall_score NUMERIC(5,2) DEFAULT 0,
  velocity_score NUMERIC(5,2) DEFAULT 0,
  pattern_score NUMERIC(5,2) DEFAULT 0,
  device_score NUMERIC(5,2) DEFAULT 0,
  last_evaluated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5m. fraud_patterns — FraudDetectionService
CREATE TABLE IF NOT EXISTS fraud_patterns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pattern_type TEXT NOT NULL,
  pattern_data JSONB DEFAULT '{}',
  severity TEXT DEFAULT 'low',
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_fraud_patterns_user ON fraud_patterns(user_id);

-- 5n. fraud_detection_events — LogisticsAIService
CREATE TABLE IF NOT EXISTS fraud_detection_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  risk_score NUMERIC(5,2),
  details JSONB DEFAULT '{}',
  action_taken TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5o. content_moderation_queue — ContentModerationService
CREATE TABLE IF NOT EXISTS content_moderation_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content_type TEXT NOT NULL,
  content_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  priority INTEGER DEFAULT 0,
  ai_score NUMERIC(5,2),
  ai_flags TEXT[],
  reviewer_id UUID,
  reviewed_at TIMESTAMPTZ,
  decision TEXT,
  decision_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_content_mod_status ON content_moderation_queue(status);

-- 5p. content_reports — ContentModerationService
CREATE TABLE IF NOT EXISTS content_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reported_content_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  content_type TEXT NOT NULL,
  content_id UUID NOT NULL,
  reason TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5q. content_appeals — ContentModerationService
CREATE TABLE IF NOT EXISTS content_appeals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  moderation_queue_id UUID REFERENCES content_moderation_queue(id) ON DELETE SET NULL,
  appeal_reason TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ,
  decision TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5r. gdpr_data_requests — GDPRService
CREATE TABLE IF NOT EXISTS gdpr_data_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_type TEXT NOT NULL CHECK (request_type IN ('export','delete','rectify')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','failed')),
  request_details JSONB DEFAULT '{}',
  deadline TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5s. user_consents — GDPRService
CREATE TABLE IF NOT EXISTS user_consents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  consent_type TEXT NOT NULL,
  granted BOOLEAN NOT NULL DEFAULT FALSE,
  granted_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  ip_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5t. exports — GDPRService
CREATE TABLE IF NOT EXISTS exports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  export_format TEXT NOT NULL DEFAULT 'json',
  content_type TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  object_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5u. outbox_events — GDPRService, NotificationService, workers
CREATE TABLE IF NOT EXISTS outbox_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id UUID NOT NULL,
  event_version INTEGER NOT NULL DEFAULT 1,
  idempotency_key TEXT UNIQUE,
  payload JSONB NOT NULL DEFAULT '{}',
  queue_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox_events(status, created_at) WHERE status = 'pending';

-- 5v. email_outbox — NotificationService, email worker
CREATE TABLE IF NOT EXISTS email_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_email TEXT NOT NULL,
  template TEXT NOT NULL,
  params_json JSONB DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  suppressed_reason TEXT,
  idempotency_key TEXT UNIQUE,
  provider_msg_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_email_outbox_pending ON email_outbox(status, created_at) WHERE status = 'pending';

-- 5w. notification_log — xp-tax-reminder-worker
CREATE TABLE IF NOT EXISTS notification_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notification_type TEXT NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notification_log_user_type ON notification_log(user_id, notification_type);

-- 5x. admin_roles — DisputeService, analytics router
CREATE TABLE IF NOT EXISTS admin_roles (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  can_resolve_disputes BOOLEAN DEFAULT FALSE,
  can_view_analytics BOOLEAN DEFAULT FALSE,
  can_manage_users BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5y. tips — TippingService
CREATE TABLE IF NOT EXISTS tips (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  poster_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  worker_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL,
  stripe_payment_intent_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5z. revenue_ledger — RevenueService, BetaService
CREATE TABLE IF NOT EXISTS revenue_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  gross_amount_cents INTEGER,
  stripe_payment_intent_id TEXT,
  stripe_subscription_id TEXT,
  stripe_transfer_id TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_revenue_ledger_user ON revenue_ledger(user_id);
CREATE INDEX IF NOT EXISTS idx_revenue_ledger_type ON revenue_ledger(event_type);

-- 5aa. stripe_events — StripeWebhookService, workers
CREATE TABLE IF NOT EXISTS stripe_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  result TEXT,
  claimed_at TIMESTAMPTZ,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5bb. shadow_score_events — ShadowBanService
CREATE TABLE IF NOT EXISTS shadow_score_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,
  source TEXT,
  score_before INTEGER NOT NULL,
  score_after INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_shadow_score_user ON shadow_score_events(user_id);

-- 5cc. saved_searches — TaskDiscoveryService
CREATE TABLE IF NOT EXISTS saved_searches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  query TEXT,
  filters JSONB DEFAULT '{}',
  sort_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_saved_searches_user ON saved_searches(user_id);

-- 5dd. task_matching_scores — TaskDiscoveryService
CREATE TABLE IF NOT EXISTS task_matching_scores (
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  overall_score NUMERIC(5,2) NOT NULL DEFAULT 0,
  skill_match NUMERIC(5,2) DEFAULT 0,
  location_match NUMERIC(5,2) DEFAULT 0,
  availability_match NUMERIC(5,2) DEFAULT 0,
  trust_match NUMERIC(5,2) DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (task_id, user_id)
);

-- 5ee. task_skills — WorkerSkillService
CREATE TABLE IF NOT EXISTS task_skills (
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  skill_id UUID NOT NULL,
  PRIMARY KEY (task_id, skill_id)
);

-- 5ff. live_broadcasts — live router
CREATE TABLE IF NOT EXISTS live_broadcasts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  broadcaster_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active',
  radius_miles NUMERIC,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expired_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_live_broadcasts_task ON live_broadcasts(task_id);

-- 5gg. daily_challenges — challenges router
CREATE TABLE IF NOT EXISTS daily_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge_date DATE NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  challenge_type TEXT NOT NULL,
  target_value INTEGER NOT NULL DEFAULT 1,
  xp_reward INTEGER NOT NULL DEFAULT 10,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5hh. daily_challenge_completions — challenges router
CREATE TABLE IF NOT EXISTS daily_challenge_completions (
  challenge_id UUID NOT NULL REFERENCES daily_challenges(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  progress INTEGER DEFAULT 0,
  completed BOOLEAN DEFAULT FALSE,
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (challenge_id, user_id)
);

-- 5ii. referral_codes — referral router
CREATE TABLE IF NOT EXISTS referral_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code TEXT NOT NULL UNIQUE,
  uses_count INTEGER DEFAULT 0,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_referral_codes_user ON referral_codes(user_id);

-- 5jj. referral_redemptions — referral router
CREATE TABLE IF NOT EXISTS referral_redemptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referral_code_id UUID NOT NULL REFERENCES referral_codes(id) ON DELETE CASCADE,
  referrer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referred_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referrer_reward_cents INTEGER DEFAULT 0,
  referred_reward_cents INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (referred_id)
);

-- 5kk. featured_listings — featured router
CREATE TABLE IF NOT EXISTS featured_listings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tier TEXT NOT NULL DEFAULT 'basic',
  stripe_payment_intent_id TEXT,
  amount_cents INTEGER,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_featured_listings_active ON featured_listings(active) WHERE active = TRUE;

-- 5ll. payment_disputes — ChargebackService
CREATE TABLE IF NOT EXISTS payment_disputes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_dispute_id TEXT NOT NULL UNIQUE,
  stripe_charge_id TEXT,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  escrow_id UUID,
  status TEXT NOT NULL DEFAULT 'open',
  payouts_were_frozen BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5mm. recurring_tasks — subscription router
CREATE TABLE IF NOT EXISTS recurring_tasks (
  task_id UUID PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  active BOOLEAN DEFAULT TRUE,
  recurrence_rule TEXT,
  next_occurrence TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5nn. recurring_task_series — subscription router
CREATE TABLE IF NOT EXISTS recurring_task_series (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  poster_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  template_task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  recurrence_rule TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5oo. recurring_task_occurrences — subscription router
CREATE TABLE IF NOT EXISTS recurring_task_occurrences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  series_id UUID NOT NULL REFERENCES recurring_task_series(id) ON DELETE CASCADE,
  task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  scheduled_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5pp. expertise_registry — ExpertiseSupplyService
CREATE TABLE IF NOT EXISTS expertise_registry (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  description TEXT,
  risk_tier TEXT NOT NULL DEFAULT 'LOW',
  active BOOLEAN DEFAULT TRUE
);

-- 5qq. expertise_capacity — ExpertiseSupplyService
CREATE TABLE IF NOT EXISTS expertise_capacity (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  expertise_id UUID NOT NULL REFERENCES expertise_registry(id) ON DELETE CASCADE,
  geo_zone TEXT,
  max_weight_capacity NUMERIC NOT NULL DEFAULT 100,
  current_weight NUMERIC NOT NULL DEFAULT 0,
  min_task_to_supply_ratio NUMERIC DEFAULT 0.5,
  auto_expand_pct NUMERIC DEFAULT 0,
  auto_expand_expires_at TIMESTAMPTZ
);

-- 5rr. user_expertise — ExpertiseSupplyService
CREATE TABLE IF NOT EXISTS user_expertise (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expertise_id UUID NOT NULL REFERENCES expertise_registry(id) ON DELETE CASCADE,
  geo_zone TEXT,
  slot_weight NUMERIC NOT NULL DEFAULT 1,
  effective_weight NUMERIC NOT NULL DEFAULT 1,
  is_primary BOOLEAN DEFAULT FALSE,
  locked_until TIMESTAMPTZ,
  status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, expertise_id, geo_zone)
);

-- 5ss. expertise_waitlist — ExpertiseSupplyService
CREATE TABLE IF NOT EXISTS expertise_waitlist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expertise_id UUID NOT NULL REFERENCES expertise_registry(id) ON DELETE CASCADE,
  geo_zone TEXT,
  requested_weight NUMERIC DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0,
  status TEXT DEFAULT 'waiting',
  invite_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5tt. expertise_change_log — ExpertiseSupplyService
CREATE TABLE IF NOT EXISTS expertise_change_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  expertise_id UUID,
  old_weight NUMERIC,
  new_weight NUMERIC,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5uu. capability_profiles — CapabilityRecomputeService
CREATE TABLE IF NOT EXISTS capability_profiles (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  skills JSONB DEFAULT '[]',
  licenses JSONB DEFAULT '[]',
  background_check_status TEXT DEFAULT 'none',
  insurance_status TEXT DEFAULT 'none',
  overall_capability_score NUMERIC(5,2) DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5vv. verified_trades — CapabilityRecomputeService
CREATE TABLE IF NOT EXISTS verified_trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trade TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  expires_at TIMESTAMPTZ,
  license_verification_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_verified_trades_user ON verified_trades(user_id);

-- 5ww. license_verifications — CapabilityRecomputeService
CREATE TABLE IF NOT EXISTS license_verifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trade_type TEXT NOT NULL,
  issuing_state TEXT,
  license_number TEXT,
  expiration_date DATE,
  status TEXT DEFAULT 'pending',
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5xx. insurance_verifications — CapabilityRecomputeService
CREATE TABLE IF NOT EXISTS insurance_verifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT,
  policy_number TEXT,
  expiration_date DATE,
  coverage_amount_cents INTEGER,
  status TEXT DEFAULT 'pending',
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5yy. background_checks — CapabilityRecomputeService
CREATE TABLE IF NOT EXISTS background_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT,
  status TEXT DEFAULT 'pending',
  result TEXT,
  expires_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5zz. job_queue — CapabilityRecomputeWorker
CREATE TABLE IF NOT EXISTS job_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_job_queue_pending ON job_queue(status, type) WHERE status = 'pending';

-- 5aaa. verification_earnings_tracking — EarnedVerificationUnlockService
CREATE TABLE IF NOT EXISTS verification_earnings_tracking (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  total_net_earnings_cents INTEGER NOT NULL DEFAULT 0,
  earned_unlock_achieved BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5bbb. verification_earnings_ledger — EarnedVerificationUnlockService
CREATE TABLE IF NOT EXISTS verification_earnings_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  net_payout_cents INTEGER NOT NULL,
  cumulative_cents INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_verification_earnings_user ON verification_earnings_ledger(user_id);

-- 5ccc. revenue views — betaDashboard router
CREATE OR REPLACE VIEW revenue_report_daily AS
  SELECT
    DATE(created_at) AS report_date,
    event_type,
    SUM(amount_cents) AS total_cents,
    COUNT(*) AS count
  FROM revenue_ledger
  GROUP BY DATE(created_at), event_type
  ORDER BY report_date DESC;

CREATE OR REPLACE VIEW revenue_pnl_monthly AS
  SELECT
    DATE_TRUNC('month', created_at) AS month,
    SUM(CASE WHEN amount_cents > 0 THEN amount_cents ELSE 0 END) AS revenue_cents,
    SUM(CASE WHEN amount_cents < 0 THEN ABS(amount_cents) ELSE 0 END) AS cost_cents,
    SUM(amount_cents) AS net_cents,
    COUNT(*) AS transactions
  FROM revenue_ledger
  GROUP BY DATE_TRUNC('month', created_at)
  ORDER BY month DESC;


-- ============================================================================
-- PART 6: SCHEMA VERSION TRACKING
-- ============================================================================
INSERT INTO schema_versions (version, applied_at)
VALUES ('005_mega_schema_alignment', NOW())
ON CONFLICT DO NOTHING;


-- ============================================================================
-- END OF MIGRATION 005
-- ============================================================================
