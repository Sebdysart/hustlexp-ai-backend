/**
 * ESCROW STATE MACHINE (BUILD_GUIDE Phase 2)
 *
 * Implements the escrow lifecycle state machine from BUILD_GUIDE.
 *
 * STATES:
 * - PENDING: Awaiting payment
 * - FUNDED: Payment captured, held in escrow
 * - LOCKED_DISPUTE: Funds frozen during dispute
 * - RELEASED: Funds transferred to hustler (terminal)
 * - REFUNDED: Funds returned to client (terminal)
 * - PARTIAL_REFUND: Split between parties (terminal)
 *
 * INVARIANTS ENFORCED:
 * - INV-4: Amount immutable after creation
 * - INV-1: XP only awarded after RELEASED
 * - Terminal states immutable
 *
 * @version 1.0.0 (BUILD_GUIDE aligned)
 */
import { getSql } from '../db/index.js';
import { createLogger } from '../utils/logger.js';
import { awardXPForTask } from './AtomicXPService.js';
const logger = createLogger('EscrowStateMachine');
export const TERMINAL_ESCROW_STATES = ['released', 'refunded', 'partial_refund'];
// ============================================================================
// VALID TRANSITIONS (FROM BUILD_GUIDE)
// ============================================================================
export const ESCROW_TRANSITIONS = {
    pending: ['funded', 'refunded'],
    funded: ['released', 'refunded', 'locked_dispute'],
    locked_dispute: ['released', 'refunded', 'partial_refund'],
    released: [], // Terminal
    refunded: [], // Terminal
    partial_refund: [], // Terminal
};
// ============================================================================
// STATE MACHINE CLASS
// ============================================================================
class EscrowStateMachineClass {
    /**
     * Check if a transition is valid
     */
    canTransition(from, to) {
        const validTargets = ESCROW_TRANSITIONS[from] || [];
        return validTargets.includes(to);
    }
    /**
     * Execute a state transition
     */
    async transition(taskId, targetState, context = {}) {
        const sql = getSql();
        try {
            // Get current state from money_state_lock
            const [lock] = await sql `
        SELECT task_id, current_state, amount_cents
        FROM money_state_lock
        WHERE task_id = ${taskId}
      `;
            if (!lock) {
                // Create initial lock if not exists
                if (targetState === 'pending') {
                    await sql `
            INSERT INTO money_state_lock (task_id, current_state, amount_cents, updated_at)
            SELECT ${taskId}, 'pending', price * 100, NOW()
            FROM tasks WHERE id = ${taskId}
          `;
                    return {
                        success: true,
                        previousState: 'pending',
                        newState: 'pending',
                    };
                }
                return {
                    success: false,
                    previousState: 'pending',
                    newState: 'pending',
                    error: 'Money state lock not found',
                };
            }
            const currentState = lock.current_state;
            // Check if terminal
            if (TERMINAL_ESCROW_STATES.includes(currentState)) {
                return {
                    success: false,
                    previousState: currentState,
                    newState: currentState,
                    error: `Cannot modify escrow in terminal state: ${currentState}`,
                };
            }
            // Check if transition is valid
            if (!this.canTransition(currentState, targetState)) {
                return {
                    success: false,
                    previousState: currentState,
                    newState: currentState,
                    error: `Invalid escrow transition: ${currentState} → ${targetState}`,
                };
            }
            // Execute transition
            await sql `
        UPDATE money_state_lock
        SET 
          current_state = ${targetState},
          ${targetState === 'funded' && context.stripePaymentIntentId
                ? sql `stripe_payment_intent_id = ${context.stripePaymentIntentId},`
                : sql ``}
          ${targetState === 'released' && context.stripeTransferId
                ? sql `stripe_transfer_id = ${context.stripeTransferId},`
                : sql ``}
          updated_at = NOW()
        WHERE task_id = ${taskId}
      `;
            // Log transition
            await sql `
        INSERT INTO escrow_state_log (task_id, from_state, to_state, context, created_at)
        VALUES (${taskId}, ${currentState}, ${targetState}, ${JSON.stringify(context)}, NOW())
      `;
            let xpAwarded = 0;
            // INV-1: Award XP when released
            if (targetState === 'released') {
                const [task] = await sql `
          SELECT assigned_to FROM tasks WHERE id = ${taskId}
        `;
                if (task?.assigned_to) {
                    const xpResult = await awardXPForTask(taskId, task.assigned_to);
                    if (xpResult.success) {
                        xpAwarded = xpResult.xpAwarded;
                        logger.info({ taskId, xpAwarded }, 'XP awarded on escrow release');
                    }
                }
            }
            logger.info({
                taskId,
                from: currentState,
                to: targetState,
                context,
                xpAwarded,
            }, 'Escrow state transition successful');
            return {
                success: true,
                previousState: currentState,
                newState: targetState,
                xpAwarded,
            };
        }
        catch (error) {
            logger.error({ error, taskId, targetState }, 'Escrow state transition failed');
            return {
                success: false,
                previousState: 'pending',
                newState: 'pending',
                error: error.message,
            };
        }
    }
    /**
     * Get current escrow state
     */
    async getState(taskId) {
        const sql = getSql();
        const [lock] = await sql `
      SELECT current_state FROM money_state_lock WHERE task_id = ${taskId}
    `;
        return lock?.current_state || null;
    }
    /**
     * Initialize escrow for a task (create money_state_lock)
     */
    async initialize(taskId, amountCents) {
        const sql = getSql();
        try {
            await sql `
        INSERT INTO money_state_lock (task_id, current_state, amount_cents, updated_at)
        VALUES (${taskId}, 'pending', ${amountCents}, NOW())
        ON CONFLICT (task_id) DO NOTHING
      `;
            return true;
        }
        catch (error) {
            logger.error({ error, taskId }, 'Failed to initialize escrow');
            return false;
        }
    }
    /**
     * Get escrow details
     */
    async getDetails(taskId) {
        const sql = getSql();
        const [lock] = await sql `
      SELECT current_state, amount_cents, stripe_payment_intent_id, stripe_transfer_id, updated_at
      FROM money_state_lock
      WHERE task_id = ${taskId}
    `;
        if (!lock)
            return null;
        return {
            state: lock.current_state,
            amountCents: lock.amount_cents,
            stripePaymentIntentId: lock.stripe_payment_intent_id,
            stripeTransferId: lock.stripe_transfer_id,
            updatedAt: new Date(lock.updated_at),
        };
    }
}
export const EscrowStateMachine = new EscrowStateMachineClass();
//# sourceMappingURL=EscrowStateMachine.js.map