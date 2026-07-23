import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const MIGRATION = read('backend/database/migrations/20260720_task_safety_resolution_integrity.sql');
const RUNNER = read('backend/src/jobs/engine-automation-migration.ts');
const DOCKERFILE = read('Dockerfile');
const ADMIN_SERVICE = read('backend/src/services/IncidentSafetyAdminService.ts');
const ADMIN_ROUTES = read('backend/src/routers/incidentAdminRoutes.ts');

describe('task safety resolution-integrity migration', () => {
  it('binds ownership once and requires an owner-authored resolution witness', () => {
    expect(MIGRATION).toContain('HX827: safety case owner can be bound only on first acknowledgment');
    expect(MIGRATION).toContain('HX828: terminal safety state lacks owner-authored resolution evidence');
    expect(MIGRATION).toContain("event_type = 'resolved'");
    expect(MIGRATION).toContain('resolution_event.actor_user_id IS DISTINCT FROM NEW.assigned_admin_id');
    expect(MIGRATION).toContain("metadata->>'idempotency_key'");
    expect(MIGRATION).toContain("metadata->>'request_hash'");
    expect(MIGRATION).toContain('task_safety_resolution_event_fields_ck');
    expect(MIGRATION).toContain(') NOT VALID;');
  });

  it('uses one owner-bound, idempotent canonical resolution transaction', () => {
    expect(ADMIN_SERVICE).toContain('Only the assigned safety operator can resolve this case.');
    expect(ADMIN_SERVICE).toContain('Safety resolution key was reused with different resolution evidence.');
    expect(ADMIN_SERVICE).toContain("SET status = 'resolved', resolved_at = NOW()");
    expect(ADMIN_SERVICE).toContain("details->>'safety_incident_id' = $1");
    expect(ADMIN_ROUTES).toContain('Resolve this safety report through the canonical safety case workflow.');
  });

  it('ships migration 80 through startup and the production image', () => {
    expect(RUNNER).toContain('TASK_SAFETY_RESOLUTION_INTEGRITY_MIGRATION');
    expect(RUNNER).toContain("'20260720_task_safety_resolution_integrity'");
    expect(RUNNER).toContain("fileName: '20260720_task_safety_resolution_integrity.sql'");
    expect(DOCKERFILE).toContain(
      '/app/backend/database/migrations/20260720_task_safety_resolution_integrity.sql',
    );
  });
});
