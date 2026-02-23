-- Escrow events audit trail
CREATE TABLE IF NOT EXISTS escrow_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  escrow_id UUID NOT NULL REFERENCES escrows(id),
  from_state VARCHAR(20) NOT NULL,
  to_state VARCHAR(20) NOT NULL,
  actor_id UUID,
  actor_type VARCHAR(20) DEFAULT 'system',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_escrow_events_escrow_id ON escrow_events(escrow_id);
CREATE INDEX IF NOT EXISTS idx_escrow_events_created_at ON escrow_events(created_at);
