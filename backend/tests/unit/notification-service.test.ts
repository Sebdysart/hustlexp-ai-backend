/**
 * NotificationService Unit Tests
 *
 * Tests all exported methods: createNotification, getUserNotifications,
 * getUnreadCount, getNotificationById, markAsRead, markAllAsRead,
 * markAsClicked, getPreferences, updatePreferences, cleanupExpiredNotifications,
 * getRecentNotificationCount.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks (must appear before imports that use them)
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
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: childFn,
  });
  const mockLogger = {
    child: childFn,
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  };
  return { logger: mockLogger };
});

vi.mock('@upstash/redis', () => ({
  Redis: vi.fn().mockImplementation(() => ({
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
    get: vi.fn().mockResolvedValue(null),
  })),
}));

vi.mock('../../src/config', () => ({
  config: {
    redis: { restUrl: null, restToken: null },
  },
}));

// Mock crypto so randomUUID is deterministic
vi.mock('crypto', () => ({
  randomUUID: vi.fn(() => 'test-group-uuid-1234'),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------
import { NotificationService } from '../../src/services/NotificationService';
import { db } from '../../src/db';

const mockDb = vi.mocked(db);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const USER_ID = 'user-abc-123';
const NOTIF_ID = 'notif-abc-456';
const TASK_ID = 'task-xyz-789';

function makeNotification(overrides: Record<string, unknown> = {}) {
  return {
    id: NOTIF_ID,
    user_id: USER_ID,
    category: 'task_accepted',
    title: 'Task Accepted',
    body: 'Your task has been accepted.',
    deep_link: 'hustlexp://tasks/task-xyz-789',
    task_id: TASK_ID,
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
    created_at: new Date('2024-01-01T00:00:00Z'),
    updated_at: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
beforeEach(() => {
  vi.clearAllMocks();
});

// ===========================================================================
// TESTS
// ===========================================================================

describe('NotificationService', () => {
  // =========================================================================
  // createNotification
  // =========================================================================
  describe('createNotification', () => {
    it('creates a notification successfully (no taskId, default prefs)', async () => {
      const notification = makeNotification();

      // getPreferences -> no rows -> default prefs returned (no db.query call needed for defaults)
      mockDb.query
        // getPreferences: no existing row -> returns default prefs (success: true, id: '')
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
        // findGroupableNotification: no groupable notification
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
        // INSERT notification
        .mockResolvedValueOnce({ rows: [notification], rowCount: 1 } as never)
        // queueNotificationChannels: check for existing push outbox event
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
        // queueNotificationChannels: INSERT outbox_events
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
        // queueNotificationChannels: UPDATE notifications SET sent_at
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      const result = await NotificationService.createNotification({
        userId: USER_ID,
        category: 'task_accepted',
        title: 'Task Accepted',
        body: 'Your task has been accepted.',
        deepLink: 'hustlexp://tasks/task-xyz-789',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toBe(NOTIF_ID);
        expect(result.data.user_id).toBe(USER_ID);
        expect(result.data.category).toBe('task_accepted');
      }
    });

    it('creates a notification successfully with taskId when user is poster', async () => {
      const notification = makeNotification();

      mockDb.query
        // Task lookup (poster_id matches userId)
        .mockResolvedValueOnce({ rows: [{ poster_id: USER_ID, worker_id: 'other-user' }], rowCount: 1 } as never)
        // getPreferences: empty -> default prefs
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
        // findGroupableNotification
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
        // INSERT notification
        .mockResolvedValueOnce({ rows: [notification], rowCount: 1 } as never)
        // push outbox check
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
        // INSERT outbox_events
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
        // UPDATE sent_at
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      const result = await NotificationService.createNotification({
        userId: USER_ID,
        category: 'task_accepted',
        title: 'Task Accepted',
        body: 'Your task has been accepted.',
        deepLink: 'hustlexp://tasks/task-xyz-789',
        taskId: TASK_ID,
      });

      expect(result.success).toBe(true);
    });

    it('returns NOT_FOUND when taskId provided but task does not exist', async () => {
      mockDb.query
        // Task lookup returns nothing
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const result = await NotificationService.createNotification({
        userId: USER_ID,
        category: 'task_accepted',
        title: 'Task Accepted',
        body: 'Body',
        deepLink: 'hustlexp://tasks/missing',
        taskId: 'nonexistent-task',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('NOT_FOUND');
      }
    });

    it('returns FORBIDDEN when user is not a participant in the task', async () => {
      mockDb.query
        // Task found but neither poster_id nor worker_id match userId
        .mockResolvedValueOnce({ rows: [{ poster_id: 'other-poster', worker_id: 'other-worker' }], rowCount: 1 } as never);

      const result = await NotificationService.createNotification({
        userId: USER_ID,
        category: 'task_accepted',
        title: 'Task Accepted',
        body: 'Body',
        deepLink: 'hustlexp://tasks/task-xyz-789',
        taskId: TASK_ID,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('FORBIDDEN');
      }
    });

    it('returns PREFERENCE_DISABLED when category is disabled in preferences', async () => {
      const prefs = makePreferences({
        category_preferences: { task_accepted: { enabled: false } },
      });

      mockDb.query
        // getPreferences: returns prefs with disabled category
        .mockResolvedValueOnce({ rows: [prefs], rowCount: 1 } as never);

      const result = await NotificationService.createNotification({
        userId: USER_ID,
        category: 'task_accepted',
        title: 'Task Accepted',
        body: 'Body',
        deepLink: 'hustlexp://tasks/task-xyz-789',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('PREFERENCE_DISABLED');
      }
    });

    it('returns PREFERENCE_DISABLED when all channels are disabled (push disabled, no in_app)', async () => {
      const prefs = makePreferences({
        push_enabled: false,
        email_enabled: false,
        sms_enabled: false,
        category_preferences: {},
      });

      mockDb.query
        .mockResolvedValueOnce({ rows: [prefs], rowCount: 1 } as never);

      const result = await NotificationService.createNotification({
        userId: USER_ID,
        category: 'task_accepted',
        title: 'Task Accepted',
        body: 'Body',
        deepLink: 'hustlexp://tasks/task-xyz-789',
        channels: ['push'], // push is disabled and no in_app fallback
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('PREFERENCE_DISABLED');
      }
    });

    it('returns DB_ERROR when db.query throws during notification insert', async () => {
      mockDb.query
        // getPreferences: empty
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
        // findGroupableNotification
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
        // INSERT notification THROWS
        .mockRejectedValueOnce(new Error('DB Error: constraint violation'));

      const result = await NotificationService.createNotification({
        userId: USER_ID,
        category: 'task_accepted',
        title: 'Task Accepted',
        body: 'Body',
        deepLink: 'hustlexp://tasks/task-xyz-789',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('DB_ERROR');
        expect(result.error.message).toContain('DB Error');
      }
    });

    it('adds notification to existing group when a groupable notification exists', async () => {
      const notification = makeNotification({ group_id: 'existing-group', group_position: 2 });

      mockDb.query
        // getPreferences: empty -> default
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
        // findGroupableNotification: returns existing group with 1 item
        .mockResolvedValueOnce({
          rows: [{ group_id: 'existing-group', max_position: 1, group_size: '1' }],
          rowCount: 1,
        } as never)
        // INSERT notification
        .mockResolvedValueOnce({ rows: [notification], rowCount: 1 } as never)
        // push outbox check
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
        // INSERT outbox_events
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
        // UPDATE sent_at
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      const result = await NotificationService.createNotification({
        userId: USER_ID,
        category: 'task_accepted',
        title: 'Task Accepted',
        body: 'Body',
        deepLink: 'hustlexp://tasks/task-xyz-789',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.group_id).toBe('existing-group');
      }
    });
  });

  // =========================================================================
  // getUserNotifications
  // =========================================================================
  describe('getUserNotifications', () => {
    it('returns list of notifications for a user', async () => {
      const notifs = [makeNotification(), makeNotification({ id: 'notif-002' })];

      mockDb.query.mockResolvedValueOnce({ rows: notifs, rowCount: 2 } as never);

      const result = await NotificationService.getUserNotifications(USER_ID);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(2);
        expect(result.data[0].user_id).toBe(USER_ID);
      }
    });

    it('returns empty array when user has no notifications', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const result = await NotificationService.getUserNotifications(USER_ID);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(0);
      }
    });

    it('filters unread notifications when unreadOnly is true', async () => {
      const unreadNotif = makeNotification({ read_at: null });

      mockDb.query.mockResolvedValueOnce({ rows: [unreadNotif], rowCount: 1 } as never);

      const result = await NotificationService.getUserNotifications(USER_ID, 50, 0, true);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data[0].read_at).toBeNull();
      }

      // Verify the query included the unreadOnly filter
      const queryCall = mockDb.query.mock.calls[0];
      expect(queryCall[0]).toContain('read_at IS NULL');
    });

    it('respects limit and offset parameters', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      await NotificationService.getUserNotifications(USER_ID, 10, 20);

      const queryParams = mockDb.query.mock.calls[0][1] as unknown[];
      expect(queryParams).toContain(10); // limit
      expect(queryParams).toContain(20); // offset
    });

    it('returns DB_ERROR on query failure', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('Connection refused'));

      const result = await NotificationService.getUserNotifications(USER_ID);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('DB_ERROR');
        expect(result.error.message).toBe('Connection refused');
      }
    });
  });

  // =========================================================================
  // getUnreadCount
  // =========================================================================
  describe('getUnreadCount', () => {
    it('returns the unread notification count', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ count: '7' }], rowCount: 1 } as never);

      const result = await NotificationService.getUnreadCount(USER_ID);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe(7);
      }
    });

    it('returns 0 when user has no unread notifications', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 } as never);

      const result = await NotificationService.getUnreadCount(USER_ID);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe(0);
      }
    });

    it('returns 0 when rows is empty (safe fallback)', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const result = await NotificationService.getUnreadCount(USER_ID);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe(0);
      }
    });

    it('returns DB_ERROR on query failure', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('Timeout'));

      const result = await NotificationService.getUnreadCount(USER_ID);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('DB_ERROR');
      }
    });
  });

  // =========================================================================
  // getNotificationById
  // =========================================================================
  describe('getNotificationById', () => {
    it('returns notification when found and owned by user', async () => {
      const notification = makeNotification();

      mockDb.query.mockResolvedValueOnce({ rows: [notification], rowCount: 1 } as never);

      const result = await NotificationService.getNotificationById(NOTIF_ID, USER_ID);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toBe(NOTIF_ID);
        expect(result.data.user_id).toBe(USER_ID);
      }
    });

    it('returns NOT_FOUND when notification does not exist or belongs to another user', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const result = await NotificationService.getNotificationById('nonexistent', USER_ID);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('NOT_FOUND');
        expect(result.error.message).toContain('nonexistent');
      }
    });

    it('returns DB_ERROR on query failure', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('DB Error'));

      const result = await NotificationService.getNotificationById(NOTIF_ID, USER_ID);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('DB_ERROR');
      }
    });

    it('queries with both notificationId and userId for security', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      await NotificationService.getNotificationById(NOTIF_ID, USER_ID);

      const [, params] = mockDb.query.mock.calls[0];
      expect(params).toContain(NOTIF_ID);
      expect(params).toContain(USER_ID);
    });
  });

  // =========================================================================
  // markAsRead
  // =========================================================================
  describe('markAsRead', () => {
    it('marks a notification as read and returns updated notification', async () => {
      const readNotification = makeNotification({ read_at: new Date() });

      mockDb.query.mockResolvedValueOnce({ rows: [readNotification], rowCount: 1 } as never);

      const result = await NotificationService.markAsRead(NOTIF_ID, USER_ID);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.read_at).not.toBeNull();
      }
    });

    it('returns NOT_FOUND when notification is not found, already read, or belongs to another user', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const result = await NotificationService.markAsRead('nonexistent', USER_ID);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('NOT_FOUND');
        expect(result.error.message).toContain('nonexistent');
      }
    });

    it('returns DB_ERROR on query failure', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('Lock timeout'));

      const result = await NotificationService.markAsRead(NOTIF_ID, USER_ID);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('DB_ERROR');
        expect(result.error.message).toBe('Lock timeout');
      }
    });

    it('only marks notifications with read_at IS NULL', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      await NotificationService.markAsRead(NOTIF_ID, USER_ID);

      const [sql] = mockDb.query.mock.calls[0];
      expect(sql).toContain('read_at IS NULL');
    });
  });

  // =========================================================================
  // markAllAsRead
  // =========================================================================
  describe('markAllAsRead', () => {
    it('marks all unread notifications as read and returns count', async () => {
      // The service uses RETURNING COUNT(*) which returns one row per updated row
      // The implementation uses rows[0]?.count with a fallback of '0'
      mockDb.query.mockResolvedValueOnce({ rows: [{ count: '5' }], rowCount: 5 } as never);

      const result = await NotificationService.markAllAsRead(USER_ID);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.marked).toBe(5);
      }
    });

    it('returns 0 when no unread notifications exist', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const result = await NotificationService.markAllAsRead(USER_ID);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.marked).toBe(0);
      }
    });

    it('returns DB_ERROR on query failure', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('Deadlock detected'));

      const result = await NotificationService.markAllAsRead(USER_ID);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('DB_ERROR');
        expect(result.error.message).toBe('Deadlock detected');
      }
    });

    it('only marks non-expired notifications as read', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      await NotificationService.markAllAsRead(USER_ID);

      const [sql] = mockDb.query.mock.calls[0];
      expect(sql).toContain('expires_at');
      expect(sql).toContain('read_at IS NULL');
    });
  });

  // =========================================================================
  // markAsClicked
  // =========================================================================
  describe('markAsClicked', () => {
    it('marks a notification as clicked and returns updated notification', async () => {
      const clickedNotification = makeNotification({ clicked_at: new Date() });

      mockDb.query.mockResolvedValueOnce({ rows: [clickedNotification], rowCount: 1 } as never);

      const result = await NotificationService.markAsClicked(NOTIF_ID, USER_ID);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.clicked_at).not.toBeNull();
      }
    });

    it('returns NOT_FOUND when notification not found or belongs to another user', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const result = await NotificationService.markAsClicked('nonexistent', USER_ID);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('NOT_FOUND');
        expect(result.error.message).toContain('nonexistent');
      }
    });

    it('returns DB_ERROR on query failure', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('Query failed'));

      const result = await NotificationService.markAsClicked(NOTIF_ID, USER_ID);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('DB_ERROR');
      }
    });

    it('sets clicked_at regardless of whether notification was previously read', async () => {
      const readAndClicked = makeNotification({ read_at: new Date(), clicked_at: new Date() });

      mockDb.query.mockResolvedValueOnce({ rows: [readAndClicked], rowCount: 1 } as never);

      const result = await NotificationService.markAsClicked(NOTIF_ID, USER_ID);

      // Unlike markAsRead, markAsClicked does not filter by clicked_at IS NULL
      expect(result.success).toBe(true);
      const [sql] = mockDb.query.mock.calls[0];
      expect(sql).not.toContain('clicked_at IS NULL');
    });
  });

  // =========================================================================
  // getPreferences
  // =========================================================================
  describe('getPreferences', () => {
    it('returns preferences when they exist in the database', async () => {
      const prefs = makePreferences();

      mockDb.query.mockResolvedValueOnce({ rows: [prefs], rowCount: 1 } as never);

      const result = await NotificationService.getPreferences(USER_ID);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.user_id).toBe(USER_ID);
        expect(result.data.id).toBe('pref-001');
        expect(result.data.push_enabled).toBe(true);
        expect(result.data.email_enabled).toBe(false);
      }
    });

    it('returns default preferences when none exist in the database', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const result = await NotificationService.getPreferences(USER_ID);

      expect(result.success).toBe(true);
      if (result.success) {
        // Default values per service implementation
        expect(result.data.user_id).toBe(USER_ID);
        expect(result.data.id).toBe(''); // Empty id signals defaults
        expect(result.data.quiet_hours_enabled).toBe(true);
        expect(result.data.quiet_hours_start).toBe('22:00:00');
        expect(result.data.quiet_hours_end).toBe('07:00:00');
        expect(result.data.push_enabled).toBe(true);
        expect(result.data.email_enabled).toBe(false);
        expect(result.data.sms_enabled).toBe(false);
        expect(result.data.category_preferences).toEqual({});
      }
    });

    it('returns DB_ERROR on query failure', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('Table not found'));

      const result = await NotificationService.getPreferences(USER_ID);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('DB_ERROR');
        expect(result.error.message).toBe('Table not found');
      }
    });

    it('queries the notification_preferences table for the correct user', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      await NotificationService.getPreferences(USER_ID);

      const [sql, params] = mockDb.query.mock.calls[0];
      expect(sql).toContain('notification_preferences');
      expect(params).toContain(USER_ID);
    });
  });

  // =========================================================================
  // updatePreferences
  // =========================================================================
  describe('updatePreferences', () => {
    it('creates new preferences when none exist', async () => {
      const newPrefs = makePreferences({ id: 'new-pref-id' });

      mockDb.query
        // getPreferences: no existing row
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
        // INSERT new preferences
        .mockResolvedValueOnce({ rows: [newPrefs], rowCount: 1 } as never);

      const result = await NotificationService.updatePreferences({
        userId: USER_ID,
        pushEnabled: true,
        emailEnabled: true,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.user_id).toBe(USER_ID);
      }
    });

    it('updates existing preferences', async () => {
      const existingPrefs = makePreferences();
      const updatedPrefs = makePreferences({ email_enabled: true });

      mockDb.query
        // getPreferences: existing row
        .mockResolvedValueOnce({ rows: [existingPrefs], rowCount: 1 } as never)
        // UPDATE preferences
        .mockResolvedValueOnce({ rows: [updatedPrefs], rowCount: 1 } as never);

      const result = await NotificationService.updatePreferences({
        userId: USER_ID,
        emailEnabled: true,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.email_enabled).toBe(true);
      }
    });

    it('returns existing preferences unchanged when no update fields are provided', async () => {
      const existingPrefs = makePreferences();

      mockDb.query
        // getPreferences: existing row with a valid id
        .mockResolvedValueOnce({ rows: [existingPrefs], rowCount: 1 } as never);

      const result = await NotificationService.updatePreferences({
        userId: USER_ID,
        // No update fields
      });

      expect(result.success).toBe(true);
      // Only one query should have been made (getPreferences), no update
      expect(mockDb.query).toHaveBeenCalledTimes(1);
    });

    it('updates quietHoursEnabled and time fields', async () => {
      const existingPrefs = makePreferences();
      const updatedPrefs = makePreferences({
        quiet_hours_enabled: false,
        quiet_hours_start: '23:00:00',
        quiet_hours_end: '06:00:00',
      });

      mockDb.query
        .mockResolvedValueOnce({ rows: [existingPrefs], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [updatedPrefs], rowCount: 1 } as never);

      const result = await NotificationService.updatePreferences({
        userId: USER_ID,
        quietHoursEnabled: false,
        quietHoursStart: '23:00:00',
        quietHoursEnd: '06:00:00',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.quiet_hours_enabled).toBe(false);
      }
    });

    it('returns DB_ERROR on query failure during update', async () => {
      const existingPrefs = makePreferences();

      mockDb.query
        // getPreferences succeeds
        .mockResolvedValueOnce({ rows: [existingPrefs], rowCount: 1 } as never)
        // UPDATE throws
        .mockRejectedValueOnce(new Error('Update failed'));

      const result = await NotificationService.updatePreferences({
        userId: USER_ID,
        smsEnabled: true,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('DB_ERROR');
      }
    });
  });

  // =========================================================================
  // cleanupExpiredNotifications
  // =========================================================================
  describe('cleanupExpiredNotifications', () => {
    it('deletes expired notifications and returns count', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ count: '12' }], rowCount: 12 } as never);

      const result = await NotificationService.cleanupExpiredNotifications();

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.deleted).toBe(12);
      }
    });

    it('returns 0 deleted when no expired notifications exist', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const result = await NotificationService.cleanupExpiredNotifications();

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.deleted).toBe(0);
      }
    });

    it('returns DB_ERROR on query failure', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('Permission denied'));

      const result = await NotificationService.cleanupExpiredNotifications();

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('DB_ERROR');
      }
    });

    it('uses 30-day threshold for deletion', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      await NotificationService.cleanupExpiredNotifications();

      const [sql] = mockDb.query.mock.calls[0];
      expect(sql).toContain('30 days');
      expect(sql).toContain('DELETE FROM notifications');
    });
  });

  // =========================================================================
  // getRecentNotificationCount
  // =========================================================================
  describe('getRecentNotificationCount', () => {
    it('returns the count of recent notifications for a category', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ count: '3' }], rowCount: 1 } as never);

      const count = await NotificationService.getRecentNotificationCount(USER_ID, 'task_accepted', 60);

      expect(count).toBe(3);
    });

    it('returns 0 when no recent notifications exist', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 } as never);

      const count = await NotificationService.getRecentNotificationCount(USER_ID, 'task_accepted', 60);

      expect(count).toBe(0);
    });

    it('returns 0 (fail open) when query throws an error', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('Network error'));

      const count = await NotificationService.getRecentNotificationCount(USER_ID, 'task_accepted', 60);

      // Fail open: return 0 to allow notification
      expect(count).toBe(0);
    });

    it('queries with the correct userId, category, and minute interval', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 } as never);

      await NotificationService.getRecentNotificationCount(USER_ID, 'badge_earned', 30);

      const [sql, params] = mockDb.query.mock.calls[0];
      expect(params).toContain(USER_ID);
      expect(params).toContain('badge_earned');
      expect(params).toContain(30);
      expect(sql).toContain("INTERVAL '1 minute'");
    });
  });
});
