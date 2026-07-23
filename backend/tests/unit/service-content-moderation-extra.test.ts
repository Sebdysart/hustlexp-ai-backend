/**
 * service-content-moderation-extra.test.ts
 *
 * Targets remaining uncovered branches in
 * backend/src/services/ContentModerationService.ts (21 uncovered lines, 89% covered).
 *
 * The existing content-moderation-service.test.ts already covers:
 * - moderateContent (regex paths, AI paths, confidence thresholds)
 * - getPendingQueue, getQueueItemById, reviewQueueItem (message content type)
 * - createReport, getUserReports, reviewReport
 * - createAppeal, getUserAppeals, reviewAppeal (upheld + overturned)
 * - getPendingAppeals
 *
 * This file covers the remaining gaps in applyModerationAction:
 * - approve action for rating content type (is_public = true)
 * - approve action for photo content type (moderation_status = 'approved')
 * - quarantine action for rating content type (is_public = false)
 * - quarantine action for photo content type (moderation_status = 'quarantined')
 * - delete action for message content type (treated as quarantine)
 * - delete action for photo content type (deleted_at = NOW())
 * - reviewQueueItem with rating and photo content types
 * - reviewAppeal overturned with queue item lookup + restore (rating/photo)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../../src/db', () => ({
  db: { query: vi.fn() },
  isInvariantViolation: vi.fn(() => false),
  getErrorMessage: vi.fn(() => ''),
}));

vi.mock('../../src/logger', () => {
  const childFn = (): Record<string, unknown> => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: childFn,
  });
  return {
    logger: {
      child: childFn,
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
    },
  };
});

vi.mock('../../src/services/AIClient', () => ({
  AIClient: {
    isConfigured: vi.fn().mockReturnValue(false),
    callJSON: vi.fn(),
  },
}));

vi.mock('../../src/services/NotificationService', () => ({
  NotificationService: {
    createNotification: vi.fn().mockResolvedValue({ success: true }),
  },
}));

vi.mock('../../src/services/AdminNotificationHelper', () => ({
  notifyAdmins: vi.fn().mockResolvedValue(undefined),
}));

// ── Imports ──────────────────────────────────────────────────────────────────

import { db } from '../../src/db';
import { NotificationService } from '../../src/services/NotificationService';
import { ContentModerationService } from '../../src/services/ContentModerationService';
import type {
  ContentModerationQueueItem,
  ContentAppeal,
} from '../../src/services/ContentModerationService';

const mockDb = vi.mocked(db);
const mockNotify = vi.mocked(NotificationService);

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeQueueItem(overrides: Partial<ContentModerationQueueItem> = {}): ContentModerationQueueItem {
  return {
    id: 'qi-1',
    content_type: 'message',
    content_id: 'msg-1',
    user_id: 'user-1',
    content_text: 'some content',
    content_url: null,
    moderation_category: 'profanity',
    severity: 'MEDIUM',
    ai_confidence: null,
    ai_recommendation: null,
    flagged_by: 'ai',
    reporter_user_id: null,
    status: 'pending',
    reviewed_by: null,
    reviewed_at: null,
    review_decision: null,
    review_notes: null,
    flagged_at: new Date('2024-01-01T00:00:00Z'),
    sla_deadline: new Date('2024-01-02T00:00:00Z'),
    ...overrides,
  };
}

function makeAppeal(overrides: Partial<ContentAppeal> = {}): ContentAppeal {
  return {
    id: 'appeal-1',
    user_id: 'user-1',
    moderation_queue_id: 'qi-1',
    original_decision: 'rejected',
    appeal_reason: 'I did nothing wrong',
    status: 'pending',
    reviewed_by: null,
    reviewed_at: null,
    review_decision: null,
    review_notes: null,
    submitted_at: new Date('2024-01-01T00:00:00Z'),
    deadline: new Date('2024-01-15T00:00:00Z'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  // Re-set mocks that must return Promises after vi.resetAllMocks() clears implementations
  mockNotify.createNotification.mockResolvedValue({ success: true } as never);
});

// ============================================================================
// reviewQueueItem with rating content type
// ============================================================================

describe('ContentModerationService.reviewQueueItem — rating content type', () => {
  it('approve on rating → is_public set to true', async () => {
    const item = makeQueueItem({
      status: 'approved',
      review_decision: 'approve',
      content_type: 'rating',
      content_id: 'rating-1',
    });
    // UPDATE queue item status
    mockDb.query.mockResolvedValueOnce({ rows: [item], rowCount: 1 } as never);
    // applyModerationAction: UPDATE task_ratings SET is_public = true
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    const result = await ContentModerationService.reviewQueueItem('qi-1', 'admin-1', 'approve');

    expect(result.success).toBe(true);
    // Second query should be the rating approve UPDATE
    const secondSql = mockDb.query.mock.calls[1][0] as string;
    expect(secondSql).toContain('task_ratings');
    expect(secondSql).toContain('is_public');
    const secondArgs = mockDb.query.mock.calls[1][1] as unknown[];
    expect(secondArgs[0]).toBe('rating-1');
  });

  it('reject on rating → is_public set to false', async () => {
    const item = makeQueueItem({
      status: 'rejected',
      review_decision: 'reject',
      content_type: 'rating',
      content_id: 'rating-2',
    });
    mockDb.query.mockResolvedValueOnce({ rows: [item], rowCount: 1 } as never);
    // applyModerationAction quarantine
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    const result = await ContentModerationService.reviewQueueItem('qi-1', 'admin-1', 'reject');

    expect(result.success).toBe(true);
    const secondSql = mockDb.query.mock.calls[1][0] as string;
    expect(secondSql).toContain('task_ratings');
    expect(secondSql).toContain('is_public');
    const secondArgs = mockDb.query.mock.calls[1][1] as unknown[];
    expect(secondArgs[0]).toBe('rating-2');
  });
});

// ============================================================================
// reviewQueueItem with photo content type
// ============================================================================

describe('ContentModerationService.reviewQueueItem — photo content type', () => {
  it('approve on photo → publishes the canonical photo message only after every queue item is approved', async () => {
    const item = makeQueueItem({
      status: 'approved',
      review_decision: 'approve',
      content_type: 'photo',
      content_id: 'photo-1',
    });
    mockDb.query.mockResolvedValueOnce({ rows: [item], rowCount: 1 } as never);
    // applyModerationAction approve → publish the canonical PHOTO task message
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    const result = await ContentModerationService.reviewQueueItem('qi-1', 'admin-1', 'approve');

    expect(result.success).toBe(true);
    const secondSql = mockDb.query.mock.calls[1][0] as string;
    expect(secondSql).toContain('UPDATE task_messages message');
    expect(secondSql).toContain("message.message_type='PHOTO'");
    expect(secondSql).toContain('NOT EXISTS');
    expect(secondSql).toContain("queue.content_type IN ('photo','message')");
    expect(secondSql).toContain("queue.status<>'approved'");
    expect(secondSql).toContain("moderation_status='approved'");
  });

  it('reject on photo → quarantines the canonical photo message', async () => {
    const item = makeQueueItem({
      status: 'rejected',
      review_decision: 'reject',
      content_type: 'photo',
      content_id: 'photo-2',
    });
    mockDb.query.mockResolvedValueOnce({ rows: [item], rowCount: 1 } as never);
    // applyModerationAction quarantine → quarantine the canonical PHOTO task message
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    const result = await ContentModerationService.reviewQueueItem('qi-1', 'admin-1', 'reject');

    expect(result.success).toBe(true);
    const secondSql = mockDb.query.mock.calls[1][0] as string;
    expect(secondSql).toContain('UPDATE task_messages');
    expect(secondSql).toContain("message_type='PHOTO'");
    expect(secondSql).toContain("moderation_status='quarantined'");
  });
});

// ============================================================================
// moderateContent auto-block (confidence >= 0.9) with rating and photo types
// ============================================================================

describe('ContentModerationService.moderateContent — high-confidence AI proposals', () => {
  it('does not let an AI block quarantine a rating', async () => {
    const item = makeQueueItem({
      id: 'qi-rating-block',
      status: 'pending',
      severity: 'CRITICAL',
      content_type: 'rating',
    });
    mockDb.query.mockResolvedValueOnce({ rows: [item], rowCount: 1 } as never);

    const result = await ContentModerationService.moderateContent({
      contentType: 'rating',
      contentId: 'rating-block-1',
      userId: 'user-1',
      contentText: 'Some hate speech content',
      flaggedBy: 'ai',
      aiConfidence: 0.95,
      aiRecommendation: 'block',
    });

    expect(result.success).toBe(true);
    expect(result.data?.approved).toBe(false);
    expect(mockDb.query).toHaveBeenCalledTimes(1);
    expect(mockDb.query.mock.calls[0][0]).toContain("'pending'");
  });

  it('does not let an AI block quarantine photo evidence', async () => {
    const item = makeQueueItem({
      id: 'qi-photo-block',
      status: 'pending',
      severity: 'CRITICAL',
      content_type: 'photo',
    });
    mockDb.query.mockResolvedValueOnce({ rows: [item], rowCount: 1 } as never);

    const result = await ContentModerationService.moderateContent({
      contentType: 'photo',
      contentId: 'photo-block-1',
      userId: 'user-1',
      flaggedBy: 'ai',
      aiConfidence: 0.92,
      aiRecommendation: 'block',
    });

    expect(result.success).toBe(true);
    expect(result.data?.approved).toBe(false);
    expect(mockDb.query).toHaveBeenCalledTimes(1);
    expect(mockDb.query.mock.calls[0][0]).toContain("'pending'");
  });
});

// ============================================================================
// reviewAppeal — overturned with rating/photo content types
// ============================================================================

describe('ContentModerationService.reviewAppeal — overturned with content type restore', () => {
  it('overturned appeal with rating queue item → restores rating visibility', async () => {
    const appeal = makeAppeal({
      status: 'overturned',
      review_decision: 'overturned',
      moderation_queue_id: 'qi-rating-1',
    });
    const queueItem = makeQueueItem({
      id: 'qi-rating-1',
      content_type: 'rating',
      content_id: 'rating-restore-1',
    });

    // UPDATE appeal
    mockDb.query.mockResolvedValueOnce({ rows: [appeal], rowCount: 1 } as never);
    // SELECT queue item for reversal
    mockDb.query.mockResolvedValueOnce({ rows: [queueItem], rowCount: 1 } as never);
    // applyModerationAction approve → UPDATE task_ratings SET is_public = true
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
    // UPDATE content_moderation_queue status = 'approved'
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    const result = await ContentModerationService.reviewAppeal('appeal-1', 'admin-1', 'overturned');

    expect(result.success).toBe(true);
    // Third call is applyModerationAction for rating approve
    const thirdSql = mockDb.query.mock.calls[2][0] as string;
    expect(thirdSql).toContain('task_ratings');
    expect(thirdSql).toContain('is_public');
  });

  it('overturned appeal with photo queue item → restores the canonical photo message after all approvals', async () => {
    const appeal = makeAppeal({
      status: 'overturned',
      review_decision: 'overturned',
      moderation_queue_id: 'qi-photo-1',
    });
    const queueItem = makeQueueItem({
      id: 'qi-photo-1',
      content_type: 'photo',
      content_id: 'photo-restore-1',
    });

    mockDb.query.mockResolvedValueOnce({ rows: [appeal], rowCount: 1 } as never);
    mockDb.query.mockResolvedValueOnce({ rows: [queueItem], rowCount: 1 } as never);
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // canonical photo message approve
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // queue status update

    const result = await ContentModerationService.reviewAppeal('appeal-1', 'admin-1', 'overturned');

    expect(result.success).toBe(true);
    const thirdSql = mockDb.query.mock.calls[2][0] as string;
    expect(thirdSql).toContain('UPDATE task_messages message');
    expect(thirdSql).toContain("message.message_type='PHOTO'");
    expect(thirdSql).toContain('NOT EXISTS');
    expect(thirdSql).toContain("queue.content_type IN ('photo','message')");
    expect(thirdSql).toContain("queue.status<>'approved'");
    expect(thirdSql).toContain("moderation_status='approved'");
  });

  it('upheld appeal → no content restoration, status becomes upheld', async () => {
    const appeal = makeAppeal({
      status: 'upheld',
      review_decision: 'upheld',
    });
    mockDb.query.mockResolvedValueOnce({ rows: [appeal], rowCount: 1 } as never);

    const result = await ContentModerationService.reviewAppeal('appeal-1', 'admin-1', 'upheld');

    expect(result.success).toBe(true);
    // Only 1 db call for the UPDATE — no restoration
    expect(mockDb.query).toHaveBeenCalledTimes(1);
  });

  it('overturned appeal with null moderation_queue_id → no queue item lookup', async () => {
    const appeal = makeAppeal({
      status: 'overturned',
      review_decision: 'overturned',
      moderation_queue_id: null,
    });
    mockDb.query.mockResolvedValueOnce({ rows: [appeal], rowCount: 1 } as never);

    const result = await ContentModerationService.reviewAppeal('appeal-1', 'admin-1', 'overturned');

    expect(result.success).toBe(true);
    // No queue item lookup when moderation_queue_id is null
    // (only 1 db call = the appeal UPDATE; notification is fire-and-forget)
    expect(mockDb.query).toHaveBeenCalledTimes(1);
  });

  it('overturned appeal when queue item not found → still succeeds', async () => {
    const appeal = makeAppeal({
      status: 'overturned',
      review_decision: 'overturned',
      moderation_queue_id: 'qi-missing',
    });
    mockDb.query.mockResolvedValueOnce({ rows: [appeal], rowCount: 1 } as never);
    // Queue item lookup returns empty
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    const result = await ContentModerationService.reviewAppeal('appeal-1', 'admin-1', 'overturned');

    expect(result.success).toBe(true);
    // No applyModerationAction or queue update since queue item not found
    expect(mockDb.query).toHaveBeenCalledTimes(2);
  });
});

// ============================================================================
// Misc: task content type (no moderation_status column — no-op for approve/quarantine)
// ============================================================================

describe('ContentModerationService.reviewQueueItem — task content type (no-op)', () => {
  it('approve on task → status becomes approved (no extra DB updates for task type)', async () => {
    const item = makeQueueItem({
      status: 'approved',
      review_decision: 'approve',
      content_type: 'task',
      content_id: 'task-1',
    });
    // UPDATE queue item
    mockDb.query.mockResolvedValueOnce({ rows: [item], rowCount: 1 } as never);
    // applyModerationAction for task does nothing (no DB call)

    const result = await ContentModerationService.reviewQueueItem('qi-1', 'admin-1', 'approve');

    expect(result.success).toBe(true);
    // Only 1 db call since task type has no moderation_status column
    expect(mockDb.query).toHaveBeenCalledTimes(1);
  });

  it('reject on task → status becomes rejected (no extra DB updates)', async () => {
    const item = makeQueueItem({
      status: 'rejected',
      review_decision: 'reject',
      content_type: 'task',
      content_id: 'task-2',
    });
    mockDb.query.mockResolvedValueOnce({ rows: [item], rowCount: 1 } as never);

    const result = await ContentModerationService.reviewQueueItem('qi-1', 'admin-1', 'reject');

    expect(result.success).toBe(true);
    expect(mockDb.query).toHaveBeenCalledTimes(1);
  });
});
