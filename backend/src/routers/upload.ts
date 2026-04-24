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
import { router, protectedProcedure } from '../trpc.js';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config.js';
import { logger } from '../logger.js';

const log = logger.child({ router: 'upload' });

// Allowed upload content types and size limits
const ALLOWED_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'] as const;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const PRESIGN_EXPIRY = 15 * 60; // 15 minutes

// Initialize S3 client — supports Cloudflare R2, Tigris (Fly.io), or any S3-compatible provider.
// Priority: S3_ENDPOINT env var > Cloudflare R2 derived endpoint
const r2Config = config.cloudflare.r2;
const s3Endpoint = process.env.S3_ENDPOINT
  || (r2Config.accountId ? `https://${r2Config.accountId}.r2.cloudflarestorage.com` : '');
const s3AccessKey = process.env.AWS_ACCESS_KEY_ID || r2Config.accessKeyId;
const s3SecretKey = process.env.AWS_SECRET_ACCESS_KEY || r2Config.secretAccessKey;
const s3BucketName = process.env.BUCKET_NAME || r2Config.bucketName || 'hustlexp-storage';
const isS3Configured = s3Endpoint && s3AccessKey && s3SecretKey;

const s3Client = isS3Configured
  ? new S3Client({
      region: process.env.AWS_REGION || 'auto',
      endpoint: s3Endpoint,
      credentials: {
        accessKeyId: s3AccessKey,
        secretAccessKey: s3SecretKey,
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
      taskId: z.string().uuid().optional(),
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
      purpose: z.enum(['proof', 'message', 'avatar']).optional().default('proof'),
    }))
    .mutation(async ({ ctx, input }) => {
      let prefix: string;
      if (input.purpose === 'message') prefix = 'messages';
      else if (input.purpose === 'avatar') prefix = 'avatars';
      else prefix = 'proofs';
      const key = input.purpose === 'avatar'
        ? `avatars/${ctx.user.id}/${Date.now()}_${input.filename}`
        : `${prefix}/${input.taskId}/${ctx.user.id}/${Date.now()}_${input.filename}`;
      const baseUrl = process.env.R2_PUBLIC_URL || `https://${s3BucketName}.r2.dev`;

      // Generate real presigned URL if S3/R2/Tigris is configured
      if (s3Client) {
        const command = new PutObjectCommand({
          Bucket: s3BucketName,
          Key: key,
          ContentType: input.contentType,
          ContentLength: input.fileSize,
          Metadata: {
            'uploaded-by': ctx.user.id,
            ...(input.taskId ? { 'task-id': input.taskId } : {}),
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
      log.warn('S3/R2/Tigris not configured, returning mock presigned URL');
      return {
        uploadUrl: `${baseUrl}/upload/${key}?X-Amz-Signature=mock`,
        publicUrl: `${baseUrl}/${key}`,
        key,
        expiresAt: new Date(Date.now() + PRESIGN_EXPIRY * 1000).toISOString(),
      };
    }),
});
