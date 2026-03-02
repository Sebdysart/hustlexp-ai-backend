// Minimal Fastify type shim for the legacy src/ Fastify layer.
// The active server (backend/src/) uses Hono; this shim allows TypeScript
// to type-check src/middleware/firebaseAuth.ts without requiring the
// fastify npm package.
declare module 'fastify' {
  export interface FastifyRequest {
    user?: import('firebase-admin/auth').DecodedIdToken;
    rawBody?: string | Buffer;
    /** Unique per-request ID attached by the addRequestId onRequest hook. */
    requestId?: string;
    // Use string (not string | string[]) so header access works without union checks
    headers: Record<string, string | undefined>;
    ip: string;
    method: string;
    url: string;
    body: unknown;
    params: unknown;
    query: unknown;
  }
  export interface FastifyReply {
    code: (statusCode: number) => void;
    send: (payload?: unknown) => void;
    header: (key: string, value: string) => FastifyReply;
    status: (statusCode: number) => FastifyReply;
    hijack: () => void;
    sent: boolean;
  }
}
