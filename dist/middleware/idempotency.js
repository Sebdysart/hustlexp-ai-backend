/**
 * Idempotency Middleware
 *
 * PHASE 6.1: Prevents duplicate POST requests for state-changing operations.
 * Requires x-idempotency-key header for financial endpoints.
 */
import { redis } from './rateLimiter.js';
import { logger } from '../utils/logger.js';
const IDEMPOTENCY_TTL_SECONDS = 86400; // 24 hours
/**
 * Require idempotency key for POST/PUT/PATCH requests
 * Stores results to return same response on retries
 */
export async function requireIdempotencyKey(request, reply) {
    // Only apply to state-changing methods
    if (!['POST', 'PUT', 'PATCH'].includes(request.method)) {
        return;
    }
    const idempotencyKey = request.headers['x-idempotency-key'];
    if (!idempotencyKey) {
        reply.status(400).send({
            error: 'Missing x-idempotency-key header',
            code: 'IDEMPOTENCY_KEY_REQUIRED',
            message: 'State-changing requests require an idempotency key',
        });
        return;
    }
    // Skip if Redis not available (graceful degradation)
    if (!redis) {
        logger.warn('Idempotency check skipped - Redis not configured');
        return;
    }
    const cacheKey = `idempotency:${idempotencyKey}`;
    try {
        // Check if we've seen this key before
        const existing = await redis.get(cacheKey);
        if (existing) {
            if (existing.status === 'processing') {
                // Request is currently being processed
                reply.status(409).send({
                    error: 'Request in progress',
                    code: 'IDEMPOTENCY_CONFLICT',
                    message: 'A request with this idempotency key is currently being processed',
                });
                return;
            }
            if (existing.status === 'completed' && existing.responseBody) {
                // Return cached response
                logger.info({ idempotencyKey }, 'Returning cached idempotent response');
                reply
                    .status(existing.responseCode || 200)
                    .send(JSON.parse(existing.responseBody));
                return;
            }
        }
        // Mark as processing
        await redis.set(cacheKey, {
            status: 'processing',
            timestamp: Date.now(),
        }, { ex: IDEMPOTENCY_TTL_SECONDS });
        // Attach key to request for post-processing
        request.idempotencyKey = idempotencyKey;
    }
    catch (error) {
        logger.error({ error, idempotencyKey }, 'Idempotency check failed');
        // Continue on error (don't block the request)
    }
}
/**
 * Hook to cache successful responses for idempotency
 */
export async function cacheIdempotentResponse(request, reply, payload) {
    const idempotencyKey = request.idempotencyKey;
    if (!idempotencyKey || !redis) {
        return;
    }
    const cacheKey = `idempotency:${idempotencyKey}`;
    try {
        // Only cache successful responses
        if (reply.statusCode >= 200 && reply.statusCode < 300) {
            await redis.set(cacheKey, {
                status: 'completed',
                responseCode: reply.statusCode,
                responseBody: payload,
                timestamp: Date.now(),
            }, { ex: IDEMPOTENCY_TTL_SECONDS });
            logger.debug({ idempotencyKey }, 'Cached idempotent response');
        }
        else {
            // Delete processing flag on error
            await redis.del(cacheKey);
        }
    }
    catch (error) {
        logger.error({ error, idempotencyKey }, 'Failed to cache idempotent response');
    }
}
/**
 * Check if idempotency middleware is enabled
 */
export function isIdempotencyEnabled() {
    return redis !== null;
}
//# sourceMappingURL=idempotency.js.map