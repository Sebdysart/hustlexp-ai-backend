/**
 * StripeService — Redis Connect Account Cache (TDD RED)
 *
 * Tests for two injectable cache helpers extracted from StripeServiceClass:
 *
 *   getConnectAccountFromRedis(userId, redis)
 *     Pure lookup: returns the Stripe Connect account ID stored at
 *     hustlexp:connect:{userId}, or null if not found / Redis unavailable.
 *
 *   setConnectAccountInRedis(userId, accountId, redis)
 *     Pure write: stores the account ID with a 24-hour TTL so it survives
 *     across server restarts and is shared across all instances.
 *
 * These functions are extracted from StripeServiceClass to make the cache
 * logic independently testable without requiring a real DB or Stripe client.
 * Both accept injectable Redis clients so no vi.mock() is needed.
 *
 * Cross-instance safety rationale:
 *   The module-level connectAccounts Map is process-local. In a multi-instance
 *   deployment (e.g., two Fastify pods behind a load balancer) one pod's Map
 *   is invisible to the other. Redis provides a shared durable layer.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  getConnectAccountFromRedis,
  setConnectAccountInRedis,
} from '../services/StripeService.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type RedisCacheGet = { get: (key: string) => Promise<string | null> };
type RedisCacheSet = { set: (key: string, value: string, opts: { ex: number }) => Promise<unknown> };

function makeGetMock(value: string | null): RedisCacheGet {
  return { get: vi.fn().mockResolvedValue(value) };
}
function makeSetMock(): RedisCacheSet {
  return { set: vi.fn().mockResolvedValue('OK') };
}

// ---------------------------------------------------------------------------
// getConnectAccountFromRedis
// ---------------------------------------------------------------------------

describe('getConnectAccountFromRedis', () => {
  it('returns null when redis client is null (Upstash not configured)', async () => {
    const result = await getConnectAccountFromRedis('user_123', null);
    expect(result).toBeNull();
  });

  it('returns the cached account ID when redis has the key', async () => {
    const mock = makeGetMock('acct_abc123');
    const result = await getConnectAccountFromRedis('user_123', mock);
    expect(result).toBe('acct_abc123');
  });

  it('looks up the canonical key hustlexp:connect:{userId}', async () => {
    const mock = makeGetMock('acct_xyz789');
    await getConnectAccountFromRedis('user_abc', mock);
    expect(mock.get).toHaveBeenCalledWith('hustlexp:connect:user_abc');
  });

  it('returns null when redis has no entry for the key', async () => {
    const mock = makeGetMock(null);
    const result = await getConnectAccountFromRedis('user_missing', mock);
    expect(result).toBeNull();
  });

  it('returns null gracefully when redis.get throws (never propagates errors)', async () => {
    const mock: RedisCacheGet = { get: vi.fn().mockRejectedValue(new Error('Redis timeout')) };
    const result = await getConnectAccountFromRedis('user_err', mock);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// setConnectAccountInRedis
// ---------------------------------------------------------------------------

describe('setConnectAccountInRedis', () => {
  it('calls redis.set with the canonical key, value, and 24h TTL', async () => {
    const mock = makeSetMock();
    await setConnectAccountInRedis('user_123', 'acct_stripe_456', mock);
    expect(mock.set).toHaveBeenCalledWith(
      'hustlexp:connect:user_123',
      'acct_stripe_456',
      { ex: 86_400 },
    );
  });

  it('is a no-op when redis is null (Upstash not configured)', async () => {
    await expect(
      setConnectAccountInRedis('user_123', 'acct_456', null),
    ).resolves.not.toThrow();
  });

  it('does not throw when redis.set fails (never breaks the write path)', async () => {
    const mock: RedisCacheSet = {
      set: vi.fn().mockRejectedValue(new Error('Redis OOM')),
    };
    await expect(
      setConnectAccountInRedis('user_err', 'acct_err', mock),
    ).resolves.not.toThrow();
  });

  it('uses user_123 as a distinct key segment from user_1234', async () => {
    const mock = makeSetMock();
    await setConnectAccountInRedis('user_123', 'acct_a', mock);
    await setConnectAccountInRedis('user_1234', 'acct_b', mock);
    expect(mock.set).toHaveBeenNthCalledWith(1, 'hustlexp:connect:user_123', 'acct_a', { ex: 86_400 });
    expect(mock.set).toHaveBeenNthCalledWith(2, 'hustlexp:connect:user_1234', 'acct_b', { ex: 86_400 });
  });
});
