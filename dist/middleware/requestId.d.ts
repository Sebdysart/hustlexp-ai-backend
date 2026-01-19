/**
 * Request ID Middleware
 *
 * PHASE 6.4: Adds unique request IDs for log tracing and correlation.
 */
import type { FastifyRequest, FastifyReply } from 'fastify';
/**
 * Add unique request ID to each request for tracing
 */
export declare function addRequestId(request: FastifyRequest, _reply: FastifyReply): Promise<void>;
/**
 * Add request ID to response headers
 */
export declare function returnRequestId(request: FastifyRequest, reply: FastifyReply): Promise<void>;
/**
 * Global error handler - sanitizes stack traces for production
 */
export declare function createGlobalErrorHandler(): (error: Error, request: FastifyRequest, reply: FastifyReply) => Promise<void>;
/**
 * Request logging hook - logs request completion with timing
 */
export declare function logRequest(request: FastifyRequest, reply: FastifyReply): Promise<void>;
//# sourceMappingURL=requestId.d.ts.map