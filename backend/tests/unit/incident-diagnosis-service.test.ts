/**
 * IncidentDiagnosisService Unit Tests
 *
 * Tests rule-based diagnosis, DB persistence, and error handling.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { diagnoseIncident } from '../../src/services/IncidentDiagnosisService';

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

vi.mock('../../src/services/AIClient', () => ({
  AIClient: {
    isConfigured: vi.fn(() => false),
    call: vi.fn(),
    callJSON: vi.fn(),
  },
}));

import { db } from '../../src/db';

const mockQuery = vi.mocked(db.query);
const mockReadQuery = vi.mocked(db.readQuery);

const makeIncidentRow = (overrides: Partial<{
  id: string; event_type: string; severity: string; service: string;
  details: Record<string, unknown>; diagnosis: null; resolved_at: null; created_at: string;
}> = {}) => ({
  id: 'incident-1',
  event_type: 'circuit_open',
  severity: 'critical',
  service: 'openai',
  details: { state: 'OPEN' },
  diagnosis: null,
  resolved_at: null,
  created_at: '2026-02-22T10:00:00Z',
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
});

// ============================================================================
// Rule-based diagnosis
// ============================================================================
describe('diagnoseIncident — rule-based', () => {
  function setupMocks(eventType: string, service = 'openai') {
    // Fetch incident
    mockReadQuery.mockResolvedValueOnce({
      rows: [makeIncidentRow({ event_type: eventType, service })],
      rowCount: 1,
    });
    // Correlated events
    mockReadQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // Recent incidents for AI context
    mockReadQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // Store diagnosis
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
  }

  it('diagnoses circuit_open with correct root cause', async () => {
    setupMocks('circuit_open', 'openai');
    const result = await diagnoseIncident('incident-1');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.incidentId).toBe('incident-1');
      expect(result.data.rootCause).toContain('Circuit breaker opened');
      expect(result.data.rootCause).toContain('openai');
      expect(result.data.diagnosisMethod).toBe('rule_based');
      expect(result.data.confidence).toBeGreaterThan(0);
    }
  });

  it('diagnoses error_spike with correct root cause', async () => {
    setupMocks('error_spike');
    const result = await diagnoseIncident('incident-1');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.rootCause).toContain('Error rate spike');
      expect(result.data.suggestedAction).toContain('deployments');
    }
  });

  it('diagnoses latency_spike with correct root cause', async () => {
    setupMocks('latency_spike');
    const result = await diagnoseIncident('incident-1');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.rootCause).toContain('latency spike');
      expect(result.data.suggestedAction).toContain('database');
    }
  });

  it('diagnoses budget_alert with correct root cause', async () => {
    setupMocks('budget_alert');
    const result = await diagnoseIncident('incident-1');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.rootCause).toContain('budget');
      expect(result.data.suggestedAction).toContain('usage patterns');
    }
  });

  it('falls back to generic diagnosis for unknown event type', async () => {
    setupMocks('unknown_event_type');
    const result = await diagnoseIncident('incident-1');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.rootCause).toContain('Unknown incident type');
      expect(result.data.confidence).toBeLessThan(0.5);
      expect(result.data.diagnosisMethod).toBe('rule_based');
    }
  });
});

// ============================================================================
// Diagnosis stores result back to DB
// ============================================================================
describe('diagnoseIncident — persistence', () => {
  it('stores diagnosis JSON back to incident record', async () => {
    mockReadQuery.mockResolvedValueOnce({
      rows: [makeIncidentRow()],
      rowCount: 1,
    });
    mockReadQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    mockReadQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await diagnoseIncident('incident-1');

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE incident_events SET diagnosis'),
      expect.arrayContaining(['incident-1'])
    );
  });
});

// ============================================================================
// Error handling
// ============================================================================
describe('diagnoseIncident — error handling', () => {
  it('returns error when incident not found', async () => {
    mockReadQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const result = await diagnoseIncident('nonexistent-id');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('INCIDENT_NOT_FOUND');
    }
  });

  it('returns error on DB fetch failure', async () => {
    mockReadQuery.mockRejectedValueOnce(new Error('Connection timeout'));

    const result = await diagnoseIncident('incident-1');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('DIAGNOSIS_FAILED');
    }
  });
});

// ============================================================================
// Correlated events
// ============================================================================
describe('diagnoseIncident — correlated events', () => {
  it('includes correlated event IDs in diagnosis', async () => {
    mockReadQuery.mockResolvedValueOnce({
      rows: [makeIncidentRow()],
      rowCount: 1,
    });
    mockReadQuery.mockResolvedValueOnce({
      rows: [{ id: 'corr-1' }, { id: 'corr-2' }],
      rowCount: 2,
    });
    mockReadQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const result = await diagnoseIncident('incident-1');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.correlatedEvents).toEqual(['corr-1', 'corr-2']);
    }
  });
});
