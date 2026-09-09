import type { ServiceResult } from '../../types.js';
import {
  chargeStaxPaymentMethod,
  getStaxTransaction,
} from './StaxClient.js';
import { StaxMerchantAccountService } from './StaxMerchantAccountService.js';

export interface CreateStaxQuotePaymentInput {
  quoteId: string;
  quoteVersionId: string;
  posterId: string;
  businessOrganizationId: string;
  paymentMethodId: string;
  amountCents: number;
  businessOrganizationId: string;
  merchantId: string;
}

export interface CreateStaxQuotePaymentResult {
  transactionId: string;
  amountCents: number;
  businessOrganizationId: string;
  merchantId: string;
}

export interface VerifyStaxQuotePaymentInput {
  transactionId: string;
  quoteId: string;
  quoteVersionId: string;
  posterId: string;
  amountCents: number;
  businessOrganizationId: string;
  merchantId: string;
}

export const StaxQuotePaymentProvider = {
  async charge(
    input: CreateStaxQuotePaymentInput,
  ): Promise<ServiceResult<CreateStaxQuotePaymentResult>> {
    try {
      const merchant = await StaxMerchantAccountService.resolveActiveForOrganization(input.businessOrganizationId);
      if (!merchant) return { success: false, error: { code: 'BUSINESS_PAYMENT_ACCOUNT_NOT_READY', message: 'The selected Business is not ready to receive Stax payments.' } };
      const idempotencyId =
        `quote:${input.quoteId}:${input.quoteVersionId}`;

      const transaction = await chargeStaxPaymentMethod({
        paymentMethodId: input.paymentMethodId,
        amountCents: input.amountCents,
        idempotencyId,
        preAuth: false,
        meta: {
          quote_id: input.quoteId,
          quote_version_id: input.quoteVersionId,
          poster_id: input.posterId,
          business_organization_id: input.businessOrganizationId,
          stax_merchant_id: merchant.merchantId,
          apiKey: merchant.apiKey,
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
          merchantId: merchant.merchantId,
          businessOrganizationId: input.businessOrganizationId,
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
    input: VerifyStaxQuotePaymentInput,
  ): Promise<ServiceResult<void>> {
    try {
      const merchant = await StaxMerchantAccountService.resolveActiveForOrganization(input.businessOrganizationId);
      if (!merchant || merchant.merchantId !== input.merchantId) return { success:false, error:{ code:'PAYMENT_MERCHANT_MISMATCH', message:'Stored Stax merchant does not match this payment.' } };
      const transaction =
        await getStaxTransaction(input.transactionId, { apiKey: merchant.apiKey });

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
            message: 'Stax transaction amount does not match quote amount.',
          },
        };
      }

      if (
        transaction.meta?.quote_id !== input.quoteId
      ) {
        return {
          success: false,
          error: {
            code: 'PAYMENT_QUOTE_MISMATCH',
            message: 'Stax transaction was not created for this quote.',
          },
        };
      }

      if (
        transaction.meta?.quote_version_id !==
        input.quoteVersionId
      ) {
        return {
          success: false,
          error: {
            code: 'PAYMENT_QUOTE_VERSION_MISMATCH',
            message: 'Stax transaction was not created for this quote version.',
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

      if (transaction.meta?.business_organization_id !== input.businessOrganizationId || transaction.meta?.stax_merchant_id !== input.merchantId) return { success:false, error:{ code:'PAYMENT_MERCHANT_MISMATCH', message:'Stax transaction merchant binding does not match.' } };

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


