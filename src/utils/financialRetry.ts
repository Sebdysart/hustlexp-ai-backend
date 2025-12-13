
import { serviceLogger } from './logger';

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
    // M4 Hook: If true, disable retries (throw immediately on 40001)
    disableRetries?: boolean;
}

export async function withFinancialRetry<T>(
    operationName: string,
    operation: () => Promise<T>,
    options: RetryOptions = {}
): Promise<T> {
    const maxRetries = options.disableRetries ? 0 : (options.maxRetries || 5);
    const baseDelay = options.baseDelayMs || 50;
    const maxDelay = options.maxDelayMs || 2000;

    let attempt = 0;

    while (true) {
        try {
            return await operation();
        } catch (err: any) {
            // Check for Postgres Serialization Error or Deadlock
            const isConcurrencyError = err.code === '40001' || err.code === '40P01';

            if (isConcurrencyError && attempt < maxRetries) {
                attempt++;
                // Jittered Backoff
                const delay = Math.min(
                    maxDelay,
                    baseDelay * Math.pow(2, attempt) + (Math.random() * 100)
                );

                serviceLogger.warn({
                    operation: operationName,
                    attempt,
                    error: err.code,
                    delay
                }, `Concurrency conflict detected. Retrying...`);

                await new Promise(resolve => setTimeout(resolve, delay));
                continue;
            }

            // If not retryable or max attempts reached
            if (isConcurrencyError) {
                serviceLogger.error({
                    operation: operationName,
                    attempts: attempt,
                    error: err.code
                }, `Financial Operation Failed: Max Retries Exceeded`);
            }

            throw err;
        }
    }
}
