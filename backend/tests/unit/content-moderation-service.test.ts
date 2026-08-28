/**
 * ContentModerationService Unit Tests
 *
 * Covers: moderateContent (AI path, regex fallback, auto-block, flag, approve),
 * getPendingQueue, getQueueItemById, reviewQueueItem, createReport, getUserReports,
 * reviewReport, createAppeal, getUserAppeals, reviewAppeal, getPendingAppeals.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// MOCKS — must be hoisted before any imports from the module under test
// ============================================================================

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

// ============================================================================
// IMPORTS (after mocks)
// ============================================================================

import { db } from '../../src/db';
import { AIClient } from '../../src/services/AIClient';
import { ContentModerationService } from '../../src/services/ContentModerationService';
import type {
  ContentModerationQueueItem,
  ContentReport,
  ContentAppeal,
} from '../../src/services/ContentModerationService';

const mockDb = vi.mocked(db);
const mockAIClient = vi.mocked(AIClient);

// ============================================================================
// HELPERS
// ============================================================================

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

function makeReport(overrides: Partial<ContentReport> = {}): ContentReport {
  return {
    id: 'rep-1',
    reporter_user_id: 'reporter-1',
    content_type: 'message',
    content_id: 'msg-1',
    reported_content_user_id: 'reported-1',
    category: 'spam',
    description: 'This is spam',
    status: 'pending',
    reviewed_by: null,
    reviewed_at: null,
    review_decision: null,
    review_notes: null,
    reported_at: new Date('2024-01-01T00:00:00Z'),
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

// ============================================================================
// TESTS
// ============================================================================

beforeEach(() => {
  vi.clearAllMocks();
  // Default: AI not configured → regex fallback path
  mockAIClient.isConfigured.mockReturnValue(false);
});

// ----------------------------------------------------------------------------
// 1. moderateContent
// ----------------------------------------------------------------------------

describe('ContentModerationService.moderateContent', () => {
  describe('regex fallback (AI not configured)', () => {
    it('clean content with no AI confidence → inserts pending queue item', async () => {
      const item = makeQueueItem({ status: 'pending', moderation_category: 'profanity' });
      mockDb.query.mockResolvedValueOnce({ rows: [item], rowCount: 1 } as never);

      const result = await ContentModerationService.moderateContent({
        contentType: 'message',
        contentId: 'msg-1',
        userId: 'user-1',
        contentText: 'Hello, how are you?',
        flaggedBy: 'ai',
      });

      expect(result.success).toBe(true);
      expect(result.data?.approved).toBe(false);
      expect(result.data?.queueItemId).toBe('qi-1');
      expect(mockDb.query).toHaveBeenCalledTimes(1);
    });

    it('phone number in content → category becomes personal_info', async () => {
      const item = makeQueueItem({ moderation_category: 'personal_info' });
      mockDb.query.mockResolvedValueOnce({ rows: [item], rowCount: 1 } as never);

      const result = await ContentModerationService.moderateContent({
        contentType: 'message',
        contentId: 'msg-2',
        userId: 'user-1',
        contentText: 'Call me at 555-867-5309',
        flaggedBy: 'ai',
      });

      expect(result.success).toBe(true);
      // Verify the query was called with personal_info category (6th positional param)
      const args = mockDb.query.mock.calls[0][1] as unknown[];
      expect(args[5]).toBe('personal_info');
    });

    it('email address in content → category becomes personal_info', async () => {
      const item = makeQueueItem({ moderation_category: 'personal_info' });
      mockDb.query.mockResolvedValueOnce({ rows: [item], rowCount: 1 } as never);

      await ContentModerationService.moderateContent({
        contentType: 'message',
        contentId: 'msg-3',
        userId: 'user-1',
        contentText: 'Email me at john.doe@example.com',
        flaggedBy: 'ai',
      });

      const args = mockDb.query.mock.calls[0][1] as unknown[];
      expect(args[5]).toBe('personal_info');
    });

    it('URL in content → category becomes phishing', async () => {
      const item = makeQueueItem({ moderation_category: 'phishing' });
      mockDb.query.mockResolvedValueOnce({ rows: [item], rowCount: 1 } as never);

      await ContentModerationService.moderateContent({
        contentType: 'message',
        contentId: 'msg-4',
        userId: 'user-1',
        contentText: 'Check out https://evil-site.com for free money',
        flaggedBy: 'ai',
      });

      const args = mockDb.query.mock.calls[0][1] as unknown[];
      expect(args[5]).toBe('phishing');
    });

    it('www. URL in content → category becomes phishing', async () => {
      const item = makeQueueItem({ moderation_category: 'phishing' });
      mockDb.query.mockResolvedValueOnce({ rows: [item], rowCount: 1 } as never);

      await ContentModerationService.moderateContent({
        contentType: 'message',
        contentId: 'msg-5',
        userId: 'user-1',
        contentText: 'Visit www.spam.com right now',
        flaggedBy: 'ai',
      });

      const args = mockDb.query.mock.calls[0][1] as unknown[];
      expect(args[5]).toBe('phishing');
    });

    it('profanity in content → category stays profanity', async () => {
      const item = makeQueueItem({ moderation_category: 'profanity' });
      mockDb.query.mockResolvedValueOnce({ rows: [item], rowCount: 1 } as never);

      await ContentModerationService.moderateContent({
        contentType: 'message',
        contentId: 'msg-6',
        userId: 'user-1',
        contentText: 'What the fuck is this',
        flaggedBy: 'ai',
      });

      const args = mockDb.query.mock.calls[0][1] as unknown[];
      expect(args[5]).toBe('profanity');
    });

    it('harassment pattern in content → category becomes harassment', async () => {
      const item = makeQueueItem({ moderation_category: 'harassment' });
      mockDb.query.mockResolvedValueOnce({ rows: [item], rowCount: 1 } as never);

      await ContentModerationService.moderateContent({
        contentType: 'message',
        contentId: 'msg-7',
        userId: 'user-1',
        contentText: 'I hate you so much',
        flaggedBy: 'ai',
      });

      const args = mockDb.query.mock.calls[0][1] as unknown[];
      expect(args[5]).toBe('harassment');
    });

    it('spam pattern in content → category becomes spam', async () => {
      const item = makeQueueItem({ moderation_category: 'spam' });
      mockDb.query.mockResolvedValueOnce({ rows: [item], rowCount: 1 } as never);

      await ContentModerationService.moderateContent({
        contentType: 'message',
        contentId: 'msg-8',
        userId: 'user-1',
        contentText: 'BUY NOW LIMITED offer today',
        flaggedBy: 'ai',
      });

      const args = mockDb.query.mock.calls[0][1] as unknown[];
      expect(args[5]).toBe('spam');
    });
  });

  describe('AI confidence thresholds', () => {
    it('aiConfidence < 0.5 + recommendation=approve remains pending for human review', async () => {
      const item = makeQueueItem({ status: 'pending', severity: 'LOW' });
      mockDb.query.mockResolvedValueOnce({ rows: [item], rowCount: 1 } as never);
      const result = await ContentModerationService.moderateContent({
        contentType: 'message',
        contentId: 'msg-9',
        userId: 'user-1',
        contentText: 'Clean content here',
        flaggedBy: 'ai',
        aiConfidence: 0.3,
        aiRecommendation: 'approve',
      });

      expect(result.success).toBe(true);
      expect(result.data?.approved).toBe(false);
      expect(result.data?.queueItemId).toBe('qi-1');
      expect(mockDb.query.mock.calls[0][0]).toContain("'pending'");
    });

    it('aiConfidence >= 0.7 (flag threshold) → inserts pending queue item', async () => {
      const item = makeQueueItem({ status: 'pending', severity: 'HIGH' });
      mockDb.query.mockResolvedValueOnce({ rows: [item], rowCount: 1 } as never);

      const result = await ContentModerationService.moderateContent({
        contentType: 'message',
        contentId: 'msg-10',
        userId: 'user-1',
        contentText: 'Suspicious content',
        flaggedBy: 'ai',
        aiConfidence: 0.75,
        aiRecommendation: 'flag',
      });

      expect(result.success).toBe(true);
      expect(result.data?.approved).toBe(false);
      expect(result.data?.queueItemId).toBe('qi-1');
      // Should use pending INSERT (not auto-block INSERT)
      const sql = mockDb.query.mock.calls[0][0] as string;
      expect(sql).toContain("'pending'");
    });

    it('aiConfidence >= 0.9 + recommendation=block remains a pending proposal', async () => {
      const item = makeQueueItem({ status: 'pending', severity: 'CRITICAL' });
      mockDb.query.mockResolvedValueOnce({ rows: [item], rowCount: 1 } as never);

      const result = await ContentModerationService.moderateContent({
        contentType: 'message',
        contentId: 'msg-11',
        userId: 'user-1',
        contentText: 'Clearly violating content',
        flaggedBy: 'ai',
        aiConfidence: 0.95,
        aiRecommendation: 'block',
      });

      expect(result.success).toBe(true);
      expect(result.data?.approved).toBe(false);
      expect(result.data?.queueItemId).toBe('qi-1');
      expect(mockDb.query).toHaveBeenCalledTimes(1);
      const insertSql = mockDb.query.mock.calls[0][0] as string;
      expect(insertSql).toContain("'pending'");
    });

    it('aiConfidence = 0.9 exactly prioritizes but does not auto-block', async () => {
      const item = makeQueueItem({ status: 'pending', severity: 'CRITICAL' });
      mockDb.query.mockResolvedValueOnce({ rows: [item], rowCount: 1 } as never);

      const result = await ContentModerationService.moderateContent({
        contentType: 'message',
        contentId: 'msg-12',
        userId: 'user-1',
        flaggedBy: 'ai',
        aiConfidence: 0.9,
        aiRecommendation: 'block',
      });

      expect(result.success).toBe(true);
      expect(result.data?.approved).toBe(false);
    });

    it('aiConfidence = 0.7 exactly → flag threshold is inclusive', async () => {
      const item = makeQueueItem({ status: 'pending', severity: 'HIGH' });
      mockDb.query.mockResolvedValueOnce({ rows: [item], rowCount: 1 } as never);

      const result = await ContentModerationService.moderateContent({
        contentType: 'task',
        contentId: 'task-1',
        userId: 'user-1',
        flaggedBy: 'ai',
        aiConfidence: 0.7,
        aiRecommendation: 'flag',
      });

      expect(result.success).toBe(true);
      expect(result.data?.approved).toBe(false);
      const sql = mockDb.query.mock.calls[0][0] as string;
      expect(sql).toContain("'pending'");
    });

    it('severity is CRITICAL when aiConfidence >= 0.9', async () => {
      const item = makeQueueItem({ severity: 'CRITICAL' });
      mockDb.query.mockResolvedValueOnce({ rows: [item], rowCount: 1 } as never);

      await ContentModerationService.moderateContent({
        contentType: 'message',
        contentId: 'msg-13',
        userId: 'user-1',
        flaggedBy: 'ai',
        aiConfidence: 0.95,
        aiRecommendation: 'block',
      });

      const args = mockDb.query.mock.calls[0][1] as unknown[];
      expect(args[6]).toBe('CRITICAL');
    });

    it('severity is HIGH when aiConfidence in [0.7, 0.9)', async () => {
      const item = makeQueueItem({ severity: 'HIGH' });
      mockDb.query.mockResolvedValueOnce({ rows: [item], rowCount: 1 } as never);

      await ContentModerationService.moderateContent({
        contentType: 'message',
        contentId: 'msg-14',
        userId: 'user-1',
        flaggedBy: 'ai',
        aiConfidence: 0.8,
        aiRecommendation: 'flag',
      });

      const args = mockDb.query.mock.calls[0][1] as unknown[];
      expect(args[6]).toBe('HIGH');
    });

    it('severity is MEDIUM when aiConfidence in [0.5, 0.7)', async () => {
      const item = makeQueueItem({ severity: 'MEDIUM' });
      mockDb.query.mockResolvedValueOnce({ rows: [item], rowCount: 1 } as never);

      await ContentModerationService.moderateContent({
        contentType: 'message',
        contentId: 'msg-15',
        userId: 'user-1',
        flaggedBy: 'ai',
        aiConfidence: 0.6,
        aiRecommendation: 'flag',
      });

      const args = mockDb.query.mock.calls[0][1] as unknown[];
      expect(args[6]).toBe('MEDIUM');
    });

    it('severity is LOW when aiConfidence < 0.5 (but no approve recommendation)', async () => {
      const item = makeQueueItem({ severity: 'LOW' });
      mockDb.query.mockResolvedValueOnce({ rows: [item], rowCount: 1 } as never);

      await ContentModerationService.moderateContent({
        contentType: 'message',
        contentId: 'msg-16',
        userId: 'user-1',
        flaggedBy: 'ai',
        aiConfidence: 0.3,
        aiRecommendation: 'flag', // not 'approve' so no early return
      });

      const args = mockDb.query.mock.calls[0][1] as unknown[];
      expect(args[6]).toBe('LOW');
    });
  });

  describe('AI enabled path', () => {
    beforeEach(() => {
      mockAIClient.isConfigured.mockReturnValue(true);
    });

    it('AI returns safe category with high confidence but cannot auto-approve', async () => {
      mockAIClient.callJSON.mockResolvedValueOnce({
        data: { category: 'safe', confidence: 0.95, recommendation: 'approve' },
      } as never);

      const item = makeQueueItem({ status: 'pending' });
      mockDb.query.mockResolvedValueOnce({ rows: [item], rowCount: 1 } as never);
      const result = await ContentModerationService.moderateContent({
        contentType: 'message',
        contentId: 'msg-17',
        userId: 'user-1',
        contentText: 'Good day to you sir',
        flaggedBy: 'ai',
      });

      expect(result.success).toBe(true);
      expect(result.data?.approved).toBe(false);
      expect(result.data?.queueItemId).toBe('qi-1');
      expect(mockDb.query.mock.calls[0][0]).toContain("'pending'");
    });

    it('AI returns non-safe category → uses AI category for moderation', async () => {
      mockAIClient.callJSON.mockResolvedValueOnce({
        data: { category: 'spam', confidence: 0.85, recommendation: 'flag' },
      } as never);
      const item = makeQueueItem({ moderation_category: 'spam', status: 'pending' });
      mockDb.query.mockResolvedValueOnce({ rows: [item], rowCount: 1 } as never);

      const result = await ContentModerationService.moderateContent({
        contentType: 'message',
        contentId: 'msg-18',
        userId: 'user-1',
        contentText: 'Buy now limited time offer',
        flaggedBy: 'ai',
      });

      expect(result.success).toBe(true);
      expect(result.data?.approved).toBe(false);
      const args = mockDb.query.mock.calls[0][1] as unknown[];
      expect(args[5]).toBe('spam');
    });

    it('AI call fails → falls back to regex patterns gracefully', async () => {
      mockAIClient.callJSON.mockRejectedValueOnce(new Error('AI timeout'));
      const item = makeQueueItem({ moderation_category: 'profanity' });
      mockDb.query.mockResolvedValueOnce({ rows: [item], rowCount: 1 } as never);

      const result = await ContentModerationService.moderateContent({
        contentType: 'message',
        contentId: 'msg-19',
        userId: 'user-1',
        contentText: 'This is damn annoying',
        flaggedBy: 'ai',
      });

      expect(result.success).toBe(true);
      expect(result.data?.approved).toBe(false);
    });
  });

  describe('error handling', () => {
    it('returns DB_ERROR when db.query throws', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('Connection refused'));

      const result = await ContentModerationService.moderateContent({
        contentType: 'message',
        contentId: 'msg-20',
        userId: 'user-1',
        contentText: 'some text',
        flaggedBy: 'ai',
        aiConfidence: 0.75,
        aiRecommendation: 'flag',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('DB_ERROR');
    });
  });
});

// ----------------------------------------------------------------------------
// 2. getPendingQueue
// ----------------------------------------------------------------------------

describe('ContentModerationService.getPendingQueue', () => {
  it('returns list of pending items', async () => {
    const items = [makeQueueItem({ id: 'qi-1' }), makeQueueItem({ id: 'qi-2' })];
    mockDb.query.mockResolvedValueOnce({ rows: items, rowCount: 2 } as never);

    const result = await ContentModerationService.getPendingQueue();

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(2);
    expect(result.data![0].id).toBe('qi-1');
  });

  it('returns empty array when no pending items', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    const result = await ContentModerationService.getPendingQueue();

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(0);
  });

  it('filters by severity when severity is provided', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    await ContentModerationService.getPendingQueue('CRITICAL');

    const sql = mockDb.query.mock.calls[0][0] as string;
    const params = mockDb.query.mock.calls[0][1] as unknown[];
    expect(sql).toContain('severity');
    expect(params).toContain('CRITICAL');
  });

  it('uses custom limit', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    await ContentModerationService.getPendingQueue(undefined, 10);

    const params = mockDb.query.mock.calls[0][1] as unknown[];
    expect(params).toContain(10);
  });

  it('returns DB_ERROR on failure', async () => {
    mockDb.query.mockRejectedValueOnce(new Error('timeout'));

    const result = await ContentModerationService.getPendingQueue();

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DB_ERROR');
  });
});

// ----------------------------------------------------------------------------
// 3. getQueueItemById
// ----------------------------------------------------------------------------

describe('ContentModerationService.getQueueItemById', () => {
  it('returns queue item when found', async () => {
    const item = makeQueueItem({ id: 'qi-42' });
    mockDb.query.mockResolvedValueOnce({ rows: [item], rowCount: 1 } as never);

    const result = await ContentModerationService.getQueueItemById('qi-42');

    expect(result.success).toBe(true);
    expect(result.data?.id).toBe('qi-42');
  });

  it('returns NOT_FOUND when item does not exist', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    const result = await ContentModerationService.getQueueItemById('nonexistent');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NOT_FOUND');
    expect(result.error?.message).toContain('nonexistent');
  });

  it('returns DB_ERROR on failure', async () => {
    mockDb.query.mockRejectedValueOnce(new Error('DB down'));

    const result = await ContentModerationService.getQueueItemById('qi-1');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DB_ERROR');
  });
});

// ----------------------------------------------------------------------------
// 4. reviewQueueItem
// ----------------------------------------------------------------------------

describe('ContentModerationService.reviewQueueItem', () => {
  it('approve decision → status becomes approved, applyModerationAction called', async () => {
    const item = makeQueueItem({ status: 'approved', review_decision: 'approve', content_type: 'message' });
    mockDb.query.mockResolvedValueOnce({ rows: [item], rowCount: 1 } as never); // UPDATE
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);     // approve UPDATE

    const result = await ContentModerationService.reviewQueueItem('qi-1', 'admin-1', 'approve', 'Looks fine');

    expect(result.success).toBe(true);
    expect(result.data?.status).toBe('approved');
    const updateArgs = mockDb.query.mock.calls[0][1] as unknown[];
    expect(updateArgs[0]).toBe('approved');
    expect(updateArgs[2]).toBe('approve');
  });

  it('keeps a photo message quarantined while any photo or caption review remains unresolved', async () => {
    const item = makeQueueItem({
      status: 'approved',
      review_decision: 'approve',
      content_type: 'photo',
      content_id: 'photo-message-1',
    });
    mockDb.query.mockResolvedValueOnce({ rows: [item], rowCount: 1 } as never);
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    const result = await ContentModerationService.reviewQueueItem(
      'qi-photo-1',
      'admin-1',
      'approve',
      'Pixels are safe',
    );

    expect(result.success).toBe(true);
    const visibilitySql = String(mockDb.query.mock.calls[1][0]);
    expect(visibilitySql).toContain("queue.content_type IN ('photo','message')");
    expect(visibilitySql).toContain("queue.status<>'approved'");
  });

  it('reject decision → status becomes rejected, quarantine called', async () => {
    const item = makeQueueItem({ status: 'rejected', review_decision: 'reject', content_type: 'message' });
    mockDb.query.mockResolvedValueOnce({ rows: [item], rowCount: 1 } as never); // UPDATE
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);     // quarantine UPDATE

    const result = await ContentModerationService.reviewQueueItem('qi-1', 'admin-1', 'reject', 'Violates policy');

    expect(result.success).toBe(true);
    expect(result.data?.status).toBe('rejected');
    const updateArgs = mockDb.query.mock.calls[0][1] as unknown[];
    expect(updateArgs[0]).toBe('rejected');
    expect(updateArgs[2]).toBe('reject');
  });

  it('escalate decision → status becomes escalated', async () => {
    const item = makeQueueItem({ status: 'escalated', review_decision: 'escalate', content_type: 'message' });
    mockDb.query.mockResolvedValueOnce({ rows: [item], rowCount: 1 } as never);

    const result = await ContentModerationService.reviewQueueItem('qi-1', 'admin-1', 'escalate');

    expect(result.success).toBe(true);
    expect(result.data?.status).toBe('escalated');
    const updateArgs = mockDb.query.mock.calls[0][1] as unknown[];
    expect(updateArgs[0]).toBe('escalated');
  });

  it('no_action decision → status becomes approved', async () => {
    const item = makeQueueItem({ status: 'approved', review_decision: 'no_action', content_type: 'message' });
    // no_action does NOT call applyModerationAction (only 'approve'/'reject' do), so one mock only
    mockDb.query.mockResolvedValueOnce({ rows: [item], rowCount: 1 } as never);

    const result = await ContentModerationService.reviewQueueItem('qi-1', 'admin-1', 'no_action');

    expect(result.success).toBe(true);
    const updateArgs = mockDb.query.mock.calls[0][1] as unknown[];
    expect(updateArgs[0]).toBe('approved');
  });

  it('returns NOT_FOUND when queue item does not exist', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    const result = await ContentModerationService.reviewQueueItem('nonexistent', 'admin-1', 'approve');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NOT_FOUND');
  });

  it('passes reviewNotes to query', async () => {
    const item = makeQueueItem({ status: 'approved' });
    mockDb.query.mockResolvedValueOnce({ rows: [item], rowCount: 1 } as never);
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    await ContentModerationService.reviewQueueItem('qi-1', 'admin-1', 'approve', 'Great content');

    const updateArgs = mockDb.query.mock.calls[0][1] as unknown[];
    expect(updateArgs[3]).toBe('Great content');
  });

  it('returns DB_ERROR on failure', async () => {
    // Use mockReset to ensure no lingering resolved mocks from prior tests
    mockDb.query.mockReset();
    mockDb.query.mockRejectedValueOnce(new Error('timeout'));

    const result = await ContentModerationService.reviewQueueItem('qi-1', 'admin-1', 'approve');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DB_ERROR');
  });
});

// ----------------------------------------------------------------------------
// 5. createReport
// ----------------------------------------------------------------------------

describe('ContentModerationService.createReport', () => {
  it('blocks self-report with INVALID_INPUT', async () => {
    const result = await ContentModerationService.createReport({
      reporterUserId: 'user-1',
      contentType: 'message',
      contentId: 'msg-1',
      reportedContentUserId: 'user-1', // same as reporter
      category: 'spam',
      description: 'test',
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toContain('own content');
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('creates valid report for different users', async () => {
    const report = makeReport();
    mockDb.query.mockResolvedValueOnce({ rows: [report], rowCount: 1 } as never);

    const result = await ContentModerationService.createReport({
      reporterUserId: 'reporter-1',
      contentType: 'message',
      contentId: 'msg-1',
      reportedContentUserId: 'reported-1',
      category: 'spam',
      description: 'This is spam',
    });

    expect(result.success).toBe(true);
    expect(result.data?.id).toBe('rep-1');
    expect(result.data?.category).toBe('spam');
  });

  it('description is optional (null when omitted)', async () => {
    const report = makeReport({ description: null });
    mockDb.query.mockResolvedValueOnce({ rows: [report], rowCount: 1 } as never);

    await ContentModerationService.createReport({
      reporterUserId: 'reporter-1',
      contentType: 'message',
      contentId: 'msg-1',
      reportedContentUserId: 'reported-1',
      category: 'spam',
    });

    const insertArgs = mockDb.query.mock.calls[0][1] as unknown[];
    expect(insertArgs[5]).toBeNull(); // description → null
  });

  it('high-priority category (harassment) triggers moderateContent', async () => {
    const report = makeReport({ category: 'harassment' });
    mockDb.query.mockResolvedValueOnce({ rows: [report], rowCount: 1 } as never); // INSERT report
    // moderateContent call → inserts queue item
    const queueItem = makeQueueItem({ status: 'pending' });
    mockDb.query.mockResolvedValueOnce({ rows: [queueItem], rowCount: 1 } as never);

    const result = await ContentModerationService.createReport({
      reporterUserId: 'reporter-1',
      contentType: 'message',
      contentId: 'msg-1',
      reportedContentUserId: 'reported-1',
      category: 'harassment',
      description: 'They harassed me',
    });

    expect(result.success).toBe(true);
    // Two DB queries: insert report + insert queue item from moderateContent
    expect(mockDb.query).toHaveBeenCalledTimes(2);
  });

  it('high-priority category (inappropriate) triggers moderateContent', async () => {
    const report = makeReport({ category: 'inappropriate' });
    mockDb.query.mockResolvedValueOnce({ rows: [report], rowCount: 1 } as never);
    const queueItem = makeQueueItem({ status: 'pending' });
    mockDb.query.mockResolvedValueOnce({ rows: [queueItem], rowCount: 1 } as never);

    const result = await ContentModerationService.createReport({
      reporterUserId: 'reporter-1',
      contentType: 'task',
      contentId: 'task-1',
      reportedContentUserId: 'reported-1',
      category: 'inappropriate',
    });

    expect(result.success).toBe(true);
    expect(mockDb.query).toHaveBeenCalledTimes(2);
  });

  it('low-priority category (spam) does NOT trigger moderateContent', async () => {
    const report = makeReport({ category: 'spam' });
    mockDb.query.mockResolvedValueOnce({ rows: [report], rowCount: 1 } as never);

    await ContentModerationService.createReport({
      reporterUserId: 'reporter-1',
      contentType: 'message',
      contentId: 'msg-1',
      reportedContentUserId: 'reported-1',
      category: 'spam',
    });

    // Only 1 query: insert report (no moderateContent triggered)
    expect(mockDb.query).toHaveBeenCalledTimes(1);
  });

  it('returns DB_ERROR on failure', async () => {
    mockDb.query.mockRejectedValueOnce(new Error('DB error'));

    const result = await ContentModerationService.createReport({
      reporterUserId: 'reporter-1',
      contentType: 'message',
      contentId: 'msg-1',
      reportedContentUserId: 'reported-1',
      category: 'spam',
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DB_ERROR');
  });
});

// ----------------------------------------------------------------------------
// 6. getUserReports
// ----------------------------------------------------------------------------

describe('ContentModerationService.getUserReports', () => {
  it('returns list of reports for a user', async () => {
    const reports = [makeReport({ id: 'rep-1' }), makeReport({ id: 'rep-2' })];
    mockDb.query.mockResolvedValueOnce({ rows: reports, rowCount: 2 } as never);

    const result = await ContentModerationService.getUserReports('reported-1');

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(2);
  });

  it('returns empty array when no reports', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    const result = await ContentModerationService.getUserReports('reported-1');

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(0);
  });

  it('filters by status when provided', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    await ContentModerationService.getUserReports('reported-1', 'pending');

    const sql = mockDb.query.mock.calls[0][0] as string;
    const params = mockDb.query.mock.calls[0][1] as unknown[];
    expect(sql).toContain('status');
    expect(params).toContain('pending');
  });

  it('uses custom limit', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    await ContentModerationService.getUserReports('reported-1', undefined, 5);

    const params = mockDb.query.mock.calls[0][1] as unknown[];
    expect(params).toContain(5);
  });

  it('returns DB_ERROR on failure', async () => {
    mockDb.query.mockRejectedValueOnce(new Error('timeout'));

    const result = await ContentModerationService.getUserReports('user-1');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DB_ERROR');
  });
});

// ----------------------------------------------------------------------------
// 7. reviewReport
// ----------------------------------------------------------------------------

describe('ContentModerationService.reviewReport', () => {
  it('action_taken decision → status becomes resolved', async () => {
    const report = makeReport({ status: 'resolved', review_decision: 'action_taken' });
    mockDb.query.mockResolvedValueOnce({ rows: [report], rowCount: 1 } as never);

    const result = await ContentModerationService.reviewReport('rep-1', 'admin-1', 'action_taken');

    expect(result.success).toBe(true);
    expect(result.data?.status).toBe('resolved');
    const args = mockDb.query.mock.calls[0][1] as unknown[];
    expect(args[0]).toBe('resolved');
  });

  it('no_action decision → status becomes resolved', async () => {
    const report = makeReport({ status: 'resolved', review_decision: 'no_action' });
    mockDb.query.mockResolvedValueOnce({ rows: [report], rowCount: 1 } as never);

    const result = await ContentModerationService.reviewReport('rep-1', 'admin-1', 'no_action');

    expect(result.success).toBe(true);
    const args = mockDb.query.mock.calls[0][1] as unknown[];
    expect(args[0]).toBe('resolved');
  });

  it('dismissed decision → status becomes dismissed', async () => {
    const report = makeReport({ status: 'dismissed', review_decision: 'dismissed' });
    mockDb.query.mockResolvedValueOnce({ rows: [report], rowCount: 1 } as never);

    const result = await ContentModerationService.reviewReport('rep-1', 'admin-1', 'dismissed');

    expect(result.success).toBe(true);
    expect(result.data?.status).toBe('dismissed');
    const args = mockDb.query.mock.calls[0][1] as unknown[];
    expect(args[0]).toBe('dismissed');
  });

  it('unknown decision → status becomes reviewed', async () => {
    const report = makeReport({ status: 'reviewed', review_decision: 'other' });
    mockDb.query.mockResolvedValueOnce({ rows: [report], rowCount: 1 } as never);

    const result = await ContentModerationService.reviewReport('rep-1', 'admin-1', 'other');

    expect(result.success).toBe(true);
    const args = mockDb.query.mock.calls[0][1] as unknown[];
    expect(args[0]).toBe('reviewed');
  });

  it('returns NOT_FOUND when report does not exist', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    const result = await ContentModerationService.reviewReport('nonexistent', 'admin-1', 'dismissed');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NOT_FOUND');
    expect(result.error?.message).toContain('nonexistent');
  });

  it('returns DB_ERROR on failure', async () => {
    mockDb.query.mockRejectedValueOnce(new Error('DB error'));

    const result = await ContentModerationService.reviewReport('rep-1', 'admin-1', 'dismissed');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DB_ERROR');
  });

  it('passes reviewNotes to query params', async () => {
    const report = makeReport({ status: 'resolved' });
    mockDb.query.mockResolvedValueOnce({ rows: [report], rowCount: 1 } as never);

    await ContentModerationService.reviewReport('rep-1', 'admin-1', 'action_taken', 'User was warned');

    const args = mockDb.query.mock.calls[0][1] as unknown[];
    expect(args[3]).toBe('User was warned');
  });
});

// ----------------------------------------------------------------------------
// 8. createAppeal
// ----------------------------------------------------------------------------

describe('ContentModerationService.createAppeal', () => {
  it('creates appeal successfully', async () => {
    const appeal = makeAppeal();
    mockDb.query.mockResolvedValueOnce({ rows: [appeal], rowCount: 1 } as never);

    const deadline = new Date('2024-01-15T00:00:00Z');
    const result = await ContentModerationService.createAppeal({
      userId: 'user-1',
      moderationQueueId: 'qi-1',
      originalDecision: 'rejected',
      appealReason: 'I did nothing wrong',
      deadline,
    });

    expect(result.success).toBe(true);
    expect(result.data?.id).toBe('appeal-1');
    expect(result.data?.status).toBe('pending');
  });

  it('passes correct params to DB insert', async () => {
    const appeal = makeAppeal();
    mockDb.query.mockResolvedValueOnce({ rows: [appeal], rowCount: 1 } as never);

    const deadline = new Date('2024-01-22T00:00:00Z');
    await ContentModerationService.createAppeal({
      userId: 'user-42',
      moderationQueueId: 'qi-99',
      originalDecision: 'suspended',
      appealReason: 'Mistaken identity',
      deadline,
    });

    const args = mockDb.query.mock.calls[0][1] as unknown[];
    expect(args[0]).toBe('user-42');
    expect(args[1]).toBe('qi-99');
    expect(args[2]).toBe('suspended');
    expect(args[3]).toBe('Mistaken identity');
    expect(args[4]).toBe(deadline);
  });

  it('returns DB_ERROR on failure', async () => {
    mockDb.query.mockRejectedValueOnce(new Error('Constraint violation'));

    const result = await ContentModerationService.createAppeal({
      userId: 'user-1',
      moderationQueueId: 'qi-1',
      originalDecision: 'rejected',
      appealReason: 'Please reconsider',
      deadline: new Date(),
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DB_ERROR');
  });
});

// ----------------------------------------------------------------------------
// 9. getUserAppeals
// ----------------------------------------------------------------------------

describe('ContentModerationService.getUserAppeals', () => {
  it('returns list of appeals for a user', async () => {
    const appeals = [makeAppeal({ id: 'appeal-1' }), makeAppeal({ id: 'appeal-2' })];
    mockDb.query.mockResolvedValueOnce({ rows: appeals, rowCount: 2 } as never);

    const result = await ContentModerationService.getUserAppeals('user-1');

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(2);
  });

  it('returns empty array when no appeals', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    const result = await ContentModerationService.getUserAppeals('user-1');

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(0);
  });

  it('filters by status when provided', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    await ContentModerationService.getUserAppeals('user-1', 'pending');

    const sql = mockDb.query.mock.calls[0][0] as string;
    const params = mockDb.query.mock.calls[0][1] as unknown[];
    expect(sql).toContain('status');
    expect(params).toContain('pending');
  });

  it('returns DB_ERROR on failure', async () => {
    mockDb.query.mockRejectedValueOnce(new Error('timeout'));

    const result = await ContentModerationService.getUserAppeals('user-1');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DB_ERROR');
  });
});

// ----------------------------------------------------------------------------
// 10. reviewAppeal
// ----------------------------------------------------------------------------

describe('ContentModerationService.reviewAppeal', () => {
  it('upheld decision → status becomes upheld', async () => {
    const appeal = makeAppeal({ status: 'upheld', review_decision: 'upheld' });
    mockDb.query.mockResolvedValueOnce({ rows: [appeal], rowCount: 1 } as never);

    const result = await ContentModerationService.reviewAppeal('appeal-1', 'admin-1', 'upheld', 'Decision stands');

    expect(result.success).toBe(true);
    expect(result.data?.status).toBe('upheld');
    const args = mockDb.query.mock.calls[0][1] as unknown[];
    expect(args[0]).toBe('upheld');
  });

  it('overturned decision → status becomes overturned, content restored', async () => {
    const appeal = makeAppeal({ status: 'overturned', review_decision: 'overturned', moderation_queue_id: 'qi-1' });
    mockDb.query.mockResolvedValueOnce({ rows: [appeal], rowCount: 1 } as never);            // UPDATE appeal
    // reviewAppeal overturned path: SELECT queue item, applyModerationAction, UPDATE queue item
    mockDb.query.mockResolvedValueOnce({ rows: [{ content_type: 'message', content_id: 'msg-1' }], rowCount: 1 } as never); // SELECT queue item
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);                  // approve message UPDATE
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);                  // UPDATE queue item status

    const result = await ContentModerationService.reviewAppeal('appeal-1', 'admin-1', 'overturned');

    expect(result.success).toBe(true);
    expect(result.data?.status).toBe('overturned');
    const args = mockDb.query.mock.calls[0][1] as unknown[];
    expect(args[0]).toBe('overturned');
  });

  it('returns NOT_FOUND when appeal does not exist', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    const result = await ContentModerationService.reviewAppeal('nonexistent', 'admin-1', 'upheld');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NOT_FOUND');
    expect(result.error?.message).toContain('nonexistent');
  });

  it('returns DB_ERROR on failure', async () => {
    mockDb.query.mockRejectedValueOnce(new Error('DB error'));

    const result = await ContentModerationService.reviewAppeal('appeal-1', 'admin-1', 'upheld');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DB_ERROR');
  });
});

// ----------------------------------------------------------------------------
// 11. getPendingAppeals
// ----------------------------------------------------------------------------

describe('ContentModerationService.getPendingAppeals', () => {
  it('returns pending appeals list', async () => {
    const appeals = [makeAppeal({ id: 'appeal-1' }), makeAppeal({ id: 'appeal-2' })];
    mockDb.query.mockResolvedValueOnce({ rows: appeals, rowCount: 2 } as never);

    const result = await ContentModerationService.getPendingAppeals();

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(2);
  });

  it('returns empty array when no pending appeals', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    const result = await ContentModerationService.getPendingAppeals();

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(0);
  });

  it('uses custom limit', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    await ContentModerationService.getPendingAppeals(20);

    const params = mockDb.query.mock.calls[0][1] as unknown[];
    expect(params).toContain(20);
  });

  it('returns DB_ERROR on failure', async () => {
    mockDb.query.mockRejectedValueOnce(new Error('timeout'));

    const result = await ContentModerationService.getPendingAppeals();

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DB_ERROR');
  });
});
