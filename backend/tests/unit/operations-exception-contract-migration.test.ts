import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const MIGRATION = read('backend/database/migrations/20260720_operations_exception_contract.sql');
const RUNNER = [
  read('backend/src/jobs/engine-automation-migration.ts'),
  read('backend/src/jobs/engine-automation-migration-files.ts'),
].join('\n');
const DOCKERFILE = read('Dockerfile');
const TRPC = read('backend/src/trpc.ts');
const ROUTER = read('backend/src/routers/operations.ts');

describe('HX/OS Operations exception migration 82', () => {
  it('creates consequence-specific authority and a server-derived priority queue', () => {
    expect(MIGRATION).toContain('can_manage_operations BOOLEAN NOT NULL DEFAULT FALSE');
    expect(TRPC).toContain("capabilityAdminMiddleware('can_manage_operations')");
    expect(MIGRATION).toContain('CREATE OR REPLACE VIEW public.operations_exception_signals');
    for (const priority of [
      "1::INTEGER AS priority_rank,\n  'SAFETY'",
      "2,\n  'MONEY'",
      "3,\n  'ACTIVE_TASK'",
      "4,\n  'SLA'",
      "6,\n  'COMMUNICATION'",
    ]) expect(MIGRATION).toContain(priority);
  });

  it('masks sensitive payloads and exposes only classified evidence', () => {
    const view = MIGRATION.slice(MIGRATION.indexOf('CREATE OR REPLACE VIEW'));
    expect(view).not.toContain('incident.description');
    expect(view).not.toContain('notification.title');
    expect(view).not.toContain('notification.body');
    expect(view).not.toContain('delivery.last_error');
    expect(view).toContain('narrative, identity, and location are masked');
    expect(view).toContain('destination and raw provider error are masked');
  });

  it('makes detail, ownership, and recovery evidence append-only and server-only', () => {
    for (const table of [
      'operations_exception_access_log',
      'operations_exception_ownership_events',
      'operations_exception_action_events',
    ]) {
      expect(MIGRATION).toContain(`'${table}'`);
      expect(MIGRATION).toContain(`REVOKE ALL ON TABLE public.${table} FROM PUBLIC`);
    }
    expect(MIGRATION).toContain('HX830: Operations exception evidence is append-only');
    expect(MIGRATION).toContain("'NOTIFICATION_RETRY_SCHEDULED', 'NOTIFICATION_RETRY_CANCELLED'");
    expect(MIGRATION).toContain('reversal_of_action_id');
  });

  it('ships migration 82 through startup, routing, and the production image', () => {
    expect(RUNNER).toMatch(
      /OPERATIONS_EXCEPTION_CONTRACT_MIGRATION\s*=\s*'20260720_operations_exception_contract'/,
    );
    expect(RUNNER).toContain("fileName: '20260720_operations_exception_contract.sql'");
    expect(DOCKERFILE).toContain('/app/backend/database/migrations/20260720_operations_exception_contract.sql');
    expect(ROUTER).toContain('operationsAdminProcedure');
    expect(ROUTER).toContain('scheduleNotificationRecovery');
    expect(ROUTER).toContain('cancelNotificationRecovery');
  });
});
