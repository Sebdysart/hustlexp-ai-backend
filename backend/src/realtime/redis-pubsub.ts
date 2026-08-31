/**
 * Redis Pub/Sub for SSE Multi-Instance Fanout
 * 
 * Enables SSE to work across multiple server instances using Redis pub/sub.
 * Also adds room-based subscriptions for task-specific updates.
 * 
 * Architecture:
 * - Local in-memory connections per instance
 * - Redis pub/sub for cross-instance message delivery
 * - Room-based subscriptions (task-specific channels)
 * 
 * @see PRODUCTION_HARDENING.md
 */

import { Redis } from 'ioredis';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { getConnections, teardownConnection } from './connection-registry.js';
import {
  createUserRealtimeEnvelope,
  getCanonicalUserRoomKey,
  getUserIdFromCanonicalRoomKey,
  isCanonicalUserRoomKey,
  parseUserRealtimeEnvelope,
  USER_REALTIME_SCHEMA_VERSION,
  type UserRealtimeEnvelope,
} from './user-realtime-contract.js';

const log = logger.child({ module: 'redis-pubsub' });

// ============================================================================
// REDIS CLIENTS
// ============================================================================

let publisher: Redis | null = null;
let subscriber: Redis | null = null;
let pubSubInitialized = false;

export const PUBSUB_QUIT_TIMEOUT_MS = 5_000;

export function getPublisher(): Redis {
  if (!publisher) {
    if (!config.redis.url) {
      throw new Error('HX004: Redis URL not configured for pub/sub');
    }
    publisher = new Redis(config.redis.url, {
      retryStrategy: (times) => Math.min(times * 50, 2000),
      maxRetriesPerRequest: 3,
    });
    publisher.on('error', (err) => onRedisError(err, 'publisher'));
  }
  return publisher;
}

export function getSubscriber(): Redis {
  if (!subscriber) {
    if (!config.redis.url) {
      throw new Error('HX004: Redis URL not configured for pub/sub');
    }
    subscriber = new Redis(config.redis.url, {
      retryStrategy: (times) => Math.min(times * 50, 2000),
      maxRetriesPerRequest: 3,
    });
    subscriber.on('error', (err) => onRedisError(err, 'subscriber'));
  }
  return subscriber;
}

function onRedisError(err: unknown, role: string): void {
  const replyErr = err as { message?: string; type?: string };
  if (replyErr?.type === 'ReplyError' && replyErr?.message?.includes('WRONGPASS')) {
    log.error(
      'Redis %s: WRONGPASS — invalid username/password for TCP connection. Use REDIS_URL (or the legacy UPSTASH_REDIS_URL alias), never a REST token.',
      role
    );
    return;
  }
  log.error({ err }, 'Redis %s error', role);
}

// ============================================================================
// ROOM MANAGEMENT
// ============================================================================

// Local in-memory room subscriptions
// Map: roomKey → Set<userId>
const roomSubscriptions = new Map<string, Set<string>>();

// Map: userId → (roomKey → local connection reference count)
//
// A user can have several SSE connections (for example, two browser tabs).
// Redis subscriptions are process-scoped, so each connection owns one local
// reference while the process subscribes to the channel only once.
const userRoomRefCounts = new Map<string, Map<string, number>>();

type RedisRoomSubscriptionState = {
  status: 'pending' | 'confirmed';
  releaseRequested: boolean;
};

// A local room reference and a confirmed Redis SUBSCRIBE are different facts.
// Failed SUBSCRIBE attempts are removed so a later tab/reconnect can retry.
const redisRoomSubscriptions = new Map<string, RedisRoomSubscriptionState>();

/**
 * Generate room key for a task
 */
export function getTaskRoomKey(taskId: string): string {
  return `room:task:${taskId}`;
}

/**
 * Generate room key for a user (personal updates)
 */
export function getUserRoomKey(userId: string): string {
  return getCanonicalUserRoomKey(userId);
}

function ensureRedisRoomSubscription(userId: string, roomKey: string): void {
  if (redisRoomSubscriptions.has(roomKey)) return;

  const state: RedisRoomSubscriptionState = { status: 'pending', releaseRequested: false };
  redisRoomSubscriptions.set(roomKey, state);
  const subscriberClient = getSubscriber();

  subscriberClient.subscribe(roomKey).then(() => {
    // The final local reference may have been released while SUBSCRIBE was in
    // flight. Do not turn a stale completion into an unowned subscription.
    if (redisRoomSubscriptions.get(roomKey) !== state || !roomSubscriptions.has(roomKey)) {
      if (state.releaseRequested) return undefined;
      return subscriberClient.unsubscribe(roomKey).then(() => undefined);
    }
    state.status = 'confirmed';
    log.debug({ userId, roomKey }, 'Confirmed Redis room subscription');
  }).catch((err) => {
    // Only clear this exact attempt. A later retry may already own the room.
    if (redisRoomSubscriptions.get(roomKey) === state) {
      redisRoomSubscriptions.delete(roomKey);
    }
    log.error({ err, userId, roomKey }, 'Failed to subscribe to Redis channel');
  });
}

/**
 * Subscribe a user to their own personal room.
 *
 * SECURITY: raw task-room subscription was removed because a predictable
 * `room:task:<id>` channel cannot prove participation. Task progress is fanned
 * out by the authorization-aware realtime dispatcher; Redis rooms are only for
 * personal, authenticated user delivery.
 */
export function subscribeToRoom(userId: string, roomKey: string): void {
  if (roomKey !== getUserRoomKey(userId)) {
    throw new Error('SSE_ROOM_FORBIDDEN: users may subscribe only to their personal room');
  }

  let roomRefCounts = userRoomRefCounts.get(userId);
  if (!roomRefCounts) {
    roomRefCounts = new Map();
    userRoomRefCounts.set(userId, roomRefCounts);
  }

  const currentRefCount = roomRefCounts.get(roomKey) ?? 0;
  roomRefCounts.set(roomKey, currentRefCount + 1);

  const isFirstLocalSubscriber = !roomSubscriptions.has(roomKey);

  // Add to room subscriptions
  if (isFirstLocalSubscriber) {
    roomSubscriptions.set(roomKey, new Set());
  }
  roomSubscriptions.get(roomKey)!.add(userId);

  // Subscribe on 0 → 1, or retry if a previous asynchronous SUBSCRIBE
  // failed while an earlier connection reference remained locally active.
  ensureRedisRoomSubscription(userId, roomKey);
  
  log.debug({ userId, roomKey, refCount: currentRefCount + 1 }, 'Retained local room reference');
}

/**
 * Unsubscribe a user from a room
 */
export function unsubscribeFromRoom(userId: string, roomKey: string): void {
  const roomRefCounts = userRoomRefCounts.get(userId);
  const currentRefCount = roomRefCounts?.get(roomKey) ?? 0;

  // Idempotent cleanup: a duplicate abort/cancel or mismatched user cannot
  // consume another connection's subscription reference.
  if (currentRefCount === 0 || !roomRefCounts) {
    log.debug({ userId, roomKey }, 'Room subscription already released');
    return;
  }

  if (currentRefCount > 1) {
    roomRefCounts.set(roomKey, currentRefCount - 1);
    log.debug({ userId, roomKey, refCount: currentRefCount - 1 }, 'Released room subscription reference');
    return;
  }

  roomRefCounts.delete(roomKey);
  if (roomRefCounts.size === 0) {
    userRoomRefCounts.delete(userId);
  }

  // Remove from room subscriptions
  const room = roomSubscriptions.get(roomKey);
  if (room) {
    room.delete(userId);
    if (room.size === 0) {
      roomSubscriptions.delete(roomKey);
      const redisSubscription = redisRoomSubscriptions.get(roomKey);
      redisRoomSubscriptions.delete(roomKey);
      // Redis preserves command order on one subscriber connection, so an
      // immediate UNSUBSCRIBE safely compensates even while SUBSCRIBE is
      // pending. Mark it to prevent a second compensation on resolution.
      if (redisSubscription) {
        redisSubscription.releaseRequested = true;
        getSubscriber().unsubscribe(roomKey).catch((err) => {
          log.error({ err, roomKey }, 'Failed to unsubscribe from Redis channel');
        });
      }
    }
  }
  
  log.debug({ userId, roomKey, refCount: 0 }, 'Unsubscribed from room');
}

/**
 * Release one connection's references to all of its rooms (on disconnect).
 */
export function unsubscribeAllRooms(userId: string): void {
  const roomRefCounts = userRoomRefCounts.get(userId);
  if (!roomRefCounts) return;
  
  // Each SSE connection acquires one reference to each of its rooms. Release
  // one reference per room for this connection without disturbing other tabs.
  // Copy keys to avoid mutation during iteration when a count reaches zero.
  const rooms = Array.from(roomRefCounts.keys());
  for (const roomKey of rooms) {
    unsubscribeFromRoom(userId, roomKey);
  }

  log.debug({ userId }, 'Released connection room subscriptions');
}

/**
 * Get all users subscribed to a room (local instance only)
 */
export function getRoomSubscribers(roomKey: string): Set<string> | undefined {
  return roomSubscriptions.get(roomKey);
}

// ============================================================================
// MESSAGE PUBLISHING
// ============================================================================

export interface SSEMessage {
  schemaVersion: typeof USER_REALTIME_SCHEMA_VERSION;
  type: string;
  payload: Record<string, unknown>;
  timestamp: string;
  room: string;
}

type SSEMessageInput = Pick<SSEMessage, 'type' | 'payload'> & {
  timestamp?: string;
};

/**
 * Publish one canonical personal event to Redis.
 *
 * Delivery is intentionally performed only by API subscribers. Publishing
 * must not also enqueue into process-local connections, otherwise an API
 * instance receives its own Redis echo and delivers every event twice.
 */
export async function publishUserRealtimeEvent(
  userId: string,
  type: string,
  payload: Record<string, unknown>,
  timestamp?: string,
): Promise<void> {
  const roomKey = getUserRoomKey(userId);
  const envelope = createUserRealtimeEnvelope(userId, type, payload, timestamp);
  await getPublisher().publish(roomKey, JSON.stringify(envelope));
  log.debug({ roomKey, type }, 'Published personal realtime event');
}

/**
 * Publish message to a room (cross-instance)
 */
export async function publishToRoom(roomKey: string, message: SSEMessageInput): Promise<void> {
  const timestamp = message.timestamp ?? new Date().toISOString();
  const fullMessage: SSEMessage = isCanonicalUserRoomKey(roomKey)
    ? createUserRealtimeEnvelope(
      getUserIdFromCanonicalRoomKey(roomKey),
      message.type,
      message.payload,
      timestamp,
    )
    : {
      schemaVersion: USER_REALTIME_SCHEMA_VERSION,
      type: message.type,
      payload: message.payload,
      timestamp,
      room: roomKey,
    };
  
  // Publish to Redis for other instances
  await getPublisher().publish(roomKey, JSON.stringify(fullMessage));

  // The shared Redis subscription is the sole local-delivery path. This
  // prevents publisher-origin echo from enqueuing the same event twice.
  log.debug({ roomKey, type: message.type }, 'Published message to room');
}

/**
 * Deliver message to local subscribers only
 */
function deliverToLocalSubscribers(roomKey: string, message: SSEMessage): void {
  
  const subscribers = roomSubscriptions.get(roomKey);
  if (!subscribers) return;
  
  const encoder = new TextEncoder();
  const data = `data: ${JSON.stringify(message)}\n\n`;
  const encoded = encoder.encode(data);
  
  for (const userId of subscribers) {
    const connections = getConnections(userId);
    if (!connections) continue;
    
    for (const conn of connections) {
      if (conn.closed) continue;
      try {
        conn.controller.enqueue(encoded);
      } catch (_error) {
        teardownConnection(userId, conn);
      }
    }
  }
}

// ============================================================================
// REDIS MESSAGE HANDLING
// ============================================================================

/**
 * Initialize Redis subscriber message handler
 */
export function initializePubSub(): void {
  if (pubSubInitialized) return;
  const sub = getSubscriber();
  pubSubInitialized = true;
  
  sub.on('message', (channel: string, message: string) => {
    try {
      const parsed: UserRealtimeEnvelope = parseUserRealtimeEnvelope(channel, message);
      log.debug({ channel, type: parsed.type }, 'Received Redis message');
      
      // Deliver to local subscribers
      deliverToLocalSubscribers(channel, parsed);
    } catch (error) {
      log.error({ error, channel, message }, 'Failed to parse Redis message');
    }
  });
  
  log.info('Redis pub/sub initialized');
}

/**
 * Graceful shutdown
 */
async function closeRedisClient(client: Redis, role: 'publisher' | 'subscriber'): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`Redis ${role} quit timed out after ${PUBSUB_QUIT_TIMEOUT_MS}ms`));
    }, PUBSUB_QUIT_TIMEOUT_MS);
    timeout.unref();
  });

  try {
    await Promise.race([client.quit(), timeoutPromise]);
  } catch (error) {
    // QUIT can hang behind an unavailable network. Force-close the socket so
    // process shutdown remains bounded; preserve the original error.
    try {
      client.disconnect(false);
    } catch (disconnectError) {
      throw new AggregateError(
        [error, disconnectError],
        `Redis ${role} failed graceful quit and forced disconnect`,
      );
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function shutdownPubSub(): Promise<void> {
  const publisherToClose = publisher;
  const subscriberToClose = subscriber;
  const errors: unknown[] = [];

  // Detach both roles before awaiting I/O so a failed publisher close cannot
  // strand the subscriber or make a later idempotent shutdown close it twice.
  publisher = null;
  subscriber = null;
  pubSubInitialized = false;
  redisRoomSubscriptions.clear();

  const closeResults = await Promise.allSettled([
    ...(publisherToClose ? [closeRedisClient(publisherToClose, 'publisher')] : []),
    ...(subscriberToClose ? [closeRedisClient(subscriberToClose, 'subscriber')] : []),
  ]);
  for (const result of closeResults) {
    if (result.status === 'rejected') errors.push(result.reason);
  }
  log.info('Redis pub/sub shut down');

  if (errors.length > 0) {
    throw new AggregateError(errors, 'Failed to close one or more Redis pub/sub clients');
  }
}

// ============================================================================
// HIGH-LEVEL API
// ============================================================================

/**
 * Send update to all participants in a task
 */
export async function broadcastToTask(
  taskId: string,
  type: string,
  payload: Record<string, unknown>
): Promise<void> {
  const roomKey = getTaskRoomKey(taskId);
  await publishToRoom(roomKey, { type, payload, timestamp: new Date().toISOString() });
}

/**
 * Send update to a specific user (all their connections)
 */
export async function broadcastToUser(
  userId: string,
  type: string,
  payload: Record<string, unknown>
): Promise<void> {
  const roomKey = getUserRoomKey(userId);
  await publishToRoom(roomKey, { type, payload, timestamp: new Date().toISOString() });
}

/**
 * Task-room subscriptions are deliberately disabled. Task events must pass
 * through the authorization-aware realtime dispatcher and personal rooms.
 */
export function subscribeToTask(_userId: string, _taskId: string): never {
  throw new Error('SSE_TASK_ROOMS_DISABLED');
}

/**
 * Unsubscribe user from task updates
 */
export function unsubscribeFromTask(userId: string, taskId: string): void {
  const roomKey = getTaskRoomKey(taskId);
  unsubscribeFromRoom(userId, roomKey);
}

export default {
  initializePubSub,
  shutdownPubSub,
  subscribeToRoom,
  unsubscribeFromRoom,
  unsubscribeAllRooms,
  publishToRoom,
  publishUserRealtimeEvent,
  broadcastToTask,
  broadcastToUser,
  subscribeToTask,
  unsubscribeFromTask,
  getRoomSubscribers,
};
