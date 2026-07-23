import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Context } from 'hono';
import { localCertificationAuthEnabled } from './auth/local-certification-token.js';
import { publicIpRateLimitMiddleware } from './middleware/security.js';
import { sseHandler } from './realtime/sse-handler.js';
import type { HustleApp } from './serverTypes.js';

const publicDir = join(import.meta.dirname || __dirname, '..', '..', 'public');
const localTestProofDir = join(import.meta.dirname || __dirname, '..', 'test-evidence');
const localTestProofArtifacts = new Map([
  ['scope-checklist.png', 'hxos-local-test-proof-1.png'],
  ['execution-state.png', 'hxos-local-test-proof-2.png'],
]);

export function localTestProofMediaEnabled(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  return localCertificationAuthEnabled(env)
    && env.HXOS_ALLOW_LOCAL_TEST_EXECUTION === 'true'
    && env.HXOS_ALLOW_LOCAL_TEST_PROOF_MEDIA === 'true';
}

export function registerLocalTestProofMediaRoutes(
  app: HustleApp,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): void {
  if (!localTestProofMediaEnabled(env)) return;
  app.get('/api/hxos-local-test/proof-media/:artifact', (context) => {
    const fileName = localTestProofArtifacts.get(context.req.param('artifact'));
    if (!fileName) return context.text('Not found', 404);
    const filePath = join(localTestProofDir, fileName);
    if (!existsSync(filePath)) return context.text('Not found', 404);
    return context.body(new Uint8Array(readFileSync(filePath)), 200, {
      'Cache-Control': 'no-store',
      'Content-Type': 'image/png',
      'X-Content-Type-Options': 'nosniff',
      'X-HXOS-Environment': 'CONTROLLED_TEST',
    });
  });
}

function serveStatic(path: string) {
  return (context: Context) => {
    const filePath = join(publicDir, path);
    if (existsSync(filePath)) return context.html(readFileSync(filePath, 'utf-8'));
    return context.text('Not found', 404);
  };
}

export function registerActionLinkRoutes(app: HustleApp): void {
  app.get('/api/action-link', async (context) => {
    const { handleActionLinkGet } = await import('./routers/web/actionLinks.js');
    const result = await handleActionLinkGet(context.req.query('token') ?? '');
    if (!result.ok && result.code === 'expired') return context.json(result, 410);
    if (!result.ok && result.code === 'not_found') return context.json(result, 404);
    return context.json(result, result.ok ? 200 : 400);
  });
  app.post('/api/action-link', async (context) => {
    const { handleActionLinkPost } = await import('./routers/web/actionLinks.js');
    const body = await context.req.json().catch(() => ({})) as {
      token?: string;
      action?: string;
    };
    const result = await handleActionLinkPost(body.token ?? '', body.action ?? '');
    if (!result.ok && result.code === 'expired') return context.json(result, 410);
    return context.json(result, result.ok ? 200 : 400);
  });
}

export function registerRealtimeRoute(app: HustleApp): void {
  app.get('/realtime/stream', sseHandler);
}

export function registerStaticRoutes(app: HustleApp): void {
  registerLocalTestProofMediaRoutes(app);
  app.use('/privacy*', publicIpRateLimitMiddleware());
  app.use('/terms*', publicIpRateLimitMiddleware());
  app.use('/legal*', publicIpRateLimitMiddleware());
  app.get('/privacy-policy', serveStatic('privacy-policy.html'));
  app.get('/privacy', serveStatic('privacy-policy.html'));
  app.get('/terms-of-service', serveStatic('terms-of-service.html'));
  app.get('/terms', serveStatic('terms-of-service.html'));
  app.get('/legal', serveStatic('index.html'));
}
