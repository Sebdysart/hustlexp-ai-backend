/**
 * AnomalyDetectionService Unit Tests
 *
 * Tests all threshold-based detection methods and recordAnomaly persistence.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  checkErrorRateSpike,
  checkLatencySpike,
  checkCircuitBreakerOpen,
  checkBudgetExhaustion,
  recordAnomaly,
} from '../../src/services/AnomalyDetectionService';

// Mock dependencies
vi.mock('../../src/db', () => ({
  db: {
    query: vi.fn(),
    readQuery: vi.fn(),
  },
}));

vi.mock('../../src/logger', () => ({
  aiLogger: {
    child: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })),
  },
}));

import { db } from '../../src/db';

const mockQuery = vi.mocked(db.query);

beforeEach(() => {
  vi.clearAllMocks();
});

// ============================================================================
// checkErrorRateSpike
// ============================================================================
describe('checkErrorRateSpike', () => {
  it('detects anomaly when current > 2x baseline', () => {
    const result = checkErrorRateSpike(5.0, 2.0); // 2.5x
    expect(result.detected).toBe(true);
    expect(result.eventType).toBe('error_spike');
    expect(result.severity).toBe('warning');
    expect(result.details).toHaveProperty('ratio');
  });

  it('returns not detected when current < 2x baseline', () => {
    const result = checkErrorRateSpike(3.0, 2.0); // 1.5x
    expect(result.detected).toBe(false);
    expect(result.eventType).toBe('error_spike');
  });

  it('returns not detected when baseline is 0 (avoids division by zero)', () => {
    const result = checkErrorRateSpike(5.0, 0);
    expect(result.detected).toBe(false);
  });

  it('returns critical severity when ratio > 5x', () => {
    const result = checkErrorRateSpike(12.0, 2.0); // 6x
    expect(result.detected).toBe(true);
    expect(result.severity).toBe('critical');
  });

  it('returns not detected when baseline is negative', () => {
    const result = checkErrorRateSpike(5.0, -1);
    expect(result.detected).toBe(false);
  });
});

// ============================================================================
// checkLatencySpike
// ============================================================================
describe('checkLatencySpike', () => {
  it('detects anomaly when P95 > 2x baseline', () => {
    const result = checkLatencySpike(1000, 400); // 2.5x
    expect(result.detected).toBe(true);
    expect(result.eventType).toBe('latency_spike');
    expect(result.severity).toBe('warning');
  });

  it('returns not detected when P95 < 2x baseline', () => {
    const result = checkLatencySpike(600, 400); // 1.5x
    expect(result.detected).toBe(false);
  });

  it('returns not detected when baseline is 0', () => {
    const result = checkLatencySpike(1000, 0);
    expect(result.detected).toBe(false);
  });

  it('returns critical when ratio > 5x', () => {
    const result = checkLatencySpike(3000, 400); // 7.5x
    expect(result.detected).toBe(true);
    expect(result.severity).toBe('critical');
  });
});

// ============================================================================
// checkCircuitBreakerOpen
// ============================================================================
describe('checkCircuitBreakerOpen', () => {
  it('detects critical anomaly when state is OPEN', () => {
    const result = checkCircuitBreakerOpen('openai', 'OPEN');
    expect(result.detected).toBe(true);
    expect(result.eventType).toBe('circuit_open');
    expect(result.severity).toBe('critical');
    expect(result.service).toBe('openai');
  });

  it('returns not detected when state is CLOSED', () => {
    const result = checkCircuitBreakerOpen('openai', 'CLOSED');
    expect(result.detected).toBe(false);
  });

  it('returns not detected when state is HALF_OPEN', () => {
    const result = checkCircuitBreakerOpen('openai', 'HALF_OPEN');
    expect(result.detected).toBe(false);
  });
});

// ============================================================================
// checkBudgetExhaustion
// ============================================================================
describe('checkBudgetExhaustion', () => {
  it('detects warning when spend > 80% of budget', () => {
    const result = checkBudgetExhaustion(85, 100); // 85%
    expect(result.detected).toBe(true);
    expect(result.eventType).toBe('budget_alert');
    expect(result.severity).toBe('warning');
  });

  it('detects critical when spend > 95% of budget', () => {
    const result = checkBudgetExhaustion(96, 100); // 96%
    expect(result.detected).toBe(true);
    expect(result.severity).toBe('critical');
  });

  it('returns not detected when spend < 80% of budget', () => {
    const result = checkBudgetExhaustion(50, 100); // 50%
    expect(result.detected).toBe(false);
  });

  it('returns not detected when budget is 0', () => {
    const result = checkBudgetExhaustion(50, 0);
    expect(result.detected).toBe(false);
  });
});

// ============================================================================
// recordAnomaly
// ============================================================================
describe('recordAnomaly', () => {
  it('inserts anomaly into incident_events and returns id', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'test-uuid-123' }],
      rowCount: 1,
    });

    const anomaly = checkCircuitBreakerOpen('openai', 'OPEN');
    const result = await recordAnomaly(anomaly);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe('test-uuid-123');
    }

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO incident_events'),
      expect.arrayContaining(['circuit_open', 'critical', 'openai'])
    );
  });

  it('returns error on DB failure', async () => {
    mockQuery.mockRejectedValueOnce(new Error('Connection refused'));

    const anomaly = checkErrorRateSpike(10, 2);
    const result = await recordAnomaly(anomaly);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('RECORD_ANOMALY_FAILED');
    }
  });
});
