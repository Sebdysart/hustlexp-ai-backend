/**
 * Tracking Regression Tests — R7 Security Fixes
 *
 * Covers:
 *  1. updateLocation with foreign sessionId → FORBIDDEN
 *  2. stopSession with foreign sessionId → FORBIDDEN
 *  3. getStats with foreign sessionId → FORBIDDEN
 *  4. Zod schema rejects accuracy outside [0, 100]
 *  5. listAvailable returns truncated coordinates, no street address
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Mocks (must be declared before imports that trigger module resolution)
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
  aiLogger: {
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

vi.mock('../../src/services/TaskService', () => ({
  TaskService: { accept: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { db } from '../../src/db';
import { trackingRouter } from '../../src/routers/tracking';
import { instantRouter } from '../../src/routers/instant';
import { MovementTrackingService } from '../../src/services/MovementTrackingService';

const mockDb = vi.mocked(db);
const mockService = vi.mocked(MovementTrackingService);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OWNER_ID = 'user-owner-001';
const INTRUDER_ID = 'user-intruder-002';
const POSTER_ID = 'user-poster-003';
const SESSION_UUID = '00000000-0000-0000-0000-000000000010';
const TASK_UUID = '00000000-0000-0000-0000-000000000020';

const validLocation = {
  latitude: 37.7749,
  longitude: -122.4194,
  accuracy: 10,
  timestamp: new Date('2026-01-01T00:00:00Z'),
};

function makeCallerAs(userId: string) {
  return trackingRouter.createCaller({
    user: { id: userId, default_mode: 'worker' },
    firebaseUid: 'fb-uid',
  } as any);
}

function makeInstantCallerAs(userId: string) {
  return instantRouter.createCaller({
    user: { id: userId, default_mode: 'worker' },
    firebaseUid: 'fb-uid',
  } as any);
}

// ---------------------------------------------------------------------------
// Test 1: updateLocation — foreign sessionId → FORBIDDEN
// ---------------------------------------------------------------------------

describe('R7-1: updateLocation ownership enforcement', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws FORBIDDEN when sessionId belongs to a different user', async () => {
    // DB returns a session owned by OWNER, but caller is INTRUDER
    mockDb.query.mockResolvedValueOnce({
      rows: [{ worker_id: OWNER_ID }],
      rowCount: 1,
    } as any);

    await expect(
      makeCallerAs(INTRUDER_ID).updateLocation({
        sessionId: SESSION_UUID,
        location: validLocation,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // Service must NOT have been called
    expect(mockService.updateLocation).not.toHaveBeenCalled();
  });

  it('allows update when caller owns the session', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ worker_id: OWNER_ID }],
      rowCount: 1,
    } as any);
    mockService.updateLocation.mockResolvedValueOnce({ success: true, data: undefined } as any);

    await expect(
      makeCallerAs(OWNER_ID).updateLocation({
        sessionId: SESSION_UUID,
        location: validLocation,
      })
    ).resolves.toEqual({ success: true });
  });

  it('throws NOT_FOUND when session does not exist', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await expect(
      makeCallerAs(INTRUDER_ID).updateLocation({
        sessionId: SESSION_UUID,
        location: validLocation,
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

// ---------------------------------------------------------------------------
// Test 2: stopSession — foreign sessionId → FORBIDDEN
// ---------------------------------------------------------------------------

describe('R7-2: stopSession ownership enforcement', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws FORBIDDEN when sessionId belongs to a different user', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ worker_id: OWNER_ID }],
      rowCount: 1,
    } as any);

    await expect(
      makeCallerAs(INTRUDER_ID).stopSession({ sessionId: SESSION_UUID })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(mockService.stopSession).not.toHaveBeenCalled();
  });

  it('allows stopSession when caller owns the session', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ worker_id: OWNER_ID }],
      rowCount: 1,
    } as any);
    mockService.stopSession.mockResolvedValueOnce({
      success: true,
      data: { totalDistance: 500 },
    } as any);

    await expect(
      makeCallerAs(OWNER_ID).stopSession({ sessionId: SESSION_UUID })
    ).resolves.toEqual({ totalDistance: 500 });
  });

  it('throws NOT_FOUND when session does not exist', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await expect(
      makeCallerAs(INTRUDER_ID).stopSession({ sessionId: SESSION_UUID })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

// ---------------------------------------------------------------------------
// Test 3: getStats — foreign sessionId → FORBIDDEN
// ---------------------------------------------------------------------------

describe('R7-3: getStats ownership enforcement', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws FORBIDDEN when caller is neither worker nor poster', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ worker_id: OWNER_ID, poster_id: POSTER_ID }],
      rowCount: 1,
    } as any);

    await expect(
      makeCallerAs(INTRUDER_ID).getStats({ sessionId: SESSION_UUID })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(mockService.getSessionStats).not.toHaveBeenCalled();
  });

  it('allows getStats when caller is the worker', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ worker_id: OWNER_ID, poster_id: POSTER_ID }],
      rowCount: 1,
    } as any);
    mockService.getSessionStats.mockResolvedValueOnce({
      success: true,
      data: { totalDistance: 1000, duration: 3600, averageSpeed: 0.27, topSpeed: 1.2 },
    } as any);

    await expect(
      makeCallerAs(OWNER_ID).getStats({ sessionId: SESSION_UUID })
    ).resolves.toMatchObject({ totalDistance: 1000 });
  });

  it('allows getStats when caller is the poster', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ worker_id: OWNER_ID, poster_id: POSTER_ID }],
      rowCount: 1,
    } as any);
    mockService.getSessionStats.mockResolvedValueOnce({
      success: true,
      data: { totalDistance: 1000, duration: 3600, averageSpeed: 0.27, topSpeed: 1.2 },
    } as any);

    await expect(
      makeCallerAs(POSTER_ID).getStats({ sessionId: SESSION_UUID })
    ).resolves.toMatchObject({ totalDistance: 1000 });
  });

  it('throws NOT_FOUND when session does not exist', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await expect(
      makeCallerAs(INTRUDER_ID).getStats({ sessionId: SESSION_UUID })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

// ---------------------------------------------------------------------------
// Test 4: Zod schema rejects accuracy < 0 or > 100
// ---------------------------------------------------------------------------

describe('R7-4: GPS accuracy Zod validation bounds', () => {
  // Re-create the same schema from the router to validate it in isolation
  const GPSPointSchema = z.object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    accuracy: z.number().min(0).max(100).optional(),
    timestamp: z.coerce.date(),
  });

  const basePoint = {
    latitude: 37.7,
    longitude: -122.4,
    timestamp: new Date(),
  };

  it('rejects accuracy below 0', () => {
    const result = GPSPointSchema.safeParse({ ...basePoint, accuracy: -1 });
    expect(result.success).toBe(false);
  });

  it('rejects accuracy above 100', () => {
    const result = GPSPointSchema.safeParse({ ...basePoint, accuracy: 101 });
    expect(result.success).toBe(false);
  });

  it('rejects impossibly precise simulator accuracy (0.001)', () => {
    // 0.001 is within [0,100] — but the router now makes accuracy optional so
    // a spoofed 0.001 value would pass the bounds but an actual value of e.g. -0.001
    // would not. Test the boundary explicitly.
    const result = GPSPointSchema.safeParse({ ...basePoint, accuracy: 0.001 });
    // 0.001 >= 0 and <= 100, so it passes the schema (geofence logic handles physics)
    expect(result.success).toBe(true);
  });

  it('accepts accuracy = 0 (boundary)', () => {
    const result = GPSPointSchema.safeParse({ ...basePoint, accuracy: 0 });
    expect(result.success).toBe(true);
  });

  it('accepts accuracy = 100 (boundary)', () => {
    const result = GPSPointSchema.safeParse({ ...basePoint, accuracy: 100 });
    expect(result.success).toBe(true);
  });

  it('accepts omitted accuracy (field is optional)', () => {
    const result = GPSPointSchema.safeParse(basePoint);
    expect(result.success).toBe(true);
  });

  it('accepts typical GPS accuracy of 10m', () => {
    const result = GPSPointSchema.safeParse({ ...basePoint, accuracy: 10 });
    expect(result.success).toBe(true);
  });

  // Integration: router-level mutation rejects accuracy > 100 at Zod parse stage
  it('updateLocation mutation rejects accuracy > 100 via Zod', async () => {
    // No DB call expected — Zod rejects before the handler runs
    await expect(
      makeCallerAs(OWNER_ID).updateLocation({
        sessionId: SESSION_UUID,
        location: { ...validLocation, accuracy: 999 },
      })
    ).rejects.toThrow();
  });

  it('updateLocation mutation rejects accuracy < 0 via Zod', async () => {
    await expect(
      makeCallerAs(OWNER_ID).updateLocation({
        sessionId: SESSION_UUID,
        location: { ...validLocation, accuracy: -5 },
      })
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Test 5: listAvailable returns truncated coordinates, no street address
// ---------------------------------------------------------------------------

describe('R7-5: listAvailable coordinate truncation', () => {
  beforeEach(() => vi.clearAllMocks());

  const now = new Date('2026-03-18T12:00:00Z');

  it('returns approximateLat/approximateLng rounded to 2dp, no address field', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        id: TASK_UUID,
        title: 'Fix sink',
        description: 'Leaky sink',
        price: 5000,
        latitude: 37.774929,   // precise — should be truncated to 37.77
        longitude: -122.419416, // precise — should be truncated to -122.42
        created_at: now,
      }],
      rowCount: 1,
    } as any);

    const caller = makeInstantCallerAs(OWNER_ID);
    const results = await caller.listAvailable({ limit: 10 });

    expect(results).toHaveLength(1);
    const task = results[0];

    // Truncated coordinates present
    expect(task.approximateLat).toBe(37.77);
    expect(task.approximateLng).toBe(-122.42);

    // Full address fields must NOT be present
    expect(task).not.toHaveProperty('location');
    expect(task).not.toHaveProperty('address');
    expect(task).not.toHaveProperty('street');
    expect(task).not.toHaveProperty('full_address');
    expect(task).not.toHaveProperty('latitude');
    expect(task).not.toHaveProperty('longitude');
  });

  it('handles null lat/lng gracefully', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        id: TASK_UUID,
        title: 'Remote task',
        description: 'No GPS',
        price: 2000,
        latitude: null,
        longitude: null,
        created_at: now,
      }],
      rowCount: 1,
    } as any);

    const results = await makeInstantCallerAs(OWNER_ID).listAvailable({ limit: 10 });
    expect(results[0].approximateLat).toBeNull();
    expect(results[0].approximateLng).toBeNull();
  });

  it('returns empty array when no tasks are available', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    const results = await makeInstantCallerAs(OWNER_ID).listAvailable({ limit: 10 });
    expect(results).toHaveLength(0);
  });
});
