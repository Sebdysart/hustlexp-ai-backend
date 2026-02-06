-- Migration: Device Fingerprint Biometric Capabilities
-- Version: 1.8.0
-- Date: 2026-02-06
-- Purpose: Add biometric capability tracking to device fingerprints

-- Enhance device fingerprints with biometric capabilities
-- Note: device_fingerprints table should exist from prior migrations
ALTER TABLE device_fingerprints ADD COLUMN IF NOT EXISTS supports_lidar BOOLEAN DEFAULT FALSE;
ALTER TABLE device_fingerprints ADD COLUMN IF NOT EXISTS supports_face_id BOOLEAN DEFAULT FALSE;
ALTER TABLE device_fingerprints ADD COLUMN IF NOT EXISTS supports_gps BOOLEAN DEFAULT FALSE;
ALTER TABLE device_fingerprints ADD COLUMN IF NOT EXISTS gps_accuracy_capable TEXT CHECK (gps_accuracy_capable IN ('high', 'medium', 'low', NULL));

-- Index for capability-based queries
CREATE INDEX IF NOT EXISTS idx_device_fingerprints_biometric_capable
  ON device_fingerprints(supports_lidar, supports_face_id, supports_gps);

-- Comments for documentation
COMMENT ON COLUMN device_fingerprints.supports_lidar IS 'TRUE if device has LiDAR sensor (iPhone 12 Pro+, iPad Pro 2020+)';
COMMENT ON COLUMN device_fingerprints.supports_face_id IS 'TRUE if device has Face ID for liveness detection';
COMMENT ON COLUMN device_fingerprints.supports_gps IS 'TRUE if device has GPS hardware (vs Wi-Fi location only)';
COMMENT ON COLUMN device_fingerprints.gps_accuracy_capable IS 'high=<10m typical, medium=10-50m, low=>50m';
