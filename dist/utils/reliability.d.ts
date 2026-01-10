/**
 * Reliability Utilities - Phase E
 *
 * Helpers for scale:
 * - Retry with exponential backoff
 * - Circuit breaker per provider
 * - Health tracking
 */
export interface RetryOptions {
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    retryOn?: (error: unknown) => boolean;
}
export interface CircuitBreakerState {
    provider: string;
    failures: number;
    lastFailure?: Date;
    isOpen: boolean;
    openedAt?: Date;
    halfOpenAt?: Date;
}
/**
 * Execute a function with retry and exponential backoff
 */
export declare function withRetry<T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T>;
/**
 * Check if circuit allows requests
 */
export declare function isCircuitOpen(provider: string): boolean;
/**
 * Record a successful call
 */
export declare function recordSuccess(provider: string): void;
/**
 * Record a failed call
 */
export declare function recordFailure(provider: string, error?: unknown): void;
/**
 * Get all circuit states
 */
export declare function getAllCircuitStates(): CircuitBreakerState[];
/**
 * Reset a circuit breaker (manual)
 */
export declare function resetCircuit(provider: string): void;
export interface ExternalCallOptions extends RetryOptions {
    provider: string;
    fallback?: () => Promise<unknown>;
}
/**
 * Execute an external call with retry and circuit breaker
 */
export declare function safeExternalCall<T>(fn: () => Promise<T>, options: ExternalCallOptions): Promise<T>;
export interface ProviderHealth {
    provider: string;
    healthy: boolean;
    circuitOpen: boolean;
    failures: number;
    lastFailure?: Date;
}
/**
 * Get health status of all providers
 */
export declare function getProviderHealth(): ProviderHealth[];
//# sourceMappingURL=reliability.d.ts.map