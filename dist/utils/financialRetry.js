import { serviceLogger } from './logger';
export async function withFinancialRetry(operationName, operation, options = {}) {
    const maxRetries = options.disableRetries ? 0 : (options.maxRetries || 5);
    const baseDelay = options.baseDelayMs || 50;
    const maxDelay = options.maxDelayMs || 2000;
    let attempt = 0;
    while (true) {
        try {
            return await operation();
        }
        catch (err) {
            // Check for Postgres Serialization Error or Deadlock
            const isConcurrencyError = err.code === '40001' || err.code === '40P01';
            if (isConcurrencyError && attempt < maxRetries) {
                attempt++;
                // Jittered Backoff
                const delay = Math.min(maxDelay, baseDelay * Math.pow(2, attempt) + (Math.random() * 100));
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
//# sourceMappingURL=financialRetry.js.map