/**
 * UI Router Unit Tests
 *
 * Tests all tRPC procedures on the UI router:
 * - getXPCelebrationStatus (protected, query)
 * - markXPCelebrationShown (protected, mutation)
 * - getBadgeAnimationStatus (protected, query)
 * - markBadgeAnimationShown (protected, mutation)
 * - reportViolation (protected, mutation)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../src/db', () => ({
  db: { query: vi.fn() },
}));

vi.mock('../../src/auth/firebase', () => ({
  firebaseAuth: { verifyIdToken: vi.fn() },
}));

vi.mock('../../src/logger', () => ({
  logger: {
    child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(),
  },
  escrowLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { db } from '../../src/db';
import { uiRouter } from '../../src/routers/ui';

const mockDb = vi.mocked(db);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_UUID = '11111111-1111-1111-1111-111111111111';

function makeCaller(userId = 'test-uid') {
  return uiRouter.createCaller({
    user: { id: userId } as any,
    firebaseUid: 'fb-uid',
  });
}

// ---------------------------------------------------------------------------
// Tests — XP Celebration
// ---------------------------------------------------------------------------

describe('ui.getXPCelebrationStatus', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns shouldShow=true when celebration not yet shown', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ xp_first_celebration_shown_at: null }],
      rowCount: 1,
    } as any);

    const result = await makeCaller().getXPCelebrationStatus();

    expect(result.shouldShow).toBe(true);
    expect(result.xpFirstCelebrationShownAt).toBeNull();
  });

  it('returns shouldShow=false when celebration already shown', async () => {
    const shownAt = new Date('2026-01-15T10:00:00Z');
    mockDb.query.mockResolvedValueOnce({
      rows: [{ xp_first_celebration_shown_at: shownAt }],
      rowCount: 1,
    } as any);

    const result = await makeCaller().getXPCelebrationStatus();

    expect(result.shouldShow).toBe(false);
    expect(result.xpFirstCelebrationShownAt).toBe(shownAt.toISOString());
  });

  it('throws NOT_FOUND when user not found', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await expect(makeCaller().getXPCelebrationStatus()).rejects.toThrow('User not found');
  });
});

describe('ui.markXPCelebrationShown', () => {
  beforeEach(() => vi.clearAllMocks());

  it('marks celebration as shown for first time', async () => {
    const shownAt = new Date('2026-01-15T10:00:00Z');
    mockDb.query.mockResolvedValueOnce({
      rows: [{ xp_first_celebration_shown_at: shownAt }],
      rowCount: 1,
    } as any);

    const result = await makeCaller().markXPCelebrationShown({});

    expect(result.success).toBe(true);
    expect(result.alreadyShown).toBe(false);
    expect(result.xpFirstCelebrationShownAt).toBe(shownAt.toISOString());
  });

  it('returns alreadyShown=true when already marked', async () => {
    // First UPDATE returns empty (no match on IS NULL condition)
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
    // Second SELECT returns current value
    const existingDate = new Date('2026-01-10T10:00:00Z');
    mockDb.query.mockResolvedValueOnce({
      rows: [{ xp_first_celebration_shown_at: existingDate }],
      rowCount: 1,
    } as any);

    const result = await makeCaller().markXPCelebrationShown({});

    expect(result.success).toBe(true);
    expect(result.alreadyShown).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests — Badge Animation
// ---------------------------------------------------------------------------

describe('ui.getBadgeAnimationStatus', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns shouldShow=true when animation not yet shown', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ animation_shown_at: null }],
      rowCount: 1,
    } as any);

    const result = await makeCaller().getBadgeAnimationStatus({ badgeId: TEST_UUID });

    expect(result.shouldShow).toBe(true);
    expect(result.animationShownAt).toBeNull();
  });

  it('returns shouldShow=false when animation already shown', async () => {
    const shownAt = new Date('2026-01-15T10:00:00Z');
    mockDb.query.mockResolvedValueOnce({
      rows: [{ animation_shown_at: shownAt }],
      rowCount: 1,
    } as any);

    const result = await makeCaller().getBadgeAnimationStatus({ badgeId: TEST_UUID });

    expect(result.shouldShow).toBe(false);
    expect(result.animationShownAt).toBe(shownAt.toISOString());
  });

  it('throws NOT_FOUND when badge not found', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await expect(
      makeCaller().getBadgeAnimationStatus({ badgeId: TEST_UUID })
    ).rejects.toThrow('Badge not found');
  });
});

describe('ui.markBadgeAnimationShown', () => {
  beforeEach(() => vi.clearAllMocks());

  it('marks badge animation as shown for first time', async () => {
    const shownAt = new Date('2026-01-15T10:00:00Z');
    mockDb.query.mockResolvedValueOnce({
      rows: [{ animation_shown_at: shownAt }],
      rowCount: 1,
    } as any);

    const result = await makeCaller().markBadgeAnimationShown({ badgeId: TEST_UUID });

    expect(result.success).toBe(true);
    expect(result.alreadyShown).toBe(false);
  });

  it('returns alreadyShown=true when already marked', async () => {
    // UPDATE returns empty
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
    // SELECT returns existing
    const existing = new Date('2026-01-10T10:00:00Z');
    mockDb.query.mockResolvedValueOnce({
      rows: [{ animation_shown_at: existing }],
      rowCount: 1,
    } as any);

    const result = await makeCaller().markBadgeAnimationShown({ badgeId: TEST_UUID });

    expect(result.success).toBe(true);
    expect(result.alreadyShown).toBe(true);
  });

  it('throws NOT_FOUND when badge does not exist', async () => {
    // UPDATE returns empty
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
    // SELECT also returns empty
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await expect(
      makeCaller().markBadgeAnimationShown({ badgeId: TEST_UUID })
    ).rejects.toThrow('Badge not found');
  });
});

// ---------------------------------------------------------------------------
// Tests — Violation Reporting
// ---------------------------------------------------------------------------

describe('ui.reportViolation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('logs violation and returns success', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

    const result = await makeCaller().reportViolation({
      type: 'COLOR',
      rule: 'UI_SPEC §3.1',
      component: 'TaskCard',
      context: { expected: '#FF0000', actual: '#00FF00' },
    });

    expect(result.success).toBe(true);
    expect(result).toHaveProperty('loggedAt');
    // Verify the DB insert call
    const [sql, params] = (mockDb.query as any).mock.calls[0];
    expect(sql).toContain('admin_actions');
    expect(params[0]).toBe('test-uid');
    const details = JSON.parse(params[1]);
    expect(details.violationType).toBe('COLOR');
    expect(details.rule).toBe('UI_SPEC §3.1');
    expect(details.component).toBe('TaskCard');
    expect(details.severity).toBe('ERROR');
  });

  it('accepts WARNING severity', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

    const result = await makeCaller().reportViolation({
      type: 'ACCESSIBILITY',
      rule: 'WCAG 2.1',
      component: 'Button',
      context: {},
      severity: 'WARNING',
    });

    expect(result.success).toBe(true);
    const details = JSON.parse((mockDb.query as any).mock.calls[0][1][1]);
    expect(details.severity).toBe('WARNING');
  });

  it('rejects invalid violation type', async () => {
    await expect(
      makeCaller().reportViolation({
        type: 'INVALID' as any,
        rule: 'test',
        component: 'test',
        context: {},
      })
    ).rejects.toThrow();
  });
});
