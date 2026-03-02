/**
 * CapabilityProfileService — Redis Feed Cache Invalidation (TDD RED)
 *
 * Tests for the exported `invalidateProfileFeedCache(userId, redis)` function.
 *
 * Current state (stub):
 *   `invalidateFeedCache` is a private function inside CapabilityProfileService
 *   that only logs. It is not exported and cannot be tested directly.
 *
 * Target behavior:
 *   Export `invalidateProfileFeedCache` as a testable pure function.
 *   When called after a `recompute()`, it must DEL the user's feed cache key
 *   so stale eligibility data is never served.
 *
 * Same cache key as FeedQueryService:
 *   `hustlexp:feed:eligible:{userId}`
 *   Both services share the same key because CapabilityProfileService drives
 *   the capability changes that determine feed eligibility. When a profile is
 *   recomputed, the FeedQueryService cache for that user is stale.
 *
 * Graceful degradation:
 *   Cache invalidation must NEVER block or fail the profile recompute.
 *   If Redis throws, log a warning and continue — the recompute already
 *   committed to the database.
 *
 * Why a separate export instead of delegating to FeedQueryService?
 *   CapabilityProfileService cannot import FeedQueryService (circular risk:
 *   FeedQueryService imports RiskLevel from CapabilityProfileService).
 *   An independent exported function breaks the circular dependency while
 *   keeping the invalidation logic co-located with the service that triggers it.
 */
import { describe, it, expect, vi } from 'vitest';
import { invalidateProfileFeedCache } from '../services/CapabilityProfileService.js';

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

describe('invalidateProfileFeedCache', () => {
  it('calls redis.del with the feed cache key for the user', async () => {
    const mock = makeDelMock();
    await invalidateProfileFeedCache('user_456', mock);
    expect(mock.del).toHaveBeenCalledWith('hustlexp:feed:eligible:user_456');
  });

  it('uses the same key as FeedQueryService for consistency', async () => {
    const mock = makeDelMock();
    await invalidateProfileFeedCache('user_consistency', mock);
    // Key must match FeedQueryService pattern exactly so both services
    // target the same cache entry.
    expect(mock.del).toHaveBeenCalledWith('hustlexp:feed:eligible:user_consistency');
  });

  it('does not throw when redis is null (Upstash not configured)', async () => {
    await expect(
      invalidateProfileFeedCache('user_123', null),
    ).resolves.not.toThrow();
  });

  it('does not throw when redis.del fails (never blocks recompute)', async () => {
    const mock: RedisDelClient = {
      del: vi.fn().mockRejectedValue(new Error('Redis error')),
    };
    await expect(
      invalidateProfileFeedCache('user_err', mock),
    ).resolves.not.toThrow();
  });

  it('handles any userId format without throwing', async () => {
    const mock = makeDelMock();
    // UUIDs, numeric IDs, and prefixed IDs are all valid
    await invalidateProfileFeedCache('550e8400-e29b-41d4-a716-446655440000', mock);
    await invalidateProfileFeedCache('usr_12345', mock);
    expect(mock.del).toHaveBeenCalledTimes(2);
  });
});
