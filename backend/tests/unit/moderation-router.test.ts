/**
 * Content Moderation Router Unit Tests
 *
 * Tests all procedures:
 * - moderateContent (admin), getPendingQueue (admin), getQueueItemById (admin), reviewQueueItem (admin)
 * - createReport (protected), getUserReports (admin), reviewReport (admin)
 * - createAppeal (protected), getUserAppeals (protected), reviewAppeal (admin), getPendingAppeals (admin)
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
import { projectModerationMediaForAdmin } from '../../src/services/PrivateMediaDeliveryService';

const mockDb = vi.mocked(db);
const mockModeration = vi.mocked(ContentModerationService);
const mockProjectModerationMedia = vi.mocked(projectModerationMediaForAdmin);

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
  mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);
  return moderationRouter.createCaller({
    user: { id: UUID1, email: 'admin@test.com', full_name: 'Admin', role: 'admin', firebase_uid: 'fb-admin' } as any,
    firebaseUid: 'fb-admin',
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('moderation router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // moderateContent (admin)
  // =========================================================================
  describe('moderateContent', () => {
    it('moderates content on success', async () => {
      const data = { queueItemId: 'q-1', severity: 'HIGH' };
      mockModeration.moderateContent.mockResolvedValue({ success: true, data } as any);

      const caller = makeAdminCaller();
      const result = await caller.moderateContent({
        contentType: 'task',
        contentId: UUID2,
        userId: UUID3,
        flaggedBy: 'ai',
        aiConfidence: 0.9,
        aiRecommendation: 'flag',
      });

      expect(result).toEqual(data);
    });

    it('throws on service failure', async () => {
      mockModeration.moderateContent.mockResolvedValue({
        success: false,
        error: { code: 'DB_ERROR', message: 'Insert failed' },
      } as any);

      const caller = makeAdminCaller();
      await expect(caller.moderateContent({
        contentType: 'message',
        contentId: UUID2,
        userId: UUID3,
        flaggedBy: 'admin',
      })).rejects.toThrow('Insert failed');
    });
  });

  // =========================================================================
  // getPendingQueue (admin)
  // =========================================================================
  describe('getPendingQueue', () => {
    it('returns pending queue items', async () => {
      const data = [{ id: 'q-1', severity: 'HIGH' }];
      mockModeration.getPendingQueue.mockResolvedValue({ success: true, data } as any);

      const caller = makeAdminCaller();
      const result = await caller.getPendingQueue({});

      expect(result).toEqual(data);
      expect(mockModeration.getPendingQueue).toHaveBeenCalledWith(undefined, 100);
      expect(mockProjectModerationMedia).toHaveBeenCalledWith(UUID1, data);
    });

    it('passes severity filter', async () => {
      mockModeration.getPendingQueue.mockResolvedValue({ success: true, data: [] } as any);

      const caller = makeAdminCaller();
      await caller.getPendingQueue({ severity: 'CRITICAL', limit: 10 });

      expect(mockModeration.getPendingQueue).toHaveBeenCalledWith('CRITICAL', 10);
    });
  });

  // =========================================================================
  // getQueueItemById (admin)
  // =========================================================================
  describe('getQueueItemById', () => {
    it('returns queue item on success', async () => {
      const data = { id: UUID2, contentType: 'task' };
      mockModeration.getQueueItemById.mockResolvedValue({ success: true, data } as any);

      const caller = makeAdminCaller();
      const result = await caller.getQueueItemById({ queueItemId: UUID2 });

      expect(result).toEqual(data);
      expect(mockProjectModerationMedia).toHaveBeenCalledWith(UUID1, [data]);
    });

    it('throws NOT_FOUND', async () => {
      mockModeration.getQueueItemById.mockResolvedValue({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Queue item not found' },
      } as any);

      const caller = makeAdminCaller();
      await expect(caller.getQueueItemById({ queueItemId: UUID2 }))
        .rejects.toThrow('Queue item not found');
    });
  });

  // =========================================================================
  // reviewQueueItem (admin)
  // =========================================================================
  describe('reviewQueueItem', () => {
    it('reviews queue item on success', async () => {
      const data = { id: UUID2, decision: 'approve' };
      mockModeration.reviewQueueItem.mockResolvedValue({ success: true, data } as any);

      const caller = makeAdminCaller();
      const result = await caller.reviewQueueItem({
        queueItemId: UUID2,
        decision: 'approve',
        reviewNotes: 'Content is fine',
      });

      expect(result).toEqual(data);
      expect(mockModeration.reviewQueueItem).toHaveBeenCalledWith(
        UUID2, UUID1, 'approve', 'Content is fine',
      );
      expect(mockProjectModerationMedia).toHaveBeenCalledWith(UUID1, [data]);
    });
  });

  // =========================================================================
  // createReport (protected)
  // =========================================================================
  describe('createReport', () => {
    it('creates report on success', async () => {
      const data = { reportId: 'r-1', status: 'pending' };
      mockModeration.createReport.mockResolvedValue({ success: true, data } as any);

      const caller = makeCaller();
      const result = await caller.createReport({
        contentType: 'message',
        contentId: UUID2,
        reportedContentUserId: UUID3,
        category: 'spam',
        description: 'This is spam',
      });

      expect(result).toEqual(data);
      expect(mockModeration.createReport).toHaveBeenCalledWith({
        reporterUserId: UUID1,
        contentType: 'message',
        contentId: UUID2,
        reportedContentUserId: UUID3,
        category: 'spam',
        description: 'This is spam',
      });
    });

    it('throws BAD_REQUEST on INVALID_INPUT', async () => {
      mockModeration.createReport.mockResolvedValue({
        success: false,
        error: { code: 'INVALID_INPUT', message: 'Duplicate report' },
      } as any);

      const caller = makeCaller();
      await expect(caller.createReport({
        contentType: 'task',
        contentId: UUID2,
        reportedContentUserId: UUID3,
        category: 'spam',
      })).rejects.toThrow('Duplicate report');
    });
  });

  // =========================================================================
  // getUserReports (admin)
  // =========================================================================
  describe('getUserReports', () => {
    it('returns user reports', async () => {
      const data = [{ id: 'r-1' }];
      mockModeration.getUserReports.mockResolvedValue({ success: true, data } as any);

      const caller = makeAdminCaller();
      const result = await caller.getUserReports({ userId: UUID2 });

      expect(result).toEqual(data);
    });
  });

  // =========================================================================
  // reviewReport (admin)
  // =========================================================================
  describe('reviewReport', () => {
    it('reviews report on success', async () => {
      const data = { id: UUID2, decision: 'action_taken' };
      mockModeration.reviewReport.mockResolvedValue({ success: true, data } as any);

      const caller = makeAdminCaller();
      const result = await caller.reviewReport({
        reportId: UUID2,
        decision: 'action_taken',
      });

      expect(result).toEqual(data);
    });
  });

  // =========================================================================
  // createAppeal (protected)
  // =========================================================================
  describe('createAppeal', () => {
    it('creates appeal on success', async () => {
      const data = { appealId: 'a-1', status: 'pending' };
      mockModeration.createAppeal.mockResolvedValue({ success: true, data } as any);

      const caller = makeCaller();
      const result = await caller.createAppeal({
        moderationQueueId: UUID2,
        originalDecision: 'rejected',
        appealReason: 'My content was not violating any rules',
        deadline: '2025-02-01T00:00:00Z',
      });

      expect(result).toEqual(data);
    });

    it('throws on service failure', async () => {
      mockModeration.createAppeal.mockResolvedValue({
        success: false,
        error: { code: 'DB_ERROR', message: 'Failed to create appeal' },
      } as any);

      const caller = makeCaller();
      await expect(caller.createAppeal({
        moderationQueueId: UUID2,
        originalDecision: 'rejected',
        appealReason: 'Unfair decision',
        deadline: '2025-02-01T00:00:00Z',
      })).rejects.toThrow('Failed to create appeal');
    });
  });

  // =========================================================================
  // getUserAppeals (protected)
  // =========================================================================
  describe('getUserAppeals', () => {
    it('returns user appeals', async () => {
      const data = [{ id: 'a-1', status: 'pending' }];
      mockModeration.getUserAppeals.mockResolvedValue({ success: true, data } as any);

      const caller = makeCaller();
      const result = await caller.getUserAppeals({});

      expect(result).toEqual(data);
      expect(mockModeration.getUserAppeals).toHaveBeenCalledWith(UUID1, undefined, 50);
    });

    it('passes optional status filter', async () => {
      mockModeration.getUserAppeals.mockResolvedValue({ success: true, data: [] } as any);

      const caller = makeCaller();
      await caller.getUserAppeals({ status: 'upheld', limit: 10 });

      expect(mockModeration.getUserAppeals).toHaveBeenCalledWith(UUID1, 'upheld', 10);
    });
  });

  // =========================================================================
  // reviewAppeal (admin)
  // =========================================================================
  describe('reviewAppeal', () => {
    it('reviews appeal on success', async () => {
      const data = { id: UUID2, decision: 'overturned' };
      mockModeration.reviewAppeal.mockResolvedValue({ success: true, data } as any);

      const caller = makeAdminCaller();
      const result = await caller.reviewAppeal({
        appealId: UUID2,
        decision: 'overturned',
        reviewNotes: 'Appeal granted',
      });

      expect(result).toEqual(data);
    });

    it('throws NOT_FOUND when appeal not found', async () => {
      mockModeration.reviewAppeal.mockResolvedValue({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Appeal not found' },
      } as any);

      const caller = makeAdminCaller();
      await expect(caller.reviewAppeal({
        appealId: UUID2,
        decision: 'upheld',
      })).rejects.toThrow('Appeal not found');
    });
  });

  // =========================================================================
  // getPendingAppeals (admin)
  // =========================================================================
  describe('getPendingAppeals', () => {
    it('returns pending appeals with default limit', async () => {
      const data = [{ id: 'a-1' }];
      mockModeration.getPendingAppeals.mockResolvedValue({ success: true, data } as any);

      const caller = makeAdminCaller();
      const result = await caller.getPendingAppeals({});

      expect(result).toEqual(data);
      expect(mockModeration.getPendingAppeals).toHaveBeenCalledWith(100);
    });
  });
});
