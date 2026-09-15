BEGIN;

ALTER TABLE task_draft_media_access_log
  ALTER COLUMN viewer_id DROP NOT NULL;

ALTER TABLE task_draft_media_access_log
  ADD COLUMN IF NOT EXISTS access_context TEXT NOT NULL DEFAULT 'AUTHENTICATED',
  ADD COLUMN IF NOT EXISTS claim_link_id UUID NULL
    REFERENCES ops_business_claim_links(id) ON DELETE RESTRICT;

ALTER TABLE task_draft_media_access_log
  ADD CONSTRAINT task_draft_media_access_log_authority_ck
  CHECK (
    (access_context = 'AUTHENTICATED' AND viewer_id IS NOT NULL AND claim_link_id IS NULL)
    OR
    (access_context = 'CLAIM_PREVIEW' AND viewer_id IS NULL AND claim_link_id IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS task_draft_media_access_log_claim_link_idx
  ON task_draft_media_access_log (claim_link_id, accessed_at DESC)
  WHERE claim_link_id IS NOT NULL;

COMMIT;
