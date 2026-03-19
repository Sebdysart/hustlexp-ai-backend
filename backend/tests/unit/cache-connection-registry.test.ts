/**
 * cache-connection-registry.test.ts
 *
 * Unit tests for backend/src/cache/connection-registry-redis.ts
 *
 * Covers:
 *  - registerConnection()
 *  - unregisterConnection() — connection found, connection not found, zero remaining connections
 *  - updateHeartbeat() — connection found, connection not found
 *  - getUserConnections()
 *  - getConnection() — found, not found
 *  - getUserPresence() — with data, without data
 *  - subscribeToChannel() — channel not yet subscribed, already subscribed, not found
 *  - unsubscribeFromChannel() — found, not found (early return)
 *  - publishEvent()
 *  - broadcastToUser() — with connections, without connections
 *  - broadcastToChannel()
 *  - getInstanceConnections()
 *  - cleanupInstance()
 *  - getRegistryStats()
 *  - startHeartbeatManager() — verifies setInterval is called
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ===========================================================================
// vi.hoisted — build reusable mock objects before factory closures run
// ===========================================================================

const {
  mockGet,
  mockSetex,
  mockPublish,
  mockSmembers,
  mockSadd,
  mockSrem,
  mockScard,
  mockDel,
  mockRpush,
  mockLtrim,
  mockExpire,
  mockPipelineExec,
  mockPipeline,
} = vi.hoisted(() => {
  const mockGet = vi.fn();
  const mockSetex = vi.fn().mockResolvedValue('OK');
  const mockPublish = vi.fn().mockResolvedValue(1);
  const mockSmembers = vi.fn().mockResolvedValue([]);
  const mockSadd = vi.fn();
  const mockSrem = vi.fn();
  const mockScard = vi.fn().mockResolvedValue(0);
  const mockDel = vi.fn().mockResolvedValue(1);
  const mockRpush = vi.fn().mockResolvedValue(1);
  const mockLtrim = vi.fn().mockResolvedValue('OK');
  const mockExpire = vi.fn().mockResolvedValue(1);
  const mockPipelineExec = vi.fn().mockResolvedValue([1, 1, 1, 0]);

  const mockPipeline = {
    setex: vi.fn().mockReturnThis(),
    sadd: vi.fn().mockReturnThis(),
    expire: vi.fn().mockReturnThis(),
    del: vi.fn().mockReturnThis(),
    srem: vi.fn().mockReturnThis(),
    scard: vi.fn().mockReturnThis(),
    exec: mockPipelineExec,
  };

  return {
    mockGet,
    mockSetex,
    mockPublish,
    mockSmembers,
    mockSadd,
    mockSrem,
    mockScard,
    mockDel,
    mockRpush,
    mockLtrim,
    mockExpire,
    mockPipelineExec,
    mockPipeline,
  };
});

// ===========================================================================
// Mocks — must precede all imports
// ===========================================================================

vi.mock('@upstash/redis', () => ({
  Redis: function MockRedis(this: Record<string, unknown>) {
    this.get = mockGet;
    this.setex = mockSetex;
    this.publish = mockPublish;
    this.smembers = mockSmembers;
    this.sadd = mockSadd;
    this.srem = mockSrem;
    this.scard = mockScard;
    this.del = mockDel;
    this.rpush = mockRpush;
    this.ltrim = mockLtrim;
    this.expire = mockExpire;
    this.pipeline = vi.fn().mockReturnValue(mockPipeline);
  },
}));

vi.mock('../../src/config', () => ({
  config: {
    redis: {
      restUrl: 'https://fake-redis.upstash.io',
      restToken: 'fake-token',
    },
  },
}));

vi.mock('../../src/logger', () => ({
  logger: {
    child: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    })),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ===========================================================================
// Imports — after mocks
// ===========================================================================

import {
  registerConnection,
  unregisterConnection,
  updateHeartbeat,
  getUserConnections,
  getConnection,
  getUserPresence,
  subscribeToChannel,
  unsubscribeFromChannel,
  publishEvent,
  broadcastToUser,
  broadcastToChannel,
  getInstanceConnections,
  cleanupInstance,
  getRegistryStats,
  startHeartbeatManager,
} from '../../src/cache/connection-registry-redis';

// ===========================================================================
// Helpers
// ===========================================================================

/** Serialised connection metadata stored in Redis. */
function makeConnectionData(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    userId: 'user-1',
    instanceId: 'inst-1',
    connectedAt: Date.now(),
    lastHeartbeat: Date.now(),
    clientInfo: {},
    channels: [],
    ...overrides,
  });
}

// ===========================================================================
// beforeEach
// ===========================================================================

beforeEach(() => {
  vi.clearAllMocks();

  // Pipeline re-chains correctly after clearAllMocks resets mockReturnThis
  mockPipeline.setex.mockReturnThis();
  mockPipeline.sadd.mockReturnThis();
  mockPipeline.expire.mockReturnThis();
  mockPipeline.del.mockReturnThis();
  mockPipeline.srem.mockReturnThis();
  mockPipeline.scard.mockReturnThis();
  mockPipelineExec.mockResolvedValue([1, 1, 1, 0]);

  mockSmembers.mockResolvedValue([]);
  mockGet.mockResolvedValue(null);
  mockSetex.mockResolvedValue('OK');
  mockPublish.mockResolvedValue(1);
  mockScard.mockResolvedValue(0);
  mockDel.mockResolvedValue(1);
  mockRpush.mockResolvedValue(1);
  mockLtrim.mockResolvedValue('OK');
  mockExpire.mockResolvedValue(1);
});

// ===========================================================================
// registerConnection
// ===========================================================================

describe('registerConnection', () => {
  it('calls pipeline.exec once with correct keys', async () => {
    await registerConnection('conn-1', 'user-1', 'inst-1', {
      clientInfo: { userAgent: 'TestAgent' },
      channels: ['ch-a'],
    });

    expect(mockPipeline.setex).toHaveBeenCalledWith(
      'conn:conn-1',
      300,
      expect.stringContaining('"userId":"user-1"'),
    );
    expect(mockPipeline.sadd).toHaveBeenCalledWith('conn:user:user-1', 'conn-1');
    expect(mockPipeline.sadd).toHaveBeenCalledWith('conn:instance:inst-1', 'conn-1');
    expect(mockPipelineExec).toHaveBeenCalledOnce();
  });

  it('works with empty metadata defaults', async () => {
    await registerConnection('conn-2', 'user-2', 'inst-2');
    expect(mockPipelineExec).toHaveBeenCalledOnce();
  });
});

// ===========================================================================
// unregisterConnection
// ===========================================================================

describe('unregisterConnection', () => {
  it('logs warning and returns early when connection is not found', async () => {
    mockGet.mockResolvedValue(null);
    // Should not throw
    await expect(unregisterConnection('conn-missing', 'inst-1')).resolves.toBeUndefined();
    expect(mockPipelineExec).not.toHaveBeenCalled();
  });

  it('removes connection and updates presence when no remaining connections', async () => {
    mockGet.mockResolvedValue(makeConnectionData({ userId: 'user-1' }));
    // pipeline.exec returns [del:1, srem:1, srem:1, scard:0] — 0 means no connections left
    mockPipelineExec.mockResolvedValue([1, 1, 1, 0]);

    await unregisterConnection('conn-1', 'inst-1');

    expect(mockPipeline.del).toHaveBeenCalledWith('conn:conn-1');
    expect(mockPipeline.srem).toHaveBeenCalledWith('conn:user:user-1', 'conn-1');
    expect(mockPipeline.srem).toHaveBeenCalledWith('conn:instance:inst-1', 'conn-1');
    // Should set presence offline
    expect(mockSetex).toHaveBeenCalledWith(
      'presence:user-1',
      300,
      expect.stringContaining('"online":false'),
    );
    // Should publish offline event
    expect(mockPublish).toHaveBeenCalled();
  });

  it('does NOT update presence when user still has remaining connections', async () => {
    mockGet.mockResolvedValue(makeConnectionData({ userId: 'user-1' }));
    // scard returns 2, meaning user still has connections
    mockPipelineExec.mockResolvedValue([1, 1, 1, 2]);

    await unregisterConnection('conn-1', 'inst-1');

    // Presence should NOT be updated
    expect(mockSetex).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('returns early without throwing when Redis data is malformed JSON', async () => {
    mockGet.mockResolvedValue('not-valid-json{{{');
    await expect(unregisterConnection('conn-bad-json', 'inst-1')).resolves.toBeUndefined();
    expect(mockPipelineExec).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// updateHeartbeat
// ===========================================================================

describe('updateHeartbeat', () => {
  it('logs warning and returns early when connection not found', async () => {
    mockGet.mockResolvedValue(null);
    await expect(updateHeartbeat('conn-missing', 'inst-1')).resolves.toBeUndefined();
    expect(mockPipelineExec).not.toHaveBeenCalled();
  });

  it('refreshes TTL for connection, user set, and instance set', async () => {
    mockGet.mockResolvedValue(makeConnectionData({ userId: 'user-1' }));
    mockScard.mockResolvedValue(2);

    await updateHeartbeat('conn-1', 'inst-1');

    expect(mockPipeline.setex).toHaveBeenCalledWith(
      'conn:conn-1',
      300,
      expect.any(String),
    );
    expect(mockPipeline.expire).toHaveBeenCalledWith('conn:user:user-1', 300);
    expect(mockPipeline.expire).toHaveBeenCalledWith('conn:instance:inst-1', 300);
    expect(mockPipelineExec).toHaveBeenCalledOnce();
  });

  it('returns early without throwing when Redis data is malformed JSON', async () => {
    mockGet.mockResolvedValue('not-valid-json{{{');
    await expect(updateHeartbeat('conn-bad-json', 'inst-1')).resolves.toBeUndefined();
    expect(mockPipelineExec).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// getUserConnections
// ===========================================================================

describe('getUserConnections', () => {
  it('returns the list from Redis smembers', async () => {
    mockSmembers.mockResolvedValue(['conn-a', 'conn-b']);
    const result = await getUserConnections('user-1');
    expect(result).toEqual(['conn-a', 'conn-b']);
  });

  it('returns empty array when user has no connections', async () => {
    mockSmembers.mockResolvedValue([]);
    const result = await getUserConnections('user-ghost');
    expect(result).toEqual([]);
  });
});

// ===========================================================================
// getConnection
// ===========================================================================

describe('getConnection', () => {
  it('returns null when connection is not found', async () => {
    mockGet.mockResolvedValue(null);
    const result = await getConnection('conn-none');
    expect(result).toBeNull();
  });

  it('returns parsed ConnectionMetadata when found', async () => {
    const raw = makeConnectionData({ userId: 'user-42', channels: ['ch-1'] });
    mockGet.mockResolvedValue(raw);
    const result = await getConnection('conn-1');
    expect(result).not.toBeNull();
    expect(result!.userId).toBe('user-42');
    expect(result!.channels).toEqual(['ch-1']);
  });

  it('returns null and does not throw when Redis data is malformed JSON', async () => {
    mockGet.mockResolvedValue('not-valid-json{{{');
    const result = await getConnection('conn-bad-json');
    expect(result).toBeNull();
  });
});

// ===========================================================================
// getUserPresence
// ===========================================================================

describe('getUserPresence', () => {
  it('returns default offline presence when no data exists', async () => {
    mockGet.mockResolvedValue(null);
    const presence = await getUserPresence('user-offline');
    expect(presence).toEqual({ online: false, lastSeen: 0, connections: 0 });
  });

  it('returns parsed presence data when it exists', async () => {
    const presenceData = JSON.stringify({ online: true, lastSeen: 1234567890, connections: 2 });
    mockGet.mockResolvedValue(presenceData);
    const presence = await getUserPresence('user-online');
    expect(presence.online).toBe(true);
    expect(presence.lastSeen).toBe(1234567890);
    expect(presence.connections).toBe(2);
  });

  it('returns default offline presence and does not throw when Redis data is malformed JSON', async () => {
    mockGet.mockResolvedValue('not-valid-json{{{');
    const presence = await getUserPresence('user-bad-json');
    expect(presence).toEqual({ online: false, lastSeen: 0, connections: 0 });
  });
});

// ===========================================================================
// subscribeToChannel
// ===========================================================================

describe('subscribeToChannel', () => {
  it('throws when connection is not found', async () => {
    mockGet.mockResolvedValue(null);
    await expect(subscribeToChannel('conn-none', 'ch-1')).rejects.toThrow('Connection not found');
  });

  it('adds channel and persists when not already subscribed', async () => {
    const raw = makeConnectionData({ channels: [] });
    mockGet.mockResolvedValue(raw);

    await subscribeToChannel('conn-1', 'ch-new');

    expect(mockSetex).toHaveBeenCalledWith(
      'conn:conn-1',
      300,
      expect.stringContaining('"ch-new"'),
    );
  });

  it('does NOT update when channel is already subscribed', async () => {
    const raw = makeConnectionData({ channels: ['ch-existing'] });
    mockGet.mockResolvedValue(raw);

    await subscribeToChannel('conn-1', 'ch-existing');

    expect(mockSetex).not.toHaveBeenCalled();
  });

  it('throws and does not call setex when Redis data is malformed JSON', async () => {
    mockGet.mockResolvedValue('not-valid-json{{{');
    await expect(subscribeToChannel('conn-bad-json', 'ch-1')).rejects.toThrow();
    expect(mockSetex).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// unsubscribeFromChannel
// ===========================================================================

describe('unsubscribeFromChannel', () => {
  it('returns early without error when connection not found', async () => {
    mockGet.mockResolvedValue(null);
    await expect(unsubscribeFromChannel('conn-none', 'ch-1')).resolves.toBeUndefined();
    expect(mockSetex).not.toHaveBeenCalled();
  });

  it('removes channel from connection and persists', async () => {
    const raw = makeConnectionData({ channels: ['ch-keep', 'ch-remove'] });
    mockGet.mockResolvedValue(raw);

    await unsubscribeFromChannel('conn-1', 'ch-remove');

    expect(mockSetex).toHaveBeenCalledWith(
      'conn:conn-1',
      300,
      expect.not.stringContaining('ch-remove'),
    );
    expect(mockSetex).toHaveBeenCalledWith(
      'conn:conn-1',
      300,
      expect.stringContaining('ch-keep'),
    );
  });

  it('returns early without throwing when Redis data is malformed JSON', async () => {
    mockGet.mockResolvedValue('not-valid-json{{{');
    await expect(unsubscribeFromChannel('conn-bad-json', 'ch-1')).resolves.toBeUndefined();
    expect(mockSetex).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// publishEvent
// ===========================================================================

describe('publishEvent', () => {
  it('publishes a JSON message to the broadcast channel', async () => {
    await publishEvent('user:online', { userId: 'user-1', type: 'online' });

    expect(mockPublish).toHaveBeenCalledWith(
      'broadcast:user:online',
      expect.stringContaining('"channel":"user:online"'),
    );
  });

  it('message includes timestamp and event payload', async () => {
    await publishEvent('some-channel', { type: 'test', data: 42 });

    const [[, message]] = (mockPublish as ReturnType<typeof vi.fn>).mock.calls;
    const parsed = JSON.parse(message as string);
    expect(parsed.channel).toBe('some-channel');
    expect(parsed.event).toEqual({ type: 'test', data: 42 });
    expect(typeof parsed.timestamp).toBe('number');
  });
});

// ===========================================================================
// broadcastToUser
// ===========================================================================

describe('broadcastToUser', () => {
  it('returns 0 when user has no connections', async () => {
    mockSmembers.mockResolvedValue([]);
    const count = await broadcastToUser('user-offline', { type: 'test' });
    expect(count).toBe(0);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('publishes event and stores in outbox when user has connections', async () => {
    mockSmembers.mockResolvedValue(['conn-a', 'conn-b']);
    mockRpush.mockResolvedValue(2);
    mockLtrim.mockResolvedValue('OK');

    const count = await broadcastToUser('user-active', { type: 'task-update' });

    expect(count).toBe(2);
    expect(mockPublish).toHaveBeenCalled();
    expect(mockRpush).toHaveBeenCalledWith(
      'outbox:user-active',
      expect.any(String),
    );
    // ltrim keeps 100 most-recent messages (FIFO)
    expect(mockLtrim).toHaveBeenCalledWith('outbox:user-active', -100, -1);
    // outbox key gets a 24-hour TTL so it is reclaimed if the user never reconnects
    expect(mockExpire).toHaveBeenCalledWith('outbox:user-active', 86400);
  });
});

// ===========================================================================
// broadcastToChannel
// ===========================================================================

describe('broadcastToChannel', () => {
  it('publishes event to the given channel', async () => {
    await broadcastToChannel('ch-public', { type: 'announcement' });

    expect(mockPublish).toHaveBeenCalledWith(
      'broadcast:ch-public',
      expect.stringContaining('"channel":"ch-public"'),
    );
  });
});

// ===========================================================================
// getInstanceConnections
// ===========================================================================

describe('getInstanceConnections', () => {
  it('returns the list of connection IDs for the instance', async () => {
    mockSmembers.mockResolvedValue(['conn-x', 'conn-y']);
    const result = await getInstanceConnections('inst-1');
    expect(result).toEqual(['conn-x', 'conn-y']);
  });

  it('returns empty array when instance has no connections', async () => {
    mockSmembers.mockResolvedValue([]);
    const result = await getInstanceConnections('inst-empty');
    expect(result).toEqual([]);
  });
});

// ===========================================================================
// cleanupInstance
// ===========================================================================

describe('cleanupInstance', () => {
  it('returns 0 when instance has no connections', async () => {
    mockSmembers.mockResolvedValue([]);
    const count = await cleanupInstance('inst-empty');
    expect(count).toBe(0);
    // Should still delete the instance set key
    expect(mockDel).toHaveBeenCalledWith('conn:instance:inst-empty');
  });

  it('unregisters all connections and deletes instance set', async () => {
    // First smembers call returns the instance connections
    // Subsequent get calls for unregisterConnection return null (connection already gone)
    mockSmembers.mockResolvedValue(['conn-a', 'conn-b']);
    mockGet.mockResolvedValue(null); // connections not found, early return in unregisterConnection

    const count = await cleanupInstance('inst-1');

    expect(count).toBe(2);
    expect(mockDel).toHaveBeenCalledWith('conn:instance:inst-1');
  });

  it('cleans up connections that still exist in Redis', async () => {
    mockSmembers.mockResolvedValue(['conn-live']);
    mockGet.mockResolvedValue(makeConnectionData({ userId: 'user-1' }));
    mockPipelineExec.mockResolvedValue([1, 1, 1, 0]); // 0 remaining connections

    const count = await cleanupInstance('inst-has-live');
    expect(count).toBe(1);
    expect(mockDel).toHaveBeenCalledWith('conn:instance:inst-has-live');
  });
});

// ===========================================================================
// getRegistryStats
// ===========================================================================

describe('getRegistryStats', () => {
  it('returns the expected shape with zero values', async () => {
    const stats = await getRegistryStats();
    expect(stats).toEqual({
      totalConnections: 0,
      onlineUsers: 0,
      totalUsers: 0,
    });
  });
});

// ===========================================================================
// startHeartbeatManager
// ===========================================================================

describe('startHeartbeatManager', () => {
  it('calls setInterval with 60000ms interval and does not throw', () => {
    vi.useFakeTimers();

    try {
      const setIntervalSpy = vi.spyOn(global, 'setInterval');
      startHeartbeatManager('inst-heartbeat');

      expect(setIntervalSpy).toHaveBeenCalledWith(
        expect.any(Function),
        60000,
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
