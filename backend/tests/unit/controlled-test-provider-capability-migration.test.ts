import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(
  process.cwd(),
  'backend/database/migrations/20260720_controlled_test_provider_capability.sql',
), 'utf8');
const expiryRepair = readFileSync(resolve(
  process.cwd(),
  'backend/database/migrations/20260720_controlled_test_provider_capability_expiry.sql',
), 'utf8');
const refreshRepair = readFileSync(resolve(
  process.cwd(),
  'backend/database/migrations/20260720_controlled_test_provider_capability_refresh.sql',
), 'utf8');
const truncatedNameRepair = readFileSync(resolve(
  process.cwd(),
  'backend/database/migrations/20260720_controlled_test_provider_capability_refresh_repair.sql',
), 'utf8');

describe('controlled TEST provider capability migration', () => {
  it('binds exact task, provider, category, tools, service zone, source, and expiry', () => {
    for (const field of [
      'task_id UUID NOT NULL',
      'worker_id UUID NOT NULL',
      'source_hustler_id UUID NOT NULL',
      'category TEXT NOT NULL',
      'tools TEXT[] NOT NULL',
      'service_city TEXT NOT NULL',
      'service_state CHAR(2) NOT NULL',
      'service_radius_miles INTEGER NOT NULL',
      'source_evidence_hash CHAR(64) NOT NULL',
      'source_expires_at TIMESTAMPTZ NOT NULL',
      'expires_at TIMESTAMPTZ NOT NULL',
    ]) expect(migration).toContain(field);
    expect(migration).toContain("CHECK (expires_at=source_expires_at)");
    expect(migration).toContain("source_expires_at<=created_at+INTERVAL '4 hours'");
    expect(expiryRepair).toContain('ALTER COLUMN source_expires_at SET NOT NULL');
    expect(expiryRepair).toContain('hxos_local_test_provider_capability_source_expiry_ck');
    expect(expiryRepair).toContain('hxos_local_test_provider_capability_source_horizon_ck');
    expect(migration).not.toContain('UNIQUE(task_id,worker_id)');
    expect(refreshRepair).toContain('DROP CONSTRAINT IF EXISTS hxos_local_test_provider_capability_evidence_task_id_worker_id_key');
    expect(refreshRepair).toContain('hxos_local_test_provider_capability_task_worker_idx');
    expect(truncatedNameRepair).toContain("pg_get_constraintdef(oid)='UNIQUE (task_id, worker_id)'");
    expect(truncatedNameRepair).toContain('format(');
  });

  it('invalidates unbound liquidity and independently gates controlled acceptance', () => {
    expect(migration).toContain('provider_capability_evidence_id UUID');
    expect(migration).toContain('hxos_local_test_liquidity_witness_current_v2');
    expect(migration).toContain('controlled_test_provider_capability_accept_guard');
    expect(migration).toContain('controlled TEST acceptance lacks capability-bound liquidity');
    expect(migration).toContain('local TEST provider capability evidence is append-only');
  });
});
