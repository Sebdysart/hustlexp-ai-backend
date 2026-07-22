BEGIN;

-- Normalize every historical admin_roles shape before capability-scoped API
-- guards are enabled. Existing rows already had universal administrator access,
-- so assigning the legacy null role to admin preserves rather than expands it.
ALTER TABLE admin_roles ADD COLUMN IF NOT EXISTS role VARCHAR(50);
UPDATE admin_roles SET role = 'admin' WHERE role IS NULL;
ALTER TABLE admin_roles ALTER COLUMN role SET DEFAULT 'support';
ALTER TABLE admin_roles ALTER COLUMN role SET NOT NULL;

ALTER TABLE admin_roles DROP CONSTRAINT IF EXISTS admin_roles_role_check;
ALTER TABLE admin_roles
  ADD CONSTRAINT admin_roles_role_check
  CHECK (role IN ('support', 'finance', 'moderator', 'admin', 'founder'));

ALTER TABLE admin_roles ADD COLUMN IF NOT EXISTS can_resolve_disputes BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE admin_roles ADD COLUMN IF NOT EXISTS can_override_escrow BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE admin_roles ADD COLUMN IF NOT EXISTS can_modify_trust BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE admin_roles ADD COLUMN IF NOT EXISTS can_ban_users BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE admin_roles ADD COLUMN IF NOT EXISTS can_access_financials BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE admin_roles ADD COLUMN IF NOT EXISTS can_manage_incidents BOOLEAN NOT NULL DEFAULT FALSE;

-- Existing baselines exposed nullable booleans while historical upgrades added
-- newer capabilities as NOT NULL. Authorization must never depend on SQL NULL,
-- so normalize every flag before enforcing one canonical shape.
UPDATE admin_roles
SET can_resolve_disputes = COALESCE(can_resolve_disputes, FALSE),
    can_override_escrow = COALESCE(can_override_escrow, FALSE),
    can_modify_trust = COALESCE(can_modify_trust, FALSE),
    can_ban_users = COALESCE(can_ban_users, FALSE),
    can_access_financials = COALESCE(can_access_financials, FALSE),
    can_manage_incidents = COALESCE(can_manage_incidents, FALSE);

ALTER TABLE admin_roles
  ALTER COLUMN can_resolve_disputes SET DEFAULT FALSE,
  ALTER COLUMN can_resolve_disputes SET NOT NULL,
  ALTER COLUMN can_override_escrow SET DEFAULT FALSE,
  ALTER COLUMN can_override_escrow SET NOT NULL,
  ALTER COLUMN can_modify_trust SET DEFAULT FALSE,
  ALTER COLUMN can_modify_trust SET NOT NULL,
  ALTER COLUMN can_ban_users SET DEFAULT FALSE,
  ALTER COLUMN can_ban_users SET NOT NULL,
  ALTER COLUMN can_access_financials SET DEFAULT FALSE,
  ALTER COLUMN can_access_financials SET NOT NULL,
  ALTER COLUMN can_manage_incidents SET DEFAULT FALSE,
  ALTER COLUMN can_manage_incidents SET NOT NULL;

-- Role defaults are explicit and reviewable. Support has no high-impact
-- capability by default; a founder/admin remains the break-glass authority.
UPDATE admin_roles
SET can_resolve_disputes = can_resolve_disputes OR role IN ('moderator', 'admin', 'founder'),
    can_override_escrow = can_override_escrow OR role IN ('finance', 'admin', 'founder'),
    can_modify_trust = can_modify_trust OR role IN ('moderator', 'admin', 'founder'),
    can_ban_users = can_ban_users OR role IN ('moderator', 'admin', 'founder'),
    can_access_financials = can_access_financials OR role IN ('finance', 'admin', 'founder'),
    can_manage_incidents = can_manage_incidents OR role IN ('moderator', 'admin', 'founder');

CREATE UNIQUE INDEX IF NOT EXISTS uq_admin_roles_user ON admin_roles(user_id);

COMMIT;
