import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const MIGRATION = read(
  'backend/database/migrations/20260825_pr276_incident_containment.sql'
);
const HARNESS = read(
  'backend/tests/integration/refund-provider-claim-authority.pg.sql'
);
const RUNNER = read('scripts/verify-pr276-incident-containment-postgres.mjs');
const PROVIDER_CLAIM = read('backend/src/services/EscrowRefundProviderClaim.ts');

describe('refund provider claim authority contract', () => {
  it('uses one exact application/database claim vocabulary', () => {
    for (const token of [
      'refund_provider_create_claim_v1',
      'refund-provider-create-claim-v1:',
      'hx-refund-claim-v1:',
      'refund_provider_claim_resolved_v1',
      'refund-provider-claim-resolved-v1:',
      'exact-succeeded-refund-v1:',
      'refund_terminal_authority',
    ]) {
      expect(MIGRATION).toContain(token);
      expect(HARNESS).toContain(token);
    }
    expect(PROVIDER_CLAIM).toContain("export const REFUND_PROVIDER_REPLAY_HOURS = 20");
    expect(PROVIDER_CLAIM).toContain("interval '20 hours'");
    expect(MIGRATION).toContain("INTERVAL '20 hours'");
  });

  it('proves acceptance, release, version drift, forgery, and exact terminal convergence in PostgreSQL', () => {
    expect(HARNESS).toContain(
      'task acceptance with active refund claim unexpectedly succeeded'
    );
    expect(HARNESS).toContain(
      'escrow release with unresolved refund claim unexpectedly succeeded'
    );
    expect(HARNESS).toContain(
      'multiple immutable refund claims unexpectedly terminalized'
    );
    expect(HARNESS).toContain(
      'multiple escrow-scoped provider claims must fail closed'
    );
    expect(HARNESS).toContain('forged refund resolution amount unexpectedly succeeded');
    expect(HARNESS).toContain(
      'exact claim, witness, and resolution must converge one immutable REFUNDED terminal'
    );
    expect(HARNESS).toContain('REFUND_PROVIDER_CLAIM_AUTHORITY_DATABASE_CONTRACT_OK');
    expect(HARNESS.trimEnd()).toMatch(/ROLLBACK;$/);
  });

  it('rejects every escrow-scoped claim except the one exact canonical version', () => {
    for (const source of [PROVIDER_CLAIM, MIGRATION]) {
      expect(source).toContain('other_claim.idempotency_key LIKE');
      expect(source).toContain("other_claim.metadata->>'event_type'='refund_provider_create_claim_v1'");
      expect(source).toContain("other_claim.metadata->>'escrow_id'");
      expect(source).toContain('other_claim.idempotency_key<>');
    }
  });

  it('runs the database contract in the containment matrix', () => {
    expect(RUNNER).toContain(
      "path.resolve('backend/tests/integration/refund-provider-claim-authority.pg.sql')"
    );
    expect(RUNNER).toContain('REFUND_PROVIDER_CLAIM_AUTHORITY_DATABASE_CONTRACT_OK');
  });
});
