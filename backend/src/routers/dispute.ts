/**
 * Dispute Router v1.0.0
 *
 * CONSTITUTIONAL: Financial safety path — dispute creation locks escrow and
 * prevents premature payout until resolution. Both roles (poster and worker)
 * may initiate disputes on a completed task.
 *
 * Procedures:
 *   create          (protectedProcedure) — Open a dispute on a completed task
 *   getById         (protectedProcedure) — Fetch a single dispute
 *   getByTask       (protectedProcedure) — Fetch all disputes for a task
 *   getMine         (protectedProcedure) — Fetch disputes for the current user
 *
 * @see DisputeService.ts
 * @see DISPUTE_SPEC.md
 * @see TODO.md §iOS Feature Sync — P0 financial safety path
 */

import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, protectedProcedure, Schemas } from '../trpc.js';
import { DisputeService } from '../services/DisputeService.js';
import { TaskService } from '../services/TaskService.js';
import { EscrowService } from '../services/EscrowService.js';
import { db } from '../db.js';

export const disputeRouter = router({
  // --------------------------------------------------------------------------
  // WRITE OPERATIONS
  // --------------------------------------------------------------------------

  /**
   * Open a dispute on a completed task.
   *
   * Either the poster or worker on the task may initiate. The router resolves
   * poster_id and worker_id from the task record so the iOS client only needs
   * to send { taskId, reason, description }.
   *
   * On success the associated escrow is locked (LOCKED_DISPUTE state) and an
   * outbox event is emitted to notify the other party.
   */
  create: protectedProcedure
    .input(z.object({
      taskId: Schemas.uuid,
      reason: z.string().min(1).max(500),
      description: z.string().min(1).max(2000),
    }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user!.id;

      // Resolve the task so we can extract escrow_id, poster_id, worker_id.
      const taskResult = await TaskService.getById(input.taskId);
      if (!taskResult.success) {
        throw new TRPCError({
          code: taskResult.error.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'INTERNAL_SERVER_ERROR',
          message: taskResult.error.message,
        });
      }

      const task = taskResult.data;

      // Early participant check — non-participants receive NOT_FOUND (not FORBIDDEN)
      // so task existence and lifecycle state are not leaked to unrelated callers.
      if (task.poster_id !== userId && task.worker_id !== userId) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' });
      }

      // Validate that a worker is assigned — disputes require two parties.
      if (!task.worker_id) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Cannot open dispute on task with no assigned worker',
        });
      }

      // Early task-state validation — reject before any DB transaction is opened in the
      // service, reducing unnecessary lock contention on the DB critical path.
      // The service validates this too (INVALID_STATE), but this fast-path check avoids
      // acquiring FOR UPDATE locks for clearly invalid states.
      //
      // BUG R-3 FIX: PROOF_SUBMITTED is a valid dispute state. A poster who disagrees
      // with the submitted proof should be able to open a dispute at that point rather
      // than being forced to wait until the task reaches COMPLETED. Without this,
      // the poster's only option after an unacceptable proof submission was to reject
      // it and hope the worker resubmits — there was no escalation path.
      const validDisputeStates = ['COMPLETED', 'PROOF_SUBMITTED'];
      if (!validDisputeStates.includes(task.state)) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Disputes can only be opened for completed tasks or tasks with submitted proof',
        });
      }

      // Resolve the escrow for this task.
      const escrowResult = await EscrowService.getByTaskId(input.taskId);
      if (!escrowResult.success) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: escrowResult.error.message ?? 'Task has no associated escrow — cannot open dispute',
        });
      }

      // R-11: ADVISORY BEST-EFFORT CHECK ONLY — NOT a TOCTOU guard.
      // This SELECT runs outside any transaction, so two concurrent requests can
      // both read zero rows and both proceed to DisputeService.create(). The real
      // duplicate-prevention guard is the FOR UPDATE lock inside
      // DisputeService.create() (which locks both the task and escrow rows before
      // inserting the dispute). This outer check is retained solely as a cheap
      // fast-path to avoid entering the service transaction for obvious duplicates
      // on non-concurrent traffic. Do NOT rely on it for correctness.
      const existingDispute = await db.query<{ id: string }>(
        `SELECT id FROM disputes WHERE task_id = $1 AND state NOT IN ('RESOLVED')`,
        [task.id]
      );
      if ((existingDispute.rowCount ?? 0) > 0) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'A dispute already exists for this task',
        });
      }

      const result = await DisputeService.create({
        taskId: input.taskId,
        escrowId: escrowResult.data.id,
        initiatedBy: userId,
        posterId: task.poster_id,
        workerId: task.worker_id,
        reason: input.reason,
        description: input.description,
      });

      if (!result.success) {
        const errCode = result.error.code;
        if (errCode === 'FORBIDDEN') {
          throw new TRPCError({ code: 'FORBIDDEN', message: result.error.message });
        }
        if (errCode === 'INVALID_STATE') {
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message: result.error.message });
        }
        if (errCode === 'NOT_FOUND') {
          throw new TRPCError({ code: 'NOT_FOUND', message: result.error.message });
        }
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: result.error.message });
      }

      return result.data;
    }),

  // --------------------------------------------------------------------------
  // READ OPERATIONS
  // --------------------------------------------------------------------------

  /**
   * Fetch a single dispute by ID.
   *
   * Both parties on the underlying task may view the dispute.
   * Callers outside the task (poster_id / worker_id) receive FORBIDDEN.
   */
  getById: protectedProcedure
    .input(z.object({
      disputeId: Schemas.uuid,
    }))
    .query(async ({ ctx, input }) => {
      const result = await DisputeService.getById(input.disputeId);

      if (!result.success) {
        throw new TRPCError({
          code: result.error.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }

      const dispute = result.data;
      const userId = ctx.user!.id;

      // Only poster or worker on this task may view the dispute.
      if (dispute.poster_id !== userId && dispute.worker_id !== userId) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'You are not a party to this dispute',
        });
      }

      return dispute;
    }),

  /**
   * Fetch all disputes attached to a specific task.
   *
   * Only the task's poster or worker may query this endpoint.
   */
  getByTask: protectedProcedure
    .input(z.object({
      taskId: Schemas.uuid,
    }))
    .query(async ({ ctx, input }) => {
      // Resolve the task first to enforce authorization.
      const taskResult = await TaskService.getById(input.taskId);
      if (!taskResult.success) {
        throw new TRPCError({
          code: taskResult.error.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'INTERNAL_SERVER_ERROR',
          message: taskResult.error.message,
        });
      }

      const task = taskResult.data;
      const userId = ctx.user!.id;

      if (task.poster_id !== userId && task.worker_id !== userId) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'You are not a party to this task',
        });
      }

      const result = await DisputeService.getByTaskId(input.taskId);
      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }

      return result.data;
    }),

  /**
   * Fetch all disputes for the current user (as poster or worker).
   */
  getMine: protectedProcedure
    .input(z.object({
      limit: z.number().int().min(1).max(100).default(50),
      offset: z.number().int().min(0).default(0),
    }).optional())
    .query(async ({ ctx, input }) => {
      const limit = input?.limit ?? 50;
      const offset = input?.offset ?? 0;
      const result = await DisputeService.getByUserId(ctx.user!.id, limit, offset);

      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }

      return result.data;
    }),
});

export type DisputeRouter = typeof disputeRouter;
