-- Purpose-bound audit evidence for authorized safety-case detail reads.

CREATE TABLE IF NOT EXISTS task_safety_case_access_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id UUID NOT NULL REFERENCES task_safety_incidents(id) ON DELETE RESTRICT,
  admin_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  purpose TEXT NOT NULL CHECK (char_length(purpose) BETWEEN 10 AND 500),
  access_scope TEXT NOT NULL DEFAULT 'CASE_DETAIL' CHECK (access_scope = 'CASE_DETAIL'),
  accessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS task_safety_case_access_incident_time
  ON task_safety_case_access_log(incident_id, accessed_at DESC);
CREATE INDEX IF NOT EXISTS task_safety_case_access_admin_time
  ON task_safety_case_access_log(admin_user_id, accessed_at DESC);

CREATE OR REPLACE FUNCTION prevent_task_safety_case_access_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'HX829: safety case access evidence is append-only'
    USING ERRCODE = 'HX829';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS task_safety_case_access_no_update ON task_safety_case_access_log;
CREATE TRIGGER task_safety_case_access_no_update
  BEFORE UPDATE ON task_safety_case_access_log
  FOR EACH ROW EXECUTE FUNCTION prevent_task_safety_case_access_mutation();

DROP TRIGGER IF EXISTS task_safety_case_access_no_delete ON task_safety_case_access_log;
CREATE TRIGGER task_safety_case_access_no_delete
  BEFORE DELETE ON task_safety_case_access_log
  FOR EACH ROW EXECUTE FUNCTION prevent_task_safety_case_access_mutation();

DROP TRIGGER IF EXISTS task_safety_case_access_no_truncate ON task_safety_case_access_log;
CREATE TRIGGER task_safety_case_access_no_truncate
  BEFORE TRUNCATE ON task_safety_case_access_log
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_task_safety_case_access_mutation();

REVOKE ALL ON TABLE task_safety_case_access_log FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE task_safety_case_access_log FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE task_safety_case_access_log FROM authenticated;
  END IF;
END
$$;
