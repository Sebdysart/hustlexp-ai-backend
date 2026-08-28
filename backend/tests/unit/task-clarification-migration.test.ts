import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(
  process.cwd(), 'backend/database/migrations/20260718_task_public_clarifications.sql',
), 'utf8');
const postgresContract = readFileSync(resolve(
  process.cwd(), 'backend/tests/integration/task-public-clarifications-contract.pg.sql',
), 'utf8');

describe('public task clarification database migration', () => {
  it('stores task-specific public Q&A without allowing comment-driven scope mutation', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS task_public_questions');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS task_clarification_revisions');
    expect(migration).toContain('public clarification identity and content are immutable');
    expect(migration).toContain('clarification revision proposal is immutable');
    expect(migration).toContain("clarification_state = 'REVISION_PENDING'");
  });

  it('requires exact Poster approval and fresh offer economics before acceptance', () => {
    expect(migration).toContain('reviewed_by IS DISTINCT FROM v_task.poster_id');
    expect(migration).toContain('proposed_customer_total_cents <> v_scope.customer_total_cents');
    expect(migration).toContain("NEW.clarification_state <> 'READY'");
    expect(migration).toContain("status = 'PENDING_POSTER_APPROVAL'");
    expect(migration).toContain('task_clarification_accept_gate');
  });

  it('ships an executable adversarial PostgreSQL contract', () => {
    expect(postgresContract).toContain('TASK_PUBLIC_CLARIFICATION_DATABASE_CONTRACT_OK');
    for (const code of ['HXCL1', 'HXCL2', 'HXCL4', 'HXCL6', 'HXCL8', 'HXCL9']) {
      expect(postgresContract).toContain(code);
    }
    expect(postgresContract).toContain("clarification_state = 'READY'");
  });
});
