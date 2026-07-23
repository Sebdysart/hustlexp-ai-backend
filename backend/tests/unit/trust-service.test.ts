/**
 * TrustService compatibility-facade tests.
 *
 * The facade may preserve its legacy call shape, but it must never preserve a
 * second promotion policy. All writes and eligibility decisions delegate to
 * the canonical TrustTierService evidence evaluator.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db', () => ({
  db: { query: vi.fn() },
}));

vi.mock('../../src/services/TrustTierService', () => ({
  TrustTier: {
    EXPLORER: 0,
    VERIFIED: 1,
    HOME_READY: 2,
    PRO: 3,
    LICENSED_SPECIALIST: 4,
    BANNED: 9,
  },
  TrustTierService: {
    applyPromotion: vi.fn(),
    evaluatePromotion: vi.fn(),
    getTrustTier: vi.fn(),
  },
}));

import { db } from '../../src/db';
import { TrustService } from '../../src/services/TrustService';
import { TrustTier, TrustTierService } from '../../src/services/TrustTierService';

const mockQuery = vi.mocked(db.query);
const mockTrustTier = vi.mocked(TrustTierService);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('TrustService.getLedger', () => {
  it('returns ledger evidence newest first', async () => {
    const entries = [
      { id: 'le2', user_id: 'u1', old_tier: 1, new_tier: 2 },
      { id: 'le1', user_id: 'u1', old_tier: 0, new_tier: 1 },
    ];
    mockQuery.mockResolvedValueOnce({ rows: entries } as never);

    await expect(TrustService.getLedger('u1')).resolves.toMatchObject({
      success: true,
      data: entries,
    });
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('ORDER BY changed_at DESC'),
      ['u1'],
    );
  });

  it('returns a database error without fabricating evidence', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection lost'));

    await expect(TrustService.getLedger('u1')).resolves.toMatchObject({
      success: false,
      error: { code: 'DB_ERROR', message: 'connection lost' },
    });
  });
});

describe('TrustService.getCurrentTier', () => {
  it('returns Explorer as a valid persisted tier', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 0 }] } as never);

    await expect(TrustService.getCurrentTier('u1')).resolves.toMatchObject({
      success: true,
      data: 0,
    });
  });

  it('returns NOT_FOUND for a missing user', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as never);

    await expect(TrustService.getCurrentTier('missing')).resolves.toMatchObject({
      success: false,
      error: { code: 'NOT_FOUND' },
    });
  });

  it('returns a database error on read failure', async () => {
    mockQuery.mockRejectedValueOnce(new Error('timeout'));

    await expect(TrustService.getCurrentTier('u1')).resolves.toMatchObject({
      success: false,
      error: { code: 'DB_ERROR', message: 'timeout' },
    });
  });
});

describe('TrustService.promote', () => {
  const baseParams = {
    userId: 'u1',
    newTier: 2,
    reason: 'legacy caller text cannot authorize promotion',
    changedBy: 'system',
  };

  it('delegates a system promotion to the canonical policy and returns the committed user', async () => {
    mockTrustTier.applyPromotion.mockResolvedValueOnce({ success: true });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'u1', trust_tier: 2 }] } as never);

    await expect(TrustService.promote(baseParams)).resolves.toMatchObject({
      success: true,
      data: { id: 'u1', trust_tier: 2 },
    });
    expect(mockTrustTier.applyPromotion).toHaveBeenCalledWith(
      'u1',
      TrustTier.HOME_READY,
      'system',
    );
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('maps non-system callers to the canonical admin audit source', async () => {
    mockTrustTier.applyPromotion.mockResolvedValueOnce({ success: true });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'u1', trust_tier: 1 }] } as never);

    await TrustService.promote({ ...baseParams, newTier: 1, changedBy: 'admin:reviewer' });

    expect(mockTrustTier.applyPromotion).toHaveBeenCalledWith(
      'u1',
      TrustTier.VERIFIED,
      'admin',
    );
  });

  it.each([0, 5, 9])('rejects unsupported promotion target %s before policy evaluation', async (newTier) => {
    await expect(TrustService.promote({ ...baseParams, newTier })).resolves.toMatchObject({
      success: false,
      error: { code: 'INVALID_TIER' },
    });
    expect(mockTrustTier.applyPromotion).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('cannot bypass failed evidence with caller-supplied reason text or task IDs', async () => {
    mockTrustTier.applyPromotion.mockRejectedValueOnce(
      new Error('Promotion preconditions not met: Current production enhanced screening required'),
    );

    await expect(TrustService.promote({
      ...baseParams,
      reason: 'Completed 500 tasks',
      taskId: 'task-claimed-by-caller',
      reasonDetails: { xp: 999999 },
    })).resolves.toMatchObject({
      success: false,
      error: {
        code: 'PROMOTION_NOT_AUTHORIZED',
        message: expect.stringContaining('production enhanced screening'),
      },
    });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns NOT_FOUND if the committed user cannot be re-read', async () => {
    mockTrustTier.applyPromotion.mockResolvedValueOnce({ success: true });
    mockQuery.mockResolvedValueOnce({ rows: [] } as never);

    await expect(TrustService.promote(baseParams)).resolves.toMatchObject({
      success: false,
      error: { code: 'NOT_FOUND' },
    });
  });

  it('distinguishes a post-commit read failure from policy rejection', async () => {
    mockTrustTier.applyPromotion.mockResolvedValueOnce({ success: true });
    mockQuery.mockRejectedValueOnce(new Error('read replica unavailable'));

    await expect(TrustService.promote(baseParams)).resolves.toMatchObject({
      success: false,
      error: { code: 'DB_ERROR', message: 'read replica unavailable' },
    });
  });
});

describe('TrustService.checkPromotionEligibility', () => {
  it('delegates eligibility without querying raw task counts', async () => {
    mockTrustTier.getTrustTier.mockResolvedValueOnce(TrustTier.VERIFIED);
    mockTrustTier.evaluatePromotion.mockResolvedValueOnce({
      eligible: true,
      targetTier: TrustTier.HOME_READY,
      reasons: [],
    });

    await expect(TrustService.checkPromotionEligibility('u1')).resolves.toMatchObject({
      success: true,
      data: { eligible: true, currentTier: 1, nextTier: 2 },
    });
    expect(mockTrustTier.evaluatePromotion).toHaveBeenCalledWith('u1');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('does not expose a next tier when evidence is insufficient', async () => {
    mockTrustTier.getTrustTier.mockResolvedValueOnce(TrustTier.VERIFIED);
    mockTrustTier.evaluatePromotion.mockResolvedValueOnce({
      eligible: false,
      targetTier: undefined,
      reasons: ['Current production enhanced screening required'],
    });

    await expect(TrustService.checkPromotionEligibility('u1')).resolves.toMatchObject({
      success: true,
      data: { eligible: false, currentTier: 1, nextTier: undefined },
    });
  });

  it('does not evaluate a banned worker for promotion', async () => {
    mockTrustTier.getTrustTier.mockResolvedValueOnce(TrustTier.BANNED);

    await expect(TrustService.checkPromotionEligibility('u1')).resolves.toMatchObject({
      success: true,
      data: { eligible: false, currentTier: 9 },
    });
    expect(mockTrustTier.evaluatePromotion).not.toHaveBeenCalled();
  });

  it('returns an error when the canonical evaluator cannot establish evidence', async () => {
    mockTrustTier.getTrustTier.mockRejectedValueOnce(new Error('User u1 not found'));

    await expect(TrustService.checkPromotionEligibility('u1')).resolves.toMatchObject({
      success: false,
      error: { code: 'DB_ERROR', message: 'User u1 not found' },
    });
  });
});
