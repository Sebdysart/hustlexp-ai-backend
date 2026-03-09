import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';

// Build a simple test version of the health routes
function createHealthApp(dbHealthy: boolean, redisHealthy: boolean) {
  const app = new Hono();
  app.get('/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));
  app.get('/ready', async (c) => {
    const checks: Record<string, boolean> = {
      db: dbHealthy,
      redis: redisHealthy,
    };
    const allHealthy = Object.values(checks).every(Boolean);
    return c.json(
      { status: allHealthy ? 'ready' : 'degraded', checks, timestamp: new Date().toISOString() },
      allHealthy ? 200 : 503
    );
  });
  return app;
}

describe('GET /health', () => {
  it('returns 200 with status ok', async () => {
    const app = createHealthApp(true, true);
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.timestamp).toBeDefined();
  });
});

describe('GET /ready', () => {
  it('returns 200 when all checks pass', async () => {
    const app = createHealthApp(true, true);
    const res = await app.request('/ready');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ready');
    expect(body.checks.db).toBe(true);
    expect(body.checks.redis).toBe(true);
  });

  it('returns 503 when db is unhealthy', async () => {
    const app = createHealthApp(false, true);
    const res = await app.request('/ready');
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe('degraded');
    expect(body.checks.db).toBe(false);
  });

  it('returns 503 when redis is unhealthy', async () => {
    const app = createHealthApp(true, false);
    const res = await app.request('/ready');
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe('degraded');
    expect(body.checks.redis).toBe(false);
  });
});
