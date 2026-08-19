-- Ops web hardening: feature_flags.key alias for Supabase parity + append-only ops action audit.

ALTER TABLE feature_flags
  ADD COLUMN IF NOT EXISTS key TEXT;

UPDATE feature_flags
SET key = name
WHERE key IS NULL;

ALTER TABLE feature_flags
  ALTER COLUMN key SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'feature_flags_key_unique'
  ) THEN
    ALTER TABLE feature_flags ADD CONSTRAINT feature_flags_key_unique UNIQUE (key);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION sync_feature_flags_key_from_name()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.key IS NULL OR BTRIM(NEW.key) = '' THEN
    NEW.key := NEW.name;
  END IF;
  IF NEW.name IS NULL OR BTRIM(NEW.name) = '' THEN
    NEW.name := NEW.key;
  END IF;
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_feature_flags_sync_key ON feature_flags;
CREATE TRIGGER trg_feature_flags_sync_key
  BEFORE INSERT OR UPDATE ON feature_flags
  FOR EACH ROW EXECUTE FUNCTION sync_feature_flags_key_from_name();

CREATE TABLE IF NOT EXISTS ops_action_audit (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id UUID,
  actor_label  TEXT NOT NULL DEFAULT 'ops',
  action       TEXT NOT NULL,
  target_type  TEXT NOT NULL,
  target_id    TEXT,
  meta         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ops_action_audit_created
  ON ops_action_audit (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ops_action_audit_action
  ON ops_action_audit (action, created_at DESC);
