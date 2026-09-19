import type { ServiceResult } from '../../types.js';
import {
  chargeStaxPaymentMethod,
  getStaxTransaction,
} from './StaxClient.js';

export interface CreateStaxAssessmentPaymentInput {
  assessmentRequestId: string;
  taskDraftId: string;
  posterId: string;
  businessOrganizationId: string;
  paymentMethodId: string;
  amountCents: number;
}

export interface CreateStaxAssessmentPaymentResult {
  transactionId: string;
  amountCents: number;
}

export interface VerifyStaxAssessmentPaymentInput {
  transactionId: string;
  assessmentRequestId: string;
  taskDraftId: string;
  posterId: string;
  amountCents: number;
}

export const StaxAssessmentPaymentProvider = {
  async charge(
    input: CreateStaxAssessmentPaymentInput,
  ): Promise<ServiceResult<CreateStaxAssessmentPaymentResult>> {
    try {
      const idempotencyId =
        `ASSESSMENT:${input.assessmentRequestId}:${input.taskDraftId}`;

      const transaction = await chargeStaxPaymentMethod({
        paymentMethodId: input.paymentMethodId,
        amountCents: input.amountCents,
        idempotencyId,
        preAuth: false,
        meta: {
          assessment_request_id: input.assessmentRequestId,
          task_draft_id: input.taskDraftId,
          poster_id: input.posterId,
          business_organization_id: input.businessOrganizationId,
        },
      });

      if (
        transaction.success !== true ||
        transaction.status !== 'SUCCESS'
      ) {
        return {
          success: false,
          error: {
            code: 'PAYMENT_NOT_SUCCEEDED',
            message: `Stax payment did not succeed (status: ${transaction.status ?? 'unknown'}).`,
          },
        };
      }

      return {
        success: true,
        data: {
          transactionId: transaction.id,
          amountCents: input.amountCents,
        },
      };
    } catch {
      return {
        success: false,
        error: {
          code: 'PAYMENT_CREATION_FAILED',
          message: 'Stax payment could not be created.',
        },
      };
    }
  },

  async verifySucceededPayment(
    input: VerifyStaxAssessmentPaymentInput,
  ): Promise<ServiceResult<void>> {
    try {
      const transaction =
        await getStaxTransaction(input.transactionId);

      if (
        transaction.success !== true ||
        transaction.status !== 'SUCCESS'
      ) {
        return {
          success: false,
          error: {
            code: 'PAYMENT_NOT_SUCCEEDED',
            message: `Stax transaction has not succeeded (status: ${transaction.status ?? 'unknown'}).`,
          },
        };
      }

      if (transaction.currency !== 'USD') {
        return {
          success: false,
          error: {
            code: 'PAYMENT_CURRENCY_MISMATCH',
            message: 'Stax transaction currency is not USD.',
          },
        };
      }

      const transactionAmountCents =
        Math.round(Number(transaction.total) * 100);

      if (transactionAmountCents !== input.amountCents) {
        return {
          success: false,
          error: {
            code: 'PAYMENT_AMOUNT_MISMATCH',
            message: 'Stax transaction amount does not match ASSESSMENT amount.',
          },
        };
      }

      if (
        transaction.meta?.assessment_request_id !== input.assessmentRequestId
      ) {
        return {
          success: false,
          error: {
            code: 'PAYMENT_ASSESSMENT_MISMATCH',
            message: 'Stax transaction was not created for this ASSESSMENT.',
          },
        };
      }

      if (
        transaction.meta?.task_draft_id !==
        input.taskDraftId
      ) {
        return {
          success: false,
          error: {
            code: 'PAYMENT_ASSESSMENT_VERSION_MISMATCH',
            message: 'Stax transaction was not created for this ASSESSMENT version.',
          },
        };
      }

      if (
        transaction.meta?.poster_id !== input.posterId
      ) {
        return {
          success: false,
          error: {
            code: 'PAYMENT_POSTER_MISMATCH',
            message: 'Stax transaction was not created for this poster.',
          },
        };
      }

      if (transaction.is_voided === true) {
        return {
          success: false,
          error: {
            code: 'PAYMENT_VOIDED',
            message: 'Stax transaction has been voided.',
          },
        };
      }

      if (Number(transaction.total_refunded ?? 0) > 0) {
        return {
          success: false,
          error: {
            code: 'PAYMENT_ALREADY_REFUNDED',
            message: 'Stax transaction has already been refunded.',
          },
        };
      }

      return {
        success: true,
        data: undefined,
      };
    } catch {
      return {
        success: false,
        error: {
          code: 'PAYMENT_VERIFICATION_FAILED',
          message: 'Stax transaction could not be verified.',
        },
      };
    }
  },
};


