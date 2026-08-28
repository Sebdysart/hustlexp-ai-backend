-- HX/OS 2.0 proof verification signal contract
--
-- Establishes one purpose-bound persistence surface for proof capture and
-- advisory biometric/photo consistency signals. AI signals remain evidence for
-- human or policy review; they are never contractual completion authority.

BEGIN;

ALTER TABLE proof_submissions
  ADD COLUMN IF NOT EXISTS deepfake_score NUMERIC(4,3),
  ADD COLUMN IF NOT EXISTS biometric_analyzed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS biometric_signal_status TEXT NOT NULL DEFAULT 'NOT_RUN',
  ADD COLUMN IF NOT EXISTS biometric_provider TEXT,
  ADD COLUMN IF NOT EXISTS biometric_failure_reason_code TEXT,
  ADD COLUMN IF NOT EXISTS biometric_policy_version TEXT NOT NULL DEFAULT 'hxos-proof-consistency-v1',
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS capture_source TEXT,
  ADD COLUMN IF NOT EXISTS exif_timestamp TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS exif_gps_lat NUMERIC,
  ADD COLUMN IF NOT EXISTS exif_gps_lng NUMERIC,
  ADD COLUMN IF NOT EXISTS exif_device_model TEXT,
  ADD COLUMN IF NOT EXISTS capture_validation_passed BOOLEAN,
  ADD COLUMN IF NOT EXISTS capture_validation_failures TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Every canonical proof requires a metadata target, including legacy proofs
-- and submissions with no GPS evidence. Existing evidence rows are preserved.
INSERT INTO proof_submissions (proof_id, user_id)
SELECT p.id, p.submitter_id
FROM proofs p
WHERE NOT EXISTS (
  SELECT 1
  FROM proof_submissions ps
  WHERE ps.proof_id = p.id
);

ALTER TABLE proof_submissions
  DROP CONSTRAINT IF EXISTS proof_submissions_liveness_score_ck,
  DROP CONSTRAINT IF EXISTS proof_submissions_deepfake_score_ck,
  DROP CONSTRAINT IF EXISTS proof_submissions_biometric_signal_status_ck,
  DROP CONSTRAINT IF EXISTS proof_submissions_biometric_provider_ck,
  DROP CONSTRAINT IF EXISTS proof_submissions_metadata_object_ck,
  DROP CONSTRAINT IF EXISTS proof_submissions_capture_source_ck,
  DROP CONSTRAINT IF EXISTS proof_submissions_exif_gps_ck;

ALTER TABLE proof_submissions
  ADD CONSTRAINT proof_submissions_liveness_score_ck
    CHECK (liveness_score IS NULL OR (liveness_score >= 0 AND liveness_score <= 1)),
  ADD CONSTRAINT proof_submissions_deepfake_score_ck
    CHECK (deepfake_score IS NULL OR (deepfake_score >= 0 AND deepfake_score <= 1)),
  ADD CONSTRAINT proof_submissions_biometric_signal_status_ck
    CHECK (biometric_signal_status IN ('NOT_RUN','PENDING','AVAILABLE','UNAVAILABLE','FAILED')),
  ADD CONSTRAINT proof_submissions_biometric_provider_ck
    CHECK (biometric_provider IS NULL OR biometric_provider IN ('AWS_REKOGNITION','GCP_VISION_HEURISTIC')),
  ADD CONSTRAINT proof_submissions_metadata_object_ck
    CHECK (jsonb_typeof(metadata) = 'object'),
  ADD CONSTRAINT proof_submissions_capture_source_ck
    CHECK (capture_source IS NULL OR capture_source IN ('live_camera','gallery','unknown')),
  ADD CONSTRAINT proof_submissions_exif_gps_ck
    CHECK (
      (exif_gps_lat IS NULL AND exif_gps_lng IS NULL)
      OR (
        exif_gps_lat IS NOT NULL
        AND exif_gps_lng IS NOT NULL
        AND exif_gps_lat BETWEEN -90 AND 90
        AND exif_gps_lng BETWEEN -180 AND 180
      )
    );

CREATE INDEX IF NOT EXISTS idx_proof_submissions_signal_status
  ON proof_submissions(biometric_signal_status, created_at DESC);

COMMENT ON COLUMN proof_submissions.biometric_signal_status IS
  'Advisory proof-consistency signal state; never contractual completion authority.';
COMMENT ON COLUMN proof_submissions.biometric_failure_reason_code IS
  'Bounded machine-readable failure reason; raw provider errors are excluded.';
COMMENT ON COLUMN proof_submissions.metadata IS
  'Purpose-bound proof review metadata; prohibited from general analytics ingestion.';
COMMIT;
