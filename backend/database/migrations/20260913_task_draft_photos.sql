BEGIN;

ALTER TABLE media_upload_receipts
  ALTER COLUMN task_id DROP NOT NULL;

ALTER TABLE media_upload_receipts
  ADD COLUMN IF NOT EXISTS task_draft_id UUID REFERENCES task_drafts(id) ON DELETE RESTRICT;

ALTER TABLE media_upload_receipts
  DROP CONSTRAINT IF EXISTS media_upload_receipts_purpose_check;
ALTER TABLE media_upload_receipts
  ADD CONSTRAINT media_upload_receipts_purpose_check
  CHECK (purpose IN ('PROOF', 'MESSAGE', 'TASK_DRAFT_PHOTO'));

ALTER TABLE media_upload_receipts
  DROP CONSTRAINT IF EXISTS media_upload_receipts_consumed_kind_check;
ALTER TABLE media_upload_receipts
  ADD CONSTRAINT media_upload_receipts_consumed_kind_check
  CHECK (consumed_kind IS NULL OR consumed_kind IN ('PROOF', 'MESSAGE', 'TASK_DRAFT_PHOTO'));

ALTER TABLE media_upload_receipts
  DROP CONSTRAINT IF EXISTS media_upload_receipts_exact_target_ck;
ALTER TABLE media_upload_receipts
  ADD CONSTRAINT media_upload_receipts_exact_target_ck
  CHECK ((task_id IS NOT NULL AND task_draft_id IS NULL)
      OR (task_id IS NULL AND task_draft_id IS NOT NULL));

CREATE OR REPLACE FUNCTION hx_media_upload_receipt_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(NEW.task_id, NEW.task_draft_id, NEW.uploader_id, NEW.purpose,
         NEW.quarantine_key, NEW.expected_content_type, NEW.expected_size_bytes,
         NEW.created_at, NEW.quarantine_expires_at, NEW.expires_at)
     IS DISTINCT FROM
     ROW(OLD.task_id, OLD.task_draft_id, OLD.uploader_id, OLD.purpose,
         OLD.quarantine_key, OLD.expected_content_type, OLD.expected_size_bytes,
         OLD.created_at, OLD.quarantine_expires_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'HXMEDIA1: immutable upload receipt identity changed' USING ERRCODE='P0001';
  END IF;
  IF NOT (
    (OLD.status = 'QUARANTINED' AND NEW.status IN ('QUARANTINED', 'FINALIZED', 'REJECTED', 'EXPIRED'))
    OR (OLD.status = 'FINALIZED' AND NEW.status IN ('FINALIZED', 'CONSUMED', 'EXPIRED'))
    OR (OLD.status = NEW.status AND OLD.status IN ('CONSUMED', 'REJECTED', 'EXPIRED'))
  ) THEN
    RAISE EXCEPTION 'HXMEDIA2: invalid upload receipt transition % -> %', OLD.status, NEW.status USING ERRCODE='P0001';
  END IF;
  IF OLD.status IN ('FINALIZED', 'CONSUMED')
     AND ROW(NEW.canonical_key, NEW.canonical_url, NEW.canonical_content_type,
             NEW.canonical_size_bytes, NEW.canonical_checksum_sha256, NEW.pixel_width,
             NEW.pixel_height, NEW.source_metadata_detected, NEW.raw_deleted_at, NEW.finalized_at)
       IS DISTINCT FROM
       ROW(OLD.canonical_key, OLD.canonical_url, OLD.canonical_content_type,
           OLD.canonical_size_bytes, OLD.canonical_checksum_sha256, OLD.pixel_width,
           OLD.pixel_height, OLD.source_metadata_detected, OLD.raw_deleted_at, OLD.finalized_at)
     AND NEW.status <> 'EXPIRED' THEN
    RAISE EXCEPTION 'HXMEDIA3: finalized media attestation changed' USING ERRCODE='P0001';
  END IF;
  IF OLD.status IN ('CONSUMED', 'REJECTED', 'EXPIRED') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'HXMEDIA4: terminal upload receipt changed' USING ERRCODE='P0001';
  END IF;
  IF OLD.status IN ('CONSUMED', 'REJECTED', 'EXPIRED') THEN RETURN OLD; END IF;
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

CREATE INDEX IF NOT EXISTS media_upload_receipts_task_draft_idx
  ON media_upload_receipts (task_draft_id, status);

CREATE TABLE IF NOT EXISTS task_draft_photos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_draft_id UUID NOT NULL REFERENCES task_drafts(id) ON DELETE CASCADE,
  upload_receipt_id UUID NOT NULL REFERENCES media_upload_receipts(id) ON DELETE RESTRICT,
  sequence_number INTEGER NOT NULL CHECK (sequence_number >= 0 AND sequence_number < 8),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (task_draft_id, upload_receipt_id),
  UNIQUE (task_draft_id, sequence_number)
);

CREATE INDEX IF NOT EXISTS task_draft_photos_draft_idx
  ON task_draft_photos (task_draft_id, sequence_number);

CREATE TABLE IF NOT EXISTS task_draft_media_access_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_draft_id UUID NOT NULL REFERENCES task_drafts(id) ON DELETE CASCADE,
  photo_id UUID NOT NULL REFERENCES task_draft_photos(id) ON DELETE CASCADE,
  viewer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  signed_url_expires_at TIMESTAMPTZ NOT NULL,
  accessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS task_draft_media_access_log_photo_idx
  ON task_draft_media_access_log (photo_id, accessed_at DESC);

COMMIT;
