import { bodyLimit } from 'hono/body-limit';
import { compress } from 'hono/compress';
import { cors } from 'hono/cors';
import { config } from './config.js';
import { logger } from './logger.js';
import {
  aiRateLimitMiddleware,
  publicIpRateLimitMiddleware,
  rateLimitMiddleware,
  securityHeaders,
} from './middleware/security.js';
import { requestIdMiddleware, serverTimingMiddleware } from './middleware/request-id.js';
import { httpMetricsMiddleware } from './monitoring/http-metrics.js';
import type { HustleApp } from './serverTypes.js';

export function validateProductionCors(): void {
  if (!config.app.isProduction) return;
  const origins = config.app.allowedOrigins;
  if (origins.length === 0) {
    console.error('❌ CRITICAL: ALLOWED_ORIGINS is not set in production');
    console.error('   Set ALLOWED_ORIGINS to your frontend domain(s)');
    console.error('   Example: ALLOWED_ORIGINS=https://app.hustlexp.com,https://admin.hustlexp.com');
    process.exit(1);
  }
  if (origins.includes('*')) {
    console.error('❌ CRITICAL: ALLOWED_ORIGINS contains "*" in production');
    console.error('   This allows any website to access your API');
    console.error('   Set specific origins like: ALLOWED_ORIGINS=https://app.hustlexp.com');
    process.exit(1);
  }
  const nonHttps = origins.filter((origin) => origin.startsWith('http:'));
  if (nonHttps.length > 0) {
    console.error('❌ CRITICAL: Non-HTTPS origins in production:');
    nonHttps.forEach((origin) => console.error(`   - ${origin}`));
    console.error('   All origins must use HTTPS in production');
    process.exit(1);
  }
  logger.info('✅ CORS configured for production:');
  origins.forEach((origin) => logger.info(`   - ${origin}`));
}

function clientIp(headers: { get(name: string): string | undefined }): string {
  const cloudflare = headers.get('cf-connecting-ip');
  if (cloudflare) return cloudflare.trim();
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    const parts = forwarded.split(',').map((value) => value.trim()).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }
  return headers.get('x-real-ip') || 'unknown';
}

function allowedOrigins(): string[] {
  if (config.app.isDevelopment) {
    return [
      'http://localhost:3000',
      'http://localhost:5173',
      'http://localhost:5174',
      'http://localhost:8081',
    ];
  }
  return config.app.allowedOrigins.length > 0
    ? config.app.allowedOrigins
    : ['https://hustlexp.app', 'https://www.hustlexp.app'];
}

export function registerCoreMiddleware(app: HustleApp): void {
  app.use('*', bodyLimit({
    maxSize: 10 * 1024 * 1024,
    onError: (context) => context.json({ error: 'Request body too large', maxSize: '10MB' }, 413),
  }));
  app.use('*', requestIdMiddleware);
  app.use('*', serverTimingMiddleware);
  app.use('*', compress());
  app.use('*', securityHeaders);
  app.use('*', async (context, next) => {
    await next();
    context.header('X-API-Version', '2024-02-19');
    context.header('X-HustleXP-Version', '2.4.0');
    context.header('Deprecation', 'false');
  });
  app.use('*', async (context, next) => {
    const start = Date.now();
    await next();
    const duration = Date.now() - start;
    const status = context.res.status;
    const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
    logger[level]({
      requestId: context.get('requestId'),
      method: context.req.method,
      path: context.req.path,
      status,
      duration,
      ip: clientIp({ get: (name) => context.req.header(name) }),
    }, `${context.req.method} ${context.req.path} → ${status} (${duration}ms)`);
  });
  const origins = allowedOrigins();
  app.use('*', cors({
    origin: (requestOrigin) => {
      if (!requestOrigin) return config.app.isDevelopment ? origins[0] : null;
      return origins.includes(requestOrigin) ? requestOrigin : null;
    },
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-HustleXP-Platform'],
    credentials: true,
    maxAge: 3600,
  }));
  app.use('*', httpMetricsMiddleware());
  registerSpecificRateLimits(app);
}

function registerSpecificRateLimits(app: HustleApp): void {
  const auth = ['/trpc/user.register*', '/trpc/biometric.*', '/trpc/admin.*'];
  auth.forEach((path) => app.use(path, rateLimitMiddleware('auth')));
  const financial = [
    '/trpc/escrow.release*',
    '/trpc/stripe.*',
    '/trpc/stripeConnect.*',
    '/trpc/subscription.*',
    '/trpc/fraud.*',
  ];
  financial.forEach((path) => app.use(path, rateLimitMiddleware('financial')));
  const ai = ['/trpc/ai.*', '/trpc/disputeAI.*', '/trpc/matchmaker.*'];
  ai.forEach((path) => {
    app.use(path, rateLimitMiddleware('ai'));
    app.use(path, aiRateLimitMiddleware('openai'));
  });
  app.use('/trpc/taskDiscovery.getAISuggestions', rateLimitMiddleware('ai'));
  app.use('/trpc/taskDiscovery.getAISuggestions', aiRateLimitMiddleware('openai'));
  app.use('/trpc/taskDiscovery.browseTasks', rateLimitMiddleware('browse'));
  app.use('/trpc/escrow.refund*', rateLimitMiddleware('financial'));
  app.use('/trpc/escrow.confirmFunding*', rateLimitMiddleware('financial'));
  app.use('/trpc/escrow.*', rateLimitMiddleware('escrow'));
  app.use('/trpc/live.*', rateLimitMiddleware('live'));
  app.use('/trpc/task.*', rateLimitMiddleware('task'));
  const mutations = [
    '/trpc/messaging.*',
    '/trpc/rating.*',
    '/trpc/moderation.*',
    '/trpc/upload.*',
    '/trpc/notification.*',
    '/trpc/tipping.*',
    '/trpc/recurringTask.*',
    '/trpc/dispute.*',
    '/trpc/xpTax.*',
    '/trpc/incidents.*',
  ];
  mutations.forEach((path) => app.use(path, rateLimitMiddleware('mutation')));
  app.use('/trpc/user.requestErasure', rateLimitMiddleware('auth'));
  app.use('/trpc/user.updateProfile', rateLimitMiddleware('mutation'));
  app.use('/trpc/user.completeOnboarding', rateLimitMiddleware('mutation'));
}

export function registerGeneralRateLimits(app: HustleApp): void {
  app.use('/trpc/*', rateLimitMiddleware('general'));
  app.use('/api/*', publicIpRateLimitMiddleware());
  app.use('/api/*', rateLimitMiddleware('general'));
}
