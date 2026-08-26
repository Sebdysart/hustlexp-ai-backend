import { db } from '../db.js';
import { writeToOutbox } from '../lib/outbox-helpers.js';
import { taskLogger } from '../logger.js';
import type { ServiceResult, Task, TaskState } from '../types.js';
import { ErrorCodes } from '../types.js';
import { VALID_TASK_TRANSITIONS } from './TaskServiceShared.js';
const log = taskLogger.child({ service: 'TaskService' });

export const TaskAbandonService = {
workerAbandon: async (taskId: string, workerId: string, reason?: string): Promise<ServiceResult<Task>> => {
    try {
      return await db.transaction(async (query) => {
        // Acquire row-level lock before reading state
        const lockResult = await query<{ state: string; worker_id: string | null; poster_id: string }>(
          `SELECT state, worker_id, poster_id FROM tasks WHERE id = $1 FOR UPDATE`,
          [taskId]
        );

        if (lockResult.rows.length === 0) {
          return {
            success: false,
            error: {
              code: ErrorCodes.NOT_FOUND,
              message: `Task ${taskId} not found`,
            },
          };
        }

        const { state: currentState, worker_id: assignedWorkerId } = lockResult.rows[0];

        // Verify the caller is the assigned worker
        if (assignedWorkerId !== workerId) {
          return {
            success: false,
            error: {
              code: ErrorCodes.FORBIDDEN,
              message: 'Only the assigned worker can abandon this task',
            },
          };
        }

        // Only ACCEPTED tasks can be abandoned
        if (!['ACCEPTED'].includes(currentState)) {
          return {
            success: false,
            error: {
              code: ErrorCodes.INVALID_STATE,
              message: `Cannot abandon task: current state is ${currentState}. Only ACCEPTED tasks can be abandoned.`,
            },
          };
        }

        // Transition to CANCELLED — worker abandonment is a terminal event for this assignment.
        // The task creator can re-post if needed. OPEN is not a valid transition from ACCEPTED
        // per VALID_TRANSITIONS, and the escrow would be in LOCKED_DISPUTE state making any
        // new worker unpayable.
        const result = await query<Task>(
          `UPDATE tasks
           SET state = 'CANCELLED',
               worker_id = NULL,
               accepted_at = NULL,
               updated_at = NOW()
           WHERE id = $1
             AND state = 'ACCEPTED'
             AND worker_id = $2
           RETURNING *`,
          [taskId, workerId]
        );

        if (result.rowCount === 0) {
          // Should be unreachable given the FOR UPDATE lock above, but guard anyway
          return {
            success: false,
            error: {
              code: ErrorCodes.INVALID_STATE,
              message: 'Cannot abandon task: state changed unexpectedly',
            },
          };
        }

        // Log the abandonment reason to task_events if the table exists
        // (fire-and-forget inside the transaction — failure is non-fatal)
        if (reason) {
          await query(
            `INSERT INTO task_events (task_id, event_type, actor_id, metadata, created_at)
             VALUES ($1, 'worker_abandoned', $2, $3, NOW())
             ON CONFLICT DO NOTHING`,
            [taskId, workerId, JSON.stringify({ reason })]
          ).catch((error) => {
            log.warn(
              { taskId, workerId, err: error instanceof Error ? error.message : String(error) },
              'Could not persist best-effort worker abandonment event',
            );
          });
        }

        // Worker abandonment = full refund to poster. Lock the escrow to
        // LOCKED_DISPUTE state atomically before emitting the outbox event.
        // This prevents a new worker from being assigned to the same escrow
        // if the payment worker fails to process the refund in time.
        // escrow-action-worker requires state=LOCKED_DISPUTE to process
        // escrow.refund_requested events (see escrow-action-worker.ts:208).
        const escrowLock = await query<{ id: string; version: number }>(
          `UPDATE escrows
           SET state = 'LOCKED_DISPUTE',
               version = version + 1,
               updated_at = NOW()
           WHERE task_id = $1 AND state = 'FUNDED'
           RETURNING id,version`,
          [taskId]
        );

        if ((escrowLock.rowCount ?? 0) > 0) {
          const lockedEscrow = escrowLock.rows[0];
          const escrowId = lockedEscrow.id;
          const authorityMetadata = {
            event_type: 'worker_abandon_refund_authority_v1',
            task_id: taskId,
            worker_id: workerId,
            reason: reason ?? null,
            canonical_state: 'LOCKED_DISPUTE',
            canonical_version: lockedEscrow.version,
          };
          const authorityKey = `worker-abandon-refund-authority-v1:${escrowId}:${taskId}:${lockedEscrow.version}`;
          const authority = await query<{ metadata: unknown }>(
            `WITH attempted AS (
               INSERT INTO escrow_events
                 (escrow_id,from_state,to_state,actor_id,actor_type,metadata,idempotency_key)
               VALUES ($1,'FUNDED','LOCKED_DISPUTE',$2,'user',$3::jsonb,$4)
               ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
               RETURNING metadata
             )
             SELECT metadata FROM attempted
             UNION ALL
             SELECT metadata FROM escrow_events
              WHERE escrow_id=$1
                AND from_state='FUNDED' AND to_state='LOCKED_DISPUTE'
                AND actor_id=$2 AND actor_type='user'
                AND metadata::jsonb=$3::jsonb
                AND idempotency_key=$4
                AND NOT EXISTS (SELECT 1 FROM attempted)`,
            [escrowId, workerId, JSON.stringify(authorityMetadata), authorityKey],
          );
          if (authority.rows.length !== 1) {
            throw new Error(
              `Worker-abandon refund authority conflicts for escrow ${escrowId}`,
            );
          }
          await writeToOutbox(
            {
              eventType: 'escrow.refund_requested',
              aggregateType: 'escrow',
              aggregateId: escrowId,
              eventVersion: lockedEscrow.version,
              payload: {
                escrow_id: escrowId,
                task_id: taskId,
                reason: 'worker_abandoned',
              },
              queueName: 'critical_payments',
              idempotencyKey: `escrow.refund_on_worker_abandon:${escrowId}:${taskId}`,
            },
            query
          );
          log.info({ escrowId, taskId, workerId }, 'Escrow locked (FUNDED→LOCKED_DISPUTE) and refund requested on worker abandonment');
        }

        return { success: true, data: result.rows[0] };
      });
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error) }, 'TaskService DB error');
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: 'A database error occurred. Please try again.',
        },
      };
    }
  },
  getValidTransitions: (state: TaskState) => VALID_TASK_TRANSITIONS[state] ?? []
};
