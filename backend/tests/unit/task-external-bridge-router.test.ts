import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const lifecycleMocks = vi.hoisted(() => ({ notifyApplicationReceived: vi.fn() }));

vi.mock('../../src/lib/task-lifecycle-notifications', () => ({
  notifyApplicationReceived: lifecycleMocks.notifyApplicationReceived,
}));

vi.mock('../../src/db', () => {
  const query = vi.fn();
  return {
    db: {
      query,
      transaction: vi.fn((fn: (queryFn: typeof query) => Promise<unknown>) => fn(query)),
    },
  };
});

import { db } from '../../src/db.js';
import { taskExternalBridgeRouter } from '../../src/routers/taskExternalBridge.js';

const mockDb = vi.mocked(db);
const TASK_ID = '11111111-1111-4111-8111-111111111111';
const POSTER_ID = '22222222-2222-4222-8222-222222222222';
const WORKER_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_WORKER_ID = '77777777-7777-4777-8777-777777777777';
const LINK_ID = '44444444-4444-4444-8444-444444444444';
const APPLICATION_ID = '55555555-5555-4555-8555-555555555555';
const OFFER_ID = '66666666-6666-4666-8666-666666666666';
const TOKEN = 'f'.repeat(64);
const SCOPE_HASH = 'a'.repeat(64);
const productionIdentity = {
  identity_verification_status: 'VERIFIED',
  identity_verification_environment: 'PRODUCTION',
  identity_verification_expires_at: '2099-01-01T00:00:00.000Z',
};

const task = {
  task_id: TASK_ID,
  link_id: LINK_ID,
  source_channel: 'nextdoor',
  link_kind: 'OPEN_SHARE',
  claimed_by_user_id: null,
  state: 'OPEN',
  poster_id: POSTER_ID,
  title: 'Move a couch',
  description: 'Move one couch down one flight of stairs.',
  category: 'moving',
  scope_hash: SCOPE_HASH,
  hustler_payout_cents: 8000,
  estimated_duration_minutes: 90,
  rough_location: 'Bellevue area',
  deadline: '2099-07-20T20:00:00.000Z',
  requirements: 'Bring a hand truck',
  risk_level: 'MEDIUM',
  required_tools: ['hand truck'],
  cancellation_policy_version: 'cancel-v1',
  late_cancel_pct: 25,
  cancellation_window_hours: 24,
  trust_tier_required: 2,
  payout_cents: 8000,
  expires_at: '2099-07-20T20:00:00.000Z',
  revoked_at: null,
};

function user(id: string, mode: 'poster' | 'worker') {
  return {
    id,
    email: `${mode}@example.com`,
    full_name: mode,
    firebase_uid: `${mode}-firebase`,
    default_mode: mode,
    trust_tier: mode === 'worker' ? 2 : 1,
    is_minor: false,
    is_banned: false,
    account_status: 'ACTIVE',
    is_admin: false,
  };
}

function posterCaller() {
  return taskExternalBridgeRouter.createCaller({ user: user(POSTER_ID, 'poster') } as any);
}

function workerCaller() {
  return taskExternalBridgeRouter.createCaller({ user: user(WORKER_ID, 'worker') } as any);
}

function publicCaller() {
  return taskExternalBridgeRouter.createCaller({ user: null } as any);
}

function row(value: unknown, count = 1) {
  return { rows: count ? [value] : [], rowCount: count } as any;
}

describe('external task bridge router', () => {
  beforeEach(() => vi.resetAllMocks());

  it('lets only the task Poster rotate a hash-only share capability', async () => {
    mockDb.query
      .mockResolvedValueOnce(row(task))
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any)
      .mockResolvedValueOnce(row({ id: LINK_ID, expires_at: task.expires_at }))
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

    const result = await posterCaller().createShareLink({ taskId: TASK_ID, sourceChannel: 'nextdoor', expiresInHours: 72 });
    expect(result.path).toMatch(/^\/work\/[a-f0-9]{64}$/);
    expect(result.postCopy).toContain('Scope, payout, and timing');
    const insert = mockDb.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO task_external_share_links'))!;
    expect(insert[1]?.[2]).toMatch(/^[a-f0-9]{64}$/);
    expect(result.path).not.toContain(String(insert[1]?.[2]));
    expect(mockDb.query.mock.calls[1][0]).toContain('SET revoked_at = NOW()');
  });

  it('returns a privacy-safe public card with no task, poster, or exact-address identifier', async () => {
    mockDb.query.mockResolvedValueOnce(row(task));
    const card = await publicCaller().getShareCard({ token: TOKEN });
    expect(card).toMatchObject({ title: task.title, area: task.rough_location, entryKind: 'OPEN_SHARE', exactAddressProtected: true });
    expect(card).not.toHaveProperty('taskId');
    expect(card).not.toHaveProperty('posterId');
    expect(card).not.toHaveProperty('location');
    const sql = String(mockDb.query.mock.calls[0][0]);
    expect(sql).not.toMatch(/t\.location(?:\s|,)/);
    expect(sql).not.toMatch(/location_lat|location_lng|full_name|email|phone/);
  });

  it('creates a distinct one-claim direct provider invitation without contact data', async () => {
    mockDb.query
      .mockResolvedValueOnce(row(task))
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any)
      .mockResolvedValueOnce(row({ id: LINK_ID, expires_at: task.expires_at }))
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

    const result = await posterCaller().createDirectInvite({ taskId: TASK_ID, sourceChannel: 'text', expiresInHours: 72 });
    expect(result.path).toMatch(/^\/work\/[a-f0-9]{64}$/);
    expect(result.inviteCopy).toContain('private HustleXP link');
    expect(result.inviteCopy).not.toMatch(/email|phone|address/i);
    const sql = mockDb.query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain("'DIRECT_INVITE'");
    expect(sql).toContain("'DIRECT_INVITE_CREATED'");
  });

  it('collapses a claimed direct invitation for anonymous or different viewers', async () => {
    const claimed = { ...task, link_kind: 'DIRECT_INVITE', claimed_by_user_id: WORKER_ID };
    mockDb.query.mockResolvedValueOnce(row(claimed));
    await expect(publicCaller().getShareCard({ token: TOKEN })).rejects.toMatchObject({ code: 'NOT_FOUND' });

    mockDb.query
      .mockResolvedValueOnce(row(claimed))
      .mockResolvedValueOnce(row({ id: OTHER_WORKER_ID, trust_tier: 2, trust_hold: false, is_verified: true, ...productionIdentity }));
    const otherCaller = taskExternalBridgeRouter.createCaller({ user: user(OTHER_WORKER_ID, 'worker') } as any);
    const candidate = await otherCaller.getCandidateOffer({ token: TOKEN });
    expect(candidate.eligibility.blockers).toContain('direct_invite_claimed');
  });

  it('exposes current eligibility without submitting or accepting work', async () => {
    mockDb.query
      .mockResolvedValueOnce(row(task))
      .mockResolvedValueOnce(row({ id: WORKER_ID, trust_tier: 2, trust_hold: false, is_verified: true, ...productionIdentity }));
    const result = await workerCaller().getCandidateOffer({ token: TOKEN });
    expect(result.eligibility).toEqual({ eligible: true, blockers: [], message: null });
    expect(mockDb.query.mock.calls.every(([sql]) => !/INSERT|UPDATE|DELETE/i.test(String(sql)))).toBe(true);
  });

  it('blocks an unverified external provider before an application exists', async () => {
    mockDb.query
      .mockResolvedValueOnce(row(task))
      .mockResolvedValueOnce(row({ id: WORKER_ID, trust_tier: 2, trust_hold: false, is_verified: false }));
    const result = await workerCaller().getCandidateOffer({ token: TOKEN });
    expect(result.eligibility.eligible).toBe(false);
    expect(result.eligibility.blockers).toContain('identity_verification_required');
  });

  it('submits one immutable structured offer into the canonical application workflow', async () => {
    mockDb.query
      .mockResolvedValueOnce(row(task))
      .mockResolvedValueOnce(row({ id: WORKER_ID, trust_tier: 2, trust_hold: false, is_verified: true, ...productionIdentity }))
      .mockResolvedValueOnce(row({ id: APPLICATION_ID }))
      .mockResolvedValueOnce(row({ id: OFFER_ID, created_at: '2099-07-20T16:00:00.000Z' }))
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);
    const result = await workerCaller().submitExternalOffer({
      token: TOKEN,
      availableFrom: '2099-07-20T17:00:00.000Z',
      availableUntil: '2099-07-20T19:00:00.000Z',
      message: 'I can bring a hand truck and arrive at 5 PM.',
      acknowledgedScopeHash: SCOPE_HASH,
      acknowledgedPayoutCents: 8000,
    });
    expect(result).toMatchObject({ offerId: OFFER_ID, status: 'SUBMITTED', submissionKind: 'OPEN_OFFER' });
    const sql = mockDb.query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain('INSERT INTO task_applications');
    expect(sql).toContain('INSERT INTO task_external_offers');
    expect(mockDb.query.mock.calls.some(([statement, values]) =>
      String(statement).includes('INSERT INTO task_external_bridge_events') && values?.includes('OFFER_SUBMITTED')
    )).toBe(true);
    expect(sql).not.toMatch(/UPDATE tasks SET state|worker_id\s*=/i);
    expect(lifecycleMocks.notifyApplicationReceived).toHaveBeenCalledWith(POSTER_ID, TASK_ID, task.title);
  });

  it('binds a direct invitation to one verified Hustler and records scope acceptance without assigning', async () => {
    const direct = { ...task, source_channel: 'text', link_kind: 'DIRECT_INVITE', claimed_by_user_id: null };
    mockDb.query
      .mockResolvedValueOnce(row(direct))
      .mockResolvedValueOnce(row({ id: WORKER_ID, trust_tier: 2, trust_hold: false, is_verified: true, ...productionIdentity }))
      .mockResolvedValueOnce(row({ claimed_by_user_id: WORKER_ID }))
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any)
      .mockResolvedValueOnce(row({ id: APPLICATION_ID }))
      .mockResolvedValueOnce(row({ id: OFFER_ID, created_at: '2099-07-20T16:00:00.000Z' }))
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);
    const result = await workerCaller().submitExternalOffer({
      token: TOKEN,
      availableFrom: '2099-07-20T17:00:00.000Z',
      availableUntil: '2099-07-20T19:00:00.000Z',
      message: 'I accept the displayed scope and can arrive at 5 PM.',
      acknowledgedScopeHash: SCOPE_HASH,
      acknowledgedPayoutCents: 8000,
    });
    expect(result.submissionKind).toBe('DIRECT_ACCEPTANCE');
    const sql = mockDb.query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain('INSERT INTO task_direct_invite_claims');
    expect(sql).toContain("'DIRECT_INVITE_CLAIMED'");
    expect(sql).toContain("'DIRECT_ACCEPTANCE'");
    expect(mockDb.query.mock.calls.some(([statement, values]) =>
      String(statement).includes('INSERT INTO task_external_bridge_events') && values?.includes('SCOPE_ACCEPTED')
    )).toBe(true);
    expect(sql).not.toMatch(/UPDATE tasks SET state|worker_id\s*=/i);
  });

  it('rejects the losing concurrent direct-invite claimant before creating an application', async () => {
    const direct = { ...task, source_channel: 'text', link_kind: 'DIRECT_INVITE', claimed_by_user_id: null };
    mockDb.query
      .mockResolvedValueOnce(row(direct))
      .mockResolvedValueOnce(row({ id: WORKER_ID, trust_tier: 2, trust_hold: false, is_verified: true, ...productionIdentity }))
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
      .mockResolvedValueOnce(row({ claimed_by_user_id: OTHER_WORKER_ID }));
    await expect(workerCaller().submitExternalOffer({
      token: TOKEN,
      availableFrom: '2099-07-20T17:00:00.000Z',
      availableUntil: '2099-07-20T19:00:00.000Z',
      message: 'I accept the scope.',
      acknowledgedScopeHash: SCOPE_HASH,
      acknowledgedPayoutCents: 8000,
    })).rejects.toMatchObject({ code: 'CONFLICT' });
    const sql = mockDb.query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain('ON CONFLICT (share_link_id) DO NOTHING');
    expect(sql).not.toContain('INSERT INTO task_applications');
  });

  it('rejects scope or payout tampering before writing an application', async () => {
    mockDb.query
      .mockResolvedValueOnce(row(task))
      .mockResolvedValueOnce(row({ id: WORKER_ID, trust_tier: 2, trust_hold: false, is_verified: true, ...productionIdentity }));
    await expect(workerCaller().submitExternalOffer({
      token: TOKEN,
      availableFrom: '2099-07-20T17:00:00.000Z',
      availableUntil: '2099-07-20T19:00:00.000Z',
      message: 'Available.',
      acknowledgedScopeHash: 'b'.repeat(64),
      acknowledgedPayoutCents: 8000,
    })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(mockDb.query).toHaveBeenCalledTimes(2);
  });

  it('collapses expired, revoked, and stale capability states to NOT_FOUND', async () => {
    for (const override of [
      { expires_at: '2020-01-01T00:00:00.000Z' },
      { revoked_at: '2099-01-01T00:00:00.000Z' },
      { payout_cents: 7999 },
    ]) {
      mockDb.query.mockResolvedValueOnce(row({ ...task, ...override }));
      await expect(publicCaller().getShareCard({ token: TOKEN })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
  });
});

describe('external task bridge migration contract', () => {
  const sql = readFileSync(
    resolve(process.cwd(), 'backend/database/migrations/20260719_external_task_bridge_contract.sql'),
    'utf8',
  );

  it('stores only a hash capability and makes attribution events append-only', () => {
    expect(sql).toContain('token_hash CHAR(64) NOT NULL UNIQUE');
    expect(sql).not.toMatch(/raw_token|token_plain|share_token\s/);
    expect(sql).toContain('task_external_bridge_events is append-only');
    expect(sql).toContain('BEFORE UPDATE OR DELETE ON task_external_bridge_events');
    expect(sql).toContain('task_direct_invite_claims is append-only');
    expect(sql).toContain("link_kind IN ('OPEN_SHARE','DIRECT_INVITE')");
    expect(sql).toContain("offer_kind IN ('OPEN_OFFER','DIRECT_ACCEPTANCE')");
  });

  it('rechecks provider and task truth when the Poster selects an external offer', () => {
    for (const guard of [
      'NOT v_user.is_verified', 'v_user.trust_hold', 'v_user.trust_tier < v_required_tier',
      'v_link.scope_hash IS DISTINCT FROM v_task.scope_hash',
      'v_link.payout_cents IS DISTINCT FROM v_task.hustler_payout_cents',
      "v_offer.offer_kind = 'DIRECT_ACCEPTANCE'",
      'v_claim.claimed_by_user_id IS DISTINCT FROM v_offer.hustler_id',
    ]) expect(sql).toContain(guard);
    expect(sql).not.toContain('v_link.revoked_at IS NOT NULL');
    expect(sql).not.toContain('v_link.expires_at <= NOW()');
  });

  it('records canonical application selection and on-platform task completion', () => {
    expect(sql).toContain('AFTER UPDATE OF status ON task_applications');
    expect(sql).toContain("'OFFER_SELECTED'");
    expect(sql).toContain('AFTER UPDATE OF state ON tasks');
    expect(sql).toContain("'TASK_COMPLETED'");
    expect(sql).toContain("NEW.state = 'COMPLETED'");
  });
});
