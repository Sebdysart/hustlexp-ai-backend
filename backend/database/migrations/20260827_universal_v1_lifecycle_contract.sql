-- HustleXP Universal V1 lifecycle contract.
-- Authority: HustleXP Business and Universal V1 Charter v1.1.0.
--
-- This migration is additive. It extends the existing Task Draft, quote,
-- scope-version, application, reservation, task, proof, business-credential,
-- and evidence records instead of creating a competing lifecycle. It grants no
-- deployment or money capability. Financial effects remain inert unless a
-- separately approved capability policy and provider adapter authorize them.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- First-class provider classes and jurisdictional trade qualifications
-- ---------------------------------------------------------------------------

ALTER TABLE capability_profiles
  ADD COLUMN IF NOT EXISTS provider_class TEXT;

ALTER TABLE business_organizations
  ADD COLUMN IF NOT EXISTS provider_class TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'capability_profiles_provider_class_check'
      AND conrelid = 'public.capability_profiles'::regclass
  ) THEN
    ALTER TABLE capability_profiles
      ADD CONSTRAINT capability_profiles_provider_class_check CHECK (
        provider_class IS NULL
        OR provider_class IN ('GENERAL_SERVICE_PROVIDER','VERIFIED_TRADE_BUSINESS')
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'business_organizations_provider_class_check'
      AND conrelid = 'public.business_organizations'::regclass
  ) THEN
    ALTER TABLE business_organizations
      ADD CONSTRAINT business_organizations_provider_class_check CHECK (
        provider_class IS NULL
        OR provider_class IN ('GENERAL_SERVICE_PROVIDER','VERIFIED_TRADE_BUSINESS')
      );
  END IF;
END
$$;

ALTER TABLE business_credentials
  ADD COLUMN IF NOT EXISTS qualification_contract_version SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS issuing_authority TEXT,
  ADD COLUMN IF NOT EXISTS jurisdiction_code TEXT,
  ADD COLUMN IF NOT EXISTS license_scope TEXT,
  ADD COLUMN IF NOT EXISTS permitted_work_categories TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS credential_evidence JSONB NOT NULL DEFAULT '{}'::JSONB,
  ADD COLUMN IF NOT EXISTS official_source_checked_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'business_credentials_universal_trade_contract_check'
      AND conrelid = 'public.business_credentials'::regclass
  ) THEN
    ALTER TABLE business_credentials
      ADD CONSTRAINT business_credentials_universal_trade_contract_check CHECK (
        qualification_contract_version = 0
        OR (
          qualification_contract_version = 1
          AND issuing_authority IS NOT NULL
          AND char_length(btrim(issuing_authority)) BETWEEN 2 AND 240
          AND jurisdiction_code ~ '^[A-Z]{2}(-[A-Z0-9_-]{1,24})?$'
          AND license_scope IS NOT NULL
          AND char_length(btrim(license_scope)) BETWEEN 2 AND 2000
          AND cardinality(permitted_work_categories) > 0
          AND jsonb_typeof(credential_evidence) = 'object'
          AND official_source_checked_at IS NOT NULL
          AND (
            status <> 'ACTIVE'
            OR (
              verified_at IS NOT NULL
              AND expires_at IS NOT NULL
              AND expires_at > verified_at
            )
          )
        )
      );
  END IF;
END
$$;

ALTER TABLE verified_trades
  ADD COLUMN IF NOT EXISTS provider_class TEXT,
  ADD COLUMN IF NOT EXISTS provider_organization_id UUID
    REFERENCES business_organizations(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS business_credential_id UUID
    REFERENCES business_credentials(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS universal_contract_version SMALLINT NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'verified_trades_provider_class_check'
      AND conrelid = 'public.verified_trades'::regclass
  ) THEN
    ALTER TABLE verified_trades
      ADD CONSTRAINT verified_trades_provider_class_check
      CHECK (
        (universal_contract_version = 0 AND provider_class IS NULL)
        OR (
          universal_contract_version = 1
          AND provider_class = 'VERIFIED_TRADE_BUSINESS'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'verified_trades_universal_contract_check'
      AND conrelid = 'public.verified_trades'::regclass
  ) THEN
    ALTER TABLE verified_trades
      ADD CONSTRAINT verified_trades_universal_contract_check CHECK (
        universal_contract_version = 0
        OR (
          universal_contract_version = 1
          AND provider_class = 'VERIFIED_TRADE_BUSINESS'
          AND provider_organization_id IS NOT NULL
          AND business_credential_id IS NOT NULL
        )
      );
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION enforce_universal_trade_qualification()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.qualification_contract_version = 1
     AND NEW.qualification_contract_version <> 1 THEN
    RAISE EXCEPTION 'HXUV1-TRADE-3: Universal V1 credential authority cannot be downgraded'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.qualification_contract_version <> 1 THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM business_organizations organization
    WHERE organization.id = NEW.organization_id
      AND organization.provider_enabled IS TRUE
      AND organization.provider_class = 'VERIFIED_TRADE_BUSINESS'
  ) THEN
    RAISE EXCEPTION 'HXUV1-TRADE-1: trade qualification requires a Verified Trade Business'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS universal_trade_qualification_guard ON business_credentials;
CREATE TRIGGER universal_trade_qualification_guard
BEFORE INSERT OR UPDATE ON business_credentials
FOR EACH ROW EXECUTE FUNCTION enforce_universal_trade_qualification();

CREATE OR REPLACE FUNCTION enforce_verified_trade_projection()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.universal_contract_version = 1
     AND NEW.universal_contract_version <> 1 THEN
    RAISE EXCEPTION 'HXUV1-TRADE-4: verified trade projection authority cannot be downgraded'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.universal_contract_version <> 1 THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM business_credentials credential
    JOIN business_organizations organization ON organization.id = credential.organization_id
    JOIN business_memberships membership
      ON membership.organization_id = organization.id
     AND membership.user_id = NEW.user_id
    WHERE credential.id = NEW.business_credential_id
      AND credential.organization_id = NEW.provider_organization_id
      AND credential.qualification_contract_version = 1
      AND credential.status = 'ACTIVE'
      AND credential.expires_at > clock_timestamp()
      AND EXISTS (
        SELECT 1
        FROM unnest(credential.permitted_work_categories) AS permitted(category)
        WHERE lower(permitted.category) = lower(NEW.trade)
      )
      AND NEW.state = split_part(credential.jurisdiction_code, '-', 2)
      AND organization.provider_class = 'VERIFIED_TRADE_BUSINESS'
      AND organization.provider_enabled IS TRUE
      AND organization.verification_status = 'VERIFIED'
      AND organization.status = 'ACTIVE'
      AND membership.status = 'ACTIVE'
      AND membership.role IN ('OWNER','ADMIN','DISPATCHER','CREW')
  ) THEN
    RAISE EXCEPTION 'HXUV1-TRADE-2: verified trade projection must match its current credential, jurisdiction, category, organization, and crew member'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS universal_verified_trade_projection_guard ON verified_trades;
CREATE TRIGGER universal_verified_trade_projection_guard
BEFORE INSERT OR UPDATE ON verified_trades
FOR EACH ROW EXECUTE FUNCTION enforce_verified_trade_projection();

CREATE OR REPLACE VIEW current_verified_trade_qualifications AS
SELECT
  trade.user_id AS provider_user_id,
  credential.id AS business_credential_id,
  credential.organization_id,
  organization.provider_class,
  credential.credential_type,
  credential.issuing_authority,
  credential.jurisdiction_code,
  credential.license_scope,
  credential.status AS license_status,
  credential.expires_at,
  credential.evidence_hash,
  credential.credential_evidence,
  credential.verified_at,
  credential.official_source_checked_at,
  credential.permitted_work_categories
FROM business_credentials credential
JOIN business_organizations organization ON organization.id = credential.organization_id
JOIN verified_trades trade
  ON trade.business_credential_id = credential.id
 AND trade.provider_organization_id = organization.id
JOIN business_memberships membership
  ON membership.organization_id = organization.id
 AND membership.user_id = trade.user_id
WHERE credential.qualification_contract_version = 1
  AND trade.universal_contract_version = 1
  AND trade.provider_class = 'VERIFIED_TRADE_BUSINESS'
  AND organization.provider_enabled IS TRUE
  AND organization.provider_class = 'VERIFIED_TRADE_BUSINESS'
  AND organization.status = 'ACTIVE'
  AND organization.verification_status = 'VERIFIED'
  AND membership.status = 'ACTIVE'
  AND membership.role IN ('OWNER','ADMIN','DISPATCHER','CREW')
  AND credential.status = 'ACTIVE'
  AND credential.verified_at IS NOT NULL
  AND credential.expires_at > clock_timestamp();

-- ---------------------------------------------------------------------------
-- One typed routing decision from each durable Task Draft
-- ---------------------------------------------------------------------------

ALTER TABLE task_drafts
  ADD COLUMN IF NOT EXISTS universal_contract_version SMALLINT NOT NULL DEFAULT 0;

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS universal_contract_version SMALLINT NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'task_drafts_universal_contract_version_check'
      AND conrelid = 'public.task_drafts'::regclass
  ) THEN
    ALTER TABLE task_drafts
      ADD CONSTRAINT task_drafts_universal_contract_version_check
      CHECK (universal_contract_version IN (0, 1));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tasks_universal_contract_version_check'
      AND conrelid = 'public.tasks'::regclass
  ) THEN
    ALTER TABLE tasks
      ADD CONSTRAINT tasks_universal_contract_version_check
      CHECK (universal_contract_version IN (0, 1));
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS task_routing_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_draft_id UUID NOT NULL REFERENCES task_drafts(id) ON DELETE RESTRICT,
  decision_version INTEGER NOT NULL CHECK (decision_version > 0),
  supersedes_decision_id UUID REFERENCES task_routing_decisions(id) ON DELETE RESTRICT,
  outcome TEXT NOT NULL CHECK (outcome IN (
    'FULFILLMENT_CANDIDATE',
    'ESTIMATE_REQUIRED',
    'MANUAL_SOURCING',
    'REFERRAL',
    'WAITLIST',
    'DECLINE'
  )),
  reason_codes TEXT[] NOT NULL CHECK (cardinality(reason_codes) > 0),
  policy_version TEXT NOT NULL CHECK (char_length(btrim(policy_version)) BETWEEN 3 AND 128),
  category_snapshot TEXT NOT NULL,
  service_cell_snapshot TEXT,
  decision_authority TEXT NOT NULL CHECK (
    decision_authority IN ('DETERMINISTIC_POLICY','NAMED_OPERATOR')
  ),
  decided_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  evidence JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(evidence) = 'object'),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (
    idempotency_key ~ '^[A-Za-z0-9:_-]{8,128}$'
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (task_draft_id, decision_version),
  CHECK (
    (decision_authority = 'NAMED_OPERATOR' AND decided_by IS NOT NULL)
    OR decision_authority = 'DETERMINISTIC_POLICY'
  ),
  CHECK (
    (decision_version = 1 AND supersedes_decision_id IS NULL)
    OR (decision_version > 1 AND supersedes_decision_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS task_routing_decisions_draft_version_idx
  ON task_routing_decisions(task_draft_id, decision_version DESC);

ALTER TABLE task_drafts
  ADD COLUMN IF NOT EXISTS active_routing_decision_id UUID
    REFERENCES task_routing_decisions(id) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION enforce_universal_task_draft_authority()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  prior_version INTEGER;
  next_version INTEGER;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.universal_contract_version = 1
       AND NEW.active_routing_decision_id IS NOT NULL THEN
      RAISE EXCEPTION 'HXUV1-ROUTE-9: Universal V1 Task Draft promotion must begin without inherited routing authority'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.universal_contract_version = 1
     AND NEW.universal_contract_version <> 1 THEN
    RAISE EXCEPTION 'HXUV1-ROUTE-4: Universal V1 Task Draft authority cannot be downgraded'
      USING ERRCODE = 'P0001';
  END IF;

  IF OLD.universal_contract_version <> 1
     AND NEW.universal_contract_version = 1 THEN
    IF NEW.active_routing_decision_id IS NOT NULL THEN
      RAISE EXCEPTION 'HXUV1-ROUTE-9: Universal V1 Task Draft promotion must begin without inherited routing authority'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.universal_contract_version <> 1
     OR NEW.active_routing_decision_id IS NOT DISTINCT FROM OLD.active_routing_decision_id THEN
    RETURN NEW;
  END IF;

  IF NEW.active_routing_decision_id IS NULL THEN
    RAISE EXCEPTION 'HXUV1-ROUTE-5: active Universal V1 routing authority cannot be cleared'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT decision_version INTO next_version
  FROM task_routing_decisions
  WHERE id = NEW.active_routing_decision_id
    AND task_draft_id = NEW.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HXUV1-ROUTE-6: active route must belong to the exact Task Draft'
      USING ERRCODE = 'P0001';
  END IF;

  IF OLD.active_routing_decision_id IS NULL THEN
    prior_version := 0;
  ELSE
    SELECT decision_version INTO prior_version
    FROM task_routing_decisions
    WHERE id = OLD.active_routing_decision_id
      AND task_draft_id = NEW.id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'HXUV1-ROUTE-7: prior active route is not an exact Task Draft fact'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF next_version <> prior_version + 1 THEN
    RAISE EXCEPTION 'HXUV1-ROUTE-8: active routing pointer must advance exactly one version'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS universal_task_draft_authority_guard ON task_drafts;
CREATE TRIGGER universal_task_draft_authority_guard
BEFORE INSERT OR UPDATE OF universal_contract_version, active_routing_decision_id ON task_drafts
FOR EACH ROW EXECUTE FUNCTION enforce_universal_task_draft_authority();

-- ---------------------------------------------------------------------------
-- Existing quotes are the estimate aggregate; immutable provider submission is
-- recorded separately so a provider estimate is never confused with a platform
-- price or an approved scope.
-- ---------------------------------------------------------------------------

ALTER TABLE quotes
  ADD COLUMN IF NOT EXISTS quote_kind TEXT NOT NULL DEFAULT 'PLATFORM_QUOTE',
  ADD COLUMN IF NOT EXISTS provider_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS provider_organization_id UUID
    REFERENCES business_organizations(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS routing_decision_id UUID
    REFERENCES task_routing_decisions(id) ON DELETE RESTRICT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'quotes_quote_kind_check'
      AND conrelid = 'public.quotes'::regclass
  ) THEN
    ALTER TABLE quotes ADD CONSTRAINT quotes_quote_kind_check CHECK (
      quote_kind IN ('PLATFORM_QUOTE','PROVIDER_ESTIMATE')
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'quotes_provider_estimate_owner_check'
      AND conrelid = 'public.quotes'::regclass
  ) THEN
    ALTER TABLE quotes ADD CONSTRAINT quotes_provider_estimate_owner_check CHECK (
      quote_kind <> 'PROVIDER_ESTIMATE'
      OR (
        routing_decision_id IS NOT NULL
        AND num_nonnulls(provider_user_id, provider_organization_id) >= 1
      )
    );
  END IF;
END
$$;

ALTER TABLE quote_versions
  ADD COLUMN IF NOT EXISTS scope_version_id UUID
    REFERENCES task_scope_versions(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS scope_hash CHAR(64),
  ADD COLUMN IF NOT EXISTS provider_submitted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS expected_quote_version INTEGER;

-- Historical quote rows predate optimistic-version authority and may contain
-- duplicate display version numbers. Do not rewrite or silently discard that
-- evidence during an upgrade. Universal V1 versions are unambiguous because
-- their expected version is populated and protected independently.
CREATE UNIQUE INDEX IF NOT EXISTS quote_versions_universal_expected_version_unique
  ON quote_versions(quote_id, expected_quote_version)
  WHERE expected_quote_version IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'quote_versions_scope_hash_check'
      AND conrelid = 'public.quote_versions'::regclass
  ) THEN
    ALTER TABLE quote_versions ADD CONSTRAINT quote_versions_scope_hash_check CHECK (
      scope_hash IS NULL OR scope_hash ~ '^[a-f0-9]{64}$'
    );
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS provider_estimate_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id UUID NOT NULL REFERENCES quotes(id) ON DELETE RESTRICT,
  quote_version_id UUID NOT NULL REFERENCES quote_versions(id) ON DELETE RESTRICT,
  routing_decision_id UUID NOT NULL REFERENCES task_routing_decisions(id) ON DELETE RESTRICT,
  provider_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  provider_organization_id UUID REFERENCES business_organizations(id) ON DELETE RESTRICT,
  submitted_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  expected_quote_version INTEGER NOT NULL CHECK (expected_quote_version > 0),
  scope_snapshot JSONB NOT NULL CHECK (jsonb_typeof(scope_snapshot) = 'object'),
  scope_hash CHAR(64) NOT NULL CHECK (scope_hash ~ '^[a-f0-9]{64}$'),
  line_items JSONB NOT NULL CHECK (jsonb_typeof(line_items) = 'array'),
  customer_total_cents BIGINT NOT NULL CHECK (customer_total_cents > 0),
  provider_payout_cents BIGINT NOT NULL CHECK (provider_payout_cents > 0),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  payload_hash CHAR(64) NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (
    idempotency_key ~ '^[A-Za-z0-9:_-]{8,128}$'
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (num_nonnulls(provider_user_id, provider_organization_id) >= 1),
  UNIQUE (quote_id, quote_version_id),
  UNIQUE (quote_id, expected_quote_version),
  CHECK (provider_payout_cents <= customer_total_cents)
);

-- ---------------------------------------------------------------------------
-- Scope changes remain on task_scope_change_proposals; party decisions become
-- independent immutable facts. Approval records do not authorize money.
-- ---------------------------------------------------------------------------

ALTER TABLE task_scope_change_proposals
  ADD COLUMN IF NOT EXISTS universal_contract_version SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS proposal_version INTEGER,
  ADD COLUMN IF NOT EXISTS supersedes_proposal_id UUID
    REFERENCES task_scope_change_proposals(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS change_order_kind TEXT NOT NULL DEFAULT 'SCOPE_ONLY',
  ADD COLUMN IF NOT EXISTS proposed_customer_total_cents INTEGER,
  ADD COLUMN IF NOT EXISTS schedule_effect TEXT,
  ADD COLUMN IF NOT EXISTS financial_adjustment_required BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE task_scope_versions
  ADD COLUMN IF NOT EXISTS universal_contract_version SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS currency CHAR(3);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'task_scope_change_kind_check'
      AND conrelid = 'public.task_scope_change_proposals'::regclass
  ) THEN
    ALTER TABLE task_scope_change_proposals
      ADD CONSTRAINT task_scope_change_kind_check CHECK (
        change_order_kind IN ('SCOPE_ONLY','PRICE_AND_SCOPE','SCHEDULE_AND_SCOPE')
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'task_scope_change_amount_check'
      AND conrelid = 'public.task_scope_change_proposals'::regclass
  ) THEN
    ALTER TABLE task_scope_change_proposals
      ADD CONSTRAINT task_scope_change_amount_check CHECK (
        universal_contract_version = 0
        OR (
          universal_contract_version = 1
          AND proposal_version IS NOT NULL
          AND proposal_version > 0
          AND (
            (proposal_version = 1 AND supersedes_proposal_id IS NULL)
            OR (proposal_version > 1 AND supersedes_proposal_id IS NOT NULL)
          )
          AND (
            (
              change_order_kind = 'SCOPE_ONLY'
              AND proposed_customer_total_cents IS NULL
              AND financial_adjustment_required IS FALSE
            )
            OR (
              change_order_kind = 'PRICE_AND_SCOPE'
              AND proposed_customer_total_cents > 0
              AND financial_adjustment_required IS TRUE
            )
            OR (
              change_order_kind = 'SCHEDULE_AND_SCOPE'
              AND schedule_effect IS NOT NULL
              AND char_length(btrim(schedule_effect)) BETWEEN 3 AND 1000
            )
          )
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'task_scope_versions_universal_contract_check'
      AND conrelid = 'public.task_scope_versions'::regclass
  ) THEN
    ALTER TABLE task_scope_versions
      ADD CONSTRAINT task_scope_versions_universal_contract_check CHECK (
        universal_contract_version = 0
        OR (
          universal_contract_version = 1
          AND currency IS NOT NULL
          AND currency ~ '^[A-Z]{3}$'
          AND hustler_payout_cents IS NOT NULL
        )
      );
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS task_scope_change_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id UUID NOT NULL REFERENCES task_scope_change_proposals(id) ON DELETE RESTRICT,
  approver_role TEXT NOT NULL CHECK (approver_role IN ('CUSTOMER','PROVIDER')),
  decision TEXT NOT NULL CHECK (decision IN ('APPROVED','REJECTED')),
  actor_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  expected_proposal_version INTEGER NOT NULL CHECK (expected_proposal_version > 0),
  reason TEXT NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 1000),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (
    idempotency_key ~ '^[A-Za-z0-9:_-]{8,128}$'
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (proposal_id, approver_role)
);

-- ---------------------------------------------------------------------------
-- Expressed interest and task-specific eligibility are distinct. Interest has
-- no reservation, assignment, address, financial, or payable authority.
-- ---------------------------------------------------------------------------

ALTER TABLE task_applications
  ADD COLUMN IF NOT EXISTS universal_contract_version SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS authority TEXT,
  ADD COLUMN IF NOT EXISTS provider_organization_id UUID
    REFERENCES business_organizations(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS interest_scope_version_id UUID
    REFERENCES task_scope_versions(id) ON DELETE RESTRICT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'task_applications_interest_authority_check'
      AND conrelid = 'public.task_applications'::regclass
  ) THEN
    ALTER TABLE task_applications
      ADD CONSTRAINT task_applications_interest_authority_check
      CHECK (
        (universal_contract_version = 0 AND authority IS NULL)
        OR (
          universal_contract_version = 1
          AND authority = 'EXPRESS_INTEREST'
          AND interest_scope_version_id IS NOT NULL
          AND status IN ('pending','withdrawn','expired','rejected')
        )
      );
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION enforce_universal_interest_integrity()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.universal_contract_version <> 1 THEN
    RETURN NEW;
  END IF;

  IF NEW.universal_contract_version <> 1
     OR OLD.task_id IS DISTINCT FROM NEW.task_id
     OR OLD.hustler_id IS DISTINCT FROM NEW.hustler_id
     OR OLD.authority IS DISTINCT FROM NEW.authority
     OR OLD.provider_organization_id IS DISTINCT FROM NEW.provider_organization_id
     OR OLD.interest_scope_version_id IS DISTINCT FROM NEW.interest_scope_version_id
     OR NOT (
       NEW.status = OLD.status
       OR (
         OLD.status = 'pending'
         AND NEW.status IN ('withdrawn','expired','rejected')
       )
     ) THEN
    RAISE EXCEPTION 'HXUV1-INTEREST-1: provider interest identity is immutable and cannot become assignment'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS universal_interest_integrity_guard ON task_applications;
CREATE TRIGGER universal_interest_integrity_guard
BEFORE UPDATE ON task_applications
FOR EACH ROW EXECUTE FUNCTION enforce_universal_interest_integrity();

CREATE TABLE IF NOT EXISTS task_provider_eligibility_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_draft_id UUID NOT NULL REFERENCES task_drafts(id) ON DELETE RESTRICT,
  task_id UUID REFERENCES tasks(id) ON DELETE RESTRICT,
  scope_version_id UUID REFERENCES task_scope_versions(id) ON DELETE RESTRICT,
  interest_application_id UUID REFERENCES task_applications(id) ON DELETE RESTRICT,
  routing_decision_id UUID NOT NULL
    REFERENCES task_routing_decisions(id) ON DELETE RESTRICT,
  decision_version INTEGER NOT NULL CHECK (decision_version > 0),
  supersedes_decision_id UUID
    REFERENCES task_provider_eligibility_decisions(id) ON DELETE RESTRICT,
  provider_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  provider_organization_id UUID REFERENCES business_organizations(id) ON DELETE RESTRICT,
  provider_class TEXT NOT NULL CHECK (
    provider_class IN ('GENERAL_SERVICE_PROVIDER','VERIFIED_TRADE_BUSINESS')
  ),
  trade_credential_id UUID REFERENCES business_credentials(id) ON DELETE RESTRICT,
  profile_eligible BOOLEAN NOT NULL,
  identity_eligible BOOLEAN NOT NULL,
  category_eligible BOOLEAN NOT NULL,
  credential_eligible BOOLEAN NOT NULL,
  geography_eligible BOOLEAN NOT NULL,
  availability_eligible BOOLEAN NOT NULL,
  restriction_clear BOOLEAN NOT NULL,
  task_eligible BOOLEAN NOT NULL,
  processor_payment_eligible BOOLEAN NOT NULL DEFAULT FALSE,
  payout_funding_eligible BOOLEAN NOT NULL DEFAULT FALSE,
  trust_tier TEXT NOT NULL,
  blocker_codes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  policy_version TEXT NOT NULL CHECK (char_length(btrim(policy_version)) BETWEEN 3 AND 128),
  evidence JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(evidence) = 'object'),
  decided_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL UNIQUE CHECK (
    idempotency_key ~ '^[A-Za-z0-9:_-]{8,128}$'
  ),
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_until TIMESTAMPTZ NOT NULL,
  UNIQUE (task_draft_id, provider_user_id, decision_version),
  CHECK (valid_until > evaluated_at),
  CHECK (
    (decision_version = 1 AND supersedes_decision_id IS NULL)
    OR (decision_version > 1 AND supersedes_decision_id IS NOT NULL)
  ),
  CHECK (
    (provider_class = 'GENERAL_SERVICE_PROVIDER' AND provider_user_id IS NOT NULL)
    OR (
      provider_class = 'VERIFIED_TRADE_BUSINESS'
      AND provider_user_id IS NOT NULL
      AND provider_organization_id IS NOT NULL
      AND trade_credential_id IS NOT NULL
    )
  ),
  CHECK (
    task_eligible IS FALSE
    OR (
      profile_eligible
      AND identity_eligible
      AND category_eligible
      AND credential_eligible
      AND geography_eligible
      AND availability_eligible
      AND restriction_clear
    )
  )
);

CREATE INDEX IF NOT EXISTS task_provider_eligibility_current_idx
  ON task_provider_eligibility_decisions(
    task_draft_id, provider_class, task_eligible, valid_until DESC
  );

-- Existing task reservations are the conditional-hold aggregate. Version 0
-- preserves historical records; version 1 requires the exact interest and
-- eligibility facts. An ACTIVE hold is expressly not an assignment.
ALTER TABLE task_reservations
  ADD COLUMN IF NOT EXISTS universal_contract_version SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS hold_kind TEXT,
  ADD COLUMN IF NOT EXISTS interest_application_id UUID
    REFERENCES task_applications(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS eligibility_decision_id UUID
    REFERENCES task_provider_eligibility_decisions(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'task_reservations_universal_hold_check'
      AND conrelid = 'public.task_reservations'::regclass
  ) THEN
    ALTER TABLE task_reservations
      ADD CONSTRAINT task_reservations_universal_hold_check CHECK (
        universal_contract_version = 0
        OR (
          universal_contract_version = 1
          AND hold_kind = 'CONDITIONAL_HOLD'
          AND interest_application_id IS NOT NULL
          AND eligibility_decision_id IS NOT NULL
          AND expires_at IS NOT NULL
          AND expires_at > reserved_at
        )
      );
  END IF;
END
$$;

COMMENT ON COLUMN task_applications.authority IS
  'EXPRESS_INTEREST only: never reservation, assignment, exact-address, money, payable, or guaranteed-work authority.';
COMMENT ON COLUMN task_reservations.hold_kind IS
  'CONDITIONAL_HOLD is a bounded soft reservation and never hard assignment.';

-- ---------------------------------------------------------------------------
-- Provider-neutral financial security facts. One row records exactly one
-- effect: authorization is never capture, and release is never bank settlement.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS task_financial_operations (
  operation_id TEXT PRIMARY KEY CHECK (char_length(btrim(operation_id)) BETWEEN 8 AND 160),
  task_draft_id UUID NOT NULL REFERENCES task_drafts(id) ON DELETE RESTRICT,
  task_id UUID REFERENCES tasks(id) ON DELETE RESTRICT,
  eligibility_decision_id UUID
    REFERENCES task_provider_eligibility_decisions(id) ON DELETE RESTRICT,
  scope_version_id UUID REFERENCES task_scope_versions(id) ON DELETE RESTRICT,
  change_order_id UUID REFERENCES task_scope_change_proposals(id) ON DELETE RESTRICT,
  event_kind TEXT NOT NULL CHECK (event_kind IN (
    'PAYMENT_METHOD_PREPARED',
    'AUTHORIZED',
    'SECURED',
    'VOIDED',
    'ADJUSTMENT_AUTHORIZED',
    'CAPTURED',
    'REFUNDED',
    'REVERSED',
    'SETTLEMENT_OBSERVED',
    'FUNDING_OBSERVED',
    'PROVIDER_RELEASED',
    'PAYOUT_OBSERVED',
    'BANK_SETTLEMENT_OBSERVED'
  )),
  provider_kind TEXT NOT NULL CHECK (provider_kind IN ('FAKE','APPROVED_PROVIDER')),
  external_reference TEXT,
  amount_cents BIGINT CHECK (amount_cents IS NULL OR amount_cents > 0),
  currency CHAR(3) CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    event_kind = 'PAYMENT_METHOD_PREPARED'
    OR (
      task_id IS NOT NULL
      AND eligibility_decision_id IS NOT NULL
      AND scope_version_id IS NOT NULL
      AND amount_cents IS NOT NULL
      AND currency IS NOT NULL
    )
  ),
  CHECK ((event_kind = 'ADJUSTMENT_AUTHORIZED') = (change_order_id IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS task_financial_security_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_draft_id UUID NOT NULL REFERENCES task_drafts(id) ON DELETE RESTRICT,
  task_id UUID REFERENCES tasks(id) ON DELETE RESTRICT,
  eligibility_decision_id UUID
    REFERENCES task_provider_eligibility_decisions(id) ON DELETE RESTRICT,
  scope_version_id UUID REFERENCES task_scope_versions(id) ON DELETE RESTRICT,
  change_order_id UUID REFERENCES task_scope_change_proposals(id) ON DELETE RESTRICT,
  predecessor_event_id UUID REFERENCES task_financial_security_events(id) ON DELETE RESTRICT,
  event_kind TEXT NOT NULL CHECK (event_kind IN (
    'PAYMENT_METHOD_PREPARED',
    'AUTHORIZED',
    'SECURED',
    'VOIDED',
    'ADJUSTMENT_AUTHORIZED',
    'CAPTURED',
    'REFUNDED',
    'REVERSED',
    'SETTLEMENT_OBSERVED',
    'FUNDING_OBSERVED',
    'PROVIDER_RELEASED',
    'PAYOUT_OBSERVED',
    'BANK_SETTLEMENT_OBSERVED'
  )),
  status TEXT NOT NULL CHECK (
    status IN ('REQUESTED','SUCCEEDED','DECLINED','FAILED','RETRYABLE_FAILURE')
  ),
  operation_id TEXT NOT NULL
    REFERENCES task_financial_operations(operation_id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL UNIQUE CHECK (
    idempotency_key ~ '^[A-Za-z0-9:_-]{8,128}$'
  ),
  expected_version INTEGER NOT NULL CHECK (expected_version >= 0),
  provider_kind TEXT NOT NULL CHECK (provider_kind IN ('FAKE','APPROVED_PROVIDER')),
  external_reference TEXT,
  amount_cents BIGINT CHECK (amount_cents IS NULL OR amount_cents > 0),
  currency CHAR(3),
  evidence JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(evidence) = 'object'),
  recorded_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (task_draft_id, expected_version),
  CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  CHECK (
    event_kind = 'PAYMENT_METHOD_PREPARED'
    OR (amount_cents IS NOT NULL AND currency IS NOT NULL)
  ),
  CHECK (
    event_kind = 'PAYMENT_METHOD_PREPARED'
    OR (
      task_id IS NOT NULL
      AND eligibility_decision_id IS NOT NULL
      AND scope_version_id IS NOT NULL
    )
  ),
  CHECK (
    (
      event_kind = 'PAYMENT_METHOD_PREPARED'
      AND predecessor_event_id IS NULL
      AND expected_version = 0
      AND status = 'SUCCEEDED'
    )
    OR (
      event_kind <> 'PAYMENT_METHOD_PREPARED'
      AND predecessor_event_id IS NOT NULL
      AND expected_version > 0
    )
  ),
  CHECK ((event_kind = 'ADJUSTMENT_AUTHORIZED') = (change_order_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS task_financial_security_events_task_idx
  ON task_financial_security_events(task_id, occurred_at, id);

-- A single operation may produce several retry/failure observations. Preserve
-- every append-only observation instead of making a status value itself unique.
DROP INDEX IF EXISTS task_financial_operation_status_unique;
CREATE INDEX IF NOT EXISTS task_financial_operation_history_idx
  ON task_financial_security_events(task_draft_id, operation_id, expected_version);

DROP INDEX IF EXISTS task_financial_external_effect_unique;
CREATE UNIQUE INDEX IF NOT EXISTS task_financial_operation_external_effect_unique
  ON task_financial_operations(provider_kind, external_reference, event_kind)
  WHERE external_reference IS NOT NULL;

CREATE INDEX IF NOT EXISTS task_financial_external_effect_history_idx
  ON task_financial_security_events(provider_kind, external_reference, event_kind, status)
  WHERE external_reference IS NOT NULL;

CREATE OR REPLACE FUNCTION enforce_financial_operation_trigger_only()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'HXUV1-FIN-18: financial operation authority is created only with its first event'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS financial_operation_trigger_only_guard ON task_financial_operations;
CREATE TRIGGER financial_operation_trigger_only_guard
BEFORE INSERT ON task_financial_operations
FOR EACH ROW EXECUTE FUNCTION enforce_financial_operation_trigger_only();

-- ---------------------------------------------------------------------------
-- Canonical Work Order materialization is an immutable fact. The row can only
-- be created after current eligibility, a live conditional hold, and a distinct
-- successful SECURED financial event. Creating it does not assign a provider.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS task_work_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_draft_id UUID NOT NULL REFERENCES task_drafts(id) ON DELETE RESTRICT,
  task_id UUID NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE RESTRICT,
  scope_version_id UUID NOT NULL REFERENCES task_scope_versions(id) ON DELETE RESTRICT,
  routing_decision_id UUID NOT NULL
    REFERENCES task_routing_decisions(id) ON DELETE RESTRICT,
  provider_estimate_submission_id UUID
    REFERENCES provider_estimate_submissions(id) ON DELETE RESTRICT,
  interest_application_id UUID NOT NULL REFERENCES task_applications(id) ON DELETE RESTRICT,
  eligibility_decision_id UUID NOT NULL
    REFERENCES task_provider_eligibility_decisions(id) ON DELETE RESTRICT,
  conditional_hold_id UUID NOT NULL REFERENCES task_reservations(id) ON DELETE RESTRICT,
  financial_security_event_id UUID NOT NULL
    REFERENCES task_financial_security_events(id) ON DELETE RESTRICT,
  provider_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  provider_organization_id UUID REFERENCES business_organizations(id) ON DELETE RESTRICT,
  materialization_version INTEGER NOT NULL CHECK (materialization_version > 0),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (
    idempotency_key ~ '^[A-Za-z0-9:_-]{8,128}$'
  ),
  materialized_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  materialized_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (num_nonnulls(provider_user_id, provider_organization_id) >= 1)
);

CREATE TABLE IF NOT EXISTS task_work_order_amendments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id UUID NOT NULL REFERENCES task_work_orders(id) ON DELETE RESTRICT,
  amendment_version INTEGER NOT NULL CHECK (amendment_version > 0),
  supersedes_amendment_id UUID
    REFERENCES task_work_order_amendments(id) ON DELETE RESTRICT,
  change_order_id UUID NOT NULL UNIQUE
    REFERENCES task_scope_change_proposals(id) ON DELETE RESTRICT,
  scope_version_id UUID NOT NULL
    REFERENCES task_scope_versions(id) ON DELETE RESTRICT,
  adjustment_event_id UUID
    REFERENCES task_financial_security_events(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL UNIQUE CHECK (
    idempotency_key ~ '^[A-Za-z0-9:_-]{8,128}$'
  ),
  materialized_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  materialized_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (work_order_id, amendment_version),
  CHECK (
    (amendment_version = 1 AND supersedes_amendment_id IS NULL)
    OR (amendment_version > 1 AND supersedes_amendment_id IS NOT NULL)
  )
);

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS work_order_id UUID
    REFERENCES task_work_orders(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS tasks_work_order_id_unique
  ON tasks(work_order_id) WHERE work_order_id IS NOT NULL;

-- Existing proof/evidence records remain authoritative. They gain an exact
-- Work Order binding and typed lifecycle purpose instead of being replaced.
ALTER TABLE proofs
  ADD COLUMN IF NOT EXISTS work_order_id UUID
    REFERENCES task_work_orders(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS evidence_kind TEXT;

ALTER TABLE evidence
  ADD COLUMN IF NOT EXISTS work_order_id UUID
    REFERENCES task_work_orders(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS lifecycle_evidence_kind TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'proofs_universal_evidence_kind_check'
      AND conrelid = 'public.proofs'::regclass
  ) THEN
    ALTER TABLE proofs ADD CONSTRAINT proofs_universal_evidence_kind_check CHECK (
      evidence_kind IS NULL
      OR evidence_kind IN ('BEFORE','PROGRESS','COMPLETION','INCIDENT','RECOVERY')
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'evidence_universal_kind_check'
      AND conrelid = 'public.evidence'::regclass
  ) THEN
    ALTER TABLE evidence ADD CONSTRAINT evidence_universal_kind_check CHECK (
      lifecycle_evidence_kind IS NULL
      OR lifecycle_evidence_kind IN (
        'SCOPE','CREDENTIAL','BEFORE','PROGRESS','COMPLETION','INCIDENT','RECOVERY','RECONCILIATION'
      )
    );
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS task_completion_facts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id UUID NOT NULL REFERENCES task_work_orders(id) ON DELETE RESTRICT,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  scope_version_id UUID NOT NULL REFERENCES task_scope_versions(id) ON DELETE RESTRICT,
  proof_id UUID NOT NULL REFERENCES proofs(id) ON DELETE RESTRICT,
  proof_snapshot_hash CHAR(64) NOT NULL CHECK (proof_snapshot_hash ~ '^[a-f0-9]{64}$'),
  completion_version INTEGER NOT NULL CHECK (completion_version > 0),
  supersedes_fact_id UUID REFERENCES task_completion_facts(id) ON DELETE RESTRICT,
  fact_kind TEXT NOT NULL CHECK (fact_kind IN ('SUBMITTED','APPROVED','REJECTED')),
  amount_approved_cents BIGINT CHECK (amount_approved_cents IS NULL OR amount_approved_cents > 0),
  incident_gate TEXT NOT NULL CHECK (incident_gate IN ('CLEAR','BLOCKED')),
  customer_notice_at TIMESTAMPTZ,
  delivery_event_id UUID
    REFERENCES task_completion_delivery_events(id) ON DELETE RESTRICT,
  actor_role TEXT NOT NULL CHECK (actor_role IN ('PROVIDER','CUSTOMER','NAMED_OPERATOR')),
  decision_reason TEXT NOT NULL CHECK (char_length(btrim(decision_reason)) BETWEEN 3 AND 2000),
  actor_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL UNIQUE CHECK (
    idempotency_key ~ '^[A-Za-z0-9:_-]{8,128}$'
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (work_order_id, completion_version),
  CHECK (
    (completion_version = 1 AND supersedes_fact_id IS NULL)
    OR (completion_version > 1 AND supersedes_fact_id IS NOT NULL)
  ),
  CHECK (
    fact_kind <> 'APPROVED'
    OR (
      amount_approved_cents IS NOT NULL
      AND incident_gate = 'CLEAR'
      AND customer_notice_at IS NOT NULL
      AND delivery_event_id IS NOT NULL
    )
  )
);

ALTER TABLE task_financial_security_events
  ADD COLUMN IF NOT EXISTS completion_fact_id UUID
    REFERENCES task_completion_facts(id) ON DELETE RESTRICT;

ALTER TABLE task_financial_operations
  ADD COLUMN IF NOT EXISTS completion_fact_id UUID
    REFERENCES task_completion_facts(id) ON DELETE RESTRICT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'task_financial_capture_completion_check'
      AND conrelid = 'public.task_financial_security_events'::regclass
  ) THEN
    ALTER TABLE task_financial_security_events
      ADD CONSTRAINT task_financial_capture_completion_check
      CHECK (event_kind <> 'CAPTURED' OR completion_fact_id IS NOT NULL);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'task_financial_operation_capture_completion_check'
      AND conrelid = 'public.task_financial_operations'::regclass
  ) THEN
    ALTER TABLE task_financial_operations
      ADD CONSTRAINT task_financial_operation_capture_completion_check
      CHECK (event_kind <> 'CAPTURED' OR completion_fact_id IS NOT NULL);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'task_financial_preparation_shape_check'
      AND conrelid = 'public.task_financial_security_events'::regclass
  ) THEN
    ALTER TABLE task_financial_security_events
      ADD CONSTRAINT task_financial_preparation_shape_check CHECK (
        event_kind <> 'PAYMENT_METHOD_PREPARED'
        OR (
          amount_cents IS NULL
          AND currency IS NULL
          AND change_order_id IS NULL
          AND completion_fact_id IS NULL
          AND (
            num_nonnulls(task_id, eligibility_decision_id, scope_version_id) = 0
            OR num_nonnulls(task_id, eligibility_decision_id, scope_version_id) = 3
          )
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'task_financial_operation_preparation_shape_check'
      AND conrelid = 'public.task_financial_operations'::regclass
  ) THEN
    ALTER TABLE task_financial_operations
      ADD CONSTRAINT task_financial_operation_preparation_shape_check CHECK (
        event_kind <> 'PAYMENT_METHOD_PREPARED'
        OR (
          amount_cents IS NULL
          AND currency IS NULL
          AND change_order_id IS NULL
          AND completion_fact_id IS NULL
          AND (
            num_nonnulls(task_id, eligibility_decision_id, scope_version_id) = 0
            OR num_nonnulls(task_id, eligibility_decision_id, scope_version_id) = 3
          )
        )
      );
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS task_reconciliation_facts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id UUID NOT NULL REFERENCES task_work_orders(id) ON DELETE RESTRICT,
  reconciliation_version INTEGER NOT NULL CHECK (reconciliation_version > 0),
  supersedes_fact_id UUID REFERENCES task_reconciliation_facts(id) ON DELETE RESTRICT,
  void_event_id UUID REFERENCES task_financial_security_events(id) ON DELETE RESTRICT,
  capture_event_id UUID REFERENCES task_financial_security_events(id) ON DELETE RESTRICT,
  refund_event_id UUID REFERENCES task_financial_security_events(id) ON DELETE RESTRICT,
  reversal_event_id UUID REFERENCES task_financial_security_events(id) ON DELETE RESTRICT,
  settlement_event_id UUID REFERENCES task_financial_security_events(id) ON DELETE RESTRICT,
  funding_event_id UUID REFERENCES task_financial_security_events(id) ON DELETE RESTRICT,
  provider_release_event_id UUID REFERENCES task_financial_security_events(id) ON DELETE RESTRICT,
  payout_event_id UUID REFERENCES task_financial_security_events(id) ON DELETE RESTRICT,
  bank_settlement_event_id UUID REFERENCES task_financial_security_events(id) ON DELETE RESTRICT,
  void_state TEXT NOT NULL CHECK (
    void_state IN ('NOT_APPLICABLE','PENDING','VOIDED','FAILED','MISMATCH')
  ),
  capture_state TEXT NOT NULL CHECK (
    capture_state IN ('NOT_APPLICABLE','PENDING','CAPTURED','MISMATCH')
  ),
  refund_state TEXT NOT NULL CHECK (
    refund_state IN ('NOT_APPLICABLE','PENDING','REFUNDED','FAILED','MISMATCH')
  ),
  reversal_state TEXT NOT NULL CHECK (
    reversal_state IN ('NOT_APPLICABLE','PENDING','REVERSED','FAILED','MISMATCH')
  ),
  settlement_state TEXT NOT NULL CHECK (
    settlement_state IN ('NOT_APPLICABLE','PENDING','SETTLED','FAILED','MISMATCH')
  ),
  funding_state TEXT NOT NULL CHECK (
    funding_state IN ('NOT_APPLICABLE','PENDING','FUNDED','FAILED','MISMATCH')
  ),
  provider_release_state TEXT NOT NULL CHECK (
    provider_release_state IN ('NOT_APPLICABLE','PENDING','RELEASED','FAILED','MISMATCH')
  ),
  payout_state TEXT NOT NULL CHECK (
    payout_state IN ('NOT_APPLICABLE','PENDING','PAID','FAILED','MISMATCH')
  ),
  bank_settlement_state TEXT NOT NULL CHECK (
    bank_settlement_state IN ('NOT_APPLICABLE','PENDING','SETTLED','FAILED','MISMATCH')
  ),
  ledger_state TEXT NOT NULL CHECK (ledger_state IN ('PENDING','MATCHED','MISMATCH')),
  reconciliation_state TEXT NOT NULL CHECK (
    reconciliation_state IN ('OPEN','MATCHED','MISMATCH','CLOSED')
  ),
  mismatch_codes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  customer_ledger_amount_cents BIGINT NOT NULL CHECK (customer_ledger_amount_cents >= 0),
  provider_ledger_amount_cents BIGINT NOT NULL CHECK (provider_ledger_amount_cents >= 0),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  expected_version INTEGER NOT NULL CHECK (expected_version >= 0),
  evidence JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(evidence) = 'object'),
  recorded_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL UNIQUE CHECK (
    idempotency_key ~ '^[A-Za-z0-9:_-]{8,128}$'
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (work_order_id, reconciliation_version),
  CHECK (
    (reconciliation_version = 1 AND supersedes_fact_id IS NULL)
    OR (reconciliation_version > 1 AND supersedes_fact_id IS NOT NULL)
  ),
  CHECK (
    (void_state = 'NOT_APPLICABLE') = (void_event_id IS NULL)
    AND (capture_state = 'NOT_APPLICABLE') = (capture_event_id IS NULL)
    AND (refund_state = 'NOT_APPLICABLE') = (refund_event_id IS NULL)
    AND (reversal_state = 'NOT_APPLICABLE') = (reversal_event_id IS NULL)
    AND (settlement_state = 'NOT_APPLICABLE') = (settlement_event_id IS NULL)
    AND (funding_state = 'NOT_APPLICABLE') = (funding_event_id IS NULL)
    AND (provider_release_state = 'NOT_APPLICABLE') = (provider_release_event_id IS NULL)
    AND (payout_state = 'NOT_APPLICABLE') = (payout_event_id IS NULL)
    AND (bank_settlement_state = 'NOT_APPLICABLE') = (bank_settlement_event_id IS NULL)
  ),
  CHECK (
    (cardinality(mismatch_codes) > 0) = (
      reconciliation_state = 'MISMATCH'
      OR ledger_state = 'MISMATCH'
      OR void_state = 'MISMATCH'
      OR capture_state = 'MISMATCH'
      OR refund_state = 'MISMATCH'
      OR reversal_state = 'MISMATCH'
      OR settlement_state = 'MISMATCH'
      OR funding_state = 'MISMATCH'
      OR provider_release_state = 'MISMATCH'
      OR payout_state = 'MISMATCH'
      OR bank_settlement_state = 'MISMATCH'
    )
  ),
  CHECK (
    reconciliation_state NOT IN ('MATCHED','CLOSED')
    OR (
      ledger_state = 'MATCHED'
      AND cardinality(mismatch_codes) = 0
      AND num_nonnulls(
        void_event_id,
        capture_event_id,
        refund_event_id,
        reversal_event_id,
        settlement_event_id,
        funding_event_id,
        provider_release_event_id,
        payout_event_id,
        bank_settlement_event_id
      ) > 0
      AND (
        (
          void_state = 'NOT_APPLICABLE'
          AND capture_state = 'CAPTURED'
          AND refund_state IN ('NOT_APPLICABLE','REFUNDED')
          AND reversal_state = 'NOT_APPLICABLE'
          AND settlement_state = 'SETTLED'
          AND funding_state = 'FUNDED'
          AND provider_release_state = 'RELEASED'
          AND payout_state = 'PAID'
          AND bank_settlement_state = 'SETTLED'
        )
        OR (
          reconciliation_state = 'CLOSED'
          AND customer_ledger_amount_cents = 0
          AND provider_ledger_amount_cents = 0
          AND (
            (
              void_state = 'VOIDED'
              AND capture_state = 'NOT_APPLICABLE'
              AND refund_state = 'NOT_APPLICABLE'
              AND reversal_state = 'NOT_APPLICABLE'
            )
            OR (
              void_state = 'NOT_APPLICABLE'
              AND capture_state IN ('NOT_APPLICABLE','CAPTURED')
              AND refund_state = 'NOT_APPLICABLE'
              AND reversal_state = 'REVERSED'
            )
            OR (
              void_state = 'NOT_APPLICABLE'
              AND capture_state = 'CAPTURED'
              AND refund_state = 'REFUNDED'
              AND reversal_state = 'NOT_APPLICABLE'
            )
          )
          AND settlement_state = 'NOT_APPLICABLE'
          AND funding_state = 'NOT_APPLICABLE'
          AND provider_release_state = 'NOT_APPLICABLE'
          AND payout_state = 'NOT_APPLICABLE'
          AND bank_settlement_state = 'NOT_APPLICABLE'
        )
      )
    )
  )
);

-- ---------------------------------------------------------------------------
-- Cross-record invariants
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION enforce_universal_routing_sequence()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  predecessor task_routing_decisions%ROWTYPE;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM task_drafts draft
    WHERE draft.id = NEW.task_draft_id
      AND draft.universal_contract_version = 1
  ) THEN
    RAISE EXCEPTION 'HXUV1-ROUTE-0: routing authority requires a Universal V1 Task Draft'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.decision_authority = 'NAMED_OPERATOR' AND NOT EXISTS (
    SELECT 1
    FROM admin_roles operator
    WHERE operator.user_id = NEW.decided_by
      AND operator.can_manage_operations IS TRUE
  ) THEN
    RAISE EXCEPTION 'HXUV1-ROUTE-3: named routing decisions require scoped operations authority'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.decision_version = 1 THEN
    RETURN NEW;
  END IF;

  SELECT * INTO predecessor
  FROM task_routing_decisions
  WHERE id = NEW.supersedes_decision_id;
  IF NOT FOUND
     OR predecessor.task_draft_id <> NEW.task_draft_id
     OR predecessor.decision_version <> NEW.decision_version - 1 THEN
    RAISE EXCEPTION 'HXUV1-ROUTE-1: routing revisions must form one exact Task Draft chain'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION publish_universal_routing_decision()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  UPDATE task_drafts
  SET active_routing_decision_id = NEW.id,
      updated_at = clock_timestamp()
  WHERE id = NEW.task_draft_id
    AND (
      active_routing_decision_id IS NULL
      OR EXISTS (
        SELECT 1 FROM task_routing_decisions current_decision
        WHERE current_decision.id = task_drafts.active_routing_decision_id
          AND current_decision.decision_version < NEW.decision_version
      )
    );
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HXUV1-ROUTE-2: routing decision did not advance the active version'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS universal_routing_sequence_guard ON task_routing_decisions;
CREATE TRIGGER universal_routing_sequence_guard
BEFORE INSERT ON task_routing_decisions
FOR EACH ROW EXECUTE FUNCTION enforce_universal_routing_sequence();

DROP TRIGGER IF EXISTS universal_routing_publish ON task_routing_decisions;
CREATE TRIGGER universal_routing_publish
AFTER INSERT ON task_routing_decisions
FOR EACH ROW EXECUTE FUNCTION publish_universal_routing_decision();

CREATE OR REPLACE FUNCTION enforce_provider_estimate_submission()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM quotes quote
    JOIN quote_versions quote_version
      ON quote_version.id = NEW.quote_version_id
     AND quote_version.quote_id = quote.id
    JOIN task_routing_decisions routing
      ON routing.id = NEW.routing_decision_id
    JOIN task_drafts draft
      ON draft.id = routing.task_draft_id
    WHERE quote.id = NEW.quote_id
      AND quote.quote_kind = 'PROVIDER_ESTIMATE'
      AND quote.routing_decision_id = NEW.routing_decision_id
      AND quote.task_draft_id = routing.task_draft_id
      AND draft.active_routing_decision_id = routing.id
      AND routing.outcome = 'ESTIMATE_REQUIRED'
      AND quote_version.version_number = NEW.expected_quote_version
      AND quote_version.expected_quote_version = NEW.expected_quote_version
      AND quote_version.provider_submitted_at IS NOT NULL
      AND quote_version.scope_json = NEW.scope_snapshot
      AND quote_version.scope_hash = NEW.scope_hash
      AND quote_version.total_cents = NEW.customer_total_cents
      AND quote_version.hustler_payout_cents = NEW.provider_payout_cents
      AND (
        quote_version.scope_version_id IS NULL
        OR EXISTS (
          SELECT 1 FROM task_scope_versions scope
          WHERE scope.id = quote_version.scope_version_id
            AND scope.scope_hash = NEW.scope_hash
        )
      )
      AND quote.active_version_id = quote_version.id
      AND quote.provider_user_id IS NOT DISTINCT FROM NEW.provider_user_id
      AND quote.provider_organization_id IS NOT DISTINCT FROM NEW.provider_organization_id
  ) THEN
    RAISE EXCEPTION 'HXUV1-EST-1: provider estimate must bind the routed quote and exact version'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.scope_hash <> encode(digest(NEW.scope_snapshot::text, 'sha256'), 'hex')
     OR NEW.payload_hash <> encode(digest(jsonb_build_object(
       'scopeSnapshot', NEW.scope_snapshot,
       'scopeHash', NEW.scope_hash,
       'lineItems', NEW.line_items,
       'customerTotalCents', NEW.customer_total_cents,
       'providerPayoutCents', NEW.provider_payout_cents,
       'currency', NEW.currency
     )::text, 'sha256'), 'hex') THEN
    RAISE EXCEPTION 'HXUV1-EST-2: immutable estimate scope or payload digest mismatch'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.submitted_by IS DISTINCT FROM NEW.provider_user_id
     AND NOT EXISTS (
       SELECT 1
       FROM business_memberships membership
       WHERE membership.organization_id = NEW.provider_organization_id
         AND membership.user_id = NEW.submitted_by
         AND membership.status = 'ACTIVE'
         AND membership.role IN ('OWNER','ADMIN','DISPATCHER','CREW')
     ) THEN
    RAISE EXCEPTION 'HXUV1-EST-3: estimate submitter lacks provider authority'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS universal_provider_estimate_guard ON provider_estimate_submissions;
CREATE TRIGGER universal_provider_estimate_guard
BEFORE INSERT ON provider_estimate_submissions
FOR EACH ROW EXECUTE FUNCTION enforce_provider_estimate_submission();

CREATE OR REPLACE FUNCTION enforce_universal_eligibility_sequence()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  predecessor task_provider_eligibility_decisions%ROWTYPE;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM task_routing_decisions routing
    JOIN task_drafts draft ON draft.id = routing.task_draft_id
    WHERE routing.id = NEW.routing_decision_id
      AND routing.task_draft_id = NEW.task_draft_id
      AND draft.active_routing_decision_id = routing.id
      AND routing.outcome IN ('FULFILLMENT_CANDIDATE','ESTIMATE_REQUIRED')
      AND (NEW.task_id IS NULL OR draft.task_id = NEW.task_id)
      AND (
        NEW.scope_version_id IS NULL
        OR EXISTS (
          SELECT 1 FROM task_scope_versions scope
          WHERE scope.id = NEW.scope_version_id
            AND scope.task_id = NEW.task_id
        )
      )
  ) THEN
    RAISE EXCEPTION 'HXUV1-ELIG-1: eligibility must bind the active routable Task Draft and exact task scope'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.interest_application_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM task_applications interest
    WHERE interest.id = NEW.interest_application_id
      AND interest.universal_contract_version = 1
      AND interest.authority = 'EXPRESS_INTEREST'
      AND interest.status = 'pending'
      AND interest.task_id = NEW.task_id
      AND interest.hustler_id = NEW.provider_user_id
      AND interest.provider_organization_id IS NOT DISTINCT FROM NEW.provider_organization_id
      AND interest.interest_scope_version_id IS NOT DISTINCT FROM NEW.scope_version_id
  ) THEN
    RAISE EXCEPTION 'HXUV1-ELIG-2: eligibility interest, provider, organization, and scope must agree'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.provider_organization_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM business_memberships membership
    JOIN business_organizations organization ON organization.id = membership.organization_id
    WHERE membership.organization_id = NEW.provider_organization_id
      AND membership.user_id = NEW.provider_user_id
      AND membership.status = 'ACTIVE'
      AND membership.role IN ('OWNER','ADMIN','DISPATCHER','CREW')
      AND organization.status = 'ACTIVE'
      AND organization.provider_enabled IS TRUE
  ) THEN
    RAISE EXCEPTION 'HXUV1-ELIG-3: organization eligibility requires an active provider member'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.decision_version > 1 THEN
    SELECT * INTO predecessor
    FROM task_provider_eligibility_decisions
    WHERE id = NEW.supersedes_decision_id;
    IF NOT FOUND
       OR predecessor.task_draft_id <> NEW.task_draft_id
       OR predecessor.provider_user_id IS DISTINCT FROM NEW.provider_user_id
       OR predecessor.provider_organization_id IS DISTINCT FROM NEW.provider_organization_id
       OR predecessor.decision_version <> NEW.decision_version - 1 THEN
      RAISE EXCEPTION 'HXUV1-ELIG-4: eligibility revisions must form one exact provider chain'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS universal_eligibility_sequence_guard ON task_provider_eligibility_decisions;
CREATE TRIGGER universal_eligibility_sequence_guard
BEFORE INSERT ON task_provider_eligibility_decisions
FOR EACH ROW EXECUTE FUNCTION enforce_universal_eligibility_sequence();

CREATE OR REPLACE FUNCTION enforce_universal_conditional_hold()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.universal_contract_version = 1
     AND NEW.universal_contract_version <> 1 THEN
    RAISE EXCEPTION 'HXUV1-HOLD-5: Universal V1 conditional hold authority cannot be downgraded'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.universal_contract_version <> 1 THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.universal_contract_version = 1 THEN
    IF OLD.task_id IS DISTINCT FROM NEW.task_id
       OR OLD.hustler_id IS DISTINCT FROM NEW.hustler_id
       OR OLD.reserved_by IS DISTINCT FROM NEW.reserved_by
       OR OLD.reserved_at IS DISTINCT FROM NEW.reserved_at
       OR OLD.universal_contract_version IS DISTINCT FROM NEW.universal_contract_version
       OR OLD.hold_kind IS DISTINCT FROM NEW.hold_kind
       OR OLD.interest_application_id IS DISTINCT FROM NEW.interest_application_id
       OR OLD.eligibility_decision_id IS DISTINCT FROM NEW.eligibility_decision_id
       OR OLD.expires_at IS DISTINCT FROM NEW.expires_at THEN
      RAISE EXCEPTION 'HXUV1-HOLD-2: conditional-hold identity and authority bindings are immutable'
        USING ERRCODE = 'P0001';
    END IF;

    IF OLD.status = 'ACTIVE' AND NEW.status IN ('RELEASED','CANCELLED') THEN
      RETURN NEW;
    END IF;
    IF NEW.status = OLD.status THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'HXUV1-HOLD-3: conditional holds only transition once from active to released or cancelled'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'HXUV1-HOLD-4: a new Universal V1 conditional hold must begin active'
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM task_provider_eligibility_decisions eligibility
    JOIN task_applications interest ON interest.id = NEW.interest_application_id
    JOIN task_routing_decisions routing ON routing.id = eligibility.routing_decision_id
    JOIN task_drafts draft ON draft.id = routing.task_draft_id
    JOIN tasks task ON task.id = NEW.task_id
    WHERE eligibility.id = NEW.eligibility_decision_id
      AND eligibility.task_id = NEW.task_id
      AND eligibility.task_eligible IS TRUE
      AND eligibility.valid_until > clock_timestamp()
      AND NOT EXISTS (
        SELECT 1 FROM task_provider_eligibility_decisions newer
        WHERE newer.task_draft_id = eligibility.task_draft_id
          AND newer.provider_user_id = eligibility.provider_user_id
          AND newer.provider_organization_id IS NOT DISTINCT FROM eligibility.provider_organization_id
          AND newer.decision_version > eligibility.decision_version
      )
      AND interest.universal_contract_version = 1
      AND interest.authority = 'EXPRESS_INTEREST'
      AND interest.status = 'pending'
      AND interest.task_id = NEW.task_id
      AND interest.hustler_id = NEW.hustler_id
      AND interest.hustler_id = eligibility.provider_user_id
      AND interest.provider_organization_id IS NOT DISTINCT FROM eligibility.provider_organization_id
      AND (
        eligibility.provider_organization_id IS NULL
        OR EXISTS (
          SELECT 1
          FROM business_memberships membership
          WHERE membership.organization_id = eligibility.provider_organization_id
            AND membership.user_id = eligibility.provider_user_id
            AND membership.status = 'ACTIVE'
            AND membership.role IN ('OWNER','ADMIN','DISPATCHER','CREW')
        )
      )
      AND interest.interest_scope_version_id = task.active_scope_version_id
      AND interest.interest_scope_version_id IS NOT DISTINCT FROM eligibility.scope_version_id
      AND draft.id = eligibility.task_draft_id
      AND draft.task_id = NEW.task_id
      AND draft.active_routing_decision_id = routing.id
      AND routing.outcome = 'FULFILLMENT_CANDIDATE'
  ) THEN
    RAISE EXCEPTION 'HXUV1-HOLD-1: conditional hold requires current exact interest, eligibility, route, provider, and scope'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS universal_conditional_hold_guard ON task_reservations;
CREATE TRIGGER universal_conditional_hold_guard
BEFORE INSERT OR UPDATE ON task_reservations
FOR EACH ROW EXECUTE FUNCTION enforce_universal_conditional_hold();

CREATE OR REPLACE FUNCTION enforce_universal_change_order_proposal()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  predecessor task_scope_change_proposals%ROWTYPE;
  base_scope task_scope_versions%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.universal_contract_version = 1
     AND NEW.universal_contract_version <> 1 THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-15: Universal V1 change-order authority cannot be downgraded'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.universal_contract_version <> 1 THEN
    RETURN NEW;
  END IF;

  SELECT * INTO base_scope FROM task_scope_versions WHERE id = NEW.base_version_id;
  IF NOT FOUND
     OR base_scope.task_id <> NEW.task_id
     OR base_scope.universal_contract_version <> 1
     OR NOT EXISTS (
       SELECT 1 FROM tasks task
       WHERE task.id = NEW.task_id
         AND task.active_scope_version_id = NEW.base_version_id
     ) THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-9: change order must start from the exact active Universal V1 scope'
      USING ERRCODE = 'P0001';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PENDING' OR NEW.approved_version_id IS NOT NULL THEN
      RAISE EXCEPTION 'HXUV1-CHANGE-10: new change order must begin pending without an approved scope'
        USING ERRCODE = 'P0001';
    END IF;
    IF NEW.proposal_version > 1 THEN
      SELECT * INTO predecessor
      FROM task_scope_change_proposals
      WHERE id = NEW.supersedes_proposal_id;
      IF NOT FOUND
         OR predecessor.task_id <> NEW.task_id
         OR predecessor.proposal_version <> NEW.proposal_version - 1
         OR predecessor.status NOT IN ('APPROVED','REJECTED','CANCELED') THEN
        RAISE EXCEPTION 'HXUV1-CHANGE-11: change-order proposals must form one terminally resolved task chain'
          USING ERRCODE = 'P0001';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.universal_contract_version <> 1
     OR OLD.status <> 'PENDING'
     OR NEW.status NOT IN ('APPROVED','REJECTED','CANCELED')
     OR OLD.task_id IS DISTINCT FROM NEW.task_id
     OR OLD.base_version_id IS DISTINCT FROM NEW.base_version_id
     OR OLD.proposed_by IS DISTINCT FROM NEW.proposed_by
     OR OLD.proposer_role IS DISTINCT FROM NEW.proposer_role
     OR OLD.observed_scope_summary IS DISTINCT FROM NEW.observed_scope_summary
     OR OLD.proposed_checklist IS DISTINCT FROM NEW.proposed_checklist
     OR OLD.proposal_version IS DISTINCT FROM NEW.proposal_version
     OR OLD.supersedes_proposal_id IS DISTINCT FROM NEW.supersedes_proposal_id
     OR OLD.change_order_kind IS DISTINCT FROM NEW.change_order_kind
     OR OLD.proposed_customer_total_cents IS DISTINCT FROM NEW.proposed_customer_total_cents
     OR OLD.schedule_effect IS DISTINCT FROM NEW.schedule_effect
     OR OLD.financial_adjustment_required IS DISTINCT FROM NEW.financial_adjustment_required THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-12: change-order identity and proposal facts are immutable'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.status = 'APPROVED' AND (
    NOT EXISTS (
      SELECT 1 FROM task_scope_change_approvals approval
      WHERE approval.proposal_id = NEW.id
        AND approval.approver_role = 'CUSTOMER'
        AND approval.decision = 'APPROVED'
    )
    OR NOT EXISTS (
      SELECT 1 FROM task_scope_change_approvals approval
      WHERE approval.proposal_id = NEW.id
        AND approval.approver_role = 'PROVIDER'
        AND approval.decision = 'APPROVED'
    )
    OR NOT EXISTS (
      SELECT 1
      FROM task_scope_versions approved_scope
      WHERE approved_scope.id = NEW.approved_version_id
        AND approved_scope.task_id = NEW.task_id
        AND approved_scope.universal_contract_version = 1
        AND approved_scope.source = 'APPROVED_CHANGE'
        AND approved_scope.supersedes_version_id = NEW.base_version_id
        AND approved_scope.currency = base_scope.currency
        AND approved_scope.customer_total_cents = COALESCE(
          NEW.proposed_customer_total_cents,
          base_scope.customer_total_cents
        )
    )
  ) THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-13: approval requires both parties and the exact immutable replacement scope'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS universal_change_order_proposal_guard ON task_scope_change_proposals;
CREATE TRIGGER universal_change_order_proposal_guard
BEFORE INSERT OR UPDATE ON task_scope_change_proposals
FOR EACH ROW EXECUTE FUNCTION enforce_universal_change_order_proposal();

CREATE OR REPLACE FUNCTION enforce_universal_change_order_approval()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  proposal task_scope_change_proposals%ROWTYPE;
BEGIN
  SELECT * INTO proposal FROM task_scope_change_proposals WHERE id = NEW.proposal_id;
  IF NOT FOUND
     OR proposal.universal_contract_version <> 1
     OR proposal.proposal_version <> NEW.expected_proposal_version THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-1: change-order decision must bind the exact proposal version'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.approver_role = 'CUSTOMER' AND NOT EXISTS (
    SELECT 1 FROM tasks task
    WHERE task.id = proposal.task_id AND task.poster_id = NEW.actor_id
  ) THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-2: customer change-order decision requires the task owner'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.approver_role = 'PROVIDER' AND NOT EXISTS (
    SELECT 1
    FROM task_work_orders work_order
    WHERE work_order.task_id = proposal.task_id
      AND (
        work_order.provider_user_id = NEW.actor_id
        OR EXISTS (
          SELECT 1 FROM business_memberships membership
          WHERE membership.organization_id = work_order.provider_organization_id
            AND membership.user_id = NEW.actor_id
            AND membership.status = 'ACTIVE'
            AND membership.role IN ('OWNER','ADMIN','DISPATCHER','CREW')
        )
      )
  ) THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-3: provider change-order decision requires Work Order authority'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS universal_change_order_approval_guard ON task_scope_change_approvals;
CREATE TRIGGER universal_change_order_approval_guard
BEFORE INSERT ON task_scope_change_approvals
FOR EACH ROW EXECUTE FUNCTION enforce_universal_change_order_approval();

CREATE OR REPLACE FUNCTION enforce_universal_work_order_amendment()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  work_order task_work_orders%ROWTYPE;
  proposal task_scope_change_proposals%ROWTYPE;
  new_scope task_scope_versions%ROWTYPE;
  previous_scope task_scope_versions%ROWTYPE;
  predecessor task_work_order_amendments%ROWTYPE;
  adjustment task_financial_security_events%ROWTYPE;
BEGIN
  SELECT * INTO work_order FROM task_work_orders WHERE id = NEW.work_order_id;
  SELECT * INTO proposal FROM task_scope_change_proposals WHERE id = NEW.change_order_id;
  SELECT * INTO new_scope FROM task_scope_versions WHERE id = NEW.scope_version_id;

  IF work_order.id IS NULL
     OR proposal.id IS NULL
     OR new_scope.id IS NULL
     OR proposal.universal_contract_version <> 1
     OR proposal.status <> 'APPROVED'
     OR proposal.approved_version_id <> NEW.scope_version_id
     OR new_scope.task_id <> work_order.task_id
     OR new_scope.universal_contract_version <> 1
     OR new_scope.source <> 'APPROVED_CHANGE'
     OR NOT EXISTS (
       SELECT 1 FROM tasks task
       WHERE task.id = work_order.task_id
         AND task.active_scope_version_id = NEW.scope_version_id
     )
     OR NOT EXISTS (
       SELECT 1 FROM task_scope_change_approvals approval
       WHERE approval.proposal_id = proposal.id
         AND approval.approver_role = 'CUSTOMER'
         AND approval.decision = 'APPROVED'
     )
     OR NOT EXISTS (
       SELECT 1 FROM task_scope_change_approvals approval
       WHERE approval.proposal_id = proposal.id
         AND approval.approver_role = 'PROVIDER'
         AND approval.decision = 'APPROVED'
     ) THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-4: Work Order amendment requires dual approval and the exact active scope'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.amendment_version = 1 THEN
    SELECT * INTO previous_scope FROM task_scope_versions WHERE id = work_order.scope_version_id;
  ELSE
    SELECT * INTO predecessor
    FROM task_work_order_amendments
    WHERE id = NEW.supersedes_amendment_id;
    IF NOT FOUND
       OR predecessor.work_order_id <> NEW.work_order_id
       OR predecessor.amendment_version <> NEW.amendment_version - 1 THEN
      RAISE EXCEPTION 'HXUV1-CHANGE-5: Work Order amendments must form one exact scope chain'
        USING ERRCODE = 'P0001';
    END IF;
    SELECT * INTO previous_scope FROM task_scope_versions WHERE id = predecessor.scope_version_id;
  END IF;

  IF previous_scope.id IS NULL THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-8: amendment predecessor scope is unavailable'
      USING ERRCODE = 'P0001';
  END IF;

  IF proposal.task_id <> work_order.task_id
     OR proposal.base_version_id <> previous_scope.id
     OR new_scope.supersedes_version_id <> previous_scope.id
     OR new_scope.version <> previous_scope.version + 1 THEN
    RAISE EXCEPTION 'HXUV1-CHANGE-14: amendment must advance the exact prior Work Order scope by one version'
      USING ERRCODE = 'P0001';
  END IF;

  IF proposal.financial_adjustment_required IS FALSE THEN
    IF NEW.adjustment_event_id IS NOT NULL
       OR new_scope.customer_total_cents <> previous_scope.customer_total_cents
       OR new_scope.currency <> previous_scope.currency THEN
      RAISE EXCEPTION 'HXUV1-CHANGE-6: scope-only amendment cannot change financial authority'
        USING ERRCODE = 'P0001';
    END IF;
  ELSE
    SELECT * INTO adjustment
    FROM task_financial_security_events
    WHERE id = NEW.adjustment_event_id;
    IF NOT FOUND
       OR adjustment.event_kind <> 'ADJUSTMENT_AUTHORIZED'
       OR adjustment.status <> 'SUCCEEDED'
       OR adjustment.task_draft_id <> work_order.task_draft_id
       OR adjustment.task_id <> work_order.task_id
       OR adjustment.eligibility_decision_id <> work_order.eligibility_decision_id
       OR adjustment.scope_version_id <> NEW.scope_version_id
       OR adjustment.change_order_id <> proposal.id
       OR adjustment.amount_cents <> new_scope.customer_total_cents
       OR adjustment.currency <> new_scope.currency THEN
      RAISE EXCEPTION 'HXUV1-CHANGE-7: price amendment requires exact successful adjustment authorization'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS universal_work_order_amendment_guard ON task_work_order_amendments;
CREATE TRIGGER universal_work_order_amendment_guard
BEFORE INSERT ON task_work_order_amendments
FOR EACH ROW EXECUTE FUNCTION enforce_universal_work_order_amendment();

CREATE OR REPLACE FUNCTION enforce_universal_work_order_materialization()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  eligibility task_provider_eligibility_decisions%ROWTYPE;
  hold task_reservations%ROWTYPE;
  financial_event task_financial_security_events%ROWTYPE;
  interest task_applications%ROWTYPE;
  routing task_routing_decisions%ROWTYPE;
  scope task_scope_versions%ROWTYPE;
BEGIN
  SELECT * INTO eligibility
  FROM task_provider_eligibility_decisions
  WHERE id = NEW.eligibility_decision_id;

  IF NOT FOUND
     OR eligibility.task_draft_id <> NEW.task_draft_id
     OR eligibility.task_id IS DISTINCT FROM NEW.task_id
     OR eligibility.scope_version_id IS DISTINCT FROM NEW.scope_version_id
     OR eligibility.routing_decision_id IS DISTINCT FROM NEW.routing_decision_id
     OR eligibility.task_eligible IS NOT TRUE
     OR eligibility.valid_until <= clock_timestamp()
     OR eligibility.provider_user_id IS DISTINCT FROM NEW.provider_user_id
     OR eligibility.provider_organization_id IS DISTINCT FROM NEW.provider_organization_id
     OR EXISTS (
       SELECT 1 FROM task_provider_eligibility_decisions newer
       WHERE newer.task_draft_id = eligibility.task_draft_id
         AND newer.provider_user_id = eligibility.provider_user_id
         AND newer.provider_organization_id IS NOT DISTINCT FROM eligibility.provider_organization_id
         AND newer.decision_version > eligibility.decision_version
     ) THEN
    RAISE EXCEPTION 'HXUV1-WO-1: current task-specific eligibility is required'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO routing FROM task_routing_decisions WHERE id = NEW.routing_decision_id;
  IF NOT FOUND
     OR routing.task_draft_id <> NEW.task_draft_id
     OR routing.outcome <> 'FULFILLMENT_CANDIDATE'
     OR NOT EXISTS (
       SELECT 1 FROM task_drafts draft
       WHERE draft.id = NEW.task_draft_id
         AND draft.task_id = NEW.task_id
         AND draft.active_routing_decision_id = routing.id
     ) THEN
    RAISE EXCEPTION 'HXUV1-WO-8: Work Order requires the active fulfillment route for the exact Task Draft and task'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO scope FROM task_scope_versions WHERE id = NEW.scope_version_id;
  IF NOT FOUND
     OR scope.task_id <> NEW.task_id
     OR scope.universal_contract_version <> 1
     OR scope.currency IS NULL THEN
    RAISE EXCEPTION 'HXUV1-WO-9: Work Order requires an exact Universal V1 scope and currency'
      USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1 FROM tasks task
    WHERE task.id = NEW.task_id
      AND task.license_required IS TRUE
  ) AND eligibility.provider_class <> 'VERIFIED_TRADE_BUSINESS' THEN
    RAISE EXCEPTION 'HXUV1-WO-10: credential-required work must use a verified trade business'
      USING ERRCODE = 'P0001';
  END IF;

  IF eligibility.provider_organization_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM business_memberships membership
    JOIN business_organizations organization
      ON organization.id = membership.organization_id
    WHERE membership.organization_id = eligibility.provider_organization_id
      AND membership.user_id = eligibility.provider_user_id
      AND membership.status = 'ACTIVE'
      AND membership.role IN ('OWNER','ADMIN','DISPATCHER','CREW')
      AND organization.status = 'ACTIVE'
      AND organization.provider_enabled IS TRUE
  ) THEN
    RAISE EXCEPTION 'HXUV1-WO-11: Work Order materialization requires current provider membership'
      USING ERRCODE = 'P0001';
  END IF;

  IF eligibility.provider_class = 'VERIFIED_TRADE_BUSINESS'
     AND NOT EXISTS (
       SELECT 1
       FROM current_verified_trade_qualifications qualification
       JOIN tasks task ON task.id = NEW.task_id
       CROSS JOIN LATERAL unnest(qualification.permitted_work_categories) permitted(category)
       WHERE qualification.business_credential_id = eligibility.trade_credential_id
         AND qualification.provider_user_id = eligibility.provider_user_id
         AND qualification.organization_id = eligibility.provider_organization_id
         AND lower(permitted.category) = lower(task.category)
         AND qualification.jurisdiction_code = task.region_code
     ) THEN
    RAISE EXCEPTION 'HXUV1-WO-6: current jurisdictional trade qualification does not permit this category or region'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO hold FROM task_reservations WHERE id = NEW.conditional_hold_id;
  IF NOT FOUND
     OR hold.task_id <> NEW.task_id
     OR hold.status <> 'ACTIVE'
     OR hold.universal_contract_version <> 1
     OR hold.hold_kind <> 'CONDITIONAL_HOLD'
     OR hold.eligibility_decision_id <> NEW.eligibility_decision_id
     OR hold.interest_application_id <> NEW.interest_application_id
     OR hold.hustler_id IS DISTINCT FROM NEW.provider_user_id
     OR hold.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'HXUV1-WO-2: live conditional hold is required and is not assignment'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO interest FROM task_applications WHERE id = NEW.interest_application_id;
  IF NOT FOUND
     OR interest.task_id <> NEW.task_id
     OR interest.universal_contract_version <> 1
     OR interest.authority <> 'EXPRESS_INTEREST'
     OR interest.status <> 'pending'
     OR interest.hustler_id IS DISTINCT FROM eligibility.provider_user_id
     OR interest.provider_organization_id IS DISTINCT FROM NEW.provider_organization_id
     OR interest.interest_scope_version_id IS DISTINCT FROM NEW.scope_version_id
     OR eligibility.interest_application_id IS DISTINCT FROM interest.id THEN
    RAISE EXCEPTION 'HXUV1-WO-3: matching provider interest is required'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO financial_event
  FROM task_financial_security_events
  WHERE id = NEW.financial_security_event_id;
  IF NOT FOUND
     OR financial_event.task_draft_id <> NEW.task_draft_id
     OR financial_event.task_id IS DISTINCT FROM NEW.task_id
     OR financial_event.eligibility_decision_id IS DISTINCT FROM NEW.eligibility_decision_id
     OR financial_event.scope_version_id IS DISTINCT FROM NEW.scope_version_id
     OR financial_event.event_kind <> 'SECURED'
     OR financial_event.status <> 'SUCCEEDED'
     OR financial_event.amount_cents <> scope.customer_total_cents
     OR financial_event.currency <> scope.currency
     OR (
       financial_event.provider_kind = 'APPROVED_PROVIDER'
       AND (
         eligibility.processor_payment_eligible IS NOT TRUE
         OR eligibility.payout_funding_eligible IS NOT TRUE
       )
     ) THEN
    RAISE EXCEPTION 'HXUV1-WO-4: successful Financial Security Event must precede Work Order'
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM tasks task
    WHERE task.id = NEW.task_id
      AND task.universal_contract_version = 1
      AND task.active_scope_version_id = NEW.scope_version_id
      AND task.worker_id IS NULL
  ) THEN
    RAISE EXCEPTION 'HXUV1-WO-5: exact approved scope is required and assignment must not pre-exist'
      USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1 FROM task_routing_decisions prior_route
    WHERE prior_route.task_draft_id = NEW.task_draft_id
      AND prior_route.outcome = 'ESTIMATE_REQUIRED'
  ) AND NOT EXISTS (
    SELECT 1
    FROM provider_estimate_submissions estimate
    JOIN task_routing_decisions estimate_route
      ON estimate_route.id = estimate.routing_decision_id
    WHERE estimate.id = NEW.provider_estimate_submission_id
      AND estimate_route.task_draft_id = NEW.task_draft_id
      AND estimate_route.outcome = 'ESTIMATE_REQUIRED'
      AND estimate.provider_user_id IS NOT DISTINCT FROM NEW.provider_user_id
      AND estimate.provider_organization_id IS NOT DISTINCT FROM NEW.provider_organization_id
      AND estimate.scope_hash = scope.scope_hash
      AND estimate.customer_total_cents = scope.customer_total_cents
      AND estimate.provider_payout_cents = scope.hustler_payout_cents
      AND estimate.currency = scope.currency
  ) THEN
    RAISE EXCEPTION 'HXUV1-WO-10: estimate-required work must bind the accepted immutable provider estimate'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS universal_work_order_materialization_guard ON task_work_orders;
CREATE TRIGGER universal_work_order_materialization_guard
BEFORE INSERT ON task_work_orders
FOR EACH ROW EXECUTE FUNCTION enforce_universal_work_order_materialization();

CREATE OR REPLACE FUNCTION bind_universal_work_order_to_task()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  UPDATE tasks
  SET work_order_id = NEW.id,
      updated_at = clock_timestamp()
  WHERE id = NEW.task_id
    AND work_order_id IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HXUV1-WO-7: task already has a different Work Order'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS universal_work_order_task_binding ON task_work_orders;
CREATE TRIGGER universal_work_order_task_binding
AFTER INSERT ON task_work_orders
FOR EACH ROW EXECUTE FUNCTION bind_universal_work_order_to_task();

CREATE OR REPLACE FUNCTION is_hustlexp_disposable_assignment_ci()
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT current_user = 'hx_ci_runner'
     AND current_database() IN (
       'hx_ci_invariant_test',
       'hx_ci_system_test',
       'hx_ci_fresh_test',
       'hx_ci_upgrade_test'
     );
$$;

CREATE OR REPLACE FUNCTION enforce_universal_hard_assignment_hold()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.universal_contract_version = 1
     AND NEW.universal_contract_version <> 1 THEN
    RAISE EXCEPTION 'HXUV1-ASSIGN-1: Universal V1 task authority cannot be downgraded'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.universal_contract_version = 1
     AND NEW.worker_id IS NOT NULL
     AND (
       TG_OP = 'INSERT'
       OR OLD.worker_id IS DISTINCT FROM NEW.worker_id
     ) THEN
    RAISE EXCEPTION 'HXUV1-ASSIGN-2: hard assignment remains held pending separate protected capability approval'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.worker_id IS NOT NULL
     AND (
       TG_OP = 'INSERT'
       OR OLD.worker_id IS DISTINCT FROM NEW.worker_id
     )
     AND NOT is_hustlexp_disposable_assignment_ci() THEN
    RAISE EXCEPTION 'HXUV1-ASSIGN-3: hard assignment is denied outside the exact disposable CI database identity'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS universal_hard_assignment_hold ON tasks;
CREATE TRIGGER universal_hard_assignment_hold
BEFORE INSERT OR UPDATE ON tasks
FOR EACH ROW EXECUTE FUNCTION enforce_universal_hard_assignment_hold();

CREATE OR REPLACE FUNCTION enforce_squad_hard_assignment_hold()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF is_hustlexp_disposable_assignment_ci() THEN
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'squad_task_workers' THEN
    RAISE EXCEPTION 'HXUV1-ASSIGN-4: squad worker binding is denied outside the exact disposable CI database identity'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.status IN ('ready', 'in_progress')
     AND (
       TG_OP = 'INSERT'
       OR OLD.status IS DISTINCT FROM NEW.status
     ) THEN
    RAISE EXCEPTION 'HXUV1-ASSIGN-5: squad task activation is denied outside the exact disposable CI database identity'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS universal_squad_worker_assignment_hold ON squad_task_workers;
CREATE TRIGGER universal_squad_worker_assignment_hold
BEFORE INSERT ON squad_task_workers
FOR EACH ROW EXECUTE FUNCTION enforce_squad_hard_assignment_hold();

DROP TRIGGER IF EXISTS universal_squad_task_activation_hold ON squad_task_assignments;
CREATE TRIGGER universal_squad_task_activation_hold
BEFORE INSERT OR UPDATE OF status ON squad_task_assignments
FOR EACH ROW EXECUTE FUNCTION enforce_squad_hard_assignment_hold();

CREATE OR REPLACE FUNCTION enforce_universal_financial_event_sequence()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  predecessor task_financial_security_events%ROWTYPE;
  secured_amount BIGINT;
  refunded_amount BIGINT;
  is_new_operation BOOLEAN := FALSE;
BEGIN
  IF NEW.provider_kind = 'APPROVED_PROVIDER' AND NEW.external_reference IS NULL THEN
    RAISE EXCEPTION 'HXUV1-FIN-5: approved-provider facts require an external reference'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.event_kind = 'PAYMENT_METHOD_PREPARED' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM task_drafts draft
      WHERE draft.id = NEW.task_draft_id
        AND draft.universal_contract_version = 1
        AND (
          NEW.task_id IS NULL
          OR draft.task_id IS NOT DISTINCT FROM NEW.task_id
        )
        AND (
          NEW.eligibility_decision_id IS NULL
          OR EXISTS (
            SELECT 1
            FROM task_provider_eligibility_decisions eligibility
            WHERE eligibility.id = NEW.eligibility_decision_id
              AND eligibility.task_draft_id = NEW.task_draft_id
              AND eligibility.task_id IS NOT DISTINCT FROM NEW.task_id
              AND (
                NEW.scope_version_id IS NULL
                OR eligibility.scope_version_id IS NOT DISTINCT FROM NEW.scope_version_id
              )
          )
        )
    ) THEN
      RAISE EXCEPTION 'HXUV1-FIN-16: financial preparation requires exact Universal V1 Task Draft authority'
        USING ERRCODE = 'P0001';
    END IF;

    INSERT INTO task_financial_operations (
      operation_id,
      task_draft_id,
      task_id,
      eligibility_decision_id,
      scope_version_id,
      change_order_id,
      event_kind,
      provider_kind,
      external_reference,
      amount_cents,
      currency,
      completion_fact_id
    ) VALUES (
      NEW.operation_id,
      NEW.task_draft_id,
      NEW.task_id,
      NEW.eligibility_decision_id,
      NEW.scope_version_id,
      NEW.change_order_id,
      NEW.event_kind,
      NEW.provider_kind,
      NEW.external_reference,
      NEW.amount_cents,
      NEW.currency,
      NEW.completion_fact_id
    );
    RETURN NEW;
  END IF;

  SELECT * INTO predecessor
  FROM task_financial_security_events
  WHERE id = NEW.predecessor_event_id;
  IF NOT FOUND
     OR predecessor.task_draft_id <> NEW.task_draft_id
     OR NOT (
       (
         predecessor.task_id IS NOT DISTINCT FROM NEW.task_id
         AND predecessor.eligibility_decision_id IS NOT DISTINCT FROM NEW.eligibility_decision_id
       )
       OR (
         predecessor.event_kind = 'PAYMENT_METHOD_PREPARED'
         AND NEW.event_kind = 'AUTHORIZED'
         AND predecessor.task_id IS NULL
         AND predecessor.eligibility_decision_id IS NULL
         AND predecessor.scope_version_id IS NULL
       )
     )
     OR predecessor.provider_kind <> NEW.provider_kind
     OR NEW.expected_version <> predecessor.expected_version + 1 THEN
    RAISE EXCEPTION 'HXUV1-FIN-1: financial predecessor must preserve draft, task, eligibility, provider, and exact version'
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM task_provider_eligibility_decisions eligibility
    JOIN task_drafts draft ON draft.id = eligibility.task_draft_id
    JOIN tasks task ON task.id = eligibility.task_id
    WHERE eligibility.id = NEW.eligibility_decision_id
      AND eligibility.task_draft_id = NEW.task_draft_id
      AND eligibility.task_id IS NOT DISTINCT FROM NEW.task_id
      AND draft.task_id IS NOT DISTINCT FROM NEW.task_id
      AND draft.universal_contract_version = 1
      AND task.universal_contract_version = 1
      AND (
        (
          NEW.event_kind = 'ADJUSTMENT_AUTHORIZED'
          AND EXISTS (
            SELECT 1
            FROM task_work_orders work_order
            JOIN task_scope_change_proposals proposal
              ON proposal.id = NEW.change_order_id
            JOIN task_scope_versions approved_scope
              ON approved_scope.id = proposal.approved_version_id
            WHERE work_order.task_draft_id = NEW.task_draft_id
              AND work_order.task_id = NEW.task_id
              AND work_order.eligibility_decision_id = eligibility.id
              AND proposal.task_id = NEW.task_id
              AND proposal.universal_contract_version = 1
              AND proposal.status = 'APPROVED'
              AND proposal.change_order_kind = 'PRICE_AND_SCOPE'
              AND proposal.financial_adjustment_required IS TRUE
              AND proposal.approved_version_id = NEW.scope_version_id
              AND proposal.base_version_id = COALESCE(
                (
                  SELECT amendment.scope_version_id
                  FROM task_work_order_amendments amendment
                  WHERE amendment.work_order_id = work_order.id
                  ORDER BY amendment.amendment_version DESC
                  LIMIT 1
                ),
                work_order.scope_version_id
              )
              AND approved_scope.task_id = NEW.task_id
              AND approved_scope.universal_contract_version = 1
              AND approved_scope.customer_total_cents = NEW.amount_cents
              AND approved_scope.currency = NEW.currency
              AND proposal.proposed_customer_total_cents = NEW.amount_cents
              AND EXISTS (
                SELECT 1
                FROM task_scope_change_approvals approval
                WHERE approval.proposal_id = proposal.id
                  AND approval.approver_role = 'CUSTOMER'
                  AND approval.decision = 'APPROVED'
              )
              AND EXISTS (
                SELECT 1
                FROM task_scope_change_approvals approval
                WHERE approval.proposal_id = proposal.id
                  AND approval.approver_role = 'PROVIDER'
                  AND approval.decision = 'APPROVED'
              )
          )
        )
        OR (
          NEW.event_kind <> 'ADJUSTMENT_AUTHORIZED'
          AND (
            eligibility.scope_version_id IS NOT DISTINCT FROM NEW.scope_version_id
            OR EXISTS (
              SELECT 1
              FROM task_work_orders work_order
              JOIN task_work_order_amendments amendment
                ON amendment.work_order_id = work_order.id
               AND amendment.scope_version_id = NEW.scope_version_id
              WHERE work_order.task_draft_id = NEW.task_draft_id
                AND work_order.task_id = NEW.task_id
                AND work_order.eligibility_decision_id = eligibility.id
                AND NOT EXISTS (
                  SELECT 1
                  FROM task_work_order_amendments newer
                  WHERE newer.work_order_id = amendment.work_order_id
                    AND newer.amendment_version > amendment.amendment_version
                )
            )
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'HXUV1-FIN-16: financial event must bind exact draft, task, eligibility, and authorized scope'
      USING ERRCODE = 'P0001';
  END IF;

  IF predecessor.status IN ('REQUESTED','RETRYABLE_FAILURE') THEN
    IF NEW.event_kind <> predecessor.event_kind
       OR NEW.operation_id <> predecessor.operation_id
       OR NEW.external_reference IS DISTINCT FROM predecessor.external_reference
       OR NEW.scope_version_id IS DISTINCT FROM predecessor.scope_version_id
       OR NEW.change_order_id IS DISTINCT FROM predecessor.change_order_id
       OR NEW.amount_cents IS DISTINCT FROM predecessor.amount_cents
       OR NEW.currency IS DISTINCT FROM predecessor.currency
       OR NEW.completion_fact_id IS DISTINCT FROM predecessor.completion_fact_id THEN
      RAISE EXCEPTION 'HXUV1-FIN-2: retry or outcome must preserve the exact requested financial effect'
        USING ERRCODE = 'P0001';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM task_financial_operations operation
      WHERE operation.operation_id = NEW.operation_id
        AND operation.task_draft_id = NEW.task_draft_id
        AND operation.task_id IS NOT DISTINCT FROM NEW.task_id
        AND operation.eligibility_decision_id IS NOT DISTINCT FROM NEW.eligibility_decision_id
        AND operation.scope_version_id IS NOT DISTINCT FROM NEW.scope_version_id
        AND operation.change_order_id IS NOT DISTINCT FROM NEW.change_order_id
        AND operation.event_kind = NEW.event_kind
        AND operation.provider_kind = NEW.provider_kind
        AND operation.external_reference IS NOT DISTINCT FROM NEW.external_reference
        AND operation.amount_cents IS NOT DISTINCT FROM NEW.amount_cents
        AND operation.currency IS NOT DISTINCT FROM NEW.currency
        AND operation.completion_fact_id IS NOT DISTINCT FROM NEW.completion_fact_id
    ) THEN
      RAISE EXCEPTION 'HXUV1-FIN-17: retry or outcome does not match its immutable operation authority'
        USING ERRCODE = 'P0001';
    END IF;
  ELSE
    IF predecessor.status <> 'SUCCEEDED'
       OR NEW.operation_id = predecessor.operation_id
       OR NOT (
      (NEW.event_kind = 'AUTHORIZED' AND predecessor.event_kind = 'PAYMENT_METHOD_PREPARED')
      OR (NEW.event_kind = 'SECURED' AND predecessor.event_kind IN ('AUTHORIZED','ADJUSTMENT_AUTHORIZED'))
      OR (NEW.event_kind = 'VOIDED' AND predecessor.event_kind IN ('AUTHORIZED','SECURED','ADJUSTMENT_AUTHORIZED'))
      OR (NEW.event_kind = 'ADJUSTMENT_AUTHORIZED' AND predecessor.event_kind IN ('SECURED','ADJUSTMENT_AUTHORIZED'))
      OR (NEW.event_kind = 'CAPTURED' AND predecessor.event_kind IN ('SECURED','ADJUSTMENT_AUTHORIZED'))
      OR (NEW.event_kind = 'REFUNDED' AND predecessor.event_kind IN (
        'CAPTURED','REFUNDED','SETTLEMENT_OBSERVED','FUNDING_OBSERVED',
        'PROVIDER_RELEASED','PAYOUT_OBSERVED','BANK_SETTLEMENT_OBSERVED'
      ))
      OR (NEW.event_kind = 'REVERSED' AND predecessor.event_kind IN (
        'AUTHORIZED','SECURED','ADJUSTMENT_AUTHORIZED','CAPTURED'
      ))
      OR (NEW.event_kind = 'SETTLEMENT_OBSERVED' AND predecessor.event_kind = 'CAPTURED')
      OR (NEW.event_kind = 'FUNDING_OBSERVED' AND predecessor.event_kind = 'SETTLEMENT_OBSERVED')
      OR (NEW.event_kind = 'PROVIDER_RELEASED' AND predecessor.event_kind = 'FUNDING_OBSERVED')
      OR (NEW.event_kind = 'PAYOUT_OBSERVED' AND predecessor.event_kind = 'PROVIDER_RELEASED')
      OR (NEW.event_kind = 'BANK_SETTLEMENT_OBSERVED' AND predecessor.event_kind = 'PAYOUT_OBSERVED')
    ) THEN
      RAISE EXCEPTION 'HXUV1-FIN-3: financial event kind has no authorized predecessor transition'
        USING ERRCODE = 'P0001';
    END IF;
    is_new_operation := TRUE;
  END IF;

  IF NEW.currency IS DISTINCT FROM predecessor.currency
     AND predecessor.currency IS NOT NULL THEN
    RAISE EXCEPTION 'HXUV1-FIN-4: financial event chain cannot change currency'
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM task_scope_versions scope
    WHERE scope.id = NEW.scope_version_id
      AND scope.task_id = NEW.task_id
      AND scope.universal_contract_version = 1
      AND scope.currency = NEW.currency
  ) THEN
    RAISE EXCEPTION 'HXUV1-FIN-11: monetary fact must bind the exact Universal V1 task scope and currency'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.event_kind NOT IN ('AUTHORIZED','ADJUSTMENT_AUTHORIZED')
     AND predecessor.scope_version_id IS NOT NULL
     AND NEW.scope_version_id IS DISTINCT FROM predecessor.scope_version_id THEN
    RAISE EXCEPTION 'HXUV1-FIN-12: financial successor cannot drift from its authorized scope'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.event_kind = 'SECURED'
     AND NEW.amount_cents <> predecessor.amount_cents THEN
    RAISE EXCEPTION 'HXUV1-FIN-6: security requires a distinct equal authorization fact'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.event_kind IN ('VOIDED','REVERSED')
     AND NEW.amount_cents <> predecessor.amount_cents THEN
    RAISE EXCEPTION 'HXUV1-FIN-15: void and reversal must equal the exact authority they terminate'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.event_kind = 'ADJUSTMENT_AUTHORIZED' AND (
    NEW.change_order_id IS NULL
    OR NEW.scope_version_id IS NULL
  ) THEN
    RAISE EXCEPTION 'HXUV1-FIN-7: adjustment authorization must bind the exact change order and scope'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.event_kind IN (
    'SETTLEMENT_OBSERVED','FUNDING_OBSERVED','PAYOUT_OBSERVED','BANK_SETTLEMENT_OBSERVED'
  ) AND NEW.amount_cents <> predecessor.amount_cents THEN
    RAISE EXCEPTION 'HXUV1-FIN-13: observed settlement, funding, payout, and bank facts must preserve predecessor amount'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.event_kind = 'PROVIDER_RELEASED' AND NOT EXISTS (
    SELECT 1 FROM task_scope_versions scope
    WHERE scope.id = NEW.scope_version_id
      AND scope.hustler_payout_cents = NEW.amount_cents
  ) THEN
    RAISE EXCEPTION 'HXUV1-FIN-14: provider release must equal the immutable provider payout amount'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.event_kind = 'CAPTURED' AND NEW.status = 'SUCCEEDED' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM task_work_orders work_order
      JOIN task_completion_facts completion ON completion.work_order_id = work_order.id
      WHERE work_order.task_id = NEW.task_id
        AND completion.id = NEW.completion_fact_id
        AND completion.scope_version_id = NEW.scope_version_id
        AND completion.fact_kind = 'APPROVED'
        AND completion.incident_gate = 'CLEAR'
        AND completion.customer_notice_at IS NOT NULL
        AND completion.amount_approved_cents = NEW.amount_cents
        AND NOT EXISTS (
          SELECT 1 FROM task_completion_facts newer
          WHERE newer.work_order_id = completion.work_order_id
            AND newer.completion_version > completion.completion_version
        )
        AND NOT EXISTS (
          SELECT 1 FROM task_safety_incidents incident
          WHERE incident.task_id = work_order.task_id
            AND incident.status NOT IN ('resolved','closed')
        )
    ) THEN
      RAISE EXCEPTION 'HXUV1-FIN-8: capture requires the current approved completion, amount, safety, and delivery facts'
      USING ERRCODE = 'P0001';
    END IF;
    IF NEW.amount_cents > predecessor.amount_cents THEN
      RAISE EXCEPTION 'HXUV1-FIN-9: capture cannot exceed secured or adjusted authority'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF NEW.event_kind = 'REFUNDED' AND NEW.status = 'SUCCEEDED' THEN
    SELECT amount_cents INTO secured_amount
    FROM task_financial_security_events
    WHERE task_draft_id = NEW.task_draft_id
      AND task_id IS NOT DISTINCT FROM NEW.task_id
      AND eligibility_decision_id IS NOT DISTINCT FROM NEW.eligibility_decision_id
      AND scope_version_id IS NOT DISTINCT FROM NEW.scope_version_id
      AND event_kind = 'CAPTURED'
      AND status = 'SUCCEEDED'
      AND currency = NEW.currency
    ORDER BY expected_version DESC
    LIMIT 1;
    SELECT COALESCE(sum(amount_cents), 0) INTO refunded_amount
    FROM task_financial_security_events
    WHERE task_draft_id = NEW.task_draft_id
      AND task_id IS NOT DISTINCT FROM NEW.task_id
      AND eligibility_decision_id IS NOT DISTINCT FROM NEW.eligibility_decision_id
      AND scope_version_id IS NOT DISTINCT FROM NEW.scope_version_id
      AND event_kind = 'REFUNDED'
      AND status = 'SUCCEEDED'
      AND currency = NEW.currency;
    IF secured_amount IS NULL OR refunded_amount + NEW.amount_cents > secured_amount THEN
      RAISE EXCEPTION 'HXUV1-FIN-10: cumulative refunds cannot exceed the successful capture'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF is_new_operation THEN
    INSERT INTO task_financial_operations (
      operation_id,
      task_draft_id,
      task_id,
      eligibility_decision_id,
      scope_version_id,
      change_order_id,
      event_kind,
      provider_kind,
      external_reference,
      amount_cents,
      currency,
      completion_fact_id
    ) VALUES (
      NEW.operation_id,
      NEW.task_draft_id,
      NEW.task_id,
      NEW.eligibility_decision_id,
      NEW.scope_version_id,
      NEW.change_order_id,
      NEW.event_kind,
      NEW.provider_kind,
      NEW.external_reference,
      NEW.amount_cents,
      NEW.currency,
      NEW.completion_fact_id
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS universal_financial_event_sequence_guard ON task_financial_security_events;
CREATE TRIGGER universal_financial_event_sequence_guard
BEFORE INSERT ON task_financial_security_events
FOR EACH ROW EXECUTE FUNCTION enforce_universal_financial_event_sequence();

CREATE OR REPLACE FUNCTION universal_proof_snapshot_hash(p_proof_id UUID)
RETURNS CHAR(64) LANGUAGE sql STABLE AS $$
  SELECT encode(digest(jsonb_build_object(
    'proofId', proof.id,
    'taskId', proof.task_id,
    'submitterId', proof.submitter_id,
    'state', proof.state,
    'description', proof.description,
    'scopeVersionId', proof.scope_version_id,
    'scopeVersionHash', proof.scope_version_hash,
    'workOrderId', proof.work_order_id,
    'evidenceKind', proof.evidence_kind,
    'photos', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', photo.id,
        'storageKey', photo.storage_key,
        'contentType', photo.content_type,
        'fileSizeBytes', photo.file_size_bytes,
        'checksumSha256', photo.checksum_sha256,
        'sequenceNumber', photo.sequence_number
      ) ORDER BY photo.sequence_number, photo.id), '[]'::JSONB)
      FROM proof_photos photo
      WHERE photo.proof_id = proof.id
    ),
    'videos', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', video.id,
        'storageKey', video.storage_key,
        'contentType', video.content_type,
        'fileSizeBytes', video.file_size_bytes,
        'durationSeconds', video.duration_seconds,
        'sequenceNumber', video.sequence_number
      ) ORDER BY video.sequence_number, video.id), '[]'::JSONB)
      FROM proof_videos video
      WHERE video.proof_id = proof.id
    )
  )::text, 'sha256'), 'hex')::CHAR(64)
  FROM proofs proof
  WHERE proof.id = p_proof_id;
$$;

CREATE OR REPLACE FUNCTION enforce_universal_completion_bindings()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  predecessor task_completion_facts%ROWTYPE;
  effective_scope_id UUID;
BEGIN
  NEW.proof_snapshot_hash := universal_proof_snapshot_hash(NEW.proof_id);
  IF NEW.proof_snapshot_hash IS NULL THEN
    RAISE EXCEPTION 'HXUV1-COMP-4: completion requires a durable proof snapshot'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.completion_version = 1 AND NEW.fact_kind <> 'SUBMITTED' THEN
    RAISE EXCEPTION 'HXUV1-COMP-5: a completion chain must begin with provider submission'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.completion_version > 1 THEN
    SELECT * INTO predecessor
    FROM task_completion_facts
    WHERE id = NEW.supersedes_fact_id;
    IF NOT FOUND
       OR predecessor.work_order_id <> NEW.work_order_id
       OR predecessor.task_id <> NEW.task_id
       OR predecessor.scope_version_id <> NEW.scope_version_id
       OR predecessor.completion_version <> NEW.completion_version - 1
       OR NOT (
         (
           predecessor.fact_kind = 'SUBMITTED'
           AND NEW.fact_kind IN ('APPROVED','REJECTED')
           AND NEW.proof_id = predecessor.proof_id
         )
         OR (
           predecessor.fact_kind = 'REJECTED'
           AND NEW.fact_kind = 'SUBMITTED'
         )
       ) THEN
      RAISE EXCEPTION 'HXUV1-COMP-2: completion facts must form one exact Work Order chain'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  SELECT COALESCE(
    (
      SELECT amendment.scope_version_id
      FROM task_work_order_amendments amendment
      WHERE amendment.work_order_id = NEW.work_order_id
      ORDER BY amendment.amendment_version DESC
      LIMIT 1
    ),
    work_order.scope_version_id
  ) INTO effective_scope_id
  FROM task_work_orders work_order
  WHERE work_order.id = NEW.work_order_id;

  IF NOT EXISTS (
    SELECT 1
    FROM task_work_orders work_order
    JOIN proofs proof ON proof.id = NEW.proof_id
    JOIN tasks task ON task.id = work_order.task_id
    JOIN task_scope_versions scope ON scope.id = NEW.scope_version_id
    WHERE work_order.id = NEW.work_order_id
      AND work_order.task_id = NEW.task_id
      AND NEW.scope_version_id = effective_scope_id
      AND task.active_scope_version_id = NEW.scope_version_id
      AND scope.task_id = NEW.task_id
      AND scope.universal_contract_version = 1
      AND proof.task_id = NEW.task_id
      AND proof.work_order_id = NEW.work_order_id
      AND proof.scope_version_id = NEW.scope_version_id
      AND proof.scope_version_hash = scope.scope_hash
      AND proof.evidence_kind = 'COMPLETION'
      AND (
        proof.submitter_id = work_order.provider_user_id
        OR EXISTS (
          SELECT 1 FROM business_memberships membership
          WHERE membership.organization_id = work_order.provider_organization_id
            AND membership.user_id = proof.submitter_id
            AND membership.status = 'ACTIVE'
            AND membership.role IN ('OWNER','ADMIN','DISPATCHER','CREW')
        )
      )
      AND (
        (NEW.fact_kind = 'SUBMITTED' AND proof.state IN ('SUBMITTED','ACCEPTED'))
        OR (NEW.fact_kind = 'APPROVED' AND proof.state = 'ACCEPTED')
        OR (NEW.fact_kind = 'REJECTED' AND proof.state = 'REJECTED')
      )
      AND (
        (
          NEW.fact_kind = 'SUBMITTED'
          AND NEW.actor_role = 'PROVIDER'
          AND NEW.actor_id = proof.submitter_id
        )
        OR (
          NEW.fact_kind IN ('APPROVED','REJECTED')
          AND (
            (
              NEW.actor_role = 'CUSTOMER'
              AND NEW.actor_id = task.poster_id
            )
            OR (
              NEW.actor_role = 'NAMED_OPERATOR'
              AND EXISTS (
                SELECT 1 FROM admin_roles operator
                WHERE operator.user_id = NEW.actor_id
                  AND (
                    operator.can_resolve_disputes IS TRUE
                    OR operator.can_manage_incidents IS TRUE
                  )
              )
            )
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'HXUV1-COMP-1: completion must bind the exact Work Order, scope, and proof state'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.fact_kind = 'APPROVED' AND (
    NOT EXISTS (
      SELECT 1
      FROM task_completion_delivery_events delivery
      WHERE delivery.id = NEW.delivery_event_id
        AND delivery.task_id = NEW.task_id
        AND delivery.delivered_at = NEW.customer_notice_at
    )
    OR EXISTS (
      SELECT 1 FROM task_safety_incidents incident
      WHERE incident.task_id = NEW.task_id
        AND incident.status NOT IN ('resolved','closed')
    )
    OR NOT EXISTS (
      SELECT 1 FROM task_scope_versions scope
      WHERE scope.id = NEW.scope_version_id
        AND scope.customer_total_cents = NEW.amount_approved_cents
    )
  ) THEN
    RAISE EXCEPTION 'HXUV1-COMP-3: approval requires provider-authenticated delivery, clear safety, and exact scope amount'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS universal_completion_bindings_guard ON task_completion_facts;
CREATE TRIGGER universal_completion_bindings_guard
BEFORE INSERT ON task_completion_facts
FOR EACH ROW EXECUTE FUNCTION enforce_universal_completion_bindings();

CREATE OR REPLACE FUNCTION enforce_universal_reconciliation_bindings()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  predecessor task_reconciliation_facts%ROWTYPE;
  work_order task_work_orders%ROWTYPE;
  scope task_scope_versions%ROWTYPE;
  void_event task_financial_security_events%ROWTYPE;
  capture task_financial_security_events%ROWTYPE;
  refund task_financial_security_events%ROWTYPE;
  reversal task_financial_security_events%ROWTYPE;
  settlement task_financial_security_events%ROWTYPE;
  funding task_financial_security_events%ROWTYPE;
  provider_release task_financial_security_events%ROWTYPE;
  payout task_financial_security_events%ROWTYPE;
  bank_settlement task_financial_security_events%ROWTYPE;
  total_refunded BIGINT;
BEGIN
  IF NEW.expected_version <> NEW.reconciliation_version - 1 THEN
    RAISE EXCEPTION 'HXUV1-REC-1: reconciliation expected version must name the prior Work Order snapshot'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.reconciliation_version > 1 THEN
    SELECT * INTO predecessor
    FROM task_reconciliation_facts
    WHERE id = NEW.supersedes_fact_id;
    IF NOT FOUND
       OR predecessor.work_order_id <> NEW.work_order_id
       OR predecessor.reconciliation_version <> NEW.reconciliation_version - 1 THEN
      RAISE EXCEPTION 'HXUV1-REC-2: reconciliation revisions must form one exact Work Order chain'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  SELECT * INTO work_order FROM task_work_orders WHERE id = NEW.work_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HXUV1-REC-3: reconciliation requires an existing Work Order'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO scope
  FROM task_scope_versions
  WHERE id = COALESCE(
    (
      SELECT amendment.scope_version_id
      FROM task_work_order_amendments amendment
      WHERE amendment.work_order_id = NEW.work_order_id
      ORDER BY amendment.amendment_version DESC
      LIMIT 1
    ),
    work_order.scope_version_id
  );

  IF NEW.void_event_id IS NOT NULL THEN
    SELECT * INTO void_event FROM task_financial_security_events WHERE id = NEW.void_event_id;
    IF NOT FOUND OR void_event.event_kind <> 'VOIDED'
       OR void_event.task_id <> work_order.task_id
       OR void_event.scope_version_id <> scope.id
       OR void_event.currency <> NEW.currency
       OR void_event.amount_cents <> scope.customer_total_cents
       OR NOT (
         (NEW.void_state = 'VOIDED' AND void_event.status = 'SUCCEEDED')
         OR (NEW.void_state = 'PENDING' AND void_event.status IN ('REQUESTED','RETRYABLE_FAILURE'))
         OR (NEW.void_state = 'FAILED' AND void_event.status IN ('DECLINED','FAILED'))
         OR NEW.void_state = 'MISMATCH'
       ) THEN
      RAISE EXCEPTION 'HXUV1-REC-14: void state requires its own exact fact'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF NEW.capture_event_id IS NOT NULL THEN
    SELECT * INTO capture FROM task_financial_security_events WHERE id = NEW.capture_event_id;
    IF NOT FOUND OR capture.event_kind <> 'CAPTURED'
       OR capture.task_id <> work_order.task_id
       OR capture.scope_version_id <> scope.id
       OR capture.currency <> NEW.currency
       OR capture.amount_cents <> scope.customer_total_cents
       OR NOT (
         (NEW.capture_state = 'CAPTURED' AND capture.status = 'SUCCEEDED')
         OR (NEW.capture_state = 'PENDING' AND capture.status IN ('REQUESTED','RETRYABLE_FAILURE'))
         OR NEW.capture_state = 'MISMATCH'
       ) THEN
      RAISE EXCEPTION 'HXUV1-REC-4: capture state requires the exact capture fact'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF NEW.refund_event_id IS NOT NULL THEN
    SELECT * INTO refund FROM task_financial_security_events WHERE id = NEW.refund_event_id;
    IF NOT FOUND OR refund.event_kind <> 'REFUNDED'
       OR refund.task_id <> work_order.task_id
       OR refund.scope_version_id <> scope.id
       OR refund.currency <> NEW.currency
       OR NOT (
         (NEW.refund_state = 'REFUNDED' AND refund.status = 'SUCCEEDED')
         OR (NEW.refund_state = 'PENDING' AND refund.status IN ('REQUESTED','RETRYABLE_FAILURE'))
         OR (NEW.refund_state = 'FAILED' AND refund.status IN ('DECLINED','FAILED'))
         OR NEW.refund_state = 'MISMATCH'
       ) THEN
      RAISE EXCEPTION 'HXUV1-REC-5: refund state requires its own exact fact'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF NEW.reversal_event_id IS NOT NULL THEN
    SELECT * INTO reversal FROM task_financial_security_events WHERE id = NEW.reversal_event_id;
    IF NOT FOUND OR reversal.event_kind <> 'REVERSED'
       OR reversal.task_id <> work_order.task_id
       OR reversal.scope_version_id <> scope.id
       OR reversal.currency <> NEW.currency
       OR reversal.amount_cents <> scope.customer_total_cents
       OR NOT (
         (NEW.reversal_state = 'REVERSED' AND reversal.status = 'SUCCEEDED')
         OR (NEW.reversal_state = 'PENDING' AND reversal.status IN ('REQUESTED','RETRYABLE_FAILURE'))
         OR (NEW.reversal_state = 'FAILED' AND reversal.status IN ('DECLINED','FAILED'))
         OR NEW.reversal_state = 'MISMATCH'
       ) THEN
      RAISE EXCEPTION 'HXUV1-REC-6: reversal state requires its own exact fact'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF NEW.settlement_event_id IS NOT NULL THEN
    SELECT * INTO settlement FROM task_financial_security_events WHERE id = NEW.settlement_event_id;
    IF NOT FOUND OR settlement.event_kind <> 'SETTLEMENT_OBSERVED'
       OR settlement.task_id <> work_order.task_id
       OR settlement.scope_version_id <> scope.id
       OR settlement.currency <> NEW.currency
       OR settlement.amount_cents <> scope.customer_total_cents
       OR NOT (
         (NEW.settlement_state = 'SETTLED' AND settlement.status = 'SUCCEEDED')
         OR (NEW.settlement_state = 'PENDING' AND settlement.status IN ('REQUESTED','RETRYABLE_FAILURE'))
         OR (NEW.settlement_state = 'FAILED' AND settlement.status IN ('DECLINED','FAILED'))
         OR NEW.settlement_state = 'MISMATCH'
       ) THEN
      RAISE EXCEPTION 'HXUV1-REC-7: settlement requires its own exact fact'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF NEW.funding_event_id IS NOT NULL THEN
    SELECT * INTO funding FROM task_financial_security_events WHERE id = NEW.funding_event_id;
    IF NOT FOUND OR funding.event_kind <> 'FUNDING_OBSERVED'
       OR funding.task_id <> work_order.task_id
       OR funding.scope_version_id <> scope.id
       OR funding.currency <> NEW.currency
       OR funding.amount_cents <> scope.customer_total_cents
       OR NOT (
         (NEW.funding_state = 'FUNDED' AND funding.status = 'SUCCEEDED')
         OR (NEW.funding_state = 'PENDING' AND funding.status IN ('REQUESTED','RETRYABLE_FAILURE'))
         OR (NEW.funding_state = 'FAILED' AND funding.status IN ('DECLINED','FAILED'))
         OR NEW.funding_state = 'MISMATCH'
       ) THEN
      RAISE EXCEPTION 'HXUV1-REC-8: funding requires its own exact fact'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF NEW.provider_release_event_id IS NOT NULL THEN
    SELECT * INTO provider_release
    FROM task_financial_security_events WHERE id = NEW.provider_release_event_id;
    IF NOT FOUND OR provider_release.event_kind <> 'PROVIDER_RELEASED'
       OR provider_release.task_id <> work_order.task_id
       OR provider_release.scope_version_id <> scope.id
       OR provider_release.currency <> NEW.currency
       OR provider_release.amount_cents <> scope.hustler_payout_cents
       OR NOT (
         (NEW.provider_release_state = 'RELEASED' AND provider_release.status = 'SUCCEEDED')
         OR (NEW.provider_release_state = 'PENDING' AND provider_release.status IN ('REQUESTED','RETRYABLE_FAILURE'))
         OR (NEW.provider_release_state = 'FAILED' AND provider_release.status IN ('DECLINED','FAILED'))
         OR NEW.provider_release_state = 'MISMATCH'
       ) THEN
      RAISE EXCEPTION 'HXUV1-REC-9: provider release requires its own exact fact'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF NEW.payout_event_id IS NOT NULL THEN
    SELECT * INTO payout FROM task_financial_security_events WHERE id = NEW.payout_event_id;
    IF NOT FOUND OR payout.event_kind <> 'PAYOUT_OBSERVED'
       OR payout.task_id <> work_order.task_id
       OR payout.scope_version_id <> scope.id
       OR payout.currency <> NEW.currency
       OR payout.amount_cents <> scope.hustler_payout_cents
       OR NOT (
         (NEW.payout_state = 'PAID' AND payout.status = 'SUCCEEDED')
         OR (NEW.payout_state = 'PENDING' AND payout.status IN ('REQUESTED','RETRYABLE_FAILURE'))
         OR (NEW.payout_state = 'FAILED' AND payout.status IN ('DECLINED','FAILED'))
         OR NEW.payout_state = 'MISMATCH'
       ) THEN
      RAISE EXCEPTION 'HXUV1-REC-10: payout requires its own exact fact and is not release'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF NEW.bank_settlement_event_id IS NOT NULL THEN
    SELECT * INTO bank_settlement
    FROM task_financial_security_events WHERE id = NEW.bank_settlement_event_id;
    IF NOT FOUND OR bank_settlement.event_kind <> 'BANK_SETTLEMENT_OBSERVED'
       OR bank_settlement.task_id <> work_order.task_id
       OR bank_settlement.scope_version_id <> scope.id
       OR bank_settlement.currency <> NEW.currency
       OR bank_settlement.amount_cents <> scope.hustler_payout_cents
       OR NOT (
         (NEW.bank_settlement_state = 'SETTLED' AND bank_settlement.status = 'SUCCEEDED')
         OR (NEW.bank_settlement_state = 'PENDING' AND bank_settlement.status IN ('REQUESTED','RETRYABLE_FAILURE'))
         OR (NEW.bank_settlement_state = 'FAILED' AND bank_settlement.status IN ('DECLINED','FAILED'))
         OR NEW.bank_settlement_state = 'MISMATCH'
       ) THEN
      RAISE EXCEPTION 'HXUV1-REC-11: release and payout are never bank settlement'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF NEW.reconciliation_state IN ('MATCHED','CLOSED') THEN
    SELECT COALESCE(sum(event.amount_cents), 0) INTO total_refunded
    FROM task_financial_security_events event
    WHERE event.task_draft_id = work_order.task_draft_id
      AND event.task_id = work_order.task_id
      AND event.eligibility_decision_id = work_order.eligibility_decision_id
      AND event.scope_version_id = scope.id
      AND event.event_kind = 'REFUNDED'
      AND event.status = 'SUCCEEDED'
      AND event.currency = NEW.currency;

    IF NEW.reconciliation_state = 'CLOSED'
       AND (
         NEW.void_state = 'VOIDED'
         OR NEW.reversal_state = 'REVERSED'
         OR (
           NEW.capture_state = 'CAPTURED'
           AND NEW.refund_state = 'REFUNDED'
           AND NEW.settlement_state = 'NOT_APPLICABLE'
         )
       ) THEN
      IF NEW.customer_ledger_amount_cents <> 0
         OR NEW.provider_ledger_amount_cents <> 0
         OR (
           NEW.refund_state = 'REFUNDED'
           AND total_refunded <> scope.customer_total_cents
         ) THEN
        RAISE EXCEPTION 'HXUV1-REC-12: closed negative path must reconcile exact zero-value ledgers'
          USING ERRCODE = 'P0001';
      END IF;
    ELSIF NEW.customer_ledger_amount_cents <> scope.customer_total_cents - total_refunded
       OR NEW.provider_ledger_amount_cents <> scope.hustler_payout_cents THEN
      RAISE EXCEPTION 'HXUV1-REC-12: matched reconciliation amounts must equal the immutable customer and provider ledgers'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF EXISTS (
    WITH RECURSIVE authority_chain(event_id) AS (
      SELECT work_order.financial_security_event_id
      UNION
      SELECT successor.id
      FROM task_financial_security_events successor
      JOIN authority_chain predecessor
        ON successor.predecessor_event_id = predecessor.event_id
    )
    SELECT 1
    FROM unnest(ARRAY[
      NEW.void_event_id,
      NEW.capture_event_id,
      NEW.refund_event_id,
      NEW.reversal_event_id,
      NEW.settlement_event_id,
      NEW.funding_event_id,
      NEW.provider_release_event_id,
      NEW.payout_event_id,
      NEW.bank_settlement_event_id
    ]) AS linked(event_id)
    JOIN task_financial_security_events event ON event.id = linked.event_id
    WHERE linked.event_id IS NOT NULL
      AND (
        event.task_draft_id IS DISTINCT FROM work_order.task_draft_id
        OR event.task_id IS DISTINCT FROM work_order.task_id
        OR event.eligibility_decision_id IS DISTINCT FROM work_order.eligibility_decision_id
        OR NOT EXISTS (
          SELECT 1 FROM authority_chain chain
          WHERE chain.event_id = event.id
        )
      )
  ) THEN
    RAISE EXCEPTION 'HXUV1-REC-13: every reconciliation fact must belong to the exact Work Order authority'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS universal_reconciliation_bindings_guard ON task_reconciliation_facts;
CREATE TRIGGER universal_reconciliation_bindings_guard
BEFORE INSERT ON task_reconciliation_facts
FOR EACH ROW EXECUTE FUNCTION enforce_universal_reconciliation_bindings();

CREATE OR REPLACE FUNCTION enforce_universal_active_scope_transition()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  active_scope task_scope_versions%ROWTYPE;
  approved_proposal_id UUID;
  existing_work_order_id UUID;
BEGIN
  IF NEW.universal_contract_version <> 1 THEN
    RETURN NEW;
  END IF;

  SELECT * INTO active_scope
  FROM task_scope_versions
  WHERE id = NEW.active_scope_version_id;
  IF NOT FOUND
     OR active_scope.task_id <> NEW.id
     OR active_scope.universal_contract_version <> 1 THEN
    RAISE EXCEPTION 'HXUV1-SCOPE-1: Universal V1 task must bind its exact durable scope'
      USING ERRCODE = 'P0001';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF active_scope.source <> 'INITIAL'
       OR active_scope.version <> 1
       OR active_scope.supersedes_version_id IS NOT NULL THEN
      RAISE EXCEPTION 'HXUV1-SCOPE-2: initial Universal V1 scope must begin the immutable task scope chain'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.universal_contract_version <> 1
     OR OLD.active_scope_version_id IS NULL THEN
    IF active_scope.source <> 'INITIAL'
       OR active_scope.version <> 1
       OR active_scope.supersedes_version_id IS NOT NULL THEN
      RAISE EXCEPTION 'HXUV1-SCOPE-2: initial Universal V1 scope must begin the immutable task scope chain'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.active_scope_version_id = OLD.active_scope_version_id THEN
    RETURN NEW;
  END IF;

  IF active_scope.source <> 'APPROVED_CHANGE'
     OR active_scope.supersedes_version_id <> OLD.active_scope_version_id
     OR NOT EXISTS (
       SELECT 1
       FROM task_scope_versions prior_scope
       WHERE prior_scope.id = OLD.active_scope_version_id
         AND prior_scope.task_id = NEW.id
         AND prior_scope.universal_contract_version = 1
         AND active_scope.version = prior_scope.version + 1
     ) THEN
    RAISE EXCEPTION 'HXUV1-SCOPE-3: active scope can only advance one exact immutable version'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT proposal.id INTO approved_proposal_id
  FROM task_scope_change_proposals proposal
  WHERE proposal.task_id = NEW.id
    AND proposal.universal_contract_version = 1
    AND proposal.status = 'APPROVED'
    AND proposal.base_version_id = OLD.active_scope_version_id
    AND proposal.approved_version_id = NEW.active_scope_version_id
    AND EXISTS (
      SELECT 1 FROM task_scope_change_approvals approval
      WHERE approval.proposal_id = proposal.id
        AND approval.approver_role = 'CUSTOMER'
        AND approval.decision = 'APPROVED'
    )
    AND EXISTS (
      SELECT 1 FROM task_scope_change_approvals approval
      WHERE approval.proposal_id = proposal.id
        AND approval.approver_role = 'PROVIDER'
        AND approval.decision = 'APPROVED'
    )
  ORDER BY proposal.proposal_version DESC
  LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HXUV1-SCOPE-4: active scope transition requires the exact dual-approved change order'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT work_order.id INTO existing_work_order_id
  FROM task_work_orders work_order
  WHERE work_order.task_id = NEW.id;
  IF FOUND AND NOT EXISTS (
    SELECT 1
    FROM task_work_order_amendments amendment
    WHERE amendment.work_order_id = existing_work_order_id
      AND amendment.change_order_id = approved_proposal_id
      AND amendment.scope_version_id = NEW.active_scope_version_id
  ) THEN
    RAISE EXCEPTION 'HXUV1-SCOPE-5: active Work Order scope transition requires its exact amendment fact'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS universal_active_scope_transition_guard ON tasks;
CREATE CONSTRAINT TRIGGER universal_active_scope_transition_guard
AFTER INSERT OR UPDATE ON tasks
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_universal_active_scope_transition();

CREATE OR REPLACE FUNCTION enforce_universal_proof_binding_immutability()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (
      SELECT 1 FROM task_completion_facts completion
      WHERE completion.proof_id = OLD.id
    ) THEN
      RAISE EXCEPTION 'HXUV1-PROOF-1: proof referenced by a completion fact cannot be deleted'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.work_order_id IS NOT NULL AND (
    OLD.task_id IS DISTINCT FROM NEW.task_id
    OR OLD.submitter_id IS DISTINCT FROM NEW.submitter_id
    OR OLD.scope_version_id IS DISTINCT FROM NEW.scope_version_id
    OR OLD.scope_version_hash IS DISTINCT FROM NEW.scope_version_hash
    OR OLD.work_order_id IS DISTINCT FROM NEW.work_order_id
    OR OLD.evidence_kind IS DISTINCT FROM NEW.evidence_kind
  ) THEN
    RAISE EXCEPTION 'HXUV1-PROOF-2: Work Order proof identity and scope bindings are immutable'
      USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1 FROM task_completion_facts completion
    WHERE completion.proof_id = OLD.id
  ) AND OLD.description IS DISTINCT FROM NEW.description THEN
    RAISE EXCEPTION 'HXUV1-PROOF-3: submitted completion proof content is immutable'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS universal_proof_binding_immutable ON proofs;
CREATE TRIGGER universal_proof_binding_immutable
BEFORE UPDATE OR DELETE ON proofs
FOR EACH ROW EXECUTE FUNCTION enforce_universal_proof_binding_immutability();

CREATE OR REPLACE FUNCTION enforce_universal_proof_media_immutability()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  bound_proof_id UUID;
BEGIN
  bound_proof_id := CASE WHEN TG_OP = 'INSERT' THEN NEW.proof_id ELSE OLD.proof_id END;
  IF EXISTS (
    SELECT 1 FROM task_completion_facts completion
    WHERE completion.proof_id = bound_proof_id
  ) THEN
    RAISE EXCEPTION 'HXUV1-PROOF-4: submitted completion proof media is immutable'
      USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS universal_proof_photos_immutable ON proof_photos;
CREATE TRIGGER universal_proof_photos_immutable
BEFORE INSERT OR UPDATE OR DELETE ON proof_photos
FOR EACH ROW EXECUTE FUNCTION enforce_universal_proof_media_immutability();

DROP TRIGGER IF EXISTS universal_proof_videos_immutable ON proof_videos;
CREATE TRIGGER universal_proof_videos_immutable
BEFORE INSERT OR UPDATE OR DELETE ON proof_videos
FOR EACH ROW EXECUTE FUNCTION enforce_universal_proof_media_immutability();

-- Every newly introduced decision/fact is append-only. Existing aggregates
-- retain their established state-transition contracts.
CREATE OR REPLACE FUNCTION prevent_universal_v1_fact_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'HXUV1-AUDIT-1: Universal V1 lifecycle facts are append-only'
    USING ERRCODE = 'P0001';
END;
$$;

DO $$
DECLARE
  relation_name TEXT;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'task_scope_versions',
    'task_routing_decisions',
    'provider_estimate_submissions',
    'task_scope_change_approvals',
    'task_provider_eligibility_decisions',
    'task_financial_operations',
    'task_financial_security_events',
    'task_work_orders',
    'task_work_order_amendments',
    'task_completion_facts',
    'task_reconciliation_facts'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', relation_name || '_immutable', relation_name);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION prevent_universal_v1_fact_mutation()',
      relation_name || '_immutable', relation_name
    );
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', relation_name || '_no_truncate', relation_name);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION prevent_universal_v1_fact_mutation()',
      relation_name || '_no_truncate', relation_name
    );
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC', relation_name);
  END LOOP;
END
$$;

REVOKE ALL ON FUNCTION enforce_universal_trade_qualification() FROM PUBLIC;
REVOKE ALL ON FUNCTION enforce_verified_trade_projection() FROM PUBLIC;
REVOKE ALL ON FUNCTION enforce_universal_task_draft_authority() FROM PUBLIC;
REVOKE ALL ON FUNCTION enforce_universal_routing_sequence() FROM PUBLIC;
REVOKE ALL ON FUNCTION publish_universal_routing_decision() FROM PUBLIC;
REVOKE ALL ON FUNCTION enforce_provider_estimate_submission() FROM PUBLIC;
REVOKE ALL ON FUNCTION enforce_universal_interest_integrity() FROM PUBLIC;
REVOKE ALL ON FUNCTION enforce_universal_eligibility_sequence() FROM PUBLIC;
REVOKE ALL ON FUNCTION enforce_universal_conditional_hold() FROM PUBLIC;
REVOKE ALL ON FUNCTION enforce_universal_change_order_proposal() FROM PUBLIC;
REVOKE ALL ON FUNCTION enforce_universal_change_order_approval() FROM PUBLIC;
REVOKE ALL ON FUNCTION enforce_universal_work_order_amendment() FROM PUBLIC;
REVOKE ALL ON FUNCTION enforce_universal_work_order_materialization() FROM PUBLIC;
REVOKE ALL ON FUNCTION bind_universal_work_order_to_task() FROM PUBLIC;
REVOKE ALL ON FUNCTION is_hustlexp_disposable_assignment_ci() FROM PUBLIC;
REVOKE ALL ON FUNCTION enforce_universal_hard_assignment_hold() FROM PUBLIC;
REVOKE ALL ON FUNCTION enforce_squad_hard_assignment_hold() FROM PUBLIC;
REVOKE ALL ON FUNCTION enforce_financial_operation_trigger_only() FROM PUBLIC;
REVOKE ALL ON FUNCTION enforce_universal_financial_event_sequence() FROM PUBLIC;
REVOKE ALL ON FUNCTION universal_proof_snapshot_hash(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION enforce_universal_completion_bindings() FROM PUBLIC;
REVOKE ALL ON FUNCTION enforce_universal_reconciliation_bindings() FROM PUBLIC;
REVOKE ALL ON FUNCTION enforce_universal_active_scope_transition() FROM PUBLIC;
REVOKE ALL ON FUNCTION enforce_universal_proof_binding_immutability() FROM PUBLIC;
REVOKE ALL ON FUNCTION enforce_universal_proof_media_immutability() FROM PUBLIC;
REVOKE ALL ON FUNCTION prevent_universal_v1_fact_mutation() FROM PUBLIC;

COMMENT ON TABLE task_routing_decisions IS
  'Append-only authoritative six-outcome routing decisions for durable Task Drafts.';
COMMENT ON TABLE task_provider_eligibility_decisions IS
  'Append-only task-specific eligibility facts; no generic approved field and no assignment authority.';
COMMENT ON TABLE task_financial_operations IS
  'Append-only global financial operation identities; retry and outcome events must preserve every authority field.';
COMMENT ON TABLE task_financial_security_events IS
  'Provider-neutral one-effect financial facts. Authorization, security, capture, release, and bank settlement are distinct.';
COMMENT ON TABLE task_work_orders IS
  'Immutable Canonical Work Order materialization; creation does not assign a provider.';
COMMENT ON TABLE task_work_order_amendments IS
  'Append-only dual-approved Work Order scope chain; price changes require an exact adjustment-authorization fact.';
COMMENT ON TABLE task_completion_facts IS
  'Append-only submitted/approved/rejected completion facts bound to exact Work Order, scope, and proof.';
COMMENT ON TABLE task_reconciliation_facts IS
  'Append-only capture, refund, reversal, settlement, funding, release, payout, bank-settlement, and ledger agreement snapshots.';
