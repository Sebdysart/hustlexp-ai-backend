import { EscrowService } from '../services/EscrowService.js';
import type { EscrowActionInput } from './EscrowActionTypes.js';

export async function handleReleaseRequest(action: EscrowActionInput): Promise<void> {
  const release = await EscrowService.release({ escrowId: action.escrow.id });
  if (!release.success && release.error.code !== 'ESCROW_TERMINAL') throw new Error(release.error.message);
}
