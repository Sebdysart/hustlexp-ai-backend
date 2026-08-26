import type { Escrow, ServiceResult } from '../types.js';
import type { StripeTransferWitness } from './EscrowReleaseTypes.js';

export interface PartialRefundEscrowRow {
  version: number;
  state: string;
  task_id: string;
  amount: number;
  platform_fee_cents: number | null;
  stripe_payment_intent_id: string | null;
  stripe_transfer_id: string | null;
  stripe_refund_id: string | null;
  refund_amount: number | null;
  release_amount: number | null;
}

export interface PartialRefundContext {
  escrowId: string;
  escrowVersion: number;
  escrowState: string;
  taskId: string;
  amount: number;
  canonicalPlatformFeeCents: number | null;
  stripePaymentIntentId: string | null;
  existingTransferId: string | null;
  existingRefundId: string | null;
  existingRefundAmount: number | null;
  existingReleaseAmount: number | null;
  workerId: string | null;
  payoutRecipientUserId: string | null;
  providerOrganizationId: string | null;
  providerAssignmentId: string | null;
  posterId: string | null;
  payoutStripeConnectId: string | null;
  payoutDestinationError: string | null;
}

export interface PartialRefundAmounts {
  workerPercent: number;
  posterPercent: number;
  workerCents: number;
  posterCents: number;
  platformFeePercent: number;
  netWorkerCentsBeforeInsurance: number;
  insuranceContributionCents: number;
  netWorkerCents: number;
}

export interface PartialRefundProviderResult {
  transferId: string | null;
  refundId: string | null;
  transferWitness: StripeTransferWitness | null;
  transferCreated: boolean;
}

export type PartialRefundPreparation =
  | Extract<ServiceResult<Escrow>, { success: false }>
  | { success: true; data: PartialRefundContext };
