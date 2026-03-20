-- F-31: Add stripe_transfer_id to insurance_claims
-- Tracks the Stripe transfer ID once a claim payout is confirmed.
-- NULL means the DB was updated (status='paid') but the Stripe call has not yet succeeded.
-- The payClaim() idempotency guard uses this to safely retry failed Stripe transfers
-- without double-debiting the pool.
ALTER TABLE insurance_claims ADD COLUMN IF NOT EXISTS stripe_transfer_id TEXT;
