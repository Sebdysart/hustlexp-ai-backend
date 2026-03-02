/**
 * Idempotency Middleware — Fastify src/ layer
 *
 * Provides two exports consumed by src/index.ts and src/middleware/hooks.ts:
 *
 *   requireIdempotencyKey(request, reply)
 *     onRequest guard: rejects state-changing requests that lack an
 *     Idempotency-Key header with HTTP 400. If the key has been seen before
 *     and a cached response is available in Redis, the cached payload is
 *     returned immediately (short-circuit replay).
 *
 *   cacheIdempotentResponse(request, reply, payload)
 *     onSend hook: after a successful response, stores the payload in Redis
 *     under the idempotency key so future identical requests get a replay.
 *
 * Graceful degradation:
 *   - When Upstash Redis is not configured the functions still work; they
 *     just skip the cache read/write. The Idempotency-Key header is still
 *     required on financial endpoints.
 *   - All Redis errors are caught and logged — they NEVER surface to the
 *     caller as exceptions.
 *
 * Cache TTL: 24 hours (86400 seconds), matching Stripe's idempotency window.
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { Redis } from '@upstash/redis';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Redis client (optional — degrades gracefully if not configured)
// ---------------------------------------------------------------------------

const IDEMPOTENCY_TTL_SECONDS = 86_400; // 24 hours

/**
 * Build the Redis client once at module load. Returns null when Upstash env
 * vars are absent so all callers can do a simple null check.
 */
function buildRedisClient(): Redis | null {
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  try {
    return new Redis({ url, token });
  } catch (err) {
    logger.warn({ err }, 'idempotency: Redis init failed — idempotency caching disabled');
    return null;
  }
}

// Initialise once at module load — Redis constructor is synchronous
const redis = buildRedisClient();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const IDEMPOTENCY_HEADER = 'idempotency-key';

function getCacheKey(key: string): string {
  return `hustlexp:idempotency:${key}`;
}

// ---------------------------------------------------------------------------
// requireIdempotencyKey (onRequest guard)
// ---------------------------------------------------------------------------

/**
 * Rejects the request with HTTP 400 when no Idempotency-Key header is present.
 *
 * Also performs cache-replay: if a prior response is cached for this key,
 * the original payload is returned immediately and the request short-circuits.
 */
export async function requireIdempotencyKey(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const key = request.headers[IDEMPOTENCY_HEADER] as string | undefined;

  if (!key) {
    reply.code(400).send({
      error: 'Missing Idempotency-Key header',
      code: 'IDEMPOTENCY_KEY_REQUIRED',
      message:
        'State-changing requests must include an Idempotency-Key header to prevent duplicate operations.',
    });
    return;
  }

  // Cache-replay: if we've seen this key before, return the stored response
  if (redis) {
    try {
      const cached = await redis.get(getCacheKey(key));
      if (cached) {
        logger.info({ requestId: request.requestId, idempotencyKey: key }, 'Idempotency replay');
        // Re-send the cached JSON payload with a 200 (already processed)
        reply.code(200).send(JSON.parse(cached));
        return;
      }
    } catch (err) {
      // Cache read failure must NOT block the real request
      logger.warn({ err, idempotencyKey: key }, 'idempotency: cache read failed — proceeding without replay');
    }
  }
}

// ---------------------------------------------------------------------------
// cacheIdempotentResponse (onSend hook)
// ---------------------------------------------------------------------------

/**
 * Stores the response payload in Redis so it can be replayed for future
 * requests with the same Idempotency-Key header.
 *
 * Only caches 2xx responses. Errors are not cached because the client should
 * be able to retry after fixing their request.
 */
export async function cacheIdempotentResponse(
  request: FastifyRequest,
  reply: FastifyReply,
  payload: string,
): Promise<void> {
  const key = request.headers[IDEMPOTENCY_HEADER] as string | undefined;
  if (!key) return; // Only cache responses that had an idempotency key

  const statusCode = (reply as FastifyReply & { statusCode?: number }).statusCode ?? 200;
  if (statusCode < 200 || statusCode >= 300) return; // Only cache successful responses

  if (!redis) return; // Redis not configured — skip caching

  try {
    await redis.set(getCacheKey(key), payload, { ex: IDEMPOTENCY_TTL_SECONDS });
  } catch (err) {
    // Cache write failure must NOT break the response flow
    logger.warn({ err, idempotencyKey: key }, 'idempotency: cache write failed');
  }
}
