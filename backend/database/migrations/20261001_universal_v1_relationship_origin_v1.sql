-- HustleXP Universal V1 RelationshipOrigin authority.
--
-- A relationship origin is immutable acquisition evidence for one real
-- TaskDraft/occurrence. It is not provider selection, assignment, address
-- authority, eligibility, fee policy, a Financial Security Event, or a Work
-- Order. Public intake can establish MARKETPLACE from its existing TaskDraft
-- capability and explicit v1 consent. PROVIDER_OS and
-- BRING_YOUR_OWN_PROVIDER remain observation-only until exact authenticated
-- initiator, customer, provider-link, and provider-consent evidence is present.

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;

CREATE TABLE IF NOT EXISTS public.universal_v1_relationship_origin_policies (
  policy_version SMALLINT NOT NULL CHECK (policy_version = 1),
  origin_kind TEXT NOT NULL CHECK (origin_kind IN (
    'MARKETPLACE', 'PROVIDER_OS', 'BRING_YOUR_OWN_PROVIDER'
  )),
  initiator_role TEXT NOT NULL CHECK (initiator_role IN ('CUSTOMER', 'PROVIDER')),
  authenticated_initiator_required BOOLEAN NOT NULL,
  customer_identity_required BOOLEAN NOT NULL CHECK (customer_identity_required),
  customer_consent_required BOOLEAN NOT NULL CHECK (customer_consent_required),
  provider_link_required BOOLEAN NOT NULL,
  provider_consent_required BOOLEAN NOT NULL,
  provider_reference_authority TEXT NOT NULL
    CHECK (provider_reference_authority = 'RELATIONSHIP_EVIDENCE_ONLY'),
  assignment_authority TEXT NOT NULL CHECK (assignment_authority = 'NONE'),
  address_disclosure_authority TEXT NOT NULL
    CHECK (address_disclosure_authority = 'NONE'),
  eligibility_authority TEXT NOT NULL CHECK (eligibility_authority = 'NONE'),
  financial_authority TEXT NOT NULL CHECK (financial_authority = 'NONE'),
  work_order_authority TEXT NOT NULL CHECK (work_order_authority = 'NONE'),
  fee_policy_authority TEXT NOT NULL CHECK (fee_policy_authority = 'NONE'),
  PRIMARY KEY (origin_kind, policy_version),
  CHECK (provider_link_required = provider_consent_required),
  CHECK (
    (origin_kind = 'MARKETPLACE'
      AND initiator_role = 'CUSTOMER'
      AND authenticated_initiator_required IS FALSE
      AND provider_link_required IS FALSE)
    OR
    (origin_kind = 'PROVIDER_OS'
      AND initiator_role = 'PROVIDER'
      AND authenticated_initiator_required IS TRUE
      AND provider_link_required IS TRUE)
    OR
    (origin_kind = 'BRING_YOUR_OWN_PROVIDER'
      AND initiator_role = 'CUSTOMER'
      AND authenticated_initiator_required IS TRUE
      AND provider_link_required IS TRUE)
  )
);

INSERT INTO public.universal_v1_relationship_origin_policies (
  policy_version, origin_kind, initiator_role,
  authenticated_initiator_required, customer_identity_required,
  customer_consent_required, provider_link_required,
  provider_consent_required, provider_reference_authority,
  assignment_authority, address_disclosure_authority,
  eligibility_authority, financial_authority, work_order_authority,
  fee_policy_authority
) VALUES
  (1, 'MARKETPLACE', 'CUSTOMER', FALSE, TRUE, TRUE, FALSE, FALSE,
   'RELATIONSHIP_EVIDENCE_ONLY', 'NONE', 'NONE', 'NONE', 'NONE', 'NONE', 'NONE'),
  (1, 'PROVIDER_OS', 'PROVIDER', TRUE, TRUE, TRUE, TRUE, TRUE,
   'RELATIONSHIP_EVIDENCE_ONLY', 'NONE', 'NONE', 'NONE', 'NONE', 'NONE', 'NONE'),
  (1, 'BRING_YOUR_OWN_PROVIDER', 'CUSTOMER', TRUE, TRUE, TRUE, TRUE, TRUE,
   'RELATIONSHIP_EVIDENCE_ONLY', 'NONE', 'NONE', 'NONE', 'NONE', 'NONE', 'NONE')
ON CONFLICT (origin_kind, policy_version) DO NOTHING;

CREATE OR REPLACE FUNCTION public.universal_v1_relationship_deterministic_uuid(
  canonical_identity TEXT
)
RETURNS UUID
LANGUAGE SQL
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  WITH value AS (
    SELECT encode(public.digest(canonical_identity, 'sha256'), 'hex') AS hex
  )
  SELECT (
    substr(hex, 1, 8) || '-' || substr(hex, 9, 4) || '-5' ||
    substr(hex, 14, 3) || '-8' || substr(hex, 18, 3) || '-' ||
    substr(hex, 21, 12)
  )::UUID
  FROM value
$$;

CREATE OR REPLACE FUNCTION public.universal_v1_relationship_subject_binding(
  identity_basis TEXT,
  subject_user_id UUID,
  subject_organization_id UUID
)
RETURNS CHAR(64)
LANGUAGE SQL
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  SELECT CASE identity_basis
    WHEN 'AUTHENTICATED_USER' THEN encode(
      public.digest('USER:' || COALESCE(subject_user_id::TEXT, ''), 'sha256'), 'hex'
    )::CHAR(64)
    WHEN 'PROVIDER_ORGANIZATION' THEN encode(
      public.digest(
        'ORGANIZATION:' || COALESCE(subject_organization_id::TEXT, ''), 'sha256'
      ), 'hex'
    )::CHAR(64)
    ELSE NULL
  END
$$;

ALTER TABLE public.task_drafts
  ADD COLUMN IF NOT EXISTS relationship_origin_contract_version SMALLINT
    NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS relationship_origin_kind TEXT,
  ADD COLUMN IF NOT EXISTS relationship_origin_policy_version SMALLINT,
  ADD COLUMN IF NOT EXISTS relationship_origin_intake_consent_version TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'task_drafts_relationship_origin_contract_check'
      AND conrelid = 'public.task_drafts'::regclass
  ) THEN
    ALTER TABLE public.task_drafts
      ADD CONSTRAINT task_drafts_relationship_origin_contract_check CHECK (
        (
          relationship_origin_contract_version = 0
          AND relationship_origin_kind IS NULL
          AND relationship_origin_policy_version IS NULL
          AND relationship_origin_intake_consent_version IS NULL
        )
        OR (
          relationship_origin_contract_version = 1
          AND relationship_origin_kind IN (
            'MARKETPLACE', 'PROVIDER_OS', 'BRING_YOUR_OWN_PROVIDER'
          )
          AND relationship_origin_policy_version = 1
          AND (
            (relationship_origin_kind = 'MARKETPLACE'
              AND relationship_origin_intake_consent_version = 'v1')
            OR
            (relationship_origin_kind IN ('PROVIDER_OS', 'BRING_YOUR_OWN_PROVIDER')
              AND relationship_origin_intake_consent_version IS NULL)
          )
        )
      ) NOT VALID;
  END IF;
END
$$;

ALTER TABLE public.task_drafts
  VALIDATE CONSTRAINT task_drafts_relationship_origin_contract_check;

CREATE TABLE IF NOT EXISTS public.universal_v1_relationship_origin_observations (
  id UUID PRIMARY KEY,
  task_draft_id UUID NOT NULL
    REFERENCES public.task_drafts(id) ON DELETE RESTRICT,
  policy_version SMALLINT NOT NULL CHECK (policy_version = 1),
  origin_kind TEXT NOT NULL,
  observation_version INTEGER NOT NULL CHECK (observation_version > 0),
  supersedes_observation_id UUID
    REFERENCES public.universal_v1_relationship_origin_observations(id) ON DELETE RESTRICT,
  observation_kind TEXT NOT NULL CHECK (observation_kind IN (
    'INITIATOR_IDENTITY_OBSERVED',
    'CUSTOMER_IDENTITY_OBSERVED',
    'CUSTOMER_CONSENT_OBSERVED',
    'PROVIDER_LINK_OBSERVED',
    'PROVIDER_CONSENT_OBSERVED'
  )),
  subject_role TEXT NOT NULL CHECK (subject_role IN ('CUSTOMER', 'PROVIDER')),
  identity_basis TEXT NOT NULL CHECK (identity_basis IN (
    'TASK_DRAFT_CAPABILITY',
    'AUTHENTICATED_USER',
    'PRIVACY_SAFE_EXTERNAL_CUSTOMER',
    'PROVIDER_ORGANIZATION'
  )),
  subject_user_id UUID REFERENCES public.users(id) ON DELETE RESTRICT,
  subject_organization_id UUID
    REFERENCES public.business_organizations(id) ON DELETE RESTRICT,
  subject_binding_sha256 CHAR(64) NOT NULL
    CHECK (subject_binding_sha256 ~ '^[a-f0-9]{64}$'),
  consent_contract_version TEXT,
  source_evidence_sha256 CHAR(64) NOT NULL
    CHECK (source_evidence_sha256 ~ '^[a-f0-9]{64}$'),
  observed_by_user_id UUID REFERENCES public.users(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL UNIQUE
    CHECK (idempotency_key ~ '^[A-Za-z0-9:_-]{8,180}$'),
  evidence_digest CHAR(64) NOT NULL
    CHECK (evidence_digest ~ '^[a-f0-9]{64}$'),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (origin_kind, policy_version)
    REFERENCES public.universal_v1_relationship_origin_policies(
      origin_kind, policy_version
    ) ON DELETE RESTRICT,
  UNIQUE (task_draft_id, observation_kind, observation_version),
  CHECK (
    (observation_version = 1 AND supersedes_observation_id IS NULL)
    OR (observation_version > 1 AND supersedes_observation_id IS NOT NULL)
  ),
  CHECK (
    (observation_kind IN (
      'CUSTOMER_CONSENT_OBSERVED', 'PROVIDER_CONSENT_OBSERVED'
    ) AND consent_contract_version = 'v1')
    OR
    (observation_kind NOT IN (
      'CUSTOMER_CONSENT_OBSERVED', 'PROVIDER_CONSENT_OBSERVED'
    ) AND consent_contract_version IS NULL)
  ),
  CHECK (
    (subject_role = 'CUSTOMER'
      AND observation_kind IN (
        'INITIATOR_IDENTITY_OBSERVED',
        'CUSTOMER_IDENTITY_OBSERVED',
        'CUSTOMER_CONSENT_OBSERVED'
      ))
    OR
    (subject_role = 'PROVIDER'
      AND observation_kind IN (
        'INITIATOR_IDENTITY_OBSERVED',
        'PROVIDER_LINK_OBSERVED',
        'PROVIDER_CONSENT_OBSERVED'
      ))
  )
);

CREATE INDEX IF NOT EXISTS universal_v1_relationship_observations_task
  ON public.universal_v1_relationship_origin_observations(
    task_draft_id, observation_kind, observation_version DESC
  );

CREATE TABLE IF NOT EXISTS public.universal_v1_relationship_origins (
  id UUID PRIMARY KEY,
  task_draft_id UUID NOT NULL
    REFERENCES public.task_drafts(id) ON DELETE RESTRICT,
  policy_version SMALLINT NOT NULL CHECK (policy_version = 1),
  origin_kind TEXT NOT NULL,
  origin_version INTEGER NOT NULL CHECK (origin_version > 0),
  supersedes_origin_id UUID
    REFERENCES public.universal_v1_relationship_origins(id) ON DELETE RESTRICT,
  initiator_identity_observation_id UUID
    REFERENCES public.universal_v1_relationship_origin_observations(id) ON DELETE RESTRICT,
  customer_identity_observation_id UUID
    REFERENCES public.universal_v1_relationship_origin_observations(id) ON DELETE RESTRICT,
  customer_consent_observation_id UUID
    REFERENCES public.universal_v1_relationship_origin_observations(id) ON DELETE RESTRICT,
  provider_link_observation_id UUID
    REFERENCES public.universal_v1_relationship_origin_observations(id) ON DELETE RESTRICT,
  provider_consent_observation_id UUID
    REFERENCES public.universal_v1_relationship_origin_observations(id) ON DELETE RESTRICT,
  routing_state TEXT NOT NULL CHECK (routing_state IN ('HELD', 'ROUTING_READY')),
  hold_reason_codes TEXT[] NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE
    CHECK (idempotency_key ~ '^[A-Za-z0-9:_-]{8,180}$'),
  evidence_digest CHAR(64) NOT NULL
    CHECK (evidence_digest ~ '^[a-f0-9]{64}$'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (origin_kind, policy_version)
    REFERENCES public.universal_v1_relationship_origin_policies(
      origin_kind, policy_version
    ) ON DELETE RESTRICT,
  UNIQUE (task_draft_id, origin_version),
  CHECK (
    (origin_version = 1 AND supersedes_origin_id IS NULL)
    OR (origin_version > 1 AND supersedes_origin_id IS NOT NULL)
  ),
  CHECK (
    (routing_state = 'ROUTING_READY' AND cardinality(hold_reason_codes) = 0)
    OR (routing_state = 'HELD' AND cardinality(hold_reason_codes) > 0)
  )
);

CREATE INDEX IF NOT EXISTS universal_v1_relationship_origins_task
  ON public.universal_v1_relationship_origins(task_draft_id, origin_version DESC);

CREATE OR REPLACE FUNCTION public.universal_v1_relationship_observation_digest(
  task_draft_id UUID,
  policy_version SMALLINT,
  origin_kind TEXT,
  observation_version INTEGER,
  supersedes_observation_id UUID,
  observation_kind TEXT,
  subject_role TEXT,
  identity_basis TEXT,
  subject_user_id UUID,
  subject_organization_id UUID,
  subject_binding_sha256 CHAR(64),
  consent_contract_version TEXT,
  source_evidence_sha256 CHAR(64),
  observed_by_user_id UUID
)
RETURNS CHAR(64)
LANGUAGE SQL
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  SELECT encode(public.digest(concat_ws('|',
    'HX_RELATIONSHIP_ORIGIN_OBSERVATION_V1', task_draft_id::TEXT,
    policy_version::TEXT, origin_kind, observation_version::TEXT,
    COALESCE(supersedes_observation_id::TEXT, ''), observation_kind,
    subject_role, identity_basis, COALESCE(subject_user_id::TEXT, ''),
    COALESCE(subject_organization_id::TEXT, ''), subject_binding_sha256::TEXT,
    COALESCE(consent_contract_version, ''), source_evidence_sha256::TEXT,
    COALESCE(observed_by_user_id::TEXT, '')
  ), 'sha256'), 'hex')::CHAR(64)
$$;

CREATE OR REPLACE FUNCTION public.enforce_universal_v1_relationship_observation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  draft public.task_drafts%ROWTYPE;
  predecessor public.universal_v1_relationship_origin_observations%ROWTYPE;
  expected_idempotency TEXT;
  expected_id UUID;
  expected_binding CHAR(64);
  expected_digest CHAR(64);
BEGIN
  SELECT * INTO draft FROM public.task_drafts WHERE id = NEW.task_draft_id;
  IF NOT FOUND
     OR draft.relationship_origin_contract_version <> 1
     OR draft.relationship_origin_kind IS DISTINCT FROM NEW.origin_kind
     OR draft.relationship_origin_policy_version IS DISTINCT FROM NEW.policy_version THEN
    RAISE EXCEPTION 'HXUV1-REL-2: observation must bind the exact versioned TaskDraft origin policy'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.observation_version = 1 THEN
    IF NEW.supersedes_observation_id IS NOT NULL THEN
      RAISE EXCEPTION 'HXUV1-REL-3: first observation version cannot have a predecessor'
        USING ERRCODE = 'P0001';
    END IF;
  ELSE
    SELECT * INTO predecessor
    FROM public.universal_v1_relationship_origin_observations
    WHERE id = NEW.supersedes_observation_id;
    IF NOT FOUND
       OR predecessor.task_draft_id <> NEW.task_draft_id
       OR predecessor.origin_kind <> NEW.origin_kind
       OR predecessor.policy_version <> NEW.policy_version
       OR predecessor.observation_kind <> NEW.observation_kind
       OR predecessor.observation_version + 1 <> NEW.observation_version THEN
      RAISE EXCEPTION 'HXUV1-REL-3: observation predecessor must be the exact prior version'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF NEW.identity_basis = 'TASK_DRAFT_CAPABILITY' THEN
    IF NEW.origin_kind <> 'MARKETPLACE'
       OR NEW.subject_role <> 'CUSTOMER'
       OR NEW.subject_user_id IS NOT NULL
       OR NEW.subject_organization_id IS NOT NULL
       OR NEW.observed_by_user_id IS NOT NULL
       OR NEW.subject_binding_sha256 IS DISTINCT FROM draft.card_token_hash::CHAR(64) THEN
      RAISE EXCEPTION 'HXUV1-REL-4: TaskDraft capability evidence is Marketplace customer evidence only'
        USING ERRCODE = 'P0001';
    END IF;
  ELSIF NEW.identity_basis = 'AUTHENTICATED_USER' THEN
    expected_binding := public.universal_v1_relationship_subject_binding(
      NEW.identity_basis, NEW.subject_user_id, NULL
    );
    IF NEW.subject_user_id IS NULL
       OR NEW.subject_organization_id IS NOT NULL
       OR NEW.observed_by_user_id IS DISTINCT FROM NEW.subject_user_id
       OR NEW.subject_binding_sha256 IS DISTINCT FROM expected_binding THEN
      RAISE EXCEPTION 'HXUV1-REL-5: authenticated-user observation must bind its exact actor identity'
        USING ERRCODE = 'P0001';
    END IF;
  ELSIF NEW.identity_basis = 'PROVIDER_ORGANIZATION' THEN
    expected_binding := public.universal_v1_relationship_subject_binding(
      NEW.identity_basis, NULL, NEW.subject_organization_id
    );
    IF NEW.subject_role <> 'PROVIDER'
       OR NEW.subject_user_id IS NOT NULL
       OR NEW.subject_organization_id IS NULL
       OR NEW.observed_by_user_id IS NULL
       OR NEW.subject_binding_sha256 IS DISTINCT FROM expected_binding
       OR NOT EXISTS (
         SELECT 1 FROM public.business_memberships membership
         WHERE membership.organization_id = NEW.subject_organization_id
           AND membership.user_id = NEW.observed_by_user_id
           AND membership.status = 'ACTIVE'
       ) THEN
      RAISE EXCEPTION 'HXUV1-REL-6: provider-organization evidence requires an active authenticated member'
        USING ERRCODE = 'P0001';
    END IF;
  ELSIF NEW.identity_basis = 'PRIVACY_SAFE_EXTERNAL_CUSTOMER' THEN
    IF NEW.origin_kind <> 'PROVIDER_OS'
       OR NEW.subject_role <> 'CUSTOMER'
       OR NEW.subject_user_id IS NOT NULL
       OR NEW.subject_organization_id IS NOT NULL
       OR NEW.observed_by_user_id IS NOT NULL THEN
      RAISE EXCEPTION 'HXUV1-REL-7: external-customer evidence is privacy-safe Provider OS customer evidence only'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF NEW.observation_kind IN (
       'PROVIDER_LINK_OBSERVED', 'PROVIDER_CONSENT_OBSERVED'
     ) AND NEW.identity_basis NOT IN (
       'AUTHENTICATED_USER', 'PROVIDER_ORGANIZATION'
     ) THEN
    RAISE EXCEPTION 'HXUV1-REL-8: provider evidence requires an exact authenticated provider subject'
      USING ERRCODE = 'P0001';
  END IF;

  expected_idempotency := 'relationship-origin-observation:' ||
    NEW.task_draft_id::TEXT || ':' || NEW.observation_kind ||
    ':v' || NEW.observation_version::TEXT;
  expected_id := public.universal_v1_relationship_deterministic_uuid(expected_idempotency);
  expected_digest := public.universal_v1_relationship_observation_digest(
    NEW.task_draft_id, NEW.policy_version, NEW.origin_kind,
    NEW.observation_version, NEW.supersedes_observation_id,
    NEW.observation_kind, NEW.subject_role, NEW.identity_basis,
    NEW.subject_user_id, NEW.subject_organization_id,
    NEW.subject_binding_sha256, NEW.consent_contract_version,
    NEW.source_evidence_sha256, NEW.observed_by_user_id
  );

  IF NEW.id IS NOT NULL AND NEW.id <> expected_id THEN
    RAISE EXCEPTION 'HXUV1-REL-9: observation identity is deterministic'
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.idempotency_key IS NOT NULL
     AND NEW.idempotency_key <> expected_idempotency THEN
    RAISE EXCEPTION 'HXUV1-REL-9: observation idempotency identity is deterministic'
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.evidence_digest IS NOT NULL
     AND NEW.evidence_digest <> expected_digest THEN
    RAISE EXCEPTION 'HXUV1-REL-9: observation evidence digest is deterministic'
      USING ERRCODE = 'P0001';
  END IF;
  NEW.id := expected_id;
  NEW.idempotency_key := expected_idempotency;
  NEW.evidence_digest := expected_digest;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS universal_v1_relationship_observation_guard
  ON public.universal_v1_relationship_origin_observations;
CREATE TRIGGER universal_v1_relationship_observation_guard
BEFORE INSERT ON public.universal_v1_relationship_origin_observations
FOR EACH ROW EXECUTE FUNCTION public.enforce_universal_v1_relationship_observation();

CREATE OR REPLACE FUNCTION public.universal_v1_relationship_origin_digest(
  task_draft_id UUID,
  policy_version SMALLINT,
  origin_kind TEXT,
  origin_version INTEGER,
  supersedes_origin_id UUID,
  initiator_identity_observation_id UUID,
  customer_identity_observation_id UUID,
  customer_consent_observation_id UUID,
  provider_link_observation_id UUID,
  provider_consent_observation_id UUID,
  initiator_identity_evidence_digest CHAR(64),
  customer_identity_evidence_digest CHAR(64),
  customer_consent_evidence_digest CHAR(64),
  provider_link_evidence_digest CHAR(64),
  provider_consent_evidence_digest CHAR(64),
  routing_state TEXT,
  hold_reason_codes TEXT[]
)
RETURNS CHAR(64)
LANGUAGE SQL
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  SELECT encode(public.digest(concat_ws('|',
    'HX_RELATIONSHIP_ORIGIN_V1', task_draft_id::TEXT,
    policy_version::TEXT, origin_kind, origin_version::TEXT,
    COALESCE(supersedes_origin_id::TEXT, ''),
    COALESCE(initiator_identity_observation_id::TEXT, ''),
    COALESCE(customer_identity_observation_id::TEXT, ''),
    COALESCE(customer_consent_observation_id::TEXT, ''),
    COALESCE(provider_link_observation_id::TEXT, ''),
    COALESCE(provider_consent_observation_id::TEXT, ''),
    COALESCE(initiator_identity_evidence_digest::TEXT, ''),
    COALESCE(customer_identity_evidence_digest::TEXT, ''),
    COALESCE(customer_consent_evidence_digest::TEXT, ''),
    COALESCE(provider_link_evidence_digest::TEXT, ''),
    COALESCE(provider_consent_evidence_digest::TEXT, ''),
    routing_state, array_to_string(hold_reason_codes, ',')
  ), 'sha256'), 'hex')::CHAR(64)
$$;

CREATE OR REPLACE FUNCTION public.enforce_universal_v1_relationship_origin()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  draft public.task_drafts%ROWTYPE;
  policy public.universal_v1_relationship_origin_policies%ROWTYPE;
  predecessor public.universal_v1_relationship_origins%ROWTYPE;
  initiator public.universal_v1_relationship_origin_observations%ROWTYPE;
  customer_identity public.universal_v1_relationship_origin_observations%ROWTYPE;
  customer_consent public.universal_v1_relationship_origin_observations%ROWTYPE;
  provider_link public.universal_v1_relationship_origin_observations%ROWTYPE;
  provider_consent public.universal_v1_relationship_origin_observations%ROWTYPE;
  reasons TEXT[] := ARRAY[]::TEXT[];
  expected_idempotency TEXT;
  expected_id UUID;
  expected_digest CHAR(64);
BEGIN
  SELECT * INTO draft FROM public.task_drafts WHERE id = NEW.task_draft_id;
  SELECT * INTO policy
  FROM public.universal_v1_relationship_origin_policies
  WHERE origin_kind = NEW.origin_kind AND policy_version = NEW.policy_version;
  IF draft.id IS NULL OR policy.origin_kind IS NULL
     OR draft.relationship_origin_contract_version <> 1
     OR draft.relationship_origin_kind IS DISTINCT FROM NEW.origin_kind
     OR draft.relationship_origin_policy_version IS DISTINCT FROM NEW.policy_version
     OR draft.task_id IS NOT NULL
     OR draft.quote_id IS NOT NULL THEN
    RAISE EXCEPTION 'HXUV1-REL-10: origin must bind the exact pre-transaction TaskDraft policy'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.origin_version = 1 THEN
    IF NEW.supersedes_origin_id IS NOT NULL THEN
      RAISE EXCEPTION 'HXUV1-REL-11: first origin version cannot have a predecessor'
        USING ERRCODE = 'P0001';
    END IF;
  ELSE
    SELECT * INTO predecessor
    FROM public.universal_v1_relationship_origins
    WHERE id = NEW.supersedes_origin_id;
    IF predecessor.id IS NULL
       OR predecessor.task_draft_id <> NEW.task_draft_id
       OR predecessor.origin_kind <> NEW.origin_kind
       OR predecessor.policy_version <> NEW.policy_version
       OR predecessor.origin_version + 1 <> NEW.origin_version THEN
      RAISE EXCEPTION 'HXUV1-REL-11: origin predecessor must be the exact prior version'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF NEW.initiator_identity_observation_id IS NULL THEN
    reasons := array_append(reasons, 'INITIATOR_IDENTITY_REQUIRED');
  ELSE
    SELECT * INTO initiator
    FROM public.universal_v1_relationship_origin_observations
    WHERE id = NEW.initiator_identity_observation_id;
    IF initiator.id IS NULL OR initiator.task_draft_id <> NEW.task_draft_id
       OR initiator.policy_version <> NEW.policy_version
       OR initiator.origin_kind <> NEW.origin_kind
       OR initiator.observation_kind <> 'INITIATOR_IDENTITY_OBSERVED'
       OR initiator.subject_role <> policy.initiator_role THEN
      RAISE EXCEPTION 'HXUV1-REL-12: initiator observation does not match the exact origin'
        USING ERRCODE = 'P0001';
    END IF;
    IF policy.authenticated_initiator_required
       AND initiator.identity_basis <> 'AUTHENTICATED_USER' THEN
      reasons := array_append(reasons, 'AUTHENTICATED_INITIATOR_REQUIRED');
    END IF;
  END IF;

  IF NEW.customer_identity_observation_id IS NULL THEN
    reasons := array_append(reasons, 'CUSTOMER_IDENTITY_REQUIRED');
  ELSE
    SELECT * INTO customer_identity
    FROM public.universal_v1_relationship_origin_observations
    WHERE id = NEW.customer_identity_observation_id;
    IF customer_identity.id IS NULL
       OR customer_identity.task_draft_id <> NEW.task_draft_id
       OR customer_identity.policy_version <> NEW.policy_version
       OR customer_identity.origin_kind <> NEW.origin_kind
       OR customer_identity.observation_kind <> 'CUSTOMER_IDENTITY_OBSERVED'
       OR customer_identity.subject_role <> 'CUSTOMER' THEN
      RAISE EXCEPTION 'HXUV1-REL-13: customer identity observation does not match the exact origin'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF NEW.customer_consent_observation_id IS NULL THEN
    reasons := array_append(reasons, 'CUSTOMER_CONSENT_REQUIRED');
  ELSE
    SELECT * INTO customer_consent
    FROM public.universal_v1_relationship_origin_observations
    WHERE id = NEW.customer_consent_observation_id;
    IF customer_consent.id IS NULL
       OR customer_consent.task_draft_id <> NEW.task_draft_id
       OR customer_consent.policy_version <> NEW.policy_version
       OR customer_consent.origin_kind <> NEW.origin_kind
       OR customer_consent.observation_kind <> 'CUSTOMER_CONSENT_OBSERVED'
       OR customer_consent.subject_role <> 'CUSTOMER'
       OR customer_consent.consent_contract_version <> 'v1' THEN
      RAISE EXCEPTION 'HXUV1-REL-14: customer consent observation does not match the exact origin'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF customer_identity.id IS NOT NULL AND customer_consent.id IS NOT NULL
     AND (
       customer_identity.identity_basis <> customer_consent.identity_basis
       OR customer_identity.subject_binding_sha256 <> customer_consent.subject_binding_sha256
       OR customer_identity.subject_user_id IS DISTINCT FROM customer_consent.subject_user_id
       OR customer_identity.subject_organization_id
            IS DISTINCT FROM customer_consent.subject_organization_id
     ) THEN
    RAISE EXCEPTION 'HXUV1-REL-15: customer identity and consent must bind the same subject'
      USING ERRCODE = 'P0001';
  END IF;

  IF policy.provider_link_required THEN
    IF NEW.provider_link_observation_id IS NULL THEN
      reasons := array_append(reasons, 'PROVIDER_LINK_REQUIRED');
    ELSE
      SELECT * INTO provider_link
      FROM public.universal_v1_relationship_origin_observations
      WHERE id = NEW.provider_link_observation_id;
      IF provider_link.id IS NULL OR provider_link.task_draft_id <> NEW.task_draft_id
         OR provider_link.policy_version <> NEW.policy_version
         OR provider_link.origin_kind <> NEW.origin_kind
         OR provider_link.observation_kind <> 'PROVIDER_LINK_OBSERVED'
         OR provider_link.subject_role <> 'PROVIDER' THEN
        RAISE EXCEPTION 'HXUV1-REL-16: provider-link observation does not match the exact origin'
          USING ERRCODE = 'P0001';
      END IF;
    END IF;
    IF NEW.provider_consent_observation_id IS NULL THEN
      reasons := array_append(reasons, 'PROVIDER_CONSENT_REQUIRED');
    ELSE
      SELECT * INTO provider_consent
      FROM public.universal_v1_relationship_origin_observations
      WHERE id = NEW.provider_consent_observation_id;
      IF provider_consent.id IS NULL
         OR provider_consent.task_draft_id <> NEW.task_draft_id
         OR provider_consent.policy_version <> NEW.policy_version
         OR provider_consent.origin_kind <> NEW.origin_kind
         OR provider_consent.observation_kind <> 'PROVIDER_CONSENT_OBSERVED'
         OR provider_consent.subject_role <> 'PROVIDER'
         OR provider_consent.consent_contract_version <> 'v1' THEN
        RAISE EXCEPTION 'HXUV1-REL-17: provider consent observation does not match the exact origin'
          USING ERRCODE = 'P0001';
      END IF;
    END IF;
  ELSIF NEW.provider_link_observation_id IS NOT NULL
     OR NEW.provider_consent_observation_id IS NOT NULL THEN
    RAISE EXCEPTION 'HXUV1-REL-18: Marketplace origin cannot carry a provider reference'
      USING ERRCODE = 'P0001';
  END IF;

  IF provider_link.id IS NOT NULL AND provider_consent.id IS NOT NULL
     AND (
       provider_link.identity_basis <> provider_consent.identity_basis
       OR provider_link.subject_binding_sha256 <> provider_consent.subject_binding_sha256
       OR provider_link.subject_user_id IS DISTINCT FROM provider_consent.subject_user_id
       OR provider_link.subject_organization_id
            IS DISTINCT FROM provider_consent.subject_organization_id
     ) THEN
    RAISE EXCEPTION 'HXUV1-REL-19: provider link and consent must bind the same subject'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.origin_kind = 'MARKETPLACE'
     AND initiator.id IS NOT NULL AND customer_identity.id IS NOT NULL
     AND initiator.subject_binding_sha256 <> customer_identity.subject_binding_sha256 THEN
    RAISE EXCEPTION 'HXUV1-REL-20: Marketplace initiator must be the customer capability'
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.origin_kind = 'BRING_YOUR_OWN_PROVIDER'
     AND initiator.id IS NOT NULL AND customer_identity.id IS NOT NULL
     AND initiator.subject_binding_sha256 <> customer_identity.subject_binding_sha256 THEN
    RAISE EXCEPTION 'HXUV1-REL-21: BYOP initiator must be the authenticated customer'
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.origin_kind = 'PROVIDER_OS' AND initiator.id IS NOT NULL
     AND provider_link.id IS NOT NULL THEN
    IF provider_link.identity_basis = 'AUTHENTICATED_USER'
       AND initiator.subject_user_id IS DISTINCT FROM provider_link.subject_user_id THEN
      RAISE EXCEPTION 'HXUV1-REL-22: Provider OS initiator must be the linked provider'
        USING ERRCODE = 'P0001';
    ELSIF provider_link.identity_basis = 'PROVIDER_ORGANIZATION'
       AND NOT EXISTS (
         SELECT 1 FROM public.business_memberships membership
         WHERE membership.organization_id = provider_link.subject_organization_id
           AND membership.user_id = initiator.subject_user_id
           AND membership.status = 'ACTIVE'
       ) THEN
      RAISE EXCEPTION 'HXUV1-REL-22: Provider OS initiator must belong to the linked provider organization'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF NEW.origin_kind = 'BRING_YOUR_OWN_PROVIDER'
     AND customer_identity.id IS NOT NULL AND provider_link.id IS NOT NULL
     AND customer_identity.subject_binding_sha256 = provider_link.subject_binding_sha256 THEN
    RAISE EXCEPTION 'HXUV1-REL-23: BYOP customer and provider must be distinct subjects'
      USING ERRCODE = 'P0001';
  END IF;

  NEW.routing_state := CASE WHEN cardinality(reasons) = 0
    THEN 'ROUTING_READY' ELSE 'HELD' END;
  NEW.hold_reason_codes := reasons;
  expected_idempotency := 'relationship-origin:' || NEW.task_draft_id::TEXT ||
    ':v' || NEW.origin_version::TEXT;
  expected_id := public.universal_v1_relationship_deterministic_uuid(expected_idempotency);
  expected_digest := public.universal_v1_relationship_origin_digest(
    NEW.task_draft_id, NEW.policy_version, NEW.origin_kind,
    NEW.origin_version, NEW.supersedes_origin_id,
    NEW.initiator_identity_observation_id,
    NEW.customer_identity_observation_id,
    NEW.customer_consent_observation_id,
    NEW.provider_link_observation_id, NEW.provider_consent_observation_id,
    initiator.evidence_digest, customer_identity.evidence_digest,
    customer_consent.evidence_digest, provider_link.evidence_digest,
    provider_consent.evidence_digest,
    NEW.routing_state, NEW.hold_reason_codes
  );

  IF NEW.id IS NOT NULL AND NEW.id <> expected_id THEN
    RAISE EXCEPTION 'HXUV1-REL-24: origin identity is deterministic'
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.idempotency_key IS NOT NULL
     AND NEW.idempotency_key <> expected_idempotency THEN
    RAISE EXCEPTION 'HXUV1-REL-24: origin idempotency identity is deterministic'
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.evidence_digest IS NOT NULL
     AND NEW.evidence_digest <> expected_digest THEN
    RAISE EXCEPTION 'HXUV1-REL-24: origin evidence digest is deterministic'
      USING ERRCODE = 'P0001';
  END IF;
  NEW.id := expected_id;
  NEW.idempotency_key := expected_idempotency;
  NEW.evidence_digest := expected_digest;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS universal_v1_relationship_origin_guard
  ON public.universal_v1_relationship_origins;
CREATE TRIGGER universal_v1_relationship_origin_guard
BEFORE INSERT ON public.universal_v1_relationship_origins
FOR EACH ROW EXECUTE FUNCTION public.enforce_universal_v1_relationship_origin();

CREATE OR REPLACE FUNCTION public.ensure_universal_v1_marketplace_relationship_origin(
  exact_task_draft_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  draft public.task_drafts%ROWTYPE;
  initiator_id UUID;
  customer_identity_id UUID;
  customer_consent_id UUID;
  origin_id UUID;
  source_digest CHAR(64);
BEGIN
  SELECT * INTO draft
  FROM public.task_drafts
  WHERE id = exact_task_draft_id
  FOR UPDATE;
  IF NOT FOUND
     OR draft.relationship_origin_contract_version <> 1
     OR draft.relationship_origin_kind <> 'MARKETPLACE'
     OR draft.relationship_origin_policy_version <> 1
     OR draft.relationship_origin_intake_consent_version <> 'v1' THEN
    RAISE EXCEPTION 'HXUV1-REL-25: Marketplace bootstrap requires the exact v1 TaskDraft intake contract'
      USING ERRCODE = 'P0001';
  END IF;

  initiator_id := public.universal_v1_relationship_deterministic_uuid(
    'relationship-origin-observation:' || draft.id::TEXT ||
    ':INITIATOR_IDENTITY_OBSERVED:v1'
  );
  customer_identity_id := public.universal_v1_relationship_deterministic_uuid(
    'relationship-origin-observation:' || draft.id::TEXT ||
    ':CUSTOMER_IDENTITY_OBSERVED:v1'
  );
  customer_consent_id := public.universal_v1_relationship_deterministic_uuid(
    'relationship-origin-observation:' || draft.id::TEXT ||
    ':CUSTOMER_CONSENT_OBSERVED:v1'
  );

  source_digest := encode(public.digest(
    'MARKETPLACE_INITIATOR|' || draft.id::TEXT || '|' || draft.card_token_hash,
    'sha256'
  ), 'hex')::CHAR(64);
  INSERT INTO public.universal_v1_relationship_origin_observations (
    id, task_draft_id, policy_version, origin_kind, observation_version,
    observation_kind, subject_role, identity_basis,
    subject_binding_sha256, source_evidence_sha256
  ) VALUES (
    initiator_id, draft.id, 1, 'MARKETPLACE', 1,
    'INITIATOR_IDENTITY_OBSERVED', 'CUSTOMER', 'TASK_DRAFT_CAPABILITY',
    draft.card_token_hash, source_digest
  ) ON CONFLICT (task_draft_id, observation_kind, observation_version) DO NOTHING;

  source_digest := encode(public.digest(
    'MARKETPLACE_CUSTOMER|' || draft.id::TEXT || '|' || draft.card_token_hash,
    'sha256'
  ), 'hex')::CHAR(64);
  INSERT INTO public.universal_v1_relationship_origin_observations (
    id, task_draft_id, policy_version, origin_kind, observation_version,
    observation_kind, subject_role, identity_basis,
    subject_binding_sha256, source_evidence_sha256
  ) VALUES (
    customer_identity_id, draft.id, 1, 'MARKETPLACE', 1,
    'CUSTOMER_IDENTITY_OBSERVED', 'CUSTOMER', 'TASK_DRAFT_CAPABILITY',
    draft.card_token_hash, source_digest
  ) ON CONFLICT (task_draft_id, observation_kind, observation_version) DO NOTHING;

  source_digest := encode(public.digest(
    'MARKETPLACE_CUSTOMER_CONSENT|' || draft.id::TEXT || '|v1|' ||
    draft.card_token_hash, 'sha256'
  ), 'hex')::CHAR(64);
  INSERT INTO public.universal_v1_relationship_origin_observations (
    id, task_draft_id, policy_version, origin_kind, observation_version,
    observation_kind, subject_role, identity_basis,
    subject_binding_sha256, consent_contract_version,
    source_evidence_sha256
  ) VALUES (
    customer_consent_id, draft.id, 1, 'MARKETPLACE', 1,
    'CUSTOMER_CONSENT_OBSERVED', 'CUSTOMER', 'TASK_DRAFT_CAPABILITY',
    draft.card_token_hash, 'v1', source_digest
  ) ON CONFLICT (task_draft_id, observation_kind, observation_version) DO NOTHING;

  origin_id := public.universal_v1_relationship_deterministic_uuid(
    'relationship-origin:' || draft.id::TEXT || ':v1'
  );
  INSERT INTO public.universal_v1_relationship_origins (
    id, task_draft_id, policy_version, origin_kind, origin_version,
    initiator_identity_observation_id, customer_identity_observation_id,
    customer_consent_observation_id
  ) VALUES (
    origin_id, draft.id, 1, 'MARKETPLACE', 1,
    initiator_id, customer_identity_id, customer_consent_id
  ) ON CONFLICT (task_draft_id, origin_version) DO NOTHING;

  IF NOT EXISTS (
    SELECT 1
    FROM public.universal_v1_relationship_origins origin
    JOIN public.universal_v1_relationship_origin_observations initiator
      ON initiator.id = origin.initiator_identity_observation_id
    JOIN public.universal_v1_relationship_origin_observations customer_identity
      ON customer_identity.id = origin.customer_identity_observation_id
    JOIN public.universal_v1_relationship_origin_observations customer_consent
      ON customer_consent.id = origin.customer_consent_observation_id
    WHERE origin.id = origin_id
      AND origin.task_draft_id = draft.id
      AND origin.origin_kind = 'MARKETPLACE'
      AND origin.policy_version = 1
      AND origin.origin_version = 1
      AND origin.initiator_identity_observation_id = initiator_id
      AND origin.customer_identity_observation_id = customer_identity_id
      AND origin.customer_consent_observation_id = customer_consent_id
      AND origin.provider_link_observation_id IS NULL
      AND origin.provider_consent_observation_id IS NULL
      AND origin.routing_state = 'ROUTING_READY'
      AND cardinality(origin.hold_reason_codes) = 0
      AND initiator.source_evidence_sha256 = encode(public.digest(
        'MARKETPLACE_INITIATOR|' || draft.id::TEXT || '|' || draft.card_token_hash,
        'sha256'
      ), 'hex')::CHAR(64)
      AND customer_identity.source_evidence_sha256 = encode(public.digest(
        'MARKETPLACE_CUSTOMER|' || draft.id::TEXT || '|' || draft.card_token_hash,
        'sha256'
      ), 'hex')::CHAR(64)
      AND customer_consent.source_evidence_sha256 = encode(public.digest(
        'MARKETPLACE_CUSTOMER_CONSENT|' || draft.id::TEXT || '|v1|' ||
        draft.card_token_hash, 'sha256'
      ), 'hex')::CHAR(64)
  ) THEN
    RAISE EXCEPTION 'HXUV1-REL-26: Marketplace bootstrap replay does not match exact certified evidence'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN origin_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_task_draft_relationship_origin_contract()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.relationship_origin_contract_version = 1
       AND (
         NEW.relationship_origin_contract_version <> 1
         OR NEW.relationship_origin_kind IS DISTINCT FROM OLD.relationship_origin_kind
         OR NEW.relationship_origin_policy_version
              IS DISTINCT FROM OLD.relationship_origin_policy_version
         OR NEW.relationship_origin_intake_consent_version
              IS DISTINCT FROM OLD.relationship_origin_intake_consent_version
       ) THEN
      RAISE EXCEPTION 'HXUV1-REL-27: TaskDraft RelationshipOrigin identity is immutable'
        USING ERRCODE = 'P0001';
    END IF;
    IF OLD.relationship_origin_contract_version = 0
       AND NEW.relationship_origin_contract_version = 1
       AND (
         NEW.relationship_origin_kind <> 'MARKETPLACE'
         OR NEW.relationship_origin_policy_version <> 1
         OR NEW.relationship_origin_intake_consent_version <> 'v1'
         OR NEW.task_id IS NOT NULL
         OR NEW.quote_id IS NOT NULL
       ) THEN
      RAISE EXCEPTION 'HXUV1-REL-28: public precontract promotion is Marketplace intake only'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS task_draft_relationship_origin_contract_guard
  ON public.task_drafts;
CREATE TRIGGER task_draft_relationship_origin_contract_guard
BEFORE UPDATE OF relationship_origin_contract_version,
  relationship_origin_kind, relationship_origin_policy_version,
  relationship_origin_intake_consent_version
ON public.task_drafts
FOR EACH ROW EXECUTE FUNCTION public.enforce_task_draft_relationship_origin_contract();

CREATE OR REPLACE FUNCTION public.bootstrap_task_draft_marketplace_relationship_origin()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.relationship_origin_contract_version = 1
     AND NEW.relationship_origin_kind = 'MARKETPLACE' THEN
    PERFORM public.ensure_universal_v1_marketplace_relationship_origin(NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS task_draft_marketplace_relationship_origin_bootstrap
  ON public.task_drafts;
CREATE TRIGGER task_draft_marketplace_relationship_origin_bootstrap
AFTER INSERT OR UPDATE OF relationship_origin_contract_version,
  relationship_origin_kind, relationship_origin_policy_version,
  relationship_origin_intake_consent_version
ON public.task_drafts
FOR EACH ROW EXECUTE FUNCTION public.bootstrap_task_draft_marketplace_relationship_origin();

CREATE OR REPLACE FUNCTION public.certify_task_draft_relationship_origin_presence()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.relationship_origin_contract_version = 1
     AND NOT EXISTS (
       SELECT 1 FROM public.universal_v1_relationship_origins origin
       WHERE origin.task_draft_id = NEW.id
         AND origin.origin_kind = NEW.relationship_origin_kind
         AND origin.policy_version = NEW.relationship_origin_policy_version
     ) THEN
    RAISE EXCEPTION 'HXUV1-REL-29: versioned TaskDraft requires an exact origin record by commit'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS task_draft_relationship_origin_presence_guard
  ON public.task_drafts;
CREATE CONSTRAINT TRIGGER task_draft_relationship_origin_presence_guard
AFTER INSERT OR UPDATE OF relationship_origin_contract_version,
  relationship_origin_kind, relationship_origin_policy_version
ON public.task_drafts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.certify_task_draft_relationship_origin_presence();

CREATE OR REPLACE FUNCTION public.enforce_relationship_origin_before_routing()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  draft public.task_drafts%ROWTYPE;
  origin public.universal_v1_relationship_origins%ROWTYPE;
BEGIN
  SELECT * INTO draft FROM public.task_drafts WHERE id = NEW.task_draft_id;
  IF draft.relationship_origin_contract_version = 0 THEN
    RETURN NEW;
  END IF;
  SELECT * INTO origin
  FROM public.universal_v1_relationship_origins candidate
  WHERE candidate.task_draft_id = draft.id
    AND candidate.origin_kind = draft.relationship_origin_kind
    AND candidate.policy_version = draft.relationship_origin_policy_version
  ORDER BY candidate.origin_version DESC
  LIMIT 1;
  IF origin.id IS NULL OR origin.routing_state <> 'ROUTING_READY'
     OR cardinality(origin.hold_reason_codes) <> 0 THEN
    RAISE EXCEPTION 'HXUV1-REL-30: routing requires the exact latest certified RelationshipOrigin'
      USING ERRCODE = 'P0001';
  END IF;
  -- Persist the certified read model on the route itself. The API reads this
  -- database-derived projection; caller evidence with the same keys is
  -- overwritten and cannot claim a different origin.
  NEW.evidence := COALESCE(NEW.evidence, '{}'::JSONB) || jsonb_build_object(
    'relationship_origin_contract_version', 1,
    'relationship_origin_id', origin.id,
    'relationship_origin_kind', origin.origin_kind,
    'relationship_origin_policy_version', origin.policy_version,
    'relationship_origin_version', origin.origin_version,
    'relationship_origin_routing_state', origin.routing_state,
    'relationship_origin_evidence_digest', origin.evidence_digest
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS universal_v1_relationship_origin_routing_guard
  ON public.task_routing_decisions;
CREATE TRIGGER universal_v1_relationship_origin_routing_guard
BEFORE INSERT ON public.task_routing_decisions
FOR EACH ROW EXECUTE FUNCTION public.enforce_relationship_origin_before_routing();

CREATE OR REPLACE FUNCTION public.prevent_universal_v1_relationship_origin_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'HXUV1-REL-1: RelationshipOrigin policy and evidence are append-only'
    USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS universal_v1_relationship_origin_policies_immutable
  ON public.universal_v1_relationship_origin_policies;
CREATE TRIGGER universal_v1_relationship_origin_policies_immutable
BEFORE UPDATE OR DELETE ON public.universal_v1_relationship_origin_policies
FOR EACH ROW EXECUTE FUNCTION public.prevent_universal_v1_relationship_origin_mutation();
DROP TRIGGER IF EXISTS universal_v1_relationship_origin_policies_no_truncate
  ON public.universal_v1_relationship_origin_policies;
CREATE TRIGGER universal_v1_relationship_origin_policies_no_truncate
BEFORE TRUNCATE ON public.universal_v1_relationship_origin_policies
FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_universal_v1_relationship_origin_mutation();

DROP TRIGGER IF EXISTS universal_v1_relationship_origin_observations_immutable
  ON public.universal_v1_relationship_origin_observations;
CREATE TRIGGER universal_v1_relationship_origin_observations_immutable
BEFORE UPDATE OR DELETE ON public.universal_v1_relationship_origin_observations
FOR EACH ROW EXECUTE FUNCTION public.prevent_universal_v1_relationship_origin_mutation();
DROP TRIGGER IF EXISTS universal_v1_relationship_origin_observations_no_truncate
  ON public.universal_v1_relationship_origin_observations;
CREATE TRIGGER universal_v1_relationship_origin_observations_no_truncate
BEFORE TRUNCATE ON public.universal_v1_relationship_origin_observations
FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_universal_v1_relationship_origin_mutation();

DROP TRIGGER IF EXISTS universal_v1_relationship_origins_immutable
  ON public.universal_v1_relationship_origins;
CREATE TRIGGER universal_v1_relationship_origins_immutable
BEFORE UPDATE OR DELETE ON public.universal_v1_relationship_origins
FOR EACH ROW EXECUTE FUNCTION public.prevent_universal_v1_relationship_origin_mutation();
DROP TRIGGER IF EXISTS universal_v1_relationship_origins_no_truncate
  ON public.universal_v1_relationship_origins;
CREATE TRIGGER universal_v1_relationship_origins_no_truncate
BEFORE TRUNCATE ON public.universal_v1_relationship_origins
FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_universal_v1_relationship_origin_mutation();

REVOKE ALL ON TABLE public.universal_v1_relationship_origin_policies FROM PUBLIC;
REVOKE ALL ON TABLE public.universal_v1_relationship_origin_observations FROM PUBLIC;
REVOKE ALL ON TABLE public.universal_v1_relationship_origins FROM PUBLIC;
REVOKE ALL ON FUNCTION public.universal_v1_relationship_deterministic_uuid(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.universal_v1_relationship_subject_binding(TEXT, UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.universal_v1_relationship_observation_digest(
  UUID, SMALLINT, TEXT, INTEGER, UUID, TEXT, TEXT, TEXT, UUID, UUID,
  CHAR, TEXT, CHAR, UUID
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.universal_v1_relationship_origin_digest(
  UUID, SMALLINT, TEXT, INTEGER, UUID, UUID, UUID, UUID, UUID, UUID,
  CHAR, CHAR, CHAR, CHAR, CHAR, TEXT, TEXT[]
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ensure_universal_v1_marketplace_relationship_origin(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_universal_v1_relationship_observation() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_universal_v1_relationship_origin() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_task_draft_relationship_origin_contract() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bootstrap_task_draft_marketplace_relationship_origin() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.certify_task_draft_relationship_origin_presence() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_relationship_origin_before_routing() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prevent_universal_v1_relationship_origin_mutation() FROM PUBLIC;

COMMENT ON TABLE public.universal_v1_relationship_origin_policies IS
  'Closed v1 policy matrix. Origin is observation-only and grants no assignment, address, eligibility, financial, Work Order, or fee authority.';
COMMENT ON TABLE public.universal_v1_relationship_origin_observations IS
  'Versioned immutable privacy-safe identity/link/consent observations for one TaskDraft origin.';
COMMENT ON TABLE public.universal_v1_relationship_origins IS
  'Versioned immutable RelationshipOrigin certification for one TaskDraft; provider references are not selection or assignment.';
