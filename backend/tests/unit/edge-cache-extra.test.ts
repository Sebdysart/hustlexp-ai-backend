/**
 * edge-cache.ts Extra Unit Tests
 *
 * Tests buildCacheControlHeader logic, CacheProfiles, edgeCache middleware,
 * conditionalEdgeCache, generateETag, and purge functions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/logger', () => ({
  logger: {
    child: () => ({
      warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(),
    }),
  },
}));

import {
  CacheProfiles,
  edgeCache,
  conditionalEdgeCache,
  generateETag,
  purgeCloudflareCache,
  purgeCloudflareCacheByTag,
  etagMiddleware,
} from '../../src/cache/edge-cache';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeContext(options: {
  method?: string;
  status?: number;
  url?: string;
  ifNoneMatch?: string;
}) {
  const {
    method = 'GET',
    status = 200,
    url = 'http://localhost/api/tasks',
    ifNoneMatch,
  } = options;

  const responseHeaders: Record<string, string> = {};
  const requestHeaders: Record<string, string> = {};
  if (ifNoneMatch) requestHeaders['If-None-Match'] = ifNoneMatch;

  const mockContext = {
    req: {
      method,
      url,
      path: new URL(url).pathname,
      header: (name: string) => requestHeaders[name],
    },
    res: {
      status,
    } as { status: number },
    header: vi.fn((name: string, value: string) => {
      responseHeaders[name] = value;
    }),
    _responseHeaders: responseHeaders,
  };

  return mockContext;
}

// ============================================================================
// CacheProfiles
// ============================================================================

describe('CacheProfiles', () => {
  it('STATIC has ttl of 1 year (31536000)', () => {
    expect(CacheProfiles.STATIC.ttl).toBe(31536000);
    expect(CacheProfiles.STATIC.immutable).toBe(true);
  });

  it('LONG has ttl of 1 day (86400) with stale-while-revalidate', () => {
    expect(CacheProfiles.LONG.ttl).toBe(86400);
    expect(CacheProfiles.LONG.staleWhileRevalidate).toBe(3600);
  });

  it('MEDIUM has ttl of 1 hour (3600)', () => {
    expect(CacheProfiles.MEDIUM.ttl).toBe(3600);
    expect(CacheProfiles.MEDIUM.staleWhileRevalidate).toBe(300);
  });

  it('SHORT has ttl of 60 seconds', () => {
    expect(CacheProfiles.SHORT.ttl).toBe(60);
    expect(CacheProfiles.SHORT.staleWhileRevalidate).toBe(30);
  });

  it('PRIVATE has private=true', () => {
    expect(CacheProfiles.PRIVATE.private).toBe(true);
    expect(CacheProfiles.PRIVATE.ttl).toBe(300);
  });

  it('NONE has noStore=true', () => {
    expect(CacheProfiles.NONE.noStore).toBe(true);
  });

  it('REVALIDATE has noCache=true and mustRevalidate=true', () => {
    expect(CacheProfiles.REVALIDATE.noCache).toBe(true);
    expect(CacheProfiles.REVALIDATE.mustRevalidate).toBe(true);
  });
});

// ============================================================================
// edgeCache middleware
// ============================================================================

describe('edgeCache middleware', () => {
  it('skips caching for POST requests', async () => {
    const ctx = makeContext({ method: 'POST', status: 200 });
    const next = vi.fn().mockResolvedValue(undefined);

    await edgeCache(CacheProfiles.MEDIUM)(ctx as never, next);

    expect(next).toHaveBeenCalled();
    expect(ctx.header).not.toHaveBeenCalled();
  });

  it('skips caching for PUT requests', async () => {
    const ctx = makeContext({ method: 'PUT', status: 200 });
    const next = vi.fn().mockResolvedValue(undefined);

    await edgeCache(CacheProfiles.MEDIUM)(ctx as never, next);

    expect(ctx.header).not.toHaveBeenCalled();
  });

  it('allows HEAD requests through to cache logic', async () => {
    const ctx = makeContext({ method: 'HEAD', status: 200 });
    const next = vi.fn().mockResolvedValue(undefined);

    await edgeCache(CacheProfiles.SHORT)(ctx as never, next);

    expect(next).toHaveBeenCalled();
  });

  it('sets no-store header immediately for noStore config', async () => {
    const ctx = makeContext({ method: 'GET', status: 200 });
    const next = vi.fn().mockResolvedValue(undefined);

    await edgeCache(CacheProfiles.NONE)(ctx as never, next);

    expect(ctx.header).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(next).toHaveBeenCalled();
  });

  it('sets Cache-Control header for GET 200 response', async () => {
    const ctx = makeContext({ method: 'GET', status: 200 });
    const next = vi.fn().mockResolvedValue(undefined);

    await edgeCache(CacheProfiles.SHORT)(ctx as never, next);

    expect(ctx.header).toHaveBeenCalledWith(
      'Cache-Control',
      expect.stringContaining('max-age=60')
    );
  });

  it('does not set Cache-Control for non-200 responses', async () => {
    const ctx = makeContext({ method: 'GET', status: 404 });
    const next = vi.fn().mockResolvedValue(undefined);

    await edgeCache(CacheProfiles.SHORT)(ctx as never, next);

    // header should not have been called with Cache-Control
    const cacheCalls = (ctx.header as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([name]) => name === 'Cache-Control'
    );
    expect(cacheCalls).toHaveLength(0);
  });

  it('sets Vary header when vary is specified', async () => {
    const ctx = makeContext({ method: 'GET', status: 200 });
    const next = vi.fn().mockResolvedValue(undefined);

    await edgeCache(CacheProfiles.LONG)(ctx as never, next);

    const varyCalls = (ctx.header as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([name]) => name === 'Vary'
    );
    expect(varyCalls.length).toBeGreaterThan(0);
    expect(varyCalls[0][1]).toContain('Accept-Encoding');
  });

  it('sets s-maxage for public cache config', async () => {
    const ctx = makeContext({ method: 'GET', status: 200 });
    const next = vi.fn().mockResolvedValue(undefined);

    await edgeCache(CacheProfiles.MEDIUM)(ctx as never, next);

    const cacheCalls = (ctx.header as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([name]) => name === 'Cache-Control'
    );
    expect(cacheCalls[0][1]).toContain('s-maxage=3600');
  });

  it('does not set s-maxage for private cache', async () => {
    const ctx = makeContext({ method: 'GET', status: 200 });
    const next = vi.fn().mockResolvedValue(undefined);

    await edgeCache(CacheProfiles.PRIVATE)(ctx as never, next);

    const cacheCalls = (ctx.header as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([name]) => name === 'Cache-Control'
    );
    const cacheControlValue = cacheCalls[0][1] as string;
    expect(cacheControlValue).not.toContain('s-maxage');
    expect(cacheControlValue).toContain('private');
  });

  it('sets immutable directive for STATIC profile', async () => {
    const ctx = makeContext({ method: 'GET', status: 200 });
    const next = vi.fn().mockResolvedValue(undefined);

    await edgeCache(CacheProfiles.STATIC)(ctx as never, next);

    const cacheCalls = (ctx.header as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([name]) => name === 'Cache-Control'
    );
    expect(cacheCalls[0][1]).toContain('immutable');
  });

  it('sets must-revalidate directive for REVALIDATE profile', async () => {
    const ctx = makeContext({ method: 'GET', status: 200 });
    const next = vi.fn().mockResolvedValue(undefined);

    await edgeCache(CacheProfiles.REVALIDATE)(ctx as never, next);

    const cacheCalls = (ctx.header as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([name]) => name === 'Cache-Control'
    );
    expect(cacheCalls[0][1]).toContain('must-revalidate');
    expect(cacheCalls[0][1]).toContain('no-cache');
  });

  it('sets Cache-Tag header based on URL path segments', async () => {
    const ctx = makeContext({ method: 'GET', status: 200, url: 'http://localhost/api/tasks/feed' });
    const next = vi.fn().mockResolvedValue(undefined);

    await edgeCache(CacheProfiles.SHORT)(ctx as never, next);

    const tagCalls = (ctx.header as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([name]) => name === 'Cache-Tag'
    );
    expect(tagCalls.length).toBeGreaterThan(0);
    expect(tagCalls[0][1]).toContain('api');
  });
});

// ============================================================================
// conditionalEdgeCache
// ============================================================================

describe('conditionalEdgeCache middleware', () => {
  it('applies cache when condition returns true', async () => {
    const ctx = makeContext({ method: 'GET', status: 200 });
    const next = vi.fn().mockResolvedValue(undefined);

    await conditionalEdgeCache({
      ...CacheProfiles.SHORT,
      condition: () => true,
    })(ctx as never, next);

    const cacheCalls = (ctx.header as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([name]) => name === 'Cache-Control'
    );
    expect(cacheCalls.length).toBeGreaterThan(0);
  });

  it('skips cache when condition returns false', async () => {
    const ctx = makeContext({ method: 'GET', status: 200 });
    const next = vi.fn().mockResolvedValue(undefined);

    await conditionalEdgeCache({
      ...CacheProfiles.SHORT,
      condition: () => false,
    })(ctx as never, next);

    expect(next).toHaveBeenCalled();
    // Cache-Control should not be set when condition is false
    const cacheCalls = (ctx.header as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([name]) => name === 'Cache-Control'
    );
    expect(cacheCalls).toHaveLength(0);
  });

  it('applies cache normally when no condition provided', async () => {
    const ctx = makeContext({ method: 'GET', status: 200 });
    const next = vi.fn().mockResolvedValue(undefined);

    await conditionalEdgeCache(CacheProfiles.SHORT)(ctx as never, next);

    const cacheCalls = (ctx.header as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([name]) => name === 'Cache-Control'
    );
    expect(cacheCalls.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// generateETag
// ============================================================================

describe('generateETag', () => {
  it('generates an ETag string starting and ending with quotes', () => {
    const tag = generateETag({ id: 1, name: 'test' });
    expect(tag.startsWith('"')).toBe(true);
    expect(tag.endsWith('"')).toBe(true);
  });

  it('generates consistent ETag for same input', () => {
    const data = { items: [1, 2, 3], total: 3 };
    const tag1 = generateETag(data);
    const tag2 = generateETag(data);
    expect(tag1).toBe(tag2);
  });

  it('generates different ETags for different inputs', () => {
    const tag1 = generateETag({ id: 1 });
    const tag2 = generateETag({ id: 2 });
    expect(tag1).not.toBe(tag2);
  });

  it('generates ETag for string input', () => {
    const tag = generateETag('hello world');
    expect(typeof tag).toBe('string');
    expect(tag.length).toBeGreaterThan(2);
  });

  it('generates ETag for array input', () => {
    const tag = generateETag([1, 2, 3]);
    expect(tag).toMatch(/^"[a-f0-9]+"$/);
  });
});

// ============================================================================
// purgeCloudflareCache
// ============================================================================

describe('purgeCloudflareCache', () => {
  it('returns early without calling fetch when apiToken is missing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));

    await purgeCloudflareCache(['https://example.com/api'], {
      zoneId: 'zone-123',
      // no apiToken
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('returns early without calling fetch when zoneId is missing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));

    await purgeCloudflareCache(['https://example.com/api'], {
      apiToken: 'token-123',
      // no zoneId
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('calls Cloudflare API when credentials are provided', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"success":true}', { status: 200 })
    );

    await purgeCloudflareCache(['https://example.com/api/tasks'], {
      apiToken: 'cf-token',
      zoneId: 'cf-zone-123',
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('cf-zone-123'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer cf-token',
        }),
      })
    );
    fetchSpy.mockRestore();
  });

  it('throws when Cloudflare API returns non-ok response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' })
    );

    await expect(
      purgeCloudflareCache(['https://example.com/api'], {
        apiToken: 'bad-token',
        zoneId: 'cf-zone',
      })
    ).rejects.toThrow();

    vi.restoreAllMocks();
  });
});

// ============================================================================
// purgeCloudflareCacheByTag
// ============================================================================

describe('purgeCloudflareCacheByTag', () => {
  it('returns early without calling fetch when credentials missing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));

    await purgeCloudflareCacheByTag(['tag-1'], { zoneId: 'zone-123' });

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('calls Cloudflare API with tags payload', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"success":true}', { status: 200 })
    );

    await purgeCloudflareCacheByTag(['tag-1', 'tag-2'], {
      apiToken: 'cf-token',
      zoneId: 'cf-zone',
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('tag-1'),
      })
    );
    fetchSpy.mockRestore();
  });
});
