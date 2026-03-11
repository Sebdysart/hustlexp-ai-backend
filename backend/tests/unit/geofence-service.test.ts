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
}));

// ── Imports ─────────────────────────────────────────────────────────────────
import { GeofenceService } from '../../src/services/GeofenceService';
import { db } from '../../src/db';

const mockQuery = db.query as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════
// checkProximity
// ═══════════════════════════════════════════════════════════════════════════
describe('GeofenceService.checkProximity', () => {
  it('returns NOT_FOUND when task does not exist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await GeofenceService.checkProximity('task-1', 'user-1', 47.6, -122.3);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('NOT_FOUND');
  });

  it('returns NO_LOCATION when task has no coordinates', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ location_lat: null, location_lng: null, state: 'ACCEPTED', worker_id: 'user-1', progress_state: 'TRAVELING' }],
    });

    const result = await GeofenceService.checkProximity('task-1', 'user-1', 47.6, -122.3);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('NO_LOCATION');
  });

  it('returns NOT_ASSIGNED when user is not the worker', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ location_lat: 47.6, location_lng: -122.3, state: 'ACCEPTED', worker_id: 'other-user', progress_state: 'TRAVELING' }],
    });

    const result = await GeofenceService.checkProximity('task-1', 'user-1', 47.6, -122.3);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('NOT_ASSIGNED');
  });

  it('detects worker within geofence and logs enter event', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ location_lat: 47.6, location_lng: -122.3, state: 'ACCEPTED', worker_id: 'user-1', progress_state: 'TRAVELING' }],
      })
      .mockResolvedValueOnce({ rows: [{ distance_meters: 100 }] }) // distance
      .mockResolvedValueOnce({ rows: [] }) // no previous event
      .mockResolvedValueOnce({ rowCount: 1 }); // insert event

    const result = await GeofenceService.checkProximity('task-1', 'user-1', 47.6001, -122.3001);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.within_geofence).toBe(true);
      expect(result.data.event_logged).toBe(true);
    }
  });

  it('triggers auto check-in when within 50m and task ACCEPTED', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ location_lat: 47.6, location_lng: -122.3, state: 'ACCEPTED', worker_id: 'user-1', progress_state: 'TRAVELING' }],
      })
      .mockResolvedValueOnce({ rows: [{ distance_meters: 30 }] }) // within 50m
      .mockResolvedValueOnce({ rows: [] }) // no previous event
      .mockResolvedValueOnce({ rowCount: 1 }); // insert

    const result = await GeofenceService.checkProximity('task-1', 'user-1', 47.6, -122.3);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.auto_checkin_triggered).toBe(true);
    }
  });

  it('logs exit event when worker moves beyond 300m', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ location_lat: 47.6, location_lng: -122.3, state: 'ACCEPTED', worker_id: 'user-1', progress_state: 'WORKING' }],
      })
      .mockResolvedValueOnce({ rows: [{ distance_meters: 400 }] }) // beyond exit radius
      .mockResolvedValueOnce({ rows: [{ event_type: 'enter' }] }) // last event was enter
      .mockResolvedValueOnce({ rowCount: 1 }); // insert exit event

    const result = await GeofenceService.checkProximity('task-1', 'user-1', 47.65, -122.35);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.within_geofence).toBe(false);
      expect(result.data.event_logged).toBe(true);
    }
  });

  it('does not log event when no state change', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ location_lat: 47.6, location_lng: -122.3, state: 'ACCEPTED', worker_id: 'user-1', progress_state: 'WORKING' }],
      })
      .mockResolvedValueOnce({ rows: [{ distance_meters: 100 }] }) // within geofence
      .mockResolvedValueOnce({ rows: [{ event_type: 'enter' }] }); // already entered

    const result = await GeofenceService.checkProximity('task-1', 'user-1', 47.6001, -122.3001);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.event_logged).toBe(false);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// getTaskEvents
// ═══════════════════════════════════════════════════════════════════════════
describe('GeofenceService.getTaskEvents', () => {
  it('returns events for a task', async () => {
    const events = [
      { id: 'e1', task_id: 'task-1', user_id: 'user-1', event_type: 'enter', distance_meters: 100, created_at: new Date() },
    ];
    mockQuery.mockResolvedValueOnce({ rows: events });

    const result = await GeofenceService.getTaskEvents('task-1');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveLength(1);
      expect(result.data[0].event_type).toBe('enter');
    }
  });

  it('returns empty array when no events', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await GeofenceService.getTaskEvents('task-1');
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toHaveLength(0);
  });

  it('returns error on DB failure', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB error'));

    const result = await GeofenceService.getTaskEvents('task-1');
    expect(result.success).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// verifyPresenceDuringTask
// ═══════════════════════════════════════════════════════════════════════════
describe('GeofenceService.verifyPresenceDuringTask', () => {
  it('returns was_present=true when events exist', async () => {
    const now = Date.now();
    mockQuery.mockResolvedValueOnce({
      rows: [
        { event_type: 'enter', created_at: new Date(now - 3600000) },
        { event_type: 'checkin', created_at: new Date(now - 3000000) },
        { event_type: 'exit', created_at: new Date(now - 600000) },
      ],
    });

    const result = await GeofenceService.verifyPresenceDuringTask('task-1', 'user-1');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.was_present).toBe(true);
      expect(result.data.checkin_count).toBe(1);
      expect(result.data.total_time_at_location_minutes).toBeGreaterThan(0);
    }
  });

  it('returns was_present=false when no events', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await GeofenceService.verifyPresenceDuringTask('task-1', 'user-1');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.was_present).toBe(false);
      expect(result.data.checkin_count).toBe(0);
    }
  });

  it('handles error gracefully', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB error'));

    const result = await GeofenceService.verifyPresenceDuringTask('task-1', 'user-1');
    expect(result.success).toBe(false);
  });
});
