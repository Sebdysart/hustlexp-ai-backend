/**
 * PAYOUT ELIGIBILITY RESOLVER (Phase 12C)
 *
 * Single source of truth for payout eligibility.
 *
 * INVARIANT: Money cannot move unless the task is in a provably safe state.
 *
 * Inputs:
 * - Task state
 * - Proof state
 * - Dispute state
 * - KillSwitch state
 *
 * Output:
 * - ALLOW | BLOCK | ESCALATE (with reason)
 */
import { neon } from '@neondatabase/serverless';
import { KillSwitch } from '../infra/KillSwitch.js';
import { ProofFreezeService } from './proof/ProofFreezeService.js';
import { ProofState } from './proof/types.js';
import { serviceLogger } from '../utils/logger.js';
import { ulid } from 'ulidx';
import { BetaMetricsService } from './BetaMetricsService.js';
const logger = serviceLogger.child({ module: 'PayoutEligibilityResolver' });
let sql = null;
function getDb() {
    if (!sql && process.env.DATABASE_URL) {
        sql = neon(process.env.DATABASE_URL);
    }
    return sql;
}
// Eligibility decisions
export var PayoutDecision;
(function (PayoutDecision) {
    PayoutDecision["ALLOW"] = "ALLOW";
    PayoutDecision["BLOCK"] = "BLOCK";
    PayoutDecision["ESCALATE"] = "ESCALATE";
})(PayoutDecision || (PayoutDecision = {}));
// Blocking reason categories
export var BlockReason;
(function (BlockReason) {
    BlockReason["KILLSWITCH_ACTIVE"] = "KILLSWITCH_ACTIVE";
    BlockReason["TASK_NOT_FOUND"] = "TASK_NOT_FOUND";
    BlockReason["TASK_NOT_COMPLETED"] = "TASK_NOT_COMPLETED";
    BlockReason["PROOF_PENDING"] = "PROOF_PENDING";
    BlockReason["PROOF_REJECTED"] = "PROOF_REJECTED";
    BlockReason["PROOF_REQUESTED"] = "PROOF_REQUESTED";
    BlockReason["PROOF_ANALYZING"] = "PROOF_ANALYZING";
    BlockReason["PROOF_ESCALATED"] = "PROOF_ESCALATED";
    BlockReason["DISPUTE_ACTIVE"] = "DISPUTE_ACTIVE";
    BlockReason["MONEY_STATE_INVALID"] = "MONEY_STATE_INVALID";
    BlockReason["ADMIN_OVERRIDE_REQUIRED"] = "ADMIN_OVERRIDE_REQUIRED";
})(BlockReason || (BlockReason = {}));
export class PayoutEligibilityResolver {
    /**
     * RESOLVE PAYOUT ELIGIBILITY
     *
     * This is the ONLY function that determines if a payout can proceed.
     * StripeMoneyEngine MUST call this before every payout operation.
     */
    static async resolve(taskId, options) {
        const evaluationId = ulid();
        const db = getDb();
        const result = {
            decision: PayoutDecision.BLOCK,
            details: {},
            evaluatedAt: new Date(),
            evaluationId
        };
        try {
            // ============================================================
            // 1. KILLSWITCH CHECK (HIGHEST PRIORITY - NO OVERRIDE)
            // ============================================================
            const killSwitchActive = await KillSwitch.isActive();
            result.details.killSwitchActive = killSwitchActive;
            if (killSwitchActive) {
                result.blockReason = BlockReason.KILLSWITCH_ACTIVE;
                result.reason = 'System frozen - KillSwitch active';
                await this.logDecision(taskId, result);
                return result;
            }
            if (!db) {
                result.blockReason = BlockReason.TASK_NOT_FOUND;
                result.reason = 'Database not initialized';
                return result;
            }
            // ============================================================
            // 2. TASK STATE CHECK
            // ============================================================
            const [task] = await db `
                SELECT id, status, proof_freeze_state 
                FROM tasks 
                WHERE id = ${taskId}::uuid
            `;
            if (!task) {
                result.blockReason = BlockReason.TASK_NOT_FOUND;
                result.reason = 'Task not found';
                await this.logDecision(taskId, result);
                return result;
            }
            result.details.taskState = task.status;
            // Task must be in completed or pending_approval state
            const payableStates = ['completed', 'pending_approval', 'in_progress'];
            if (!payableStates.includes(task.status)) {
                result.blockReason = BlockReason.TASK_NOT_COMPLETED;
                result.reason = `Task in non-payable state: ${task.status}`;
                await this.logDecision(taskId, result);
                return result;
            }
            // ============================================================
            // 3. DISPUTE CHECK (AUTOMATIC BLOCK)
            // ============================================================
            const [activeDispute] = await db `
                SELECT id, status 
                FROM disputes 
                WHERE task_id = ${taskId}::uuid 
                AND status NOT IN ('refunded', 'upheld', 'closed')
                LIMIT 1
            `;
            result.details.disputeActive = !!activeDispute;
            if (activeDispute) {
                // Check for admin override on dispute
                if (options?.adminOverride?.enabled) {
                    result.details.adminOverride = true;
                    // Log but allow - admin takes responsibility
                    logger.warn({
                        taskId,
                        disputeId: activeDispute.id,
                        adminId: options.adminOverride.adminId,
                        overrideReason: options.adminOverride.reason
                    }, 'Admin override: Allowing payout despite active dispute');
                }
                else {
                    result.blockReason = BlockReason.DISPUTE_ACTIVE;
                    result.reason = `Active dispute: ${activeDispute.status}`;
                    await this.logDecision(taskId, result);
                    return result;
                }
            }
            // ============================================================
            // 4. PROOF STATE CHECK (MULTI-LAYER)
            // ============================================================
            // 4a. Check proof freeze service (blocking states)
            const proofBlock = await ProofFreezeService.isPayoutBlocked(taskId);
            if (proofBlock.blocked) {
                // Check for admin override on proof
                if (options?.adminOverride?.enabled) {
                    result.details.adminOverride = true;
                    logger.warn({
                        taskId,
                        proofBlockReason: proofBlock.reason,
                        adminId: options.adminOverride.adminId,
                        overrideReason: options.adminOverride.reason
                    }, 'Admin override: Allowing payout despite proof block');
                }
                else {
                    result.blockReason = BlockReason.PROOF_PENDING;
                    result.reason = proofBlock.reason || 'Proof verification pending';
                    await this.logDecision(taskId, result);
                    return result;
                }
            }
            // 4b. Get proof truth
            const proofTruth = await ProofFreezeService.getProofTruth(taskId);
            result.details.proofState = proofTruth.proofState;
            result.details.hasValidProof = proofTruth.hasValidProof;
            // If proof was required but not verified
            if (!proofTruth.hasValidProof) {
                if (proofTruth.proofState === ProofState.REJECTED) {
                    result.blockReason = BlockReason.PROOF_REJECTED;
                    result.reason = 'Proof was rejected';
                    result.decision = PayoutDecision.ESCALATE;
                    await this.logDecision(taskId, result);
                    return result;
                }
                if (proofTruth.proofState === ProofState.REQUESTED) {
                    result.blockReason = BlockReason.PROOF_REQUESTED;
                    result.reason = 'Proof requested but not submitted';
                    await this.logDecision(taskId, result);
                    return result;
                }
                if (proofTruth.proofState === ProofState.ANALYZING) {
                    result.blockReason = BlockReason.PROOF_ANALYZING;
                    result.reason = 'Proof is being analyzed';
                    await this.logDecision(taskId, result);
                    return result;
                }
                if (proofTruth.proofState === ProofState.ESCALATED) {
                    result.blockReason = BlockReason.PROOF_ESCALATED;
                    result.reason = 'Proof escalated for manual review';
                    result.decision = PayoutDecision.ESCALATE;
                    await this.logDecision(taskId, result);
                    return result;
                }
            }
            // ============================================================
            // 5. MONEY STATE CHECK
            // ============================================================
            const [moneyLock] = await db `
                SELECT current_state, next_allowed_event 
                FROM money_state_lock 
                WHERE task_id = ${taskId}::uuid
            `;
            if (moneyLock) {
                result.details.moneyState = moneyLock.current_state;
                // Money must be in 'held' state to release payout
                if (moneyLock.current_state !== 'held') {
                    // If already released or refunded, block duplicate
                    if (['released', 'refunded', 'completed'].includes(moneyLock.current_state)) {
                        result.blockReason = BlockReason.MONEY_STATE_INVALID;
                        result.reason = `Money already in terminal state: ${moneyLock.current_state}`;
                        await this.logDecision(taskId, result);
                        return result;
                    }
                    // Pending dispute state
                    if (moneyLock.current_state === 'pending_dispute') {
                        result.blockReason = BlockReason.DISPUTE_ACTIVE;
                        result.reason = 'Money frozen in dispute hold';
                        await this.logDecision(taskId, result);
                        return result;
                    }
                }
            }
            // ============================================================
            // ALL CHECKS PASSED → ALLOW
            // ============================================================
            result.decision = PayoutDecision.ALLOW;
            result.reason = 'All eligibility checks passed';
            // Emit metric
            BetaMetricsService.payoutAllowed();
            await this.logDecision(taskId, result);
            return result;
        }
        catch (error) {
            logger.error({ error, taskId }, 'Error evaluating payout eligibility');
            result.blockReason = BlockReason.ADMIN_OVERRIDE_REQUIRED;
            result.reason = `Evaluation error: ${error.message}`;
            result.decision = PayoutDecision.ESCALATE;
            return result;
        }
    }
    /**
     * LOG DECISION TO AUDIT TRAIL
     * Every eligibility decision is recorded for forensics.
     */
    static async logDecision(taskId, result) {
        const db = getDb();
        // Emit metrics based on decision
        if (result.decision === PayoutDecision.BLOCK) {
            BetaMetricsService.payoutBlocked(result.blockReason || 'unknown');
        }
        else if (result.decision === PayoutDecision.ESCALATE) {
            BetaMetricsService.payoutEscalated(result.blockReason || 'unknown');
        }
        // ALLOW is emitted directly in resolve() to avoid double-counting
        if (!db)
            return;
        try {
            await db `
                INSERT INTO payout_eligibility_log (
                    evaluation_id, task_id, decision, block_reason, reason,
                    details, evaluated_at
                ) VALUES (
                    ${result.evaluationId}, ${taskId}::uuid, ${result.decision}, 
                    ${result.blockReason || null}, ${result.reason || null},
                    ${JSON.stringify(result.details)}, ${result.evaluatedAt}
                )
            `;
        }
        catch (error) {
            // Log table might not exist yet - just warn
            logger.warn({ error, taskId }, 'Failed to log eligibility decision - table may not exist');
        }
        logger.info({
            taskId,
            evaluationId: result.evaluationId,
            decision: result.decision,
            blockReason: result.blockReason,
            reason: result.reason
        }, 'Payout eligibility evaluated');
    }
    /**
     * CHECK ADMIN OVERRIDE VALIDITY
     * Validates an admin override before it can be used.
     */
    static validateAdminOverride(override) {
        if (!override.adminId) {
            return { valid: false, error: 'Admin ID required' };
        }
        if (!override.reason) {
            return { valid: false, error: 'Override reason required' };
        }
        if (override.expiresAt && new Date() > override.expiresAt) {
            return { valid: false, error: 'Override has expired' };
        }
        return { valid: true };
    }
}
//# sourceMappingURL=PayoutEligibilityResolver.js.map