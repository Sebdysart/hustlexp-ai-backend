import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const router = fs.readFileSync('backend/src/routers/automation.ts', 'utf8');
const service = fs.readFileSync('backend/src/services/HustlerIdentityLinkService.ts', 'utf8');
const migration = fs.readFileSync('backend/database/migrations/20260712_hustler_identity_link.sql', 'utf8');
const runner = fs.readFileSync('backend/src/jobs/engine-automation-migration.ts', 'utf8');

describe('canonical Hustler identity link contract', () => {
  it('is service-authenticated and validates engine id, claim id and E.164 phone', () => {
    const block = router.slice(router.indexOf('linkHustlerIdentity'), router.indexOf('listTasks'));
    expect(block).toContain('adminOrEngineBridgeProcedure');
    expect(block).toContain('engineHustlerRef: Schemas.uuid');
    expect(block).toContain('providerClaimId: Schemas.uuid');
    expect(block).toMatch(/phoneE164: z\.string\(\)\.regex/);
  });

  it('persists a hash-only idempotency bridge with one roster identity per engine user', () => {
    expect(migration).toContain('provider_claim_id UUID PRIMARY KEY');
    expect(migration).toContain('user_id UUID NOT NULL UNIQUE');
    expect(migration).toContain("phone_hash TEXT NOT NULL CHECK (phone_hash ~ '^[0-9a-f]{64}$')");
    expect(migration).not.toMatch(/phone_e164|firebase|email/i);
    expect(runner).toContain("fileName: '20260712_hustler_identity_link.sql'");
  });

  it('never promotes above trust tier one or creates an assignment/payout', () => {
    expect(service).toContain('Math.max(user.trust_tier, 1)');
    expect(service).not.toMatch(/trustTier[^\n]*[2-9]|assignment|payout|transfer|refund|stripe/i);
  });
});
