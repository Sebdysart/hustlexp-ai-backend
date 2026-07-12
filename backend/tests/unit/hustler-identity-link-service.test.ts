import { beforeEach, describe, expect, it, vi } from 'vitest';

const { query, serializableTransaction } = vi.hoisted(() => {
  const hoistedQuery = vi.fn();
  return {
    query: hoistedQuery,
    serializableTransaction: vi.fn(async (fn: (q: typeof hoistedQuery) => Promise<unknown>) => fn(hoistedQuery)),
  };
});

vi.mock('../../src/db.js', () => ({ db: { serializableTransaction } }));

import { HustlerIdentityLinkService } from '../../src/services/HustlerIdentityLinkService.js';

const input = {
  engineHustlerRef: '11111111-1111-4111-8111-111111111111',
  phoneE164: '+14255550123',
  providerClaimId: '22222222-2222-4222-8222-222222222222',
};

const user = {
  id: input.engineHustlerRef, default_mode: 'worker', phone: null,
  trust_tier: 0, is_banned: false, account_status: 'ACTIVE',
};

beforeEach(() => {
  query.mockReset();
  serializableTransaction.mockClear();
});

describe('HustlerIdentityLinkService', () => {
  it('fails closed when the authenticated engine user no longer exists', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await expect(HustlerIdentityLinkService.link(input)).resolves.toMatchObject({
      success: false, error: { code: 'NOT_FOUND' },
    });
  });

  it('atomically links the verified phone and raises only the outdoor trust floor', async () => {
    query
      .mockResolvedValueOnce({ rows: [user] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(HustlerIdentityLinkService.link(input)).resolves.toEqual({
      success: true,
      data: { engineHustlerRef: input.engineHustlerRef, trustTier: 1, idempotencyReplayed: false },
    });
    expect(serializableTransaction).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE users SET phone = $1, trust_tier = $2'),
      [input.phoneE164, 1, input.engineHustlerRef],
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO engine_hustler_identity_links'),
      [input.providerClaimId, input.engineHustlerRef, expect.stringMatching(/^[0-9a-f]{64}$/)],
    );
  });

  it('replays only the same claim, user and phone evidence', async () => {
    const hash = '6dee31cf75946e409817e979fe66f9260b44eb804f3c6acc1cff462048efa4b6';
    query
      .mockResolvedValueOnce({ rows: [{ ...user, trust_tier: 2 }] })
      .mockResolvedValueOnce({ rows: [{ user_id: input.engineHustlerRef, phone_hash: hash }] });
    await expect(HustlerIdentityLinkService.link(input)).resolves.toEqual({
      success: true,
      data: { engineHustlerRef: input.engineHustlerRef, trustTier: 2, idempotencyReplayed: true },
    });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it.each([
    [{ ...user, default_mode: 'poster' }, 'PRECONDITION_FAILED'],
    [{ ...user, is_banned: true }, 'PRECONDITION_FAILED'],
    [{ ...user, account_status: 'SUSPENDED' }, 'PRECONDITION_FAILED'],
  ])('fails closed for an ineligible engine identity %#', async (row, code) => {
    query.mockResolvedValueOnce({ rows: [row] });
    await expect(HustlerIdentityLinkService.link(input)).resolves.toMatchObject({
      success: false, error: { code },
    });
  });

  it('rejects a phone collision before changing the canonical user', async () => {
    query
      .mockResolvedValueOnce({ rows: [user] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'other' }] });
    await expect(HustlerIdentityLinkService.link(input)).resolves.toMatchObject({
      success: false, error: { code: 'IDENTITY_CONFLICT' },
    });
    expect(query).not.toHaveBeenCalledWith(expect.stringContaining('UPDATE users'), expect.anything());
  });

  it('rejects a roster-phone collision even when the users table has no raw-phone match', async () => {
    query
      .mockResolvedValueOnce({ rows: [user] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ user_id: 'other' }] });
    await expect(HustlerIdentityLinkService.link(input)).resolves.toMatchObject({
      success: false, error: { code: 'IDENTITY_CONFLICT' },
    });
    expect(query).not.toHaveBeenCalledWith(expect.stringContaining('UPDATE users'), expect.anything());
  });

  it('turns database failures into a retry-safe service error', async () => {
    serializableTransaction.mockRejectedValueOnce(new Error('offline'));
    await expect(HustlerIdentityLinkService.link(input)).resolves.toEqual({
      success: false, error: { code: 'DB_ERROR', message: 'Identity link could not be persisted' },
    });
  });
});
