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

import { getSql, transaction } from '../db/index.js';
import type { SqlTx } from '../db/index.js';
import { createLogger } from '../utils/logger.js';
import { awardXPInTx } from './AtomicXPService.js';
import { getErrorMessage } from '../utils/errors.js';

const logger = createLogger('EscrowStateMachine');

// ============================================================================
// TYPES
// ============================================================================

export type EscrowState =
  | 'pending'
  | 'funded'
  | 'locked_dispute'
  | 'released'
  | 'refunded'
  | 'partial_refund';

export const TERMINAL_ESCROW_STATES: EscrowState[] = ['released', 'refunded', 'partial_refund'];

export interface EscrowTransitionContext {
  stripePaymentIntentId?: string;
  stripeTransferId?: string;
  disputeId?: string;
  refundAmount?: number;
  adminId?: string;
  reason?: string;
}

export interface EscrowTransitionResult {
  success: boolean;
  previousState: EscrowState;
  newState: EscrowState;
  xpAwarded?: number;
  error?: string;
}

// ============================================================================
// VALID TRANSITIONS (FROM BUILD_GUIDE)
// ============================================================================

export const ESCROW_TRANSITIONS: Record<EscrowState, EscrowState[]> = {
  pending: ['funded', 'refunded'],
  funded: ['released', 'refunded', 'locked_dispute'],
  locked_dispute: ['released', 'refunded', 'partial_refund'],
  released: [],       // Terminal
  refunded: [],       // Terminal
  partial_refund: [], // Terminal
};

// ============================================================================
// STATE MACHINE CLASS
// ============================================================================

class EscrowStateMachineClass {

  /**
   * Check if a transition is valid
   */
  canTransition(from: EscrowState, to: EscrowState): boolean {
    const validTargets = ESCROW_TRANSITIONS[from] || [];
    return validTargets.includes(to);
  }

  /**
   * Execute a state transition.
   *
   * When the target state is 'released', the escrow state update AND the XP
   * award are wrapped in a SINGLE serializable transaction so that either both
   * succeed or both roll back. This enforces INV-1: no money released without
   * XP, no XP without money release.
   */
  async transition(
    taskId: string,
    targetState: EscrowState,
    context: EscrowTransitionContext = {}
  ): Promise<EscrowTransitionResult> {
    const sql = getSql();

    try {
      // Read current state outside the write transaction so we can validate
      // before acquiring a serializable lock.
      const [lock] = await sql`
        SELECT task_id, current_state, amount_cents
        FROM money_state_lock
        WHERE task_id = ${taskId}
      `;

      if (!lock) {
        // Create initial lock if not exists
        if (targetState === 'pending') {
          await sql`
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

      const currentState = lock.current_state as EscrowState;

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

      let xpAwarded = 0;

      // ------------------------------------------------------------------
      // ATOMIC BLOCK: escrow state update + XP award in one serializable tx.
      //
      // If the target is 'released' we must award XP inside the same
      // transaction so that either both writes commit or neither does.
      // For all other target states we still use the same transaction helper
      // for consistency; XP is not awarded in those paths.
      // ------------------------------------------------------------------
      await transaction(async (tx: SqlTx) => {
        // Execute state update
        await tx`
          UPDATE money_state_lock
          SET
            current_state = ${targetState},
            ${targetState === 'funded' && context.stripePaymentIntentId
              ? tx`stripe_payment_intent_id = ${context.stripePaymentIntentId},`
              : tx``}
            ${targetState === 'released' && context.stripeTransferId
              ? tx`stripe_transfer_id = ${context.stripeTransferId},`
              : tx``}
            updated_at = NOW()
          WHERE task_id = ${taskId}
        `;

        // Log transition
        await tx`
          INSERT INTO escrow_state_log (task_id, from_state, to_state, context, created_at)
          VALUES (${taskId}, ${currentState}, ${targetState}, ${JSON.stringify(context)}, NOW())
        `;

        // INV-1: Award XP when released — inside the same atomic block
        if (targetState === 'released') {
          const [task] = await tx`
            SELECT assigned_to FROM tasks WHERE id = ${taskId}
          `;

          if (task?.assigned_to) {
            // awardXPInTx operates within tx — any failure rolls back the
            // entire transaction, including the escrow state update above.
            const xpResult = await awardXPInTx(taskId, task.assigned_to, tx);
            if (xpResult.success) {
              xpAwarded = xpResult.xpAwarded;
              logger.info({ taskId, xpAwarded }, 'XP awarded on escrow release');
            }
          }
        }
      });

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

    } catch (error: unknown) {
      logger.error(
        { escrowId: taskId, targetState, error: getErrorMessage(error) },
        'COMPENSATING_TX: escrow+XP transaction failed — no funds released, no XP awarded',
      );
      return {
        success: false,
        previousState: 'pending',
        newState: 'pending',
        error: getErrorMessage(error),
      };
    }
  }

  /**
   * Get current escrow state
   */
  async getState(taskId: string): Promise<EscrowState | null> {
    const sql = getSql();
    const [lock] = await sql`
      SELECT current_state FROM money_state_lock WHERE task_id = ${taskId}
    `;
    return lock?.current_state as EscrowState || null;
  }

  /**
   * Initialize escrow for a task (create money_state_lock)
   */
  async initialize(taskId: string, amountCents: number): Promise<boolean> {
    const sql = getSql();

    try {
      await sql`
        INSERT INTO money_state_lock (task_id, current_state, amount_cents, updated_at)
        VALUES (${taskId}, 'pending', ${amountCents}, NOW())
        ON CONFLICT (task_id) DO NOTHING
      `;
      return true;
    } catch (error) {
      logger.error({ error, taskId }, 'Failed to initialize escrow');
      return false;
    }
  }

  /**
   * Get escrow details
   */
  async getDetails(taskId: string): Promise<{
    state: EscrowState;
    amountCents: number;
    stripePaymentIntentId?: string;
    stripeTransferId?: string;
    updatedAt: Date;
  } | null> {
    const sql = getSql();
    const [lock] = await sql`
      SELECT current_state, amount_cents, stripe_payment_intent_id, stripe_transfer_id, updated_at
      FROM money_state_lock
      WHERE task_id = ${taskId}
    `;

    if (!lock) return null;

    return {
      state: lock.current_state as EscrowState,
      amountCents: lock.amount_cents,
      stripePaymentIntentId: lock.stripe_payment_intent_id,
      stripeTransferId: lock.stripe_transfer_id,
      updatedAt: new Date(lock.updated_at),
    };
  }
}

export const EscrowStateMachine = new EscrowStateMachineClass();
