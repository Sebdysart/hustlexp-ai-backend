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
import { HeatMapService } from '../../src/services/HeatMapService';
import { db } from '../../src/db';

const mockQuery = db.query as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════
// getHeatMap
// ═══════════════════════════════════════════════════════════════════════════
describe('HeatMapService.getHeatMap', () => {
  it('returns heat map cells with normalized intensity', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { center_lat: 47.6, center_lng: -122.3, geohash: '47.6,-122.3', task_count: 10, avg_price_cents: 5000 },
        { center_lat: 47.61, center_lng: -122.31, geohash: '47.61,-122.31', task_count: 5, avg_price_cents: 3000 },
      ],
    });

    const result = await HeatMapService.getHeatMap({ centerLat: 47.6, centerLng: -122.3 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cells).toHaveLength(2);
      expect(result.data.cells[0].intensity).toBe(1); // max count = intensity 1
      expect(result.data.cells[1].intensity).toBe(0.5); // 5/10 = 0.5
    }
  });

  it('returns empty cells array when no tasks found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await HeatMapService.getHeatMap({ centerLat: 47.6, centerLng: -122.3 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cells).toHaveLength(0);
      // Falls back to default bounds
      expect(result.data.bounds.min_lat).toBeCloseTo(47.5, 1);
    }
  });

  it('filters by category when provided', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await HeatMapService.getHeatMap({ centerLat: 47.6, centerLng: -122.3, category: 'plumbing' });
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('category'),
      expect.arrayContaining(['plumbing']),
    );
  });

  it('uses custom radius when provided', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await HeatMapService.getHeatMap({ centerLat: 47.6, centerLng: -122.3, radiusMiles: 20 });
    // 20 miles * 1609.34 = ~32186.8
    expect(mockQuery).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining([expect.closeTo(32186.8, 0)]),
    );
  });

  it('handles DB error', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB error'));

    const result = await HeatMapService.getHeatMap({ centerLat: 47.6, centerLng: -122.3 });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('HEATMAP_ERROR');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// getDemandAlerts
// ═══════════════════════════════════════════════════════════════════════════
describe('HeatMapService.getDemandAlerts', () => {
  it('returns alerts for high-demand skills', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { skill_name: 'Gutter Cleaning', task_count: 8, avg_price_cents: 5000, worker_count: 2 },
      ],
    });

    const result = await HeatMapService.getDemandAlerts('user-1', 47.6, -122.3);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveLength(1);
      expect(result.data[0].skill_name).toBe('Gutter Cleaning');
      expect(result.data[0].demand_multiplier).toBe(4); // 8/2
    }
  });

  it('filters out skills with demand multiplier below 1.5', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { skill_name: 'Low Demand', task_count: 3, avg_price_cents: 2000, worker_count: 5 },
      ],
    });

    const result = await HeatMapService.getDemandAlerts('user-1', 47.6, -122.3);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveLength(0);
    }
  });

  it('filters out skills with zero workers', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { skill_name: 'No Workers', task_count: 10, avg_price_cents: 5000, worker_count: 0 },
      ],
    });

    const result = await HeatMapService.getDemandAlerts('user-1', 47.6, -122.3);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveLength(0);
    }
  });

  it('handles DB error', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB error'));

    const result = await HeatMapService.getDemandAlerts('user-1', 47.6, -122.3);
    expect(result.success).toBe(false);
  });
});
