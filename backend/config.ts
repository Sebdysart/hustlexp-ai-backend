export const config = {
  database: {
    url: process.env.DATABASE_URL || '',
    maxConnections: 10,
  },
  redis: {
    url: process.env.REDIS_URL || '',
    token: process.env.REDIS_TOKEN || '',
  },
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
    platformFeePercent: 2.5,
  },
  firebase: {
    projectId: process.env.FIREBASE_PROJECT_ID || '',
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n') || '',
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL || '',
  },
  cloudflare: {
    r2: {
      accountId: process.env.R2_ACCOUNT_ID || '',
      accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
      bucketName: process.env.R2_BUCKET_NAME || 'hustlexp-storage',
    },
  },
  ai: {
    google: {
      apiKey: process.env.GOOGLE_AI_API_KEY || '',
      model: 'gemini-2.0-flash-exp',
      requestPercent: 80,
    },
    deepseek: {
      apiKey: process.env.DEEPSEEK_API_KEY || '',
      model: 'deepseek-r1',
      requestPercent: 10,
    },
    qwen: {
      apiKey: process.env.QWEN_API_KEY || '',
      model: 'qwen3-22b',
      requestPercent: 5,
    },
    openai: {
      apiKey: process.env.OPENAI_API_KEY || '',
      model: 'gpt-4o',
      requestPercent: 5,
    },
    cacheTTL: 24 * 60 * 60,
    targetCacheHitRate: 0.7,
  },
  analytics: {
    posthog: {
      apiKey: process.env.POSTHOG_API_KEY || '',
    },
    sentry: {
      dsn: process.env.SENTRY_DSN || '',
    },
  },
  app: {
    env: process.env.NODE_ENV || 'development',
    isDevelopment: process.env.NODE_ENV === 'development',
    isProduction: process.env.NODE_ENV === 'production',
    allowedOrigins: (process.env.ALLOWED_ORIGINS || '')
      .split(',')
      .map(origin => origin.trim())
      .filter(Boolean),
  },
} as const;

export function validateConfig() {
  const errors: string[] = [];

  if (config.app.isProduction) {
    if (!config.database.url) errors.push('DATABASE_URL is required');
    if (!config.redis.url) errors.push('REDIS_URL is required');
    if (!config.redis.token) errors.push('REDIS_TOKEN is required');
    if (!config.stripe.secretKey) errors.push('STRIPE_SECRET_KEY is required');
    if (!config.firebase.projectId) errors.push('FIREBASE_PROJECT_ID is required');
    if (!config.firebase.privateKey) errors.push('FIREBASE_PRIVATE_KEY is required');
    if (!config.firebase.clientEmail) errors.push('FIREBASE_CLIENT_EMAIL is required');
  }

  if (errors.length > 0) {
    console.error('❌ Configuration validation failed:');
    errors.forEach((error) => console.error(`  - ${error}`));
    throw new Error('Invalid configuration');
  }

  console.log('✅ Configuration validated successfully');
}
