import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'backend/database/migrations/20260823_quote_payment_recovery.sql',
  'utf8',
);
const registry = readFileSync(
  'backend/src/jobs/engine-automation-migration-files.ts',
  'utf8',
);

describe('quote payment recovery migration', () => {
  it('registers one runtime-owned append-only recovery evidence rail', () => {
    expect(registry).toContain("name: '20260823_quote_payment_recovery'");
    expect(registry).toContain("fileName: '20260823_quote_payment_recovery.sql'");
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.quote_payment_recovery_events');
    expect(migration).toContain("recovery_action TEXT NOT NULL CHECK (recovery_action IN ('VOIDED', 'REFUNDED'))");
    expect(migration).toContain("reason_code IN (\n    'UNDERWRITING_CONTAINMENT',\n    'POSTER_REQUESTED_CANCELLATION'");
    expect(migration).toContain('UNIQUE (quote_payment_id)');
    expect(migration).toContain('BEFORE UPDATE OR DELETE ON public.quote_payment_recovery_events');
    expect(migration).toContain('BEFORE TRUNCATE ON public.quote_payment_recovery_events');
  });
});
