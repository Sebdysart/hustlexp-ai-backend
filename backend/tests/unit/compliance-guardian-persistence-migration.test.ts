import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(
  process.cwd(),
  'backend/database/migrations/20260719_compliance_guardian_persistence_contract.sql',
), 'utf8');

describe('Compliance Guardian production persistence migration', () => {
  it('creates the canonical counter and converts the legacy array shape', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS flagged_phrase_counter JSONB');
    expect(migration).toContain("jsonb_typeof(flagged_phrase_counter) = 'array'");
    expect(migration).toContain('jsonb_object_agg');
    expect(migration).toContain("ALTER COLUMN flagged_phrase_counter SET DEFAULT '{}'::jsonb");
    expect(migration).toContain('ALTER COLUMN flagged_phrase_counter SET NOT NULL');
    expect(migration).toContain('users_flagged_phrase_counter_object');
  });

  it('creates the durable violation evidence contract and indexes', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS compliance_violations');
    expect(migration).toContain('user_id UUID REFERENCES users(id) ON DELETE SET NULL');
    expect(migration).toContain('risk_score INTEGER NOT NULL CHECK (risk_score BETWEEN 0 AND 100)');
    expect(migration).toContain('idx_compliance_violations_user_id');
    expect(migration).toContain('idx_compliance_violations_risk_score');
    expect(migration).toContain('idx_compliance_violations_created_at');
  });
});
