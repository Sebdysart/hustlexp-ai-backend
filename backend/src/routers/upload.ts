/**
 * Upload Router v1.0.0
 *
 * Presigned URL generation for Cloudflare R2 photo uploads.
 * Used by iOS ProofService for proof photo uploads.
 *
 * In production, this generates real R2 presigned URLs.
 * Currently returns mock URLs for development.
 */

import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';

export const uploadRouter = router({
  /**
   * Get a presigned URL for uploading a file to R2
   */
  getPresignedUrl: protectedProcedure
    .input(z.object({
      taskId: z.string().uuid(),
      filename: z.string().min(1).max(255),
      contentType: z.string().default('image/jpeg'),
    }))
    .mutation(async ({ ctx, input }) => {
      const key = `proofs/${input.taskId}/${ctx.user.id}/${Date.now()}_${input.filename}`;

      // TODO: In production, generate real R2 presigned URL via @aws-sdk/s3-request-presigner
      // For now, return mock URLs for development
      const baseUrl = process.env.R2_PUBLIC_URL || 'https://r2.hustlexp.com';

      return {
        uploadUrl: `${baseUrl}/upload/${key}?X-Amz-Signature=mock`,
        publicUrl: `${baseUrl}/${key}`,
        key,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(), // 15 min
      };
    }),
});
