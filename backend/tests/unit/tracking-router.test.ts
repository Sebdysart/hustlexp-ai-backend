/**
 * Tracking Router Unit Tests
 *
 * Tests all tRPC procedures on the tracking router:
 * - startSession (protected, mutation)
 * - updateLocation (protected, mutation)
 * - stopSession (protected, mutation)
 * - getStats (protected, query)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

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

vi.mock('../../src/services/MovementTrackingService', () => ({
  MovementTrackingService: {
    startSession: vi.fn(),
    updateLocation: vi.fn(),
    stopSession: vi.fn(),
    getSessionStats: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { db } from '../../src/db';
import { trackingRouter } from '../../src/routers/tracking';
import { MovementTrackingService } from '../../src/services/MovementTrackingService';

const mockService = vi.mocked(MovementTrackingService);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCaller(authenticated = true) {
  const ctx: any = authenticated
    ? { user: { id: 'test-uid', default_mode: 'worker' }, firebaseUid: 'fb-uid' }
    : { user: null, firebaseUid: null };
  return trackingRouter.createCaller(ctx);
}

const validLocation = {
  latitude: 37.7749,
  longitude: -122.4194,
  accuracy: 10,
  timestamp: new Date('2026-01-01T00:00:00Z'),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const TASK_UUID = '00000000-0000-0000-0000-000000000001';
const SESSION_UUID = '00000000-0000-0000-0000-000000000002';

describe('tracking.startSession', () => {
  beforeEach(() => vi.clearAllMocks());

  it('starts a session and returns data', async () => {
    const sessionData = { sessionId: SESSION_UUID, startedAt: new Date().toISOString() };
    mockService.startSession.mockResolvedValueOnce({ success: true, data: sessionData } as any);

    const result = await makeCaller().startSession({
      taskId: TASK_UUID,
      initialLocation: validLocation,
    });

    expect(result).toEqual(sessionData);
    expect(mockService.startSession).toHaveBeenCalledWith(TASK_UUID, 'test-uid', validLocation);
  });

  it('throws when service returns failure', async () => {
    mockService.startSession.mockResolvedValueOnce({
      success: false,
      error: { message: 'Task not found' },
    } as any);

    await expect(
      makeCaller().startSession({ taskId: TASK_UUID, initialLocation: validLocation })
    ).rejects.toThrow('Task not found');
  });

  it('rejects unauthenticated users', async () => {
    await expect(
      makeCaller(false).startSession({ taskId: TASK_UUID, initialLocation: validLocation })
    ).rejects.toThrow();
  });
});

describe('tracking.updateLocation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('updates location and returns success', async () => {
    (db.query as any).mockResolvedValueOnce({ rows: [{ worker_id: 'test-uid' }], rowCount: 1 });
    mockService.updateLocation.mockResolvedValueOnce({ success: true } as any);

    const result = await makeCaller().updateLocation({
      sessionId: SESSION_UUID,
      location: validLocation,
    });

    expect(result).toEqual({ success: true });
    expect(mockService.updateLocation).toHaveBeenCalledWith({
      sessionId: SESSION_UUID,
      location: validLocation,
    });
  });

  it('throws when service returns failure', async () => {
    (db.query as any).mockResolvedValueOnce({ rows: [{ worker_id: 'test-uid' }], rowCount: 1 });
    mockService.updateLocation.mockResolvedValueOnce({
      success: false,
      error: { message: 'Session not found' },
    } as any);

    await expect(
      makeCaller().updateLocation({ sessionId: SESSION_UUID, location: validLocation })
    ).rejects.toThrow('Session not found');
  });
});

describe('tracking.stopSession', () => {
  beforeEach(() => vi.clearAllMocks());

  it('stops session and returns data', async () => {
    (db.query as any).mockResolvedValueOnce({ rows: [{ worker_id: 'test-uid' }], rowCount: 1 });
    const stopData = { distance: 1500, duration: 3600 };
    mockService.stopSession.mockResolvedValueOnce({ success: true, data: stopData } as any);

    const result = await makeCaller().stopSession({ sessionId: SESSION_UUID });

    expect(result).toEqual(stopData);
    expect(mockService.stopSession).toHaveBeenCalledWith(SESSION_UUID);
  });

  it('throws when service returns failure', async () => {
    (db.query as any).mockResolvedValueOnce({ rows: [{ worker_id: 'test-uid' }], rowCount: 1 });
    mockService.stopSession.mockResolvedValueOnce({
      success: false,
      error: { message: 'Session already stopped' },
    } as any);

    await expect(
      makeCaller().stopSession({ sessionId: SESSION_UUID })
    ).rejects.toThrow('Session already stopped');
  });
});

describe('tracking.getStats', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns session stats', async () => {
    (db.query as any).mockResolvedValueOnce({ rows: [{ worker_id: 'test-uid', poster_id: 'poster-uid' }], rowCount: 1 });
    const stats = { totalDistance: 5000, avgSpeed: 4.5 };
    mockService.getSessionStats.mockResolvedValueOnce({ success: true, data: stats } as any);

    const result = await makeCaller().getStats({ sessionId: SESSION_UUID });

    expect(result).toEqual(stats);
    expect(mockService.getSessionStats).toHaveBeenCalledWith(SESSION_UUID);
  });

  it('throws when service returns failure', async () => {
    (db.query as any).mockResolvedValueOnce({ rows: [{ worker_id: 'test-uid', poster_id: 'poster-uid' }], rowCount: 1 });
    mockService.getSessionStats.mockResolvedValueOnce({
      success: false,
      error: { message: 'Stats unavailable' },
    } as any);

    await expect(
      makeCaller().getStats({ sessionId: SESSION_UUID })
    ).rejects.toThrow('Stats unavailable');
  });
});
