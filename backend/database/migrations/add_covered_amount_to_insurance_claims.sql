-- F60-1/2/3: Store covered_amount_cents at claim filing time so that
-- reviewClaim denial decrement and payClaim both use the same value
-- rather than recomputing from a potentially different coverage_percentage.

ALTER TABLE insurance_claims
  ADD COLUMN IF NOT EXISTS covered_amount_cents INTEGER;

-- Backfill existing rows using 80% (the default coverage)
UPDATE insurance_claims
SET covered_amount_cents = ROUND(claim_amount_cents * 0.8)
WHERE covered_amount_cents IS NULL;
