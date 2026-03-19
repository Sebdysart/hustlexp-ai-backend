-- Migration: fix_xp_ledger_clawback.sql
--
-- Fixes two schema bugs that caused XP clawback to always fail silently:
--
-- BUG 1 (ON CONFLICT): clawbackXP used ON CONFLICT (user_id, escrow_id, reason) but
--   the only unique constraint was UNIQUE (escrow_id) — the composite did not exist.
--   PostgreSQL raised "there is no unique or exclusion constraint matching the ON CONFLICT
--   specification" on every clawback call.
--
--   Fix: Replace UNIQUE (escrow_id) with UNIQUE (escrow_id, reason) so that:
--     - The original award row (reason='task_completion') keeps its uniqueness.
--     - A clawback row (reason='refund'/'dispute_loss'/etc.) can coexist per escrow.
--     - ON CONFLICT ON CONSTRAINT xp_ledger_escrow_reason_unique can be used for idempotency.
--
-- BUG 2 (CHECK constraints): clawbackXP inserted negative base_xp / effective_xp to
--   represent the debit, but the table had CHECK (base_xp > 0) and CHECK (effective_xp > 0).
--   Every clawback INSERT raised a CHECK violation (swallowed by the catch block).
--
--   Fix: Relax the CHECKs to CHECK (base_xp != 0) / CHECK (effective_xp != 0).
--   Clawback rows store negative values; awards continue to store positive values.
--   The sign convention + reason field together make the ledger self-describing.
--
-- BUG 3 (INV-1 trigger): The xp_requires_released_escrow trigger fires on ALL inserts,
--   including clawback inserts that happen after the escrow is REFUNDED or LOCKED_DISPUTE.
--   Clawback rows must be allowed even when the escrow is no longer RELEASED.
--
--   Fix: Skip the trigger for clawback entries (effective_xp < 0). Awards (effective_xp > 0)
--   still require a RELEASED escrow — INV-1 is preserved for the award path.

-- ----------------------------------------------------------------------------
-- Step 1: Drop the old UNIQUE (escrow_id) constraint
-- ----------------------------------------------------------------------------
ALTER TABLE xp_ledger DROP CONSTRAINT IF EXISTS xp_ledger_escrow_unique;

-- ----------------------------------------------------------------------------
-- Step 2: Add UNIQUE (escrow_id, reason) — allows award + clawback per escrow
-- ----------------------------------------------------------------------------
ALTER TABLE xp_ledger
  ADD CONSTRAINT xp_ledger_escrow_reason_unique UNIQUE (escrow_id, reason);

-- ----------------------------------------------------------------------------
-- Step 3: Relax base_xp CHECK — allow negative values for clawback debit rows
-- ----------------------------------------------------------------------------
ALTER TABLE xp_ledger DROP CONSTRAINT IF EXISTS xp_ledger_base_xp_check;
ALTER TABLE xp_ledger ADD CONSTRAINT xp_ledger_base_xp_check CHECK (base_xp != 0);

-- ----------------------------------------------------------------------------
-- Step 4: Relax effective_xp CHECK — allow negative values for clawback debit rows
-- ----------------------------------------------------------------------------
ALTER TABLE xp_ledger DROP CONSTRAINT IF EXISTS xp_ledger_effective_xp_check;
ALTER TABLE xp_ledger ADD CONSTRAINT xp_ledger_effective_xp_check CHECK (effective_xp != 0);

-- ----------------------------------------------------------------------------
-- Step 5: Update INV-1 trigger to skip the RELEASED-state check for clawback rows
--   (identified by effective_xp < 0).  Awards (effective_xp > 0) still require
--   the escrow to be RELEASED — INV-1 is fully preserved for the award path.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_xp_requires_released_escrow()
RETURNS TRIGGER AS $$
DECLARE
    escrow_state VARCHAR(20);
BEGIN
    -- Clawback debit entries (effective_xp < 0) are inserted AFTER the escrow has
    -- been refunded or locked — they must not be blocked by the RELEASED check.
    -- INV-1 only applies to positive XP awards.
    IF NEW.effective_xp < 0 THEN
        RETURN NEW;
    END IF;

    -- Get current escrow state for positive (award) entries
    SELECT state INTO escrow_state
    FROM escrows
    WHERE id = NEW.escrow_id;

    IF escrow_state IS NULL THEN
        RAISE EXCEPTION 'INV-1_VIOLATION: Cannot award XP - escrow % not found', NEW.escrow_id
            USING ERRCODE = 'HX101';
    END IF;

    IF escrow_state != 'RELEASED' THEN
        RAISE EXCEPTION 'INV-1_VIOLATION: Cannot award XP - escrow % is in state % (must be RELEASED)',
            NEW.escrow_id, escrow_state
            USING ERRCODE = 'HX101';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
