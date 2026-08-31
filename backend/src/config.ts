/**
 * HustleXP Backend Configuration v1.0.0
 *
 * Centralized configuration for all backend services.
 *
 * @see ARCHITECTURE.md
 */

import { buildIdentity, type BuildIdentity } from './buildIdentity.js';
import {
  readReleaseManifest,
  RELEASE_CHARTER_AUTHORITY,
  type ReleaseManifestEvidence,
} from './releaseManifest.js';
import { assertNonproductionFakeFinanceAuthorized } from './services/payment/NonproductionFinancialAuthorization.js';
import { deployedSyntheticProviderConfigurationErrors } from './deployedSyntheticProviderPolicy.js';

export const config = {
  // Database (standard PostgreSQL; Railway in production)
  database: {
    url: process.env.DATABASE_URL || '',
    pgbouncer: process.env.DB_PGBOUNCER === 'true',
  },

  // Redis transports. The provider-neutral TCP URL is the canonical portable
  // path for every Redis command consumer, BullMQ, and realtime pub/sub. The
  // Upstash REST pair is an explicit legacy alternate transport. It is not
  // runtime failover. Never
  // infer one transport's credentials from the other: redis:// is not an HTTP
  // endpoint and an ambiguous REDIS_TOKEN is not an Upstash REST bearer token.
  redis: {
    // Explicit REST-only compatibility credentials.
    restUrl: process.env.UPSTASH_REDIS_REST_URL || '',
    restToken: process.env.UPSTASH_REDIS_REST_TOKEN || '',
    // Direct TCP connection string. REDIS_URL is canonical; the vendor-named
    // alias remains accepted only for backwards-compatible deployments.
    url: process.env.REDIS_URL || process.env.UPSTASH_REDIS_URL || '',
  },

  // Payments (Stripe)
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    // Platform-account events cover customer funding, refunds, disputes, and
    // transfers. Connect events cover worker account and bank-payout state.
    // Stripe assigns a distinct signing secret to each destination.
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
    connectWebhookSecret: process.env.STRIPE_CONNECT_WEBHOOK_SECRET || '',
    // SECURITY FIX (v2.9.3): Clamp to [0, 100] at parse time. A negative or
    // non-numeric env var would silently pass through parseInt and could cause
    // the fee calculation to produce a negative value (overpaying the worker).
    // HX/OS §15: task-specific Price Book economics are authoritative. This
    // 20% value is only the conservative fallback for legacy rows that do not
    // yet carry an immutable platform margin.
    platformFeePercent: (() => {
      const raw = parseInt(process.env.PLATFORM_FEE_PERCENT || '20', 10);
      return isNaN(raw) || raw < 0 ? 20 : Math.min(raw, 100);
    })(),
    minimumTaskValueCents: (() => {
      const raw = parseInt(process.env.MIN_TASK_VALUE_CENTS || '1500', 10);
      return Number.isFinite(raw) ? Math.max(1500, raw) : 1500;
    })(), // Binding HustleXP specification: $15.00 global task minimum
    plans: {
      premium: {
        monthlyPriceCents: 1499,
        yearlyPriceCents: 14999,
        priceIdMonthly: process.env.STRIPE_PREMIUM_MONTHLY_PRICE_ID || '',
        priceIdYearly: process.env.STRIPE_PREMIUM_YEARLY_PRICE_ID || '',
      },
      pro: {
        monthlyPriceCents: 2999,
        yearlyPriceCents: 29999,
        priceIdMonthly: process.env.STRIPE_PRO_MONTHLY_PRICE_ID || '',
        priceIdYearly: process.env.STRIPE_PRO_YEARLY_PRICE_ID || '',
      },
    },
  },

  // Authentication (Firebase)
  firebase: {
    projectId: process.env.FIREBASE_PROJECT_ID || '',
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n') || '',
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL || '',
    webApiKey: process.env.FIREBASE_WEB_API_KEY || '',
  },

  // Storage (Cloudflare R2)
  cloudflare: {
    r2: {
      accountId: process.env.R2_ACCOUNT_ID || '',
      endpoint:
        process.env.R2_ENDPOINT ||
        process.env.S3_ENDPOINT ||
        (process.env.R2_ACCOUNT_ID
          ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
          : ''),
      accessKeyId: process.env.R2_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY || '',
      bucketName: process.env.R2_BUCKET_NAME || process.env.BUCKET_NAME || 'hustlexp-storage',
      region: process.env.R2_REGION || process.env.AWS_DEFAULT_REGION || 'auto',
    },
  },

  // Maps & Geocoding (Google Maps Platform)
  googleMaps: {
    apiKey: process.env.GOOGLE_MAPS_API_KEY || '',
  },

  // AI Services (Multi-model)
  ai: {
    openai: {
      apiKey: process.env.OPENAI_API_KEY || '',
      model: process.env.OPENAI_MODEL || 'gpt-4o',
    },
    deepseek: {
      apiKey: process.env.DEEPSEEK_API_KEY || '',
      model: process.env.DEEPSEEK_MODEL || 'deepseek-r1',
    },
    groq: {
      apiKey: process.env.GROQ_API_KEY || '',
      model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    },
    alibaba: {
      apiKey: process.env.ALIBABA_API_KEY || '',
      model: process.env.ALIBABA_MODEL || 'qwen-max',
    },
    anthropic: {
      apiKey: process.env.ANTHROPIC_API_KEY || '',
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514',
    },
    // Model routing weights (configurable for A/B testing)
    routing: {
      primary: process.env.AI_ROUTE_PRIMARY || 'openai',
      fast: process.env.AI_ROUTE_FAST || 'groq',
      reasoning: process.env.AI_ROUTE_REASONING || 'deepseek',
      safety: process.env.AI_ROUTE_SAFETY || 'anthropic',
      backup: process.env.AI_ROUTE_BACKUP || 'alibaba',
    },
    cacheTTL: parseInt(process.env.AI_CACHE_TTL || String(24 * 60 * 60), 10),
  },

  // Identity Verification
  identity: {
    twilio: {
      accountSid: process.env.TWILIO_ACCOUNT_SID || '',
      authToken: process.env.TWILIO_AUTH_TOKEN || '',
      verifyServiceSid: process.env.TWILIO_VERIFY_SERVICE_SID || '',
    },
    sendgrid: {
      apiKey: process.env.SENDGRID_API_KEY || '',
      fromEmail: process.env.SENDGRID_FROM_EMAIL || 'verify@hustlexp.app',
    },
  },

  // Seattle Beta Configuration
  beta: {
    enabled: process.env.BETA_ENABLED === 'true',
    regionName: 'Seattle Metro',
    bounds: {
      south: 47.4,
      west: -122.5,
      north: 47.8,
      east: -122.2,
    },
    center: {
      lat: 47.6062,
      lng: -122.3321,
    },
    radiusMiles: 15,
    startDate: process.env.BETA_START_DATE || '2026-02-22',
    endDate: process.env.BETA_END_DATE || '2026-03-24',
    maxUsers: 100,
    maxTasks: 200,
    maxGmvCents: 1_000_000, // $10,000
    plans: {
      free: { priceId: process.env.STRIPE_FREE_PRICE_ID || '', name: 'Free' },
      premium: { priceId: process.env.STRIPE_PREMIUM_PRICE_ID || '', name: 'Premium' },
      pro: { priceId: process.env.STRIPE_PRO_PRICE_ID || '', name: 'Pro' },
    },
  },

  // Error Tracking (Sentry)
  sentry: {
    dsn: process.env.SENTRY_DSN || '',
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE || '0.1'),
  },

  // APM & Monitoring (Datadog)
  datadog: {
    enabled: process.env.DATADOG_ENABLED === 'true',
    agentHost: process.env.DD_AGENT_HOST || 'localhost',
    agentPort: parseInt(process.env.DD_AGENT_PORT || '8125', 10),
    serviceName: process.env.DD_SERVICE || 'hustlexp-api',
    env: process.env.DD_ENV || process.env.NODE_ENV || 'development',
    version: process.env.DD_VERSION || process.env.npm_package_version || '1.0.0',
  },

  // Tax Compliance
  tax: {
    // 32-byte hex key for AES-256-GCM TIN encryption.
    // Generate with: openssl rand -hex 32
    encryptionKey: process.env.TAX_TIN_ENCRYPTION_KEY || '',
  },

  // Job Queue Security
  // SECURITY: No hardcoded fallback. In production the validator enforces this is set.
  // In dev/test a clearly-labeled non-production value is used so the queue still functions locally.
  queue: {
    hmacSecret:
      process.env.QUEUE_HMAC_SECRET ||
      (process.env.NODE_ENV === 'production'
        ? '' // will be caught by validateConfig() → process.exit(1)
        : 'dev-only-hmac-secret-local-use'),
  },

  // Application
  app: {
    port: parseInt(process.env.PORT || '3000', 10),
    env: process.env.NODE_ENV || 'development',
    isDevelopment: process.env.NODE_ENV !== 'production',
    isProduction: process.env.NODE_ENV === 'production',
    allowedOrigins: (process.env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  },
};

function firebaseConfigurationErrors(): string[] {
  const errors: string[] = [];
  if (!config.firebase.projectId) errors.push('FIREBASE_PROJECT_ID is required');
  if (!config.firebase.privateKey) errors.push('FIREBASE_PRIVATE_KEY is required');
  if (!config.firebase.clientEmail) errors.push('FIREBASE_CLIENT_EMAIL is required');
  return errors;
}

function stripeSecretKeyErrors(): string[] {
  if (!config.stripe.secretKey || config.stripe.secretKey.includes('placeholder')) {
    return ['STRIPE_SECRET_KEY is required (not placeholder)'];
  }
  return [];
}

function stripeModeErrors(): string[] {
  const stripeMode = process.env.STRIPE_MODE?.trim().toLowerCase();
  if (stripeMode && stripeMode !== 'test' && stripeMode !== 'live') {
    return ['STRIPE_MODE must be either test or live'];
  }
  if (stripeMode === 'test' && config.stripe.secretKey.startsWith('sk_live_')) {
    return ['STRIPE_MODE=test cannot be used with a live Stripe secret key'];
  }
  if (stripeMode === 'live' && config.stripe.secretKey.startsWith('sk_test_')) {
    return ['STRIPE_MODE=live cannot be used with a test Stripe secret key'];
  }
  return [];
}

function paymentCreationModeErrors(): string[] {
  const mode = process.env.HX_PAYMENT_CREATION_MODE?.trim().toLowerCase();
  if (mode && mode !== 'enabled' && mode !== 'frozen') {
    return ['HX_PAYMENT_CREATION_MODE must be either enabled or frozen'];
  }
  if (mode === 'enabled') {
    return [
      'HX_PAYMENT_CREATION_MODE=enabled is forbidden while underwriting decisions remain unresolved',
    ];
  }
  return [];
}

function stripeWebhookSecretErrors(name: string, value: string): string[] {
  if (!value || value.includes('placeholder')) return [`${name} is required (not placeholder)`];
  if (!value.startsWith('whsec_')) return [`${name} must be a Stripe webhook signing secret`];
  return [];
}

function stripeWebhookConfigurationErrors(): string[] {
  const webhookSecrets = [
    ['STRIPE_WEBHOOK_SECRET', config.stripe.webhookSecret],
    ['STRIPE_CONNECT_WEBHOOK_SECRET', config.stripe.connectWebhookSecret],
  ] as const;
  const errors = webhookSecrets.flatMap(([name, value]) => stripeWebhookSecretErrors(name, value));
  if (
    config.stripe.webhookSecret
    && config.stripe.webhookSecret === config.stripe.connectWebhookSecret
  ) {
    errors.push('Stripe platform and Connect webhook secrets must be distinct');
  }
  return errors;
}

function stripeConfigurationErrors(): string[] {
  return [
    ...stripeSecretKeyErrors(),
    ...stripeModeErrors(),
    ...paymentCreationModeErrors(),
    ...stripeWebhookConfigurationErrors(),
  ];
}

function redisConfigurationErrors(): string[] {
  const errors: string[] = [];
  if (Boolean(config.redis.restUrl) !== Boolean(config.redis.restToken)) {
    errors.push(
      'UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be configured together when using the legacy REST alternate',
    );
  }
  if (!config.redis.url)
    errors.push('REDIS_URL (or legacy UPSTASH_REDIS_URL) is required for Redis commands, BullMQ, and realtime');
  else {
    try {
      const redisUrl = new URL(config.redis.url);
      if (!['redis:', 'rediss:'].includes(redisUrl.protocol) || !redisUrl.hostname) {
        errors.push('REDIS_URL (or legacy UPSTASH_REDIS_URL) must use redis: or rediss: with a hostname');
      }
    } catch {
      errors.push('REDIS_URL (or legacy UPSTASH_REDIS_URL) must be a valid Redis URL');
    }
  }
  if (config.redis.restUrl) {
    try {
      const restUrl = new URL(config.redis.restUrl);
      if (
        restUrl.protocol !== 'https:'
        || !restUrl.hostname
        || restUrl.username
        || restUrl.password
        || restUrl.search
        || restUrl.hash
      ) {
        errors.push('UPSTASH_REDIS_REST_URL must be an HTTPS URL without embedded credentials, query, or fragment');
      }
    } catch {
      errors.push('UPSTASH_REDIS_REST_URL must be a valid HTTPS URL');
    }
  }
  return errors;
}

function taxConfigurationErrors(): string[] {
  if (!config.tax.encryptionKey) {
    return ['TAX_TIN_ENCRYPTION_KEY is required in production (AES-256-GCM TIN encryption)'];
  }
  if (!/^[0-9a-fA-F]{64}$/.test(config.tax.encryptionKey)) {
    return [
      'TAX_TIN_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes) for AES-256-GCM — generate with: openssl rand -hex 32',
    ];
  }
  return [];
}

function storageEndpointErrors(endpointValue: string): string[] {
  const errors: string[] = [];
  if (endpointValue) {
    try {
      const endpoint = new URL(endpointValue);
      if (endpoint.protocol !== 'https:') errors.push('Object storage endpoint must use HTTPS');
      if (endpoint.username || endpoint.password)
        errors.push('Object storage endpoint cannot embed credentials');
    } catch {
      errors.push('Object storage endpoint must be a valid URL');
    }
  }
  return errors;
}

function storageCredentialErrors(): string[] {
  const errors: string[] = [];
  const r2 = config.cloudflare.r2;
  if (!r2.endpoint)
    errors.push('R2_ENDPOINT, S3_ENDPOINT, or R2_ACCOUNT_ID is required for object storage');
  if (!r2.accessKeyId)
    errors.push('R2_ACCESS_KEY_ID or AWS_ACCESS_KEY_ID is required for object storage');
  if (!r2.secretAccessKey)
    errors.push('R2_SECRET_ACCESS_KEY or AWS_SECRET_ACCESS_KEY is required for object storage');
  if (!(process.env.R2_BUCKET_NAME || process.env.BUCKET_NAME))
    errors.push('R2_BUCKET_NAME or BUCKET_NAME is required for object storage');
  return errors;
}

function storageConfigurationErrors(): string[] {
  return [
    ...storageCredentialErrors(),
    ...storageEndpointErrors(config.cloudflare.r2.endpoint),
  ];
}

function productionConfigurationWarnings(): string[] {
  const warnings: string[] = [];
  if (!config.identity.sendgrid.apiKey)
    warnings.push('SendGrid not configured — email notifications will fail');
  return warnings;
}

function productionConfigurationErrors(): string[] {
  const queueErrors = process.env.QUEUE_HMAC_SECRET
    ? []
    : ['QUEUE_HMAC_SECRET is required in production (HMAC signing for financial BullMQ jobs)'];
  return [
    ...queueErrors,
    ...firebaseConfigurationErrors(),
    ...stripeConfigurationErrors(),
    ...redisConfigurationErrors(),
    ...taxConfigurationErrors(),
    ...storageConfigurationErrors(),
  ];
}

type DeployedSyntheticEnvironment = 'preview' | 'staging';

export interface ConfigValidationOptions {
  release?: ReleaseManifestEvidence;
  identity?: BuildIdentity;
}

function deployedSyntheticEnvironment(): DeployedSyntheticEnvironment | null {
  const value = process.env.HX_ENVIRONMENT?.trim().toLowerCase();
  return value === 'preview' || value === 'staging' ? value : null;
}

function remoteUrlErrors(
  name: string,
  value: string | undefined,
  protocols: readonly string[],
  railwayInternal = false,
): string[] {
  const errors: string[] = [];
  if (!value?.trim()) return [`${name} is required in deployed synthetic nonproduction`];
  try {
    const parsed = new URL(value);
    if (!protocols.includes(parsed.protocol)) {
      errors.push(`${name} must use ${protocols.join(' or ')}`);
    }
    if (['localhost', '127.0.0.1', '::1'].includes(parsed.hostname.toLowerCase())) {
      errors.push(`${name} may not use loopback in deployed synthetic nonproduction`);
    }
    if (railwayInternal && !parsed.hostname.toLowerCase().endsWith('.railway.internal')) {
      errors.push(`${name} must use isolated Railway private networking`);
    }
  } catch {
    errors.push(`${name} must be a valid URL`);
  }
  return errors;
}

function exactHttpsOrigin(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== 'https:'
      || parsed.username
      || parsed.password
      || parsed.pathname !== '/'
      || parsed.search
      || parsed.hash
      || ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname.toLowerCase())
      || parsed.origin !== value
    ) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function deployedSyntheticOriginErrors(): string[] {
  const errors: string[] = [];
  const apiOrigin = exactHttpsOrigin(process.env.HX_NONPROD_API_ORIGIN);
  const webOrigin = exactHttpsOrigin(process.env.HX_NONPROD_WEB_ORIGIN);
  if (!apiOrigin) errors.push('HX_NONPROD_API_ORIGIN must be an exact remote HTTPS origin');
  if (!webOrigin) errors.push('HX_NONPROD_WEB_ORIGIN must be an exact remote HTTPS origin');
  if (apiOrigin && webOrigin && apiOrigin === webOrigin) {
    errors.push('nonproduction API and web origins must be distinct');
  }
  if (webOrigin && (
    config.app.allowedOrigins.length !== 1
    || config.app.allowedOrigins[0] !== webOrigin
  )) {
    errors.push('ALLOWED_ORIGINS must equal the exact nonproduction web origin');
  }
  const railwayPublicDomain = process.env.RAILWAY_PUBLIC_DOMAIN?.trim();
  if (apiOrigin && railwayPublicDomain && apiOrigin !== `https://${railwayPublicDomain}`) {
    errors.push('HX_NONPROD_API_ORIGIN must match the Railway API public domain');
  }
  return errors;
}

function encryptionConfigurationErrors(): string[] {
  const errors = [...taxConfigurationErrors()];
  if (!/^[0-9a-fA-F]{64}$/u.test(process.env.SESSION_ENCRYPTION_KEY ?? '')) {
    errors.push('SESSION_ENCRYPTION_KEY must be exactly 64 hex characters in deployed synthetic nonproduction');
  }
  try {
    const raw = process.env.TASK_LOCATION_ENCRYPTION_KEY ?? '';
    if (!raw || Buffer.from(raw, 'base64').length !== 32) throw new Error('invalid');
  } catch {
    errors.push('TASK_LOCATION_ENCRYPTION_KEY must encode exactly 32 bytes in deployed synthetic nonproduction');
  }
  if (!/^[A-Za-z0-9._-]{3,64}$/u.test(process.env.TASK_LOCATION_ENCRYPTION_KEY_ID ?? '')) {
    errors.push('TASK_LOCATION_ENCRYPTION_KEY_ID is required in deployed synthetic nonproduction');
  }
  return errors;
}

function deployedSyntheticConfigurationErrors(
  environment: DeployedSyntheticEnvironment,
  options: ConfigValidationOptions,
): string[] {
  const errors: string[] = [];
  if (process.env.NODE_ENV !== 'production') {
    errors.push('NODE_ENV must be production for deployed synthetic nonproduction');
  }
  const release = options.release ?? readReleaseManifest();
  const identity = options.identity ?? buildIdentity;
  const role = process.env.SERVICE_ROLE?.trim().toLowerCase();
  if (!role || !['api', 'backend', 'worker', 'migration'].includes(role)) {
    errors.push('SERVICE_ROLE must be api, backend, worker, or migration in deployed synthetic nonproduction');
  }
  const component = role === 'worker' ? 'worker' : role === 'migration' ? 'migration' : 'backend';
  try {
    assertNonproductionFakeFinanceAuthorized({
      env: process.env,
      release,
      identity,
      component,
    });
  } catch (error) {
    errors.push(error instanceof Error ? error.message : 'exact nonproduction release authority is invalid');
  }
  if (release.source !== 'HX_RELEASE_MANIFEST_JSON') {
    errors.push('deployed synthetic nonproduction requires HX_RELEASE_MANIFEST_JSON');
  }
  if (release.manifest?.environment !== environment) {
    errors.push('exact release manifest environment does not match HX_ENVIRONMENT');
  }
  const authority = release.manifest?.authority;
  if (
    authority?.document !== RELEASE_CHARTER_AUTHORITY.document
    || authority?.charterVersion !== RELEASE_CHARTER_AUTHORITY.version
    || authority?.charterRevision !== RELEASE_CHARTER_AUTHORITY.revision
    || !/^sha256:(?!0{64}$)[0-9a-f]{64}$/u.test(authority?.capabilityPolicyDigest ?? '')
  ) {
    errors.push('exact release manifest must bind the signed Charter and capability policy');
  }
  if (process.env.ENGINE_API_MODE !== 'test') errors.push('ENGINE_API_MODE must be test');
  errors.push(...remoteUrlErrors('DATABASE_URL', process.env.DATABASE_URL, ['postgres:', 'postgresql:'], true));
  errors.push(...remoteUrlErrors('REDIS_URL', config.redis.url, ['redis:', 'rediss:'], true));
  if ((process.env.QUEUE_HMAC_SECRET?.trim().length ?? 0) < 32) {
    errors.push('QUEUE_HMAC_SECRET must contain at least 32 characters in deployed synthetic nonproduction');
  }
  errors.push(...deployedSyntheticOriginErrors());
  errors.push(...encryptionConfigurationErrors());
  errors.push(...deployedSyntheticProviderConfigurationErrors(process.env));
  return [...new Set(errors)];
}

/** Validate required configuration and fail closed in production. */
export function validateConfig(
  options: ConfigValidationOptions = {},
): { valid: boolean; errors: string[]; warnings: string[] } {
  const errors = config.database.url ? [] : ['DATABASE_URL is required'];
  const warnings: string[] = [];
  const syntheticEnvironment = deployedSyntheticEnvironment();
  if (syntheticEnvironment) {
    errors.push(...deployedSyntheticConfigurationErrors(syntheticEnvironment, options));
  } else if (config.app.isProduction) {
    errors.push(...productionConfigurationErrors());
    warnings.push(...productionConfigurationWarnings());
  }

  // SECURITY FIX (v2.9.4): In production, fatal config errors must crash the
  // process immediately rather than silently continuing. A misconfigured
  // deployment (e.g. missing Firebase credentials) would otherwise serve every
  // authenticated request as a 401 with no alerting.
  if ((config.app.isProduction || syntheticEnvironment) && errors.length > 0) {
    // eslint-disable-next-line no-console
    console.error(
      '[FATAL] Production startup aborted — missing required configuration:\n' +
        errors.map((e) => `  • ${e}`).join('\n')
    );
    process.exit(1);
  }

  return { valid: errors.length === 0, errors, warnings };
}

export default config;
