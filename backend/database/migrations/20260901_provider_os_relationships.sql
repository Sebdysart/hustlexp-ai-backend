-- Provider OS: persistent provider ↔ onboarded poster relationship.
-- Task visibility is derived from this table. Do not assign drafts one-by-one.

CREATE TABLE IF NOT EXISTS provider_os_relationships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  poster_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked')),
  onboarded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT provider_os_relationships_distinct_users
    CHECK (provider_user_id <> poster_user_id),
  CONSTRAINT provider_os_relationships_unique_pair
    UNIQUE (provider_user_id, poster_user_id)
);

CREATE INDEX IF NOT EXISTS idx_provider_os_rel_provider_active
  ON provider_os_relationships (provider_user_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_provider_os_rel_poster_active
  ON provider_os_relationships (poster_user_id)
  WHERE status = 'active';
