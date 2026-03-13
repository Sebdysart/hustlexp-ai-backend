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
import { getConnections } from './connection-registry.js';

const log = logger.child({ module: 'redis-pubsub' });

// ============================================================================
// REDIS CLIENTS
// ============================================================================

let publisher: Redis | null = null;
let subscriber: Redis | null = null;

export function getPublisher(): Redis {
  if (!publisher) {
    if (!config.redis.url) {
      throw new Error('HX004: Redis URL not configured for pub/sub');
    }
    publisher = new Redis(config.redis.url, {
      retryStrategy: (times) => Math.min(times * 50, 2000),
      maxRetriesPerRequest: 3,
    });
    publisher.on('error', (err) => log.error({ err }, 'Redis publisher error'));
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
    subscriber.on('error', (err) => log.error({ err }, 'Redis subscriber error'));
  }
  return subscriber;
}

// ============================================================================
// ROOM MANAGEMENT
// ============================================================================

// Local in-memory room subscriptions
// Map: roomKey → Set<userId>
const roomSubscriptions = new Map<string, Set<string>>();

// Map: userId → Set<roomKey>
const userRooms = new Map<string, Set<string>>();

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
  return `room:user:${userId}`;
}

/**
 * Subscribe a user to a room
 */
export function subscribeToRoom(userId: string, roomKey: string): void {
  // Add to room subscriptions
  if (!roomSubscriptions.has(roomKey)) {
    roomSubscriptions.set(roomKey, new Set());
  }
  roomSubscriptions.get(roomKey)!.add(userId);
  
  // Add to user's room list
  if (!userRooms.has(userId)) {
    userRooms.set(userId, new Set());
  }
  userRooms.get(userId)!.add(roomKey);
  
  // Subscribe to Redis channel for this room
  getSubscriber().subscribe(roomKey).catch((err) => {
    log.error({ err, userId, roomKey }, 'Failed to subscribe to Redis channel');
  });
  
  log.debug({ userId, roomKey }, 'Subscribed to room');
}

/**
 * Unsubscribe a user from a room
 */
export function unsubscribeFromRoom(userId: string, roomKey: string): void {
  // Remove from room subscriptions
  const room = roomSubscriptions.get(roomKey);
  if (room) {
    room.delete(userId);
    if (room.size === 0) {
      roomSubscriptions.delete(roomKey);
      // Unsubscribe from Redis channel when no local users
      getSubscriber().unsubscribe(roomKey).catch((err) => {
        log.error({ err, roomKey }, 'Failed to unsubscribe from Redis channel');
      });
    }
  }
  
  // Remove from user's room list
  const userRoomList = userRooms.get(userId);
  if (userRoomList) {
    userRoomList.delete(roomKey);
    if (userRoomList.size === 0) {
      userRooms.delete(userId);
    }
  }
  
  log.debug({ userId, roomKey }, 'Unsubscribed from room');
}

/**
 * Unsubscribe a user from all rooms (on disconnect)
 */
export function unsubscribeAllRooms(userId: string): void {
  const userRoomList = userRooms.get(userId);
  if (!userRoomList) return;
  
  // Copy to avoid mutation during iteration
  const rooms = Array.from(userRoomList);
  for (const roomKey of rooms) {
    unsubscribeFromRoom(userId, roomKey);
  }
  
  userRooms.delete(userId);
  log.debug({ userId }, 'Unsubscribed from all rooms');
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
  type: string;
  payload: Record<string, unknown>;
  timestamp: string;
  room?: string;
}

/**
 * Publish message to a room (cross-instance)
 */
export async function publishToRoom(roomKey: string, message: Omit<SSEMessage, 'room'>): Promise<void> {
  const fullMessage: SSEMessage = {
    ...message,
    room: roomKey,
    timestamp: new Date().toISOString(),
  };
  
  // Publish to Redis for other instances
  await getPublisher().publish(roomKey, JSON.stringify(fullMessage));
  
  // Also deliver to local subscribers immediately
  deliverToLocalSubscribers(roomKey, fullMessage);
  
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
        // Connection closed
        conn.closed = true;
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
  const sub = getSubscriber();
  
  sub.on('message', (channel: string, message: string) => {
    try {
      const parsed: SSEMessage = JSON.parse(message);
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
export async function shutdownPubSub(): Promise<void> {
  if (publisher) {
    await publisher.quit();
    publisher = null;
  }
  if (subscriber) {
    await subscriber.quit();
    subscriber = null;
  }
  log.info('Redis pub/sub shut down');
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
 * Subscribe user to task updates
 */
export function subscribeToTask(userId: string, taskId: string): void {
  const roomKey = getTaskRoomKey(taskId);
  subscribeToRoom(userId, roomKey);
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
  broadcastToTask,
  broadcastToUser,
  subscribeToTask,
  unsubscribeFromTask,
  getRoomSubscribers,
};
