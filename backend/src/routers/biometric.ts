/**
 * Biometric Router v1.0.0
 *
 * Biometric verification for proof submissions
 *
 * Validates: GPS proximity, liveness score, deepfake score, time-lock hash
 * Calls: BiometricVerificationService, LogisticsAIService
 *
 * @see schema.sql v1.8.0 (proof_submissions biometric fields)
 * @see BiometricVerificationService.ts, LogisticsAIService.ts
 */

import { TRPCError } from '@trpc/server';
import { router, protectedProcedure, Schemas } from '../trpc';
import { BiometricVerificationService } from '../services/BiometricVerificationService';
import { LogisticsAIService } from '../services/LogisticsAIService';
import { z } from 'zod';

export const biometricRouter = router({
  // --------------------------------------------------------------------------
  // WRITE OPERATIONS
  // --------------------------------------------------------------------------

  /**
   * Submit biometric proof for validation
   * Runs liveness, deepfake, GPS, and time-lock checks
   */
  submitBiometricProof: protectedProcedure
    .input(
      z.object({
        proof_id: Schemas.uuid,
        task_id: Schemas.uuid,
        photo_url: z.string().url(),
        gps_coordinates: z.object({
          latitude: z.number().min(-90).max(90),
          longitude: z.number().min(-180).max(180)
        }),
        gps_accuracy_meters: z.number().min(0).max(10000),
        gps_timestamp: z.string().datetime(),
        task_location: z.object({
          latitude: z.number().min(-90).max(90),
          longitude: z.number().min(-180).max(180)
        }),
        lidar_depth_map_url: z.string().url().optional(),
        time_lock_hash: z.string().min(1),
        submission_timestamp: z.string().datetime()
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        // Run biometric verification
        const biometricResult = await BiometricVerificationService.analyzeProofSubmission(
          input.proof_id,
          input.photo_url,
          input.lidar_depth_map_url
        );

        if (!biometricResult.success) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: biometricResult.error?.message || 'Biometric verification failed'
          });
        }

        // Run GPS validation
        const gpsResult = await LogisticsAIService.validateGPSProof(
          input.gps_coordinates,
          input.task_location,
          input.gps_accuracy_meters
        );

        if (!gpsResult.success) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: gpsResult.error?.message || 'GPS validation failed'
          });
        }

        // Run impossible travel check (if user has prior location)
        // TODO: Get last known location from database
        const impossibleTravelResult = await LogisticsAIService.detectImpossibleTravel(
          ctx.user.id,
          { ...input.gps_coordinates, timestamp: input.gps_timestamp }
        );

        if (!impossibleTravelResult.success) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: impossibleTravelResult.error?.message || 'Impossible travel check failed'
          });
        }

        // Validate time-lock
        const timeLockResult = LogisticsAIService.validateTimeLock(
          input.time_lock_hash,
          input.submission_timestamp,
          input.gps_timestamp
        );

        // Combine results
        const biometric = biometricResult.data!;
        const gps = gpsResult.data!;
        const travel = impossibleTravelResult.data!;

        // Determine overall recommendation
        let recommendation: 'approve' | 'manual_review' | 'reject' = 'approve';
        const flags: string[] = [];

        if (biometric.recommendation === 'reject' || gps.risk_level === 'HIGH' || travel.flagged) {
          recommendation = 'reject';
        } else if (
          biometric.recommendation === 'manual_review' ||
          gps.risk_level === 'MEDIUM' ||
          !timeLockResult.passed
        ) {
          recommendation = 'manual_review';
        }

        if (biometric.flags.length > 0) {
          flags.push(...biometric.flags);
        }
        if (!gps.passed) {
          flags.push('gps_out_of_range');
        }
        if (travel.flagged) {
          flags.push('impossible_travel');
        }
        if (!timeLockResult.passed) {
          flags.push('time_lock_failed');
        }

        return {
          success: true,
          recommendation,
          flags,
          biometric_scores: biometric.scores,
          gps_validation: {
            passed: gps.passed,
            distance_meters: gps.distance_meters,
            risk_level: gps.risk_level
          },
          impossible_travel: {
            flagged: travel.flagged,
            speed_kmh: travel.speed_kmh
          },
          time_lock: {
            passed: timeLockResult.passed,
            time_delta_seconds: timeLockResult.time_delta_seconds
          },
          reasoning: biometric.reasoning
        };
      } catch (error) {
        if (error instanceof TRPCError) {
          throw error;
        }

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: error instanceof Error ? error.message : 'Biometric validation failed'
        });
      }
    }),

  /**
   * Analyze face photo only (no GPS validation)
   * Used for profile photo verification
   */
  analyzeFacePhoto: protectedProcedure
    .input(
      z.object({
        photo_url: z.string().url()
      })
    )
    .mutation(async ({ input }) => {
      const result = await BiometricVerificationService.analyzeFacePhoto(input.photo_url);

      if (!result.success) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: result.error?.message || 'Face analysis failed'
        });
      }

      return result.data;
    })
});
