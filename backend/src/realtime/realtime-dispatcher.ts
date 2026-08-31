/**
 * Realtime Dispatcher v1.0.0
 * 
 * Pillar A - Realtime Tracking: Fan out task.progress_updated events to SSE connections
 * 
 * Responsibility:
 * - Consume task.progress_updated outbox payload
 * - Determine recipients (poster + worker)
 * - Fan out to active connections
 * 
 * Hard rules:
 * - No state mutation
 * - Authorization at fanout (users only see their tasks)
 * - No retries that change meaning
 * 
 * @see Step 10 - Realtime Transport Implementation
 */

import { db } from '../db.js';
import {
  getConnections,
  getAllConnections,
  forceDisconnectUser,
  teardownConnection,
  type SSEConnection,
} from './connection-registry.js';
import { PlanService } from '../services/PlanService.js';
import type { TaskProgressState } from '../types.js';
import { logger } from '../logger.js';
import { publishUserRealtimeEvent } from './redis-pubsub.js';

const log = logger.child({ module: 'realtime-dispatcher' });

// ============================================================================
// TYPES
// ============================================================================

interface TaskProgressUpdatedPayload {
  taskId: string;
  from: string;
  to: string;
  actor: {
    type: 'worker' | 'system';
    userId: string | null;
  };
  occurredAt: string;
}

interface OutboxEvent {
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: TaskProgressUpdatedPayload;
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Check whether a user is currently banned.
 *
 * Called before every fanout write so that a ban takes effect on the next
 * pushed event even if the SSE connection was already open at ban time.
 * If the user is banned their stream is force-closed here as a side-effect,
 * so subsequent events skip them automatically.
 */
async function checkAndEvictBannedUser(userId: string): Promise<boolean> {
  const result = await db.query<{ is_banned: boolean }>(
    'SELECT COALESCE(is_banned, false) as is_banned FROM users WHERE id = $1',
    [userId]
  );
  if (result.rows.length === 0) return true; // user deleted — treat as banned
  if (result.rows[0].is_banned) {
    forceDisconnectUser(userId);
    log.info({ userId }, 'Evicted banned user from SSE during fanout');
    return true;
  }
  return false;
}

// ============================================================================
// REALTIME DISPATCHER
// ============================================================================

/**
 * Dispatch task.progress_updated event to authorized recipients
 * 
 * Recipients:
 * - Poster (always)
 * - Worker (if exists)
 * 
 * Authorization: Users only receive events for tasks they are party to
 */
export async function dispatchTaskProgress(event: OutboxEvent): Promise<void> {
  if (event.event_type !== 'task.progress_updated') {
    throw new Error(`Unexpected event type: ${event.event_type}`);
  }

  const { taskId } = event.payload;

  // Resolve recipients (poster + worker)
  const taskResult = await db.query<{
    poster_id: string;
    worker_id: string | null;
    risk_level: string;
  }>(
    `SELECT poster_id, worker_id, risk_level FROM tasks WHERE id = $1`,
    [taskId]
  );

  if (taskResult.rows.length === 0) {
    log.warn({ taskId }, 'Task not found for realtime dispatch, skipping');
    return;
  }

  const task = taskResult.rows[0];
  const { to } = event.payload;

  // Step 9-C: Filter live tracking events (TRAVELING/WORKING) by plan
  // Premium users get all events, free users only get basic states
  const recipients = new Set<string>();
  
  // Check poster eligibility
  const posterCanReceive = await PlanService.canReceiveProgressEvent(task.poster_id, to as TaskProgressState);
  if (posterCanReceive) {
    recipients.add(task.poster_id);
  }

  // Check worker eligibility (if exists)
  if (task.worker_id) {
    const workerCanReceive = await PlanService.canReceiveProgressEvent(task.worker_id, to as TaskProgressState);
    if (workerCanReceive) {
      recipients.add(task.worker_id);
    }
  }

  const authorizedRecipients: string[] = [];
  for (const userId of recipients) {
    // Re-check ban status before publication so a stream opened before a ban
    // cannot receive the next progress event.
    if (await checkAndEvictBannedUser(userId)) continue;
    authorizedRecipients.push(userId);
  }

  // The job may run in a dedicated worker with no process-local API
  // connections. Publish canonical personal envelopes; every API instance
  // receives its subscribed user rooms through Redis and performs local SSE
  // fanout there. Task-room subscription remains disabled.
  await Promise.all(authorizedRecipients.map((userId) => publishUserRealtimeEvent(
    userId,
    event.event_type,
    event.payload as unknown as Record<string, unknown>,
    event.payload.occurredAt,
  )));

  if (authorizedRecipients.length > 0) {
    log.info({ taskId, recipientCount: authorizedRecipients.length }, 'task.progress_updated Redis fanout complete');
  }
}

/**
 * Dispatch message.new event to recipient's SSE connections
 */
export async function dispatchNewMessage(payload: {
  messageId: string;
  taskId: string;
  senderId: string;
  recipientId: string;
  content?: string;
  createdAt: string;
}): Promise<void> {
  const { recipientId } = payload;

  // Bug 1 fix: re-check ban status so a banned recipient's stream is closed
  // even if the connection was opened before the ban was applied.
  if (await checkAndEvictBannedUser(recipientId)) return;

  const conns = getConnections(recipientId);
  if (!conns) return;

  const sseMessage = `event: message.new\ndata: ${JSON.stringify(payload)}\n\n`;

  for (const conn of conns) {
    if (conn.closed) continue;
    try {
      await writeToConnection(recipientId, conn, sseMessage);
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error), recipientId }, 'Failed to write message.new to SSE');
    }
  }
}

/**
 * Write SSE message to connection
 *
 * Uses the ReadableStream controller to enqueue the message
 */
async function writeToConnection(userId: string, conn: SSEConnection, message: string): Promise<void> {
  if (conn.closed) {
    return; // Connection already closed
  }

  try {
    const encoder = new TextEncoder();
    conn.controller.enqueue(encoder.encode(message));
  } catch (error) {
    teardownConnection(userId, conn);
    throw error;
  }
}

/**
 * Broadcast a flag_changed event to all active SSE connections
 */
export async function dispatchFlagChanged(flagName: string): Promise<void> {
  const allConnections = getAllConnections();
  const message = `event: flag_changed\ndata: ${JSON.stringify({ flag: flagName })}\n\n`;

  let fanoutCount = 0;
  for (const [userId, conns] of allConnections) {
    for (const conn of conns) {
      if (conn.closed) continue;
      try {
        await writeToConnection(userId, conn, message);
        fanoutCount++;
      } catch (error) {
        log.error({ err: error instanceof Error ? error.message : String(error), userId }, 'Failed to write flag_changed to SSE connection');
      }
    }
  }

  if (fanoutCount > 0) {
    log.info({ flagName, connectionCount: fanoutCount }, 'flag_changed broadcast complete');
  }
}
