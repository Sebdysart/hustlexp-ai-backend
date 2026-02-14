-- ============================================================
-- Migration: Squads Mode + Recurring Tasks
-- v2.4.0 — Two tier-gated unlockable features
--
-- Squads (Gold = Elite Tier 4):
--   - squads, squad_members, squad_invites, squad_task_assignments
--
-- Recurring Tasks (Silver = Trusted Tier 3):
--   - recurring_task_series, recurring_task_occurrences
--   - task table extensions (parent_series_id, occurrence_number)
--
-- Authority: PRODUCT_SPEC §11 (Squads), §12 (Recurring Tasks)
-- ============================================================

-- ============================================================
-- PART 1: SQUADS MODE
-- ============================================================

-- 1.1: Core squads table
CREATE TABLE IF NOT EXISTS squads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    emoji VARCHAR(10) NOT NULL DEFAULT '⚡️',
    tagline VARCHAR(200),
    organizer_id UUID NOT NULL REFERENCES users(id),
    max_members INT NOT NULL DEFAULT 5,
    status VARCHAR(20) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'paused', 'disbanded')),

    -- Stats (denormalized for fast reads)
    total_tasks_completed INT NOT NULL DEFAULT 0,
    total_earnings_cents INT NOT NULL DEFAULT 0,
    average_rating NUMERIC(3,2) NOT NULL DEFAULT 0,
    squad_xp INT NOT NULL DEFAULT 0,
    squad_level INT NOT NULL DEFAULT 1,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 1.2: Squad members
CREATE TABLE IF NOT EXISTS squad_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    squad_id UUID NOT NULL REFERENCES squads(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id),
    role VARCHAR(20) NOT NULL DEFAULT 'member'
        CHECK (role IN ('organizer', 'member')),
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE(squad_id, user_id)
);

-- 1.3: Squad invites
CREATE TABLE IF NOT EXISTS squad_invites (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    squad_id UUID NOT NULL REFERENCES squads(id) ON DELETE CASCADE,
    inviter_id UUID NOT NULL REFERENCES users(id),
    invitee_id UUID NOT NULL REFERENCES users(id),
    status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'accepted', 'declined', 'expired')),
    sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
    responded_at TIMESTAMPTZ,

    UNIQUE(squad_id, invitee_id, status)
);

-- 1.4: Squad task assignments (multi-worker task bridge)
CREATE TABLE IF NOT EXISTS squad_task_assignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    squad_id UUID NOT NULL REFERENCES squads(id),
    task_id UUID NOT NULL REFERENCES tasks(id),
    required_workers INT NOT NULL DEFAULT 2,
    payment_split_mode VARCHAR(20) NOT NULL DEFAULT 'equal'
        CHECK (payment_split_mode IN ('equal', 'weighted')),
    per_worker_payment_cents INT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'recruiting'
        CHECK (status IN ('recruiting', 'ready', 'in_progress', 'completed', 'cancelled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 1.5: Squad task worker slots
CREATE TABLE IF NOT EXISTS squad_task_workers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    squad_task_id UUID NOT NULL REFERENCES squad_task_assignments(id) ON DELETE CASCADE,
    worker_id UUID NOT NULL REFERENCES users(id),
    accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    payment_share_cents INT,

    UNIQUE(squad_task_id, worker_id)
);

-- 1.6: Extend tasks table with squad reference
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS squad_id UUID REFERENCES squads(id);

-- Indexes for squads
CREATE INDEX IF NOT EXISTS idx_squads_organizer ON squads(organizer_id);
CREATE INDEX IF NOT EXISTS idx_squad_members_user ON squad_members(user_id);
CREATE INDEX IF NOT EXISTS idx_squad_members_squad ON squad_members(squad_id);
CREATE INDEX IF NOT EXISTS idx_squad_invites_invitee ON squad_invites(invitee_id, status);
CREATE INDEX IF NOT EXISTS idx_squad_task_assignments_squad ON squad_task_assignments(squad_id);
CREATE INDEX IF NOT EXISTS idx_tasks_squad ON tasks(squad_id) WHERE squad_id IS NOT NULL;

-- ============================================================
-- PART 2: RECURRING TASKS
-- ============================================================

-- 2.1: Recurring task series (the "template")
CREATE TABLE IF NOT EXISTS recurring_task_series (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    poster_id UUID NOT NULL REFERENCES users(id),
    template_task_id UUID REFERENCES tasks(id),

    -- Schedule
    pattern VARCHAR(20) NOT NULL
        CHECK (pattern IN ('daily', 'weekly', 'biweekly', 'monthly')),
    day_of_week INT CHECK (day_of_week >= 1 AND day_of_week <= 7),
    day_of_month INT CHECK (day_of_month >= 1 AND day_of_month <= 28),
    time_of_day VARCHAR(5),  -- HH:mm
    start_date DATE NOT NULL,
    end_date DATE,

    -- Task template fields
    title VARCHAR(255) NOT NULL,
    description TEXT NOT NULL,
    payment_cents INT NOT NULL CHECK (payment_cents >= 500),
    location VARCHAR(500),
    category VARCHAR(50),
    estimated_duration VARCHAR(50),
    required_tier INT NOT NULL DEFAULT 1,

    -- Status
    status VARCHAR(20) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'paused', 'completed', 'cancelled')),
    occurrence_count INT NOT NULL DEFAULT 0,
    completed_count INT NOT NULL DEFAULT 0,

    -- Preferred worker (auto-assign)
    preferred_worker_id UUID REFERENCES users(id),

    -- Timestamps
    next_occurrence_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2.2: Recurring task occurrences (individual generated tasks)
CREATE TABLE IF NOT EXISTS recurring_task_occurrences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    series_id UUID NOT NULL REFERENCES recurring_task_series(id) ON DELETE CASCADE,
    task_id UUID REFERENCES tasks(id),
    occurrence_number INT NOT NULL,
    scheduled_date DATE NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'scheduled'
        CHECK (status IN ('scheduled', 'posted', 'in_progress', 'completed', 'skipped', 'cancelled')),
    worker_id UUID REFERENCES users(id),
    completed_at TIMESTAMPTZ,
    rating INT CHECK (rating >= 1 AND rating <= 5),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE(series_id, occurrence_number)
);

-- 2.3: Extend tasks table with recurring reference
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS parent_series_id UUID REFERENCES recurring_task_series(id);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS occurrence_number INT;

-- Indexes for recurring tasks
CREATE INDEX IF NOT EXISTS idx_recurring_series_poster ON recurring_task_series(poster_id);
CREATE INDEX IF NOT EXISTS idx_recurring_series_status ON recurring_task_series(status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_recurring_series_next ON recurring_task_series(next_occurrence_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_recurring_occurrences_series ON recurring_task_occurrences(series_id);
CREATE INDEX IF NOT EXISTS idx_recurring_occurrences_date ON recurring_task_occurrences(scheduled_date);
CREATE INDEX IF NOT EXISTS idx_tasks_series ON tasks(parent_series_id) WHERE parent_series_id IS NOT NULL;

-- ============================================================
-- PART 3: TIER-GATE ENFORCEMENT TRIGGERS
-- ============================================================

-- 3.1: Enforce Gold tier (Elite) for squad creation
CREATE OR REPLACE FUNCTION enforce_squad_tier_gate()
RETURNS TRIGGER AS $$
DECLARE
    user_tier INT;
BEGIN
    SELECT trust_tier INTO user_tier FROM users WHERE id = NEW.organizer_id;

    IF user_tier IS NULL OR user_tier < 4 THEN
        RAISE EXCEPTION 'HX-GATE-001: Squads Mode requires Elite trust tier (4). Current: %', COALESCE(user_tier, 0);
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enforce_squad_tier ON squads;
CREATE TRIGGER trg_enforce_squad_tier
    BEFORE INSERT ON squads
    FOR EACH ROW
    EXECUTE FUNCTION enforce_squad_tier_gate();

-- 3.2: Enforce squad member eligibility (must be Elite+)
CREATE OR REPLACE FUNCTION enforce_squad_member_tier()
RETURNS TRIGGER AS $$
DECLARE
    user_tier INT;
BEGIN
    SELECT trust_tier INTO user_tier FROM users WHERE id = NEW.user_id;

    IF user_tier IS NULL OR user_tier < 4 THEN
        RAISE EXCEPTION 'HX-GATE-002: Squad membership requires Elite trust tier (4). Current: %', COALESCE(user_tier, 0);
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enforce_squad_member_tier ON squad_members;
CREATE TRIGGER trg_enforce_squad_member_tier
    BEFORE INSERT ON squad_members
    FOR EACH ROW
    EXECUTE FUNCTION enforce_squad_member_tier();

-- 3.3: Enforce Silver tier (Trusted) for recurring task creation
CREATE OR REPLACE FUNCTION enforce_recurring_tier_gate()
RETURNS TRIGGER AS $$
DECLARE
    user_tier INT;
BEGIN
    SELECT trust_tier INTO user_tier FROM users WHERE id = NEW.poster_id;

    IF user_tier IS NULL OR user_tier < 3 THEN
        RAISE EXCEPTION 'HX-GATE-003: Recurring Tasks requires Trusted tier (3). Current: %', COALESCE(user_tier, 0);
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enforce_recurring_tier ON recurring_task_series;
CREATE TRIGGER trg_enforce_recurring_tier
    BEFORE INSERT ON recurring_task_series
    FOR EACH ROW
    EXECUTE FUNCTION enforce_recurring_tier_gate();

-- 3.4: Enforce max squad size
CREATE OR REPLACE FUNCTION enforce_squad_max_members()
RETURNS TRIGGER AS $$
DECLARE
    current_count INT;
    max_size INT;
BEGIN
    -- Advisory lock prevents TOCTOU race on concurrent inserts
    PERFORM pg_advisory_xact_lock(hashtext('squad_members_' || NEW.squad_id::text));
    SELECT COUNT(*) INTO current_count
    FROM squad_members WHERE squad_id = NEW.squad_id;

    SELECT max_members INTO max_size
    FROM squads WHERE id = NEW.squad_id;

    IF current_count >= max_size THEN
        RAISE EXCEPTION 'HX-GATE-004: Squad is full (max % members)', max_size;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enforce_squad_max ON squad_members;
CREATE TRIGGER trg_enforce_squad_max
    BEFORE INSERT ON squad_members
    FOR EACH ROW
    EXECUTE FUNCTION enforce_squad_max_members();

-- ============================================================
-- DONE: Migration complete
-- Squads: 5 tables + 2 task columns + 3 triggers
-- Recurring: 2 tables + 2 task columns + 1 trigger
-- Total: 7 new tables, 4 new columns, 4 enforcement triggers
-- ============================================================
