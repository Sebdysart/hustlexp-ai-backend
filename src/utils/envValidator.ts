/**
 * @deprecated Use src/config/env.ts directly
 * This file remains for backward compatibility but delegates to the new enterprise loader.
 */

import { env } from '../config/env.js';
import { serviceLogger } from './logger.js';

export function validateEnv() {
    // The new loader validates on import. 
    // Return a structure compatible with legacy callers if they check properties
    return {
        valid: true,
        missing: [],
        warnings: [],
        configured: {
            OPENAI_API_KEY: !!env.OPENAI_API_KEY,
            DEEPSEEK_API_KEY: !!env.DEEPSEEK_API_KEY,
            GROQ_API_KEY: !!env.GROQ_API_KEY,
            DATABASE_URL: !!env.DATABASE_URL,
            UPSTASH_REDIS_REST_URL: !!env.UPSTASH_REDIS_REST_URL,
            FIREBASE_PROJECT_ID: !!env.FIREBASE_PROJECT_ID,
            FIREBASE_CONFIGURED: !!env.FIREBASE_PROJECT_ID
        }
    };
}

// Accept argument to satisfy legacy calls
export function logEnvStatus(result?: any) {
    serviceLogger.info({
        mode: env.mode,
        stripe: env.STRIPE_MODE,
        payouts: env.isPayoutsEnabled
    }, 'Environment Verified (Enterprise Loader)');
}

export function getEnvStatus() {
    return {
        database: !!env.DATABASE_URL,
        redis: !!env.UPSTASH_REDIS_REST_URL,
        openai: !!env.OPENAI_API_KEY,
        deepseek: !!env.DEEPSEEK_API_KEY,
        groq: !!env.GROQ_API_KEY,
        firebase: !!env.FIREBASE_PROJECT_ID
    };
}
