-- HX/OS legal authority: a production region policy may be enabled only by an
-- immutable, current, revision-bound counsel approval document.

CREATE TABLE IF NOT EXISTS region_policy_legal_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  region_policy_id UUID NOT NULL REFERENCES region_policies(id) ON DELETE RESTRICT,
  policy_hash CHAR(64) NOT NULL CHECK (policy_hash ~ '^[a-f0-9]{64}$'),
  approval_document JSONB NOT NULL CHECK (jsonb_typeof(approval_document) = 'object'),
  approval_document_hash CHAR(64) NOT NULL CHECK (approval_document_hash ~ '^[a-f0-9]{64}$'),
  evidence_uri TEXT NOT NULL CHECK (evidence_uri ~ '^https://[^[:space:]]+$'),
  evidence_sha256 CHAR(64) NOT NULL CHECK (evidence_sha256 ~ '^[a-f0-9]{64}$'),
  counsel_name TEXT NOT NULL CHECK (nullif(btrim(counsel_name), '') IS NOT NULL),
  counsel_organization TEXT NOT NULL CHECK (nullif(btrim(counsel_organization), '') IS NOT NULL),
  policy_owner TEXT NOT NULL CHECK (nullif(btrim(policy_owner), '') IS NOT NULL),
  activation_owner TEXT NOT NULL CHECK (nullif(btrim(activation_owner), '') IS NOT NULL),
  approved_at TIMESTAMPTZ NOT NULL,
  effective_at TIMESTAMPTZ NOT NULL,
  review_at TIMESTAMPTZ NOT NULL,
  activated_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (region_policy_id),
  CHECK (approved_at <= effective_at),
  CHECK (effective_at < review_at)
);

CREATE OR REPLACE FUNCTION validate_region_policy_legal_approval()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_policy region_policies%ROWTYPE;
  v_scope JSONB;
  v_approval JSONB;
  v_categories TEXT[];
  v_policy_categories TEXT[];
  v_approved_at TIMESTAMPTZ;
  v_effective_at TIMESTAMPTZ;
  v_review_at TIMESTAMPTZ;
  v_engine_approved TEXT;
  v_engine_deployed TEXT;
  v_site_approved TEXT;
  v_site_deployed TEXT;
  v_determination TEXT;
BEGIN
  IF NEW.approval_document_hash <> encode(digest(NEW.approval_document::text, 'sha256'), 'hex') THEN
    RAISE EXCEPTION 'HXRPLA1: approval document hash mismatch' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_policy
  FROM region_policies
  WHERE id = NEW.region_policy_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HXRPLA2: governed region policy is unavailable' USING ERRCODE = 'P0001';
  END IF;
  IF v_policy.policy_state <> 'ACTIVE'
     OR v_policy.production_enabled <> FALSE
     OR v_policy.approval_state <> 'COUNSEL_APPROVAL_REQUIRED'
     OR v_policy.approval_reference IS NOT NULL THEN
    RAISE EXCEPTION 'HXRPLA2: governed region policy is not pending production approval' USING ERRCODE = 'P0001';
  END IF;

  IF NEW.approval_document->>'gate_id' IS DISTINCT FROM 'EXT-LEGAL-001'
     OR NEW.approval_document->>'decision' IS DISTINCT FROM 'APPROVED'
     OR NEW.approval_document->>'schema_version' IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'HXRPLA3: approval schema, gate, or decision is invalid' USING ERRCODE = 'P0001';
  END IF;

  v_scope := NEW.approval_document->'scope';
  v_approval := NEW.approval_document->'approval';
  IF jsonb_typeof(v_scope) IS DISTINCT FROM 'object'
     OR jsonb_typeof(v_approval) IS DISTINCT FROM 'object'
     OR v_scope->>'jurisdiction_code' IS DISTINCT FROM v_policy.region_code
     OR v_scope->>'policy_version' IS DISTINCT FROM v_policy.version
     OR v_scope->>'policy_hash' IS DISTINCT FROM v_policy.policy_hash::TEXT
     OR NEW.policy_hash IS DISTINCT FROM v_policy.policy_hash THEN
    RAISE EXCEPTION 'HXRPLA4: approval policy identity mismatch' USING ERRCODE = 'P0001';
  END IF;

  IF jsonb_typeof(v_scope->'local_jurisdictions') IS DISTINCT FROM 'array'
     OR jsonb_array_length(v_scope->'local_jurisdictions') = 0
     OR jsonb_typeof(v_scope->'prohibited_scope') IS DISTINCT FROM 'array'
     OR jsonb_array_length(v_scope->'prohibited_scope') = 0 THEN
    RAISE EXCEPTION 'HXRPLA5: local jurisdiction or prohibited scope is missing' USING ERRCODE = 'P0001';
  END IF;

  IF jsonb_typeof(v_scope->'permitted_categories') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'HXRPLA8: approval category scope does not match policy' USING ERRCODE = 'P0001';
  END IF;
  SELECT array_agg(value ORDER BY value) INTO v_categories
  FROM jsonb_array_elements_text(v_scope->'permitted_categories');
  SELECT array_agg(key ORDER BY key) INTO v_policy_categories
  FROM jsonb_object_keys(v_policy.policy_document->'categories') AS key;
  IF v_categories IS DISTINCT FROM v_policy_categories THEN
    RAISE EXCEPTION 'HXRPLA8: approval category scope does not match policy' USING ERRCODE = 'P0001';
  END IF;

  IF nullif(btrim(v_approval#>>'{counsel,name}'), '') IS NULL
     OR nullif(btrim(v_approval#>>'{counsel,organization}'), '') IS NULL
     OR jsonb_typeof(v_approval#>'{counsel,licensed_jurisdictions}') IS DISTINCT FROM 'array'
     OR NOT (v_approval#>'{counsel,licensed_jurisdictions}' ? 'WA')
     OR nullif(btrim(v_approval->>'policy_owner'), '') IS NULL
     OR nullif(btrim(v_approval->>'activation_owner'), '') IS NULL THEN
    RAISE EXCEPTION 'HXRPLA6: counsel qualification or accountable owner is missing' USING ERRCODE = 'P0001';
  END IF;

  BEGIN
    v_approved_at := (v_approval->>'approved_at')::TIMESTAMPTZ;
    v_effective_at := (v_approval->>'effective_at')::TIMESTAMPTZ;
    v_review_at := (v_approval->>'review_at')::TIMESTAMPTZ;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'HXRPLA7: approval dates are invalid' USING ERRCODE = 'P0001';
  END;
  IF v_approved_at > v_effective_at
     OR v_effective_at > clock_timestamp()
     OR v_review_at <= clock_timestamp()
     OR v_effective_at >= v_review_at
     OR NEW.approved_at IS DISTINCT FROM v_approved_at
     OR NEW.effective_at IS DISTINCT FROM v_effective_at
     OR NEW.review_at IS DISTINCT FROM v_review_at THEN
    RAISE EXCEPTION 'HXRPLA7: approval dates are invalid, ineffective, or expired' USING ERRCODE = 'P0001';
  END IF;

  IF jsonb_typeof(v_approval->'exceptions') IS DISTINCT FROM 'array'
     OR jsonb_typeof(v_approval->'determinations') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'HXRPLA9: legal determinations or exceptions are incomplete' USING ERRCODE = 'P0001';
  END IF;
  FOREACH v_determination IN ARRAY ARRAY[
    'worker_classification',
    'category_licensing',
    'screening_and_adverse_action',
    'privacy_and_retention',
    'payments_payouts_and_tax',
    'disputes_arbitration_and_liability',
    'safety_location_and_recording'
  ] LOOP
    IF v_approval->'determinations'->>v_determination IS DISTINCT FROM 'APPROVED' THEN
      RAISE EXCEPTION 'HXRPLA9: legal determinations or exceptions are incomplete' USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  IF v_approval#>>'{evidence,uri}' IS DISTINCT FROM NEW.evidence_uri
     OR v_approval#>>'{evidence,sha256}' IS DISTINCT FROM NEW.evidence_sha256::TEXT
     OR NEW.evidence_uri !~ '^https://[^[:space:]]+$'
     OR NEW.evidence_sha256 !~ '^[a-f0-9]{64}$'
     OR nullif(btrim(v_approval#>>'{evidence,signature_method}'), '') IS NULL THEN
    RAISE EXCEPTION 'HXRPLA10: signed external approval evidence is invalid' USING ERRCODE = 'P0001';
  END IF;

  v_engine_approved := NEW.approval_document#>>'{release_bindings,engine,approved_revision}';
  v_engine_deployed := NEW.approval_document#>>'{release_bindings,engine,deployed_revision}';
  v_site_approved := NEW.approval_document#>>'{release_bindings,site,approved_revision}';
  v_site_deployed := NEW.approval_document#>>'{release_bindings,site,deployed_revision}';
  IF NEW.approval_document#>>'{release_bindings,engine,repository}' IS DISTINCT FROM 'Sebdysart/hustlexp-ai-backend'
     OR NEW.approval_document#>>'{release_bindings,site,repository}' IS DISTINCT FROM 'Sebdysart/hustlexp-site'
     OR v_engine_approved !~ '^[a-f0-9]{40}$'
     OR v_engine_deployed !~ '^[a-f0-9]{40}$'
     OR v_site_approved !~ '^[a-f0-9]{40}$'
     OR v_site_deployed !~ '^[a-f0-9]{40}$'
     OR nullif(btrim(NEW.approval_document#>>'{release_bindings,engine,deployment_id}'), '') IS NULL
     OR nullif(btrim(NEW.approval_document#>>'{release_bindings,site,deployment_id}'), '') IS NULL THEN
    RAISE EXCEPTION 'HXRPLA11: release binding is incomplete' USING ERRCODE = 'P0001';
  END IF;
  IF v_engine_approved IS DISTINCT FROM v_engine_deployed
     OR v_site_approved IS DISTINCT FROM v_site_deployed THEN
    RAISE EXCEPTION 'HXRPLA12: approved and deployed revisions must match' USING ERRCODE = 'P0001';
  END IF;

  IF NEW.counsel_name IS DISTINCT FROM v_approval#>>'{counsel,name}'
     OR NEW.counsel_organization IS DISTINCT FROM v_approval#>>'{counsel,organization}'
     OR NEW.policy_owner IS DISTINCT FROM v_approval->>'policy_owner'
     OR NEW.activation_owner IS DISTINCT FROM v_approval->>'activation_owner' THEN
    RAISE EXCEPTION 'HXRPLA13: approval projection does not match document' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS region_policy_legal_approval_valid ON region_policy_legal_approvals;
CREATE TRIGGER region_policy_legal_approval_valid
BEFORE INSERT ON region_policy_legal_approvals
FOR EACH ROW EXECUTE FUNCTION validate_region_policy_legal_approval();

CREATE OR REPLACE FUNCTION prevent_region_policy_legal_approval_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'HXRPLA19: region policy legal approvals are append-only' USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS region_policy_legal_approval_immutable ON region_policy_legal_approvals;
CREATE TRIGGER region_policy_legal_approval_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON region_policy_legal_approvals
FOR EACH STATEMENT EXECUTE FUNCTION prevent_region_policy_legal_approval_mutation();

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON region_policy_legal_approvals FROM PUBLIC;

CREATE OR REPLACE FUNCTION prevent_region_policy_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'HXRP3: region policies cannot be deleted' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.policy_state = 'DRAFT' THEN
    RETURN NEW;
  END IF;
  IF OLD.policy_state = 'ACTIVE'
     AND NEW.policy_state = 'RETIRED'
     AND (to_jsonb(NEW) - 'policy_state') = (to_jsonb(OLD) - 'policy_state') THEN
    RETURN NEW;
  END IF;
  IF OLD.policy_state = 'ACTIVE'
     AND NEW.policy_state = 'ACTIVE'
     AND OLD.production_enabled = FALSE
     AND NEW.production_enabled = TRUE
     AND OLD.approval_state = 'COUNSEL_APPROVAL_REQUIRED'
     AND NEW.approval_state = 'COUNSEL_APPROVED'
     AND (to_jsonb(NEW) - 'production_enabled' - 'approval_state' - 'approval_reference') =
         (to_jsonb(OLD) - 'production_enabled' - 'approval_state' - 'approval_reference')
     AND EXISTS (
       SELECT 1
       FROM region_policy_legal_approvals approval
       WHERE approval.region_policy_id = OLD.id
         AND approval.policy_hash = OLD.policy_hash
         AND approval.effective_at <= clock_timestamp()
         AND approval.review_at > clock_timestamp()
         AND NEW.approval_reference = 'region-policy-legal-approval:' || approval.id::TEXT
     ) THEN
    RETURN NEW;
  END IF;
  IF to_jsonb(NEW) = to_jsonb(OLD) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'HXRP4: active or retired region policy is immutable' USING ERRCODE = 'P0001';
END;
$$;

CREATE OR REPLACE FUNCTION activate_region_policy_with_legal_approval(
  p_region_policy_id UUID,
  p_approval_document JSONB,
  p_approval_document_hash TEXT,
  p_actor_id UUID
)
RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE
  v_policy region_policies%ROWTYPE;
  v_existing region_policy_legal_approvals%ROWTYPE;
  v_approval JSONB;
  v_approval_id UUID := gen_random_uuid();
BEGIN
  SELECT * INTO v_policy
  FROM region_policies
  WHERE id = p_region_policy_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HXRPLA14: region policy does not exist' USING ERRCODE = 'P0001';
  END IF;

  IF v_policy.production_enabled THEN
    SELECT * INTO v_existing
    FROM region_policy_legal_approvals
    WHERE region_policy_id = v_policy.id;
    IF FOUND AND v_existing.approval_document_hash = p_approval_document_hash THEN
      RETURN v_existing.id;
    END IF;
    RAISE EXCEPTION 'HXRPLA15: production policy has different approval evidence' USING ERRCODE = 'P0001';
  END IF;

  IF v_policy.policy_state <> 'ACTIVE'
     OR v_policy.approval_state <> 'COUNSEL_APPROVAL_REQUIRED'
     OR p_approval_document_hash !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'HXRPLA16: region policy is not eligible for production activation' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = p_actor_id) THEN
    RAISE EXCEPTION 'HXRPLA17: accountable activation actor is required' USING ERRCODE = 'P0001';
  END IF;

  v_approval := p_approval_document->'approval';
  INSERT INTO region_policy_legal_approvals (
    id, region_policy_id, policy_hash, approval_document, approval_document_hash,
    evidence_uri, evidence_sha256, counsel_name, counsel_organization,
    policy_owner, activation_owner, approved_at, effective_at, review_at, activated_by
  ) VALUES (
    v_approval_id,
    v_policy.id,
    v_policy.policy_hash,
    p_approval_document,
    p_approval_document_hash,
    v_approval#>>'{evidence,uri}',
    v_approval#>>'{evidence,sha256}',
    v_approval#>>'{counsel,name}',
    v_approval#>>'{counsel,organization}',
    v_approval->>'policy_owner',
    v_approval->>'activation_owner',
    (v_approval->>'approved_at')::TIMESTAMPTZ,
    (v_approval->>'effective_at')::TIMESTAMPTZ,
    (v_approval->>'review_at')::TIMESTAMPTZ,
    p_actor_id
  );

  UPDATE region_policies
  SET approval_state = 'COUNSEL_APPROVED',
      approval_reference = 'region-policy-legal-approval:' || v_approval_id::TEXT,
      production_enabled = TRUE
  WHERE id = v_policy.id;

  INSERT INTO region_policy_events (
    region_policy_id, event_type, actor_id, policy_hash, public_reason
  ) VALUES (
    v_policy.id,
    'PRODUCTION_APPROVED',
    p_actor_id,
    v_policy.policy_hash,
    'Exact revision-bound Washington policy approved for production by qualified counsel and the named policy owner.'
  );
  RETURN v_approval_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION activate_region_policy_with_legal_approval(UUID, JSONB, TEXT, UUID)
FROM PUBLIC;

CREATE OR REPLACE FUNCTION enforce_production_region_policy_legal_approval()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.automation_classification = 'PRODUCTION'
     AND NOT EXISTS (
       SELECT 1
       FROM region_policies policy
       JOIN region_policy_legal_approvals approval
         ON approval.region_policy_id = policy.id
       WHERE policy.id = NEW.region_policy_id
         AND policy.policy_state = 'ACTIVE'
         AND policy.production_enabled = TRUE
         AND policy.approval_state = 'COUNSEL_APPROVED'
         AND policy.approval_reference = 'region-policy-legal-approval:' || approval.id::TEXT
         AND approval.policy_hash = policy.policy_hash
         AND approval.effective_at <= clock_timestamp()
         AND approval.review_at > clock_timestamp()
     ) THEN
    RAISE EXCEPTION 'HXRPLA18: production legal approval is missing, expired, or mismatched' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS task_region_policy_legal_approval_gate ON tasks;
CREATE TRIGGER task_region_policy_legal_approval_gate
BEFORE INSERT OR UPDATE OF automation_classification, region_policy_id,
  region_policy_hash, region_policy_version, region_code
ON tasks FOR EACH ROW EXECUTE FUNCTION enforce_production_region_policy_legal_approval();
