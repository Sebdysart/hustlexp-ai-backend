-- Migration: Add Dispute MVP schema changes
-- Purpose: Enable dispute resolution pipeline with escrow action integration
-- Phase: Dispute Resolution MVP

-- 1. Add unique constraint: one dispute per escrow
CREATE UNIQUE INDEX IF NOT EXISTS idx_disputes_escrow_unique
ON disputes(escrow_id);

-- 2. Add version column for optimistic locking
ALTER TABLE disputes
ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

-- 3. Add split amounts columns
ALTER TABLE disputes
ADD COLUMN IF NOT EXISTS outcome_refund_amount INTEGER,
ADD COLUMN IF NOT EXISTS outcome_release_amount INTEGER;

-- 4. Add constraint for split amounts
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'disputes_split_amounts_check'
    ) THEN
        ALTER TABLE disputes
        ADD CONSTRAINT disputes_split_amounts_check
        CHECK (
          outcome_escrow_action != 'SPLIT'
          OR (
            outcome_refund_amount IS NOT NULL
            AND outcome_release_amount IS NOT NULL
            AND outcome_refund_amount >= 0
            AND outcome_release_amount >= 0
          )
        );
    END IF;
END $$;

-- 5. Create dispute_evidence table
CREATE TABLE IF NOT EXISTS dispute_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id UUID NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
  uploaded_by UUID NOT NULL REFERENCES users(id),
  kind VARCHAR(20) NOT NULL CHECK (kind IN ('IMAGE','VIDEO','TEXT','LINK')),
  object_key TEXT,
  text_body TEXT,
  url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dispute_evidence_dispute
ON dispute_evidence(dispute_id, created_at);
