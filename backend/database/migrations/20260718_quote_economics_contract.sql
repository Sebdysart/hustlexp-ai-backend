-- Canonical quote economics for website-created engine tasks.
--
-- The website Price Book already commits a customer total, Hustler payout,
-- and platform margin. This migration preserves that immutable split in the
-- engine instead of recomputing it later from a process-wide percentage.
-- Legacy tasks remain nullable and continue to use the legacy configured fee.

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS hustler_payout_cents INTEGER,
  ADD COLUMN IF NOT EXISTS platform_margin_cents INTEGER;

ALTER TABLE escrows
  ADD COLUMN IF NOT EXISTS platform_fee_cents INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tasks_quote_economics_pair_ck'
  ) THEN
    ALTER TABLE tasks ADD CONSTRAINT tasks_quote_economics_pair_ck CHECK (
      (hustler_payout_cents IS NULL AND platform_margin_cents IS NULL)
      OR (
        hustler_payout_cents IS NOT NULL
        AND platform_margin_cents IS NOT NULL
        AND hustler_payout_cents > 0
        AND platform_margin_cents >= 0
        AND hustler_payout_cents + platform_margin_cents = price
      )
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'escrows_platform_fee_within_amount_ck'
  ) THEN
    ALTER TABLE escrows ADD CONSTRAINT escrows_platform_fee_within_amount_ck CHECK (
      platform_fee_cents IS NULL
      OR (platform_fee_cents >= 0 AND platform_fee_cents < amount)
    );
  END IF;
END
$$;

COMMENT ON COLUMN tasks.hustler_payout_cents IS
  'Price Book Hustler payout before the separate self-insurance contribution; immutable quote economics.';
COMMENT ON COLUMN tasks.platform_margin_cents IS
  'Price Book platform margin; must reconcile with hustler_payout_cents to task price.';
COMMENT ON COLUMN escrows.platform_fee_cents IS
  'Canonical platform fee copied from task quote economics. NULL preserves legacy configured-percent behavior.';
