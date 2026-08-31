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
  it('registers durable recovery ownership plus append-only transition evidence', () => {
    expect(registry).toContain("name: '20260823_quote_payment_recovery'");
    expect(registry).toContain("fileName: '20260823_quote_payment_recovery.sql'");
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.quote_payment_recovery_operations');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.quote_payment_recovery_events');
    expect(migration).toContain("'CLAIMED', 'COMPLETED', 'RECONCILIATION_REQUIRED'");
    expect(migration).toContain('expected_payment_updated_at TIMESTAMPTZ NOT NULL');
    expect(migration).toContain('correlation_id UUID NOT NULL UNIQUE');
    expect(migration).toContain("'CLAIMED', 'CLAIM_RENEWED', 'COMPLETED', 'RECONCILIATION_REQUIRED'");
    expect(migration).toContain("recovery_action TEXT CHECK (recovery_action IN ('VOIDED', 'REFUNDED'))");
    expect(migration).toContain("reason_code IN (\n    'UNDERWRITING_CONTAINMENT',\n    'POSTER_REQUESTED_CANCELLATION'");
    expect(migration).toContain('quote_payment_id UUID NOT NULL UNIQUE');
    expect(migration).toContain('quote_payment_recovery_terminal_event_uq');
    expect(migration).toContain('BEFORE UPDATE OR DELETE ON public.quote_payment_recovery_operations');
    expect(migration).toContain('BEFORE TRUNCATE ON public.quote_payment_recovery_operations');
    expect(migration).toContain('BEFORE UPDATE OR DELETE ON public.quote_payment_recovery_events');
    expect(migration).toContain('BEFORE TRUNCATE ON public.quote_payment_recovery_events');
  });
});
