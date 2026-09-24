import { recordManualRefundRequirement } from '../services/EscrowRefundProvider.js';
import type { EscrowActionInput } from './EscrowActionTypes.js';

export async function handleRefundRequest(action: EscrowActionInput): Promise<void> {
  await recordManualRefundRequirement(action.escrow.id, 'full_refund', action.reason);
}
