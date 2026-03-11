import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the metrics module
const mockObserve = vi.fn();
const mockInc = vi.fn();
vi.mock('../../src/monitoring/metrics', () => ({
  httpRequestDuration: { observe: (...args: unknown[]) => mockObserve(...args) },
  httpRequestsTotal: { inc: (...args: unknown[]) => mockInc(...args) },
}));

import { httpMetricsMiddleware } from '../../src/monitoring/http-metrics';

function createMockContext(path: string, method = 'GET', status = 200) {
  return {
    req: { path, method },
    res: { status },
  };
}

describe('HTTP Metrics Middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a middleware function', () => {
    const mw = httpMetricsMiddleware();
    expect(typeof mw).toBe('function');
  });

  it('skips /health endpoint', async () => {
    const mw = httpMetricsMiddleware();
    const next = vi.fn();
    const c = createMockContext('/health');

    await mw(c as any, next);

    expect(next).toHaveBeenCalled();
    expect(mockObserve).not.toHaveBeenCalled();
    expect(mockInc).not.toHaveBeenCalled();
  });

  it('skips /metrics endpoint', async () => {
    const mw = httpMetricsMiddleware();
    const next = vi.fn();
    const c = createMockContext('/metrics');

    await mw(c as any, next);

    expect(next).toHaveBeenCalled();
    expect(mockObserve).not.toHaveBeenCalled();
  });

  it('records metrics for regular endpoints', async () => {
    const mw = httpMetricsMiddleware();
    const next = vi.fn();
    const c = createMockContext('/api/tasks', 'GET', 200);

    await mw(c as any, next);

    expect(mockObserve).toHaveBeenCalled();
    expect(mockInc).toHaveBeenCalled();
  });

  it('normalizes UUID-containing routes', async () => {
    const mw = httpMetricsMiddleware();
    const next = vi.fn();
    const c = createMockContext('/api/tasks/550e8400-e29b-41d4-a716-446655440000', 'GET', 200);

    await mw(c as any, next);

    const observeCall = mockObserve.mock.calls[0];
    expect(observeCall[0].route).toBe('/api/tasks/:id');
  });

  it('normalizes numeric ID routes', async () => {
    const mw = httpMetricsMiddleware();
    const next = vi.fn();
    const c = createMockContext('/api/users/12345', 'GET', 200);

    await mw(c as any, next);

    const observeCall = mockObserve.mock.calls[0];
    expect(observeCall[0].route).toBe('/api/users/:id');
  });

  it('records 500 on errors', async () => {
    const mw = httpMetricsMiddleware();
    const error = new Error('test error');
    const next = vi.fn().mockRejectedValue(error);
    const c = createMockContext('/api/tasks', 'POST', 200);

    await expect(mw(c as any, next)).rejects.toThrow('test error');

    const observeCall = mockObserve.mock.calls[0];
    expect(observeCall[0].status_code).toBe('500');
  });

  it('records actual status code on success', async () => {
    const mw = httpMetricsMiddleware();
    const next = vi.fn();
    const c = createMockContext('/api/tasks', 'POST', 201);

    await mw(c as any, next);

    const observeCall = mockObserve.mock.calls[0];
    expect(observeCall[0].status_code).toBe('201');
  });
});
