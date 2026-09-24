import type { Escrow, ServiceResult } from '../types.js';
import { getEscrowById } from './EscrowReadService.js';
import { recordManualRefundRequirement } from './EscrowRefundProvider.js';
import type { RefundEscrowParams } from './EscrowServiceShared.js';

export async function refundEscrow(params: RefundEscrowParams): Promise<ServiceResult<Escrow>> {
  const existing = await getEscrowById(params.escrowId);
  if (!existing.success || existing.data.state === 'REFUNDED') return existing;
  await recordManualRefundRequirement(params.escrowId, 'full_refund', params.reason);
  return { success: false, error: { code: 'MANUAL_REFUND_REQUIRED',
    message: 'Automatic refunds are unavailable. Operations must verify and complete the refund manually.' } };
}
