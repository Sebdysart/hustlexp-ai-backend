import { db } from '../db.js';
import { logger } from '../logger.js';
import type { Proof, ServiceResult } from '../types.js';
import { BiometricVerificationService } from './BiometricVerificationService.js';
import {
  JudgeAIService,
  type BiometricSignals,
  type JudgeVerdict,
  type LogisticsSignals,
  type PhotoVerificationSignals,
} from './JudgeAIService.js';
import { LogisticsAIService } from './LogisticsAIService.js';
import type { ProofWithSignals } from './ProofTypes.js';

const log = logger.child({ service: 'ProofService' });

async function biometricSignals(
  proofId: string,
  proof: ProofWithSignals,
): Promise<BiometricSignals | null> {
  if (!proof.photo_url) return null;
  const result = await BiometricVerificationService.analyzeProofSubmission(
    proofId,
    proof.photo_url,
    undefined,
  );
  if (result.success) return result.data!.scores;
  log.warn({ proofId }, 'Biometric subsystem error, proceeding without');
  return null;
}

function parsedCoordinates(proof: ProofWithSignals): { latitude: number; longitude: number } {
  if (typeof proof.gps_coordinates === 'string') return JSON.parse(proof.gps_coordinates);
  return proof.gps_coordinates as unknown as { latitude: number; longitude: number };
}

async function taskCoordinates(
  taskId: string,
): Promise<{ latitude: number; longitude: number } | null> {
  const result = await db.query<{ location_lat: number; location_lng: number }>(
    'SELECT location_lat, location_lng FROM tasks WHERE id = $1 AND location_lat IS NOT NULL',
    [taskId],
  );
  if (result.rows.length === 0) return null;
  return {
    latitude: Number(result.rows[0].location_lat),
    longitude: Number(result.rows[0].location_lng),
  };
}

async function logisticsSignals(proofId: string, proof: ProofWithSignals): Promise<LogisticsSignals | null> {
  if (!proof.gps_coordinates) return null;
  const coordinates = parsedCoordinates(proof);
  const taskLocation = await taskCoordinates(proof.task_id);
  const accuracyMeters = Number(proof.gps_accuracy_meters);
  if (!taskLocation || !Number.isFinite(accuracyMeters) || accuracyMeters < 0) {
    log.warn({ proofId }, 'GPS evidence lacks a trustworthy task reference or measured accuracy');
    return null;
  }
  const result = await LogisticsAIService.validateGPSProof(coordinates, taskLocation, accuracyMeters);
  if (!result.success) {
    log.warn({ proofId }, 'Logistics subsystem error, proceeding without');
    return null;
  }
  return {
    gps_proximity: { passed: result.data.passed, distance_meters: result.data.distance_meters },
    gps_accuracy: { passed: accuracyMeters <= 50, accuracy_meters: accuracyMeters },
  };
}

async function photoSignals(proofId: string, proof: ProofWithSignals): Promise<PhotoVerificationSignals | null> {
  const taskResult = await db.query<{ description: string; before_photo_url?: string }>(
    'SELECT description, before_photo_url FROM tasks WHERE id = $1',
    [proof.task_id],
  );
  const task = taskResult.rows[0];
  if (!proof.photo_url || !task?.before_photo_url || !task?.description) return null;
  log.warn(
    { proofId },
    'Legacy before-photo media is disabled until it has a receipt-backed private-delivery contract',
  );
  return null;
}

export interface AcceptedProofVerification {
  failure: ServiceResult<Proof> | null;
  verdict: JudgeVerdict | null;
}

export async function verifyAcceptedProof(
  proofId: string,
  reviewerId: string,
  proof: ProofWithSignals,
): Promise<AcceptedProofVerification> {
  const biometric = await biometricSignals(proofId, proof);
  const logistics = await logisticsSignals(proofId, proof);
  const photoVerification = await photoSignals(proofId, proof);
  const judge = await JudgeAIService.synthesizeVerdict({
    proof_id: proofId,
    task_id: proof.task_id,
    biometric,
    logistics,
    photo_verification: photoVerification,
  });
  if (!judge.success) {
    log.error({ err: judge.error?.message, proofId }, 'JudgeAI synthesis failed');
    return {
      failure: {
        success: false,
        error: {
          code: 'JUDGE_UNAVAILABLE',
          message: 'Proof acceptance requires a durable verification decision. Try again.',
        },
      },
      verdict: null,
    };
  }
  const verdict = judge.data;
  if (verdict.verdict === 'REJECT') {
    return {
      verdict,
      failure: {
        success: false,
        error: {
          code: 'JUDGE_REJECTED',
          message: `Proof rejected by verification: ${verdict.reasoning}`,
          details: {
            risk_score: verdict.risk_score,
            fraud_flags: verdict.fraud_flags,
            component_scores: verdict.component_scores,
            recommended_action: verdict.recommended_action,
          },
        },
      },
    };
  }
  if (verdict.verdict === 'MANUAL_REVIEW') {
    log.warn(
      { proofId, riskScore: verdict.risk_score, fraudFlags: verdict.fraud_flags, reviewerId },
      'JudgeAI flagged proof for MANUAL_REVIEW - human reviewer overriding to ACCEPTED',
    );
  }
  return { failure: null, verdict };
}
