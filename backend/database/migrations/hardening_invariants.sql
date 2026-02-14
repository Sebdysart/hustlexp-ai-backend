-- ============================================================================
-- HARDENING INVARIANTS MIGRATION
-- Constitutional-grade triggers for financial integrity
-- ============================================================================

-- ============================================================================
-- FIX 1: RECURRING TASK SUBSCRIPTION ENFORCEMENT
-- ============================================================================
-- Prevents recurring task creation when user has no subscription capacity.
-- DB trigger enforces what the application layer also checks.
-- ============================================================================

-- 1a. Prevent recurring task series creation beyond subscription limit
CREATE OR REPLACE FUNCTION enforce_recurring_subscription_limit()
RETURNS TRIGGER AS $$
DECLARE
  user_limit INT;
  active_count INT;
BEGIN
  -- Only check on INSERT or when activating a paused series
  IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND NEW.status = 'active' AND OLD.status != 'active') THEN
    -- Get user's recurring task limit
    SELECT COALESCE(recurring_task_limit, 0) INTO user_limit
    FROM users WHERE id = NEW.poster_id;

    -- Count existing active series (exclude the current one on UPDATE)
    SELECT COUNT(*) INTO active_count
    FROM recurring_task_series
    WHERE poster_id = NEW.poster_id
      AND status = 'active'
      AND id != COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid);

    IF active_count >= user_limit THEN
      RAISE EXCEPTION 'SUBSCRIPTION_LIMIT_EXCEEDED: User % has % active recurring series but limit is %. Upgrade subscription to create more.',
        NEW.poster_id, active_count, user_limit
        USING ERRCODE = 'HX501';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS recurring_subscription_guard ON recurring_task_series;
CREATE TRIGGER recurring_subscription_guard
    BEFORE INSERT OR UPDATE ON recurring_task_series
    FOR EACH ROW
    EXECUTE FUNCTION enforce_recurring_subscription_limit();

-- 1b. Auto-pause recurring series when user subscription downgrades
-- This is a safety net enforced at DB level on the users table
CREATE OR REPLACE FUNCTION auto_pause_recurring_on_downgrade()
RETURNS TRIGGER AS $$
BEGIN
  -- If recurring_task_limit decreased, pause excess series
  IF NEW.recurring_task_limit < OLD.recurring_task_limit THEN
    -- Pause all active series beyond the new limit
    WITH ranked_series AS (
      SELECT id, ROW_NUMBER() OVER (ORDER BY created_at ASC) as rn
      FROM recurring_task_series
      WHERE poster_id = NEW.id AND status = 'active'
    )
    UPDATE recurring_task_series
    SET status = 'paused', updated_at = NOW()
    WHERE id IN (
      SELECT id FROM ranked_series WHERE rn > NEW.recurring_task_limit
    );

    -- Cancel scheduled occurrences for paused series
    UPDATE recurring_task_occurrences
    SET status = 'cancelled'
    WHERE series_id IN (
      SELECT id FROM recurring_task_series
      WHERE poster_id = NEW.id AND status = 'paused'
    )
    AND status = 'scheduled';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS recurring_auto_pause_on_downgrade ON users;
CREATE TRIGGER recurring_auto_pause_on_downgrade
    AFTER UPDATE OF recurring_task_limit ON users
    FOR EACH ROW
    WHEN (NEW.recurring_task_limit < OLD.recurring_task_limit)
    EXECUTE FUNCTION auto_pause_recurring_on_downgrade();

-- ============================================================================
-- FIX 2: RISK LEVEL IMMUTABILITY (INV-6)
-- ============================================================================
-- risk_level is write-once. After task creation, it cannot be changed.
-- This prevents fee bypass: create as MEDIUM (pay $2.50) then downgrade to LOW.
-- ============================================================================

-- 2a. Prevent risk_level modification after creation
CREATE OR REPLACE FUNCTION prevent_risk_level_mutation()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.risk_level IS DISTINCT FROM OLD.risk_level THEN
        RAISE EXCEPTION 'INV-6_VIOLATION: risk_level is immutable after creation. Task: %, attempted change: % -> %',
            OLD.id, OLD.risk_level, NEW.risk_level
            USING ERRCODE = 'HX606';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS task_risk_level_immutable ON tasks;
CREATE TRIGGER task_risk_level_immutable
    BEFORE UPDATE ON tasks
    FOR EACH ROW
    EXECUTE FUNCTION prevent_risk_level_mutation();

-- 2b. Patch terminal state trigger to also protect risk_level
-- (Belt and suspenders: risk_level trigger handles ALL states,
--  this ensures terminal state trigger is also comprehensive)
CREATE OR REPLACE FUNCTION prevent_task_terminal_mutation()
RETURNS TRIGGER AS $$
BEGIN
    -- Check if OLD state is terminal
    IF OLD.state IN ('COMPLETED', 'CANCELLED', 'EXPIRED') THEN
        -- Only allow updates to audit-related fields (updated_at, etc.)
        IF NEW.state != OLD.state OR
           NEW.price != OLD.price OR
           NEW.poster_id != OLD.poster_id OR
           NEW.worker_id IS DISTINCT FROM OLD.worker_id OR
           NEW.title != OLD.title OR
           NEW.description != OLD.description OR
           NEW.risk_level != OLD.risk_level THEN
            RAISE EXCEPTION 'TERMINAL_STATE_VIOLATION: Cannot modify task % in terminal state %', OLD.id, OLD.state
                USING ERRCODE = 'HX001';
        END IF;
    END IF;

    -- Prevent transition FROM terminal states
    IF OLD.state IN ('COMPLETED', 'CANCELLED', 'EXPIRED') AND NEW.state != OLD.state THEN
        RAISE EXCEPTION 'TERMINAL_STATE_VIOLATION: Cannot transition task % from terminal state %', OLD.id, OLD.state
            USING ERRCODE = 'HX001';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- FIX 3: REVENUE LEDGER APPEND-ONLY (INV-7)
-- ============================================================================
-- revenue_ledger is a financial audit trail. No UPDATE or DELETE allowed.
-- Matches the existing xp_ledger, badges, and admin_actions patterns.
-- ============================================================================

-- 3a. Prevent UPDATE on revenue_ledger
CREATE OR REPLACE FUNCTION prevent_revenue_ledger_update()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'INV-7_VIOLATION: revenue_ledger is append-only. Cannot update entry: %. To correct, insert a compensating entry.',
        OLD.id
        USING ERRCODE = 'HX701';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS revenue_ledger_no_update ON revenue_ledger;
CREATE TRIGGER revenue_ledger_no_update
    BEFORE UPDATE ON revenue_ledger
    FOR EACH ROW
    EXECUTE FUNCTION prevent_revenue_ledger_update();

-- 3b. Prevent DELETE on revenue_ledger
CREATE OR REPLACE FUNCTION prevent_revenue_ledger_delete()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'INV-7_VIOLATION: revenue_ledger is append-only. Cannot delete entry: %. Financial records are permanent.',
        OLD.id
        USING ERRCODE = 'HX702';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS revenue_ledger_no_delete ON revenue_ledger;
CREATE TRIGGER revenue_ledger_no_delete
    BEFORE DELETE ON revenue_ledger
    FOR EACH ROW
    EXECUTE FUNCTION prevent_revenue_ledger_delete();

-- ============================================================================
-- FIX 4: INSURANCE SUBSCRIPTIONS PAYMENT STATUS
-- ============================================================================
-- Required for two-step insurance upgrade confirm pattern.
-- ============================================================================

ALTER TABLE insurance_subscriptions ADD COLUMN IF NOT EXISTS payment_status VARCHAR(20) DEFAULT 'pending'
    CHECK (payment_status IN ('pending', 'paid', 'failed'));
CREATE INDEX IF NOT EXISTS idx_insurance_subscriptions_payment ON insurance_subscriptions(payment_status);
