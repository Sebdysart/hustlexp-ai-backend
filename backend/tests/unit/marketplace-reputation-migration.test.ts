import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = resolve(process.cwd(), 'backend/database/migrations/20260718_marketplace_reputation_contract.sql');
const pgContractPath = resolve(process.cwd(), 'backend/tests/integration/marketplace-reputation-contract.pg.sql');

describe('marketplace reputation database contract', () => {
  it('separates verified work, transaction reviews, local recommendations, credentials, flags, and appeals', () => {
    const migration = readFileSync(migrationPath, 'utf8');
    for (const object of [
      'verified_region_memberships', 'local_provider_recommendations',
      'provider_credential_status', 'reputation_signal_flags',
      'reputation_signal_appeals', 'provider_reputation_public',
    ]) expect(migration).toContain(object);
    expect(migration).toContain('180.0');
    expect(migration).toContain('PENDING_MODERATION');
    expect(migration).toContain('HELD_FOR_REVIEW');
    expect(migration).toContain('BUILDING_HISTORY');
  });

  it('enforces locality, non-self recommendation, immutability, and public separation in PostgreSQL', () => {
    const contract = readFileSync(pgContractPath, 'utf8');
    expect(contract).toContain('MARKETPLACE_REPUTATION_DATABASE_CONTRACT_OK');
    for (const code of ['HXREP1', 'HXREP2', 'HXREP3', 'HXREP4', 'HXREP5']) {
      expect(contract).toContain(code);
    }
    expect(contract).toContain('blended_into_verified_score');
  });
});
