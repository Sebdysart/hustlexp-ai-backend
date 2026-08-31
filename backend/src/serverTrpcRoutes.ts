import { trpcServer } from '@hono/trpc-server';
import type { Context } from 'hono';
import { checkRateLimit } from './cache/redis.js';
import { appRouter } from './routers/index.js';
import type { HustleApp } from './serverTypes.js';
import { createContext } from './trpc.js';

const TRPC_MAX_BATCH_SIZE = 10;
const PRIVATE_NO_STORE_PROCEDURES = new Set([
  'universalOccurrence.customer',
  'universalOccurrence.provider',
  'universalOccurrence.operations',
]);

function trustedClientIp(context: Context): string {
  const cloudflare = context.req.header('cf-connecting-ip');
  if (cloudflare) return cloudflare.trim();
  const forwarded = context.req.header('x-forwarded-for');
  if (forwarded) {
    const ips = forwarded.split(',').map((ip) => ip.trim()).filter(Boolean);
    if (ips.length > 0) return ips[ips.length - 1];
  }
  return context.req.header('x-real-ip') || 'unknown';
}

async function consumeBatchTokens(context: Context, operationCount: number) {
  const identifier = `ip:${trustedClientIp(context)}`;
  for (let index = 1; index < operationCount; index += 1) {
    const result = await checkRateLimit(identifier, 'general', 120, 60);
    if (!result.allowed) {
      context.header('Retry-After', '60');
      return context.json({
        error: 'Too Many Requests',
        message: 'Rate limit exceeded (batch amplification). Try again in 60 seconds.',
        retryAfter: 60,
      }, 429);
    }
  }
  return null;
}

function applyPrivateNoStoreHeaders(context: Context): void {
  context.header('Cache-Control', 'private, no-store, max-age=0');
  context.header('Pragma', 'no-cache');
  const vary = (context.res.headers.get('Vary') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (!vary.some((value) => value.toLowerCase() === 'authorization')) {
    vary.push('Authorization');
  }
  context.header('Vary', vary.join(', '));
}

export function registerTrpcRoutes(app: HustleApp): void {
  app.use('/trpc/*', async (context, next) => {
    const trpcPath = context.req.path.replace(/^\/trpc\//, '');
    const procedures = trpcPath.split(',');
    const operationCount = procedures.length;
    const privateNoStore = procedures.some(
      (procedure) => PRIVATE_NO_STORE_PROCEDURES.has(procedure),
    );
    if (privateNoStore) applyPrivateNoStoreHeaders(context);
    if (operationCount > TRPC_MAX_BATCH_SIZE) {
      return context.json({
        error: 'Batch Too Large',
        message: `tRPC batch requests are limited to ${TRPC_MAX_BATCH_SIZE} operations. Received ${operationCount}.`,
        maxBatchSize: TRPC_MAX_BATCH_SIZE,
      }, 400);
    }
    if (operationCount > 1) {
      const rejection = await consumeBatchTokens(context, operationCount);
      if (rejection) return rejection;
    }
    await next();
    // The tRPC fetch adapter replaces the downstream Response, so reapply the
    // private cache policy and merge its own Vary token after it returns.
    if (privateNoStore) applyPrivateNoStoreHeaders(context);
  });
  app.use('/trpc/*', trpcServer({ router: appRouter, createContext }));
}
