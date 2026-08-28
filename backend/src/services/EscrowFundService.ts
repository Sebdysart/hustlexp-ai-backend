import { db } from '../db.js';
import type { Escrow, ServiceResult } from '../types.js';
import { ErrorCodes } from '../types.js';
import { escrowLogger } from '../logger.js';
import { logEscrowEvent } from './EscrowServiceShared.js';
import type { FundEscrowParams } from './EscrowServiceShared.js';

export const fundEscrow = async (params: FundEscrowParams): Promise<ServiceResult<Escrow>> => {
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
  };
