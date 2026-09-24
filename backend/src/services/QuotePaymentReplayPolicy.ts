export function quotePaymentReplayDecision(state: {
  escrowState: string;
  taskState: string;
}): 'complete' | 'continue' | 'refunded' {
  if (state.escrowState === 'REFUNDED' || state.escrowState === 'REFUND_PARTIAL') {
    return 'refunded';
  }
  if (['FUNDED', 'LOCKED_DISPUTE', 'RELEASED'].includes(state.escrowState)
    && state.taskState !== 'OPEN') {
    return 'complete';
  }
  return 'continue';
}
