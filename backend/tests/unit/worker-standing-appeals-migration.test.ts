import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  WORKER_STANDING_APPEALS_MIGRATION,
  productionMigrationRuntime,
} from '../../src/jobs/engine-automation-migration.js';

const sql = readFileSync(resolve(
  process.cwd(), 'backend/database/migrations/20260720_worker_standing_appeals.sql',
), 'utf8');
const harness = readFileSync(resolve(
  process.cwd(), 'backend/tests/integration/worker-standing-appeals.pg.sql',
), 'utf8');

describe('worker standing appeal migration contract', () => {
  it('is a required startup migration', () => {
    const runtime = productionMigrationRuntime();
    expect(runtime.migrationSpecs.some((spec) => spec.name === WORKER_STANDING_APPEALS_MIGRATION)).toBe(true);
  });

  it('enforces independent review, append-only evidence, and zero retaliation', () => {
    expect(sql).toContain("ranking_penalty INTEGER NOT NULL DEFAULT 0 CHECK (ranking_penalty = 0)");
    expect(sql).toContain('appeal requires an independent human reviewer');
    expect(sql).toContain('worker standing evidence is append-only');
    expect(sql).toContain('major_action_worker_standing_appeal_events');
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
  });

  it('retains a falsifiable PostgreSQL harness for invalid transitions and mutation attempts', () => {
    expect(harness).toContain('WORKER_STANDING_APPEALS_DATABASE_CONTRACT_OK');
    expect(harness).toContain('HXSTAND4:');
    expect(harness).toContain('HXSTAND7:');
    expect(harness).toContain('HXSTAND8:');
  });
});
