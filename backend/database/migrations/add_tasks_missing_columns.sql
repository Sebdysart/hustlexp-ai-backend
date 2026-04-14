-- Migration: Add all missing columns to tasks table
-- These columns are referenced by TaskService.create() and task router
-- but were not included in the base constitutional-schema.sql

-- TaskService.create() INSERT columns
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS estimated_duration VARCHAR(100);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS xp_reward INTEGER DEFAULT 0;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS instant_mode BOOLEAN DEFAULT FALSE;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS sensitive BOOLEAN DEFAULT FALSE;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS template_slug VARCHAR(50);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS matched_at TIMESTAMPTZ;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS surge_level INTEGER;

-- Task router UPDATE columns (post-create metadata)
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS illegal_risk_score INTEGER;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS compliance_guardian_notes JSONB;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS late_cancel_pct NUMERIC;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS content_release BOOLEAN DEFAULT FALSE;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS cancellation_window_hours INTEGER;

-- Progress tracking (Pillar A - Realtime Tracking)
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS progress_state VARCHAR(20) DEFAULT 'POSTED';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS progress_updated_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS progress_by UUID;

-- Location coordinates (for heatmap spatial queries)
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS location_lat DECIMAL(10,8);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS location_lng DECIMAL(11,8);

-- Recurring tasks link
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS parent_series_id UUID;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS occurrence_number INTEGER;

-- State additions for MATCHING (instant mode)
-- Update the state CHECK constraint to include MATCHING
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_state_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_state_check CHECK (state IN (
    'OPEN', 'MATCHING', 'ACCEPTED', 'PROOF_SUBMITTED',
    'DISPUTED', 'COMPLETED', 'CANCELLED', 'EXPIRED'
));
