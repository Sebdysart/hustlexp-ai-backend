/**
 * PROOF FREEZE SERVICE
 *
 * Enforces proof → money boundary.
 * When proof is pending, payout MUST be blocked.
 */
import { neon } from '@neondatabase/serverless';
import { createLogger } from '../../utils/logger.js';
import { ProofState } from './types.js';
const logger = createLogger('ProofFreezeService');
let sql = null;
function getDb() {
    if (!sql && process.env.DATABASE_URL) {
        sql = neon(process.env.DATABASE_URL);
    }
    return sql;
}
// Freeze states that block payout
const BLOCKING_PROOF_STATES = [
    ProofState.REQUESTED,
    ProofState.SUBMITTED,
    ProofState.ANALYZING,
    ProofState.ESCALATED
];
export class ProofFreezeService {
    /**
     * Set freeze state on task when proof is requested
     */
    static async setFreezeState(taskId, state) {
        const db = getDb();
        if (!db)
            return;
        await db `
            UPDATE tasks SET proof_freeze_state = ${state}, updated_at = NOW()
            WHERE id = ${taskId}::uuid
        `;
        logger.info({ taskId, state }, 'Task proof freeze state updated');
    }
    /**
     * Check if payout is blocked by proof state
     * This is the READ-ONLY dependency between proof and money
     */
    static async isPayoutBlocked(taskId) {
        const db = getDb();
        if (!db)
            return { blocked: false };
        // 1. Check task freeze state
        const [task] = await db `
            SELECT proof_freeze_state FROM tasks WHERE id = ${taskId}::uuid
        `;
        if (task?.proof_freeze_state === 'AWAITING_PROOF') {
            return { blocked: true, reason: 'Task is awaiting proof submission' };
        }
        // 2. Check for any pending proof requests
        const [pendingProof] = await db `
            SELECT id, state FROM proof_requests 
            WHERE task_id = ${taskId}::uuid 
            AND state IN ('requested', 'submitted', 'analyzing', 'escalated')
            ORDER BY created_at DESC
            LIMIT 1
        `;
        if (pendingProof) {
            return {
                blocked: true,
                reason: `Proof in state: ${pendingProof.state}`
            };
        }
        return { blocked: false };
    }
    /**
     * Get canonical proof truth for task
     * Single source of truth for "has valid evidence"
     */
    static async getProofTruth(taskId) {
        const db = getDb();
        if (!db)
            return { hasValidProof: false, proofState: null };
        const [proof] = await db `
            SELECT ps.id, ps.state, ps.locked_at, pr.state as request_state
            FROM proof_submissions ps
            JOIN proof_requests pr ON pr.id = ps.request_id
            WHERE ps.task_id = ${taskId}::uuid
            AND ps.state IN ('verified', 'locked')
            ORDER BY ps.created_at DESC
            LIMIT 1
        `;
        if (!proof) {
            // Check if proof was even required
            const [request] = await db `
                SELECT id, state FROM proof_requests WHERE task_id = ${taskId}::uuid LIMIT 1
            `;
            if (!request) {
                // No proof required for this task
                return { hasValidProof: true, proofState: null };
            }
            return { hasValidProof: false, proofState: request.state };
        }
        return {
            hasValidProof: true,
            proofState: proof.state,
            submissionId: proof.id,
            verifiedAt: proof.locked_at
        };
    }
}
//# sourceMappingURL=ProofFreezeService.js.map