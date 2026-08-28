import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn(), transaction: vi.fn() }));
vi.mock('../../src/db.js', () => ({ db: { query: mocks.query, transaction: mocks.transaction } }));

import { LiquidityCellService } from '../../src/services/LiquidityCellService.js';

const cell = {
  id: '11111111-1111-4111-8111-111111111111',
  geo_zone: 'bellevue-kirkland',
  geography_label: 'Bellevue–Kirkland',
  category: 'ground_level_yard_cleanup',
  operating_window: 'Friday–Sunday daytime',
  state: 'OPEN',
  policy_version: 'hxos-launch-cell-v1',
  launch_cell_enabled: true,
  green_category: true,
  environment: 'PRODUCTION',
  is_test: false,
  metrics_computed_at: '2026-07-18T19:55:00.000Z',
  evaluated_at: '2026-07-18T19:55:00.000Z',
  stable_since: '2026-07-01T20:00:00.000Z',
  suspension_reason: null,
  minimum_provider_net_hourly_cents: 2000,
  provider_earnings_policy_version: 'hxos-provider-economics-approved-v1',
  provider_earnings_policy_state: 'APPROVED',
  provider_earnings_sample_size: '30',
  average_provider_net_hourly_cents: '3500',
  opportunity_sample_size: '8',
  opportunity_minimum_cents: '7200',
  opportunity_maximum_cents: '11800',
};

const metricRow = {
  completed_tasks_total: '35', paid_tasks_30d: '30', total_tasks_30d: '35', filled_tasks_30d: '30',
  active_verified_providers: '5', anchor_demand_accounts: '2', average_contribution_cents: '1400',
  missing_contribution_count: '0', dispute_tasks_30d: '1', no_show_tasks_30d: '1',
  cancelled_tasks_30d: '2', repeat_paid_tasks_30d: '8',
  provider_earnings_sample_size: '30', missing_provider_earnings_count: '0',
  average_provider_net_hourly_cents: '3500',
};

const expansionCell = {
  ...cell,
  expansion_eligible: true,
  completed_tasks_total: '35',
  paid_tasks_30d: '30',
  fill_rate_30d: '0.85714',
  active_verified_providers: '5',
  anchor_demand_accounts: '2',
  average_contribution_cents: '1400',
  provider_earnings_sample_size: '30',
  average_provider_net_hourly_cents: '3500',
  dispute_rate_30d: '0.03333',
  no_show_rate_30d: '0.02857',
  cancellation_rate_30d: '0.05714',
  repeat_demand_rate_30d: '0.26667',
};

function expansionQuery(source = expansionCell, replay?: Record<string, unknown>) {
  mocks.query.mockImplementation(async (sql: string, values?: unknown[]) => {
    if (sql.includes('FROM liquidity_expansion_requests') && sql.includes('WHERE actor_id')) {
      return { rows: replay ? [replay] : [] };
    }
    if (sql.includes('FROM zone_category_cells') && sql.includes('FOR UPDATE')) return { rows: [source] };
    if (sql.includes('SELECT id FROM zone_category_cells')) return { rows: [] };
    if (sql.includes('INSERT INTO liquidity_expansion_requests')) {
      return { rows: [{
        id: values?.[0], target_cell_id: values?.[2], request_hash: values?.[5],
        decision: values?.[13], reasons: JSON.parse(String(values?.[14])),
      }] };
    }
    return { rows: [] };
  });
}

describe('canonical liquidity cell service', () => {
  beforeEach(() => {
    mocks.query.mockReset();
    mocks.transaction.mockReset();
    mocks.transaction.mockImplementation(async (work) => work(mocks.query));
  });

  it('returns only coarse public promises and downgrades stale metrics', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [cell] });
    const fresh = await LiquidityCellService.getPublicSnapshot(
      'bellevue-kirkland', new Date('2026-07-18T20:00:00.000Z'), mocks.query,
    );
    expect(fresh).toMatchObject({
      success: true,
      data: {
        geoZone: 'bellevue-kirkland', area: 'Bellevue–Kirkland', stale: false,
        categories: [{
          state: 'AVAILABLE',
          operatingWindow: 'Friday–Sunday daytime',
          opportunityRange: {
            minimumCents: 7200,
            maximumCents: 11800,
            currency: 'USD',
            evidenceClass: 'ACTIVE_FUNDED_PRODUCTION_TASKS',
            evidenceWindowDays: 30,
            asOf: '2026-07-18T20:00:00.000Z',
          },
        }],
      },
    });
    const publicSql = String(mocks.query.mock.calls[0]?.[0]);
    expect(publicSql).toContain("cell.environment = 'PRODUCTION'");
    expect(publicSql).toContain('cell.is_test IS FALSE');
    expect(publicSql).toContain('PERCENTILE_DISC(0.25)');
    expect(publicSql).toContain("task.state IN ('OPEN', 'MATCHING')");
    expect(publicSql).toContain("task.automation_classification = 'PRODUCTION'");
    expect(publicSql).toContain("escrow.state = 'FUNDED'");
    expect(mocks.query.mock.calls[0]?.[1]).toEqual([
      'hxos-launch-cell-v1',
      '2026-07-18T20:00:00.000Z',
      'bellevue-kirkland',
    ]);
    expect(JSON.stringify(fresh)).not.toContain('activeVerifiedProviders');
    expect(JSON.stringify(fresh)).not.toContain('sampleSize');

    mocks.query.mockResolvedValueOnce({ rows: [cell] });
    const stale = await LiquidityCellService.getPublicSnapshot(
      'bellevue-kirkland', new Date('2026-07-18T20:20:01.000Z'), mocks.query,
    );
    expect(stale).toMatchObject({ success: true, data: { stale: true, categories: [{ state: 'LATER_WINDOWS' }] } });
    expect(JSON.stringify(stale)).not.toContain('opportunityRange');
  });

  it('suppresses a real payout band until the public privacy threshold is met', async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [{ ...cell, opportunity_sample_size: '4' }],
    });
    const sparse = await LiquidityCellService.getPublicSnapshot(
      'bellevue-kirkland', new Date('2026-07-18T20:00:00.000Z'), mocks.query,
    );
    expect(sparse).toMatchObject({
      success: true,
      data: { stale: false, categories: [{ state: 'AVAILABLE' }] },
    });
    expect(JSON.stringify(sparse)).not.toContain('opportunityRange');

    mocks.query.mockResolvedValueOnce({
      rows: [{ ...cell, opportunity_minimum_cents: '12000', opportunity_maximum_cents: '9000' }],
    });
    const invalid = await LiquidityCellService.getPublicSnapshot(
      'bellevue-kirkland', new Date('2026-07-18T20:00:00.000Z'), mocks.query,
    );
    expect(JSON.stringify(invalid)).not.toContain('opportunityRange');
  });

  it('recalculates from canonical transactions and appends a payload-hashed decision event', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM zone_category_cells WHERE id')) return { rows: [cell] };
      if (sql.includes('COUNT(DISTINCT category)')) return { rows: [{ count: '3' }] };
      if (sql.includes('WITH cell_tasks')) return { rows: [metricRow] };
      return { rows: [] };
    });
    const result = await LiquidityCellService.recalculateCell(
      cell.id, 'admin-1', new Date('2026-07-18T20:00:00.000Z'),
    );
    expect(result).toEqual({ success: true, data: { id: cell.id, state: 'OPEN', expansionEligible: true } });
    const eventCall = mocks.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO zone_category_cell_events'));
    expect(eventCall?.[1]?.[4]).toMatch(/^[a-f0-9]{64}$/);
    expect(eventCall?.[1]?.[6]).toBe('admin-1');
  });

  it('throttles when actual contribution evidence is incomplete', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM zone_category_cells WHERE id')) return { rows: [cell] };
      if (sql.includes('COUNT(DISTINCT category)')) return { rows: [{ count: '3' }] };
      if (sql.includes('WITH cell_tasks')) return { rows: [{ ...metricRow, missing_contribution_count: '1' }] };
      return { rows: [] };
    });
    const result = await LiquidityCellService.recalculateCell(
      cell.id, 'admin-1', new Date('2026-07-18T20:00:00.000Z'),
    );
    expect(result).toMatchObject({ success: true, data: { state: 'THROTTLED', expansionEligible: false } });
    const updateCall = mocks.query.mock.calls.find(([sql]) => String(sql).includes('UPDATE zone_category_cells SET'));
    expect(updateCall?.[1]?.[16]).toBe(false);
  });

  it('throttles a mature category when accepted-offer net-hourly evidence is incomplete or below floor', async () => {
    for (const mutation of [
      { missing_provider_earnings_count: '1' },
      { average_provider_net_hourly_cents: '1999' },
    ]) {
      mocks.query.mockReset();
      mocks.query.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM zone_category_cells WHERE id')) return { rows: [cell] };
        if (sql.includes('COUNT(DISTINCT category)')) return { rows: [{ count: '3' }] };
        if (sql.includes('WITH cell_tasks')) return { rows: [{ ...metricRow, ...mutation }] };
        return { rows: [] };
      });
      const result = await LiquidityCellService.recalculateCell(
        cell.id, 'admin-1', new Date('2026-07-18T20:00:00.000Z'),
      );
      expect(result).toMatchObject({ success: true, data: { state: 'THROTTLED', expansionEligible: false } });
    }
  });

  it('binds only an open task whose category matches the chosen cell', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ id: 'task-1', liquidity_cell_id: cell.id }] });
    await expect(LiquidityCellService.bindTaskToCell('task-1', cell.id, mocks.query)).resolves.toEqual({
      success: true, data: { taskId: 'task-1', cellId: cell.id },
    });
    expect(mocks.query.mock.calls[0]?.[0]).toContain("t.state IN ('OPEN','MATCHING')");
    expect(mocks.query.mock.calls[0]?.[0]).toContain('t.category = c.category');
    expect(mocks.query.mock.calls[0]?.[0]).toContain("t.automation_classification = 'PRODUCTION'");
    expect(mocks.query.mock.calls[0]?.[0]).toContain("c.environment = 'PRODUCTION'");
  });

  it('creates an adjacent eligible geography only as non-dispatching seeding', async () => {
    expansionQuery();
    const result = await LiquidityCellService.requestAdjacentExpansion({
      sourceCellId: cell.id,
      targetGeoZone: 'redmond',
      targetGeographyLabel: 'Redmond',
      targetCategory: cell.category,
      targetOperatingWindow: cell.operating_window,
      idempotencyKey: 'expand:eligible:1',
    }, 'admin-1', new Date('2026-07-18T20:00:00.000Z'));
    expect(result).toMatchObject({
      success: true,
      data: { decision: 'APPROVED', targetState: 'SEEDING', replayed: false },
    });
    const cellInsert = mocks.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO zone_category_cells'));
    expect(cellInsert?.[1]?.[5]).toBe('SEEDING');
    expect(cellInsert?.[1]?.[7]).toBe(true);
    expect(String(cellInsert?.[0])).toContain('dispatch_allowed');
    expect(String(cellInsert?.[0])).toContain('FALSE,FALSE,FALSE,0');
  });

  it('records a fail-closed denial and creates no target when the source is ineligible', async () => {
    expansionQuery({ ...expansionCell, expansion_eligible: false });
    const result = await LiquidityCellService.requestAdjacentExpansion({
      sourceCellId: cell.id,
      targetGeoZone: 'redmond',
      targetGeographyLabel: 'Redmond',
      targetCategory: cell.category,
      targetOperatingWindow: cell.operating_window,
      idempotencyKey: 'expand:denied:1',
    }, 'admin-1', new Date('2026-07-18T20:00:00.000Z'));
    expect(result).toMatchObject({
      success: true,
      data: { decision: 'DENIED', targetCellId: null, targetState: null, reasons: ['source_not_expansion_eligible'] },
    });
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO zone_category_cells'))).toBe(false);
    const requestInsert = mocks.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO liquidity_expansion_requests'));
    expect(requestInsert?.[1]?.[3]).toBe('admin-1');
    expect(requestInsert?.[1]?.[13]).toBe('DENIED');
  });

  it.each([
    ['stability', { stable_since: '2026-07-10T20:00:00.000Z' }, 'source_stability_window_incomplete'],
    ['fill', { fill_rate_30d: '0.84' }, 'source_fill_rate_below_floor'],
    ['contribution', { average_contribution_cents: '0' }, 'source_contribution_not_positive'],
    ['provider earnings floor', { average_provider_net_hourly_cents: '1999' }, 'source_provider_net_hourly_below_floor'],
    ['provider earnings sample', { provider_earnings_sample_size: '29' }, 'source_provider_earnings_sample_incomplete'],
    ['disputes', { dispute_rate_30d: '0.051' }, 'source_dispute_rate_above_ceiling'],
    ['no-shows', { no_show_rate_30d: '0.051' }, 'source_no_show_rate_above_ceiling'],
    ['provider redundancy', { active_verified_providers: '4' }, 'source_provider_redundancy_below_floor'],
    ['repeat demand', { repeat_demand_rate_30d: '0.19' }, 'source_repeat_demand_below_floor'],
  ])('rechecks the persisted %s floor instead of trusting the eligibility flag', async (_label, mutation, reason) => {
    expansionQuery({ ...expansionCell, ...mutation, expansion_eligible: true });
    const result = await LiquidityCellService.requestAdjacentExpansion({
      sourceCellId: cell.id,
      targetGeoZone: 'redmond',
      targetGeographyLabel: 'Redmond',
      targetCategory: cell.category,
      targetOperatingWindow: cell.operating_window,
      idempotencyKey: `expand:floor:${reason}`,
    }, 'admin-1', new Date('2026-07-18T20:00:00.000Z'));
    expect(result).toMatchObject({ success: true, data: { decision: 'DENIED' } });
    if (!result.success) return;
    expect(result.data.reasons).toContain(reason);
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO zone_category_cells'))).toBe(false);
  });

  it('prepares an override only as a closed launch-disabled cell with owner and reason', async () => {
    expansionQuery({ ...expansionCell, expansion_eligible: false });
    const result = await LiquidityCellService.requestAdjacentExpansion({
      sourceCellId: cell.id,
      targetGeoZone: 'redmond',
      targetGeographyLabel: 'Redmond',
      targetCategory: cell.category,
      targetOperatingWindow: cell.operating_window,
      idempotencyKey: 'expand:override:1',
      override: {
        owner: 'Marketplace Governance',
        reason: 'Prepare an offline demand-collection cell; dispatch remains disabled.',
        expiresAt: '2026-07-18T21:00:00.000Z',
      },
    }, 'admin-1', new Date('2026-07-18T20:00:00.000Z'));
    expect(result).toMatchObject({
      success: true,
      data: { decision: 'OVERRIDE_PREPARED', targetState: 'CLOSED', replayed: false },
    });
    const requestInsert = mocks.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO liquidity_expansion_requests'));
    expect(requestInsert?.[1]?.slice(13, 18)).toEqual([
      'OVERRIDE_PREPARED',
      JSON.stringify(['source_not_expansion_eligible', 'override_prepared_closed_only']),
      'Marketplace Governance',
      'Prepare an offline demand-collection cell; dispatch remains disabled.',
      '2026-07-18T21:00:00.000Z',
    ]);
    const cellInsert = mocks.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO zone_category_cells'));
    expect(cellInsert?.[1]?.[5]).toBe('CLOSED');
    expect(cellInsert?.[1]?.[7]).toBe(false);
  });

  it('replays the identical request and rejects an idempotency payload conflict', async () => {
    const original = {
      sourceCellId: cell.id,
      targetGeoZone: 'redmond',
      targetGeographyLabel: 'Redmond',
      targetCategory: cell.category,
      targetOperatingWindow: cell.operating_window,
      idempotencyKey: 'expand:replay:1',
    };
    expansionQuery();
    const first = await LiquidityCellService.requestAdjacentExpansion(
      original, 'admin-1', new Date('2026-07-18T20:00:00.000Z'),
    );
    expect(first.success).toBe(true);
    if (!first.success) return;
    const requestInsert = mocks.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO liquidity_expansion_requests'))!;
    const replayRow = {
      id: first.data.requestId,
      target_cell_id: first.data.targetCellId,
      request_hash: requestInsert[1]?.[5],
      decision: 'APPROVED',
      reasons: ['source_expansion_policy_passed'],
    };

    mocks.query.mockReset();
    expansionQuery(expansionCell, replayRow);
    await expect(LiquidityCellService.requestAdjacentExpansion(
      original, 'admin-1', new Date('2026-07-18T20:00:00.000Z'),
    )).resolves.toMatchObject({ success: true, data: { replayed: true, requestId: first.data.requestId } });

    await expect(LiquidityCellService.requestAdjacentExpansion(
      { ...original, targetGeoZone: 'issaquah' }, 'admin-1', new Date('2026-07-18T20:00:00.000Z'),
    )).resolves.toMatchObject({ success: false, error: { code: 'CONFLICT' } });
  });
});
