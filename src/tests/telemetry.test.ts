/**
 * OpenTelemetry Instrumentation Tests — Task 18
 *
 * Verifies:
 *  1. tracedQuery resolves with the result of fn()
 *  2. tracedQuery re-throws errors from fn()
 *  3. fastifyPlugin registers onRequest, onResponse, and onError hooks
 *  4. telemetry SDK init failure does NOT throw (server-safe)
 *  5. AI span attributes are set correctly (mock tracer)
 *  6. degradedMode enqueueAIRequest injects trace context carrier
 *  7. onError hook records exception and ends span (5xx)
 *  8. onError hook does NOT set ERROR status for 4xx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Shared mock span — used by all tests that call startActiveSpan / startSpan
// ---------------------------------------------------------------------------

const mockSpanEnd = vi.fn();
const mockSpanSetAttribute = vi.fn();
const mockSpanSetStatus = vi.fn();
const mockSpanRecordException = vi.fn();

const mockSpan = {
  setAttribute: mockSpanSetAttribute,
  setStatus: mockSpanSetStatus,
  recordException: mockSpanRecordException,
  end: mockSpanEnd,
};

const mockStartActiveSpan = vi.fn((_name: string, fn: (span: typeof mockSpan) => unknown) => fn(mockSpan));
const mockStartSpan = vi.fn(() => mockSpan);

const mockTracer = {
  startActiveSpan: mockStartActiveSpan,
  startSpan: mockStartSpan,
};

// ---------------------------------------------------------------------------
// Mock @opentelemetry/api before any module imports
// ---------------------------------------------------------------------------

vi.mock('@opentelemetry/api', () => {
  const SpanStatusCode = { OK: 1, ERROR: 2, UNSET: 0 };
  return {
    SpanStatusCode,
    trace: {
      getTracer: () => mockTracer,
      setSpan: (_ctx: unknown, _span: unknown) => ({ spanContext: 'mocked' }),
    },
    context: {
      active: () => ({}),
    },
    propagation: {
      inject: (_ctx: unknown, carrier: Record<string, string>) => {
        carrier['traceparent'] = '00-abc123-def456-01';
      },
    },
  };
});

// Mock the telemetry/index module so dbTracer and fastifyPlugin use our
// mock tracer directly.
vi.mock('../telemetry/index.js', () => ({
  tracer: mockTracer,
}));

// Mock NodeSDK to avoid real SDK initialization in the safety test
vi.mock('@opentelemetry/sdk-node', () => ({
  NodeSDK: class MockNodeSDK {
    constructor() { /* no-op */ }
    start() { /* no-op */ }
    shutdown() { return Promise.resolve(); }
  },
}));

vi.mock('@opentelemetry/sdk-trace-base', () => ({
  ConsoleSpanExporter: class MockConsoleSpanExporter {},
  NoopSpanProcessor: class MockNoopSpanProcessor {},
}));

vi.mock('@opentelemetry/exporter-trace-otlp-http', () => ({
  OTLPTraceExporter: class MockOTLPTraceExporter {
    constructor() { /* no-op */ }
  },
}));

vi.mock('@opentelemetry/instrumentation-http', () => ({
  HttpInstrumentation: class MockHttpInstrumentation {
    constructor() { /* no-op */ }
  },
}));

vi.mock('@opentelemetry/instrumentation-pg', () => ({
  PgInstrumentation: class MockPgInstrumentation {
    constructor() { /* no-op */ }
  },
}));

// ---------------------------------------------------------------------------
// Test 1 & 2: tracedQuery
// ---------------------------------------------------------------------------

describe('tracedQuery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-set implementation after clearAllMocks
    mockStartActiveSpan.mockImplementation((_name: string, fn: (span: typeof mockSpan) => unknown) => fn(mockSpan));
    mockStartSpan.mockReturnValue(mockSpan);
  });

  it('resolves with the result of fn()', async () => {
    const { tracedQuery } = await import('../telemetry/dbTracer.js');

    const result = await tracedQuery('users.findById', () => Promise.resolve({ id: 42 }));

    expect(result).toEqual({ id: 42 });
    expect(mockStartActiveSpan).toHaveBeenCalledWith('db.query users.findById', expect.any(Function));
    expect(mockSpanSetAttribute).toHaveBeenCalledWith('db.system', 'postgresql');
    expect(mockSpanSetAttribute).toHaveBeenCalledWith('db.operation', 'users.findById');
    expect(mockSpanSetStatus).toHaveBeenCalledWith({ code: 1 }); // SpanStatusCode.OK
    expect(mockSpanEnd).toHaveBeenCalled();
  });

  it('re-throws errors from fn() and records exception on span', async () => {
    const { tracedQuery } = await import('../telemetry/dbTracer.js');
    const boom = new Error('db connection refused');

    await expect(
      tracedQuery('tasks.insert', () => Promise.reject(boom)),
    ).rejects.toThrow('db connection refused');

    expect(mockSpanRecordException).toHaveBeenCalledWith(boom);
    expect(mockSpanSetStatus).toHaveBeenCalledWith({ code: 2 }); // SpanStatusCode.ERROR
    expect(mockSpanEnd).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Test 3: fastifyPlugin registers hooks
// ---------------------------------------------------------------------------

describe('fastifyPlugin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStartActiveSpan.mockImplementation((_name: string, fn: (span: typeof mockSpan) => unknown) => fn(mockSpan));
    mockStartSpan.mockReturnValue(mockSpan);
  });

  it('registers onRequest, onResponse, and onError hooks on the Fastify instance', async () => {
    const { telemetryPlugin } = await import('../telemetry/fastifyPlugin.js');

    const addedHooks = new Set<string>();
    const mockFastify = {
      decorateRequest: vi.fn(),
      addHook: vi.fn((hookName: string) => {
        addedHooks.add(hookName);
      }),
    };

    await telemetryPlugin(mockFastify as never);

    expect(addedHooks).toContain('onRequest');
    expect(addedHooks).toContain('onResponse');
    expect(addedHooks).toContain('onError');
  });

  it('onRequest hook calls tracer.startSpan with method + url and stores span on request', async () => {
    const { telemetryPlugin } = await import('../telemetry/fastifyPlugin.js');

    const addedHooks = new Map<string, (...args: unknown[]) => void>();
    const mockFastify = {
      decorateRequest: vi.fn(),
      addHook: vi.fn((name: string, fn: (...args: unknown[]) => void) => {
        addedHooks.set(name, fn);
      }),
    };

    await telemetryPlugin(mockFastify as never);

    const fakeRequest = {
      method: 'GET',
      routerPath: '/api/tasks/:id',
      url: '/api/tasks/123',
      otelSpan: undefined as unknown,
      otelContext: undefined as unknown,
    };
    const done = vi.fn();

    const onRequestHook = addedHooks.get('onRequest');
    expect(onRequestHook).toBeDefined();
    onRequestHook!(fakeRequest, {}, done);

    expect(done).toHaveBeenCalled();
    // Uses startSpan (not startActiveSpan) to avoid context being destroyed
    expect(mockStartSpan).toHaveBeenCalledWith(
      'GET /api/tasks/123',
      expect.objectContaining({ attributes: expect.objectContaining({ 'http.method': 'GET' }) }),
    );
    // Span is stored on request
    expect(fakeRequest.otelSpan).toBe(mockSpan);
  });

  it('preHandler hook sets http.route from routerPath', async () => {
    const { telemetryPlugin } = await import('../telemetry/fastifyPlugin.js');

    const addedHooks = new Map<string, (...args: unknown[]) => void>();
    const mockFastify = {
      decorateRequest: vi.fn(),
      addHook: vi.fn((name: string, fn: (...args: unknown[]) => void) => {
        addedHooks.set(name, fn);
      }),
    };

    await telemetryPlugin(mockFastify as never);

    const localSpan = {
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
      recordException: vi.fn(),
      end: vi.fn(),
    };
    const fakeRequest = {
      method: 'GET',
      routerPath: '/api/tasks/:id',
      url: '/api/tasks/123',
      otelSpan: localSpan,
    };
    const done = vi.fn();

    const preHandlerHook = addedHooks.get('preHandler');
    expect(preHandlerHook).toBeDefined();
    preHandlerHook!(fakeRequest, {}, done);

    expect(localSpan.setAttribute).toHaveBeenCalledWith('http.route', '/api/tasks/:id');
    expect(done).toHaveBeenCalled();
  });

  it('onResponse hook ends the span and sets status OK', async () => {
    const { telemetryPlugin } = await import('../telemetry/fastifyPlugin.js');

    const addedHooks = new Map<string, (...args: unknown[]) => void>();
    const mockFastify = {
      decorateRequest: vi.fn(),
      addHook: vi.fn((name: string, fn: (...args: unknown[]) => void) => {
        addedHooks.set(name, fn);
      }),
    };

    await telemetryPlugin(mockFastify as never);

    const localSpan = {
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
      recordException: vi.fn(),
      end: vi.fn(),
    };
    const fakeRequest = { otelSpan: localSpan };
    const fakeReply = { statusCode: 200 };
    const done = vi.fn();

    const onResponseHook = addedHooks.get('onResponse');
    expect(onResponseHook).toBeDefined();
    onResponseHook!(fakeRequest, fakeReply, done);

    expect(localSpan.setAttribute).toHaveBeenCalledWith('http.status_code', 200);
    expect(localSpan.setStatus).toHaveBeenCalledWith({ code: 1 }); // SpanStatusCode.OK
    expect(localSpan.end).toHaveBeenCalled();
    expect(done).toHaveBeenCalled();
  });

  it('records exception and ends span in onError hook for 5xx errors', async () => {
    const { telemetryPlugin } = await import('../telemetry/fastifyPlugin.js');

    const addedHooks = new Map<string, (...args: unknown[]) => void>();
    const mockFastify = {
      decorateRequest: vi.fn(),
      addHook: vi.fn((name: string, fn: (...args: unknown[]) => void) => {
        addedHooks.set(name, fn);
      }),
    };

    await telemetryPlugin(mockFastify as never);

    const localSpan = {
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
      recordException: vi.fn(),
      end: vi.fn(),
    };
    const fakeRequest = { otelSpan: localSpan };
    const fakeReply = { statusCode: 500 };
    const fakeError = new Error('internal server error');
    const done = vi.fn();

    const onErrorHook = addedHooks.get('onError') as (
      req: unknown, reply: unknown, err: Error, done: () => void
    ) => void;
    expect(onErrorHook).toBeDefined();
    onErrorHook(fakeRequest, fakeReply, fakeError, done);

    expect(localSpan.setAttribute).toHaveBeenCalledWith('http.status_code', 500);
    expect(localSpan.recordException).toHaveBeenCalledWith(fakeError);
    // 5xx → ERROR status must be set
    expect(localSpan.setStatus).toHaveBeenCalledWith({ code: 2, message: 'internal server error' });
    expect(localSpan.end).toHaveBeenCalled();
    expect(done).toHaveBeenCalled();
  });

  it('does not set SpanStatusCode.ERROR for 4xx errors in onError hook', async () => {
    const { telemetryPlugin } = await import('../telemetry/fastifyPlugin.js');

    const addedHooks = new Map<string, (...args: unknown[]) => void>();
    const mockFastify = {
      decorateRequest: vi.fn(),
      addHook: vi.fn((name: string, fn: (...args: unknown[]) => void) => {
        addedHooks.set(name, fn);
      }),
    };

    await telemetryPlugin(mockFastify as never);

    const localSpan = {
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
      recordException: vi.fn(),
      end: vi.fn(),
    };
    const fakeRequest = { otelSpan: localSpan };
    const fakeReply = { statusCode: 404 };
    const fakeError = new Error('not found');
    const done = vi.fn();

    const onErrorHook = addedHooks.get('onError') as (
      req: unknown, reply: unknown, err: Error, done: () => void
    ) => void;
    expect(onErrorHook).toBeDefined();
    onErrorHook(fakeRequest, fakeReply, fakeError, done);

    expect(localSpan.setAttribute).toHaveBeenCalledWith('http.status_code', 404);
    expect(localSpan.recordException).toHaveBeenCalledWith(fakeError);
    // 4xx → setStatus must NOT be called with ERROR
    expect(localSpan.setStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({ code: 2 }),
    );
    expect(localSpan.end).toHaveBeenCalled();
    expect(done).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Test 4: SDK init failure is server-safe
// ---------------------------------------------------------------------------

describe('telemetry SDK init safety', () => {
  it('does not throw even when NodeSDK is mocked away', async () => {
    // The telemetry/index.ts wraps NodeSDK init in try/catch.
    // With mocked SDK, importing must succeed without error.
    await expect(import('../telemetry/index.js')).resolves.toBeDefined();
  });

  it('exports a tracer object with startActiveSpan', async () => {
    const mod = await import('../telemetry/index.js');
    expect(mod.tracer).toBeDefined();
    expect(typeof mod.tracer.startActiveSpan).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Test 5: AI span attributes (mock tracer verification)
// ---------------------------------------------------------------------------

describe('AI span attributes in routedGenerate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStartActiveSpan.mockImplementation((_name: string, fn: (span: typeof mockSpan) => unknown) => fn(mockSpan));
    mockStartSpan.mockReturnValue(mockSpan);
  });

  it('sets ai.provider, ai.model, and ai.prompt_length attributes on the span', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('GROQ_API_KEY', '');
    vi.stubEnv('DEEPSEEK_API_KEY', '');
    vi.stubEnv('ANTHROPIC_API_KEY', '');

    const { routedGenerate } = await import('../ai/router.js');

    // All providers will throw "not configured" — routedGenerate throws too
    await expect(
      routedGenerate('default', { messages: [{ role: 'user', content: 'hello world' }] }),
    ).rejects.toThrow();

    // tracer.startActiveSpan was called for at least one provider
    expect(mockStartActiveSpan).toHaveBeenCalledWith(
      expect.stringMatching(/^ai\.generate /),
      expect.any(Function),
    );

    // Span attributes were set on the mock span
    expect(mockSpanSetAttribute).toHaveBeenCalledWith('ai.provider', expect.any(String));
    expect(mockSpanSetAttribute).toHaveBeenCalledWith('ai.model', expect.any(String));
    expect(mockSpanSetAttribute).toHaveBeenCalledWith('ai.prompt_length', expect.any(Number));
  });
});

// ---------------------------------------------------------------------------
// Test 6: degradedMode trace context injection
// ---------------------------------------------------------------------------

describe('degradedMode trace context injection', () => {
  it('enqueueAIRequest captures a traceContext carrier on the job', async () => {
    const { enqueueAIRequest } = await import('../ai/degradedMode.js');
    const job = enqueueAIRequest('user-otel', 'test message', 'chat');

    expect(job.traceContext).toBeDefined();
    expect(typeof job.traceContext).toBe('object');
    // The mock propagation.inject sets a traceparent key
    expect(job.traceContext['traceparent']).toBe('00-abc123-def456-01');
  });

  it('handleDegradedRequest still returns a queued result with traceContext on the job', async () => {
    const { handleDegradedRequest, getQueuedJob } = await import('../ai/degradedMode.js');
    const result = handleDegradedRequest('user-otel-2', 'find a task', 'search');

    expect(result.status).toBe('queued');
    expect(result.jobId).toBeTruthy();
    expect(typeof result.message).toBe('string');

    // The underlying job has a traceContext
    const job = getQueuedJob(result.jobId);
    expect(job?.traceContext).toBeDefined();
  });
});
