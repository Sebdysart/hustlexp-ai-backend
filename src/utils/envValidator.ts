/**
 * Environment Variable Validator
 * 
 * Validates required and optional environment variables at startup.
 * Provides clear error messages for missing configuration.
 */

import { logger } from './logger.js';

interface EnvConfig {
    required: string[];
    optional: string[];
}

const ENV_CONFIG: EnvConfig = {
    required: [
        // At least one AI provider must be configured
    ],
    optional: [
        'OPENAI_API_KEY',
        'DEEPSEEK_API_KEY',
        'GROQ_API_KEY',
        'DATABASE_URL',
        'UPSTASH_REDIS_REST_URL',
        'UPSTASH_REDIS_REST_TOKEN',
        'FIREBASE_PROJECT_ID',
        'FIREBASE_CLIENT_EMAIL',
        'FIREBASE_PRIVATE_KEY',
        'PORT',
        'NODE_ENV',
    ],
};

interface ValidationResult {
    valid: boolean;
    missing: string[];
    warnings: string[];
    configured: Record<string, boolean>;
}

/**
 * Validate all environment variables
 */
export function validateEnv(): ValidationResult {
    const missing: string[] = [];
    const warnings: string[] = [];
    const configured: Record<string, boolean> = {};

    // Check required variables
    for (const key of ENV_CONFIG.required) {
        if (!process.env[key]) {
            missing.push(key);
        }
        configured[key] = !!process.env[key];
    }

    // Check optional variables and track status
    for (const key of ENV_CONFIG.optional) {
        configured[key] = !!process.env[key];
    }

    // Validate AI provider configuration
    const hasOpenAI = !!process.env.OPENAI_API_KEY;
    const hasDeepSeek = !!process.env.DEEPSEEK_API_KEY;
    const hasGroq = !!process.env.GROQ_API_KEY;

    if (!hasOpenAI && !hasDeepSeek && !hasGroq) {
        warnings.push('No AI provider configured - AI features will not work');
    }

    // Validate database
    if (!process.env.DATABASE_URL) {
        warnings.push('DATABASE_URL not set - using in-memory storage');
    }

    // Validate Redis (required for rate limiting)
    if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
        warnings.push('Redis not configured - rate limiting disabled');
    }

    // Validate Firebase (required for authentication)
    const hasFirebase = !!process.env.FIREBASE_PROJECT_ID &&
        !!process.env.FIREBASE_CLIENT_EMAIL &&
        !!process.env.FIREBASE_PRIVATE_KEY;
    if (!hasFirebase) {
        warnings.push('Firebase not configured - authentication disabled');
    }
    configured['FIREBASE_CONFIGURED'] = hasFirebase;

    return {
        valid: missing.length === 0,
        missing,
        warnings,
        configured,
    };
}

/**
 * Log environment validation results
 */
export function logEnvStatus(result: ValidationResult): void {
    if (result.missing.length > 0) {
        logger.error({ missing: result.missing }, 'Missing required environment variables');
    }

    for (const warning of result.warnings) {
        logger.warn(warning);
    }

    // Log configured services
    const services = {
        openai: result.configured.OPENAI_API_KEY ? '✓' : '✗',
        deepseek: result.configured.DEEPSEEK_API_KEY ? '✓' : '✗',
        groq: result.configured.GROQ_API_KEY ? '✓' : '✗',
        database: result.configured.DATABASE_URL ? '✓' : '✗',
        redis: result.configured.UPSTASH_REDIS_REST_URL ? '✓' : '✗',
        firebase: result.configured.FIREBASE_CONFIGURED ? '✓' : '✗',
    };

    logger.info({ services }, 'Service configuration');
}

/**
 * Get environment status for health check
 */
export function getEnvStatus(): Record<string, boolean> {
    const result = validateEnv();
    return {
        openai: result.configured.OPENAI_API_KEY || false,
        deepseek: result.configured.DEEPSEEK_API_KEY || false,
        groq: result.configured.GROQ_API_KEY || false,
        database: result.configured.DATABASE_URL || false,
        redis: (result.configured.UPSTASH_REDIS_REST_URL && result.configured.UPSTASH_REDIS_REST_TOKEN) || false,
        firebase: result.configured.FIREBASE_CONFIGURED || false,
    };
}
