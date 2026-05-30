export const config = {
  database: {
    url: process.env.DATABASE_URL || '',
    pgbouncer: process.env.DB_PGBOUNCER === 'true',
  },
  
  redis: {
    restUrl: process.env.UPSTASH_REDIS_REST_URL || process.env.REDIS_URL || '',
    restToken: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.REDIS_TOKEN || '',
    url: process.env.UPSTASH_REDIS_URL || process.env.REDIS_URL || '',
  },
  
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
    platformFeePercent: (() => { const raw = parseInt(process.env.PLATFORM_FEE_PERCENT || '15', 10); return isNaN(raw) || raw < 0 ? 15 : Math.min(raw, 100); })(),
    minimumTaskValueCents: (() => { const raw = parseInt(process.env.MIN_TASK_VALUE_CENTS || '500', 10); return isNaN(raw) || raw < 0 ? 500 : raw; })(),
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
  
  firebase: {
    projectId: process.env.FIREBASE_PROJECT_ID || '',
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n') || '',
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL || '',
    webApiKey: process.env.FIREBASE_WEB_API_KEY || '',
  },
  
  cloudflare: {
    r2: {
      accountId: process.env.R2_ACCOUNT_ID || '',
      accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
      bucketName: process.env.R2_BUCKET_NAME || 'hustlexp-storage',
    },
  },

  googleMaps: {
    apiKey: process.env.GOOGLE_MAPS_API_KEY || '',
  },

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
    routing: {
      primary: process.env.AI_ROUTE_PRIMARY || 'openai',
      fast: process.env.AI_ROUTE_FAST || 'groq',
      reasoning: process.env.AI_ROUTE_REASONING || 'deepseek',
      safety: process.env.AI_ROUTE_SAFETY || 'anthropic',
      backup: process.env.AI_ROUTE_BACKUP || 'alibaba',
    },
    cacheTTL: parseInt(process.env.AI_CACHE_TTL || String(24 * 60 * 60), 10),
  },
  
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
    maxGmvCents: 1_000_000,
    plans: {
      free: { priceId: process.env.STRIPE_FREE_PRICE_ID || '', name: 'Free' },
      premium: { priceId: process.env.STRIPE_PREMIUM_PRICE_ID || '', name: 'Premium' },
      pro: { priceId: process.env.STRIPE_PRO_PRICE_ID || '', name: 'Pro' },
    },
  },

  sentry: {
    dsn: process.env.SENTRY_DSN || '',
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE || '0.1'),
  },

  datadog: {
    enabled: process.env.DATADOG_ENABLED === 'true',
    agentHost: process.env.DD_AGENT_HOST || 'localhost',
    agentPort: parseInt(process.env.DD_AGENT_PORT || '8125', 10),
    serviceName: process.env.DD_SERVICE || 'hustlexp-api',
    env: process.env.DD_ENV || process.env.NODE_ENV || 'development',
    version: process.env.DD_VERSION || process.env.npm_package_version || '1.0.0',
  },

  tax: {
    encryptionKey: process.env.TAX_TIN_ENCRYPTION_KEY || '',
  },

  queue: {
    hmacSecret: process.env.QUEUE_HMAC_SECRET ||
      (process.env.NODE_ENV === 'production'
        ? ''
        : 'dev-only-hmac-secret-local-use'),
  },

  // Feature flags — legal/safety kill switches. Default OFF; enable only via explicit env.
  features: {
    // Self-insurance pool gated OFF pending legal review (WA unauthorized-insurance
    // risk; cf. WA Insurance Commissioner v. Airbnb, 2023). Gates BOTH the 2%
    // contribution (collection) and all claims/payouts at the service layer.
    insurancePoolEnabled: process.env.INSURANCE_POOL_ENABLED === 'true',
  },

  app: {
    port: parseInt(process.env.PORT || '3000', 10),
    env: process.env.NODE_ENV || 'development',
    isDevelopment: process.env.NODE_ENV !== 'production',
    isProduction: process.env.NODE_ENV === 'production',
    allowedOrigins: (process.env.ALLOWED_ORIGINS || '')
      .split(',')
      .map(origin => origin.trim())
      .filter(Boolean),
  },
};

export function validateConfig(): { valid: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!config.database.url) {
    errors.push('DATABASE_URL is required');
  }

  if (config.app.isProduction) {
    // STOP-009 FIX: Block HX_STRIPE_STUB in production at startup.
    if (process.env.HX_STRIPE_STUB === '1') {
      errors.push('HX_STRIPE_STUB=1 is forbidden in production — would stub all Stripe transfers/refunds with fake IDs');
    }
    if (!process.env.QUEUE_HMAC_SECRET) {
      errors.push('QUEUE_HMAC_SECRET is required in production (HMAC signing for financial BullMQ jobs)');
    }
    if (!config.firebase.projectId) errors.push('FIREBASE_PROJECT_ID is required');
    if (!config.firebase.privateKey) errors.push('FIREBASE_PRIVATE_KEY is required');
    if (!config.firebase.clientEmail) errors.push('FIREBASE_CLIENT_EMAIL is required');
    if (!config.stripe.secretKey || config.stripe.secretKey.includes('placeholder')) {
      errors.push('STRIPE_SECRET_KEY is required (not placeholder)');
    }
    if (!config.redis.restUrl) {
      errors.push('UPSTASH_REDIS_REST_URL is required for caching/rate limiting');
    }
    if (!config.redis.url) {
      errors.push('UPSTASH_REDIS_URL or REDIS_URL is required for BullMQ job queues');
    }
    if (!config.cloudflare.r2.accountId || !config.cloudflare.r2.accessKeyId || !config.cloudflare.r2.secretAccessKey) {
      warnings.push('R2 storage not configured — exports will fail');
    }
    if (!config.identity.sendgrid.apiKey) {
      warnings.push('SendGrid not configured — email notifications will fail');
    }
    if (!config.tax.encryptionKey) {
      errors.push('TAX_TIN_ENCRYPTION_KEY is required in production (AES-256-GCM TIN encryption)');
    } else if (!/^[0-9a-fA-F]{64}$/.test(config.tax.encryptionKey)) {
      errors.push('TAX_TIN_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes) for AES-256-GCM — generate with: openssl rand -hex 32');
    }
  }

  if (config.app.isProduction && errors.length > 0) {
    // eslint-disable-next-line no-console
    console.error(
      '[FATAL] Production startup aborted — missing required configuration:\n' +
        errors.map(e => `  • ${e}`).join('\n')
    );
    process.exit(1);
  }

  return { valid: errors.length === 0, errors, warnings };
}

export default config;
