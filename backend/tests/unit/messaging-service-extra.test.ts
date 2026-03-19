/**
 * MessagingService Extra Unit Tests
 *
 * Covers paths NOT already in messaging-service.test.ts:
 * - markAsRead: success, NOT_FOUND (message not found), NOT_FOUND (wrong user), already read, DB error
 * - markAllAsRead: success, NOT_FOUND task, FORBIDDEN user, 0 count, DB error
 * - sendMessage: EXPIRED/CANCELLED read-only state, AUTO with custom content override, with Redis publish
 * - sendMessage: content moderation - flagged patterns (phone, email, link)
 * - sendMessage: content moderation - no patterns (async moderation)
 * - sendMessage: invariant violation
 * - sendPhotoMessage: FORBIDDEN sender, no recipient (null worker_id), non-read-only invalid state
 * - sendPhotoMessage: with caption containing forbidden patterns
 * - sendPhotoMessage: DB error
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

// Redis publish mock — active config to exercise publish path
// vi.hoisted() required because vi.mock() is hoisted above variable declarations
const { mockRedisPublish } = vi.hoisted(() => ({
  mockRedisPublish: vi.fn().mockResolvedValue(1),
}));
vi.mock('@upstash/redis', () => ({
  Redis: class MockRedis {
    publish = mockRedisPublish;
  },
}));
// Stub out the cache/redis helpers used by sendMessage's rate limit
vi.mock('../../src/cache/redis', () => ({
  incr: vi.fn().mockResolvedValue(1),   // first message in window — always allowed
  expire: vi.fn().mockResolvedValue(undefined),
  redis: {},
  checkRateLimit: vi.fn(),
}));
vi.mock('../../src/config', () => ({
  config: { redis: { restUrl: 'https://test.upstash.io', restToken: 'token' } },
}));
vi.mock('../../src/logger', () => {
  const child = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });
  return { logger: { child } };
});

import { MessagingService } from '../../src/services/MessagingService';
import { db, isInvariantViolation } from '../../src/db';
import { ContentModerationService } from '../../src/services/ContentModerationService';

const mockDb = vi.mocked(db);
const mockIsInvariantViolation = vi.mocked(isInvariantViolation);
const mockModerateContent = vi.mocked(ContentModerationService.moderateContent);

// ============================================================================
// FIXTURES
// ============================================================================
const taskRow = {
  id: 'task-1', poster_id: 'poster-1', worker_id: 'worker-1', state: 'ACCEPTED',
};

const msg = {
  id: 'msg-1', task_id: 'task-1', sender_id: 'poster-1', receiver_id: 'worker-1',
  message_type: 'TEXT', content: 'Hello', read_at: null,
  moderation_status: 'pending', moderation_flags: null,
  photo_urls: null, photo_count: null,
  location_latitude: null, location_longitude: null, location_expires_at: null,
  auto_message_template: null,
  created_at: new Date(), updated_at: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
  // mockReset() clears once-queue to prevent mockRejectedValueOnce leakage between tests.
  mockDb.query.mockReset();
  mockIsInvariantViolation.mockReturnValue(false);
  mockModerateContent.mockResolvedValue({ success: true } as never);
});

// ============================================================================
// markAsRead
// ============================================================================
describe('MessagingService.markAsRead', () => {
  it('successfully marks message as read', async () => {
    const readMsg = { ...msg, read_at: new Date() };
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ receiver_id: 'worker-1' }] })  // verify receiver
      .mockResolvedValueOnce({ rows: [readMsg] });                       // UPDATE

    const result = await MessagingService.markAsRead('msg-1', 'worker-1');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.read_at).not.toBeNull();
    }
  });

  it('returns NOT_FOUND when message does not exist', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [] });
    const result = await MessagingService.markAsRead('missing-msg', 'worker-1');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('NOT_FOUND');
      expect(result.error.message).toContain('missing-msg');
    }
  });

  it('returns FORBIDDEN when user is not the receiver', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ receiver_id: 'worker-1' }] });
    const result = await MessagingService.markAsRead('msg-1', 'poster-1');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('FORBIDDEN');
      expect(result.error.message).toContain('receiver');
    }
  });

  it('returns NOT_FOUND when message already read (UPDATE returns 0 rows)', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ receiver_id: 'worker-1' }] }) // verify
      .mockResolvedValueOnce({ rows: [] });                            // UPDATE returns nothing

    const result = await MessagingService.markAsRead('msg-1', 'worker-1');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('NOT_FOUND');
      expect(result.error.message).toContain('already read');
    }
  });

  it('returns DB_ERROR when query throws', async () => {
    mockDb.query.mockRejectedValueOnce(new Error('DB crash'));
    const result = await MessagingService.markAsRead('msg-1', 'worker-1');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('DB_ERROR');
    }
  });
});

// ============================================================================
// markAllAsRead
// ============================================================================
describe('MessagingService.markAllAsRead', () => {
  it('successfully marks all messages as read', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ poster_id: 'poster-1', worker_id: 'worker-1' }] }) // task
      .mockResolvedValueOnce({ rows: [{ count: '3' }] });                                   // UPDATE

    const result = await MessagingService.markAllAsRead('task-1', 'worker-1');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.marked).toBe(3);
    }
  });

  it('returns NOT_FOUND when task does not exist', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [] });
    const result = await MessagingService.markAllAsRead('missing-task', 'user-1');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('NOT_FOUND');
      expect(result.error.message).toContain('missing-task');
    }
  });

  it('returns FORBIDDEN when user is not a participant', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ poster_id: 'poster-A', worker_id: 'worker-B' }],
    });
    const result = await MessagingService.markAllAsRead('task-1', 'stranger-99');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('FORBIDDEN');
    }
  });

  it('returns 0 when no unread messages exist', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ poster_id: 'poster-1', worker_id: 'worker-1' }] })
      .mockResolvedValueOnce({ rows: [] }); // 0 rows updated

    const result = await MessagingService.markAllAsRead('task-1', 'poster-1');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.marked).toBe(0);
    }
  });

  it('returns DB_ERROR when query throws', async () => {
    mockDb.query.mockRejectedValueOnce(new Error('Timeout'));
    const result = await MessagingService.markAllAsRead('task-1', 'poster-1');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('DB_ERROR');
    }
  });
});

// ============================================================================
// sendMessage — additional edge cases
// ============================================================================
describe('MessagingService.sendMessage (extra)', () => {
  it('returns INVALID_STATE for EXPIRED task (read-only)', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ ...taskRow, state: 'EXPIRED' }] });
    const result = await MessagingService.sendMessage({
      taskId: 'task-1', senderId: 'poster-1', messageType: 'TEXT', content: 'Hey',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('INVALID_STATE');
      expect(result.error.message).toContain('read-only');
    }
  });

  it('returns INVALID_INPUT when AUTO message has no template', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [taskRow] });
    const result = await MessagingService.sendMessage({
      taskId: 'task-1', senderId: 'poster-1', messageType: 'AUTO',
      // autoMessageTemplate is undefined
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('INVALID_INPUT');
    }
  });

  it('sends AUTO message with custom content overriding template', async () => {
    const autoMsg = { ...msg, message_type: 'AUTO', content: 'Custom on-my-way text', auto_message_template: 'on_my_way' };
    mockDb.query
      .mockResolvedValueOnce({ rows: [taskRow] })
      .mockResolvedValueOnce({ rows: [autoMsg] });

    const result = await MessagingService.sendMessage({
      taskId: 'task-1', senderId: 'worker-1', messageType: 'AUTO',
      autoMessageTemplate: 'on_my_way',
      content: 'Custom on-my-way text', // overrides default template
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.content).toBe('Custom on-my-way text');
    }
  });

  it('flags message with phone number and calls ContentModerationService', async () => {
    const contentWithPhone = 'Call me at 555-867-5309 to confirm';
    const flaggedMsg = { ...msg, content: contentWithPhone, moderation_status: 'flagged', moderation_flags: ['phone'] };

    mockDb.query
      .mockResolvedValueOnce({ rows: [taskRow] })    // task query
      .mockResolvedValueOnce({ rows: [msg] })        // INSERT message
      .mockResolvedValueOnce({ rows: [] });          // UPDATE moderation_status (flagged)

    const result = await MessagingService.sendMessage({
      taskId: 'task-1', senderId: 'poster-1', messageType: 'TEXT', content: contentWithPhone,
    });
    expect(result.success).toBe(true);
    // moderation should have been called with flag recommendation
    expect(mockModerateContent).toHaveBeenCalledWith(expect.objectContaining({
      contentType: 'message',
      flaggedBy: 'ai',
      aiRecommendation: 'flag',
    }));
  });

  it('flags message with email address pattern', async () => {
    const contentWithEmail = 'Email me at user@example.com for details';

    mockDb.query
      .mockResolvedValueOnce({ rows: [taskRow] })
      .mockResolvedValueOnce({ rows: [msg] })
      .mockResolvedValueOnce({ rows: [] }); // UPDATE flagged

    const result = await MessagingService.sendMessage({
      taskId: 'task-1', senderId: 'poster-1', messageType: 'TEXT', content: contentWithEmail,
    });
    expect(result.success).toBe(true);
    expect(mockModerateContent).toHaveBeenCalledWith(expect.objectContaining({
      aiRecommendation: 'flag',
    }));
  });

  it('flags message with URL link pattern', async () => {
    const contentWithLink = 'Check out https://example.com for more info';

    mockDb.query
      .mockResolvedValueOnce({ rows: [taskRow] })
      .mockResolvedValueOnce({ rows: [msg] })
      .mockResolvedValueOnce({ rows: [] }); // UPDATE flagged

    const result = await MessagingService.sendMessage({
      taskId: 'task-1', senderId: 'poster-1', messageType: 'TEXT', content: contentWithLink,
    });
    expect(result.success).toBe(true);
    expect(mockModerateContent).toHaveBeenCalled();
  });

  it('calls ContentModerationService asynchronously for clean message (no patterns)', async () => {
    const cleanContent = 'Please complete the task by 3pm today';

    mockDb.query
      .mockResolvedValueOnce({ rows: [taskRow] })
      .mockResolvedValueOnce({ rows: [msg] });

    const result = await MessagingService.sendMessage({
      taskId: 'task-1', senderId: 'poster-1', messageType: 'TEXT', content: cleanContent,
    });
    expect(result.success).toBe(true);
    // async moderation is called (fire-and-forget)
    expect(mockModerateContent).toHaveBeenCalledWith(expect.objectContaining({
      contentType: 'message',
      contentText: cleanContent,
      flaggedBy: 'ai',
    }));
    // No recommendation set for async path (undefined fields)
    expect(mockModerateContent).toHaveBeenCalledWith(expect.not.objectContaining({
      aiRecommendation: expect.anything(),
    }));
  });

  it('handles invariant violation and returns INVARIANT_VIOLATION code', async () => {
    const invError = Object.assign(new Error('Invariant'), { code: 'ESCROW_INV' });
    mockIsInvariantViolation.mockReturnValueOnce(true);

    mockDb.query
      .mockResolvedValueOnce({ rows: [taskRow] })
      .mockRejectedValueOnce(invError);

    const result = await MessagingService.sendMessage({
      taskId: 'task-1', senderId: 'poster-1', messageType: 'TEXT', content: 'Valid content',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(['ESCROW_INV', 'INVARIANT_VIOLATION']).toContain(result.error.code);
    }
  });

  it('publishes to Redis realtime channel when config has restUrl', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [taskRow] })
      .mockResolvedValueOnce({ rows: [msg] });

    await MessagingService.sendMessage({
      taskId: 'task-1', senderId: 'poster-1', messageType: 'TEXT', content: 'Hello',
    });

    // Redis publish should have been called for realtime delivery
    expect(mockRedisPublish).toHaveBeenCalledWith(
      expect.stringContaining('realtime:user:'),
      expect.stringContaining('message.new')
    );
  });

  it('allows messaging in PROOF_SUBMITTED task state', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ ...taskRow, state: 'PROOF_SUBMITTED' }] })
      .mockResolvedValueOnce({ rows: [msg] });
    const result = await MessagingService.sendMessage({
      taskId: 'task-1', senderId: 'poster-1', messageType: 'TEXT', content: 'Accepted!',
    });
    expect(result.success).toBe(true);
  });

  it('returns error when db throws non-invariant error during INSERT', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [taskRow] })
      .mockRejectedValueOnce(new Error('Connection refused'));

    const result = await MessagingService.sendMessage({
      taskId: 'task-1', senderId: 'poster-1', messageType: 'TEXT', content: 'Hello',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('DB_ERROR');
      expect(result.error.message).toBe('Connection refused');
    }
  });
});

// ============================================================================
// sendPhotoMessage — additional edge cases
// ============================================================================
describe('MessagingService.sendPhotoMessage (extra)', () => {
  const photoMsg = {
    ...msg, message_type: 'PHOTO',
    photo_urls: ['https://example.com/photo.jpg'], photo_count: 1,
  };

  it('returns FORBIDDEN when sender is not a participant', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [taskRow] });
    const result = await MessagingService.sendPhotoMessage({
      taskId: 'task-1', senderId: 'stranger-99', photoUrls: ['photo.jpg'],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('FORBIDDEN');
    }
  });

  it('returns INVALID_STATE when no worker assigned (null worker_id)', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ ...taskRow, worker_id: null }] });
    const result = await MessagingService.sendPhotoMessage({
      taskId: 'task-1', senderId: 'poster-1', photoUrls: ['photo.jpg'],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('INVALID_STATE');
      expect(result.error.message).toContain('no recipient');
    }
  });

  it('returns INVALID_STATE when task is in non-allowed state (OPEN)', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ ...taskRow, state: 'OPEN' }] });
    const result = await MessagingService.sendPhotoMessage({
      taskId: 'task-1', senderId: 'poster-1', photoUrls: ['photo.jpg'],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('INVALID_STATE');
    }
  });

  it('flags caption with phone number in photo message', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [taskRow] })             // task
      .mockResolvedValue({ rows: [photoMsg] });               // evidence INSERT + message INSERT

    const result = await MessagingService.sendPhotoMessage({
      taskId: 'task-1', senderId: 'poster-1',
      photoUrls: ['https://example.com/photo.jpg'],
      caption: 'Contact me at 555-867-5309',
    });
    expect(result.success).toBe(true);
    // moderation should have been called for caption
    expect(mockModerateContent).toHaveBeenCalledWith(expect.objectContaining({
      contentType: 'message',
      flaggedBy: 'ai',
      aiRecommendation: 'flag',
    }));
  });

  it('returns DB_ERROR when db throws during photo message INSERT', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [taskRow] })
      .mockRejectedValueOnce(new Error('DB fail'));

    const result = await MessagingService.sendPhotoMessage({
      taskId: 'task-1', senderId: 'poster-1', photoUrls: ['photo.jpg'],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('DB_ERROR');
    }
  });

  it('calls ContentModerationService for each photo URL (async)', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [taskRow] })
      .mockResolvedValue({ rows: [{ ...photoMsg, photo_count: 2 }] });

    await MessagingService.sendPhotoMessage({
      taskId: 'task-1', senderId: 'poster-1',
      photoUrls: ['photo1.jpg', 'photo2.jpg'],
    });

    // moderateContent called once per photo (2 photos)
    const photoCalls = (mockModerateContent as any).mock.calls.filter(
      (call: any[]) => call[0].contentType === 'photo'
    );
    expect(photoCalls.length).toBe(2);
  });

  it('extracts storage key from URL with slashes (R2 format)', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [taskRow] })
      .mockResolvedValue({ rows: [photoMsg] });

    const result = await MessagingService.sendPhotoMessage({
      taskId: 'task-1', senderId: 'poster-1',
      photoUrls: ['https://cdn.r2.example.com/bucket/user123/photo.jpg'],
    });
    // Should succeed — storage key extraction shouldn't break
    expect(result.success).toBe(true);
  });
});
