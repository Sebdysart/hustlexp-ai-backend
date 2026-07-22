-- HX/OS 2.0 canonical media quarantine and finalization contract
--
-- Direct clients may write only a short-lived quarantine object. Downstream
-- proof or message records must bind to an engine-issued receipt for a decoded,
-- pixel-re-encoded canonical object. Raw objects are deleted on finalization,
-- rejection, or expiry.

BEGIN;

CREATE TABLE IF NOT EXISTS media_upload_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  uploader_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('PROOF', 'MESSAGE')),
  status TEXT NOT NULL DEFAULT 'QUARANTINED'
    CHECK (status IN ('QUARANTINED', 'FINALIZED', 'CONSUMED', 'REJECTED', 'EXPIRED')),
  quarantine_key TEXT NOT NULL UNIQUE,
  expected_content_type TEXT NOT NULL
    CHECK (expected_content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  expected_size_bytes INTEGER NOT NULL CHECK (expected_size_bytes BETWEEN 1 AND 10485760),
  canonical_key TEXT UNIQUE,
  canonical_url TEXT,
  canonical_content_type TEXT
    CHECK (canonical_content_type IS NULL OR canonical_content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  canonical_size_bytes INTEGER CHECK (canonical_size_bytes IS NULL OR canonical_size_bytes BETWEEN 1 AND 10485760),
  canonical_checksum_sha256 TEXT
    CHECK (canonical_checksum_sha256 IS NULL OR canonical_checksum_sha256 ~ '^[a-f0-9]{64}$'),
  pixel_width INTEGER CHECK (pixel_width IS NULL OR pixel_width > 0),
  pixel_height INTEGER CHECK (pixel_height IS NULL OR pixel_height > 0),
  source_metadata_detected BOOLEAN,
  raw_deleted_at TIMESTAMPTZ,
  finalized_at TIMESTAMPTZ,
  consumed_kind TEXT CHECK (consumed_kind IS NULL OR consumed_kind IN ('PROOF', 'MESSAGE')),
  consumed_id UUID,
  consumed_at TIMESTAMPTZ,
  rejection_code TEXT,
  quarantine_expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '15 minutes'),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT media_upload_receipts_expiry_order_ck CHECK (quarantine_expires_at <= expires_at),
  CONSTRAINT media_upload_receipts_state_shape_ck CHECK (
    (
      status = 'QUARANTINED'
      AND canonical_key IS NULL
      AND canonical_url IS NULL
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
      AND canonical_url IS NOT NULL
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
      AND canonical_url IS NOT NULL
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
      AND canonical_url IS NULL
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

CREATE INDEX IF NOT EXISTS media_upload_receipts_expiry_idx
  ON media_upload_receipts (expires_at, id)
  WHERE status = 'FINALIZED';

CREATE INDEX IF NOT EXISTS media_upload_receipts_quarantine_expiry_idx
  ON media_upload_receipts (quarantine_expires_at, id)
  WHERE status = 'QUARANTINED';

CREATE INDEX IF NOT EXISTS media_upload_receipts_consumer_idx
  ON media_upload_receipts (task_id, uploader_id, purpose, status);

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

  IF OLD.status IN ('FINALIZED', 'CONSUMED')
     AND ROW(NEW.canonical_key, NEW.canonical_url, NEW.canonical_content_type,
             NEW.canonical_size_bytes, NEW.canonical_checksum_sha256,
             NEW.pixel_width, NEW.pixel_height, NEW.source_metadata_detected,
             NEW.raw_deleted_at, NEW.finalized_at)
       IS DISTINCT FROM
       ROW(OLD.canonical_key, OLD.canonical_url, OLD.canonical_content_type,
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

DROP TRIGGER IF EXISTS media_upload_receipts_guard_trg ON media_upload_receipts;
CREATE TRIGGER media_upload_receipts_guard_trg
BEFORE UPDATE ON media_upload_receipts
FOR EACH ROW EXECUTE FUNCTION hx_media_upload_receipt_guard();

ALTER TABLE media_upload_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE media_upload_receipts FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON TABLE media_upload_receipts FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON TABLE media_upload_receipts FROM authenticated;
  END IF;
END;
$$;

COMMENT ON TABLE media_upload_receipts IS
  'Server-only attestations for short-lived quarantine uploads that were decoded, pixel-re-encoded, metadata-stripped, and bound to one task/uploader/purpose.';

COMMIT;
