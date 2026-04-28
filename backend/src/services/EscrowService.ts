/**
 * EscrowService v1.0.0
 * 
 * CONSTITUTIONAL: Enforces INV-2, INV-4
 * 
 * INV-2: Escrow can only be RELEASED if task is COMPLETED
 * INV-4: Escrow amount is immutable after creation
 * 
 * This service does NOT pre-check invariants — it relies on
 * database triggers to enforce them. This is correct architecture:
 * the database is the single source of truth.
 * 
 * @see schema.sql §1.3 (escrows table)
 * @see PRODUCT_SPEC.md §4
 */

import { TRPCError } from '@trpc/server';
import { db, isInvariantViolation, isUniqueViolation, getErrorMessage } from '../db.js';
import { config } from '../config.js';
import { EarnedVerificationUnlockService } from './EarnedVerificationUnlockService.js';
import { XPTaxService } from './XPTaxService.js';
import { XPService } from './XPService.js';
import { SelfInsurancePoolService } from './SelfInsurancePoolService.js';
import { RevenueService } from './RevenueService.js';
import type {
  Escrow,
  EscrowState,
  ServiceResult,
} from '../types.js';
import { TERMINAL_ESCROW_STATES, ErrorCodes } from '../types.js';
import { escrowLogger } from '../logger.js';

// ============================================================================
// TYPES
// ============================================================================

interface CreateEscrowParams {
  taskId: string;
  amount: number; // USD cents
}

interface FundEscrowParams {
  escrowId: string;
  stripePaymentIntentId: string;
}

interface ReleaseEscrowParams {
  escrowId: string;
  stripeTransferId?: string;
  /** When true, skips KYC payouts_enabled gate (admin-override path only). Fee/XP/insurance still run. */
  adminOverride?: boolean;
  /** Reason for admin override — recorded in escrow_events metadata. */
  reason?: string;
}

interface RefundEscrowParams {
  escrowId: string;
  /** When true, allows refunding a LOCKED_DISPUTE escrow (admin override). */
  adminOverride?: boolean;
  /** Optional reason recorded in escrow_events metadata (used with adminOverride). */
  reason?: string;
}

interface PartialRefundParams {
  escrowId: string;
  workerPercent: number;
  posterPercent: number;
}

// ============================================================================
// STATE MACHINE
// ============================================================================

/**
 * Escrow State Transitions (PRODUCT_SPEC §4.2, §4.3)
 *
 * SPEC ALIGNMENT: LOCKED_DISPUTE can transition to RELEASED when dispute
 * is resolved in worker's favor. This was previously blocked.
 */
const VALID_TRANSITIONS: Record<EscrowState, EscrowState[]> = {
  PENDING: ['FUNDED', 'REFUNDED'],
  FUNDED: ['RELEASED', 'REFUNDED', 'LOCKED_DISPUTE'],
  LOCKED_DISPUTE: ['RELEASED', 'REFUNDED', 'REFUND_PARTIAL'], // SPEC FIX: Added RELEASED for worker dispute wins
  RELEASED: [],      // TERMINAL
  REFUNDED: [],      // TERMINAL
  REFUND_PARTIAL: [], // TERMINAL
};

function isTerminalState(state: EscrowState): boolean {
  return TERMINAL_ESCROW_STATES.includes(state);
}

function isValidTransition(from: EscrowState, to: EscrowState): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

// ============================================================================
// SERVICE
// ============================================================================

async function logEscrowEvent(escrowId: string, fromState: string, toState: string, actorId?: string, actorType: string = 'system', metadata: Record<string, unknown> = {}): Promise<void> {
  try {
    await db.query(
      `INSERT INTO escrow_events (escrow_id, from_state, to_state, actor_id, actor_type, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [escrowId, fromState, toState, actorId || null, actorType, JSON.stringify(metadata)]
    );
  } catch (error) {
    escrowLogger.error({ err: error instanceof Error ? error.message : String(error), escrowId }, 'Failed to log escrow event');
  }
}

export const EscrowService = {
  // --------------------------------------------------------------------------
  // READ OPERATIONS
  // --------------------------------------------------------------------------
  
  /**
   * Get escrow by ID
   */
  getById: async (escrowId: string): Promise<ServiceResult<Escrow>> => {
    try {
      const result = await db.query<Escrow>(
        `SELECT e.*, t.poster_id, t.worker_id
         FROM escrows e
         JOIN tasks t ON t.id = e.task_id
         WHERE e.id = $1`,
        [escrowId]
      );
      
      if (result.rows.length === 0) {
        return {
          success: false,
          error: {
            code: ErrorCodes.NOT_FOUND,
            message: `Escrow ${escrowId} not found`,
          },
        };
      }
      
      return { success: true, data: result.rows[0] };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },

  /**
   * Get escrow by task ID
   */
  getByTaskId: async (taskId: string): Promise<ServiceResult<Escrow>> => {
    try {
      const result = await db.query<Escrow>(
        'SELECT * FROM escrows WHERE task_id = $1',
        [taskId]
      );
      
      if (result.rows.length === 0) {
        return {
          success: false,
          error: {
            code: ErrorCodes.NOT_FOUND,
            message: `No escrow found for task ${taskId}`,
          },
        };
      }
      
      return { success: true, data: result.rows[0] };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },

  // --------------------------------------------------------------------------
  // STATE TRANSITIONS
  // --------------------------------------------------------------------------

  /**
   * Create escrow in PENDING state
   */
  create: async (params: CreateEscrowParams): Promise<ServiceResult<Escrow>> => {
    const { taskId, amount } = params;
    
    // Validate amount is positive integer (cents)
    if (!Number.isInteger(amount) || amount <= 0) {
      return {
        success: false,
        error: {
          code: ErrorCodes.INVALID_STATE,
          message: 'Amount must be a positive integer (cents)',
        },
      };
    }
    
    try {
      const result = await db.query<Escrow>(
        `INSERT INTO escrows (task_id, amount, state)
         VALUES ($1, $2, 'PENDING')
         RETURNING *`,
        [taskId, amount]
      );
      
      return { success: true, data: result.rows[0] };
    } catch (error) {
      if (isUniqueViolation(error)) {
        return {
          success: false,
          error: {
            code: 'DUPLICATE',
            message: `Escrow already exists for task ${taskId}`,
          },
        };
      }
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },

  /**
   * Fund escrow: PENDING → FUNDED
   * Called when Stripe payment_intent.succeeded
   *
   * RACE CONDITION FIX: Wrapped in transaction with SELECT FOR UPDATE so the
   * row-level lock is held from the state read through the UPDATE COMMIT.
   * Without the transaction, two concurrent Stripe webhook deliveries for the
   * same payment_intent.succeeded event could both read state='PENDING' and
   * both execute the UPDATE, double-funding the escrow.
   * The AND version = $3 / version = version + 1 guard provides a secondary
   * optimistic-lock safety net: even if two transactions serialise on the same
   * initial version, only the first COMMIT increments the version — the second
   * UPDATE hits version already incremented → 0 rows → clean INVALID_STATE error.
   */
  fund: async (params: FundEscrowParams): Promise<ServiceResult<Escrow>> => {
    const { escrowId, stripePaymentIntentId } = params;

    try {
      const txResult = await db.transaction(async (query) => {
        // Lock the escrow row for the duration of the transaction
        const lockResult = await query<{ state: string; version: number }>(
          `SELECT state, version FROM escrows WHERE id = $1 FOR UPDATE`,
          [escrowId]
        );

        if (lockResult.rows.length === 0) {
          return {
            success: false,
            error: {
              code: ErrorCodes.NOT_FOUND,
              message: `Escrow ${escrowId} not found`,
            },
          } as ServiceResult<Escrow>;
        }

        const { state, version } = lockResult.rows[0];

        if (state !== 'PENDING') {
          return {
            success: false,
            error: {
              code: ErrorCodes.INVALID_STATE,
              message: `Cannot fund escrow: current state is ${state}, expected PENDING`,
            },
          } as ServiceResult<Escrow>;
        }

        const result = await query<Escrow>(
          `UPDATE escrows
           SET state = 'FUNDED',
               stripe_payment_intent_id = $2,
               funded_at = NOW(),
               version = version + 1,
               updated_at = NOW()
           WHERE id = $1
             AND state = 'PENDING'
             AND version = $3
           RETURNING *`,
          [escrowId, stripePaymentIntentId, version]
        );

        if (result.rowCount === 0) {
          return {
            success: false,
            error: {
              code: ErrorCodes.INVALID_STATE,
              message: `Cannot fund escrow: state changed unexpectedly`,
            },
          } as ServiceResult<Escrow>;
        }

        return { success: true, data: result.rows[0] } as ServiceResult<Escrow>;
      });

      if (!txResult.success) {
        return txResult;
      }

      await logEscrowEvent(escrowId, 'PENDING', 'FUNDED');

      return txResult;
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },

  /**
   * Release escrow: FUNDED|LOCKED_DISPUTE → RELEASED
   *
   * SPEC ALIGNMENT (PRODUCT_SPEC §4.3):
   * - FUNDED → RELEASED: Normal task completion
   * - LOCKED_DISPUTE → RELEASED: Dispute resolved in worker's favor
   *
   * INV-2: RELEASED requires COMPLETED task
   * The database trigger enforces this — we catch the error.
   *
   * v1.8.0 Gamification Integration:
   * - Records earnings for verification unlock tracking ($40 threshold)
   * - Records offline payment tax if applicable (10% on cash/Venmo)
   * - Attempts XP award (may be blocked by tax trigger HX201)
   */
  release: async (params: ReleaseEscrowParams): Promise<ServiceResult<Escrow>> => {
    const { escrowId, stripeTransferId, adminOverride = false, reason } = params;

    // FIX 1A: Require stripeTransferId for non-admin releases.
    // Without this guard a poster can mark an escrow as released without
    // having ever created a Stripe transfer, producing a $0 payout.
    if (!adminOverride && !stripeTransferId) {
      return {
        success: false,
        error: {
          code: ErrorCodes.INVALID_STATE,
          message: 'stripeTransferId is required to release escrow — create the Stripe transfer first',
        },
      };
    }

    // Variables populated inside the transaction, used by post-commit side effects
    let releasedEscrow: Escrow;
    let workerId: string | undefined;
    let grossPayoutCents: number | undefined;
    let netPayoutCents: number;
    let taskId: string;
    let paymentMethod: string;
    let escrowStateBefore: string;
    let adminManualPayoutRequired = false;

    try {
      // RACE CONDITION FIX: Wrap the entire read-check-write sequence in a
      // transaction. SELECT FOR UPDATE acquires a row-level lock and holds it
      // until COMMIT/ROLLBACK. Without the transaction wrapper, db.query()
      // releases the connection (and the lock) immediately after the SELECT,
      // so two concurrent calls could both pass the state check and both UPDATE.
      const txResult = await db.transaction(async (query) => {
        // 1. Lock the escrow row for the duration of the transaction
        const escrowResult = await query<{
          id: string;
          task_id: string;
          amount: number;
          state: string;
          version: number;
        }>(
          `SELECT id, task_id, amount, state, version FROM escrows WHERE id = $1 FOR UPDATE`,
          [escrowId]
        );

        if (escrowResult.rows.length === 0) {
          return {
            success: false,
            error: {
              code: ErrorCodes.NOT_FOUND,
              message: `Escrow ${escrowId} not found`,
            },
          } as ServiceResult<Escrow>;
        }

        const escrow = escrowResult.rows[0];

        // Get task details for worker_id and price
        const taskResult = await query<{
          worker_id: string | null;
          price: number;
        }>(
          `SELECT worker_id, price FROM tasks WHERE id = $1`,
          [escrow.task_id]
        );

        if (taskResult.rows.length === 0 || !taskResult.rows[0].worker_id) {
          return {
            success: false,
            error: {
              code: ErrorCodes.INVALID_STATE,
              message: `Task ${escrow.task_id} has no assigned worker`,
            },
          } as ServiceResult<Escrow>;
        }

        const task = taskResult.rows[0];
        const resolvedWorkerId = task.worker_id!;
        const resolvedPaymentMethod: string = 'escrow';
        const resolvedGross = escrow.amount;

        // KYC GATE: Verify worker has Stripe Connect set up before releasing funds.
        // Note: payouts_enabled is verified live by Stripe's transfer API itself —
        // if KYC is incomplete, the transfer will fail with a clear error from Stripe.
        if (!adminOverride) {
          const workerKycResult = await query<{
            stripe_connect_id: string | null;
          }>(
            `SELECT stripe_connect_id FROM users WHERE id = $1`,
            [resolvedWorkerId]
          );

          if (workerKycResult.rows.length === 0) {
            return {
              success: false,
              error: {
                code: ErrorCodes.NOT_FOUND,
                message: `Worker ${resolvedWorkerId} not found`,
              },
            } as ServiceResult<Escrow>;
          }

          if (!workerKycResult.rows[0].stripe_connect_id) {
            return {
              success: false,
              error: {
                code: ErrorCodes.INVALID_STATE,
                message: `Worker has not set up Stripe Connect — cannot release payout`,
              },
            } as ServiceResult<Escrow>;
          }
        } else {
          // FIX 3: adminOverride skips the KYC gate above, but we still need to
          // know whether the worker has a Stripe Connect account so ops can be
          // alerted when a manual payout is required.
          const adminWorkerRow = await query<{ stripe_connect_id: string | null }>(
            `SELECT stripe_connect_id FROM users WHERE id = $1`,
            [resolvedWorkerId]
          );
          const adminStripeConnectId = adminWorkerRow.rows[0]?.stripe_connect_id ?? null;
          if (!adminStripeConnectId) {
            // Worker has no Stripe Connect account — money cannot be transferred
            // automatically. Log a CRITICAL warning so ops acts promptly.
            escrowLogger.error(
              { workerId: resolvedWorkerId, escrowId, adminOverride: true },
              'CRITICAL: adminOverride release but worker has no stripe_connect_id — manual payout required'
            );
            // Stash flag in the metadata object so logEscrowEvent records it
            // and ops tooling can surface it for reconciliation.
            adminManualPayoutRequired = true;
          }
        }

        // Calculate platform fee (from config - default 15%)
        // SECURITY FIX (v2.9.3): Clamp to [0, 100] — a negative env var must not
        // produce a negative fee (which would overpay the worker).
        const platformFeePercent = Math.min(100, Math.max(0, config.stripe.platformFeePercent ?? 15));
        const platformFeeCents = Math.round(resolvedGross * (platformFeePercent / 100));
        const resolvedNet = resolvedGross - platformFeeCents;

        // 2. Release escrow (SPEC FIX: Allow release from both FUNDED and LOCKED_DISPUTE states)
        // The version = $3 optimistic-lock guard is a secondary safety net: if somehow
        // two transactions serialise on the same version (e.g. after a retry), the
        // second UPDATE hits version already incremented → 0 rows → clean error.
        const result = await query<Escrow>(
          `UPDATE escrows
           SET state = 'RELEASED',
               stripe_transfer_id = $2,
               released_at = NOW(),
               version = version + 1,
               updated_at = NOW()
           WHERE id = $1
             AND state IN ('FUNDED', 'LOCKED_DISPUTE')
             AND version = $3
           RETURNING *`,
          [escrowId, stripeTransferId ?? null, escrow.version]
        );

        if (result.rowCount === 0) {
          const existing = await EscrowService.getById(escrowId);
          if (!existing.success) {
            return existing;
          }

          if (isTerminalState(existing.data.state)) {
            return {
              success: false,
              error: {
                code: ErrorCodes.ESCROW_TERMINAL,
                message: `Escrow ${escrowId} is in terminal state ${existing.data.state}`,
              },
            } as ServiceResult<Escrow>;
          }

          return {
            success: false,
            error: {
              code: ErrorCodes.INVALID_STATE,
              message: `Cannot release escrow: current state is ${existing.data.state}, expected FUNDED or LOCKED_DISPUTE`,
            },
          } as ServiceResult<Escrow>;
        }

        // Capture for post-commit side effects
        workerId = resolvedWorkerId;
        grossPayoutCents = resolvedGross;
        netPayoutCents = resolvedNet;
        taskId = escrow.task_id;
        paymentMethod = resolvedPaymentMethod;
        escrowStateBefore = escrow.state;
        releasedEscrow = result.rows[0];

        return { success: true, data: result.rows[0] } as ServiceResult<Escrow>;
      });

      if (!txResult.success) {
        return txResult;
      }

      await logEscrowEvent(
        escrowId,
        escrowStateBefore!,
        'RELEASED',
        undefined,
        adminOverride ? 'admin' : 'system',
        {
          ...(adminOverride && reason ? { adminOverride: true, reason } : {}),
          ...(adminManualPayoutRequired ? { admin_manual_payout_required: true } : {}),
        }
      );

      // FIX 1B: Write revenue ledger entry for this escrow payout.
      // Previously no ledger entry was created on escrow release, making P&L
      // unreconcilable.  platform_fee is the correct event type — it captures
      // the full financial decomposition (gross, fee, net) per RevenueService v2 spec.
      try {
        const platformFeePercent = Math.min(100, Math.max(0, config.stripe.platformFeePercent ?? 15));
        const platformFeeCents = Math.round(grossPayoutCents! * (platformFeePercent / 100));
        await RevenueService.logEvent({
          eventType: 'platform_fee',
          userId: workerId!,
          taskId: taskId!,
          amountCents: platformFeeCents,
          grossAmountCents: grossPayoutCents!,
          platformFeeCents,
          netAmountCents: netPayoutCents!,
          feeBasisPoints: Math.round(platformFeePercent * 100),
          escrowId,
          stripeTransferId: stripeTransferId ?? undefined,
          metadata: {
            event: 'escrow_release',
            adminOverride,
            ...(adminManualPayoutRequired ? { admin_manual_payout_required: true } : {}),
          },
        });
      } catch (revenueError) {
        // Non-fatal: ledger write failure must not block payout confirmation.
        // Ops can backfill from escrow_events table if needed.
        escrowLogger.error(
          { err: revenueError instanceof Error ? revenueError.message : String(revenueError), workerId, escrowId },
          'Failed to write revenue ledger entry for escrow release — requires manual reconciliation'
        );
      }

      // v1.x: Record 2% self-insurance contribution from worker earnings
      try {
        const insuranceContributionCents = Math.round(grossPayoutCents! * 0.02);
        await SelfInsurancePoolService.recordContribution(
          taskId!,
          workerId!,
          insuranceContributionCents,
        );
      } catch (insuranceError) {
        // Non-fatal: pool contribution failure must not block payout
        escrowLogger.warn(
          { err: insuranceError instanceof Error ? insuranceError.message : String(insuranceError), workerId, escrowId },
          'Failed to record self-insurance contribution — escrow release proceeds'
        );
      }

      // 3. v1.8.0: Record earnings for verification unlock tracking
      // This is idempotent via UNIQUE constraint on escrow_id
      await EarnedVerificationUnlockService.recordEarnings(
        workerId!,
        taskId!,
        escrowId,
        netPayoutCents!
      );

      // 4. v1.8.0: Handle offline payment tax if applicable
      if (paymentMethod! === 'offline_cash' || paymentMethod! === 'offline_venmo' || paymentMethod! === 'offline_cashapp') {
        await XPTaxService.recordOfflinePayment(
          workerId!,
          taskId!,
          paymentMethod! as 'offline_cash' | 'offline_venmo' | 'offline_cashapp',
          grossPayoutCents!
        );
      }

      // 5. v1.8.0: Attempt to award XP (may be blocked by tax trigger)
      // XP award formula: price / 10 (e.g., $50 task = 500 XP)
      const xpAmount = Math.round(grossPayoutCents! / 10);
      try {
        await XPService.awardXP({ userId: workerId!, taskId: taskId!, escrowId, baseXP: xpAmount });
      } catch (xpError) {
        // Check if XP was blocked by tax trigger (HX201)
        if (xpError instanceof Error && xpError.message.includes('XP-TAX-BLOCK')) {
          escrowLogger.warn(
            { workerId, err: xpError.message, escrowId },
            'XP blocked by tax trigger'
          );
          // Continue - escrow is released, but XP is held back until tax paid
        } else {
          // Unexpected XP error - log but don't fail escrow release
          escrowLogger.error(
            { err: xpError instanceof Error ? xpError.message : String(xpError), workerId, escrowId },
            'Failed to award XP'
          );
        }
      }

      return { success: true, data: releasedEscrow! };
    } catch (error) {
      // Check for INV-2 violation from trigger
      if (isInvariantViolation(error)) {
        const dbError = error as { code: string; message: string };
        if (dbError.code === 'HX201') {
          return {
            success: false,
            error: {
              code: ErrorCodes.INV_2_VIOLATION,
              message: getErrorMessage('HX201'),
              details: { escrowId },
            },
          };
        }
      }

      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },

  /**
   * Refund escrow: FUNDED → REFUNDED (or LOCKED_DISPUTE → REFUNDED with adminOverride)
   *
   * SECURITY FIX (v2.9.3): LOCKED_DISPUTE is NOT allowed for poster-initiated
   * refunds. A poster cannot call refund() while a worker's dispute is active.
   * LOCKED_DISPUTE escrows can only be refunded via adminOverride=true (the admin
   * force_refund path), ensuring dispute resolution logic is never bypassed without
   * explicit admin intent.
   */
  refund: async (params: RefundEscrowParams): Promise<ServiceResult<Escrow>> => {
    const { escrowId, adminOverride = false, reason } = params;

    let refundedEscrow: Escrow;
    let refundWorkerId: string | null = null;
    let escrowStateBefore: string = 'FUNDED';

    try {
      // RACE CONDITION FIX: Wrap SELECT FOR UPDATE + UPDATE in a transaction so
      // the row-level lock is held from SELECT through COMMIT. Without the
      // transaction wrapper, db.query() releases the connection (and the lock)
      // immediately after the SELECT, allowing a concurrent refund() to slip
      // through and trigger a double-refund.
      const txResult = await db.transaction(async (query) => {
        const escrowPreCheck = await query<{ task_id: string; version: number; state: string }>(
          `SELECT task_id, version, state FROM escrows WHERE id = $1 FOR UPDATE`,
          [escrowId]
        );
        const refundTaskId = escrowPreCheck.rows[0]?.task_id;
        const escrowVersion = escrowPreCheck.rows[0]?.version;
        const currentState = escrowPreCheck.rows[0]?.state;

        // Guard: LOCKED_DISPUTE refund requires adminOverride
        if (currentState === 'LOCKED_DISPUTE' && !adminOverride) {
          return {
            success: false,
            error: {
              code: ErrorCodes.INVALID_STATE,
              message: `Cannot refund escrow: state is LOCKED_DISPUTE — admin override required to refund a disputed escrow`,
            },
          } as ServiceResult<Escrow>;
        }

        if (refundTaskId) {
          const taskRow = await query<{ worker_id: string | null }>(
            `SELECT worker_id FROM tasks WHERE id = $1`,
            [refundTaskId]
          );
          refundWorkerId = taskRow.rows[0]?.worker_id ?? null;
        }

        // Allow FUNDED → REFUNDED normally; LOCKED_DISPUTE → REFUNDED only with adminOverride
        const allowedStates = adminOverride ? `'FUNDED', 'LOCKED_DISPUTE'` : `'FUNDED'`;

        const result = await query<Escrow>(
          `UPDATE escrows
           SET state = 'REFUNDED',
               refunded_at = NOW(),
               version = version + 1,
               updated_at = NOW()
           WHERE id = $1
             AND state IN (${allowedStates})
             AND version = $2
           RETURNING *`,
          [escrowId, escrowVersion]
        );

        if (result.rowCount === 0) {
          const existing = await EscrowService.getById(escrowId);
          if (!existing.success) {
            return existing;
          }

          if (isTerminalState(existing.data.state)) {
            return {
              success: false,
              error: {
                code: ErrorCodes.ESCROW_TERMINAL,
                message: `Escrow ${escrowId} is in terminal state ${existing.data.state}`,
              },
            } as ServiceResult<Escrow>;
          }

          return {
            success: false,
            error: {
              code: ErrorCodes.INVALID_STATE,
              message: `Cannot refund escrow: current state is ${existing.data.state}`,
            },
          } as ServiceResult<Escrow>;
        }

        escrowStateBefore = currentState ?? 'FUNDED';
        refundedEscrow = result.rows[0];
        return { success: true, data: result.rows[0] } as ServiceResult<Escrow>;
      });

      if (!txResult.success) {
        return txResult;
      }

      await logEscrowEvent(
        escrowId,
        escrowStateBefore,
        'REFUNDED',
        undefined,
        adminOverride ? 'admin' : 'system',
        adminOverride && reason ? { adminOverride: true, reason } : {}
      );

      // FIX 3: Clawback XP if the worker had already been awarded XP for this escrow
      if (refundWorkerId) {
        try {
          await XPService.clawbackXP(refundWorkerId, escrowId, 'task_refunded');
        } catch (clawbackError) {
          // Non-fatal: clawback failure must not block the refund
          escrowLogger.error(
            { err: clawbackError instanceof Error ? clawbackError.message : String(clawbackError), workerId: refundWorkerId, escrowId },
            'XP clawback failed during refund — refund proceeds'
          );
        }
      }

      return { success: true, data: refundedEscrow! };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },

  /**
   * Lock for dispute: FUNDED → LOCKED_DISPUTE
   *
   * FIX 5: Enforces challenge_window_hours. A poster cannot file a dispute after
   * the challenge window (measured from task.completed_at) has elapsed.
   */
  lockForDispute: async (escrowId: string, options?: { adminOverride?: boolean }): Promise<ServiceResult<Escrow>> => {
    try {
      // RACE CONDITION FIX: Entire check + update wrapped in a transaction so the
      // FOR UPDATE row-level lock is held from SELECT through COMMIT. Without the
      // transaction, a concurrent release() could transition the escrow to RELEASED
      // between the window check and the UPDATE, causing a stale-read bug.
      return await db.transaction(async (query) => {
        const windowCheck = await query<{
          completed_at: Date | null;
          challenge_window_hours: number | null;
          version: number;
        }>(
          `SELECT t.completed_at, t.challenge_window_hours, e.version
           FROM escrows e
           JOIN tasks t ON t.id = e.task_id
           WHERE e.id = $1
           FOR UPDATE OF e`,
          [escrowId]
        );

        if (windowCheck.rows.length > 0) {
          const { completed_at, challenge_window_hours } = windowCheck.rows[0];

          // SECURITY FIX (v2.9.3): A dispute may only be filed on a completed task.
          // Previously, null completed_at silently skipped the window guard, allowing
          // any authenticated user to lock an in-progress task's escrow indefinitely.
          // REG-5 FIX: adminOverride bypasses this check so admins can lock mid-task
          // escrows for fraud investigation (completed_at=null).
          if (completed_at == null && !options?.adminOverride) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'Cannot dispute a task that has not been completed',
            });
          }

          // Only enforce challenge window when the task has a completion timestamp.
          // If completed_at is null and adminOverride=true, skip the window check entirely.
          if (completed_at != null) {
            const windowMs = (challenge_window_hours ?? 6) * 60 * 60 * 1000;
            const deadlineAt = new Date(new Date(completed_at).getTime() + windowMs);
            if (new Date() > deadlineAt) {
              throw new TRPCError({
                code: 'PRECONDITION_FAILED',
                message: `Dispute window has closed. Tasks must be disputed within ${challenge_window_hours ?? 6} hours of completion.`,
              });
            }
          }
        }

        const escrowVersion = windowCheck.rows[0]?.version;
        const result = await query<Escrow>(
          `UPDATE escrows
           SET state = 'LOCKED_DISPUTE',
               version = version + 1,
               updated_at = NOW()
           WHERE id = $1
             AND state = 'FUNDED'
             AND version = $2
           RETURNING *`,
          [escrowId, escrowVersion]
        );

        if (result.rowCount === 0) {
          const existing = await EscrowService.getById(escrowId);
          if (!existing.success) {
            return existing;
          }

          return {
            success: false,
            error: {
              code: ErrorCodes.INVALID_STATE,
              message: `Cannot lock escrow: current state is ${existing.data.state}, expected FUNDED`,
            },
          };
        }

        await logEscrowEvent(escrowId, 'FUNDED', 'LOCKED_DISPUTE');

        return { success: true, data: result.rows[0] };
      });
    } catch (error) {
      // Re-throw TRPCErrors (e.g. challenge window PRECONDITION_FAILED) — do not swallow
      if (error instanceof TRPCError) {
        throw error;
      }
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },

  /**
   * Partial refund: LOCKED_DISPUTE → REFUND_PARTIAL
   */
  partialRefund: async (params: PartialRefundParams): Promise<ServiceResult<Escrow>> => {
    const { escrowId, workerPercent, posterPercent } = params;
    
    // Validate percentages
    if (workerPercent < 0 || workerPercent > 100 || posterPercent < 0 || posterPercent > 100) {
      return {
        success: false,
        error: {
          code: 'INVALID_PERCENT',
          message: 'Percentages must be between 0 and 100',
        },
      };
    }
    if (workerPercent + posterPercent !== 100) {
      return {
        success: false,
        error: {
          code: ErrorCodes.INVALID_STATE,
          message: 'Worker and poster percentages must sum to 100',
        },
      };
    }
    
    let partialRefundEscrow: Escrow;

    try {
      // RACE CONDITION FIX: Wrap SELECT FOR UPDATE + UPDATE in a transaction.
      // Without the transaction, the FOR UPDATE lock is released as soon as the
      // SELECT completes, allowing two admin callers to both see
      // state='LOCKED_DISPUTE' and both execute the UPDATE on the same escrow.
      const txResult = await db.transaction(async (query) => {
        const lockResult = await query<{ version: number; state: string }>(
          `SELECT version, state FROM escrows WHERE id = $1 FOR UPDATE`,
          [escrowId]
        );
        const escrowVersion = lockResult.rows[0]?.version;

        const result = await query<Escrow>(
          `UPDATE escrows
           SET state = 'REFUND_PARTIAL',
               refunded_at = NOW(),
               version = version + 1,
               updated_at = NOW()
           WHERE id = $1
             AND state = 'LOCKED_DISPUTE'
             AND version = $2
           RETURNING *`,
          [escrowId, escrowVersion]
        );

        if (result.rowCount === 0) {
          const existing = await EscrowService.getById(escrowId);
          if (!existing.success) {
            return existing;
          }

          return {
            success: false,
            error: {
              code: ErrorCodes.INVALID_STATE,
              message: `Cannot partially refund: current state is ${existing.data.state}, expected LOCKED_DISPUTE`,
            },
          } as ServiceResult<Escrow>;
        }

        partialRefundEscrow = result.rows[0];
        return { success: true, data: result.rows[0] } as ServiceResult<Escrow>;
      });

      if (!txResult.success) {
        return txResult;
      }

      await logEscrowEvent(escrowId, 'LOCKED_DISPUTE', 'REFUND_PARTIAL');

      // FIX 3: Clawback XP when dispute resolves against the worker (posterPercent > 0)
      if (posterPercent > 0) {
        try {
          const disputeTaskRow = await db.query<{ worker_id: string | null }>(
            `SELECT t.worker_id FROM escrows e JOIN tasks t ON t.id = e.task_id WHERE e.id = $1`,
            [escrowId]
          );
          const disputeWorkerId = disputeTaskRow.rows[0]?.worker_id ?? null;
          if (disputeWorkerId) {
            const posterFraction = posterPercent / 100;
            await XPService.clawbackXP(disputeWorkerId, escrowId, 'dispute_lost', posterFraction);
          }
        } catch (clawbackError) {
          // Non-fatal: clawback failure must not block the partial refund
          escrowLogger.error(
            { err: clawbackError instanceof Error ? clawbackError.message : String(clawbackError), escrowId },
            'XP clawback failed during partialRefund — refund proceeds'
          );
        }
      }

      return { success: true, data: partialRefundEscrow! };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },

  // --------------------------------------------------------------------------
  // HELPERS
  // --------------------------------------------------------------------------

  isTerminalState,
  isValidTransition,
  getValidTransitions: (state: EscrowState) => VALID_TRANSITIONS[state] ?? [],
};

export default EscrowService;
