import { recordManualRefundRequirement } from './EscrowRefundProvider.js';

export interface PendingPaymentCancellationInput { escrowId: string; taskId: string; reason: string }
export const PendingPaymentCancellationService = {
  execute: async (input: PendingPaymentCancellationInput): Promise<void> => {
    await recordManualRefundRequirement(input.escrowId, 'payment_cancellation', input.reason);
  },
};
export default PendingPaymentCancellationService;
