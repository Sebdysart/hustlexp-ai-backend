/**
 * FIX-Y1: Regression tests for Bug 1 and Bug 2 in messaging
 *
 * Bug 1: markAllAsRead — RETURNING COUNT(*) invalid in DML; always returned 0.
 *        Fix: use result.rowCount instead.
 *
 * Bug 2: sendMessage AUTO type — client-supplied content overrode server templates,
 *        bypassing moderation. Fix: always use server template text for AUTO messages.
 *
 * Bug 3 (SSE connection limit) is covered in fix-y1-sse-connection-limit.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// MOCKS
// ============================================================================

vi.mock('../../src/db', () => ({
  db: { query: vi.fn() },
  isInvariantViolation: vi.fn().mockReturnValue(false),
  getErrorMessage: vi.fn().mockReturnValue('Invariant violation'),
}));
vi.mock('../../src/services/ContentModerationService', () => ({
  ContentModerationService: { moderateContent: vi.fn().mockResolvedValue({ success: true }) },
}));
vi.mock('../../src/services/NotificationService', () => ({
  NotificationService: { createNotification: vi.fn().mockResolvedValue({ success: true }) },
}));
vi.mock('@upstash/redis', () => ({
  Redis: vi.fn().mockImplementation(() => ({ publish: vi.fn().mockResolvedValue(1) })),
}));
vi.mock('../../src/config', () => ({ config: { redis: { restUrl: null, restToken: null } } }));
vi.mock('../../src/cache/redis', () => ({
  incr: vi.fn().mockResolvedValue(1),
  expire: vi.fn().mockResolvedValue(undefined),
  redis: {},
  checkRateLimit: vi.fn(),
}));
vi.mock('../../src/logger', () => {
  const child = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });
  return { logger: { child } };
});

// ============================================================================
// IMPORTS (after vi.mock declarations)
// ============================================================================
import { MessagingService } from '../../src/services/MessagingService';
import { db } from '../../src/db';

// ============================================================================
// TEST DATA
// ============================================================================

const taskRow = {
  id: 'task-1', poster_id: 'poster-1', worker_id: 'worker-1', state: 'ACCEPTED',
};

const msgRow = {
  id: 'msg-1', task_id: 'task-1', sender_id: 'poster-1', receiver_id: 'worker-1',
  message_type: 'AUTO', content: "I'm on my way to the task location. ETA: ~X minutes.",
  auto_message_template: 'on_my_way', read_at: null, moderation_status: 'pending',
  created_at: new Date(), updated_at: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ============================================================================
// BUG 1: markAllAsRead returns actual rowCount, not 0
// ============================================================================

describe('Bug 1 – markAllAsRead uses rowCount (not RETURNING COUNT(*))', () => {
  it('returns the rowCount from the UPDATE query when 3 rows are marked read', async () => {
    (db.query as any)
      // Task participant lookup
      .mockResolvedValueOnce({ rows: [{ poster_id: 'poster-1', worker_id: 'worker-1' }] })
      // UPDATE query — rowCount reflects actual affected rows; rows array is empty
      .mockResolvedValueOnce({ rows: [], rowCount: 3 });

    const result = await MessagingService.markAllAsRead('task-1', 'poster-1');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.marked).toBe(3);
    }
  });

  it('returns 0 when no unread messages exist (rowCount = 0)', async () => {
    (db.query as any)
      .mockResolvedValueOnce({ rows: [{ poster_id: 'poster-1', worker_id: 'worker-1' }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const result = await MessagingService.markAllAsRead('task-1', 'poster-1');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.marked).toBe(0);
    }
  });

  it('handles null rowCount (driver quirk) as 0', async () => {
    (db.query as any)
      .mockResolvedValueOnce({ rows: [{ poster_id: 'poster-1', worker_id: 'worker-1' }] })
      .mockResolvedValueOnce({ rows: [], rowCount: null });

    const result = await MessagingService.markAllAsRead('task-1', 'poster-1');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.marked).toBe(0);
    }
  });

  it('returns NOT_FOUND when task does not exist', async () => {
    (db.query as any).mockResolvedValueOnce({ rows: [] });

    const result = await MessagingService.markAllAsRead('nonexistent', 'poster-1');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('NOT_FOUND');
    }
  });
});

// ============================================================================
// BUG 2: AUTO message content is always server template, never client-supplied
// ============================================================================

describe('Bug 2 – sendMessage AUTO type uses server template, ignores client content', () => {
  it('uses template text regardless of client-supplied content field', async () => {
    (db.query as any)
      .mockResolvedValueOnce({ rows: [taskRow] })  // task lookup
      .mockResolvedValueOnce({ rows: [msgRow] });  // INSERT message

    const result = await MessagingService.sendMessage({
      taskId: 'task-1',
      senderId: 'worker-1',
      messageType: 'AUTO',
      autoMessageTemplate: 'on_my_way',
      // Client attempts to override the content with arbitrary text to bypass moderation
      content: 'ARBITRARY ATTACKER CONTENT — bypassing moderation',
    });

    expect(result.success).toBe(true);

    // The INSERT call must use the server template text, NOT the attacker content
    const insertCall = (db.query as any).mock.calls.find((call: any[]) =>
      typeof call[0] === 'string' && call[0].includes('INSERT INTO task_messages')
    );
    expect(insertCall).toBeDefined();
    const insertParams: any[] = insertCall![1];
    // Index 4 is the `content` value passed to the INSERT query ($5)
    const contentParam = insertParams[4];
    expect(contentParam).not.toBe('ARBITRARY ATTACKER CONTENT — bypassing moderation');
    expect(contentParam).toBe("I'm on my way to the task location. ETA: ~X minutes.");
  });

  it('uses template text when no client content is supplied', async () => {
    (db.query as any)
      .mockResolvedValueOnce({ rows: [taskRow] })
      .mockResolvedValueOnce({ rows: [{ ...msgRow, auto_message_template: 'running_late', content: "I'm running about X minutes late. I'll arrive at [time]." }] });

    const result = await MessagingService.sendMessage({
      taskId: 'task-1',
      senderId: 'worker-1',
      messageType: 'AUTO',
      autoMessageTemplate: 'running_late',
    });

    expect(result.success).toBe(true);

    const insertCall = (db.query as any).mock.calls.find((call: any[]) =>
      typeof call[0] === 'string' && call[0].includes('INSERT INTO task_messages')
    );
    expect(insertCall).toBeDefined();
    const contentParam = insertCall![1][4];
    expect(contentParam).toBe("I'm running about X minutes late. I'll arrive at [time].");
  });

  it('rejects AUTO messages with an unknown template key', async () => {
    (db.query as any).mockResolvedValueOnce({ rows: [taskRow] });

    const result = await MessagingService.sendMessage({
      taskId: 'task-1',
      senderId: 'worker-1',
      messageType: 'AUTO',
      autoMessageTemplate: 'nonexistent_template',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('INVALID_INPUT');
    }
  });
});
