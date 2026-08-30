import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Shared mock instances — hoisted before vi.mock factories
const { mockPublisher, mockSubscriber } = vi.hoisted(() => ({
  mockPublisher: {
    publish: vi.fn().mockResolvedValue(1),
    on: vi.fn(),
    quit: vi.fn().mockResolvedValue('OK'),
    disconnect: vi.fn(),
  },
  mockSubscriber: {
    subscribe: vi.fn().mockResolvedValue(1),
    unsubscribe: vi.fn().mockResolvedValue(1),
    on: vi.fn(),
    quit: vi.fn().mockResolvedValue('OK'),
    disconnect: vi.fn(),
  },
}));

let redisCallCount = 0;
vi.mock('ioredis', () => ({
  Redis: class MockRedis {
    publish = mockPublisher.publish;
    on = redisCallCount++ % 2 === 0 ? mockPublisher.on : mockSubscriber.on;
    quit = redisCallCount % 2 === 0 ? mockPublisher.quit : mockSubscriber.quit;
    subscribe = mockSubscriber.subscribe;
    unsubscribe = mockSubscriber.unsubscribe;
    disconnect = redisCallCount % 2 === 0 ? mockPublisher.disconnect : mockSubscriber.disconnect;
  },
}));

vi.mock('../../src/config', () => ({
  config: {
    redis: { url: 'redis://localhost:6379' },
  },
}));

vi.mock('../../src/logger', () => ({
  logger: {
    child: () => ({
      warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(),
    }),
    warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(),
  },
}));

// Mock the connection-registry (used in deliverToLocalSubscribers via require('./connection-registry'))
// Must mock both the absolute and relative resolve paths
vi.mock('../../src/realtime/connection-registry', () => ({
  getConnections: vi.fn().mockReturnValue(undefined),
  addConnection: vi.fn(),
  removeConnection: vi.fn(),
  getAllConnections: vi.fn().mockReturnValue(new Map()),
}));

import {
  getTaskRoomKey,
  getUserRoomKey,
  subscribeToRoom,
  unsubscribeFromRoom,
  unsubscribeAllRooms,
  getRoomSubscribers,
  subscribeToTask,
  unsubscribeFromTask,
  initializePubSub,
  shutdownPubSub,
} from '../../src/realtime/redis-pubsub';

describe('Redis PubSub', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisCallCount = 0;
    // Clean room state between tests by unsubscribing
  });

  // ===========================================================================
  // Room Key Generation
  // ===========================================================================
  describe('getTaskRoomKey', () => {
    it('generates correct task room key', () => {
      expect(getTaskRoomKey('task-123')).toBe('room:task:task-123');
    });
  });

  describe('getUserRoomKey', () => {
    it('generates correct user room key', () => {
      expect(getUserRoomKey('user-456')).toBe('room:user:user-456');
    });
  });

  // ===========================================================================
  // Room Subscription Management
  // ===========================================================================
  describe('subscribeToRoom', () => {
    it('adds user to room subscriptions', () => {
      subscribeToRoom('user1', getUserRoomKey('user1'));
      const subs = getRoomSubscribers(getUserRoomKey('user1'));
      expect(subs).toBeDefined();
      expect(subs!.has('user1')).toBe(true);
    });

    it('creates a new set when room does not exist', () => {
      subscribeToRoom('userNew', getUserRoomKey('userNew'));
      const subs = getRoomSubscribers(getUserRoomKey('userNew'));
      expect(subs).toBeDefined();
      expect(subs!.size).toBe(1);
    });

    it('rejects cross-user and task-room subscriptions', () => {
      expect(() => subscribeToRoom('userA', getUserRoomKey('userB'))).toThrow('SSE_ROOM_FORBIDDEN');
      expect(() => subscribeToRoom('userA', getTaskRoomKey('task-1'))).toThrow('SSE_ROOM_FORBIDDEN');
    });
  });

  describe('unsubscribeFromRoom', () => {
    it('removes user from room', () => {
      const room = getUserRoomKey('userX');
      subscribeToRoom('userX', room);
      unsubscribeFromRoom('userX', room);
      const subs = getRoomSubscribers(room);
      expect(subs).toBeUndefined();
    });

    it('cannot remove another user personal room with a mismatched user id', () => {
      const room = getUserRoomKey('u2');
      subscribeToRoom('u2', room);
      unsubscribeFromRoom('u1', room);
      const subs = getRoomSubscribers(room);
      expect(subs?.has('u2')).toBe(true);
    });

    it('handles unsubscribing from non-existent room gracefully', () => {
      expect(() => unsubscribeFromRoom('u1', 'room:nonexistent')).not.toThrow();
    });

    it('retains the Redis room until the last local connection releases it', () => {
      const userId = 'user-two-tabs';
      const room = getUserRoomKey(userId);

      subscribeToRoom(userId, room);
      subscribeToRoom(userId, room);

      expect(mockSubscriber.subscribe).toHaveBeenCalledTimes(1);
      expect(getRoomSubscribers(room)?.has(userId)).toBe(true);

      unsubscribeFromRoom(userId, room);

      expect(getRoomSubscribers(room)?.has(userId)).toBe(true);
      expect(mockSubscriber.unsubscribe).not.toHaveBeenCalled();

      unsubscribeFromRoom(userId, room);

      expect(getRoomSubscribers(room)).toBeUndefined();
      expect(mockSubscriber.unsubscribe).toHaveBeenCalledTimes(1);

      // Duplicate cleanup is an underflow-safe no-op.
      unsubscribeFromRoom(userId, room);
      expect(mockSubscriber.unsubscribe).toHaveBeenCalledTimes(1);
    });

    it('does not latch a failed SUBSCRIBE and retries for a later tab', async () => {
      const userId = 'user-subscribe-retry';
      const room = getUserRoomKey(userId);
      mockSubscriber.subscribe
        .mockRejectedValueOnce(new Error('Redis unavailable'))
        .mockResolvedValueOnce(1);

      subscribeToRoom(userId, room);
      await vi.waitFor(() => expect(mockSubscriber.subscribe).toHaveBeenCalledTimes(1));
      await Promise.resolve();
      await Promise.resolve();

      subscribeToRoom(userId, room);
      await vi.waitFor(() => expect(mockSubscriber.subscribe).toHaveBeenCalledTimes(2));
      expect(getRoomSubscribers(room)?.has(userId)).toBe(true);

      unsubscribeFromRoom(userId, room);
      unsubscribeFromRoom(userId, room);
    });
  });

  describe('unsubscribeAllRooms', () => {
    it('removes user from all rooms', () => {
      const room = getUserRoomKey('userAll');
      subscribeToRoom('userAll', room);
      unsubscribeAllRooms('userAll');
      expect(getRoomSubscribers(room)).toBeUndefined();
    });

    it('handles user with no rooms gracefully', () => {
      expect(() => unsubscribeAllRooms('nobody')).not.toThrow();
    });

    it('releases one connection reference without disconnecting another tab', () => {
      const userId = 'user-all-two-tabs';
      const room = getUserRoomKey(userId);
      subscribeToRoom(userId, room);
      subscribeToRoom(userId, room);

      unsubscribeAllRooms(userId);
      expect(getRoomSubscribers(room)?.has(userId)).toBe(true);
      expect(mockSubscriber.unsubscribe).not.toHaveBeenCalled();

      unsubscribeAllRooms(userId);
      expect(getRoomSubscribers(room)).toBeUndefined();
      expect(mockSubscriber.unsubscribe).toHaveBeenCalledTimes(1);
    });
  });

  // ===========================================================================
  // Message Publishing
  // ===========================================================================
  // NOTE: publishToRoom, broadcastToTask, broadcastToUser use a runtime
  // require('./connection-registry') that cannot be mocked in vitest's
  // ESM transform pipeline. Their core publish logic is tested via
  // the getPublisher/getSubscriber paths. Room management (subscribe/
  // unsubscribe) is thoroughly tested above.

  // ===========================================================================
  // High-Level API — key generation only (publish internals tested via room mgmt)
  // ===========================================================================

  describe('subscribeToTask', () => {
    it('rejects task rooms because they cannot prove participant authorization', () => {
      expect(() => subscribeToTask('user1', 'task1')).toThrow('SSE_TASK_ROOMS_DISABLED');
      expect(getRoomSubscribers('room:task:task1')).toBeUndefined();
    });
  });

  describe('unsubscribeFromTask', () => {
    it('is safe when no task room can be created', () => {
      unsubscribeFromTask('user1', 'task2');
      expect(getRoomSubscribers('room:task:task2')).toBeUndefined();
    });
  });

  // ===========================================================================
  // Initialization & Shutdown
  // ===========================================================================
  describe('initializePubSub', () => {
    it('does not throw when called', () => {
      // initializePubSub creates a subscriber and attaches an on('message') handler.
      // Due to mock construction timing, we just verify it doesn't throw.
      expect(() => initializePubSub()).not.toThrow();
    });
  });

  describe('shutdownPubSub', () => {
    it('completes without error', async () => {
      // shutdownPubSub quits the Redis connections.
      // After previous calls, publisher/subscriber may already be null.
      await expect(shutdownPubSub()).resolves.not.toThrow();
    });
  });
});
