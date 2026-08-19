import type {
  PaymentProvider,
} from './PaymentProvider.js';
import { LocalCertificationPaymentProvider } from '../LocalCertificationPaymentProvider.js';

export const LocalCertificationPaymentProviderAdapter: PaymentProvider = {
  async createPaymentIntent(input) {
    const result = await LocalCertificationPaymentProvider.createIntent({
      taskId: input.taskId,
      posterId: input.posterId,
      escrowId: input.escrowId,
      amountCents: input.amountCents,
    });

    if (!result.success) {
      return result;
    }

    return {
      success: true,
      data: {
        paymentIntentId: result.data.paymentIntentId,
        clientSecret: result.data.clientSecret,
        amountCents: result.data.amount,
      },
    };
  },

  async verifySucceededPayment(input) {
    const result =
      await LocalCertificationPaymentProvider.verifySucceededIntent({
        paymentIntentId: input.paymentIntentId,
        escrowId: input.escrowId,
        taskId: input.taskId,
        posterId: input.posterId,
        amountCents: input.amountCents,
      });

    if (!result.success) {
      return result;
    }

    return {
      success: true,
      data: undefined,
    };
  },
};