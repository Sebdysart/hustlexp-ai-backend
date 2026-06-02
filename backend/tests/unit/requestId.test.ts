import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { requestIdMiddleware } from '../../src/middleware/request-id';

describe('requestIdMiddleware', () => {
  it('echoes provided x-request-id', async () => {
    const app = new Hono();
    app.use('*', requestIdMiddleware);
    app.get('/test', (c) => c.json({ ok: true }));
    const res = await app.request('/test', { headers: { 'x-request-id': 'test-id-123' } });
    expect(res.headers.get('x-request-id')).toBe('test-id-123');
  });

  it('generates a UUID request ID when none provided (A48-1: safe fallback)', async () => {
    const app = new Hono();
    app.use('*', requestIdMiddleware);
    app.get('/test', (c) => c.json({ ok: true }));
    const res = await app.request('/test');
    // A48-1 FIX: fallback is randomUUID() — UUID v4 format, safe against log injection
    const id = res.headers.get('x-request-id');
    expect(id).toBeTruthy();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('sets requestId in context', async () => {
    const app = new Hono();
    app.use('*', requestIdMiddleware);
    app.get('/test', (c) => c.json({ requestId: c.get('requestId') }));
    const res = await app.request('/test', { headers: { 'x-request-id': 'ctx-test' } });
    const body = await res.json();
    expect(body.requestId).toBe('ctx-test');
  });
});
