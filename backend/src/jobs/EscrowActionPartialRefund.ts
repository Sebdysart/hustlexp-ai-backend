import { recordManualRefundRequirement } from '../services/EscrowRefundProvider.js';
import type { EscrowActionInput } from './EscrowActionTypes.js';

export async function handlePartialRefundRequest(action: EscrowActionInput): Promise<void> {
  await recordManualRefundRequirement(action.escrow.id, 'partial_refund', action.reason);
}
