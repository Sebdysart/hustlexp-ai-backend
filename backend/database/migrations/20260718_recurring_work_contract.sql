-- HustleXP recurring work contract v2.
-- Authority: supplied E2E specification §§8B and 9.
-- Legacy calendar-series rows remain readable as contract_version=1. Only v2
-- templates may activate through the controlled orchestration rail.

BEGIN;

CREATE TABLE IF NOT EXISTS recurring_task_series (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  poster_id UUID NOT NULL REFERENCES users(id),
  template_task_id UUID REFERENCES tasks(id),
  pattern TEXT NOT NULL CHECK (pattern IN ('daily','weekly','biweekly','monthly')),
  day_of_week INTEGER CHECK (day_of_week BETWEEN 1 AND 7),
  day_of_month INTEGER CHECK (day_of_month BETWEEN 1 AND 28),
  time_of_day TEXT,
  start_date DATE NOT NULL,
  end_date DATE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  payment_cents INTEGER NOT NULL CHECK (payment_cents >= 500),
  location TEXT,
  category TEXT,
  estimated_duration TEXT,
  required_tier INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','completed','cancelled')),
  occurrence_count INTEGER NOT NULL DEFAULT 0,
  completed_count INTEGER NOT NULL DEFAULT 0,
  preferred_worker_id UUID REFERENCES users(id),
  next_occurrence_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE recurring_task_series
  ADD COLUMN IF NOT EXISTS contract_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS client_principal_type TEXT,
  ADD COLUMN IF NOT EXISTS client_principal_id UUID,
  ADD COLUMN IF NOT EXISTS template_lineage_id UUID,
  ADD COLUMN IF NOT EXISTS region_code TEXT,
  ADD COLUMN IF NOT EXISTS risk_level TEXT,
  ADD COLUMN IF NOT EXISTS rough_location TEXT,
  ADD COLUMN IF NOT EXISTS location_ciphertext TEXT,
  ADD COLUMN IF NOT EXISTS location_nonce TEXT,
  ADD COLUMN IF NOT EXISTS location_auth_tag TEXT,
  ADD COLUMN IF NOT EXISTS location_key_id TEXT,
  ADD COLUMN IF NOT EXISTS location_fingerprint TEXT,
  ADD COLUMN IF NOT EXISTS access_ciphertext TEXT,
  ADD COLUMN IF NOT EXISTS access_nonce TEXT,
  ADD COLUMN IF NOT EXISTS access_auth_tag TEXT,
  ADD COLUMN IF NOT EXISTS access_key_id TEXT,
  ADD COLUMN IF NOT EXISTS access_fingerprint TEXT,
  ADD COLUMN IF NOT EXISTS task_recipe JSONB,
  ADD COLUMN IF NOT EXISTS timezone TEXT,
  ADD COLUMN IF NOT EXISTS service_window_start TIME,
  ADD COLUMN IF NOT EXISTS service_window_end TIME,
  ADD COLUMN IF NOT EXISTS expected_duration_minutes INTEGER,
  ADD COLUMN IF NOT EXISTS corridor_minimum_cents INTEGER,
  ADD COLUMN IF NOT EXISTS corridor_maximum_cents INTEGER,
  ADD COLUMN IF NOT EXISTS maximum_adjustment_cents INTEGER,
  ADD COLUMN IF NOT EXISTS provider_payout_cents INTEGER,
  ADD COLUMN IF NOT EXISTS platform_margin_cents INTEGER,
  ADD COLUMN IF NOT EXISTS license_requirements JSONB,
  ADD COLUMN IF NOT EXISTS insurance_requirements JSONB,
  ADD COLUMN IF NOT EXISTS credentials_valid_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS required_tools TEXT[],
  ADD COLUMN IF NOT EXISTS required_vehicle TEXT,
  ADD COLUMN IF NOT EXISTS completion_checklist JSONB,
  ADD COLUMN IF NOT EXISTS backup_worker_ids UUID[],
  ADD COLUMN IF NOT EXISTS cancellation_rules JSONB,
  ADD COLUMN IF NOT EXISTS holiday_rules JSONB,
  ADD COLUMN IF NOT EXISTS budget_cap_cents INTEGER,
  ADD COLUMN IF NOT EXISTS budget_spend_cents INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS approver_id UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS escalation_rules JSONB,
  ADD COLUMN IF NOT EXISTS invoice_grouping JSONB,
  ADD COLUMN IF NOT EXISTS next_review_date DATE,
  ADD COLUMN IF NOT EXISTS pause_code TEXT,
  ADD COLUMN IF NOT EXISTS pause_metadata JSONB,
  ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS paused_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS recovery_revision INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS repeated_corridor_breach_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS repeated_provider_failure_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS failed_fulfillment_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS location_closed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS open_dispute_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS material_scope_change BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS successful_instance_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS automation_mode TEXT NOT NULL DEFAULT 'SUPERVISED';

CREATE TABLE IF NOT EXISTS recurring_task_template_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id UUID NOT NULL REFERENCES recurring_task_series(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version > 0),
  previous_revision_id UUID REFERENCES recurring_task_template_revisions(id) ON DELETE RESTRICT,
  snapshot JSONB NOT NULL,
  snapshot_hash TEXT NOT NULL CHECK (snapshot_hash ~ '^[a-f0-9]{64}$'),
  change_reason TEXT NOT NULL,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (template_id, version),
  UNIQUE (template_id, snapshot_hash)
);

ALTER TABLE recurring_task_series ADD COLUMN IF NOT EXISTS current_revision_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'recurring_series_current_revision_fk'
  ) THEN
    ALTER TABLE recurring_task_series
      ADD CONSTRAINT recurring_series_current_revision_fk
      FOREIGN KEY (current_revision_id) REFERENCES recurring_task_template_revisions(id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS recurring_task_occurrences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  series_id UUID NOT NULL REFERENCES recurring_task_series(id) ON DELETE RESTRICT,
  task_id UUID REFERENCES tasks(id),
  occurrence_number INTEGER NOT NULL,
  scheduled_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled','posted','in_progress','completed','skipped','cancelled')),
  worker_id UUID REFERENCES users(id),
  completed_at TIMESTAMPTZ,
  rating INTEGER CHECK (rating BETWEEN 1 AND 5),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (series_id, occurrence_number)
);

ALTER TABLE recurring_task_occurrences
  ADD COLUMN IF NOT EXISTS template_revision_id UUID REFERENCES recurring_task_template_revisions(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS scheduled_start TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS scheduled_end TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS customer_total_cents INTEGER,
  ADD COLUMN IF NOT EXISTS provider_payout_cents INTEGER,
  ADD COLUMN IF NOT EXISTS platform_margin_cents INTEGER,
  ADD COLUMN IF NOT EXISTS reservation_state TEXT NOT NULL DEFAULT 'NOT_STARTED',
  ADD COLUMN IF NOT EXISTS generation_key TEXT,
  ADD COLUMN IF NOT EXISTS generation_attempted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE UNIQUE INDEX IF NOT EXISTS recurring_occurrence_task_unique
  ON recurring_task_occurrences(task_id) WHERE task_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS recurring_occurrence_schedule_unique
  ON recurring_task_occurrences(series_id, scheduled_date);
CREATE UNIQUE INDEX IF NOT EXISTS recurring_occurrence_generation_key_unique
  ON recurring_task_occurrences(generation_key) WHERE generation_key IS NOT NULL;

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS parent_series_id UUID REFERENCES recurring_task_series(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS occurrence_number INTEGER,
  ADD COLUMN IF NOT EXISTS recurring_template_revision_id UUID REFERENCES recurring_task_template_revisions(id) ON DELETE RESTRICT;

CREATE TABLE IF NOT EXISTS recurring_provider_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  occurrence_id UUID NOT NULL REFERENCES recurring_task_occurrences(id) ON DELETE RESTRICT,
  worker_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  pool_type TEXT NOT NULL CHECK (pool_type IN ('PREFERRED','BACKUP')),
  wave_rank INTEGER NOT NULL CHECK (wave_rank >= 0),
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','ACCEPTED','DECLINED','TIMED_OUT','CANCELLED')),
  offered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  responded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (occurrence_id, worker_id)
);

CREATE TABLE IF NOT EXISTS recurring_template_pause_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id UUID NOT NULL REFERENCES recurring_task_series(id) ON DELETE RESTRICT,
  pause_code TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS recurring_template_recovery_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id UUID NOT NULL REFERENCES recurring_task_series(id) ON DELETE RESTRICT,
  recovery_revision INTEGER NOT NULL,
  reason TEXT NOT NULL,
  evidence JSONB NOT NULL,
  actor_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (template_id, recovery_revision)
);

CREATE TABLE IF NOT EXISTS recurring_schedule_exceptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id UUID NOT NULL REFERENCES recurring_task_series(id) ON DELETE RESTRICT,
  template_revision_id UUID NOT NULL
    REFERENCES recurring_task_template_revisions(id) ON DELETE RESTRICT,
  scheduled_start TIMESTAMPTZ NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('BLACKOUT_DATE','END_DATE_REACHED')),
  generation_key TEXT NOT NULL UNIQUE,
  evidence JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION prevent_recurring_audit_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'recurring contract audit rows are append-only';
END $$;

DROP TRIGGER IF EXISTS recurring_revision_immutable ON recurring_task_template_revisions;
CREATE TRIGGER recurring_revision_immutable BEFORE UPDATE OR DELETE ON recurring_task_template_revisions
FOR EACH ROW EXECUTE FUNCTION prevent_recurring_audit_mutation();
DROP TRIGGER IF EXISTS recurring_pause_event_immutable ON recurring_template_pause_events;
CREATE TRIGGER recurring_pause_event_immutable BEFORE UPDATE OR DELETE ON recurring_template_pause_events
FOR EACH ROW EXECUTE FUNCTION prevent_recurring_audit_mutation();
DROP TRIGGER IF EXISTS recurring_recovery_event_immutable ON recurring_template_recovery_events;
CREATE TRIGGER recurring_recovery_event_immutable BEFORE UPDATE OR DELETE ON recurring_template_recovery_events
FOR EACH ROW EXECUTE FUNCTION prevent_recurring_audit_mutation();
DROP TRIGGER IF EXISTS recurring_schedule_exception_immutable ON recurring_schedule_exceptions;
CREATE TRIGGER recurring_schedule_exception_immutable BEFORE UPDATE OR DELETE ON recurring_schedule_exceptions
FOR EACH ROW EXECUTE FUNCTION prevent_recurring_audit_mutation();

CREATE OR REPLACE FUNCTION enforce_recurring_v2_template_complete()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.contract_version < 2 THEN RETURN NEW; END IF;
  IF NEW.status = 'active' AND (
    NEW.client_principal_type NOT IN ('HOUSEHOLD','ORGANIZATION') OR
    NEW.client_principal_id IS NULL OR NEW.template_lineage_id IS NULL OR
    NEW.current_revision_id IS NULL OR NEW.region_code IS NULL OR NEW.risk_level IS NULL OR NEW.rough_location IS NULL OR
    NEW.location_ciphertext IS NULL OR NEW.access_ciphertext IS NULL OR
    NEW.task_recipe IS NULL OR NEW.timezone IS NULL OR NEW.service_window_start IS NULL OR
    NEW.service_window_end IS NULL OR NEW.expected_duration_minutes IS NULL OR
    NEW.corridor_minimum_cents IS NULL OR NEW.corridor_maximum_cents IS NULL OR
    NEW.maximum_adjustment_cents IS NULL OR NEW.provider_payout_cents IS NULL OR
    NEW.platform_margin_cents IS NULL OR NEW.license_requirements IS NULL OR
    NEW.insurance_requirements IS NULL OR NEW.required_tools IS NULL OR
    NEW.completion_checklist IS NULL OR NEW.backup_worker_ids IS NULL OR
    NEW.cancellation_rules IS NULL OR NEW.holiday_rules IS NULL OR
    NEW.budget_cap_cents IS NULL OR NEW.approver_id IS NULL OR
    NEW.escalation_rules IS NULL OR NEW.invoice_grouping IS NULL OR
    NEW.next_review_date IS NULL OR NEW.next_occurrence_at IS NULL
  ) THEN
    RAISE EXCEPTION 'HXREC1: controlled recurring template is incomplete';
  END IF;
  IF NEW.contract_version >= 2 AND (
    NEW.payment_cents < NEW.corridor_minimum_cents OR
    NEW.payment_cents > NEW.corridor_maximum_cents OR
    NEW.provider_payout_cents + NEW.platform_margin_cents <> NEW.payment_cents OR
    NEW.maximum_adjustment_cents > NEW.corridor_maximum_cents - NEW.corridor_minimum_cents OR
    NEW.budget_cap_cents < NEW.payment_cents OR
    NEW.service_window_end <= NEW.service_window_start
  ) THEN
    RAISE EXCEPTION 'HXREC2: controlled recurring economics or service window is invalid';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'paused' AND NEW.status = 'active'
     AND OLD.pause_code IS DISTINCT FROM 'ACTIVATION_PENDING'
     AND NEW.recovery_revision <= OLD.recovery_revision THEN
    RAISE EXCEPTION 'HXREC3: paused template requires an authorized recovery revision';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS recurring_v2_template_complete ON recurring_task_series;
CREATE TRIGGER recurring_v2_template_complete
BEFORE INSERT OR UPDATE ON recurring_task_series
FOR EACH ROW EXECUTE FUNCTION enforce_recurring_v2_template_complete();

CREATE OR REPLACE FUNCTION evaluate_recurring_template_safeguards(
  p_template_id UUID,
  p_projected_total_cents INTEGER,
  p_at TIMESTAMPTZ DEFAULT NOW()
) RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE r recurring_task_series%ROWTYPE;
BEGIN
  SELECT * INTO r FROM recurring_task_series WHERE id = p_template_id;
  IF NOT FOUND OR r.status <> 'active' THEN RETURN 'TEMPLATE_NOT_ACTIVE'; END IF;
  IF r.repeated_corridor_breach_count >= 2 OR p_projected_total_cents > r.corridor_maximum_cents
    THEN RETURN 'PRICE_CORRIDOR_REPEATED'; END IF;
  IF r.repeated_provider_failure_count >= 2 THEN RETURN 'PROVIDER_FAILURE_REPEATED'; END IF;
  IF r.budget_spend_cents + p_projected_total_cents > r.budget_cap_cents
    THEN RETURN 'BUDGET_WOULD_EXCEED'; END IF;
  IF (COALESCE(r.license_requirements, '{}'::jsonb) <> '{}'::jsonb OR
      COALESCE(r.insurance_requirements, '{}'::jsonb) <> '{}'::jsonb)
     AND (r.credentials_valid_until IS NULL OR r.credentials_valid_until <= p_at)
    THEN RETURN 'CREDENTIAL_EXPIRED'; END IF;
  IF r.location_closed_at IS NOT NULL THEN RETURN 'LOCATION_CLOSED'; END IF;
  IF r.open_dispute_count > 0 THEN RETURN 'RECENT_DISPUTE'; END IF;
  IF r.material_scope_change THEN RETURN 'MATERIAL_SCOPE_CHANGE'; END IF;
  IF r.failed_fulfillment_attempts >= 3 THEN RETURN 'FULFILLMENT_ATTEMPTS_EXHAUSTED'; END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION pause_recurring_template(
  p_template_id UUID,
  p_pause_code TEXT,
  p_evidence JSONB DEFAULT '{}'::jsonb,
  p_actor_id UUID DEFAULT NULL
) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE changed BOOLEAN;
BEGIN
  UPDATE recurring_task_series
  SET status='paused', pause_code=p_pause_code, pause_metadata=COALESCE(p_evidence,'{}'::jsonb),
      paused_at=NOW(), paused_by=p_actor_id, updated_at=NOW()
  WHERE id=p_template_id AND status='active';
  changed := FOUND;
  IF changed THEN
    INSERT INTO recurring_template_pause_events(template_id,pause_code,evidence,actor_id)
    VALUES (p_template_id,p_pause_code,COALESCE(p_evidence,'{}'::jsonb),p_actor_id);
  END IF;
  RETURN changed;
END $$;

CREATE OR REPLACE FUNCTION record_recurring_safeguard_signal(
  p_template_id UUID,
  p_signal TEXT,
  p_evidence JSONB DEFAULT '{}'::jsonb,
  p_actor_id UUID DEFAULT NULL
) RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE reason TEXT;
BEGIN
  UPDATE recurring_task_series SET
    repeated_corridor_breach_count = repeated_corridor_breach_count + CASE WHEN p_signal='PRICE_CORRIDOR_BREACH' THEN 1 ELSE 0 END,
    repeated_provider_failure_count = repeated_provider_failure_count + CASE WHEN p_signal='PROVIDER_FAILURE' THEN 1 ELSE 0 END,
    failed_fulfillment_attempts = failed_fulfillment_attempts + CASE WHEN p_signal='FULFILLMENT_FAILURE' THEN 1 ELSE 0 END,
    location_closed_at = CASE WHEN p_signal='LOCATION_CLOSED' THEN NOW() ELSE location_closed_at END,
    open_dispute_count = open_dispute_count + CASE WHEN p_signal='DISPUTE_OPENED' THEN 1 ELSE 0 END,
    material_scope_change = material_scope_change OR p_signal='MATERIAL_SCOPE_CHANGE',
    budget_spend_cents = budget_spend_cents + CASE WHEN p_signal='BUDGET_SPEND' THEN COALESCE((p_evidence->>'amount_cents')::INTEGER,0) ELSE 0 END,
    credentials_valid_until = CASE WHEN p_signal='CREDENTIAL_EXPIRY' THEN (p_evidence->>'valid_until')::TIMESTAMPTZ ELSE credentials_valid_until END,
    updated_at = NOW()
  WHERE id=p_template_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'HXREC4: recurring template not found'; END IF;

  reason := evaluate_recurring_template_safeguards(
    p_template_id,
    COALESCE((p_evidence->>'projected_total_cents')::INTEGER,
      (SELECT payment_cents FROM recurring_task_series WHERE id=p_template_id)),
    NOW()
  );
  IF reason IS NOT NULL AND reason <> 'TEMPLATE_NOT_ACTIVE' THEN
    PERFORM pause_recurring_template(p_template_id,reason,p_evidence,p_actor_id);
  END IF;
  RETURN reason;
END $$;

CREATE OR REPLACE FUNCTION recover_recurring_template(
  p_template_id UUID,
  p_actor_id UUID,
  p_reason TEXT,
  p_evidence JSONB
) RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE r recurring_task_series%ROWTYPE; next_revision INTEGER;
BEGIN
  IF p_actor_id IS NULL OR length(trim(COALESCE(p_reason,''))) < 10 OR p_evidence IS NULL THEN
    RAISE EXCEPTION 'HXREC5: recovery requires actor, reason, and evidence';
  END IF;
  SELECT * INTO r FROM recurring_task_series WHERE id=p_template_id FOR UPDATE;
  IF NOT FOUND OR r.status <> 'paused' OR r.pause_code IS NULL THEN
    RAISE EXCEPTION 'HXREC6: only a paused template can be recovered';
  END IF;

  IF r.repeated_corridor_breach_count > 0 OR r.repeated_provider_failure_count > 0 OR
     r.failed_fulfillment_attempts > 0 OR r.location_closed_at IS NOT NULL OR
     r.open_dispute_count > 0 OR r.material_scope_change OR
     r.budget_spend_cents + r.payment_cents > r.budget_cap_cents OR
     ((COALESCE(r.license_requirements,'{}'::jsonb) <> '{}'::jsonb OR
       COALESCE(r.insurance_requirements,'{}'::jsonb) <> '{}'::jsonb) AND
       (r.credentials_valid_until IS NULL OR r.credentials_valid_until <= NOW())) THEN
    RAISE EXCEPTION 'HXREC7: recovery conditions remain unresolved';
  END IF;
  IF COALESCE((p_evidence->>'conditions_resolved')::BOOLEAN,FALSE) IS NOT TRUE THEN
    RAISE EXCEPTION 'HXREC8: recovery evidence must affirm resolved conditions';
  END IF;

  next_revision := r.recovery_revision + 1;
  UPDATE recurring_task_series SET status='active', pause_code=NULL, pause_metadata=NULL,
    paused_at=NULL, paused_by=NULL, recovery_revision=next_revision,
    repeated_corridor_breach_count=0, repeated_provider_failure_count=0,
    failed_fulfillment_attempts=0, updated_at=NOW()
  WHERE id=p_template_id;
  INSERT INTO recurring_template_recovery_events(template_id,recovery_revision,reason,evidence,actor_id)
  VALUES (p_template_id,next_revision,p_reason,p_evidence,p_actor_id);
  RETURN next_revision;
END $$;

CREATE OR REPLACE FUNCTION enforce_recurring_occurrence_generation_gate()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE reason TEXT;
BEGIN
  reason := evaluate_recurring_template_safeguards(NEW.series_id,NEW.customer_total_cents,NOW());
  IF reason IS NOT NULL THEN
    RAISE EXCEPTION 'HXREC9: recurring occurrence generation blocked: %', reason;
  END IF;
  IF NEW.template_revision_id IS NULL OR NEW.task_id IS NULL OR NEW.generation_key IS NULL THEN
    RAISE EXCEPTION 'HXREC10: occurrence requires revision, task, and generation witness';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS recurring_occurrence_generation_gate ON recurring_task_occurrences;
CREATE TRIGGER recurring_occurrence_generation_gate
BEFORE INSERT ON recurring_task_occurrences
FOR EACH ROW EXECUTE FUNCTION enforce_recurring_occurrence_generation_gate();

CREATE OR REPLACE FUNCTION pause_recurring_on_task_dispute()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state='DISPUTED' AND OLD.state IS DISTINCT FROM 'DISPUTED' AND NEW.parent_series_id IS NOT NULL THEN
    UPDATE recurring_task_series SET open_dispute_count=open_dispute_count+1 WHERE id=NEW.parent_series_id;
    PERFORM pause_recurring_template(NEW.parent_series_id,'RECENT_DISPUTE',jsonb_build_object('task_id',NEW.id),NULL);
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS recurring_task_dispute_pause ON tasks;
CREATE TRIGGER recurring_task_dispute_pause AFTER UPDATE OF state ON tasks
FOR EACH ROW EXECUTE FUNCTION pause_recurring_on_task_dispute();

CREATE INDEX IF NOT EXISTS recurring_series_due_idx
  ON recurring_task_series(next_occurrence_at) WHERE contract_version >= 2 AND status='active';
CREATE INDEX IF NOT EXISTS recurring_reservation_due_idx
  ON recurring_provider_reservations(expires_at) WHERE status='PENDING';

REVOKE ALL ON FUNCTION public.evaluate_recurring_template_safeguards(UUID,INTEGER,TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pause_recurring_template(UUID,TEXT,JSONB,UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_recurring_safeguard_signal(UUID,TEXT,JSONB,UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.recover_recurring_template(UUID,UUID,TEXT,JSONB) FROM PUBLIC;

COMMIT;
