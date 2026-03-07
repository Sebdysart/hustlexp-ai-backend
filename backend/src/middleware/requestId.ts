import { createMiddleware } from 'hono/factory';
import { randomUUID } from 'crypto';

export const requestIdMiddleware = createMiddleware(async (c, next) => {
  const requestId = c.req.header('x-request-id') ?? randomUUID();
  c.set('requestId', requestId);
  c.header('x-request-id', requestId);

  const start = Date.now();
  await next();
  const duration = Date.now() - start;

  const method = c.req.method;
  const path = new URL(c.req.url).pathname;
  const status = c.res.status;
  console.log(JSON.stringify({
    requestId,
    method,
    path,
    status,
    duration_ms: duration,
    timestamp: new Date().toISOString(),
  }));
});
