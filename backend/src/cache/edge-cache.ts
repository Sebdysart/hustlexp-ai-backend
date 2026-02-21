// ============================================================================
// HustleXP Edge Caching Middleware
// CDN-friendly cache headers for API responses
// ============================================================================

import { MiddlewareHandler } from 'hono';
import { logger } from '../logger';

const cacheLog = logger.child({ module: 'edge-cache' });

// ============================================================================
// Cache Configuration Types
// ============================================================================
interface CacheConfig {
  /** Time to live in seconds */
  ttl: number;
  
  /** 
   * Vary headers for cache key differentiation
   * Common values: ['Accept-Encoding', 'Accept-Language', 'Authorization']
   */
  vary?: string[];
  
  /** 
   * Private cache (user-specific) vs public cache (shared)
   * Private responses are not cached by shared caches (CDNs)
   */
  private?: boolean;
  
  /**
   * Stale-while-revalidate duration in seconds
   * Serve stale content while refreshing in background
   */
  staleWhileRevalidate?: number;
  
  /**
   * Stale-if-error duration in seconds
   * Serve stale content on origin errors
   */
  staleIfError?: number;
  
  /**
   * Must-revalidate directive
   * Forces revalidation after TTL expires
   */
  mustRevalidate?: boolean;
  
  /**
   * Immutable directive for versioned assets
   * Content never changes, cache forever
   */
  immutable?: boolean;
  
  /**
   * No-store directive
   * Never cache this response
   */
  noStore?: boolean;
  
  /**
   * No-cache directive
   * Must revalidate before using cached response
   */
  noCache?: boolean;
}

// ============================================================================
// Predefined Cache Profiles
// ============================================================================
export const CacheProfiles = {
  /** Static assets that never change (versioned URLs) */
  STATIC: {
    ttl: 31536000, // 1 year
    immutable: true,
    vary: ['Accept-Encoding'],
  } as CacheConfig,
  
  /** Semi-static content that changes infrequently */
  LONG: {
    ttl: 86400, // 1 day
    staleWhileRevalidate: 3600, // 1 hour
    vary: ['Accept-Encoding', 'Accept-Language'],
  } as CacheConfig,
  
  /** Medium-lived cache for reference data */
  MEDIUM: {
    ttl: 3600, // 1 hour
    staleWhileRevalidate: 300, // 5 minutes
    vary: ['Accept-Encoding'],
  } as CacheConfig,
  
  /** Short-lived cache for frequently changing data */
  SHORT: {
    ttl: 60, // 1 minute
    staleWhileRevalidate: 30,
    vary: ['Accept-Encoding'],
  } as CacheConfig,
  
  /** Private cache for user-specific data */
  PRIVATE: {
    ttl: 300, // 5 minutes
    private: true,
    vary: ['Accept-Encoding', 'Authorization'],
  } as CacheConfig,
  
  /** No caching */
  NONE: {
    noStore: true,
  } as CacheConfig,
  
  /** Must revalidate every time */
  REVALIDATE: {
    ttl: 0,
    noCache: true,
    mustRevalidate: true,
  } as CacheConfig,
};

// ============================================================================
// Build Cache-Control Header
// ============================================================================
function buildCacheControlHeader(config: CacheConfig): string {
  const directives: string[] = [];
  
  if (config.noStore) {
    directives.push('no-store');
    return directives.join(', ');
  }
  
  if (config.noCache) {
    directives.push('no-cache');
  }
  
  if (config.private) {
    directives.push('private');
  } else if (!config.noStore) {
    directives.push('public');
  }
  
  if (config.ttl !== undefined && config.ttl > 0) {
    directives.push(`max-age=${config.ttl}`);
    
    // s-maxage for shared caches (CDNs)
    if (!config.private) {
      directives.push(`s-maxage=${config.ttl}`);
    }
  }
  
  if (config.staleWhileRevalidate !== undefined && config.staleWhileRevalidate > 0) {
    directives.push(`stale-while-revalidate=${config.staleWhileRevalidate}`);
  }
  
  if (config.staleIfError !== undefined && config.staleIfError > 0) {
    directives.push(`stale-if-error=${config.staleIfError}`);
  }
  
  if (config.mustRevalidate) {
    directives.push('must-revalidate');
  }
  
  if (config.immutable) {
    directives.push('immutable');
  }
  
  return directives.join(', ');
}

// ============================================================================
// Edge Cache Middleware Factory
// ============================================================================
export function edgeCache(config: CacheConfig): MiddlewareHandler {
  return async (c, next) => {
    // Skip caching for non-GET/HEAD requests
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      await next();
      return;
    }
    
    // Skip if no-store
    if (config.noStore) {
      c.header('Cache-Control', 'no-store');
      await next();
      return;
    }
    
    // Execute the request
    await next();
    
    // Only cache successful responses
    if (c.res.status !== 200) {
      return;
    }
    
    // Build and set Cache-Control header
    const cacheControl = buildCacheControlHeader(config);
    c.header('Cache-Control', cacheControl);
    
    // Set Vary header if specified
    if (config.vary && config.vary.length > 0) {
      c.header('Vary', config.vary.join(', '));
    }
    
    // Add cache tags for Cloudflare (if using Cloudflare CDN)
    if (!config.private && config.ttl && config.ttl > 0) {
      // Extract tags from URL path for cache purging
      const url = new URL(c.req.url);
      const pathParts = url.pathname.split('/').filter(Boolean);
      if (pathParts.length > 0) {
        c.header('Cache-Tag', pathParts.join(','));
      }
    }
    
    cacheLog.debug({
      path: c.req.path,
      cacheControl,
      vary: config.vary,
    }, 'Cache headers set');
  };
}

// ============================================================================
// Conditional Cache Middleware
// ============================================================================
interface ConditionalCacheConfig extends CacheConfig {
  /** Only apply cache if condition returns true */
  condition?: (c: any) => boolean;
}

export function conditionalEdgeCache(config: ConditionalCacheConfig): MiddlewareHandler {
  return async (c, next) => {
    // Check condition
    if (config.condition && !config.condition(c)) {
      await next();
      return;
    }
    
    // Apply normal edge cache
    return edgeCache(config)(c, next);
  };
}

// ============================================================================
// Cache Invalidation Helper
// ============================================================================
interface CacheInvalidationConfig {
  /** Cloudflare API token */
  apiToken?: string;
  /** Cloudflare zone ID */
  zoneId?: string;
  /** Upstash Redis REST URL (for tag-based invalidation) */
  redisUrl?: string;
  /** Upstash Redis REST token */
  redisToken?: string;
}

/**
 * Purge Cloudflare cache by URL
 */
export async function purgeCloudflareCache(
  urls: string[],
  config: CacheInvalidationConfig
): Promise<void> {
  if (!config.apiToken || !config.zoneId) {
    cacheLog.warn('Cloudflare credentials not configured');
    return;
  }
  
  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${config.zoneId}/purge_cache`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ files: urls }),
      }
    );
    
    if (!response.ok) {
      throw new Error(`Cloudflare purge failed: ${response.statusText}`);
    }
    
    cacheLog.info({ urls }, 'Cloudflare cache purged');
  } catch (error) {
    cacheLog.error({ err: error, urls }, 'Failed to purge Cloudflare cache');
    throw error;
  }
}

/**
 * Purge Cloudflare cache by tag
 */
export async function purgeCloudflareCacheByTag(
  tags: string[],
  config: CacheInvalidationConfig
): Promise<void> {
  if (!config.apiToken || !config.zoneId) {
    cacheLog.warn('Cloudflare credentials not configured');
    return;
  }
  
  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${config.zoneId}/purge_cache`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ tags }),
      }
    );
    
    if (!response.ok) {
      throw new Error(`Cloudflare purge by tag failed: ${response.statusText}`);
    }
    
    cacheLog.info({ tags }, 'Cloudflare cache purged by tag');
  } catch (error) {
    cacheLog.error({ err: error, tags }, 'Failed to purge Cloudflare cache by tag');
    throw error;
  }
}

// ============================================================================
// ETag Support
// ============================================================================
export function generateETag(data: any): string {
  const crypto = require('crypto');
  const hash = crypto.createHash('md5');
  hash.update(JSON.stringify(data));
  return `"${hash.digest('hex')}"`;
}

/**
 * Middleware to handle conditional requests with ETag
 */
export function etagMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    
    // Only for successful GET requests
    if (c.req.method !== 'GET' || c.res.status !== 200) {
      return;
    }
    
    // Get response body
    const body = await c.res.clone().text();
    
    // Generate ETag
    const etag = generateETag(body);
    
    // Check If-None-Match header
    const ifNoneMatch = c.req.header('If-None-Match');
    if (ifNoneMatch === etag) {
      c.res = new Response(null, { status: 304 });
    }
    
    // Set ETag header
    c.header('ETag', etag);
  };
}
