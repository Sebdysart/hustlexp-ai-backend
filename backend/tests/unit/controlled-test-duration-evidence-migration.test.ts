import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(
  process.cwd(),
  'backend/database/migrations/20260720_controlled_test_duration_evidence.sql',
), 'utf8');

describe('controlled TEST duration evidence migration', () => {
  it('is append-only, range-bound, quote-linked, and TEST-only', () => {
    for (const invariant of [
      'source_quote_version_id UUID NOT NULL',
      "policy_version='price-book-duration-v1'",
      "source_environment='TEST'",
      "environment='CONTROLLED_TEST'",
      'UNIQUE(task_id)',
      'UNIQUE(source_quote_version_id)',
      'duration_min_minutes<=duration_expected_minutes',
      'duration_expected_minutes<=duration_max_minutes',
      'local TEST duration evidence is append-only',
    ]) expect(migration).toContain(invariant);
  });

  it('fails closed when marker, task state, or matching evidence is absent', () => {
    expect(migration).toContain("current_setting('hustlexp.local_test_duration_enabled',TRUE)='true'");
    expect(migration).toContain("v_task.automation_classification<>'CONTROLLED_TEST'");
    expect(migration).toContain('controlled TEST task duration lacks matching evidence');
    expect(migration).toContain('BEFORE UPDATE OF estimated_duration_minutes ON tasks');
  });
});
