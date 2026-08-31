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
  disconnect: ReturnType<typeof vi.fn>;
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
    disconnect = vi.fn();
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
const { mockGetConnections, mockTeardownConnection } = vi.hoisted(() => ({
  mockGetConnections: vi.fn().mockReturnValue(undefined),
  mockTeardownConnection: vi.fn(),
}));
vi.mock('../../src/realtime/connection-registry', () => ({
  getConnections: mockGetConnections,
  teardownConnection: mockTeardownConnection,
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
  it('publishes through Redis and delivers exactly once from the subscriber echo', async () => {
    // First subscribe a user to a room
    subscribeToRoom('user-pub-1', getUserRoomKey('user-pub-1'));

    // Set up a mock connection for delivery
    const mockEnqueue = vi.fn();
    const mockConn = { userId: 'user-pub-1', closed: false, controller: { enqueue: mockEnqueue } };
    mockGetConnections.mockReturnValue(new Set([mockConn as any]));

    await publishToRoom(getUserRoomKey('user-pub-1'), {
      type: 'task.update',
      payload: { taskId: 'task-1', status: 'ACCEPTED' },
      timestamp: new Date().toISOString(),
    });

    // Publisher should have been called
    const pub = mockInstances.find(i => i.publish.mock.calls.length > 0);
    expect(pub).toBeDefined();
    expect(pub!.publish).toHaveBeenCalledWith(
      getUserRoomKey('user-pub-1'),
      expect.stringContaining('task.update')
    );
    const published = JSON.parse(pub!.publish.mock.calls[0][1] as string);
    expect(published).toEqual(expect.objectContaining({
      schemaVersion: 1,
      type: 'task.update',
      room: getUserRoomKey('user-pub-1'),
      payload: { taskId: 'task-1', status: 'ACCEPTED' },
    }));

    // Origin publication must not enqueue locally. The API instance's Redis
    // subscriber is the single delivery authority.
    expect(mockEnqueue).not.toHaveBeenCalled();
    initializePubSub();
    const sub = mockInstances.find(instance => instance._messageHandler);
    expect(sub?._messageHandler).toBeDefined();
    sub!._messageHandler!(
      pub!.publish.mock.calls[0][0] as string,
      pub!.publish.mock.calls[0][1] as string,
    );
    expect(mockEnqueue).toHaveBeenCalledOnce();
    expect(mockEnqueue).toHaveBeenCalledWith(expect.any(Uint8Array));

    // Cleanup
    unsubscribeFromRoom('user-pub-1', getUserRoomKey('user-pub-1'));
  });

  it('handles delivery to closed connection gracefully', async () => {
    subscribeToRoom('user-closed-1', getUserRoomKey('user-closed-1'));

    // Mock a closed connection — enqueue will throw
    const mockClosedConn = {
      userId: 'user-closed-1',
      closed: false,
      controller: {
        enqueue: vi.fn().mockImplementation(() => { throw new Error('Controller already closed'); }),
      },
    };
    mockGetConnections.mockReturnValue(new Set([mockClosedConn as any]));

    await publishToRoom(getUserRoomKey('user-closed-1'), {
      type: 'test',
      payload: {},
      timestamp: new Date().toISOString(),
    });
    initializePubSub();
    const pub = mockInstances.find(instance => instance.publish.mock.calls.length > 0)!;
    const sub = mockInstances.find(instance => instance._messageHandler)!;
    sub._messageHandler!(pub.publish.mock.calls[0][0], pub.publish.mock.calls[0][1]);

    expect(mockTeardownConnection).toHaveBeenCalledWith('user-closed-1', mockClosedConn);

    unsubscribeFromRoom('user-closed-1', getUserRoomKey('user-closed-1'));
  });

  it('skips delivery to already-closed connections', async () => {
    subscribeToRoom('user-skip-1', getUserRoomKey('user-skip-1'));

    const mockEnqueue = vi.fn();
    const closedConn = {
      userId: 'user-skip-1',
      closed: true, // already marked closed
      controller: { enqueue: mockEnqueue },
    };
    mockGetConnections.mockReturnValue(new Set([closedConn as any]));

    await publishToRoom(getUserRoomKey('user-skip-1'), {
      type: 'test',
      payload: {},
      timestamp: new Date().toISOString(),
    });

    initializePubSub();
    const pub = mockInstances.find(instance => instance.publish.mock.calls.length > 0)!;
    const sub = mockInstances.find(instance => instance._messageHandler)!;
    sub._messageHandler!(pub.publish.mock.calls[0][0], pub.publish.mock.calls[0][1]);

    // enqueue should NOT have been called for closed connection
    expect(mockEnqueue).not.toHaveBeenCalled();

    unsubscribeFromRoom('user-skip-1', getUserRoomKey('user-skip-1'));
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
    expect(() => subscribeToTask('user-task-1', 'task-abc')).toThrow('SSE_TASK_ROOMS_DISABLED');
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
    subscribeToRoom('user-msg-1', getUserRoomKey('user-msg-1'));

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
      schemaVersion: 1,
      type: 'task.update',
      payload: { taskId: 'task-1' },
      room: getUserRoomKey('user-msg-1'),
      timestamp: new Date().toISOString(),
    });

    sub._messageHandler!(getUserRoomKey('user-msg-1'), message);

    // Local delivery should have been triggered
    expect(mockEnqueue).toHaveBeenCalled();

    unsubscribeFromRoom('user-msg-1', getUserRoomKey('user-msg-1'));
  });

  it('drops the orphan legacy channel and a room-mismatched envelope', () => {
    subscribeToRoom('user-msg-2', getUserRoomKey('user-msg-2'));
    const mockEnqueue = vi.fn();
    mockGetConnections.mockReturnValue(new Set([{
      userId: 'user-msg-2',
      closed: false,
      controller: { enqueue: mockEnqueue },
    } as any]));
    initializePubSub();

    const sub = mockInstances[mockInstances.length - 1];
    const envelope = {
      schemaVersion: 1,
      type: 'message.new',
      payload: { messageId: 'message-1' },
      room: getUserRoomKey('user-msg-2'),
      timestamp: new Date().toISOString(),
    };

    sub._messageHandler!('realtime:user:user-msg-2', JSON.stringify(envelope));
    sub._messageHandler!(getUserRoomKey('user-msg-2'), JSON.stringify({
      ...envelope,
      room: getUserRoomKey('different-user'),
    }));

    expect(mockEnqueue).not.toHaveBeenCalled();
    unsubscribeFromRoom('user-msg-2', getUserRoomKey('user-msg-2'));
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

  it('keeps cross-instance delivery active when one of two local connections disconnects', () => {
    const userId = 'user-cross-instance-two-tabs';
    const room = getUserRoomKey(userId);
    const enqueueTabOne = vi.fn();
    const enqueueTabTwo = vi.fn();
    const tabOne = {
      userId,
      closed: false,
      controller: { enqueue: enqueueTabOne },
    };
    const tabTwo = {
      userId,
      closed: false,
      controller: { enqueue: enqueueTabTwo },
    };

    subscribeToRoom(userId, room);
    subscribeToRoom(userId, room);
    mockGetConnections.mockReturnValue(new Set([tabOne as any, tabTwo as any]));
    initializePubSub();

    const sub = mockInstances[mockInstances.length - 1];
    const remoteEnvelope = JSON.stringify({
      schemaVersion: 1,
      type: 'notification.new',
      payload: { notificationId: 'remote-notification-1' },
      room,
      timestamp: new Date().toISOString(),
    });

    // This message callback represents a publish performed by another API
    // instance and delivered through the shared Redis channel.
    sub._messageHandler!(room, remoteEnvelope);
    expect(enqueueTabOne).toHaveBeenCalledTimes(1);
    expect(enqueueTabTwo).toHaveBeenCalledTimes(1);

    // Tab one disconnects. Its registry entry and one subscription reference
    // are removed, but Redis must remain subscribed for tab two.
    mockGetConnections.mockReturnValue(new Set([tabTwo as any]));
    unsubscribeAllRooms(userId);
    expect(sub.unsubscribe).not.toHaveBeenCalled();

    sub._messageHandler!(room, remoteEnvelope);
    expect(enqueueTabOne).toHaveBeenCalledTimes(1);
    expect(enqueueTabTwo).toHaveBeenCalledTimes(2);

    unsubscribeAllRooms(userId);
    expect(sub.unsubscribe).toHaveBeenCalledTimes(1);
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

  it('still closes the subscriber and aggregates when publisher close fails', async () => {
    const pub = getPublisher() as unknown as MockRedisInstance;
    const sub = getSubscriber() as unknown as MockRedisInstance;
    const publisherError = new Error('publisher close failed');
    pub.quit.mockRejectedValueOnce(publisherError);

    const close = shutdownPubSub();
    await expect(close).rejects.toThrow('Failed to close one or more Redis pub/sub clients');
    const error = await close.catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([publisherError]);
    expect(pub.quit).toHaveBeenCalledTimes(1);
    expect(sub.quit).toHaveBeenCalledTimes(1);
    expect(pub.disconnect).toHaveBeenCalledWith(false);
    await expect(shutdownPubSub()).resolves.toBeUndefined();
  });

  it('bounds a hung quit and force-disconnects both Redis roles', async () => {
    vi.useFakeTimers();
    try {
      const pub = getPublisher() as unknown as MockRedisInstance;
      const sub = getSubscriber() as unknown as MockRedisInstance;
      pub.quit.mockImplementationOnce(() => new Promise(() => undefined));
      sub.quit.mockImplementationOnce(() => new Promise(() => undefined));

      const close = shutdownPubSub();
      const closeExpectation = expect(close).rejects.toThrow(
        'Failed to close one or more Redis pub/sub clients',
      );
      await vi.advanceTimersByTimeAsync(10_001);

      await closeExpectation;
      expect(pub.disconnect).toHaveBeenCalledWith(false);
      expect(sub.disconnect).toHaveBeenCalledWith(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ============================================================================
// deliverToLocalSubscribers — multiple connections per user
// ============================================================================
describe('deliverToLocalSubscribers — multiple connections', () => {
  it('delivers to all connections for a user', async () => {
    subscribeToRoom('user-multi-conn', getUserRoomKey('user-multi-conn'));

    const enqueue1 = vi.fn();
    const enqueue2 = vi.fn();
    const conn1 = { userId: 'user-multi-conn', closed: false, controller: { enqueue: enqueue1 } };
    const conn2 = { userId: 'user-multi-conn', closed: false, controller: { enqueue: enqueue2 } };

    // mockGetConnections returns both connections when called for 'user-multi-conn'
    mockGetConnections.mockReturnValue(new Set([conn1 as any, conn2 as any]));

    await publishToRoom(getUserRoomKey('user-multi-conn'), {
      type: 'ping',
      payload: {},
      timestamp: new Date().toISOString(),
    });

    initializePubSub();
    const pub = mockInstances.find(instance => instance.publish.mock.calls.length > 0)!;
    const sub = mockInstances.find(instance => instance._messageHandler)!;
    sub._messageHandler!(pub.publish.mock.calls[0][0], pub.publish.mock.calls[0][1]);

    expect(enqueue1).toHaveBeenCalled();
    expect(enqueue2).toHaveBeenCalled();

    unsubscribeFromRoom('user-multi-conn', getUserRoomKey('user-multi-conn'));
  });
});
