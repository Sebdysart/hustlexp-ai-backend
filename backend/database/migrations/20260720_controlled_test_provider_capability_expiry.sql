-- Repair already-migrated databases so engine capability never outlives the
-- immutable site evidence from which it was derived.

BEGIN;

ALTER TABLE hxos_local_test_provider_capability_evidence
  ADD COLUMN IF NOT EXISTS source_expires_at TIMESTAMPTZ;

UPDATE hxos_local_test_provider_capability_evidence
SET source_expires_at=expires_at
WHERE source_expires_at IS NULL;

ALTER TABLE hxos_local_test_provider_capability_evidence
  ALTER COLUMN source_expires_at SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='hxos_local_test_provider_capability_evidence'::regclass
      AND conname='hxos_local_test_provider_capability_source_expiry_ck'
  ) THEN
    ALTER TABLE hxos_local_test_provider_capability_evidence
      ADD CONSTRAINT hxos_local_test_provider_capability_source_expiry_ck
      CHECK (expires_at=source_expires_at);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='hxos_local_test_provider_capability_evidence'::regclass
      AND conname='hxos_local_test_provider_capability_source_horizon_ck'
  ) THEN
    ALTER TABLE hxos_local_test_provider_capability_evidence
      ADD CONSTRAINT hxos_local_test_provider_capability_source_horizon_ck
      CHECK (source_expires_at<=created_at+INTERVAL '4 hours');
  END IF;
END
$$;

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
     OR NEW.environment<>'CONTROLLED_TEST' OR NEW.is_test IS NOT TRUE THEN
    RAISE EXCEPTION 'HXPC2: provider capability does not match the controlled TEST task, worker, or source expiry' USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON COLUMN hxos_local_test_provider_capability_evidence.source_expires_at IS
  'Exact immutable site evidence expiry; engine capability may never extend it.';

COMMIT;
