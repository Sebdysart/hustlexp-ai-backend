-- Stage-1 category policy: deliberately no legal conclusions are seeded.
BEGIN;
CREATE TABLE IF NOT EXISTS service_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE CHECK (code IN ('yard','cleaning','moving','assembly','delivery','handyman','home_services','auto','events','pet_care','painting','plumbing','electrical','other')),
  display_name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','RETIRED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO service_categories (code,display_name) VALUES
 ('yard','Yard work'),('cleaning','Cleaning'),('moving','Moving help'),('assembly','Assembly'),
 ('delivery','Pickup & delivery'),('handyman','Handyman'),('home_services','Home services'),
 ('auto','Auto help'),('events','Event help'),('pet_care','Pet care'),('painting','Painting'),
 ('plumbing','Plumbing'),('electrical','Electrical'),('other','General task')
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS credential_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), code TEXT NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9_]{2,80}$'),
  display_name TEXT NOT NULL, credential_kind TEXT NOT NULL,
  issuing_authority TEXT, jurisdiction_code TEXT CHECK (jurisdiction_code ~ '^US-[A-Z]{2}(-[A-Z0-9_-]+)?$'),
  supports_expiration BOOLEAN NOT NULL DEFAULT TRUE,
  requires_number BOOLEAN NOT NULL DEFAULT TRUE, requires_evidence BOOLEAN NOT NULL DEFAULT TRUE,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','RETIRED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Credential types/requirements are intentionally empty until approved Ops configuration.
CREATE TABLE IF NOT EXISTS service_category_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_category_id UUID NOT NULL REFERENCES service_categories(id) ON DELETE RESTRICT,
  jurisdiction_code TEXT NOT NULL CHECK (jurisdiction_code ~ '^US-[A-Z]{2}(-[A-Z0-9_-]+)?$'),
  policy_status TEXT NOT NULL CHECK (policy_status IN ('UNRESTRICTED','CREDENTIAL_REQUIRED','MANUAL_REVIEW_REQUIRED','DISABLED')),
  policy_version INTEGER NOT NULL CHECK (policy_version > 0),
  effective_from TIMESTAMPTZ NOT NULL, effective_to TIMESTAMPTZ,
  manual_review_required BOOLEAN NOT NULL DEFAULT FALSE, notes TEXT,
  created_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  UNIQUE(service_category_id,jurisdiction_code,policy_version)
);
CREATE INDEX IF NOT EXISTS service_category_policy_effective_idx
 ON service_category_policies(service_category_id,jurisdiction_code,effective_from DESC);
CREATE TABLE IF NOT EXISTS service_credential_requirements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_category_policy_id UUID NOT NULL REFERENCES service_category_policies(id) ON DELETE RESTRICT,
  credential_type_id UUID NOT NULL REFERENCES credential_types(id) ON DELETE RESTRICT,
  required BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(service_category_policy_id,credential_type_id)
);
INSERT INTO service_category_policies
 (service_category_id,jurisdiction_code,policy_status,policy_version,effective_from,manual_review_required,notes)
SELECT id, 'US-WA', 'MANUAL_REVIEW_REQUIRED', 1, '2020-01-01T00:00:00Z', TRUE,
 'Conservative launch default: no category is declared legally unrestricted. Ops must review the exact service or publish an approved policy. Other tasks require category correction.'
FROM service_categories c WHERE NOT EXISTS (SELECT 1 FROM service_category_policies p WHERE p.service_category_id=c.id AND p.jurisdiction_code='US-WA' AND p.policy_version=1)
ON CONFLICT(service_category_id,jurisdiction_code,policy_version) DO NOTHING;

CREATE OR REPLACE FUNCTION guard_service_category_policy() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Business category policy history is immutable'; END IF;
 IF TG_OP='UPDATE' AND ((to_jsonb(NEW)-'effective_to') IS DISTINCT FROM (to_jsonb(OLD)-'effective_to')
   OR OLD.effective_to IS NOT NULL OR NEW.effective_to IS NULL) THEN
   RAISE EXCEPTION 'Only closing an effective policy interval is permitted';
 END IF;
 PERFORM id FROM service_categories WHERE id=NEW.service_category_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM service_categories WHERE id=NEW.service_category_id AND code='other')
   AND (NEW.policy_status<>'MANUAL_REVIEW_REQUIRED' OR NOT NEW.manual_review_required) THEN
   RAISE EXCEPTION 'Other must remain manual review until the task is reclassified';
 END IF;
 IF EXISTS(SELECT 1 FROM service_category_policies p WHERE p.id<>NEW.id
   AND p.service_category_id=NEW.service_category_id AND p.jurisdiction_code=NEW.jurisdiction_code
   AND p.effective_from < COALESCE(NEW.effective_to,'infinity'::timestamptz)
   AND NEW.effective_from < COALESCE(p.effective_to,'infinity'::timestamptz)) THEN
   RAISE EXCEPTION 'Business category policies cannot overlap';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS service_category_policy_guard ON service_category_policies;
CREATE TRIGGER service_category_policy_guard BEFORE INSERT OR UPDATE OR DELETE ON service_category_policies
 FOR EACH ROW EXECUTE FUNCTION guard_service_category_policy();
CREATE OR REPLACE FUNCTION prevent_business_eligibility_history_mutation() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Business eligibility history is immutable'; END $$;
DROP TRIGGER IF EXISTS service_credential_requirement_immutable ON service_credential_requirements;
CREATE TRIGGER service_credential_requirement_immutable BEFORE UPDATE OR DELETE ON service_credential_requirements
 FOR EACH ROW EXECUTE FUNCTION prevent_business_eligibility_history_mutation();

ALTER TABLE business_service_profiles ADD COLUMN IF NOT EXISTS service_category_id UUID REFERENCES service_categories(id) ON DELETE RESTRICT;
ALTER TABLE business_service_profiles ADD COLUMN IF NOT EXISTS selected_by_business BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE business_service_profiles ADD COLUMN IF NOT EXISTS eligibility_status TEXT NOT NULL DEFAULT 'DECLARED'
 CHECK (eligibility_status IN ('DECLARED','PENDING_REVIEW','ELIGIBLE','BLOCKED'));
ALTER TABLE business_service_profiles ADD COLUMN IF NOT EXISTS eligibility_reason TEXT;
ALTER TABLE business_service_profiles ADD COLUMN IF NOT EXISTS eligibility_reviewed_at TIMESTAMPTZ;
ALTER TABLE business_service_profiles ADD COLUMN IF NOT EXISTS eligibility_reviewed_by UUID REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE business_service_profiles ADD COLUMN IF NOT EXISTS eligibility_reviewed_policy_id UUID REFERENCES service_category_policies(id) ON DELETE RESTRICT;
ALTER TABLE business_service_profiles DROP CONSTRAINT IF EXISTS business_service_profiles_service_code_check;
ALTER TABLE business_service_profiles ADD CONSTRAINT business_service_profiles_service_code_check CHECK (service_code ~ '^[A-Za-z0-9_-]{2,40}$');
-- The historical constraint allowed uppercase only, so known lowercase normalization
-- cannot collide with a separately valid lowercase legacy row. Keep unknown custom
-- identifiers intact, without canonical authority or an invented mapping.
UPDATE business_service_profiles p SET service_code=c.code,service_category_id=c.id,
 selected_by_business=TRUE,eligibility_status='PENDING_REVIEW',eligibility_reason='Initial policy review required'
FROM service_categories c WHERE lower(p.service_code)=c.code AND p.service_category_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS business_service_profile_category_unique
 ON business_service_profiles(organization_id,service_category_id) WHERE service_category_id IS NOT NULL;
CREATE OR REPLACE FUNCTION business_canonical_service_code(value TEXT) RETURNS TEXT LANGUAGE SQL STABLE AS $$
 SELECT COALESCE((SELECT code FROM service_categories WHERE code=lower(btrim(value))),btrim(value))
$$;
CREATE OR REPLACE FUNCTION normalize_business_service_category() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE category_id UUID;
BEGIN
 NEW.service_code=business_canonical_service_code(NEW.service_code);
 SELECT id INTO category_id FROM service_categories WHERE code=NEW.service_code;
 IF NEW.service_category_id IS NOT NULL AND NEW.service_category_id IS DISTINCT FROM category_id THEN
   RAISE EXCEPTION 'Service profile category identity mismatch';
 END IF;
 NEW.service_category_id=category_id;
 IF category_id IS NULL THEN NEW.selected_by_business=FALSE; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS normalize_business_service_category_trigger ON business_service_profiles;
CREATE TRIGGER normalize_business_service_category_trigger BEFORE INSERT OR UPDATE OF service_code,service_category_id
 ON business_service_profiles FOR EACH ROW EXECUTE FUNCTION normalize_business_service_category();
-- Retain the advanced operation and its full validation/audit/idempotency contract;
-- replace only its obsolete uppercase normalization, including replay comparison.
DO $$ DECLARE procedure_text TEXT; procedure_oid OID;
BEGIN
 SELECT oid INTO procedure_oid FROM pg_proc WHERE proname='create_business_service_profile' AND pronamespace='public'::regnamespace;
 IF procedure_oid IS NOT NULL THEN
   SELECT pg_get_functiondef(procedure_oid) INTO procedure_text;
   EXECUTE replace(procedure_text,'upper(btrim(p_service_code))','business_canonical_service_code(p_service_code)');
 END IF;
END $$;
-- Policy configuration is writable only through the audited Ops server APIs,
-- even on deployments with inherited public schema grants.
DO $$ DECLARE table_name TEXT; BEGIN
 FOREACH table_name IN ARRAY ARRAY['service_categories','service_category_policies','credential_types','service_credential_requirements'] LOOP
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
