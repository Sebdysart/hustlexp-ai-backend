-- Incident Intelligence: incident_events table
-- Stores detected anomalies, diagnoses, and resolution tracking

CREATE TABLE IF NOT EXISTS incident_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  service TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}',
  diagnosis JSONB,
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT,
  resolution_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_incident_events_type ON incident_events(event_type);
CREATE INDEX IF NOT EXISTS idx_incident_events_severity ON incident_events(severity);
CREATE INDEX IF NOT EXISTS idx_incident_events_created ON incident_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_incident_events_unresolved ON incident_events(resolved_at) WHERE resolved_at IS NULL;
