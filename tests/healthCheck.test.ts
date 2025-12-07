/**
 * Health Check Tests
 */

import { describe, it, expect, vi } from 'vitest';
import { quickHealthCheck } from '../src/utils/healthCheck.js';

describe('Health Check', () => {
    describe('quickHealthCheck', () => {
        it('should return ok status', () => {
            const result = quickHealthCheck();
            expect(result.status).toBe('ok');
        });

        it('should return a valid ISO timestamp', () => {
            const result = quickHealthCheck();
            expect(() => new Date(result.timestamp)).not.toThrow();
        });
    });
});
