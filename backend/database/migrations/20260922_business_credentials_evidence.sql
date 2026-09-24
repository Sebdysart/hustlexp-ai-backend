-- Stage-1 organization credentials reuse private, sanitized media receipts.
-- Depends on 20261007_business_service_category_policy.sql.
BEGIN;

ALTER TABLE business_locations ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'OPERATING_LOCATION'
  CHECK (purpose IN ('OPERATING_LOCATION','BUSINESS_ADDRESS'));
CREATE UNIQUE INDEX IF NOT EXISTS business_locations_one_business_address
  ON business_locations(organization_id) WHERE purpose='BUSINESS_ADDRESS' AND status='ACTIVE';

ALTER TABLE business_credentials
  ADD COLUMN IF NOT EXISTS credential_type_id UUID REFERENCES credential_types(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS credential_number TEXT,
  ADD COLUMN IF NOT EXISTS issuing_authority TEXT,
  ADD COLUMN IF NOT EXISTS jurisdiction_code TEXT,
  ADD COLUMN IF NOT EXISTS issued_at DATE,
  ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS current_version_id UUID,
  ADD COLUMN IF NOT EXISTS verification_notes TEXT,
  ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revoked_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
-- Only exact registry matches are backfilled. Legacy unrecognized strings remain
-- usable by legacy operations but cannot satisfy normalized quote requirements.
UPDATE business_credentials c SET credential_type_id=t.id
  FROM credential_types t WHERE c.credential_type=t.code AND c.credential_type_id IS NULL;

CREATE TABLE IF NOT EXISTS business_credential_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  credential_id UUID NOT NULL REFERENCES business_credentials(id) ON DELETE RESTRICT,
  organization_id UUID NOT NULL REFERENCES business_organizations(id) ON DELETE RESTRICT,
  submitted_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  submission_idempotency_key TEXT NOT NULL CHECK (length(submission_idempotency_key) BETWEEN 8 AND 128),
  submission_hash TEXT NOT NULL CHECK (submission_hash ~ '^[a-f0-9]{64}$'),
  snapshot JSONB NOT NULL CHECK (jsonb_typeof(snapshot)='object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(organization_id,submitted_by,submission_idempotency_key),
  UNIQUE(id,credential_id,organization_id)
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='business_credentials_current_version_fk') THEN
    ALTER TABLE business_credentials ADD CONSTRAINT business_credentials_current_version_fk
      FOREIGN KEY (current_version_id,id,organization_id)
      REFERENCES business_credential_versions(id,credential_id,organization_id) DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS business_credential_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  credential_id UUID NOT NULL REFERENCES business_credentials(id) ON DELETE RESTRICT,
  version_id UUID REFERENCES business_credential_versions(id) ON DELETE RESTRICT,
  organization_id UUID NOT NULL REFERENCES business_organizations(id) ON DELETE RESTRICT,
  actor_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK(status IN ('PENDING','ACTIVE','EXPIRED','REJECTED','REVOKED')),
  reason TEXT,
  snapshot JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY(version_id,credential_id,organization_id) REFERENCES business_credential_versions(id,credential_id,organization_id)
);
CREATE INDEX IF NOT EXISTS business_credential_events_history_idx ON business_credential_events(credential_id,created_at,id);
-- Preserve legacy current rows before the first normalized replacement.
INSERT INTO business_credential_events(credential_id,organization_id,actor_id,status,reason,snapshot)
SELECT c.id,c.organization_id,COALESCE(c.verified_by,o.created_by),c.status,'Legacy credential before versioned submissions',to_jsonb(c)
FROM business_credentials c JOIN business_organizations o ON o.id=c.organization_id
WHERE c.current_version_id IS NULL AND NOT EXISTS (SELECT 1 FROM business_credential_events e WHERE e.credential_id=c.id);

ALTER TABLE media_upload_receipts ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES business_organizations(id) ON DELETE RESTRICT;
ALTER TABLE media_upload_receipts DROP CONSTRAINT IF EXISTS media_upload_receipts_purpose_check;
ALTER TABLE media_upload_receipts ADD CONSTRAINT media_upload_receipts_purpose_check CHECK(purpose IN ('PROOF','MESSAGE','TASK_DRAFT_PHOTO','BUSINESS_CREDENTIAL'));
ALTER TABLE media_upload_receipts DROP CONSTRAINT IF EXISTS media_upload_receipts_consumed_kind_check;
ALTER TABLE media_upload_receipts ADD CONSTRAINT media_upload_receipts_consumed_kind_check CHECK(consumed_kind IS NULL OR consumed_kind IN ('PROOF','MESSAGE','TASK_DRAFT_PHOTO','BUSINESS_CREDENTIAL'));
ALTER TABLE media_upload_receipts DROP CONSTRAINT IF EXISTS media_upload_receipts_exact_target_ck;
ALTER TABLE media_upload_receipts ADD CONSTRAINT media_upload_receipts_exact_target_ck CHECK(
  (purpose IN ('PROOF','MESSAGE') AND task_id IS NOT NULL AND task_draft_id IS NULL AND organization_id IS NULL)
  OR (purpose='TASK_DRAFT_PHOTO' AND task_id IS NULL AND task_draft_id IS NOT NULL AND organization_id IS NULL)
  OR (purpose='BUSINESS_CREDENTIAL' AND task_id IS NULL AND task_draft_id IS NULL AND organization_id IS NOT NULL)
);
-- The existing receipt lifecycle/attestation trigger is retained. Extend its
-- immutable identity to cover the new exact organization target as well.
CREATE OR REPLACE FUNCTION hx_business_media_receipt_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    RAISE EXCEPTION 'HXMEDIA1: immutable organization receipt identity changed';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS business_media_receipt_identity_guard ON media_upload_receipts;
CREATE TRIGGER business_media_receipt_identity_guard BEFORE UPDATE ON media_upload_receipts
  FOR EACH ROW EXECUTE FUNCTION hx_business_media_receipt_identity_guard();

CREATE TABLE IF NOT EXISTS business_credential_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  credential_id UUID NOT NULL REFERENCES business_credentials(id) ON DELETE RESTRICT,
  version_id UUID NOT NULL REFERENCES business_credential_versions(id) ON DELETE RESTRICT,
  organization_id UUID NOT NULL REFERENCES business_organizations(id) ON DELETE RESTRICT,
  upload_receipt_id UUID NOT NULL UNIQUE REFERENCES media_upload_receipts(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY(version_id,credential_id,organization_id) REFERENCES business_credential_versions(id,credential_id,organization_id)
);
CREATE INDEX IF NOT EXISTS business_credential_evidence_version_idx ON business_credential_evidence(version_id);
CREATE TABLE IF NOT EXISTS business_credential_media_access_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  evidence_id UUID NOT NULL REFERENCES business_credential_evidence(id) ON DELETE RESTRICT,
  organization_id UUID NOT NULL REFERENCES business_organizations(id) ON DELETE RESTRICT,
  viewer_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  access_context TEXT NOT NULL CHECK(access_context IN ('BUSINESS','OPS')),
  signed_url_expires_at TIMESTAMPTZ NOT NULL,
  accessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
DO $$ DECLARE table_name TEXT; BEGIN
  FOREACH table_name IN ARRAY ARRAY['business_credential_versions','business_credential_events','business_credential_evidence','business_credential_media_access_log'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I',table_name||'_immutable',table_name);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION prevent_business_audit_mutation()',table_name||'_immutable',table_name);
    -- Match existing private media tables: only the trusted server DB owner may
    -- access credential documents/metadata; signed delivery reauthorizes callers.
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
