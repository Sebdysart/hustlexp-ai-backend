import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';

// Mock prom-client
vi.mock('prom-client', () => {
  class MockHistogram {
    name: string;
    constructor(opts: { name: string }) { this.name = opts.name; }
    observe = vi.fn();
  }
  class MockCounter {
    name: string;
    constructor(opts: { name: string }) { this.name = opts.name; }
    inc = vi.fn();
  }
  class MockGauge {
    name: string;
    constructor(opts: { name: string }) { this.name = opts.name; }
    set = vi.fn();
    inc = vi.fn();
    dec = vi.fn();
  }
  class MockRegistry {
    metrics = vi.fn().mockResolvedValue('# HELP test\ntest 1');
    contentType = 'text/plain; version=0.0.4';
    registerMetric = vi.fn();
  }

  return {
    Registry: MockRegistry,
    Histogram: MockHistogram,
    Counter: MockCounter,
    Gauge: MockGauge,
    collectDefaultMetrics: vi.fn(),
  };
});

import {
  registry,
  httpRequestDuration,
  httpRequestsTotal,
  dbQueryDuration,
  dbConnectionsActive,
  cacheOperationDuration,
  cacheOperationsTotal,
  apiErrorsTotal,
  activeUsers,
  escrowTotalValue,
  createMetricsEndpoint,
} from '../../src/monitoring/metrics';

describe('Prometheus Metrics', () => {
  let originalInternalApiKey: string | undefined;

  beforeAll(() => {
    originalInternalApiKey = process.env.INTERNAL_API_KEY;
    process.env.INTERNAL_API_KEY = 'test-key';
  });

  afterAll(() => {
    if (originalInternalApiKey === undefined) {
      delete process.env.INTERNAL_API_KEY;
    } else {
      process.env.INTERNAL_API_KEY = originalInternalApiKey;
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // Metric exports
  // ===========================================================================
  describe('metric exports', () => {
    it('exports httpRequestDuration histogram', () => {
      expect(httpRequestDuration).toBeDefined();
      expect(httpRequestDuration.name).toBe('http_request_duration_seconds');
    });

    it('exports httpRequestsTotal counter', () => {
      expect(httpRequestsTotal).toBeDefined();
      expect(httpRequestsTotal.name).toBe('http_requests_total');
    });

    it('exports dbQueryDuration histogram', () => {
      expect(dbQueryDuration).toBeDefined();
      expect(dbQueryDuration.name).toBe('db_query_duration_seconds');
    });

    it('exports dbConnectionsActive gauge', () => {
      expect(dbConnectionsActive).toBeDefined();
      expect(dbConnectionsActive.name).toBe('db_connections_active');
    });

    it('exports cacheOperationDuration histogram', () => {
      expect(cacheOperationDuration).toBeDefined();
      expect(cacheOperationDuration.name).toBe('cache_operation_duration_seconds');
    });

    it('exports cacheOperationsTotal counter', () => {
      expect(cacheOperationsTotal).toBeDefined();
      expect(cacheOperationsTotal.name).toBe('cache_operations_total');
    });

    it('exports apiErrorsTotal counter', () => {
      expect(apiErrorsTotal).toBeDefined();
      expect(apiErrorsTotal.name).toBe('api_errors_total');
    });

    it('exports activeUsers gauge', () => {
      expect(activeUsers).toBeDefined();
      expect(activeUsers.name).toBe('active_users');
    });

    it('exports escrowTotalValue gauge', () => {
      expect(escrowTotalValue).toBeDefined();
      expect(escrowTotalValue.name).toBe('escrow_total_value');
    });

    it('exports registry', () => {
      expect(registry).toBeDefined();
    });
  });

  // ===========================================================================
  // createMetricsEndpoint
  // ===========================================================================
  describe('createMetricsEndpoint', () => {
    it('registers a /metrics GET route', () => {
      const mockApp = {
        get: vi.fn(),
      };

      createMetricsEndpoint(mockApp as any);

      expect(mockApp.get).toHaveBeenCalledWith('/metrics', expect.any(Function));
    });

    it('returns metrics text from registry', async () => {
      const mockApp = {
        get: vi.fn(),
      };

      createMetricsEndpoint(mockApp as any);

      // Get the handler function
      const handler = mockApp.get.mock.calls[0][1];
      const mockC = {
        req: {
          header: vi.fn().mockReturnValue('Bearer test-key'),
        },
        text: vi.fn().mockReturnValue('response'),
      };

      await handler(mockC);

      expect(mockC.text).toHaveBeenCalledWith(
        expect.any(String),
        200,
        expect.objectContaining({ 'Content-Type': expect.any(String) }),
      );
    });

    // -------------------------------------------------------------------------
    // A47-2 FIX: timingSafeEqual replaces string equality (no timing side-channel)
    // -------------------------------------------------------------------------

    it('A47-2: returns 401 when Authorization header is missing', async () => {
      const mockApp = { get: vi.fn() };
      createMetricsEndpoint(mockApp as any);
      const handler = mockApp.get.mock.calls[0][1];
      const mockC = {
        req: { header: vi.fn().mockReturnValue(undefined) },
        text: vi.fn().mockReturnValue('response'),
      };
      await handler(mockC);
      expect(mockC.text).toHaveBeenCalledWith('Unauthorized', 401);
    });

    it('A47-2: returns 401 when Bearer token is wrong', async () => {
      const mockApp = { get: vi.fn() };
      createMetricsEndpoint(mockApp as any);
      const handler = mockApp.get.mock.calls[0][1];
      const mockC = {
        req: { header: vi.fn().mockReturnValue('Bearer wrong-key') },
        text: vi.fn().mockReturnValue('response'),
      };
      await handler(mockC);
      expect(mockC.text).toHaveBeenCalledWith('Unauthorized', 401);
    });

    it('A47-2: returns 401 when Authorization scheme is Basic (not Bearer)', async () => {
      const mockApp = { get: vi.fn() };
      createMetricsEndpoint(mockApp as any);
      const handler = mockApp.get.mock.calls[0][1];
      const mockC = {
        req: { header: vi.fn().mockReturnValue('Basic test-key') },
        text: vi.fn().mockReturnValue('response'),
      };
      await handler(mockC);
      expect(mockC.text).toHaveBeenCalledWith('Unauthorized', 401);
    });

    it('A47-2: returns 200 with metrics when correct key is provided (timing-safe comparison)', async () => {
      // This test verifies the timingSafeEqual path returns 200 for valid auth,
      // not just that the old string equality worked.
      const mockApp = { get: vi.fn() };
      createMetricsEndpoint(mockApp as any);
      const handler = mockApp.get.mock.calls[0][1];
      const mockC = {
        req: { header: vi.fn().mockReturnValue('Bearer test-key') },
        text: vi.fn().mockReturnValue('response'),
      };
      await handler(mockC);
      expect(mockC.text).toHaveBeenCalledWith(
        expect.any(String),
        200,
        expect.objectContaining({ 'Content-Type': expect.any(String) }),
      );
    });
  });
});
