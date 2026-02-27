import type { DecodedIdToken } from 'firebase-admin/auth';
import type { Span, Context } from '@opentelemetry/api';

// Minimal Fastify type shim for the legacy src/ Fastify layer.
// The active server (backend/src/) uses Hono; this exists so TypeScript can
// type-check the src/middleware/firebaseAuth.ts module without installing
// the full fastify package.
declare module 'fastify' {
  interface FastifyRequest {
    user?: DecodedIdToken;
    rawBody?: string | Buffer;
    otelSpan?: Span;
    otelContext?: Context;
    headers: Record<string, string | string[] | undefined>;
    ip: string;
    method: string;
    url: string;
    body: unknown;
    params: unknown;
    query: unknown;
  }
  interface FastifyReply {
    code: (statusCode: number) => FastifyReply;
    send: (payload?: unknown) => FastifyReply;
    header: (key: string, value: string) => FastifyReply;
    status: (statusCode: number) => FastifyReply;
    hijack: () => FastifyReply;
  }
  export type FastifyRequest = FastifyRequest;
  export type FastifyReply = FastifyReply;
}
