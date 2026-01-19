/**
 * Request ID Middleware
 *
 * PHASE 6.4: Adds unique request IDs for log tracing and correlation.
 */
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger.js';
/**
 * Add unique request ID to each request for tracing
 */
export async function addRequestId(request, _reply) {
    // Check if client provided a request ID, otherwise generate one
    const requestId = request.headers['x-request-id'] || uuidv4();
    // Attach to request for use in logging
    request.requestId = requestId;
}
/**
 * Add request ID to response headers
 */
export async function returnRequestId(request, reply) {
    const requestId = request.requestId;
    if (requestId) {
        reply.header('x-request-id', requestId);
    }
}
/**
 * Global error handler - sanitizes stack traces for production
 */
export function createGlobalErrorHandler() {
    return async (error, request, reply) => {
        const requestId = request.requestId || 'unknown';
        const isProd = process.env.NODE_ENV === 'production';
        // Log full error
        logger.error({
            requestId,
            error: error.message,
            stack: error.stack,
            url: request.url,
            method: request.method,
            userId: request.user?.uid,
        }, 'Unhandled error');
        // Determine status code
        const statusCode = error.statusCode || 500;
        // Build response
        const response = {
            error: statusCode >= 500 ? 'Internal Server Error' : error.message,
            code: error.code || 'INTERNAL_ERROR',
            requestId,
        };
        // Include stack trace only in development
        if (!isProd && error.stack) {
            response.stack = error.stack.split('\n').slice(0, 5);
        }
        reply.status(statusCode).send(response);
    };
}
/**
 * Request logging hook - logs request completion with timing
 */
export async function logRequest(request, reply) {
    const requestId = request.requestId || 'unknown';
    logger.info({
        requestId,
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        responseTime: reply.getResponseTime(),
        userId: request.user?.uid,
    }, 'Request completed');
}
//# sourceMappingURL=requestId.js.map