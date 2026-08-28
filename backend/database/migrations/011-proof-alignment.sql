-- Migration 011: Proof-review schema alignment (idempotent, for EXISTING databases)
--
-- WHY: The code paths task.reviewProof (approve/reject) and task.complete require
-- objects that drifted off some existing databases:
--   - proof_submissions table (LEFT JOINed by ProofService.review)
--   - tasks.location_lat / location_lng  (logistics check in ProofService.review)
--   - tasks.before_photo_url             (photo check in ProofService.review)
--   - tasks.progress_state (strict)      (TaskService.complete / tracking)
-- Without these, reviewProof returns 400 ("relation proof_submissions does not exist").
-- This file adds exactly those objects. Proven on a disposable Neon branch where
-- proof reject + approve then passed.
--
-- HOW TO APPLY: OUT-OF-BAND ONLY via the reviewed alignment process
--   (psql / node-pg / Neon run_sql) against the target DB. NEVER via `npm run db:migrate`
--   (disabled — it was destructive DROP SCHEMA). This script is fully idempotent and
--   re-runnable. It intentionally does NOT write schema_versions (avoids the 005
--   NOT-NULL applied_by/checksum pitfall).
--
-- SAFETY: additive only. No DROP, no data loss. The only data write is a backfill of
-- NULL tasks.progress_state -> 'POSTED'.

-- 1. proof_submissions (verbatim shape from 005-mega-schema-alignment.sql)
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

-- 2. tasks geo + before-photo columns used by the proof-review verification path
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS location_lat NUMERIC;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS location_lng NUMERIC;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS before_photo_url TEXT;

-- 3. tasks.progress_state — strict VARCHAR(20), NOT NULL, DEFAULT 'POSTED', CHECK.
--    Handles both "missing" and "exists as bare TEXT (from 005)".
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS progress_state VARCHAR(20);

DO $$
BEGIN
  -- Coerce a pre-existing non-varchar (e.g. bare TEXT from 005) to VARCHAR(20).
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tasks' AND column_name = 'progress_state'
      AND data_type <> 'character varying'
  ) THEN
    ALTER TABLE tasks ALTER COLUMN progress_state TYPE VARCHAR(20);
  END IF;
END $$;

UPDATE tasks SET progress_state = 'POSTED' WHERE progress_state IS NULL;
ALTER TABLE tasks ALTER COLUMN progress_state SET DEFAULT 'POSTED';
ALTER TABLE tasks ALTER COLUMN progress_state SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tasks_progress_state_check'
  ) THEN
    ALTER TABLE tasks
      ADD CONSTRAINT tasks_progress_state_check
      CHECK (progress_state IN ('POSTED','ACCEPTED','TRAVELING','WORKING','COMPLETED','CLOSED'))
      NOT VALID;
    ALTER TABLE tasks VALIDATE CONSTRAINT tasks_progress_state_check;
  END IF;
END $$;

-- 4. proofs review columns — guarded; add only if missing (already present on most DBs).
ALTER TABLE proofs ADD COLUMN IF NOT EXISTS state VARCHAR(20) NOT NULL DEFAULT 'PENDING';
ALTER TABLE proofs ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES users(id);
ALTER TABLE proofs ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE proofs ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
ALTER TABLE proofs ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ;
