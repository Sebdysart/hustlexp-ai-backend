/**
 * PhotoVerificationService v1.1.0
 *
 * Time-locked camera metadata validation. Provider-backed photo comparison is
 * deliberately absent until a versioned proof/media identity contract exists.
 * The legacy signature returns a deterministic manual-review result and has no
 * provider import, URL, credential, or latent spend path.
 */

import { db } from '../db.js';
import type { ServiceResult } from '../types.js';

interface PhotoMetadata {
  capture_source: 'live_camera' | 'gallery' | 'unknown';
  exif_timestamp: Date | null;
  exif_gps_lat: number | null;
  exif_gps_lng: number | null;
  exif_device_model: string | null;
}

interface CaptureValidationResult {
  passed: boolean;
  failures: string[];
  warnings: string[];
}

interface BeforeAfterComparisonResult {
  similarity_score: number;
  completion_score: number;
  change_detected: boolean;
  ai_assessment: string;
  confidence: number;
  recommendation: 'approve' | 'manual_review' | 'reject';
}

const MAX_CAPTURE_AGE_MINUTES = 5;
const MAX_GPS_DISTANCE_METERS = 500;

const DORMANT_COMPARISON: BeforeAfterComparisonResult = Object.freeze({
  similarity_score: 0.5,
  completion_score: 0.5,
  change_detected: true,
  ai_assessment: 'AI verification dormant — manual review required',
  confidence: 0.0,
  recommendation: 'manual_review',
});

export const PhotoVerificationService = {
  /** Validate capture freshness/proximity and persist only derived signals. */
  validateCapture: async (
    proofId: string,
    metadata: PhotoMetadata,
    taskLocation?: { lat: number; lng: number },
  ): Promise<ServiceResult<CaptureValidationResult>> => {
    const failures: string[] = [];
    const warnings: string[] = [];

    if (metadata.capture_source === 'gallery') {
      failures.push('GALLERY_UPLOAD_REJECTED: Photo must be taken live within the app');
    }
    if (metadata.capture_source === 'unknown') {
      warnings.push('CAPTURE_SOURCE_UNKNOWN: Could not determine if photo was taken live');
    }

    if (metadata.exif_timestamp) {
      const ageMinutes = (Date.now() - new Date(metadata.exif_timestamp).getTime()) / 60000;
      if (ageMinutes > MAX_CAPTURE_AGE_MINUTES) {
        failures.push(
          `STALE_PHOTO: Photo is ${Math.round(ageMinutes)} minutes old (max ${MAX_CAPTURE_AGE_MINUTES})`,
        );
      }
      if (ageMinutes < 0) {
        failures.push('FUTURE_TIMESTAMP: Photo timestamp is in the future — possible manipulation');
      }
    } else {
      warnings.push('NO_EXIF_TIMESTAMP: Could not verify when photo was taken');
    }

    if (metadata.exif_gps_lat && metadata.exif_gps_lng && taskLocation) {
      const distance = haversineDistance(
        metadata.exif_gps_lat,
        metadata.exif_gps_lng,
        taskLocation.lat,
        taskLocation.lng,
      );
      if (distance > MAX_GPS_DISTANCE_METERS) {
        failures.push(
          `GPS_MISMATCH: Photo taken ${Math.round(distance)}m from task location (max ${MAX_GPS_DISTANCE_METERS}m)`,
        );
      }
    } else if (!metadata.exif_gps_lat && taskLocation) {
      warnings.push('NO_GPS_DATA: Could not verify photo location');
    }

    const passed = failures.length === 0;
    const persisted = await db.query(
      `WITH target AS (
         SELECT id FROM proof_submissions
         WHERE proof_id = $4
         ORDER BY created_at DESC, id DESC
         LIMIT 1
       )
       UPDATE proof_submissions ps
       SET capture_source = $1,
           exif_timestamp = NULL,
           exif_gps_lat = NULL,
           exif_gps_lng = NULL,
           exif_device_model = NULL,
           capture_validation_passed = $2,
           capture_validation_failures = $3
       FROM target
       WHERE ps.id = target.id
       RETURNING ps.id`,
      [metadata.capture_source, passed, [...failures, ...warnings], proofId],
    );

    if ((persisted.rowCount ?? 0) === 0) {
      return {
        success: false,
        error: {
          code: 'PROOF_SIGNAL_TARGET_NOT_FOUND',
          message: 'The canonical proof verification record was not found.',
        },
      };
    }

    return { success: true, data: { passed, failures, warnings } };
  },

  /**
   * Provider execution is intentionally absent for this legacy signature.
   * Inputs are accepted only for API compatibility and are never transmitted,
   * persisted, or used to derive an automated proof decision.
   */
  compareBeforeAfter: async (
    _taskId: string,
    _beforePhotoUrl: string,
    _afterPhotoUrl: string,
    _taskDescription: string,
  ): Promise<ServiceResult<BeforeAfterComparisonResult>> => ({
    success: true,
    data: { ...DORMANT_COMPARISON },
  }),
};

function haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const earthRadiusMeters = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2)
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusMeters * c;
}

function toRad(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

export default PhotoVerificationService;
