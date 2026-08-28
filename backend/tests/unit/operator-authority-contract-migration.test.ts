import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(
  process.cwd(),
  'backend/database/migrations/20260828_operator_authority_contract.sql',
), 'utf8');
const registry = readFileSync(resolve(
  process.cwd(),
  'backend/src/jobs/engine-automation-migration-files.ts',
), 'utf8');
const server = readFileSync(resolve(process.cwd(), 'backend/src/server.ts'), 'utf8');
const adminRoutes = readFileSync(resolve(process.cwd(), 'backend/src/serverAdminRoutes.ts'), 'utf8');
const authorityService = readFileSync(resolve(
  process.cwd(),
  'backend/src/services/OperatorAuthorityService.ts',
), 'utf8');

describe('Universal V1 operator authority migration', () => {
  it('registers the append-only migration in the required runner', () => {
    expect(registry).toContain("name: '20260828_operator_authority_contract'");
    expect(registry).toContain("fileName: '20260828_operator_authority_contract.sql'");
  });

  it('provides exact target versions and a closed containment-only operation set', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 1');
    expect(migration).toContain('action_links_operator_version');
    expect(migration).toContain('feature_flags_operator_version');
    expect(migration).toMatch(/operation_type IN \(\s*'EXPIRE_ACTION_LINK',\s*'DISABLE_FEATURE_FLAG'\s*\)/);
    expect(migration).toContain("command_payload = '{\"status\":\"expired\"}'::jsonb");
    expect(migration).toContain("command_payload = '{\"enabled\":false}'::jsonb");
    expect(authorityService).toMatch(/boundedOperatorOperations = \[\s*'EXPIRE_ACTION_LINK',\s*'DISABLE_FEATURE_FLAG'/);
    expect(authorityService).not.toMatch(/stripe|payouts?\.create|worker_id|assign(?:ment)?|deploy(?:ment)?|testflight/i);
  });

  it('requires an independent approver and an exact command-version transition', () => {
    expect(migration).toContain('CHECK (requested_by IS DISTINCT FROM approved_by)');
    expect(migration).toContain('NEW.requested_by = NEW.approved_by');
    expect(migration).toContain('NEW.version <> OLD.version + 1');
    expect(migration).toContain('operator_command_one_pending_target');
  });

  it('protects command evidence from update, delete, and truncate', () => {
    expect(migration).toContain('operator_command_audit_no_mutation');
    expect(migration).toContain('BEFORE UPDATE OR DELETE ON public.operator_command_audit');
    expect(migration).toContain('operator_command_audit_no_truncate');
    expect(migration).toContain('operator_command_no_delete');
    expect(migration).toContain('operator_command_no_truncate');
  });

  it('registers the named session route behind auth rate limiting', () => {
    expect(server).toContain("app.use('/admin/*', publicIpRateLimitMiddleware(), rateLimitMiddleware('auth'))");
    expect(server).toContain('registerAdminRoutes(app)');
    expect(adminRoutes).toContain("app.get('/admin/session'");
    expect(adminRoutes).toContain("honoContext.header('Cache-Control', 'no-store')");
  });
});
