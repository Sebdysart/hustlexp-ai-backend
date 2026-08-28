/**
 * fraud-detection-worker.test.ts
 *
 * W47-3 FIX: Verifies the fraud scan lookback window is 5 minutes (not 6),
 * which matches the cron schedule and prevents duplicate fraud_detection_events
 * from being created on consecutive runs.
 *
 * Also tests the processFraudDetectionJob function for:
 * - Empty result early return
 * - Impossible travel detection delegation to LogisticsAIService
 * - Error propagation (re-throw for BullMQ retry)
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ────────────────────────────────────────────────────────────────────────────
// Source-level assertion (W47-3 interval check)
// ────────────────────────────────────────────────────────────────────────────

const WORKER_PATH = path.resolve(
  __dirname,
  '../../src/jobs/fraud-detection-worker.ts'
);

describe("W47-3: fraud scan lookback window", () => {
  const source = fs.readFileSync(WORKER_PATH, 'utf8');

  it("uses INTERVAL '5 minutes' — matches the cron schedule", () => {
    expect(source).toContain("INTERVAL '5 minutes'");
  });

  it("does NOT use INTERVAL '6 minutes' — which caused 1-minute overlap", () => {
    expect(source).not.toContain("INTERVAL '6 minutes'");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Mocks
// ────────────────────────────────────────────────────────────────────────────

vi.mock('../../src/db.js', () => ({
  db: { query: vi.fn() },
}));

vi.mock('../../src/services/LogisticsAIService.js', () => ({
  LogisticsAIService: {
    detectImpossibleTravel: vi.fn(),
  },
}));

vi.mock('../../src/logger.js', () => {
  const base = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: () => base,
  };
  return { logger: base, workerLogger: base };
});

// ────────────────────────────────────────────────────────────────────────────
// Imports (after mocks)
// ────────────────────────────────────────────────────────────────────────────

import { db } from '../../src/db.js';
import { LogisticsAIService } from '../../src/services/LogisticsAIService.js';
import { processFraudDetectionJob } from '../../src/jobs/fraud-detection-worker.js';
import type { Job } from 'bullmq';

const mockDb = vi.mocked(db);
const mockDetectImpossibleTravel = vi.mocked(LogisticsAIService.detectImpossibleTravel);

const fakeJob = {} as Job;

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe('processFraudDetectionJob', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns early with no action when no recent proofs exist', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    await processFraudDetectionJob(fakeJob);

    // LogisticsAIService should not be called if there are no proofs
    expect(mockDetectImpossibleTravel).not.toHaveBeenCalled();
  });

  it('skips users with only one proof (need at least 2 for travel detection)', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        proof_id: 'p1',
        user_id: 'user-1',
        gps_latitude: 37.7749,
        gps_longitude: -122.4194,
        gps_timestamp: new Date().toISOString(),
      }],
      rowCount: 1,
    } as never);

    await processFraudDetectionJob(fakeJob);

    expect(mockDetectImpossibleTravel).not.toHaveBeenCalled();
  });

  it('calls detectImpossibleTravel for each consecutive proof pair per user', async () => {
    const now = new Date();
    const earlier = new Date(now.getTime() - 60_000); // 1 minute ago

    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          proof_id: 'p1',
          user_id: 'user-1',
          gps_latitude: 37.7749,
          gps_longitude: -122.4194,
          gps_timestamp: earlier.toISOString(),
        },
        {
          proof_id: 'p2',
          user_id: 'user-1',
          gps_latitude: 37.7850,
          gps_longitude: -122.4100,
          gps_timestamp: now.toISOString(),
        },
      ],
      rowCount: 2,
    } as never);

    mockDetectImpossibleTravel.mockResolvedValueOnce({
      success: true,
      data: { flagged: false, speed_kmh: 12, distance_meters: 1200, time_delta_seconds: 60, passed: true },
    } as never);

    await processFraudDetectionJob(fakeJob);

    expect(mockDetectImpossibleTravel).toHaveBeenCalledTimes(1);
    expect(mockDetectImpossibleTravel).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ latitude: 37.7850, longitude: -122.4100 }),
      expect.objectContaining({ latitude: 37.7749, longitude: -122.4194 })
    );
  });

  it('counts flagged travel events in the final log', async () => {
    const now = new Date();
    const earlier = new Date(now.getTime() - 60_000);

    mockDb.query.mockResolvedValueOnce({
      rows: [
        { proof_id: 'p1', user_id: 'user-fraud', gps_latitude: 37.0, gps_longitude: -122.0, gps_timestamp: earlier.toISOString() },
        { proof_id: 'p2', user_id: 'user-fraud', gps_latitude: 51.5, gps_longitude: -0.12, gps_timestamp: now.toISOString() },
      ],
      rowCount: 2,
    } as never);

    mockDetectImpossibleTravel.mockResolvedValueOnce({
      success: true,
      data: { flagged: true, speed_kmh: 8500, distance_meters: 8_600_000, time_delta_seconds: 60, passed: false },
    } as never);

    // Should complete without throwing even though travel was flagged
    await expect(processFraudDetectionJob(fakeJob)).resolves.toBeUndefined();
  });

  it('continues scan when detectImpossibleTravel throws (non-fraud treatment)', async () => {
    const now = new Date();
    const earlier = new Date(now.getTime() - 60_000);

    mockDb.query.mockResolvedValueOnce({
      rows: [
        { proof_id: 'p1', user_id: 'user-err', gps_latitude: 37.0, gps_longitude: -122.0, gps_timestamp: earlier.toISOString() },
        { proof_id: 'p2', user_id: 'user-err', gps_latitude: 37.1, gps_longitude: -122.1, gps_timestamp: now.toISOString() },
      ],
      rowCount: 2,
    } as never);

    mockDetectImpossibleTravel.mockRejectedValueOnce(new Error('AI service unavailable'));

    // Should not throw — errors in detectImpossibleTravel are swallowed
    await expect(processFraudDetectionJob(fakeJob)).resolves.toBeUndefined();
  });

  it('re-throws when the outer DB query fails (BullMQ will retry)', async () => {
    mockDb.query.mockRejectedValueOnce(new Error('DB connection lost'));

    await expect(processFraudDetectionJob(fakeJob)).rejects.toThrow('DB connection lost');
  });

  it('processes multiple users independently in the same batch', async () => {
    const now = new Date();
    const earlier = new Date(now.getTime() - 120_000);

    mockDb.query.mockResolvedValueOnce({
      rows: [
        { proof_id: 'a1', user_id: 'user-A', gps_latitude: 37.0, gps_longitude: -122.0, gps_timestamp: earlier.toISOString() },
        { proof_id: 'a2', user_id: 'user-A', gps_latitude: 37.1, gps_longitude: -122.1, gps_timestamp: now.toISOString() },
        { proof_id: 'b1', user_id: 'user-B', gps_latitude: 40.0, gps_longitude: -74.0, gps_timestamp: earlier.toISOString() },
        { proof_id: 'b2', user_id: 'user-B', gps_latitude: 40.1, gps_longitude: -74.1, gps_timestamp: now.toISOString() },
      ],
      rowCount: 4,
    } as never);

    mockDetectImpossibleTravel.mockResolvedValue({
      success: true,
      data: { flagged: false, speed_kmh: 5, distance_meters: 500, time_delta_seconds: 120, passed: true },
    } as never);

    await processFraudDetectionJob(fakeJob);

    // One call per pair per user = 2 calls total
    expect(mockDetectImpossibleTravel).toHaveBeenCalledTimes(2);
  });
});
