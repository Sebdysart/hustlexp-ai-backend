// ============================================================================
// HustleXP Connection Registry - Redis-Based (Multi-Instance Safe)
// Replaces in-memory registry for horizontal scaling
// ============================================================================

import { Redis } from '@upstash/redis';
import { config } from '../config.js';
import { logger } from '../logger.js';

const registryLog = logger.child({ module: 'connection-registry' });

// Initialize Redis client (lazy/guarded — matches pattern in cache/redis.ts)
let redis: Redis | null = null;
if (config.redis.restUrl && config.redis.restToken) {
  redis = new Redis({
    url: config.redis.restUrl,
    token: config.redis.restToken,
  });
} else {
  registryLog.warn(
    'connection-registry-redis: Redis not configured (UPSTASH_REDIS_REST_URL/TOKEN missing) — realtime registry disabled'
  );
}

// ============================================================================
// Configuration
// ============================================================================
const CONNECTION_TTL = 300; // 5 minutes
const HEARTBEAT_INTERVAL = 60000; // 1 minute

// ============================================================================
// Redis Key Patterns
// ============================================================================
const KEYS = {
  connection: (connId: string) => `conn:${connId}`,
  userConnections: (userId: string) => `conn:user:${userId}`,
  instanceConnections: (instanceId: string) => `conn:instance:${instanceId}`,
  userPresence: (userId: string) => `presence:${userId}`,
  broadcastChannel: (channel: string) => `broadcast:${channel}`,
};

// ============================================================================
// Connection Metadata
// ============================================================================
interface ConnectionMetadata {
  userId: string;
  instanceId: string;
  connectedAt: number;
  lastHeartbeat: number;
  clientInfo: {
    userAgent?: string;
    ip?: string;
    deviceId?: string;
  };
  channels: string[];
}

// ============================================================================
// Register Connection
// ============================================================================
export async function registerConnection(
  connectionId: string,
  userId: string,
  instanceId: string,
  metadata: Partial<ConnectionMetadata> = {}
): Promise<void> {
  if (!redis) {
    registryLog.warn('connection-registry-redis: Redis not configured, skipping registerConnection');
    return;
  }

  const now = Date.now();

  const connectionData: ConnectionMetadata = {
    userId,
    instanceId,
    connectedAt: now,
    lastHeartbeat: now,
    clientInfo: metadata.clientInfo || {},
    channels: metadata.channels || [],
  };

  const pipeline = redis.pipeline();
  
  // Store connection details
  pipeline.setex(
    KEYS.connection(connectionId),
    CONNECTION_TTL,
    JSON.stringify(connectionData)
  );
  
  // Add to user's connection set
  pipeline.sadd(KEYS.userConnections(userId), connectionId);
  pipeline.expire(KEYS.userConnections(userId), CONNECTION_TTL);
  
  // Add to instance's connection set (for cleanup on instance shutdown)
  pipeline.sadd(KEYS.instanceConnections(instanceId), connectionId);
  pipeline.expire(KEYS.instanceConnections(instanceId), CONNECTION_TTL);
  
  // Update user presence
  pipeline.setex(
    KEYS.userPresence(userId),
    CONNECTION_TTL,
    JSON.stringify({
      online: true,
      lastSeen: now,
      connections: 1,
    })
  );
  
  await pipeline.exec();
  
  registryLog.debug({ connectionId, userId, instanceId }, 'Connection registered');
}

// ============================================================================
// Unregister Connection
// ============================================================================
export async function unregisterConnection(
  connectionId: string,
  instanceId: string
): Promise<void> {
  if (!redis) {
    registryLog.warn('connection-registry-redis: Redis not configured, skipping unregisterConnection');
    return;
  }

  // Get connection data first
  const connData = await redis.get<string>(KEYS.connection(connectionId));
  
  if (!connData) {
    registryLog.warn({ connectionId }, 'Connection not found for unregister');
    return;
  }
  
  let connection: ConnectionMetadata;
  try {
    connection = JSON.parse(connData);
  } catch {
    registryLog.warn({ key: KEYS.connection(connectionId), raw: connData }, 'connection-registry: failed to parse Redis value, skipping');
    return;
  }

  const pipeline = redis.pipeline();

  // Remove connection details
  pipeline.del(KEYS.connection(connectionId));
  
  // Remove from user's connection set
  pipeline.srem(KEYS.userConnections(connection.userId), connectionId);
  
  // Remove from instance's connection set
  pipeline.srem(KEYS.instanceConnections(instanceId), connectionId);
  
  // Check if user has other connections
  pipeline.scard(KEYS.userConnections(connection.userId));
  
  const results = await pipeline.exec();
  const scardResult = results?.[3];
  const remainingConnections = (scardResult != null && typeof scardResult === 'number') ? scardResult : 0;

  // Update user presence if no more connections
  if (remainingConnections === 0) {
    await redis.setex(
      KEYS.userPresence(connection.userId),
      CONNECTION_TTL,
      JSON.stringify({
        online: false,
        lastSeen: Date.now(),
        connections: 0,
      })
    );
    
    // Publish offline event
    await publishEvent('user:offline', {
      userId: connection.userId,
      timestamp: Date.now(),
    });
  }
  
  registryLog.debug({ connectionId, userId: connection.userId }, 'Connection unregistered');
}

// ============================================================================
// Heartbeat
// ============================================================================
export async function updateHeartbeat(
  connectionId: string,
  instanceId: string
): Promise<void> {
  if (!redis) {
    registryLog.warn('connection-registry-redis: Redis not configured, skipping updateHeartbeat');
    return;
  }

  const connData = await redis.get<string>(KEYS.connection(connectionId));
  
  if (!connData) {
    registryLog.warn({ connectionId }, 'Connection not found for heartbeat');
    return;
  }
  
  let connection: ConnectionMetadata;
  try {
    connection = JSON.parse(connData);
  } catch {
    registryLog.warn({ key: KEYS.connection(connectionId), raw: connData }, 'connection-registry: failed to parse Redis value, skipping');
    return;
  }
  connection.lastHeartbeat = Date.now();
  
  const connectionCount = await redis.scard(KEYS.userConnections(connection.userId));

  const pipeline = redis.pipeline();

  // Update connection TTL
  pipeline.setex(
    KEYS.connection(connectionId),
    CONNECTION_TTL,
    JSON.stringify(connection)
  );

  // Update user connection set TTL
  pipeline.expire(KEYS.userConnections(connection.userId), CONNECTION_TTL);

  // Update instance connection set TTL
  pipeline.expire(KEYS.instanceConnections(instanceId), CONNECTION_TTL);

  // Update user presence
  pipeline.setex(
    KEYS.userPresence(connection.userId),
    CONNECTION_TTL,
    JSON.stringify({
      online: true,
      lastSeen: Date.now(),
      connections: connectionCount,
    })
  );
  
  await pipeline.exec();
}

// ============================================================================
// Get User Connections
// ============================================================================
export async function getUserConnections(userId: string): Promise<string[]> {
  if (!redis) {
    registryLog.warn('connection-registry-redis: Redis not configured, skipping getUserConnections');
    return [];
  }
  return redis.smembers(KEYS.userConnections(userId));
}

// ============================================================================
// Get Connection Details
// ============================================================================
export async function getConnection(connectionId: string): Promise<ConnectionMetadata | null> {
  if (!redis) {
    registryLog.warn('connection-registry-redis: Redis not configured, skipping getConnection');
    return null;
  }
  const data = await redis.get<string>(KEYS.connection(connectionId));
  if (!data) return null;
  try {
    return JSON.parse(data) as ConnectionMetadata;
  } catch {
    registryLog.warn({ key: KEYS.connection(connectionId), raw: data }, 'connection-registry: failed to parse Redis value, skipping');
    return null;
  }
}

// ============================================================================
// Get User Presence
// ============================================================================
export async function getUserPresence(userId: string): Promise<{
  online: boolean;
  lastSeen: number;
  connections: number;
}> {
  if (!redis) {
    registryLog.warn('connection-registry-redis: Redis not configured, skipping getUserPresence');
    return { online: false, lastSeen: 0, connections: 0 };
  }
  const data = await redis.get<string>(KEYS.userPresence(userId));
  
  if (data) {
    try {
      return JSON.parse(data) as { online: boolean; lastSeen: number; connections: number };
    } catch {
      registryLog.warn({ key: KEYS.userPresence(userId), raw: data }, 'connection-registry: failed to parse Redis value, skipping');
    }
  }

  return {
    online: false,
    lastSeen: 0,
    connections: 0,
  };
}

// ============================================================================
// Subscribe to Channel
// ============================================================================
export async function subscribeToChannel(
  connectionId: string,
  channel: string
): Promise<void> {
  if (!redis) {
    registryLog.warn('connection-registry-redis: Redis not configured, skipping subscribeToChannel');
    return;
  }
  const connData = await redis.get<string>(KEYS.connection(connectionId));
  
  if (!connData) {
    throw new Error('Connection not found');
  }
  
  let connection: ConnectionMetadata;
  try {
    connection = JSON.parse(connData);
  } catch {
    registryLog.warn({ key: KEYS.connection(connectionId), raw: connData }, 'connection-registry: failed to parse Redis value, skipping');
    throw new Error('Connection data is corrupted');
  }

  if (!connection.channels.includes(channel)) {
    connection.channels.push(channel);
    
    await redis.setex(
      KEYS.connection(connectionId),
      CONNECTION_TTL,
      JSON.stringify(connection)
    );
  }
  
  registryLog.debug({ connectionId, channel }, 'Subscribed to channel');
}

// ============================================================================
// Unsubscribe from Channel
// ============================================================================
export async function unsubscribeFromChannel(
  connectionId: string,
  channel: string
): Promise<void> {
  if (!redis) {
    registryLog.warn('connection-registry-redis: Redis not configured, skipping unsubscribeFromChannel');
    return;
  }
  const connData = await redis.get<string>(KEYS.connection(connectionId));
  
  if (!connData) {
    return;
  }
  
  let connection: ConnectionMetadata;
  try {
    connection = JSON.parse(connData);
  } catch {
    registryLog.warn({ key: KEYS.connection(connectionId), raw: connData }, 'connection-registry: failed to parse Redis value, skipping');
    return;
  }
  connection.channels = connection.channels.filter((c) => c !== channel);
  
  await redis.setex(
    KEYS.connection(connectionId),
    CONNECTION_TTL,
    JSON.stringify(connection)
  );
  
  registryLog.debug({ connectionId, channel }, 'Unsubscribed from channel');
}

// ============================================================================
// Broadcasting
// ============================================================================

/**
 * Publish event to a channel (cross-instance)
 */
export async function publishEvent(
  channel: string,
  event: Record<string, unknown>
): Promise<void> {
  if (!redis) {
    registryLog.warn('connection-registry-redis: Redis not configured, skipping publishEvent');
    return;
  }

  const message = JSON.stringify({
    channel,
    event,
    timestamp: Date.now(),
  });

  await redis.publish(KEYS.broadcastChannel(channel), message);
  
  registryLog.debug({ channel, eventType: event.type }, 'Event published');
}

/**
 * Broadcast to specific user (all their connections across all instances)
 */
export async function broadcastToUser(
  userId: string,
  event: Record<string, unknown>
): Promise<number> {
  const connections = await getUserConnections(userId);
  
  if (connections.length === 0) {
    return 0;
  }
  
  // Publish to broadcast channel
  await publishEvent(`user:${userId}`, event);

  // Explicit null guard before direct Redis calls — publishEvent already has its own guard,
  // but the rpush/ltrim/expire block below accesses `redis` directly. The early return at
  // the top of this function handles the empty-connections case, but does not guard against
  // a null redis reference here. Add the guard to satisfy the null-safety invariant.
  if (!redis) return 0;

  // Also store in outbox for offline delivery
  const outboxKey = `outbox:${userId}`;
  await redis.rpush(
    outboxKey,
    JSON.stringify({
      event,
      timestamp: Date.now(),
      attempts: 0,
    })
  );
  // Cap outbox to 100 most-recent messages and set a 24-hour TTL so the
  // list is reclaimed automatically if the user never reconnects.
  await redis.ltrim(outboxKey, -100, -1);
  await redis.expire(outboxKey, 86400);
  
  registryLog.debug({ userId, connectionCount: connections.length }, 'Broadcast to user');
  
  return connections.length;
}

/**
 * Broadcast to channel (all subscribers)
 */
export async function broadcastToChannel(
  channel: string,
  event: Record<string, unknown>
): Promise<void> {
  await publishEvent(channel, event);
  
  registryLog.debug({ channel, eventType: event.type }, 'Broadcast to channel');
}

// ============================================================================
// Instance Management
// ============================================================================

/**
 * Get all connections for an instance (for cleanup on shutdown)
 */
export async function getInstanceConnections(instanceId: string): Promise<string[]> {
  if (!redis) {
    registryLog.warn('connection-registry-redis: Redis not configured, skipping getInstanceConnections');
    return [];
  }
  return redis.smembers(KEYS.instanceConnections(instanceId));
}

/**
 * Cleanup all connections for an instance (call on shutdown)
 */
export async function cleanupInstance(instanceId: string): Promise<number> {
  if (!redis) {
    registryLog.warn('connection-registry-redis: Redis not configured, skipping cleanupInstance');
    return 0;
  }

  const connections = await getInstanceConnections(instanceId);

  for (const connectionId of connections) {
    await unregisterConnection(connectionId, instanceId);
  }

  // Delete instance set
  await redis.del(KEYS.instanceConnections(instanceId));
  
  registryLog.info({ instanceId, connectionCount: connections.length }, 'Instance cleaned up');
  
  return connections.length;
}

// ============================================================================
// Statistics
// ============================================================================
export async function getRegistryStats(): Promise<{
  totalConnections: number;
  onlineUsers: number;
  totalUsers: number;
}> {
  // This is an approximation - for exact counts, use SCAN
  return {
    totalConnections: 0,
    onlineUsers: 0,
    totalUsers: 0,
  };
}

// ============================================================================
// Heartbeat Manager (run in each instance)
// ============================================================================
export function startHeartbeatManager(instanceId: string): void {
  setInterval(async () => {
    const connections = await getInstanceConnections(instanceId);
    
    for (const connectionId of connections) {
      await updateHeartbeat(connectionId, instanceId);
    }
  }, HEARTBEAT_INTERVAL);
  
  registryLog.info({ instanceId }, 'Heartbeat manager started');
}
