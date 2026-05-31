-- 008-c6-schema-alignment.sql
--
-- C6 schema alignment: brings the live Neon `users` table and adjacent rating
-- table in line with what the existing TypeScript code already assumes.
-- Surfaced during the C6 (signup gate on Dispatch) manual acceptance attempt
-- on 2026-05-30, when the first authenticated `user.register` → `task.create`
-- web call hit a cascade of "column does not exist" / "relation does not
-- exist" / check-constraint errors against the live Neon DB.
--
-- This file is the canonical, idempotent statement of every drift remediation.
-- Parts of it have ALREADY been applied to the dev Neon DB on 2026-05-30 as
-- part of the acceptance attempt (each step is marked); re-running the whole
-- file is a no-op for those parts. The `plan` / `plan_expires_at` columns at
-- the bottom were NOT applied — they are the next blocker for C6 to complete.
--
-- Every change here is purely additive or strictly more permissive — no data
-- is rewritten, no column is dropped, no constraint is tightened.
--
-- ---------------------------------------------------------------------------
-- DRIFT INVENTORY (from the C6 acceptance run)
-- ---------------------------------------------------------------------------
--
--   1. user.register INSERT references users.is_banned, account_status,
--      date_of_birth, is_minor — none existed on live. [APPLIED 2026-05-30]
--   2. users_trust_tier_check enforced trust_tier >= 1, but the code at
--      backend/src/routers/user.ts:355 explicitly inserts 0 for phone-less
--      signups (UNVERIFIED tier). [RELAXED 2026-05-30 to 0..4]
--   3. toMobileUser() in user.ts queries FROM task_ratings — table missing
--      from live. [CREATED 2026-05-30, empty]
--   4. PlanService.getUserPlan queries SELECT plan, plan_expires_at FROM
--      users — neither column exists. [NOT YET APPLIED — next C6 blocker]
--
-- ---------------------------------------------------------------------------
-- STEP 1 — users: add the auth/COPPA/ban-status columns (APPLIED 2026-05-30)
-- ---------------------------------------------------------------------------

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_banned BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS account_status TEXT NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN IF NOT EXISTS date_of_birth DATE,
  ADD COLUMN IF NOT EXISTS is_minor BOOLEAN NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- STEP 2 — users: relax trust_tier check to allow 0 (UNVERIFIED) tier
--                  (RELAXED 2026-05-30)
-- ---------------------------------------------------------------------------
-- The new range is a strict superset of the old one (1..4), so this only
-- accepts MORE rows, never rejects fewer.

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_trust_tier_check;
ALTER TABLE users
  ADD CONSTRAINT users_trust_tier_check
  CHECK (trust_tier >= 0 AND trust_tier <= 4);

-- ---------------------------------------------------------------------------
-- STEP 3 — task_ratings: create empty table + indexes (CREATED 2026-05-30)
-- ---------------------------------------------------------------------------
-- Definition copied verbatim from backend/database/constitutional-schema.sql
-- lines 1657-1688. Empty table — toMobileUser stats then resolve to
-- AVG → NULL → COALESCE(5.0), COUNT → 0, which is correct for any user
-- with no ratings yet.

CREATE TABLE IF NOT EXISTS task_ratings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  rater_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ratee_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stars INTEGER NOT NULL CHECK (stars >= 1 AND stars <= 5),
  comment TEXT,
  tags TEXT[],
  is_public BOOLEAN DEFAULT true,
  is_blind BOOLEAN DEFAULT true,
  is_auto_rated BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  UNIQUE(task_id, rater_id, ratee_id),
  CHECK (comment IS NULL OR LENGTH(comment) <= 500)
);

CREATE INDEX IF NOT EXISTS idx_ratings_ratee
  ON task_ratings(ratee_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ratings_task
  ON task_ratings(task_id);
CREATE INDEX IF NOT EXISTS idx_ratings_public
  ON task_ratings(ratee_id, is_public)
  WHERE is_public = true;

-- ---------------------------------------------------------------------------
-- STEP 4 — users: add plan columns (NOT YET APPLIED — next C6 blocker)
-- ---------------------------------------------------------------------------
-- Surfaced by the *third* attempt at task.create during C6 acceptance:
--   "column "plan" does not exist"
-- backend/src/services/PlanService.ts:77
--   SELECT plan, plan_expires_at FROM users WHERE id = $1
-- Defaulting plan to 'free' matches PlanService's documented behaviour for
-- an expired/missing plan (line 91: UPDATE users SET plan = 'free').

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'free',
  ADD COLUMN IF NOT EXISTS plan_expires_at TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- KNOWN FOLLOW-ONS NOT INCLUDED HERE
-- ---------------------------------------------------------------------------
-- After this migration runs, the C6 path may still hit further drift inside
-- TaskService.create (downstream of PlanService). Those should be discovered
-- by re-running C6 manual acceptance after applying this file and resolved
-- in a follow-up migration of the same shape (purely additive). DO NOT add
-- speculative columns here.
