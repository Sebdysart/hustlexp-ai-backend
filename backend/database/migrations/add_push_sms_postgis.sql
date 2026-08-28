-- ============================================================================
-- Migration: Push Notifications, SMS Outbox, PostGIS
-- Created: 2026-02-12
-- Description: Creates device_tokens table, sms_outbox table, enables PostGIS
-- Backwards-compatible: All operations use IF NOT EXISTS
-- ============================================================================

-- ============================================================================
-- 1. DEVICE TOKENS TABLE (for FCM push notifications)
-- ============================================================================

CREATE TABLE IF NOT EXISTS device_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fcm_token TEXT NOT NULL,
  device_type VARCHAR(20) DEFAULT 'ios',
  device_name VARCHAR(100),
  app_version VARCHAR(20),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, fcm_token)
);

-- Index for querying active tokens by user
CREATE INDEX IF NOT EXISTS idx_device_tokens_user_active
  ON device_tokens(user_id) WHERE is_active = true;

-- ============================================================================
-- 2. SMS OUTBOX TABLE (for Twilio SMS delivery)
-- ============================================================================

CREATE TABLE IF NOT EXISTS sms_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  to_phone VARCHAR(20) NOT NULL,
  body TEXT NOT NULL,
  priority VARCHAR(10) DEFAULT 'normal',
  status VARCHAR(20) DEFAULT 'pending',
  twilio_sid VARCHAR(100),
  error_message TEXT,
  retry_count INTEGER DEFAULT 0,
  idempotency_key TEXT UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  sent_at TIMESTAMPTZ
);

-- Index for worker polling (pending/failed SMS)
CREATE INDEX IF NOT EXISTS idx_sms_outbox_status
  ON sms_outbox(status) WHERE status IN ('pending', 'failed');

-- ============================================================================
-- 3. POSTGIS EXTENSION + GEOGRAPHY COLUMN
-- ============================================================================

-- Enable PostGIS extension (requires superuser or rds_superuser on Neon)
-- Note: If this fails on Neon, PostGIS may need to be enabled via dashboard
CREATE EXTENSION IF NOT EXISTS postgis;

-- Add geography column to tasks table
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS location_geo GEOGRAPHY(POINT, 4326);

-- Backfill existing tasks that have lat/lng
UPDATE tasks
SET location_geo = ST_MakePoint(longitude, latitude)::GEOGRAPHY
WHERE latitude IS NOT NULL
  AND longitude IS NOT NULL
  AND location_geo IS NULL;

-- Spatial index for proximity queries
CREATE INDEX IF NOT EXISTS idx_tasks_location_geo ON tasks USING GIST(location_geo);

-- ============================================================================
-- 4. AUTO-POPULATE TRIGGER (keep location_geo in sync with lat/lng)
-- ============================================================================

CREATE OR REPLACE FUNCTION update_location_geo()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.latitude IS NOT NULL AND NEW.longitude IS NOT NULL THEN
    NEW.location_geo := ST_MakePoint(NEW.longitude, NEW.latitude)::GEOGRAPHY;
  ELSE
    NEW.location_geo := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop and recreate to ensure latest version
DROP TRIGGER IF EXISTS trg_tasks_update_location_geo ON tasks;
CREATE TRIGGER trg_tasks_update_location_geo
  BEFORE INSERT OR UPDATE OF latitude, longitude ON tasks
  FOR EACH ROW
  EXECUTE FUNCTION update_location_geo();
