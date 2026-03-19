/**
 * Notification Router Extra Unit Tests
 *
 * Covers branches NOT in notification-router.test.ts:
 * - getUnreadCount (success, service error)
 * - getById (success, NOT_FOUND, FORBIDDEN, service error)
 * - markAsRead (success, NOT_FOUND, FORBIDDEN, service error)
 * - markAllAsRead (success, service error)
 * - markAsClicked (success, NOT_FOUND, FORBIDDEN)
 * - getPreferences (success, service error)
 * - updatePreferences (success, service error)
 * - registerDeviceToken (success, error)
 * - unregisterDeviceToken (success, NOT_FOUND, error)
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
import { NotificationService } from '../../src/services/NotificationService';
import { notificationRouter } from '../../src/routers/notification';

const mockDb = vi.mocked(db);
const mockNS = vi.mocked(NotificationService);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_UUID  = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const NOTIF_UUID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function makeCaller(userId = USER_UUID) {
  return notificationRouter.createCaller({
    user: {
      id: userId,
      email: 'user@hustlexp.com',
      full_name: 'Test User',
      role: 'hustler',
      firebase_uid: 'fb-user',
    } as any,
    firebaseUid: 'fb-user',
  });
}

function makeAdminCaller() {
  mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);
  return notificationRouter.createCaller({
    user: {
      id: USER_UUID,
      email: 'admin@hustlexp.com',
      full_name: 'Admin User',
      role: 'admin',
      firebase_uid: 'fb-admin',
    } as any,
    firebaseUid: 'fb-admin',
  });
}

// ---------------------------------------------------------------------------
// getUnreadCount
// ---------------------------------------------------------------------------

describe('notification.getUnreadCount', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns count when service succeeds', async () => {
    mockNS.getUnreadCount.mockResolvedValueOnce({ success: true, data: 7 } as any);

    const result = await makeCaller().getUnreadCount();

    expect(result.count).toBe(7);
    expect(mockNS.getUnreadCount).toHaveBeenCalledWith(USER_UUID);
  });

  it('throws INTERNAL_SERVER_ERROR when service fails', async () => {
    mockNS.getUnreadCount.mockResolvedValueOnce({
      success: false,
      error: { code: 'DB_ERROR', message: 'Connection timeout' },
    } as any);

    await expect(makeCaller().getUnreadCount()).rejects.toThrow('Connection timeout');
  });

  it('returns 0 when no unread notifications', async () => {
    mockNS.getUnreadCount.mockResolvedValueOnce({ success: true, data: 0 } as any);

    const result = await makeCaller().getUnreadCount();
    expect(result.count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getById
// ---------------------------------------------------------------------------

describe('notification.getById', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns notification on success', async () => {
    const notif = { id: NOTIF_UUID, title: 'Test', type: 'task_assigned' };
    mockNS.getNotificationById.mockResolvedValueOnce({ success: true, data: notif } as any);

    const result = await makeCaller().getById({ notificationId: NOTIF_UUID });

    expect(result).toEqual(notif);
    expect(mockNS.getNotificationById).toHaveBeenCalledWith(NOTIF_UUID, USER_UUID);
  });

  it('throws NOT_FOUND error', async () => {
    mockNS.getNotificationById.mockResolvedValueOnce({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Notification not found' },
    } as any);

    await expect(makeCaller().getById({ notificationId: NOTIF_UUID }))
      .rejects.toThrow('Notification not found');
  });

  it('throws FORBIDDEN error', async () => {
    mockNS.getNotificationById.mockResolvedValueOnce({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Access denied' },
    } as any);

    await expect(makeCaller().getById({ notificationId: NOTIF_UUID }))
      .rejects.toThrow('Access denied');
  });

  it('throws INTERNAL_SERVER_ERROR for other errors', async () => {
    mockNS.getNotificationById.mockResolvedValueOnce({
      success: false,
      error: { code: 'DB_ERROR', message: 'Database error' },
    } as any);

    await expect(makeCaller().getById({ notificationId: NOTIF_UUID }))
      .rejects.toThrow('Database error');
  });
});

// ---------------------------------------------------------------------------
// markAsRead
// ---------------------------------------------------------------------------

describe('notification.markAsRead', () => {
  beforeEach(() => vi.clearAllMocks());

  it('marks notification as read on success', async () => {
    const data = { id: NOTIF_UUID, read_at: new Date() };
    mockNS.markAsRead.mockResolvedValueOnce({ success: true, data } as any);

    const result = await makeCaller().markAsRead({ notificationId: NOTIF_UUID });

    expect(result).toEqual(data);
    expect(mockNS.markAsRead).toHaveBeenCalledWith(NOTIF_UUID, USER_UUID);
  });

  it('throws NOT_FOUND when notification not found', async () => {
    mockNS.markAsRead.mockResolvedValueOnce({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Notification not found' },
    } as any);

    await expect(makeCaller().markAsRead({ notificationId: NOTIF_UUID }))
      .rejects.toThrow('Notification not found');
  });

  it('throws FORBIDDEN when notification belongs to another user', async () => {
    mockNS.markAsRead.mockResolvedValueOnce({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Cannot mark others notifications' },
    } as any);

    await expect(makeCaller().markAsRead({ notificationId: NOTIF_UUID }))
      .rejects.toThrow('Cannot mark others notifications');
  });

  it('throws INTERNAL_SERVER_ERROR for generic errors', async () => {
    mockNS.markAsRead.mockResolvedValueOnce({
      success: false,
      error: { code: 'GENERIC', message: 'Something went wrong' },
    } as any);

    await expect(makeCaller().markAsRead({ notificationId: NOTIF_UUID }))
      .rejects.toThrow('Something went wrong');
  });
});

// ---------------------------------------------------------------------------
// markAllAsRead
// ---------------------------------------------------------------------------

describe('notification.markAllAsRead', () => {
  beforeEach(() => vi.clearAllMocks());

  it('marks all as read and returns data', async () => {
    const data = { updatedCount: 5 };
    mockNS.markAllAsRead.mockResolvedValueOnce({ success: true, data } as any);

    const result = await makeCaller().markAllAsRead();

    expect(result).toEqual(data);
    expect(mockNS.markAllAsRead).toHaveBeenCalledWith(USER_UUID);
  });

  it('throws INTERNAL_SERVER_ERROR on service failure', async () => {
    mockNS.markAllAsRead.mockResolvedValueOnce({
      success: false,
      error: { code: 'DB_ERROR', message: 'Update failed' },
    } as any);

    await expect(makeCaller().markAllAsRead()).rejects.toThrow('Update failed');
  });
});

// ---------------------------------------------------------------------------
// markAsClicked
// ---------------------------------------------------------------------------

describe('notification.markAsClicked', () => {
  beforeEach(() => vi.clearAllMocks());

  it('marks notification as clicked on success', async () => {
    const data = { id: NOTIF_UUID, clicked_at: new Date() };
    mockNS.markAsClicked.mockResolvedValueOnce({ success: true, data } as any);

    const result = await makeCaller().markAsClicked({ notificationId: NOTIF_UUID });

    expect(result).toEqual(data);
    expect(mockNS.markAsClicked).toHaveBeenCalledWith(NOTIF_UUID, USER_UUID);
  });

  it('throws NOT_FOUND when notification not found', async () => {
    mockNS.markAsClicked.mockResolvedValueOnce({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Not found' },
    } as any);

    await expect(makeCaller().markAsClicked({ notificationId: NOTIF_UUID }))
      .rejects.toThrow('Not found');
  });

  it('throws FORBIDDEN when not authorized', async () => {
    mockNS.markAsClicked.mockResolvedValueOnce({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Forbidden' },
    } as any);

    await expect(makeCaller().markAsClicked({ notificationId: NOTIF_UUID }))
      .rejects.toThrow('Forbidden');
  });
});

// ---------------------------------------------------------------------------
// getPreferences
// ---------------------------------------------------------------------------

describe('notification.getPreferences', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns preferences on success', async () => {
    const data = { pushEnabled: true, emailEnabled: false, quietHoursEnabled: false };
    mockNS.getPreferences.mockResolvedValueOnce({ success: true, data } as any);

    const result = await makeCaller().getPreferences();

    expect(result).toEqual(data);
    expect(mockNS.getPreferences).toHaveBeenCalledWith(USER_UUID);
  });

  it('throws INTERNAL_SERVER_ERROR on service failure', async () => {
    mockNS.getPreferences.mockResolvedValueOnce({
      success: false,
      error: { code: 'DB_ERROR', message: 'Preferences load failed' },
    } as any);

    await expect(makeCaller().getPreferences()).rejects.toThrow('Preferences load failed');
  });
});

// ---------------------------------------------------------------------------
// updatePreferences
// ---------------------------------------------------------------------------

describe('notification.updatePreferences', () => {
  beforeEach(() => vi.clearAllMocks());

  it('updates preferences and returns data', async () => {
    const data = { pushEnabled: false, emailEnabled: true };
    mockNS.updatePreferences.mockResolvedValueOnce({ success: true, data } as any);

    const result = await makeCaller().updatePreferences({
      pushEnabled: false,
      emailEnabled: true,
    });

    expect(result).toEqual(data);
    expect(mockNS.updatePreferences).toHaveBeenCalledWith({
      userId: USER_UUID,
      pushEnabled: false,
      emailEnabled: true,
    });
  });

  it('passes all preference fields to service', async () => {
    mockNS.updatePreferences.mockResolvedValueOnce({ success: true, data: {} } as any);

    await makeCaller().updatePreferences({
      quietHoursEnabled: true,
      quietHoursStart: '22:00:00',
      quietHoursEnd: '08:00:00',
      pushEnabled: true,
      emailEnabled: false,
      smsEnabled: false,
    });

    const [call] = mockNS.updatePreferences.mock.calls[0];
    expect(call.quietHoursEnabled).toBe(true);
    expect(call.quietHoursStart).toBe('22:00:00');
    expect(call.userId).toBe(USER_UUID);
  });

  it('throws INTERNAL_SERVER_ERROR on service failure', async () => {
    mockNS.updatePreferences.mockResolvedValueOnce({
      success: false,
      error: { code: 'DB_ERROR', message: 'Update failed' },
    } as any);

    await expect(makeCaller().updatePreferences({ pushEnabled: true }))
      .rejects.toThrow('Update failed');
  });
});

// ---------------------------------------------------------------------------
// registerDeviceToken
// ---------------------------------------------------------------------------

describe('notification.registerDeviceToken', () => {
  beforeEach(() => vi.clearAllMocks());

  it('registers device token and returns row', async () => {
    const row = {
      id: 'token-id',
      user_id: USER_UUID,
      fcm_token: 'fcm-abc123',
      device_type: 'ios',
      device_name: 'iPhone 16',
      app_version: '1.0.0',
      is_active: true,
      created_at: new Date(),
      updated_at: new Date(),
    };
    // First call: COUNT query for token cap check (0 existing → no eviction)
    mockDb.query.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 } as any);
    // Second call: UPSERT
    mockDb.query.mockResolvedValueOnce({ rows: [row], rowCount: 1 } as any);

    const result = await makeCaller().registerDeviceToken({
      fcmToken: 'fcm-abc123',
      deviceType: 'ios',
      deviceName: 'iPhone 16',
      appVersion: '1.0.0',
    });

    expect(result.fcm_token).toBe('fcm-abc123');
    expect(result.device_type).toBe('ios');
    expect(result.is_active).toBe(true);
  });

  it('upserts if token already exists (uses ON CONFLICT)', async () => {
    const row = {
      id: 'token-id',
      user_id: USER_UUID,
      fcm_token: 'existing-token',
      device_type: 'android',
      device_name: null,
      app_version: null,
      is_active: true,
      created_at: new Date(),
      updated_at: new Date(),
    };
    // First call: COUNT query for token cap check (0 other active tokens)
    mockDb.query.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 } as any);
    // Second call: UPSERT
    mockDb.query.mockResolvedValueOnce({ rows: [row], rowCount: 1 } as any);

    const result = await makeCaller().registerDeviceToken({
      fcmToken: 'existing-token',
      deviceType: 'android',
    });

    // calls[1] is the UPSERT (calls[0] is the COUNT)
    const [sql] = (mockDb.query as any).mock.calls[1];
    expect(sql).toContain('ON CONFLICT');
    expect(result.is_active).toBe(true);
  });

  it('uses null for optional fields when not provided', async () => {
    const row = {
      id: 'token-id', user_id: USER_UUID, fcm_token: 'tok', device_type: 'ios',
      device_name: null, app_version: null, is_active: true,
      created_at: new Date(), updated_at: new Date(),
    };
    // First call: COUNT query for token cap check (0 existing → no eviction)
    mockDb.query.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 } as any);
    // Second call: UPSERT
    mockDb.query.mockResolvedValueOnce({ rows: [row], rowCount: 1 } as any);

    await makeCaller().registerDeviceToken({ fcmToken: 'tok' });

    // calls[1] is the UPSERT (calls[0] is the COUNT); params are positional
    const [, params] = (mockDb.query as any).mock.calls[1];
    expect(params[3]).toBeNull(); // deviceName
    expect(params[4]).toBeNull(); // appVersion
  });

  it('throws INTERNAL_SERVER_ERROR on DB error', async () => {
    mockDb.query.mockRejectedValueOnce(new Error('DB insert failed'));

    await expect(
      makeCaller().registerDeviceToken({ fcmToken: 'tok' })
    ).rejects.toThrow('DB insert failed');
  });
});

// ---------------------------------------------------------------------------
// unregisterDeviceToken
// ---------------------------------------------------------------------------

describe('notification.unregisterDeviceToken', () => {
  beforeEach(() => vi.clearAllMocks());

  it('deactivates token and returns success', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'token-id' }], rowCount: 1 } as any);

    const result = await makeCaller().unregisterDeviceToken({ fcmToken: 'fcm-abc' });

    expect(result.success).toBe(true);
    const [sql, params] = (mockDb.query as any).mock.calls[0];
    expect(sql).toContain('is_active = false');
    expect(params).toContain(USER_UUID);
    expect(params).toContain('fcm-abc');
  });

  it('throws NOT_FOUND when token not found for user', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await expect(
      makeCaller().unregisterDeviceToken({ fcmToken: 'nonexistent' })
    ).rejects.toThrow('Device token not found for this user');
  });

  it('throws INTERNAL_SERVER_ERROR on DB error', async () => {
    mockDb.query.mockRejectedValueOnce(new Error('Connection lost'));

    await expect(
      makeCaller().unregisterDeviceToken({ fcmToken: 'tok' })
    ).rejects.toThrow('Connection lost');
  });
});
