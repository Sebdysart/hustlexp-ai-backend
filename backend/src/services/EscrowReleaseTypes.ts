import type { Escrow, ServiceResult } from '../types.js';

export interface ReleaseEscrowRow {
  id: string;
  task_id: string;
  amount: number;
  platform_fee_cents: number | null;
  state: string;
  version: number;
  stripe_transfer_id: string | null;
}

export interface ReleaseTaskRow {
  worker_id: string | null;
  payout_recipient_user_id: string | null;
  provider_organization_id: string | null;
  price: number;
  payment_method: string | null;
  poster_id: string | null;
  automation_classification: string | null;
  hustler_payout_cents: number | null;
  platform_margin_cents: number | null;
}

export type ReleasePayoutProvider =
  | 'STRIPE'
  | 'LOCAL_CERTIFICATION_TEST'
  | 'MANUAL_RECONCILIATION';

export interface ReleasePost {
  workerId: string;
  payoutRecipientUserId: string;
  serviceBusinessProvider: boolean;
  grossPayoutCents: number;
  netPayoutCents: number;
  platformFeeCents: number;
  platformFeePercent: number;
  insuranceContributionCents: number;
  taskId: string;
  paymentMethod: string;
  escrowStateBefore: string;
  adminManualPayoutRequired: boolean;
  posterId: string | null;
  payoutProvider: ReleasePayoutProvider;
  providerTransferId: string | null;
}

export type ReleaseTransactionResult =
  | Extract<ServiceResult<Escrow>, { success: false }>
  | { success: true; data: Escrow; post: ReleasePost };
