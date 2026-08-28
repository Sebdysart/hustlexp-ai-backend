-- Migration: Beta contract schema alignment (2026-06-12)
-- Purpose: Add the columns the application code already reads but that are
--          missing from the live schema, causing production crashes:
--            * tasks.trust_tier_required  → applyForTask / assignWorker / accept
--              threw `column "trust_tier_required" does not exist` (apply/claim dead).
--            * users.zip_code / preferred_categories / preferred_min_price →
--              TaskDiscoveryService.calculateMatchingScore SELECTs these; when
--              absent the scorer throws (caught + skipped), so the matching-score
--              cache stays empty and getFeed always returns [] (silent empty feed).
--
-- SAFETY: 100% additive and idempotent — only `ADD COLUMN IF NOT EXISTS` with
--         nullable / sensible defaults. No data is modified, no column is dropped
--         or retyped, no row is rewritten. A NULL trust_tier_required means "no
--         poster-imposed tier floor" — exactly the pre-existing intended default,
--         so this does NOT weaken any trust gate; it makes the gate evaluable
--         instead of crashing.

-- 1. Poster-imposed trust-tier floor on a task (NULL = no extra requirement).
--    Numeric to match users.trust_tier (1=rookie, 2=verified, 3=trusted, 4=elite).
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS trust_tier_required INTEGER;

-- 2. Hustler discovery preferences read by the feed matching scorer.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS zip_code TEXT;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS preferred_categories TEXT[] DEFAULT ARRAY[]::TEXT[];

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS preferred_min_price INTEGER DEFAULT 0;

-- Helpful (optional) index for the feed's open-task scan; harmless if it already exists.
CREATE INDEX IF NOT EXISTS idx_tasks_state_open ON tasks(state) WHERE state = 'OPEN';
