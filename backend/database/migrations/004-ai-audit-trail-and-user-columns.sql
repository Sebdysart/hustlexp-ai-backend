-- ============================================================================
-- Migration 004: AI Audit Trail Tables & User Columns
-- ============================================================================
-- Creates the 4 AI audit trail tables (ai_jobs, ai_proposals, ai_decisions,
-- ai_agent_decisions) and adds missing columns to the users table.
--
-- Idempotent: uses IF NOT EXISTS and DO $$ blocks throughout.
-- ============================================================================

-- ============================================================================
-- 1. AI JOBS TABLE (schema.sql SS7.2)
-- Tracks individual AI job executions, linked to ai_events.
-- ============================================================================
CREATE TABLE IF NOT EXISTS ai_jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        UUID NOT NULL REFERENCES ai_events(id) ON DELETE CASCADE,
  subsystem       TEXT NOT NULL,

  status          TEXT NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING','PROCESSING','COMPLETED','FAILED','TIMED_OUT','KILLED')),

  -- Model info
  model_provider  TEXT,
  model_id        TEXT,
  prompt_version  TEXT,

  -- Timing
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  timeout_ms      INTEGER NOT NULL DEFAULT 30000,

  -- Retry tracking
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 3,
  last_error      TEXT,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for ai_jobs
CREATE INDEX IF NOT EXISTS idx_ai_jobs_event_id   ON ai_jobs(event_id);
CREATE INDEX IF NOT EXISTS idx_ai_jobs_status     ON ai_jobs(status);
CREATE INDEX IF NOT EXISTS idx_ai_jobs_subsystem  ON ai_jobs(subsystem);
CREATE INDEX IF NOT EXISTS idx_ai_jobs_created_at ON ai_jobs(created_at);

-- Auto-update updated_at trigger
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'ai_jobs_updated_at'
  ) THEN
    CREATE TRIGGER ai_jobs_updated_at
      BEFORE UPDATE ON ai_jobs
      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
END $$;


-- ============================================================================
-- 2. AI PROPOSALS TABLE (schema.sql SS7.3)
-- Stores AI proposals/suggestions produced by jobs.
-- ============================================================================
CREATE TABLE IF NOT EXISTS ai_proposals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          UUID NOT NULL REFERENCES ai_jobs(id) ON DELETE CASCADE,

  proposal_type   TEXT NOT NULL,
  proposal        JSONB NOT NULL DEFAULT '{}',
  proposal_hash   TEXT NOT NULL,

  confidence      NUMERIC(4,3),
  certainty_tier  TEXT CHECK (certainty_tier IN ('STRONG','MODERATE','WEAK')),
  anomaly_flags   TEXT[],

  schema_version  TEXT NOT NULL DEFAULT '1.0',

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for ai_proposals
CREATE INDEX IF NOT EXISTS idx_ai_proposals_job_id     ON ai_proposals(job_id);
CREATE INDEX IF NOT EXISTS idx_ai_proposals_type       ON ai_proposals(proposal_type);
CREATE INDEX IF NOT EXISTS idx_ai_proposals_created_at ON ai_proposals(created_at);


-- ============================================================================
-- 3. AI DECISIONS TABLE (schema.sql SS7.4)
-- Records decisions (accept/reject) made on proposals.
-- ============================================================================
CREATE TABLE IF NOT EXISTS ai_decisions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id     UUID NOT NULL REFERENCES ai_proposals(id) ON DELETE CASCADE,

  accepted        BOOLEAN NOT NULL,
  reason_codes    TEXT[] NOT NULL DEFAULT '{}',

  -- What was written (if accepted)
  writes          JSONB,

  -- Authority: 'system', 'admin:usr_xxx', 'user:usr_xxx'
  final_author    TEXT NOT NULL,

  decided_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for ai_decisions
CREATE INDEX IF NOT EXISTS idx_ai_decisions_proposal_id ON ai_decisions(proposal_id);
CREATE INDEX IF NOT EXISTS idx_ai_decisions_decided_at  ON ai_decisions(decided_at);


-- ============================================================================
-- 4. AI AGENT DECISIONS TABLE (schema.sql v1.8.0)
-- The primary audit trail table. Records every AI agent decision with
-- authority_level enforcement (A2 only -- proposal-only, never A1).
-- ============================================================================
CREATE TABLE IF NOT EXISTS ai_agent_decisions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_type          TEXT NOT NULL,
  task_id             UUID,
  proof_id            UUID,

  proposal            JSONB NOT NULL DEFAULT '{}',
  confidence_score    NUMERIC(4,3) NOT NULL DEFAULT 0.0,
  reasoning           TEXT,

  accepted            BOOLEAN,
  validator_override  BOOLEAN DEFAULT FALSE,
  validator_reason    TEXT,

  authority_level     TEXT NOT NULL DEFAULT 'A2',

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for ai_agent_decisions
CREATE INDEX IF NOT EXISTS idx_ai_agent_decisions_agent_type  ON ai_agent_decisions(agent_type);
CREATE INDEX IF NOT EXISTS idx_ai_agent_decisions_task_id     ON ai_agent_decisions(task_id);
CREATE INDEX IF NOT EXISTS idx_ai_agent_decisions_created_at  ON ai_agent_decisions(created_at);
CREATE INDEX IF NOT EXISTS idx_ai_agent_decisions_authority   ON ai_agent_decisions(authority_level);

-- ----------------------------------------------------------------------------
-- 4a. CHECK CONSTRAINT: authority_level must be 'A2' (proposal-only, never A1)
-- ----------------------------------------------------------------------------
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'ai_agent_decisions'
      AND constraint_name = 'ai_agent_decisions_authority_level_check'
      AND constraint_type = 'CHECK'
  ) THEN
    ALTER TABLE ai_agent_decisions
      ADD CONSTRAINT ai_agent_decisions_authority_level_check
      CHECK (authority_level = 'A2');
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 4b. CHECK CONSTRAINT: agent_type must be one of the valid agent types
-- Drop the old constraint first (if it exists with fewer values), then re-add.
-- ----------------------------------------------------------------------------
DO $$ BEGIN
  -- Drop any existing agent_type check constraint to update the allowed values
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'ai_agent_decisions'
      AND constraint_name = 'ai_agent_decisions_agent_type_check'
      AND constraint_type = 'CHECK'
  ) THEN
    ALTER TABLE ai_agent_decisions
      DROP CONSTRAINT ai_agent_decisions_agent_type_check;
  END IF;

  -- Add the full set of valid agent types
  ALTER TABLE ai_agent_decisions
    ADD CONSTRAINT ai_agent_decisions_agent_type_check
    CHECK (agent_type IN (
      'scoper',
      'judge',
      'matchmaker',
      'dispute',
      'reputation',
      'onboarding',
      'logistics'
    ));
END $$;


-- ============================================================================
-- 5. ADD MISSING COLUMNS TO USERS TABLE
-- Uses DO $$ blocks to check for column existence before adding.
-- ============================================================================

-- 5a. trust_tier (integer, default 1)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'trust_tier'
  ) THEN
    ALTER TABLE users ADD COLUMN trust_tier INTEGER NOT NULL DEFAULT 1;
  END IF;
END $$;

-- 5b. xp_total (integer, default 0)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'xp_total'
  ) THEN
    ALTER TABLE users ADD COLUMN xp_total INTEGER NOT NULL DEFAULT 0;
  END IF;
END $$;

-- 5c. current_streak (integer, default 0)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'current_streak'
  ) THEN
    ALTER TABLE users ADD COLUMN current_streak INTEGER NOT NULL DEFAULT 0;
  END IF;
END $$;

-- 5d. is_verified (boolean, default false)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'is_verified'
  ) THEN
    ALTER TABLE users ADD COLUMN is_verified BOOLEAN NOT NULL DEFAULT FALSE;
  END IF;
END $$;

-- 5e. account_status (text, default 'active')
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'account_status'
  ) THEN
    ALTER TABLE users ADD COLUMN account_status TEXT NOT NULL DEFAULT 'active';
  END IF;
END $$;


-- ============================================================================
-- END OF MIGRATION 004
-- ============================================================================
