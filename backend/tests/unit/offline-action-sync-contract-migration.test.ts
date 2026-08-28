import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(
  process.cwd(),
  'backend/database/migrations/20260720_offline_action_sync_contract.sql',
), 'utf8');
const harness = readFileSync(resolve(
  process.cwd(),
  'backend/tests/integration/offline-action-sync.pg.sql',
), 'utf8');
const repair = readFileSync(resolve(
  process.cwd(),
  'backend/database/migrations/20260720_offline_action_sync_contract_repair.sql',
), 'utf8');

describe('offline action sync migration contract', () => {
  it('defines a monotonic task version that callers cannot forge', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 1');
    expect(migration).toContain("to_jsonb(NEW) - 'version' - 'updated_at'");
    expect(migration).toContain('NEW.version := OLD.version + 1');
    expect(migration).toContain('NEW.version := OLD.version');
  });

  it('requires complete v1 proof and safety witnesses while retaining classified legacy rows', () => {
    for (const field of [
      'sync_contract_version', 'client_sequence', 'prior_task_version',
      'local_occurred_at', 'device_version', 'app_version', 'entry_surface',
      'context_source', 'intended_transition',
    ]) expect(migration).toContain(field);
    expect(migration).toContain('proofs_offline_sync_tuple_ck');
    expect(migration).toContain('task_safety_offline_sync_tuple_ck');
    expect(migration).toContain('sync_contract_version = 0');
    expect(migration).toContain('sync_contract_version = 1');
    expect(repair).toContain('device_version IS NOT NULL');
    expect(repair).toContain('app_version IS NOT NULL');
    expect(repair).toContain('entry_surface IS NOT NULL');
    expect(repair).toContain('context_source IS NOT NULL');
    expect(repair).toContain('intended_transition IS NOT NULL');
  });

  it('ships an executable adversarial PostgreSQL harness', () => {
    expect(harness).toContain('duplicate proof sequence unexpectedly succeeded');
    expect(harness).toContain('incomplete safety sync tuple unexpectedly succeeded');
    expect(harness).toContain('future geofence evidence unexpectedly succeeded');
    expect(harness).toContain('proof reconciliation witness unexpectedly became partial');
    expect(harness).toContain('OFFLINE_ACTION_SYNC_DATABASE_CONTRACT_OK');
  });
});
