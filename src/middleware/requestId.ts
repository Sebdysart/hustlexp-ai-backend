/**
 * Request ID Middleware — Fastify layer
 *
 * Provides four exports consumed by src/index.ts:
 *   addRequestId         — onRequest:  generates / reuses a unique request ID
 *   returnRequestId      — onResponse: echoes ID back via X-Request-Id header
 *   logRequest           — onResponse: structured access log
 *   createGlobalErrorHandler — Fastify setErrorHandler factory
 *
 * ID format: req_<ULID>  (time-sortable, URL-safe, 26-char Crockford Base32)
 * If the client supplies an x-request-id header it is reused for end-to-end
 * tracing (e.g. from the iOS app or an upstream load balancer).
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { ulid } from 'ulidx';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// onRequest hook
// ---------------------------------------------------------------------------

/**
 * Attach a unique request ID to every incoming Fastify request.
 * The ID is stored on `request.requestId` for downstream handlers.
 */
export async function addRequestId(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const incomingId = request.headers['x-request-id'];
  const id =
    typeof incomingId === 'string' && incomingId.length > 0
      ? incomingId
      : `req_${ulid()}`;

  request.requestId = id;
}

// ---------------------------------------------------------------------------
// onResponse hooks
// ---------------------------------------------------------------------------

/**
 * Echo the request ID back to the client as X-Request-Id so they can
 * correlate their requests with server-side logs.
 */
export async function returnRequestId(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (request.requestId) {
    reply.header('X-Request-Id', request.requestId);
  }
}

/**
 * Structured access log — emitted after every response.
 * Uses the noop logger in tests and the real pino logger in production.
 */
export async function logRequest(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  logger.info(
    {
      requestId: request.requestId,
      method: request.method,
      url: request.url,
      statusCode: (reply as FastifyReply & { statusCode?: number }).statusCode,
      ip: request.ip,
    },
    'request completed',
  );
}

// ---------------------------------------------------------------------------
// Global error handler factory
// ---------------------------------------------------------------------------

type FastifyErrorHandler = (
  err: Error & { statusCode?: number; validation?: unknown[] },
  request: FastifyRequest,
  reply: FastifyReply,
) => void;

/**
 * Returns a Fastify-compatible error handler.
 *
 * Mapping:
 *   - err.validation present    → 400 VALIDATION_ERROR
 *   - err.statusCode set        → forward that code
 *   - otherwise                 → 500 INTERNAL_ERROR (logged at error level)
 */
export function createGlobalErrorHandler(): FastifyErrorHandler {
  return function globalErrorHandler(err, request, reply) {
    const statusCode = err.statusCode ?? 500;

    if (statusCode >= 500) {
      logger.error(
        { requestId: request.requestId, err, method: request.method, url: request.url },
        'Internal server error',
      );
    }

    if (err.validation) {
      reply.status(400).send({
        error: 'Validation Error',
        code: 'VALIDATION_ERROR',
        details: err.validation,
        requestId: request.requestId,
      });
      return;
    }

    reply.status(statusCode).send({
      error: err.message || 'Internal Server Error',
      code: statusCode >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR',
      requestId: request.requestId,
    });
  };
}
