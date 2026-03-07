/**
 * Notification Router Unit Tests — notification.getList cursor-based pagination
 *
 * Tests that notification.getList returns { items, nextCursor } with correct
 * cursor-based pagination semantics.
 *
 * Pattern: mock db at module level, use createCaller with a fake protected
 * context to bypass middleware, then call getList directly.
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

import { db } from '../../src/db';
import { notificationRouter } from '../../src/routers/notification';

const mockDb = vi.mocked(db);

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

/**
 * Set up the mock so db.query returns `rows` for the getList query.
 * protectedProcedure does NOT make a DB call itself, so this is the first call.
 */
function setupNotifications(rows: NotificationRow[]) {
  mockDb.query.mockResolvedValueOnce({ rows, rowCount: rows.length } as any);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('notification.getList — cursor-based pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. Return shape
  // -------------------------------------------------------------------------

  describe('return shape', () => {
    it('returns { items, nextCursor } shape', async () => {
      setupNotifications([makeNotification({ id: 'aaa' })]);

      const result = await makeUserCaller().getList({ limit: 20 });

      expect(result).toHaveProperty('items');
      expect(result).toHaveProperty('nextCursor');
    });

    it('items is an array of notification objects', async () => {
      const notifs = [makeNotification({ id: 'aaa', title: 'Test Notification' })];
      setupNotifications(notifs);

      const result = await makeUserCaller().getList({ limit: 20 });

      expect(Array.isArray(result.items)).toBe(true);
      expect(result.items).toHaveLength(1);
      expect(result.items[0].title).toBe('Test Notification');
    });
  });

  // -------------------------------------------------------------------------
  // 2. nextCursor: null when total results <= limit (last page)
  // -------------------------------------------------------------------------

  describe('nextCursor — last page', () => {
    it('is null when results < limit', async () => {
      const notifs = [makeNotification(), makeNotification(), makeNotification()];
      setupNotifications(notifs);

      const result = await makeUserCaller().getList({ limit: 50 });

      expect(result.nextCursor).toBeNull();
      expect(result.items).toHaveLength(3);
    });

    it('is null when results exactly equal limit (no sentinel row returned)', async () => {
      // limit=2, DB returned exactly 2 rows — no sentinel, so no next page
      const notifs = [makeNotification({ id: 'aaa' }), makeNotification({ id: 'bbb' })];
      setupNotifications(notifs);

      const result = await makeUserCaller().getList({ limit: 2 });

      expect(result.nextCursor).toBeNull();
      expect(result.items).toHaveLength(2);
    });

    it('is null for empty result set', async () => {
      setupNotifications([]);

      const result = await makeUserCaller().getList({ limit: 20 });

      expect(result.items).toHaveLength(0);
      expect(result.nextCursor).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // 3. nextCursor: non-null when more results exist
  // -------------------------------------------------------------------------

  describe('nextCursor — more pages exist', () => {
    it('is the created_at ISO timestamp of the last visible item when there is a next page', async () => {
      // limit=2, DB returns 3 rows (limit+1) → sentinel detected
      const notifs = [
        makeNotification({ id: 'id-aaa', created_at: new Date('2024-01-03T00:00:00.000Z') }),
        makeNotification({ id: 'id-bbb', created_at: new Date('2024-01-02T00:00:00.000Z') }),
        makeNotification({ id: 'id-ccc', created_at: new Date('2024-01-01T00:00:00.000Z') }), // sentinel row
      ];
      setupNotifications(notifs);

      const result = await makeUserCaller().getList({ limit: 2 });

      expect(result.nextCursor).toBe('2024-01-02T00:00:00.000Z'); // created_at of last visible item
      expect(result.items).toHaveLength(2);      // sentinel excluded from items
      expect(result.items.map((n: NotificationRow) => n.id)).toEqual(['id-aaa', 'id-bbb']);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Cursor condition passed to SQL when cursor provided
  // -------------------------------------------------------------------------

  describe('cursor forwarding', () => {
    it('passes created_at < cursor condition to SQL when cursor provided', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeUserCaller().getList({
        cursor: '2024-01-01T00:00:00.000Z',
        limit: 5,
      });

      const [sql, params] = (mockDb.query as any).mock.calls[0];

      expect(sql).toContain('created_at <');
      expect(params).toContain('2024-01-01T00:00:00.000Z');
    });

    // -----------------------------------------------------------------------
    // 5. No cursor WHERE clause when cursor is undefined
    // -----------------------------------------------------------------------

    it('does NOT add cursor WHERE clause when cursor is undefined', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeUserCaller().getList({ limit: 10 });

      const [sql] = (mockDb.query as any).mock.calls[0];
      // No cursor condition should appear
      expect(sql).not.toMatch(/created_at\s*</);
    });
  });

  // -------------------------------------------------------------------------
  // 6. limit+1 sentinel plumbing
  // -------------------------------------------------------------------------

  describe('limit sentinel', () => {
    it('plumbs limit+1 to DB query as sentinel', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeUserCaller().getList({ limit: 20 });

      const [, params] = (mockDb.query as any).mock.calls[0];
      // params[0] = user_id ($1), params[1] = limit+1 ($2)
      expect(params[1]).toBe(21);
    });

    it('queries DB for 3 rows when limit=2', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeUserCaller().getList({ limit: 2 });

      const [, params] = (mockDb.query as any).mock.calls[0];
      expect(params[1]).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // 7. unreadOnly filter
  // -------------------------------------------------------------------------

  describe('unreadOnly filter', () => {
    it('adds read_at IS NULL condition when unreadOnly=true', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeUserCaller().getList({ limit: 20, unreadOnly: true });

      const [sql] = (mockDb.query as any).mock.calls[0];
      expect(sql).toContain('read_at IS NULL');
    });

    it('does not add read_at IS NULL when unreadOnly=false', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeUserCaller().getList({ limit: 20, unreadOnly: false });

      const [sql] = (mockDb.query as any).mock.calls[0];
      expect(sql).not.toContain('read_at IS NULL');
    });
  });

  // -------------------------------------------------------------------------
  // 8. Default limit is 20
  // -------------------------------------------------------------------------

  describe('default limit', () => {
    it('uses default limit of 20 when limit is not provided', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      // Call without limit — Zod default(20) should apply
      await makeUserCaller().getList({});

      const [, params] = (mockDb.query as any).mock.calls[0];
      // limit+1 sentinel = 21
      expect(params[1]).toBe(21);
    });
  });
});
