-- Migration: Add Stripe Connect tables for worker payouts and 1099 compliance
-- Purpose: Enable worker onboarding to Stripe Connect for instant/seamless payouts
-- Phase: Payments & Payouts MVP
--
-- Tables:
--   - worker_stripe_accounts: Stripe Connect account linking
--   - worker_tax_info: 1099/W-9 tax compliance data
--   - worker_payout_settings: Payout preferences and scheduling
--   - worker_earnings_1099: Annual earnings tracking for tax reporting

BEGIN;

-- ============================================================================
-- 1. worker_stripe_accounts: Links workers to Stripe Connect accounts
-- ============================================================================
CREATE TABLE IF NOT EXISTS worker_stripe_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Core linking
    worker_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    stripe_account_id VARCHAR(255) UNIQUE NOT NULL,
    
    -- Account configuration
    account_type VARCHAR(20) NOT NULL DEFAULT 'express'
        CHECK (account_type IN ('express', 'standard', 'custom')),
    
    -- Onboarding status tracking
    onboarding_status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (onboarding_status IN ('pending', 'verified', 'rejected', 'restricted')),
    
    -- Geographic/account details
    country VARCHAR(2) NOT NULL DEFAULT 'US',
    
    -- Stripe requirements (JSONB for flexibility)
    requirements_due JSONB DEFAULT '[]'::jsonb,
    requirements_currently_due JSONB DEFAULT '[]'::jsonb,
    requirements_eventually_due JSONB DEFAULT '[]'::jsonb,
    requirements_past_due JSONB DEFAULT '[]'::jsonb,
    
    -- Capabilities status
    charges_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    payouts_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    
    -- Stripe metadata (for webhook handling)
    stripe_account_json JSONB,
    
    -- Timestamps
    onboarding_completed_at TIMESTAMPTZ,
    rejected_at TIMESTAMPTZ,
    restricted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Indexes for worker_stripe_accounts
CREATE INDEX IF NOT EXISTS idx_worker_stripe_accounts_worker 
    ON worker_stripe_accounts(worker_id);
CREATE INDEX IF NOT EXISTS idx_worker_stripe_accounts_stripe_id 
    ON worker_stripe_accounts(stripe_account_id);
CREATE INDEX IF NOT EXISTS idx_worker_stripe_accounts_status 
    ON worker_stripe_accounts(onboarding_status);
CREATE INDEX IF NOT EXISTS idx_worker_stripe_accounts_payouts_enabled 
    ON worker_stripe_accounts(payouts_enabled) 
    WHERE payouts_enabled = TRUE;

-- Trigger for updated_at
DROP TRIGGER IF EXISTS worker_stripe_accounts_updated_at ON worker_stripe_accounts;
CREATE TRIGGER worker_stripe_accounts_updated_at 
    BEFORE UPDATE ON worker_stripe_accounts 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================================
-- 2. worker_tax_info: Tax form data for 1099 compliance (W-9, W-8BEN, etc.)
-- ============================================================================
CREATE TABLE IF NOT EXISTS worker_tax_info (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Link to worker
    worker_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    
    -- Tax form type
    tax_form_type VARCHAR(20) NOT NULL
        CHECK (tax_form_type IN ('W9', 'W8BEN', 'W8BEN_E')),
    
    -- Tax ID (partial for display/verification, full encrypted)
    tax_id_last4 VARCHAR(4),
    tax_id_encrypted TEXT, -- Full encrypted SSN/EIN
    tax_id_type VARCHAR(10) CHECK (tax_id_type IN ('SSN', 'EIN')),
    
    -- Legal entity info
    legal_name VARCHAR(255) NOT NULL,
    business_name VARCHAR(255),
    
    -- Address (US format primarily)
    address_line1 VARCHAR(255),
    address_line2 VARCHAR(255),
    address_city VARCHAR(100),
    address_state VARCHAR(2),
    address_zip VARCHAR(20),
    address_country VARCHAR(2) DEFAULT 'US',
    
    -- For W-8BEN: Foreign tax ID and country
    foreign_tax_id TEXT,
    citizenship_country VARCHAR(2),
    
    -- Certification/signature (legal requirements)
    signature_date TIMESTAMPTZ,
    ip_address INET,
    user_agent TEXT,
    
    -- Verification status
    submitted_at TIMESTAMPTZ,
    verified_at TIMESTAMPTZ,
    verified_by UUID REFERENCES users(id),
    
    -- Soft delete for historical forms
    superseded_by UUID REFERENCES worker_tax_info(id),
    is_current BOOLEAN NOT NULL DEFAULT TRUE,
    
    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Indexes for worker_tax_info
CREATE INDEX IF NOT EXISTS idx_worker_tax_info_worker 
    ON worker_tax_info(worker_id);
CREATE INDEX IF NOT EXISTS idx_worker_tax_info_current 
    ON worker_tax_info(worker_id, is_current) 
    WHERE is_current = TRUE;
CREATE INDEX IF NOT EXISTS idx_worker_tax_info_submitted 
    ON worker_tax_info(submitted_at);

-- Trigger for updated_at
DROP TRIGGER IF EXISTS worker_tax_info_updated_at ON worker_tax_info;
CREATE TRIGGER worker_tax_info_updated_at 
    BEFORE UPDATE ON worker_tax_info 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================================
-- 3. worker_payout_settings: Payout preferences and schedule
-- ============================================================================
CREATE TABLE IF NOT EXISTS worker_payout_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Link to worker (one-to-one)
    worker_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,
    
    -- Payout method
    payout_method VARCHAR(20) NOT NULL DEFAULT 'standard'
        CHECK (payout_method IN ('standard', 'instant')),
    
    -- Payout schedule
    payout_schedule VARCHAR(20) NOT NULL DEFAULT 'weekly'
        CHECK (payout_schedule IN ('daily', 'weekly', 'monthly')),
    
    -- Minimum payout threshold (cents)
    minimum_payout_amount_cents INTEGER NOT NULL DEFAULT 100
        CHECK (minimum_payout_amount_cents >= 0),
    
    -- Bank account info (last 4 only, full stored in Stripe)
    bank_account_last4 VARCHAR(4),
    bank_account_type VARCHAR(20) CHECK (bank_account_type IN ('checking', 'savings')),
    bank_name VARCHAR(100),
    
    -- Instant payout settings
    instant_payout_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    instant_payout_fee_accepted BOOLEAN NOT NULL DEFAULT FALSE,
    
    -- Schedule details
    weekly_payout_day INTEGER CHECK (weekly_payout_day BETWEEN 0 AND 6), -- 0=Sunday
    monthly_payout_day INTEGER CHECK (monthly_payout_day BETWEEN 1 AND 31),
    
    -- Next scheduled payout
    next_scheduled_payout_at TIMESTAMPTZ,
    
    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Indexes for worker_payout_settings
CREATE INDEX IF NOT EXISTS idx_worker_payout_settings_worker 
    ON worker_payout_settings(worker_id);
CREATE INDEX IF NOT EXISTS idx_worker_payout_settings_schedule 
    ON worker_payout_settings(next_scheduled_payout_at) 
    WHERE next_scheduled_payout_at IS NOT NULL;

-- Trigger for updated_at
DROP TRIGGER IF EXISTS worker_payout_settings_updated_at ON worker_payout_settings;
CREATE TRIGGER worker_payout_settings_updated_at 
    BEFORE UPDATE ON worker_payout_settings 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================================
-- 4. worker_earnings_1099: Annual earnings for 1099 tax form generation
-- ============================================================================
CREATE TABLE IF NOT EXISTS worker_earnings_1099 (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Composite key: one record per worker per year
    worker_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    year INTEGER NOT NULL,
    
    -- Earnings summary (all amounts in cents)
    total_payments_cents INTEGER NOT NULL DEFAULT 0,
    total_platform_fees_cents INTEGER NOT NULL DEFAULT 0,
    total_refunds_cents INTEGER NOT NULL DEFAULT 0,
    net_payments_cents INTEGER NOT NULL DEFAULT 0,
    
    -- Transaction counts
    total_tasks_completed INTEGER NOT NULL DEFAULT 0,
    total_transactions INTEGER NOT NULL DEFAULT 0,
    
    -- 1099 threshold tracking ($600 in 2024)
    threshold_reached_at TIMESTAMPTZ,
    threshold_amount_cents INTEGER NOT NULL DEFAULT 60000, -- $600.00 default
    
    -- 1099 form generation tracking
    form_1099_generated_at TIMESTAMPTZ,
    form_1099_sent_at TIMESTAMPTZ,
    form_1099_method VARCHAR(20) CHECK (form_1099_method IN ('EMAIL', 'MAIL', 'PORTAL')),
    form_1099_tracking_number VARCHAR(100),
    
    -- Copy B/C filing status
    filed_with_irs_at TIMESTAMPTZ,
    irs_acknowledgment_code VARCHAR(50),
    
    -- Corrections
    is_corrected BOOLEAN NOT NULL DEFAULT FALSE,
    corrects_record_id UUID REFERENCES worker_earnings_1099(id),
    correction_reason TEXT,
    
    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    
    -- Constraints
    CONSTRAINT worker_earnings_1099_worker_year_unique UNIQUE (worker_id, year)
);

-- Indexes for worker_earnings_1099
CREATE INDEX IF NOT EXISTS idx_worker_earnings_1099_worker 
    ON worker_earnings_1099(worker_id);
CREATE INDEX IF NOT EXISTS idx_worker_earnings_1099_year 
    ON worker_earnings_1099(year);
CREATE INDEX IF NOT EXISTS idx_worker_earnings_1099_threshold 
    ON worker_earnings_1099(threshold_reached_at) 
    WHERE threshold_reached_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_worker_earnings_1099_form_generated 
    ON worker_earnings_1099(form_1099_generated_at) 
    WHERE form_1099_generated_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_worker_earnings_1099_filed 
    ON worker_earnings_1099(filed_with_irs_at) 
    WHERE filed_with_irs_at IS NOT NULL;

-- Trigger for updated_at
DROP TRIGGER IF EXISTS worker_earnings_1099_updated_at ON worker_earnings_1099;
CREATE TRIGGER worker_earnings_1099_updated_at 
    BEFORE UPDATE ON worker_earnings_1099 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================================
-- Comments for documentation
-- ============================================================================
COMMENT ON TABLE worker_stripe_accounts IS 'Links workers to their Stripe Connect accounts for payouts';
COMMENT ON TABLE worker_tax_info IS 'Tax form data (W-9, W-8BEN) for 1099 compliance';
COMMENT ON TABLE worker_payout_settings IS 'Worker preferences for payout timing and method';
COMMENT ON TABLE worker_earnings_1099 IS 'Annual earnings aggregation for 1099 tax form generation';

COMMENT ON COLUMN worker_stripe_accounts.requirements_due IS 'Stripe account requirements from capabilities/requirements API';
COMMENT ON COLUMN worker_tax_info.tax_id_encrypted IS 'Full tax ID encrypted at application level before storage';
COMMENT ON COLUMN worker_earnings_1099.net_payments_cents IS 'total_payments_cents - total_platform_fees_cents - total_refunds_cents';

COMMIT;
