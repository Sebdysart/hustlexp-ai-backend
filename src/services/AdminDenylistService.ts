/**
 * Admin Denylist Service
 * 
 * Redis-backed denylist for immediate admin revocation.
 * Even if a valid JWT has admin:true, if the UID is in the denylist,
 * access is blocked.
 * 
 * This allows instant revocation without waiting for JWT expiry (up to 1 hour).
 * 
 * Usage:
 *   - Add to denylist: AdminDenylistService.addToDenylist(uid, reason, addedBy)
 *   - Check denylist: AdminDenylistService.isDenied(uid)
 *   - Remove from denylist: AdminDenylistService.removeFromDenylist(uid)
 *   - Emergency lock: AdminDenylistService.emergencyLock(uid, reason)
 */

import { Redis } from '@upstash/redis';
import { logger } from '../utils/logger.js';

// Get Redis credentials from environment
const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// Check if Redis is configured
const isRedisConfigured = !!(UPSTASH_REDIS_REST_URL && UPSTASH_REDIS_REST_TOKEN);

// Create Redis client
const redis = isRedisConfigured
    ? new Redis({
        url: UPSTASH_REDIS_REST_URL,
        token: UPSTASH_REDIS_REST_TOKEN,
    })
    : null;

if (!isRedisConfigured) {
    logger.error('ADMIN DENYLIST DISABLED: Redis not configured. This is a security risk!');
}

// Redis key prefix for denylist
const DENYLIST_PREFIX = 'admin:denylist:';
const DENYLIST_SET_KEY = 'admin:denylist:uids';

// Default TTL: 24 hours (ensures cleanup after JWT definitely expired)
const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

// ============================================
// Types
// ============================================

export interface DenylistEntry {
    uid: string;
    reason: string;
    addedBy: string;
    addedAt: string;  // ISO timestamp
    expiresAt: string | null;
    isEmergency: boolean;
}

// ============================================
// Service Class
// ============================================

class AdminDenylistServiceClass {
    /**
     * Check if Redis is available for denylist operations
     */
    isAvailable(): boolean {
        return redis !== null;
    }

    /**
     * Check if a UID is denied (blocked from admin access)
     * CRITICAL: This is called on EVERY admin endpoint
     */
    async isDenied(uid: string): Promise<boolean> {
        if (!redis) {
            // FAIL OPEN WARNING: If Redis is down, we can't check denylist
            // In a stricter setup, you might want to FAIL CLOSED (deny all)
            logger.warn({ uid }, 'Denylist check skipped - Redis unavailable');
            return false;
        }

        try {
            const exists = await redis.exists(`${DENYLIST_PREFIX}${uid}`);
            if (exists) {
                logger.warn({ uid }, 'Admin access blocked - UID is in denylist');
            }
            return exists === 1;
        } catch (error) {
            logger.error({ error, uid }, 'Denylist check failed');
            // FAIL OPEN on error - could change to FAIL CLOSED for stricter security
            return false;
        }
    }

    /**
     * Add a UID to the denylist
     * Use this for normal admin revocation
     */
    async addToDenylist(
        uid: string,
        reason: string,
        addedBy: string,
        ttlSeconds: number = DEFAULT_TTL_SECONDS
    ): Promise<boolean> {
        if (!redis) {
            logger.error({ uid }, 'Cannot add to denylist - Redis unavailable');
            return false;
        }

        try {
            const entry: DenylistEntry = {
                uid,
                reason,
                addedBy,
                addedAt: new Date().toISOString(),
                expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
                isEmergency: false,
            };

            // Store entry with TTL
            await redis.setex(
                `${DENYLIST_PREFIX}${uid}`,
                ttlSeconds,
                JSON.stringify(entry)
            );

            // Also add to set for listing
            await redis.sadd(DENYLIST_SET_KEY, uid);

            logger.info({ uid, reason, addedBy, ttlSeconds }, 'UID added to admin denylist');
            return true;
        } catch (error) {
            logger.error({ error, uid }, 'Failed to add to denylist');
            return false;
        }
    }

    /**
     * Emergency lock - add to denylist with NO expiry
     * Use this when an admin account is compromised
     */
    async emergencyLock(uid: string, reason: string, lockedBy: string = 'SYSTEM'): Promise<boolean> {
        if (!redis) {
            logger.error({ uid }, 'CRITICAL: Cannot emergency lock - Redis unavailable');
            return false;
        }

        try {
            const entry: DenylistEntry = {
                uid,
                reason: `EMERGENCY LOCK: ${reason}`,
                addedBy: lockedBy,
                addedAt: new Date().toISOString(),
                expiresAt: null, // No expiry
                isEmergency: true,
            };

            // Store entry WITHOUT TTL (persists until manually removed)
            await redis.set(
                `${DENYLIST_PREFIX}${uid}`,
                JSON.stringify(entry)
            );

            // Add to set
            await redis.sadd(DENYLIST_SET_KEY, uid);

            logger.error({ uid, reason, lockedBy }, 'EMERGENCY LOCK: Admin UID locked');
            return true;
        } catch (error) {
            logger.error({ error, uid }, 'CRITICAL: Emergency lock failed');
            return false;
        }
    }

    /**
     * Remove a UID from the denylist
     * Use with caution - only after confirming identity
     */
    async removeFromDenylist(uid: string, removedBy: string): Promise<boolean> {
        if (!redis) {
            logger.error({ uid }, 'Cannot remove from denylist - Redis unavailable');
            return false;
        }

        try {
            await redis.del(`${DENYLIST_PREFIX}${uid}`);
            await redis.srem(DENYLIST_SET_KEY, uid);

            logger.warn({ uid, removedBy }, 'UID removed from admin denylist');
            return true;
        } catch (error) {
            logger.error({ error, uid }, 'Failed to remove from denylist');
            return false;
        }
    }

    /**
     * Get details of a denylist entry
     */
    async getEntry(uid: string): Promise<DenylistEntry | null> {
        if (!redis) return null;

        try {
            const data = await redis.get(`${DENYLIST_PREFIX}${uid}`);
            if (!data) return null;

            return typeof data === 'string' ? JSON.parse(data) : data as DenylistEntry;
        } catch (error) {
            logger.error({ error, uid }, 'Failed to get denylist entry');
            return null;
        }
    }

    /**
     * List all denied UIDs
     */
    async listAll(): Promise<string[]> {
        if (!redis) return [];

        try {
            const uids = await redis.smembers(DENYLIST_SET_KEY);
            return uids || [];
        } catch (error) {
            logger.error({ error }, 'Failed to list denylist');
            return [];
        }
    }

    /**
     * Get count of denied UIDs
     */
    async count(): Promise<number> {
        if (!redis) return 0;

        try {
            return await redis.scard(DENYLIST_SET_KEY) || 0;
        } catch (error) {
            logger.error({ error }, 'Failed to count denylist');
            return 0;
        }
    }
}

export const AdminDenylistService = new AdminDenylistServiceClass();
