/** Exact integer-cent invariant for PaymentIntent creation. */
export function isExactCanonicalPaymentAmount(
  taskPriceCents: number,
  callerAmountCents: number
): boolean {
  return Number.isSafeInteger(taskPriceCents)
    && taskPriceCents > 0
    && Number.isSafeInteger(callerAmountCents)
    && callerAmountCents === taskPriceCents;
}
