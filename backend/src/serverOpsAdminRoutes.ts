import type { Context } from 'hono';
import { publicIpRateLimitMiddleware, rateLimitMiddleware } from './middleware/security.js';
import type { HustleApp } from './serverTypes.js';
import { getOpsLiquidityPayload } from './services/OpsLiquidityService.js';
import { assertOpsAdminBearerKey, OpsAuthError } from './routers/web/opsServiceKey.js';
import { logger } from './logger.js';

const log = logger.child({ route: 'admin.liquidity' });

function bearerToken(header: string | undefined): string {
  if (!header?.startsWith('Bearer ')) return '';
  return header.slice(7).trim();
}

async function handleLiquidity(context: Context) {
  try {
    assertOpsAdminBearerKey(bearerToken(context.req.header('Authorization')));
  } catch (error) {
    if (error instanceof OpsAuthError) {
      return context.json({ error: 'Unauthorized' }, 401);
    }
    throw error;
  }

  try {
    const payload = await getOpsLiquidityPayload();
    return context.json(payload);
  } catch (error) {
    log.error({ err: error }, 'GET /admin/liquidity failed');
    return context.json({ error: 'Internal server error' }, 500);
  }
}

/** Interim paste-key liquidity route used by OpsGate / OpsDashboard. */
export function registerOpsAdminRoutes(app: HustleApp): void {
  app.use('/admin/liquidity', publicIpRateLimitMiddleware(), rateLimitMiddleware('general'));
  app.get('/admin/liquidity', handleLiquidity);
}
