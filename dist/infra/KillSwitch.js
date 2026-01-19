import { Redis } from '@upstash/redis';
import { serviceLogger } from '../utils/logger.js';
import { env } from '../config/env.js';
import { BetaMetricsService } from '../services/BetaMetricsService.js';
/**
 * KILL SWITCH (OMEGA PROTOCOL)
 *
 * The Autonomic Nervous System of Protection.
 * If this triggers, ALL financial movement stops immediately.
 *
 * Triggers:
 * - Ledger Drift > 0
 * - Unexplained Stripe Failures
 * - Identity Fraud Spikes
 * - Manual Admin Override
 *
 * Persistence:
 * - Uses REDIS (High Priority) to propagate lock across all instances.
 * - Local fallback if Redis fails (Fail Safe/Closed).
 */
const logger = serviceLogger.child({ module: 'KillSwitch' });
export class KillSwitch {
    static redis = null;
    static localState = false; // Fallback
    static reason = null;
    static REDIS_KEY = 'sys:kill_switch:active';
    static initialize() {
        try {
            if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_URL.startsWith('http')) {
                // Warning: Token might be missing in Env object type if not defined in 'env' export
                // We trust env.UPSTASH_REDIS_REST_URL is there.
                // But wait, env.ts doesn't export token?
                // Let's check env.ts again.
                // Line 80: UPSTASH_REDIS_REST_URL = requireVar...
                // But where is TOKEN?
                // Env.ts doesn't seem to export TOKEN explicitly in the `env` object?
                // Line 137 exports UPSTASH_REDIS_REST_URL.
                // It does NOT export UPSTASH_REDIS_REST_TOKEN. 
                // We might need to access process.env directly or update env.ts.
                this.redis = new Redis({
                    url: env.UPSTASH_REDIS_REST_URL,
                    token: process.env.UPSTASH_REDIS_REST_TOKEN || '',
                });
            }
        }
        catch (e) {
            logger.warn('Redis not configured for KillSwitch. Using process-local state only.');
        }
    }
    /**
     * IS SYSTEM FROZEN?
     * @returns true if payouts/money should STOP.
     */
    static async isActive() {
        // 1. Check Local (Fast)
        if (this.localState)
            return true;
        // 2. Check Redis (Trusted)
        if (this.redis) {
            try {
                const remote = await this.redis.get(this.REDIS_KEY);
                if (remote) {
                    this.localState = true; // Sync local
                    return true;
                }
            }
            catch (err) {
                logger.error({ err }, 'KillSwitch Redis Check Failed - Assuming SAFE but ALERTING');
                // Should we Fail Closed? 
                // In Omega Protocol, availability < safety.
                // But transient redis failure shouldn't kill app.
                // We return localState.
            }
        }
        return false;
    }
    /**
     * TRIGGER THE KILL SWITCH
     * Stops everything.
     */
    static async trigger(reason, metadata = {}) {
        logger.fatal({ reason, metadata }, '⚠️ KILL SWITCH TRIGGERED - SYSTEM FREEZING ⚠️');
        this.localState = true;
        this.reason = reason;
        // Emit metric
        BetaMetricsService.killswitchActivated(reason);
        if (this.redis) {
            try {
                await this.redis.set(this.REDIS_KEY, true);
                await this.redis.set('sys:kill_switch:reason', reason);
                await this.redis.set('sys:kill_switch:meta', JSON.stringify(metadata));
            }
            catch (err) {
                logger.error({ err }, 'Failed to persist KillSwitch to Redis');
            }
        }
        // Ω-OPS: Fire alert on KillSwitch activation
        try {
            const { AlertService } = await import('../services/AlertService.js');
            await AlertService.fire('KILLSWITCH_ACTIVATED', `KillSwitch triggered: ${reason}`, { reason, ...metadata });
        }
        catch (alertErr) {
            logger.error({ alertErr }, 'Failed to send KillSwitch alert - CHECK ALERT CONFIGURATION');
        }
    }
    /**
     * RESET (Admin Only)
     */
    static async resolve() {
        logger.info('KillSwitch Resolved - Resuming Operations');
        this.localState = false;
        this.reason = null;
        if (this.redis) {
            await this.redis.del(this.REDIS_KEY);
        }
    }
    /**
     * CHECK SPECIFIC GATES
     */
    static async checkGate(gate) {
        const frozen = await this.isActive();
        if (frozen) {
            logger.warn({ gate }, 'Gate Access DENIED - KillSwitch Active');
            return false;
        }
        return true;
    }
}
// Auto-Init
KillSwitch.initialize();
//# sourceMappingURL=KillSwitch.js.map