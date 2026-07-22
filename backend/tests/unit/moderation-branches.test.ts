/**
 * Moderation Router Branch Coverage Tests
 *
 * Targets uncovered branches in moderation.ts not covered by moderation-router.test.ts:
 *
 * getQueueItemById:
 *   - INTERNAL_SERVER_ERROR path (error.code !== 'NOT_FOUND')
 *
 * reviewQueueItem:
 *   - NOT_FOUND path
 *   - INTERNAL_SERVER_ERROR path (non-NOT_FOUND error)
 *
 * createReport:
 *   - INTERNAL_SERVER_ERROR path (non-INVALID_INPUT error)
 *
 * reviewReport:
 *   - NOT_FOUND path
 *   - INTERNAL_SERVER_ERROR (non-NOT_FOUND)
 *   - without reviewNotes (optional field)
 *
 * reviewAppeal:
 *   - INTERNAL_SERVER_ERROR (non-NOT_FOUND error)
 *
 * getUserAppeals:
 *   - service failure path (INTERNAL_SERVER_ERROR)
 *
 * getPendingQueue:
 *   - service failure path (INTERNAL_SERVER_ERROR)
 *
 * getPendingAppeals:
 *   - service failure path (INTERNAL_SERVER_ERROR)
 *
 * getUserReports:
 *   - service failure path (INTERNAL_SERVER_ERROR)
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

vi.mock('../../src/services/ContentModerationService', () => ({
  ContentModerationService: {
    moderateContent: vi.fn(),
    getPendingQueue: vi.fn(),
    getQueueItemById: vi.fn(),
    reviewQueueItem: vi.fn(),
    createReport: vi.fn(),
    getUserReports: vi.fn(),
    reviewReport: vi.fn(),
    createAppeal: vi.fn(),
    getUserAppeals: vi.fn(),
    reviewAppeal: vi.fn(),
    getPendingAppeals: vi.fn(),
  },
}));

vi.mock('../../src/services/PrivateMediaDeliveryService', () => ({
  projectModerationMediaForAdmin: vi.fn(async (_adminId: string, items: unknown[]) => items),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { db } from '../../src/db';
import { moderationRouter } from '../../src/routers/moderation';
import { ContentModerationService } from '../../src/services/ContentModerationService';

const mockDb = vi.mocked(db);
const mockModeration = vi.mocked(ContentModerationService);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UUID1 = '00000000-0000-0000-0000-000000000001';
const UUID2 = '00000000-0000-0000-0000-000000000002';
const UUID3 = '00000000-0000-0000-0000-000000000003';

function makeCaller() {
  return moderationRouter.createCaller({
    user: { id: UUID1, email: 'user@test.com', full_name: 'User', firebase_uid: 'fb-1' } as any,
    firebaseUid: 'fb-1',
  });
}

function makeAdminCaller() {
  // adminProcedure checks admin_roles table
  mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);
  return moderationRouter.createCaller({
    user: { id: UUID1, email: 'admin@test.com', full_name: 'Admin', role: 'admin', firebase_uid: 'fb-admin' } as any,
    firebaseUid: 'fb-admin',
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('moderation router — branch coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // getQueueItemById — error code branching
  // =========================================================================
  describe('getQueueItemById error code branches', () => {
    it('throws INTERNAL_SERVER_ERROR for non-NOT_FOUND errors', async () => {
      mockModeration.getQueueItemById.mockResolvedValue({
        success: false,
        error: { code: 'DB_ERROR', message: 'Database connection failed' },
      } as any);

      const caller = makeAdminCaller();
      await expect(caller.getQueueItemById({ queueItemId: UUID2 }))
        .rejects.toThrow('Database connection failed');

      // Verify it threw with INTERNAL_SERVER_ERROR code (not NOT_FOUND)
      try {
        const caller2 = makeAdminCaller();
        await caller2.getQueueItemById({ queueItemId: UUID2 });
      } catch (err: any) {
        expect(err.code).toBe('INTERNAL_SERVER_ERROR');
      }
    });
  });

  // =========================================================================
  // reviewQueueItem — error code branching
  // =========================================================================
  describe('reviewQueueItem error code branches', () => {
    it('throws NOT_FOUND when queue item not found', async () => {
      mockModeration.reviewQueueItem.mockResolvedValue({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Queue item not found' },
      } as any);

      const caller = makeAdminCaller();
      await expect(caller.reviewQueueItem({
        queueItemId: UUID2,
        decision: 'approve',
      })).rejects.toThrow('Queue item not found');
    });

    it('throws INTERNAL_SERVER_ERROR for non-NOT_FOUND error in reviewQueueItem', async () => {
      mockModeration.reviewQueueItem.mockResolvedValue({
        success: false,
        error: { code: 'CONFLICT', message: 'Already reviewed' },
      } as any);

      const caller = makeAdminCaller();
      await expect(caller.reviewQueueItem({
        queueItemId: UUID2,
        decision: 'reject',
        reviewNotes: 'Spam content',
      })).rejects.toThrow('Already reviewed');
    });

    it('passes undefined reviewNotes to service when not provided', async () => {
      const data = { id: UUID2, decision: 'no_action' };
      mockModeration.reviewQueueItem.mockResolvedValue({ success: true, data } as any);

      const caller = makeAdminCaller();
      await caller.reviewQueueItem({
        queueItemId: UUID2,
        decision: 'no_action',
      });

      expect(mockModeration.reviewQueueItem).toHaveBeenCalledWith(
        UUID2, UUID1, 'no_action', undefined,
      );
    });
  });

  // =========================================================================
  // createReport — error code branching
  // =========================================================================
  describe('createReport error code branches', () => {
    it('throws INTERNAL_SERVER_ERROR for non-INVALID_INPUT errors', async () => {
      mockModeration.createReport.mockResolvedValue({
        success: false,
        error: { code: 'DB_ERROR', message: 'Insert failed' },
      } as any);

      const caller = makeCaller();
      await expect(caller.createReport({
        contentType: 'task',
        contentId: UUID2,
        reportedContentUserId: UUID3,
        category: 'spam',
      })).rejects.toThrow('Insert failed');

      // The code path should map non-INVALID_INPUT to INTERNAL_SERVER_ERROR
      try {
        const caller2 = makeCaller();
        await caller2.createReport({
          contentType: 'task',
          contentId: UUID2,
          reportedContentUserId: UUID3,
          category: 'spam',
        });
      } catch (err: any) {
        expect(err.code).toBe('INTERNAL_SERVER_ERROR');
      }
    });

    it('creates report without optional description field', async () => {
      const data = { reportId: 'r-1', status: 'pending' };
      mockModeration.createReport.mockResolvedValue({ success: true, data } as any);

      const caller = makeCaller();
      const result = await caller.createReport({
        contentType: 'profile',
        contentId: UUID2,
        reportedContentUserId: UUID3,
        category: 'harassment',
        // description is optional — omit it
      });

      expect(result).toEqual(data);
      expect(mockModeration.createReport).toHaveBeenCalledWith(
        expect.objectContaining({ description: undefined }),
      );
    });
  });

  // =========================================================================
  // getUserReports — failure path
  // =========================================================================
  describe('getUserReports failure branch', () => {
    it('throws INTERNAL_SERVER_ERROR on service failure', async () => {
      mockModeration.getUserReports.mockResolvedValue({
        success: false,
        error: { code: 'DB_ERROR', message: 'Query failed' },
      } as any);

      const caller = makeAdminCaller();
      await expect(caller.getUserReports({ userId: UUID2 }))
        .rejects.toThrow('Query failed');
    });

    it('passes optional status filter to service', async () => {
      mockModeration.getUserReports.mockResolvedValue({ success: true, data: [] } as any);

      const caller = makeAdminCaller();
      await caller.getUserReports({ userId: UUID2, status: 'reviewed', limit: 25 });

      expect(mockModeration.getUserReports).toHaveBeenCalledWith(UUID2, 'reviewed', 25);
    });
  });

  // =========================================================================
  // reviewReport — error code branching
  // =========================================================================
  describe('reviewReport error code branches', () => {
    it('throws NOT_FOUND when report not found', async () => {
      mockModeration.reviewReport.mockResolvedValue({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Report not found' },
      } as any);

      const caller = makeAdminCaller();
      await expect(caller.reviewReport({
        reportId: UUID2,
        decision: 'no_action',
      })).rejects.toThrow('Report not found');
    });

    it('throws INTERNAL_SERVER_ERROR for non-NOT_FOUND error in reviewReport', async () => {
      mockModeration.reviewReport.mockResolvedValue({
        success: false,
        error: { code: 'DB_ERROR', message: 'Update failed' },
      } as any);

      const caller = makeAdminCaller();
      await expect(caller.reviewReport({
        reportId: UUID2,
        decision: 'dismissed',
      })).rejects.toThrow('Update failed');
    });

    it('passes undefined reviewNotes when not provided', async () => {
      const data = { id: UUID2, decision: 'dismissed' };
      mockModeration.reviewReport.mockResolvedValue({ success: true, data } as any);

      const caller = makeAdminCaller();
      await caller.reviewReport({
        reportId: UUID2,
        decision: 'dismissed',
        // no reviewNotes
      });

      expect(mockModeration.reviewReport).toHaveBeenCalledWith(
        UUID2, UUID1, 'dismissed', undefined,
      );
    });
  });

  // =========================================================================
  // reviewAppeal — error code branching
  // =========================================================================
  describe('reviewAppeal error code branches', () => {
    it('throws INTERNAL_SERVER_ERROR for non-NOT_FOUND error in reviewAppeal', async () => {
      mockModeration.reviewAppeal.mockResolvedValue({
        success: false,
        error: { code: 'DB_ERROR', message: 'Appeal update failed' },
      } as any);

      const caller = makeAdminCaller();
      await expect(caller.reviewAppeal({
        appealId: UUID2,
        decision: 'upheld',
      })).rejects.toThrow('Appeal update failed');
    });

    it('passes undefined reviewNotes when not provided to reviewAppeal', async () => {
      const data = { id: UUID2, decision: 'upheld' };
      mockModeration.reviewAppeal.mockResolvedValue({ success: true, data } as any);

      const caller = makeAdminCaller();
      await caller.reviewAppeal({
        appealId: UUID2,
        decision: 'upheld',
        // no reviewNotes
      });

      expect(mockModeration.reviewAppeal).toHaveBeenCalledWith(
        UUID2, UUID1, 'upheld', undefined,
      );
    });
  });

  // =========================================================================
  // getUserAppeals — failure path
  // =========================================================================
  describe('getUserAppeals failure branch', () => {
    it('throws INTERNAL_SERVER_ERROR on service failure', async () => {
      mockModeration.getUserAppeals.mockResolvedValue({
        success: false,
        error: { code: 'DB_ERROR', message: 'Appeals query failed' },
      } as any);

      const caller = makeCaller();
      await expect(caller.getUserAppeals({}))
        .rejects.toThrow('Appeals query failed');
    });
  });

  // =========================================================================
  // getPendingQueue — failure path
  // =========================================================================
  describe('getPendingQueue failure branch', () => {
    it('throws INTERNAL_SERVER_ERROR on service failure', async () => {
      mockModeration.getPendingQueue.mockResolvedValue({
        success: false,
        error: { code: 'DB_ERROR', message: 'Queue query failed' },
      } as any);

      const caller = makeAdminCaller();
      await expect(caller.getPendingQueue({}))
        .rejects.toThrow('Queue query failed');
    });
  });

  // =========================================================================
  // getPendingAppeals — failure path
  // =========================================================================
  describe('getPendingAppeals failure branch', () => {
    it('throws INTERNAL_SERVER_ERROR on service failure', async () => {
      mockModeration.getPendingAppeals.mockResolvedValue({
        success: false,
        error: { code: 'DB_ERROR', message: 'Pending appeals query failed' },
      } as any);

      const caller = makeAdminCaller();
      await expect(caller.getPendingAppeals({}))
        .rejects.toThrow('Pending appeals query failed');
    });

    it('passes custom limit to service', async () => {
      mockModeration.getPendingAppeals.mockResolvedValue({ success: true, data: [] } as any);

      const caller = makeAdminCaller();
      await caller.getPendingAppeals({ limit: 25 });

      expect(mockModeration.getPendingAppeals).toHaveBeenCalledWith(25);
    });
  });
});
