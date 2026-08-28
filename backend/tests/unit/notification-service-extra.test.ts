/**
 * NotificationService Extra Unit Tests
 *
 * Covers paths NOT already tested in notification-service.test.ts:
 * - createNotification with Redis-based frequency limiting (hourly/daily limits)
 * - createNotification with in_app channel fallback
 * - createNotification with quiet hours + DND bypass (HIGH priority, bypass categories)
 * - createNotification with worker participant check
 * - createNotification triggering batchNotification
 * - createNotification with invariant violation
 * - createNotification with expiresAt
 * - updatePreferences: categoryPreferences update field
 * - updatePreferences: all update fields together
 * - updatePreferences: creates prefs when getPreferences fails (returns no id)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
vi.mock('../../src/db', () => ({
  db: {
    query: vi.fn(),
    transaction: vi.fn(),
    serializableTransaction: vi.fn(),
  },
  isInvariantViolation: vi.fn(() => false),
  isUniqueViolation: vi.fn(() => false),
  getErrorMessage: vi.fn((code: string) => `Error: ${code}`),
}));

vi.mock('../../src/logger', () => {
  const childFn = (): object => ({
    info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(),
    fatal: vi.fn(), trace: vi.fn(), child: childFn,
  });
  return { logger: { child: childFn, info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } };
});

// Redis mock with configurable incr results
// Use vi.hoisted to ensure mock instances are available before module loading
const { mockRedisIncr, mockRedisExpire, mockRedisGet } = vi.hoisted(() => ({
  mockRedisIncr: vi.fn().mockResolvedValue(1),
  mockRedisExpire: vi.fn().mockResolvedValue(1),
  mockRedisGet: vi.fn().mockResolvedValue(null),
}));

vi.mock('@upstash/redis', () => ({
  Redis: class MockRedis {
    incr = mockRedisIncr;
    expire = mockRedisExpire;
    get = mockRedisGet;
  },
}));

vi.mock('../../src/config', () => ({
  config: {
    // restUrl and restToken set so Redis gets instantiated (frequency limiting active)
    redis: { restUrl: 'https://test-redis.upstash.io', restToken: 'test-token' },
  },
}));

vi.mock('crypto', () => ({
  randomUUID: vi.fn(() => 'new-group-uuid-5678'),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------
import { NotificationService } from '../../src/services/NotificationService';
import { db, isInvariantViolation } from '../../src/db';

const mockDb = vi.mocked(db);
const mockIsInvariantViolation = vi.mocked(isInvariantViolation);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const USER_ID = 'user-extra-test';
const NOTIF_ID = 'notif-extra-456';
const TASK_ID = 'task-extra-789';

function makeNotification(overrides: Record<string, unknown> = {}) {
  return {
    id: NOTIF_ID,
    user_id: USER_ID,
    category: 'task_accepted',
    title: 'Task Accepted',
    body: 'Body',
    deep_link: 'hustlexp://tasks/test',
    task_id: null,
    metadata: {},
    channels: ['push'],
    priority: 'MEDIUM',
    sent_at: null,
    delivered_at: null,
    read_at: null,
    clicked_at: null,
    group_id: null,
    group_position: null,
    expires_at: null,
    created_at: new Date('2024-01-01T10:00:00Z'),
    ...overrides,
  };
}

function makePreferences(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pref-001',
    user_id: USER_ID,
    quiet_hours_enabled: false,
    quiet_hours_start: '22:00:00',
    quiet_hours_end: '07:00:00',
    push_enabled: true,
    email_enabled: false,
    sms_enabled: false,
    category_preferences: {},
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
beforeEach(() => {
  // Use resetAllMocks to also clear mockResolvedValueOnce queues
  // (clearAllMocks only clears call history, not the queued return values)
  vi.resetAllMocks();
  // Re-setup default mock behaviors after reset
  mockRedisIncr.mockResolvedValue(1);
  mockRedisExpire.mockResolvedValue(1);
  mockIsInvariantViolation.mockReturnValue(false);
});

// ===========================================================================
// TESTS
// ===========================================================================

describe('NotificationService (extra coverage)', () => {

  // =========================================================================
  // createNotification — frequency limit paths (Redis active)
  // =========================================================================
  describe('createNotification — frequency limiting', () => {
    it('returns an authorized explicit replay before exhausted frequency counters are read', async () => {
      mockRedisGet
        .mockResolvedValueOnce(5)
        .mockResolvedValueOnce(20);

      const replay = makeNotification({
        category: 'new_matching_task',
        dedupe_key: 'matching-event:replay',
        object_type: 'task',
        object_id: TASK_ID,
      });
      mockDb.query
        .mockResolvedValueOnce({
          rows: [{ poster_id: USER_ID, worker_id: null }],
          rowCount: 1,
        } as never)
        .mockResolvedValueOnce({ rows: [replay], rowCount: 1 } as never);

      const result = await NotificationService.createNotification({
        userId: USER_ID,
        category: 'new_matching_task',
        title: 'New Task',
        body: 'Body',
        deepLink: `hustlexp://tasks/${TASK_ID}`,
        taskId: TASK_ID,
        dedupeKey: 'matching-event:replay',
      });

      expect(result).toEqual({ success: true, data: replay });
      expect(mockRedisGet).not.toHaveBeenCalled();
      expect(mockDb.query).toHaveBeenCalledTimes(2);
      expect(String(mockDb.query.mock.calls[1]?.[0])).toContain('AND user_id = $2');
    });

    it('returns RATE_LIMIT_EXCEEDED when hourly limit exceeded and no batch target found', async () => {
      // Category 'new_matching_task' has perHour: 5
      // checkFrequency uses redis.get() — return values >= limit to trigger enforcement.
      // BUG 8 FIX: frequency is now read-only checked (get) before INSERT, then incremented after.
      mockRedisGet
        .mockResolvedValueOnce(5)   // hourly = 5 >= perHour(5) — triggers batch path
        .mockResolvedValueOnce(10); // daily

      mockDb.query
        // getPreferences: no row -> default prefs
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
        // batchNotification: find recent notification to batch with - none found
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const result = await NotificationService.createNotification({
        userId: USER_ID,
        category: 'new_matching_task',
        title: 'New Task',
        body: 'Body',
        deepLink: 'hustlexp://tasks/t1',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('RATE_LIMIT_EXCEEDED');
        expect(result.error.message).toContain('new_matching_task');
      }
    });

    it('returns batched notification when hourly limit exceeded and batch target exists', async () => {
      // checkFrequency uses redis.get(); incrementFrequency uses redis.incr() after INSERT.
      // BUG 8 FIX: check is now read-only, so use mockRedisGet for the pre-INSERT check.
      mockRedisGet
        .mockResolvedValueOnce(5)   // hourly = 5 >= perHour(5) — triggers batch
        .mockResolvedValueOnce(10); // daily

      const existingNotif = makeNotification({ title: 'Old Task', body: 'Old body', metadata: {} });
      const updatedNotif = makeNotification({ title: 'Old Task (2 new)', body: 'Updated body', metadata: { batched_count: 1 } });

      mockDb.query
        // getPreferences
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
        // batchNotification: find recent notification (bare SELECT, before transaction)
        .mockResolvedValueOnce({ rows: [existingNotif], rowCount: 1 } as never);

      // batchNotification now wraps the SELECT FOR UPDATE + UPDATE in db.transaction().
      // Mock transaction to call the callback with a txQuery fn that returns the expected results.
      const txQuery = vi.fn()
        // SELECT ... FOR UPDATE inside transaction
        .mockResolvedValueOnce({ rows: [existingNotif], rowCount: 1 } as never)
        // UPDATE notification inside transaction
        .mockResolvedValueOnce({ rows: [updatedNotif], rowCount: 1 } as never);
      mockDb.transaction.mockImplementationOnce(async (cb: (q: typeof txQuery) => Promise<unknown>) => cb(txQuery));

      const result = await NotificationService.createNotification({
        userId: USER_ID,
        category: 'new_matching_task',
        title: 'New Task',
        body: 'Body',
        deepLink: 'hustlexp://tasks/t1',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        // The batched notification is returned
        expect(result.data.id).toBe(NOTIF_ID);
      }
    });

    it('returns RATE_LIMIT_EXCEEDED when daily limit exceeded', async () => {
      // Category 'welcome' has perDay: 1
      // checkFrequency uses redis.get(); BUG 8 FIX: check is read-only pre-INSERT.
      mockRedisGet
        .mockResolvedValueOnce(0)  // hourly OK (0 < 1)
        .mockResolvedValueOnce(1); // daily = 1 >= perDay(1) — triggers daily limit

      mockDb.query
        // getPreferences
        .mockResolvedValueOnce({
          rows: [makePreferences({ category_preferences: { welcome: { enabled: true } } })],
          rowCount: 1,
        } as never);

      const result = await NotificationService.createNotification({
        userId: USER_ID,
        category: 'welcome',
        title: 'Welcome!',
        body: 'Body',
        deepLink: 'hustlexp://welcome',
        objectRef: { type: 'user', id: USER_ID },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('RATE_LIMIT_EXCEEDED');
        expect(result.error.message).toContain('Daily limit exceeded');
      }
    });

    it('sets TTL on first Redis increment (hourly === 1)', async () => {
      // 'badge_earned' has perHour: 3, perDay: 10
      mockRedisIncr
        .mockResolvedValueOnce(1)  // hourly = 1 (first, TTL should be set)
        .mockResolvedValueOnce(1); // daily = 1 (first, TTL should be set)

      const notif = makeNotification({ category: 'badge_earned' });
      mockDb.query
        .mockResolvedValueOnce({
          rows: [makePreferences({ category_preferences: { badge_earned: { enabled: true } } })],
          rowCount: 1,
        } as never)  // getPreferences
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)  // findGroupableNotification
        .mockResolvedValueOnce({ rows: [notif], rowCount: 1 } as never) // INSERT
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)  // push outbox check
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)  // INSERT outbox
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // UPDATE sent_at

      await NotificationService.createNotification({
        userId: USER_ID,
        category: 'badge_earned',
        title: 'Badge Earned',
        body: 'Body',
        deepLink: 'hustlexp://badges/1',
      });

      // expire should be called twice (once for hour key, once for day key)
      expect(mockRedisExpire).toHaveBeenCalledTimes(2);
    });
  });

  // =========================================================================
  // createNotification — quiet hours and DND bypass
  // =========================================================================
  describe('createNotification — quiet hours', () => {
    it('still creates an active-task notification during quiet hours', async () => {
      // Prefs with quiet hours enabled
      const prefs = makePreferences({
        quiet_hours_enabled: true,
        quiet_hours_start: '00:00:00', // all day quiet
        quiet_hours_end: '23:59:00',
      });

      const notif = makeNotification({ priority: 'CRITICAL' });
      mockDb.query
        .mockResolvedValueOnce({ rows: [prefs], rowCount: 1 } as never) // getPreferences
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)      // findGroupableNotification
        .mockResolvedValueOnce({ rows: [notif], rowCount: 1 } as never) // INSERT
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)      // push outbox check
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)      // INSERT outbox
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);     // UPDATE sent_at

      const result = await NotificationService.createNotification({
        userId: USER_ID,
        category: 'task_accepted',
        title: 'Critical',
        body: 'Body',
        deepLink: 'hustlexp://tasks/t1',
        priority: 'CRITICAL',
      });

      expect(result.success).toBe(true);
    });

    it('still creates notification during quiet hours for DND bypass category (security_alert)', async () => {
      const prefs = makePreferences({
        quiet_hours_enabled: true,
        quiet_hours_start: '00:00:00',
        quiet_hours_end: '23:59:00',
      });

      const notif = makeNotification({ category: 'security_alert' });
      mockDb.query
        .mockResolvedValueOnce({ rows: [prefs], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
        .mockResolvedValueOnce({ rows: [notif], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      const result = await NotificationService.createNotification({
        userId: USER_ID,
        category: 'security_alert',
        title: 'Security Alert',
        body: 'Body',
        deepLink: 'hustlexp://security',
        objectRef: { type: 'user', id: USER_ID },
        priority: 'MEDIUM',
      });

      expect(result.success).toBe(true);
    });
  });

  // =========================================================================
  // createNotification — channel filtering edge cases
  // =========================================================================
  describe('createNotification — channel filtering', () => {
    it('falls through to in_app when push is disabled but in_app is in channels', async () => {
      const prefs = makePreferences({
        push_enabled: false,
        email_enabled: false,
        sms_enabled: false,
      });

      const notif = makeNotification({ channels: ['in_app'] });
      // Only in_app channel remains after push is filtered out.
      // queueNotificationChannels skips in_app (continue), so NO outbox queries.
      // Sequence: getPreferences, findGroupableNotification, INSERT, UPDATE sent_at (4 total)
      mockDb.query
        .mockResolvedValueOnce({ rows: [prefs], rowCount: 1 } as never) // getPreferences
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)      // findGroupableNotification
        .mockResolvedValueOnce({ rows: [notif], rowCount: 1 } as never) // INSERT
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);     // UPDATE sent_at

      const result = await NotificationService.createNotification({
        userId: USER_ID,
        category: 'task_accepted',
        title: 'Task Accepted',
        body: 'Body',
        deepLink: 'hustlexp://tasks/t1',
        channels: ['push', 'in_app'],
      });

      expect(result.success).toBe(true);
    });

    it('creates notification when user is worker (not poster) in task', async () => {
      const notif = makeNotification();
      const WORKER_ID = 'worker-user-999';

      mockDb.query
        // Task lookup: user is the worker
        .mockResolvedValueOnce({ rows: [{ poster_id: 'other-poster', worker_id: WORKER_ID }], rowCount: 1 } as never)
        // getPreferences
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
        // findGroupableNotification
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
        // INSERT
        .mockResolvedValueOnce({ rows: [notif], rowCount: 1 } as never)
        // outbox check
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
        // INSERT outbox
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
        // UPDATE sent_at
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      const result = await NotificationService.createNotification({
        userId: WORKER_ID,
        category: 'task_accepted',
        title: 'Task',
        body: 'Body',
        deepLink: 'hustlexp://tasks/t1',
        taskId: TASK_ID,
      });

      expect(result.success, `Expected success but got error: ${JSON.stringify(!result.success ? result.error : null)}`).toBe(true);
    });

    it('creates notification with expiresAt set', async () => {
      const expiresAt = new Date(Date.now() + 86400000);
      const notif = makeNotification({ expires_at: expiresAt });

      mockDb.query
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)      // getPreferences
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)      // findGroupableNotification
        .mockResolvedValueOnce({ rows: [notif], rowCount: 1 } as never) // INSERT
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)      // outbox check
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)      // INSERT outbox
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);     // UPDATE sent_at

      const result = await NotificationService.createNotification({
        userId: USER_ID,
        category: 'task_accepted',
        title: 'Task',
        body: 'Body',
        deepLink: 'hustlexp://tasks/t1',
        expiresAt,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.expires_at).toEqual(expiresAt);
      }
    });
  });

  // =========================================================================
  // createNotification — invariant violation
  // =========================================================================
  describe('createNotification — invariant violation handling', () => {
    it('returns INVARIANT_VIOLATION code when db throws an invariant error', async () => {
      const invariantError = Object.assign(new Error('Invariant violated'), { code: 'INV_001' });
      mockIsInvariantViolation.mockReturnValueOnce(true);

      mockDb.query
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // getPreferences
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // findGroupableNotification
        .mockRejectedValueOnce(invariantError);                     // INSERT throws

      const result = await NotificationService.createNotification({
        userId: USER_ID,
        category: 'task_accepted',
        title: 'Task',
        body: 'Body',
        deepLink: 'hustlexp://tasks/t1',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(['INV_001', 'INVARIANT_VIOLATION']).toContain(result.error.code);
      }
    });
  });

  // =========================================================================
  // createNotification — grouping: new group creation
  // =========================================================================
  describe('createNotification — new group creation', () => {
    it('creates a new group (group_id = randomUUID) when no groupable notification found', async () => {
      const notif = makeNotification({ group_id: 'new-group-uuid-5678', group_position: 1 });

      mockDb.query
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)      // getPreferences
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)      // findGroupableNotification: no match
        .mockResolvedValueOnce({ rows: [notif], rowCount: 1 } as never) // INSERT
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)      // outbox check
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)      // INSERT outbox
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);     // UPDATE sent_at

      const result = await NotificationService.createNotification({
        userId: USER_ID,
        category: 'task_accepted',
        title: 'Task',
        body: 'Body',
        deepLink: 'hustlexp://tasks/t1',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.group_id).toBe('new-group-uuid-5678');
      }
    });
  });

  // =========================================================================
  // createNotification — grouping with taskId (task-specific group query)
  // =========================================================================
  describe('createNotification — grouping with taskId', () => {
    it('uses task-specific grouping query when taskId is provided', async () => {
      const notif = makeNotification({ task_id: TASK_ID });

      mockDb.query
        // Task lookup (user is poster)
        .mockResolvedValueOnce({ rows: [{ poster_id: USER_ID, worker_id: 'worker-2' }], rowCount: 1 } as never)
        // getPreferences
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
        // findGroupableNotification with taskId: no existing group
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
        // INSERT
        .mockResolvedValueOnce({ rows: [notif], rowCount: 1 } as never)
        // outbox check
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
        // INSERT outbox
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
        // UPDATE sent_at
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      const result = await NotificationService.createNotification({
        userId: USER_ID,
        category: 'task_accepted',
        title: 'Task',
        body: 'Body',
        deepLink: 'hustlexp://tasks/t1',
        taskId: TASK_ID,
      });

      expect(result.success).toBe(true);
    });
  });

  // =========================================================================
  // updatePreferences — categoryPreferences field
  // =========================================================================
  describe('updatePreferences — categoryPreferences', () => {
    it('updates categoryPreferences field in existing preferences', async () => {
      const existingPrefs = makePreferences();
      const updatedPrefs = makePreferences({
        category_preferences: { task_accepted: { enabled: false, sound: false } },
      });

      mockDb.query
        .mockResolvedValueOnce({ rows: [existingPrefs], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [updatedPrefs], rowCount: 1 } as never);

      const result = await NotificationService.updatePreferences({
        userId: USER_ID,
        categoryPreferences: { task_accepted: { enabled: false, sound: false } },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.category_preferences).toEqual({
          task_accepted: { enabled: false, sound: false },
        });
      }
    });

    it('creates new preferences with categoryPreferences when none exist', async () => {
      const newPrefs = makePreferences({
        id: 'new-id',
        category_preferences: { badge_earned: { enabled: true } },
      });

      mockDb.query
        // getPreferences: no existing row (defaults returned, id: '')
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
        // INSERT new preferences
        .mockResolvedValueOnce({ rows: [newPrefs], rowCount: 1 } as never);

      const result = await NotificationService.updatePreferences({
        userId: USER_ID,
        categoryPreferences: { badge_earned: { enabled: true } },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toBe('new-id');
      }
    });

    it('updates all fields simultaneously', async () => {
      const existingPrefs = makePreferences();
      const updatedPrefs = makePreferences({
        push_enabled: false,
        email_enabled: true,
        sms_enabled: true,
        quiet_hours_enabled: false,
        quiet_hours_start: '21:00:00',
        quiet_hours_end: '08:00:00',
        category_preferences: { welcome: { enabled: false } },
      });

      mockDb.query
        .mockResolvedValueOnce({ rows: [existingPrefs], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [updatedPrefs], rowCount: 1 } as never);

      const result = await NotificationService.updatePreferences({
        userId: USER_ID,
        pushEnabled: false,
        emailEnabled: true,
        smsEnabled: true,
        quietHoursEnabled: false,
        quietHoursStart: '21:00:00',
        quietHoursEnd: '08:00:00',
        categoryPreferences: { welcome: { enabled: false } },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.push_enabled).toBe(false);
        expect(result.data.email_enabled).toBe(true);
        expect(result.data.sms_enabled).toBe(true);
      }
    });
  });

  // =========================================================================
  // createNotification — metadata provided
  // =========================================================================
  describe('createNotification — with metadata', () => {
    it('stores metadata when provided', async () => {
      const metadata = { taskCategory: 'cleaning', urgency: 'high' };
      const notif = makeNotification({ metadata });

      mockDb.query
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
        .mockResolvedValueOnce({ rows: [notif], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      const result = await NotificationService.createNotification({
        userId: USER_ID,
        category: 'task_accepted',
        title: 'Task',
        body: 'Body',
        deepLink: 'hustlexp://tasks/t1',
        metadata,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.metadata).toEqual(metadata);
      }
    });
  });

  // =========================================================================
  // createNotification — multiple channels including email/sms
  // =========================================================================
  describe('createNotification — multi-channel with email and sms enabled', () => {
    it('sends to enabled channels: push + email when email_enabled is true', async () => {
      const prefs = makePreferences({ email_enabled: true });
      const notif = makeNotification({ category: 'payment_failed', channels: ['push', 'email'] });

      mockDb.query
        .mockResolvedValueOnce({ rows: [prefs], rowCount: 1 } as never) // getPreferences
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)      // findGroupableNotification
        .mockResolvedValueOnce({ rows: [notif], rowCount: 1 } as never) // INSERT
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)      // push outbox check
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)      // INSERT outbox push
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)      // UPDATE sent_at push
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)      // email outbox check
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)      // INSERT outbox email
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);     // UPDATE sent_at email

      const result = await NotificationService.createNotification({
        userId: USER_ID,
        category: 'payment_failed',
        title: 'Payment failed',
        body: 'Body',
        deepLink: 'hustlexp://tasks/t1',
        channels: ['push', 'email'],
      });

      expect(result.success).toBe(true);
    });
  });
});
