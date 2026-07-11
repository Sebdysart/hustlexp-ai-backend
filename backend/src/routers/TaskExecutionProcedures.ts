import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { invalidateTask } from '../cache/db-cache.js';
import { db } from '../db.js';
import { notifyProofSubmitted } from '../lib/task-lifecycle-notifications.js';
import { logger } from '../logger.js';
import { ProofService } from '../services/ProofService.js';
import { TaskService } from '../services/TaskService.js';
import { hustlerProcedure, protectedProcedure, Schemas } from '../trpc.js';
import type { Proof } from '../types.js';
import { ErrorCodes } from '../types.js';
import { approvedProofMediaUrl } from './task-router-common.js';

const taskRouterLog = logger.child({ router: 'task' });

async function deleteOrphanProof(proofId: string): Promise<void> {
  try {
    await db.query('DELETE FROM proofs WHERE id = $1', [proofId]);
  } catch (error) {
    taskRouterLog.error(
      { err: error instanceof Error ? error.message : String(error), proofId },
      'R-10: failed to delete orphaned proof after task state transition failure',
    );
  }
}

async function attachProofVideos(proofId: string, urls: string[] | undefined): Promise<void> {
  for (const url of urls ?? []) {
    const result = await ProofService.addVideo({ proofId, storageKey: url, contentType: 'video/mp4' });
    if (!result.success) {
      taskRouterLog.warn({ proofId, url }, 'Failed to add video to proof');
    }
  }
}

async function notifyPosterOfProof(
  task: { poster_id?: string | null; title?: string | null },
  taskId: string,
): Promise<void> {
  if (task.poster_id) await notifyProofSubmitted(task.poster_id, taskId, task.title ?? 'your task');
}

export const TaskExecutionProcedures = {
start: hustlerProcedure
    .input(z.object({ taskId: Schemas.uuid }))
    .mutation(async ({ ctx, input }) => {
      const result = await TaskService.startWork(input.taskId, ctx.user.id);
      if (!result.success) {
        const code = result.error.code === ErrorCodes.NOT_FOUND
          ? 'NOT_FOUND'
          : result.error.code === ErrorCodes.FORBIDDEN
            ? 'FORBIDDEN'
            : 'PRECONDITION_FAILED';
        throw new TRPCError({ code, message: result.error.message });
      }

      await invalidateTask(input.taskId);
      return result.data;
    }),
getProof: protectedProcedure
    .input(z.object({ taskId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const result = await db.query<Proof>(
        `SELECT p.* FROM proofs p
         JOIN tasks t ON t.id = p.task_id
         WHERE p.task_id = $1
           AND (t.poster_id = $2 OR t.worker_id = $2)
         ORDER BY p.created_at DESC
         LIMIT 1`,
        [input.taskId, ctx.user.id]
      );

      if (result.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'No proof found for this task' });
      }

      const proof = result.rows[0];
      const [photosRes, videosRes] = await Promise.all([
        ProofService.getPhotos(proof.id),
        ProofService.getVideos(proof.id),
      ]);
      return {
        ...proof,
        photos: photosRes.success ? photosRes.data : [],
        videos: videosRes.success ? videosRes.data : [],
      };
    }),
submitProof: hustlerProcedure
    .input(z.object({
      taskId: z.string().uuid(),
      description: z.string().trim().max(2000).optional(),
      // Extended fields from iOS frontend
      photoUrls: z.array(approvedProofMediaUrl).max(10).optional(),
      videoUrls: z.array(approvedProofMediaUrl).max(5).optional(),
      notes: z.string().trim().max(2000).optional(),
      gpsLatitude: z.number().min(-90).max(90).optional(),
      gpsLongitude: z.number().min(-180).max(180).optional(),
      biometricHash: z.string().max(256).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      // KK4 FIX: Router-layer ownership check. ProofService has its own check
      // but verifying here at the router boundary avoids hitting ProofService
      // at all for non-assigned workers, and makes the authorization boundary
      // explicit at the procedure layer.
      const taskOwnership = await db.query<{ worker_id: string | null }>(
        'SELECT worker_id FROM tasks WHERE id = $1',
        [input.taskId]
      );
      if (!taskOwnership.rows[0] || taskOwnership.rows[0].worker_id !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the assigned worker can submit proof' });
      }

      // YY-02 FIX: The previous implementation issued raw db.query('BEGIN') /
      // db.query('COMMIT') / db.query('ROLLBACK') from the pool. Because pg-pool
      // dispatches each query() call to whatever connection is currently idle,
      // these control statements could land on a different pool connection than
      // the queries inside ProofService.submit() and TaskService.submitProof(),
      // making the outer "transaction" completely illusory.
      //
      // Both services already manage their own internal db.transaction() calls
      // (ProofService.submit via UU-05, TaskService.submitProof via the existing
      // FOR UPDATE transaction). The idempotency recovery path in
      // TaskService.submitProof() (PROOF_SUBMITTED → return success) handles the
      // case where ProofService.submit committed but the task state update did not.
      // Removing the outer raw BEGIN/COMMIT restores the intended semantics: each
      // service operates on its own pinned connection inside its own transaction.
      const proofResult = await ProofService.submit({
        taskId: input.taskId,
        submitterId: ctx.user.id,
        description: input.description ?? input.notes,
        photoUrls: input.photoUrls,
        gpsLatitude: input.gpsLatitude,
        gpsLongitude: input.gpsLongitude,
        biometricHash: input.biometricHash,
      });

      if (!proofResult.success) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: proofResult.error.message,
        });
      }

      // R-10 FIX: ProofService.submit and TaskService.submitProof each own their
      // internal transactions and cannot be composed into a single atomic unit
      // without invasive refactoring. Instead, if the task state transition fails
      // after the proof row has already committed, delete the orphaned proof row
      // before rethrowing so the worker can retry cleanly.
      const taskResult = await TaskService.submitProof(input.taskId);

      if (!taskResult.success) {
        // Best-effort cleanup: remove the committed proof row so it does not
        // permanently block future submission attempts (ProofService.submit
        // rejects if an active proof already exists for the task).
        await deleteOrphanProof(proofResult.data.id);
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: taskResult.error.message,
        });
      }

      // Video attachments are best-effort: run after commit so a video failure
      // does not roll back the proof or the task state transition.
      await attachProofVideos(proofResult.data.id, input.videoUrls);

      await invalidateTask(input.taskId);

      // Lifecycle notification (post-commit): tell the poster to review
      const provenTask = taskResult.data as { poster_id?: string | null; title?: string | null };
      await notifyPosterOfProof(provenTask, input.taskId);

      return {
        task: taskResult.data,
        proof: proofResult.data,
      };
    })
};
