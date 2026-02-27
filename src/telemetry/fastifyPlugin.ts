/**
 * Fastify OpenTelemetry Plugin
 *
 * Wraps every HTTP request in a span that carries:
 *   - http.method
 *   - http.route  (Fastify routerPath, e.g. /api/tasks/:id, set in preHandler)
 *   - http.url    (full path including query string)
 *   - http.status_code (set on response / error)
 *
 * Span lifecycle:
 *   onRequest   → tracer.startSpan() — stored on request.otelSpan + context in request.otelContext
 *   preHandler  → update http.route now that routerPath is populated
 *   onResponse  → setStatus OK + span.end()
 *   onError     → recordException + setStatus ERROR (5xx only) + span.end()
 *
 * NOTE: The `fastify` package is not listed as a direct dependency of this
 * layer, so types are expressed via the loose interfaces below rather than
 * importing from 'fastify'.  This avoids breaking the typecheck when the
 * full Fastify package is absent.
 */

import { context, trace, SpanStatusCode, type Span } from '@opentelemetry/api';
import type { Context } from '@opentelemetry/api';
import { tracer } from './index.js';

// ---------------------------------------------------------------------------
// Minimal Fastify-compatible type surface — avoids direct 'fastify' import
// ---------------------------------------------------------------------------

type HookDone = () => void;

interface OtelRequest {
  method: string;
  routerPath?: string;
  url: string;
  otelSpan?: Span;
  otelContext?: Context;
}

interface OtelReply {
  statusCode: number;
}

interface FastifyLike {
  decorateRequest(name: string, value: unknown): void;
  addHook(
    event: 'onRequest' | 'onResponse' | 'preHandler',
    fn: (request: OtelRequest, reply: OtelReply, done: HookDone) => void,
  ): void;
  addHook(
    event: 'onError',
    fn: (request: OtelRequest, reply: OtelReply, error: Error, done: HookDone) => void,
  ): void;
}

// ---------------------------------------------------------------------------
// Plugin implementation
// ---------------------------------------------------------------------------

export async function telemetryPlugin(fastify: FastifyLike): Promise<void> {
  // Decorate the request with nullable span and context slots
  fastify.decorateRequest('otelSpan', null);
  fastify.decorateRequest('otelContext', null);

  // -------------------------------------------------------------------------
  // onRequest — open the span using startSpan (not startActiveSpan) so the
  // active context does not die at the end of the synchronous callback.
  // routerPath is NOT available yet (routing hasn't happened), so we use url
  // as a temporary span name and update http.route in preHandler.
  // -------------------------------------------------------------------------
  fastify.addHook('onRequest', (request: OtelRequest, _reply: OtelReply, done: HookDone) => {
    try {
      const route = request.url ?? 'unknown';
      const span = tracer.startSpan(`${request.method} ${route}`, {
        attributes: {
          'http.method': request.method,
          'http.url': request.url,
        },
      });
      // Create a context with this span as active so child spans can nest correctly
      const spanContext = trace.setSpan(context.active(), span);
      request.otelSpan = span;
      request.otelContext = spanContext;
    } catch (_err) {
      // Telemetry failure must never affect request processing
    }
    done();
  });

  // -------------------------------------------------------------------------
  // preHandler — routerPath IS now populated (routing is complete).
  // Update http.route to the parameterised pattern to avoid high cardinality.
  // -------------------------------------------------------------------------
  fastify.addHook('preHandler', (request: OtelRequest, _reply: OtelReply, done: HookDone) => {
    try {
      const span = request.otelSpan;
      if (span) {
        const route = (request as { routerPath?: string }).routerPath ?? request.url ?? 'unknown';
        span.setAttribute('http.route', route);
      }
    } catch (_err) {
      // Telemetry failure must never affect request processing
    }
    done();
  });

  // -------------------------------------------------------------------------
  // onResponse — close the span with OK status
  // -------------------------------------------------------------------------
  fastify.addHook('onResponse', (request: OtelRequest, reply: OtelReply, done: HookDone) => {
    try {
      const span = request.otelSpan;
      if (span) {
        span.setAttribute('http.status_code', reply.statusCode);
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
        request.otelSpan = undefined;
      }
    } catch (_err) {
      // Telemetry failure must never affect response delivery
    }
    done();
  });

  // -------------------------------------------------------------------------
  // onError — record exception and close the span.
  // Per OTel HTTP semantic conventions, ERROR status is only set for server
  // errors (5xx).  Client errors (4xx) are expected and do not indicate a
  // server-side problem.
  // -------------------------------------------------------------------------
  fastify.addHook('onError', (request: OtelRequest, reply: OtelReply, error: Error, done: HookDone) => {
    try {
      const span = request.otelSpan;
      if (span) {
        span.setAttribute('http.status_code', reply.statusCode);
        span.recordException(error);
        // Only mark the span as ERROR for server-side failures (5xx)
        if (reply.statusCode >= 500) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        }
        span.end();
        request.otelSpan = undefined;
      }
    } catch (_err) {
      // Telemetry failure must never affect error handling
    }
    done();
  });
}
