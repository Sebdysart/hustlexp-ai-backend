/**
 * FINANCIAL RETRY UTILITY
 *
 * Handles strict SERIALIZABLE transaction retries for Neon/Postgres.
 * Detects:
 * - 40001: Serialization Failure (Concurrent Updates)
 * - 40P01: Deadlock Detected
 *
 * Implements Jittered Exponential Backoff.
 */
interface RetryOptions {
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    disableRetries?: boolean;
}
export declare function withFinancialRetry<T>(operationName: string, operation: () => Promise<T>, options?: RetryOptions): Promise<T>;
export {};
//# sourceMappingURL=financialRetry.d.ts.map