/**
 * Task Router v1.0.0
 * 
 * CONSTITUTIONAL: Task lifecycle endpoints
 * 
 * @see PRODUCT_SPEC.md §3
 */

import { TRPCError } from '@trpc/server';
import { router, protectedProcedure, Schemas } from '../trpc';
import { TaskService } from '../services/TaskService';
import { ProofService } from '../services/ProofService';
import { z } from 'zod';

export const taskRouter = router({
  // --------------------------------------------------------------------------
  // READ OPERATIONS
  // --------------------------------------------------------------------------
  
  /**
   * Get task by ID
   */
  getById: protectedProcedure
    .input(z.object({ taskId: Schemas.uuid }))
    .query(async ({ input }) => {
      const result = await TaskService.getById(input.taskId);
      
      if (!result.success) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: result.error.message,
        });
      }
      
      return result.data;
    }),
  
  /**
   * Get server-authoritative task state
   * Used for state confirmation (UI_SPEC §9.1)
   */
  getState: protectedProcedure
    .input(z.object({ taskId: Schemas.uuid }))
    .query(async ({ input }) => {
      const result = await db.query<{ state: string }>(
        `SELECT state FROM tasks WHERE id = $1`,
        [input.taskId]
      );
      
      if (result.rows.length === 0) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Task not found',
        });
      }
      
      return {
        state: result.rows[0].state,
      };
    }),
  
  /**
   * List tasks by poster
   * SECURITY: Users can only list their own tasks
   */
  listByPoster: protectedProcedure
    .input(z.object({ posterId: Schemas.uuid }))
    .query(async ({ ctx, input }) => {
      // Authorization: users can only list their own posted tasks
      if (input.posterId !== ctx.user.id) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'You can only view your own posted tasks',
        });
      }

      const result = await TaskService.getByPoster(input.posterId);

      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }

      return result.data;
    }),

  /**
   * List tasks by worker
   * SECURITY: Users can only list their own accepted tasks
   */
  listByWorker: protectedProcedure
    .input(z.object({ workerId: Schemas.uuid }))
    .query(async ({ ctx, input }) => {
      // Authorization: users can only list their own worker tasks
      if (input.workerId !== ctx.user.id) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'You can only view your own accepted tasks',
        });
      }

      const result = await TaskService.getByWorker(input.workerId);

      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }

      return result.data;
    }),
  
  /**
   * List open tasks (feed)
   */
  listOpen: protectedProcedure
    .input(Schemas.pagination)
    .query(async ({ input }) => {
      const result = await TaskService.getOpenTasks(input.limit, input.offset);
      
      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      
      return result.data;
    }),
  
  // --------------------------------------------------------------------------
  // WRITE OPERATIONS
  // --------------------------------------------------------------------------
  
  /**
   * Create a new task
   */
  create: protectedProcedure
    .input(Schemas.createTask)
    .mutation(async ({ ctx, input }) => {
      const result = await TaskService.create({
        posterId: ctx.user.id,
        title: input.title,
        description: input.description,
        price: input.price,
        requirements: input.requirements,
        location: input.location,
        category: input.category,
        deadline: input.deadline ? new Date(input.deadline) : undefined,
        requiresProof: input.requiresProof,
        mode: input.mode,
        liveBroadcastRadiusMiles: input.liveBroadcastRadiusMiles,
        instantMode: input.instantMode,
      });
      
      if (!result.success) {
        // Map HX error codes to tRPC error codes
        let code: 'BAD_REQUEST' | 'PRECONDITION_FAILED' = 'BAD_REQUEST';
        if (result.error.code === 'HX902' || result.error.code === 'HX901') {
          code = 'PRECONDITION_FAILED';
        }
        throw new TRPCError({
          code,
          message: result.error.message,
        });
      }
      
      return result.data;
    }),
  
  /**
   * Accept a task (worker claims it)
   */
  accept: protectedProcedure
    .input(z.object({ taskId: Schemas.uuid }))
    .mutation(async ({ ctx, input }) => {
      const result = await TaskService.accept({
        taskId: input.taskId,
        workerId: ctx.user.id,
      });
      
      if (!result.success) {
        const code = result.error.code === 'HX002' ? 'PRECONDITION_FAILED' : 'BAD_REQUEST';
        throw new TRPCError({
          code,
          message: result.error.message,
        });
      }
      
      return result.data;
    }),
  
  /**
   * Submit proof for task
   */
  submitProof: protectedProcedure
    .input(Schemas.submitProof)
    .mutation(async ({ ctx, input }) => {
      // Create proof
      const proofResult = await ProofService.submit({
        taskId: input.taskId,
        submitterId: ctx.user.id,
        description: input.description,
      });
      
      if (!proofResult.success) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: proofResult.error.message,
        });
      }
      
      // Transition task to PROOF_SUBMITTED
      const taskResult = await TaskService.submitProof({
        taskId: input.taskId,
        proofId: proofResult.data.id,
      });
      
      if (!taskResult.success) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: taskResult.error.message,
        });
      }
      
      return {
        task: taskResult.data,
        proof: proofResult.data,
      };
    }),
  
  /**
   * Review proof (accept/reject)
   */
  reviewProof: protectedProcedure
    .input(Schemas.reviewProof)
    .mutation(async ({ ctx, input }) => {
      // Get proof to find task
      const proofResult = await ProofService.getById(input.proofId);
      if (!proofResult.success) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: proofResult.error.message,
        });
      }
      
      // Verify reviewer is the poster
      const taskResult = await TaskService.getById(proofResult.data.task_id);
      if (!taskResult.success) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Task not found',
        });
      }
      
      if (taskResult.data.poster_id !== ctx.user.id) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Only the task poster can review proof',
        });
      }
      
      // Review proof
      const reviewResult = await ProofService.review({
        proofId: input.proofId,
        reviewerId: ctx.user.id,
        decision: input.decision,
        reason: input.reason,
      });
      
      if (!reviewResult.success) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: reviewResult.error.message,
        });
      }
      
      return reviewResult.data;
    }),
  
  /**
   * Complete task (after proof accepted)
   * INV-3: Will fail if proof is not ACCEPTED
   * SECURITY: Only the poster can mark a task as complete
   */
  complete: protectedProcedure
    .input(z.object({ taskId: Schemas.uuid }))
    .mutation(async ({ ctx, input }) => {
      // Authorization: only the poster can complete a task
      const taskResult = await TaskService.getById(input.taskId);
      if (!taskResult.success) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' });
      }
      if (taskResult.data.poster_id !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the task poster can mark it complete' });
      }

      const result = await TaskService.complete(input.taskId);

      if (!result.success) {
        const code = result.error.code === 'HX301' ? 'PRECONDITION_FAILED' : 'BAD_REQUEST';
        throw new TRPCError({
          code,
          message: result.error.message,
        });
      }

      return result.data;
    }),
  
  /**
   * Cancel task
   */
  cancel: protectedProcedure
    .input(z.object({ 
      taskId: Schemas.uuid,
      reason: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      // Verify user is poster
      const taskResult = await TaskService.getById(input.taskId);
      if (!taskResult.success) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Task not found',
        });
      }
      
      if (taskResult.data.poster_id !== ctx.user.id) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Only the task poster can cancel',
        });
      }
      
      const result = await TaskService.cancel(input.taskId, input.reason);
      
      if (!result.success) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: result.error.message,
        });
      }
      
      return result.data;
    }),
});

export type TaskRouter = typeof taskRouter;
