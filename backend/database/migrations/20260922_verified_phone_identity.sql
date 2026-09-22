-- Existing phone values have no universal proof-of-verification. Do not
-- bulk-mark them verified or erase them. Firebase Admin verifies them lazily;
-- unverified legacy contact values can be preserved in contact_phone when the
-- real verified owner registers. The unique phone index remains in force.
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS contact_phone TEXT;
COMMENT ON COLUMN users.phone IS 'Identity phone, assigned only from Firebase Admin. Legacy rows without phone_verified_at require verification before collision protection.';
COMMENT ON COLUMN users.contact_phone IS 'Historical unverified contact phone; never used to authenticate or claim a customer draft.';
