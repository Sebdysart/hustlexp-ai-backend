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
--      users — neither column exists. [APPLIED 2026-05-31]
--   5. tasks INSERT in TaskService.create references xp_reward, risk_level,
--      mode, live_broadcast_radius_miles, instant_mode, sensitive — none of
--      these existed on live tasks. Defaults come from canonical migration
--      005-mega-schema-alignment.sql (which was never applied to live).
--      [APPLIED 2026-05-31]
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
-- STEP 4 — users: add plan columns (APPLIED 2026-05-31)
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
-- STEP 5 — tasks: add the columns TaskService.create's INSERT references
--                  (APPLIED 2026-05-31)
-- ---------------------------------------------------------------------------
-- The INSERT in backend/src/services/TaskService.ts:443 binds 17 columns;
-- six of them did not exist on live `tasks`. Defaults are taken verbatim
-- from the canonical (never-applied-on-live) 005-mega-schema-alignment.sql.
-- The risk_level CHECK is added as a separate constraint guarded by
-- pg_constraint so a re-run is idempotent.

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS xp_reward                  INTEGER NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS risk_level                 TEXT    NOT NULL DEFAULT 'LOW',
  ADD COLUMN IF NOT EXISTS mode                       TEXT    DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS live_broadcast_radius_miles NUMERIC,
  ADD COLUMN IF NOT EXISTS instant_mode               BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS sensitive                  BOOLEAN DEFAULT FALSE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tasks_risk_level_check'
  ) THEN
    ALTER TABLE tasks
      ADD CONSTRAINT tasks_risk_level_check
      CHECK (risk_level IN ('LOW','MEDIUM','HIGH','IN_HOME'));
  END IF;
END$$;

-- ---------------------------------------------------------------------------
-- C6 ACCEPTANCE — passed end-to-end on 2026-05-31 after step 5 was applied.
-- task.create returned 200, task persisted to Neon (id a90f33a1-99b0-4c13-
-- 852e-a8f52698f570), post-create UI showed "Task draft created. Secure
-- payment is next." No Stripe / payment-intent call fired. C7 (Stripe
-- Elements funding) is the next roadmap item.
-- ---------------------------------------------------------------------------
--
-- KNOWN NON-DB BLOCKER SURFACED DURING ACCEPTANCE (NOT in this migration):
-- The Upstash Redis account is account-level rate-limited at the time of
-- writing. invalidateCacheByTag in backend/src/cache/query-cache.ts:157 calls
-- pipeline.exec() without a try/catch and surfaces TypeError "res.map is not
-- a function" as INTERNAL_SERVER_ERROR after a successful task.create. The
-- dev acceptance run worked around this by launching the backend with empty
-- UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN (so getClient() returns
-- null and the cache helpers no-op). This is a resilience bug independent
-- of C6 — fix is to wrap pipeline.exec in the same fail-open shape as
-- redis.get / checkRateLimit. Recommended follow-up for the next operator.
