import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const MIGRATION = read('backend/database/migrations/20260720_task_safety_case_access_integrity.sql');
const RUNNER = [
  read('backend/src/jobs/engine-automation-migration.ts'),
  read('backend/src/jobs/engine-automation-migration-files.ts'),
].join('\n');
const DOCKERFILE = read('Dockerfile');
const SERVICE = read('backend/src/services/IncidentSafetyAdminService.ts');

describe('task safety case-access integrity migration', () => {
  it('creates purpose-bound append-only detail access evidence', () => {
    expect(MIGRATION).toContain('CREATE TABLE IF NOT EXISTS task_safety_case_access_log');
    expect(MIGRATION).toContain("access_scope = 'CASE_DETAIL'");
    expect(MIGRATION).toContain('HX829: safety case access evidence is append-only');
    expect(MIGRATION).toContain('BEFORE UPDATE');
    expect(MIGRATION).toContain('BEFORE DELETE');
    expect(MIGRATION).toContain('BEFORE TRUNCATE');
    expect(MIGRATION).toContain('REVOKE ALL ON TABLE task_safety_case_access_log FROM PUBLIC');
  });

  it('uses an explicit privacy-minimized projection before recording access', () => {
    expect(SERVICE).toContain('INSERT INTO task_safety_case_access_log');
    expect(SERVICE).toContain("'CASE_DETAIL'");
    expect(SERVICE).not.toMatch(/SELECT \*\s+FROM task_safety_incidents/);
  });

  it('ships migration 81 through startup and the production image', () => {
    expect(RUNNER).toContain('TASK_SAFETY_CASE_ACCESS_INTEGRITY_MIGRATION');
    expect(RUNNER).toContain("'20260720_task_safety_case_access_integrity'");
    expect(RUNNER).toContain("fileName: '20260720_task_safety_case_access_integrity.sql'");
    expect(DOCKERFILE).toContain(
      '/app/backend/database/migrations/20260720_task_safety_case_access_integrity.sql',
    );
  });
});
