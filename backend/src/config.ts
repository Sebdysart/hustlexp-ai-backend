/**
 * HustleXP Backend Configuration v1.0.0
 *
 * Centralized configuration for all backend services.
 *
 * @see ARCHITECTURE.md
 */

export const config = {
  // Database (Neon PostgreSQL)
  database: {
    url: process.env.DATABASE_URL || '',
    pgbouncer: process.env.DB_PGBOUNCER === 'true',
  },

  // Cache (Upstash Redis)
  redis: {
    // REST API (for @upstash/redis client - caching, rate limiting)
    restUrl: process.env.UPSTASH_REDIS_REST_URL || process.env.REDIS_URL || '',
    restToken: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.REDIS_TOKEN || '',
    // Direct TCP (for BullMQ/ioredis - job queues)
    // Upstash provides both REST and direct TCP endpoints
    // Use UPSTASH_REDIS_URL (direct TCP connection string) for BullMQ
    // Format: redis://default:{password}@{endpoint}:6379
    // OR use separate Redis instance: REDIS_URL=redis://localhost:6379
    url: process.env.UPSTASH_REDIS_URL || process.env.REDIS_URL || '', // Direct TCP connection string
  },

  // Payments (Stripe)
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
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

function stripeConfigurationErrors(): string[] {
  const errors: string[] = [];
  if (!config.stripe.secretKey || config.stripe.secretKey.includes('placeholder')) {
    errors.push('STRIPE_SECRET_KEY is required (not placeholder)');
  }
  const stripeMode = process.env.STRIPE_MODE?.trim().toLowerCase();
  if (stripeMode && stripeMode !== 'test' && stripeMode !== 'live') {
    errors.push('STRIPE_MODE must be either test or live');
  } else if (stripeMode === 'test' && config.stripe.secretKey.startsWith('sk_live_')) {
    errors.push('STRIPE_MODE=test cannot be used with a live Stripe secret key');
  } else if (stripeMode === 'live' && config.stripe.secretKey.startsWith('sk_test_')) {
    errors.push('STRIPE_MODE=live cannot be used with a test Stripe secret key');
  }
  return errors;
}

function redisConfigurationErrors(): string[] {
  const errors: string[] = [];
  if (!config.redis.restUrl)
    errors.push('UPSTASH_REDIS_REST_URL is required for caching/rate limiting');
  if (!config.redis.url)
    errors.push('UPSTASH_REDIS_URL or REDIS_URL is required for BullMQ job queues');
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

function storageConfigurationErrors(): string[] {
  const errors: string[] = [];
  const r2 = config.cloudflare.r2;
  if (!r2.endpoint)
    errors.push('R2_ENDPOINT, S3_ENDPOINT, or R2_ACCOUNT_ID is required for object storage');
  if (!r2.accessKeyId)
    errors.push('R2_ACCESS_KEY_ID or AWS_ACCESS_KEY_ID is required for object storage');
  if (!r2.secretAccessKey)
    errors.push('R2_SECRET_ACCESS_KEY or AWS_SECRET_ACCESS_KEY is required for object storage');
  if (!(process.env.R2_BUCKET_NAME || process.env.BUCKET_NAME)) {
    errors.push('R2_BUCKET_NAME or BUCKET_NAME is required for object storage');
  }
  if (r2.endpoint) {
    try {
      const endpoint = new URL(r2.endpoint);
      if (endpoint.protocol !== 'https:') errors.push('Object storage endpoint must use HTTPS');
      if (endpoint.username || endpoint.password)
        errors.push('Object storage endpoint cannot embed credentials');
    } catch {
      errors.push('Object storage endpoint must be a valid URL');
    }
  }
  return errors;
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

/** Validate required configuration and fail closed in production. */
export function validateConfig(): { valid: boolean; errors: string[]; warnings: string[] } {
  const errors = config.database.url ? [] : ['DATABASE_URL is required'];
  const warnings: string[] = [];
  if (config.app.isProduction) {
    errors.push(...productionConfigurationErrors());
    warnings.push(...productionConfigurationWarnings());
  }

  // SECURITY FIX (v2.9.4): In production, fatal config errors must crash the
  // process immediately rather than silently continuing. A misconfigured
  // deployment (e.g. missing Firebase credentials) would otherwise serve every
  // authenticated request as a 401 with no alerting.
  if (config.app.isProduction && errors.length > 0) {
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
