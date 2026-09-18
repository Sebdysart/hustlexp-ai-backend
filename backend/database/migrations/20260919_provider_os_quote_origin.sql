BEGIN;

-- Null means legacy/unspecified. Never infer an acquisition channel from actors.
ALTER TABLE quotes ADD COLUMN acquisition_origin TEXT NULL
  CHECK (acquisition_origin IN ('claim_link', 'direct_proposal', 'provider_os'));
CREATE INDEX quotes_provider_os_history_idx
  ON quotes (business_organization_id, created_at DESC, id DESC)
  WHERE acquisition_origin = 'provider_os';

ALTER TABLE task_draft_media_access_log ADD COLUMN provider_organization_id UUID NULL
  REFERENCES business_organizations(id) ON DELETE RESTRICT;
ALTER TABLE task_draft_media_access_log DROP CONSTRAINT task_draft_media_access_log_authority_ck;
ALTER TABLE task_draft_media_access_log ADD CONSTRAINT task_draft_media_access_log_authority_ck
  CHECK (
    (access_context = 'AUTHENTICATED' AND viewer_id IS NOT NULL AND claim_link_id IS NULL AND provider_organization_id IS NULL)
    OR (access_context = 'CLAIM_PREVIEW' AND viewer_id IS NULL AND claim_link_id IS NOT NULL AND provider_organization_id IS NULL)
    OR (access_context = 'PROVIDER_OS' AND viewer_id IS NOT NULL AND claim_link_id IS NULL AND provider_organization_id IS NOT NULL)
  );

COMMIT;
