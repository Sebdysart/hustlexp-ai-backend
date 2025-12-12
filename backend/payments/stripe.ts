export const stripe = {
  createPaymentIntent: async (params: {
    amount: number;
    currency: string;
    taskId: string;
    posterId: string;
    workerId: string;
  }) => {
    console.log('[Stripe Stub] Create payment intent:', params);
    return {
      paymentIntentId: 'stub_pi_' + Date.now(),
      clientSecret: 'stub_secret_' + Date.now(),
    };
  },
};
