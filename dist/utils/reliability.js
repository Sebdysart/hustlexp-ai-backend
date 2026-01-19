/**
 * Reliability Utilities - Phase E
 *
 * Helpers for scale:
 * - Retry with exponential backoff
 * - Circuit breaker per provider
 * - Health tracking
 */
import { serviceLogger } from './logger.js';
import { EventLogger } from './EventLogger.js';
// ============================================
// Retry with Backoff
// ============================================
/**
 * Execute a function with retry and exponential backoff
 */
export async function withRetry(fn, options = {}) {
    const { maxAttempts = 3, baseDelayMs = 100, maxDelayMs = 5000, retryOn = defaultRetryPredicate, } = options;
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        }
        catch (error) {
            lastError = error;
            if (attempt >= maxAttempts || !retryOn(error)) {
                throw error;
            }
            // Exponential backoff: 100ms, 300ms, 900ms...
            const delay = Math.min(baseDelayMs * Math.pow(3, attempt - 1), maxDelayMs);
            serviceLogger.debug({
                attempt,
                maxAttempts,
                delayMs: delay,
            }, 'Retrying after error');
            await sleep(delay);
        }
    }
    throw lastError;
}
/**
 * Default retry predicate: retry on network/timeout/5xx errors
 */
function defaultRetryPredicate(error) {
    if (error instanceof Error) {
        const msg = error.message.toLowerCase();
        // Network errors
        if (msg.includes('network') ||
            msg.includes('timeout') ||
            msg.includes('econnrefused') ||
            msg.includes('enotfound')) {
            return true;
        }
        // Check for status code
        const statusMatch = msg.match(/status[:\s]*(\d{3})/);
        if (statusMatch) {
            const status = parseInt(statusMatch[1]);
            // Retry on 5xx, not on 4xx
            return status >= 500 && status < 600;
        }
        // Rate limit (retry after delay)
        if (msg.includes('rate limit') || msg.includes('429')) {
            return true;
        }
    }
    return false;
}
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
// ============================================
// Circuit Breaker
// ============================================
const CIRCUIT_CONFIG = {
    failureThreshold: 5, // failures to trip circuit
    failureWindowMs: 60000, // 1 minute window
    cooldownMs: 30000, // 30 seconds before half-open
    halfOpenMaxAttempts: 2, // test calls in half-open
};
const circuitStates = new Map();
/**
 * Get or create circuit state for a provider
 */
function getCircuitState(provider) {
    if (!circuitStates.has(provider)) {
        circuitStates.set(provider, {
            provider,
            failures: 0,
            isOpen: false,
        });
    }
    return circuitStates.get(provider);
}
/**
 * Check if circuit allows requests
 */
export function isCircuitOpen(provider) {
    const state = getCircuitState(provider);
    if (!state.isOpen) {
        return false;
    }
    // Check if we should transition to half-open
    if (state.openedAt) {
        const elapsed = Date.now() - state.openedAt.getTime();
        if (elapsed >= CIRCUIT_CONFIG.cooldownMs) {
            state.halfOpenAt = new Date();
            serviceLogger.info({ provider }, 'Circuit breaker half-open');
            return false; // Allow test request
        }
    }
    return true;
}
/**
 * Record a successful call
 */
export function recordSuccess(provider) {
    const state = getCircuitState(provider);
    if (state.halfOpenAt) {
        // Success in half-open closes the circuit
        state.isOpen = false;
        state.failures = 0;
        state.openedAt = undefined;
        state.halfOpenAt = undefined;
        serviceLogger.info({ provider }, 'Circuit breaker closed');
        EventLogger.logEvent({
            eventType: 'custom',
            source: 'backend',
            metadata: { type: 'circuit_close', provider },
        });
    }
}
/**
 * Record a failed call
 */
export function recordFailure(provider, error) {
    const state = getCircuitState(provider);
    const now = Date.now();
    // Reset if outside failure window
    if (state.lastFailure) {
        const elapsed = now - state.lastFailure.getTime();
        if (elapsed > CIRCUIT_CONFIG.failureWindowMs) {
            state.failures = 0;
        }
    }
    state.failures++;
    state.lastFailure = new Date();
    // Check if we should open the circuit
    if (state.failures >= CIRCUIT_CONFIG.failureThreshold && !state.isOpen) {
        state.isOpen = true;
        state.openedAt = new Date();
        serviceLogger.warn({ provider, failures: state.failures }, 'Circuit breaker opened');
        EventLogger.logEvent({
            eventType: 'custom',
            source: 'backend',
            metadata: {
                type: 'circuit_open',
                provider,
                failures: state.failures,
                error: error instanceof Error ? error.message : String(error),
            },
        });
    }
}
/**
 * Get all circuit states
 */
export function getAllCircuitStates() {
    return Array.from(circuitStates.values());
}
/**
 * Reset a circuit breaker (manual)
 */
export function resetCircuit(provider) {
    const state = getCircuitState(provider);
    state.isOpen = false;
    state.failures = 0;
    state.openedAt = undefined;
    state.halfOpenAt = undefined;
    state.lastFailure = undefined;
    serviceLogger.info({ provider }, 'Circuit breaker manually reset');
}
/**
 * Execute an external call with retry and circuit breaker
 */
export async function safeExternalCall(fn, options) {
    const { provider, fallback, ...retryOptions } = options;
    // Check circuit breaker
    if (isCircuitOpen(provider)) {
        serviceLogger.warn({ provider }, 'Circuit open, using fallback');
        if (fallback) {
            return fallback();
        }
        throw new Error(`Circuit open for ${provider}`);
    }
    try {
        const result = await withRetry(fn, retryOptions);
        recordSuccess(provider);
        return result;
    }
    catch (error) {
        recordFailure(provider, error);
        if (fallback) {
            serviceLogger.warn({ provider }, 'Call failed, using fallback');
            return fallback();
        }
        throw error;
    }
}
/**
 * Get health status of all providers
 */
export function getProviderHealth() {
    const providers = ['openai', 'deepseek', 'groq', 'stripe', 'r2'];
    return providers.map(provider => {
        const state = circuitStates.get(provider);
        return {
            provider,
            healthy: !state?.isOpen,
            circuitOpen: state?.isOpen || false,
            failures: state?.failures || 0,
            lastFailure: state?.lastFailure,
        };
    });
}
//# sourceMappingURL=reliability.js.map