-- Migration: AI Agent Decisions Tracking
-- Version: 1.8.0
-- Date: 2026-02-06
-- Purpose: Track proposals from Scoper, Logistics, and Judge AI agents (Authority A2)

-- AI agent decision tracking for multi-agent system
CREATE TABLE IF NOT EXISTS ai_agent_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_type TEXT NOT NULL CHECK (agent_type IN ('scoper', 'logistics', 'judge')),
  task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
  proof_id UUID REFERENCES proofs(id) ON DELETE CASCADE,

  -- Agent-specific data
  proposal JSONB NOT NULL, -- Agent's recommendation
  confidence_score DECIMAL(5,4) CHECK (confidence_score >= 0 AND confidence_score <= 1),
  reasoning TEXT NOT NULL,

  -- Decision outcome
  accepted BOOLEAN, -- NULL if pending validator review
  validator_override BOOLEAN DEFAULT FALSE,
  validator_reason TEXT,

  -- Authority tracking (A2 = Proposal-Only per AI_INFRASTRUCTURE.md)
  authority_level TEXT NOT NULL DEFAULT 'A2' CHECK (authority_level IN ('A0', 'A1', 'A2', 'A3')),

  -- Audit
  created_at TIMESTAMPTZ DEFAULT NOW(),
  decided_at TIMESTAMPTZ,
  decided_by UUID REFERENCES users(id) -- System validator or admin
);

-- Indexes for performance
CREATE INDEX idx_ai_agent_decisions_agent_type ON ai_agent_decisions(agent_type);
CREATE INDEX idx_ai_agent_decisions_task_id ON ai_agent_decisions(task_id);
CREATE INDEX idx_ai_agent_decisions_proof_id ON ai_agent_decisions(proof_id);
CREATE INDEX idx_ai_agent_decisions_created_at ON ai_agent_decisions(created_at DESC);
CREATE INDEX idx_ai_agent_decisions_accepted ON ai_agent_decisions(accepted) WHERE accepted IS NOT NULL;
CREATE INDEX idx_ai_agent_decisions_pending ON ai_agent_decisions(agent_type, accepted) WHERE accepted IS NULL;

-- Comments for documentation
COMMENT ON TABLE ai_agent_decisions IS 'Audit log for all AI agent proposals (Authority Level A2: Proposal-Only)';
COMMENT ON COLUMN ai_agent_decisions.agent_type IS 'Which AI agent made the proposal: scoper, logistics, or judge';
COMMENT ON COLUMN ai_agent_decisions.proposal IS 'Full JSON proposal object from agent (structure varies by agent_type)';
COMMENT ON COLUMN ai_agent_decisions.confidence_score IS 'Agent confidence in proposal (0.0-1.0). Low confidence flags for manual review.';
COMMENT ON COLUMN ai_agent_decisions.reasoning IS 'Human-readable explanation of agent decision';
COMMENT ON COLUMN ai_agent_decisions.accepted IS 'NULL=pending review, TRUE=accepted by validator, FALSE=rejected';
COMMENT ON COLUMN ai_agent_decisions.validator_override IS 'TRUE if admin manually overrode agent proposal';
COMMENT ON COLUMN ai_agent_decisions.authority_level IS 'Constitutional authority level (always A2 for agents: proposal-only, cannot execute)';
