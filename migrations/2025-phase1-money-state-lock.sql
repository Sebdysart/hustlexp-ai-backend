-- Phase 1: Money Engine V2 Consolidaton
-- Creates Atomic Lock and Idempotency Tables

-- 1. Create Atomic Lock Table
CREATE TABLE IF NOT EXISTS money_state_lock (
    task_id UUID PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    current_state TEXT NOT NULL CHECK (
        current_state IN ('open', 'held', 'released', 'refunded', 'upheld', 'completed', 'pending_dispute')
    ),
    next_allowed_event TEXT[] NOT NULL,
    
    -- Centralized Stripe Identifiers (Source of Truth)
    stripe_payment_intent_id TEXT NOT NULL, 
    stripe_charge_id TEXT,
    stripe_transfer_id TEXT,
    stripe_refund_id TEXT,
    
    -- Audit & Concurrency
    locked_at TIMESTAMP WITH TIME ZONE,
    locked_by TEXT, 
    last_transition_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    version INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. Create Idempotency Table
CREATE TABLE IF NOT EXISTS money_events_processed (
    event_id TEXT PRIMARY KEY, 
    task_id UUID NOT NULL,
    event_type TEXT NOT NULL,
    processed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Index for performance
CREATE INDEX IF NOT EXISTS idx_money_events_task_id ON money_events_processed(task_id);
CREATE INDEX IF NOT EXISTS idx_money_lock_stripe_pi ON money_state_lock(stripe_payment_intent_id);
