import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks (BEFORE imports) ──────────────────────────────────────────────────
vi.mock('../../src/db', () => ({
  db: { query: vi.fn() },
  isInvariantViolation: vi.fn(() => false),
  isUniqueViolation: vi.fn(() => false),
  getErrorMessage: vi.fn((code: string) => `Error ${code}`),
}));

vi.mock('../../src/logger', () => ({
  logger: {
    child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(),
  },
  escrowLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  aiLogger: {
    child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(),
  },
}));

// ── Imports ─────────────────────────────────────────────────────────────────
import { MovementTrackingService } from '../../src/services/MovementTrackingService';
import { db } from '../../src/db';

const mockQuery = db.query as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

const gpsPoint = { latitude: 47.6, longitude: -122.3, accuracy: 5, timestamp: new Date() };

// ═══════════════════════════════════════════════════════════════════════════
// startSession
// ═══════════════════════════════════════════════════════════════════════════
describe('MovementTrackingService.startSession', () => {
  it('creates a new movement session', async () => {
    const fakeSession = {
      id: 'mvmt-task-1-123',
      taskId: 'task-1',
      userId: 'user-1',
      startedAt: new Date(),
      gpsTrail: [gpsPoint],
      totalDistance: 0,
      averageSpeed: 0,
      status: 'active',
    };
    mockQuery.mockResolvedValueOnce({ rows: [fakeSession] });

    const result = await MovementTrackingService.startSession('task-1', 'user-1', gpsPoint);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe('active');
    }
  });

  it('handles DB error', async () => {
    mockQuery.mockRejectedValueOnce(new Error('insert failed'));

    const result = await MovementTrackingService.startSession('task-1', 'user-1', gpsPoint);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('SESSION_START_FAILED');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// updateLocation
// ═══════════════════════════════════════════════════════════════════════════
describe('MovementTrackingService.updateLocation', () => {
  it('updates session with new GPS point', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{
          id: 'session-1',
          gpsTrail: [gpsPoint],
          totalDistance: 0,
          averageSpeed: 0,
          startedAt: new Date(Date.now() - 60000),
          status: 'active',
        }],
      })
      .mockResolvedValueOnce({ rowCount: 1 }); // update

    const newPoint = { ...gpsPoint, latitude: 47.601 };
    const result = await MovementTrackingService.updateLocation({
      sessionId: 'session-1',
      location: newPoint,
    });
    expect(result.success).toBe(true);
  });

  it('returns error when session not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await MovementTrackingService.updateLocation({
      sessionId: 'missing',
      location: gpsPoint,
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('SESSION_NOT_FOUND');
  });

  it('handles DB error', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB error'));

    const result = await MovementTrackingService.updateLocation({
      sessionId: 'session-1',
      location: gpsPoint,
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('LOCATION_UPDATE_FAILED');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// stopSession
// ═══════════════════════════════════════════════════════════════════════════
describe('MovementTrackingService.stopSession', () => {
  it('stops an active session', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'session-1', status: 'completed', totalDistance: 500, endedAt: new Date() }],
    });

    const result = await MovementTrackingService.stopSession('session-1');
    expect(result.success).toBe(true);
  });

  it('returns error when session not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await MovementTrackingService.stopSession('missing');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('SESSION_NOT_FOUND');
  });

  it('handles DB error', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB error'));

    const result = await MovementTrackingService.stopSession('session-1');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('SESSION_STOP_FAILED');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// getSessionStats
// ═══════════════════════════════════════════════════════════════════════════
describe('MovementTrackingService.getSessionStats', () => {
  it('returns stats for a session', async () => {
    const now = Date.now();
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'session-1',
        totalDistance: 1000,
        averageSpeed: 2.5,
        status: 'completed',
        startedAt: new Date(now - 600000),
        endedAt: new Date(now),
        gpsTrail: [
          { latitude: 47.6, longitude: -122.3, accuracy: 5, timestamp: new Date(now - 600000) },
          { latitude: 47.601, longitude: -122.301, accuracy: 5, timestamp: new Date(now - 300000) },
        ],
      }],
    });

    const result = await MovementTrackingService.getSessionStats('session-1');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.totalDistance).toBe(1000);
      expect(result.data.duration).toBeGreaterThan(0);
    }
  });

  it('returns error when session not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await MovementTrackingService.getSessionStats('missing');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('SESSION_NOT_FOUND');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// _calculateDistance (pure function)
// ═══════════════════════════════════════════════════════════════════════════
describe('MovementTrackingService._calculateDistance', () => {
  it('returns 0 for same coordinates', () => {
    expect(MovementTrackingService._calculateDistance(47.6, -122.3, 47.6, -122.3)).toBe(0);
  });

  it('calculates distance between two points in meters', () => {
    // Seattle downtown to Space Needle (~1.5km)
    const distance = MovementTrackingService._calculateDistance(47.6062, -122.3321, 47.6205, -122.3493);
    expect(distance).toBeGreaterThan(500);
    expect(distance).toBeLessThan(5000);
  });

  it('handles large distances', () => {
    // Seattle to Portland (~280km)
    const distance = MovementTrackingService._calculateDistance(47.6, -122.3, 45.5, -122.6);
    expect(distance).toBeGreaterThan(200000);
    expect(distance).toBeLessThan(300000);
  });
});
