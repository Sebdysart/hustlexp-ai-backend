-- Phase 12C: Payout Eligibility Closure
-- Creates audit log for payout eligibility decisions

CREATE TABLE IF NOT EXISTS payout_eligibility_log (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    evaluation_id text NOT NULL UNIQUE,
    task_id uuid NOT NULL REFERENCES tasks(id),
    decision text NOT NULL CHECK (decision IN ('ALLOW', 'BLOCK', 'ESCALATE')),
    block_reason text,
    reason text,
    details jsonb DEFAULT '{}'::jsonb,
    admin_override jsonb,
    evaluated_at timestamptz NOT NULL DEFAULT NOW(),
    created_at timestamptz NOT NULL DEFAULT NOW()
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_payout_elig_task ON payout_eligibility_log(task_id);
CREATE INDEX IF NOT EXISTS idx_payout_elig_decision ON payout_eligibility_log(decision);
CREATE INDEX IF NOT EXISTS idx_payout_elig_evaluated ON payout_eligibility_log(evaluated_at);

-- Comment for documentation
COMMENT ON TABLE payout_eligibility_log IS 'Phase 12C: Immutable audit trail for all payout eligibility decisions';
