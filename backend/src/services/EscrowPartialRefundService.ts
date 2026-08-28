import { db } from '../db.js';
import { escrowLogger } from '../logger.js';
import type { Escrow, ServiceResult } from '../types.js';
import { ErrorCodes } from '../types.js';
import { runPartialRefundEffects } from './EscrowPartialRefundEffects.js';
import {
  computePartialRefundAmounts,
  executePartialRefundProviders,
} from './EscrowPartialRefundProvider.js';
import {
  preparePartialRefund,
  terminalizePartialRefund,
} from './EscrowPartialRefundTransaction.js';
import type { PartialRefundParams } from './EscrowServiceShared.js';

function invalidPercentages(params: PartialRefundParams): ServiceResult<Escrow> | null {
  if (
    params.workerPercent < 0 || params.workerPercent > 100
    || params.posterPercent < 0 || params.posterPercent > 100
  ) {
    return {
      success: false,
      error: { code: 'INVALID_PERCENT', message: 'Percentages must be between 0 and 100' },
    };
  }
  if (params.workerPercent + params.posterPercent !== 100) {
    return {
      success: false,
      error: {
        code: ErrorCodes.INVALID_STATE,
        message: 'Worker and poster percentages must sum to 100',
      },
    };
  }
  return null;
}

export async function partialRefundEscrow(params: PartialRefundParams): Promise<ServiceResult<Escrow>> {
  const invalid = invalidPercentages(params);
  if (invalid) return invalid;
  try {
    const prepared = await db.transaction((query) => preparePartialRefund(query, params.escrowId));
    if (!prepared.success) return prepared;
    const amounts = computePartialRefundAmounts({
      amount: prepared.data.amount,
      workerPercent: params.workerPercent,
      posterPercent: params.posterPercent,
    });
    const provider = await executePartialRefundProviders(prepared.data, amounts);
    const terminal = await db.transaction((query) => terminalizePartialRefund(query, prepared.data, provider));
    if (!terminal.success) return terminal;
    await runPartialRefundEffects({ context: prepared.data, amounts, provider });
    return terminal;
  } catch (error) {
    escrowLogger.error(
      { err: error instanceof Error ? error.message : String(error) },
      'EscrowService DB error',
    );
    return {
      success: false,
      error: { code: 'DB_ERROR', message: 'A database error occurred. Please try again.' },
    };
  }
}
