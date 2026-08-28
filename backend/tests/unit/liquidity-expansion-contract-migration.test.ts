import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(process.cwd(), 'backend/database/migrations/20260719_liquidity_expansion_contract.sql'),
  'utf8',
);
const repair = readFileSync(
  resolve(process.cwd(), 'backend/database/migrations/20260719_liquidity_expansion_fk_repair.sql'),
  'utf8',
);

describe('liquidity expansion database contract', () => {
  it('keeps decisions append-only, payload-bound, and target-linked', () => {
    expect(migration).toContain('liquidity_expansion_requests');
    expect(migration).toContain('UNIQUE (actor_id, idempotency_key)');
    expect(migration).toContain('request_hash CHAR(64)');
    expect(migration).toContain('source_metrics_hash CHAR(64)');
    expect(migration).toContain('liquidity_expansion_requests_immutable');
    expect(migration).toContain('expansion_origin_immutable');
    expect(migration).toContain('DEFERRABLE INITIALLY DEFERRED');
    expect(repair).toContain('liquidity_expansion_requests_target_cell_id_fkey');
    expect(repair).toContain('DEFERRABLE INITIALLY DEFERRED');
  });

  it('allows approved targets to start only in seeding and overrides only closed', () => {
    expect(migration).toContain("NEW.state <> 'SEEDING'");
    expect(migration).toContain("NEW.state <> 'CLOSED'");
    expect(migration).toContain('HXLC9: approved expansion must begin as non-dispatching seeding');
    expect(migration).toContain('HXLC10: override preparation cannot open a cell');
    expect(migration).toContain('HXLC11: denied expansion cannot create a cell');
  });
});
