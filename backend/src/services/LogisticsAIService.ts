/**
 * LogisticsAIService v1.0.0
 *
 * CONSTITUTIONAL: Authority Level A2 (Proposal-Only)
 *
 * Validates proof submissions for spatial consistency, temporal integrity,
 * and physical feasibility. Cannot directly approve/reject proofs.
 *
 * @see LOGISTICS_AGENT_SPEC_LOCKED.md
 * @see schema.sql v1.8.0 (ai_agent_decisions, fraud_detection_events)
 */

import { db } from '../db';
import type { ServiceResult } from '../types';
import { aiLogger } from '../logger';

const log = aiLogger.child({ service: 'LogisticsAIService' });

// ============================================================================
// TYPES
// ============================================================================

interface GPSCoordinates {
  latitude: number;
  longitude: number;
}

interface ValidationCheck {
  passed: boolean;
  [key: string]: unknown;
}

interface LogisticsProposal {
  risk_score: number; // 0.0-1.0
  risk_level: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  recommendation: 'approve' | 'manual_review' | 'reject';
  fraud_flags: string[];
  reasoning: string;
  validation_checks: {
    gps_proximity: ValidationCheck & { distance_meters?: number; threshold_meters: number };
    impossible_travel: ValidationCheck & { speed_kmh?: number; max_allowed_kmh: number };
    time_lock: ValidationCheck & { time_delta_seconds?: number };
    gps_accuracy: ValidationCheck & { accuracy_meters: number; threshold_meters: number };
  };
  confidence_score: number;
}

interface ImpossibleTravelResult {
  passed: boolean;
  speed_kmh: number;
  distance_meters: number;
  time_delta_seconds: number;
  flagged: boolean;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const MAX_GROUND_SPEED_KMH = 100; // Maximum realistic ground speed
const GPS_PROXIMITY_THRESHOLD_METERS = 500; // Task location proximity
const GPS_ACCURACY_THRESHOLD_METERS = 50; // Required GPS accuracy
const TIME_LOCK_MAX_DELTA_SECONDS = 300; // 5 minutes max between capture and submission

// ============================================================================
// SERVICE
// ============================================================================

export const LogisticsAIService = {
  /**
   * Validate GPS proximity to task location
   * Uses Haversine distance formula
   */
  validateGPSProof: async (
    proofCoords: GPSCoordinates,
    taskCoords: GPSCoordinates,
    accuracyMeters: number
  ): Promise<ServiceResult<{ passed: boolean; distance_meters: number; risk_level: 'LOW' | 'MEDIUM' | 'HIGH' }>> => {
    try {
      const distanceMeters = LogisticsAIService._haversineDistance(proofCoords, taskCoords);

      let riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
      let passed: boolean;

      if (distanceMeters <= 100) {
        riskLevel = 'LOW';
        passed = true;
      } else if (distanceMeters <= GPS_PROXIMITY_THRESHOLD_METERS) {
        riskLevel = 'MEDIUM';
        passed = true;
      } else {
        riskLevel = 'HIGH';
        passed = false;
      }

      return {
        success: true,
        data: { passed, distance_meters: distanceMeters, risk_level: riskLevel }
      };
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error) }, 'Failed to validate GPS proof');
      return {
        success: false,
        error: {
          code: 'GPS_VALIDATION_FAILED',
          message: error instanceof Error ? error.message : 'Failed to validate GPS'
        }
      };
    }
  },

  /**
   * Detect impossible travel patterns
   * Flags physically impossible movement (>100 km/h ground speed)
   */
  detectImpossibleTravel: async (
    userId: string,
    currentLocation: GPSCoordinates & { timestamp: string },
    lastKnownLocation?: GPSCoordinates & { timestamp: string }
  ): Promise<ServiceResult<ImpossibleTravelResult>> => {
    try {
      if (!lastKnownLocation) {
        // No prior location to compare
        return {
          success: true,
          data: {
            passed: true,
            speed_kmh: 0,
            distance_meters: 0,
            time_delta_seconds: 0,
            flagged: false
          }
        };
      }

      const distanceMeters = LogisticsAIService._haversineDistance(lastKnownLocation, currentLocation);
      const timeDeltaSeconds =
        (new Date(currentLocation.timestamp).getTime() - new Date(lastKnownLocation.timestamp).getTime()) / 1000;

      if (timeDeltaSeconds <= 0) {
        // Invalid timestamps
        return {
          success: false,
          error: {
            code: 'INVALID_TIMESTAMPS',
            message: 'Current timestamp must be after last known timestamp'
          }
        };
      }

      const speedMps = distanceMeters / timeDeltaSeconds;
      const speedKmh = speedMps * 3.6;

      const flagged = speedKmh > MAX_GROUND_SPEED_KMH;
      const passed = !flagged;

      // If flagged, create fraud detection event
      if (flagged) {
        await db.query(
          `INSERT INTO fraud_detection_events (
            user_id, event_type, severity, evidence,
            location_a, location_b, time_a, time_b,
            distance_km, time_delta_seconds
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            userId,
            'impossible_travel',
            speedKmh > 200 ? 'critical' : 'high',
            JSON.stringify({ speed_kmh: speedKmh, explanation: `User traveled ${(distanceMeters / 1000).toFixed(1)}km in ${(timeDeltaSeconds / 60).toFixed(0)} minutes` }),
            `(${lastKnownLocation.latitude},${lastKnownLocation.longitude})`,
            `(${currentLocation.latitude},${currentLocation.longitude})`,
            new Date(lastKnownLocation.timestamp),
            new Date(currentLocation.timestamp),
            distanceMeters / 1000,
            timeDeltaSeconds
          ]
        );

        log.warn({ userId, speedKmh, distanceMeters, timeDeltaSeconds }, 'FRAUD ALERT: Impossible travel detected');
      }

      return {
        success: true,
        data: {
          passed,
          speed_kmh: speedKmh,
          distance_meters: distanceMeters,
          time_delta_seconds: timeDeltaSeconds,
          flagged
        }
      };
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error), userId }, 'Failed to detect impossible travel');
      return {
        success: false,
        error: {
          code: 'IMPOSSIBLE_TRAVEL_CHECK_FAILED',
          message: error instanceof Error ? error.message : 'Failed to check impossible travel'
        }
      };
    }
  },

  /**
   * Validate time-lock hash
   * Ensures photo was taken at claimed time, not pre-uploaded
   */
  validateTimeLock: (
    timeLockHash: string,
    submissionTimestamp: string,
    gpsTimestamp: string
  ): { passed: boolean; time_delta_seconds: number } => {
    const timeDelta = Math.abs(
      (new Date(submissionTimestamp).getTime() - new Date(gpsTimestamp).getTime()) / 1000
    );

    // Photos must be submitted within 5 minutes of capture
    const passed = timeDelta <= TIME_LOCK_MAX_DELTA_SECONDS;

    return { passed, time_delta_seconds: timeDelta };
  },

  /**
   * Assess overall logistics risk
   * Combines all validation checks into single proposal
   */
  assessLogisticsRisk: async (
    proofId: string,
    userId: string,
    proofCoords: GPSCoordinates,
    taskCoords: GPSCoordinates,
    gpsAccuracyMeters: number,
    gpsTimestamp: string,
    submissionTimestamp: string,
    timeLockHash: string,
    lastKnownLocation?: GPSCoordinates & { timestamp: string }
  ): Promise<ServiceResult<LogisticsProposal>> => {
    try {
      // Run all validation checks
      const gpsProximityResult = await LogisticsAIService.validateGPSProof(proofCoords, taskCoords, gpsAccuracyMeters);
      const impossibleTravelResult = await LogisticsAIService.detectImpossibleTravel(
        userId,
        { ...proofCoords, timestamp: gpsTimestamp },
        lastKnownLocation
      );
      const timeLockResult = LogisticsAIService.validateTimeLock(timeLockHash, submissionTimestamp, gpsTimestamp);
      const gpsAccuracyCheck = gpsAccuracyMeters <= GPS_ACCURACY_THRESHOLD_METERS;

      // Collect results
      const validationChecks = {
        gps_proximity: {
          passed: gpsProximityResult.success && gpsProximityResult.data.passed,
          distance_meters: gpsProximityResult.success ? gpsProximityResult.data.distance_meters : undefined,
          threshold_meters: GPS_PROXIMITY_THRESHOLD_METERS
        },
        impossible_travel: {
          passed: impossibleTravelResult.success && impossibleTravelResult.data.passed,
          speed_kmh: impossibleTravelResult.success ? impossibleTravelResult.data.speed_kmh : undefined,
          max_allowed_kmh: MAX_GROUND_SPEED_KMH
        },
        time_lock: {
          passed: timeLockResult.passed,
          time_delta_seconds: timeLockResult.time_delta_seconds
        },
        gps_accuracy: {
          passed: gpsAccuracyCheck,
          accuracy_meters: gpsAccuracyMeters,
          threshold_meters: GPS_ACCURACY_THRESHOLD_METERS
        }
      };

      // Calculate risk score
      let riskScore = 0.0;
      const fraudFlags: string[] = [];

      if (!validationChecks.gps_proximity.passed) {
        riskScore += 0.40;
        fraudFlags.push('gps_out_of_range');
      } else if (validationChecks.gps_proximity.distance_meters! > 100) {
        riskScore += 0.15;
      }

      if (!validationChecks.impossible_travel.passed) {
        riskScore += 0.30;
        fraudFlags.push('impossible_travel');
      }

      if (!validationChecks.time_lock.passed) {
        riskScore += 0.20;
        fraudFlags.push('time_manipulation');
      }

      if (!validationChecks.gps_accuracy.passed) {
        riskScore += 0.10;
        fraudFlags.push('poor_gps_accuracy');
      }

      riskScore = Math.min(riskScore, 1.0);

      // Determine risk level and recommendation
      let riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
      let recommendation: 'approve' | 'manual_review' | 'reject';

      if (riskScore >= 0.70) {
        riskLevel = 'CRITICAL';
        recommendation = 'reject';
      } else if (riskScore >= 0.50) {
        riskLevel = 'HIGH';
        recommendation = 'reject';
      } else if (riskScore >= 0.30) {
        riskLevel = 'MEDIUM';
        recommendation = 'manual_review';
      } else {
        riskLevel = 'LOW';
        recommendation = 'approve';
      }

      // Generate reasoning
      let reasoning = '';
      if (fraudFlags.length === 0) {
        reasoning = `All logistics checks passed. GPS within ${validationChecks.gps_proximity.distance_meters?.toFixed(0)}m of task. No impossible travel detected.`;
      } else {
        reasoning = `Logistics flags detected: ${fraudFlags.join(', ')}. Risk score: ${(riskScore * 100).toFixed(0)}%.`;
      }

      // Log decision to ai_agent_decisions
      await db.query(
        `INSERT INTO ai_agent_decisions (
          agent_type, proof_id, proposal, confidence_score, reasoning, authority_level
        ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          'logistics',
          proofId,
          JSON.stringify({ risk_score: riskScore, risk_level: riskLevel, recommendation, fraud_flags: fraudFlags }),
          1.0 - riskScore, // Confidence inverse of risk
          reasoning,
          'A2'
        ]
      );

      return {
        success: true,
        data: {
          risk_score: riskScore,
          risk_level: riskLevel,
          recommendation,
          fraud_flags: fraudFlags,
          reasoning,
          validation_checks: validationChecks,
          confidence_score: 1.0 - riskScore
        }
      };
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error), proofId, userId }, 'Failed to assess logistics risk');
      return {
        success: false,
        error: {
          code: 'LOGISTICS_ASSESSMENT_FAILED',
          message: error instanceof Error ? error.message : 'Failed to assess logistics risk'
        }
      };
    }
  },

  /**
   * Private: Haversine distance formula
   * Returns distance in meters between two GPS coordinates
   */
  _haversineDistance: (coord1: GPSCoordinates, coord2: GPSCoordinates): number => {
    const R = 6371e3; // Earth radius in meters
    const φ1 = (coord1.latitude * Math.PI) / 180;
    const φ2 = (coord2.latitude * Math.PI) / 180;
    const Δφ = ((coord2.latitude - coord1.latitude) * Math.PI) / 180;
    const Δλ = ((coord2.longitude - coord1.longitude) * Math.PI) / 180;

    const a =
      Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
      Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c; // Distance in meters
  }
};
