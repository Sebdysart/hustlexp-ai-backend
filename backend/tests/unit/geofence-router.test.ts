/**
 * Geofence Router Unit Tests
 *
 * Tests tRPC procedures:
 * - checkProximity (protected, mutation)
 * - getTaskEvents (protected, query)
 * - verifyPresence (protected, query)
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

vi.mock('../../src/services/GeofenceService', () => ({
  GeofenceService: {
    checkProximity: vi.fn(),
    getTaskEvents: vi.fn(),
    verifyPresenceDuringTask: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { db } from '../../src/db';
import { geofenceRouter } from '../../src/routers/geofence';
import { GeofenceService } from '../../src/services/GeofenceService';

const mockDb = vi.mocked(db);
const mockService = vi.mocked(GeofenceService);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_UUID = '11111111-1111-1111-1111-111111111111';

function makeCaller(userId = 'test-uid') {
  return geofenceRouter.createCaller({
    user: { id: userId, default_mode: 'worker' } as any,
    firebaseUid: 'fb-uid',
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('geofence.checkProximity', () => {
  beforeEach(() => vi.clearAllMocks());

  it('checks proximity for a task', async () => {
    const result_ = { withinRadius: true, distanceMeters: 50 };
    mockService.checkProximity.mockResolvedValueOnce(result_ as any);

    const result = await makeCaller().checkProximity({
      taskId: TEST_UUID,
      lat: 37.7749,
      lng: -122.4194,
    });

    expect(result).toEqual(result_);
    expect(mockService.checkProximity).toHaveBeenCalledWith(
      TEST_UUID, 'test-uid', 37.7749, -122.4194
    );
  });

  it('rejects invalid latitude', async () => {
    await expect(
      makeCaller().checkProximity({ taskId: TEST_UUID, lat: 91, lng: 0 })
    ).rejects.toThrow();
  });

  it('rejects invalid longitude', async () => {
    await expect(
      makeCaller().checkProximity({ taskId: TEST_UUID, lat: 0, lng: -181 })
    ).rejects.toThrow();
  });
});

describe('geofence.getTaskEvents', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns geofence events for a task', async () => {
    const events = [
      { type: 'check_in', timestamp: new Date().toISOString() },
      { type: 'check_out', timestamp: new Date().toISOString() },
    ];
    mockDb.query.mockResolvedValueOnce({ rows: [{ poster_id: 'test-uid', worker_id: 'test-uid' }], rowCount: 1 } as any);
    mockService.getTaskEvents.mockResolvedValueOnce(events as any);

    const result = await makeCaller().getTaskEvents({ taskId: TEST_UUID });

    expect(result).toEqual(events);
    expect(mockService.getTaskEvents).toHaveBeenCalledWith(TEST_UUID);
  });
});

describe('geofence.verifyPresence', () => {
  beforeEach(() => vi.clearAllMocks());

  it('verifies presence during task', async () => {
    const presence = { verified: true, durationMinutes: 45 };
    mockService.verifyPresenceDuringTask.mockResolvedValueOnce(presence as any);

    const result = await makeCaller().verifyPresence({ taskId: TEST_UUID });

    expect(result).toEqual(presence);
    expect(mockService.verifyPresenceDuringTask).toHaveBeenCalledWith(TEST_UUID, 'test-uid');
  });
});
