-- A corrective visit is a child of an already completed task. It carries no
-- quote, payment, task-progress, or completion-verification identity.
CREATE TABLE task_reworks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  business_organization_id UUID NOT NULL REFERENCES business_organizations(id) ON DELETE RESTRICT,
  sequence_number INTEGER NOT NULL CHECK (sequence_number > 0),
  status TEXT NOT NULL DEFAULT 'REQUESTED' CHECK (status IN (
    'REQUESTED', 'ACCEPTED', 'DECLINED', 'SCHEDULED',
    'IN_PROGRESS', 'PROOF_SUBMITTED', 'COMPLETED', 'CANCELLED'
  )),
  reason_category TEXT NOT NULL CHECK (char_length(btrim(reason_category)) BETWEEN 2 AND 80),
  requested_correction TEXT NOT NULL CHECK (char_length(btrim(requested_correction)) BETWEEN 10 AND 4000),
  requested_by_admin_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  support_thread_id UUID REFERENCES support_threads(id) ON DELETE RESTRICT,
  scheduled_service_date DATE,
  arrival_window_start TIMESTAMPTZ,
  arrival_window_end TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  declined_at TIMESTAMPTZ,
  scheduled_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  proof_submitted_at TIMESTAMPTZ,
  customer_confirmed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  event_sequence INTEGER NOT NULL DEFAULT 1 CHECK (event_sequence > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (task_id, sequence_number),
  UNIQUE (id, task_id),
  CHECK ((arrival_window_start IS NULL) = (arrival_window_end IS NULL)),
  CHECK (arrival_window_end IS NULL OR arrival_window_end > arrival_window_start)
);

CREATE UNIQUE INDEX task_reworks_one_active_per_task
  ON task_reworks(task_id)
  WHERE status IN ('REQUESTED', 'ACCEPTED', 'SCHEDULED', 'IN_PROGRESS', 'PROOF_SUBMITTED');
CREATE INDEX task_reworks_task_history_idx ON task_reworks(task_id, sequence_number DESC);
CREATE INDEX task_reworks_support_thread_idx ON task_reworks(support_thread_id)
  WHERE support_thread_id IS NOT NULL;

CREATE OR REPLACE FUNCTION guard_task_rework_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.task_id IS DISTINCT FROM OLD.task_id
     OR NEW.business_organization_id IS DISTINCT FROM OLD.business_organization_id
     OR NEW.sequence_number IS DISTINCT FROM OLD.sequence_number THEN
    RAISE EXCEPTION 'HXREWORK2: corrective-work identity is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER task_reworks_identity_guard
  BEFORE UPDATE ON task_reworks FOR EACH ROW EXECUTE FUNCTION guard_task_rework_identity();

ALTER TABLE proofs ADD COLUMN IF NOT EXISTS rework_id UUID;
ALTER TABLE proofs ADD CONSTRAINT proofs_rework_task_fk
  FOREIGN KEY (rework_id, task_id) REFERENCES task_reworks(id, task_id) ON DELETE RESTRICT;
CREATE INDEX proofs_rework_idx ON proofs(rework_id, created_at DESC)
  WHERE rework_id IS NOT NULL;

-- Reputation response time and rating aggregates use original task proof only.
CREATE OR REPLACE VIEW poster_reputation AS
SELECT
    u.id as poster_id,
    COUNT(DISTINCT t.id) as tasks_posted_90d,
    COUNT(DISTINCT d.id) as disputes_90d,
    ROUND(AVG(EXTRACT(EPOCH FROM (p.reviewed_at - p.submitted_at))/3600)::NUMERIC, 1) as avg_response_hours,
    COUNT(CASE WHEN pr.rating = 'GREAT' THEN 1 END) as great_ratings,
    COUNT(CASE WHEN pr.rating = 'OKAY' THEN 1 END) as okay_ratings,
    COUNT(CASE WHEN pr.rating = 'DIFFICULT' THEN 1 END) as difficult_ratings,
    COUNT(pr.id) as total_ratings
FROM users u
LEFT JOIN tasks t ON t.poster_id = u.id AND t.created_at > NOW() - INTERVAL '90 days'
LEFT JOIN disputes d ON d.task_id = t.id
LEFT JOIN proofs p ON p.task_id = t.id AND p.rework_id IS NULL
LEFT JOIN poster_ratings pr ON pr.poster_id = u.id AND pr.created_at > NOW() - INTERVAL '90 days'
GROUP BY u.id
HAVING COUNT(DISTINCT t.id) >= 5;

ALTER TABLE media_upload_receipts ADD COLUMN rework_id UUID;
ALTER TABLE media_upload_receipts ADD CONSTRAINT media_upload_receipts_rework_task_fk
  FOREIGN KEY (rework_id, task_id) REFERENCES task_reworks(id, task_id) ON DELETE RESTRICT;
ALTER TABLE media_upload_receipts ADD CONSTRAINT media_upload_receipts_rework_purpose_ck
  CHECK (rework_id IS NULL OR (purpose = 'PROOF' AND task_id IS NOT NULL));

CREATE OR REPLACE FUNCTION guard_rework_evidence_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.rework_id IS DISTINCT FROM OLD.rework_id OR NEW.task_id IS DISTINCT FROM OLD.task_id THEN
    RAISE EXCEPTION 'HXREWORK1: corrective evidence identity is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER proofs_rework_identity_guard
  BEFORE UPDATE ON proofs FOR EACH ROW EXECUTE FUNCTION guard_rework_evidence_identity();
CREATE TRIGGER media_receipts_rework_identity_guard
  BEFORE UPDATE ON media_upload_receipts FOR EACH ROW EXECUTE FUNCTION guard_rework_evidence_identity();
