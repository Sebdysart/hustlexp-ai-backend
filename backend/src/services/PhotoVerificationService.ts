/**
 * PhotoVerificationService v1.0.0
 *
 * CONSTITUTIONAL: Before/After photo AI comparison (Gap 2 fix)
 * + Time-locked camera validation (Gap 11 fix)
 *
 * Uses Google Cloud Vision API or OpenAI Vision to compare before/after
 * images for task completion verification. Also validates photo metadata
 * to prevent gallery uploads and GPS spoofing.
 *
 * @see BiometricVerificationService (complements this for face checks)
 */

import { db } from '../db';
import type { ServiceResult } from '../types';
import { openaiBreaker } from '../middleware/circuit-breaker';
import { logger } from '../logger';

const log = logger.child({ service: 'PhotoVerificationService' });

// ============================================================================
// TYPES
// ============================================================================

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
  similarity_score: number; // 0-1 (how similar the scenes are)
  completion_score: number; // 0-1 (how much the "problem" appears resolved)
  change_detected: boolean;
  ai_assessment: string;
  confidence: number;
  recommendation: 'approve' | 'manual_review' | 'reject';
}

// ============================================================================
// CONSTANTS
// ============================================================================

const MAX_CAPTURE_AGE_MINUTES = 5; // Photo must be taken within 5 minutes
const MAX_GPS_DISTANCE_METERS = 500; // Photo GPS must be within 500m of task
const COMPLETION_THRESHOLD = 0.65; // 65% completion score = auto-approve
const REVIEW_THRESHOLD = 0.40; // Below 40% = reject, 40-65% = manual review

// ============================================================================
// SERVICE
// ============================================================================

export const PhotoVerificationService = {
  // --------------------------------------------------------------------------
  // GAP 11: TIME-LOCKED CAMERA VALIDATION
  // --------------------------------------------------------------------------

  /**
   * Validate that a photo was taken live (not from gallery)
   * Checks EXIF data, timestamp freshness, GPS proximity
   */
  validateCapture: async (
    proofId: string,
    metadata: PhotoMetadata,
    taskLocation?: { lat: number; lng: number }
  ): Promise<ServiceResult<CaptureValidationResult>> => {
    const failures: string[] = [];
    const warnings: string[] = [];

    // 1. Check capture source
    if (metadata.capture_source === 'gallery') {
      failures.push('GALLERY_UPLOAD_REJECTED: Photo must be taken live within the app');
    }

    if (metadata.capture_source === 'unknown') {
      warnings.push('CAPTURE_SOURCE_UNKNOWN: Could not determine if photo was taken live');
    }

    // 2. Check timestamp freshness
    if (metadata.exif_timestamp) {
      const ageMinutes = (Date.now() - new Date(metadata.exif_timestamp).getTime()) / 60000;
      if (ageMinutes > MAX_CAPTURE_AGE_MINUTES) {
        failures.push(`STALE_PHOTO: Photo is ${Math.round(ageMinutes)} minutes old (max ${MAX_CAPTURE_AGE_MINUTES})`);
      }
      if (ageMinutes < 0) {
        failures.push('FUTURE_TIMESTAMP: Photo timestamp is in the future — possible manipulation');
      }
    } else {
      warnings.push('NO_EXIF_TIMESTAMP: Could not verify when photo was taken');
    }

    // 3. Check GPS proximity to task
    if (metadata.exif_gps_lat && metadata.exif_gps_lng && taskLocation) {
      const distance = haversineDistance(
        metadata.exif_gps_lat,
        metadata.exif_gps_lng,
        taskLocation.lat,
        taskLocation.lng
      );

      if (distance > MAX_GPS_DISTANCE_METERS) {
        failures.push(`GPS_MISMATCH: Photo taken ${Math.round(distance)}m from task location (max ${MAX_GPS_DISTANCE_METERS}m)`);
      }
    } else if (!metadata.exif_gps_lat && taskLocation) {
      warnings.push('NO_GPS_DATA: Could not verify photo location');
    }

    // 4. Store validation results
    const passed = failures.length === 0;
    await db.query(
      `UPDATE proof_submissions
       SET capture_source = $1,
           exif_timestamp = $2,
           exif_gps_lat = $3,
           exif_gps_lng = $4,
           exif_device_model = $5,
           capture_validation_passed = $6,
           capture_validation_failures = $7
       WHERE id = $8`,
      [
        metadata.capture_source,
        metadata.exif_timestamp,
        metadata.exif_gps_lat,
        metadata.exif_gps_lng,
        metadata.exif_device_model,
        passed,
        [...failures, ...warnings],
        proofId,
      ]
    );

    return {
      success: true,
      data: { passed, failures, warnings },
    };
  },

  // --------------------------------------------------------------------------
  // GAP 2: BEFORE/AFTER PHOTO AI COMPARISON
  // --------------------------------------------------------------------------

  /**
   * Compare before and after photos using AI vision
   * Uses OpenAI Vision API (GPT-4o) or Google Cloud Vision
   */
  compareBeforeAfter: async (
    taskId: string,
    beforePhotoUrl: string,
    afterPhotoUrl: string,
    taskDescription: string
  ): Promise<ServiceResult<BeforeAfterComparisonResult>> => {
    try {
      // Call OpenAI Vision API for comparison
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        log.warn('OPENAI_API_KEY not set, using fallback scoring');
        return {
          success: true,
          data: {
            similarity_score: 0.5,
            completion_score: 0.5,
            change_detected: true,
            ai_assessment: 'AI verification unavailable — manual review required',
            confidence: 0.0,
            recommendation: 'manual_review',
          },
        };
      }

      const response = await openaiBreaker.execute(() => fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [
            {
              role: 'system',
              content: `You are a task completion verification AI for a gig work platform.
You compare before and after photos to determine if a physical task was completed.
Respond with JSON only: {"similarity_score": 0-1, "completion_score": 0-1, "change_detected": bool, "assessment": "string", "confidence": 0-1}
- similarity_score: how similar the scene/location is (should be high if same place)
- completion_score: how much the described work appears to be done (0=not done, 1=fully done)
- change_detected: whether meaningful change occurred between photos
- assessment: brief explanation
- confidence: how confident you are in this judgment`,
            },
            {
              role: 'user',
              content: [
                { type: 'text', text: `Task description: "${taskDescription}". Compare the BEFORE photo (first) with the AFTER photo (second). Was this task completed?` },
                { type: 'image_url', image_url: { url: beforePhotoUrl } },
                { type: 'image_url', image_url: { url: afterPhotoUrl } },
              ],
            },
          ],
          max_tokens: 500,
          temperature: 0.1, // Low temperature for consistent scoring
        }),
      }));

      if (!response.ok) {
        throw new Error(`OpenAI API error: ${response.status}`);
      }

      const data = await response.json() as Record<string, any>;
      const content = data.choices?.[0]?.message?.content;

      // Parse AI response
      let parsed;
      try {
        // Extract JSON from response (may be wrapped in markdown code blocks)
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        parsed = JSON.parse(jsonMatch?.[0] || content);
      } catch {
        log.error({ content }, 'Failed to parse AI response');
        return {
          success: true,
          data: {
            similarity_score: 0.5,
            completion_score: 0.5,
            change_detected: true,
            ai_assessment: 'AI response parsing failed — manual review required',
            confidence: 0.0,
            recommendation: 'manual_review',
          },
        };
      }

      // Determine recommendation
      let recommendation: 'approve' | 'manual_review' | 'reject';
      if (parsed.completion_score >= COMPLETION_THRESHOLD && parsed.confidence >= 0.6) {
        recommendation = 'approve';
      } else if (parsed.completion_score < REVIEW_THRESHOLD) {
        recommendation = 'reject';
      } else {
        recommendation = 'manual_review';
      }

      return {
        success: true,
        data: {
          similarity_score: parsed.similarity_score || 0,
          completion_score: parsed.completion_score || 0,
          change_detected: parsed.change_detected ?? true,
          ai_assessment: parsed.assessment || 'Assessment unavailable',
          confidence: parsed.confidence || 0,
          recommendation,
        },
      };
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error) }, 'compareBeforeAfter error');
      return {
        success: true,
        data: {
          similarity_score: 0.5,
          completion_score: 0.5,
          change_detected: true,
          ai_assessment: `AI verification error: ${error instanceof Error ? error.message : 'Unknown'}`,
          confidence: 0.0,
          recommendation: 'manual_review',
        },
      };
    }
  },
};

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Haversine distance calculation (meters)
 */
function haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000; // Earth radius in meters
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

export default PhotoVerificationService;
