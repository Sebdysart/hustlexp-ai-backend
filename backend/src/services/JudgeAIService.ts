/**
 * JudgeAIService v1.0.0
 *
 * CONSTITUTIONAL: Authority Level A2 (Proposal-Only)
 *
 * Final synthesis agent for proof verification. Combines signals from:
 *   1. BiometricVerificationService (liveness, deepfake, risk)
 *   2. LogisticsAIService (GPS proximity, impossible travel, time-lock, accuracy)
 *   3. PhotoVerificationService (similarity, completion, change detection)
 *
 * Produces a verdict (APPROVE / MANUAL_REVIEW / REJECT) with reasoning.
 * Uses DeepSeek (reasoning route) for multi-signal synthesis, with a
 * deterministic weighted-scoring fallback when AI is unavailable.
 *
 * @see BiometricVerificationService
 * @see LogisticsAIService
 * @see PhotoVerificationService
 * @see schema.sql v1.8.0 (ai_agent_decisions)
 */

import { db } from '../db';
import type { ServiceResult } from '../types';
import { AIClient } from './AIClient';

// ============================================================================
// TYPES
// ============================================================================

export interface BiometricSignals {
  liveness_score: number;   // 0-1 (0=pre-recorded, 1=live)
  deepfake_score: number;   // 0-1 (0=real, 1=fake)
  risk_level: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
}

export interface LogisticsSignals {
  gps_proximity: { passed: boolean; distance_meters?: number };
  impossible_travel: { passed: boolean; speed_kmh?: number };
  time_lock: { passed: boolean; time_delta_seconds?: number };
  gps_accuracy: { passed: boolean; accuracy_meters: number };
}

export interface PhotoVerificationSignals {
  similarity_score: number;   // 0-1
  completion_score: number;   // 0-1
  change_detected: boolean;
}

export interface JudgeInput {
  proof_id: string;
  task_id: string;
  biometric: BiometricSignals;
  logistics: LogisticsSignals;
  photo_verification: PhotoVerificationSignals;
}

export interface JudgeVerdict {
  verdict: 'APPROVE' | 'MANUAL_REVIEW' | 'REJECT';
  confidence: number;          // 0-1
  reasoning: string;
  risk_score: number;          // 0-1
  component_scores: {
    biometric: number;         // 0-1 (higher = riskier)
    logistics: number;         // 0-1 (higher = riskier)
    photo_verification: number; // 0-1 (higher = riskier)
  };
  fraud_flags: string[];
  recommended_action: string;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const BIOMETRIC_WEIGHT = 0.35;
const LOGISTICS_WEIGHT = 0.35;
const PHOTO_WEIGHT = 0.30;

const APPROVE_THRESHOLD = 0.30;   // weighted_score < 0.30 → APPROVE
const REJECT_THRESHOLD = 0.70;    // weighted_score > 0.70 → REJECT

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Compute a 0-1 risk score from biometric signals.
 * High liveness and low deepfake → low risk.
 */
function scoreBiometric(signals: BiometricSignals): { score: number; flags: string[] } {
  const flags: string[] = [];
  let risk = 0;

  // Invert liveness: low liveness = high risk
  risk += (1 - signals.liveness_score) * 0.50;

  // Deepfake score is already risk-oriented
  risk += signals.deepfake_score * 0.50;

  if (signals.liveness_score < 0.70) flags.push('low_liveness');
  if (signals.deepfake_score > 0.85) flags.push('deepfake_suspected');
  if (signals.risk_level === 'CRITICAL') flags.push('biometric_critical');

  return { score: Math.min(risk, 1.0), flags };
}

/**
 * Compute a 0-1 risk score from logistics signals.
 * Each failed check contributes to risk.
 */
function scoreLogistics(signals: LogisticsSignals): { score: number; flags: string[] } {
  const flags: string[] = [];
  let risk = 0;

  if (!signals.gps_proximity.passed) {
    risk += 0.40;
    flags.push('gps_out_of_range');
  }
  if (!signals.impossible_travel.passed) {
    risk += 0.30;
    flags.push('impossible_travel');
  }
  if (!signals.time_lock.passed) {
    risk += 0.20;
    flags.push('time_manipulation');
  }
  if (!signals.gps_accuracy.passed) {
    risk += 0.10;
    flags.push('poor_gps_accuracy');
  }

  return { score: Math.min(risk, 1.0), flags };
}

/**
 * Compute a 0-1 risk score from photo verification signals.
 * Low completion / no change detected → high risk.
 */
function scorePhotoVerification(signals: PhotoVerificationSignals): { score: number; flags: string[] } {
  const flags: string[] = [];
  let risk = 0;

  // Completion score inverted: low completion = high risk
  risk += (1 - signals.completion_score) * 0.50;

  // Similarity: very low similarity means different scene (suspicious)
  if (signals.similarity_score < 0.30) {
    risk += 0.25;
    flags.push('scene_mismatch');
  }

  // No change detected is suspicious for task completion
  if (!signals.change_detected) {
    risk += 0.25;
    flags.push('no_change_detected');
  }

  return { score: Math.min(risk, 1.0), flags };
}

/**
 * Deterministic fallback when AI is unavailable.
 * Uses weighted scoring across all three signal domains.
 */
function deterministicVerdict(input: JudgeInput): JudgeVerdict {
  const biometric = scoreBiometric(input.biometric);
  const logistics = scoreLogistics(input.logistics);
  const photo = scorePhotoVerification(input.photo_verification);

  const weightedScore =
    biometric.score * BIOMETRIC_WEIGHT +
    logistics.score * LOGISTICS_WEIGHT +
    photo.score * PHOTO_WEIGHT;

  const allFlags = [...biometric.flags, ...logistics.flags, ...photo.flags];

  let verdict: 'APPROVE' | 'MANUAL_REVIEW' | 'REJECT';
  let recommendedAction: string;

  if (weightedScore < APPROVE_THRESHOLD) {
    verdict = 'APPROVE';
    recommendedAction = 'Auto-approve proof and release escrow.';
  } else if (weightedScore > REJECT_THRESHOLD) {
    verdict = 'REJECT';
    recommendedAction = 'Reject proof submission. Flag for fraud review if repeated.';
  } else {
    verdict = 'MANUAL_REVIEW';
    recommendedAction = 'Route to human reviewer for manual inspection.';
  }

  const reasoning = allFlags.length === 0
    ? `All verification signals passed. Weighted risk score: ${(weightedScore * 100).toFixed(0)}%. Biometric: ${(biometric.score * 100).toFixed(0)}%, Logistics: ${(logistics.score * 100).toFixed(0)}%, Photo: ${(photo.score * 100).toFixed(0)}%.`
    : `Flags detected: ${allFlags.join(', ')}. Weighted risk score: ${(weightedScore * 100).toFixed(0)}%. Biometric: ${(biometric.score * 100).toFixed(0)}%, Logistics: ${(logistics.score * 100).toFixed(0)}%, Photo: ${(photo.score * 100).toFixed(0)}%.`;

  return {
    verdict,
    confidence: 1.0 - weightedScore,
    reasoning,
    risk_score: weightedScore,
    component_scores: {
      biometric: biometric.score,
      logistics: logistics.score,
      photo_verification: photo.score,
    },
    fraud_flags: allFlags,
    recommended_action: recommendedAction,
  };
}

// ============================================================================
// SERVICE
// ============================================================================

/**
 * Synthesize a final verdict by combining biometric, logistics, and photo signals.
 * Uses DeepSeek (reasoning route) for AI synthesis, with deterministic fallback.
 */
async function synthesizeVerdict(input: JudgeInput): Promise<ServiceResult<JudgeVerdict>> {
  try {
    // Attempt AI-based synthesis if configured
    if (AIClient.isConfigured()) {
      try {
        const aiResult = await AIClient.callJSON<JudgeVerdict>({
          route: 'reasoning',
          temperature: 0.1,
          timeoutMs: 15000,
          enableCache: false,
          systemPrompt: `You are HustleXP's Judge AI — the final synthesis agent for proof verification (A2 authority, proposal-only).

You combine signals from three verification subsystems to produce a single verdict:

1. BIOMETRIC signals: liveness_score (0-1, higher=more live), deepfake_score (0-1, higher=more fake), risk_level
2. LOGISTICS signals: gps_proximity (passed/failed + distance), impossible_travel (passed/failed + speed), time_lock (passed/failed + delta), gps_accuracy (passed/failed + accuracy)
3. PHOTO VERIFICATION signals: similarity_score (0-1, scene consistency), completion_score (0-1, task appears done), change_detected (boolean)

Return JSON with EXACTLY these fields:
- verdict: "APPROVE" | "MANUAL_REVIEW" | "REJECT"
- confidence: number 0-1
- reasoning: string (human-readable, min 30 chars)
- risk_score: number 0-1 (0=safe, 1=fraud)
- component_scores: { biometric: number, logistics: number, photo_verification: number } (each 0-1, higher=riskier)
- fraud_flags: string[] (e.g., "deepfake_suspected", "impossible_travel", "no_change_detected")
- recommended_action: string (what to do next)

RULES:
- If all signals are clean → APPROVE with high confidence
- If any CRITICAL flags (deepfake > 0.85, impossible travel, GPS far out of range) → lean REJECT
- Ambiguous signals → MANUAL_REVIEW
- Always explain which signals drove the decision`,
          prompt: `Synthesize a verdict for this proof submission:

PROOF: ${input.proof_id} (Task: ${input.task_id})

BIOMETRIC SIGNALS:
- Liveness score: ${input.biometric.liveness_score}
- Deepfake score: ${input.biometric.deepfake_score}
- Risk level: ${input.biometric.risk_level}

LOGISTICS SIGNALS:
- GPS proximity: ${input.logistics.gps_proximity.passed ? 'PASSED' : 'FAILED'}${input.logistics.gps_proximity.distance_meters != null ? ` (${input.logistics.gps_proximity.distance_meters.toFixed(0)}m)` : ''}
- Impossible travel: ${input.logistics.impossible_travel.passed ? 'PASSED' : 'FAILED'}${input.logistics.impossible_travel.speed_kmh != null ? ` (${input.logistics.impossible_travel.speed_kmh.toFixed(0)} km/h)` : ''}
- Time lock: ${input.logistics.time_lock.passed ? 'PASSED' : 'FAILED'}${input.logistics.time_lock.time_delta_seconds != null ? ` (${input.logistics.time_lock.time_delta_seconds}s delta)` : ''}
- GPS accuracy: ${input.logistics.gps_accuracy.passed ? 'PASSED' : 'FAILED'} (${input.logistics.gps_accuracy.accuracy_meters}m)

PHOTO VERIFICATION SIGNALS:
- Similarity score: ${input.photo_verification.similarity_score}
- Completion score: ${input.photo_verification.completion_score}
- Change detected: ${input.photo_verification.change_detected}

Produce your verdict.`,
        });

        const aiVerdict = aiResult.data;

        // Validate AI response has required fields and sane values
        if (
          aiVerdict &&
          typeof aiVerdict.verdict === 'string' &&
          ['APPROVE', 'MANUAL_REVIEW', 'REJECT'].includes(aiVerdict.verdict) &&
          typeof aiVerdict.confidence === 'number' &&
          typeof aiVerdict.risk_score === 'number' &&
          typeof aiVerdict.reasoning === 'string' &&
          aiVerdict.component_scores &&
          Array.isArray(aiVerdict.fraud_flags) &&
          typeof aiVerdict.recommended_action === 'string'
        ) {
          console.log(
            `[JudgeAI] AI verdict: ${aiVerdict.verdict}, confidence=${aiVerdict.confidence.toFixed(2)}, risk=${aiVerdict.risk_score.toFixed(2)} (via ${aiResult.provider})`
          );
          return { success: true, data: aiVerdict };
        }

        // AI returned malformed response — fall through to deterministic
        console.warn('[JudgeAI] AI returned malformed verdict, using deterministic fallback');
      } catch (aiError) {
        console.warn('[JudgeAI] AI synthesis failed, using deterministic fallback:', aiError);
      }
    }

    // Deterministic fallback
    const fallbackVerdict = deterministicVerdict(input);
    console.log(
      `[JudgeAI] Deterministic verdict: ${fallbackVerdict.verdict}, risk=${fallbackVerdict.risk_score.toFixed(2)}`
    );
    return { success: true, data: fallbackVerdict };
  } catch (error) {
    console.error('[JudgeAIService.synthesizeVerdict] Error:', error);
    return {
      success: false,
      error: {
        code: 'JUDGE_SYNTHESIS_FAILED',
        message: error instanceof Error ? error.message : 'Failed to synthesize verdict',
      },
    };
  }
}

/**
 * Log a Judge verdict to the ai_agent_decisions audit trail.
 */
async function logVerdict(
  proofId: string,
  taskId: string,
  verdict: JudgeVerdict
): Promise<ServiceResult<void>> {
  try {
    await db.query(
      `INSERT INTO ai_agent_decisions (
        agent_type, proof_id, task_id, proposal, confidence_score,
        reasoning, accepted, authority_level
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        'judge',
        proofId,
        taskId,
        JSON.stringify({
          verdict: verdict.verdict,
          risk_score: verdict.risk_score,
          component_scores: verdict.component_scores,
          fraud_flags: verdict.fraud_flags,
          recommended_action: verdict.recommended_action,
        }),
        verdict.confidence,
        verdict.reasoning,
        verdict.verdict === 'APPROVE',
        'A2',
      ]
    );

    return { success: true, data: undefined };
  } catch (error) {
    console.error('[JudgeAIService.logVerdict] Error:', error);
    return {
      success: false,
      error: {
        code: 'LOG_VERDICT_FAILED',
        message: error instanceof Error ? error.message : 'Failed to log verdict',
      },
    };
  }
}

// ============================================================================
// EXPORTED MODULE
// ============================================================================

export const JudgeAIService = {
  synthesizeVerdict,
  logVerdict,
};

export default JudgeAIService;
