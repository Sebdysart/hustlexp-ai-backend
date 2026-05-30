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

interface CreateEscrowParams {
  taskId: string;
  amount: number;
}

interface FundEscrowParams {
  escrowId: string;
  stripePaymentIntentId: string;
}

interface ReleaseEscrowParams {
  escrowId: string;
  stripeTransferId?: string;
  adminOverride?: boolean;
  reason?: string;
}

interface RefundEscrowParams {
  escrowId: string;
  adminOverride?: boolean;
  reason?: string;
}

interface PartialRefundParams {
  escrowId: string;
  workerPercent: number;
  posterPercent: number;
}

const VALID_TRANSITIONS: Record<EscrowState, EscrowState[]> = {
  PENDING: ['FUNDED', 'REFUNDED'],
  FUNDED: ['RELEASED', 'REFUNDED', 'LOCKED_DISPUTE'],
  LOCKED_DISPUTE: ['RELEASED', 'REFUNDED', 'REFUND_PARTIAL'],
  RELEASED: [],
  REFUNDED: [],
  REFUND_PARTIAL: [],
};

function isTerminalState(state: EscrowState): boolean {
  return TERMINAL_ESCROW_STATES.includes(state);
}

function isValidTransition(from: EscrowState, to: EscrowState): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

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
        return { success: false, error: { code: ErrorCodes.NOT_FOUND, message: `Escrow ${escrowId} not found` } };
      }
      return { success: true, data: result.rows[0] };
    } catch (error) {
      return { success: false, error: { code: 'DB_ERROR', message: error instanceof Error ? error.message : 'Unknown error' } };
    }
  },

  getByTaskId: async (taskId: string): Promise<ServiceResult<Escrow>> => {
    try {
      const result = await db.query<Escrow>('SELECT * FROM escrows WHERE task_id = $1', [taskId]);
      if (result.rows.length === 0) {
        return { success: false, error: { code: ErrorCodes.NOT_FOUND, message: `No escrow found for task ${taskId}` } };
      }
      return { success: true, data: result.rows[0] };
    } catch (error) {
      return { success: false, error: { code: 'DB_ERROR', message: error instanceof Error ? error.message : 'Unknown error' } };
    }
  },

  create: async (params: CreateEscrowParams): Promise<ServiceResult<Escrow>> => {
    const { taskId, amount } = params;
    if (!Number.isInteger(amount) || amount <= 0) {
      return { success: false, error: { code: ErrorCodes.INVALID_STATE, message: 'Amount must be a positive integer (cents)' } };
    }
    try {
      const result = await db.query<Escrow>(
        `INSERT INTO escrows (task_id, amount, state) VALUES ($1, $2, 'PENDING') RETURNING *`,
        [taskId, amount]
      );
      return { success: true, data: result.rows[0] };
    } catch (error) {
      if (isUniqueViolation(error)) {
        return { success: false, error: { code: 'DUPLICATE', message: `Escrow already exists for task ${taskId}` } };
      }
      return { success: false, error: { code: 'DB_ERROR', message: error instanceof Error ? error.message : 'Unknown error' } };
    }
  },

  fund: async (params: FundEscrowParams): Promise<ServiceResult<Escrow>> => {
    const { escrowId, stripePaymentIntentId } = params;
    try {
      const txResult = await db.transaction(async (query) => {
        const lockResult = await query<{ state: string; version: number }>(
          `SELECT state, version FROM escrows WHERE id = $1 FOR UPDATE`, [escrowId]
        );
        if (lockResult.rows.length === 0) {
          return { success: false, error: { code: ErrorCodes.NOT_FOUND, message: `Escrow ${escrowId} not found` } } as ServiceResult<Escrow>;
        }
        const { state, version } = lockResult.rows[0];
        if (state !== 'PENDING') {
          return { success: false, error: { code: ErrorCodes.INVALID_STATE, message: `Cannot fund escrow: current state is ${state}, expected PENDING` } } as ServiceResult<Escrow>;
        }
        const result = await query<Escrow>(
          `UPDATE escrows SET state = 'FUNDED', stripe_payment_intent_id = $2, funded_at = NOW(), version = version + 1, updated_at = NOW()
           WHERE id = $1 AND state = 'PENDING' AND version = $3 RETURNING *`,
          [escrowId, stripePaymentIntentId, version]
        );
        if (result.rowCount === 0) {
          return { success: false, error: { code: ErrorCodes.INVALID_STATE, message: `Cannot fund escrow: state changed unexpectedly` } } as ServiceResult<Escrow>;
        }
        return { success: true, data: result.rows[0] } as ServiceResult<Escrow>;
      });
      if (!txResult.success) return txResult;
      await logEscrowEvent(escrowId, 'PENDING', 'FUNDED');
      return txResult;
    } catch (error) {
      return { success: false, error: { code: 'DB_ERROR', message: error instanceof Error ? error.message : 'Unknown error' } };
    }
  },

  release: async (params: ReleaseEscrowParams): Promise<ServiceResult<Escrow>> => {
    const { escrowId, stripeTransferId, adminOverride = false, reason } = params;

    if (!adminOverride && !stripeTransferId) {
      return { success: false, error: { code: ErrorCodes.INVALID_STATE, message: 'stripeTransferId is required to release escrow — create the Stripe transfer first' } };
    }

    let releasedEscrow: Escrow;
    let workerId: string;
    let grossPayoutCents: number;
    let netPayoutCents: number;
    let taskId: string;
    let paymentMethod: string;
    let escrowStateBefore: string;
    let adminManualPayoutRequired = false;

    try {
      const txResult = await db.transaction(async (query) => {
        const escrowResult = await query<{ id: string; task_id: string; amount: number; state: string; version: number }>(
          `SELECT id, task_id, amount, state, version FROM escrows WHERE id = $1 FOR UPDATE`, [escrowId]
        );
        if (escrowResult.rows.length === 0) {
          return { success: false, error: { code: ErrorCodes.NOT_FOUND, message: `Escrow ${escrowId} not found` } } as ServiceResult<Escrow>;
        }
        const escrow = escrowResult.rows[0];

        // GAP-3 FIX: LOCKED_DISPUTE → RELEASED requires adminOverride. Without this
        // guard, any non-admin caller with a valid stripeTransferId could release a
        // disputed escrow, bypassing dispute resolution. Mirrors refund()'s guard.
        if (escrow.state === 'LOCKED_DISPUTE' && !adminOverride) {
          return { success: false, error: { code: ErrorCodes.INVALID_STATE, message: 'Cannot release escrow: state is LOCKED_DISPUTE — admin override required to release a disputed escrow' } } as ServiceResult<Escrow>;
        }

        const taskResult = await query<{ worker_id: string | null; price: number }>(
          `SELECT worker_id, price FROM tasks WHERE id = $1`, [escrow.task_id]
        );
        if (taskResult.rows.length === 0 || !taskResult.rows[0].worker_id) {
          return { success: false, error: { code: ErrorCodes.INVALID_STATE, message: `Task ${escrow.task_id} has no assigned worker` } } as ServiceResult<Escrow>;
        }
        const task = taskResult.rows[0];
        const resolvedWorkerId = task.worker_id!;
        const resolvedPaymentMethod: string = 'escrow';
        const resolvedGross = escrow.amount;

        if (!adminOverride) {
          const workerKycResult = await query<{ payouts_enabled: boolean; stripe_connect_id: string | null; stripe_connect_status: string | null }>(
            `SELECT payouts_enabled, stripe_connect_id, stripe_connect_status FROM users WHERE id = $1`, [resolvedWorkerId]
          );
          if (workerKycResult.rows.length === 0) {
            return { success: false, error: { code: ErrorCodes.NOT_FOUND, message: `Worker ${resolvedWorkerId} not found` } } as ServiceResult<Escrow>;
          }
          const workerKyc = workerKycResult.rows[0];
          if (!workerKyc.stripe_connect_id) {
            return { success: false, error: { code: ErrorCodes.INVALID_STATE, message: `Worker has not set up Stripe Connect — cannot release payout` } } as ServiceResult<Escrow>;
          }
          if (!workerKyc.payouts_enabled) {
            return { success: false, error: { code: ErrorCodes.INVALID_STATE, message: `Worker KYC incomplete — payouts not enabled (status: ${workerKyc.stripe_connect_status ?? 'unknown'})` } } as ServiceResult<Escrow>;
          }
        } else {
          const adminWorkerRow = await query<{ stripe_connect_id: string | null }>(
            `SELECT stripe_connect_id FROM users WHERE id = $1`, [resolvedWorkerId]
          );
          const adminStripeConnectId = adminWorkerRow.rows[0]?.stripe_connect_id ?? null;
          if (!adminStripeConnectId) {
            escrowLogger.error({ workerId: resolvedWorkerId, escrowId, adminOverride: true }, 'CRITICAL: adminOverride release but worker has no stripe_connect_id — manual payout required');
            adminManualPayoutRequired = true;
          }
        }

        const platformFeePercent = Math.min(100, Math.max(0, config.stripe.platformFeePercent ?? 15));
        const platformFeeCents = Math.round(resolvedGross * (platformFeePercent / 100));
        const resolvedNet = resolvedGross - platformFeeCents;

        const result = await query<Escrow>(
          `UPDATE escrows SET state = 'RELEASED', stripe_transfer_id = $2, released_at = NOW(), version = version + 1, updated_at = NOW()
           WHERE id = $1 AND state IN ('FUNDED', 'LOCKED_DISPUTE') AND version = $3 RETURNING *`,
          [escrowId, stripeTransferId ?? null, escrow.version]
        );

        if (result.rowCount === 0) {
          const existing = await EscrowService.getById(escrowId);
          if (!existing.success) return existing;
          if (isTerminalState(existing.data.state)) {
            return { success: false, error: { code: ErrorCodes.ESCROW_TERMINAL, message: `Escrow ${escrowId} is in terminal state ${existing.data.state}` } } as ServiceResult<Escrow>;
          }
          return { success: false, error: { code: ErrorCodes.INVALID_STATE, message: `Cannot release escrow: current state is ${existing.data.state}, expected FUNDED or LOCKED_DISPUTE` } } as ServiceResult<Escrow>;
        }

        workerId = resolvedWorkerId;
        grossPayoutCents = resolvedGross;
        netPayoutCents = resolvedNet;
        taskId = escrow.task_id;
        paymentMethod = resolvedPaymentMethod;
        escrowStateBefore = escrow.state;
        releasedEscrow = result.rows[0];
        return { success: true, data: result.rows[0] } as ServiceResult<Escrow>;
      });

      if (!txResult.success) return txResult;

      await logEscrowEvent(escrowId, escrowStateBefore!, 'RELEASED', undefined, adminOverride ? 'admin' : 'system', {
        ...(adminOverride && reason ? { adminOverride: true, reason } : {}),
        ...(adminManualPayoutRequired ? { admin_manual_payout_required: true } : {}),
      });

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
          metadata: { event: 'escrow_release', adminOverride, ...(adminManualPayoutRequired ? { admin_manual_payout_required: true } : {}) },
        });
      } catch (revenueError) {
        escrowLogger.error({ err: revenueError instanceof Error ? revenueError.message : String(revenueError), workerId, escrowId }, 'Failed to write revenue ledger entry for escrow release — requires manual reconciliation');
      }

      // 2% self-insurance contribution. Gated OFF at the service layer (legal hold);
      // recordContribution returns INSURANCE_DISABLED and this becomes a no-op.
      try {
        const insuranceContributionCents = Math.round(grossPayoutCents * 0.02);
        await SelfInsurancePoolService.recordContribution(taskId!, workerId!, insuranceContributionCents);
      } catch (insuranceError) {
        escrowLogger.warn({ err: insuranceError instanceof Error ? insuranceError.message : String(insuranceError), workerId, escrowId }, 'Failed to record self-insurance contribution — escrow release proceeds');
      }

      await EarnedVerificationUnlockService.recordEarnings(workerId!, taskId!, escrowId, netPayoutCents!);

      if (paymentMethod! === 'offline_cash' || paymentMethod! === 'offline_venmo' || paymentMethod! === 'offline_cashapp') {
        await XPTaxService.recordOfflinePayment(workerId!, taskId!, paymentMethod! as 'offline_cash' | 'offline_venmo' | 'offline_cashapp', grossPayoutCents!);
      }

      const xpAmount = Math.round(grossPayoutCents! / 10);
      try {
        await XPService.awardXP({ userId: workerId!, taskId: taskId!, escrowId, baseXP: xpAmount });
      } catch (xpError) {
        if (xpError instanceof Error && xpError.message.includes('XP-TAX-BLOCK')) {
          escrowLogger.warn({ workerId, err: xpError.message, escrowId }, 'XP blocked by tax trigger');
        } else {
          escrowLogger.error({ err: xpError instanceof Error ? xpError.message : String(xpError), workerId, escrowId }, 'Failed to award XP');
        }
      }

      return { success: true, data: releasedEscrow! };
    } catch (error) {
      if (isInvariantViolation(error)) {
        const dbError = error as { code: string; message: string };
        if (dbError.code === 'HX201') {
          return { success: false, error: { code: ErrorCodes.INV_2_VIOLATION, message: getErrorMessage('HX201'), details: { escrowId } } };
        }
      }
      return { success: false, error: { code: 'DB_ERROR', message: error instanceof Error ? error.message : 'Unknown error' } };
    }
  },

  refund: async (params: RefundEscrowParams): Promise<ServiceResult<Escrow>> => {
    const { escrowId, adminOverride = false, reason } = params;
    let refundedEscrow: Escrow;
    let refundWorkerId: string | null = null;
    let escrowStateBefore: string = 'FUNDED';
    try {
      const txResult = await db.transaction(async (query) => {
        const escrowPreCheck = await query<{ task_id: string; version: number; state: string }>(
          `SELECT task_id, version, state FROM escrows WHERE id = $1 FOR UPDATE`, [escrowId]
        );
        const refundTaskId = escrowPreCheck.rows[0]?.task_id;
        const escrowVersion = escrowPreCheck.rows[0]?.version;
        const currentState = escrowPreCheck.rows[0]?.state;

        if (currentState === 'LOCKED_DISPUTE' && !adminOverride) {
          return { success: false, error: { code: ErrorCodes.INVALID_STATE, message: `Cannot refund escrow: state is LOCKED_DISPUTE — admin override required to refund a disputed escrow` } } as ServiceResult<Escrow>;
        }

        if (refundTaskId) {
          const taskRow = await query<{ worker_id: string | null }>(`SELECT worker_id FROM tasks WHERE id = $1`, [refundTaskId]);
          refundWorkerId = taskRow.rows[0]?.worker_id ?? null;
        }

        const allowedStates = adminOverride ? `'FUNDED', 'LOCKED_DISPUTE'` : `'FUNDED'`;
        const result = await query<Escrow>(
          `UPDATE escrows SET state = 'REFUNDED', refunded_at = NOW(), version = version + 1, updated_at = NOW()
           WHERE id = $1 AND state IN (${allowedStates}) AND version = $2 RETURNING *`,
          [escrowId, escrowVersion]
        );

        if (result.rowCount === 0) {
          const existing = await EscrowService.getById(escrowId);
          if (!existing.success) return existing;
          if (isTerminalState(existing.data.state)) {
            return { success: false, error: { code: ErrorCodes.ESCROW_TERMINAL, message: `Escrow ${escrowId} is in terminal state ${existing.data.state}` } } as ServiceResult<Escrow>;
          }
          return { success: false, error: { code: ErrorCodes.INVALID_STATE, message: `Cannot refund escrow: current state is ${existing.data.state}` } } as ServiceResult<Escrow>;
        }

        escrowStateBefore = currentState ?? 'FUNDED';
        refundedEscrow = result.rows[0];
        return { success: true, data: result.rows[0] } as ServiceResult<Escrow>;
      });

      if (!txResult.success) return txResult;

      await logEscrowEvent(escrowId, escrowStateBefore, 'REFUNDED', undefined, adminOverride ? 'admin' : 'system', adminOverride && reason ? { adminOverride: true, reason } : {});

      if (refundWorkerId) {
        try {
          await XPService.clawbackXP(refundWorkerId, escrowId, 'task_refunded');
        } catch (clawbackError) {
          escrowLogger.error({ err: clawbackError instanceof Error ? clawbackError.message : String(clawbackError), workerId: refundWorkerId, escrowId }, 'XP clawback failed during refund — refund proceeds');
        }
      }

      return { success: true, data: refundedEscrow! };
    } catch (error) {
      return { success: false, error: { code: 'DB_ERROR', message: error instanceof Error ? error.message : 'Unknown error' } };
    }
  },

  lockForDispute: async (escrowId: string, options?: { adminOverride?: boolean }): Promise<ServiceResult<Escrow>> => {
    try {
      return await db.transaction(async (query) => {
        const windowCheck = await query<{ completed_at: Date | null; challenge_window_hours: number | null; version: number }>(
          `SELECT t.completed_at, t.challenge_window_hours, e.version
           FROM escrows e JOIN tasks t ON t.id = e.task_id
           WHERE e.id = $1 FOR UPDATE OF e`,
          [escrowId]
        );

        if (windowCheck.rows.length > 0) {
          const { completed_at, challenge_window_hours } = windowCheck.rows[0];
          if (completed_at == null && !options?.adminOverride) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: 'Cannot dispute a task that has not been completed' });
          }
          if (completed_at != null) {
            const windowMs = (challenge_window_hours ?? 6) * 60 * 60 * 1000;
            const deadlineAt = new Date(new Date(completed_at).getTime() + windowMs);
            if (new Date() > deadlineAt) {
              throw new TRPCError({ code: 'PRECONDITION_FAILED', message: `Dispute window has closed. Tasks must be disputed within ${challenge_window_hours ?? 6} hours of completion.` });
            }
          }
        }

        const escrowVersion = windowCheck.rows[0]?.version;
        const result = await query<Escrow>(
          `UPDATE escrows SET state = 'LOCKED_DISPUTE', version = version + 1, updated_at = NOW()
           WHERE id = $1 AND state = 'FUNDED' AND version = $2 RETURNING *`,
          [escrowId, escrowVersion]
        );

        if (result.rowCount === 0) {
          const existing = await EscrowService.getById(escrowId);
          if (!existing.success) return existing;
          return { success: false, error: { code: ErrorCodes.INVALID_STATE, message: `Cannot lock escrow: current state is ${existing.data.state}, expected FUNDED` } };
        }

        await logEscrowEvent(escrowId, 'FUNDED', 'LOCKED_DISPUTE');
        return { success: true, data: result.rows[0] };
      });
    } catch (error) {
      if (error instanceof TRPCError) throw error;
      return { success: false, error: { code: 'DB_ERROR', message: error instanceof Error ? error.message : 'Unknown error' } };
    }
  },

  partialRefund: async (params: PartialRefundParams): Promise<ServiceResult<Escrow>> => {
    const { escrowId, workerPercent, posterPercent } = params;
    if (workerPercent < 0 || workerPercent > 100 || posterPercent < 0 || posterPercent > 100) {
      return { success: false, error: { code: 'INVALID_PERCENT', message: 'Percentages must be between 0 and 100' } };
    }
    if (workerPercent + posterPercent !== 100) {
      return { success: false, error: { code: ErrorCodes.INVALID_STATE, message: 'Worker and poster percentages must sum to 100' } };
    }
    let partialRefundEscrow: Escrow;
    try {
      const txResult = await db.transaction(async (query) => {
        const lockResult = await query<{ version: number; state: string }>(`SELECT version, state FROM escrows WHERE id = $1 FOR UPDATE`, [escrowId]);
        const escrowVersion = lockResult.rows[0]?.version;
        const result = await query<Escrow>(
          `UPDATE escrows SET state = 'REFUND_PARTIAL', refunded_at = NOW(), version = version + 1, updated_at = NOW()
           WHERE id = $1 AND state = 'LOCKED_DISPUTE' AND version = $2 RETURNING *`,
          [escrowId, escrowVersion]
        );
        if (result.rowCount === 0) {
          const existing = await EscrowService.getById(escrowId);
          if (!existing.success) return existing;
          return { success: false, error: { code: ErrorCodes.INVALID_STATE, message: `Cannot partially refund: current state is ${existing.data.state}, expected LOCKED_DISPUTE` } } as ServiceResult<Escrow>;
        }
        partialRefundEscrow = result.rows[0];
        return { success: true, data: result.rows[0] } as ServiceResult<Escrow>;
      });

      if (!txResult.success) return txResult;

      await logEscrowEvent(escrowId, 'LOCKED_DISPUTE', 'REFUND_PARTIAL');

      if (posterPercent > 0) {
        try {
          const disputeTaskRow = await db.query<{ worker_id: string | null }>(
            `SELECT t.worker_id FROM escrows e JOIN tasks t ON t.id = e.task_id WHERE e.id = $1`, [escrowId]
          );
          const disputeWorkerId = disputeTaskRow.rows[0]?.worker_id ?? null;
          if (disputeWorkerId) {
            const posterFraction = posterPercent / 100;
            await XPService.clawbackXP(disputeWorkerId, escrowId, 'dispute_lost', posterFraction);
          }
        } catch (clawbackError) {
          escrowLogger.error({ err: clawbackError instanceof Error ? clawbackError.message : String(clawbackError), escrowId }, 'XP clawback failed during partialRefund — refund proceeds');
        }
      }

      return { success: true, data: partialRefundEscrow! };
    } catch (error) {
      return { success: false, error: { code: 'DB_ERROR', message: error instanceof Error ? error.message : 'Unknown error' } };
    }
  },

  isTerminalState,
  isValidTransition,
  getValidTransitions: (state: EscrowState) => VALID_TRANSITIONS[state] ?? [],
};

export default EscrowService;
