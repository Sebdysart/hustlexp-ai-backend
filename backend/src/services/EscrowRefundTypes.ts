import type { Escrow, ServiceResult } from '../types.js';

export interface RefundEscrowRow {
  task_id: string;
  version: number;
  state: string;
  stripe_payment_intent_id: string | null;
  stripe_refund_id: string | null;
  stripe_transfer_id: string | null;
  amount: number;
}

export interface RefundContext {
  escrowId: string;
  workerId: string | null;
  stateBefore: string;
  stripePaymentIntentId: string | null;
  stripeRefundId: string | null;
  stripeTransferId: string | null;
  amount: number;
  allowedStates: string[];
}

export type RefundPreparation =
  | Extract<ServiceResult<Escrow>, { success: false }>
  | { success: true; data: RefundContext };
