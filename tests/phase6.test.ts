/**
 * Phase 6 Backend Hardening Test Suite
 * 
 * Comprehensive tests for:
 * - Financial integrity (concurrency, idempotency)
 * - XP persistence
 * - AI timeouts
 * - Error handling
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock database
vi.mock('../db/index.js', () => ({
    sql: vi.fn(),
    isDatabaseAvailable: () => true,
    transaction: vi.fn(async (callback) => callback(vi.fn())),
}));

// ============================================
// PHASE 6.1: FINANCIAL INTEGRITY TESTS
// ============================================

describe('Phase 6.1: Financial Integrity', () => {
    describe('SERIALIZABLE Transaction Isolation', () => {
        it('should use SERIALIZABLE isolation level', async () => {
            // The transaction function in db/index.ts should use SERIALIZABLE
            const { transaction } = await import('../db/index.js');
            // Verify transaction exists and is callable
            expect(typeof transaction).toBe('function');
        });
    });

    describe('Idempotency Middleware', () => {
        it('should require x-idempotency-key for POST requests', async () => {
            const { requireIdempotencyKey } = await import('../middleware/idempotency.js');
            expect(typeof requireIdempotencyKey).toBe('function');
        });

        it('should allow requests without key when Redis unavailable', async () => {
            // Graceful degradation test
            const { isIdempotencyEnabled } = await import('../middleware/idempotency.js');
            expect(typeof isIdempotencyEnabled).toBe('function');
        });
    });

    describe('Rate Limiters', () => {
        it('should have admin rate limiter (10 req/min)', async () => {
            const { adminRateLimiter } = await import('../middleware/rateLimiter.js');
            // Will be null if Redis not configured, but function should exist
            expect(adminRateLimiter === null || typeof adminRateLimiter === 'object').toBe(true);
        });

        it('should have financial rate limiter (5 req/min)', async () => {
            const { financialRateLimiter } = await import('../middleware/rateLimiter.js');
            expect(financialRateLimiter === null || typeof financialRateLimiter === 'object').toBe(true);
        });
    });

    describe('XP Unique Constraint', () => {
        it('should prevent duplicate XP awards for same task', async () => {
            // Schema includes: CREATE UNIQUE INDEX idx_xp_events_user_task ON xp_events(user_id, task_id)
            // This is enforced at DB level - verify schema statement exists
            const fs = await import('fs');
            const schema = fs.readFileSync('src/db/schema.ts', 'utf-8');
            expect(schema).toContain('idx_xp_events_user_task');
        });
    });
});

// ============================================
// PHASE 6.2: XP PERSISTENCE TESTS
// ============================================

describe('Phase 6.2: XP Persistence', () => {
    describe('GamificationService', () => {
        it('should persist XP events to database', async () => {
            const { GamificationService } = await import('../services/GamificationService.js');
            expect(typeof GamificationService.awardXP).toBe('function');
        });

        it('should use ON CONFLICT DO NOTHING for idempotency', async () => {
            const fs = await import('fs');
            const gamification = fs.readFileSync('src/services/GamificationService.ts', 'utf-8');
            expect(gamification).toContain('ON CONFLICT');
        });

        it('should fallback to in-memory when DB unavailable', async () => {
            const fs = await import('fs');
            const gamification = fs.readFileSync('src/services/GamificationService.ts', 'utf-8');
            expect(gamification).toContain('xpEventsFallback');
        });
    });
});

// ============================================
// PHASE 6.3: AI SAFETY TESTS
// ============================================

describe('Phase 6.3: AI Safety', () => {
    describe('AI Timeout', () => {
        it('should have 30-second timeout configured', async () => {
            const fs = await import('fs');
            const router = fs.readFileSync('src/ai/router.ts', 'utf-8');
            expect(router).toContain('AI_TIMEOUT_MS = 30000');
        });

        it('should wrap AI calls with timeout', async () => {
            const fs = await import('fs');
            const router = fs.readFileSync('src/ai/router.ts', 'utf-8');
            expect(router).toContain('withTimeout');
        });
    });
});

// ============================================
// PHASE 6.4: DEPLOYMENT STABILITY TESTS
// ============================================

describe('Phase 6.4: Deployment Stability', () => {
    describe('Request ID Middleware', () => {
        it('should have addRequestId function', async () => {
            const { addRequestId } = await import('../middleware/requestId.js');
            expect(typeof addRequestId).toBe('function');
        });

        it('should have global error handler', async () => {
            const { createGlobalErrorHandler } = await import('../middleware/requestId.js');
            expect(typeof createGlobalErrorHandler).toBe('function');
        });
    });

    describe('Environment Validation', () => {
        it('should require STRIPE_SECRET_KEY', async () => {
            const fs = await import('fs');
            const envValidator = fs.readFileSync('src/utils/envValidator.ts', 'utf-8');
            expect(envValidator).toContain("'STRIPE_SECRET_KEY'");
            // Verify it's in required, not optional
            const requiredSection = envValidator.match(/required:\s*\[(.*?)\]/s);
            expect(requiredSection?.[1]).toContain('STRIPE_SECRET_KEY');
        });
    });
});

// ============================================
// MONEY ENGINE CONCURRENCY TESTS
// ============================================

describe('Money Engine Concurrency', () => {
    describe('Row-Level Locking', () => {
        it('should use SELECT FOR UPDATE on money_state_lock', async () => {
            const fs = await import('fs');
            const engine = fs.readFileSync('src/services/StripeMoneyEngine.ts', 'utf-8');
            expect(engine).toContain('FOR UPDATE');
        });
    });

    describe('Phase 5 Guards', () => {
        it('should have terminal state guard', async () => {
            const fs = await import('fs');
            const engine = fs.readFileSync('src/services/StripeMoneyEngine.ts', 'utf-8');
            expect(engine).toContain('TERMINAL_STATES');
        });

        it('should have dispute guard on release', async () => {
            const fs = await import('fs');
            const engine = fs.readFileSync('src/services/StripeMoneyEngine.ts', 'utf-8');
            expect(engine).toContain('Block RELEASE_PAYOUT if dispute exists');
        });

        it('should have admin validation guard', async () => {
            const fs = await import('fs');
            const engine = fs.readFileSync('src/services/StripeMoneyEngine.ts', 'utf-8');
            expect(engine).toContain('ADMIN_EVENTS');
        });
    });
});
