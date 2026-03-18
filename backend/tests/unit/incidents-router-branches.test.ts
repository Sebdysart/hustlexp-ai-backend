/**
 * Incidents router branch coverage tests
 *
 * Targets the 14 uncovered branches:
 * - incidents.get: found vs not found
 * - incidents.resolve: found vs not found, notes param present/absent
 * - incidents.diagnose: success vs failure, error message fallback
 * - incidents.stats: 24h vs 7d vs 30d interval mapping
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db', () => ({
  db: { query: vi.fn() },
}));

vi.mock('../../src/auth/firebase', () => ({
  firebaseAuth: { verifyIdToken: vi.fn() },
}));

vi.mock('../../src/logger', () => ({
  logger: {
    child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(),
  },
  escrowLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('../../src/services/IncidentDiagnosisService', () => ({
  IncidentDiagnosisService: { diagnoseIncident: vi.fn() },
}));

import { db } from '../../src/db';
import { IncidentDiagnosisService } from '../../src/services/IncidentDiagnosisService';
import incidentsRouter from '../../src/routers/incidents';

const mockDb = vi.mocked(db);
const mockDiagnosis = vi.mocked(IncidentDiagnosisService);

function makeCaller(userId = 'admin-1') {
  return incidentsRouter.createCaller({
    user: {
      id: userId, email: 'a@b.com', full_name: 'Admin',
      role: 'admin', trust_tier: 5, firebase_uid: 'fb-admin',
    } as any,
    firebaseUid: 'fb-admin',
  });
}

function seedAdminCheck() {
  mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);
}

beforeEach(() => { vi.clearAllMocks(); seedAdminCheck(); });

describe('incidents.get', () => {
  it('returns incident when found', async () => {
    const incident = { id: '550e8400-e29b-41d4-a716-446655440000', event_type: 'error_spike' };
    mockDb.query.mockResolvedValueOnce({ rows: [incident], rowCount: 1 } as any);

    const result = await makeCaller().get({ id: '550e8400-e29b-41d4-a716-446655440000' });
    expect(result.id).toBe('550e8400-e29b-41d4-a716-446655440000');
  });

  it('throws when incident not found', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await expect(
      makeCaller().get({ id: '550e8400-e29b-41d4-a716-446655440000' }),
    ).rejects.toThrow('Incident not found');
  });
});

describe('incidents.resolve', () => {
  it('resolves incident with notes', async () => {
    const resolved = { id: '550e8400-e29b-41d4-a716-446655440000', resolved_at: new Date() };
    mockDb.query.mockResolvedValueOnce({ rows: [resolved], rowCount: 1 } as any);

    const result = await makeCaller().resolve({
      id: '550e8400-e29b-41d4-a716-446655440000',
      notes: 'Fixed by restarting',
    });
    expect(result.resolved_at).toBeDefined();
  });

  it('resolves incident without notes (uses default "Resolved")', async () => {
    const resolved = { id: '550e8400-e29b-41d4-a716-446655440000', resolved_at: new Date() };
    mockDb.query.mockResolvedValueOnce({ rows: [resolved], rowCount: 1 } as any);

    const result = await makeCaller().resolve({
      id: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(result.resolved_at).toBeDefined();

    // Check that the default 'Resolved' was used in the query
    // calls[0] = isAdmin admin_roles check; calls[1] = the UPDATE query
    const [, params] = mockDb.query.mock.calls[1];
    expect(JSON.parse(params![1] as string)).toBe('Resolved');
  });

  it('throws when incident not found', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await expect(
      makeCaller().resolve({ id: '550e8400-e29b-41d4-a716-446655440000' }),
    ).rejects.toThrow('Incident not found');
  });
});

describe('incidents.diagnose', () => {
  it('returns diagnosis data on success', async () => {
    const diagnosisData = { summary: 'Error spike in auth', recommendations: [] };
    mockDiagnosis.diagnoseIncident.mockResolvedValueOnce({
      success: true,
      data: diagnosisData,
    } as any);

    const result = await makeCaller().diagnose({
      id: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(result.summary).toBe('Error spike in auth');
  });

  it('throws with error message on failure', async () => {
    mockDiagnosis.diagnoseIncident.mockResolvedValueOnce({
      success: false,
      error: { message: 'AI unavailable' },
    } as any);

    await expect(
      makeCaller().diagnose({ id: '550e8400-e29b-41d4-a716-446655440000' }),
    ).rejects.toThrow('AI unavailable');
  });

  it('throws "Diagnosis failed" when error message is missing', async () => {
    mockDiagnosis.diagnoseIncident.mockResolvedValueOnce({
      success: false,
      error: {},
    } as any);

    await expect(
      makeCaller().diagnose({ id: '550e8400-e29b-41d4-a716-446655440000' }),
    ).rejects.toThrow('Diagnosis failed');
  });
});

describe('incidents.stats', () => {
  it('maps 24h to 1 day interval', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ total: '5', critical_count: '1', warning_count: '2', info_count: '2', resolved_count: '3', avg_resolution_time_seconds: 120 }],
      rowCount: 1,
    } as any);

    const result = await makeCaller().stats({ timeRange: '24h' });
    expect(result.total).toBe('5');

    // calls[0] = isAdmin admin_roles check; calls[1] = the stats SELECT query
    const [, params] = mockDb.query.mock.calls[1];
    expect(params![0]).toBe('1 day');
  });

  it('maps 7d to 7 days interval', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ total: '10' }], rowCount: 1,
    } as any);

    await makeCaller().stats({ timeRange: '7d' });

    const [, params] = mockDb.query.mock.calls[1];
    expect(params![0]).toBe('7 days');
  });

  it('maps 30d to 30 days interval', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ total: '20' }], rowCount: 1,
    } as any);

    await makeCaller().stats({ timeRange: '30d' });

    const [, params] = mockDb.query.mock.calls[1];
    expect(params![0]).toBe('30 days');
  });

  it('uses default 24h when not provided', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ total: '3' }], rowCount: 1,
    } as any);

    await makeCaller().stats({});

    const [, params] = mockDb.query.mock.calls[1];
    expect(params![0]).toBe('1 day');
  });
});
