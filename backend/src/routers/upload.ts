/**
 * Upload Router v2.0.0
 *
 * Presigned URL generation for Cloudflare R2 photo uploads.
 * Used by iOS ProofService for proof photo uploads.
 *
 * Security: validates content type, file size, and sanitizes filenames.
 *
 * Uses @aws-sdk/s3-request-presigner for real R2 presigned URLs.
 * Falls back to mock URLs if R2 credentials are not configured.
 */

import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config';
import { logger } from '../logger';

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
        .max(MAX_FILE_SIZE, `File size must be under ${MAX_FILE_SIZE / 1024 / 1024}MB`)
        .optional(), // Optional for backward compat with iOS client
    }))
    .mutation(async ({ ctx, input }) => {
      const key = `proofs/${input.taskId}/${ctx.user.id}/${Date.now()}_${input.filename}`;
      const baseUrl = process.env.R2_PUBLIC_URL || `https://${r2Config.bucketName}.r2.dev`;

      // Generate real presigned URL if R2 is configured
      if (s3Client) {
        const command = new PutObjectCommand({
          Bucket: r2Config.bucketName,
          Key: key,
          ContentType: input.contentType,
          ...(input.fileSize ? { ContentLength: input.fileSize } : {}),
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
