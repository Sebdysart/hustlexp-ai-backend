-- Migration 009: Tax Forms Table
-- Persistent storage for W-9 / W-8BEN tax form submissions
-- Required for Stripe Connect 1099 reporting compliance
--
-- Replaces the placeholder implementation in StripeConnectService.ts
-- that returned hardcoded 'not_submitted' for all users.

CREATE TABLE IF NOT EXISTS tax_forms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    stripe_connect_id TEXT NOT NULL,

    -- Form metadata
    form_type TEXT NOT NULL CHECK (form_type IN ('W9', 'W8BEN', 'W8BENE')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'rejected', 'expired')),

    -- Stored fields (sensitive — only last4 of tax IDs)
    tax_id_last4 TEXT CHECK (tax_id_last4 IS NULL OR length(tax_id_last4) = 4),
    name_on_file TEXT,
    business_name_on_file TEXT,
    tax_classification TEXT,
    address_line1 TEXT,
    address_city TEXT,
    address_state TEXT,
    address_zip TEXT,
    address_country TEXT DEFAULT 'US',

    -- W-8BEN specific
    foreign_tax_id TEXT,
    treaty_country TEXT,
    treaty_article TEXT,

    -- Signature
    signature_on_file BOOLEAN NOT NULL DEFAULT false,
    signed_at TIMESTAMPTZ,

    -- Review
    requires_update BOOLEAN NOT NULL DEFAULT false,
    rejection_reason TEXT,
    verified_at TIMESTAMPTZ,

    -- Timestamps
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One active tax form per user (latest submission wins)
CREATE INDEX idx_tax_forms_user_id ON tax_forms(user_id);
CREATE INDEX idx_tax_forms_status ON tax_forms(status) WHERE status = 'pending';

-- Prevent duplicate active submissions: only one non-expired/non-rejected form per user
CREATE UNIQUE INDEX idx_tax_forms_active_per_user
    ON tax_forms(user_id)
    WHERE status IN ('pending', 'verified');
