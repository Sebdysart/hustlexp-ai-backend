BEGIN;
CREATE TABLE IF NOT EXISTS business_quote_eligibility_decisions (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 quote_id UUID NOT NULL UNIQUE REFERENCES quotes(id) ON DELETE RESTRICT,
 quote_version_id UUID NOT NULL REFERENCES quote_versions(id) ON DELETE RESTRICT,
 task_draft_id UUID NOT NULL REFERENCES task_drafts(id) ON DELETE RESTRICT,
 business_organization_id UUID NOT NULL REFERENCES business_organizations(id) ON DELETE RESTRICT,
 service_profile_id UUID NOT NULL REFERENCES business_service_profiles(id) ON DELETE RESTRICT,
 action TEXT NOT NULL CHECK(action='SUBMIT_QUOTE'),
 primary_category TEXT NOT NULL REFERENCES service_categories(code),
 jurisdiction_code TEXT NOT NULL,
 category_policy_id UUID NOT NULL REFERENCES service_category_policies(id) ON DELETE RESTRICT,
 policy_version INTEGER NOT NULL, policy_hash TEXT NOT NULL CHECK(policy_hash ~ '^[a-f0-9]{64}$'),
 decision TEXT NOT NULL CHECK(decision='ALLOW'), reason_codes JSONB NOT NULL DEFAULT '[]'::jsonb,
 required_credential_snapshot JSONB NOT NULL CHECK(jsonb_typeof(required_credential_snapshot)='array'),
 credential_snapshot JSONB NOT NULL CHECK(jsonb_typeof(credential_snapshot)='array'),
 service_profile_snapshot JSONB NOT NULL,
 evaluated_at TIMESTAMPTZ NOT NULL, eligibility_service_version TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS business_quote_eligibility_organization_idx
 ON business_quote_eligibility_decisions(business_organization_id,created_at DESC);
CREATE INDEX IF NOT EXISTS business_quote_eligibility_credentials_idx
 ON business_quote_eligibility_decisions USING gin(credential_snapshot jsonb_path_ops);
DROP TRIGGER IF EXISTS business_quote_eligibility_immutable ON business_quote_eligibility_decisions;
CREATE TRIGGER business_quote_eligibility_immutable BEFORE UPDATE OR DELETE ON business_quote_eligibility_decisions
 FOR EACH ROW EXECUTE FUNCTION prevent_business_eligibility_history_mutation();
CREATE OR REPLACE FUNCTION validate_business_quote_eligibility_binding() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM quotes q JOIN quote_versions v ON v.quote_id=q.id
   JOIN task_drafts d ON d.id=q.task_draft_id
   JOIN business_service_profiles p ON p.id=NEW.service_profile_id
   JOIN service_category_policies policy ON policy.id=NEW.category_policy_id
   JOIN service_categories c ON c.id=policy.service_category_id
   WHERE q.id=NEW.quote_id AND q.task_draft_id=NEW.task_draft_id
     AND q.business_organization_id=NEW.business_organization_id
     AND v.id=NEW.quote_version_id AND p.organization_id=q.business_organization_id
     AND p.service_code=NEW.primary_category AND c.code=NEW.primary_category
     AND d.category=NEW.primary_category AND d.region_code=NEW.jurisdiction_code
     AND policy.policy_version=NEW.policy_version AND policy.jurisdiction_code=NEW.jurisdiction_code) THEN
   RAISE EXCEPTION 'Business quote eligibility binding mismatch';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS business_quote_eligibility_binding ON business_quote_eligibility_decisions;
CREATE TRIGGER business_quote_eligibility_binding BEFORE INSERT ON business_quote_eligibility_decisions
 FOR EACH ROW EXECUTE FUNCTION validate_business_quote_eligibility_binding();
CREATE TABLE IF NOT EXISTS task_draft_category_corrections (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), task_draft_id UUID NOT NULL REFERENCES task_drafts(id) ON DELETE RESTRICT,
 previous_category TEXT NOT NULL, new_category TEXT NOT NULL REFERENCES service_categories(code),
 changed_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 reason TEXT NOT NULL CHECK(char_length(btrim(reason)) BETWEEN 3 AND 2000),
 CHECK(previous_category<>new_category)
);
CREATE INDEX IF NOT EXISTS task_draft_category_correction_history_idx ON task_draft_category_corrections(task_draft_id,changed_at DESC);
DROP TRIGGER IF EXISTS task_draft_category_correction_immutable ON task_draft_category_corrections;
CREATE TRIGGER task_draft_category_correction_immutable BEFORE UPDATE OR DELETE ON task_draft_category_corrections
 FOR EACH ROW EXECUTE FUNCTION prevent_business_eligibility_history_mutation();
CREATE OR REPLACE FUNCTION protect_quoted_task_category() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.category IS DISTINCT FROM OLD.category AND (OLD.task_id IS NOT NULL OR EXISTS(
   SELECT 1 FROM quotes WHERE task_draft_id=OLD.id AND business_organization_id IS NOT NULL)) THEN
   RAISE EXCEPTION 'Category cannot change after a business quote or canonical task';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS protect_quoted_task_category_trigger ON task_drafts;
CREATE TRIGGER protect_quoted_task_category_trigger BEFORE UPDATE OF category ON task_drafts
 FOR EACH ROW EXECUTE FUNCTION protect_quoted_task_category();
CREATE TABLE IF NOT EXISTS business_credential_review_signals (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id UUID NOT NULL REFERENCES business_organizations(id),
 credential_id UUID NOT NULL REFERENCES business_credentials(id), quote_id UUID NOT NULL REFERENCES quotes(id),
 task_id UUID REFERENCES tasks(id), reason TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(credential_id,quote_id)
);
CREATE INDEX IF NOT EXISTS business_credential_review_signals_org_idx
 ON business_credential_review_signals(organization_id,created_at DESC);
DROP TRIGGER IF EXISTS business_credential_review_signal_immutable ON business_credential_review_signals;
CREATE TRIGGER business_credential_review_signal_immutable BEFORE UPDATE OR DELETE ON business_credential_review_signals
 FOR EACH ROW EXECUTE FUNCTION prevent_business_eligibility_history_mutation();
-- Credential snapshots contain private numbers/evidence metadata. Match the
-- existing server-only credential history and private-media access boundary.
DO $$ DECLARE table_name TEXT; BEGIN
 FOREACH table_name IN ARRAY ARRAY['business_quote_eligibility_decisions','task_draft_category_corrections','business_credential_review_signals'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
  EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC',table_name);
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
   EXECUTE format('REVOKE ALL ON TABLE %I FROM anon',table_name);
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
   EXECUTE format('REVOKE ALL ON TABLE %I FROM authenticated',table_name);
  END IF;
 END LOOP;
END $$;
COMMIT;
