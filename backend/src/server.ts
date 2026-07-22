// Sentry initialization must remain the first application import.
import './sentry.js';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { config } from './config.js';
import { logger } from './logger.js';
import { publicIpRateLimitMiddleware, rateLimitMiddleware } from './middleware/security.js';
import { createMetricsEndpoint } from './monitoring/metrics.js';
import { registerAnimationRoutes } from './serverAnimationRoutes.js';
import { registerErrorHandlers } from './serverErrorHandlers.js';
import { registerHealthRoutes } from './serverHealthRoutes.js';
import { installProcessHandlers } from './serverLifecycle.js';
import {
  registerCoreMiddleware,
  registerGeneralRateLimits,
  validateProductionCors,
} from './serverMiddleware.js';
import {
  registerActionLinkRoutes,
  registerRealtimeRoute,
  registerStaticRoutes,
} from './serverPublicRoutes.js';
import { registerStateRoutes } from './serverStateRoutes.js';
import { startServer } from './serverStartup.js';
import { registerTrpcRoutes } from './serverTrpcRoutes.js';
import type { HustleApp } from './serverTypes.js';
import { registerWebhookRoutes } from './serverWebhookRoutes.js';

validateProductionCors();
const app: HustleApp = new Hono();

registerCoreMiddleware(app);

// Keep public-IP protection visible in the composition root: security tests verify order.
app.use('/trpc/*', publicIpRateLimitMiddleware());
registerGeneralRateLimits(app);

createMetricsEndpoint(app);
registerHealthRoutes(app);
registerActionLinkRoutes(app);

app.use('/realtime/stream', publicIpRateLimitMiddleware(), rateLimitMiddleware('sse'));
registerRealtimeRoute(app);
registerStaticRoutes(app);

registerTrpcRoutes(app);
registerAnimationRoutes(app);
registerStateRoutes(app);

app.use('/webhooks/*', publicIpRateLimitMiddleware());
app.use('/webhooks/*', rateLimitMiddleware('general'));
registerWebhookRoutes(app);
registerErrorHandlers(app);

startServer().catch((error) => logger.fatal({ err: error }, 'Failed to start server'));

export default { port: config.app.port, fetch: app.fetch };

const server = serve({ fetch: app.fetch, port: config.app.port });
installProcessHandlers(server);

export { app };
