/**
 * Idempotency Middleware
 *
 * PHASE 6.1: Prevents duplicate POST requests for state-changing operations.
 * Requires x-idempotency-key header for financial endpoints.
 */
import type { FastifyRequest, FastifyReply } from 'fastify';
/**
 * Require idempotency key for POST/PUT/PATCH requests
 * Stores results to return same response on retries
 */
export declare function requireIdempotencyKey(request: FastifyRequest, reply: FastifyReply): Promise<void>;
/**
 * Hook to cache successful responses for idempotency
 */
export declare function cacheIdempotentResponse(request: FastifyRequest, reply: FastifyReply, payload: string): Promise<void>;
/**
 * Check if idempotency middleware is enabled
 */
export declare function isIdempotencyEnabled(): boolean;
//# sourceMappingURL=idempotency.d.ts.map