-- Legacy relationships may have been created without customer consent. Preserve
-- evidence, but require a new organization-owned invitation and explicit acceptance.
ALTER TABLE provider_os_relationships
  ADD COLUMN provider_organization_id UUID REFERENCES business_organizations(id) ON DELETE RESTRICT,
  ADD COLUMN created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN accepted_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN accepted_at TIMESTAMPTZ,
  ADD COLUMN disabled_reason TEXT;
ALTER TABLE provider_os_invites
  ADD COLUMN provider_organization_id UUID REFERENCES business_organizations(id) ON DELETE RESTRICT,
  ADD COLUMN created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN last_accepted_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN last_accepted_at TIMESTAMPTZ,
  ADD COLUMN disabled_reason TEXT;
UPDATE provider_os_relationships SET status = 'revoked',
  created_by_user_id = provider_user_id,
  disabled_reason = 'legacy_ownership_and_consent_unverified', updated_at = NOW();
UPDATE provider_os_invites SET status = 'revoked',
  created_by_user_id = provider_user_id,
  disabled_reason = 'legacy_organization_unverified', updated_at = NOW();
-- provider_user_id remains historical evidence only, never an access principal.
ALTER TABLE provider_os_relationships
  ALTER COLUMN provider_user_id DROP NOT NULL,
  DROP CONSTRAINT provider_os_relationships_unique_pair,
  ADD CONSTRAINT provider_os_relationships_org_customer_unique UNIQUE (provider_organization_id, poster_user_id),
  ADD CONSTRAINT provider_os_relationships_active_org CHECK (status <> 'active' OR provider_organization_id IS NOT NULL);
ALTER TABLE provider_os_invites
  ALTER COLUMN provider_user_id DROP NOT NULL,
  ADD CONSTRAINT provider_os_invites_open_org CHECK (status <> 'open' OR provider_organization_id IS NOT NULL);
CREATE INDEX idx_provider_os_relationship_org_active ON provider_os_relationships(provider_organization_id, poster_user_id) WHERE status = 'active';
CREATE INDEX idx_provider_os_invite_org_open ON provider_os_invites(provider_organization_id, expires_at) WHERE status = 'open';

CREATE TABLE provider_os_entitlements (
  organization_id UUID PRIMARY KEY REFERENCES business_organizations(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'revoked')),
  starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  grant_source TEXT NOT NULL DEFAULT 'manual_ops' CHECK (grant_source = 'manual_ops'),
  granted_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  granted_at TIMESTAMPTZ,
  changed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  suspended_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (expires_at IS NULL OR expires_at > starts_at)
);
-- No automatic grants: an operator must explicitly enable each business.
