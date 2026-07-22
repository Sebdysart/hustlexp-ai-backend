import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  OFFLINE_ACTION_RECONCILIATION_MIGRATION,
  productionMigrationRuntime,
} from '../../src/jobs/engine-automation-migration.js';

const sql = readFileSync(resolve(
  process.cwd(), 'backend/database/migrations/20260720_offline_action_reconciliation.sql',
), 'utf8');
const harness = readFileSync(resolve(
  process.cwd(), 'backend/tests/integration/offline-action-sync.pg.sql',
), 'utf8');

describe('offline action reconciliation migration contract', () => {
  it('is a required production startup migration', () => {
    expect(productionMigrationRuntime().migrationSpecs.some(
      (spec) => spec.name === OFFLINE_ACTION_RECONCILIATION_MIGRATION,
    )).toBe(true);
  });

  it('persists only versioned lowercase SHA-256 witnesses for each offline action class', () => {
    for (const table of ['proofs', 'task_safety_incidents', 'task_geofence_events']) {
      expect(sql).toContain(`ALTER TABLE ${table}`);
      expect(sql).toContain(`COMMENT ON COLUMN ${table}.offline_payload_hash`);
    }
    expect(sql).toContain('reconciliation_contract_version SMALLINT NOT NULL DEFAULT 0');
    expect(sql).toContain("offline_payload_hash ~ '^[a-f0-9]{64}$'");
    expect(sql).toContain('reconciliation_contract_version=0 AND offline_payload_hash IS NULL');
    expect(sql).toContain('reconciliation_contract_version=1 AND sync_contract_version=1');
  });

  it('ships falsifiable PostgreSQL checks for valid, partial, and malformed witnesses', () => {
    expect(harness).toContain('proof must retain its privacy-minimized reconciliation witness');
    expect(harness).toContain('proof reconciliation witness unexpectedly became partial');
    expect(harness).toContain('uppercase safety reconciliation hash unexpectedly succeeded');
    expect(harness).toContain('presence reconciliation witness unexpectedly became partial');
    expect(harness).toContain('OFFLINE_ACTION_SYNC_DATABASE_CONTRACT_OK');
  });
});
