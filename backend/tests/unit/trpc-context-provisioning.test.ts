import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '../../src/types.js';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(),
  verify: vi.fn(),
  firebaseUser: vi.fn(),
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/db.js', () => ({ db: { query: mocks.query, transaction: mocks.transaction } }));
vi.mock('../../src/auth/firebase.js', () => ({
  firebaseAuth: { verifyIdToken: mocks.verify },
  getFirebaseUserRecord: mocks.firebaseUser,
}));
vi.mock('../../src/auth-cache.js', () => ({
  authCache: { delete: vi.fn() },
  authCacheKey: (token: string) => token,
  authCacheGet: mocks.cacheGet,
  authCacheSet: mocks.cacheSet,
  invalidateAuthCacheForUser: vi.fn(),
}));
vi.mock('../../src/cache/redis.js', () => ({ redis: { get: vi.fn() } }));
vi.mock('../../src/auth/local-certification-token.js', () => ({ verifyLocalCertificationToken: () => null }));
vi.mock('../../src/logger.js', () => ({
  logger: { ...mocks.log, child: () => mocks.log },
  escrowLogger: mocks.log,
}));
vi.mock('../../src/services/XPService.js', () => ({ XPService: {} }));
vi.mock('../../src/services/EarnedVerificationUnlockService.js', () => ({ EarnedVerificationUnlockService: {} }));
vi.mock('../../src/services/StreakService.js', () => ({ getStreakStatus: vi.fn() }));
vi.mock('../../src/cache/db-cache.js', () => ({
  cachedDbQuery: vi.fn(), invalidateUser: vi.fn(), CACHE_KEYS: {}, CACHE_TTL: {}, CACHE_TAGS: {},
}));

// Keep all three authentication layers real: context -> lazy provisioner ->
// protected user.me. Only Firebase, cache, and database transport are mocked.
import { createContext } from '../../src/trpc-context.js';
import { userRouter } from '../../src/routers/user.js';

type StoredUser = User & { phone_verified_at: Date | null; contact_phone: string | null };
type FirebaseIdentity = { email?: string; phoneNumber?: string; displayName?: string; providerData?: { providerId: string }[] };

const UID = 'firebase-new-customer';
const TOKEN = 'verified-firebase-token';
const PHONE = '+12065550123';
const NOW = new Date('2026-09-22T12:00:00Z');
let users: StoredUser[];
let records: Map<string, FirebaseIdentity>;
let insertFailure: Error | null;

function storedUser(overrides: Partial<StoredUser> = {}): StoredUser {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    firebase_uid: UID,
    email: 'existing@example.com',
    full_name: 'Existing Customer',
    phone: null,
    phone_verified_at: null,
    contact_phone: null,
    default_mode: 'poster',
    role_was_overridden: false,
    trust_tier: 0,
    trust_hold: false,
    xp_total: 0,
    current_level: 1,
    current_streak: 0,
    is_verified: false,
    is_banned: false,
    student_id_verified: false,
    plan: 'free',
    live_mode_state: 'OFF',
    live_mode_total_tasks: 0,
    daily_active_minutes: 0,
    consecutive_active_days: 0,
    account_status: 'ACTIVE',
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function rows<T>(items: T[]) { return { rows: items, rowCount: items.length }; }

function request() {
  return createContext({
    req: new Request('https://api.hustlexp.test/trpc/user.me', { headers: { authorization: `Bearer ${TOKEN}` } }),
    resHeaders: new Headers(),
  });
}

function inserts() {
  return mocks.query.mock.calls.filter(([sql]) => /^\s*INSERT INTO users\b/.test(String(sql)));
}

beforeEach(() => {
  vi.resetAllMocks();
  users = [];
  records = new Map();
  insertFailure = null;
  mocks.cacheGet.mockReturnValue(null);
  mocks.verify.mockResolvedValue({ uid: UID, exp: Math.floor(Date.now() / 1000) + 300 });
  mocks.firebaseUser.mockImplementation(async (uid: string) => {
    const record = records.get(uid);
    if (!record) throw new Error('Firebase user record not found');
    return record;
  });
  mocks.transaction.mockImplementation(async (action: (query: typeof mocks.query) => Promise<unknown>) => {
    const before = users.map((user) => ({ ...user }));
    try { return await action(mocks.query); } catch (error) { users = before; throw error; }
  });
  mocks.query.mockImplementation(async (sql: string, parameters: unknown[] = []) => {
    const compact = sql.replace(/\s+/g, ' ').trim();
    if (compact.startsWith('SELECT * FROM users WHERE firebase_uid =')) {
      return rows(users.filter((user) => user.firebase_uid === parameters[0]));
    }
    if (compact.startsWith('SELECT pg_advisory_xact_lock')) return rows([]);
    if (compact.startsWith('SELECT id, firebase_uid, phone_verified_at, email FROM users WHERE phone =')) {
      return rows(users.filter((user) => user.phone === parameters[0]));
    }
    if (compact.startsWith('INSERT INTO users')) {
      if (insertFailure) throw insertFailure;
      const [uid, email, phone, name, mode, dateOfBirth, trustTier] = parameters;
      if (users.some((user) => user.email === email && email !== null && user.firebase_uid !== uid)) {
        throw Object.assign(new Error('duplicate email'), { code: '23505', constraint: 'users_email_key' });
      }
      if (!email && !phone) throw Object.assign(new Error('identity required'), { code: '23514' });
      const user = storedUser({
        firebase_uid: uid as string,
        email: email as string | null,
        phone: phone as string | null,
        phone_verified_at: phone ? NOW : null,
        full_name: name as string,
        default_mode: mode as User['default_mode'],
        date_of_birth: dateOfBirth as string,
        is_minor: true,
        trust_tier: trustTier as number,
      });
      users.push(user);
      return rows([user]);
    }
    if (compact.includes('FROM admin_roles')) return rows([]);
    if (compact.includes('FROM task_ratings tr')) {
      return rows([{ avg_rating: null, total_ratings: '0', tasks_completed: '0', tasks_posted: '0', total_earnings: '0', total_spent: '0' }]);
    }
    throw new Error(`Unexpected query in auth regression test: ${compact}`);
  });
});

describe('verified Firebase session to lazy users row to protected user.me', () => {
  it.each(['password', 'google.com', 'apple.com'])('provisions a new %s email identity before user.me without requiring onboarding', async (providerId) => {
    records.set(UID, { email: ' New.Customer@Example.com ', displayName: 'New Customer', providerData: [{ providerId }] });

    const context = await request();
    expect(mocks.verify).toHaveBeenCalledWith(TOKEN, true);
    expect(context.firebaseUid).toBe(UID);
    expect(context.user).toMatchObject({ email: 'new.customer@example.com', phone: null, account_status: 'ACTIVE', is_minor: true });
    expect(mocks.firebaseUser).toHaveBeenCalledWith(UID);
    expect(inserts()).toHaveLength(1);
    expect(mocks.cacheSet).toHaveBeenCalledWith(TOKEN, expect.objectContaining({ firebaseUid: UID, user: context.user }), expect.any(Number));

    await expect(userRouter.createCaller(context).me()).resolves.toMatchObject({
      id: context.user!.id, email: 'new.customer@example.com', hasCompletedOnboarding: false, canAccessOps: false,
    });
  });

  it('provisions a new phone-only identity with verified phone and no synthetic email', async () => {
    records.set(UID, { phoneNumber: PHONE });
    const context = await request();
    expect(context.user).toMatchObject({ email: null, phone: PHONE, phone_verified_at: NOW, default_mode: 'poster', is_minor: true });
    expect(inserts()).toHaveLength(1);
    expect(inserts()[0][1]).toEqual([UID, null, PHONE, 'HustleXP customer', 'poster', '1990-01-01', 1]);
    await expect(userRouter.createCaller(context).me()).resolves.toMatchObject({ email: null, phone: PHONE, hasCompletedOnboarding: false });
  });

  it('preserves both trusted identity fields and uses Firebase Admin rather than caller contact input', async () => {
    records.set(UID, { email: 'both@example.com', phoneNumber: PHONE, displayName: 'Both Identities' });
    const context = await createContext({
      req: new Request('https://api.hustlexp.test/trpc/user.me?phone=%2B12065550999', {
        headers: { authorization: `Bearer ${TOKEN}`, 'x-phone-number': '+12065550999' },
      }),
      resHeaders: new Headers(),
    });
    expect(context.user).toMatchObject({ email: 'both@example.com', phone: PHONE, phone_verified_at: NOW });
    await expect(userRouter.createCaller(context).me()).resolves.toMatchObject({ email: 'both@example.com', phone: PHONE, hasCompletedOnboarding: false });
  });

  it('reuses an existing Firebase UID row without another insert or Firebase user-record fetch', async () => {
    users.push(storedUser({ onboarding_completed_at: NOW }));
    const context = await request();
    expect(context.user?.id).toBe(users[0].id);
    expect(inserts()).toHaveLength(0);
    expect(mocks.firebaseUser).not.toHaveBeenCalled();
    await expect(userRouter.createCaller(context).me()).resolves.toMatchObject({ hasCompletedOnboarding: true });
  });

  it('reuses the newly created domain identity on subsequent uncached requests', async () => {
    records.set(UID, { email: 'repeat@example.com' });
    const first = await request();
    const second = await request();
    expect(second.user?.id).toBe(first.user?.id);
    expect(users).toHaveLength(1);
    expect(inserts()).toHaveLength(1);
    expect(mocks.firebaseUser).toHaveBeenCalledTimes(1);
    await expect(userRouter.createCaller(second).me()).resolves.toMatchObject({ hasCompletedOnboarding: false });
  });

  it('rejects a verified-phone collision without creating or reassigning an internal identity', async () => {
    const owner = storedUser({ firebase_uid: 'other-firebase-user', phone: PHONE, phone_verified_at: NOW });
    users.push(owner);
    records.set(UID, { phoneNumber: PHONE });
    const context = await request();
    expect(context.user).toBeNull();
    expect(context.authErrorCode).toBe('PHONE_ALREADY_LINKED');
    expect(inserts()).toHaveLength(0);
    expect(users).toEqual([owner]);
    expect(mocks.cacheSet).not.toHaveBeenCalled();
    await expect(userRouter.createCaller(context).me()).rejects.toMatchObject({ code: 'UNAUTHORIZED', message: expect.stringContaining('already linked') });
  });

  it('fails closed on an email collision instead of merging incompatible Firebase UIDs', async () => {
    const owner = storedUser({ firebase_uid: 'other-firebase-user', email: 'shared@example.com' });
    users.push(owner);
    records.set(UID, { email: 'shared@example.com' });
    const context = await request();
    expect(context.user).toBeNull();
    expect(context.firebaseUid).toBe(UID);
    expect(users).toEqual([owner]);
    expect(mocks.cacheSet).not.toHaveBeenCalled();
    await expect(userRouter.createCaller(context).me()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('exposes the existing failure boundary: an insert exception leaves a verified UID but no domain user and user.me rejects', async () => {
    records.set(UID, { email: 'insert-failure@example.com' });
    insertFailure = Object.assign(new Error('could not determine data type of parameter $3'), { code: '42P08' });
    const context = await request();
    expect(mocks.verify).toHaveBeenCalledWith(TOKEN, true);
    expect(inserts()).toHaveLength(1);
    expect(context.firebaseUid).toBe(UID);
    expect(context.user).toBeNull();
    expect(users).toHaveLength(0);
    expect(mocks.log.warn).toHaveBeenCalledWith(expect.objectContaining({ err: insertFailure, firebaseUid: UID }), 'Lazy user provision failed');
    expect(mocks.cacheSet).not.toHaveBeenCalled();
    await expect(userRouter.createCaller(context).me()).rejects.toMatchObject({ code: 'UNAUTHORIZED', message: 'Authentication required' });
  });

  it.each([
    { label: 'suspended', state: { account_status: 'SUSPENDED' as const } },
    { label: 'deleted', state: { account_status: 'DELETED' as const } },
    { label: 'banned', state: { is_banned: true } },
  ])('preserves $label account rejection even when Firebase verifies', async ({ state }) => {
    users.push(storedUser(state));
    const context = await request();
    expect(context.user?.id).toBe(users[0].id);
    expect(inserts()).toHaveLength(0);
    expect(mocks.cacheSet).not.toHaveBeenCalled();
    await expect(userRouter.createCaller(context).me()).rejects.toMatchObject({ code: 'UNAUTHORIZED', message: 'Account suspended.' });
  });

  it('does not provision a Firebase-disabled identity whose token verification fails', async () => {
    mocks.verify.mockRejectedValue(Object.assign(new Error('Firebase user disabled'), { code: 'auth/user-disabled' }));
    const context = await request();
    expect(context.user).toBeNull();
    expect(context.firebaseUid).toBeNull();
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.firebaseUser).not.toHaveBeenCalled();
    expect(mocks.cacheSet).not.toHaveBeenCalled();
    await expect(userRouter.createCaller(context).me()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('cannot create a users row from a Firebase identity with neither email nor verified phone', async () => {
    records.set(UID, {});
    const context = await request();
    expect(context.user).toBeNull();
    expect(context.firebaseUid).toBe(UID);
    expect(inserts()).toHaveLength(0);
    expect(mocks.cacheSet).not.toHaveBeenCalled();
    await expect(userRouter.createCaller(context).me()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});
