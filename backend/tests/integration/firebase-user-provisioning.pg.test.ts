import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';

const { getFirebaseUserRecord } = vi.hoisted(() => ({ getFirebaseUserRecord: vi.fn() }));
vi.mock('../../src/auth/firebase.js', () => ({ getFirebaseUserRecord }));

const testUrl = process.env.PROVIDER_OS_TEST_DATABASE_URL;
const migration = (file: string) => readFileSync(`backend/database/migrations/${file}.sql`, 'utf8');

describe.skipIf(!testUrl)('Firebase lazy user provisioning (isolated PostgreSQL)', () => {
  const databaseName = `firebase_provisioning_${randomUUID().replaceAll('-', '')}`;
  const admin = new Client({ connectionString: testUrl });
  let fixture: Client;
  let database: typeof import('../../src/db.js').db;
  let ensureUser: typeof import('../../src/auth/ensure-user.js').ensureUserRowForFirebaseUid;
  let created = false;
  let oldDatabaseUrl: string | undefined;

  beforeAll(async () => {
    const parsed = new URL(testUrl!);
    if (!['localhost', '127.0.0.1'].includes(parsed.hostname) || parsed.port !== '55439') {
      throw new Error('Only isolated local PostgreSQL on port 55439 is allowed.');
    }
    await admin.connect();
    await admin.query(`CREATE DATABASE ${databaseName}`);
    created = true;
    const fixtureUrl = new URL(testUrl!);
    fixtureUrl.pathname = `/${databaseName}`;
    fixture = new Client({ connectionString: fixtureUrl.toString() });
    await fixture.connect();

    // Execute the actual canonical users definition and users-specific portions
    // of unrelated lifecycle migrations; no simplified TEXT substitute for
    // users.phone VARCHAR(20), which would hide this parameter-inference bug.
    const launchSchema = readFileSync('backend/database/launch-schema.sql', 'utf8');
    const usersSchema = /CREATE TABLE IF NOT EXISTS users \([\s\S]*?\n\);/.exec(launchSchema)?.[0];
    if (!usersSchema) throw new Error('Canonical users definition was not found.');
    await fixture.query(usersSchema);
    await fixture.query(migration('20260719_lifecycle_service_foundations').split('-- Region acceptance gates')[0]);
    await fixture.query(migration('20260719_tier0_browse_only_contract').split('ALTER TABLE capability_profiles')[0]);
    // These tables only satisfy foreign keys/ALTERs in the full identity migration.
    await fixture.query(`CREATE TABLE leads(id UUID PRIMARY KEY, email TEXT NOT NULL, phone TEXT, user_id UUID);
      CREATE TABLE task_drafts(id UUID PRIMARY KEY);
      CREATE TABLE sms_outbox(id UUID PRIMARY KEY, user_id UUID NOT NULL, idempotency_key TEXT);`);
    await fixture.query(migration('20261002_phone_draft_claims'));
    await fixture.query(migration('20261004_verified_phone_identity'));
    oldDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = fixtureUrl.toString();
    database = (await import('../../src/db.js')).db;
    ensureUser = (await import('../../src/auth/ensure-user.js')).ensureUserRowForFirebaseUid;
  }, 30_000);

  beforeEach(() => { getFirebaseUserRecord.mockReset(); });

  afterAll(async () => {
    if (database) await database.close();
    if (fixture) await fixture.end();
    if (created) await admin.query(`DROP DATABASE ${databaseName} WITH (FORCE)`);
    await admin.end();
    if (oldDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = oldDatabaseUrl;
  }, 30_000);

  it('inserts a new email-only user with incomplete onboarding and active account defaults', async () => {
    getFirebaseUserRecord.mockResolvedValue({ email: '  New.Email@Example.test  ', displayName: 'New Email' });
    const user = await ensureUser('pg-new-email');
    expect(user).toMatchObject({ firebase_uid: 'pg-new-email', email: 'new.email@example.test', phone: null,
      phone_verified_at: null, full_name: 'New Email', default_mode: 'worker', trust_tier: 0,
      account_status: 'ACTIVE', onboarding_completed_at: null, is_minor: true });
    expect((await fixture.query('SELECT id FROM users WHERE firebase_uid=$1', ['pg-new-email'])).rows).toHaveLength(1);
  });

  it('inserts a new verified phone-only user without a synthetic email', async () => {
    getFirebaseUserRecord.mockResolvedValue({ phoneNumber: '+12065550123' });
    const user = await ensureUser('pg-new-phone');
    expect(user).toMatchObject({ firebase_uid: 'pg-new-phone', email: null, phone: '+12065550123',
      full_name: 'HustleXP customer', default_mode: 'poster', trust_tier: 1,
      account_status: 'ACTIVE', onboarding_completed_at: null, is_minor: true });
    expect(user?.phone_verified_at).toBeInstanceOf(Date);
  });

  it.each(['google.com', 'apple.com'])('accepts trusted email identities from %s', async (providerId) => {
    const uid = `pg-${providerId}`;
    getFirebaseUserRecord.mockResolvedValue({ email: `${providerId}@example.test`, providerData: [{ providerId }] });
    expect(await ensureUser(uid)).toMatchObject({ firebase_uid: uid, email: `${providerId}@example.test`, phone: null });
  });

  it('stores both trusted email and verified phone consistently', async () => {
    getFirebaseUserRecord.mockResolvedValue({ email: 'both@example.test', phoneNumber: '+12065550124' });
    const user = await ensureUser('pg-both');
    expect(user).toMatchObject({ email: 'both@example.test', phone: '+12065550124', trust_tier: 1 });
    expect(user?.phone_verified_at).toBeInstanceOf(Date);
  });

  it('reuses an existing Firebase UID without resetting account or onboarding status', async () => {
    const id = randomUUID();
    await fixture.query(`INSERT INTO users(id,firebase_uid,email,full_name,account_status,onboarding_completed_at)
      VALUES($1,'pg-existing','existing@example.test','Existing User','SUSPENDED',NOW())`, [id]);
    getFirebaseUserRecord.mockResolvedValue({ email: 'existing@example.test', displayName: 'Changed Firebase Name' });
    const user = await ensureUser('pg-existing');
    expect(user).toMatchObject({ id, full_name: 'Existing User', account_status: 'SUSPENDED' });
    expect(user?.onboarding_completed_at).toBeInstanceOf(Date);
    expect((await fixture.query('SELECT id FROM users WHERE firebase_uid=$1', ['pg-existing'])).rows).toHaveLength(1);
  });

  it('rejects a verified phone collision without creating or taking over a user', async () => {
    await fixture.query(`INSERT INTO users(firebase_uid,email,phone,phone_verified_at,full_name)
      VALUES('pg-phone-owner',NULL,'+12065550125',NOW(),'Phone Owner')`);
    getFirebaseUserRecord.mockResolvedValue({ phoneNumber: '+12065550125' });
    await expect(ensureUser('pg-phone-intruder')).rejects.toMatchObject({ applicationCode: 'PHONE_ALREADY_LINKED' });
    expect((await fixture.query('SELECT firebase_uid FROM users WHERE phone=$1', ['+12065550125'])).rows)
      .toEqual([{ firebase_uid: 'pg-phone-owner' }]);
    expect((await fixture.query('SELECT id FROM users WHERE firebase_uid=$1', ['pg-phone-intruder'])).rows).toHaveLength(0);
  });

  it('keeps incompatible email identity collisions fail-closed under the unique constraint', async () => {
    await fixture.query(`INSERT INTO users(firebase_uid,email,full_name)
      VALUES('pg-email-owner','owned@example.test','Email Owner')`);
    getFirebaseUserRecord.mockResolvedValue({ email: 'owned@example.test' });
    expect(await ensureUser('pg-email-intruder')).toBeNull();
    expect((await fixture.query('SELECT firebase_uid FROM users WHERE email=$1', ['owned@example.test'])).rows)
      .toEqual([{ firebase_uid: 'pg-email-owner' }]);
    expect((await fixture.query('SELECT id FROM users WHERE firebase_uid=$1', ['pg-email-intruder'])).rows).toHaveLength(0);
  });

  it('keeps the migrated at-least-one-identity check active', async () => {
    await expect(fixture.query(`INSERT INTO users(firebase_uid,full_name) VALUES('pg-no-identity','No Identity')`))
      .rejects.toMatchObject({ code: '23514', constraint: 'users_verified_identity_chk' });
  });

  it('serializes concurrent provisioning of the same verified Firebase identity', async () => {
    getFirebaseUserRecord.mockResolvedValue({ phoneNumber: '+12065550126' });
    const [first, replay] = await Promise.all([ensureUser('pg-racing-phone'), ensureUser('pg-racing-phone')]);
    expect(first).not.toBeNull();
    expect(replay?.id).toBe(first?.id);
    expect((await fixture.query('SELECT id FROM users WHERE firebase_uid=$1', ['pg-racing-phone'])).rows).toHaveLength(1);
  });

  it.each([
    { kind: 'email', email: 'registration@example.test', phone: null, mode: 'worker', tier: 0 },
    { kind: 'phone', email: null, phone: '+12065550127', mode: 'poster', tier: 1 },
  ])('keeps the direct user.register $kind INSERT compatible with the same migrated schema', async ({ kind, email, phone, mode, tier }) => {
    // This is a SQL/schema contract test, not a mock of registration authority:
    // execute the router's actual INSERT to catch the same inference regression
    // on the non-lazy path. Router authorization is covered in its unit suite.
    const source = readFileSync('backend/src/routers/user.ts', 'utf8');
    const insert = /`(INSERT INTO users \([\s\S]+?RETURNING \*)`/.exec(source)?.[1];
    if (!insert) throw new Error('user.register INSERT was not found.');
    const result = await fixture.query(insert, [`pg-register-${kind}`, email, phone, 'Registration Fixture', mode, '1990-01-01', false, tier]);
    expect(result.rows[0]).toMatchObject({ email, phone, default_mode: mode, trust_tier: tier });
    expect(result.rows[0].onboarding_completed_at).toBeInstanceOf(Date);
    expect(Boolean(result.rows[0].phone_verified_at)).toBe(Boolean(phone));
  });
});
