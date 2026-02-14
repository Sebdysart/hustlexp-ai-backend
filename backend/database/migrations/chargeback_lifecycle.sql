-- ============================================================================
-- CHARGEBACK LIFECYCLE MIGRATION
-- Sprint 1: Automated Stripe dispute handling
-- ============================================================================
-- Handles: charge.dispute.created, charge.dispute.updated, charge.dispute.closed
-- Pattern: event-driven, idempotent, append-only ledger reversals
-- ============================================================================

-- ============================================================================
-- 1. PAYMENT DISPUTES TABLE
-- ============================================================================
-- Tracks Stripe chargebacks separately from internal task disputes.
-- Internal disputes (DisputeService) = poster vs worker disagreements.
-- Payment disputes (this table) = Stripe chargebacks from card issuers.
-- ============================================================================

CREATE TABLE IF NOT EXISTS payment_disputes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Stripe references (idempotency anchor)
    stripe_dispute_id VARCHAR(255) NOT NULL UNIQUE,
    stripe_charge_id VARCHAR(255) NOT NULL,
    stripe_payment_intent_id VARCHAR(255),
    stripe_event_id VARCHAR(255) NOT NULL REFERENCES stripe_events(stripe_event_id),

    -- HustleXP references
    user_id UUID REFERENCES users(id),           -- The user who was charged
    escrow_id UUID REFERENCES escrows(id),        -- Related escrow (if found)
    task_id UUID REFERENCES tasks(id),            -- Related task (if found)

    -- Dispute details
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    currency VARCHAR(3) NOT NULL DEFAULT 'usd',
    reason VARCHAR(100),                          -- Stripe reason code
    status VARCHAR(30) NOT NULL DEFAULT 'open'
        CHECK (status IN (
            'open',              -- Dispute created, under review
            'needs_response',    -- Evidence needed
            'under_review',      -- Evidence submitted, bank reviewing
            'won',               -- TERMINAL: Resolved in our favor
            'lost',              -- TERMINAL: Resolved in cardholder's favor
            'closed'             -- TERMINAL: Closed (warning or other)
        )),

    -- Financial tracking
    reversal_ledger_id UUID,                      -- Points to the negative revenue_ledger entry
    reversal_amount_cents INTEGER,                 -- Amount reversed (may differ from dispute amount)

    -- Resolution
    resolved_at TIMESTAMPTZ,
    resolution_stripe_event_id VARCHAR(255),

    -- User impact
    payouts_were_frozen BOOLEAN DEFAULT FALSE,
    trust_was_downgraded BOOLEAN DEFAULT FALSE,
    previous_trust_tier INTEGER,

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_payment_disputes_user ON payment_disputes(user_id);
CREATE INDEX IF NOT EXISTS idx_payment_disputes_status ON payment_disputes(status);
CREATE INDEX IF NOT EXISTS idx_payment_disputes_stripe_charge ON payment_disputes(stripe_charge_id);
CREATE INDEX IF NOT EXISTS idx_payment_disputes_stripe_pi ON payment_disputes(stripe_payment_intent_id);
CREATE INDEX IF NOT EXISTS idx_payment_disputes_escrow ON payment_disputes(escrow_id);
CREATE INDEX IF NOT EXISTS idx_payment_disputes_created ON payment_disputes(created_at DESC);

-- ============================================================================
-- 2. USER COLUMNS FOR PAYOUT FREEZE + DISPUTE TRACKING
-- ============================================================================

-- Payout freeze flag: when TRUE, no escrow releases or Stripe transfers
ALTER TABLE users ADD COLUMN IF NOT EXISTS payouts_locked BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS payouts_locked_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS payouts_locked_reason VARCHAR(255);

-- Dispute rate tracking
ALTER TABLE users ADD COLUMN IF NOT EXISTS dispute_count INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS dispute_lost_count INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_dispute_at TIMESTAMPTZ;

-- Index for finding frozen users
CREATE INDEX IF NOT EXISTS idx_users_payouts_locked ON users(payouts_locked) WHERE payouts_locked = TRUE;

-- ============================================================================
-- 3. ADD 'chargeback' AND 'chargeback_reversal' TO revenue_ledger EVENT TYPES
-- ============================================================================
-- No schema change needed — revenue_ledger.event_type is VARCHAR(50).
-- RevenueService type union will be updated in code.
-- The following is documentation:
--
-- event_type = 'chargeback': negative amount_cents (loss from dispute)
--   metadata: { stripe_dispute_id, stripe_charge_id, reason, payment_dispute_id }
--
-- event_type = 'chargeback_reversal': positive amount_cents (won dispute)
--   metadata: { stripe_dispute_id, stripe_charge_id, payment_dispute_id }
-- ============================================================================

-- ============================================================================
-- 4. TRIGGER: PREVENT ESCROW RELEASE WHEN PAYOUTS LOCKED
-- ============================================================================
-- If user has payouts_locked = TRUE, block escrow releases for their tasks.
-- This is a DB-level safety net on top of application-level checks.
-- ============================================================================

CREATE OR REPLACE FUNCTION prevent_release_when_payouts_locked()
RETURNS TRIGGER AS $$
DECLARE
    worker_locked BOOLEAN;
    worker_id_val UUID;
BEGIN
    -- Only check on release transitions
    IF NEW.state = 'RELEASED' AND OLD.state != 'RELEASED' THEN
        -- Get the worker_id from the task
        SELECT t.worker_id INTO worker_id_val
        FROM tasks t WHERE t.id = NEW.task_id;

        IF worker_id_val IS NOT NULL THEN
            SELECT payouts_locked INTO worker_locked
            FROM users WHERE id = worker_id_val;

            IF worker_locked = TRUE THEN
                RAISE EXCEPTION 'PAYOUT_FROZEN: Cannot release escrow %. Worker % has payouts locked due to active chargeback.',
                    NEW.id, worker_id_val
                    USING ERRCODE = 'HX810';
            END IF;
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS escrow_payout_freeze_guard ON escrows;
CREATE TRIGGER escrow_payout_freeze_guard
    BEFORE UPDATE ON escrows
    FOR EACH ROW
    EXECUTE FUNCTION prevent_release_when_payouts_locked();

-- ============================================================================
-- 5. APPEND-ONLY PROTECTION FOR PAYMENT_DISPUTES
-- ============================================================================
-- Status can only advance forward (open → needs_response → under_review → won/lost/closed).
-- No deletes allowed.
-- ============================================================================

CREATE OR REPLACE FUNCTION prevent_payment_dispute_delete()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'PAYMENT_DISPUTE_DELETE_BLOCKED: Cannot delete payment dispute %. Financial records are permanent.',
        OLD.id
        USING ERRCODE = 'HX811';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS payment_disputes_no_delete ON payment_disputes;
CREATE TRIGGER payment_disputes_no_delete
    BEFORE DELETE ON payment_disputes
    FOR EACH ROW
    EXECUTE FUNCTION prevent_payment_dispute_delete();

-- ============================================================================
-- DISPUTE FORWARD-ONLY STATE MACHINE
-- ============================================================================
-- Prevents payment disputes from regressing to previous states.
-- Valid progression: open → needs_response → under_review → won/lost/closed

CREATE OR REPLACE FUNCTION enforce_dispute_forward_state()
RETURNS TRIGGER AS $$
DECLARE
    state_order INTEGER;
    new_state_order INTEGER;
BEGIN
    -- Assign numeric order to states
    state_order := CASE OLD.status
        WHEN 'open' THEN 1
        WHEN 'needs_response' THEN 2
        WHEN 'under_review' THEN 3
        WHEN 'won' THEN 10
        WHEN 'lost' THEN 10
        WHEN 'closed' THEN 10
        ELSE 0
    END;

    new_state_order := CASE NEW.status
        WHEN 'open' THEN 1
        WHEN 'needs_response' THEN 2
        WHEN 'under_review' THEN 3
        WHEN 'won' THEN 10
        WHEN 'lost' THEN 10
        WHEN 'closed' THEN 10
        ELSE 0
    END;

    -- Terminal states are immutable
    IF state_order = 10 AND NEW.status <> OLD.status THEN
        RAISE EXCEPTION 'Dispute % is in terminal state % and cannot transition to %',
            OLD.id, OLD.status, NEW.status
            USING ERRCODE = 'HX701';
    END IF;

    -- Non-terminal states can only advance forward
    IF new_state_order < state_order AND new_state_order < 10 THEN
        RAISE EXCEPTION 'Dispute % cannot regress from % to %',
            OLD.id, OLD.status, NEW.status
            USING ERRCODE = 'HX702';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS dispute_forward_state_guard ON payment_disputes;
CREATE TRIGGER dispute_forward_state_guard
    BEFORE UPDATE ON payment_disputes
    FOR EACH ROW
    EXECUTE FUNCTION enforce_dispute_forward_state();
