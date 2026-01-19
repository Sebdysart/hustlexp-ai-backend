/**
 * N2.2 Cleanup Migration - Task State Machine Canonicalization
 * 
 * ============================================================================
 * PURPOSE
 * ============================================================================
 * 
 * Adds WORKING state to task state machine and execution timestamps.
 * Normalizes state transitions: OPEN → EN_ROUTE → WORKING → COMPLETED
 * 
 * ============================================================================
 * CHANGES
 * ============================================================================
 * 
 * 1. Add WORKING state to CHECK constraint
 * 2. Add en_route_at timestamp column
 * 3. Add arrived_at timestamp column
 * 
 * ============================================================================
 * STATE MACHINE (CANONICAL)
 * ============================================================================
 * 
 * OPEN → EN_ROUTE (ACCEPTED) → WORKING → COMPLETED
 * 
 * TERMINAL: COMPLETED, CANCELLED, EXPIRED
 * 
 * ============================================================================
 * NOTES
 * ============================================================================
 * 
 * - PROOF_SUBMITTED is kept for backward compatibility but not used in execution flow
 * - EN_ROUTE maps to ACCEPTED in schema (conceptual state vs. storage)
 * - All timestamps are execution-gated for analytics and SLAs
 * 
 * Reference: Phase N2.2 Final Authority Resolution
 */

BEGIN;

-- ============================================================================
-- 1. Add WORKING state to CHECK constraint
-- ============================================================================
-- 
-- PostgreSQL doesn't support ALTER TABLE ... DROP CONSTRAINT ... ADD CONSTRAINT
-- for CHECK constraints directly. We need to:
-- 1. Drop the old constraint (handle any name variations)
-- 2. Add the new constraint with WORKING included

-- Drop constraint if it exists (try common names and any state-related constraint)
ALTER TABLE tasks
  DROP CONSTRAINT IF EXISTS tasks_state_check;

-- Add new constraint with WORKING state included
ALTER TABLE tasks
  ADD CONSTRAINT tasks_state_check CHECK (
    state IN (
      'OPEN',           -- Visible, accepting applications
      'MATCHING',       -- Instant mode: searching for hustler (existing state)
      'ACCEPTED',       -- Worker assigned, en route (maps to EN_ROUTE)
      'WORKING',        -- Worker arrived and working on task (NEW)
      'PROOF_SUBMITTED',-- Awaiting poster review (legacy, kept for compatibility)
      'DISPUTED',       -- Under admin review
      'COMPLETED',      -- TERMINAL: Successfully finished
      'CANCELLED',      -- TERMINAL: Terminated by poster/admin
      'EXPIRED'         -- TERMINAL: Time limit exceeded
    )
  );

-- ============================================================================
-- 2. Add execution timestamps
-- ============================================================================

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS en_route_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS arrived_at TIMESTAMPTZ;

-- ============================================================================
-- 3. Create indexes for timestamp queries (optional but recommended)
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_tasks_en_route_at ON tasks(en_route_at) WHERE en_route_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_arrived_at ON tasks(arrived_at) WHERE arrived_at IS NOT NULL;

COMMIT;
