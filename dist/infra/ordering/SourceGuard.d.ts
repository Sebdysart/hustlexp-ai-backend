import Stripe from 'stripe';
export declare class SourceGuard {
    private static stripe;
    static init(): void;
    /**
     * VALIDATE WEBHOOK SIGNATURE & PLAYLOAD
     * throws Error if invalid (Caller handles generic 400/200 logic).
     */
    static validate(signature: string, rawBody: string | Buffer): Stripe.Event;
    /**
     * VALIDATE CONNECTED ACCOUNT
     * Ensures event belongs to a known authorized connected account (if applicable).
     */
    static validateAccount(event: Stripe.Event): boolean;
}
//# sourceMappingURL=SourceGuard.d.ts.map