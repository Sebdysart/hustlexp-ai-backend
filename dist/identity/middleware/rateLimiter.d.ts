declare const LIMITS: {
    emailSend: {
        max: number;
        windowMs: number;
    };
    smsSend: {
        max: number;
        windowMs: number;
    };
    verify: {
        max: number;
        windowMs: number;
    };
    ipGlobal: {
        max: number;
        windowMs: number;
    };
};
interface RateLimitResult {
    allowed: boolean;
    remaining: number;
    retryAfterMs?: number;
}
/**
 * Check rate limit
 */
export declare function checkRateLimit(key: string, type: keyof typeof LIMITS): Promise<RateLimitResult>;
export declare function isRateLimitConfigured(): boolean;
export {};
//# sourceMappingURL=rateLimiter.d.ts.map