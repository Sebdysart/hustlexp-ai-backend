/**
 * Fastify OpenTelemetry Plugin
 *
 * Wraps every HTTP request in a span that carries:
 *   - http.method
 *   - http.route  (Fastify routerPath, e.g. /api/tasks/:id)
 *   - http.url    (full path including query string)
 *   - http.status_code (set on response / error)
 *
 * Span lifecycle:
 *   onRequest  → startActiveSpan (stored on request object via decoration)
 *   onResponse → setStatus OK + span.end()
 *   onError    → recordException + setStatus ERROR + span.end()
 *
 * NOTE: The `fastify` package is not listed as a direct dependency of this
 * layer, so types are expressed via the loose interfaces below rather than
 * importing from 'fastify'.  This avoids breaking the typecheck when the
 * full Fastify package is absent.
 */

import { SpanStatusCode, type Span } from '@opentelemetry/api';
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
}

interface OtelReply {
  statusCode: number;
}

interface FastifyLike {
  decorateRequest(name: string, value: unknown): void;
  addHook(
    event: 'onRequest' | 'onResponse',
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
  // Decorate the request with a nullable span slot
  fastify.decorateRequest('otelSpan', null);

  // -------------------------------------------------------------------------
  // onRequest — open the span
  // -------------------------------------------------------------------------
  fastify.addHook('onRequest', (request: OtelRequest, _reply: OtelReply, done: HookDone) => {
    try {
      // routerPath is the matched pattern (/api/tasks/:id).
      // Falls back to raw URL while request is being matched.
      const route = request.routerPath ?? request.url ?? 'unknown';
      const spanName = `${request.method} ${route}`;

      tracer.startActiveSpan(spanName, (span: Span) => {
        span.setAttribute('http.method', request.method);
        span.setAttribute('http.route', route);
        span.setAttribute('http.url', request.url);
        request.otelSpan = span;
      });
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
  // onError — record exception and close the span with ERROR status
  // -------------------------------------------------------------------------
  fastify.addHook('onError', (request: OtelRequest, reply: OtelReply, error: Error, done: HookDone) => {
    try {
      const span = request.otelSpan;
      if (span) {
        span.setAttribute('http.status_code', reply.statusCode);
        span.recordException(error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        span.end();
        request.otelSpan = undefined;
      }
    } catch (_err) {
      // Telemetry failure must never affect error handling
    }
    done();
  });
}
