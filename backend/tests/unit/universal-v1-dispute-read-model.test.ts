import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../src/db', () => ({ db: { query: mocks.query } }));

import {
  getUniversalV1DisputeForOperator,
  getUniversalV1DisputeForParticipant,
  listUniversalV1DisputesForParticipant,
} from '../../src/services/UniversalV1DisputeReadModel.js';

const ACTOR_ID = '11111111-1111-4111-8111-111111111111';
const DISPUTE_ID = '22222222-2222-4222-8222-222222222222';

function context(overrides: Record<string, unknown> = {}) {
  return {
    user: {
      id: ACTOR_ID,
      email: 'participant@example.test',
      full_name: 'Named participant',
      default_mode: 'poster',
      account_status: 'ACTIVE',
      is_banned: false,
      is_minor: false,
      ...overrides,
    },
    firebaseUid: 'firebase-participant',
    ip: '127.0.0.1',
  } as any;
}

function operatorContext() {
  const now = Math.floor(Date.now() / 1000);
  return {
    ...context({ default_mode: 'poster' }),
    identityAssurance: {
      authenticatedAtSeconds: now - 30,
      tokenExpiresAtSeconds: now + 3_600,
      signInProvider: 'password',
      secondFactor: 'phone',
      mfaVerified: true,
    },
  } as any;
}

beforeEach(() => vi.clearAllMocks());

describe('UniversalV1DisputeReadModel participant authority', () => {
  it.each([
    ['pending/paused account', { account_status: 'PAUSED' }],
    ['suspended account', { account_status: 'SUSPENDED' }],
    ['minor account', { is_minor: true }],
    ['unknown adult status', { is_minor: undefined }],
    ['banned account', { is_banned: true }],
  ])('rejects a %s before any read', async (_label, overrides) => {
    await expect(listUniversalV1DisputesForParticipant(
      context(overrides), 20, 0,
    )).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('rechecks an active adult database row and current exact participant relation for set reads', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await expect(listUniversalV1DisputesForParticipant(
      context(), 20, 0,
    )).resolves.toEqual([]);

    const [sql, params] = mocks.query.mock.calls[0];
    expect(String(sql)).toContain("viewer.account_status = 'ACTIVE'");
    expect(String(sql)).toContain('viewer.is_minor IS FALSE');
    expect(String(sql)).toContain('COALESCE(viewer.is_banned, FALSE) IS FALSE');
    expect(String(sql)).toContain("membership.status = 'ACTIVE'");
    expect(String(sql)).toContain("membership.role IN ('OWNER', 'ADMIN', 'DISPATCHER', 'CREW')");
    expect(params).toEqual([ACTOR_ID, 20, 0]);
  });

  it('uses the database participant assertion for one-dispute reads and redacts stale membership as not found', async () => {
    mocks.query.mockRejectedValueOnce(
      new Error('HXUDR1: actor is not exactly one current customer/provider participant'),
    );

    await expect(getUniversalV1DisputeForParticipant(
      context(), DISPUTE_ID,
    )).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const [sql, params] = mocks.query.mock.calls[0];
    expect(String(sql)).toContain('assert_universal_v1_dispute_participant_v1');
    expect(params).toEqual([DISPUTE_ID, ACTOR_ID]);
  });

  it('rechecks current operator authority inside the same statement as operator-only detail', async () => {
    mocks.query.mockRejectedValueOnce(
      new Error('HXUDR7: current named dispute operator authority is required'),
    );

    await expect(getUniversalV1DisputeForOperator(
      operatorContext(), DISPUTE_ID,
    )).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(mocks.query).toHaveBeenCalledOnce();
    const [sql, params] = mocks.query.mock.calls[0];
    expect(String(sql)).toContain('assert_universal_v1_dispute_operator_v1($2)');
    expect(String(sql)).toContain('operator_timeline');
    expect(params).toEqual([DISPUTE_ID, ACTOR_ID]);
  });
});
