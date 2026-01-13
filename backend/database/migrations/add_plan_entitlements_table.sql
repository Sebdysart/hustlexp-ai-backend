-- Migration: Add plan_entitlements table (Step 9-D - Stripe Integration)
-- Purpose: One-off per-task risk access purchased outside subscriptions
-- 
-- Invariant S-3: Entitlements never outlive payment
-- Invariant S-5: Entitlements must reference a valid Stripe event
-- 
-- Note: No FK constraint on source_event_id (allows async processing).
-- Service layer MUST validate event exists before creating entitlement.
-- Future hardening: Consider FK if processing becomes fully synchronous.
-- 
-- @see STEP_9D_STRIPE_INTEGRATION.md

BEGIN;

-- Plan entitlements table - per-task or per-risk access
CREATE TABLE IF NOT EXISTS plan_entitlements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID NOT NULL REFERENCES users(id),
    task_id UUID REFERENCES tasks(id), -- nullable: some entitlements may be global

    -- What this entitlement grants
    risk_level TEXT NOT NULL CHECK (risk_level IN ('MEDIUM', 'HIGH', 'IN_HOME')),

    -- Payment linkage (idempotency + causal linkage)
    -- NOTE: No FK to stripe_events (allows async processing)
    -- Service layer MUST validate event exists (Invariant S-5)
    source_event_id TEXT NOT NULL,  -- Stripe evt_xxx (must exist in stripe_events)
    source_payment_intent TEXT,     -- pi_xxx (optional but recommended)

    -- Validity window
    granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotency: one entitlement per Stripe event (Invariant S-3)
CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_entitlements_source_event
ON plan_entitlements(source_event_id);

-- Fast expiry checks (used by gating logic - Invariant S-4)
CREATE INDEX IF NOT EXISTS idx_plan_entitlements_active
ON plan_entitlements(user_id, expires_at);

COMMIT;
