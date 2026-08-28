-- HX/OS 2.0 private media delivery contract
--
-- Canonical media objects remain private R2 objects. Browser and external
-- analysis access is granted only through short-lived, receipt-bound signed
-- URLs whose issuance is recorded in an append-only server-only audit table.

BEGIN;

LOCK TABLE media_upload_receipts, proof_photos, task_messages IN ACCESS EXCLUSIVE MODE;

DROP TRIGGER IF EXISTS media_upload_receipts_guard_trg ON media_upload_receipts;
ALTER TABLE media_upload_receipts
  DROP CONSTRAINT IF EXISTS media_upload_receipts_state_shape_ck;

-- Convert receipt-backed historical references before clearing the deprecated
-- public URL attestation. Exact consumer binding prevents cross-task/key reuse.
UPDATE proof_photos pp
SET storage_key = mur.canonical_key
FROM media_upload_receipts mur
WHERE mur.status = 'CONSUMED'
  AND mur.purpose = 'PROOF'
  AND mur.consumed_kind = 'PROOF'
  AND mur.consumed_id = pp.proof_id
  AND mur.canonical_key IS NOT NULL
  AND mur.canonical_url IS NOT NULL
  AND pp.storage_key = mur.canonical_url;

UPDATE task_messages tm
SET photo_urls = mapped.private_references
FROM (
  SELECT source.id,
         ARRAY_AGG(COALESCE(mur.canonical_key, item.reference)
                   ORDER BY item.ordinality) AS private_references
  FROM task_messages source
  CROSS JOIN LATERAL UNNEST(COALESCE(source.photo_urls, ARRAY[]::TEXT[]))
    WITH ORDINALITY AS item(reference, ordinality)
  LEFT JOIN media_upload_receipts mur
    ON mur.status = 'CONSUMED'
   AND mur.purpose = 'MESSAGE'
   AND mur.consumed_kind = 'MESSAGE'
   AND mur.consumed_id = source.id
   AND mur.canonical_key IS NOT NULL
   AND mur.canonical_url = item.reference
  GROUP BY source.id
) mapped
WHERE tm.id = mapped.id
  AND tm.photo_urls IS DISTINCT FROM mapped.private_references;

-- Unbound legacy URLs have no trustworthy receipt authority. Preserve a
-- non-retrievable integrity witness while making the media explicitly
-- unavailable instead of retaining or guessing a public object location.
UPDATE proof_photos
SET storage_key = 'legacy-unavailable/' || ENCODE(DIGEST(storage_key, 'sha256'), 'hex')
WHERE storage_key ~* '^https?://';

-- The receipt-backed flow stores its authority in proof_photos. Historical
-- proof_submissions URLs are unaudited duplicates and must not win COALESCE
-- selection over the private key during analysis.
UPDATE proof_submissions
SET photo_url = NULL
WHERE photo_url ~* '^https?://';

UPDATE task_messages
SET photo_urls = ARRAY(
  SELECT CASE
    WHEN item.reference ~* '^https?://'
      THEN 'legacy-unavailable/' || ENCODE(DIGEST(item.reference, 'sha256'), 'hex')
    ELSE item.reference
  END
  FROM UNNEST(COALESCE(task_messages.photo_urls, ARRAY[]::TEXT[]))
    WITH ORDINALITY AS item(reference, ordinality)
  ORDER BY item.ordinality
)
WHERE EXISTS (
  SELECT 1
  FROM UNNEST(COALESCE(task_messages.photo_urls, ARRAY[]::TEXT[])) AS reference
  WHERE reference ~* '^https?://'
);

UPDATE media_upload_receipts
SET canonical_url = NULL
WHERE canonical_url IS NOT NULL;

ALTER TABLE media_upload_receipts
  ADD CONSTRAINT media_upload_receipts_state_shape_ck CHECK (
    canonical_url IS NULL
    AND (
      (
        status = 'QUARANTINED'
        AND canonical_key IS NULL
        AND canonical_content_type IS NULL
        AND canonical_size_bytes IS NULL
        AND canonical_checksum_sha256 IS NULL
        AND pixel_width IS NULL
        AND pixel_height IS NULL
        AND source_metadata_detected IS NULL
        AND raw_deleted_at IS NULL
        AND finalized_at IS NULL
        AND consumed_kind IS NULL
        AND consumed_id IS NULL
        AND consumed_at IS NULL
        AND rejection_code IS NULL
      ) OR (
        status = 'FINALIZED'
        AND canonical_key IS NOT NULL
        AND canonical_content_type IS NOT NULL
        AND canonical_size_bytes IS NOT NULL
        AND canonical_checksum_sha256 IS NOT NULL
        AND pixel_width IS NOT NULL
        AND pixel_height IS NOT NULL
        AND source_metadata_detected IS NOT NULL
        AND raw_deleted_at IS NOT NULL
        AND finalized_at IS NOT NULL
        AND consumed_kind IS NULL
        AND consumed_id IS NULL
        AND consumed_at IS NULL
        AND rejection_code IS NULL
      ) OR (
        status = 'CONSUMED'
        AND canonical_key IS NOT NULL
        AND canonical_content_type IS NOT NULL
        AND canonical_size_bytes IS NOT NULL
        AND canonical_checksum_sha256 IS NOT NULL
        AND pixel_width IS NOT NULL
        AND pixel_height IS NOT NULL
        AND source_metadata_detected IS NOT NULL
        AND raw_deleted_at IS NOT NULL
        AND finalized_at IS NOT NULL
        AND consumed_kind = purpose
        AND consumed_id IS NOT NULL
        AND consumed_at IS NOT NULL
        AND rejection_code IS NULL
      ) OR (
        status IN ('REJECTED', 'EXPIRED')
        AND canonical_key IS NULL
        AND canonical_content_type IS NULL
        AND canonical_size_bytes IS NULL
        AND canonical_checksum_sha256 IS NULL
        AND pixel_width IS NULL
        AND pixel_height IS NULL
        AND source_metadata_detected IS NULL
        AND raw_deleted_at IS NOT NULL
        AND finalized_at IS NULL
        AND consumed_kind IS NULL
        AND consumed_id IS NULL
        AND consumed_at IS NULL
        AND rejection_code IS NOT NULL
      )
    )
  );

ALTER TABLE proof_photos
  DROP CONSTRAINT IF EXISTS proof_photos_private_storage_key_ck;
ALTER TABLE proof_photos
  ADD CONSTRAINT proof_photos_private_storage_key_ck
  CHECK (storage_key !~* '^https?://');

ALTER TABLE task_messages
  DROP CONSTRAINT IF EXISTS task_messages_private_photo_references_ck;
ALTER TABLE task_messages
  ADD CONSTRAINT task_messages_private_photo_references_ck
  CHECK (ARRAY_TO_STRING(COALESCE(photo_urls, ARRAY[]::TEXT[]), '') !~* 'https?://');

CREATE OR REPLACE FUNCTION hx_media_upload_receipt_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(NEW.task_id, NEW.uploader_id, NEW.purpose, NEW.quarantine_key,
         NEW.expected_content_type, NEW.expected_size_bytes, NEW.created_at,
         NEW.quarantine_expires_at, NEW.expires_at)
     IS DISTINCT FROM
     ROW(OLD.task_id, OLD.uploader_id, OLD.purpose, OLD.quarantine_key,
         OLD.expected_content_type, OLD.expected_size_bytes, OLD.created_at,
         OLD.quarantine_expires_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'HXMEDIA1: immutable upload receipt identity changed' USING ERRCODE='P0001';
  END IF;

  IF NOT (
    (OLD.status = 'QUARANTINED' AND NEW.status IN ('QUARANTINED', 'FINALIZED', 'REJECTED', 'EXPIRED'))
    OR (OLD.status = 'FINALIZED' AND NEW.status IN ('FINALIZED', 'CONSUMED', 'EXPIRED'))
    OR (OLD.status = NEW.status AND OLD.status IN ('CONSUMED', 'REJECTED', 'EXPIRED'))
  ) THEN
    RAISE EXCEPTION 'HXMEDIA2: invalid upload receipt transition % -> %', OLD.status, NEW.status USING ERRCODE='P0001';
  END IF;

  IF NEW.canonical_url IS NOT NULL THEN
    RAISE EXCEPTION 'HXMEDIA5: permanent public canonical URLs are prohibited' USING ERRCODE='P0001';
  END IF;

  IF OLD.status IN ('FINALIZED', 'CONSUMED')
     AND ROW(NEW.canonical_key, NEW.canonical_content_type,
             NEW.canonical_size_bytes, NEW.canonical_checksum_sha256,
             NEW.pixel_width, NEW.pixel_height, NEW.source_metadata_detected,
             NEW.raw_deleted_at, NEW.finalized_at)
       IS DISTINCT FROM
       ROW(OLD.canonical_key, OLD.canonical_content_type,
           OLD.canonical_size_bytes, OLD.canonical_checksum_sha256,
           OLD.pixel_width, OLD.pixel_height, OLD.source_metadata_detected,
           OLD.raw_deleted_at, OLD.finalized_at)
     AND NEW.status <> 'EXPIRED' THEN
    RAISE EXCEPTION 'HXMEDIA3: finalized media attestation changed' USING ERRCODE='P0001';
  END IF;

  IF OLD.status IN ('CONSUMED', 'REJECTED', 'EXPIRED') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'HXMEDIA4: terminal upload receipt changed' USING ERRCODE='P0001';
  END IF;

  IF OLD.status IN ('CONSUMED', 'REJECTED', 'EXPIRED') THEN
    RETURN OLD;
  END IF;

  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER media_upload_receipts_guard_trg
BEFORE UPDATE ON media_upload_receipts
FOR EACH ROW EXECUTE FUNCTION hx_media_upload_receipt_guard();

CREATE TABLE IF NOT EXISTS media_access_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id UUID NOT NULL REFERENCES media_upload_receipts(id) ON DELETE RESTRICT,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  viewer_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('USER', 'ADMIN', 'SYSTEM')),
  purpose TEXT NOT NULL CHECK (purpose IN ('PROOF', 'MESSAGE')),
  consumer_id UUID NOT NULL,
  access_reason TEXT NOT NULL CHECK (
    access_reason IN ('PROOF_REVIEW', 'MESSAGE_THREAD', 'BIOMETRIC_ANALYSIS', 'MODERATION_REVIEW')
  ),
  signed_url_expires_at TIMESTAMPTZ NOT NULL,
  accessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT media_access_log_actor_ck CHECK (
    (actor_kind = 'USER' AND viewer_id IS NOT NULL)
    OR (actor_kind = 'ADMIN' AND viewer_id IS NOT NULL)
    OR (actor_kind = 'SYSTEM' AND viewer_id IS NULL)
  ),
  CONSTRAINT media_access_log_expiry_ck CHECK (signed_url_expires_at > accessed_at),
  CONSTRAINT media_access_log_reason_ck CHECK (
    (purpose = 'PROOF' AND access_reason IN ('PROOF_REVIEW', 'BIOMETRIC_ANALYSIS'))
    OR (purpose = 'MESSAGE' AND access_reason IN ('MESSAGE_THREAD', 'MODERATION_REVIEW'))
  )
);

CREATE INDEX IF NOT EXISTS media_access_log_receipt_idx
  ON media_access_log (receipt_id, accessed_at DESC);
CREATE INDEX IF NOT EXISTS media_access_log_viewer_idx
  ON media_access_log (viewer_id, accessed_at DESC)
  WHERE viewer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS media_access_log_consumer_idx
  ON media_access_log (purpose, consumer_id, accessed_at DESC);

CREATE OR REPLACE FUNCTION hx_media_access_log_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'HXMEDIA6: media access logs are append-only' USING ERRCODE='P0001';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM media_upload_receipts receipt
    WHERE receipt.id = NEW.receipt_id
      AND receipt.task_id = NEW.task_id
      AND receipt.status = 'CONSUMED'
      AND receipt.purpose = NEW.purpose
      AND receipt.consumed_kind = NEW.purpose
      AND receipt.consumed_id = NEW.consumer_id
      AND receipt.canonical_key IS NOT NULL
      AND receipt.canonical_url IS NULL
  ) THEN
    RAISE EXCEPTION 'HXMEDIA7: access log is not bound to consumed private media' USING ERRCODE='P0001';
  END IF;

  IF NEW.actor_kind = 'USER' AND NOT EXISTS (
    SELECT 1 FROM tasks task
    WHERE task.id = NEW.task_id
      AND (task.poster_id = NEW.viewer_id OR task.worker_id = NEW.viewer_id)
  ) THEN
    RAISE EXCEPTION 'HXMEDIA8: media viewer is not a current task participant' USING ERRCODE='P0001';
  END IF;

  IF NEW.actor_kind = 'ADMIN' AND NOT EXISTS (
    SELECT 1 FROM admin_roles role
    WHERE role.user_id = NEW.viewer_id
      AND role.can_modify_trust = TRUE
  ) THEN
    RAISE EXCEPTION 'HXMEDIA9: media viewer lacks persisted trust-admin authority' USING ERRCODE='P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS media_access_log_guard_trg ON media_access_log;
CREATE TRIGGER media_access_log_guard_trg
BEFORE INSERT OR UPDATE OR DELETE ON media_access_log
FOR EACH ROW EXECUTE FUNCTION hx_media_access_log_guard();

CREATE OR REPLACE FUNCTION hx_media_access_log_truncate_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'HXMEDIA6: media access logs are append-only' USING ERRCODE='P0001';
END;
$$;

DROP TRIGGER IF EXISTS media_access_log_truncate_guard_trg ON media_access_log;
CREATE TRIGGER media_access_log_truncate_guard_trg
BEFORE TRUNCATE ON media_access_log
FOR EACH STATEMENT EXECUTE FUNCTION hx_media_access_log_truncate_guard();

ALTER TABLE media_access_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE media_access_log FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON TABLE media_access_log FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON TABLE media_access_log FROM authenticated;
  END IF;
END;
$$;

COMMENT ON COLUMN media_upload_receipts.canonical_url IS
  'Deprecated rolling-upgrade column. Must remain NULL; access is issued as an audited short-lived signed URL.';
COMMENT ON TABLE media_access_log IS
  'Append-only server-side audit of receipt-bound short-lived private media URL issuance. URLs and storage keys are deliberately not stored.';

COMMIT;
