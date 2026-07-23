-- Canonical engine record of an existing-roster identity claim.
-- The service stores only a provider claim UUID and a phone hash; the verified
-- phone belongs on the canonical user profile. One engine user may be linked to
-- exactly one roster identity through this contract.

CREATE TABLE IF NOT EXISTS engine_hustler_identity_links (
  provider_claim_id UUID PRIMARY KEY,
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  phone_hash TEXT NOT NULL CHECK (phone_hash ~ '^[0-9a-f]{64}$'),
  linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS engine_hustler_identity_links_phone_hash_uniq
  ON engine_hustler_identity_links(phone_hash);
