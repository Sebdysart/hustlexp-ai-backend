import { env } from './env.js';
import { serviceLogger } from '../utils/logger.js';

// ===================================
// CENTRALIZED SAFETY GUARDS
// ===================================

/**
 * Throws error if non-production environment attempts financial capability
 */
export function assertPayoutsEnabled(context: string) {
    if (!env.isPayoutsEnabled) {
        serviceLogger.warn({ context, env: env.mode }, '[SAFETY] Payout blocked by safety lock');
        throw new Error(`[SAFETY] Payouts are DISABLED in ${env.mode} environment.`);
    }
}

/**
 * Returns true if real email delivery is allowed
 */
export function canSendRealEmail(): boolean {
    if (!env.isEmailRealDelivery) {
        serviceLogger.debug('[SAFETY] Real email delivery suppressed (Staging/Local)');
        return false;
    }
    return true;
}

/**
 * Returns true if real SMS delivery is allowed
 */
export function canSendRealSms(): boolean {
    if (!env.isSmsRealDelivery) {
        serviceLogger.debug('[SAFETY] Real SMS delivery suppressed (Staging/Local)');
        return false;
    }
    return true;
}

/**
 * Assert that AI Verification is running in strict mode
 */
export function assertIdentityStrict(context: string) {
    if (env.isIdentityStrictMode) {
        // No-op, allowed
        return;
    }
    // In local/test, we might warn but allow loose checks
    serviceLogger.warn({ context }, '[SAFETY] Running Identity check in LOOSE mode');
}

/**
 * Sanitize Stripe Mode for Logging
 */
export function getSafeConfigSummary() {
    return {
        mode: env.mode,
        stripe: env.STRIPE_MODE, // safe to log 'live' or 'test'
        payouts: env.isPayoutsEnabled,
        db: env.DATABASE_URL ? 'configured' : 'missing',
        redis: env.UPSTASH_REDIS_REST_URL ? 'configured' : 'missing'
    };
}
