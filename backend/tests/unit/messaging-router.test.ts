/**
 * Messaging Router Unit Tests
 *
 * Tests all 7 procedures in the messaging router:
 *   MUTATIONS:
 *     1. sendMessage       — TEXT and AUTO message types via MessagingService
 *     2. sendPhotoMessage   — photo messages via MessagingService
 *     3. markAsRead         — single message read receipt via MessagingService
 *     4. markAllAsRead      — bulk read receipt via MessagingService
 *   QUERIES:
 *     5. getTaskMessages    — fetch messages for a task via MessagingService
 *     6. getUnreadCount     — global unread count via MessagingService (returns { unreadCount, count })
 *     7. getConversations   — conversation summaries via direct db.query
 *
 * Pattern: mock db + MessagingService at module level, use createCaller
 * with a fake protected context to bypass middleware.
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

vi.mock('../../src/services/MessagingService', () => ({
  MessagingService: {
    sendMessage: vi.fn(),
    sendPhotoMessage: vi.fn(),
    getMessagesForTask: vi.fn(),
    markAsRead: vi.fn(),
    markAllAsRead: vi.fn(),
    getUnreadCount: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { db } from '../../src/db';
import { messagingRouter } from '../../src/routers/messaging';
import { MessagingService } from '../../src/services/MessagingService';

const mockDb = vi.mocked(db);
const mockMessaging = vi.mocked(MessagingService);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TASK_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const MESSAGE_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const RECEIPT_1 = 'c0000000-0000-4000-8000-000000000001';
const RECEIPT_2 = 'c0000000-0000-4000-8000-000000000002';
const RECEIPT_3 = 'c0000000-0000-4000-8000-000000000003';
const RECEIPT_4 = 'c0000000-0000-4000-8000-000000000004';
const USER_ID = 'user-poster-1';
const WORKER_ID = 'user-worker-1';

interface TaskMessageRow {
  id: string;
  task_id: string;
  sender_id: string;
  receiver_id: string;
  message_type: 'TEXT' | 'AUTO' | 'PHOTO' | 'LOCATION';
  content: string | null;
  auto_message_template: string | null;
  photo_urls: string[] | null;
  photo_count: number | null;
  location_latitude: number | null;
  location_longitude: number | null;
  location_expires_at: Date | null;
  read_at: Date | null;
  moderation_status: string;
  moderation_flags: string[] | null;
  created_at: Date;
  updated_at: Date;
}

interface ConversationRow {
  taskId: string;
  id: string;
  taskTitle: string;
  otherUserId: string;
  otherUserName: string;
  otherUserRole: string;
  lastMessage: string | null;
  lastMessageAt: Date | null;
  unreadCount: number;
}

function makeMessage(overrides: Partial<TaskMessageRow> = {}): TaskMessageRow {
  return {
    id: MESSAGE_ID,
    task_id: TASK_ID,
    sender_id: USER_ID,
    receiver_id: WORKER_ID,
    message_type: 'TEXT',
    content: 'Hello, are you on your way?',
    auto_message_template: null,
    photo_urls: null,
    photo_count: null,
    location_latitude: null,
    location_longitude: null,
    location_expires_at: null,
    read_at: null,
    moderation_status: 'pending',
    moderation_flags: null,
    created_at: new Date('2026-03-01T12:00:00Z'),
    updated_at: new Date('2026-03-01T12:00:00Z'),
    ...overrides,
  };
}

function makeConversation(overrides: Partial<ConversationRow> = {}): ConversationRow {
  return {
    taskId: TASK_ID,
    id: TASK_ID,
    taskTitle: 'Mow the lawn',
    otherUserId: WORKER_ID,
    otherUserName: 'Jane Worker',
    otherUserRole: 'worker',
    lastMessage: 'On my way!',
    lastMessageAt: new Date('2026-03-01T12:05:00Z'),
    unreadCount: 2,
    ...overrides,
  };
}

/** Create a caller for a regular authenticated user. */
function makeUserCaller(userId = USER_ID) {
  const fakeUser = {
    id: userId,
    email: 'user@hustlexp.com',
    full_name: 'Test User',
    role: 'hustler',
    trust_tier: 3,
    firebase_uid: 'fb-user',
  };
  return messagingRouter.createCaller({
    user: fakeUser as any,
    firebaseUid: 'fb-user',
  });
}

/** Create a caller with no user (unauthenticated). */
function makeAnonCaller() {
  return messagingRouter.createCaller({
    user: null as any,
    firebaseUid: null,
  });
}

// ===========================================================================
// messaging.sendMessage
// ===========================================================================

describe('messaging.sendMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('happy path — TEXT message', () => {
    it('returns the created message on success', async () => {
      const msg = makeMessage();
      mockMessaging.sendMessage.mockResolvedValueOnce({
        success: true,
        data: msg,
      } as any);

      const result = await makeUserCaller().sendMessage({
        taskId: TASK_ID,
        messageType: 'TEXT',
        content: 'Hello, are you on your way?',
      });

      expect(result).toEqual(msg);
    });

    it('passes senderId from ctx.user.id to MessagingService', async () => {
      mockMessaging.sendMessage.mockResolvedValueOnce({
        success: true,
        data: makeMessage(),
      } as any);

      await makeUserCaller('custom-user-id').sendMessage({
        taskId: TASK_ID,
        messageType: 'TEXT',
        content: 'Hi there',
      });

      expect(mockMessaging.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ senderId: 'custom-user-id' }),
      );
    });

    it('passes all input fields to MessagingService', async () => {
      mockMessaging.sendMessage.mockResolvedValueOnce({
        success: true,
        data: makeMessage(),
      } as any);

      await makeUserCaller().sendMessage({
        taskId: TASK_ID,
        messageType: 'TEXT',
        content: 'Hello world',
      });

      expect(mockMessaging.sendMessage).toHaveBeenCalledWith({
        taskId: TASK_ID,
        senderId: USER_ID,
        messageType: 'TEXT',
        content: 'Hello world',
        autoMessageTemplate: undefined,
      });
    });
  });

  describe('happy path — AUTO message', () => {
    it('sends an AUTO message with template', async () => {
      const autoMsg = makeMessage({
        message_type: 'AUTO',
        auto_message_template: 'on_my_way',
        content: "I'm on my way to the task location. ETA: ~X minutes.",
      });
      mockMessaging.sendMessage.mockResolvedValueOnce({
        success: true,
        data: autoMsg,
      } as any);

      const result = await makeUserCaller().sendMessage({
        taskId: TASK_ID,
        messageType: 'AUTO',
        autoMessageTemplate: 'on_my_way',
      });

      expect(result).toEqual(autoMsg);
      expect(mockMessaging.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          messageType: 'AUTO',
          autoMessageTemplate: 'on_my_way',
        }),
      );
    });
  });

  describe('input validation — router-level', () => {
    it('throws BAD_REQUEST when TEXT message has no content', async () => {
      await expect(
        makeUserCaller().sendMessage({
          taskId: TASK_ID,
          messageType: 'TEXT',
        }),
      ).rejects.toThrow(/Content is required for TEXT messages/);
    });

    it('throws BAD_REQUEST when AUTO message has no template', async () => {
      await expect(
        makeUserCaller().sendMessage({
          taskId: TASK_ID,
          messageType: 'AUTO',
        }),
      ).rejects.toThrow(/autoMessageTemplate is required for AUTO messages/);
    });

    it('rejects invalid messageType via zod', async () => {
      await expect(
        makeUserCaller().sendMessage({
          taskId: TASK_ID,
          messageType: 'INVALID' as any,
        }),
      ).rejects.toThrow();
    });

    it('rejects invalid UUID for taskId via zod', async () => {
      await expect(
        makeUserCaller().sendMessage({
          taskId: 'not-a-uuid',
          messageType: 'TEXT',
          content: 'Hello',
        }),
      ).rejects.toThrow();
    });

    it('rejects content longer than 500 characters via zod', async () => {
      await expect(
        makeUserCaller().sendMessage({
          taskId: TASK_ID,
          messageType: 'TEXT',
          content: 'x'.repeat(501),
        }),
      ).rejects.toThrow();
    });

    it('rejects invalid autoMessageTemplate enum via zod', async () => {
      await expect(
        makeUserCaller().sendMessage({
          taskId: TASK_ID,
          messageType: 'AUTO',
          autoMessageTemplate: 'invalid_template' as any,
        }),
      ).rejects.toThrow();
    });
  });

  describe('service error mapping', () => {
    it('throws NOT_FOUND when service returns NOT_FOUND error', async () => {
      mockMessaging.sendMessage.mockResolvedValueOnce({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Task not found' },
      } as any);

      await expect(
        makeUserCaller().sendMessage({
          taskId: TASK_ID,
          messageType: 'TEXT',
          content: 'Hello',
        }),
      ).rejects.toThrow(/Task not found/);
    });

    it('throws FORBIDDEN when service returns FORBIDDEN error', async () => {
      mockMessaging.sendMessage.mockResolvedValueOnce({
        success: false,
        error: { code: 'FORBIDDEN', message: 'You are not a participant' },
      } as any);

      await expect(
        makeUserCaller().sendMessage({
          taskId: TASK_ID,
          messageType: 'TEXT',
          content: 'Hello',
        }),
      ).rejects.toThrow(/You are not a participant/);
    });

    it('throws PRECONDITION_FAILED when service returns INVALID_STATE error', async () => {
      mockMessaging.sendMessage.mockResolvedValueOnce({
        success: false,
        error: { code: 'INVALID_STATE', message: 'Task is COMPLETED' },
      } as any);

      await expect(
        makeUserCaller().sendMessage({
          taskId: TASK_ID,
          messageType: 'TEXT',
          content: 'Hello',
        }),
      ).rejects.toThrow(/Task is COMPLETED/);
    });

    it('throws BAD_REQUEST for other service errors', async () => {
      mockMessaging.sendMessage.mockResolvedValueOnce({
        success: false,
        error: { code: 'INVALID_INPUT', message: 'Content too long' },
      } as any);

      await expect(
        makeUserCaller().sendMessage({
          taskId: TASK_ID,
          messageType: 'TEXT',
          content: 'Hello',
        }),
      ).rejects.toThrow(/Content too long/);
    });
  });

  describe('authentication', () => {
    it('throws UNAUTHORIZED for unauthenticated callers', async () => {
      await expect(
        makeAnonCaller().sendMessage({
          taskId: TASK_ID,
          messageType: 'TEXT',
          content: 'Hello',
        }),
      ).rejects.toThrow();
    });
  });
});

// ===========================================================================
// messaging.sendPhotoMessage
// ===========================================================================

describe('messaging.sendPhotoMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('happy path', () => {
    it('returns the created photo message on success', async () => {
      const photoMsg = makeMessage({
        message_type: 'PHOTO',
        content: 'Look at this',
        photo_urls: ['https://pub-abc123def456.r2.dev/photo1.jpg'],
        photo_count: 1,
      });
      mockMessaging.sendPhotoMessage.mockResolvedValueOnce({
        success: true,
        data: photoMsg,
      } as any);

      const result = await makeUserCaller().sendPhotoMessage({
        taskId: TASK_ID,
        uploadReceiptIds: [RECEIPT_1],
        caption: 'Look at this',
      });

      expect(result).toEqual(photoMsg);
    });

    it('passes senderId from ctx.user.id to MessagingService', async () => {
      mockMessaging.sendPhotoMessage.mockResolvedValueOnce({
        success: true,
        data: makeMessage({ message_type: 'PHOTO' }),
      } as any);

      await makeUserCaller('worker-abc').sendPhotoMessage({
        taskId: TASK_ID,
        uploadReceiptIds: [RECEIPT_1],
      });

      expect(mockMessaging.sendPhotoMessage).toHaveBeenCalledWith(
        expect.objectContaining({ senderId: 'worker-abc' }),
      );
    });

    it('supports multiple photos (up to 3)', async () => {
      const urls = [
        'https://pub-abc123def456.r2.dev/p1.jpg',
        'https://pub-abc123def456.r2.dev/p2.jpg',
        'https://pub-abc123def456.r2.dev/p3.jpg',
      ];
      mockMessaging.sendPhotoMessage.mockResolvedValueOnce({
        success: true,
        data: makeMessage({ message_type: 'PHOTO', photo_urls: urls, photo_count: 3 }),
      } as any);

      const result = await makeUserCaller().sendPhotoMessage({
        taskId: TASK_ID,
        uploadReceiptIds: [RECEIPT_1, RECEIPT_2, RECEIPT_3],
      });

      expect(result.photo_urls).toHaveLength(3);
    });

    it('caption is optional', async () => {
      mockMessaging.sendPhotoMessage.mockResolvedValueOnce({
        success: true,
        data: makeMessage({ message_type: 'PHOTO', content: null }),
      } as any);

      const result = await makeUserCaller().sendPhotoMessage({
        taskId: TASK_ID,
        uploadReceiptIds: [RECEIPT_1],
      });

      expect(mockMessaging.sendPhotoMessage).toHaveBeenCalledWith(
        expect.objectContaining({ caption: undefined }),
      );
      expect(result).toBeDefined();
    });
  });

  describe('input validation — router-level (zod)', () => {
    it('rejects an empty uploadReceiptIds array', async () => {
      await expect(
        makeUserCaller().sendPhotoMessage({
          taskId: TASK_ID,
          uploadReceiptIds: [],
        }),
      ).rejects.toThrow();
    });

    it('rejects more than 3 photos', async () => {
      await expect(
        makeUserCaller().sendPhotoMessage({
          taskId: TASK_ID,
          uploadReceiptIds: [RECEIPT_1, RECEIPT_2, RECEIPT_3, RECEIPT_4],
        }),
      ).rejects.toThrow();
    });

    it('rejects malformed upload receipt identities', async () => {
      await expect(
        makeUserCaller().sendPhotoMessage({
          taskId: TASK_ID,
          uploadReceiptIds: ['not-a-receipt'],
        }),
      ).rejects.toThrow();
    });

    it('rejects invalid UUID for taskId', async () => {
      await expect(
        makeUserCaller().sendPhotoMessage({
          taskId: 'bad-uuid',
          uploadReceiptIds: [RECEIPT_1],
        }),
      ).rejects.toThrow();
    });

    it('rejects caption longer than 200 characters', async () => {
      await expect(
        makeUserCaller().sendPhotoMessage({
          taskId: TASK_ID,
          uploadReceiptIds: [RECEIPT_1],
          caption: 'x'.repeat(201),
        }),
      ).rejects.toThrow();
    });
  });

  describe('service error mapping', () => {
    it('throws NOT_FOUND when task does not exist', async () => {
      mockMessaging.sendPhotoMessage.mockResolvedValueOnce({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Task not found' },
      } as any);

      await expect(
        makeUserCaller().sendPhotoMessage({
          taskId: TASK_ID,
          uploadReceiptIds: [RECEIPT_1],
        }),
      ).rejects.toThrow(/Task not found/);
    });

    it('throws FORBIDDEN when user is not a participant', async () => {
      mockMessaging.sendPhotoMessage.mockResolvedValueOnce({
        success: false,
        error: { code: 'FORBIDDEN', message: 'You are not a participant' },
      } as any);

      await expect(
        makeUserCaller().sendPhotoMessage({
          taskId: TASK_ID,
          uploadReceiptIds: [RECEIPT_1],
        }),
      ).rejects.toThrow(/You are not a participant/);
    });

    it('throws PRECONDITION_FAILED for INVALID_STATE', async () => {
      mockMessaging.sendPhotoMessage.mockResolvedValueOnce({
        success: false,
        error: { code: 'INVALID_STATE', message: 'Task is CANCELLED' },
      } as any);

      await expect(
        makeUserCaller().sendPhotoMessage({
          taskId: TASK_ID,
          uploadReceiptIds: [RECEIPT_1],
        }),
      ).rejects.toThrow(/Task is CANCELLED/);
    });
  });

  describe('authentication', () => {
    it('throws UNAUTHORIZED for unauthenticated callers', async () => {
      await expect(
        makeAnonCaller().sendPhotoMessage({
          taskId: TASK_ID,
          uploadReceiptIds: [RECEIPT_1],
        }),
      ).rejects.toThrow();
    });
  });
});

// ===========================================================================
// messaging.getTaskMessages
// ===========================================================================

describe('messaging.getTaskMessages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('happy path', () => {
    it('returns paginated messages object for the task', async () => {
      const messages = [
        makeMessage({ id: 'msg-1', content: 'Hello' }),
        makeMessage({ id: 'msg-2', content: 'Hi there', sender_id: WORKER_ID, receiver_id: USER_ID }),
      ];
      mockMessaging.getMessagesForTask.mockResolvedValueOnce({
        success: true,
        data: { messages, hasMore: false },
      } as any);

      const result = await makeUserCaller().getTaskMessages({ taskId: TASK_ID });

      expect(Array.isArray((result as any).messages)).toBe(true);
      expect((result as any).messages).toHaveLength(2);
      expect((result as any).messages[0].id).toBe('msg-1');
      expect((result as any).messages[1].id).toBe('msg-2');
      expect((result as any).hasMore).toBe(false);
    });

    it('returns empty messages array with hasMore=false when no messages exist', async () => {
      mockMessaging.getMessagesForTask.mockResolvedValueOnce({
        success: true,
        data: { messages: [], hasMore: false },
      } as any);

      const result = await makeUserCaller().getTaskMessages({ taskId: TASK_ID });

      expect((result as any).messages).toHaveLength(0);
      expect((result as any).hasMore).toBe(false);
    });

    it('returns hasMore=true when a full page (100) is returned', async () => {
      const messages = Array.from({ length: 100 }, (_, i) =>
        makeMessage({ id: `msg-${i}`, content: `Message ${i}` })
      );
      mockMessaging.getMessagesForTask.mockResolvedValueOnce({
        success: true,
        data: { messages, hasMore: true },
      } as any);

      const result = await makeUserCaller().getTaskMessages({ taskId: TASK_ID });

      expect((result as any).messages).toHaveLength(100);
      expect((result as any).hasMore).toBe(true);
    });

    it('passes userId and default offset=0 from context to MessagingService', async () => {
      mockMessaging.getMessagesForTask.mockResolvedValueOnce({
        success: true,
        data: { messages: [], hasMore: false },
      } as any);

      await makeUserCaller('specific-user').getTaskMessages({ taskId: TASK_ID });

      expect(mockMessaging.getMessagesForTask).toHaveBeenCalledWith(
        TASK_ID,
        'specific-user',
        0,
      );
    });

    it('passes non-zero offset to service when provided', async () => {
      mockMessaging.getMessagesForTask.mockResolvedValueOnce({
        success: true,
        data: { messages: [], hasMore: false },
      } as any);

      await makeUserCaller().getTaskMessages({ taskId: TASK_ID, offset: 100 });

      expect(mockMessaging.getMessagesForTask).toHaveBeenCalledWith(
        TASK_ID,
        expect.any(String),
        100,
      );
    });
  });

  describe('error cases', () => {
    it('throws NOT_FOUND when task does not exist', async () => {
      mockMessaging.getMessagesForTask.mockResolvedValueOnce({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Task not found' },
      } as any);

      await expect(
        makeUserCaller().getTaskMessages({ taskId: TASK_ID }),
      ).rejects.toThrow(/Task not found/);
    });

    it('throws FORBIDDEN when user is not a participant', async () => {
      mockMessaging.getMessagesForTask.mockResolvedValueOnce({
        success: false,
        error: { code: 'FORBIDDEN', message: 'You do not have permission' },
      } as any);

      await expect(
        makeUserCaller().getTaskMessages({ taskId: TASK_ID }),
      ).rejects.toThrow(/You do not have permission/);
    });

    it('throws INTERNAL_SERVER_ERROR for other service errors', async () => {
      mockMessaging.getMessagesForTask.mockResolvedValueOnce({
        success: false,
        error: { code: 'DB_ERROR', message: 'Connection failed' },
      } as any);

      await expect(
        makeUserCaller().getTaskMessages({ taskId: TASK_ID }),
      ).rejects.toThrow(/Connection failed/);
    });
  });

  describe('input validation', () => {
    it('rejects invalid UUID for taskId', async () => {
      await expect(
        makeUserCaller().getTaskMessages({ taskId: 'bad' }),
      ).rejects.toThrow();
    });
  });

  describe('authentication', () => {
    it('throws UNAUTHORIZED for unauthenticated callers', async () => {
      await expect(
        makeAnonCaller().getTaskMessages({ taskId: TASK_ID }),
      ).rejects.toThrow();
    });
  });
});

// ===========================================================================
// messaging.markAsRead
// ===========================================================================

describe('messaging.markAsRead', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('happy path', () => {
    it('returns the updated message with read_at set', async () => {
      const readMsg = makeMessage({ read_at: new Date('2026-03-01T13:00:00Z') });
      mockMessaging.markAsRead.mockResolvedValueOnce({
        success: true,
        data: readMsg,
      } as any);

      const result = await makeUserCaller().markAsRead({ messageId: MESSAGE_ID });

      expect(result).toEqual(readMsg);
      expect(result.read_at).toBeDefined();
    });

    it('passes userId from context for receiver verification', async () => {
      mockMessaging.markAsRead.mockResolvedValueOnce({
        success: true,
        data: makeMessage({ read_at: new Date() }),
      } as any);

      await makeUserCaller('receiver-user').markAsRead({ messageId: MESSAGE_ID });

      expect(mockMessaging.markAsRead).toHaveBeenCalledWith(
        MESSAGE_ID,
        'receiver-user',
      );
    });
  });

  describe('error cases', () => {
    it('throws NOT_FOUND when message does not exist', async () => {
      mockMessaging.markAsRead.mockResolvedValueOnce({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Message not found' },
      } as any);

      await expect(
        makeUserCaller().markAsRead({ messageId: MESSAGE_ID }),
      ).rejects.toThrow(/Message not found/);
    });

    it('throws FORBIDDEN when user is not the receiver', async () => {
      mockMessaging.markAsRead.mockResolvedValueOnce({
        success: false,
        error: { code: 'FORBIDDEN', message: 'You are not the receiver' },
      } as any);

      await expect(
        makeUserCaller().markAsRead({ messageId: MESSAGE_ID }),
      ).rejects.toThrow(/You are not the receiver/);
    });

    it('throws INTERNAL_SERVER_ERROR for DB errors', async () => {
      mockMessaging.markAsRead.mockResolvedValueOnce({
        success: false,
        error: { code: 'DB_ERROR', message: 'Database timeout' },
      } as any);

      await expect(
        makeUserCaller().markAsRead({ messageId: MESSAGE_ID }),
      ).rejects.toThrow(/Database timeout/);
    });
  });

  describe('input validation', () => {
    it('rejects invalid UUID for messageId', async () => {
      await expect(
        makeUserCaller().markAsRead({ messageId: 'not-valid' }),
      ).rejects.toThrow();
    });
  });

  describe('authentication', () => {
    it('throws UNAUTHORIZED for unauthenticated callers', async () => {
      await expect(
        makeAnonCaller().markAsRead({ messageId: MESSAGE_ID }),
      ).rejects.toThrow();
    });
  });
});

// ===========================================================================
// messaging.markAllAsRead
// ===========================================================================

describe('messaging.markAllAsRead', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('happy path', () => {
    it('returns the count of marked messages', async () => {
      mockMessaging.markAllAsRead.mockResolvedValueOnce({
        success: true,
        data: { marked: 5 },
      } as any);

      const result = await makeUserCaller().markAllAsRead({ taskId: TASK_ID });

      expect(result).toEqual({ marked: 5 });
    });

    it('returns { marked: 0 } when there are no unread messages', async () => {
      mockMessaging.markAllAsRead.mockResolvedValueOnce({
        success: true,
        data: { marked: 0 },
      } as any);

      const result = await makeUserCaller().markAllAsRead({ taskId: TASK_ID });

      expect(result.marked).toBe(0);
    });

    it('passes userId from context for participant verification', async () => {
      mockMessaging.markAllAsRead.mockResolvedValueOnce({
        success: true,
        data: { marked: 3 },
      } as any);

      await makeUserCaller('my-user-id').markAllAsRead({ taskId: TASK_ID });

      expect(mockMessaging.markAllAsRead).toHaveBeenCalledWith(
        TASK_ID,
        'my-user-id',
      );
    });
  });

  describe('error cases', () => {
    it('throws NOT_FOUND when task does not exist', async () => {
      mockMessaging.markAllAsRead.mockResolvedValueOnce({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Task not found' },
      } as any);

      await expect(
        makeUserCaller().markAllAsRead({ taskId: TASK_ID }),
      ).rejects.toThrow(/Task not found/);
    });

    it('throws FORBIDDEN when user is not a participant', async () => {
      mockMessaging.markAllAsRead.mockResolvedValueOnce({
        success: false,
        error: { code: 'FORBIDDEN', message: 'You are not a participant' },
      } as any);

      await expect(
        makeUserCaller().markAllAsRead({ taskId: TASK_ID }),
      ).rejects.toThrow(/You are not a participant/);
    });

    it('throws INTERNAL_SERVER_ERROR for other errors', async () => {
      mockMessaging.markAllAsRead.mockResolvedValueOnce({
        success: false,
        error: { code: 'DB_ERROR', message: 'Unexpected failure' },
      } as any);

      await expect(
        makeUserCaller().markAllAsRead({ taskId: TASK_ID }),
      ).rejects.toThrow(/Unexpected failure/);
    });
  });

  describe('input validation', () => {
    it('rejects invalid UUID for taskId', async () => {
      await expect(
        makeUserCaller().markAllAsRead({ taskId: 'bad-uuid' }),
      ).rejects.toThrow();
    });
  });

  describe('authentication', () => {
    it('throws UNAUTHORIZED for unauthenticated callers', async () => {
      await expect(
        makeAnonCaller().markAllAsRead({ taskId: TASK_ID }),
      ).rejects.toThrow();
    });
  });
});

// ===========================================================================
// messaging.getUnreadCount
// ===========================================================================

describe('messaging.getUnreadCount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('return shape', () => {
    it('returns { unreadCount, count } with both fields for frontend compat', async () => {
      mockMessaging.getUnreadCount.mockResolvedValueOnce({
        success: true,
        data: 7,
      } as any);

      const result = await makeUserCaller().getUnreadCount();

      expect(result).toEqual({ unreadCount: 7, count: 7 });
      expect(result.unreadCount).toBe(7);
      expect(result.count).toBe(7);
    });

    it('returns 0 when user has no unread messages', async () => {
      mockMessaging.getUnreadCount.mockResolvedValueOnce({
        success: true,
        data: 0,
      } as any);

      const result = await makeUserCaller().getUnreadCount();

      expect(result).toEqual({ unreadCount: 0, count: 0 });
    });

    it('both fields always match', async () => {
      mockMessaging.getUnreadCount.mockResolvedValueOnce({
        success: true,
        data: 42,
      } as any);

      const result = await makeUserCaller().getUnreadCount();

      expect(result.unreadCount).toBe(result.count);
    });
  });

  describe('user scoping', () => {
    it('passes userId from context to MessagingService', async () => {
      mockMessaging.getUnreadCount.mockResolvedValueOnce({
        success: true,
        data: 3,
      } as any);

      await makeUserCaller('user-xyz').getUnreadCount();

      expect(mockMessaging.getUnreadCount).toHaveBeenCalledWith('user-xyz');
    });
  });

  describe('error cases', () => {
    it('throws INTERNAL_SERVER_ERROR on service failure', async () => {
      mockMessaging.getUnreadCount.mockResolvedValueOnce({
        success: false,
        error: { code: 'DB_ERROR', message: 'Query failed' },
      } as any);

      await expect(
        makeUserCaller().getUnreadCount(),
      ).rejects.toThrow(/Query failed/);
    });
  });

  describe('authentication', () => {
    it('throws UNAUTHORIZED for unauthenticated callers', async () => {
      await expect(
        makeAnonCaller().getUnreadCount(),
      ).rejects.toThrow();
    });
  });
});

// ===========================================================================
// messaging.getConversations — uses db.query directly (not MessagingService)
// ===========================================================================

describe('messaging.getConversations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('return shape', () => {
    it('returns an array of conversation summary objects', async () => {
      const convos = [
        makeConversation(),
        makeConversation({
          taskId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
          id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
          taskTitle: 'Walk the dog',
          otherUserName: 'Bob Poster',
          otherUserRole: 'poster',
          unreadCount: 0,
        }),
      ];
      mockDb.query.mockResolvedValueOnce({ rows: convos, rowCount: 2 } as any);

      const result = await makeUserCaller().getConversations();

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);
    });

    it('each conversation has the expected fields', async () => {
      const convo = makeConversation();
      mockDb.query.mockResolvedValueOnce({ rows: [convo], rowCount: 1 } as any);

      const result = await makeUserCaller().getConversations();
      const item = result[0] as any;

      expect(item.taskId).toBe(TASK_ID);
      expect(item.id).toBe(TASK_ID);
      expect(item.taskTitle).toBe('Mow the lawn');
      expect(item.otherUserId).toBe(WORKER_ID);
      expect(item.otherUserName).toBe('Jane Worker');
      expect(item.otherUserRole).toBe('worker');
      expect(item.lastMessage).toBe('On my way!');
      expect(item.lastMessageAt).toBeDefined();
      expect(item.unreadCount).toBe(2);
    });

    it('returns empty array when user has no active conversations', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const result = await makeUserCaller().getConversations();

      expect(result).toHaveLength(0);
    });
  });

  describe('user scoping', () => {
    it('passes the user ID to the SQL query', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeUserCaller('user-xyz').getConversations();

      const [, params] = (mockDb.query as any).mock.calls[0];
      expect(params).toContain('user-xyz');
    });
  });

  describe('SQL query properties', () => {
    it('queries only tasks in messaging-eligible states', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeUserCaller().getConversations();

      const [sql] = (mockDb.query as any).mock.calls[0];
      expect(sql).toContain('ACCEPTED');
      expect(sql).toContain('PROOF_SUBMITTED');
      expect(sql).toContain('DISPUTED');
    });

    it('queries tasks where user is poster OR worker', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeUserCaller().getConversations();

      const [sql] = (mockDb.query as any).mock.calls[0];
      expect(sql).toContain('poster_id');
      expect(sql).toContain('worker_id');
    });

    it('includes unread count in the query', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeUserCaller().getConversations();

      const [sql] = (mockDb.query as any).mock.calls[0];
      expect(sql).toContain('read_at IS NULL');
    });

    it('orders by latest message descending', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeUserCaller().getConversations();

      const [sql] = (mockDb.query as any).mock.calls[0];
      expect(sql).toContain('ORDER BY');
      expect(sql).toContain('DESC');
    });

    it('makes exactly 1 db.query call', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeUserCaller().getConversations();

      expect(mockDb.query).toHaveBeenCalledTimes(1);
    });
  });

  describe('authentication', () => {
    it('throws UNAUTHORIZED for unauthenticated callers', async () => {
      await expect(
        makeAnonCaller().getConversations(),
      ).rejects.toThrow();
    });
  });
});
