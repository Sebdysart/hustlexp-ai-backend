--
-- Incident Events Table
-- Tracks system anomalies, errors, and automated diagnosis results
--

CREATE TABLE IF NOT EXISTS incident_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'error_spike',
    'latency_spike',
    'circuit_breaker_open',
    'budget_threshold',
    'anomaly_detected',
    'manual_report'
  )),
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  service TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}',
  diagnosis JSONB,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS incident_events_event_type_idx ON incident_events(event_type);
CREATE INDEX IF NOT EXISTS incident_events_severity_idx ON incident_events(severity);
CREATE INDEX IF NOT EXISTS incident_events_service_idx ON incident_events(service);
CREATE INDEX IF NOT EXISTS incident_events_created_at_idx ON incident_events(created_at DESC);
CREATE INDEX IF NOT EXISTS incident_events_resolved_idx ON incident_events(resolved_at) WHERE resolved_at IS NULL;

-- Updated_at trigger
CREATE OR REPLACE FUNCTION update_incident_events_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER incident_events_updated_at
BEFORE UPDATE ON incident_events
FOR EACH ROW
EXECUTE FUNCTION update_incident_events_updated_at();
