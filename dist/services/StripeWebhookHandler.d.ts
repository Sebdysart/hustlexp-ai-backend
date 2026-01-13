/**
 * STRIPE WEBHOOK HANDLER (BUILD_GUIDE FIX 2)
 *
 * Handles Stripe webhooks with:
 * - Idempotent event processing (stripe_events table)
 * - Out-of-order event handling
 * - Error logging and retry support
 *
 * INVARIANTS ENFORCED:
 * - INV-STRIPE-1: Every Stripe webhook processed exactly once
 * - INV-STRIPE-2: Stripe is authoritative for payment state
 * - INV-STRIPE-3: Out-of-order events don't corrupt state
 *
 * @version 1.0.0 (BUILD_GUIDE aligned)
 */
import Stripe from 'stripe';
declare class StripeWebhookHandlerClass {
    /**
     * Process a Stripe webhook event
     * Returns true if processed, false if duplicate
     */
    handleEvent(event: Stripe.Event): Promise<boolean>;
    /**
     * Process event based on type
     */
    private processEvent;
    /**
     * Payment succeeded → Fund escrow
     */
    private handlePaymentSucceeded;
    /**
     * Payment canceled → Refund escrow
     */
    private handlePaymentCanceled;
    /**
     * Payment failed → Log and notify
     */
    private handlePaymentFailed;
    /**
     * Dispute created → Lock escrow
     */
    private handleDisputeCreated;
    /**
     * Dispute closed → Apply outcome
     */
    private handleDisputeClosed;
    /**
     * Transfer created → Log
     */
    private handleTransferCreated;
    /**
     * Transfer failed → Alert
     */
    private handleTransferFailed;
    /**
     * Payout paid → Final confirmation
     */
    private handlePayoutPaid;
}
export declare const StripeWebhookHandler: StripeWebhookHandlerClass;
export {};
//# sourceMappingURL=StripeWebhookHandler.d.ts.map