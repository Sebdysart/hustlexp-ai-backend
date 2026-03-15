/**
 * Heatmap Router Unit Tests
 *
 * Tests tRPC procedures:
 * - getHeatMap (protected, query)
 * - getDemandAlerts (protected, query)
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

vi.mock('../../src/services/HeatMapService', () => ({
  HeatMapService: {
    getHeatMap: vi.fn(),
    getDemandAlerts: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { heatmapRouter } from '../../src/routers/heatmap';
import { HeatMapService } from '../../src/services/HeatMapService';

const mockService = vi.mocked(HeatMapService);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCaller(userId = 'test-uid') {
  return heatmapRouter.createCaller({
    user: { id: userId, default_mode: 'worker' } as any,
    firebaseUid: 'fb-uid',
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('heatmap.getHeatMap', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns heat map data', async () => {
    const heatMapData = { cells: [{ lat: 37.7, lng: -122.4, intensity: 5 }] };
    mockService.getHeatMap.mockResolvedValueOnce(heatMapData as any);

    const result = await makeCaller().getHeatMap({
      centerLat: 37.7749,
      centerLng: -122.4194,
    });

    expect(result).toEqual(heatMapData);
    expect(mockService.getHeatMap).toHaveBeenCalledWith({
      centerLat: 37.7749,
      centerLng: -122.4194,
    });
  });

  it('passes optional radius and category', async () => {
    mockService.getHeatMap.mockResolvedValueOnce({ cells: [] } as any);

    await makeCaller().getHeatMap({
      centerLat: 40.7128,
      centerLng: -74.006,
      radiusMiles: 10,
      category: 'cleaning',
    });

    expect(mockService.getHeatMap).toHaveBeenCalledWith({
      centerLat: 40.7128,
      centerLng: -74.006,
      radiusMiles: 10,
      category: 'cleaning',
    });
  });

  it('rejects latitude outside valid range', async () => {
    await expect(
      makeCaller().getHeatMap({ centerLat: 91, centerLng: 0 })
    ).rejects.toThrow();
  });

  it('rejects longitude outside valid range', async () => {
    await expect(
      makeCaller().getHeatMap({ centerLat: 0, centerLng: 181 })
    ).rejects.toThrow();
  });

  it('rejects radius outside valid range', async () => {
    await expect(
      makeCaller().getHeatMap({ centerLat: 0, centerLng: 0, radiusMiles: 51 })
    ).rejects.toThrow();
  });
});

describe('heatmap.getDemandAlerts', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns demand alerts for user location', async () => {
    const alerts = [{ area: 'Downtown', demandLevel: 'high' }];
    mockService.getDemandAlerts.mockResolvedValueOnce(alerts as any);

    const result = await makeCaller().getDemandAlerts({
      lat: 37.7749,
      lng: -122.4194,
    });

    expect(result).toEqual(alerts);
    expect(mockService.getDemandAlerts).toHaveBeenCalledWith('test-uid', 37.7749, -122.4194);
  });

  it('rejects invalid coordinates', async () => {
    await expect(
      makeCaller().getDemandAlerts({ lat: -91, lng: 0 })
    ).rejects.toThrow();
  });
});
