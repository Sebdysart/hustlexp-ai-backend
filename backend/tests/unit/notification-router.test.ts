/**
 * Notification Router Unit Tests — notification.getList offset-based pagination
 *
 * Tests that notification.getList returns a plain array (result.data from
 * NotificationService.getUserNotifications) with offset-based pagination.
 *
 * Pattern: mock NotificationService at module level, use createCaller with a
 * fake protected context to bypass middleware, then call getList directly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must come before any imports that transitively touch these modules
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
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
  escrowLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('../../src/services/NotificationService', () => ({
  NotificationService: {
    getUserNotifications: vi.fn(),
    getUnreadCount: vi.fn(),
    getNotificationById: vi.fn(),
    markAsRead: vi.fn(),
    markAllAsRead: vi.fn(),
    markAsClicked: vi.fn(),
    getPreferences: vi.fn(),
    updatePreferences: vi.fn(),
  },
}));

vi.mock('../../src/services/PushNotificationService', () => ({
  sendPushNotification: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { NotificationService } from '../../src/services/NotificationService';
import { notificationRouter } from '../../src/routers/notification';

const mockNotificationService = vi.mocked(NotificationService);

// ---------------------------------------------------------------------------
// Row type and helpers
// ---------------------------------------------------------------------------

type NotificationRow = {
  id: string;
  user_id: string;
  type: string;
  title: string;
  body: string | null;
  read_at: Date | null;
  created_at: Date;
  data: Record<string, unknown> | null;
};

function makeNotification(overrides: Partial<NotificationRow & { id: string }> = {}): NotificationRow {
  const id = overrides.id ?? `notif-${Math.random().toString(36).slice(2, 10)}`;
  return {
    id,
    user_id: 'user-abc',
    type: 'task_assigned',
    title: 'New Task',
    body: 'You have been assigned a task',
    read_at: null,
    created_at: new Date('2025-01-01T00:00:00Z'),
    data: null,
    ...overrides,
  };
}

/**
 * Create a tRPC caller for the notification router with a pre-authenticated
 * user context. protectedProcedure only checks ctx.user — no extra DB call.
 */
function makeUserCaller(userId = 'user-abc') {
  const fakeUser = {
    id: userId,
    email: 'user@hustlexp.com',
    full_name: 'Test User',
    role: 'hustler',
    firebase_uid: 'fb-user',
  };
  return notificationRouter.createCaller({
    user: fakeUser as any,
    firebaseUid: 'fb-user',
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('notification.getList — offset-based pagination (returns array)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. Return shape — plain array (from service result.data)
  // -------------------------------------------------------------------------

  describe('return shape', () => {
    it('returns an array (not { items, nextCursor })', async () => {
      mockNotificationService.getUserNotifications.mockResolvedValueOnce({
        success: true,
        data: [makeNotification({ id: 'aaa' })],
      } as any);

      const result = await makeUserCaller().getList({ limit: 20, offset: 0, unreadOnly: false });

      expect(Array.isArray(result)).toBe(true);
    });

    it('returns notification objects from the service', async () => {
      const notifs = [makeNotification({ id: 'aaa', title: 'Test Notification' })];
      mockNotificationService.getUserNotifications.mockResolvedValueOnce({
        success: true,
        data: notifs,
      } as any);

      const result = await makeUserCaller().getList({ limit: 20, offset: 0, unreadOnly: false });

      expect(result).toHaveLength(1);
      expect(result[0].title).toBe('Test Notification');
    });
  });

  // -------------------------------------------------------------------------
  // 2. Pagination — limit/offset passed to service
  // -------------------------------------------------------------------------

  describe('pagination', () => {
    it('passes limit and offset to NotificationService.getUserNotifications', async () => {
      mockNotificationService.getUserNotifications.mockResolvedValueOnce({
        success: true,
        data: [],
      } as any);

      await makeUserCaller().getList({ limit: 25, offset: 10, unreadOnly: false });

      expect(mockNotificationService.getUserNotifications).toHaveBeenCalledWith(
        'user-abc',
        25,
        10,
        false
      );
    });

    it('uses default limit=50 and offset=0 when not explicitly provided', async () => {
      mockNotificationService.getUserNotifications.mockResolvedValueOnce({
        success: true,
        data: [],
      } as any);

      // Zod defaults: limit=50, offset=0, unreadOnly=false
      await makeUserCaller().getList({});

      expect(mockNotificationService.getUserNotifications).toHaveBeenCalledWith(
        'user-abc',
        50,
        0,
        false
      );
    });
  });

  // -------------------------------------------------------------------------
  // 3. Empty result
  // -------------------------------------------------------------------------

  describe('empty result', () => {
    it('returns empty array when no results', async () => {
      mockNotificationService.getUserNotifications.mockResolvedValueOnce({
        success: true,
        data: [],
      } as any);

      const result = await makeUserCaller().getList({ limit: 20, offset: 0, unreadOnly: false });

      expect(result).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Multiple items
  // -------------------------------------------------------------------------

  describe('multiple items', () => {
    it('returns multiple notifications in the array', async () => {
      const notifs = [
        makeNotification({ id: 'aaa', title: 'Notif A' }),
        makeNotification({ id: 'bbb', title: 'Notif B' }),
        makeNotification({ id: 'ccc', title: 'Notif C' }),
      ];
      mockNotificationService.getUserNotifications.mockResolvedValueOnce({
        success: true,
        data: notifs,
      } as any);

      const result = await makeUserCaller().getList({ limit: 50, offset: 0, unreadOnly: false });

      expect(result).toHaveLength(3);
      expect(result.map((n: any) => n.id)).toEqual(['aaa', 'bbb', 'ccc']);
    });
  });

  // -------------------------------------------------------------------------
  // 5. unreadOnly filter
  // -------------------------------------------------------------------------

  describe('unreadOnly filter', () => {
    it('passes unreadOnly=true to the service', async () => {
      mockNotificationService.getUserNotifications.mockResolvedValueOnce({
        success: true,
        data: [],
      } as any);

      await makeUserCaller().getList({ limit: 20, offset: 0, unreadOnly: true });

      expect(mockNotificationService.getUserNotifications).toHaveBeenCalledWith(
        'user-abc',
        20,
        0,
        true
      );
    });

    it('passes unreadOnly=false to the service', async () => {
      mockNotificationService.getUserNotifications.mockResolvedValueOnce({
        success: true,
        data: [],
      } as any);

      await makeUserCaller().getList({ limit: 20, offset: 0, unreadOnly: false });

      expect(mockNotificationService.getUserNotifications).toHaveBeenCalledWith(
        'user-abc',
        20,
        0,
        false
      );
    });
  });

  // -------------------------------------------------------------------------
  // 6. Service error propagation
  // -------------------------------------------------------------------------

  describe('service error', () => {
    it('throws INTERNAL_SERVER_ERROR when service returns failure', async () => {
      mockNotificationService.getUserNotifications.mockResolvedValueOnce({
        success: false,
        error: { code: 'DB_ERROR', message: 'Database connection lost' },
      } as any);

      await expect(
        makeUserCaller().getList({ limit: 20, offset: 0, unreadOnly: false })
      ).rejects.toThrow('Database connection lost');
    });
  });
});
