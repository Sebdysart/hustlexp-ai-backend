-- Controlled local TEST screening exists only to exercise consent, trust,
-- eligibility, and audit state machines without claiming that a criminal-history
-- or consumer report was ordered. Production acceptance must reject this evidence.

ALTER TABLE background_checks
  ADD COLUMN IF NOT EXISTS provider_environment TEXT NOT NULL DEFAULT 'PRODUCTION',
  ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE background_checks
SET provider_environment = CASE
      WHEN provider = 'local_certification_test' THEN 'CONTROLLED_TEST'
      ELSE 'PRODUCTION'
    END,
    is_test = provider = 'local_certification_test';

ALTER TABLE background_checks
  DROP CONSTRAINT IF EXISTS background_checks_provider_environment_check;
ALTER TABLE background_checks
  ADD CONSTRAINT background_checks_provider_environment_check CHECK (
    (
      provider = 'local_certification_test'
      AND provider_environment = 'CONTROLLED_TEST'
      AND is_test IS TRUE
      AND check_id ~ '^scr_hxos_test_[a-f0-9]{32}$'
    )
    OR
    (
      provider IS DISTINCT FROM 'local_certification_test'
      AND provider_environment = 'PRODUCTION'
      AND is_test IS FALSE
      AND COALESCE(check_id, '') !~ '^scr_hxos_test_'
    )
  );

CREATE TABLE IF NOT EXISTS hxos_local_test_screening_reports (
  id TEXT PRIMARY KEY CHECK (id ~ '^scr_hxos_test_[a-f0-9]{32}$'),
  background_check_id UUID NOT NULL UNIQUE REFERENCES background_checks(id) ON DELETE RESTRICT,
  worker_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  consent_id UUID NOT NULL REFERENCES worker_screening_consents(id) ON DELETE RESTRICT,
  provider_mode TEXT NOT NULL DEFAULT 'local_certification_test'
    CHECK (provider_mode = 'local_certification_test'),
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','PROCESSING','CLEAR')),
  request_hash CHAR(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  idempotency_key TEXT NOT NULL,
  result_summary TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  is_test BOOLEAN NOT NULL DEFAULT TRUE CHECK (is_test IS TRUE),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (worker_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS hxos_local_test_screening_reports_worker_idx
  ON hxos_local_test_screening_reports(worker_id, status, expires_at DESC);

CREATE TABLE IF NOT EXISTS hxos_local_test_screening_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id TEXT NOT NULL REFERENCES hxos_local_test_screening_reports(id) ON DELETE RESTRICT,
  background_check_id UUID NOT NULL REFERENCES background_checks(id) ON DELETE RESTRICT,
  worker_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  from_status TEXT CHECK (from_status IS NULL OR from_status IN ('PENDING','PROCESSING','CLEAR')),
  to_status TEXT NOT NULL CHECK (to_status IN ('PENDING','PROCESSING','CLEAR')),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'report_requested','report_processing','report_cleared'
  )),
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION prevent_local_test_screening_event_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'HXLTS7: local TEST screening events are append-only' USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS local_test_screening_events_immutable ON hxos_local_test_screening_events;
CREATE TRIGGER local_test_screening_events_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON hxos_local_test_screening_events
FOR EACH STATEMENT EXECUTE FUNCTION prevent_local_test_screening_event_mutation();

DROP TRIGGER IF EXISTS local_test_screening_reports_no_delete ON hxos_local_test_screening_reports;
CREATE TRIGGER local_test_screening_reports_no_delete
BEFORE DELETE OR TRUNCATE ON hxos_local_test_screening_reports
FOR EACH STATEMENT EXECUTE FUNCTION prevent_local_test_screening_event_mutation();

CREATE OR REPLACE FUNCTION enforce_local_test_screening_consent_contract()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.provider = 'local_certification_test' THEN
    IF current_setting('hustlexp.local_test_screening_enabled', TRUE) IS DISTINCT FROM 'true' THEN
      RAISE EXCEPTION 'HXLTS1: local TEST screening consent requires transaction-local authority' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.disclosure_version <> 'hx-worker-screening-local-test-v1'
       OR NEW.disclosure_hash <> 'c059a2d7b341b9f951a97f9e28a93afe3f763015a0c7ffd8bd9f7f15ab2e8565'
       OR NEW.purpose <> 'Exercise consent-bound eligibility controls for CONTROLLED_TEST work only; no external background or consumer report is ordered.' THEN
      RAISE EXCEPTION 'HXLTS2: local TEST screening consent disclosure or purpose mismatch' USING ERRCODE = 'P0001';
    END IF;
  ELSIF NEW.disclosure_version = 'hx-worker-screening-local-test-v1' THEN
    RAISE EXCEPTION 'HXLTS3: TEST disclosure cannot authorize another provider' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS local_test_screening_consent_contract ON worker_screening_consents;
CREATE TRIGGER local_test_screening_consent_contract
BEFORE INSERT OR UPDATE OF provider, disclosure_version, disclosure_hash, purpose
ON worker_screening_consents
FOR EACH ROW EXECUTE FUNCTION enforce_local_test_screening_consent_contract();

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
  IF v_consent.provider <> NEW.provider THEN
    RAISE EXCEPTION 'HXWS4: screening provider or disclosure does not match consent' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.provider = 'local_certification_test' THEN
    IF v_consent.disclosure_version <> 'hx-worker-screening-local-test-v1'
       OR v_consent.disclosure_hash <> 'c059a2d7b341b9f951a97f9e28a93afe3f763015a0c7ffd8bd9f7f15ab2e8565' THEN
      RAISE EXCEPTION 'HXWS4: screening provider or disclosure does not match consent' USING ERRCODE = 'P0001';
    END IF;
  ELSIF v_consent.disclosure_version <> 'hx-worker-screening-rights-v1'
        OR v_consent.disclosure_hash <> '61d054648dabd5b3533337363e87f2a8c628c60878aff6c25f4d2a1fbf88df4f' THEN
    RAISE EXCEPTION 'HXWS4: screening provider or disclosure does not match consent' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_background_check_environment()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
       OLD.user_id IS DISTINCT FROM NEW.user_id
       OR OLD.provider IS DISTINCT FROM NEW.provider
       OR OLD.check_id IS DISTINCT FROM NEW.check_id
       OR OLD.screening_consent_id IS DISTINCT FROM NEW.screening_consent_id
       OR OLD.provider_environment IS DISTINCT FROM NEW.provider_environment
       OR OLD.is_test IS DISTINCT FROM NEW.is_test
     ) THEN
    RAISE EXCEPTION 'HXLTS4: screening provider identity and environment are immutable' USING ERRCODE = 'P0001';
  END IF;

  IF NEW.provider = 'local_certification_test' THEN
    IF NEW.provider_environment <> 'CONTROLLED_TEST'
       OR NEW.is_test IS NOT TRUE
       OR NEW.check_id !~ '^scr_hxos_test_[a-f0-9]{32}$' THEN
      RAISE EXCEPTION 'HXLTS5: local TEST screening provenance is invalid' USING ERRCODE = 'P0001';
    END IF;
    IF (TG_OP = 'INSERT' OR (NEW.status = 'CLEAR' AND OLD.status IS DISTINCT FROM 'CLEAR'))
       AND current_setting('hustlexp.local_test_screening_enabled', TRUE) IS DISTINCT FROM 'true' THEN
      RAISE EXCEPTION 'HXLTS6: local TEST screening mutation requires transaction-local authority' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.status = 'CLEAR'
       AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'CLEAR')
       AND NOT EXISTS (
         SELECT 1
         FROM hxos_local_test_screening_reports report
         WHERE report.background_check_id = NEW.id
           AND report.id = NEW.check_id
           AND report.worker_id = NEW.user_id
           AND report.consent_id = NEW.screening_consent_id
           AND report.status = 'CLEAR'
           AND report.is_test IS TRUE
           AND report.completed_at IS NOT NULL
       ) THEN
      RAISE EXCEPTION 'HXLTS8: local TEST screening CLEAR requires exact provider evidence' USING ERRCODE = 'P0001';
    END IF;
  ELSIF NEW.provider_environment <> 'PRODUCTION'
        OR NEW.is_test IS TRUE
        OR COALESCE(NEW.check_id, '') ~ '^scr_hxos_test_' THEN
    RAISE EXCEPTION 'HXLTS9: production provider cannot carry TEST provenance' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS background_check_environment_gate ON background_checks;
CREATE TRIGGER background_check_environment_gate
BEFORE INSERT OR UPDATE OF user_id, provider, check_id, status,
  screening_consent_id, provider_environment, is_test
ON background_checks
FOR EACH ROW EXECUTE FUNCTION enforce_background_check_environment();

CREATE OR REPLACE FUNCTION enforce_local_test_screening_report_integrity()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  background RECORD;
BEGIN
  IF current_setting('hustlexp.local_test_screening_enabled', TRUE) IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'HXLTS10: local TEST report mutation requires transaction-local authority' USING ERRCODE = 'P0001';
  END IF;
  SELECT b.id, b.user_id, b.screening_consent_id, b.provider,
         b.provider_environment, b.is_test, b.check_id
  INTO background
  FROM background_checks b
  WHERE b.id = NEW.background_check_id
  FOR SHARE;
  IF NOT FOUND
     OR background.user_id <> NEW.worker_id
     OR background.screening_consent_id <> NEW.consent_id
     OR background.provider <> 'local_certification_test'
     OR background.provider_environment <> 'CONTROLLED_TEST'
     OR background.is_test IS NOT TRUE
     OR background.check_id <> NEW.id
     OR NEW.provider_mode <> 'local_certification_test'
     OR NEW.is_test IS NOT TRUE THEN
    RAISE EXCEPTION 'HXLTS11: local TEST report does not match its canonical screening record' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.id IS DISTINCT FROM NEW.id
       OR OLD.background_check_id IS DISTINCT FROM NEW.background_check_id
       OR OLD.worker_id IS DISTINCT FROM NEW.worker_id
       OR OLD.consent_id IS DISTINCT FROM NEW.consent_id
       OR OLD.provider_mode IS DISTINCT FROM NEW.provider_mode
       OR OLD.request_hash IS DISTINCT FROM NEW.request_hash
       OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key
       OR OLD.expires_at IS DISTINCT FROM NEW.expires_at
       OR OLD.is_test IS DISTINCT FROM NEW.is_test THEN
      RAISE EXCEPTION 'HXLTS12: local TEST report identity and request evidence are immutable' USING ERRCODE = 'P0001';
    END IF;
    IF NOT (
      (OLD.status = 'PENDING' AND NEW.status = 'PROCESSING')
      OR (OLD.status = 'PROCESSING' AND NEW.status = 'CLEAR')
    ) THEN
      RAISE EXCEPTION 'HXLTS13: invalid local TEST screening transition' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF NEW.status = 'CLEAR'
     AND (NEW.completed_at IS NULL OR NULLIF(BTRIM(NEW.result_summary), '') IS NULL) THEN
    RAISE EXCEPTION 'HXLTS14: clear local TEST report requires completion evidence' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS local_test_screening_report_integrity ON hxos_local_test_screening_reports;
CREATE TRIGGER local_test_screening_report_integrity
BEFORE INSERT OR UPDATE ON hxos_local_test_screening_reports
FOR EACH ROW EXECUTE FUNCTION enforce_local_test_screening_report_integrity();

ALTER TABLE capability_profiles
  ADD COLUMN IF NOT EXISTS background_check_source_id UUID REFERENCES background_checks(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS background_check_provider TEXT,
  ADD COLUMN IF NOT EXISTS background_check_environment TEXT,
  ADD COLUMN IF NOT EXISTS background_check_is_test BOOLEAN NOT NULL DEFAULT FALSE;

WITH latest AS (
  SELECT DISTINCT ON (user_id)
    id, user_id, provider, provider_environment, is_test, expires_at
  FROM background_checks
  WHERE status = 'CLEAR' AND (expires_at IS NULL OR expires_at > NOW())
  ORDER BY user_id, is_test ASC, expires_at DESC NULLS LAST, initiated_at DESC
)
UPDATE capability_profiles profile
SET background_check_valid = TRUE,
    background_check_expires_at = latest.expires_at,
    background_check_source_id = latest.id,
    background_check_provider = latest.provider,
    background_check_environment = latest.provider_environment,
    background_check_is_test = latest.is_test
FROM latest
WHERE profile.user_id = latest.user_id;

UPDATE capability_profiles profile
SET background_check_valid = FALSE,
    background_check_expires_at = NULL,
    background_check_source_id = NULL,
    background_check_provider = NULL,
    background_check_environment = NULL,
    background_check_is_test = FALSE
WHERE profile.background_check_valid IS TRUE
  AND profile.background_check_source_id IS NULL;

ALTER TABLE capability_profiles
  DROP CONSTRAINT IF EXISTS capability_profiles_background_provenance_check;
ALTER TABLE capability_profiles
  ADD CONSTRAINT capability_profiles_background_provenance_check CHECK (
    (
      background_check_valid IS FALSE
      AND background_check_source_id IS NULL
      AND background_check_provider IS NULL
      AND background_check_environment IS NULL
      AND background_check_is_test IS FALSE
    )
    OR
    (
      background_check_valid IS TRUE
      AND background_check_source_id IS NOT NULL
      AND background_check_provider IS NOT NULL
      AND background_check_environment IN ('PRODUCTION','CONTROLLED_TEST')
      AND (
        (background_check_is_test IS FALSE AND background_check_environment = 'PRODUCTION')
        OR
        (background_check_is_test IS TRUE
          AND background_check_environment = 'CONTROLLED_TEST'
          AND background_check_provider = 'local_certification_test')
      )
    )
  );

-- Repair the region policy gate so a clear TEST fixture is never accepted as a
-- production background report.
CREATE OR REPLACE FUNCTION enforce_task_region_policy_on_accept()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_local_test_screening BOOLEAN;
BEGIN
  IF NEW.state <> 'ACCEPTED'
     OR (TG_OP = 'UPDATE' AND OLD.state = 'ACCEPTED' AND OLD.worker_id IS NOT DISTINCT FROM NEW.worker_id) THEN
    RETURN NEW;
  END IF;
  IF NEW.region_policy_id IS NULL OR NEW.region_policy_snapshot IS NULL THEN
    RAISE EXCEPTION 'HXRP17: accepted task has no region policy binding' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.worker_id IS NULL THEN
    RAISE EXCEPTION 'HXRP18: accepted task requires a worker' USING ERRCODE = 'P0001';
  END IF;

  v_local_test_screening := NEW.automation_classification = 'CONTROLLED_TEST'
    AND current_setting('hustlexp.local_test_screening_enabled', TRUE) = 'true';

  IF NEW.background_check_required AND NOT EXISTS (
    SELECT 1
    FROM background_checks background
    WHERE background.user_id = NEW.worker_id
      AND background.status = 'CLEAR'
      AND (background.expires_at IS NULL OR background.expires_at > clock_timestamp())
      AND (
        (
          background.is_test IS FALSE
          AND background.provider_environment = 'PRODUCTION'
        )
        OR
        (
          v_local_test_screening
          AND background.provider = 'local_certification_test'
          AND background.provider_environment = 'CONTROLLED_TEST'
          AND background.is_test IS TRUE
          AND EXISTS (
            SELECT 1 FROM hxos_local_test_screening_reports report
            WHERE report.background_check_id = background.id
              AND report.worker_id = NEW.worker_id
              AND report.status = 'CLEAR'
              AND report.is_test IS TRUE
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'HXRP19: background check required by region policy' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.insurance_required AND NOT EXISTS (
    SELECT 1 FROM insurance_verifications insurance
    WHERE insurance.user_id = NEW.worker_id
      AND lower(insurance.status) IN ('approved','verified')
      AND (insurance.expiration_date IS NULL OR insurance.expiration_date >= CURRENT_DATE)
  ) THEN
    RAISE EXCEPTION 'HXRP20: insurance required by region policy' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.license_required AND NOT EXISTS (
    SELECT 1 FROM license_verifications license
    WHERE license.user_id = NEW.worker_id
      AND license.trade_type = NEW.trade_type
      AND license.issuing_state = NEW.location_state
      AND lower(license.status) IN ('approved','verified')
      AND (license.expiration_date IS NULL OR license.expiration_date >= CURRENT_DATE)
  ) THEN
    RAISE EXCEPTION 'HXRP21: license required by region policy' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

-- Restore every Tier-0 and payout safeguard while adding provenance-aware
-- screening enforcement. This supersedes the payout migration's trigger body.
CREATE OR REPLACE FUNCTION enforce_task_worker_eligibility_on_accept()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_worker RECORD;
  v_active_tasks INTEGER;
  v_local_test_payout BOOLEAN;
  v_local_test_screening BOOLEAN;
BEGIN
  IF NEW.state <> 'ACCEPTED'
     OR (TG_OP = 'UPDATE' AND OLD.state = 'ACCEPTED' AND OLD.worker_id IS NOT DISTINCT FROM NEW.worker_id) THEN
    RETURN NEW;
  END IF;
  IF NEW.worker_id IS NULL THEN
    RAISE EXCEPTION 'HXWE1: accepted task requires a worker' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.poster_id = NEW.worker_id THEN
    RAISE EXCEPTION 'HXWE2: poster cannot accept their own task' USING ERRCODE = 'P0001';
  END IF;

  SELECT
    user_row.default_mode,
    user_row.account_status,
    user_row.is_minor,
    user_row.is_banned,
    user_row.trust_hold,
    user_row.trust_hold_until,
    user_row.trust_tier AS worker_trust_tier,
    user_row.is_verified,
    user_row.phone,
    user_row.plan,
    user_row.stripe_connect_id,
    user_row.payouts_enabled,
    profile.trust_tier AS profile_trust_tier,
    profile.risk_clearance,
    profile.background_check_valid,
    profile.background_check_expires_at,
    profile.background_check_source_id,
    profile.background_check_provider,
    profile.background_check_environment,
    profile.background_check_is_test
  INTO v_worker
  FROM users user_row
  JOIN capability_profiles profile ON profile.user_id = user_row.id
  WHERE user_row.id = NEW.worker_id;

  IF NOT FOUND OR v_worker.default_mode <> 'worker' THEN
    RAISE EXCEPTION 'HXWE3: eligible worker authority is missing' USING ERRCODE = 'P0001';
  END IF;

  v_local_test_payout := NEW.automation_classification = 'CONTROLLED_TEST'
    AND current_setting('hustlexp.local_test_payout_enabled', TRUE) = 'true'
    AND EXISTS (
      SELECT 1 FROM hxos_local_test_payout_destinations destination
      WHERE destination.worker_id = NEW.worker_id
        AND destination.status = 'ACTIVE'
        AND destination.is_test IS TRUE
    );
  v_local_test_screening := NEW.automation_classification = 'CONTROLLED_TEST'
    AND current_setting('hustlexp.local_test_screening_enabled', TRUE) = 'true';

  IF v_worker.account_status <> 'ACTIVE' OR v_worker.is_minor OR v_worker.is_banned THEN
    RAISE EXCEPTION 'HXWE4: worker account is not active and eligible' USING ERRCODE = 'P0001';
  END IF;
  IF v_worker.trust_hold
     AND (v_worker.trust_hold_until IS NULL OR v_worker.trust_hold_until > clock_timestamp()) THEN
    RAISE EXCEPTION 'HXWE5: worker has an active trust hold' USING ERRCODE = 'P0001';
  END IF;
  IF (v_worker.stripe_connect_id IS NULL OR NOT v_worker.payouts_enabled)
     AND NOT v_local_test_payout THEN
    RAISE EXCEPTION 'HXWE6: worker payout account is not ready' USING ERRCODE = 'P0001';
  END IF;
  IF v_worker.profile_trust_tier IS DISTINCT FROM v_worker.worker_trust_tier THEN
    RAISE EXCEPTION 'HXWE7: worker capability profile is stale' USING ERRCODE = 'P0001';
  END IF;
  IF v_worker.worker_trust_tier < 1
     OR NOT v_worker.is_verified
     OR NULLIF(BTRIM(v_worker.phone), '') IS NULL THEN
    RAISE EXCEPTION 'HXWE15: Tier 0 is browse-only; verified identity and phone are required' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.risk_level = 'IN_HOME' OR NOT (lower(NEW.risk_level) = ANY(v_worker.risk_clearance)) THEN
    RAISE EXCEPTION 'HXWE8: worker lacks task risk clearance' USING ERRCODE = 'P0001';
  END IF;
  IF v_worker.worker_trust_tier < COALESCE(NEW.trust_tier_required, 1) THEN
    RAISE EXCEPTION 'HXWE9: worker trust tier is insufficient' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.price > (CASE
      WHEN v_worker.worker_trust_tier = 1 THEN 5000
      WHEN v_worker.worker_trust_tier = 2 THEN 20000
      ELSE 9999900
    END) THEN
    RAISE EXCEPTION 'HXWE10: task value exceeds worker trust authority' USING ERRCODE = 'P0001';
  END IF;

  IF NEW.background_check_required THEN
    IF v_worker.background_check_valid IS NOT TRUE
       OR v_worker.background_check_source_id IS NULL
       OR (v_worker.background_check_expires_at IS NOT NULL
           AND v_worker.background_check_expires_at <= clock_timestamp()) THEN
      RAISE EXCEPTION 'HXWE17: task requires a current derived screening capability' USING ERRCODE = 'P0001';
    END IF;
    IF v_worker.background_check_is_test IS TRUE THEN
      IF NOT v_local_test_screening
         OR v_worker.background_check_provider <> 'local_certification_test'
         OR v_worker.background_check_environment <> 'CONTROLLED_TEST'
         OR NOT EXISTS (
           SELECT 1
           FROM background_checks background
           JOIN hxos_local_test_screening_reports report
             ON report.background_check_id = background.id
           WHERE background.id = v_worker.background_check_source_id
             AND background.user_id = NEW.worker_id
             AND background.status = 'CLEAR'
             AND background.is_test IS TRUE
             AND report.status = 'CLEAR'
             AND report.is_test IS TRUE
         ) THEN
        RAISE EXCEPTION 'HXWE16: TEST screening cannot authorize production work' USING ERRCODE = 'P0001';
      END IF;
    ELSIF v_worker.background_check_environment <> 'PRODUCTION'
          OR NOT EXISTS (
            SELECT 1 FROM background_checks background
            WHERE background.id = v_worker.background_check_source_id
              AND background.user_id = NEW.worker_id
              AND background.status = 'CLEAR'
              AND background.provider_environment = 'PRODUCTION'
              AND background.is_test IS FALSE
              AND (background.expires_at IS NULL OR background.expires_at > clock_timestamp())
          ) THEN
      RAISE EXCEPTION 'HXWE18: production screening provenance is invalid' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF NEW.risk_level = 'HIGH'
     AND v_worker.plan <> 'pro'
     AND NOT EXISTS (
       SELECT 1 FROM plan_entitlements entitlement
       WHERE entitlement.user_id = NEW.worker_id
         AND (entitlement.task_id IS NULL OR entitlement.task_id = NEW.id)
         AND entitlement.risk_level = 'HIGH'
         AND entitlement.expires_at > clock_timestamp()
     ) THEN
    RAISE EXCEPTION 'HXWE11: high-risk work requires Pro or an active entitlement' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM escrows escrow
    WHERE escrow.task_id = NEW.id AND escrow.state = 'FUNDED'
  ) THEN
    RAISE EXCEPTION 'HXWE12: task is not funded' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM disputes dispute
    WHERE dispute.worker_id = NEW.worker_id
      AND dispute.state IN ('OPEN', 'EVIDENCE_REQUESTED', 'ESCALATED')
  ) THEN
    RAISE EXCEPTION 'HXWE13: worker has an active dispute' USING ERRCODE = 'P0001';
  END IF;

  SELECT COUNT(*) INTO v_active_tasks
  FROM tasks active_task
  WHERE active_task.worker_id = NEW.worker_id
    AND active_task.id <> NEW.id
    AND active_task.state IN ('ACCEPTED', 'PROOF_SUBMITTED', 'DISPUTED');
  IF v_active_tasks >= 5 THEN
    RAISE EXCEPTION 'HXWE14: worker active-task capacity is exhausted' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON TABLE hxos_local_test_screening_reports IS
  'Non-production screening state-machine fixture. CLEAR is TEST evidence only and never proves an external background report.';
COMMENT ON COLUMN capability_profiles.background_check_is_test IS
  'True only when the derived screening source is a controlled local TEST fixture; production task acceptance must reject it.';
COMMENT ON FUNCTION enforce_task_worker_eligibility_on_accept() IS
  'HX/OS acceptance backstop: Tier 0 identity, payout readiness, capability provenance, TEST/production screening isolation, trust/risk/value/plan, funded escrow, dispute, and capacity.';
