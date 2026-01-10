/**
 * Throws error if non-production environment attempts financial capability
 */
export declare function assertPayoutsEnabled(context: string): void;
/**
 * Returns true if real email delivery is allowed
 */
export declare function canSendRealEmail(): boolean;
/**
 * Returns true if real SMS delivery is allowed
 */
export declare function canSendRealSms(): boolean;
/**
 * Assert that AI Verification is running in strict mode
 */
export declare function assertIdentityStrict(context: string): void;
/**
 * Sanitize Stripe Mode for Logging
 */
export declare function getSafeConfigSummary(): {
    mode: import("./env.js").EnvMode;
    stripe: "test" | "live";
    payouts: boolean;
    db: string;
    redis: string;
};
//# sourceMappingURL=safety.d.ts.map