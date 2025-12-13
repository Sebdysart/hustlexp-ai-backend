import dotenv from 'dotenv';
import path from 'path';
import { serviceLogger } from '../utils/logger.js';

// ===================================
// 1. AUTO-DETECT ENVIRONMENT
// ===================================

export enum EnvMode {
    TEST = 'test',
    LOCAL = 'local',
    STAGING = 'staging',
    PRODUCTION = 'production'
}

function detectMode(): EnvMode {
    const railwayEnv = process.env.RAILWAY_ENVIRONMENT_NAME; // "staging" | "production"

    // 1. Explicit Test Mode (e.g., Jest)
    if (process.env.NODE_ENV === 'test') {
        return EnvMode.TEST;
    }

    // 2. Railway Detection
    if (railwayEnv === 'production') return EnvMode.PRODUCTION;
    if (railwayEnv === 'staging') return EnvMode.STAGING;

    // 3. Fallback to Local
    return EnvMode.LOCAL;
}

const CURRENT_MODE = detectMode();

// ===================================
// 2. LOAD CORRECT ENV FILE
// ===================================

if (CURRENT_MODE === EnvMode.LOCAL) {
    dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
    // Fallback to .env if .env.local missing
    dotenv.config({ path: path.resolve(process.cwd(), '.env') });
} else if (CURRENT_MODE === EnvMode.TEST) {
    dotenv.config({ path: path.resolve(process.cwd(), '.env.test') });
}
// Staging/Prod use injected Railway variables (no file loading needed)

// ===================================
// 3. VALIDATION UTILS
// ===================================

function requireVar(key: string): string {
    const value = process.env[key];
    if (!value) {
        throw new Error(`[CRITICAL] Missing required environment variable: ${key}`);
    }
    return value;
}

function ensurePrefix(key: string, prefix: string, envName: string) {
    const value = requireVar(key);
    if (!value.startsWith(prefix)) {
        throw new Error(`[SECURITY] ${key} must start with "${prefix}" in ${envName}`);
    }
}

// ===================================
// 4. LOAD & VALIDATE
// ===================================

console.log(`[ENV] Loading Environment: ${CURRENT_MODE.toUpperCase()}`);

const isStaging = CURRENT_MODE === EnvMode.STAGING;
const isProduction = CURRENT_MODE === EnvMode.PRODUCTION;
const isLocal = CURRENT_MODE === EnvMode.LOCAL;
const isTest = CURRENT_MODE === EnvMode.TEST;

// Universal Reqs
const PORT = parseInt(process.env.PORT || '3000', 10);
const DATABASE_URL = requireVar('DATABASE_URL');
const UPSTASH_REDIS_REST_URL = requireVar('UPSTASH_REDIS_REST_URL');
const FIREBASE_PROJECT_ID = requireVar('FIREBASE_PROJECT_ID');
const FIREBASE_PRIVATE_KEY = requireVar('FIREBASE_PRIVATE_KEY');
const FIREBASE_CLIENT_EMAIL = requireVar('FIREBASE_CLIENT_EMAIL');

// AI Keys (Required everywhere)
const OPENAI_API_KEY = requireVar('OPENAI_API_KEY');
const DEEPSEEK_API_KEY = requireVar('DEEPSEEK_API_KEY');
const GROQ_API_KEY = requireVar('GROQ_API_KEY');

// Stripe Safety Logic
let stripeKey = process.env.STRIPE_SECRET_KEY || '';
let stripeMode: 'live' | 'test' = 'test';

if (isProduction) {
    ensurePrefix('STRIPE_SECRET_KEY', 'sk_live_', 'PRODUCTION');
    ensurePrefix('STRIPE_WEBHOOK_SECRET', 'whsec_', 'PRODUCTION');
    stripeMode = 'live';
    stripeKey = requireVar('STRIPE_SECRET_KEY');
} else if (isStaging) {
    ensurePrefix('STRIPE_SECRET_KEY', 'sk_test_', 'STAGING');
    ensurePrefix('STRIPE_WEBHOOK_SECRET', 'whsec_', 'STAGING');
    stripeMode = 'test';
    stripeKey = requireVar('STRIPE_SECRET_KEY');
} else {
    // Local / Test
    stripeMode = 'test';
    // Optional in local dev until needed, but good to warn
    if (!stripeKey) console.warn('[ENV] WARN: STRIPE_SECRET_KEY missing in local/test');
}

// Firebase Safety Logic
if (isProduction && FIREBASE_PROJECT_ID.endsWith('-staging')) {
    throw new Error("[SECURITY] Cannot run PRODUCTION with STAGING Firebase credentials.");
}

// Feature Flags
const payoutsEnabled = isProduction; // Hard-disabled in staging/local
const emailRealDelivery = isProduction; // Block real email in staging
const smsRealDelivery = isProduction; // Block real SMS in staging
const identityStrictMode = isProduction || isStaging; // Enforce verification checks in cloud envs

// ===================================
// 5. EXPORT THE SAFE ENV OBJECT
// ===================================

export const env = {
    // metadata
    mode: CURRENT_MODE,
    isLocal,
    isStaging,
    isProduction,
    isTest,

    // server
    PORT,
    DATABASE_URL,
    UPSTASH_REDIS_REST_URL,

    // auth
    FIREBASE_PROJECT_ID,
    FIREBASE_PRIVATE_KEY,
    FIREBASE_CLIENT_EMAIL,

    // ai
    OPENAI_API_KEY,
    DEEPSEEK_API_KEY,
    GROQ_API_KEY,

    // stripe
    STRIPE_SECRET_KEY: stripeKey,
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
    STRIPE_MODE: stripeMode,

    // identity (merged)
    TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
    TWILIO_VERIFY_SERVICE_SID: process.env.TWILIO_VERIFY_SERVICE_SID,
    SENDGRID_API_KEY: process.env.SENDGRID_API_KEY,
    SENDGRID_FROM_EMAIL: process.env.SENDGRID_FROM_EMAIL,

    // flags
    isPayoutsEnabled: payoutsEnabled,
    isEmailRealDelivery: emailRealDelivery,
    isSmsRealDelivery: smsRealDelivery,
    isIdentityStrictMode: identityStrictMode,

    // limits
    aiCostLimitSoft: isProduction ? 50 : 5, // Daily $ limit
    aiCostLimitHard: isProduction ? 100 : 10,
};

// Log startup confirmation
serviceLogger.info({
    mode: CURRENT_MODE,
    stripeMode,
    payoutsEnabled,
    identityStrict: identityStrictMode
}, 'Running Enterprise Environment Loader');
