import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(
  process.cwd(), 'backend/database/migrations/20260718_completion_retention_contract.sql',
), 'utf8');
const postgresContract = readFileSync(resolve(
  process.cwd(), 'backend/tests/integration/completion-retention-contract.pg.sql',
), 'utf8');

describe('completion retention database migration', () => {
  it('binds rebooks to a completed transaction without cloning an assignment', () => {
    expect(migration).toContain('repeat_source_task_id UUID REFERENCES tasks(id)');
    expect(migration).toContain('preferred_worker_id UUID REFERENCES users(id)');
    expect(migration).toContain("source_row.state <> 'COMPLETED'");
    expect(migration).toContain("NEW.worker_id IS NOT NULL");
    expect(migration).toContain('rebook retention binding is immutable');
  });

  it('stores the six bounded structured review dimensions', () => {
    for (const field of [
      'communication', 'scopeAccuracy', 'punctuality', 'care', 'resultQuality', 'value',
    ]) {
      expect(migration).toContain(field);
    }
    expect(migration).toContain('BETWEEN 1 AND 5');
    expect(migration).toContain('review requires a completed assigned transaction');
    expect(migration).toContain('reviewer and reviewed user must be transaction participants');
    expect(migration).toContain('completed-task review content is immutable');
  });

  it('ships an executable adversarial PostgreSQL contract', () => {
    expect(postgresContract).toContain('COMPLETION_RETENTION_DATABASE_CONTRACT_OK');
    for (const code of ['HXRT3', 'HXRT4', 'HXRT5', 'HXRT6', 'HXRT8', 'HXRV1', 'HXRV4']) {
      expect(postgresContract).toContain(code);
    }
    expect(postgresContract).toContain("amount = 7500 AND state = 'PENDING'");
  });
});
