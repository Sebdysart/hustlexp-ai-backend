-- HX/OS task-template authority.
-- New work must carry a deterministic v2 policy witness before it can be
-- offered or accepted. Legacy rows remain readable but fail closed at the
-- mutation boundary until they are explicitly reviewed and recreated.

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS mutual_consent_required BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE tasks
SET mutual_consent_required = TRUE
WHERE mutual_consent_required = FALSE
  AND (
    content_release = TRUE
    OR template_slug IN ('content_creator', 'wildcard_bizarre')
    OR description ~* '\m(film(ing)?|video|camera|record(ing)?|stream(ing)?|youtube|tiktok|instagram|social[[:space:]]+media)\M'
  );

CREATE OR REPLACE FUNCTION prevent_task_template_policy_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.template_slug IS DISTINCT FROM OLD.template_slug
     OR NEW.risk_level IS DISTINCT FROM OLD.risk_level
     OR NEW.trust_tier_required IS DISTINCT FROM OLD.trust_tier_required
     OR NEW.completion_criteria IS DISTINCT FROM OLD.completion_criteria
     OR NEW.content_release IS DISTINCT FROM OLD.content_release
     OR NEW.mutual_consent_required IS DISTINCT FROM OLD.mutual_consent_required
     OR NEW.cancellation_window_hours IS DISTINCT FROM OLD.cancellation_window_hours
     OR NEW.late_cancel_pct IS DISTINCT FROM OLD.late_cancel_pct
     OR NEW.cancellation_policy_version IS DISTINCT FROM OLD.cancellation_policy_version
     OR NEW.illegal_risk_score IS DISTINCT FROM OLD.illegal_risk_score
     OR NEW.compliance_guardian_notes IS DISTINCT FROM OLD.compliance_guardian_notes THEN
    RAISE EXCEPTION 'HXTP1: task template policy is immutable after creation'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS task_template_policy_immutable ON tasks;
CREATE TRIGGER task_template_policy_immutable
BEFORE UPDATE OF
  template_slug, risk_level, trust_tier_required, completion_criteria,
  content_release, mutual_consent_required, cancellation_window_hours,
  late_cancel_pct, cancellation_policy_version, illegal_risk_score,
  compliance_guardian_notes
ON tasks FOR EACH ROW EXECUTE FUNCTION prevent_task_template_policy_mutation();

CREATE OR REPLACE FUNCTION enforce_task_template_policy_on_accept()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state <> 'ACCEPTED'
     OR (TG_OP = 'UPDATE' AND OLD.state = 'ACCEPTED' AND OLD.worker_id IS NOT DISTINCT FROM NEW.worker_id) THEN
    RETURN NEW;
  END IF;
  IF NEW.cancellation_policy_version IS NULL
     OR NEW.cancellation_policy_version NOT LIKE 'task-template-v2:%' THEN
    RAISE EXCEPTION 'HXTP2: task lacks a verified v2 template policy witness'
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.mutual_consent_required AND NOT NEW.mutual_consent_accepted THEN
    RAISE EXCEPTION 'HXTP3: required mutual consent was not accepted'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS task_template_policy_accept_gate ON tasks;
CREATE TRIGGER task_template_policy_accept_gate
BEFORE INSERT OR UPDATE OF state, worker_id, mutual_consent_accepted ON tasks
FOR EACH ROW EXECUTE FUNCTION enforce_task_template_policy_on_accept();

COMMENT ON FUNCTION enforce_task_template_policy_on_accept() IS
  'HX/OS acceptance backstop: only v2 content-derived task policy is actionable; required consent must be recorded atomically.';
