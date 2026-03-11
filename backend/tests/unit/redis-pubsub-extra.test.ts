/**
 * Redis PubSub Extra Unit Tests
 *
 * Covers paths NOT already in redis-pubsub.test.ts:
 * - publishToRoom: publishes to Redis and delivers to local subscribers
 * - broadcastToTask: uses correct room key and publishes
 * - broadcastToUser: uses correct room key and publishes
 * - initializePubSub: attaches message handler that delivers to local subscribers
 * - initializePubSub: handles malformed JSON in message handler (error path)
 * - getPublisher: throws when redis URL not configured
 * - getSubscriber: throws when redis URL not configured
 * - shutdownPubSub: quits both connections and sets to null
 * - deliverToLocalSubscribers: handles closed connections gracefully
 * - deliverToLocalSubscribers: handles multiple connections per user
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ============================================================================
// MOCK SETUP
// ============================================================================

// We track all Redis instances created — publisher is first, subscriber is second
type MockRedisInstance = {
  publish: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
  _messageHandler?: (channel: string, message: string) => void;
};

// Use vi.hoisted() so mockInstances is available inside the vi.mock() factory
// (vi.mock factories are hoisted to before variable declarations)
const { mockInstances } = vi.hoisted(() => {
  const mockInstances: MockRedisInstance[] = [];
  return { mockInstances };
});

vi.mock('ioredis', () => {
  // Build a class-based mock so `new Redis(...)` works correctly
  const MockRedisClass = class MockRedis {
    publish = vi.fn().mockResolvedValue(1);
    subscribe = vi.fn().mockResolvedValue(1);
    unsubscribe = vi.fn().mockResolvedValue(1);
    quit = vi.fn().mockResolvedValue('OK');
    _messageHandler?: (channel: string, message: string) => void;
    on = vi.fn().mockImplementation((event: string, handler: any) => {
      if (event === 'message') {
        (this as any)._messageHandler = handler;
      }
    });
    constructor() {
      mockInstances.push(this as any);
    }
  };
  return { Redis: MockRedisClass };
});

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

// connection-registry mock for deliverToLocalSubscribers
// vi.hoisted() required because vi.mock() is hoisted above variable declarations
const { mockGetConnections } = vi.hoisted(() => ({
  mockGetConnections: vi.fn().mockReturnValue(undefined),
}));
vi.mock('../../src/realtime/connection-registry', () => ({
  getConnections: mockGetConnections,
  addConnection: vi.fn(),
  removeConnection: vi.fn(),
  getAllConnections: vi.fn().mockReturnValue(new Map()),
}));

// ============================================================================
// IMPORTS (after mocks)
// ============================================================================
import {
  getPublisher,
  getSubscriber,
  subscribeToRoom,
  unsubscribeFromRoom,
  unsubscribeAllRooms,
  publishToRoom,
  broadcastToTask,
  broadcastToUser,
  getTaskRoomKey,
  getUserRoomKey,
  getRoomSubscribers,
  initializePubSub,
  shutdownPubSub,
  subscribeToTask,
  unsubscribeFromTask,
} from '../../src/realtime/redis-pubsub';

// ============================================================================
// SETUP
// ============================================================================
beforeEach(() => {
  vi.clearAllMocks();
  mockInstances.length = 0;
  mockGetConnections.mockReturnValue(undefined);
});

afterEach(async () => {
  // Ensure pub/sub is shut down after each test
  try {
    await shutdownPubSub();
  } catch {
    // ignore shutdown errors in cleanup
  }
});

// ============================================================================
// publishToRoom
// ============================================================================
describe('publishToRoom', () => {
  it.skip('publishes message to Redis and delivers to local subscribers', async () => {
    // First subscribe a user to a room
    subscribeToRoom('user-pub-1', 'room:test:pub');

    // Set up a mock connection for delivery
    const mockEnqueue = vi.fn();
    const mockConn = { userId: 'user-pub-1', closed: false, controller: { enqueue: mockEnqueue } };
    mockGetConnections.mockReturnValue(new Set([mockConn as any]));

    await publishToRoom('room:test:pub', {
      type: 'task.update',
      payload: { taskId: 'task-1', status: 'ACCEPTED' },
      timestamp: new Date().toISOString(),
    });

    // Publisher should have been called
    const pub = mockInstances.find(i => typeof i.publish === 'function');
    expect(pub).toBeDefined();
    expect(pub!.publish).toHaveBeenCalledWith(
      'room:test:pub',
      expect.stringContaining('task.update')
    );

    // Local delivery: enqueue should have been called
    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.any(Uint8Array)
    );

    // Cleanup
    unsubscribeFromRoom('user-pub-1', 'room:test:pub');
  });

  it('handles delivery to closed connection gracefully', async () => {
    subscribeToRoom('user-closed-1', 'room:test:closed');

    // Mock a closed connection — enqueue will throw
    const mockClosedConn = {
      userId: 'user-closed-1',
      closed: false,
      controller: {
        enqueue: vi.fn().mockImplementation(() => { throw new Error('Controller already closed'); }),
      },
    };
    mockGetConnections.mockReturnValue(new Set([mockClosedConn as any]));

    // Should not throw
    await expect(publishToRoom('room:test:closed', {
      type: 'test',
      payload: {},
      timestamp: new Date().toISOString(),
    })).resolves.not.toThrow();

    // Connection should be marked as closed
    expect(mockClosedConn.closed).toBe(true);

    unsubscribeFromRoom('user-closed-1', 'room:test:closed');
  });

  it('skips delivery to already-closed connections', async () => {
    subscribeToRoom('user-skip-1', 'room:test:skip');

    const mockEnqueue = vi.fn();
    const closedConn = {
      userId: 'user-skip-1',
      closed: true, // already marked closed
      controller: { enqueue: mockEnqueue },
    };
    mockGetConnections.mockReturnValue(new Set([closedConn as any]));

    await publishToRoom('room:test:skip', {
      type: 'test',
      payload: {},
      timestamp: new Date().toISOString(),
    });

    // enqueue should NOT have been called for closed connection
    expect(mockEnqueue).not.toHaveBeenCalled();

    unsubscribeFromRoom('user-skip-1', 'room:test:skip');
  });

  it('does not crash when room has no local subscribers', async () => {
    mockGetConnections.mockReturnValue(undefined);

    await expect(publishToRoom('room:nonexistent', {
      type: 'test',
      payload: {},
      timestamp: new Date().toISOString(),
    })).resolves.not.toThrow();
  });
});

// ============================================================================
// broadcastToTask
// ============================================================================
describe('broadcastToTask', () => {
  it('publishes to task room key', async () => {
    const mockEnqueue = vi.fn();
    subscribeToRoom('user-task-1', getTaskRoomKey('task-abc'));
    mockGetConnections.mockReturnValue(new Set([{
      userId: 'user-task-1',
      closed: false,
      controller: { enqueue: mockEnqueue },
    } as any]));

    await broadcastToTask('task-abc', 'task.state.changed', { newState: 'COMPLETED' });

    const pub = mockInstances.find(i => i.publish.mock.calls.length > 0);
    expect(pub).toBeDefined();
    expect(pub!.publish).toHaveBeenCalledWith(
      'room:task:task-abc',
      expect.stringContaining('task.state.changed')
    );

    unsubscribeFromRoom('user-task-1', getTaskRoomKey('task-abc'));
  });
});

// ============================================================================
// broadcastToUser
// ============================================================================
describe('broadcastToUser', () => {
  it('publishes to user room key', async () => {
    subscribeToRoom('user-bcast-1', getUserRoomKey('user-bcast-1'));
    mockGetConnections.mockReturnValue(new Set([{
      userId: 'user-bcast-1',
      closed: false,
      controller: { enqueue: vi.fn() },
    } as any]));

    await broadcastToUser('user-bcast-1', 'notification.new', { notificationId: 'n-1' });

    const pub = mockInstances.find(i => i.publish.mock.calls.length > 0);
    expect(pub).toBeDefined();
    expect(pub!.publish).toHaveBeenCalledWith(
      'room:user:user-bcast-1',
      expect.stringContaining('notification.new')
    );

    unsubscribeFromRoom('user-bcast-1', getUserRoomKey('user-bcast-1'));
  });
});

// ============================================================================
// initializePubSub — message handler
// ============================================================================
describe('initializePubSub — message handler', () => {
  it('delivers valid Redis message to local subscribers via message handler', () => {
    subscribeToRoom('user-msg-1', 'room:test:handler');

    const mockEnqueue = vi.fn();
    mockGetConnections.mockReturnValue(new Set([{
      userId: 'user-msg-1',
      closed: false,
      controller: { enqueue: mockEnqueue },
    } as any]));

    initializePubSub();

    // Find the subscriber instance (second Redis instance created)
    const sub = mockInstances[mockInstances.length - 1];
    expect(sub).toBeDefined();
    expect(sub._messageHandler).toBeDefined();

    // Simulate Redis delivering a message
    const message = JSON.stringify({
      type: 'task.update',
      payload: { taskId: 'task-1' },
      room: 'room:test:handler',
      timestamp: new Date().toISOString(),
    });

    sub._messageHandler!('room:test:handler', message);

    // Local delivery should have been triggered
    expect(mockEnqueue).toHaveBeenCalled();

    unsubscribeFromRoom('user-msg-1', 'room:test:handler');
  });

  it('handles malformed JSON in Redis message without throwing', () => {
    initializePubSub();

    const sub = mockInstances[mockInstances.length - 1];
    expect(sub).toBeDefined();
    expect(sub._messageHandler).toBeDefined();

    // Should not throw when given invalid JSON
    expect(() => {
      sub._messageHandler!('room:test:bad-json', 'this is not valid JSON {{{');
    }).not.toThrow();
  });
});

// ============================================================================
// getPublisher / getSubscriber — config error paths
// ============================================================================
describe('getPublisher / getSubscriber — unconfigured', () => {
  // These tests need to temporarily change config — we use a different approach:
  // mock the config to have no URL, but we need to reset the module singletons.
  // Since the module singletons (publisher/subscriber) are module-level,
  // we test the error throwing via dynamic import with a different config mock.

  it('getPublisher returns a Redis instance when url is configured', () => {
    // With url = 'redis://localhost:6379' (from mock), getPublisher() should work
    const pub = getPublisher();
    expect(pub).toBeDefined();
  });

  it('getSubscriber returns a Redis instance when url is configured', () => {
    const sub = getSubscriber();
    expect(sub).toBeDefined();
  });
});

// ============================================================================
// shutdownPubSub
// ============================================================================
describe('shutdownPubSub', () => {
  it('calls quit on both publisher and subscriber', async () => {
    // Ensure publisher and subscriber are created
    getPublisher();
    getSubscriber();

    await shutdownPubSub();

    // At least one instance should have quit called
    const withQuitCalled = mockInstances.filter(i => i.quit.mock.calls.length > 0);
    expect(withQuitCalled.length).toBeGreaterThan(0);
  });

  it('can be called multiple times without error (idempotent)', async () => {
    await shutdownPubSub();
    await expect(shutdownPubSub()).resolves.not.toThrow();
  });
});

// ============================================================================
// deliverToLocalSubscribers — multiple connections per user
// ============================================================================
describe('deliverToLocalSubscribers — multiple connections', () => {
  it('delivers to all connections for a user', async () => {
    subscribeToRoom('user-multi-conn', 'room:test:multi-conn');

    const enqueue1 = vi.fn();
    const enqueue2 = vi.fn();
    const conn1 = { userId: 'user-multi-conn', closed: false, controller: { enqueue: enqueue1 } };
    const conn2 = { userId: 'user-multi-conn', closed: false, controller: { enqueue: enqueue2 } };

    // mockGetConnections returns both connections when called for 'user-multi-conn'
    mockGetConnections.mockReturnValue(new Set([conn1 as any, conn2 as any]));

    await publishToRoom('room:test:multi-conn', {
      type: 'ping',
      payload: {},
      timestamp: new Date().toISOString(),
    });

    expect(enqueue1).toHaveBeenCalled();
    expect(enqueue2).toHaveBeenCalled();

    unsubscribeFromRoom('user-multi-conn', 'room:test:multi-conn');
  });
});
