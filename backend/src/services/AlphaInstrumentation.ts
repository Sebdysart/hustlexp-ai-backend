/**
 * Alpha Instrumentation Service
 * 
 * Trust-system telemetry for detecting leaks, confusion, abuse vectors, and silent failure.
 * This is not analytics fluff; this is trust-system telemetry.
 * 
 * Event groups:
 * - edge_state_impression: What reality users are actually experiencing
 * - edge_state_exit: Silent failure detection
 * - dispute_entry_attempt: Dispute path pressure tests
 * - dispute_submission_result: Dispute guard validation
 * - proof_submission: Proof loop instrumentation
 * - proof_correction_outcome: Proof correction validation
 * - trust_delta_applied: Trust change auditability
 */

import { db } from '../db';
import { logger } from '../logger';

const log = logger.child({ service: 'AlphaInstrumentation' });

// ============================================================================
// Event Types
// ============================================================================

export type EdgeStateType = 'E1_NO_TASKS_AVAILABLE' | 'E2_ELIGIBILITY_MISMATCH' | 'E3_TRUST_TIER_LOCKED';
export type UserRole = 'hustler' | 'poster';
export type ExitType = 'continue' | 'back' | 'app_background' | 'session_end';
export type DisputeTriggerState = 'BLOCKED' | 'ACTION_REQUIRED' | 'APPROVED';
export type DisputeReasonCode = 
  | 'REQUIRED_DELIVERABLES_MISSING'
  | 'PROOF_NOT_MEET_CRITERIA'
  | 'WORK_DEVIATES_DESCRIPTION'
  | 'LOCATION_TIME_MISMATCH'
  | 'SYSTEM_ERROR_VERIFICATION'
  | 'ACCESS_NOT_PROVIDED'
  | 'REQUIREMENTS_CHANGED'
  | 'SAFETY_ISSUE_PREVENTED';
export type TrustDeltaType = 'xp' | 'tier' | 'streak';
export type VerificationResult = 'pass' | 'fail';

// ============================================================================
// Event Payloads
// ============================================================================

export interface EdgeStateImpressionPayload {
  user_id: string;
  role: UserRole;
  state: EdgeStateType;
  trust_tier: number;
  location_radius_miles?: number;
  instant_mode_enabled: boolean;
  timestamp: Date;
}

export interface EdgeStateExitPayload {
  user_id: string;
  role: UserRole;
  state: EdgeStateType;
  time_on_screen_ms: number;
  exit_type: ExitType;
  timestamp: Date;
}

export interface DisputeEntryAttemptPayload {
  user_id: string;
  role: UserRole;
  task_id: string;
  trigger_state: DisputeTriggerState;
  time_since_completion_seconds: number;
  reason_selected: DisputeReasonCode;
  timestamp: Date;
}

export interface DisputeSubmissionResultPayload {
  user_id: string;
  role: UserRole;
  task_id: string;
  submitted: boolean;
  rejected_by_guard: boolean;
  cooldown_hit: boolean;
  timestamp: Date;
}

export interface ProofSubmissionPayload {
  user_id: string;
  role: UserRole;
  task_id: string;
  attempt_number: 1 | 2;
  proof_type: string;
  gps_verified: boolean;
  verification_result: VerificationResult;
  failure_reason?: string;
  timestamp: Date;
}

export interface ProofCorrectionOutcomePayload {
  user_id: string;
  role: UserRole;
  task_id: string;
  resolved: boolean;
  xp_released: boolean;
  escrow_released: boolean;
  timestamp: Date;
}

export interface TrustDeltaAppliedPayload {
  user_id: string;
  role: UserRole;
  delta_type: TrustDeltaType;
  delta_amount: number;
  reason_code: string;
  task_id?: string;
  timestamp: Date;
}

// ============================================================================
// Alpha Instrumentation Service
// ============================================================================

export class AlphaInstrumentation {
  /**
   * Emit edge state impression event
   * Fire once per session per state
   */
  static async emitEdgeStateImpression(payload: EdgeStateImpressionPayload): Promise<void> {
    try {
      await db.query(`
        INSERT INTO alpha_telemetry (
          event_group,
          user_id,
          role,
          state,
          trust_tier,
          location_radius_miles,
          instant_mode_enabled,
          metadata,
          timestamp
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `, [
        'edge_state_impression',
        payload.user_id,
        payload.role,
        payload.state,
        payload.trust_tier,
        payload.location_radius_miles || null,
        payload.instant_mode_enabled,
        JSON.stringify({}),
        payload.timestamp
      ]);
    } catch (error) {
      // Silent fail - instrumentation should not break core flow
      log.error({ err: error instanceof Error ? error.message : String(error) }, 'Failed to emit edge_state_impression');
    }
  }

  /**
   * Emit edge state exit event
   * Fire when user leaves the screen
   */
  static async emitEdgeStateExit(payload: EdgeStateExitPayload): Promise<void> {
    try {
      await db.query(`
        INSERT INTO alpha_telemetry (
          event_group,
          user_id,
          role,
          state,
          time_on_screen_ms,
          exit_type,
          metadata,
          timestamp
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, [
        'edge_state_exit',
        payload.user_id,
        payload.role,
        payload.state,
        payload.time_on_screen_ms,
        payload.exit_type,
        JSON.stringify({}),
        payload.timestamp
      ]);
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error) }, 'Failed to emit edge_state_exit');
    }
  }

  /**
   * Emit dispute entry attempt event
   * Fire before dispute submission
   */
  static async emitDisputeEntryAttempt(payload: DisputeEntryAttemptPayload): Promise<void> {
    try {
      await db.query(`
        INSERT INTO alpha_telemetry (
          event_group,
          user_id,
          role,
          task_id,
          trigger_state,
          time_since_completion_seconds,
          reason_selected,
          metadata,
          timestamp
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `, [
        'dispute_entry_attempt',
        payload.user_id,
        payload.role,
        payload.task_id,
        payload.trigger_state,
        payload.time_since_completion_seconds,
        payload.reason_selected,
        JSON.stringify({}),
        payload.timestamp
      ]);
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error) }, 'Failed to emit dispute_entry_attempt');
    }
  }

  /**
   * Emit dispute submission result event
   */
  static async emitDisputeSubmissionResult(payload: DisputeSubmissionResultPayload): Promise<void> {
    try {
      await db.query(`
        INSERT INTO alpha_telemetry (
          event_group,
          user_id,
          role,
          task_id,
          submitted,
          rejected_by_guard,
          cooldown_hit,
          metadata,
          timestamp
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `, [
        'dispute_submission_result',
        payload.user_id,
        payload.role,
        payload.task_id,
        payload.submitted,
        payload.rejected_by_guard,
        payload.cooldown_hit,
        JSON.stringify({}),
        payload.timestamp
      ]);
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error) }, 'Failed to emit dispute_submission_result');
    }
  }

  /**
   * Emit proof submission event
   */
  static async emitProofSubmission(payload: ProofSubmissionPayload): Promise<void> {
    try {
      await db.query(`
        INSERT INTO alpha_telemetry (
          event_group,
          user_id,
          role,
          task_id,
          attempt_number,
          proof_type,
          gps_verified,
          verification_result,
          failure_reason,
          metadata,
          timestamp
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      `, [
        'proof_submission',
        payload.user_id,
        payload.role,
        payload.task_id,
        payload.attempt_number,
        payload.proof_type,
        payload.gps_verified,
        payload.verification_result,
        payload.failure_reason || null,
        JSON.stringify({}),
        payload.timestamp
      ]);
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error) }, 'Failed to emit proof_submission');
    }
  }

  /**
   * Emit proof correction outcome event
   */
  static async emitProofCorrectionOutcome(payload: ProofCorrectionOutcomePayload): Promise<void> {
    try {
      await db.query(`
        INSERT INTO alpha_telemetry (
          event_group,
          user_id,
          role,
          task_id,
          resolved,
          xp_released,
          escrow_released,
          metadata,
          timestamp
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `, [
        'proof_correction_outcome',
        payload.user_id,
        payload.role,
        payload.task_id,
        payload.resolved,
        payload.xp_released,
        payload.escrow_released,
        JSON.stringify({}),
        payload.timestamp
      ]);
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error) }, 'Failed to emit proof_correction_outcome');
    }
  }

  /**
   * Emit trust delta applied event
   * Fire on every trust update
   */
  static async emitTrustDeltaApplied(payload: TrustDeltaAppliedPayload): Promise<void> {
    try {
      await db.query(`
        INSERT INTO alpha_telemetry (
          event_group,
          user_id,
          role,
          delta_type,
          delta_amount,
          reason_code,
          task_id,
          metadata,
          timestamp
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `, [
        'trust_delta_applied',
        payload.user_id,
        payload.role,
        payload.delta_type,
        payload.delta_amount,
        payload.reason_code,
        payload.task_id || null,
        JSON.stringify({}),
        payload.timestamp
      ]);
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error) }, 'Failed to emit trust_delta_applied');
    }
  }
}
