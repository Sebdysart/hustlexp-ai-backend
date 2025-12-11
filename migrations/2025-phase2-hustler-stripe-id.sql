ALTER TABLE hustler_profiles ADD COLUMN IF NOT EXISTS stripe_account_id VARCHAR(255);
CREATE INDEX IF NOT EXISTS idx_hustler_stripe_id ON hustler_profiles(stripe_account_id);
