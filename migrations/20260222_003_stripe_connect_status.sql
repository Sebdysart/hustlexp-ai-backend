-- Stripe Connect status columns
ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_connect_status VARCHAR(30) DEFAULT 'not_started';
ALTER TABLE users ADD COLUMN IF NOT EXISTS payouts_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS charges_enabled BOOLEAN DEFAULT FALSE;
