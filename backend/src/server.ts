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
import { registerOpsAdminRoutes } from './serverOpsAdminRoutes.js';

validateProductionCors();
const app: HustleApp = new Hono();

registerCoreMiddleware(app);

// Keep public-IP protection visible in the composition root: security tests verify order.
app.use('/trpc/*', publicIpRateLimitMiddleware());
registerGeneralRateLimits(app);

createMetricsEndpoint(app);
registerHealthRoutes(app);
registerActionLinkRoutes(app);
registerOpsAdminRoutes(app);

app.use('/realtime/stream', publicIpRateLimitMiddleware(), rateLimitMiddleware('sse'));
registerRealtimeRoute(app);
registerStaticRoutes(app);

registerTrpcRoutes(app);
registerAnimationRoutes(app);
registerStateRoutes(app);

// Signed processor deliveries must reach authentication and durable receipt
// even while Redis is unavailable. Global body limits still apply above.
registerWebhookRoutes(app);
registerErrorHandlers(app);

async function main(): Promise<void> {
  try {
    await startServer();

    const server = serve({
      fetch: app.fetch,
      port: config.app.port,
    });

    installProcessHandlers(server);

    logger.info(
      { port: config.app.port },
      'HustleXP backend HTTP server started',
    );
  } catch (error) {
    logger.fatal(
      { err: error },
      'Failed to initialize HustleXP backend',
    );

    process.exit(1);
  }
}

void main();

export default {
  port: config.app.port,
  fetch: app.fetch,
};

export { app };
