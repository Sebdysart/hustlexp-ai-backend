import { describe, expect, it } from 'vitest';
import { quotePaymentReplayDecision } from '../../src/services/QuotePaymentReplayPolicy.js';

describe('settled quote checkout replay', () => {
  it.each(['FUNDED', 'LOCKED_DISPUTE', 'RELEASED'])(
    'returns the paid task without funding again when escrow is %s',
    (escrowState) => {
      expect(quotePaymentReplayDecision({ escrowState, taskState: 'COMPLETED' }))
        .toBe('complete');
    },
  );

  it('continues incomplete first finalization safely', () => {
    expect(quotePaymentReplayDecision({ escrowState: 'PENDING', taskState: 'OPEN' }))
      .toBe('continue');
    expect(quotePaymentReplayDecision({ escrowState: 'FUNDED', taskState: 'OPEN' }))
      .toBe('continue');
  });

  it.each(['REFUNDED', 'REFUND_PARTIAL'])(
    'never reports a refunded checkout as newly successful when escrow is %s',
    (escrowState) => {
      expect(quotePaymentReplayDecision({ escrowState, taskState: 'COMPLETED' }))
        .toBe('refunded');
    },
  );
});
