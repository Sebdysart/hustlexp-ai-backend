import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks (BEFORE imports) ──────────────────────────────────────────────────
vi.mock('../../src/db', () => ({
  db: { query: vi.fn() },
  isInvariantViolation: vi.fn(() => false),
  isUniqueViolation: vi.fn(() => false),
  getErrorMessage: vi.fn((code: string) => `Error ${code}`),
}));

vi.mock('../../src/logger', () => ({
  logger: {
    child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(),
  },
  escrowLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

// ── Imports ─────────────────────────────────────────────────────────────────
import { BadgeService } from '../../src/services/BadgeService';
import { db, isInvariantViolation } from '../../src/db';

const mockQuery = db.query as ReturnType<typeof vi.fn>;
const mockIsInvariantViolation = isInvariantViolation as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

const fakeBadge = {
  id: 'badge-1',
  user_id: 'user-1',
  badge_type: 'FIRST_TASK',
  badge_tier: 1,
  awarded_at: new Date().toISOString(),
  awarded_for: 'Completing first task',
  task_id: 'task-1',
  animation_shown_at: null,
};

// ═══════════════════════════════════════════════════════════════════════════
// getByUserId
// ═══════════════════════════════════════════════════════════════════════════
describe('BadgeService.getByUserId', () => {
  it('returns badges for user', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [fakeBadge] });

    const result = await BadgeService.getByUserId('user-1');
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toHaveLength(1);
  });

  it('returns empty array when user has no badges', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await BadgeService.getByUserId('user-1');
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toHaveLength(0);
  });

  it('handles DB error', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB error'));

    const result = await BadgeService.getByUserId('user-1');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('DB_ERROR');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// getById
// ═══════════════════════════════════════════════════════════════════════════
describe('BadgeService.getById', () => {
  it('returns badge when found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [fakeBadge] });

    const result = await BadgeService.getById('badge-1');
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.id).toBe('badge-1');
  });

  it('returns NOT_FOUND when badge does not exist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await BadgeService.getById('missing');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('NOT_FOUND');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// hasBadge
// ═══════════════════════════════════════════════════════════════════════════
describe('BadgeService.hasBadge', () => {
  it('returns true when user has badge type', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '1' }] });

    const result = await BadgeService.hasBadge('user-1', 'FIRST_TASK');
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe(true);
  });

  it('returns false when user does not have badge type', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });

    const result = await BadgeService.hasBadge('user-1', 'MYTHICAL');
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// award
// ═══════════════════════════════════════════════════════════════════════════
describe('BadgeService.award', () => {
  it('awards badge successfully', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [fakeBadge] });

    const result = await BadgeService.award({
      userId: 'user-1',
      badgeType: 'FIRST_TASK',
      badgeTier: 1,
      awardedFor: 'First task',
      taskId: 'task-1',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid tier below 1', async () => {
    const result = await BadgeService.award({
      userId: 'user-1',
      badgeType: 'X',
      badgeTier: 0,
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('INVALID_TIER');
  });

  it('rejects invalid tier above 4', async () => {
    const result = await BadgeService.award({
      userId: 'user-1',
      badgeType: 'X',
      badgeTier: 5,
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('INVALID_TIER');
  });

  it('handles unique constraint violation (duplicate badge)', async () => {
    const err = new Error('unique constraint') as any;
    err.code = '23505';
    mockQuery.mockRejectedValueOnce(err);

    const result = await BadgeService.award({
      userId: 'user-1',
      badgeType: 'FIRST_TASK',
      badgeTier: 1,
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('23505');
  });

  it('handles invariant violation', async () => {
    const err = { code: 'INVARIANT' } as any;
    mockIsInvariantViolation.mockReturnValueOnce(true);
    mockQuery.mockRejectedValueOnce(err);

    const result = await BadgeService.award({
      userId: 'user-1',
      badgeType: 'X',
      badgeTier: 1,
    });
    expect(result.success).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// markAnimationShown
// ═══════════════════════════════════════════════════════════════════════════
describe('BadgeService.markAnimationShown', () => {
  it('marks animation shown', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ...fakeBadge, animation_shown_at: new Date().toISOString() }] });

    const result = await BadgeService.markAnimationShown({ badgeId: 'badge-1' });
    expect(result.success).toBe(true);
  });

  it('returns NOT_FOUND for missing badge', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await BadgeService.markAnimationShown({ badgeId: 'missing' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('NOT_FOUND');
  });

  it('handles DB error', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB error'));

    const result = await BadgeService.markAnimationShown({ badgeId: 'badge-1' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('DB_ERROR');
  });
});
