/**
 * service-incident-diagnosis.test.ts
 *
 * Targets uncovered branches in backend/src/services/IncidentDiagnosisService.ts
 * (47 uncovered lines, 29.9% covered). Focuses on:
 * - IncidentDiagnosisService.diagnoseIncident (object method, uses db.query not db.readQuery)
 * - IncidentDiagnosisService.buildDiagnosisPrompt (pure helper)
 * - IncidentDiagnosisService.parseAIDiagnosis (JSON parse + fallback)
 * - IncidentDiagnosisService.ruleBasedDiagnosis (all heuristic branches)
 * - IncidentDiagnosisService.getRecentCommits / getRecentDeployments (returns mocks)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks (BEFORE imports) ──────────────────────────────────────────────────

vi.mock('../../src/db', () => ({
  db: {
    query: vi.fn(),
    readQuery: vi.fn(),
  },
}));

vi.mock('../../src/services/AIClient', () => ({
  AIClient: {
    isConfigured: vi.fn(() => false),
    call: vi.fn(),
    callJSON: vi.fn(),
  },
}));

// ── Imports ─────────────────────────────────────────────────────────────────

import { IncidentDiagnosisService } from '../../src/services/IncidentDiagnosisService';
import { db } from '../../src/db';

const mockQuery = vi.mocked(db.query);
const mockReadQuery = vi.mocked(db.readQuery);

function makeIncident(overrides: Partial<{
  event_type: string;
  severity: string;
  service: string;
  details: Record<string, unknown>;
  created_at: Date;
}> = {}) {
  return {
    event_type: 'error_spike',
    severity: 'high',
    service: 'payment-service',
    details: { errorRate: 0.15 },
    created_at: new Date('2026-01-10T08:00:00Z'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: db.query for UPDATE always succeeds
  mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
});

// ============================================================================
// IncidentDiagnosisService.diagnoseIncident (object method)
// ============================================================================

describe('IncidentDiagnosisService.diagnoseIncident', () => {
  it('returns error when incident not found (rowCount = 0)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const result = await IncidentDiagnosisService.diagnoseIncident('inc-1');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('HX600');
      expect(result.error.message).toMatch(/not found/i);
    }
  });

  it('returns error on db exception', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB timeout'));

    const result = await IncidentDiagnosisService.diagnoseIncident('inc-1');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('HX600');
    }
  });

  it('succeeds with rule-based diagnosis when AI not configured (error_spike + deployments)', async () => {
    const incident = makeIncident({ event_type: 'error_spike' });
    // Fetch incident
    mockQuery.mockResolvedValueOnce({ rows: [incident], rowCount: 1 });
    // UPDATE diagnosis
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const result = await IncidentDiagnosisService.diagnoseIncident('inc-1');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.incidentId).toBe('inc-1');
      // error_spike + recent deployments → confidence 70
      expect(result.data.confidence).toBe(70);
      expect(result.data.rootCause).toMatch(/deployment/i);
    }
  });

  it('succeeds with latency_spike rule-based diagnosis', async () => {
    const incident = makeIncident({ event_type: 'latency_spike' });
    mockQuery.mockResolvedValueOnce({ rows: [incident], rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const result = await IncidentDiagnosisService.diagnoseIncident('inc-1');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.confidence).toBe(50);
      expect(result.data.rootCause).toMatch(/performance/i);
    }
  });

  it('succeeds with budget_threshold rule-based diagnosis', async () => {
    const incident = makeIncident({ event_type: 'budget_threshold' });
    mockQuery.mockResolvedValueOnce({ rows: [incident], rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const result = await IncidentDiagnosisService.diagnoseIncident('inc-1');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.confidence).toBe(90);
      expect(result.data.rootCause).toMatch(/budget/i);
    }
  });

  it('succeeds with circuit_breaker_open rule-based diagnosis', async () => {
    const incident = makeIncident({ event_type: 'circuit_breaker_open' });
    mockQuery.mockResolvedValueOnce({ rows: [incident], rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const result = await IncidentDiagnosisService.diagnoseIncident('inc-1');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.confidence).toBe(60);
      expect(result.data.rootCause).toMatch(/circuit breaker/i);
    }
  });

  it('uses fallback diagnosis for unknown event type', async () => {
    const incident = makeIncident({ event_type: 'weird_unknown_event' });
    mockQuery.mockResolvedValueOnce({ rows: [incident], rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const result = await IncidentDiagnosisService.diagnoseIncident('inc-1');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.confidence).toBe(40);
      expect(result.data.rootCause).toBe('Unknown');
    }
  });

  it('saves diagnosis to database', async () => {
    const incident = makeIncident({ event_type: 'latency_spike' });
    mockQuery.mockResolvedValueOnce({ rows: [incident], rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await IncidentDiagnosisService.diagnoseIncident('inc-save');

    expect(mockQuery).toHaveBeenCalledWith(
      'UPDATE incident_events SET diagnosis = $1 WHERE id = $2',
      expect.arrayContaining(['inc-save'])
    );
  });

  it('diagnosis includes relatedCommits and relatedDeployments from mocks', async () => {
    const incident = makeIncident({ event_type: 'error_spike' });
    mockQuery.mockResolvedValueOnce({ rows: [incident], rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const result = await IncidentDiagnosisService.diagnoseIncident('inc-commits');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Array.isArray(result.data.relatedCommits)).toBe(true);
      expect(Array.isArray(result.data.relatedDeployments)).toBe(true);
    }
  });
});

// ============================================================================
// IncidentDiagnosisService.buildDiagnosisPrompt (pure helper)
// ============================================================================

describe('IncidentDiagnosisService.buildDiagnosisPrompt', () => {
  it('includes incident type, severity, and service', () => {
    const incident = makeIncident({ event_type: 'error_spike', severity: 'critical', service: 'stripe' });
    const prompt = IncidentDiagnosisService.buildDiagnosisPrompt(
      incident,
      ['commit-abc Fix auth bug'],
      ['Deploy #999 - 1h ago - SUCCESS']
    );

    expect(prompt).toContain('error_spike');
    expect(prompt).toContain('critical');
    expect(prompt).toContain('stripe');
  });

  it('shows "None" when no commits', () => {
    const incident = makeIncident();
    const prompt = IncidentDiagnosisService.buildDiagnosisPrompt(incident, [], []);

    expect(prompt).toContain('None');
  });

  it('includes commit and deployment lists', () => {
    const incident = makeIncident();
    const prompt = IncidentDiagnosisService.buildDiagnosisPrompt(
      incident,
      ['abc Fix XP service'],
      ['Deploy #42 - 30 min ago']
    );

    expect(prompt).toContain('abc Fix XP service');
    expect(prompt).toContain('Deploy #42');
  });

  it('formats incident details as JSON', () => {
    const incident = makeIncident({ details: { errorRate: 0.25, endpoint: '/api/pay' } });
    const prompt = IncidentDiagnosisService.buildDiagnosisPrompt(incident, [], []);

    expect(prompt).toContain('errorRate');
    expect(prompt).toContain('0.25');
  });
});

// ============================================================================
// IncidentDiagnosisService.parseAIDiagnosis
// ============================================================================

describe('IncidentDiagnosisService.parseAIDiagnosis', () => {
  it('parses valid JSON from AI response', () => {
    const aiResponse = JSON.stringify({
      rootCause: 'Deployment regression in payment-service',
      relatedCommits: ['abc123'],
      relatedDeployments: ['Deploy #50'],
      suggestedFix: 'Rollback to previous version',
      confidence: 85,
      reasoning: 'Error spike coincides with Deploy #50',
    });

    const result = IncidentDiagnosisService.parseAIDiagnosis('inc-1', aiResponse);

    expect(result.incidentId).toBe('inc-1');
    expect(result.confidence).toBe(85);
    expect(result.rootCause).toBe('Deployment regression in payment-service');
    expect(result.relatedCommits).toEqual(['abc123']);
    expect(result.suggestedFix).toBe('Rollback to previous version');
    expect(result.reasoning).toBe('Error spike coincides with Deploy #50');
  });

  it('extracts JSON embedded in surrounding text', () => {
    const aiResponse = `Analysis complete. Here is the diagnosis:
{
  "rootCause": "Database connection pool exhausted",
  "relatedCommits": [],
  "relatedDeployments": [],
  "suggestedFix": "Increase pool size",
  "confidence": 70,
  "reasoning": "High query volume"
}
End of analysis.`;

    const result = IncidentDiagnosisService.parseAIDiagnosis('inc-2', aiResponse);
    expect(result.confidence).toBe(70);
    expect(result.rootCause).toBe('Database connection pool exhausted');
  });

  it('uses default values when JSON fields are missing', () => {
    const aiResponse = JSON.stringify({
      rootCause: 'Something happened',
      // missing confidence, relatedCommits, suggestedFix, reasoning
    });

    const result = IncidentDiagnosisService.parseAIDiagnosis('inc-3', aiResponse);
    expect(result.confidence).toBe(50);
    expect(result.relatedCommits).toEqual([]);
    expect(result.relatedDeployments).toEqual([]);
    expect(result.suggestedFix).toBe('Manual investigation required');
  });

  it('falls back to raw response when no JSON found', () => {
    const rawText = 'The system is experiencing issues. Please check logs manually.';

    const result = IncidentDiagnosisService.parseAIDiagnosis('inc-4', rawText);
    expect(result.incidentId).toBe('inc-4');
    expect(result.confidence).toBe(30);
    expect(result.rootCause).toBe('Unable to determine from AI response');
    expect(result.reasoning).toBe(rawText);
  });

  it('falls back gracefully when JSON.parse throws', () => {
    // Contains { and } but malformed JSON
    const brokenJson = '{ rootCause: invalid json here }';

    const result = IncidentDiagnosisService.parseAIDiagnosis('inc-5', brokenJson);
    expect(result.confidence).toBe(30);
    expect(result.rootCause).toBe('Unable to determine from AI response');
  });
});

// ============================================================================
// IncidentDiagnosisService.ruleBasedDiagnosis
// ============================================================================

describe('IncidentDiagnosisService.ruleBasedDiagnosis', () => {
  const baseIncident = makeIncident();

  it('error_spike with deployments → confidence 70', () => {
    const result = IncidentDiagnosisService.ruleBasedDiagnosis(
      'inc-1',
      { ...baseIncident, event_type: 'error_spike' },
      ['commit-a'],
      ['Deploy #5']
    );
    expect(result.confidence).toBe(70);
    expect(result.rootCause).toMatch(/deployment/i);
    expect(result.suggestedFix).toMatch(/rollback/i);
  });

  it('error_spike without deployments → confidence 40 (unknown)', () => {
    const result = IncidentDiagnosisService.ruleBasedDiagnosis(
      'inc-1',
      { ...baseIncident, event_type: 'error_spike' },
      ['commit-a'],
      [] // no deployments
    );
    expect(result.confidence).toBe(40);
    expect(result.rootCause).toBe('Unknown');
  });

  it('latency_spike → performance degradation', () => {
    const result = IncidentDiagnosisService.ruleBasedDiagnosis(
      'inc-1',
      { ...baseIncident, event_type: 'latency_spike' },
      [],
      []
    );
    expect(result.confidence).toBe(50);
    expect(result.rootCause).toMatch(/performance/i);
    expect(result.suggestedFix).toMatch(/database/i);
  });

  it('budget_threshold → AI budget exceeded', () => {
    const result = IncidentDiagnosisService.ruleBasedDiagnosis(
      'inc-1',
      { ...baseIncident, event_type: 'budget_threshold' },
      [],
      []
    );
    expect(result.confidence).toBe(90);
    expect(result.rootCause).toMatch(/budget/i);
  });

  it('circuit_breaker_open → circuit breaker diagnosis', () => {
    const result = IncidentDiagnosisService.ruleBasedDiagnosis(
      'inc-1',
      { ...baseIncident, event_type: 'circuit_breaker_open' },
      [],
      []
    );
    expect(result.confidence).toBe(60);
    expect(result.rootCause).toMatch(/circuit breaker/i);
    expect(result.suggestedFix).toMatch(/downstream/i);
  });

  it('unknown event type → generic 40 confidence', () => {
    const result = IncidentDiagnosisService.ruleBasedDiagnosis(
      'inc-1',
      { ...baseIncident, event_type: 'totally_unknown' },
      [],
      []
    );
    expect(result.confidence).toBe(40);
    expect(result.rootCause).toBe('Unknown');
    expect(result.reasoning).toMatch(/rule-based/i);
  });

  it('slices commits to max 5 and deployments to max 3', () => {
    const commits = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'];
    const deploys = ['d1', 'd2', 'd3', 'd4', 'd5'];

    const result = IncidentDiagnosisService.ruleBasedDiagnosis(
      'inc-1',
      { ...baseIncident, event_type: 'unknown' },
      commits,
      deploys
    );
    expect(result.relatedCommits).toHaveLength(5);
    expect(result.relatedDeployments).toHaveLength(3);
  });

  it('returns reasoning indicating rule-based method', () => {
    const result = IncidentDiagnosisService.ruleBasedDiagnosis(
      'inc-r',
      baseIncident,
      [],
      []
    );
    expect(result.reasoning).toMatch(/rule-based/i);
  });
});

// ============================================================================
// IncidentDiagnosisService.getRecentCommits / getRecentDeployments
// ============================================================================

describe('IncidentDiagnosisService.getRecentCommits / getRecentDeployments', () => {
  it('getRecentCommits returns an array of strings', async () => {
    const commits = await IncidentDiagnosisService.getRecentCommits();
    expect(Array.isArray(commits)).toBe(true);
    commits.forEach((c) => expect(typeof c).toBe('string'));
  });

  it('getRecentDeployments returns an array of strings', async () => {
    const deploys = await IncidentDiagnosisService.getRecentDeployments();
    expect(Array.isArray(deploys)).toBe(true);
    deploys.forEach((d) => expect(typeof d).toBe('string'));
  });
});
