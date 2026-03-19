/**
 * Upload Router v2.0.0
 *
 * Presigned URL generation for Cloudflare R2 photo uploads.
 * Used by iOS for proof and message photo uploads.
 *
 * Security: validates content type, file size, and sanitizes filenames.
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

const log = logger.child({ router: 'upload' });

// Allowed upload content types and size limits
const ALLOWED_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'] as const;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const PRESIGN_EXPIRY = 15 * 60; // 15 minutes

// Initialize S3 client for Cloudflare R2 (S3-compatible)
const r2Config = config.cloudflare.r2;
const isR2Configured = r2Config.accountId && r2Config.accessKeyId && r2Config.secretAccessKey;

const s3Client = isR2Configured
  ? new S3Client({
      region: 'auto',
      endpoint: `https://${r2Config.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: r2Config.accessKeyId,
        secretAccessKey: r2Config.secretAccessKey,
      },
    })
  : null;

export const uploadRouter = router({
  /**
   * Get a presigned URL for uploading a file to R2
   * Validates content type, file size, and sanitizes filename
   */
  getPresignedUrl: protectedProcedure
    .input(z.object({
      taskId: z.string().uuid(),
      filename: z.string()
        .min(1)
        .max(255)
        .regex(/^[a-zA-Z0-9._-]+$/, 'Filename contains invalid characters'),
      contentType: z.enum(ALLOWED_CONTENT_TYPES, {
        errorMap: () => ({ message: `Content type must be one of: ${ALLOWED_CONTENT_TYPES.join(', ')}` }),
      }),
      fileSize: z.number()
        .min(1, 'File cannot be empty')
        .max(MAX_FILE_SIZE, `File size must be under ${MAX_FILE_SIZE / 1024 / 1024}MB`),
      purpose: z.enum(['proof', 'message']).optional().default('proof'),
    }))
    .mutation(async ({ ctx, input }) => {
      // IDOR fix: verify caller is a participant (poster or worker) of the task
      const taskCheck = await db.query<{ poster_id: string; worker_id: string | null }>(
        'SELECT poster_id, worker_id FROM tasks WHERE id = $1',
        [input.taskId],
      );
      if (taskCheck.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' });
      }
      const { poster_id, worker_id } = taskCheck.rows[0];
      if (ctx.user.id !== poster_id && ctx.user.id !== worker_id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Not authorized to upload files for this task' });
      }

      const prefix = input.purpose === 'message' ? 'messages' : 'proofs';
      const key = `${prefix}/${input.taskId}/${ctx.user.id}/${Date.now()}_${input.filename}`;
      const baseUrl = process.env.R2_PUBLIC_URL || `https://${r2Config.bucketName}.r2.dev`;

      // Generate real presigned URL if R2 is configured
      if (s3Client) {
        const command = new PutObjectCommand({
          Bucket: r2Config.bucketName,
          Key: key,
          ContentType: input.contentType,
          ContentLength: input.fileSize,
          Metadata: {
            'uploaded-by': ctx.user.id,
            'task-id': input.taskId,
          },
        });

        const uploadUrl = await getSignedUrl(s3Client, command, {
          expiresIn: PRESIGN_EXPIRY,
        });

        return {
          uploadUrl,
          publicUrl: `${baseUrl}/${key}`,
          key,
          expiresAt: new Date(Date.now() + PRESIGN_EXPIRY * 1000).toISOString(),
        };
      }

      // Fallback: mock URLs for local development
      log.warn('R2 not configured, returning mock presigned URL');
      return {
        uploadUrl: `${baseUrl}/upload/${key}?X-Amz-Signature=mock`,
        publicUrl: `${baseUrl}/${key}`,
        key,
        expiresAt: new Date(Date.now() + PRESIGN_EXPIRY * 1000).toISOString(),
      };
    }),
});
