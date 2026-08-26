import type { Escrow, ServiceResult } from '../types.js';

export interface RefundEscrowRow {
  task_id: string;
  version: number;
  state: string;
  platform_fee_cents: number | null;
  stripe_payment_intent_id: string | null;
  stripe_refund_id: string | null;
  stripe_transfer_id: string | null;
  payout_provider: string | null;
  provider_transfer_id: string | null;
  provider_transfer_status: string | null;
  provider_transfer_paid_at: Date | null;
  amount: number;
}

export interface RefundTaskRow {
  id: string;
  version: number;
  worker_id: string | null;
  state: string;
}

export interface RefundProviderClaim {
  claimIdempotencyKey: string;
  providerIdempotencyKey: string;
  providerReplayDeadline: Date;
}

export interface RefundContext {
  escrowId: string;
  taskId: string;
  workerId: string | null;
  taskVersion: number;
  taskState: string;
  version: number;
  stateBefore: string;
  platformFeeCents: number | null;
  stripePaymentIntentId: string | null;
  stripeRefundId: string | null;
  stripeTransferId: string | null;
  payoutProvider: string | null;
  providerTransferId: string | null;
  providerTransferStatus: string | null;
  providerTransferPaidAt: Date | null;
  amount: number;
  allowedStates: string[];
  providerClaim: RefundProviderClaim;
}

export type RefundPreparation =
  | Extract<ServiceResult<Escrow>, { success: false }>
  | { success: true; data: RefundContext };
