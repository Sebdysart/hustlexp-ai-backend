-- Append-only bridge evidence for supplementing a legacy controlled TEST task
-- with the Price-Book duration range linked to its immutable quote version.

BEGIN;

CREATE TABLE IF NOT EXISTS hxos_local_test_duration_evidence (
  id UUID PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  source_quote_version_id UUID NOT NULL,
  duration_min_minutes INTEGER NOT NULL CHECK (duration_min_minutes BETWEEN 15 AND 1440),
  duration_expected_minutes INTEGER NOT NULL CHECK (duration_expected_minutes BETWEEN 15 AND 1440),
  duration_max_minutes INTEGER NOT NULL CHECK (duration_max_minutes BETWEEN 15 AND 1440),
  policy_version TEXT NOT NULL CHECK (policy_version='price-book-duration-v1'),
  source_evidence_hash CHAR(64) NOT NULL CHECK (source_evidence_hash ~ '^[a-f0-9]{64}$'),
  source_environment TEXT NOT NULL CHECK (source_environment='TEST'),
  request_hash CHAR(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  attestation_hash CHAR(64) NOT NULL CHECK (attestation_hash ~ '^[a-f0-9]{64}$'),
  prior_duration_minutes INTEGER CHECK (prior_duration_minutes IS NULL OR prior_duration_minutes BETWEEN 15 AND 1440),
  reason TEXT NOT NULL CHECK (reason='LEGACY_ACCEPTED_QUOTE_PRICE_BOOK_SUPPLEMENT'),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  actor_id TEXT NOT NULL CHECK (char_length(actor_id) BETWEEN 1 AND 128),
  environment TEXT NOT NULL CHECK (environment='CONTROLLED_TEST'),
  is_test BOOLEAN NOT NULL CHECK (is_test IS TRUE),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(task_id),
  UNIQUE(source_quote_version_id),
  CONSTRAINT hxos_local_test_duration_bounds CHECK (
    duration_min_minutes<=duration_expected_minutes
    AND duration_expected_minutes<=duration_max_minutes
  )
);

CREATE OR REPLACE FUNCTION enforce_local_test_duration_evidence_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_task tasks%ROWTYPE;
BEGIN
  IF (current_setting('hustlexp.local_test_duration_enabled',TRUE)='true') IS NOT TRUE THEN
    RAISE EXCEPTION 'HXDU1: local TEST duration authority is required' USING ERRCODE='P0001';
  END IF;
  SELECT * INTO v_task FROM tasks WHERE id=NEW.task_id FOR SHARE;
  IF v_task.id IS NULL
     OR v_task.automation_classification<>'CONTROLLED_TEST'
     OR v_task.state NOT IN ('OPEN','MATCHING')
     OR v_task.worker_id IS NOT NULL
     OR (v_task.estimated_duration_minutes IS NOT NULL
       AND v_task.estimated_duration_minutes<>NEW.duration_expected_minutes)
     OR v_task.estimated_duration_minutes IS DISTINCT FROM NEW.prior_duration_minutes
     OR NEW.environment<>'CONTROLLED_TEST'
     OR NEW.source_environment<>'TEST'
     OR NEW.is_test IS NOT TRUE THEN
    RAISE EXCEPTION 'HXDU2: local TEST duration task or source is invalid' USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER hxos_local_test_duration_insert_guard
BEFORE INSERT ON hxos_local_test_duration_evidence
FOR EACH ROW EXECUTE FUNCTION enforce_local_test_duration_evidence_insert();

CREATE OR REPLACE FUNCTION prevent_local_test_duration_evidence_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'HXDU3: local TEST duration evidence is append-only' USING ERRCODE='P0001';
END;
$$;

CREATE TRIGGER hxos_local_test_duration_immutable
BEFORE UPDATE OR DELETE ON hxos_local_test_duration_evidence
FOR EACH ROW EXECUTE FUNCTION prevent_local_test_duration_evidence_mutation();
CREATE TRIGGER hxos_local_test_duration_truncate_guard
BEFORE TRUNCATE ON hxos_local_test_duration_evidence
FOR EACH STATEMENT EXECUTE FUNCTION prevent_local_test_duration_evidence_mutation();

CREATE OR REPLACE FUNCTION enforce_local_test_task_duration_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.automation_classification='CONTROLLED_TEST'
     AND NEW.estimated_duration_minutes IS DISTINCT FROM OLD.estimated_duration_minutes THEN
    IF (current_setting('hustlexp.local_test_duration_enabled',TRUE)='true') IS NOT TRUE THEN
      RAISE EXCEPTION 'HXDU4: controlled TEST duration update requires explicit authority' USING ERRCODE='P0001';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM hxos_local_test_duration_evidence evidence
      WHERE evidence.task_id=NEW.id
        AND evidence.duration_expected_minutes=NEW.estimated_duration_minutes
        AND evidence.prior_duration_minutes IS NOT DISTINCT FROM OLD.estimated_duration_minutes
        AND evidence.environment='CONTROLLED_TEST'
        AND evidence.source_environment='TEST'
        AND evidence.is_test IS TRUE
    ) THEN
      RAISE EXCEPTION 'HXDU5: controlled TEST task duration lacks matching evidence' USING ERRCODE='P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER controlled_test_task_duration_guard
BEFORE UPDATE OF estimated_duration_minutes ON tasks
FOR EACH ROW EXECUTE FUNCTION enforce_local_test_task_duration_update();

COMMENT ON TABLE hxos_local_test_duration_evidence IS
  'Append-only local certification evidence linking one controlled TEST task duration to one immutable site quote version. Never production proof.';

COMMIT;
