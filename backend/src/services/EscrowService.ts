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
import type { QueryFn } from '../db.js';
import { config } from '../config.js';
import { computeFeeBreakdown, computePlatformFeeCents, clampFeePercent, computeInsuranceContributionCents, feeBasisPoints } from '../lib/money.js';
import { EarnedVerificationUnlockService } from './EarnedVerificationUnlockService.js';
import { XPTaxService } from './XPTaxService.js';
import { XPService } from './XPService.js';
import { SelfInsurancePoolService } from './SelfInsurancePoolService.js';
import { RevenueService } from './RevenueService.js';
import { StripeService } from './StripeService.js';
import { notifyAdmins } from './AdminNotificationHelper.js';
import {
  LocalCertificationPayoutProvider,
  localCertificationPayoutEnabled,
} from './LocalCertificationPayoutProvider.js';
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
  /** Explicit TEST-only provider transfer. Never accepted for production tasks. */
  localTestTransferId?: string;
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

async function logEscrowEvent(escrowId: string, fromState: string, toState: string, actorId?: string, actorType: string = 'system', metadata: Record<string, unknown> = {}, idempotencyKey?: string): Promise<void> {
  try {
    await db.query(
      `INSERT INTO escrow_events (escrow_id, from_state, to_state, actor_id, actor_type, metadata, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
      [escrowId, fromState, toState, actorId || null, actorType, JSON.stringify(metadata), idempotencyKey ?? null]
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
      escrowLogger.error({ err: error instanceof Error ? error.message : String(error) }, 'EscrowService DB error');
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: 'A database error occurred. Please try again.',
        },
      };
    }
  },

  /**
   * Get escrow by task ID
   * R-14 FIX: JOIN tasks so poster_id/worker_id are included in one query,
   * eliminating the need for a second EscrowService.getById() call in the router
   * for authorization checks.
   */
  getByTaskId: async (taskId: string): Promise<ServiceResult<Escrow>> => {
    try {
      const result = await db.query<Escrow>(
        `SELECT e.*, t.poster_id, t.worker_id
         FROM escrows e
         JOIN tasks t ON t.id = e.task_id
         WHERE e.task_id = $1`,
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
      escrowLogger.error({ err: error instanceof Error ? error.message : String(error) }, 'EscrowService DB error');
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: 'A database error occurred. Please try again.',
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
      escrowLogger.error({ err: error instanceof Error ? error.message : String(error) }, 'EscrowService DB error');
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: 'A database error occurred. Please try again.',
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
  /**
   * Sync a PENDING escrow's amount to a changed task price.
   *
   * AUDIT FIX M1 (2026-06-11): DynamicPricingService previously issued a raw
   * `UPDATE escrows SET amount` — escrow mutations must be owned by
   * EscrowService so invariants live in one place. PENDING-only by design:
   * a FUNDED escrow's amount is what Stripe actually captured (the HX004
   * trigger also blocks post-funding amount changes at the DB).
   *
   * INV-1/INV-5: amount must be a positive integer in cents.
   * Accepts an optional transaction executor so callers already holding a
   * lock on the task row (e.g. the ASAP bump transaction) keep atomicity.
   */
  syncPendingAmount: async (
    taskId: string,
    newAmountCents: number,
    q?: QueryFn
  ): Promise<ServiceResult<{ updated: boolean }>> => {
    if (!Number.isInteger(newAmountCents) || newAmountCents <= 0) {
      return {
        success: false,
        error: {
          code: ErrorCodes.INVALID_STATE,
          message: 'Escrow amount must be a positive integer (cents)',
        },
      };
    }
    const exec: QueryFn = q ?? db.query;
    const result = await exec(
      `UPDATE escrows SET amount = $1 WHERE task_id = $2 AND state = 'PENDING'`,
      [newAmountCents, taskId]
    );
    return { success: true, data: { updated: (result.rowCount ?? 0) > 0 } };
  },

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

        // TOCTOU FIX: Check that this PI is not already linked to a *different* escrow.
        // This query runs inside the transaction after acquiring the FOR UPDATE row lock,
        // so two concurrent fund() calls for different escrows with the same PI cannot
        // both pass this check before either commits.
        const piConflictResult = await query<{ id: string }>(
          `SELECT id FROM escrows WHERE stripe_payment_intent_id = $1 AND id != $2`,
          [stripePaymentIntentId, escrowId]
        );
        if (piConflictResult.rows.length > 0) {
          return {
            success: false,
            error: {
              code: ErrorCodes.INVALID_STATE,
              message: `Payment intent ${stripePaymentIntentId} is already linked to a different escrow`,
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
      escrowLogger.error({ err: error instanceof Error ? error.message : String(error) }, 'EscrowService DB error');
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: 'A database error occurred. Please try again.',
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
    const {
      escrowId,
      stripeTransferId,
      localTestTransferId,
      adminOverride = false,
      reason,
    } = params;

    if (adminOverride && !reason?.trim()) {
      return {
        success: false,
        error: {
          code: ErrorCodes.INVALID_INPUT,
          message: 'Admin escrow release requires an attributable reason',
        },
      };
    }

    // FIX 1A: Require stripeTransferId for non-admin releases.
    // Without this guard a poster can mark an escrow as released without
    // having ever created a Stripe transfer, producing a $0 payout.
    if (!adminOverride && Boolean(stripeTransferId) === Boolean(localTestTransferId)) {
      return {
        success: false,
        error: {
          code: ErrorCodes.INVALID_STATE,
          message: 'Exactly one verified payout-provider transfer is required to release escrow',
        },
      };
    }
    if (localTestTransferId && !localCertificationPayoutEnabled()) {
      return {
        success: false,
        error: {
          code: ErrorCodes.INVALID_STATE,
          message: 'Local certification payouts are disabled',
        },
      };
    }

    // PR3 (return-threading): post-commit side-effect values are RETURNED from the
    // transaction's success result and destructured below the success gate, so the
    // compiler can prove they are assigned — no `!` assertions, no sentinel defaults.
    type ReleasePost = {
      workerId: string;
      grossPayoutCents: number;
      netPayoutCents: number;
      platformFeeCents: number;
      platformFeePercent: number;
      insuranceContributionCents: number; // F-22: recorded post-commit via recordContribution
      taskId: string;
      paymentMethod: string;
      escrowStateBefore: string;
      adminManualPayoutRequired: boolean;
      posterId: string | null; // F-23: poster (the payer) is attributed the platform fee
      payoutProvider: 'STRIPE' | 'LOCAL_CERTIFICATION_TEST' | 'MANUAL_RECONCILIATION';
      providerTransferId: string | null;
    };
    // `post` is optional so the existing `as ServiceResult<Escrow>` failure-arm casts
    // below remain valid without modification; it is always present on the success path.
    type ReleaseTxResult =
      | Extract<ServiceResult<Escrow>, { success: false }>
      | { success: true; data: Escrow; post?: ReleasePost };

    try {
      // RACE CONDITION FIX: Wrap the entire read-check-write sequence in a
      // transaction. SELECT FOR UPDATE acquires a row-level lock and holds it
      // until COMMIT/ROLLBACK. Without the transaction wrapper, db.query()
      // releases the connection (and the lock) immediately after the SELECT,
      // so two concurrent calls could both pass the state check and both UPDATE.
      const txResult = await db.transaction<ReleaseTxResult>(async (query) => {
        // F-01/F-03: tracks whether an adminOverride release needs a manual payout
        // (worker has no Stripe Connect account). Closure-scoped; threaded out via `post`.
        let adminManualPayoutRequired = false;
        // 1. Lock the escrow row for the duration of the transaction
        const escrowResult = await query<{
          id: string;
          task_id: string;
          amount: number;
          platform_fee_cents: number | null;
          state: string;
          version: number;
          stripe_transfer_id: string | null;
        }>(
          `SELECT id, task_id, amount, platform_fee_cents, state, version,
                  stripe_transfer_id
           FROM escrows WHERE id = $1 FOR UPDATE`,
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

        // A dispute lock is a real payout hold. The ordinary release path may
        // continue only after an authoritative dispute decision resolves in the
        // worker's favour. Administrators use the separately authorized and
        // audited override route, which is marked transaction-locally for the
        // database trigger and requires a reason at the service boundary.
        if (escrow.state === 'LOCKED_DISPUTE') {
          if (adminOverride) {
            await query(
              `SELECT set_config('hustlexp.dispute_release_override', 'true', true)`,
            );
          } else {
            const resolvedDispute = await query<{ resolved_dispute_id: string }>(
              `SELECT id::text AS resolved_dispute_id
               FROM disputes
               WHERE escrow_id = $1
                 AND state = 'RESOLVED'
                 AND outcome_escrow_action = 'RELEASE'
               ORDER BY resolved_at DESC NULLS LAST, id DESC
               LIMIT 1`,
              [escrowId],
            );
            if (!resolvedDispute.rows[0]?.resolved_dispute_id) {
              return {
                success: false,
                error: {
                  code: ErrorCodes.INVALID_STATE,
                  message: 'Cannot release dispute-locked escrow without a resolved worker-favor dispute',
                },
              } as ServiceResult<Escrow>;
            }
          }
        }

        // Get task details for worker_id, price, payment_method, and poster_id.
        // F-23: poster_id is needed so the admin_override platform_fee is attributed
        // to the poster (the payer), matching every other platform_fee call site.
        const taskResult = await query<{
          worker_id: string | null;
          price: number;
          payment_method: string | null;
          poster_id: string | null;
          automation_classification: string | null;
          hustler_payout_cents: number | null;
          platform_margin_cents: number | null;
        }>(
          `SELECT worker_id, price, payment_method, poster_id,
                  automation_classification, hustler_payout_cents,
                  platform_margin_cents
           FROM tasks WHERE id = $1`,
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
        const resolvedPaymentMethod: string = task.payment_method ?? 'escrow';
        const resolvedGross = escrow.amount;
        // F-23: prefer poster attribution for the platform fee; worker fallback applied at use site.
        const resolvedPosterId = task.poster_id ?? null;

        // Calculate the immutable release economics before provider validation so
        // every provider must prove the exact same gross/fee/insurance/net split.
        const configuredFeePercent = clampFeePercent(config.stripe.platformFeePercent);
        const breakdown = computeFeeBreakdown(
          resolvedGross,
          configuredFeePercent,
          escrow.platform_fee_cents,
        );
        const {
          platformFeeCents,
          insuranceContributionCents: txInsuranceContributionCents,
          netPayoutCents: resolvedNet,
        } = breakdown;
        const platformFeePercent = feeBasisPoints(resolvedGross, platformFeeCents) / 100;
        const resolvedStripeTransferId = stripeTransferId ?? escrow.stripe_transfer_id;
        const payoutProvider: ReleasePost['payoutProvider'] = localTestTransferId
          ? 'LOCAL_CERTIFICATION_TEST'
          : resolvedStripeTransferId
            ? 'STRIPE'
            : 'MANUAL_RECONCILIATION';
        const providerTransferId = localTestTransferId ?? resolvedStripeTransferId ?? null;
        const providerTransferStatus = payoutProvider === 'LOCAL_CERTIFICATION_TEST'
          ? 'paid'
          : payoutProvider === 'STRIPE'
            ? 'submitted'
            : 'manual_reconciliation';

        // Provider gate: a local TEST transfer is accepted only for a completed
        // CONTROLLED_TEST task and only when its provider ledger proves the exact
        // worker, task, escrow, and net amount. Every other ordinary release
        // retains the Stripe Connect KYC gate.
        if (localTestTransferId) {
          if (task.automation_classification !== 'CONTROLLED_TEST') {
            return {
              success: false,
              error: {
                code: ErrorCodes.INVALID_STATE,
                message: 'Local certification payout cannot release a production-classified task',
              },
            } as ServiceResult<Escrow>;
          }
          const verified = await LocalCertificationPayoutProvider.verifyPaidTransfer(query, {
            transferId: localTestTransferId,
            taskId: escrow.task_id,
            escrowId,
            workerId: resolvedWorkerId,
            amountCents: resolvedNet,
          });
          if (!verified) {
            return {
              success: false,
              error: {
                code: ErrorCodes.INVALID_STATE,
                message: 'Local certification payout is not provider-confirmed for the exact net amount',
              },
            } as ServiceResult<Escrow>;
          }
        } else if (!adminOverride) {
          const workerKycResult = await query<{
            payouts_enabled: boolean;
            stripe_connect_id: string | null;
            stripe_connect_status: string | null;
          }>(
            `SELECT payouts_enabled, stripe_connect_id, stripe_connect_status FROM users WHERE id = $1`,
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

          const workerKyc = workerKycResult.rows[0];

          if (!workerKyc.stripe_connect_id) {
            return {
              success: false,
              error: {
                code: ErrorCodes.INVALID_STATE,
                message: `Worker has not set up Stripe Connect — cannot release payout`,
              },
            } as ServiceResult<Escrow>;
          }

          if (!workerKyc.payouts_enabled) {
            return {
              success: false,
              error: {
                code: ErrorCodes.INVALID_STATE,
                message: `Worker KYC incomplete — payouts not enabled (status: ${workerKyc.stripe_connect_status ?? 'unknown'})`,
              },
            } as ServiceResult<Escrow>;
          }
        } else {
          // An admin override without existing provider transfer evidence is a
          // manual reconciliation state. It is never labeled paid merely because
          // the escrow state moved to RELEASED.
          const adminWorkerRow = await query<{ stripe_connect_id: string | null }>(
            `SELECT stripe_connect_id FROM users WHERE id = $1`,
            [resolvedWorkerId]
          );
          const adminStripeConnectId = adminWorkerRow.rows[0]?.stripe_connect_id ?? null;
          if (!resolvedStripeTransferId) {
            // Worker has no Stripe Connect account — money cannot be transferred
            // automatically. Log a CRITICAL warning so ops acts promptly.
            escrowLogger.error(
              { workerId: resolvedWorkerId, escrowId, adminOverride: true, hasStripeAccount: Boolean(adminStripeConnectId) },
              'CRITICAL: adminOverride release lacks provider transfer evidence — manual payout reconciliation required'
            );
            // Stash flag in the metadata object so logEscrowEvent records it
            // and ops tooling can surface it for reconciliation.
            adminManualPayoutRequired = true;
          }
        }

        // 2. Release escrow. LOCKED_DISPUTE reached this statement only through
        // a resolved worker-favor dispute or an attributable administrator override.
        // The version = $3 optimistic-lock guard is a secondary safety net: if somehow
        // two transactions serialise on the same version (e.g. after a retry), the
        // second UPDATE hits version already incremented → 0 rows → clean error.
        const result = await query<Escrow>(
          `UPDATE escrows
           SET state = 'RELEASED',
               stripe_transfer_id = $2,
               payout_provider = $4,
               provider_transfer_id = $5,
               provider_transfer_status = $6,
               provider_transfer_paid_at = CASE WHEN $6 = 'paid' THEN NOW() ELSE NULL END,
               released_at = NOW(),
               version = version + 1,
               updated_at = NOW()
           WHERE id = $1
             AND state IN ('FUNDED', 'LOCKED_DISPUTE')
             AND version = $3
           RETURNING *`,
          [
            escrowId,
            payoutProvider === 'STRIPE' ? resolvedStripeTransferId : null,
            escrow.version,
            payoutProvider,
            providerTransferId,
            providerTransferStatus,
          ]
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
              message: `Cannot release escrow: current state is ${existing.data.state}, expected FUNDED or an authorized resolved dispute`,
            },
          } as ServiceResult<Escrow>;
        }

        // PR3: return post-commit captures from the transaction success result
        // (return-threading) so they are provably assigned below the success gate.
        return {
          success: true,
          data: result.rows[0],
          post: {
            workerId: resolvedWorkerId,
            grossPayoutCents: resolvedGross,
            netPayoutCents: resolvedNet,
            platformFeeCents,
            platformFeePercent,
            insuranceContributionCents: txInsuranceContributionCents, // F-22
            taskId: escrow.task_id,
            paymentMethod: resolvedPaymentMethod,
            escrowStateBefore: escrow.state,
            adminManualPayoutRequired,
            posterId: resolvedPosterId,
            payoutProvider,
            providerTransferId,
          },
        };
      });

      if (!txResult.success) {
        return txResult;
      }

      const { post } = txResult;
      if (!post) {
        // Unreachable: the transaction always returns `post` on the success path.
        // This guard lets the compiler prove the captures are present without a
        // non-null assertion.
        escrowLogger.error({ escrowId }, 'release: post-commit captures missing after successful transaction');
        return {
          success: false,
          error: { code: 'DB_ERROR', message: 'Internal error finalizing escrow release' },
        };
      }
      const {
        workerId,
        grossPayoutCents,
        netPayoutCents,
        platformFeeCents,
        platformFeePercent,
        insuranceContributionCents,
        taskId,
        paymentMethod,
        escrowStateBefore,
        adminManualPayoutRequired,
        posterId,
        payoutProvider,
        providerTransferId,
      } = post;
      const releasedEscrow = txResult.data;

      await logEscrowEvent(
        escrowId,
        escrowStateBefore,
        'RELEASED',
        undefined,
        adminOverride ? 'admin' : 'system',
        {
          ...(adminOverride && reason ? { adminOverride: true, reason } : {}),
          ...(adminManualPayoutRequired ? { admin_manual_payout_required: true } : {}),
          payout_provider: payoutProvider,
          provider_transfer_id: providerTransferId,
          provider_transfer_status: payoutProvider === 'LOCAL_CERTIFICATION_TEST'
            ? 'paid'
            : payoutProvider === 'STRIPE'
              ? 'submitted'
              : 'manual_reconciliation',
        },
        `escrow.released:${escrowId}`
      );

      // F-10 FIX: Do NOT log platform_fee here for normal (non-admin-override) releases.
      // The platform_fee revenue ledger row MUST only be written by the payment-worker's
      // handleTransferCreated() handler, which has the real Stripe transfer event ID
      // (stripeEventId). That handler uses an idempotency guard of:
      //   SELECT id FROM revenue_ledger WHERE stripe_event_id = $1 AND event_type = 'platform_fee'
      // If we wrote a row here with stripe_event_id = NULL, that guard would never find
      // it and would insert a second platform_fee row — every escrow release would be
      // double-counted in the revenue ledger.
      //
      // EXCEPTIONS: manual reconciliation and LOCAL_CERTIFICATION_TEST releases
      // never emit a Stripe transfer webhook. Record the platform margin here;
      // the one-platform-fee-per-escrow unique index is the durable replay guard.
      if ((adminOverride && adminManualPayoutRequired) || payoutProvider === 'LOCAL_CERTIFICATION_TEST') {
        // F-06 FIX: Skip RevenueService.logEvent when platformFeeCents rounds to 0.
        // RevenueService has a POSITIVE_ONLY_EVENTS guard that silently rejects
        // amountCents <= 0. For tiny escrows (e.g. 1 cent * 15% = 0 after rounding),
        // calling logEvent wastes a DB round-trip and emits a misleading error log.
        if (!platformFeeCents || platformFeeCents <= 0) {
          escrowLogger.warn(
            { escrowId, platformFeeCents: platformFeeCents ?? 0, grossPayoutCents },
            'F-06: Skipping platform_fee ledger entry for admin_override_release — fee rounds to 0 cents'
          );
        } else {
          try {
            await RevenueService.logEvent({
              eventType: 'platform_fee',
              userId: posterId ?? workerId, // F-23: attribute the platform fee to the poster (payer), worker fallback
              taskId: taskId!,
              amountCents: platformFeeCents,
              grossAmountCents: grossPayoutCents!,
              platformFeeCents: platformFeeCents,
              // Revenue decomposition separates the quoted Hustler share from
              // the separately disclosed self-insurance adjustment.
              netAmountCents: payoutProvider === 'LOCAL_CERTIFICATION_TEST'
                ? grossPayoutCents! - platformFeeCents
                : netPayoutCents!,
              feeBasisPoints: Math.round(platformFeePercent! * 100),
              escrowId,
              metadata: payoutProvider === 'LOCAL_CERTIFICATION_TEST'
                ? {
                    event: 'local_certification_test_release',
                    payout_provider: payoutProvider,
                    provider_transfer_id: providerTransferId,
                    is_test: true,
                  }
                : { event: 'admin_override_release', admin_manual_payout_required: true },
            });
          } catch (feeLogErr) {
            escrowLogger.error(
              { err: feeLogErr instanceof Error ? feeLogErr.message : String(feeLogErr), escrowId },
              'F-01: Failed to log platform_fee for admin_override_release — manual reconciliation required'
            );
          }
        }
      }
      //
      // The release event itself is captured in escrow_events via logEscrowEvent above.
      // The payment-worker's handleTransferCreated() is the single authoritative source
      // for the platform_fee ledger entry on normal releases, ensuring idempotency via stripe_event_id.

      // v1.x: Record 2% self-insurance contribution from worker earnings
      // F-22 FIX: Use the insuranceContributionCents captured from the transaction
      // (same value that was deducted from the Stripe transfer amount) so what is
      // recorded in the pool exactly matches what was withheld.
      try {
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
          // Unexpected XP error — escrow release still succeeds, but the worker
          // did not receive XP. Logged at WARN so ops can detect the gap.
          // The worker may retry via the manual escrow.awardXP endpoint.
          escrowLogger.warn(
            { err: xpError instanceof Error ? xpError.message : String(xpError), workerId, escrowId },
            'Auto-award XP failed after escrow release — worker can retry via escrow.awardXP'
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

      escrowLogger.error({ err: error instanceof Error ? error.message : String(error) }, 'EscrowService DB error');
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: 'A database error occurred. Please try again.',
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
    let stripePaymentIntentId: string | null = null;
    let stripeRefundId: string | null = null;
    let stripeTransferId: string | null = null;
    let refundAmount: number = 0;
    let allowedStates: string[];

    try {
      // -----------------------------------------------------------------------
      // Transaction 1 (read + validate): acquire FOR UPDATE lock, validate
      // state and task guards, capture all values needed for the Stripe call.
      // Does NOT commit any state change — escrow remains FUNDED after T1.
      // -----------------------------------------------------------------------
      const readResult = await db.transaction(async (query) => {
        const escrowPreCheck = await query<{ task_id: string; version: number; state: string; stripe_payment_intent_id: string | null; stripe_refund_id: string | null; stripe_transfer_id: string | null; amount: number }>(
          `SELECT task_id, version, state, stripe_payment_intent_id, stripe_refund_id, stripe_transfer_id, amount FROM escrows WHERE id = $1 FOR UPDATE`,
          [escrowId]
        );

        if (escrowPreCheck.rows.length === 0) {
          return {
            success: false,
            error: { code: ErrorCodes.NOT_FOUND, message: `Escrow ${escrowId} not found` },
          } as ServiceResult<Escrow>;
        }

        const refundTaskId = escrowPreCheck.rows[0]?.task_id;
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
          // LL4: Check task state inside the transaction (FOR UPDATE lock held) to
          // eliminate the TOCTOU race window. A refund is blocked if a worker has
          // already been assigned (task is ACCEPTED, IN_PROGRESS, PROOF_SUBMITTED,
          // or COMPLETED) — the router pre-check was removed in favour of this
          // in-transaction guard.
          const taskRow = await query<{ worker_id: string | null; state: string }>(
            `SELECT worker_id, state FROM tasks WHERE id = $1`,
            [refundTaskId]
          );
          refundWorkerId = taskRow.rows[0]?.worker_id ?? null;
          const taskState = taskRow.rows[0]?.state;
          const workerAssignedStates = ['ACCEPTED', 'MATCHING', 'IN_PROGRESS', 'PROOF_SUBMITTED', 'COMPLETED'];
          if (taskState && workerAssignedStates.includes(taskState)) {
            return {
              success: false,
              error: {
                code: ErrorCodes.INVALID_STATE,
                message: 'Cannot refund escrow for a task that has been accepted by a worker',
              },
            } as ServiceResult<Escrow>;
          }
        }

        // Capture values for Stripe call and T2
        escrowStateBefore = currentState ?? 'FUNDED';
        stripePaymentIntentId = escrowPreCheck.rows[0]?.stripe_payment_intent_id ?? null;
        stripeRefundId = escrowPreCheck.rows[0]?.stripe_refund_id ?? null;
        stripeTransferId = escrowPreCheck.rows[0]?.stripe_transfer_id ?? null;
        refundAmount = escrowPreCheck.rows[0]?.amount ?? 0;
        allowedStates = adminOverride ? ['FUNDED', 'LOCKED_DISPUTE', 'RELEASED'] : ['FUNDED'];

        return { success: true } as unknown as ServiceResult<Escrow>;
      });

      if (!readResult.success) {
        return readResult;
      }

      // -----------------------------------------------------------------------
      // F-2 FIX: Transfer reversal — must happen BEFORE the Stripe refund.
      // If the escrow is RELEASED (adminOverride path) and a transfer was already
      // sent to the worker (stripe_transfer_id is set), clawback the transfer first.
      // If the reversal fails, abort — do not issue the refund and create a
      // double-spend where the worker keeps the funds AND the poster is refunded.
      // -----------------------------------------------------------------------
      if (adminOverride && escrowStateBefore === 'RELEASED' && stripeTransferId) {
        const reversalResult = await StripeService.createTransferReversal(stripeTransferId, escrowId);
        if (!reversalResult.success) {
          return {
            success: false,
            error: {
              code: 'STRIPE_REVERSAL_FAILED',
              message: `Admin force-refund aborted: transfer reversal for transfer ${stripeTransferId} failed — ${reversalResult.error.message}. Refund not issued to prevent double-spend.`,
            },
          };
        }
        escrowLogger.info(
          { escrowId, stripeTransferId, reversalId: reversalResult.data.reversalId },
          'Admin force-refund: transfer reversal succeeded — proceeding with poster refund'
        );
      }

      // -----------------------------------------------------------------------
      // F59-5 FIX: Admin refund on RELEASED escrow where transfer was manually paid
      // (stripeTransferId is null). The transfer-reversal block above is skipped
      // (no transfer ID), but the escrow was marked RELEASED — meaning the worker
      // was paid via the adminManualPayoutRequired path. Issuing a Stripe refund
      // to the poster here would return money that the worker already received
      // without any corresponding clawback. Ops must handle this case manually.
      // -----------------------------------------------------------------------
      if (adminOverride && escrowStateBefore === 'RELEASED' && !stripeTransferId) {
        return {
          success: false,
          error: {
            code: 'MANUAL_PAYOUT_CANNOT_REFUND',
            message: 'Cannot refund a manually-paid RELEASED escrow — worker clawback must be handled manually',
          },
        };
      }

      // -----------------------------------------------------------------------
      // F-05 FIX: Admin refund on RELEASED escrow with no stripe_payment_intent_id.
      // When adminOverride=true and the escrow is RELEASED but has no PI on record,
      // there is nothing to refund in Stripe. Silently marking as REFUNDED would
      // return money that was never held — ops must handle this manually.
      // -----------------------------------------------------------------------
      if (adminOverride && escrowStateBefore === 'RELEASED' && !stripePaymentIntentId) {
        return {
          success: false,
          error: {
            code: 'MISSING_STRIPE_PI',
            message: 'Cannot refund: no Stripe payment intent on record — manual refund required',
          },
        };
      }

      // -----------------------------------------------------------------------
      // Stripe call: issue BEFORE committing DB state to REFUNDED.
      // If Stripe throws, the escrow remains FUNDED and the caller can retry.
      // Idempotency: if stripe_refund_id is already set, a prior attempt
      // succeeded — skip the Stripe call and proceed directly to T2.
      // -----------------------------------------------------------------------
      if (stripePaymentIntentId && !stripeRefundId) {
        // Fatal: rethrow so the caller retries while escrow is still FUNDED.
        const refundResult = await StripeService.createRefund({
          paymentIntentId: stripePaymentIntentId,
          escrowId,
          amount: refundAmount,
          reason: 'requested_by_customer',
          // F-1 FIX: Use 'svc_refund' suffix to distinguish service-layer refunds
          // from escrow-action-worker refunds ('wkr_refund'). Without distinct suffixes,
          // both paths share the same Stripe idempotency key and one silently no-ops.
          idempotencyKeySuffix: adminOverride ? 'admin_override' : 'svc_refund',
        });
        if (!refundResult.success) {
          throw new Error(`Stripe refund failed — ${refundResult.error.message}`);
        }
        stripeRefundId = refundResult.data?.refundId ?? null;
      }

      // -----------------------------------------------------------------------
      // Transaction 2 (terminalize): atomically commit state = REFUNDED and
      // persist the stripe_refund_id. Only runs after the Stripe call succeeds.
      // F-05 FIX: Add SELECT FOR UPDATE NOWAIT before the UPDATE so we re-read
      // the current version under an exclusive lock. T1 committed and released its
      // lock; between T1 and T2 any concurrent operation can increment the version,
      // making a stale T1 version snapshot miss the UPDATE (0 rows) even though
      // the Stripe refund already succeeded. Mirroring the partialRefund T2 pattern.
      // -----------------------------------------------------------------------
      const termResult = await db.transaction(async (query) => {
        // Step 1: Acquire exclusive lock and re-read current version + state
        let lockedRefundRow: { id: string; version: number; state: string } | undefined;
        try {
          const lockedResult = await query<{ id: string; version: number; state: string }>(
            `SELECT id, version, state FROM escrows WHERE id = $1 FOR UPDATE NOWAIT`,
            [escrowId]
          );
          if (!lockedResult.rows.length) {
            return {
              success: false,
              error: { code: ErrorCodes.NOT_FOUND, message: `Escrow ${escrowId} not found during T2 lock` },
            } as ServiceResult<Escrow>;
          }
          lockedRefundRow = lockedResult.rows[0];
        } catch (lockErr) {
          const msg = lockErr instanceof Error ? lockErr.message : String(lockErr);
          if (msg.includes('55P03') || msg.toLowerCase().includes('could not obtain lock')) {
            throw new Error(`LOCK_CONTENTION: Another worker is processing this escrow refund — will retry`);
          }
          throw lockErr;
        }

        // Step 2: If state changed away from an allowed state, return appropriate error
        if (!allowedStates!.includes(lockedRefundRow.state)) {
          if (lockedRefundRow.state === 'REFUNDED') {
            // Already refunded — idempotent
            const existing = await EscrowService.getById(escrowId);
            if (existing.success) {
              refundedEscrow = existing.data;
              return { success: true, data: existing.data } as ServiceResult<Escrow>;
            }
          }
          return {
            success: false,
            error: {
              code: isTerminalState(lockedRefundRow.state as EscrowState) ? ErrorCodes.ESCROW_TERMINAL : ErrorCodes.INVALID_STATE,
              message: `Cannot refund escrow: state changed to ${lockedRefundRow.state} between T1 and T2`,
            },
          } as ServiceResult<Escrow>;
        }

        // Step 3: UPDATE using the freshly-locked version (not the stale T1 snapshot)
        const result = await query<Escrow>(
          `UPDATE escrows
           SET state = 'REFUNDED',
               refunded_at = NOW(),
               stripe_refund_id = COALESCE($3, stripe_refund_id),
               version = version + 1,
               updated_at = NOW()
           WHERE id = $1
             AND state = ANY($4::text[])
             AND version = $2
           RETURNING *`,
          [escrowId, lockedRefundRow.version, stripeRefundId, allowedStates!]
        );

        if (result.rowCount === 0) {
          // Freshly-locked version still didn't match — should not happen since we hold
          // the FOR UPDATE lock, but handle defensively via getById classification.
          const existing = await EscrowService.getById(escrowId);
          if (!existing.success) {
            return existing;
          }

          // RACE RECOVERY: If the escrow transitioned to RELEASED between T1 and T2,
          // a concurrent release() won the race after our Stripe refund was already issued.
          // This is a double-spend: the worker received a transfer AND the poster got a refund.
          // F-01 FIX: Instead of attempting fragile refund cancellation, log a CRITICAL alert
          // with enough data for manual reconciliation and set manual_reconciliation_required=true
          // on the escrow row so ops can track it. Use error code REFUND_RACE_CONDITION.
          if (existing.data.state === 'RELEASED' && stripeRefundId) {
            const stripeChargeId = stripePaymentIntentId ?? 'unknown';
            escrowLogger.error(
              {
                escrowId,
                stripeRefundId,
                stripeChargeId,
                escrowState: 'RELEASED',
                amountCents: refundAmount,
              },
              'CRITICAL: REFUND_RACE_CONDITION — release() won the race between T1 and T2. ' +
              'Stripe refund already issued. Worker received transfer AND poster received refund. ' +
              'Manual reconciliation required.'
            );
            // Set manual_reconciliation_required flag so ops can query and track it.
            try {
              await db.query(
                `UPDATE escrows SET manual_reconciliation_required = true WHERE id = $1`,
                [escrowId]
              );
            } catch (flagErr) {
              escrowLogger.error(
                { escrowId, err: flagErr instanceof Error ? flagErr.message : String(flagErr) },
                'CRITICAL: failed to set manual_reconciliation_required flag — ops must manually identify this escrow'
              );
            }
            // Notify ops for immediate action.
            notifyAdmins({
              title: 'REFUND RACE CONDITION — Manual Reconciliation Required',
              body: `Escrow ${escrowId}: release() raced with refund(). Stripe refund ${stripeRefundId} already issued (charge: ${stripeChargeId}). Worker received transfer AND poster received refund. Amount: ${refundAmount} cents. Investigate immediately.`,
              deepLink: `/admin/escrows/${escrowId}`,
              priority: 'CRITICAL',
              metadata: { escrow_id: escrowId, stripe_refund_id: stripeRefundId, stripe_charge_id: stripeChargeId, amount_cents: refundAmount },
            }).catch(notifyErr => escrowLogger.error(
              { err: notifyErr instanceof Error ? notifyErr.message : String(notifyErr), escrowId },
              'Failed to send admin notification for REFUND_RACE_CONDITION — manual intervention still required'
            ));
            return {
              success: false,
              error: {
                code: 'REFUND_RACE_CONDITION',
                message: `Escrow ${escrowId}: concurrent release detected between T1 and T2. Stripe refund ${stripeRefundId} was already issued. Manual reconciliation required — escrow flagged.`,
              },
            } as ServiceResult<Escrow>;
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
              message: `Cannot refund escrow: concurrent modification detected (state=${existing.data.state ?? 'unknown'})`,
            },
          } as ServiceResult<Escrow>;
        }

        refundedEscrow = result.rows[0];
        return { success: true, data: result.rows[0] } as ServiceResult<Escrow>;
      });

      if (!termResult.success) {
        return termResult;
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
      escrowLogger.error({ err: error instanceof Error ? error.message : String(error) }, 'EscrowService DB error');
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: 'A database error occurred. Please try again.',
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
  lockForDispute: async (escrowId: string, options?: { adminOverride?: boolean; initiatedBy?: string; allowedTaskStates?: string[] }): Promise<ServiceResult<Escrow>> => {
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
          state: string;
          task_state: string;
        }>(
          `SELECT t.completed_at, t.challenge_window_hours, e.version, e.state, t.state AS task_state
           FROM escrows e
           JOIN tasks t ON t.id = e.task_id
           WHERE e.id = $1
           FOR UPDATE OF e`,
          [escrowId]
        );

        // Bug 2 fix (part A): Reject if an open dispute already exists for this escrow.
        // Checked inside the transaction so the FOR UPDATE lock prevents a race between
        // two concurrent dispute-open requests on the same escrow.
        const existingDisputeCheck = await query<{ count: string }>(
          `SELECT COUNT(*) as count FROM disputes WHERE escrow_id = $1 AND state != 'RESOLVED'`,
          [escrowId]
        );
        if (parseInt(existingDisputeCheck.rows[0]?.count ?? '0', 10) > 0) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Dispute already open for this escrow',
          });
        }

        // Bug 2 fix (part B): Per-user dispute flood guard — max 3 open disputes per 24 h.
        if (options?.initiatedBy) {
          const userFloodCheck = await query<{ count: string }>(
            `SELECT COUNT(*) as count FROM disputes
             WHERE initiated_by = $1
               AND state != 'RESOLVED'
               AND created_at > NOW() - INTERVAL '24 hours'`,
            [options.initiatedBy]
          );
          const openCount = parseInt(userFloodCheck.rows[0]?.count ?? '0', 10);
          if (openCount >= 3) {
            throw new TRPCError({
              code: 'TOO_MANY_REQUESTS',
              message: 'Dispute rate limit exceeded: maximum 3 open disputes per 24 hours',
            });
          }
        }

        // BUG 5 FIX (TOCTOU): Validate task state inside the transaction while the
        // FOR UPDATE lock is held, eliminating the race window between the router's
        // pre-check and this service call. Only run when allowedTaskStates is passed.
        if (options?.allowedTaskStates && !options?.adminOverride) {
          const taskState = windowCheck.rows[0]?.task_state;
          if (!taskState || !options.allowedTaskStates.includes(taskState)) {
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: 'Can only file a dispute on an active task (accepted, in-progress, proof-submitted, or completed)',
            });
          }
        }

        if (windowCheck.rows.length > 0) {
          const { completed_at, challenge_window_hours } = windowCheck.rows[0];

          // REG-5 / BUG-2 FIX: The completed_at == null guard has been removed for
          // the non-admin path. The router layer (escrow.lockForDispute) already
          // validates that the task is in an active disputeable state
          // (ACCEPTED / IN_PROGRESS / PROOF_SUBMITTED / DISPUTED) before calling this
          // service, so blocking on completed_at here created contradictory
          // preconditions — zero states can satisfy both "active task" AND
          // "completed_at IS NOT NULL". Admins still bypass the window check via
          // adminOverride when completed_at is null (fraud investigation path).

          // Only enforce challenge window when the task has a completion timestamp.
          // For active (non-completed) tasks completed_at is null — skip the window.
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

        // BUG 2 FIX: Also accept RELEASED escrows (dispute filed after payout).
        // When locking a RELEASED escrow, clear stripe_transfer_id so the
        // escrow-action-worker retry path can issue a fresh transfer if needed.
        // DisputeService.create stores the original transfer ID in escrow_events
        // (event_type='dispute_locked_after_release') for recovery purposes.
        const result = await query<Escrow>(
          `UPDATE escrows
           SET state = 'LOCKED_DISPUTE',
               stripe_transfer_id = CASE WHEN state = 'RELEASED' THEN NULL ELSE stripe_transfer_id END,
               version = version + 1,
               updated_at = NOW()
           WHERE id = $1
             AND state IN ('FUNDED', 'RELEASED')
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
              message: `Cannot lock escrow: current state is ${existing.data.state}, expected FUNDED or RELEASED`,
            },
          };
        }

        // Use the pre-update state captured in windowCheck for the audit event.
        const lockedFromState = windowCheck.rows[0]?.state ?? 'FUNDED';
        await logEscrowEvent(escrowId, lockedFromState, 'LOCKED_DISPUTE');

        return { success: true, data: result.rows[0] };
      });
    } catch (error) {
      // Re-throw TRPCErrors (e.g. challenge window PRECONDITION_FAILED) — do not swallow
      if (error instanceof TRPCError) {
        throw error;
      }
      escrowLogger.error({ err: error instanceof Error ? error.message : String(error) }, 'EscrowService DB error');
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: 'A database error occurred. Please try again.',
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
    let txTaskId: string = '';
    let txAmount: number = 0;
    let txPlatformFeeCents: number | null = null;
    let txStripePaymentIntentId: string | null = null;
    let txWorkerId: string | null = null;
    let txPosterId: string | null = null; // F-23: poster is charged the platform fee
    let txWorkerStripeConnectId: string | null = null;
    let txExistingTransferId: string | null = null;
    let txExistingRefundId: string | null = null;

    try {
      // -----------------------------------------------------------------------
      // Transaction 1 (read-only lock): SELECT FOR UPDATE to read state and
      // validate preconditions. We do NOT commit the state change here.
      // This keeps the lock tight and ensures we read the most recent data
      // without allowing a concurrent caller to race past the state check.
      // -----------------------------------------------------------------------

      const readResult = await db.transaction(async (query) => {
        const lockResult = await query<{
          version: number;
          state: string;
          task_id: string;
          amount: number;
          platform_fee_cents: number | null;
          stripe_payment_intent_id: string | null;
          stripe_transfer_id: string | null;
          stripe_refund_id: string | null;
        }>(
          `SELECT version, state, task_id, amount, platform_fee_cents, stripe_payment_intent_id, stripe_transfer_id, stripe_refund_id FROM escrows WHERE id = $1 FOR UPDATE`,
          [escrowId]
        );

        const row = lockResult.rows[0];
        if (!row) {
          return {
            success: false,
            error: { code: ErrorCodes.NOT_FOUND, message: `Escrow ${escrowId} not found` },
          } as ServiceResult<Escrow>;
        }

        if (row.state !== 'LOCKED_DISPUTE') {
          return {
            success: false,
            error: {
              code: ErrorCodes.INVALID_STATE,
              message: `Cannot partially refund: current state is ${row.state}, expected LOCKED_DISPUTE`,
            },
          } as ServiceResult<Escrow>;
        }

        txTaskId = row.task_id;
        txAmount = row.amount;
        txPlatformFeeCents = row.platform_fee_cents;
        txStripePaymentIntentId = row.stripe_payment_intent_id ?? null;
        txExistingTransferId = row.stripe_transfer_id ?? null;
        txExistingRefundId = row.stripe_refund_id ?? null;

        if (txPlatformFeeCents != null) {
          return {
            success: false,
            error: {
              code: ErrorCodes.INVALID_STATE,
              message: 'Canonical quote partial payout is fail-closed pending exact split reconciliation',
            },
          } as ServiceResult<Escrow>;
        }

        // Fetch worker_id, poster_id and stripe_connect_id inside the transaction
        if (txTaskId) {
          const taskRow = await query<{ worker_id: string | null; poster_id: string | null }>(
            `SELECT t.worker_id, t.poster_id FROM tasks t WHERE t.id = $1`,
            [txTaskId]
          );
          txWorkerId = taskRow.rows[0]?.worker_id ?? null;
          txPosterId = taskRow.rows[0]?.poster_id ?? null; // F-23

          if (txWorkerId) {
            const workerRow = await query<{ stripe_connect_id: string | null }>(
              `SELECT stripe_connect_id FROM users WHERE id = $1`,
              [txWorkerId]
            );
            txWorkerStripeConnectId = workerRow.rows[0]?.stripe_connect_id ?? null;
          }
        }

        return { success: true } as unknown as ServiceResult<Escrow>;
      });

      if (!readResult.success) {
        return readResult;
      }

      // -----------------------------------------------------------------------
      // Stripe calls: issue BEFORE terminalizing the DB state so that if they
      // fail the escrow is still LOCKED_DISPUTE and the caller can retry.
      // Idempotency checks (txExistingTransferId / txExistingRefundId) protect
      // against duplicate Stripe calls on retries.
      // -----------------------------------------------------------------------
      const partialAmount = txAmount!;
      // BUG 1 FIX: compute posterCents as the exact complement of workerCents so
      // that workerCents + posterCents === partialAmount always (no residual cent).
      const workerCents = Math.round(partialAmount * (workerPercent / 100));
      const posterCents = partialAmount - workerCents;
      const platformFeePercent = clampFeePercent(config.stripe.platformFeePercent);

      let resolvedTransferId: string | null = txExistingTransferId;
      let resolvedRefundId: string | null = txExistingRefundId;

      // BUG 2 FIX: Issue the poster refund FIRST, then the worker transfer.
      // Rationale: if the refund succeeds but the transfer fails, a BullMQ retry can
      // safely re-issue the transfer (txExistingRefundId idempotency guard skips it).
      // The prior order (transfer first) meant a crash between the two calls left
      // stripe_transfer_id un-persisted, so a retry read null from the DB and issued
      // a second transfer — double-paying the worker.

      // Poster portion — Stripe refund on the original payment intent (runs FIRST)
      if (posterCents > 0) {
        if (txExistingRefundId) {
          // Idempotency: refund already recorded from a prior attempt — skip.
          escrowLogger.info(
            { escrowId, stripeRefundId: txExistingRefundId },
            'partialRefund: stripe_refund_id already set — skipping duplicate Stripe refund'
          );
        } else if (!txStripePaymentIntentId!) {
          escrowLogger.error(
            { escrowId },
            'partialRefund: no stripe_payment_intent_id — cannot issue poster refund, manual refund required'
          );
        } else {
          const refundResult = await StripeService.createRefund({
            paymentIntentId: txStripePaymentIntentId,
            escrowId,
            amount: posterCents,
            reason: 'requested_by_customer',
            idempotencyKeySuffix: 'svc_partial_refund',
          });
          if (!refundResult.success) {
            // Fatal: throw so the caller can retry while the escrow is still LOCKED_DISPUTE.
            throw new Error(`partialRefund: Stripe refund failed — ${refundResult.error.message}`);
          }
          resolvedRefundId = refundResult.data.refundId;
        }
      }

      // Worker portion — Stripe transfer to connected account (runs SECOND)
      // Computed unconditionally so that idempotent retries (txExistingTransferId
      // already set) still produce the correct value for the revenue ledger below.
      // Hoisted so the same rounded value is reused in the revenue ledger block below,
      // preventing divergence from a second independent Math.round() call.
      // AUDIT FIX H3: was round(worker × (1 − pct/100)), which disagrees with the
      // complement form by 1¢ on .5 boundaries (e.g. 1050¢ @15%: 893 vs 892) —
      // the full-release path uses fee-then-complement. Unified: net = worker − fee.
      const netWorkerCentsBeforeInsurance = workerCents - computePlatformFeeCents(workerCents, platformFeePercent);
      // REVIEW FIX (PR242 follow-up): this path previously withheld NO self-
      // insurance contribution and never funded the pool, while the worker-queue
      // split path and the full-release path both do — same split paid the
      // worker differently and left the pool underfunded on service-path
      // disputes. Withhold 2% of the worker's GROSS share (matching the
      // full-release F54-2 convention) and record the contribution below.
      const partialInsuranceContributionCents = computeInsuranceContributionCents(workerCents);
      const netWorkerCents = netWorkerCentsBeforeInsurance - partialInsuranceContributionCents;
      if (workerCents > 0) {
        if (txExistingTransferId) {
          // Idempotency: transfer already recorded from a prior attempt — skip.
          escrowLogger.info(
            { escrowId, stripeTransferId: txExistingTransferId },
            'partialRefund: stripe_transfer_id already set — skipping duplicate Stripe transfer'
          );
        } else if (!txWorkerId!) {
          escrowLogger.error(
            { escrowId },
            'partialRefund: no worker_id — cannot issue worker transfer'
          );
        } else if (!txWorkerStripeConnectId!) {
          // BUG 3 FIX: worker has cents owed but no Stripe Connect account — throw
          // instead of falling through silently.  Throwing here keeps the escrow in
          // LOCKED_DISPUTE so ops can intervene via the admin recovery path
          // (AdminService.forceEscrowState / manual Stripe transfer).
          // Compare: handleReleaseRequest throws in the equivalent branch.
          throw new Error(
            `partialRefund: worker ${txWorkerId} has no stripe_connect_id — cannot issue worker transfer of ${workerCents} cents. Escrow remains LOCKED_DISPUTE for manual ops recovery.`
          );
        } else {
          // BUG 7 FIX: Pass 'svc_partial_refund' suffix so this key is distinct from
          // escrow-action-worker's 'wkr_partial_refund' suffix. Without distinct suffixes,
          // Stripe would see both calls as idempotent replays of the same transfer key
          // (tr_create_{escrowId}_{amount}), masking a real duplicate double-transfer.
          // F-5 FIX: Renamed from 'escrow_partial_refund' to 'svc_partial_refund' to
          // explicitly namespace service-layer vs worker-layer idempotency keys.
          const transferResult = await StripeService.createTransfer({
            escrowId,
            taskId: txTaskId!,
            workerId: txWorkerId,
            workerStripeAccountId: txWorkerStripeConnectId,
            amount: netWorkerCents,
            description: `Dispute partial resolution: worker ${workerPercent}%`,
            idempotencyKeySuffix: 'svc_partial_refund',
          });
          if (!transferResult.success) {
            // Fatal: throw so the caller can retry while the escrow is still LOCKED_DISPUTE.
            throw new Error(`partialRefund: Stripe transfer failed — ${transferResult.error.message}`);
          }
          resolvedTransferId = transferResult.data.transferId;
        }
      }

      // -----------------------------------------------------------------------
      // Transaction 2 (terminalize): atomically commit state = REFUND_PARTIAL
      // plus both Stripe IDs. Only runs after both Stripe calls succeed.
      //
      // F-05 FIX: Re-read the version under FOR UPDATE NOWAIT so the UPDATE
      // predicate uses the freshly-locked version rather than the stale T1
      // snapshot. Any operation that incremented the version between T1 and T2
      // would cause a stale T1 version snapshot to match 0 rows — orphaning the Stripe calls.
      // -----------------------------------------------------------------------
      const termResult = await db.transaction(async (query) => {
        // Step 1: Acquire exclusive lock and re-read live version
        let lockedVersion: number;
        try {
          const lockedRow = await query<{ id: string; version: number; state: string }>(
            `SELECT id, version, state FROM escrows WHERE id = $1 FOR UPDATE NOWAIT`,
            [escrowId]
          );
          if (!lockedRow.rows.length) {
            throw new Error(`Escrow ${escrowId} disappeared during T2 partial-refund lock — retry`);
          }
          const lockedState = lockedRow.rows[0].state;
          // Idempotent replay: already terminalized by a concurrent caller
          if (lockedState === 'REFUND_PARTIAL') {
            const existing = await EscrowService.getById(escrowId);
            return existing;
          }
          if (lockedState !== 'LOCKED_DISPUTE') {
            return {
              success: false,
              error: {
                code: ErrorCodes.INVALID_STATE,
                message: `partialRefund: escrow state changed to ${lockedState} during T2 lock — cannot terminalize`,
              },
            } as ServiceResult<Escrow>;
          }
          lockedVersion = lockedRow.rows[0].version;
        } catch (lockErr) {
          if (lockErr instanceof Error && lockErr.message.includes('could not obtain lock')) {
            throw new Error(`partialRefund T2: row lock contention on escrow ${escrowId} — retry`);
          }
          throw lockErr;
        }

        const result = await query<Escrow>(
          `UPDATE escrows
           SET state = 'REFUND_PARTIAL',
               refunded_at = NOW(),
               stripe_transfer_id = COALESCE($3, stripe_transfer_id),
               stripe_refund_id = COALESCE($4, stripe_refund_id),
               version = version + 1,
               updated_at = NOW()
           WHERE id = $1
             AND version = $2
             AND state = 'LOCKED_DISPUTE'
           RETURNING *`,
          [escrowId, lockedVersion!, resolvedTransferId, resolvedRefundId]
        );

        if (result.rowCount === 0) {
          // Concurrent modification — check if it's a safe replay.
          const checkResult = await query<{ state: string }>(
            `SELECT state FROM escrows WHERE id = $1`,
            [escrowId]
          );
          const currentState = checkResult.rows[0]?.state;
          if (currentState === 'REFUND_PARTIAL') {
            // Already terminalized by a concurrent caller — treat as success.
            const existing = await EscrowService.getById(escrowId);
            return existing;
          }
          return {
            success: false,
            error: {
              code: ErrorCodes.INVALID_STATE,
              message: `partialRefund: concurrent modification detected (state=${currentState ?? 'unknown'})`,
            },
          } as ServiceResult<Escrow>;
        }

        partialRefundEscrow = result.rows[0];
        return { success: true, data: result.rows[0] } as ServiceResult<Escrow>;
      });

      if (!termResult.success) {
        return termResult;
      }

      await logEscrowEvent(escrowId, 'LOCKED_DISPUTE', 'REFUND_PARTIAL');

      // Log platform fee to revenue ledger for the worker's partial payout.
      // Non-fatal: ledger write failure must not block the partial refund confirmation.
      // BUG 3 FIX: If resolvedTransferId is null on this attempt, check whether a
      // ledger entry already exists for this escrow (idempotent retry path). If one
      // exists, log a warning and skip. If none exists, the transfer was created but
      // not recorded — log CRITICAL so ops can reconcile via Stripe.
      if (workerCents > 0 && !resolvedTransferId) {
        const existingLedger = await db.query<{ id: string }>(
          `SELECT id FROM revenue_ledger WHERE escrow_id = $1 AND event_type = 'platform_fee' LIMIT 1`,
          [escrowId]
        );
        if (existingLedger.rows.length > 0) {
          escrowLogger.warn(
            { escrowId },
            '[EscrowService.partialRefund] resolvedTransferId is null but platform_fee ledger entry already exists — skipping duplicate ledger write (idempotent retry)'
          );
        } else {
          escrowLogger.error(
            { escrowId, workerCents, txWorkerId },
            '[EscrowService.partialRefund] CRITICAL: resolvedTransferId is null and no existing platform_fee ledger entry found — Stripe transfer may have been created but not recorded. Manual reconciliation required via Stripe idempotency key.'
          );
        }
      }
      if (workerCents > 0 && resolvedTransferId) {
        // REVIEW FIX (PR242 follow-up): the platform_fee event must record the
        // PLATFORM fee only — NOT the insurance contribution (which is tracked
        // separately in the self-insurance pool). feeCents is therefore derived
        // from the PRE-insurance net (workerCents − fee), while netAmountCents
        // reflects the ACTUAL transfer (net − insurance), matching the
        // full-release ledger convention where insurance is excluded from the
        // platform_fee decomposition.
        const feeCents = workerCents - netWorkerCentsBeforeInsurance;
        if (feeCents > 0) {
          try {
            // F-23 FIX: Platform fee is charged to the poster (buyer), not the worker.
            // Use txPosterId so the ledger correctly attributes the fee to the payer.
            await RevenueService.logEvent({
              eventType: 'platform_fee',
              userId: txPosterId ?? txWorkerId!, // prefer poster; fall back to worker if missing
              taskId: txTaskId ?? undefined,
              amountCents: feeCents,
              grossAmountCents: workerCents,
              platformFeeCents: feeCents,
              netAmountCents: netWorkerCents, // actual transfer (net − insurance)
              feeBasisPoints: Math.round(platformFeePercent * 100),
              escrowId,
              stripeTransferId: resolvedTransferId,
              metadata: { event: 'escrow_partial_refund' },
            });
          } catch (revenueErr) {
            escrowLogger.error(
              { err: revenueErr instanceof Error ? revenueErr.message : String(revenueErr), escrowId },
              '[EscrowService.partialRefund] revenue ledger write failed — manual reconciliation required'
            );
          }
        }

        // REVIEW FIX (PR242 follow-up): record the self-insurance pool
        // contribution withheld from the worker transfer. Idempotent via
        // ON CONFLICT (task_id, hustler_id) DO NOTHING in recordContribution —
        // safe on BullMQ-style retries. Non-fatal: a pool-write failure must not
        // block the already-committed partial refund (mirrors the worker queue).
        if (partialInsuranceContributionCents > 0 && txWorkerId && txTaskId) {
          try {
            await SelfInsurancePoolService.recordContribution(
              txTaskId,
              txWorkerId,
              partialInsuranceContributionCents,
            );
          } catch (insuranceErr) {
            escrowLogger.warn(
              { err: insuranceErr instanceof Error ? insuranceErr.message : String(insuranceErr), escrowId },
              '[EscrowService.partialRefund] self-insurance pool contribution failed — partial refund proceeds'
            );
          }
        }
      }

      // FIX 3: Clawback XP when dispute resolves against the worker (posterPercent > 0)
      if (posterPercent > 0) {
        try {
          const disputeWorkerId = txWorkerId ?? null;
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
      escrowLogger.error({ err: error instanceof Error ? error.message : String(error) }, 'EscrowService DB error');
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: 'A database error occurred. Please try again.',
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
