-- ============================================================
-- Migration: Add location coordinates to tasks table
--
-- Many services (BatchQuesting, GeofenceService, FeedQuery,
-- HeatMap, ProofService, DynamicPricing) query location_lat
-- and location_lng but these columns were never created.
-- ============================================================

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS location_lat DECIMAL(10,8),
  ADD COLUMN IF NOT EXISTS location_lng DECIMAL(11,8);

CREATE INDEX IF NOT EXISTS idx_tasks_location_coords
  ON tasks(location_lat, location_lng)
  WHERE location_lat IS NOT NULL AND location_lng IS NOT NULL;

-- ============================================================
-- DONE
-- ============================================================
