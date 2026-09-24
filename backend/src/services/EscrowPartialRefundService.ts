import type { Escrow, ServiceResult } from '../types.js';
import { getEscrowById } from './EscrowReadService.js';
import { recordManualRefundRequirement } from './EscrowRefundProvider.js';
import type { PartialRefundParams } from './EscrowServiceShared.js';

export async function partialRefundEscrow(params: PartialRefundParams): Promise<ServiceResult<Escrow>> {
  if (!Number.isFinite(params.workerPercent) || !Number.isFinite(params.posterPercent)
      || params.workerPercent < 0 || params.posterPercent < 0 || params.workerPercent + params.posterPercent !== 100) {
    return { success: false, error: { code: 'INVALID_PERCENT', message: 'Percentages must be between 0 and 100 and sum to 100.' } };
  }
  const existing = await getEscrowById(params.escrowId);
  if (!existing.success || existing.data.state === 'REFUND_PARTIAL') return existing;
  await recordManualRefundRequirement(params.escrowId, 'partial_refund');
  return { success: false, error: { code: 'MANUAL_REFUND_REQUIRED',
    message: 'Partial refunds require manual review. No refund or payout has been issued.' } };
}
