import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/middleware/security', () => ({
  publicIpRateLimitMiddleware: () => async (_context: unknown, next: () => Promise<void>) => next(),
}));

vi.mock('../../src/realtime/sse-handler', () => ({ sseHandler: vi.fn() }));

import {
  localTestProofMediaEnabled,
  registerLocalTestProofMediaRoutes,
} from '../../src/serverPublicRoutes';
import type { HustleApp } from '../../src/serverTypes';

const enabledEnv = {
  NODE_ENV: 'development',
  ENGINE_API_MODE: 'test',
  STRIPE_MODE: 'test',
  HXOS_ALLOW_LOCAL_TEST_AUTH: 'true',
  HXOS_LOCAL_TEST_AUTH_SECRET: 'a'.repeat(32),
  HXOS_ALLOW_LOCAL_TEST_EXECUTION: 'true',
  HXOS_ALLOW_LOCAL_TEST_PROOF_MEDIA: 'true',
};

describe('controlled TEST proof media route', () => {
  it('requires every local certification and proof-media gate', () => {
    expect(localTestProofMediaEnabled(enabledEnv)).toBe(true);
    expect(localTestProofMediaEnabled({ ...enabledEnv, NODE_ENV: 'production' })).toBe(false);
    expect(localTestProofMediaEnabled({ ...enabledEnv, ENGINE_API_MODE: 'live' })).toBe(false);
    expect(localTestProofMediaEnabled({ ...enabledEnv, STRIPE_MODE: 'live' })).toBe(false);
    expect(localTestProofMediaEnabled({ ...enabledEnv, HXOS_ALLOW_LOCAL_TEST_PROOF_MEDIA: 'false' })).toBe(false);
  });

  it('serves only the closed, truth-labeled PNG fixture set when enabled', async () => {
    const app = new Hono() as HustleApp;
    registerLocalTestProofMediaRoutes(app, enabledEnv);

    const response = await app.request('/api/hxos-local-test/proof-media/scope-checklist.png');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('image/png');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-hxos-environment')).toBe('CONTROLLED_TEST');
    expect(Array.from(new Uint8Array(await response.arrayBuffer()).slice(0, 8))).toEqual([
      137, 80, 78, 71, 13, 10, 26, 10,
    ]);

    const missing = await Promise.resolve(
      app.request('/api/hxos-local-test/proof-media/unknown.png'),
    );
    expect(missing.status).toBe(404);
  });

  it('does not register the route when disabled', async () => {
    const app = new Hono() as HustleApp;
    registerLocalTestProofMediaRoutes(app, {
      ...enabledEnv,
      HXOS_ALLOW_LOCAL_TEST_PROOF_MEDIA: 'false',
    });
    const response = await Promise.resolve(
      app.request('/api/hxos-local-test/proof-media/scope-checklist.png'),
    );
    expect(response.status).toBe(404);
  });
});
