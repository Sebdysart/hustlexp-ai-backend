-- backend/database/migrations/task_template_system.sql
-- AI Task Template System v2.1
-- Adds: template_slug, completion_criteria, compliance fields, consent, late_cancel_pct
-- Creates: compliance_violations table

BEGIN;

-- ============================================================
-- 1. New columns on tasks
-- ============================================================

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS template_slug VARCHAR(50),
  ADD COLUMN IF NOT EXISTS completion_criteria JSONB,
  ADD COLUMN IF NOT EXISTS content_release BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS cancellation_window_hours INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS illegal_risk_score INTEGER DEFAULT 0 CHECK (illegal_risk_score BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS compliance_guardian_notes JSONB,
  ADD COLUMN IF NOT EXISTS mutual_consent_accepted BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS late_cancel_pct INTEGER NOT NULL DEFAULT 0 CHECK (late_cancel_pct BETWEEN 0 AND 100);

-- Index for compliance dashboard queries
CREATE INDEX IF NOT EXISTS idx_tasks_illegal_risk_score
  ON tasks(illegal_risk_score)
  WHERE illegal_risk_score > 20;

-- Partial index: excludes NULL rows (legacy tasks without a template)
CREATE INDEX IF NOT EXISTS idx_tasks_template_slug
  ON tasks(template_slug)
  WHERE template_slug IS NOT NULL;

-- ============================================================
-- 2. compliance_violations table (Trust & Safety only)
-- ============================================================

CREATE TABLE IF NOT EXISTS compliance_violations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- nullable: ON DELETE SET NULL retains audit record even after user deletion
  user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  ip_address      INET,
  device_fingerprint TEXT,
  raw_description TEXT NOT NULL,
  risk_score      INTEGER NOT NULL CHECK (risk_score BETWEEN 0 AND 100),
  -- { triggered_rules: string[], tier: 'soft_flag'|'hard_block', appeal_status: string }
  triggered_rules JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_compliance_violations_user_id
  ON compliance_violations(user_id);

CREATE INDEX IF NOT EXISTS idx_compliance_violations_risk_score
  ON compliance_violations(risk_score);

-- BRIN is optimal for append-only time-series tables; supports time-range dashboard queries
CREATE INDEX IF NOT EXISTS idx_compliance_violations_created_at
  ON compliance_violations USING BRIN (created_at);

COMMIT;
