import type { DecodedIdToken } from 'firebase-admin/auth';
import type { Span, Context } from '@opentelemetry/api';

declare module 'fastify' {
  interface FastifyRequest {
    user?: DecodedIdToken;
    rawBody?: string | Buffer;
    otelSpan?: Span;
    otelContext?: Context;
  }
}
