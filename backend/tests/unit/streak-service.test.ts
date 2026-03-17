// backend/tests/unit/streak-service.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db.js', () => ({
  db: { query: vi.fn() },
}));

vi.mock('../../src/logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

import { db } from '../../src/db.js';
import {
  updateStreakOnTaskCompletion,
  getStreakStatus,
} from '../../src/services/StreakService.js';

const mockDb = vi.mocked(db);

const USER_ID = 'user-aaa-111';

describe('StreakService.updateStreakOnTaskCompletion', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('starts streak at 1 when user has no previous completions', async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{ current_streak: 0, last_task_completed_at: null, streak_grace_expires_at: null }],
      } as any)
      .mockResolvedValueOnce({ rows: [] } as any) // UPDATE current_streak
      .mockResolvedValueOnce({ rows: [] } as any); // UPDATE longest_streak

    const completedAt = new Date('2026-03-10T14:00:00.000Z');
    const result = await updateStreakOnTaskCompletion(USER_ID, completedAt);

    expect(result.success).toBe(true);
    expect(result.data!.newStreak).toBe(1);
    expect(result.data!.streakChanged).toBe(true);
    expect(result.data!.wasReset).toBe(false);
    expect(result.data!.previousStreak).toBe(0);
  });

  it('extends streak by 1 when completion is the day after last', async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{
          current_streak: 5,
          last_task_completed_at: new Date('2026-03-09T12:00:00.000Z'),
          streak_grace_expires_at: new Date('2026-03-10T23:59:59.999Z'),
        }],
      } as any)
      .mockResolvedValueOnce({ rows: [] } as any)
      .mockResolvedValueOnce({ rows: [] } as any);

    const completedAt = new Date('2026-03-10T10:00:00.000Z');
    const result = await updateStreakOnTaskCompletion(USER_ID, completedAt);

    expect(result.success).toBe(true);
    expect(result.data!.newStreak).toBe(6);
    expect(result.data!.streakChanged).toBe(true);
    expect(result.data!.wasReset).toBe(false);
  });

  it('does not change streak when completion is on same day as last', async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{
          current_streak: 3,
          last_task_completed_at: new Date('2026-03-10T08:00:00.000Z'),
          streak_grace_expires_at: new Date('2026-03-11T23:59:59.999Z'),
        }],
      } as any)
      .mockResolvedValueOnce({ rows: [] } as any)
      .mockResolvedValueOnce({ rows: [] } as any);

    const completedAt = new Date('2026-03-10T20:00:00.000Z'); // same UTC day
    const result = await updateStreakOnTaskCompletion(USER_ID, completedAt);

    expect(result.success).toBe(true);
    expect(result.data!.newStreak).toBe(3);
    expect(result.data!.streakChanged).toBe(false);
    expect(result.data!.wasReset).toBe(false);
  });

  it('resets streak to 1 when a day was missed', async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{
          current_streak: 10,
          last_task_completed_at: new Date('2026-03-07T12:00:00.000Z'), // 3 days ago
          streak_grace_expires_at: new Date('2026-03-08T23:59:59.999Z'),
        }],
      } as any)
      .mockResolvedValueOnce({ rows: [] } as any)
      .mockResolvedValueOnce({ rows: [] } as any);

    const completedAt = new Date('2026-03-10T12:00:00.000Z');
    const result = await updateStreakOnTaskCompletion(USER_ID, completedAt);

    expect(result.success).toBe(true);
    expect(result.data!.newStreak).toBe(1);
    expect(result.data!.streakChanged).toBe(true);
    expect(result.data!.wasReset).toBe(true);
  });

  it('returns NOT_FOUND when user does not exist', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [] } as any);

    const result = await updateStreakOnTaskCompletion('nonexistent-user', new Date());

    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('NOT_FOUND');
  });

  it('returns DB_ERROR on db failure', async () => {
    mockDb.query.mockRejectedValueOnce(new Error('Connection lost'));

    const result = await updateStreakOnTaskCompletion(USER_ID, new Date());

    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('DB_ERROR');
    expect(result.error!.message).toContain('Connection lost');
  });

  it('handles longest_streak column not existing gracefully', async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{ current_streak: 2, last_task_completed_at: null, streak_grace_expires_at: null }],
      } as any)
      .mockResolvedValueOnce({ rows: [] } as any) // UPDATE current_streak
      .mockRejectedValueOnce(new Error('column "longest_streak" does not exist')); // longest_streak update fails

    const result = await updateStreakOnTaskCompletion(USER_ID, new Date('2026-03-10T10:00:00.000Z'));

    // Should still succeed — the longest_streak failure is swallowed
    expect(result.success).toBe(true);
    expect(result.data!.newStreak).toBe(1);
  });
});

describe('StreakService.getStreakStatus', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns streak status for active user with existing streak', async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{
          current_streak: 5,
          last_task_completed_at: new Date('2026-03-09T12:00:00.000Z'),
          streak_grace_expires_at: new Date('2026-03-10T23:59:59.999Z'),
        }],
      } as any)
      .mockResolvedValueOnce({
        rows: [{ longest_streak: 12 }],
      } as any);

    const result = await getStreakStatus(USER_ID);

    expect(result.success).toBe(true);
    expect(result.data!.current_streak).toBe(5);
    expect(result.data!.longest_streak).toBe(12);
    expect(result.data!.message).toContain('5-day streak');
  });

  it('returns message encouraging to start streak when streak is 0', async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{ current_streak: 0, last_task_completed_at: null, streak_grace_expires_at: null }],
      } as any)
      .mockResolvedValueOnce({ rows: [{ longest_streak: 0 }] } as any);

    const result = await getStreakStatus(USER_ID);

    expect(result.success).toBe(true);
    expect(result.data!.current_streak).toBe(0);
    expect(result.data!.message).toContain('start your streak');
  });

  it('returns 1-day streak message for single day streak', async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{ current_streak: 1, last_task_completed_at: new Date(), streak_grace_expires_at: null }],
      } as any)
      .mockResolvedValueOnce({ rows: [{ longest_streak: 1 }] } as any);

    const result = await getStreakStatus(USER_ID);

    expect(result.success).toBe(true);
    expect(result.data!.message).toContain('1 day streak');
  });

  it('returns NOT_FOUND when user does not exist', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [] } as any);

    const result = await getStreakStatus('nonexistent-user');

    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('NOT_FOUND');
  });

  it('handles longest_streak column missing gracefully', async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{ current_streak: 3, last_task_completed_at: new Date(), streak_grace_expires_at: null }],
      } as any)
      .mockRejectedValueOnce(new Error('column does not exist'));

    const result = await getStreakStatus(USER_ID);

    // Should still succeed — longest_streak falls back to current_streak
    expect(result.success).toBe(true);
    expect(result.data!.longest_streak).toBe(3); // falls back to current_streak
  });

  it('handles longest_streak null value by using current_streak', async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{ current_streak: 7, last_task_completed_at: new Date(), streak_grace_expires_at: null }],
      } as any)
      .mockResolvedValueOnce({ rows: [{ longest_streak: null }] } as any);

    const result = await getStreakStatus(USER_ID);

    expect(result.success).toBe(true);
    expect(result.data!.longest_streak).toBe(7);
  });

  it('returns DB_ERROR on db failure', async () => {
    mockDb.query.mockRejectedValueOnce(new Error('timeout'));

    const result = await getStreakStatus(USER_ID);

    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('DB_ERROR');
  });
});
