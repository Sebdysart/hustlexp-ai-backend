import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
const mocks = vi.hoisted(() => ({ query: vi.fn(), transaction: vi.fn() }));
vi.mock('../../src/db.js', () => ({ db: { query: mocks.query, transaction: mocks.transaction } }));
vi.mock('../../src/logger.js', () => ({ logger: { warn: vi.fn() } }));
import {
  createProviderOsPurchase,
  finalizeProviderOsPurchase,
  getProviderOsPurchaseState,
  refreshProviderOsPurchase,
  completeControlledProviderOsPurchase,
  reconcileProviderOsPurchases,
} from '../../src/services/ProviderOsPurchaseService.js';
import { LocalCertificationPaymentProvider } from '../../src/services/LocalCertificationPaymentProvider.js';
import { writeProviderOsEntitlement } from '../../src/services/ProviderOsEntitlementService.js';
import type { QueryFn } from '../../src/db.js';
const databaseUrl = process.env.PROVIDER_OS_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)(
  'Provider OS purchases: real PostgreSQL and controlled-test provider ledger',
  () => {
    const client = new Client({ connectionString: databaseUrl });
    const schema = `purchase_test_${randomUUID().replaceAll('-', '')}`;
    const org = randomUUID(),
      other = randomUUID(),
      actor = randomUUID(),
      outsider = randomUUID();
    const query = (sql: string, values?: unknown[]) => client.query(sql, values);
    const env = {
      NODE_ENV: 'test',
      ENGINE_API_MODE: 'test',
      PAYMENT_PROVIDER: 'local_test',
      HX_PAYMENT_CREATION_MODE: 'enabled',
      HXOS_ALLOW_LOCAL_TEST_PAYMENT: 'true',
      HXOS_LOCAL_TEST_PAYMENT_SECRET: 'controlled-product-test-secret-32-characters',
      PROVIDER_OS_TEST_PURCHASE_ENABLED: 'true',
      PROVIDER_OS_TEST_AMOUNT_CENTS: '1234',
      PROVIDER_OS_TEST_PERIOD_DAYS: '30',
      PROVIDER_OS_TEST_CURRENCY: 'usd',
    };
    const purchase = async () => (await createProviderOsPurchase(org, actor)).purchase!;
    const paid = async () =>
      LocalCertificationPaymentProvider.confirmProductIntent(await row(), query as QueryFn);
    const row = async () => (await query('SELECT * FROM provider_os_purchases LIMIT 1')).rows[0];
    const entitlement = async () =>
      (await query('SELECT * FROM provider_os_entitlements WHERE organization_id=$1', [org]))
        .rows[0];
    beforeAll(async () => {
      const url = new URL(databaseUrl!);
      if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.port !== '55439')
        throw new Error('Isolated local test database required');
      await client.connect();
      await query(`CREATE SCHEMA ${schema}`);
      await query(`SET search_path TO ${schema}`);
      await query(`CREATE TABLE users(id UUID PRIMARY KEY,account_status TEXT DEFAULT 'ACTIVE',is_banned BOOLEAN DEFAULT false,trust_hold BOOLEAN DEFAULT false);
      CREATE TABLE business_organizations(id UUID PRIMARY KEY,status TEXT DEFAULT 'ACTIVE',provider_enabled BOOLEAN DEFAULT true,verification_status TEXT DEFAULT 'VERIFIED');
      CREATE TABLE business_memberships(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),organization_id UUID,user_id UUID,status TEXT DEFAULT 'ACTIVE',role TEXT DEFAULT 'OWNER');
      CREATE FUNCTION business_membership_has_action(UUID,UUID,TEXT) RETURNS BOOLEAN LANGUAGE sql AS 'SELECT EXISTS(SELECT 1 FROM business_memberships WHERE organization_id=$1 AND user_id=$2 AND status=''ACTIVE'' AND role IN (''OWNER'',''ADMIN''))';
      CREATE TABLE ops_action_audit(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),actor_user_id UUID,actor_label TEXT,action TEXT,target_type TEXT,target_id UUID,meta JSONB);
      CREATE TABLE provider_os_entitlements(organization_id UUID PRIMARY KEY REFERENCES business_organizations(id),status TEXT NOT NULL,starts_at TIMESTAMPTZ DEFAULT NOW(),expires_at TIMESTAMPTZ,
        grant_source TEXT DEFAULT 'manual_ops' CONSTRAINT provider_os_entitlements_grant_source_check CHECK(grant_source='manual_ops'),
        granted_by_user_id UUID,granted_at TIMESTAMPTZ,changed_by_user_id UUID,suspended_at TIMESTAMPTZ,revoked_at TIMESTAMPTZ,reason TEXT,created_at TIMESTAMPTZ DEFAULT NOW(),updated_at TIMESTAMPTZ DEFAULT NOW());`);
      await query(
        readFileSync('backend/database/migrations/20260919_provider_os_purchases.sql', 'utf8')
      );
      mocks.query.mockImplementation(query);
      mocks.transaction.mockImplementation(async (fn) => {
        const connection = new Client({ connectionString: databaseUrl });
        await connection.connect();
        const tx = (sql: string, values?: unknown[]) => connection.query(sql, values);
        try {
          await tx(`SET search_path TO ${schema}`);
          await tx('BEGIN');
          const r = await fn(tx);
          await tx('COMMIT');
          return r;
        } catch (e) {
          await tx('ROLLBACK');
          throw e;
        } finally {
          await connection.end();
        }
      });
    });
    afterAll(async () => {
      vi.unstubAllEnvs();
      await query(`DROP SCHEMA ${schema} CASCADE`);
      await client.end();
    });
    beforeEach(async () => {
      for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
      await query(
        'TRUNCATE hxos_local_test_product_events,hxos_local_test_product_intents,provider_os_entitlements,provider_os_purchases,ops_action_audit,business_memberships,business_organizations,users CASCADE'
      );
      await query('INSERT INTO users(id) VALUES($1),($2)', [actor, outsider]);
      await query('INSERT INTO business_organizations(id) VALUES($1),($2)', [org, other]);
      await query(
        'INSERT INTO business_memberships(organization_id,user_id) VALUES($1,$2),($3,$4)',
        [org, actor, other, outsider]
      );
    });
    it('authorizes exact organization and billing action without requiring entitlement', async () => {
      await expect(createProviderOsPurchase(org, outsider)).rejects.toThrow();
      await query("UPDATE business_memberships SET role='DISPATCHER' WHERE user_id=$1", [actor]);
      await expect(createProviderOsPurchase(org, actor)).rejects.toThrow();
      expect((await query('SELECT * FROM hxos_local_test_product_intents')).rows).toHaveLength(0);
    });
    it('persists pending before checkout, reuses it, and restores it on reload', async () => {
      const p = await purchase();
      expect(p.status).toBe('pending');
      expect((await purchase()).id).toBe(p.id);
      expect((await query('SELECT * FROM hxos_local_test_product_intents')).rows).toHaveLength(1);
      expect((await getProviderOsPurchaseState(org, actor)).purchase?.id).toBe(p.id);
      expect(await entitlement()).toBeUndefined();
      await expect(refreshProviderOsPurchase(other, outsider, p.id)).rejects.toThrow(
        'Purchase not found'
      );
    });
    it('browser completion without authoritative payment cannot unlock', async () => {
      const p = await purchase();
      await refreshProviderOsPurchase(org, actor, p.id);
      expect(await entitlement()).toBeUndefined();
    });
    it.each([
      ['PROVIDER_OS_TEST_AMOUNT_CENTS', '0'],
      ['PROVIDER_OS_TEST_CURRENCY', 'eur'],
      ['PROVIDER_OS_TEST_PERIOD_DAYS', '0'],
      ['HX_PAYMENT_CREATION_MODE', 'frozen'],
    ])('blocks new confirmation through every entry point when %s is invalid', async (key, value) => {
      const p = await purchase();
      vi.stubEnv(key, value);
      await expect(completeControlledProviderOsPurchase(org, actor, p.id)).rejects.toThrow();
      await expect(paid()).rejects.toThrow();
      await expect(LocalCertificationPaymentProvider.createProductIntent(await row())).rejects.toThrow();
      expect((await query('SELECT status FROM hxos_local_test_product_intents')).rows[0].status).toBe('requires_confirmation');
      expect(await entitlement()).toBeUndefined();
    });
    it('reconciles an already confirmed payment while creation is frozen and the catalog is invalid', async () => {
      const p = await purchase();
      await paid();
      vi.stubEnv('HX_PAYMENT_CREATION_MODE', 'frozen');
      vi.stubEnv('PROVIDER_OS_TEST_PERIOD_DAYS', '0');
      await finalizeProviderOsPurchase(p.id);
      expect((await row()).status).toBe('succeeded');
      expect((await entitlement()).source_purchase_id).toBe(p.id);
    });
    it('verified success grants once across webhook replay and refresh', async () => {
      const p = await purchase();
      await paid();
      await completeControlledProviderOsPurchase(org, actor, p.id);
      const first = await entitlement();
      expect(first.grant_source).toBe('purchase');
      expect(first.source_purchase_id).toBe(p.id);
      expect(first.expires_at.getTime() - first.starts_at.getTime()).toBe(30 * 86400000);
      await completeControlledProviderOsPurchase(org, actor, p.id);
      await finalizeProviderOsPurchase(p.id);
      expect((await entitlement()).expires_at).toEqual(first.expires_at);
      expect((await row()).status).toBe('succeeded');
      expect((await query('SELECT * FROM ops_action_audit')).rows).toHaveLength(1);
    });
    it.each(['amount_cents', 'currency', 'organization_id', 'is_test', 'period_days'])(
      'fails closed on %s mismatch',
      async (field) => {
        const p = await purchase();
        await paid();
        const original = (await query('SELECT * FROM hxos_local_test_product_intents')).rows[0];
        const mismatches: Record<string, unknown> = {
          amount_cents: 999,
          currency: 'eur',
          organization_id: other,
          is_test: false,
          period_days: 999,
        };
        const prior = mocks.query.getMockImplementation()!;
        mocks.query.mockImplementation(async (sql: string, values?: unknown[]) =>
          sql.startsWith('SELECT * FROM hxos_local_test_product_intents')
            ? { rows: [{ ...original, [field]: mismatches[field] }], rowCount: 1 }
            : prior(sql, values)
        );
        await expect(finalizeProviderOsPurchase(p.id)).rejects.toThrow();
        mocks.query.mockImplementation(query);
        expect(await entitlement()).toBeUndefined();
        expect((await row()).status).toBe('pending');
      }
    );
    it('failed payment leaves access inactive; later authoritative success can recover', async () => {
      const p = await purchase();
      await query("UPDATE hxos_local_test_product_intents SET status='failed'");
      await finalizeProviderOsPurchase(p.id);
      expect((await row()).status).toBe('failed');
      expect(await entitlement()).toBeUndefined();
      await query("UPDATE hxos_local_test_product_intents SET status='succeeded'");
      await finalizeProviderOsPurchase(p.id);
      expect((await row()).status).toBe('succeeded');
    });
    it('extends finite access granted during checkout from its existing expiry', async () => {
      const p = await purchase();
      const expiry = new Date(Date.now() + 10 * 86400000);
      await writeProviderOsEntitlement(query as QueryFn, {
        organizationId: org,
        actorId: actor,
        status: 'active',
        expiresAt: expiry.toISOString(),
        reason: 'manual fixture',
      });
      await paid();
      await finalizeProviderOsPurchase(p.id);
      expect((await entitlement()).expires_at.getTime()).toBe(expiry.getTime() + 30 * 86400000);
      await expect(createProviderOsPurchase(org, actor)).rejects.toThrow();
    });
    it.each(['suspended', 'revoked'] as const)(
      'does not sell or overwrite %s access',
      async (status) => {
        const p = await purchase();
        await writeProviderOsEntitlement(query as QueryFn, {
          organizationId: org,
          actorId: actor,
          status,
          reason: 'Ops block',
        });
        await expect(createProviderOsPurchase(org, actor)).rejects.toThrow();
        await paid();
        await finalizeProviderOsPurchase(p.id);
        expect((await entitlement()).status).toBe(status);
        expect((await row()).paid_at).not.toBeNull();
        expect((await row()).resolution_reason).toBe('administrative_access_block');
        expect((await getProviderOsPurchaseState(org, actor)).purchase?.checkout).toBeNull();
      }
    );
    it('holds a paid purchase if purchaser membership was removed', async () => {
      const p = await purchase();
      await query("UPDATE business_memberships SET status='REMOVED' WHERE user_id=$1", [actor]);
      await paid();
      await finalizeProviderOsPurchase(p.id);
      expect(await entitlement()).toBeUndefined();
      expect((await row()).resolution_reason).toBe('purchaser_no_longer_authorized');
      await expect(refreshProviderOsPurchase(org, actor, p.id)).rejects.toThrow();
    });
    it('recovers provider failures and closed browser through scheduled reconciliation', async () => {
      const p = await purchase();
      await paid();
      const original = mocks.query.getMockImplementation()!;
      mocks.query.mockImplementation(async (sql: string, values?: unknown[]) => {
        if (sql.startsWith('SELECT * FROM hxos_local_test_product_intents'))
          throw new Error('provider store unavailable');
        return original(sql, values);
      });
      await expect(finalizeProviderOsPurchase(p.id)).rejects.toThrow();
      expect(await entitlement()).toBeUndefined();
      mocks.query.mockImplementation(query);
      await query('UPDATE provider_os_purchases SET next_check_at=NOW()');
      await reconcileProviderOsPurchases();
      expect((await row()).status).toBe('succeeded');
    });
    it('provider cancellation permits a new purchase', async () => {
      const p = await purchase();
      await query("UPDATE hxos_local_test_product_intents SET status='canceled'");
      await finalizeProviderOsPurchase(p.id);
      expect((await row()).status).toBe('canceled');
      expect((await getProviderOsPurchaseState(org, actor)).canPurchase).toBe(true);
    });
    it('does not treat purchase as business verification', async () => {
      await query("UPDATE business_organizations SET verification_status='PENDING' WHERE id=$1", [
        org,
      ]);
      const p = await purchase();
      await paid();
      await finalizeProviderOsPurchase(p.id);
      expect((await getProviderOsPurchaseState(org, actor)).verificationRequired).toBe(true);
    });
    it('new payments freeze but already-paid verification remains available', async () => {
      const p = await purchase();
      await paid();
      vi.stubEnv('HX_PAYMENT_CREATION_MODE', 'frozen');
      await expect(createProviderOsPurchase(org, actor)).rejects.toThrow();
      await finalizeProviderOsPurchase(p.id);
      expect((await row()).status).toBe('succeeded');
    });
    it('reauthorizes before controlled confirmation and rejects cross-org confirmation', async () => {
      const p = await purchase();
      await expect(completeControlledProviderOsPurchase(other, outsider, p.id)).rejects.toThrow();
      await query("UPDATE business_memberships SET status='REMOVED' WHERE user_id=$1", [actor]);
      await expect(completeControlledProviderOsPurchase(org, actor, p.id)).rejects.toThrow();
      expect(
        (await query('SELECT status FROM hxos_local_test_product_intents')).rows[0].status
      ).toBe('requires_confirmation');
    });
    it('creates, confirms and verifies a controlled purchase in production with the existing override', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('HXOS_ALLOW_LOCAL_TEST_PAYMENT_IN_PRODUCTION', 'true');
      const p = await purchase();
      expect((await getProviderOsPurchaseState(org, actor)).product?.provider).toBe('local_test');
      await completeControlledProviderOsPurchase(org, actor, p.id);
      expect((await row()).status).toBe('succeeded');
      expect((await entitlement()).source_purchase_id).toBe(p.id);
    });
    it.each(['false', undefined])('rejects production creation, confirmation and verification without override (%s)', async (override) => {
      const p = await purchase();
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('HXOS_ALLOW_LOCAL_TEST_PAYMENT_IN_PRODUCTION', override);
      expect((await getProviderOsPurchaseState(org, actor)).product).toBeNull();
      await expect(completeControlledProviderOsPurchase(org, actor, p.id)).rejects.toThrow();
      await expect(createProviderOsPurchase(org, actor)).rejects.toThrow();
      await expect(LocalCertificationPaymentProvider.verifyProductIntent(await row())).rejects.toThrow('disabled');
      expect(await entitlement()).toBeUndefined();
    });
    it('payment is durable if the entitlement transaction fails and recovers without a second confirmation', async () => {
      const p = await purchase();
      const transaction = mocks.transaction.getMockImplementation()!;
      let calls = 0;
      mocks.transaction.mockImplementation(async (fn) => {
        calls++;
        if (calls === 2) throw new Error('grant failure');
        return transaction(fn);
      });
      await completeControlledProviderOsPurchase(org, actor, p.id);
      mocks.transaction.mockImplementation(transaction);
      expect(await entitlement()).toBeUndefined();
      expect(
        (await query('SELECT status FROM hxos_local_test_product_intents')).rows[0].status
      ).toBe('succeeded');
      await finalizeProviderOsPurchase(p.id);
      expect((await row()).status).toBe('succeeded');
      expect(
        (
          await query(
            "SELECT * FROM hxos_local_test_product_events WHERE event_type='intent_succeeded'"
          )
        ).rows
      ).toHaveLength(1);
    });
    it('serializes concurrent purchase creation and finalization across separate database connections', async () => {
      const [one, two] = await Promise.all([purchase(), purchase()]);
      expect(one.id).toBe(two.id);
      await paid();
      await Promise.all([finalizeProviderOsPurchase(one.id), finalizeProviderOsPurchase(two.id)]);
      const access = await entitlement();
      expect(access.expires_at.getTime() - access.starts_at.getTime()).toBe(30 * 86400000);
      expect((await query('SELECT * FROM ops_action_audit')).rows).toHaveLength(1);
    });
    it('rolls back entitlement and audit together if purchase success persistence fails', async () => {
      const p = await purchase();
      await paid();
      await query(`CREATE FUNCTION fail_purchase_success() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='succeeded' THEN RAISE EXCEPTION 'fixture write failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_purchase_success BEFORE UPDATE ON provider_os_purchases FOR EACH ROW EXECUTE FUNCTION fail_purchase_success()`);
      try {
        await expect(finalizeProviderOsPurchase(p.id)).rejects.toThrow();
        expect(await entitlement()).toBeUndefined();
        expect((await query('SELECT * FROM ops_action_audit')).rows).toHaveLength(0);
        expect(
          (await query('SELECT status FROM hxos_local_test_product_intents')).rows[0].status
        ).toBe('succeeded');
      } finally {
        await query(
          'DROP TRIGGER fail_purchase_success ON provider_os_purchases; DROP FUNCTION fail_purchase_success()'
        );
      }
      await finalizeProviderOsPurchase(p.id);
      expect((await row()).status).toBe('succeeded');
    });
    it('never accesses task payment tables (fixture deliberately contains none)', async () => {
      const p = await purchase();
      await paid();
      await finalizeProviderOsPurchase(p.id);
      expect((await row()).status).toBe('succeeded');
    });
  }
);
