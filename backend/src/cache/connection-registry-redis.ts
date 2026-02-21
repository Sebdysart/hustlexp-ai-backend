// ============================================================================
// HustleXP Connection Registry - Redis-Based (Multi-Instance Safe)
// Replaces in-memory registry for horizontal scaling
// ============================================================================

import { Redis } from '@upstash/redis';
import { config } from '../config';
import { logger } from '../logger';

const registryLog = logger.child({ module: 'connection-registry' });

// Initialize Redis client
const redis = new Redis({
  url: config.redis.restUrl,
  token: config.redis.restToken,
});

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
  // Get connection data first
  const connData = await redis.get<string>(KEYS.connection(connectionId));
  
  if (!connData) {
    registryLog.warn({ connectionId }, 'Connection not found for unregister');
    return;
  }
  
  const connection: ConnectionMetadata = JSON.parse(connData);
  
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
  const remainingConnections = results?.[3] as number;
  
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
  const connData = await redis.get<string>(KEYS.connection(connectionId));
  
  if (!connData) {
    registryLog.warn({ connectionId }, 'Connection not found for heartbeat');
    return;
  }
  
  const connection: ConnectionMetadata = JSON.parse(connData);
  connection.lastHeartbeat = Date.now();
  
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
      connections: await redis.scard(KEYS.userConnections(connection.userId)),
    })
  );
  
  await pipeline.exec();
}

// ============================================================================
// Get User Connections
// ============================================================================
export async function getUserConnections(userId: string): Promise<string[]> {
  return redis.smembers(KEYS.userConnections(userId));
}

// ============================================================================
// Get Connection Details
// ============================================================================
export async function getConnection(connectionId: string): Promise<ConnectionMetadata | null> {
  const data = await redis.get<string>(KEYS.connection(connectionId));
  return data ? JSON.parse(data) : null;
}

// ============================================================================
// Get User Presence
// ============================================================================
export async function getUserPresence(userId: string): Promise<{
  online: boolean;
  lastSeen: number;
  connections: number;
}> {
  const data = await redis.get<string>(KEYS.userPresence(userId));
  
  if (data) {
    return JSON.parse(data);
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
  const connData = await redis.get<string>(KEYS.connection(connectionId));
  
  if (!connData) {
    throw new Error('Connection not found');
  }
  
  const connection: ConnectionMetadata = JSON.parse(connData);
  
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
  const connData = await redis.get<string>(KEYS.connection(connectionId));
  
  if (!connData) {
    return;
  }
  
  const connection: ConnectionMetadata = JSON.parse(connData);
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
  event: any
): Promise<void> {
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
  event: any
): Promise<number> {
  const connections = await getUserConnections(userId);
  
  if (connections.length === 0) {
    return 0;
  }
  
  // Publish to broadcast channel
  await publishEvent(`user:${userId}`, event);
  
  // Also store in outbox for offline delivery
  await redis.lpush(
    `outbox:${userId}`,
    JSON.stringify({
      event,
      timestamp: Date.now(),
      attempts: 0,
    })
  );
  
  // Trim outbox to prevent unbounded growth
  await redis.ltrim(`outbox:${userId}`, 0, 99);
  
  registryLog.debug({ userId, connectionCount: connections.length }, 'Broadcast to user');
  
  return connections.length;
}

/**
 * Broadcast to channel (all subscribers)
 */
export async function broadcastToChannel(
  channel: string,
  event: any
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
  return redis.smembers(KEYS.instanceConnections(instanceId));
}

/**
 * Cleanup all connections for an instance (call on shutdown)
 */
export async function cleanupInstance(instanceId: string): Promise<number> {
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
