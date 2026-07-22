-- Worker screening is category-scoped, consent-bound, inspectable, disputable,
-- appealable, and neutral for ranking and categories that do not require it.

-- Fresh constitutional databases do not include the legacy capability tables.
-- Keep this contract self-contained so the required startup migration sequence
-- can be applied to both new databases and existing installations.
CREATE TABLE IF NOT EXISTS background_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT,
  status TEXT DEFAULT 'pending',
  result TEXT,
  expires_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE background_checks
  ADD COLUMN IF NOT EXISTS check_id TEXT,
  ADD COLUMN IF NOT EXISTS initiated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS result_summary TEXT,
  ADD COLUMN IF NOT EXISTS details JSONB,
  ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS notes TEXT;

UPDATE background_checks
SET status = UPPER(status),
    initiated_at = COALESCE(initiated_at, created_at, NOW()),
    result_summary = COALESCE(result_summary, result)
WHERE status IS DISTINCT FROM UPPER(status)
   OR initiated_at IS NULL
   OR (result_summary IS NULL AND result IS NOT NULL);

ALTER TABLE background_checks ALTER COLUMN status SET DEFAULT 'PENDING';
ALTER TABLE background_checks ALTER COLUMN initiated_at SET DEFAULT NOW();

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'background_checks_rights_status_check') THEN
    ALTER TABLE background_checks ADD CONSTRAINT background_checks_rights_status_check
      CHECK (status IN ('PENDING','IN_PROGRESS','CLEAR','CONSIDER','PRE_ADVERSE','DISPUTED','FAILED','EXPIRED'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS background_checks_provider_check_uidx
  ON background_checks(provider, check_id) WHERE check_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_background_checks_user_clear
  ON background_checks(user_id, expires_at DESC) WHERE status = 'CLEAR';

CREATE TABLE IF NOT EXISTS worker_screening_consents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL,
  disclosure_version TEXT NOT NULL,
  disclosure_hash CHAR(64) NOT NULL CHECK (disclosure_hash ~ '^[a-f0-9]{64}$'),
  policy_version TEXT NOT NULL,
  purpose TEXT NOT NULL,
  consent_granted BOOLEAN NOT NULL CHECK (consent_granted),
  disclosure_presented_standalone BOOLEAN NOT NULL CHECK (disclosure_presented_standalone),
  purpose_acknowledged BOOLEAN NOT NULL CHECK (purpose_acknowledged),
  rights_summary_acknowledged BOOLEAN NOT NULL CHECK (rights_summary_acknowledged),
  request_hash CHAR(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  idempotency_key TEXT NOT NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  UNIQUE (worker_id, idempotency_key)
);

ALTER TABLE background_checks
  ADD COLUMN IF NOT EXISTS screening_consent_id UUID REFERENCES worker_screening_consents(id) ON DELETE RESTRICT;

CREATE TABLE IF NOT EXISTS worker_screening_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  background_check_id UUID REFERENCES background_checks(id) ON DELETE RESTRICT,
  consent_id UUID REFERENCES worker_screening_consents(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'CONSENT_GRANTED','CONSENT_REVOKED','CHECK_INITIATED','REPORT_READY','REPORT_VIEWED',
    'PRE_ADVERSE_SENT','DISPUTE_OPENED','DISPUTE_RESOLVED','ADVERSE_SENT',
    'APPEAL_OPENED','APPEAL_RESOLVED','CHECK_CLEARED','CHECK_EXPIRED'
  )),
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  request_hash CHAR(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  idempotency_key TEXT NOT NULL,
  public_message TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (worker_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS worker_screening_notices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  background_check_id UUID NOT NULL REFERENCES background_checks(id) ON DELETE RESTRICT,
  worker_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  notice_type TEXT NOT NULL CHECK (notice_type IN ('PRE_ADVERSE','FINAL_ADVERSE')),
  reason_codes TEXT[] NOT NULL CHECK (cardinality(reason_codes) > 0),
  provider_name TEXT NOT NULL,
  provider_address TEXT NOT NULL,
  provider_phone TEXT NOT NULL,
  provider_decision_disclaimer TEXT NOT NULL,
  report_access_path TEXT NOT NULL,
  rights_summary_version TEXT NOT NULL,
  dispute_instructions TEXT NOT NULL,
  free_report_deadline_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ NOT NULL,
  final_action_eligible_at TIMESTAMPTZ,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (background_check_id, notice_type)
);

CREATE TABLE IF NOT EXISTS worker_screening_disputes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  background_check_id UUID NOT NULL REFERENCES background_checks(id) ON DELETE RESTRICT,
  worker_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 10 AND 4000),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CORRECTED','UPHELD','CLOSED')),
  resolution_note TEXT,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolved_by UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS worker_screening_disputes_one_open_idx
  ON worker_screening_disputes(background_check_id) WHERE status = 'OPEN';

CREATE TABLE IF NOT EXISTS worker_screening_appeals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  background_check_id UUID NOT NULL REFERENCES background_checks(id) ON DELETE RESTRICT,
  worker_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 10 AND 4000),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','OVERTURNED','UPHELD')),
  resolution_note TEXT,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolved_by UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS worker_screening_appeals_one_open_idx
  ON worker_screening_appeals(background_check_id) WHERE status = 'OPEN';

CREATE OR REPLACE FUNCTION prevent_worker_screening_audit_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'HXWS1: worker screening audit records are append-only' USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS worker_screening_events_immutable ON worker_screening_events;
CREATE TRIGGER worker_screening_events_immutable
BEFORE UPDATE OR DELETE ON worker_screening_events
FOR EACH ROW EXECUTE FUNCTION prevent_worker_screening_audit_mutation();

DROP TRIGGER IF EXISTS worker_screening_notices_immutable ON worker_screening_notices;
CREATE TRIGGER worker_screening_notices_immutable
BEFORE UPDATE OR DELETE ON worker_screening_notices
FOR EACH ROW EXECUTE FUNCTION prevent_worker_screening_audit_mutation();

CREATE OR REPLACE FUNCTION enforce_worker_screening_consent()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_consent worker_screening_consents%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN RETURN NEW; END IF;
  IF NEW.screening_consent_id IS NULL THEN
    RAISE EXCEPTION 'HXWS2: a new screening check requires explicit consent' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_consent FROM worker_screening_consents WHERE id = NEW.screening_consent_id FOR SHARE;
  IF NOT FOUND OR v_consent.worker_id <> NEW.user_id OR v_consent.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'HXWS3: screening consent is invalid, revoked, or belongs to another worker' USING ERRCODE = 'P0001';
  END IF;
  IF v_consent.provider <> NEW.provider OR v_consent.disclosure_version <> 'hx-worker-screening-rights-v1' THEN
    RAISE EXCEPTION 'HXWS4: screening provider or disclosure does not match consent' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS worker_screening_consent_gate ON background_checks;
CREATE TRIGGER worker_screening_consent_gate
BEFORE INSERT ON background_checks
FOR EACH ROW EXECUTE FUNCTION enforce_worker_screening_consent();

CREATE OR REPLACE FUNCTION enforce_worker_screening_adverse_action()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'FAILED' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'FAILED' THEN RETURN NEW; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM worker_screening_notices n
    WHERE n.background_check_id = NEW.id
      AND n.notice_type = 'PRE_ADVERSE'
      AND n.delivered_at IS NOT NULL
      AND n.report_access_path <> ''
      AND n.final_action_eligible_at <= NOW()
  ) THEN
    RAISE EXCEPTION 'HXWS5: final adverse action requires delivered report, rights notice, and elapsed review window' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM worker_screening_disputes d
    WHERE d.background_check_id = NEW.id AND d.status = 'OPEN'
  ) THEN
    RAISE EXCEPTION 'HXWS6: final adverse action is blocked while a dispute is open' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS worker_screening_adverse_gate ON background_checks;
CREATE TRIGGER worker_screening_adverse_gate
BEFORE UPDATE OF status ON background_checks
FOR EACH ROW EXECUTE FUNCTION enforce_worker_screening_adverse_action();
