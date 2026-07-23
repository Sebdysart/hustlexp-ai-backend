/**
 * config.ts Unit Tests
 *
 * Tests configuration object values from environment variables
 * and the validateConfig() function.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Save original env
const originalEnv = { ...process.env };

afterEach(() => {
  // Restore env after each test
  process.env = { ...originalEnv };
  vi.resetModules();
});

// ============================================================================
// Default values (no env vars set)
// ============================================================================

describe('config — default values', () => {
  it('database url defaults to empty string', async () => {
    delete process.env.DATABASE_URL;
    vi.resetModules();
    const { config } = await import('../../src/config');
    expect(config.database.url).toBe('');
  });

  it('database pgbouncer defaults to false', async () => {
    delete process.env.DB_PGBOUNCER;
    vi.resetModules();
    const { config } = await import('../../src/config');
    expect(config.database.pgbouncer).toBe(false);
  });

  it('stripe platformFeePercent defaults to 15', async () => {
    delete process.env.PLATFORM_FEE_PERCENT;
    vi.resetModules();
    const { config } = await import('../../src/config');
    expect(config.stripe.platformFeePercent).toBe(15);
  });

  it('stripe minimumTaskValueCents defaults to 500', async () => {
    delete process.env.MIN_TASK_VALUE_CENTS;
    vi.resetModules();
    const { config } = await import('../../src/config');
    expect(config.stripe.minimumTaskValueCents).toBe(500);
  });

  it('app port defaults to 3000', async () => {
    delete process.env.PORT;
    vi.resetModules();
    const { config } = await import('../../src/config');
    expect(config.app.port).toBe(3000);
  });

  it('app env defaults to development', async () => {
    delete process.env.NODE_ENV;
    vi.resetModules();
    const { config } = await import('../../src/config');
    expect(config.app.env).toBe('development');
  });

  it('app isDevelopment is true when NODE_ENV is not production', async () => {
    process.env.NODE_ENV = 'test';
    vi.resetModules();
    const { config } = await import('../../src/config');
    expect(config.app.isDevelopment).toBe(true);
    expect(config.app.isProduction).toBe(false);
  });

  it('app isProduction is true when NODE_ENV is production', async () => {
    process.env.NODE_ENV = 'production';
    vi.resetModules();
    const { config } = await import('../../src/config');
    expect(config.app.isProduction).toBe(true);
    expect(config.app.isDevelopment).toBe(false);
  });

  it('openai model defaults to gpt-4o', async () => {
    delete process.env.OPENAI_MODEL;
    vi.resetModules();
    const { config } = await import('../../src/config');
    expect(config.ai.openai.model).toBe('gpt-4o');
  });

  it('groq model defaults to llama-3.3-70b-versatile', async () => {
    delete process.env.GROQ_MODEL;
    vi.resetModules();
    const { config } = await import('../../src/config');
    expect(config.ai.groq.model).toBe('llama-3.3-70b-versatile');
  });

  it('deepseek model defaults to deepseek-r1', async () => {
    delete process.env.DEEPSEEK_MODEL;
    vi.resetModules();
    const { config } = await import('../../src/config');
    expect(config.ai.deepseek.model).toBe('deepseek-r1');
  });

  it('anthropic model defaults to claude-sonnet-4-20250514', async () => {
    delete process.env.ANTHROPIC_MODEL;
    vi.resetModules();
    const { config } = await import('../../src/config');
    expect(config.ai.anthropic.model).toBe('claude-sonnet-4-20250514');
  });

  it('alibaba model defaults to qwen-max', async () => {
    delete process.env.ALIBABA_MODEL;
    vi.resetModules();
    const { config } = await import('../../src/config');
    expect(config.ai.alibaba.model).toBe('qwen-max');
  });

  it('ai route primary defaults to openai', async () => {
    delete process.env.AI_ROUTE_PRIMARY;
    vi.resetModules();
    const { config } = await import('../../src/config');
    expect(config.ai.routing.primary).toBe('openai');
  });

  it('ai route fast defaults to groq', async () => {
    delete process.env.AI_ROUTE_FAST;
    vi.resetModules();
    const { config } = await import('../../src/config');
    expect(config.ai.routing.fast).toBe('groq');
  });

  it('ai cache TTL defaults to 86400 (24 hours)', async () => {
    delete process.env.AI_CACHE_TTL;
    vi.resetModules();
    const { config } = await import('../../src/config');
    expect(config.ai.cacheTTL).toBe(86400);
  });

  it('r2 bucket defaults to hustlexp-storage', async () => {
    delete process.env.R2_BUCKET_NAME;
    vi.resetModules();
    const { config } = await import('../../src/config');
    expect(config.cloudflare.r2.bucketName).toBe('hustlexp-storage');
  });

  it('sendgrid fromEmail defaults to verify@hustlexp.app', async () => {
    delete process.env.SENDGRID_FROM_EMAIL;
    vi.resetModules();
    const { config } = await import('../../src/config');
    expect(config.identity.sendgrid.fromEmail).toBe('verify@hustlexp.app');
  });

  it('sentry tracesSampleRate defaults to 0.1', async () => {
    delete process.env.SENTRY_TRACES_SAMPLE_RATE;
    vi.resetModules();
    const { config } = await import('../../src/config');
    expect(config.sentry.tracesSampleRate).toBe(0.1);
  });

  it('datadog enabled defaults to false', async () => {
    delete process.env.DATADOG_ENABLED;
    vi.resetModules();
    const { config } = await import('../../src/config');
    expect(config.datadog.enabled).toBe(false);
  });

  it('datadog agentHost defaults to localhost', async () => {
    delete process.env.DD_AGENT_HOST;
    vi.resetModules();
    const { config } = await import('../../src/config');
    expect(config.datadog.agentHost).toBe('localhost');
  });

  it('datadog agentPort defaults to 8125', async () => {
    delete process.env.DD_AGENT_PORT;
    vi.resetModules();
    const { config } = await import('../../src/config');
    expect(config.datadog.agentPort).toBe(8125);
  });

  it('beta enabled defaults to false', async () => {
    delete process.env.BETA_ENABLED;
    vi.resetModules();
    const { config } = await import('../../src/config');
    expect(config.beta.enabled).toBe(false);
  });

  it('beta startDate defaults to 2026-02-22', async () => {
    delete process.env.BETA_START_DATE;
    vi.resetModules();
    const { config } = await import('../../src/config');
    expect(config.beta.startDate).toBe('2026-02-22');
  });

  it('beta maxUsers is 100', async () => {
    vi.resetModules();
    const { config } = await import('../../src/config');
    expect(config.beta.maxUsers).toBe(100);
  });

  it('beta maxGmvCents is 1,000,000 ($10,000)', async () => {
    vi.resetModules();
    const { config } = await import('../../src/config');
    expect(config.beta.maxGmvCents).toBe(1_000_000);
  });

  it('allowedOrigins defaults to empty array when ALLOWED_ORIGINS not set', async () => {
    delete process.env.ALLOWED_ORIGINS;
    vi.resetModules();
    const { config } = await import('../../src/config');
    expect(config.app.allowedOrigins).toEqual([]);
  });
});

// ============================================================================
// Environment variable overrides
// ============================================================================

describe('config — env var overrides', () => {
  it('reads DATABASE_URL from env', async () => {
    process.env.DATABASE_URL = 'postgres://test:5432/db';
    vi.resetModules();
    const { config } = await import('../../src/config');
    expect(config.database.url).toBe('postgres://test:5432/db');
  });

  it('reads DB_PGBOUNCER=true', async () => {
    process.env.DB_PGBOUNCER = 'true';
    vi.resetModules();
    const { config } = await import('../../src/config');
    expect(config.database.pgbouncer).toBe(true);
  });

  it('reads PORT from env', async () => {
    process.env.PORT = '8080';
    vi.resetModules();
    const { config } = await import('../../src/config');
    expect(config.app.port).toBe(8080);
  });

  it('reads PLATFORM_FEE_PERCENT from env', async () => {
    process.env.PLATFORM_FEE_PERCENT = '20';
    vi.resetModules();
    const { config } = await import('../../src/config');
    expect(config.stripe.platformFeePercent).toBe(20);
  });

  it('reads BETA_ENABLED=true from env', async () => {
    process.env.BETA_ENABLED = 'true';
    vi.resetModules();
    const { config } = await import('../../src/config');
    expect(config.beta.enabled).toBe(true);
  });

  it('reads DATADOG_ENABLED=true from env', async () => {
    process.env.DATADOG_ENABLED = 'true';
    vi.resetModules();
    const { config } = await import('../../src/config');
    expect(config.datadog.enabled).toBe(true);
  });

  it('reads ALLOWED_ORIGINS as comma-separated list', async () => {
    process.env.ALLOWED_ORIGINS = 'https://app.hustlexp.com,https://admin.hustlexp.com';
    vi.resetModules();
    const { config } = await import('../../src/config');
    expect(config.app.allowedOrigins).toEqual([
      'https://app.hustlexp.com',
      'https://admin.hustlexp.com',
    ]);
  });

  it('reads FIREBASE_PRIVATE_KEY replacing \\n with newline', async () => {
    process.env.FIREBASE_PRIVATE_KEY = 'line1\\nline2';
    vi.resetModules();
    const { config } = await import('../../src/config');
    expect(config.firebase.privateKey).toBe('line1\nline2');
  });

  it('reads redis restUrl from UPSTASH_REDIS_REST_URL', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.upstash.io';
    vi.resetModules();
    const { config } = await import('../../src/config');
    expect(config.redis.restUrl).toBe('https://redis.upstash.io');
  });

  it('prefers UPSTASH_REDIS_URL over REDIS_URL for direct TCP', async () => {
    process.env.UPSTASH_REDIS_URL = 'redis://upstash:6379';
    process.env.REDIS_URL = 'redis://fallback:6379';
    vi.resetModules();
    const { config } = await import('../../src/config');
    expect(config.redis.url).toBe('redis://upstash:6379');
  });

  it('falls back to REDIS_URL when UPSTASH_REDIS_URL not set', async () => {
    delete process.env.UPSTASH_REDIS_URL;
    process.env.REDIS_URL = 'redis://fallback:6379';
    vi.resetModules();
    const { config } = await import('../../src/config');
    expect(config.redis.url).toBe('redis://fallback:6379');
  });

  it('reads AI_CACHE_TTL from env', async () => {
    process.env.AI_CACHE_TTL = '3600';
    vi.resetModules();
    const { config } = await import('../../src/config');
    expect(config.ai.cacheTTL).toBe(3600);
  });

  it('reads SENTRY_DSN from env', async () => {
    process.env.SENTRY_DSN = 'https://sentry.io/123';
    vi.resetModules();
    const { config } = await import('../../src/config');
    expect(config.sentry.dsn).toBe('https://sentry.io/123');
  });
});

// ============================================================================
// Stripe plans configuration (hardcoded)
// ============================================================================

describe('config — stripe plans', () => {
  it('premium monthly price is 1499 cents ($14.99)', async () => {
    vi.resetModules();
    const { config } = await import('../../src/config');
    expect(config.stripe.plans.premium.monthlyPriceCents).toBe(1499);
  });

  it('premium yearly price is 14999 cents ($149.99)', async () => {
    vi.resetModules();
    const { config } = await import('../../src/config');
    expect(config.stripe.plans.premium.yearlyPriceCents).toBe(14999);
  });

  it('pro monthly price is 2999 cents ($29.99)', async () => {
    vi.resetModules();
    const { config } = await import('../../src/config');
    expect(config.stripe.plans.pro.monthlyPriceCents).toBe(2999);
  });

  it('pro yearly price is 29999 cents ($299.99)', async () => {
    vi.resetModules();
    const { config } = await import('../../src/config');
    expect(config.stripe.plans.pro.yearlyPriceCents).toBe(29999);
  });
});

// ============================================================================
// Beta geographic configuration (hardcoded)
// ============================================================================

describe('config — beta geo', () => {
  it('beta region is Seattle Metro', async () => {
    vi.resetModules();
    const { config } = await import('../../src/config');
    expect(config.beta.regionName).toBe('Seattle Metro');
  });

  it('beta center lat is approximately 47.6', async () => {
    vi.resetModules();
    const { config } = await import('../../src/config');
    expect(config.beta.center.lat).toBeCloseTo(47.6, 1);
  });

  it('beta radiusMiles is 15', async () => {
    vi.resetModules();
    const { config } = await import('../../src/config');
    expect(config.beta.radiusMiles).toBe(15);
  });
});

// ============================================================================
// validateConfig
// ============================================================================

describe('validateConfig', () => {
  // SECURITY FIX (v2.9.4): validateConfig now calls process.exit(1) in
  // production when fatal errors are present. Mock process.exit so the test
  // process does not actually exit; verify it is called where expected.
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as () => never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('returns valid=false with DATABASE_URL error when not set', async () => {
    delete process.env.DATABASE_URL;
    process.env.NODE_ENV = 'test';
    vi.resetModules();
    const { validateConfig } = await import('../../src/config');
    const result = validateConfig();
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('DATABASE_URL is required');
    // Non-production: process.exit must NOT be called
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('returns valid=true when DATABASE_URL is set in non-production', async () => {
    process.env.DATABASE_URL = 'postgres://localhost:5432/test';
    process.env.NODE_ENV = 'test';
    vi.resetModules();
    const { validateConfig } = await import('../../src/config');
    const result = validateConfig();
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('returns production errors when NODE_ENV=production and required vars missing', async () => {
    process.env.DATABASE_URL = 'postgres://localhost:5432/prod';
    process.env.NODE_ENV = 'production';
    delete process.env.FIREBASE_PROJECT_ID;
    delete process.env.FIREBASE_PRIVATE_KEY;
    delete process.env.FIREBASE_CLIENT_EMAIL;
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_URL;
    delete process.env.REDIS_URL;
    delete process.env.TAX_TIN_ENCRYPTION_KEY;
    vi.resetModules();
    const { validateConfig } = await import('../../src/config');
    // process.exit is mocked — validateConfig continues after the call
    const result = validateConfig();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('FIREBASE_PROJECT_ID'))).toBe(true);
    expect(result.errors.some(e => e.includes('STRIPE_SECRET_KEY'))).toBe(true);
    expect(result.errors.some(e => e.includes('TAX_TIN_ENCRYPTION_KEY'))).toBe(true);
  });

  it('calls process.exit(1) in production when Firebase config is missing', async () => {
    process.env.DATABASE_URL = 'postgres://prod';
    process.env.NODE_ENV = 'production';
    delete process.env.FIREBASE_PROJECT_ID;
    delete process.env.FIREBASE_PRIVATE_KEY;
    delete process.env.FIREBASE_CLIENT_EMAIL;
    process.env.STRIPE_SECRET_KEY = 'sk_live_real_key';
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.upstash.io';
    process.env.UPSTASH_REDIS_URL = 'redis://upstash:6379';
    process.env.QUEUE_HMAC_SECRET = 'real-hmac-secret';
    process.env.TAX_TIN_ENCRYPTION_KEY = 'a'.repeat(64);
    vi.resetModules();
    const { validateConfig } = await import('../../src/config');
    validateConfig();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('does NOT call process.exit in development when Firebase config is missing', async () => {
    process.env.DATABASE_URL = 'postgres://localhost:5432/dev';
    process.env.NODE_ENV = 'development';
    delete process.env.FIREBASE_PROJECT_ID;
    delete process.env.FIREBASE_PRIVATE_KEY;
    delete process.env.FIREBASE_CLIENT_EMAIL;
    vi.resetModules();
    const { validateConfig } = await import('../../src/config');
    validateConfig();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('validates TAX_TIN_ENCRYPTION_KEY format (64 hex chars)', async () => {
    process.env.DATABASE_URL = 'postgres://localhost:5432/prod';
    process.env.NODE_ENV = 'production';
    process.env.FIREBASE_PROJECT_ID = 'test-project';
    process.env.FIREBASE_PRIVATE_KEY = 'key';
    process.env.FIREBASE_CLIENT_EMAIL = 'test@test.com';
    process.env.STRIPE_SECRET_KEY = 'sk_live_real_key';
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.upstash.io';
    process.env.UPSTASH_REDIS_URL = 'redis://upstash:6379';
    // Invalid key (not 64 hex chars)
    process.env.TAX_TIN_ENCRYPTION_KEY = 'tooshort';
    vi.resetModules();
    const { validateConfig } = await import('../../src/config');
    const result = validateConfig();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(result.errors.some(e => e.includes('64 hex characters'))).toBe(true);
  });

  it('accepts valid 64-char hex TAX_TIN_ENCRYPTION_KEY', async () => {
    process.env.DATABASE_URL = 'postgres://localhost:5432/prod';
    process.env.NODE_ENV = 'production';
    process.env.FIREBASE_PROJECT_ID = 'test-project';
    process.env.FIREBASE_PRIVATE_KEY = 'key';
    process.env.FIREBASE_CLIENT_EMAIL = 'test@test.com';
    process.env.STRIPE_SECRET_KEY = 'sk_live_real_key';
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.upstash.io';
    process.env.UPSTASH_REDIS_URL = 'redis://upstash:6379';
    process.env.QUEUE_HMAC_SECRET = 'real-hmac-secret';
    process.env.TAX_TIN_ENCRYPTION_KEY = 'a'.repeat(64); // 64 'a's = valid hex
    vi.resetModules();
    const { validateConfig } = await import('../../src/config');
    const result = validateConfig();
    // All required vars present — process.exit must NOT be called
    expect(exitSpy).not.toHaveBeenCalled();
    const taxErrors = result.errors.filter(e => e.includes('TAX_TIN_ENCRYPTION_KEY'));
    expect(taxErrors).toHaveLength(0);
  });

  it('warns about R2 storage in production when not configured', async () => {
    process.env.DATABASE_URL = 'postgres://localhost:5432/prod';
    process.env.NODE_ENV = 'production';
    process.env.FIREBASE_PROJECT_ID = 'proj';
    process.env.FIREBASE_PRIVATE_KEY = 'key';
    process.env.FIREBASE_CLIENT_EMAIL = 'a@b.com';
    process.env.STRIPE_SECRET_KEY = 'sk_live_real';
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.upstash.io';
    process.env.UPSTASH_REDIS_URL = 'redis://upstash:6379';
    process.env.QUEUE_HMAC_SECRET = 'real-hmac-secret';
    process.env.TAX_TIN_ENCRYPTION_KEY = 'a'.repeat(64);
    delete process.env.R2_ACCOUNT_ID;
    delete process.env.R2_ACCESS_KEY_ID;
    delete process.env.R2_SECRET_ACCESS_KEY;
    vi.resetModules();
    const { validateConfig } = await import('../../src/config');
    const result = validateConfig();
    // R2 absence is a warning, not a fatal error — process.exit must NOT be called
    expect(exitSpy).not.toHaveBeenCalled();
    expect(result.warnings.some(w => w.includes('R2'))).toBe(true);
  });

  it('warns about SendGrid when not configured in production', async () => {
    process.env.DATABASE_URL = 'postgres://localhost:5432/prod';
    process.env.NODE_ENV = 'production';
    process.env.FIREBASE_PROJECT_ID = 'proj';
    process.env.FIREBASE_PRIVATE_KEY = 'key';
    process.env.FIREBASE_CLIENT_EMAIL = 'a@b.com';
    process.env.STRIPE_SECRET_KEY = 'sk_live_real';
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.upstash.io';
    process.env.UPSTASH_REDIS_URL = 'redis://upstash:6379';
    process.env.QUEUE_HMAC_SECRET = 'real-hmac-secret';
    process.env.TAX_TIN_ENCRYPTION_KEY = 'a'.repeat(64);
    delete process.env.SENDGRID_API_KEY;
    vi.resetModules();
    const { validateConfig } = await import('../../src/config');
    const result = validateConfig();
    // SendGrid absence is a warning, not a fatal error — process.exit must NOT be called
    expect(exitSpy).not.toHaveBeenCalled();
    expect(result.warnings.some(w => w.includes('SendGrid'))).toBe(true);
  });

  it('returns both errors array and warnings array', async () => {
    delete process.env.DATABASE_URL;
    process.env.NODE_ENV = 'test';
    vi.resetModules();
    const { validateConfig } = await import('../../src/config');
    const result = validateConfig();
    expect(Array.isArray(result.errors)).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);
    expect(typeof result.valid).toBe('boolean');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('flags STRIPE_SECRET_KEY with placeholder as error in production', async () => {
    process.env.DATABASE_URL = 'postgres://prod';
    process.env.NODE_ENV = 'production';
    process.env.FIREBASE_PROJECT_ID = 'proj';
    process.env.FIREBASE_PRIVATE_KEY = 'key';
    process.env.FIREBASE_CLIENT_EMAIL = 'a@b.com';
    process.env.STRIPE_SECRET_KEY = 'sk_live_placeholder'; // contains 'placeholder'
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.io';
    process.env.UPSTASH_REDIS_URL = 'redis://upstash:6379';
    process.env.TAX_TIN_ENCRYPTION_KEY = 'a'.repeat(64);
    vi.resetModules();
    const { validateConfig } = await import('../../src/config');
    const result = validateConfig();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(result.errors.some(e => e.includes('STRIPE_SECRET_KEY'))).toBe(true);
  });

  it.each([
    ['test', 'sk_live_real', 'STRIPE_MODE=test'],
    ['live', 'sk_test_real', 'STRIPE_MODE=live'],
    ['preview', 'sk_live_real', 'STRIPE_MODE must be either test or live'],
  ])('fails production boot for Stripe mode/key mismatch %s', async (mode, secret, expected) => {
    process.env.DATABASE_URL = 'postgres://prod';
    process.env.NODE_ENV = 'production';
    process.env.FIREBASE_PROJECT_ID = 'proj';
    process.env.FIREBASE_PRIVATE_KEY = 'key';
    process.env.FIREBASE_CLIENT_EMAIL = 'a@b.com';
    process.env.STRIPE_SECRET_KEY = secret;
    process.env.STRIPE_MODE = mode;
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.io';
    process.env.UPSTASH_REDIS_URL = 'redis://upstash:6379';
    process.env.QUEUE_HMAC_SECRET = 'real-hmac-secret';
    process.env.TAX_TIN_ENCRYPTION_KEY = 'a'.repeat(64);
    vi.resetModules();
    const { validateConfig } = await import('../../src/config');
    const result = validateConfig();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(result.errors.some(error => error.includes(expected))).toBe(true);
  });

  it.each([
    ['test', 'sk_test_real'],
    ['live', 'sk_live_real'],
  ])('accepts a matching Stripe %s mode/key pair', async (mode, secret) => {
    process.env.DATABASE_URL = 'postgres://prod';
    process.env.NODE_ENV = 'production';
    process.env.FIREBASE_PROJECT_ID = 'proj';
    process.env.FIREBASE_PRIVATE_KEY = 'key';
    process.env.FIREBASE_CLIENT_EMAIL = 'a@b.com';
    process.env.STRIPE_SECRET_KEY = secret;
    process.env.STRIPE_MODE = mode;
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.io';
    process.env.UPSTASH_REDIS_URL = 'redis://upstash:6379';
    process.env.QUEUE_HMAC_SECRET = 'real-hmac-secret';
    process.env.TAX_TIN_ENCRYPTION_KEY = 'a'.repeat(64);
    vi.resetModules();
    const { validateConfig } = await import('../../src/config');
    const result = validateConfig();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(result.errors).toHaveLength(0);
  });
});

// ============================================================================
// QUEUE_HMAC_SECRET — security-specific tests (Bug 1 fix)
// ============================================================================

describe('config — QUEUE_HMAC_SECRET security', () => {
  it('uses env var value when QUEUE_HMAC_SECRET is set', async () => {
    process.env.NODE_ENV = 'development';
    process.env.QUEUE_HMAC_SECRET = 'my-secret-value';
    vi.resetModules();
    const { config } = await import('../../src/config');
    expect(config.queue.hmacSecret).toBe('my-secret-value');
  });

  it('uses dev-only fallback in development when QUEUE_HMAC_SECRET is missing', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.QUEUE_HMAC_SECRET;
    vi.resetModules();
    const { config } = await import('../../src/config');
    // Must NOT be the old committed string that is now a known-public value
    expect(config.queue.hmacSecret).not.toBe('dev-queue-hmac-secret-not-for-production');
    // Must be labeled as dev-only so it is recognizable as non-production
    expect(config.queue.hmacSecret).toMatch(/dev-only/);
  });

  it('uses dev-only fallback in test environment when QUEUE_HMAC_SECRET is missing', async () => {
    process.env.NODE_ENV = 'test';
    delete process.env.QUEUE_HMAC_SECRET;
    vi.resetModules();
    const { config } = await import('../../src/config');
    expect(config.queue.hmacSecret).not.toBe('dev-queue-hmac-secret-not-for-production');
    expect(config.queue.hmacSecret).toMatch(/dev-only/);
  });

  it('returns empty string in production when QUEUE_HMAC_SECRET is missing (validateConfig exits)', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.QUEUE_HMAC_SECRET;
    vi.resetModules();
    const { config } = await import('../../src/config');
    // The production branch yields '' which triggers validateConfig() → process.exit(1)
    expect(config.queue.hmacSecret).toBe('');
    // The old committed fallback must never appear in any environment
    expect(config.queue.hmacSecret).not.toBe('dev-queue-hmac-secret-not-for-production');
  });
});

// ============================================================================
// Default export
// ============================================================================

describe('config default export', () => {
  it('default export equals named config export', async () => {
    vi.resetModules();
    const mod = await import('../../src/config');
    expect(mod.default).toBe(mod.config);
  });
});
