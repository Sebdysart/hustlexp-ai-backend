/**
 * PROOF STATE MACHINE (BUILD_GUIDE Phase 2)
 *
 * Implements the proof lifecycle state machine from BUILD_GUIDE.
 *
 * STATES:
 * - PENDING: Proof submitted, awaiting review
 * - REVIEWING: AI or admin reviewing proof
 * - ACCEPTED: Proof approved (terminal for this proof)
 * - REJECTED: Proof rejected, can resubmit
 * - EXPIRED: Review window passed (terminal)
 *
 * INVARIANTS ENFORCED:
 * - INV-3: Task COMPLETED requires ACCEPTED proof
 * - Only one active proof per task
 * - Rejection allows resubmission
 *
 * @version 1.0.0 (BUILD_GUIDE aligned)
 */
import { getSql } from '../db/index.js';
import { createLogger } from '../utils/logger.js';
const logger = createLogger('ProofStateMachine');
export const TERMINAL_PROOF_STATES = ['accepted', 'expired'];
// ============================================================================
// VALID TRANSITIONS (FROM BUILD_GUIDE)
// ============================================================================
export const PROOF_TRANSITIONS = {
    pending: ['reviewing', 'accepted', 'rejected', 'expired'],
    reviewing: ['accepted', 'rejected'],
    accepted: [], // Terminal
    rejected: [], // Not terminal - allows new proof submission
    expired: [], // Terminal
};
export function calculateProofQuality(proof) {
    const hasDescription = (proof.description?.length || 0) > 50;
    const photoCount = proof.photoUrls?.length || 0;
    const hasBeforeAfter = proof.hasBeforeAfter || false;
    // COMPREHENSIVE: Before/after photos + detailed description
    if (hasBeforeAfter && hasDescription && photoCount >= 2) {
        return 'COMPREHENSIVE';
    }
    // STANDARD: At least 1 photo
    if (photoCount >= 1) {
        return 'STANDARD';
    }
    // BASIC: Text only
    return 'BASIC';
}
// ============================================================================
// STATE MACHINE CLASS
// ============================================================================
class ProofStateMachineClass {
    /**
     * Check if a transition is valid
     */
    canTransition(from, to) {
        const validTargets = PROOF_TRANSITIONS[from] || [];
        return validTargets.includes(to);
    }
    /**
     * Submit new proof for a task
     */
    async submit(taskId, hustlerId, data) {
        const sql = getSql();
        try {
            // Check for existing active proof
            const [existing] = await sql `
        SELECT id, status FROM proof_submissions
        WHERE task_id = ${taskId}
          AND status NOT IN ('rejected', 'expired')
        ORDER BY created_at DESC
        LIMIT 1
      `;
            if (existing) {
                if (existing.status === 'accepted') {
                    return {
                        success: false,
                        previousState: 'accepted',
                        newState: 'accepted',
                        proofId: existing.id,
                        error: 'Proof already accepted for this task',
                    };
                }
                if (existing.status === 'pending' || existing.status === 'reviewing') {
                    return {
                        success: false,
                        previousState: existing.status,
                        newState: existing.status,
                        proofId: existing.id,
                        error: 'Proof already pending review',
                    };
                }
            }
            // Calculate quality tier
            const quality = calculateProofQuality({
                description: data.description,
                photoUrls: data.photoUrls,
            });
            // Calculate expiration (24 hours)
            const expiresAt = new Date();
            expiresAt.setHours(expiresAt.getHours() + 24);
            // Create proof submission
            const [proof] = await sql `
        INSERT INTO proof_submissions (
          task_id,
          hustler_id,
          description,
          photo_urls,
          quality,
          status,
          expires_at,
          created_at
        ) VALUES (
          ${taskId},
          ${hustlerId},
          ${data.description || ''},
          ${JSON.stringify(data.photoUrls || [])},
          ${quality},
          'pending',
          ${expiresAt},
          NOW()
        )
        RETURNING id
      `;
            logger.info({
                taskId,
                proofId: proof.id,
                quality,
            }, 'Proof submitted');
            return {
                success: true,
                previousState: 'pending',
                newState: 'pending',
                proofId: proof.id,
            };
        }
        catch (error) {
            logger.error({ error, taskId }, 'Failed to submit proof');
            return {
                success: false,
                previousState: 'pending',
                newState: 'pending',
                error: error.message,
            };
        }
    }
    /**
     * Transition proof to a new state
     */
    async transition(proofId, targetState, context = {}) {
        const sql = getSql();
        try {
            // Get current state
            const [proof] = await sql `
        SELECT id, task_id, status FROM proof_submissions WHERE id = ${proofId}
      `;
            if (!proof) {
                return {
                    success: false,
                    previousState: 'pending',
                    newState: 'pending',
                    error: 'Proof not found',
                };
            }
            const currentState = proof.status;
            // Check if transition is valid
            if (!this.canTransition(currentState, targetState)) {
                return {
                    success: false,
                    previousState: currentState,
                    newState: currentState,
                    proofId,
                    error: `Invalid proof transition: ${currentState} → ${targetState}`,
                };
            }
            // Execute transition
            await sql `
        UPDATE proof_submissions
        SET 
          status = ${targetState},
          ${context.reviewerId ? sql `reviewed_by = ${context.reviewerId},` : sql ``}
          ${context.aiScore !== undefined ? sql `ai_score = ${context.aiScore},` : sql ``}
          ${context.rejectionReason ? sql `rejection_reason = ${context.rejectionReason},` : sql ``}
          ${targetState !== 'pending' ? sql `reviewed_at = NOW(),` : sql ``}
          updated_at = NOW()
        WHERE id = ${proofId}
      `;
            // Log transition
            await sql `
        INSERT INTO proof_state_log (proof_id, task_id, from_state, to_state, context, created_at)
        VALUES (${proofId}, ${proof.task_id}, ${currentState}, ${targetState}, ${JSON.stringify(context)}, NOW())
      `;
            logger.info({
                proofId,
                taskId: proof.task_id,
                from: currentState,
                to: targetState,
                context,
            }, 'Proof state transition successful');
            return {
                success: true,
                previousState: currentState,
                newState: targetState,
                proofId,
            };
        }
        catch (error) {
            logger.error({ error, proofId, targetState }, 'Proof state transition failed');
            return {
                success: false,
                previousState: 'pending',
                newState: 'pending',
                proofId,
                error: error.message,
            };
        }
    }
    /**
     * Accept a proof
     */
    async accept(proofId, reviewerId) {
        return this.transition(proofId, 'accepted', { reviewerId });
    }
    /**
     * Reject a proof
     */
    async reject(proofId, reason, reviewerId) {
        return this.transition(proofId, 'rejected', {
            reviewerId,
            rejectionReason: reason,
        });
    }
    /**
     * Get current proof state for a task
     */
    async getTaskProofState(taskId) {
        const sql = getSql();
        const [proof] = await sql `
      SELECT id, status, quality, photo_urls, rejection_reason, expires_at
      FROM proof_submissions
      WHERE task_id = ${taskId}
      ORDER BY created_at DESC
      LIMIT 1
    `;
        if (!proof)
            return null;
        let photoUrls = [];
        try {
            photoUrls = typeof proof.photo_urls === 'string'
                ? JSON.parse(proof.photo_urls)
                : (proof.photo_urls || []);
        }
        catch (e) {
            // Ignore parse errors
        }
        return {
            proofId: proof.id,
            state: proof.status,
            quality: proof.quality,
            photoUrls,
            rejectionReason: proof.rejection_reason,
            expiresAt: proof.expires_at ? new Date(proof.expires_at) : undefined,
        };
    }
    /**
     * Check if task has accepted proof (INV-3 helper)
     */
    async hasAcceptedProof(taskId) {
        const sql = getSql();
        const [proof] = await sql `
      SELECT id FROM proof_submissions
      WHERE task_id = ${taskId} AND status = 'accepted'
      LIMIT 1
    `;
        return !!proof;
    }
}
export const ProofStateMachine = new ProofStateMachineClass();
//# sourceMappingURL=ProofStateMachine.js.map