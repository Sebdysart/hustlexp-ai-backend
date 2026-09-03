import type {
  PaymentProvider,
  VerifySucceededPaymentInput,
} from './PaymentProvider.js';

export const StaxPaymentProvider: PaymentProvider = {
  async createPaymentIntent(input) {
    throw new Error('Stax createPaymentIntent not implemented yet');
  },

  async verifySucceededPayment(
    input: VerifySucceededPaymentInput,
  ) {
    throw new Error('Stax verifySucceededPayment not implemented yet');
  },
};