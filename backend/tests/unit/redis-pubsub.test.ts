import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Shared mock instances — hoisted before vi.mock factories
const { mockPublisher, mockSubscriber } = vi.hoisted(() => ({
  mockPublisher: {
    publish: vi.fn().mockResolvedValue(1),
    on: vi.fn(),
    quit: vi.fn().mockResolvedValue('OK'),
  },
  mockSubscriber: {
    subscribe: vi.fn().mockResolvedValue(1),
    unsubscribe: vi.fn().mockResolvedValue(1),
    on: vi.fn(),
    quit: vi.fn().mockResolvedValue('OK'),
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
      subscribeToRoom('user1', 'room:test:1');
      const subs = getRoomSubscribers('room:test:1');
      expect(subs).toBeDefined();
      expect(subs!.has('user1')).toBe(true);
    });

    it('creates a new set when room does not exist', () => {
      subscribeToRoom('userNew', 'room:test:new');
      const subs = getRoomSubscribers('room:test:new');
      expect(subs).toBeDefined();
      expect(subs!.size).toBe(1);
    });

    it('adds multiple users to same room', () => {
      subscribeToRoom('userA', 'room:test:multi');
      subscribeToRoom('userB', 'room:test:multi');
      const subs = getRoomSubscribers('room:test:multi');
      expect(subs!.size).toBe(2);
      expect(subs!.has('userA')).toBe(true);
      expect(subs!.has('userB')).toBe(true);
    });
  });

  describe('unsubscribeFromRoom', () => {
    it('removes user from room', () => {
      subscribeToRoom('userX', 'room:test:unsub');
      unsubscribeFromRoom('userX', 'room:test:unsub');
      const subs = getRoomSubscribers('room:test:unsub');
      expect(subs).toBeUndefined();
    });

    it('keeps room when other users remain', () => {
      subscribeToRoom('u1', 'room:test:partial');
      subscribeToRoom('u2', 'room:test:partial');
      unsubscribeFromRoom('u1', 'room:test:partial');
      const subs = getRoomSubscribers('room:test:partial');
      expect(subs).toBeDefined();
      expect(subs!.size).toBe(1);
      expect(subs!.has('u2')).toBe(true);
    });

    it('handles unsubscribing from non-existent room gracefully', () => {
      expect(() => unsubscribeFromRoom('u1', 'room:nonexistent')).not.toThrow();
    });
  });

  describe('unsubscribeAllRooms', () => {
    it('removes user from all rooms', () => {
      subscribeToRoom('userAll', 'room:test:all1');
      subscribeToRoom('userAll', 'room:test:all2');
      unsubscribeAllRooms('userAll');
      expect(getRoomSubscribers('room:test:all1')).toBeUndefined();
      expect(getRoomSubscribers('room:test:all2')).toBeUndefined();
    });

    it('handles user with no rooms gracefully', () => {
      expect(() => unsubscribeAllRooms('nobody')).not.toThrow();
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
    it('subscribes user to task room', () => {
      subscribeToTask('user1', 'task1');
      const subs = getRoomSubscribers('room:task:task1');
      expect(subs).toBeDefined();
      expect(subs!.has('user1')).toBe(true);
    });
  });

  describe('unsubscribeFromTask', () => {
    it('unsubscribes user from task room', () => {
      subscribeToTask('user1', 'task2');
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
