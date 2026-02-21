-- Migration: Add AI Cost Logs Table
-- Purpose: Track and govern AI/LLM usage costs across all agents (judge, matchmaker, etc.)
-- This enables cost monitoring, alerting, budgeting, and optimization for AI operations
-- Created: 2026-02-21

-- ============================================
-- AI COST LOGS TABLE
-- ============================================
-- Tracks every AI/LLM API call with detailed cost and performance metrics
-- Used for: cost governance, usage analytics, performance monitoring, audit trails

CREATE TABLE IF NOT EXISTS ai_cost_logs (
    -- Primary identifier
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Agent identification
    agent_type VARCHAR(50) NOT NULL,  -- 'judge', 'matchmaker', 'chatbot', 'recommender', etc.
    
    -- User context (nullable for system/agent-initiated calls)
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    
    -- Provider and model info
    provider VARCHAR(20) NOT NULL,     -- 'groq', 'openai', 'deepseek', 'alibaba', 'anthropic'
    model VARCHAR(50) NOT NULL,        -- e.g., 'llama-3.1-70b', 'gpt-4o', 'deepseek-chat'
    
    -- Token usage breakdown
    tokens_used INTEGER NOT NULL DEFAULT 0,       -- Total tokens (prompt + completion)
    prompt_tokens INTEGER NOT NULL DEFAULT 0,     -- Input/prompt tokens
    completion_tokens INTEGER NOT NULL DEFAULT 0, -- Output/completion tokens
    
    -- Cost tracking (in USD cents for precision, avoids floating point issues)
    estimated_cost_cents INTEGER NOT NULL DEFAULT 0,  -- e.g., 150 = $1.50
    
    -- Audit and deduplication hashes
    request_hash VARCHAR(64),          -- SHA-256 hash of request payload for dedup detection
    response_hash VARCHAR(64),         -- SHA-256 hash of response for integrity verification
    
    -- Performance metrics
    latency_ms INTEGER,                -- Response time in milliseconds
    
    -- Error tracking (HustleXP error codes)
    error_code VARCHAR(20),            -- HX701: Timeout, HX702: Rate Limit, HX703: Provider Error, etc.
    
    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================
-- INDEXES FOR COMMON QUERY PATTERNS
-- ============================================

-- Index for user-specific cost queries (user dashboard, billing)
-- Covers: "Show me my AI costs by agent type over time"
CREATE INDEX IF NOT EXISTS idx_ai_cost_logs_user_agent_date 
    ON ai_cost_logs (user_id, agent_type, created_at DESC);

-- Index for agent-level cost analysis (agent optimization, budgeting)
-- Covers: "How much does the judge agent cost per day?"
CREATE INDEX IF NOT EXISTS idx_ai_cost_logs_agent_date 
    ON ai_cost_logs (agent_type, created_at DESC);

-- Index for provider cost analysis (provider comparison, rate limiting)
-- Covers: "What's our daily spend on Groq vs OpenAI?"
CREATE INDEX IF NOT EXISTS idx_ai_cost_logs_provider_date 
    ON ai_cost_logs (provider, created_at DESC);

-- Additional useful indexes
CREATE INDEX IF NOT EXISTS idx_ai_cost_logs_created_at 
    ON ai_cost_logs (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_cost_logs_error_code 
    ON ai_cost_logs (error_code) WHERE error_code IS NOT NULL;

-- ============================================
-- MATERIALIZED VIEW: DAILY SPEND SUMMARY
-- ============================================
-- Pre-aggregated daily cost data for fast dashboard queries
-- Refresh periodically (e.g., every 5 minutes) or trigger on new inserts

CREATE MATERIALIZED VIEW IF NOT EXISTS ai_daily_spend_summary AS
SELECT 
    DATE(created_at) AS date,
    agent_type,
    provider,
    model,
    COUNT(*) AS total_requests,
    COUNT(*) FILTER (WHERE error_code IS NOT NULL) AS error_count,
    SUM(tokens_used) AS total_tokens,
    SUM(prompt_tokens) AS total_prompt_tokens,
    SUM(completion_tokens) AS total_completion_tokens,
    SUM(estimated_cost_cents) AS total_cost_cents,
    AVG(latency_ms)::INTEGER AS avg_latency_ms,
    PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms)::INTEGER AS p95_latency_ms,
    MAX(latency_ms) AS max_latency_ms
FROM ai_cost_logs
GROUP BY DATE(created_at), agent_type, provider, model
ORDER BY date DESC, total_cost_cents DESC;

-- Index on materialized view for fast lookups
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_daily_spend_summary_pk 
    ON ai_daily_spend_summary (date, agent_type, provider, model);

CREATE INDEX IF NOT EXISTS idx_ai_daily_spend_summary_date 
    ON ai_daily_spend_summary (date DESC);

-- ============================================
-- REFRESH FUNCTION
-- ============================================
-- Call this function to refresh the materialized view
-- Can be triggered by a cron job, pg_cron, or application code

CREATE OR REPLACE FUNCTION refresh_ai_spend_summary()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY ai_daily_spend_summary;
END;
$$;

-- ============================================
-- TABLE COMMENTS
-- ============================================

COMMENT ON TABLE ai_cost_logs IS 
    'Audit log for all AI/LLM API calls. Tracks costs, tokens, latency, and errors for governance and optimization. ' ||
    'Used for: cost monitoring, budget alerts, usage analytics, performance tracking, and audit compliance. ' ||
    'Cost is stored in USD cents to avoid floating-point precision issues. ' ||
    'Request/response hashes enable deduplication detection and response integrity verification.';

COMMENT ON COLUMN ai_cost_logs.agent_type IS 
    'Identifier for which AI agent made the call: judge, matchmaker, chatbot, recommender, etc.';

COMMENT ON COLUMN ai_cost_logs.user_id IS 
    'Reference to the user associated with this AI call. NULL for system/agent-initiated calls.';

COMMENT ON COLUMN ai_cost_logs.provider IS 
    'LLM provider: groq, openai, deepseek, alibaba, anthropic, etc.';

COMMENT ON COLUMN ai_cost_logs.estimated_cost_cents IS 
    'Estimated cost in USD cents (e.g., 125 = $1.25). Calculated based on provider pricing and token usage.';

COMMENT ON COLUMN ai_cost_logs.request_hash IS 
    'SHA-256 hash of the request payload. Used for deduplication detection and idempotency.';

COMMENT ON COLUMN ai_cost_logs.response_hash IS 
    'SHA-256 hash of the response content. Used for audit trails and response integrity verification.';

COMMENT ON COLUMN ai_cost_logs.error_code IS 
    'HustleXP-specific error codes: HX701 (Timeout), HX702 (Rate Limit), HX703 (Provider Error), etc.';

COMMENT ON MATERIALIZED VIEW ai_daily_spend_summary IS 
    'Pre-aggregated daily cost and usage metrics by agent, provider, and model. ' ||
    'Refresh periodically using refresh_ai_spend_summary() function. ' ||
    'Used for dashboards, cost alerts, and budgeting reports.';

COMMENT ON FUNCTION refresh_ai_spend_summary() IS 
    'Refreshes the ai_daily_spend_summary materialized view concurrently. ' ||
    'Call this after bulk inserts or on a schedule (e.g., every 5 minutes) to keep dashboards current.';

-- ============================================
-- GRANTS (adjust based on your security model)
-- ============================================
-- GRANT SELECT ON ai_cost_logs TO app_readonly;
-- GRANT INSERT ON ai_cost_logs TO app_service;
-- GRANT SELECT ON ai_daily_spend_summary TO app_readonly;
-- GRANT EXECUTE ON FUNCTION refresh_ai_spend_summary() TO app_scheduler;
