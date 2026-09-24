-- Provider OS invite links: onboard new or existing posters via opaque token.
-- Raw token is never stored; only SHA-256 hash.

CREATE TABLE IF NOT EXISTS provider_os_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  token_hash TEXT NOT NULL
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  intended_email TEXT NULL,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'revoked', 'expired')),
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT provider_os_invites_token_hash_uq UNIQUE (token_hash)
);

CREATE INDEX IF NOT EXISTS idx_provider_os_invites_provider_open
  ON provider_os_invites (provider_user_id)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS idx_provider_os_invites_expires
  ON provider_os_invites (status, expires_at);
