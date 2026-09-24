import { createHash } from 'node:crypto';

import type { ServiceResult } from '../types.js';
import {
  LocalCertificationPaymentProvider,
  localCertificationPaymentEnabled,
} from './LocalCertificationPaymentProvider.js';

type Environment = Record<string, string | undefined>;

export function controlledTestQuotePaymentEnabled(
  env: Environment = process.env,
): boolean {
  return env.PAYMENT_PROVIDER === 'local_test'
    && localCertificationPaymentEnabled(env);
}

export function controlledTestQuotePaymentReference(
  quoteId: string,
  quoteVersionId: string,
): string {
  const digest = createHash('sha256')
    .update(`${quoteId}:${quoteVersionId}`)
    .digest('hex')
    .slice(0, 32);

  return `quote_local_test_${digest}`;
}

export async function settleControlledTestQuotePayment(input: {
  taskId: string;
  escrowId: string;
  posterId: string;
  amountCents: number;
}): Promise<ServiceResult<{
  paymentIntentId: string;
  replayed: boolean;
}>> {
  if (!controlledTestQuotePaymentEnabled()) {
    return {
      success: false,
      error: {
        code: 'CONTROLLED_TEST_PAYMENT_DISABLED',
        message: 'Controlled-test quote payments are disabled.',
      },
    };
  }

  const created = await LocalCertificationPaymentProvider.createIntent({
    taskId: input.taskId,
    escrowId: input.escrowId,
    posterId: input.posterId,
    amountCents: input.amountCents,
  });

  if (!created.success) {
    return created;
  }

  const confirmed = await LocalCertificationPaymentProvider.confirmIntent({
    paymentIntentId: created.data.paymentIntentId,
    clientSecret: created.data.clientSecret,
    posterId: input.posterId,
  });

  if (!confirmed.success) {
    return confirmed;
  }

  const verified =
    await LocalCertificationPaymentProvider.verifySucceededIntent({
      paymentIntentId: confirmed.data.paymentIntentId,
      escrowId: input.escrowId,
      taskId: input.taskId,
      posterId: input.posterId,
      amountCents: input.amountCents,
    });

  if (!verified.success) {
    return verified;
  }

  return {
    success: true,
    data: {
      paymentIntentId: confirmed.data.paymentIntentId,
      replayed: confirmed.data.idempotencyReplayed,
    },
  };
}
