/**
 * MessagingService — Security & Pagination Tests
 *
 * Validates:
 *   FIX 2a — sendMessage: per-sender-per-task Redis rate limit (30 msg/min)
 *   FIX 2b — getMessagesForTask: paginated reads (max 100 messages, hasMore flag)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────

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
vi.mock('../../src/config', () => ({
  config: { redis: { restUrl: null, restToken: null } },
}));
vi.mock('../../src/logger', () => {
  const child = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });
  return { logger: { child } };
});

// Controllable Redis incr/expire stubs for rate-limit testing
const { mockIncr, mockExpire } = vi.hoisted(() => ({
  mockIncr: vi.fn<[], Promise<number>>(),
  mockExpire: vi.fn<[], Promise<void>>().mockResolvedValue(undefined),
}));

vi.mock('../../src/cache/redis', () => ({
  incr: mockIncr,
  expire: mockExpire,
  redis: {},
  checkRateLimit: vi.fn(),
}));

// ── Imports ──────────────────────────────────────────────────────────────────

import { MessagingService } from '../../src/services/MessagingService';
import { db } from '../../src/db';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const taskRow = {
  id: 'task-1',
  poster_id: 'poster-1',
  worker_id: 'worker-1',
  state: 'ACCEPTED',
};

const msg = {
  id: 'msg-1',
  task_id: 'task-1',
  sender_id: 'poster-1',
  receiver_id: 'worker-1',
  message_type: 'TEXT',
  content: 'Hello',
  read_at: null,
  moderation_status: 'pending',
  moderation_flags: null,
  photo_urls: null,
  photo_count: null,
  location_latitude: null,
  location_longitude: null,
  location_expires_at: null,
  auto_message_template: null,
  created_at: new Date(),
  updated_at: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
  (db.query as ReturnType<typeof vi.fn>).mockReset();
  // Default: Redis incr returns 1 (first message in window) — allow
  mockIncr.mockResolvedValue(1);
  mockExpire.mockResolvedValue(undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
// FIX 2a — Per-sender-per-task rate limiting in sendMessage
// ─────────────────────────────────────────────────────────────────────────────

describe('MessagingService.sendMessage — per-sender-per-task rate limit', () => {
  it('allows sending when Redis counter is at limit (30)', async () => {
    mockIncr.mockResolvedValue(30); // exactly at the limit — still allowed
    (db.query as any)
      .mockResolvedValueOnce({ rows: [taskRow] })
      .mockResolvedValueOnce({ rows: [msg] });

    const result = await MessagingService.sendMessage({
      taskId: 'task-1',
      senderId: 'poster-1',
      messageType: 'TEXT',
      content: 'Still allowed',
    });
    expect(result.success).toBe(true);
  });

  it('rejects sendMessage when Redis counter exceeds 30 (message flooding)', async () => {
    mockIncr.mockResolvedValue(31); // 31st message in the window — rejected
    (db.query as any).mockResolvedValueOnce({ rows: [taskRow] });

    const result = await MessagingService.sendMessage({
      taskId: 'task-1',
      senderId: 'poster-1',
      messageType: 'TEXT',
      content: 'This should be blocked',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('RATE_LIMIT_EXCEEDED');
      expect(result.error.message).toContain('rate limit');
    }
  });

  it('rejects at 100 messages (well above limit)', async () => {
    mockIncr.mockResolvedValue(100);
    (db.query as any).mockResolvedValueOnce({ rows: [taskRow] });

    const result = await MessagingService.sendMessage({
      taskId: 'task-1',
      senderId: 'worker-1',
      messageType: 'TEXT',
      content: 'Flood message',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('RATE_LIMIT_EXCEEDED');
    }
  });

  it('calls redis.incr with the correct key pattern (msg_rate:{senderId}:{taskId})', async () => {
    mockIncr.mockResolvedValue(1);
    (db.query as any)
      .mockResolvedValueOnce({ rows: [taskRow] })
      .mockResolvedValueOnce({ rows: [msg] });

    await MessagingService.sendMessage({
      taskId: 'task-1',
      senderId: 'poster-1',
      messageType: 'TEXT',
      content: 'Hello',
    });

    expect(mockIncr).toHaveBeenCalledWith('msg_rate:poster-1:task-1');
  });

  it('sets 60-second TTL on the rate-limit key when count is 1 (first message)', async () => {
    mockIncr.mockResolvedValue(1);
    (db.query as any)
      .mockResolvedValueOnce({ rows: [taskRow] })
      .mockResolvedValueOnce({ rows: [msg] });

    await MessagingService.sendMessage({
      taskId: 'task-1',
      senderId: 'poster-1',
      messageType: 'TEXT',
      content: 'First message',
    });

    expect(mockExpire).toHaveBeenCalledWith('msg_rate:poster-1:task-1', 60);
  });

  it('does NOT reset TTL when count > 1 (subsequent messages in same window)', async () => {
    mockIncr.mockResolvedValue(5); // 5th message — key already has TTL
    (db.query as any)
      .mockResolvedValueOnce({ rows: [taskRow] })
      .mockResolvedValueOnce({ rows: [msg] });

    await MessagingService.sendMessage({
      taskId: 'task-1',
      senderId: 'poster-1',
      messageType: 'TEXT',
      content: 'Fifth message',
    });

    // expire should NOT be called for count > 1
    expect(mockExpire).not.toHaveBeenCalled();
  });

  it('rate-limit key is sender+task scoped — different senders get independent buckets', async () => {
    // Both senders at count=1 (first message each) — both should be allowed.
    // task-1 has poster-1 and worker-1 as participants — both can send.
    mockIncr.mockResolvedValue(1);
    (db.query as any)
      // First call: poster-1 sends to worker-1
      .mockResolvedValueOnce({ rows: [taskRow] })
      .mockResolvedValueOnce({ rows: [msg] })
      // Second call: worker-1 sends to poster-1 (same task, reversed roles)
      .mockResolvedValueOnce({ rows: [taskRow] })
      .mockResolvedValueOnce({ rows: [{ ...msg, sender_id: 'worker-1', receiver_id: 'poster-1' }] });

    const r1 = await MessagingService.sendMessage({
      taskId: 'task-1', senderId: 'poster-1', messageType: 'TEXT', content: 'From poster',
    });
    const r2 = await MessagingService.sendMessage({
      taskId: 'task-1', senderId: 'worker-1', messageType: 'TEXT', content: 'From worker',
    });

    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);

    // Each sender produces a distinct Redis key
    const incrKeys = (mockIncr as any).mock.calls.map((c: string[]) => c[0]);
    expect(incrKeys).toContain('msg_rate:poster-1:task-1');
    expect(incrKeys).toContain('msg_rate:worker-1:task-1');
  });

  it('rate-limit check occurs AFTER state/participant validation (not on invalid requests)', async () => {
    // Task is in COMPLETED (read-only) — should fail with INVALID_STATE, not rate-limit check
    (db.query as any).mockResolvedValueOnce({ rows: [{ ...taskRow, state: 'COMPLETED' }] });

    const result = await MessagingService.sendMessage({
      taskId: 'task-1', senderId: 'poster-1', messageType: 'TEXT', content: 'Hey',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('INVALID_STATE');
    }
    // incr should not have been called (request rejected before rate limit check)
    expect(mockIncr).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FIX 2b — Paginated getMessagesForTask (max 100, hasMore flag)
// ─────────────────────────────────────────────────────────────────────────────

describe('MessagingService.getMessagesForTask — pagination', () => {
  it('returns messages with hasMore=false when fewer than 100 results', async () => {
    const messages = Array.from({ length: 5 }, (_, i) => ({ ...msg, id: `msg-${i}` }));
    (db.query as any)
      .mockResolvedValueOnce({ rows: [taskRow] })
      .mockResolvedValueOnce({ rows: messages });

    const result = await MessagingService.getMessagesForTask('task-1', 'poster-1');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.messages).toHaveLength(5);
      expect(result.data.hasMore).toBe(false);
    }
  });

  it('returns hasMore=true when exactly 100 results (page full — more may exist)', async () => {
    const messages = Array.from({ length: 100 }, (_, i) => ({ ...msg, id: `msg-${i}` }));
    (db.query as any)
      .mockResolvedValueOnce({ rows: [taskRow] })
      .mockResolvedValueOnce({ rows: messages });

    const result = await MessagingService.getMessagesForTask('task-1', 'poster-1');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.messages).toHaveLength(100);
      expect(result.data.hasMore).toBe(true);
    }
  });

  it('returns hasMore=false when fewer than 100 results on second page', async () => {
    const messages = Array.from({ length: 42 }, (_, i) => ({ ...msg, id: `msg-${i}` }));
    (db.query as any)
      .mockResolvedValueOnce({ rows: [taskRow] })
      .mockResolvedValueOnce({ rows: messages });

    const result = await MessagingService.getMessagesForTask('task-1', 'poster-1', 100);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.messages).toHaveLength(42);
      expect(result.data.hasMore).toBe(false);
    }
  });

  it('passes LIMIT 100 and the given OFFSET to the database query', async () => {
    (db.query as any)
      .mockResolvedValueOnce({ rows: [taskRow] })
      .mockResolvedValueOnce({ rows: [] });

    await MessagingService.getMessagesForTask('task-1', 'poster-1', 200);

    // Second call is the SELECT on task_messages
    const calls = (db.query as any).mock.calls;
    const msgQueryCall = calls[1]; // [sql, params]
    const sql: string = msgQueryCall[0];
    const params: unknown[] = msgQueryCall[1];

    expect(sql).toMatch(/LIMIT/i);
    expect(sql).toMatch(/OFFSET/i);
    // Params: [taskId, PAGE_SIZE=100, offset=200]
    expect(params).toContain(100);   // LIMIT
    expect(params).toContain(200);   // OFFSET
  });

  it('passes offset=0 by default (first page)', async () => {
    (db.query as any)
      .mockResolvedValueOnce({ rows: [taskRow] })
      .mockResolvedValueOnce({ rows: [] });

    await MessagingService.getMessagesForTask('task-1', 'poster-1');

    const calls = (db.query as any).mock.calls;
    const params: unknown[] = calls[1][1];
    expect(params).toContain(0); // default offset
  });

  it('returns NOT_FOUND when task does not exist', async () => {
    (db.query as any).mockResolvedValueOnce({ rows: [] });
    const result = await MessagingService.getMessagesForTask('missing-task', 'poster-1');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('NOT_FOUND');
    }
  });

  it('returns FORBIDDEN when user is not a participant', async () => {
    (db.query as any).mockResolvedValueOnce({
      rows: [{ ...taskRow, poster_id: 'other', worker_id: 'other2' }],
    });
    const result = await MessagingService.getMessagesForTask('task-1', 'stranger');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('FORBIDDEN');
    }
  });

  it('returns empty messages with hasMore=false on empty conversation', async () => {
    (db.query as any)
      .mockResolvedValueOnce({ rows: [taskRow] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await MessagingService.getMessagesForTask('task-1', 'poster-1');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.messages).toHaveLength(0);
      expect(result.data.hasMore).toBe(false);
    }
  });

  it('returns DB_ERROR on database failure', async () => {
    (db.query as any).mockRejectedValueOnce(new Error('Connection lost'));
    const result = await MessagingService.getMessagesForTask('task-1', 'poster-1');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('DB_ERROR');
    }
  });
});
