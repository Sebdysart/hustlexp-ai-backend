import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');

describe('engine automation production container contract', () => {
  it('packages the required migration and enters through the fail-closed start command', () => {
    const dockerfile = read('Dockerfile');
    expect(dockerfile).toContain(
      'COPY --from=builder /app/backend/database/migrations/20260710_engine_automation_contracts.sql ./backend/database/migrations/20260710_engine_automation_contracts.sql',
    );
    expect(dockerfile).toContain('CMD ["npm", "start"]');
  });

  it('applies the migration before both web and worker runtimes', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts.start).toMatch(/engine-automation-migration/);
    expect(pkg.scripts.start).toContain('SERVICE_ROLE');
    expect(pkg.scripts.start).toContain('node dist/backend/src/jobs/workers.js');
    expect(pkg.scripts.start).toContain('node dist/backend/src/server.js');
    expect(pkg.scripts['start:workers']).toMatch(/engine-automation-migration.+&& node dist\/backend\/src\/jobs\/workers\.js/);

    const procfile = read('Procfile');
    expect(procfile).toContain('web: npm start');
    expect(procfile).toContain('worker: npm run start:workers');
  });

  it('keeps the API as the default role and makes worker health role-aware', () => {
    const dockerfile = read('Dockerfile');
    expect(dockerfile).toContain("process.env.SERVICE_ROLE==='worker'");
    expect(dockerfile).toContain("require('http').get('http://localhost:3000/health'");

    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts.start).toContain('else node dist/backend/src/server.js');
  });

  it('pins every canonical E2-E5 persistence witness in the packaged SQL', () => {
    const sql = read('backend/database/migrations/20260710_engine_automation_contracts.sql');
    for (const table of [
      'task_create_requests',
      'task_location_vault',
      'task_reservations',
      'task_reservation_requests',
      'task_dispatch_expiry_requests',
      'task_completion_delivery_events',
      'task_unattended_completion_requests',
      'engine_automation_events',
    ]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
  });
});
