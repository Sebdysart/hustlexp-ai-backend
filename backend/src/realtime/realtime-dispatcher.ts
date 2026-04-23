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
import { getConnections, getAllConnections, forceDisconnectUser, type SSEConnection } from './connection-registry.js';
import { PlanService } from '../services/PlanService.js';
import type { TaskProgressState } from '../types.js';
import { logger } from '../logger.js';

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
    `SELECT (account_status IN ('SUSPENDED', 'DELETED')) as is_banned FROM users WHERE id = $1`,
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

  // Format SSE message
  const sseMessage = formatSSEMessage(event.payload);

  // Fan out to active connections
  let fanoutCount = 0;
  for (const userId of recipients) {
    // Bug 1 fix: re-check ban status on every fanout so streams opened before
    // a ban do not continue receiving events.
    if (await checkAndEvictBannedUser(userId)) continue;

    const conns = getConnections(userId);
    if (!conns) continue;

    for (const conn of conns) {
      if (conn.closed) continue;

      try {
        await writeToConnection(conn, sseMessage);
        fanoutCount++;
      } catch (error) {
        // Write failure → mark connection as closed (client will reconnect)
        log.error({ err: error instanceof Error ? error.message : String(error), userId }, 'Failed to write to SSE connection');
        conn.closed = true;
      }
    }
  }

  if (fanoutCount > 0) {
    log.info({ taskId, recipientCount: recipients.size, connectionCount: fanoutCount }, 'task.progress_updated fanout complete');
  }
}

/**
 * Format payload as SSE message
 */
function formatSSEMessage(payload: TaskProgressUpdatedPayload): string {
  return `event: task.progress_updated\ndata: ${JSON.stringify(payload)}\n\n`;
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
      await writeToConnection(conn, sseMessage);
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error), recipientId }, 'Failed to write message.new to SSE');
      conn.closed = true;
    }
  }
}

/**
 * Write SSE message to connection
 *
 * Uses the ReadableStream controller to enqueue the message
 */
async function writeToConnection(conn: SSEConnection, message: string): Promise<void> {
  if (conn.closed) {
    return; // Connection already closed
  }

  try {
    const encoder = new TextEncoder();
    conn.controller.enqueue(encoder.encode(message));
  } catch (error) {
    // Controller closed or stream error - mark connection as closed
    conn.closed = true;
    throw error;
  }
}

/**
 * Dispatch earnings.updated event to a specific worker's SSE connections.
 *
 * Fired after escrow release so the worker's EarningsScreen updates in real-time.
 */
export async function dispatchEarningsUpdated(payload: {
  userId: string;
  taskId: string;
  taskTitle: string;
  amountCents: number;
  netPayoutCents: number;
  newTotalEarningsCents: number;
}): Promise<void> {
  const { userId } = payload;

  if (await checkAndEvictBannedUser(userId)) return;

  const conns = getConnections(userId);
  if (!conns) return;

  const sseMessage = `event: earnings.updated\ndata: ${JSON.stringify(payload)}\n\n`;

  let fanoutCount = 0;
  for (const conn of conns) {
    if (conn.closed) continue;
    try {
      await writeToConnection(conn, sseMessage);
      fanoutCount++;
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error), userId }, 'Failed to write earnings.updated to SSE');
      conn.closed = true;
    }
  }

  if (fanoutCount > 0) {
    log.info({ userId, taskId: payload.taskId, amountCents: payload.netPayoutCents }, 'earnings.updated fanout complete');
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
        await writeToConnection(conn, message);
        fanoutCount++;
      } catch (error) {
        log.error({ err: error instanceof Error ? error.message : String(error), userId }, 'Failed to write flag_changed to SSE connection');
        conn.closed = true;
      }
    }
  }

  if (fanoutCount > 0) {
    log.info({ flagName, connectionCount: fanoutCount }, 'flag_changed broadcast complete');
  }
}
