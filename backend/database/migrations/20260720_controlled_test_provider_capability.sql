-- A TEST provider counts toward task liquidity only when the site-originated
-- category, tools, and service-zone claim is explicitly bound and current.

BEGIN;

CREATE TABLE IF NOT EXISTS hxos_local_test_provider_capability_evidence (
  id UUID PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  worker_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  source_hustler_id UUID NOT NULL,
  category TEXT NOT NULL CHECK (category ~ '^[a-z0-9][a-z0-9_-]{0,99}$'),
  tools TEXT[] NOT NULL CHECK (cardinality(tools) BETWEEN 1 AND 20),
  service_city TEXT NOT NULL CHECK (char_length(service_city) BETWEEN 2 AND 100),
  service_state CHAR(2) NOT NULL CHECK (service_state ~ '^[A-Z]{2}$'),
  service_radius_miles INTEGER NOT NULL CHECK (service_radius_miles BETWEEN 1 AND 100),
  source_policy_version TEXT NOT NULL CHECK (char_length(source_policy_version) BETWEEN 1 AND 100),
  source_evidence_hash CHAR(64) NOT NULL CHECK (source_evidence_hash ~ '^[a-f0-9]{64}$'),
  source_expires_at TIMESTAMPTZ NOT NULL,
  request_hash CHAR(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  attestation_hash CHAR(64) NOT NULL CHECK (attestation_hash ~ '^[a-f0-9]{64}$'),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  actor_id TEXT NOT NULL CHECK (char_length(actor_id) BETWEEN 1 AND 128),
  environment TEXT NOT NULL CHECK (environment='CONTROLLED_TEST'),
  is_test BOOLEAN NOT NULL CHECK (is_test IS TRUE),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (expires_at=source_expires_at),
  CHECK (source_expires_at<=created_at+INTERVAL '4 hours')
);

CREATE INDEX IF NOT EXISTS hxos_local_test_provider_capability_task_worker_idx
  ON hxos_local_test_provider_capability_evidence(task_id,worker_id,created_at DESC);

CREATE OR REPLACE FUNCTION enforce_local_test_provider_capability_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_task tasks%ROWTYPE;
  v_profile capability_profiles%ROWTYPE;
  v_worker users%ROWTYPE;
BEGIN
  IF (current_setting('hustlexp.local_test_provider_capability_enabled',TRUE)='true') IS NOT TRUE THEN
    RAISE EXCEPTION 'HXPC1: local TEST provider-capability authority is required' USING ERRCODE='P0001';
  END IF;
  SELECT * INTO v_task FROM tasks WHERE id=NEW.task_id FOR SHARE;
  SELECT * INTO v_worker FROM users WHERE id=NEW.worker_id FOR SHARE;
  SELECT * INTO v_profile FROM capability_profiles WHERE user_id=NEW.worker_id FOR SHARE;
  IF v_task.id IS NULL OR v_worker.id IS NULL OR v_profile.user_id IS NULL
     OR v_task.automation_classification<>'CONTROLLED_TEST'
     OR v_task.state NOT IN ('OPEN','MATCHING') OR v_task.worker_id IS NOT NULL
     OR v_task.category<>NEW.category
     OR v_task.region_code<>('US-'||NEW.service_state)
     OR position(lower(NEW.service_city) in lower(coalesce(v_task.rough_location,'')))=0
     OR v_worker.default_mode<>'worker' OR v_worker.account_status<>'ACTIVE'
     OR v_worker.is_minor OR coalesce(v_worker.is_banned,FALSE)
     OR lower(v_profile.location_city)<>lower(NEW.service_city)
     OR v_profile.location_state<>NEW.service_state
     OR NEW.source_expires_at<=clock_timestamp()
     OR NEW.source_expires_at>clock_timestamp()+INTERVAL '4 hours'
     OR NEW.expires_at IS DISTINCT FROM NEW.source_expires_at
     OR NEW.expires_at<=clock_timestamp()
     OR NEW.environment<>'CONTROLLED_TEST' OR NEW.is_test IS NOT TRUE THEN
    RAISE EXCEPTION 'HXPC2: provider capability does not match the controlled TEST task and worker' USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER hxos_local_test_provider_capability_insert_guard
BEFORE INSERT ON hxos_local_test_provider_capability_evidence
FOR EACH ROW EXECUTE FUNCTION enforce_local_test_provider_capability_insert();

CREATE OR REPLACE FUNCTION prevent_local_test_provider_capability_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'HXPC3: local TEST provider capability evidence is append-only' USING ERRCODE='P0001';
END;
$$;

CREATE TRIGGER hxos_local_test_provider_capability_immutable
BEFORE UPDATE OR DELETE ON hxos_local_test_provider_capability_evidence
FOR EACH ROW EXECUTE FUNCTION prevent_local_test_provider_capability_mutation();
CREATE TRIGGER hxos_local_test_provider_capability_truncate_guard
BEFORE TRUNCATE ON hxos_local_test_provider_capability_evidence
FOR EACH STATEMENT EXECUTE FUNCTION prevent_local_test_provider_capability_mutation();

ALTER TABLE hxos_local_test_liquidity_witnesses
  ADD COLUMN IF NOT EXISTS provider_capability_evidence_id UUID
  REFERENCES hxos_local_test_provider_capability_evidence(id) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION hxos_local_test_provider_capability_current(
  p_task_id UUID,p_worker_id UUID,p_evidence_id UUID
) RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
  SELECT EXISTS (
    SELECT 1
    FROM hxos_local_test_provider_capability_evidence evidence
    JOIN tasks task ON task.id=evidence.task_id
    JOIN capability_profiles profile ON profile.user_id=evidence.worker_id
    WHERE evidence.id=p_evidence_id
      AND evidence.task_id=p_task_id
      AND evidence.worker_id=p_worker_id
      AND evidence.category=task.category
      AND evidence.environment='CONTROLLED_TEST'
      AND evidence.is_test IS TRUE
      AND evidence.expires_at>clock_timestamp()
      AND task.automation_classification='CONTROLLED_TEST'
      AND task.state IN ('OPEN','MATCHING')
      AND task.worker_id IS NULL
      AND lower(profile.location_city)=lower(evidence.service_city)
      AND profile.location_state=evidence.service_state
  )
$$;

CREATE OR REPLACE FUNCTION enforce_local_test_liquidity_capability_link()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.provider_capability_evidence_id IS NULL
     OR NOT hxos_local_test_provider_capability_current(
       NEW.task_id,NEW.worker_id,NEW.provider_capability_evidence_id
     ) THEN
    RAISE EXCEPTION 'HXPC4: liquidity witness lacks current exact-task provider capability' USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER hxos_local_test_liquidity_capability_guard
BEFORE INSERT ON hxos_local_test_liquidity_witnesses
FOR EACH ROW EXECUTE FUNCTION enforce_local_test_liquidity_capability_link();

CREATE OR REPLACE FUNCTION hxos_local_test_liquidity_witness_current_v2(
  p_task_id UUID,p_worker_id UUID,p_cell_id UUID
) RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
  SELECT hxos_local_test_liquidity_witness_current(p_task_id,p_worker_id,p_cell_id)
    AND EXISTS (
      SELECT 1 FROM hxos_local_test_liquidity_witnesses witness
      WHERE witness.task_id=p_task_id AND witness.worker_id=p_worker_id
        AND witness.cell_id=p_cell_id
        AND witness.created_at>=clock_timestamp()-INTERVAL '15 minutes'
        AND witness.provider_capability_evidence_id IS NOT NULL
        AND hxos_local_test_provider_capability_current(
          witness.task_id,witness.worker_id,witness.provider_capability_evidence_id
        )
    )
$$;

CREATE OR REPLACE FUNCTION enforce_controlled_test_provider_capability_on_accept()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state='ACCEPTED' AND NEW.automation_classification='CONTROLLED_TEST'
     AND (TG_OP='INSERT' OR OLD.state IS DISTINCT FROM NEW.state OR OLD.worker_id IS DISTINCT FROM NEW.worker_id) THEN
    IF NEW.worker_id IS NULL OR NEW.liquidity_cell_id IS NULL
       OR NOT hxos_local_test_liquidity_witness_current_v2(NEW.id,NEW.worker_id,NEW.liquidity_cell_id) THEN
      RAISE EXCEPTION 'HXPC5: controlled TEST acceptance lacks capability-bound liquidity' USING ERRCODE='P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER controlled_test_provider_capability_accept_guard
BEFORE INSERT OR UPDATE OF state,worker_id ON tasks
FOR EACH ROW EXECUTE FUNCTION enforce_controlled_test_provider_capability_on_accept();

COMMENT ON TABLE hxos_local_test_provider_capability_evidence IS
  'Append-only site-originated category, tools, and service-zone evidence for one provider and one controlled TEST task. Never production capability proof.';

COMMIT;
