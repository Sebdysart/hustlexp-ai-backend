-- HX/OS Compliance Guardian persistence contract.
-- Closes the fresh-deployment hole where the runtime referenced a user counter
-- and violation table that were present only in legacy, unpackaged migrations.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS flagged_phrase_counter JSONB;

-- Convert the historical array shape into the current phrase-keyed object.
-- Duplicate phrases retain count and first/last observations.
WITH legacy_entries AS (
  SELECT
    u.id AS user_id,
    entry->>'phrase' AS phrase,
    COUNT(*)::INTEGER AS occurrence_count,
    MIN(entry->>'matched_at') AS first_at,
    MAX(entry->>'matched_at') AS last_at
  FROM (
    SELECT id, flagged_phrase_counter
    FROM users
    WHERE jsonb_typeof(flagged_phrase_counter) = 'array'
  ) u
  CROSS JOIN LATERAL jsonb_array_elements(u.flagged_phrase_counter) AS entry
  WHERE NULLIF(BTRIM(entry->>'phrase'), '') IS NOT NULL
  GROUP BY u.id, entry->>'phrase'
),
legacy_objects AS (
  SELECT
    user_id,
    jsonb_object_agg(
      phrase,
      jsonb_build_object(
        'count', occurrence_count,
        'first_at', first_at,
        'last_at', last_at
      )
    ) AS counter
  FROM legacy_entries
  GROUP BY user_id
)
UPDATE users u
SET flagged_phrase_counter = COALESCE(o.counter, '{}'::jsonb)
FROM legacy_objects o
WHERE u.id = o.user_id;

UPDATE users
SET flagged_phrase_counter = '{}'::jsonb
WHERE flagged_phrase_counter IS NULL
   OR jsonb_typeof(flagged_phrase_counter) <> 'object';

ALTER TABLE users
  ALTER COLUMN flagged_phrase_counter SET DEFAULT '{}'::jsonb,
  ALTER COLUMN flagged_phrase_counter SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'users_flagged_phrase_counter_object'
      AND conrelid = 'users'::regclass
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_flagged_phrase_counter_object
      CHECK (jsonb_typeof(flagged_phrase_counter) = 'object');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS compliance_violations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ip_address INET,
  device_fingerprint TEXT,
  raw_description TEXT NOT NULL,
  risk_score INTEGER NOT NULL CHECK (risk_score BETWEEN 0 AND 100),
  triggered_rules JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(triggered_rules) = 'array'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

UPDATE compliance_violations
SET triggered_rules = '[]'::jsonb
WHERE triggered_rules IS NULL;

ALTER TABLE compliance_violations
  ALTER COLUMN triggered_rules SET DEFAULT '[]'::jsonb,
  ALTER COLUMN triggered_rules SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_compliance_violations_user_id
  ON compliance_violations(user_id);
CREATE INDEX IF NOT EXISTS idx_compliance_violations_risk_score
  ON compliance_violations(risk_score);
CREATE INDEX IF NOT EXISTS idx_compliance_violations_created_at
  ON compliance_violations USING BRIN (created_at);
