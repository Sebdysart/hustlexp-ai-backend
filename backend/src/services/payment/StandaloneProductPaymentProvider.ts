/** A standalone product contract. Never accepts task, quote, escrow or payout identifiers. */
export interface StandaloneProductPurchase {
  id: string;
  organization_id: string;
  purchaser_user_id: string | null;
  product_code: string;
  amount_cents: number;
  currency: string;
  period_days: number;
  test_mode: boolean;
  provider_payment_id: string | null;
}
export type ProductPaymentVerification =
  | { state: 'paid'; transactionId: string }
  | { state: 'pending' | 'failed' | 'canceled' };
export interface StandaloneProductPaymentProvider {
  create(purchase: StandaloneProductPurchase): Promise<{ id: string }>;
  verify(purchase: StandaloneProductPurchase): Promise<ProductPaymentVerification>;
}
