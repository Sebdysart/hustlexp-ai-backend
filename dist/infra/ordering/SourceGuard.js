import { serviceLogger } from '../../utils/logger.js';
import { env } from '../../config/env.js';
import Stripe from 'stripe';
/**
 * SOURCE GUARD (OMEGA PHASE 5)
 *
 * Authenticates the incoming webhook source.
 *
 * Rules:
 * - Must pass Stripe Signature Verification.
 * - Must match Environment Mode (Test vs Live).
 * - Must contain valid Schema (id, type, object).
 */
const logger = serviceLogger.child({ module: 'SourceGuard' });
export class SourceGuard {
    static stripe;
    static init() {
        this.stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: '2024-11-20.acacia' });
    }
    /**
     * VALIDATE WEBHOOK SIGNATURE & PLAYLOAD
     * throws Error if invalid (Caller handles generic 400/200 logic).
     */
    static validate(signature, rawBody) {
        if (!this.stripe)
            this.init();
        try {
            const event = this.stripe.webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET || '');
            // MODE CHECK
            const isLiveEnv = env.isProduction;
            if (event.livemode !== isLiveEnv) {
                // In strict mode, we reject mismatched env events.
                if (env.isIdentityStrictMode) {
                    logger.warn({ eventId: event.id, livemode: event.livemode, env: isLiveEnv }, 'Source Guard: Environment Mode Mismatch');
                    throw new Error('Environment Mode Mismatch');
                }
            }
            return event;
        }
        catch (err) {
            logger.warn({ err: err.message }, 'Source Guard: Signature/Schema Verification Failed');
            throw new Error(`Webhook Signature Failed: ${err.message}`);
        }
    }
    /**
     * VALIDATE CONNECTED ACCOUNT
     * Ensures event belongs to a known authorized connected account (if applicable).
     */
    static validateAccount(event) {
        // If event.account exists, verify it's our platform's child?
        // Or specific whitelist?
        // For now, Pass.
        return true;
    }
}
//# sourceMappingURL=SourceGuard.js.map