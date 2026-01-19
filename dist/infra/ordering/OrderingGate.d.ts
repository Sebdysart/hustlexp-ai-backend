import Stripe from 'stripe';
export declare class OrderingGate {
    /**
     * INGRESS GATE
     * Run this immediately upon receiving a Webhook.
     * @returns Stripe.Event if Safe, NULL if Blocked (Safe to ignore).
     * @throws Error only if Signature fails (400 Bad Request).
     */
    static ingress(signature: string, rawBody: string | Buffer, internalEventId: string): Promise<Stripe.Event | null>;
}
//# sourceMappingURL=OrderingGate.d.ts.map