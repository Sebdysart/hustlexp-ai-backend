-- Migration: Proof Submissions Biometric Enhancement
-- Version: 1.8.0
-- Date: 2026-02-06
-- Purpose: Add GPS, LiDAR, and biometric verification fields to proof submissions

-- Enhance existing proof_submissions table with biometric fields
ALTER TABLE proof_submissions ADD COLUMN IF NOT EXISTS gps_coordinates POINT;
ALTER TABLE proof_submissions ADD COLUMN IF NOT EXISTS gps_accuracy_meters DECIMAL(8,2);
ALTER TABLE proof_submissions ADD COLUMN IF NOT EXISTS gps_timestamp TIMESTAMPTZ;
ALTER TABLE proof_submissions ADD COLUMN IF NOT EXISTS lidar_depth_map_url TEXT;
ALTER TABLE proof_submissions ADD COLUMN IF NOT EXISTS time_lock_hash TEXT;
ALTER TABLE proof_submissions ADD COLUMN IF NOT EXISTS deepfake_score DECIMAL(5,4) CHECK (deepfake_score >= 0 AND deepfake_score <= 1);
ALTER TABLE proof_submissions ADD COLUMN IF NOT EXISTS liveness_score DECIMAL(5,4) CHECK (liveness_score >= 0 AND liveness_score <= 1);
ALTER TABLE proof_submissions ADD COLUMN IF NOT EXISTS biometric_verified_at TIMESTAMPTZ;

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_proof_submissions_gps ON proof_submissions USING GIST (gps_coordinates);
CREATE INDEX IF NOT EXISTS idx_proof_submissions_deepfake_score ON proof_submissions(deepfake_score) WHERE deepfake_score IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_proof_submissions_liveness_score ON proof_submissions(liveness_score) WHERE liveness_score IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_proof_submissions_gps_timestamp ON proof_submissions(gps_timestamp DESC);

-- Comments for documentation
COMMENT ON COLUMN proof_submissions.gps_coordinates IS 'GPS location where proof photo was taken (PostGIS POINT type)';
COMMENT ON COLUMN proof_submissions.gps_accuracy_meters IS 'GPS accuracy in meters (lower is better, <20m is excellent)';
COMMENT ON COLUMN proof_submissions.gps_timestamp IS 'Timestamp when GPS coordinates were captured';
COMMENT ON COLUMN proof_submissions.lidar_depth_map_url IS 'URL to LiDAR depth map file for spatial verification';
COMMENT ON COLUMN proof_submissions.time_lock_hash IS 'SHA-256 hash for live capture verification (prevents pre-uploaded photos)';
COMMENT ON COLUMN proof_submissions.deepfake_score IS 'Deepfake probability (0.0=real, 1.0=fake). Score >0.85 flags for review.';
COMMENT ON COLUMN proof_submissions.liveness_score IS 'Liveness detection score (0.0=pre-recorded, 1.0=live). Score <0.70 flags for review.';
COMMENT ON COLUMN proof_submissions.biometric_verified_at IS 'Timestamp when biometric verification completed';
