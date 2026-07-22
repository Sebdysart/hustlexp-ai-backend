import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db.js';
import { LiquidityCellService } from '../../src/services/LiquidityCellService.js';

const enabled = process.env.HX_ALLOW_E2E_LIQUIDITY_EXPANSION === '1';
const describePg = enabled ? describe : describe.skip;

function assertDisposableDatabase(databaseUrl: string): void {
  const parsed = new URL(databaseUrl);
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
  const disposableName = /(?:e2e|test|startup)/i.test(parsed.pathname.slice(1));
  if (!loopback || !disposableName) {
    throw new Error(`Refusing liquidity expansion test against ${parsed.hostname}/${parsed.pathname.slice(1)}`);
  }
}

describePg('HX/OS PostgreSQL adjacent expansion contract', () => {
  const databaseUrl = process.env.DATABASE_URL ?? '';
  const runId = randomUUID();
  const suffix = runId.slice(0, 8);
  const sourceId = randomUUID();
  const actorId = `expansion-admin-${suffix}`;
  let approvedRequestId = '';
  let approvedTargetId = '';

  beforeAll(async () => {
    assertDisposableDatabase(databaseUrl);
    await db.query(
      `INSERT INTO zone_category_cells
         (id,geo_zone,geography_label,category,operating_window,state,policy_version,
          launch_cell_enabled,green_category,metrics_computed_at,evaluated_at,stable_since,
          state_reasons,completed_tasks_total,paid_tasks_30d,fill_rate_30d,
          active_verified_providers,anchor_demand_accounts,average_contribution_cents,
          dispute_rate_30d,no_show_rate_30d,cancellation_rate_30d,repeat_demand_rate_30d,
          dispatch_allowed,public_instant_requests_allowed,expansion_eligible,max_concurrent_dispatches)
       VALUES ($1,$2,$3,'moving','Daily 08:00-18:00','OPEN','hxos-launch-cell-v1',
          TRUE,TRUE,NOW(),NOW(),NOW()-INTERVAL '20 days','["controlled_expansion_source"]',
          40,30,0.90,5,2,1400,0.03,0.03,0.05,0.25,TRUE,TRUE,TRUE,5)`,
      [sourceId, `source-${suffix}`, `Source ${suffix}`],
    );
  });

  afterAll(async () => {
    if (enabled) await db.close();
  });

  it('creates an eligible adjacent target only as seeding and replays exactly', async () => {
    const input = {
      sourceCellId: sourceId,
      targetGeoZone: `eligible-${suffix}`,
      targetGeographyLabel: `Eligible ${suffix}`,
      targetCategory: 'moving',
      targetOperatingWindow: 'Daily 08:00-18:00',
      idempotencyKey: `eligible:${runId}`,
    };
    const first = await LiquidityCellService.requestAdjacentExpansion(input, actorId);
    expect(first).toMatchObject({ success: true, data: { decision: 'APPROVED', targetState: 'SEEDING', replayed: false } });
    if (!first.success || !first.data.targetCellId) return;
    approvedRequestId = first.data.requestId;
    approvedTargetId = first.data.targetCellId;
    const target = await db.query<{
      state: string; launch_cell_enabled: boolean; green_category: boolean;
      dispatch_allowed: boolean; public_instant_requests_allowed: boolean; expansion_request_id: string;
    }>(
      `SELECT state,launch_cell_enabled,green_category,dispatch_allowed,
              public_instant_requests_allowed,expansion_request_id
         FROM zone_category_cells WHERE id=$1`,
      [approvedTargetId],
    );
    expect(target.rows[0]).toEqual({
      state: 'SEEDING',
      launch_cell_enabled: true,
      green_category: true,
      dispatch_allowed: false,
      public_instant_requests_allowed: false,
      expansion_request_id: approvedRequestId,
    });
    await expect(LiquidityCellService.requestAdjacentExpansion(input, actorId))
      .resolves.toMatchObject({ success: true, data: { replayed: true, requestId: approvedRequestId } });
    await expect(LiquidityCellService.requestAdjacentExpansion(
      { ...input, targetGeoZone: `conflict-${suffix}` }, actorId,
    )).resolves.toMatchObject({ success: false, error: { code: 'CONFLICT' } });
  });

  it('records denial and allows an exception to prepare only a closed cell', async () => {
    await db.query('UPDATE zone_category_cells SET expansion_eligible=FALSE WHERE id=$1', [sourceId]);
    const denied = await LiquidityCellService.requestAdjacentExpansion({
      sourceCellId: sourceId,
      targetGeoZone: `denied-${suffix}`,
      targetGeographyLabel: `Denied ${suffix}`,
      targetCategory: 'moving',
      targetOperatingWindow: 'Daily 08:00-18:00',
      idempotencyKey: `denied:${runId}`,
    }, actorId);
    expect(denied).toMatchObject({
      success: true,
      data: { decision: 'DENIED', targetCellId: null, reasons: ['source_not_expansion_eligible'] },
    });

    const prepared = await LiquidityCellService.requestAdjacentExpansion({
      sourceCellId: sourceId,
      targetGeoZone: `prepared-${suffix}`,
      targetGeographyLabel: `Prepared ${suffix}`,
      targetCategory: 'moving',
      targetOperatingWindow: 'Daily 08:00-18:00',
      idempotencyKey: `prepared:${runId}`,
      override: {
        owner: 'Marketplace Governance',
        reason: 'Prepare demand collection only; launch and dispatch remain disabled.',
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      },
    }, actorId);
    expect(prepared).toMatchObject({
      success: true,
      data: { decision: 'OVERRIDE_PREPARED', targetState: 'CLOSED' },
    });
    if (!prepared.success || !prepared.data.targetCellId) return;
    const target = await db.query<{
      state: string; launch_cell_enabled: boolean; green_category: boolean; dispatch_allowed: boolean;
    }>(
      'SELECT state,launch_cell_enabled,green_category,dispatch_allowed FROM zone_category_cells WHERE id=$1',
      [prepared.data.targetCellId],
    );
    expect(target.rows[0]).toEqual({
      state: 'CLOSED', launch_cell_enabled: false, green_category: false, dispatch_allowed: false,
    });
  });

  it('enforces append-only decisions, immutable origins, and forbidden-open rejection', async () => {
    await expect(db.query(
      `UPDATE liquidity_expansion_requests SET reasons='["rewritten"]'::jsonb WHERE id=$1`,
      [approvedRequestId],
    )).rejects.toThrow(/append-only/);
    await expect(db.query(
      'UPDATE zone_category_cells SET expansion_request_id=NULL WHERE id=$1',
      [approvedTargetId],
    )).rejects.toThrow(/HXLC12/);

    const requestId = randomUUID();
    const targetId = randomUUID();
    await expect(db.transaction(async (query) => {
      await query(
        `INSERT INTO liquidity_expansion_requests
           (id,source_cell_id,target_cell_id,actor_id,idempotency_key,request_hash,
            source_metrics_hash,policy_version,adjacency_kind,target_geo_zone,
            target_geography_label,target_category,target_operating_window,decision,reasons)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'hxos-launch-cell-v1','GEOGRAPHY',$8,$9,
                 'moving','Daily 08:00-18:00','APPROVED','["forbidden_open_probe"]')`,
        [requestId, sourceId, targetId, actorId, `forbidden:${runId}`, '1'.repeat(64), '2'.repeat(64),
          `forbidden-${suffix}`, `Forbidden ${suffix}`],
      );
      await query(
        `INSERT INTO zone_category_cells
           (id,geo_zone,geography_label,category,operating_window,state,policy_version,
            launch_cell_enabled,green_category,dispatch_allowed,public_instant_requests_allowed,
            expansion_eligible,max_concurrent_dispatches,expansion_request_id)
         VALUES ($1,$2,$3,'moving','Daily 08:00-18:00','OPEN','hxos-launch-cell-v1',
                 TRUE,TRUE,TRUE,TRUE,TRUE,5,$4)`,
        [targetId, `forbidden-${suffix}`, `Forbidden ${suffix}`, requestId],
      );
    })).rejects.toThrow(/HXLC9/);
  });
});
