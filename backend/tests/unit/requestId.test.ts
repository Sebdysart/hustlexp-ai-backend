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

  it('generates a req_ULID request ID when none provided', async () => {
    const app = new Hono();
    app.use('*', requestIdMiddleware);
    app.get('/test', (c) => c.json({ ok: true }));
    const res = await app.request('/test');
    // Production middleware generates `req_${ulid()}` — a non-empty string starting with req_
    const id = res.headers.get('x-request-id');
    expect(id).toBeTruthy();
    expect(id).toMatch(/^req_[0-9A-Z]{26}$/);
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
