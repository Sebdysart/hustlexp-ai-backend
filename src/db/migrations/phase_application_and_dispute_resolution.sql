-- ============================================================================
-- MIGRATION: Task Applications & Enhanced Dispute Resolution
--
-- Creates tables for:
-- 1. task_applications - Hustler application workflow with counter-offers
-- 2. dispute_resolutions - Enhanced dispute resolution with AI + jury
-- 3. dispute_evidence - Evidence items for disputes
-- 4. dispute_jury - Jury assignments and votes
--
-- CONSTITUTIONAL INVARIANTS ENFORCED:
-- - One active application per hustler per task (unique constraint)
-- - Application state machine via CHECK constraints
-- - Dispute state machine via CHECK constraints
-- - Jury members must not be dispute participants (enforced at app level)
-- - Evidence immutability after resolution phase (enforced at app level)
-- ============================================================================

-- ============================================================================
-- 1. TASK APPLICATIONS TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS task_applications (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    task_id uuid NOT NULL REFERENCES tasks(id),
    hustler_id uuid NOT NULL REFERENCES users(id),

    -- Pricing
    proposed_price_cents integer,
    message text,

    -- Status
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN (
            'pending', 'accepted', 'rejected',
            'countered', 'counter_accepted', 'counter_rejected',
            'withdrawn', 'expired'
        )),

    -- Rejection
    rejection_reason text,

    -- Counter-offer chain
    counter_offer_price_cents integer,
    counter_offer_message text,
    counter_offer_round integer NOT NULL DEFAULT 0
        CHECK (counter_offer_round >= 0 AND counter_offer_round <= 3),

    -- Final agreed price (set on acceptance)
    agreed_price_cents integer,

    -- Timestamps
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW()
);

-- INV-APP-1: One active application per hustler per task
-- (allows re-application after rejection/withdrawal/expiry)
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_app_active_per_hustler
    ON task_applications (task_id, hustler_id)
    WHERE status NOT IN ('rejected', 'counter_rejected', 'withdrawn', 'expired');

-- Query indexes
CREATE INDEX IF NOT EXISTS idx_task_app_task ON task_applications(task_id);
CREATE INDEX IF NOT EXISTS idx_task_app_hustler ON task_applications(hustler_id);
CREATE INDEX IF NOT EXISTS idx_task_app_status ON task_applications(status);
CREATE INDEX IF NOT EXISTS idx_task_app_created ON task_applications(created_at);

-- Composite for expiry cron
CREATE INDEX IF NOT EXISTS idx_task_app_stale
    ON task_applications(status, created_at)
    WHERE status IN ('pending', 'countered');

COMMENT ON TABLE task_applications IS 'Hustler applications for tasks with counter-offer negotiation support';

-- ============================================================================
-- 2. DISPUTE RESOLUTIONS TABLE (Enhanced)
-- ============================================================================

CREATE TABLE IF NOT EXISTS dispute_resolutions (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    task_id uuid NOT NULL REFERENCES tasks(id),
    initiator_id uuid NOT NULL REFERENCES users(id),
    initiator_role text NOT NULL CHECK (initiator_role IN ('poster', 'hustler')),
    poster_id uuid NOT NULL REFERENCES users(id),
    hustler_id uuid NOT NULL REFERENCES users(id),

    -- Dispute details
    reason text NOT NULL,

    -- State machine
    status text NOT NULL DEFAULT 'open'
        CHECK (status IN (
            'open', 'evidence_collection',
            'under_ai_review', 'ai_recommended',
            'jury_selection', 'jury_deliberation', 'jury_decided',
            'finalized', 'expired'
        )),

    -- AI Resolution fields
    ai_outcome text CHECK (ai_outcome IN ('poster', 'hustler', 'split') OR ai_outcome IS NULL),
    ai_confidence numeric(3,2),
    ai_reasoning text,
    ai_split_percent integer CHECK (ai_split_percent IS NULL OR (ai_split_percent >= 0 AND ai_split_percent <= 100)),
    ai_risk_flags text[] DEFAULT '{}',

    -- Jury Resolution fields
    jury_member_ids uuid[] DEFAULT '{}',
    jury_outcome text CHECK (jury_outcome IN ('poster', 'hustler', 'split') OR jury_outcome IS NULL),
    jury_poster_votes integer DEFAULT 0,
    jury_hustler_votes integer DEFAULT 0,
    jury_deliberation_deadline timestamptz,

    -- Final Resolution
    final_outcome text CHECK (final_outcome IN ('poster', 'hustler', 'split') OR final_outcome IS NULL),
    refund_amount_cents integer,
    release_amount_cents integer,
    finalized_by text,
    finalized_at timestamptz,

    -- Error tracking
    money_engine_error text,

    -- Timestamps
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW()
);

-- One active dispute per task
CREATE UNIQUE INDEX IF NOT EXISTS idx_dispute_res_active_per_task
    ON dispute_resolutions (task_id)
    WHERE status NOT IN ('finalized', 'expired');

-- Query indexes
CREATE INDEX IF NOT EXISTS idx_dispute_res_task ON dispute_resolutions(task_id);
CREATE INDEX IF NOT EXISTS idx_dispute_res_initiator ON dispute_resolutions(initiator_id);
CREATE INDEX IF NOT EXISTS idx_dispute_res_status ON dispute_resolutions(status);
CREATE INDEX IF NOT EXISTS idx_dispute_res_poster ON dispute_resolutions(poster_id);
CREATE INDEX IF NOT EXISTS idx_dispute_res_hustler ON dispute_resolutions(hustler_id);
CREATE INDEX IF NOT EXISTS idx_dispute_res_created ON dispute_resolutions(created_at);

COMMENT ON TABLE dispute_resolutions IS 'Enhanced dispute resolution with AI-assisted and jury-based outcomes';

-- ============================================================================
-- 3. DISPUTE EVIDENCE TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS dispute_evidence (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    dispute_id uuid NOT NULL REFERENCES dispute_resolutions(id) ON DELETE CASCADE,
    submitted_by uuid NOT NULL REFERENCES users(id),
    evidence_type text NOT NULL CHECK (evidence_type IN ('photo', 'text', 'url', 'screenshot')),
    content text NOT NULL,
    description text,
    created_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dispute_evidence_dispute ON dispute_evidence(dispute_id);
CREATE INDEX IF NOT EXISTS idx_dispute_evidence_submitter ON dispute_evidence(submitted_by);

COMMENT ON TABLE dispute_evidence IS 'Evidence items submitted during dispute resolution';

-- ============================================================================
-- 4. DISPUTE JURY TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS dispute_jury (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    dispute_id uuid NOT NULL REFERENCES dispute_resolutions(id) ON DELETE CASCADE,
    juror_id uuid NOT NULL REFERENCES users(id),

    -- Voting
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'voted', 'recused', 'expired')),
    vote text CHECK (vote IN ('poster', 'hustler') OR vote IS NULL),
    reasoning text,

    -- Timestamps
    assigned_at timestamptz NOT NULL DEFAULT NOW(),
    voted_at timestamptz,

    -- One assignment per juror per dispute
    UNIQUE(dispute_id, juror_id)
);

CREATE INDEX IF NOT EXISTS idx_dispute_jury_dispute ON dispute_jury(dispute_id);
CREATE INDEX IF NOT EXISTS idx_dispute_jury_juror ON dispute_jury(juror_id);
CREATE INDEX IF NOT EXISTS idx_dispute_jury_pending
    ON dispute_jury(juror_id, status)
    WHERE status = 'pending';

COMMENT ON TABLE dispute_jury IS 'Jury member assignments and votes for dispute resolution';

-- ============================================================================
-- 5. ADD 'disputed' STATUS TO TASKS IF NOT ALREADY PRESENT
-- (The tasks table uses a text status field, so this is handled at app level.
--  This comment documents the expected status values.)
-- ============================================================================

-- Expected task statuses after this migration:
-- 'draft', 'active', 'assigned', 'in_progress', 'completed', 'cancelled', 'disputed'
