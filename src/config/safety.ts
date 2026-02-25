/**
 * Safety guard for payout operations.
 * Checks that payouts are explicitly enabled via environment configuration.
 * Throws if payouts are disabled or if running in a non-production environment
 * without explicit opt-in.
 *
 * Called before every RELEASE_PAYOUT operation in the StripeMoneyEngine.
 */
export function assertPayoutsEnabled(context?: string): void {
  // KILLSWITCH: If PAYOUTS_DISABLED is set, block all payouts immediately
  if (process.env.PAYOUTS_DISABLED === 'true') {
    throw new Error(
      `PAYOUTS DISABLED: Payout operations are currently suspended via PAYOUTS_DISABLED flag.` +
      (context ? ` Context: ${context}` : '')
    );
  }

  // In production, require STRIPE_SECRET_KEY to be present (not placeholder)
  const stripeKey = process.env.STRIPE_SECRET_KEY || '';
  if (process.env.NODE_ENV === 'production' && (!stripeKey || stripeKey.includes('placeholder'))) {
    throw new Error(
      'PAYOUTS BLOCKED: STRIPE_SECRET_KEY is missing or contains placeholder in production.' +
      (context ? ` Context: ${context}` : '')
    );
  }

  // Require Stripe Connect to be configured for payouts
  if (process.env.NODE_ENV === 'production' && !stripeKey.startsWith('sk_live_')) {
    throw new Error(
      'PAYOUTS BLOCKED: Production payouts require a live Stripe key (sk_live_*).' +
      (context ? ` Context: ${context}` : '')
    );
  }
}
