-- Add dispute evidence tracking columns to payment_disputes (B#6).
-- evidence_submitted_at: set when evidence is auto-submitted to Stripe.
-- evidence_submission_failed: set when Stripe API call fails (retry/admin review).
-- evidence_needs_review: set when evidence quality is too thin for auto-submit.

ALTER TABLE payment_disputes ADD COLUMN IF NOT EXISTS evidence_submitted_at TIMESTAMPTZ;
ALTER TABLE payment_disputes ADD COLUMN IF NOT EXISTS evidence_submission_failed BOOLEAN DEFAULT FALSE;
ALTER TABLE payment_disputes ADD COLUMN IF NOT EXISTS evidence_needs_review BOOLEAN DEFAULT FALSE;
