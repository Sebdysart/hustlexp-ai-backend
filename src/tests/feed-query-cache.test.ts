/**
 * FeedQueryService — Redis Cache Invalidation (TDD RED)
 *
 * Tests for the Redis-backed `invalidateFeedCache(userId, redis)` function.
 *
 * Current state (stub):
 *   The function exists but only logs. It never touches Redis.
 *
 * Target behavior:
 *   When Redis is configured, `invalidateFeedCache` must DEL the canonical
 *   feed cache key so that the next call to `getFeed` queries the database
 *   fresh rather than returning stale eligibility results.
 *
 * Cache key pattern: `hustlexp:feed:eligible:{userId}`
 *   Matches the namespace convention used across the Fastify src/ layer
 *   (hustlexp:ratelimit:*, hustlexp:idempotency:*, hustlexp:connect:*).
 *
 * Graceful degradation:
 *   If Redis is unavailable or throws, the function must not propagate the
 *   error — the feed will simply be recomputed on the next request.
 *
 * Injectable Redis parameter:
 *   The function accepts an optional second argument for testability, matching
 *   the pattern established in checkStripeEventIdempotency (injectable sql)
 *   and the other cache helpers. The default value is the module-level Redis
 *   client built at startup.
 */
import { describe, it, expect, vi } from 'vitest';
import { invalidateFeedCache } from '../services/FeedQueryService.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type RedisDelClient = { del: (key: string) => Promise<number> };

function makeDelMock(returnValue: number = 1): RedisDelClient {
  return { del: vi.fn().mockResolvedValue(returnValue) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('invalidateFeedCache', () => {
  it('calls redis.del with the canonical feed cache key', async () => {
    const mock = makeDelMock();
    await invalidateFeedCache('user_123', mock);
    expect(mock.del).toHaveBeenCalledWith('hustlexp:feed:eligible:user_123');
  });

  it('uses the correct key pattern for any userId', async () => {
    const mock = makeDelMock();
    await invalidateFeedCache('user_abc_456', mock);
    expect(mock.del).toHaveBeenCalledWith('hustlexp:feed:eligible:user_abc_456');
  });

  it('does not throw when redis is null (graceful degradation)', async () => {
    await expect(invalidateFeedCache('user_123', null)).resolves.not.toThrow();
  });

  it('does not throw when redis.del fails', async () => {
    const mock: RedisDelClient = {
      del: vi.fn().mockRejectedValue(new Error('Connection refused')),
    };
    await expect(invalidateFeedCache('user_xyz', mock)).resolves.not.toThrow();
  });

  it('generates distinct keys for different users', async () => {
    const mock = makeDelMock();
    await invalidateFeedCache('user_a', mock);
    await invalidateFeedCache('user_b', mock);
    expect(mock.del).toHaveBeenNthCalledWith(1, 'hustlexp:feed:eligible:user_a');
    expect(mock.del).toHaveBeenNthCalledWith(2, 'hustlexp:feed:eligible:user_b');
  });

  it('resolves even when redis.del returns 0 (key did not exist)', async () => {
    const mock = makeDelMock(0); // 0 = key not found, no-op — still valid
    await expect(invalidateFeedCache('user_no_cache', mock)).resolves.not.toThrow();
    expect(mock.del).toHaveBeenCalledOnce();
  });
});
