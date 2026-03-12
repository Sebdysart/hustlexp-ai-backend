/**
 * Telemetry branch coverage tests
 *
 * Covers uncovered branches in:
 * - src/telemetry/dbTracer.ts: error path (catch branch)
 * - src/telemetry/fastifyPlugin.ts: all hook branches (span exists/absent, error 5xx vs 4xx,
 *   routerPath fallback, try/catch catch blocks)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SpanStatusCode } from '@opentelemetry/api';

// Mock the telemetry index to provide a mock tracer
const mockSpan = {
  setAttribute: vi.fn(),
  setStatus: vi.fn(),
  recordException: vi.fn(),
  end: vi.fn(),
};

const mockTracer = {
  startActiveSpan: vi.fn((name: string, fn: (span: typeof mockSpan) => unknown) => fn(mockSpan)),
  startSpan: vi.fn(() => mockSpan),
};

vi.mock('../../../src/telemetry/index', () => ({
  tracer: mockTracer,
}));

vi.mock('@opentelemetry/api', async () => {
  const actual = await vi.importActual('@opentelemetry/api');
  return {
    ...actual,
    context: { active: vi.fn(() => ({})) },
    trace: { setSpan: vi.fn((_ctx: unknown, span: unknown) => ({ span })) },
  };
});

beforeEach(() => vi.clearAllMocks());

// ============================================================================
// dbTracer
// ============================================================================

describe('tracedQuery', () => {
  it('records success span on OK', async () => {
    const { tracedQuery } = await import('../../../src/telemetry/dbTracer');
    const result = await tracedQuery('test.query', () => Promise.resolve([{ id: 1 }]));

    expect(result).toEqual([{ id: 1 }]);
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('db.system', 'postgresql');
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('db.operation', 'test.query');
    expect(mockSpan.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    expect(mockSpan.end).toHaveBeenCalled();
  });

  it('records error span and rethrows on failure', async () => {
    const { tracedQuery } = await import('../../../src/telemetry/dbTracer');
    const error = new Error('db boom');

    await expect(tracedQuery('fail.query', () => Promise.reject(error))).rejects.toThrow('db boom');

    expect(mockSpan.recordException).toHaveBeenCalledWith(error);
    expect(mockSpan.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR });
    expect(mockSpan.end).toHaveBeenCalled();
  });

  it('wraps non-Error in Error for recordException', async () => {
    const { tracedQuery } = await import('../../../src/telemetry/dbTracer');

    await expect(tracedQuery('string.error', () => Promise.reject('string error'))).rejects.toBe('string error');

    // Should have called recordException with an Error (from String(error))
    expect(mockSpan.recordException).toHaveBeenCalled();
    const arg = mockSpan.recordException.mock.calls[0][0];
    expect(arg).toBeInstanceOf(Error);
    expect(arg.message).toBe('string error');
  });
});

// ============================================================================
// fastifyPlugin
// ============================================================================

describe('telemetryPlugin', () => {
  it('registers all hooks on fastify instance', async () => {
    const { telemetryPlugin } = await import('../../../src/telemetry/fastifyPlugin');

    const hooks: Record<string, Function> = {};
    const fastifyMock = {
      decorateRequest: vi.fn(),
      addHook: vi.fn((event: string, fn: Function) => {
        hooks[event] = fn;
      }),
    };

    await telemetryPlugin(fastifyMock as any);

    expect(fastifyMock.decorateRequest).toHaveBeenCalledWith('otelSpan', null);
    expect(fastifyMock.decorateRequest).toHaveBeenCalledWith('otelContext', null);
    expect(hooks['onRequest']).toBeDefined();
    expect(hooks['preHandler']).toBeDefined();
    expect(hooks['onResponse']).toBeDefined();
    expect(hooks['onError']).toBeDefined();
  });

  it('onRequest creates span and attaches to request', async () => {
    const { telemetryPlugin } = await import('../../../src/telemetry/fastifyPlugin');

    const hooks: Record<string, Function> = {};
    const fastifyMock = {
      decorateRequest: vi.fn(),
      addHook: vi.fn((event: string, fn: Function) => {
        hooks[event] = fn;
      }),
    };

    await telemetryPlugin(fastifyMock as any);

    const request: Record<string, unknown> = { method: 'GET', url: '/api/test' };
    const reply = { statusCode: 200 };
    const done = vi.fn();

    hooks['onRequest'](request, reply, done);

    expect(request.otelSpan).toBeDefined();
    expect(request.otelContext).toBeDefined();
    expect(done).toHaveBeenCalled();
  });

  it('preHandler updates http.route when span exists', async () => {
    const { telemetryPlugin } = await import('../../../src/telemetry/fastifyPlugin');

    const hooks: Record<string, Function> = {};
    const fastifyMock = {
      decorateRequest: vi.fn(),
      addHook: vi.fn((event: string, fn: Function) => {
        hooks[event] = fn;
      }),
    };

    await telemetryPlugin(fastifyMock as any);

    const span = { setAttribute: vi.fn() };
    const request = { method: 'GET', url: '/api/tasks/123', routerPath: '/api/tasks/:id', otelSpan: span };
    const done = vi.fn();

    hooks['preHandler'](request, {}, done);

    expect(span.setAttribute).toHaveBeenCalledWith('http.route', '/api/tasks/:id');
    expect(done).toHaveBeenCalled();
  });

  it('preHandler does nothing when no span', async () => {
    const { telemetryPlugin } = await import('../../../src/telemetry/fastifyPlugin');

    const hooks: Record<string, Function> = {};
    const fastifyMock = {
      decorateRequest: vi.fn(),
      addHook: vi.fn((event: string, fn: Function) => {
        hooks[event] = fn;
      }),
    };

    await telemetryPlugin(fastifyMock as any);

    const request = { method: 'GET', url: '/test' };
    const done = vi.fn();

    hooks['preHandler'](request, {}, done);
    expect(done).toHaveBeenCalled();
  });

  it('preHandler falls back to url when no routerPath', async () => {
    const { telemetryPlugin } = await import('../../../src/telemetry/fastifyPlugin');

    const hooks: Record<string, Function> = {};
    const fastifyMock = {
      decorateRequest: vi.fn(),
      addHook: vi.fn((event: string, fn: Function) => {
        hooks[event] = fn;
      }),
    };

    await telemetryPlugin(fastifyMock as any);

    const span = { setAttribute: vi.fn() };
    const request = { method: 'GET', url: '/fallback', otelSpan: span };
    const done = vi.fn();

    hooks['preHandler'](request, {}, done);
    expect(span.setAttribute).toHaveBeenCalledWith('http.route', '/fallback');
  });

  it('onResponse ends span with OK status', async () => {
    const { telemetryPlugin } = await import('../../../src/telemetry/fastifyPlugin');

    const hooks: Record<string, Function> = {};
    const fastifyMock = {
      decorateRequest: vi.fn(),
      addHook: vi.fn((event: string, fn: Function) => {
        hooks[event] = fn;
      }),
    };

    await telemetryPlugin(fastifyMock as any);

    const span = { setAttribute: vi.fn(), setStatus: vi.fn(), end: vi.fn() };
    const request: Record<string, unknown> = { otelSpan: span };
    const reply = { statusCode: 200 };
    const done = vi.fn();

    hooks['onResponse'](request, reply, done);

    expect(span.setAttribute).toHaveBeenCalledWith('http.status_code', 200);
    expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    expect(span.end).toHaveBeenCalled();
    expect(request.otelSpan).toBeUndefined();
    expect(done).toHaveBeenCalled();
  });

  it('onResponse does nothing when no span', async () => {
    const { telemetryPlugin } = await import('../../../src/telemetry/fastifyPlugin');

    const hooks: Record<string, Function> = {};
    const fastifyMock = {
      decorateRequest: vi.fn(),
      addHook: vi.fn((event: string, fn: Function) => {
        hooks[event] = fn;
      }),
    };

    await telemetryPlugin(fastifyMock as any);

    const request = {};
    const done = vi.fn();

    hooks['onResponse'](request, { statusCode: 200 }, done);
    expect(done).toHaveBeenCalled();
  });

  it('onError records exception and sets ERROR status for 5xx', async () => {
    const { telemetryPlugin } = await import('../../../src/telemetry/fastifyPlugin');

    const hooks: Record<string, Function> = {};
    const fastifyMock = {
      decorateRequest: vi.fn(),
      addHook: vi.fn((event: string, fn: Function) => {
        hooks[event] = fn;
      }),
    };

    await telemetryPlugin(fastifyMock as any);

    const span = { setAttribute: vi.fn(), setStatus: vi.fn(), recordException: vi.fn(), end: vi.fn() };
    const request: Record<string, unknown> = { otelSpan: span };
    const reply = { statusCode: 500 };
    const error = new Error('server error');
    const done = vi.fn();

    hooks['onError'](request, reply, error, done);

    expect(span.recordException).toHaveBeenCalledWith(error);
    expect(span.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
      message: 'server error',
    });
    expect(span.end).toHaveBeenCalled();
    expect(request.otelSpan).toBeUndefined();
    expect(done).toHaveBeenCalled();
  });

  it('onError records exception but does NOT set ERROR status for 4xx', async () => {
    const { telemetryPlugin } = await import('../../../src/telemetry/fastifyPlugin');

    const hooks: Record<string, Function> = {};
    const fastifyMock = {
      decorateRequest: vi.fn(),
      addHook: vi.fn((event: string, fn: Function) => {
        hooks[event] = fn;
      }),
    };

    await telemetryPlugin(fastifyMock as any);

    const span = { setAttribute: vi.fn(), setStatus: vi.fn(), recordException: vi.fn(), end: vi.fn() };
    const request: Record<string, unknown> = { otelSpan: span };
    const reply = { statusCode: 404 };
    const error = new Error('not found');
    const done = vi.fn();

    hooks['onError'](request, reply, error, done);

    expect(span.recordException).toHaveBeenCalledWith(error);
    // Should NOT set ERROR status for 4xx
    expect(span.setStatus).not.toHaveBeenCalled();
    expect(span.end).toHaveBeenCalled();
  });

  it('onError does nothing when no span', async () => {
    const { telemetryPlugin } = await import('../../../src/telemetry/fastifyPlugin');

    const hooks: Record<string, Function> = {};
    const fastifyMock = {
      decorateRequest: vi.fn(),
      addHook: vi.fn((event: string, fn: Function) => {
        hooks[event] = fn;
      }),
    };

    await telemetryPlugin(fastifyMock as any);

    const request = {};
    const done = vi.fn();

    hooks['onError'](request, { statusCode: 500 }, new Error('err'), done);
    expect(done).toHaveBeenCalled();
  });
});
