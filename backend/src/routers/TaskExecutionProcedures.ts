import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { invalidateTask } from '../cache/db-cache.js';
import { db } from '../db.js';
import { notifyProofSubmitted } from '../lib/task-lifecycle-notifications.js';
import { ProofService } from '../services/ProofService.js';
import { projectProofPhotosForViewer } from '../services/PrivateMediaDeliveryService.js';
import { TaskService } from '../services/TaskService.js';
import { hustlerProcedure, protectedProcedure, Schemas } from '../trpc.js';
import type { Proof, Task } from '../types.js';
import { ErrorCodes } from '../types.js';
import { approvedProofMediaUrl } from './task-router-common.js';

const proofPhotoEvidence = z.object({
  uploadReceiptId: z.string().uuid(),
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  fileSizeBytes: z.number().int().positive().max(10 * 1024 * 1024),
  checksumSha256: z.string().regex(/^[a-f0-9]{64}$/i),
  capturedAt: z.string().datetime().optional(),
}).strict();

async function notifyPosterOfProof(
  task: { poster_id?: string | null; title?: string | null },
  taskId: string,
): Promise<void> {
  if (task.poster_id) await notifyProofSubmitted(task.poster_id, taskId, task.title ?? 'your task');
}

export const TaskExecutionProcedures = {
markTraveling: hustlerProcedure
    .input(z.object({ taskId: Schemas.uuid }))
    .mutation(async ({ ctx, input }) => {
      const result = await TaskService.advanceProgress({
        taskId: input.taskId,
        to: 'TRAVELING',
        actor: { type: 'worker', userId: ctx.user.id },
      });
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
      const photos = photosRes.success
        ? await projectProofPhotosForViewer({
          taskId: input.taskId,
          proofId: proof.id,
          viewerId: ctx.user.id,
          photos: photosRes.data,
        })
        : [];
      return {
        ...proof,
        photos,
        // Receipt-backed private video delivery is intentionally not enabled
        // yet. Preserve non-sensitive metadata without exposing storage keys.
        videos: videosRes.success ? videosRes.data.map((video) => ({
          id: video.id,
          proof_id: video.proof_id,
          content_type: video.content_type,
          file_size_bytes: video.file_size_bytes,
          duration_seconds: video.duration_seconds,
          sequence_number: video.sequence_number,
          created_at: video.created_at,
          download_url: null,
          download_expires_at: null,
          delivery_status: 'UNAVAILABLE' as const,
        })) : [],
      };
    }),
submitProof: hustlerProcedure
    .input(z.object({
      taskId: z.string().uuid(),
      description: z.string().trim().max(2000).optional(),
      // Extended fields from iOS frontend
      // URL-only photos are retained only to return an explicit migration error
      // from ProofService; new clients must send photoEvidence.
      photoUrls: z.array(approvedProofMediaUrl).max(10).optional(),
      photoEvidence: z.array(proofPhotoEvidence).max(10).optional(),
      // Retained only to fail closed for older native clients. Video evidence
      // must not be accepted until it has receipt-backed finalization parity
      // with proof photos.
      videoUrls: z.array(approvedProofMediaUrl)
        .max(0, 'Video proof requires receipt-backed upload finalization.')
        .optional(),
      notes: z.string().trim().max(2000).optional(),
      gpsLatitude: z.number().min(-90).max(90).optional(),
      gpsLongitude: z.number().min(-180).max(180).optional(),
      gpsAccuracyMeters: z.number().min(0).max(10_000).optional(),
      biometricHash: z.string().max(256).optional(),
      scopeVersionId: z.string().uuid().optional(),
      scopeHash: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
      // Optional only for backwards compatibility with older native clients;
      // current web clients always send this durable retry witness.
      clientSubmissionId: z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9:_-]+$/).optional(),
      clientSequence: z.number().int().positive().optional(),
      priorTaskVersion: z.number().int().positive().optional(),
      localOccurredAt: z.string().datetime().optional(),
      deviceVersion: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9._:-]+$/).optional(),
      appVersion: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9._:-]+$/).optional(),
      offlinePayloadHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    }).superRefine((value, context) => {
      const syncValues = [
        value.clientSequence,
        value.priorTaskVersion,
        value.localOccurredAt,
        value.deviceVersion,
        value.appVersion,
      ];
      const supplied = syncValues.filter((item) => item !== undefined).length;
      if (supplied !== 0 && supplied !== syncValues.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['clientSequence'],
          message: 'Offline sync evidence must be supplied as one complete tuple.',
        });
      }
      if (supplied === syncValues.length && !value.clientSubmissionId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['clientSubmissionId'],
          message: 'Offline sync evidence requires a durable client submission identity.',
        });
      }
      if (value.offlinePayloadHash !== undefined && supplied !== syncValues.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['offlinePayloadHash'],
          message: 'Offline payload evidence requires the complete sync tuple.',
        });
      }
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

      const { proofResult, taskResult } = await db.transaction(async (query) => {
        const proofResult = await ProofService.submit({
          taskId: input.taskId,
          submitterId: ctx.user.id,
          description: input.description ?? input.notes,
          photoUrls: input.photoUrls,
          photoEvidence: input.photoEvidence,
          gpsLatitude: input.gpsLatitude,
          gpsLongitude: input.gpsLongitude,
          gpsAccuracyMeters: input.gpsAccuracyMeters,
          biometricHash: input.biometricHash,
          scopeVersionId: input.scopeVersionId,
          scopeHash: input.scopeHash?.toLowerCase(),
          clientSubmissionId: input.clientSubmissionId,
          clientSequence: input.clientSequence,
          priorTaskVersion: input.priorTaskVersion,
          localOccurredAt: input.localOccurredAt,
          deviceVersion: input.deviceVersion,
          appVersion: input.appVersion,
          offlinePayloadHash: input.offlinePayloadHash,
        }, query);
        if (!proofResult.success) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: proofResult.error.message });
        }
        const taskResult = proofResult.data.idempotency_replayed
          ? await (async () => {
            const current = await query<Task>(
              'SELECT * FROM tasks WHERE id=$1',
              [input.taskId],
            );
            return current.rows[0]
              ? { success: true as const, data: current.rows[0] }
              : { success: false as const, error: { code: 'NOT_FOUND', message: 'Task not found' } };
          })()
          : await TaskService.submitProof(input.taskId, query);
        if (!taskResult.success) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: taskResult.error.message });
        }
        return { proofResult, taskResult };
      });

      await invalidateTask(input.taskId);

      // Lifecycle notification (post-commit): tell the poster to review
      if (!proofResult.data.idempotency_replayed) {
        const provenTask = taskResult.data as { poster_id?: string | null; title?: string | null };
        await notifyPosterOfProof(provenTask, input.taskId);
      }

      return {
        task: taskResult.data,
        proof: proofResult.data,
      };
    })
};
