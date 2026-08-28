/**
 * Upload Router v2.0.0
 *
 * Quarantined presigned uploads plus server-side image finalization.
 * Used by web and native clients for proof and message photo uploads.
 *
 * Security: clients can write only to a short-lived quarantine key. The
 * finalize mutation decodes and pixel-re-encodes the stored bytes before a
 * task-bound receipt attestation is returned. Private object keys never cross
 * the client boundary.
 *
 * Uses @aws-sdk/s3-request-presigner for real R2 presigned URLs.
 * Falls back to mock URLs if R2 credentials are not configured.
 */

import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../trpc.js';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { db } from '../db.js';
import { randomUUID } from 'crypto';
import path from 'path';
import {
  finalizeMediaUpload,
  type MediaUploadPurpose,
} from '../services/MediaUploadFinalizationService.js';
import {
  MAX_MEDIA_UPLOAD_BYTES,
  SUPPORTED_SANITIZED_IMAGE_TYPES,
} from '../services/MediaSanitizationService.js';

const log = logger.child({ router: 'upload' });

// Allowed upload content types and size limits
const ALLOWED_CONTENT_TYPES = SUPPORTED_SANITIZED_IMAGE_TYPES;
const MAX_FILE_SIZE = MAX_MEDIA_UPLOAD_BYTES;
const PRESIGN_EXPIRY = 15 * 60; // 15 minutes

// Initialize S3 client for Cloudflare R2 (S3-compatible)
const r2Config = config.cloudflare.r2;
const isR2Configured = r2Config.endpoint && r2Config.accessKeyId && r2Config.secretAccessKey;

const s3Client = isR2Configured
  ? new S3Client({
      region: r2Config.region,
      endpoint: r2Config.endpoint,
      credentials: {
        accessKeyId: r2Config.accessKeyId,
        secretAccessKey: r2Config.secretAccessKey,
      },
    })
  : null;

interface TaskUploadAuthority {
  poster_id: string;
  worker_id: string | null;
}

async function assertUploadAuthority(
  taskId: string,
  userId: string,
  purpose: 'proof' | 'message'
): Promise<void> {
  const taskCheck = await db.query<TaskUploadAuthority>(
    'SELECT poster_id, worker_id FROM tasks WHERE id = $1',
    [taskId]
  );
  if (taskCheck.rows.length === 0) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' });
  }
  const { poster_id, worker_id } = taskCheck.rows[0];
  if (purpose === 'proof' && userId !== worker_id) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Only the assigned worker can upload completion proof.',
    });
  }
  if (purpose === 'message' && userId !== poster_id && userId !== worker_id) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Not authorized to upload files for this task',
    });
  }
}

function canonicalPurpose(purpose: 'proof' | 'message'): MediaUploadPurpose {
  return purpose === 'message' ? 'MESSAGE' : 'PROOF';
}

export const uploadRouter = router({
  /**
   * Get a presigned URL for uploading a file to R2
   * Validates content type, file size, and sanitizes filename
   */
  getPresignedUrl: protectedProcedure
    .input(
      z.object({
        taskId: z.string().uuid(),
        filename: z
          .string()
          .min(1)
          .max(255)
          .regex(/^[a-zA-Z0-9._-]+$/, 'Filename contains invalid characters'),
        contentType: z.enum(ALLOWED_CONTENT_TYPES, {
          errorMap: () => ({
            message: `Content type must be one of: ${ALLOWED_CONTENT_TYPES.join(', ')}`,
          }),
        }),
        fileSize: z
          .number()
          .min(1, 'File cannot be empty')
          .max(MAX_FILE_SIZE, `File size must be under ${MAX_FILE_SIZE / 1024 / 1024}MB`),
        purpose: z.enum(['proof', 'message']).optional().default('proof'),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertUploadAuthority(input.taskId, ctx.user.id, input.purpose);

      const receiptId = randomUUID();
      const ext = path
        .extname(input.filename)
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')
        .slice(0, 4);
      const key = `quarantine/${input.purpose}/${input.taskId}/${ctx.user.id}/${receiptId}${ext ? '.' + ext : ''}`;
      const expiresAt = new Date(Date.now() + PRESIGN_EXPIRY * 1000);
      const receiptExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

      // Generate real presigned URL if R2 is configured
      let uploadUrl: string;
      if (s3Client) {
        const command = new PutObjectCommand({
          Bucket: r2Config.bucketName,
          Key: key,
          ContentType: input.contentType,
          ContentLength: input.fileSize,
          Metadata: {
            'uploaded-by': ctx.user.id,
            'task-id': input.taskId,
            'receipt-id': receiptId,
            purpose: input.purpose,
          },
        });

        uploadUrl = await getSignedUrl(s3Client, command, {
          expiresIn: PRESIGN_EXPIRY,
        });
      } else {
        // Fallback remains non-authoritative: finalization still requires a real
        // quarantine object and therefore fails closed without R2.
        log.warn('R2 not configured, returning non-authoritative mock upload URL');
        uploadUrl = `https://r2-not-configured.invalid/upload/${key}?X-Amz-Signature=mock`;
      }

      await db.query(
        `INSERT INTO media_upload_receipts (
           id, task_id, uploader_id, purpose, quarantine_key,
           expected_content_type, expected_size_bytes, quarantine_expires_at, expires_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          receiptId,
          input.taskId,
          ctx.user.id,
          canonicalPurpose(input.purpose),
          key,
          input.contentType,
          input.fileSize,
          expiresAt,
          receiptExpiresAt,
        ]
      );

      return { uploadUrl, receiptId, expiresAt: expiresAt.toISOString() };
    }),

  finalizeImageUpload: protectedProcedure
    .input(
      z.object({
        taskId: z.string().uuid(),
        receiptId: z.string().uuid(),
        purpose: z.enum(['proof', 'message']).optional().default('proof'),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertUploadAuthority(input.taskId, ctx.user.id, input.purpose);
      return finalizeMediaUpload({
        receiptId: input.receiptId,
        taskId: input.taskId,
        uploaderId: ctx.user.id,
        purpose: canonicalPurpose(input.purpose),
      });
    }),
});
