/**
 * Environment Validator Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { validateEnv, getEnvStatus } from '../src/utils/envValidator.js';

describe('Environment Validator', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        vi.resetModules();
        process.env = { ...originalEnv };
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    describe('validateEnv', () => {
        it('should return valid when at least one AI provider is configured', () => {
            process.env.OPENAI_API_KEY = 'test-key';
            const result = validateEnv();
            expect(result.valid).toBe(true);
            expect(result.warnings).not.toContain('No AI provider configured - AI features will not work');
        });

        it('should warn when no AI provider is configured', () => {
            delete process.env.OPENAI_API_KEY;
            delete process.env.DEEPSEEK_API_KEY;
            delete process.env.GROQ_API_KEY;
            const result = validateEnv();
            expect(result.warnings).toContain('No AI provider configured - AI features will not work');
        });

        it('should warn when DATABASE_URL is not set', () => {
            delete process.env.DATABASE_URL;
            const result = validateEnv();
            expect(result.warnings).toContain('DATABASE_URL not set - using in-memory storage');
        });

        it('should warn when Redis is not configured', () => {
            delete process.env.UPSTASH_REDIS_REST_URL;
            delete process.env.UPSTASH_REDIS_REST_TOKEN;
            const result = validateEnv();
            expect(result.warnings).toContain('Redis not configured - rate limiting disabled');
        });
    });

    describe('getEnvStatus', () => {
        it('should return correct status for configured services', () => {
            process.env.OPENAI_API_KEY = 'test-key';
            process.env.DATABASE_URL = 'postgres://test';
            const status = getEnvStatus();
            expect(status.openai).toBe(true);
            expect(status.database).toBe(true);
        });

        it('should return false for unconfigured services', () => {
            delete process.env.OPENAI_API_KEY;
            delete process.env.DATABASE_URL;
            const status = getEnvStatus();
            expect(status.openai).toBe(false);
            expect(status.database).toBe(false);
        });
    });
});
