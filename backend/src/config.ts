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
    maxConnections: 10,
  },
  
  // Cache (Upstash Redis)
  redis: {
    // REST API (for @upstash/redis client - caching, rate limiting)
    restUrl: process.env.UPSTASH_REDIS_REST_URL || '',
    restToken: process.env.UPSTASH_REDIS_REST_TOKEN || '',
    // Direct TCP (for BullMQ/ioredis - job queues)
    // Upstash provides both REST and direct TCP endpoints
    // Use UPSTASH_REDIS_URL (direct TCP connection string) for BullMQ
    // Format: redis://default:{password}@{endpoint}:6379
    // OR use separate Redis instance: REDIS_URL=redis://localhost:6379
    url: process.env.UPSTASH_REDIS_URL || process.env.REDIS_URL || '',  // Direct TCP connection string
  },
  
  // Payments (Stripe)
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
    platformFeePercent: 15, // PRODUCT_SPEC §9: 15% platform fee
    minimumTaskValueCents: 500, // PRODUCT_SPEC §9: $5.00 minimum
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
      accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
      bucketName: process.env.R2_BUCKET_NAME || 'hustlexp-storage',
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
      model: 'gpt-4o',
    },
    deepseek: {
      apiKey: process.env.DEEPSEEK_API_KEY || '',
      model: 'deepseek-r1',
    },
    groq: {
      apiKey: process.env.GROQ_API_KEY || '',
      model: 'llama-3.3-70b-versatile',
    },
    alibaba: {
      apiKey: process.env.ALIBABA_API_KEY || '',
      model: 'qwen-max',
    },
    // Model routing weights
    routing: {
      primary: 'openai',      // Default for most tasks
      fast: 'groq',           // Low latency tasks
      reasoning: 'deepseek',  // Complex reasoning
      backup: 'alibaba',      // Fallback
    },
    cacheTTL: 24 * 60 * 60,
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

  // Application
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
} as const;

/**
 * Validate required configuration for production
 */
export function validateConfig(): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  // Always required
  if (!config.database.url) {
    errors.push('DATABASE_URL is required');
  }
  
  // Required in production
  if (config.app.isProduction) {
    if (!config.firebase.projectId) errors.push('FIREBASE_PROJECT_ID is required');
    if (!config.firebase.privateKey) errors.push('FIREBASE_PRIVATE_KEY is required');
    if (!config.firebase.clientEmail) errors.push('FIREBASE_CLIENT_EMAIL is required');
    if (!config.stripe.secretKey || config.stripe.secretKey.includes('placeholder')) {
      errors.push('STRIPE_SECRET_KEY is required (not placeholder)');
    }
    // REST API required for caching/rate limiting
    if (!config.redis.restUrl) {
      errors.push('UPSTASH_REDIS_REST_URL is required for caching/rate limiting');
    }
    // Direct TCP required for BullMQ job queues
    if (!config.redis.url) {
      errors.push('UPSTASH_REDIS_URL or REDIS_URL is required for BullMQ job queues');
    }
    // R2 Storage (optional but recommended for exports)
    if (!config.cloudflare.r2.accountId || !config.cloudflare.r2.accessKeyId || !config.cloudflare.r2.secretAccessKey) {
      console.warn('⚠️  R2 storage not configured (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY) - exports will fail');
    }
    // SendGrid (optional but recommended for email notifications)
    if (!config.identity.sendgrid.apiKey) {
      console.warn('⚠️  SendGrid not configured (SENDGRID_API_KEY) - email notifications will fail');
    }
  }
  
  if (errors.length > 0) {
    console.error('❌ Configuration validation failed:');
    errors.forEach(e => console.error(`   - ${e}`));
  } else {
    console.log('✅ Configuration validated');
  }
  
  return { valid: errors.length === 0, errors };
}

export default config;
