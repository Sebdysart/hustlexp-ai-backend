import { AdminOverride } from './PayoutEligibilityResolver.js';
export declare function handle(taskId: string, eventType: string, context: any, options?: {
    tx?: any;
    disableRetries?: boolean;
    stripeClient?: any;
    eventId?: string;
    adminOverride?: AdminOverride;
}): Promise<{
    success: boolean;
    status: string;
    state?: undefined;
} | {
    success: boolean;
    state: string;
    status?: undefined;
}>;
export declare const StripeMoneyEngine: {
    handle: typeof handle;
};
//# sourceMappingURL=StripeMoneyEngine.d.ts.map