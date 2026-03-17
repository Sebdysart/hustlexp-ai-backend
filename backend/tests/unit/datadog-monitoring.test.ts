import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Must mock setInterval before module loads (datadog.ts has module-level setInterval)
vi.useFakeTimers();

vi.mock('../../src/config', () => ({
  config: {
    datadog: {
      enabled: true,
      agentHost: 'localhost',
      agentPort: 8125,
    },
    app: { env: 'test' },
  },
}));

vi.mock('../../src/logger', () => ({
  logger: {
    child: () => ({
      warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(),
    }),
    warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(),
  },
}));

// Track calls through a global array that survives hoisting
const _calls: { method: string; args: unknown[] }[] = [];

vi.mock('node-statsd', () => ({
  StatsD: class MockStatsD {
    increment(...args: unknown[]) { _calls.push({ method: 'increment', args }); }
    timing(...args: unknown[]) { _calls.push({ method: 'timing', args }); }
    gauge(...args: unknown[]) { _calls.push({ method: 'gauge', args }); }
    histogram(...args: unknown[]) { _calls.push({ method: 'histogram', args }); }
    on() {}
    close(cb: () => void) { _calls.push({ method: 'close', args: [] }); cb(); }
  },
}));

import {
  increment,
  timing,
  gauge,
  histogram,
  trackTaskCreated,
  taskCompleted,
  trackPayment,
  trackAIRequest,
  trackDisputeCreated,
  trackUserSignup,
  trackApiError,
  trackDatabaseQuery,
  trackExternalCall,
  trackCacheHit,
  flushMetrics,
  getStatsD,
  reportSystemMetrics,
} from '../../src/monitoring/datadog';

describe('Datadog Monitoring', () => {
  beforeEach(() => {
    _calls.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ===========================================================================
  // getStatsD
  // ===========================================================================
  describe('getStatsD', () => {
    it('returns a StatsD client when enabled', () => {
      const client = getStatsD();
      expect(client).toBeDefined();
      expect(client).not.toBeNull();
    });
  });

  // ===========================================================================
  // Core Metrics
  // ===========================================================================
  describe('increment', () => {
    it('calls statsd increment', () => {
      increment('test.counter');
      expect(_calls.some(c => c.method === 'increment')).toBe(true);
    });

    it('passes tags as array', () => {
      increment('test.counter', { env: 'prod', service: 'api' });
      const call = _calls.find(c => c.method === 'increment');
      expect(call).toBeDefined();
      expect(call!.args[0]).toBe('test.counter');
      expect(call!.args[3]).toEqual(['env:prod', 'service:api']);
    });

    it('supports custom value', () => {
      increment('test.counter', undefined, 5);
      const call = _calls.find(c => c.method === 'increment');
      expect(call!.args[1]).toBe(5);
    });
  });

  describe('timing', () => {
    it('records timing metric', () => {
      timing('test.duration', 150);
      expect(_calls.some(c => c.method === 'timing')).toBe(true);
    });

    it('passes tags', () => {
      timing('test.duration', 200, { operation: 'read' });
      const call = _calls.find(c => c.method === 'timing');
      expect(call!.args[3]).toEqual(['operation:read']);
    });
  });

  describe('gauge', () => {
    it('records gauge metric', () => {
      gauge('test.gauge', 42);
      expect(_calls.some(c => c.method === 'gauge')).toBe(true);
    });
  });

  describe('histogram', () => {
    it('records histogram metric', () => {
      histogram('test.histogram', 99);
      expect(_calls.some(c => c.method === 'histogram')).toBe(true);
    });
  });

  // ===========================================================================
  // Business Metrics
  // ===========================================================================
  describe('trackTaskCreated', () => {
    it('increments counter and records histogram', () => {
      trackTaskCreated('cleaning', 5000);
      expect(_calls.filter(c => c.method === 'increment').length).toBeGreaterThanOrEqual(1);
      expect(_calls.filter(c => c.method === 'histogram').length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('taskCompleted', () => {
    it('records timing and increments counter', () => {
      taskCompleted(3600000, 'delivery');
      expect(_calls.some(c => c.method === 'timing')).toBe(true);
      expect(_calls.some(c => c.method === 'increment')).toBe(true);
    });
  });

  describe('trackPayment', () => {
    it('tracks escrow payment', () => {
      trackPayment(10000, 'escrow');
      expect(_calls.some(c => c.method === 'increment')).toBe(true);
      expect(_calls.some(c => c.method === 'histogram')).toBe(true);
    });

    it('tracks different payment types', () => {
      trackPayment(8500, 'payout');
      expect(_calls.some(c => c.method === 'increment')).toBe(true);
    });
  });

  describe('trackAIRequest', () => {
    it('tracks all AI metrics', () => {
      trackAIRequest('matchmaker', 'openai', 1500, 200, 5);
      expect(_calls.filter(c => c.method === 'increment').length).toBeGreaterThanOrEqual(1);
      expect(_calls.filter(c => c.method === 'timing').length).toBeGreaterThanOrEqual(1);
      expect(_calls.filter(c => c.method === 'histogram').length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('trackDisputeCreated', () => {
    it('increments disputes counter', () => {
      trackDisputeCreated('quality');
      expect(_calls.some(c => c.method === 'increment')).toBe(true);
    });
  });

  describe('trackUserSignup', () => {
    it('increments signup counter', () => {
      trackUserSignup('organic');
      expect(_calls.some(c => c.method === 'increment')).toBe(true);
    });
  });

  describe('trackApiError', () => {
    it('increments error counter', () => {
      trackApiError('/api/tasks', '500');
      expect(_calls.some(c => c.method === 'increment')).toBe(true);
    });
  });

  // ===========================================================================
  // Performance Tracking
  // ===========================================================================
  describe('trackDatabaseQuery', () => {
    it('records query timing', () => {
      trackDatabaseQuery('SELECT', 'tasks', 15);
      expect(_calls.some(c => c.method === 'timing')).toBe(true);
    });
  });

  describe('trackExternalCall', () => {
    it('records success timing without error increment', () => {
      trackExternalCall('stripe', 'create_payment', 500, true);
      expect(_calls.some(c => c.method === 'timing')).toBe(true);
      // Should NOT increment error counter on success
      const incrementCalls = _calls.filter(c => c.method === 'increment');
      expect(incrementCalls.length).toBe(0);
    });

    it('records failure timing with error increment', () => {
      trackExternalCall('stripe', 'create_payment', 500, false);
      expect(_calls.some(c => c.method === 'timing')).toBe(true);
      expect(_calls.some(c => c.method === 'increment')).toBe(true);
    });
  });

  describe('trackCacheHit', () => {
    it('tracks cache hit', () => {
      trackCacheHit('hit', 'user:profile:123');
      expect(_calls.some(c => c.method === 'increment')).toBe(true);
    });

    it('tracks cache miss', () => {
      trackCacheHit('miss', 'task:feed:456');
      expect(_calls.some(c => c.method === 'increment')).toBe(true);
    });
  });

  // ===========================================================================
  // System Metrics
  // ===========================================================================
  describe('reportSystemMetrics', () => {
    it('records heap_used, heap_total, rss, cpu.user, cpu.system gauges', () => {
      reportSystemMetrics();
      const gaugeCalls = _calls.filter(c => c.method === 'gauge');
      const metricNames = gaugeCalls.map(c => c.args[0] as string);
      expect(metricNames).toContain('system.memory.heap_used');
      expect(metricNames).toContain('system.memory.heap_total');
      expect(metricNames).toContain('system.memory.rss');
      expect(metricNames).toContain('system.cpu.user');
      expect(metricNames).toContain('system.cpu.system');
    });
  });

  // ===========================================================================
  // Shutdown
  // ===========================================================================
  describe('flushMetrics', () => {
    it('closes statsd client', async () => {
      await flushMetrics();
      expect(_calls.some(c => c.method === 'close')).toBe(true);
    });
  });
});
