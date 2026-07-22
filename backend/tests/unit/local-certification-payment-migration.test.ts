import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'backend/database/migrations/20260720_local_certification_payment_provider.sql',
  'utf8',
);
const runner = readFileSync('backend/src/jobs/engine-automation-migration.ts', 'utf8');
const dockerfile = readFileSync('Dockerfile', 'utf8');

describe('local certification payment provider migration', () => {
  it('persists TEST-only intent identity, hashed capability, and provider state', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS hxos_local_test_payment_intents');
    expect(migration).toContain("CHECK (provider_mode = 'test')");
    expect(migration).toContain('CHECK (is_test IS TRUE)');
    expect(migration).toContain("client_secret_hash ~ '^[a-f0-9]{64}$'");
    expect(migration).not.toMatch(/client_secret\s+TEXT/i);
  });

  it('requires a matching pending CONTROLLED_TEST task and escrow', () => {
    expect(migration).toContain("automation_classification <> 'CONTROLLED_TEST'");
    expect(migration).toContain("escrow_row.state <> 'PENDING'");
    expect(migration).toContain('task_row.price <> NEW.amount_cents');
    expect(migration).toContain('escrow_row.amount <> NEW.amount_cents');
  });

  it('keeps economics immutable, success terminal, and events append-only', () => {
    expect(migration).toContain('local TEST payment identity and economics are immutable');
    expect(migration).toContain('succeeded local TEST payment is terminal');
    expect(migration).toContain('local TEST payment events are append-only');
    expect(migration).toContain('BEFORE UPDATE OR DELETE ON hxos_local_test_payment_events');
  });

  it('ships through the startup migration chain and production image', () => {
    expect(runner).toContain("'20260720_local_certification_payment_provider.sql'");
    expect(dockerfile).toContain(
      '/app/backend/database/migrations/20260720_local_certification_payment_provider.sql',
    );
  });
});
