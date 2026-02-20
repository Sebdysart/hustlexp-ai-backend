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

import { db } from '../db';
import { getConnections, type SSEConnection } from './connection-registry';
import { PlanService } from '../services/PlanService';
import { logger } from '../logger';

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
  const posterCanReceive = await PlanService.canReceiveProgressEvent(task.poster_id, to as any);
  if (posterCanReceive) {
    recipients.add(task.poster_id);
  }

  // Check worker eligibility (if exists)
  if (task.worker_id) {
    const workerCanReceive = await PlanService.canReceiveProgressEvent(task.worker_id, to as any);
    if (workerCanReceive) {
      recipients.add(task.worker_id);
    }
  }

  // Format SSE message
  const sseMessage = formatSSEMessage(event.payload);

  // Fan out to active connections
  let fanoutCount = 0;
  for (const userId of recipients) {
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
