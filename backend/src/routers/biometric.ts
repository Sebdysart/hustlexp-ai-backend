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
import { router, hustlerProcedure, Schemas } from '../trpc.js';
import { db } from '../db.js';
import { BiometricVerificationService } from '../services/BiometricVerificationService.js';
import { LogisticsAIService } from '../services/LogisticsAIService.js';
import { GDPRService } from '../services/GDPRService.js';
import { z } from 'zod';
import { issueSingleParticipantMediaAccess } from '../services/PrivateMediaDeliveryService.js';

interface BiometricProofContext {
  worker_id: string | null;
  submitter_id: string;
  biometric_signal_status: string;
  photo_url: string | null;
  lidar_depth_map_url: string | null;
  gps_coordinates: { latitude: number; longitude: number } | string | null;
  gps_accuracy_meters: number | string | null;
  location_lat: number | string | null;
  location_lng: number | string | null;
}

function storedCoordinates(
  value: BiometricProofContext['gps_coordinates'],
): { latitude: number; longitude: number } | null {
  if (value == null) return null;
  const parsed = typeof value === 'string' ? JSON.parse(value) as Record<string, unknown> : value;
  const latitude = Number(parsed.latitude);
  const longitude = Number(parsed.longitude);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90
      || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) return null;
  return { latitude, longitude };
}

export const biometricRouter = router({
  // --------------------------------------------------------------------------
  // WRITE OPERATIONS
  // --------------------------------------------------------------------------

  /**
   * Submit biometric proof for validation
   * Runs liveness, deepfake, GPS, and time-lock checks
   */
  submitBiometricProof: hustlerProcedure
    .input(
      z.object({
        proof_id: Schemas.uuid,
        task_id: Schemas.uuid,
        // Rolling-upgrade compatibility claims only. The mutation ignores
        // these URLs and consumes receipt-backed stored proof media below.
        photo_url: z.string().url().optional(),
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
        // Bind every claimed identifier to one canonical, durable proof record.
        // Client media, GPS, and task coordinates are compatibility fields only;
        // verification consumes stored evidence and server task coordinates.
        const contextResult = await db.query<BiometricProofContext>(
          `SELECT t.worker_id,p.submitter_id,
                  ps.biometric_signal_status,
                  pp.storage_key AS photo_url,
                  NULL::TEXT AS lidar_depth_map_url,
                  ps.gps_coordinates,ps.gps_accuracy_meters,
                  t.location_lat,t.location_lng
           FROM tasks t
           JOIN proofs p ON p.task_id=t.id AND p.id=$1
           JOIN LATERAL (
             SELECT id,gps_coordinates,gps_accuracy_meters,
                    biometric_signal_status
             FROM proof_submissions
             WHERE proof_id=p.id
             ORDER BY created_at DESC,id DESC
             LIMIT 1
           ) ps ON TRUE
           LEFT JOIN LATERAL (
             SELECT storage_key
             FROM proof_photos
             WHERE proof_id=p.id
             ORDER BY sequence_number ASC,created_at ASC,id ASC
             LIMIT 1
           ) pp ON TRUE
           WHERE t.id=$2`,
          [input.proof_id, input.task_id]
        );
        const proofContext = contextResult.rows[0];
        if (!proofContext) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Proof verification record not found' });
        }
        if (proofContext.worker_id !== ctx.user.id || proofContext.submitter_id !== ctx.user.id) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Not the assigned worker for this task' });
        }
        if (['PENDING', 'AVAILABLE'].includes(proofContext.biometric_signal_status)) {
          throw new TRPCError({ code: 'CONFLICT', message: 'Biometric proof already submitted for this task' });
        }
        if (!proofContext.photo_url) {
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Durable proof photo evidence is required' });
        }
        if (/^https?:\/\//i.test(proofContext.photo_url)) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'Legacy public proof media cannot be used for biometric verification.',
          });
        }
        const proofCoordinates = storedCoordinates(proofContext.gps_coordinates);
        const accuracyMeters = Number(proofContext.gps_accuracy_meters);
        if (!proofCoordinates || !Number.isFinite(accuracyMeters) || accuracyMeters < 0) {
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Durable proof GPS evidence is required' });
        }
        const taskLatitude = Number(proofContext.location_lat);
        const taskLongitude = Number(proofContext.location_lng);
        if (!Number.isFinite(taskLatitude) || !Number.isFinite(taskLongitude)) {
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Canonical task coordinates are unavailable' });
        }

        // BIPA compliance: verify biometric data consent before collection
        const hasConsent = await GDPRService.hasBiometricConsent(ctx.user.id);
        if (!hasConsent) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'BIPA_CONSENT_REQUIRED: Biometric data consent required before collection (740 ILCS 14)',
          });
        }

        // Run biometric verification
        const privatePhoto = await issueSingleParticipantMediaAccess({
          taskId: input.task_id,
          viewerId: ctx.user.id,
          purpose: 'PROOF',
          accessReason: 'BIOMETRIC_ANALYSIS',
          consumerId: input.proof_id,
          storageKey: proofContext.photo_url,
        });
        if (!privatePhoto) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'Private proof media is unavailable. Biometric verification was not run.',
          });
        }
        const biometricResult = await BiometricVerificationService.analyzeProofSubmission(
          input.proof_id,
          privatePhoto.downloadUrl,
          undefined,
        );

        if (!biometricResult.success) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: biometricResult.error?.message || 'Biometric verification failed'
          });
        }

        // Run GPS validation
        const gpsResult = await LogisticsAIService.validateGPSProof(
          proofCoordinates,
          { latitude: taskLatitude, longitude: taskLongitude },
          accuracyMeters
        );

        if (!gpsResult.success) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: gpsResult.error?.message || 'GPS validation failed'
          });
        }

        // Run impossible travel check (if user has prior location)
        // Fetch last known GPS location from proof_submissions or impossible_travel_log
        const lastLocationResult = await db.query<{
          latitude: number;
          longitude: number;
          timestamp: string;
        }>(
          `SELECT latitude, longitude, logged_at::text as timestamp
           FROM impossible_travel_log
           WHERE user_id = $1
           ORDER BY logged_at DESC
           LIMIT 1`,
          [ctx.user.id]
        );
        const lastKnownLocation = lastLocationResult.rows.length > 0
          ? lastLocationResult.rows[0]
          : undefined;

        const impossibleTravelResult = await LogisticsAIService.detectImpossibleTravel(
          ctx.user.id,
          { ...input.gps_coordinates, timestamp: input.gps_timestamp },
          lastKnownLocation
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
  analyzeFacePhoto: hustlerProcedure
    .input(
      z.object({
        photo_url: z.string()
      })
    )
    .mutation(async () => {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Direct face-photo analysis is disabled. Identity verification must use a private provider-attested flow.',
      });
    }),

  // --------------------------------------------------------------------------
  // AWS REKOGNITION FACE LIVENESS (iBeta Level 2, ~$0.015/check)
  // --------------------------------------------------------------------------

  /**
   * Create a Face Liveness session
   *
   * Returns sessionId for the iOS FaceLivenessDetector (AWS Amplify SDK).
   * Client calls this first, runs the liveness challenge, then calls getLivenessResult.
   */
  createLivenessSession: hustlerProcedure
    .input(z.void())
    .mutation(async () => {
      const result = await BiometricVerificationService.createLivenessSession();

      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error?.message || 'Failed to create liveness session',
        });
      }

      return result.data;
    }),

  /**
   * Get Face Liveness session result
   *
   * Called after the iOS client finishes the FaceLivenessDetector challenge.
   * Returns confidence score (0-100).
   */
  getLivenessResult: hustlerProcedure
    .input(z.object({
      sessionId: z.string().min(1),
    }))
    .query(async ({ input }) => {
      const result = await BiometricVerificationService.getLivenessSessionResult(input.sessionId);

      if (!result.success) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: result.error?.message || 'Failed to get liveness result',
        });
      }

      return result.data;
    }),
});
