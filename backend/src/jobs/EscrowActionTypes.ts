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
  state: string;
  version: number;
  amount: number;
  platform_fee_cents: number | null;
  stripe_payment_intent_id: string | null;
  stripe_transfer_id: string | null;
  stripe_refund_id: string | null;
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
