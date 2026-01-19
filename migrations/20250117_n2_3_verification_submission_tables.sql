/**
 * N2.3 Verification Submission Tables Migration
 * 
 * ============================================================================
 * PURPOSE
 * ============================================================================
 * 
 * Creates tables for verification submission (Phase N2.3).
 * These tables store USER-SUBMITTED verification records.
 * 
 * AUTHORITY MODEL:
 * - Verification tables = USER CLAIMS (pending review)
 * - Capability profiles = SYSTEM-DERIVED (from approved verifications)
 * - Verified trades = SYSTEM-DERIVED (from approved license verifications)
 * 
 * ============================================================================
 * TABLES
 * ============================================================================
 * 
 * 1. license_verifications
 *    - User-submitted license claims
 *    - Status: PENDING → APPROVED/REJECTED/EXPIRED
 *    - Never directly writes to capability_profiles or verified_trades
 * 
 * 2. insurance_verifications
 *    - User-submitted insurance claims (COI uploads)
 *    - Status: PENDING → APPROVED/REJECTED/EXPIRED
 *    - Never directly writes to capability_profiles
 * 
 * 3. background_checks
 *    - User-initiated background check requests
 *    - Status: PENDING → APPROVED/REJECTED/EXPIRED
 *    - Never directly writes to capability_profiles
 * 
 * ============================================================================
 * STATUS MODEL (SHARED)
 * ============================================================================
 * 
 * - PENDING: Submitted, awaiting review/processing
 * - APPROVED: Verified and valid
 * - REJECTED: Verification failed or invalid
 * - EXPIRED: Expired (time-based)
 * 
 * ============================================================================
 * NOTES
 * ============================================================================
 * 
 * - Submission creates record with status = PENDING
 * - Only STATUS CHANGES (later, via admin/webhook) trigger recompute
 * - Submission never triggers recompute or eligibility changes
 * 
 * Reference: Phase N2.3 — Verification Submission (LOCKED)
 */

BEGIN;

-- ============================================================================
-- 1. License Verifications Table
-- ============================================================================

CREATE TABLE IF NOT EXISTS license_verifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  
  -- License details (user-submitted)
  trade_type TEXT NOT NULL,  -- e.g., 'electrician', 'plumber', 'general_contractor'
  license_number TEXT NOT NULL,
  issuing_state TEXT NOT NULL,  -- Two-letter state code (e.g., 'WA', 'CA')
  expiration_date DATE,  -- Optional if registry-checked
  
  -- Submission metadata
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED')),
  source TEXT NOT NULL DEFAULT 'USER_SUBMITTED' CHECK (source IN ('USER_SUBMITTED', 'ADMIN_OVERRIDE', 'EXTERNAL_API')),
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  -- Review/approval metadata (set later, not on submission)
  reviewed_at TIMESTAMPTZ,
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,  -- Admin reviewer
  reviewed_by_system BOOLEAN DEFAULT false,  -- True if approved via external API
  
  -- External validation (optional, set later)
  external_provider_ref TEXT,  -- Reference from external verification API
  external_validation_at TIMESTAMPTZ,
  
  -- Attachments (optional, URLs to stored files)
  attachments TEXT[],  -- Array of file URLs
  
  -- Audit
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- Idempotency: Prevent duplicate submissions for same license
  -- Only one PENDING verification per license at a time
  -- (Enforced via partial unique index, not constraint)
);

CREATE INDEX IF NOT EXISTS idx_license_verifications_user ON license_verifications(user_id);
CREATE INDEX IF NOT EXISTS idx_license_verifications_status ON license_verifications(status);
CREATE INDEX IF NOT EXISTS idx_license_verifications_trade ON license_verifications(trade_type);
CREATE INDEX IF NOT EXISTS idx_license_verifications_submitted ON license_verifications(submitted_at DESC);

-- Partial unique index: Only one PENDING verification per license at a time
CREATE UNIQUE INDEX IF NOT EXISTS idx_license_verifications_pending_unique 
  ON license_verifications(user_id, trade_type, license_number, issuing_state) 
  WHERE status = 'PENDING';

-- ============================================================================
-- 2. Insurance Verifications Table
-- ============================================================================

CREATE TABLE IF NOT EXISTS insurance_verifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  
  -- Insurance details (user-submitted)
  provider_name TEXT NOT NULL,
  policy_number TEXT NOT NULL,
  coverage_amount DECIMAL(12, 2),  -- Optional, in USD
  expiration_date DATE NOT NULL,
  trade_scope TEXT[] NOT NULL,  -- Array of trades covered (e.g., ['electrician', 'plumber'])
  
  -- Submission metadata
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED')),
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  -- Review/approval metadata (set later)
  reviewed_at TIMESTAMPTZ,
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,  -- Admin reviewer
  reviewed_by_system BOOLEAN DEFAULT false,
  
  -- Attachments (COI uploads)
  attachments TEXT[],  -- Array of COI file URLs
  
  -- Audit
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- Idempotency: One PENDING verification per user at a time
  -- (Multiple insurance policies allowed, but one PENDING submission at a time per user)
  -- (Enforced via partial unique index, not constraint)
);

CREATE INDEX IF NOT EXISTS idx_insurance_verifications_user ON insurance_verifications(user_id);
CREATE INDEX IF NOT EXISTS idx_insurance_verifications_status ON insurance_verifications(status);
CREATE INDEX IF NOT EXISTS idx_insurance_verifications_expiration ON insurance_verifications(expiration_date);
CREATE INDEX IF NOT EXISTS idx_insurance_verifications_submitted ON insurance_verifications(submitted_at DESC);

-- Partial unique index: Only one PENDING insurance verification per user at a time
CREATE UNIQUE INDEX IF NOT EXISTS idx_insurance_verifications_pending_unique 
  ON insurance_verifications(user_id) 
  WHERE status = 'PENDING';

-- ============================================================================
-- 3. Background Checks Table
-- ============================================================================

CREATE TABLE IF NOT EXISTS background_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  
  -- Initiation metadata
  jurisdiction TEXT NOT NULL,  -- State/country code (e.g., 'WA', 'US')
  consent BOOLEAN NOT NULL DEFAULT true,  -- User consent to background check
  initiated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  -- Status
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED')),
  
  -- External provider (set later, not on initiation)
  provider_ref TEXT,  -- Reference from background check provider API
  provider_name TEXT,  -- e.g., 'Checkr', 'GoodHire'
  provider_initiated_at TIMESTAMPTZ,
  
  -- Results (set later, not on initiation)
  completed_at TIMESTAMPTZ,
  reviewed_at TIMESTAMPTZ,
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,  -- Admin reviewer
  
  -- Result details (set later, when status changes)
  result_summary TEXT,  -- Optional summary of findings
  expires_at TIMESTAMPTZ,  -- When background check expires (set on approval)
  
  -- Audit
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- Idempotency: One PENDING background check per user at a time
  -- (Enforced via partial unique index, not constraint)
);

CREATE INDEX IF NOT EXISTS idx_background_checks_user ON background_checks(user_id);
CREATE INDEX IF NOT EXISTS idx_background_checks_status ON background_checks(status);
CREATE INDEX IF NOT EXISTS idx_background_checks_initiated ON background_checks(initiated_at DESC);
CREATE INDEX IF NOT EXISTS idx_background_checks_expires ON background_checks(expires_at) WHERE expires_at IS NOT NULL;

-- Partial unique index: Only one PENDING background check per user at a time
CREATE UNIQUE INDEX IF NOT EXISTS idx_background_checks_pending_unique 
  ON background_checks(user_id) 
  WHERE status = 'PENDING';

COMMIT;
