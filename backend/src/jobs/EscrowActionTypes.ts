import { z } from 'zod';

export const FinancialJobPayloadSchema = z.object({
  escrow_id: z.string().uuid(),
  task_id: z.string().uuid(),
  dispute_id: z.string().uuid().optional(),
  reason: z.string().min(1).max(500),
  refund_amount: z.number().int().nonnegative().optional(),
  release_amount: z.number().int().nonnegative().optional(),
  _outbox_key: z.string().min(1).max(500),
  _sig: z.string().length(64),
});

export interface EscrowActionPayload {
  escrow_id: string;
  task_id: string;
  dispute_id?: string;
  reason: string;
  refund_amount?: number;
  release_amount?: number;
}

export interface EscrowActionJobData {
  payload: EscrowActionPayload;
}

export interface EscrowActionRow {
  id: string;
  task_id: string;
  state: string;
  version: number;
  amount: number;
  platform_fee_cents: number | null;
  stripe_payment_intent_id: string | null;
  stripe_transfer_id: string | null;
  stripe_refund_id: string | null;
  refund_amount: number | null;
  release_amount: number | null;
  payout_provider: string | null;
  provider_transfer_id: string | null;
  provider_transfer_status: string | null;
  provider_transfer_paid_at: Date | null;
}

export interface TaskPayoutRow {
  worker_id: string | null;
  payout_recipient_user_id: string | null;
  provider_organization_id: string | null;
  provider_assignment_id: string | null;
  poster_id: string | null;
}

export function taskPayoutRecipient(task: TaskPayoutRow): string | null {
  return task.payout_recipient_user_id ?? task.worker_id;
}

export interface EscrowActionInput {
  escrow: EscrowActionRow;
  taskId: string;
  disputeId?: string;
  reason: string;
  refundAmount?: number;
  releaseAmount?: number;
}

export interface EscrowActionTerminalProof {
  escrowId: string;
  taskId: string;
  terminalState: 'RELEASED' | 'REFUNDED' | 'REFUND_PARTIAL';
  providerOperationId: string;
  evidence:
    | 'EXACT_RELEASE_RECONCILED_V1'
    | 'EXACT_REFUND_TERMINALIZED_V1'
    | 'EXACT_PARTIAL_REFUND_RECONCILED_V1';
}
