import { randomBytes, randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { recomputeCapabilityProfile } from '../../src/services/CapabilityRecomputeService.js';
import {
  createTestPool,
  createTestUser,
  hasDb,
  promoteTestUserTrustSequentially,
} from '../setup.js';

interface UniversalTradeFixture {
  userId: string;
  verifiedTradeId: string;
}

interface TradeSnapshotRow {
  snapshot: Record<string, unknown>;
}

let pool: pg.Pool | undefined;

async function testPool(): Promise<pg.Pool> {
  if (!pool) throw new Error('PostgreSQL test pool is unavailable');
  return pool;
}

async function providerUser(): Promise<string> {
  const database = await testPool();
  const userId = await createTestUser(
    database,
    `test-capability-recompute-${randomUUID()}@hustlexp.test`
  );
  await promoteTestUserTrustSequentially(database, userId, 1);
  return userId;
}

async function universalTradeFixture(): Promise<UniversalTradeFixture> {
  const database = await testPool();
  const userId = await providerUser();
  const organizationId = randomUUID();
  const membershipId = randomUUID();
  const credentialId = randomUUID();
  const verifiedTradeId = randomUUID();

  await database.query(
    `INSERT INTO business_organizations(
       id, legal_name, display_name, provider_enabled, client_enabled,
       verification_status, status, created_by, creation_idempotency_key,
       provider_class
     ) VALUES (
       $1, 'Capability Preservation Plumbing LLC', 'Capability Plumbing', TRUE, FALSE,
       'VERIFIED', 'ACTIVE', $2, $3, 'VERIFIED_TRADE_BUSINESS'
     )`,
    [organizationId, userId, `capability-preservation:${organizationId}`]
  );
  await database.query(
    `INSERT INTO business_memberships(
       id, organization_id, user_id, role, status, invited_by, accepted_at
     ) VALUES ($1, $2, $3, 'OWNER', 'ACTIVE', $3, clock_timestamp())`,
    [membershipId, organizationId, userId]
  );
  await database.query(
    `INSERT INTO business_credentials(
       id, organization_id, membership_id, credential_type, status,
       expires_at, evidence_hash, verified_by, verified_at,
       qualification_contract_version, issuing_authority, jurisdiction_code,
       license_scope, permitted_work_categories, credential_evidence,
       official_source_checked_at
     ) VALUES (
       $1, $2, $3, 'PLUMBING_LICENSE', 'ACTIVE',
       clock_timestamp() + INTERVAL '365 days', $4, $5,
       clock_timestamp() - INTERVAL '1 day', 1, 'Washington Trade Authority',
       'US-WA', 'Residential plumbing installation and repair', ARRAY['plumbing']::text[],
       $6::jsonb, clock_timestamp() - INTERVAL '1 day'
     )`,
    [
      credentialId,
      organizationId,
      membershipId,
      randomBytes(32).toString('hex'),
      userId,
      JSON.stringify({ source: 'synthetic-official-register', licenseStatus: 'ACTIVE' }),
    ]
  );
  await database.query(
    `INSERT INTO verified_trades(
       id, user_id, trade, state, expires_at, provider_class,
       provider_organization_id, business_credential_id,
       universal_contract_version
     ) VALUES (
       $1, $2, 'plumbing', 'WA', CURRENT_DATE + 365,
       'VERIFIED_TRADE_BUSINESS', $3, $4, 1
     )`,
    [verifiedTradeId, userId, organizationId, credentialId]
  );

  return { userId, verifiedTradeId };
}

async function snapshotTrade(verifiedTradeId: string): Promise<Record<string, unknown>> {
  const database = await testPool();
  const result = await database.query<TradeSnapshotRow>(
    `SELECT to_jsonb(trade) AS snapshot
       FROM verified_trades trade
      WHERE trade.id = $1`,
    [verifiedTradeId]
  );
  const snapshot = result.rows[0]?.snapshot;
  if (!snapshot) throw new Error(`Missing verified trade ${verifiedTradeId}`);
  return snapshot;
}

beforeAll(async () => {
  if (!hasDb) return;
  pool = createTestPool();
  await pool.query('SELECT 1');
});

afterAll(async () => {
  await pool?.end();
});

describe.skipIf(!hasDb)('CapabilityRecomputeService Universal V1 projection isolation', () => {
  it('preserves every byte of an independently projected Universal V1 trade', async () => {
    const fixture = await universalTradeFixture();
    const before = await snapshotTrade(fixture.verifiedTradeId);

    await recomputeCapabilityProfile(fixture.userId, { reason: 'PRESERVATION_REGRESSION' });

    expect(await snapshotTrade(fixture.verifiedTradeId)).toEqual(before);
  });

  it('does not update a Universal V1 projection when a legacy license has the same key', async () => {
    const database = await testPool();
    const fixture = await universalTradeFixture();
    const before = await snapshotTrade(fixture.verifiedTradeId);
    await database.query(
      `INSERT INTO license_verifications(
         user_id, trade_type, license_number, issuing_state, status, expiration_date
       ) VALUES ($1, 'plumbing', $2, 'WA', 'APPROVED', CURRENT_DATE + 90)`,
      [fixture.userId, `legacy-${randomUUID()}`]
    );

    await recomputeCapabilityProfile(fixture.userId, { reason: 'SAME_KEY_REGRESSION' });

    const rows = await database.query<{ id: string; universal_contract_version: number }>(
      `SELECT id, universal_contract_version
         FROM verified_trades
        WHERE user_id = $1 AND trade = 'plumbing' AND state = 'WA'`,
      [fixture.userId]
    );
    expect(rows.rows).toEqual([{ id: fixture.verifiedTradeId, universal_contract_version: 1 }]);
    expect(await snapshotTrade(fixture.verifiedTradeId)).toEqual(before);
  });

  it('removes stale legacy rows without deleting Universal V1 rows', async () => {
    const database = await testPool();
    const fixture = await universalTradeFixture();
    const universalBefore = await snapshotTrade(fixture.verifiedTradeId);
    await database.query(
      `INSERT INTO verified_trades(
         user_id, trade, state, expires_at, universal_contract_version
       ) VALUES ($1, 'legacy_stale_trade', 'WA', CURRENT_DATE + 30, 0)`,
      [fixture.userId]
    );

    await recomputeCapabilityProfile(fixture.userId, { reason: 'STALE_LEGACY_REGRESSION' });

    const stale = await database.query<{ count: number }>(
      `SELECT COUNT(*)::integer AS count
         FROM verified_trades
        WHERE user_id = $1 AND universal_contract_version = 0`,
      [fixture.userId]
    );
    expect(stale.rows[0]?.count).toBe(0);
    expect(await snapshotTrade(fixture.verifiedTradeId)).toEqual(universalBefore);
  });

  it('rebuilds current legacy rows as contract-version zero idempotently', async () => {
    const database = await testPool();
    const userId = await providerUser();
    const licenseId = randomUUID();
    await database.query(
      `INSERT INTO license_verifications(
         id, user_id, trade_type, license_number, issuing_state, status, expiration_date
       ) VALUES ($1, $2, 'electrician', $3, 'WA', 'APPROVED', DATE '2028-12-31')`,
      [licenseId, userId, `legacy-${randomUUID()}`]
    );

    await recomputeCapabilityProfile(userId, { reason: 'LEGACY_REBUILD_REGRESSION' });
    const first = await database.query<{
      trade: string;
      state: string;
      expires_at: string;
      license_verification_id: string;
      universal_contract_version: number;
      provider_class: null;
      provider_organization_id: null;
      business_credential_id: null;
    }>(
      `SELECT trade, state, expires_at::date::text AS expires_at, license_verification_id,
              universal_contract_version, provider_class,
              provider_organization_id, business_credential_id
         FROM verified_trades
        WHERE user_id = $1`,
      [userId]
    );
    expect(first.rows).toEqual([
      {
        trade: 'electrician',
        state: 'WA',
        expires_at: '2028-12-31',
        license_verification_id: licenseId,
        universal_contract_version: 0,
        provider_class: null,
        provider_organization_id: null,
        business_credential_id: null,
      },
    ]);

    await recomputeCapabilityProfile(userId, { reason: 'LEGACY_REBUILD_REPLAY' });
    const replay = await database.query(
      `SELECT trade, state, expires_at::date::text AS expires_at, license_verification_id,
              universal_contract_version, provider_class,
              provider_organization_id, business_credential_id
         FROM verified_trades
        WHERE user_id = $1`,
      [userId]
    );
    expect(replay.rows).toEqual(first.rows);
  });
});
