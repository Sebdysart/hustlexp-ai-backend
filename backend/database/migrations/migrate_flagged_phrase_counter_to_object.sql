-- Migration: migrate_flagged_phrase_counter_to_object
-- Version: v2.9.1
-- Purpose: Convert old array-format flagged_phrase_counter to new object format.
--
-- Old format: [{"phrase": "no questions asked", "matched_at": "2026-02-10T00:00:00Z"}, ...]
-- New format: {"no questions asked": {"count": 1, "first_at": "...", "last_at": "..."}}
--
-- Background: Pre-v2.8.8 code stored flagged_phrase_counter as a JSONB array.
-- The current SQL uses ->$3 key access expecting a JSONB object. When the stored
-- value is an array, PostgreSQL returns NULL for a string key on an array, and
-- the subsequent array || object concatenation raises:
--   "invalid input syntax for type jsonb: array || object not supported"
-- The JS catch block handles this gracefully (first-occurrence fallback), but the
-- old array data is never corrected in place. This migration converts all stale
-- array-format rows to the canonical object format in a single transactional sweep.

BEGIN;

UPDATE users
SET flagged_phrase_counter = (
  SELECT COALESCE(
    jsonb_object_agg(
      entry->>'phrase',
      jsonb_build_object(
        'count',    1,
        'first_at', entry->>'matched_at',
        'last_at',  entry->>'matched_at'
      )
    ),
    '{}'::jsonb
  )
  FROM jsonb_array_elements(flagged_phrase_counter) AS entry
  WHERE entry->>'phrase' IS NOT NULL
)
WHERE
  flagged_phrase_counter IS NOT NULL
  AND jsonb_typeof(flagged_phrase_counter) = 'array';

-- Reset any NULL values to canonical empty object initial state.
UPDATE users
SET flagged_phrase_counter = '{}'::jsonb
WHERE flagged_phrase_counter IS NULL;

COMMIT;
