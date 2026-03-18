/**
 * Low-Coverage Routers — Batch Unit Tests
 *
 * Routers covered (all previously < 32% line coverage):
 *   1. betaDashboardRouter  (betaDashboard.ts  — 8%)
 *   2. notificationRouter   (notification.ts   — 9%)
 *   3. instantRouter        (instant.ts        — 11%)
 *   4. expertiseSupplyRouter (expertiseSupply.ts — 15%)
 *   5. liveRouter           (live.ts           — 32%)
 *
 * Pattern (matches admin-router.test.ts):
 *   - vi.mock all module-level dependencies BEFORE imports
 *   - Each router is tested via its own .createCaller()
 *   - Admin routers need a mock admin_roles DB check (first db.query call)
 *   - Protected routers just need ctx.user to be non-null
 *   - 5-8 tests per router, separate describe blocks
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — declared before any imports that transitively load these modules
// ---------------------------------------------------------------------------

vi.mock('../../src/db', () => ({
  db: { query: vi.fn() },
}));

vi.mock('../../src/auth/firebase', () => ({
  firebaseAuth: { verifyIdToken: vi.fn() },
}));

vi.mock('../../src/logger', () => ({
  logger: {
    child: () => ({
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    }),
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
  escrowLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

// --- betaDashboard service mocks ---
vi.mock('../../src/services/BetaService', () => ({
  BetaService: {
    getBetaMetrics: vi.fn(),
    getBetaStatus: vi.fn(),
    getKillSignals: vi.fn(),
    logBetaStateChange: vi.fn(),
  },
}));

vi.mock('../../src/services/RevenueService', () => ({
  RevenueService: {
    getRevenueSummary: vi.fn(),
    getMonthlyPnl: vi.fn(),
    verifyLedgerIntegrity: vi.fn(),
  },
}));

vi.mock('../../src/services/ChargebackService', () => ({
  ChargebackService: {
    getPlatformDisputeRate: vi.fn(),
  },
}));

// --- notification service mocks ---
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

// --- instant service mocks ---
vi.mock('../../src/services/TaskService', () => ({
  TaskService: {
    accept: vi.fn(),
  },
}));

// --- expertiseSupply service mocks ---
vi.mock('../../src/services/ExpertiseSupplyService', () => ({
  ExpertiseSupplyService: {
    listExpertise: vi.fn(),
    getUserExpertise: vi.fn(),
    addUserExpertise: vi.fn(),
    removeUserExpertise: vi.fn(),
    promoteExpertise: vi.fn(),
    checkCapacity: vi.fn(),
    getUserWaitlist: vi.fn(),
    acceptWaitlistInvite: vi.fn(),
    getSupplyDashboard: vi.fn(),
    adminUpdateCapacity: vi.fn(),
    recalculateAllCapacity: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { db } from '../../src/db';
import { betaDashboardRouter } from '../../src/routers/betaDashboard';
import { notificationRouter } from '../../src/routers/notification';
import { instantRouter } from '../../src/routers/instant';
import { expertiseSupplyRouter } from '../../src/routers/expertiseSupply';
import { liveRouter } from '../../src/routers/live';
import { BetaService } from '../../src/services/BetaService';
import { RevenueService } from '../../src/services/RevenueService';
import { ChargebackService } from '../../src/services/ChargebackService';
import { NotificationService } from '../../src/services/NotificationService';
import { sendPushNotification } from '../../src/services/PushNotificationService';
import { TaskService } from '../../src/services/TaskService';
import { ExpertiseSupplyService } from '../../src/services/ExpertiseSupplyService';

const mockDb = vi.mocked(db);
const mockBetaService = vi.mocked(BetaService);
const mockRevenueService = vi.mocked(RevenueService);
const mockChargebackService = vi.mocked(ChargebackService);
const mockNotificationService = vi.mocked(NotificationService);
const mockSendPush = vi.mocked(sendPushNotification);
const mockTaskService = vi.mocked(TaskService);
const mockExpertiseSupplyService = vi.mocked(ExpertiseSupplyService);

// ---------------------------------------------------------------------------
// Context helpers
// ---------------------------------------------------------------------------

/**
 * Fake user object matching the User type used throughout the codebase.
 */
function makeFakeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user-123',
    email: 'test@hustlexp.com',
    full_name: 'Test User',
    role: 'hustler',
    default_mode: 'worker', // hustlerProcedure requires default_mode === 'worker'
    firebase_uid: 'fb-uid-123',
    live_mode_state: 'OFF',
    live_mode_session_started_at: null,
    live_mode_banned_until: null,
    live_mode_total_tasks: 0,
    live_mode_completion_rate: 0,
    ...overrides,
  };
}

/**
 * Create a caller for a protected (non-admin) router procedure.
 * Only needs ctx.user set.
 */
function makeProtectedCtx(userOverrides: Record<string, unknown> = {}) {
  return { user: makeFakeUser(userOverrides), firebaseUid: 'fb-uid-123' };
}

/**
 * Create a caller for an admin router procedure.
 * The adminProcedure middleware calls db.query to check admin_roles, so we
 * pre-seed that as the first mockResolvedValueOnce call.
 */
function makeAdminCtx() {
  return {
    user: makeFakeUser({ role: 'admin' }),
    firebaseUid: 'fb-uid-admin',
  };
}

/**
 * Seed a successful admin_roles check as the first db.query call.
 * Must be called before any test that uses an adminProcedure.
 */
function seedAdminRoleCheck() {
  mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);
}

// ===========================================================================
// 1. betaDashboardRouter
// ===========================================================================

describe('betaDashboardRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---- getMetrics ----------------------------------------------------------

  describe('getMetrics', () => {
    it('returns metrics data when service succeeds', async () => {
      seedAdminRoleCheck();
      const fakeMetrics = { tasksCreated: 42, tasksCompleted: 30, gmvCents: 150000 };
      mockBetaService.getBetaMetrics.mockResolvedValueOnce({
        success: true,
        data: fakeMetrics,
      } as any);

      const caller = betaDashboardRouter.createCaller(makeAdminCtx());
      const result = await caller.getMetrics({ windowDays: 14 });

      expect(result).toEqual(fakeMetrics);
      expect(mockBetaService.getBetaMetrics).toHaveBeenCalledWith(14);
    });

    it('throws INTERNAL_SERVER_ERROR when service fails', async () => {
      seedAdminRoleCheck();
      mockBetaService.getBetaMetrics.mockResolvedValueOnce({
        success: false,
        error: { message: 'DB timeout' },
      } as any);

      const caller = betaDashboardRouter.createCaller(makeAdminCtx());
      await expect(caller.getMetrics({ windowDays: 30 })).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'DB timeout',
      });
    });

    it('uses default windowDays of 30 when input is omitted', async () => {
      seedAdminRoleCheck();
      mockBetaService.getBetaMetrics.mockResolvedValueOnce({
        success: true,
        data: {},
      } as any);

      const caller = betaDashboardRouter.createCaller(makeAdminCtx());
      await caller.getMetrics(undefined);

      expect(mockBetaService.getBetaMetrics).toHaveBeenCalledWith(30);
    });
  });

  // ---- getStatus -----------------------------------------------------------

  describe('getStatus', () => {
    it('returns status data when service succeeds', async () => {
      seedAdminRoleCheck();
      const fakeStatus = { usersEnrolled: 10, tasksCreated: 5, gmvCents: 5000 };
      mockBetaService.getBetaStatus.mockResolvedValueOnce({
        success: true,
        data: fakeStatus,
      } as any);

      const caller = betaDashboardRouter.createCaller(makeAdminCtx());
      const result = await caller.getStatus();

      expect(result).toEqual(fakeStatus);
    });

    it('throws INTERNAL_SERVER_ERROR when service fails', async () => {
      seedAdminRoleCheck();
      mockBetaService.getBetaStatus.mockResolvedValueOnce({
        success: false,
        error: { message: 'Service unavailable' },
      } as any);

      const caller = betaDashboardRouter.createCaller(makeAdminCtx());
      await expect(caller.getStatus()).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
      });
    });
  });

  // ---- getKillSignals ------------------------------------------------------

  describe('getKillSignals', () => {
    it('returns kill signals when service succeeds', async () => {
      seedAdminRoleCheck();
      const fakeSignals = [{ signal: 'HIGH_DISPUTE_RATE', value: 0.25 }];
      mockBetaService.getKillSignals.mockResolvedValueOnce({
        success: true,
        data: fakeSignals,
      } as any);

      const caller = betaDashboardRouter.createCaller(makeAdminCtx());
      const result = await caller.getKillSignals();

      expect(result).toEqual(fakeSignals);
    });
  });

  // ---- getRevenueSummary ---------------------------------------------------

  describe('getRevenueSummary', () => {
    it('returns revenue summary with default 30 days', async () => {
      seedAdminRoleCheck();
      const fakeRevenue = { platform_fee: 5000, subscription: 2000 };
      mockRevenueService.getRevenueSummary.mockResolvedValueOnce({
        success: true,
        data: fakeRevenue,
      } as any);

      const caller = betaDashboardRouter.createCaller(makeAdminCtx());
      const result = await caller.getRevenueSummary(undefined);

      expect(result).toEqual(fakeRevenue);
      expect(mockRevenueService.getRevenueSummary).toHaveBeenCalledWith(30);
    });

    it('passes custom days to service', async () => {
      seedAdminRoleCheck();
      mockRevenueService.getRevenueSummary.mockResolvedValueOnce({
        success: true,
        data: {},
      } as any);

      const caller = betaDashboardRouter.createCaller(makeAdminCtx());
      await caller.getRevenueSummary({ days: 7 });

      expect(mockRevenueService.getRevenueSummary).toHaveBeenCalledWith(7);
    });
  });

  // ---- getDisputeRate ------------------------------------------------------

  describe('getDisputeRate', () => {
    it('returns dispute rate when service succeeds', async () => {
      seedAdminRoleCheck();
      const fakeRate = { rate30d: 0.02, rate90d: 0.018 };
      mockChargebackService.getPlatformDisputeRate.mockResolvedValueOnce({
        success: true,
        data: fakeRate,
      } as any);

      const caller = betaDashboardRouter.createCaller(makeAdminCtx());
      const result = await caller.getDisputeRate();

      expect(result).toEqual(fakeRate);
    });
  });

  // ---- getDailyTaskCounts --------------------------------------------------

  describe('getDailyTaskCounts', () => {
    it('returns mapped daily task counts from db', async () => {
      seedAdminRoleCheck();
      mockDb.query.mockResolvedValueOnce({
        rows: [
          { day: '2026-03-01', created: '5', completed: '3', cancelled: '1' },
          { day: '2026-03-02', created: '8', completed: '6', cancelled: '0' },
        ],
        rowCount: 2,
      } as any);

      const caller = betaDashboardRouter.createCaller(makeAdminCtx());
      const result = await caller.getDailyTaskCounts({ days: 7 });

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({ day: '2026-03-01', created: 5, completed: 3, cancelled: 1 });
    });

    it('returns empty array when no data', async () => {
      seedAdminRoleCheck();
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const caller = betaDashboardRouter.createCaller(makeAdminCtx());
      const result = await caller.getDailyTaskCounts(undefined);

      expect(result).toEqual([]);
    });
  });

  // ---- getBetaConfig -------------------------------------------------------

  describe('getBetaConfig', () => {
    it('returns beta config for admin users (adminProcedure — v2.9.8)', async () => {
      // getBetaConfig was changed to adminProcedure in v2.9.8 to prevent GPS boundary leakage
      seedAdminRoleCheck();
      const caller = betaDashboardRouter.createCaller(makeAdminCtx());
      const result = await caller.getBetaConfig();

      // Verifies that config fields are present (values come from config.ts)
      expect(result).toHaveProperty('enabled');
      expect(result).toHaveProperty('region');
      expect(result).toHaveProperty('bounds');
      expect(result).toHaveProperty('radiusMiles');
    });
  });

  // ---- requestKillSwitchToggle ---------------------------------------------

  describe('requestKillSwitchToggle', () => {
    it('logs kill switch request and returns logged: true', async () => {
      seedAdminRoleCheck();
      mockBetaService.logBetaStateChange.mockResolvedValueOnce(undefined as any);

      const caller = betaDashboardRouter.createCaller(makeAdminCtx());
      const result = await caller.requestKillSwitchToggle({
        action: 'DISABLE',
        reason: 'High dispute rate detected',
      });

      expect(result.logged).toBe(true);
      expect(result).toHaveProperty('currentState');
      expect(result).toHaveProperty('requiresRedeploy');
      expect(mockBetaService.logBetaStateChange).toHaveBeenCalledTimes(1);
    });
  });
});

// ===========================================================================
// 2. notificationRouter
// ===========================================================================

describe('notificationRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const NOTIFICATION_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

  // ---- getList -------------------------------------------------------------

  describe('getList', () => {
    it('returns paginated notifications on success', async () => {
      const fakeData = {
        notifications: [{ id: 'notif-1', title: 'New task nearby' }],
        total: 1,
      };
      mockNotificationService.getUserNotifications.mockResolvedValueOnce({
        success: true,
        data: fakeData,
      } as any);

      const caller = notificationRouter.createCaller(makeProtectedCtx());
      const result = await caller.getList({ limit: 10, offset: 0, unreadOnly: false });

      expect(result).toEqual(fakeData);
      expect(mockNotificationService.getUserNotifications).toHaveBeenCalledWith(
        'user-123', 10, 0, false
      );
    });

    it('throws INTERNAL_SERVER_ERROR when service fails', async () => {
      mockNotificationService.getUserNotifications.mockResolvedValueOnce({
        success: false,
        error: { message: 'DB error' },
      } as any);

      const caller = notificationRouter.createCaller(makeProtectedCtx());
      await expect(
        caller.getList({ limit: 10, offset: 0, unreadOnly: false })
      ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR', message: 'DB error' });
    });

    it('throws UNAUTHORIZED when ctx.user is null', async () => {
      const caller = notificationRouter.createCaller({ user: null, firebaseUid: null });
      await expect(
        caller.getList({ limit: 10, offset: 0, unreadOnly: false })
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });
  });

  // ---- getUnreadCount ------------------------------------------------------

  describe('getUnreadCount', () => {
    it('returns { count: N } on success', async () => {
      mockNotificationService.getUnreadCount.mockResolvedValueOnce({
        success: true,
        data: 7,
      } as any);

      const caller = notificationRouter.createCaller(makeProtectedCtx());
      const result = await caller.getUnreadCount();

      expect(result).toEqual({ count: 7 });
    });

    it('throws UNAUTHORIZED when ctx.user is null', async () => {
      const caller = notificationRouter.createCaller({ user: null, firebaseUid: null });
      await expect(caller.getUnreadCount()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });
  });

  // ---- getById -------------------------------------------------------------

  describe('getById', () => {
    it('returns notification when found', async () => {
      const fakeNotif = { id: NOTIFICATION_ID, title: 'Task assigned' };
      mockNotificationService.getNotificationById.mockResolvedValueOnce({
        success: true,
        data: fakeNotif,
      } as any);

      const caller = notificationRouter.createCaller(makeProtectedCtx());
      const result = await caller.getById({ notificationId: NOTIFICATION_ID });

      expect(result).toEqual(fakeNotif);
      expect(mockNotificationService.getNotificationById).toHaveBeenCalledWith(
        NOTIFICATION_ID, 'user-123'
      );
    });

    it('throws NOT_FOUND when service returns NOT_FOUND error code', async () => {
      mockNotificationService.getNotificationById.mockResolvedValueOnce({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Notification not found' },
      } as any);

      const caller = notificationRouter.createCaller(makeProtectedCtx());
      await expect(
        caller.getById({ notificationId: NOTIFICATION_ID })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  // ---- markAsRead ----------------------------------------------------------

  describe('markAsRead', () => {
    it('returns updated notification on success', async () => {
      const fakeResult = { id: NOTIFICATION_ID, read_at: new Date().toISOString() };
      mockNotificationService.markAsRead.mockResolvedValueOnce({
        success: true,
        data: fakeResult,
      } as any);

      const caller = notificationRouter.createCaller(makeProtectedCtx());
      const result = await caller.markAsRead({ notificationId: NOTIFICATION_ID });

      expect(result).toEqual(fakeResult);
      expect(mockNotificationService.markAsRead).toHaveBeenCalledWith(
        NOTIFICATION_ID, 'user-123'
      );
    });

    it('throws FORBIDDEN when notification belongs to another user', async () => {
      mockNotificationService.markAsRead.mockResolvedValueOnce({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Access denied' },
      } as any);

      const caller = notificationRouter.createCaller(makeProtectedCtx());
      await expect(
        caller.markAsRead({ notificationId: NOTIFICATION_ID })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
  });

  // ---- markAllAsRead -------------------------------------------------------

  describe('markAllAsRead', () => {
    it('returns success result', async () => {
      mockNotificationService.markAllAsRead.mockResolvedValueOnce({
        success: true,
        data: { count: 5 },
      } as any);

      const caller = notificationRouter.createCaller(makeProtectedCtx());
      const result = await caller.markAllAsRead();

      expect(result).toEqual({ count: 5 });
      expect(mockNotificationService.markAllAsRead).toHaveBeenCalledWith('user-123');
    });
  });

  // ---- getPreferences ------------------------------------------------------

  describe('getPreferences', () => {
    it('returns preferences on success', async () => {
      const fakePrefs = { pushEnabled: true, emailEnabled: false, quietHoursEnabled: false };
      mockNotificationService.getPreferences.mockResolvedValueOnce({
        success: true,
        data: fakePrefs,
      } as any);

      const caller = notificationRouter.createCaller(makeProtectedCtx());
      const result = await caller.getPreferences();

      expect(result).toEqual(fakePrefs);
    });
  });

  // ---- updatePreferences ---------------------------------------------------

  describe('updatePreferences', () => {
    it('returns updated preferences on success', async () => {
      const updatedPrefs = { pushEnabled: false, emailEnabled: true };
      mockNotificationService.updatePreferences.mockResolvedValueOnce({
        success: true,
        data: updatedPrefs,
      } as any);

      const caller = notificationRouter.createCaller(makeProtectedCtx());
      const result = await caller.updatePreferences({ pushEnabled: false, emailEnabled: true });

      expect(result).toEqual(updatedPrefs);
      expect(mockNotificationService.updatePreferences).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-123', pushEnabled: false, emailEnabled: true })
      );
    });
  });

  // ---- registerDeviceToken -------------------------------------------------

  describe('registerDeviceToken', () => {
    it('upserts device token and returns the row', async () => {
      const fakeRow = {
        id: 'token-row-1',
        user_id: 'user-123',
        fcm_token: 'fcm-abc-123',
        device_type: 'ios',
        device_name: 'iPhone 15',
        app_version: '2.0.0',
        is_active: true,
        created_at: new Date(),
        updated_at: new Date(),
      };
      mockDb.query.mockResolvedValueOnce({ rows: [fakeRow], rowCount: 1 } as any);

      const caller = notificationRouter.createCaller(makeProtectedCtx());
      const result = await caller.registerDeviceToken({
        fcmToken: 'fcm-abc-123',
        deviceType: 'ios',
        deviceName: 'iPhone 15',
        appVersion: '2.0.0',
      });

      expect(result).toEqual(fakeRow);
      const [sql, params] = (mockDb.query as any).mock.calls[0];
      expect(sql).toContain('ON CONFLICT');
      expect(params).toContain('user-123');
      expect(params).toContain('fcm-abc-123');
    });

    it('throws INTERNAL_SERVER_ERROR on db failure', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('connection reset'));

      const caller = notificationRouter.createCaller(makeProtectedCtx());
      await expect(
        caller.registerDeviceToken({ fcmToken: 'tok', deviceType: 'ios' })
      ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    });
  });

  // ---- unregisterDeviceToken -----------------------------------------------

  describe('unregisterDeviceToken', () => {
    it('deactivates token and returns { success: true }', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'token-row-1' }], rowCount: 1 } as any);

      const caller = notificationRouter.createCaller(makeProtectedCtx());
      const result = await caller.unregisterDeviceToken({ fcmToken: 'fcm-abc-123' });

      expect(result).toEqual({ success: true });
    });

    it('throws NOT_FOUND when token does not exist for this user', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const caller = notificationRouter.createCaller(makeProtectedCtx());
      await expect(
        caller.unregisterDeviceToken({ fcmToken: 'unknown-token' })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  // ---- sendTestPush (admin) ------------------------------------------------

  describe('sendTestPush', () => {
    it('calls sendPushNotification with correct args', async () => {
      seedAdminRoleCheck();
      mockSendPush.mockResolvedValueOnce({ success: true } as any);

      const caller = notificationRouter.createCaller(makeAdminCtx());
      const result = await caller.sendTestPush({
        userId: NOTIFICATION_ID,
        title: 'Test',
        body: 'Body',
      });

      expect(result).toEqual({ success: true });
      expect(mockSendPush).toHaveBeenCalledWith(
        NOTIFICATION_ID, 'Test', 'Body', { type: 'test', source: 'admin_debug' }
      );
    });
  });
});

// ===========================================================================
// 3. instantRouter
// ===========================================================================

describe('instantRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const TASK_ID = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';

  // ---- listAvailable -------------------------------------------------------

  describe('listAvailable', () => {
    it('returns mapped task list from db', async () => {
      const now = new Date('2026-03-01T12:00:00Z');
      mockDb.query.mockResolvedValueOnce({
        rows: [
          {
            id: TASK_ID,
            title: 'Deliver groceries',
            description: 'Fast delivery needed',
            price: 2500,
            location: 'Capitol Hill, Seattle',
            created_at: now,
          },
        ],
        rowCount: 1,
      } as any);

      const caller = instantRouter.createCaller(makeProtectedCtx());
      const result = await caller.listAvailable({ limit: 10 });

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(1);
      const task = result[0];
      expect(task.id).toBe(TASK_ID);
      expect(task.title).toBe('Deliver groceries');
      expect(task.price).toBe(2500);
      expect(typeof task.waitingSeconds).toBe('number');
      expect(task.waitingSeconds).toBeGreaterThanOrEqual(0);
    });

    it('returns empty array when no tasks available', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const caller = instantRouter.createCaller(makeProtectedCtx());
      const result = await caller.listAvailable(undefined);

      expect(result).toEqual([]);
    });

    it('queries for LIVE mode OPEN tasks without worker', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const caller = instantRouter.createCaller(makeProtectedCtx());
      await caller.listAvailable({ limit: 5 });

      const [sql, params] = (mockDb.query as any).mock.calls[0];
      expect(sql).toContain("mode = 'LIVE'");
      expect(sql).toContain("state = 'OPEN'");
      expect(sql).toContain('worker_id IS NULL');
      expect(params).toContain(5);
    });
  });

  // ---- accept --------------------------------------------------------------

  describe('accept', () => {
    it('returns task and timeToAcceptSeconds on success', async () => {
      const createdAt = new Date('2026-03-01T12:00:00Z');
      const acceptedAt = new Date('2026-03-01T12:01:30Z'); // 90 seconds later
      const fakeTask = { id: TASK_ID, created_at: createdAt, accepted_at: acceptedAt };

      mockTaskService.accept.mockResolvedValueOnce({
        success: true,
        data: fakeTask,
      } as any);

      const caller = instantRouter.createCaller(makeProtectedCtx());
      const result = await caller.accept({ taskId: TASK_ID });

      expect(result.task).toEqual(fakeTask);
      expect(result.timeToAcceptSeconds).toBe(90);
      expect(mockTaskService.accept).toHaveBeenCalledWith({
        taskId: TASK_ID,
        workerId: 'user-123',
      });
    });

    it('returns null timeToAcceptSeconds when accepted_at is missing', async () => {
      const fakeTask = { id: TASK_ID, created_at: new Date(), accepted_at: null };
      mockTaskService.accept.mockResolvedValueOnce({
        success: true,
        data: fakeTask,
      } as any);

      const caller = instantRouter.createCaller(makeProtectedCtx());
      const result = await caller.accept({ taskId: TASK_ID });

      expect(result.timeToAcceptSeconds).toBeNull();
    });

    it('throws BAD_REQUEST when TaskService fails', async () => {
      mockTaskService.accept.mockResolvedValueOnce({
        success: false,
        error: { message: 'Task already accepted' },
      } as any);

      const caller = instantRouter.createCaller(makeProtectedCtx());
      await expect(
        caller.accept({ taskId: TASK_ID })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'Task already accepted' });
    });
  });

  // ---- dismiss -------------------------------------------------------------

  describe('dismiss', () => {
    it('returns { dismissed: true } when notification exists', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'notif-99' }], rowCount: 1 } as any);

      const caller = instantRouter.createCaller(makeProtectedCtx());
      const result = await caller.dismiss({ taskId: TASK_ID });

      expect(result).toEqual({ dismissed: true });
      const [sql, params] = (mockDb.query as any).mock.calls[0];
      expect(sql).toContain("category = 'instant_task_available'");
      expect(params).toContain('user-123');
      expect(params).toContain(TASK_ID);
    });

    it('throws NOT_FOUND when notification not found or already dismissed', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const caller = instantRouter.createCaller(makeProtectedCtx());
      await expect(
        caller.dismiss({ taskId: TASK_ID })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  // ---- metrics -------------------------------------------------------------

  describe('metrics', () => {
    it('returns computed stats object with correct shape', async () => {
      // Call 1: time-to-accept rows
      const createdAt1 = new Date('2026-03-01T10:00:00Z');
      const acceptedAt1 = new Date('2026-03-01T10:00:45Z'); // 45s
      const createdAt2 = new Date('2026-03-01T11:00:00Z');
      const acceptedAt2 = new Date('2026-03-01T11:02:00Z'); // 120s
      mockDb.query.mockResolvedValueOnce({
        rows: [
          { created_at: createdAt1, accepted_at: acceptedAt1 },
          { created_at: createdAt2, accepted_at: acceptedAt2 },
        ],
        rowCount: 2,
      } as any);

      // Call 2: notification latency rows (empty)
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      // Call 3: dismiss stats
      mockDb.query.mockResolvedValueOnce({
        rows: [{ total: '10', dismissed: '3' }],
        rowCount: 1,
      } as any);

      const caller = instantRouter.createCaller(makeProtectedCtx());
      const result = await caller.metrics();

      expect(result).toHaveProperty('timeToAccept');
      expect(result).toHaveProperty('notificationLatency');
      expect(result).toHaveProperty('dismissRate');
      expect(result).toHaveProperty('dismissStats');
      expect(result.timeToAccept.count).toBe(2);
      expect(result.dismissStats.total).toBe(10);
      expect(result.dismissStats.dismissed).toBe(3);
      expect(result.dismissRate).toBe(0.3);
    });

    it('returns nulls for stats when no time-to-accept data', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
      mockDb.query.mockResolvedValueOnce({
        rows: [{ total: '0', dismissed: '0' }],
        rowCount: 1,
      } as any);

      const caller = instantRouter.createCaller(makeProtectedCtx());
      const result = await caller.metrics();

      expect(result.timeToAccept.median).toBeNull();
      expect(result.timeToAccept.p90).toBeNull();
      expect(result.dismissRate).toBe(0);
    });
  });
});

// ===========================================================================
// 4. expertiseSupplyRouter
// ===========================================================================

describe('expertiseSupplyRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const EXPERTISE_ID = 'c3d4e5f6-a7b8-9012-cdef-123456789012';
  const WAITLIST_ID = 'd4e5f6a7-b8c9-0123-defa-234567890123';

  // ---- listExpertise -------------------------------------------------------

  describe('listExpertise', () => {
    it('returns sliced list on success', async () => {
      const fakeList = [
        { id: EXPERTISE_ID, name: 'Delivery', category: 'logistics' },
        { id: 'id-2', name: 'Cleaning', category: 'home' },
        { id: 'id-3', name: 'Assembly', category: 'home' },
      ];
      mockExpertiseSupplyService.listExpertise.mockResolvedValueOnce({
        success: true,
        data: fakeList,
      } as any);

      const caller = expertiseSupplyRouter.createCaller(makeProtectedCtx());
      // offset=1, limit=2 → should return items at index 1 and 2
      const result = await caller.listExpertise({ limit: 2, offset: 1 });

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('Cleaning');
    });

    it('returns full list when no pagination options given', async () => {
      const fakeList = [{ id: EXPERTISE_ID, name: 'Delivery' }];
      mockExpertiseSupplyService.listExpertise.mockResolvedValueOnce({
        success: true,
        data: fakeList,
      } as any);

      const caller = expertiseSupplyRouter.createCaller(makeProtectedCtx());
      const result = await caller.listExpertise(undefined);

      expect(result).toHaveLength(1);
    });

    it('throws INTERNAL_SERVER_ERROR when service fails', async () => {
      mockExpertiseSupplyService.listExpertise.mockResolvedValueOnce({
        success: false,
        error: { message: 'DB error' },
      } as any);

      const caller = expertiseSupplyRouter.createCaller(makeProtectedCtx());
      await expect(caller.listExpertise(undefined)).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
      });
    });
  });

  // ---- getMyExpertise ------------------------------------------------------

  describe('getMyExpertise', () => {
    it('returns user expertise on success', async () => {
      const fakeExpertise = [{ expertiseId: EXPERTISE_ID, isPrimary: true }];
      mockExpertiseSupplyService.getUserExpertise.mockResolvedValueOnce({
        success: true,
        data: fakeExpertise,
      } as any);

      const caller = expertiseSupplyRouter.createCaller(makeProtectedCtx());
      const result = await caller.getMyExpertise();

      expect(result).toEqual(fakeExpertise);
      expect(mockExpertiseSupplyService.getUserExpertise).toHaveBeenCalledWith('user-123');
    });
  });

  // ---- addExpertise --------------------------------------------------------

  describe('addExpertise', () => {
    it('calls service with correct args and returns result', async () => {
      const fakeResult = { status: 'enrolled', expertiseId: EXPERTISE_ID };
      mockExpertiseSupplyService.addUserExpertise.mockResolvedValueOnce({
        success: true,
        data: fakeResult,
      } as any);

      const caller = expertiseSupplyRouter.createCaller(makeProtectedCtx());
      const result = await caller.addExpertise({
        expertiseId: EXPERTISE_ID,
        isPrimary: true,
        geoZone: 'seattle_metro',
      });

      expect(result).toEqual(fakeResult);
      expect(mockExpertiseSupplyService.addUserExpertise).toHaveBeenCalledWith(
        'user-123', EXPERTISE_ID, true, 'seattle_metro'
      );
    });

    it('throws INTERNAL_SERVER_ERROR when service fails (e.g. capacity full)', async () => {
      mockExpertiseSupplyService.addUserExpertise.mockResolvedValueOnce({
        success: false,
        error: { message: 'Capacity full, added to waitlist' },
      } as any);

      const caller = expertiseSupplyRouter.createCaller(makeProtectedCtx());
      await expect(
        caller.addExpertise({ expertiseId: EXPERTISE_ID, isPrimary: false, geoZone: 'seattle_metro' })
      ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    });
  });

  // ---- removeExpertise -----------------------------------------------------

  describe('removeExpertise', () => {
    it('calls service with correct args and returns result', async () => {
      const fakeResult = { removed: true };
      mockExpertiseSupplyService.removeUserExpertise.mockResolvedValueOnce({
        success: true,
        data: fakeResult,
      } as any);

      const caller = expertiseSupplyRouter.createCaller(makeProtectedCtx());
      const result = await caller.removeExpertise({
        expertiseId: EXPERTISE_ID,
        geoZone: 'seattle_metro',
      });

      expect(result).toEqual(fakeResult);
    });
  });

  // ---- checkCapacity -------------------------------------------------------

  describe('checkCapacity', () => {
    it('returns capacity info on success', async () => {
      const fakeCapacity = { available: true, currentCount: 12, maxCapacity: 50 };
      mockExpertiseSupplyService.checkCapacity.mockResolvedValueOnce({
        success: true,
        data: fakeCapacity,
      } as any);

      const caller = expertiseSupplyRouter.createCaller(makeProtectedCtx());
      const result = await caller.checkCapacity({
        expertiseId: EXPERTISE_ID,
        geoZone: 'seattle_metro',
      });

      expect(result).toEqual(fakeCapacity);
      expect(mockExpertiseSupplyService.checkCapacity).toHaveBeenCalledWith(
        EXPERTISE_ID, 'seattle_metro'
      );
    });
  });

  // ---- getMyWaitlist -------------------------------------------------------

  describe('getMyWaitlist', () => {
    it('returns waitlist entries on success', async () => {
      const fakeWaitlist = [{ waitlistEntryId: WAITLIST_ID, position: 3, expertiseName: 'Delivery' }];
      mockExpertiseSupplyService.getUserWaitlist.mockResolvedValueOnce({
        success: true,
        data: fakeWaitlist,
      } as any);

      const caller = expertiseSupplyRouter.createCaller(makeProtectedCtx());
      const result = await caller.getMyWaitlist();

      expect(result).toEqual(fakeWaitlist);
      expect(mockExpertiseSupplyService.getUserWaitlist).toHaveBeenCalledWith('user-123');
    });
  });

  // ---- acceptInvite --------------------------------------------------------

  describe('acceptInvite', () => {
    it('calls service and returns result', async () => {
      const fakeResult = { enrolled: true };
      mockExpertiseSupplyService.acceptWaitlistInvite.mockResolvedValueOnce({
        success: true,
        data: fakeResult,
      } as any);

      const caller = expertiseSupplyRouter.createCaller(makeProtectedCtx());
      const result = await caller.acceptInvite({ waitlistEntryId: WAITLIST_ID });

      expect(result).toEqual(fakeResult);
      expect(mockExpertiseSupplyService.acceptWaitlistInvite).toHaveBeenCalledWith(
        'user-123', WAITLIST_ID
      );
    });
  });

  // ---- getSupplyDashboard (admin) ------------------------------------------

  describe('getSupplyDashboard', () => {
    it('returns dashboard data on success', async () => {
      seedAdminRoleCheck();
      const fakeDashboard = { categories: [], totalHustlers: 45 };
      mockExpertiseSupplyService.getSupplyDashboard.mockResolvedValueOnce({
        success: true,
        data: fakeDashboard,
      } as any);

      const caller = expertiseSupplyRouter.createCaller(makeAdminCtx());
      const result = await caller.getSupplyDashboard({ geoZone: 'seattle_metro' });

      expect(result).toEqual(fakeDashboard);
      expect(mockExpertiseSupplyService.getSupplyDashboard).toHaveBeenCalledWith('seattle_metro');
    });

    it('uses default geoZone of seattle_metro when input is omitted', async () => {
      seedAdminRoleCheck();
      mockExpertiseSupplyService.getSupplyDashboard.mockResolvedValueOnce({
        success: true,
        data: {},
      } as any);

      const caller = expertiseSupplyRouter.createCaller(makeAdminCtx());
      await caller.getSupplyDashboard(undefined);

      expect(mockExpertiseSupplyService.getSupplyDashboard).toHaveBeenCalledWith('seattle_metro');
    });
  });

  // ---- triggerRecalc (admin) -----------------------------------------------

  describe('triggerRecalc', () => {
    it('triggers recalculation and returns result', async () => {
      seedAdminRoleCheck();
      const fakeResult = { updated: 10 };
      mockExpertiseSupplyService.recalculateAllCapacity.mockResolvedValueOnce({
        success: true,
        data: fakeResult,
      } as any);

      const caller = expertiseSupplyRouter.createCaller(makeAdminCtx());
      const result = await caller.triggerRecalc();

      expect(result).toEqual(fakeResult);
    });
  });
});

// ===========================================================================
// 5. liveRouter
// ===========================================================================

describe('liveRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---- toggle --------------------------------------------------------------

  describe('toggle', () => {
    it('activates live mode and returns updated user row', async () => {
      const updatedUser = { id: 'user-123', live_mode_state: 'ACTIVE' };
      mockDb.query.mockResolvedValueOnce({ rows: [updatedUser], rowCount: 1 } as any);

      const caller = liveRouter.createCaller(
        makeProtectedCtx({ live_mode_state: 'OFF', live_mode_banned_until: null })
      );
      const result = await caller.toggle({ enabled: true });

      expect(result).toEqual(updatedUser);
      const [sql, params] = (mockDb.query as any).mock.calls[0];
      expect(sql).toContain('live_mode_state =');
      expect(params).toContain('ACTIVE');
    });

    it('deactivates live mode — sets state to OFF', async () => {
      const updatedUser = { id: 'user-123', live_mode_state: 'OFF' };
      mockDb.query.mockResolvedValueOnce({ rows: [updatedUser], rowCount: 1 } as any);

      const caller = liveRouter.createCaller(
        makeProtectedCtx({ live_mode_state: 'ACTIVE', live_mode_banned_until: null })
      );
      const result = await caller.toggle({ enabled: false });

      expect(result).toEqual(updatedUser);
      const [, params] = (mockDb.query as any).mock.calls[0];
      expect(params).toContain('OFF');
    });

    it('throws FORBIDDEN when user is banned from live mode', async () => {
      const bannedUntil = new Date(Date.now() + 86400000).toISOString(); // +1 day
      const caller = liveRouter.createCaller(
        makeProtectedCtx({ live_mode_banned_until: bannedUntil })
      );

      await expect(caller.toggle({ enabled: true })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    });

    it('throws PRECONDITION_FAILED when live mode is in cooldown', async () => {
      const caller = liveRouter.createCaller(
        makeProtectedCtx({ live_mode_state: 'COOLDOWN', live_mode_banned_until: null })
      );

      await expect(caller.toggle({ enabled: true })).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
      });
    });

    it('throws INTERNAL_SERVER_ERROR on db failure', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('connection error'));

      const caller = liveRouter.createCaller(
        makeProtectedCtx({ live_mode_state: 'OFF', live_mode_banned_until: null })
      );

      await expect(caller.toggle({ enabled: true })).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
      });
    });
  });

  // ---- getStatus -----------------------------------------------------------

  describe('getStatus', () => {
    it('returns live mode status from ctx.user without hitting db', async () => {
      const caller = liveRouter.createCaller(
        makeProtectedCtx({
          live_mode_state: 'ACTIVE',
          live_mode_session_started_at: '2026-03-01T10:00:00Z',
          live_mode_banned_until: null,
          live_mode_total_tasks: 7,
          live_mode_completion_rate: 0.86,
        })
      );

      const result = await caller.getStatus();

      expect(result.state).toBe('ACTIVE');
      expect(result.totalTasks).toBe(7);
      expect(result.completionRate).toBe(0.86);
      expect(result.bannedUntil).toBeNull();
      // No db calls expected since data comes from ctx.user
      expect(mockDb.query).not.toHaveBeenCalled();
    });

    it('returns OFF state when live mode is inactive', async () => {
      const caller = liveRouter.createCaller(
        makeProtectedCtx({
          live_mode_state: 'OFF',
          live_mode_session_started_at: null,
          live_mode_total_tasks: 0,
        })
      );

      const result = await caller.getStatus();

      expect(result.state).toBe('OFF');
      expect(result.sessionStartedAt).toBeNull();
    });
  });

  // ---- listBroadcasts ------------------------------------------------------

  describe('listBroadcasts', () => {
    it('returns mapped broadcast list on success', async () => {
      const now = new Date('2026-03-01T12:00:00Z');
      mockDb.query.mockResolvedValueOnce({
        rows: [
          {
            id: 'broadcast-1',
            task_id: 'task-99',
            started_at: now,
            expired_at: null,
            initial_radius_miles: 5,
            final_radius_miles: null,
            hustlers_notified: 10,
            hustlers_viewed: 3,
            task_title: 'Move furniture',
            task_price: 8000,
            task_location: 'Fremont, Seattle',
            task_category: 'moving',
            task_deadline: null,
          },
        ],
        rowCount: 1,
      } as any);

      const caller = liveRouter.createCaller(makeProtectedCtx());
      const result = await caller.listBroadcasts({
        latitude: 47.6062,
        longitude: -122.3321,
        radiusMiles: 5,
        limit: 20,
        offset: 0,
      });

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(1);
      const broadcast = result[0];
      expect(broadcast.id).toBe('broadcast-1');
      expect(broadcast.task.title).toBe('Move furniture');
      expect(broadcast.task.price).toBe(8000);
      expect(broadcast.startedAt).toBe(now.toISOString());
      expect(broadcast.expiredAt).toBeNull();
    });

    it('returns empty array when no broadcasts available', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const caller = liveRouter.createCaller(makeProtectedCtx());
      const result = await caller.listBroadcasts({
        latitude: 47.6062,
        longitude: -122.3321,
        radiusMiles: 5,
      });

      expect(result).toEqual([]);
    });

    it('passes radiusMiles, limit, and offset as db query params', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const caller = liveRouter.createCaller(makeProtectedCtx());
      await caller.listBroadcasts({
        latitude: 47.6062,
        longitude: -122.3321,
        radiusMiles: 10,
        limit: 15,
        offset: 5,
      });

      const [sql, params] = (mockDb.query as any).mock.calls[0];
      expect(sql).toContain('live_broadcasts');
      expect(params).toContain(10);  // radiusMiles
      expect(params).toContain(15);  // limit
      expect(params).toContain(5);   // offset
    });

    it('throws INTERNAL_SERVER_ERROR on db failure', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('query timeout'));

      const caller = liveRouter.createCaller(makeProtectedCtx());
      await expect(
        caller.listBroadcasts({
          latitude: 47.6062,
          longitude: -122.3321,
          radiusMiles: 5,
        })
      ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    });
  });
});
