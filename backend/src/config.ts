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
    url: process.env.UPSTASH_REDIS_REST_URL || '',
    token: process.env.UPSTASH_REDIS_REST_TOKEN || '',
  },
  
  // Payments (Stripe)
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
    platformFeePercent: 2.5,
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
    if (!config.redis.url) errors.push('UPSTASH_REDIS_REST_URL is required');
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
