-- Background Checks (Checkr)
CREATE TABLE IF NOT EXISTS background_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  checkr_candidate_id VARCHAR(255),
  checkr_report_id VARCHAR(255),
  package VARCHAR(50) NOT NULL DEFAULT 'tasker_standard',
  status VARCHAR(30) NOT NULL DEFAULT 'pending',
  result VARCHAR(30),
  completed_at TIMESTAMPTZ,
  webhook_received_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_background_checks_user_id ON background_checks(user_id);
CREATE INDEX IF NOT EXISTS idx_background_checks_checkr_candidate ON background_checks(checkr_candidate_id);
