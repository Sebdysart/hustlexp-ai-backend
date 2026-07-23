import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { classifyPaymentIntentCancellation } from '../../src/services/StripePaymentIntentCancellationService';

type CancellationPlan = 'NO_PROVIDER_WRITE' | 'CANCEL' | 'REFUND';

function independentCancellationOracle(status: string): CancellationPlan {
  if (status === 'canceled') return 'NO_PROVIDER_WRITE';
  if (status === 'succeeded') return 'REFUND';
  return 'CANCEL';
}

describe('pending PaymentIntent cancellation properties', () => {
  it('never treats a succeeded charge as safely cancelable', () => {
    fc.assert(fc.property(
      fc.constantFrom(
        'requires_payment_method',
        'requires_confirmation',
        'requires_action',
        'processing',
        'requires_capture',
        'canceled',
        'succeeded',
      ),
      (status) => {
        expect(classifyPaymentIntentCancellation(status)).toBe(independentCancellationOracle(status));
      },
    ), { numRuns: 100 });
  });

  it('generates stable, task-scoped cancellation and refund identities', () => {
    fc.assert(fc.property(fc.uuid(), fc.uuid(), (firstTaskId, secondTaskId) => {
      fc.pre(firstTaskId !== secondTaskId);
      const cancel = (taskId: string) => `dispatch-expiry-cancel:${taskId}`;
      const refund = (taskId: string) => `dispatch-expiry-refund:${taskId}`;

      expect(cancel(firstTaskId)).toBe(cancel(firstTaskId));
      expect(refund(firstTaskId)).toBe(refund(firstTaskId));
      expect(cancel(firstTaskId)).not.toBe(cancel(secondTaskId));
      expect(refund(firstTaskId)).not.toBe(refund(secondTaskId));
      expect(cancel(firstTaskId)).not.toBe(refund(firstTaskId));
    }), { numRuns: 100 });
  });
});
