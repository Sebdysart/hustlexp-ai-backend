import type { DecodedIdToken } from 'firebase-admin/auth';

declare module 'fastify' {
  interface FastifyRequest {
    user?: DecodedIdToken;
    rawBody?: string | Buffer;
  }
}
