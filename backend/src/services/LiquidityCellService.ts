import { createHash, randomUUID } from 'node:crypto';
import { db, type QueryFn } from '../db.js';
import type { ServiceResult } from '../types.js';
import {
  evaluateLiquidityCell,
  LIQUIDITY_THRESHOLDS,
  LIQUIDITY_CELL_POLICY_VERSION,
  publicAvailabilityForCell,
  type LiquidityCellMetrics,
  type LiquidityCellState,
} from './LiquidityCellPolicy.js';

interface CellRow {
  id: string;
  geo_zone: string;
  geography_label: string;
  category: string;
  operating_window: string;
  state: LiquidityCellState;
  policy_version: string;
  launch_cell_enabled: boolean;
  green_category: boolean;
  environment: 'PRODUCTION' | 'CONTROLLED_TEST';
  is_test: boolean;
  metrics_computed_at: string | Date | null;
  evaluated_at: string | Date;
  stable_since: string | Date | null;
  suspension_reason: string | null;
  minimum_provider_net_hourly_cents: string | number | null;
  provider_earnings_policy_version: string | null;
  provider_earnings_policy_state: 'TEST_HYPOTHESIS' | 'APPROVED' | null;
  opportunity_sample_size: string | number | null;
  opportunity_minimum_cents: string | number | null;
  opportunity_maximum_cents: string | number | null;
}

interface MetricRow {
  completed_tasks_total: string;
  paid_tasks_30d: string;
  total_tasks_30d: string;
  filled_tasks_30d: string;
  active_verified_providers: string;
  anchor_demand_accounts: string;
  average_contribution_cents: string | null;
  missing_contribution_count: string;
  provider_earnings_sample_size: string;
  missing_provider_earnings_count: string;
  average_provider_net_hourly_cents: string | null;
  dispute_tasks_30d: string;
  no_show_tasks_30d: string;
  cancelled_tasks_30d: string;
  repeat_paid_tasks_30d: string;
}

interface ExpansionSourceRow extends CellRow {
  expansion_eligible: boolean;
  completed_tasks_total: string;
  paid_tasks_30d: string;
  fill_rate_30d: string;
  active_verified_providers: string;
  anchor_demand_accounts: string;
  average_contribution_cents: string;
  provider_earnings_sample_size: string;
  average_provider_net_hourly_cents: string;
  dispute_rate_30d: string;
  no_show_rate_30d: string;
  cancellation_rate_30d: string;
  repeat_demand_rate_30d: string;
}

type ExpansionDecision = 'APPROVED' | 'DENIED' | 'OVERRIDE_PREPARED';

interface ExpansionRequestRow {
  id: string;
  target_cell_id: string | null;
  request_hash: string;
  decision: ExpansionDecision;
  reasons: string[];
}

export interface AdjacentExpansionInput {
  sourceCellId: string;
  targetGeoZone: string;
  targetGeographyLabel: string;
  targetCategory: string;
  targetOperatingWindow: string;
  idempotencyKey: string;
  override?: {
    owner: string;
    reason: string;
    expiresAt: string;
  };
}

export interface AdjacentExpansionResult {
  requestId: string;
  targetCellId: string | null;
  decision: ExpansionDecision;
  targetState: 'SEEDING' | 'CLOSED' | null;
  reasons: string[];
  replayed: boolean;
}

export interface PublicLiquidityCell {
  category: string;
  label: string;
  state: 'AVAILABLE' | 'LIMITED' | 'LATER_WINDOWS' | 'TEMPORARILY_UNAVAILABLE';
  note: string;
  operatingWindow: string;
  opportunityRange?: {
    minimumCents: number;
    maximumCents: number;
    currency: 'USD';
    evidenceClass: 'ACTIVE_FUNDED_PRODUCTION_TASKS';
    evidenceWindowDays: 30;
    asOf: string;
  };
}

export interface PublicLiquiditySnapshot {
  policyVersion: string;
  geoZone: string | null;
  area: string | null;
  asOf: string | null;
  stale: boolean;
  categories: PublicLiquidityCell[];
}

function iso(value: string | Date | null): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function numeric(value: string | null): number {
  if (value === null) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

const PUBLIC_OPPORTUNITY_MINIMUM_SAMPLE = 5;
const PUBLIC_OPPORTUNITY_WINDOW_DAYS = 30;

function opportunityRange(
  row: CellRow,
  at: Date,
): PublicLiquidityCell['opportunityRange'] {
  const sampleSize = numeric(
    row.opportunity_sample_size == null ? null : String(row.opportunity_sample_size),
  );
  const minimumCents = numeric(
    row.opportunity_minimum_cents == null ? null : String(row.opportunity_minimum_cents),
  );
  const maximumCents = numeric(
    row.opportunity_maximum_cents == null ? null : String(row.opportunity_maximum_cents),
  );
  if (
    sampleSize < PUBLIC_OPPORTUNITY_MINIMUM_SAMPLE
    || !Number.isInteger(minimumCents)
    || !Number.isInteger(maximumCents)
    || minimumCents <= 0
    || maximumCents < minimumCents
  ) {
    return undefined;
  }
  return {
    minimumCents,
    maximumCents,
    currency: 'USD',
    evidenceClass: 'ACTIVE_FUNDED_PRODUCTION_TASKS',
    evidenceWindowDays: PUBLIC_OPPORTUNITY_WINDOW_DAYS,
    asOf: at.toISOString(),
  };
}

function safeRate(numerator: number, denominator: number): number {
  return denominator > 0 ? Math.min(1, Math.max(0, numerator / denominator)) : 0;
}

function label(category: string): string {
  return category.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function note(state: PublicLiquidityCell['state']): string {
  if (state === 'AVAILABLE') return 'Good availability in configured windows';
  if (state === 'LIMITED') return 'Selected windows only';
  if (state === 'TEMPORARILY_UNAVAILABLE') return 'Not accepting new transactions in this cell';
  return 'Submit a flexible request; timing is not promised';
}

function staleCell(row: CellRow, at: Date): boolean {
  const evaluatedAt = iso(row.evaluated_at);
  const metricsAt = iso(row.metrics_computed_at);
  if (!evaluatedAt || !metricsAt) return true;
  return at.getTime() - Date.parse(evaluatedAt) > 15 * 60_000
    || at.getTime() - Date.parse(metricsAt) > 15 * 60_000;
}

async function getPublicSnapshot(
  geoZone?: string,
  at: Date = new Date(),
  query: QueryFn = db.query,
): Promise<ServiceResult<PublicLiquiditySnapshot>> {
  try {
    const params: unknown[] = [LIQUIDITY_CELL_POLICY_VERSION, at.toISOString()];
    let zoneFilter = '';
    if (geoZone) {
      params.push(geoZone);
      zoneFilter = 'AND cell.geo_zone = $3';
    }
    const result = await query<CellRow>(
      `SELECT cell.id, cell.geo_zone, cell.geography_label, cell.category,
              cell.operating_window, cell.state, cell.policy_version,
              cell.launch_cell_enabled, cell.green_category,
              cell.environment, cell.is_test,
              cell.metrics_computed_at, cell.evaluated_at, cell.stable_since,
              cell.suspension_reason,
              opportunity.sample_size AS opportunity_sample_size,
              opportunity.minimum_cents AS opportunity_minimum_cents,
              opportunity.maximum_cents AS opportunity_maximum_cents
        FROM zone_category_cells cell
        LEFT JOIN LATERAL (
          SELECT
            COUNT(*)::text AS sample_size,
            PERCENTILE_DISC(0.25) WITHIN GROUP (
              ORDER BY task.hustler_payout_cents
            )::text AS minimum_cents,
            PERCENTILE_DISC(0.75) WITHIN GROUP (
              ORDER BY task.hustler_payout_cents
            )::text AS maximum_cents
          FROM tasks task
          WHERE task.liquidity_cell_id = cell.id
            AND task.geo_zone = cell.geo_zone
            AND task.category = cell.category
            AND task.state IN ('OPEN', 'MATCHING')
            AND task.worker_id IS NULL
            AND task.automation_classification = 'PRODUCTION'
            AND task.hustler_payout_cents > 0
            AND task.created_at >= $2::timestamptz - INTERVAL '30 days'
            AND (task.deadline IS NULL OR task.deadline > $2::timestamptz)
            AND EXISTS (
              SELECT 1 FROM escrows escrow
              WHERE escrow.task_id = task.id AND escrow.state = 'FUNDED'
            )
        ) opportunity ON TRUE
        WHERE cell.launch_cell_enabled = TRUE AND cell.green_category = TRUE
          AND cell.environment = 'PRODUCTION' AND cell.is_test IS FALSE
          AND cell.policy_version = $1 ${zoneFilter}
        ORDER BY cell.geo_zone, cell.category, cell.operating_window`,
      params,
    );
    if (result.rows.length === 0) {
      return {
        success: true,
        data: { policyVersion: LIQUIDITY_CELL_POLICY_VERSION, geoZone: geoZone ?? null, area: null, asOf: null, stale: true, categories: [] },
      };
    }
    const selectedZone = geoZone ?? result.rows[0]!.geo_zone;
    const rows = result.rows.filter((row) => row.geo_zone === selectedZone);
    const stale = rows.some((row) => staleCell(row, at));
    const categories = rows.map((row) => {
      const cellIsStale = staleCell(row, at);
      const range = cellIsStale ? undefined : opportunityRange(row, at);
      const publicState = cellIsStale && row.state !== 'SUSPENDED'
        ? 'LATER_WINDOWS' as const
        : publicAvailabilityForCell(row.state);
      return {
        category: row.category,
        label: label(row.category),
        state: publicState,
        note: note(publicState),
        operatingWindow: row.operating_window,
        ...(range ? { opportunityRange: range } : {}),
      };
    });
    const asOfValues = rows.map((row) => iso(row.metrics_computed_at)).filter((value): value is string => Boolean(value));
    return {
      success: true,
      data: {
        policyVersion: LIQUIDITY_CELL_POLICY_VERSION,
        geoZone: selectedZone,
        area: rows[0]?.geography_label ?? null,
        asOf: asOfValues.sort().at(0) ?? null,
        stale,
        categories,
      },
    };
  } catch {
    return { success: false, error: { code: 'DB_ERROR', message: 'Liquidity availability is unavailable.' } };
  }
}

function metricsFromRow(row: MetricRow): LiquidityCellMetrics {
  const total30d = numeric(row.total_tasks_30d);
  const paid30d = numeric(row.paid_tasks_30d);
  const contributionComplete = numeric(row.missing_contribution_count) === 0 && paid30d > 0;
  const providerEarningsComplete = numeric(row.missing_provider_earnings_count) === 0
    && numeric(row.provider_earnings_sample_size) > 0;
  return {
    completedTasksTotal: numeric(row.completed_tasks_total),
    paidTasks30d: paid30d,
    fillRate30d: safeRate(numeric(row.filled_tasks_30d), total30d),
    activeVerifiedProviders: numeric(row.active_verified_providers),
    anchorDemandAccounts: numeric(row.anchor_demand_accounts),
    averageContributionCents: contributionComplete ? numeric(row.average_contribution_cents) : 0,
    providerEarningsSampleSize: numeric(row.provider_earnings_sample_size),
    averageProviderNetHourlyCents: providerEarningsComplete
      ? numeric(row.average_provider_net_hourly_cents)
      : 0,
    disputeRate30d: safeRate(numeric(row.dispute_tasks_30d), paid30d),
    noShowRate30d: safeRate(numeric(row.no_show_tasks_30d), total30d),
    cancellationRate30d: safeRate(numeric(row.cancelled_tasks_30d), total30d),
    repeatDemandRate30d: safeRate(numeric(row.repeat_paid_tasks_30d), paid30d),
  };
}

const METRICS_SQL = `WITH cell_tasks AS (
  SELECT t.*, rtc.contribution_cents
  FROM tasks t
  LEFT JOIN revenue_task_contribution rtc ON rtc.task_id = t.id
  WHERE t.geo_zone = $1 AND t.category = $2
    AND COALESCE(t.automation_classification, 'PRODUCTION') = 'PRODUCTION'
), paid_30d AS (
  SELECT * FROM cell_tasks WHERE state = 'COMPLETED' AND completed_at >= NOW() - INTERVAL '30 days'
), provider_earnings_30d AS (
  SELECT paid.id,
         CASE
           WHEN paid.started_at IS NOT NULL
            AND paid.completed_at > paid.started_at
            AND offer.net_payout_cents > 0
            AND offer.estimated_travel_time_minutes > 0
           THEN FLOOR(
             (offer.net_payout_cents * 60.0)
             / (
               GREATEST(1, CEIL(EXTRACT(EPOCH FROM (paid.completed_at - paid.started_at)) / 60.0))
               + offer.estimated_travel_time_minutes
             )
           )::integer
           ELSE NULL
         END AS provider_net_hourly_cents
    FROM paid_30d paid
    LEFT JOIN LATERAL (
      SELECT decision.net_payout_cents, decision.estimated_travel_time_minutes
        FROM worker_offer_decisions decision
       WHERE decision.task_id = paid.id
         AND decision.worker_id = paid.worker_id
         AND decision.decision_ready = TRUE
         AND decision.provider_earnings_floor_met = TRUE
         AND decision.customer_total_cents = paid.price
         AND decision.payout_cents IS NOT DISTINCT FROM paid.hustler_payout_cents
         AND decision.scope_hash IS NOT DISTINCT FROM paid.scope_hash
       ORDER BY decision.created_at DESC
       LIMIT 1
    ) offer ON TRUE
), repeat_posters AS (
  SELECT poster_id FROM paid_30d GROUP BY poster_id HAVING COUNT(*) >= 2
), anchors AS (
  SELECT poster_id FROM cell_tasks
  WHERE state = 'COMPLETED' AND completed_at >= NOW() - INTERVAL '90 days'
  GROUP BY poster_id HAVING COUNT(*) >= 2
)
SELECT
  COUNT(*) FILTER (WHERE state = 'COMPLETED')::text AS completed_tasks_total,
  (SELECT COUNT(*) FROM paid_30d)::text AS paid_tasks_30d,
  COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')::text AS total_tasks_30d,
  COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days' AND accepted_at IS NOT NULL)::text AS filled_tasks_30d,
  COUNT(DISTINCT worker_id) FILTER (
    WHERE worker_id IS NOT NULL AND accepted_at >= NOW() - INTERVAL '30 days'
      AND EXISTS (SELECT 1 FROM users u WHERE u.id = worker_id AND u.trust_tier >= 2 AND COALESCE(u.trust_hold, FALSE) = FALSE)
  )::text AS active_verified_providers,
  (SELECT COUNT(*) FROM anchors)::text AS anchor_demand_accounts,
  (SELECT AVG(contribution_cents) FROM paid_30d)::text AS average_contribution_cents,
  (SELECT COUNT(*) FROM paid_30d WHERE contribution_cents IS NULL)::text AS missing_contribution_count,
  (SELECT COUNT(*) FROM provider_earnings_30d WHERE provider_net_hourly_cents IS NOT NULL)::text
    AS provider_earnings_sample_size,
  (SELECT COUNT(*) FROM provider_earnings_30d WHERE provider_net_hourly_cents IS NULL)::text
    AS missing_provider_earnings_count,
  (SELECT AVG(provider_net_hourly_cents) FROM provider_earnings_30d)::text
    AS average_provider_net_hourly_cents,
  COUNT(*) FILTER (WHERE state = 'DISPUTED' AND updated_at >= NOW() - INTERVAL '30 days')::text AS dispute_tasks_30d,
  COUNT(*) FILTER (WHERE state = 'EXPIRED' AND accepted_at IS NOT NULL AND updated_at >= NOW() - INTERVAL '30 days')::text AS no_show_tasks_30d,
  COUNT(*) FILTER (WHERE state = 'CANCELLED' AND updated_at >= NOW() - INTERVAL '30 days')::text AS cancelled_tasks_30d,
  (SELECT COUNT(*) FROM paid_30d p WHERE p.poster_id IN (SELECT poster_id FROM repeat_posters))::text AS repeat_paid_tasks_30d
FROM cell_tasks`;

function metricsHash(metrics: LiquidityCellMetrics): string {
  return createHash('sha256').update(JSON.stringify(metrics)).digest('hex');
}

function expansionMetrics(row: ExpansionSourceRow): LiquidityCellMetrics {
  return {
    completedTasksTotal: numeric(row.completed_tasks_total),
    paidTasks30d: numeric(row.paid_tasks_30d),
    fillRate30d: numeric(row.fill_rate_30d),
    activeVerifiedProviders: numeric(row.active_verified_providers),
    anchorDemandAccounts: numeric(row.anchor_demand_accounts),
    averageContributionCents: numeric(row.average_contribution_cents),
    providerEarningsSampleSize: numeric(row.provider_earnings_sample_size),
    averageProviderNetHourlyCents: numeric(row.average_provider_net_hourly_cents),
    disputeRate30d: numeric(row.dispute_rate_30d),
    noShowRate30d: numeric(row.no_show_rate_30d),
    cancellationRate30d: numeric(row.cancellation_rate_30d),
    repeatDemandRate30d: numeric(row.repeat_demand_rate_30d),
  };
}

function normalizedExpansionInput(input: AdjacentExpansionInput): AdjacentExpansionInput {
  const expiry = input.override ? new Date(input.override.expiresAt) : null;
  return {
    sourceCellId: input.sourceCellId.trim(),
    targetGeoZone: input.targetGeoZone.trim().toLowerCase(),
    targetGeographyLabel: input.targetGeographyLabel.trim(),
    targetCategory: input.targetCategory.trim().toLowerCase(),
    targetOperatingWindow: input.targetOperatingWindow.trim(),
    idempotencyKey: input.idempotencyKey.trim(),
    override: input.override ? {
      owner: input.override.owner.trim(),
      reason: input.override.reason.trim(),
      expiresAt: expiry && Number.isFinite(expiry.getTime()) ? expiry.toISOString() : input.override.expiresAt,
    } : undefined,
  };
}

function expansionRequestHash(input: AdjacentExpansionInput): string {
  return createHash('sha256').update(JSON.stringify({
    sourceCellId: input.sourceCellId,
    targetGeoZone: input.targetGeoZone,
    targetGeographyLabel: input.targetGeographyLabel,
    targetCategory: input.targetCategory,
    targetOperatingWindow: input.targetOperatingWindow,
    override: input.override ?? null,
  })).digest('hex');
}

function validExpansionInput(input: AdjacentExpansionInput, actorId: string): boolean {
  return actorId.trim().length >= 1 && actorId.trim().length <= 128
    && /^[a-f0-9-]{36}$/i.test(input.sourceCellId)
    && /^[a-z0-9][a-z0-9_-]{1,79}$/.test(input.targetGeoZone)
    && input.targetGeographyLabel.length >= 2 && input.targetGeographyLabel.length <= 120
    && input.targetCategory.length >= 1 && input.targetCategory.length <= 100
    && input.targetOperatingWindow.length >= 2 && input.targetOperatingWindow.length <= 160
    && input.idempotencyKey.length >= 8 && input.idempotencyKey.length <= 128;
}

function validOverride(input: AdjacentExpansionInput, requestedAt: Date): boolean {
  if (!input.override) return false;
  const expiresAt = Date.parse(input.override.expiresAt);
  return input.override.owner.length >= 3 && input.override.owner.length <= 120
    && input.override.reason.length >= 20 && input.override.reason.length <= 500
    && Number.isFinite(expiresAt)
    && expiresAt > requestedAt.getTime()
    && expiresAt <= requestedAt.getTime() + 24 * 60 * 60_000;
}

function expansionFloorReasons(source: ExpansionSourceRow, requestedAt: Date): string[] {
  const metrics = expansionMetrics(source);
  const reasons: string[] = [];
  const stableSince = Date.parse(iso(source.stable_since) ?? '');
  if (!Number.isFinite(stableSince)
      || requestedAt.getTime() - stableSince < LIQUIDITY_THRESHOLDS.expansionStableDays * 24 * 60 * 60_000) {
    reasons.push('source_stability_window_incomplete');
  }
  if (metrics.fillRate30d < LIQUIDITY_THRESHOLDS.openFillRate) reasons.push('source_fill_rate_below_floor');
  if (metrics.averageContributionCents <= 0) reasons.push('source_contribution_not_positive');
  const minimumProviderNetHourlyCents = numeric(
    source.minimum_provider_net_hourly_cents == null
      ? null
      : String(source.minimum_provider_net_hourly_cents),
  );
  if (source.provider_earnings_policy_state !== 'APPROVED'
    || !source.provider_earnings_policy_version?.trim()
    || minimumProviderNetHourlyCents <= 0) {
    reasons.push('source_provider_earnings_policy_unapproved');
  }
  if (metrics.providerEarningsSampleSize < LIQUIDITY_THRESHOLDS.providerEarningsSampleSize) {
    reasons.push('source_provider_earnings_sample_incomplete');
  }
  if (minimumProviderNetHourlyCents > 0
    && metrics.averageProviderNetHourlyCents < minimumProviderNetHourlyCents) {
    reasons.push('source_provider_net_hourly_below_floor');
  }
  if (metrics.disputeRate30d > LIQUIDITY_THRESHOLDS.expansionMaximumDisputeRate) reasons.push('source_dispute_rate_above_ceiling');
  if (metrics.noShowRate30d > LIQUIDITY_THRESHOLDS.expansionMaximumNoShowRate) reasons.push('source_no_show_rate_above_ceiling');
  if (metrics.activeVerifiedProviders < LIQUIDITY_THRESHOLDS.expansionProviderRedundancy) reasons.push('source_provider_redundancy_below_floor');
  if (metrics.repeatDemandRate30d < LIQUIDITY_THRESHOLDS.expansionRepeatDemandRate) reasons.push('source_repeat_demand_below_floor');
  return reasons;
}

function resultFromExpansionRow(row: ExpansionRequestRow, replayed: boolean): AdjacentExpansionResult {
  return {
    requestId: row.id,
    targetCellId: row.target_cell_id,
    decision: row.decision,
    targetState: row.decision === 'APPROVED' ? 'SEEDING'
      : row.decision === 'OVERRIDE_PREPARED' ? 'CLOSED' : null,
    reasons: row.reasons,
    replayed,
  };
}

async function recalculateCell(
  cellId: string,
  actorId: string,
  evaluatedAt: Date = new Date(),
): Promise<ServiceResult<{ id: string; state: LiquidityCellState; expansionEligible: boolean }>> {
  try {
    return await db.transaction(async (query) => {
      const cellResult = await query<CellRow>(
        `SELECT id, geo_zone, geography_label, category, operating_window, state,
                policy_version, launch_cell_enabled, green_category,
                environment, is_test,
                metrics_computed_at, evaluated_at, stable_since, suspension_reason,
                minimum_provider_net_hourly_cents, provider_earnings_policy_version,
                provider_earnings_policy_state
           FROM zone_category_cells WHERE id = $1 FOR UPDATE`,
        [cellId],
      );
      const cell = cellResult.rows[0];
      if (!cell) return { success: false as const, error: { code: 'NOT_FOUND', message: 'Liquidity cell not found.' } };
      if (cell.environment !== 'PRODUCTION' || cell.is_test) {
        return { success: false as const, error: { code: 'INVALID_STATE', message: 'TEST liquidity is not recalculated by production launch policy.' } };
      }
      const greenResult = await query<{ count: string }>(
        `SELECT COUNT(DISTINCT category)::text AS count FROM zone_category_cells
          WHERE geo_zone = $1 AND launch_cell_enabled = TRUE AND green_category = TRUE
            AND environment = 'PRODUCTION' AND is_test IS FALSE`,
        [cell.geo_zone],
      );
      const metricResult = await query<MetricRow>(METRICS_SQL, [cell.geo_zone, cell.category]);
      const metrics = metricsFromRow(metricResult.rows[0]!);
      const evaluatedIso = evaluatedAt.toISOString();
      const decision = evaluateLiquidityCell({
        geoZone: cell.geo_zone,
        category: cell.category,
        operatingWindow: cell.operating_window,
        launchCellEnabled: cell.launch_cell_enabled,
        greenCategory: cell.green_category,
        launchGreenCategoryCount: numeric(greenResult.rows[0]?.count ?? '0'),
        minimumProviderNetHourlyCents: numeric(
          cell.minimum_provider_net_hourly_cents == null
            ? null
            : String(cell.minimum_provider_net_hourly_cents),
        ) || null,
        providerEarningsPolicyVersion: cell.provider_earnings_policy_version,
        providerEarningsPolicyApproved: cell.provider_earnings_policy_state === 'APPROVED',
        metrics,
        metricsComputedAt: evaluatedIso,
        evaluatedAt: evaluatedIso,
        previousState: cell.state,
        stableSince: iso(cell.stable_since),
        suspensionReason: cell.suspension_reason,
        severeFailure: null,
      });
      const stableSince = decision.state === cell.state ? iso(cell.stable_since) ?? evaluatedIso : evaluatedIso;
      await query(
        `UPDATE zone_category_cells SET
           state = $2, policy_version = $3, metrics_computed_at = $4, evaluated_at = $4,
           stable_since = $5, state_reasons = $6::jsonb,
           completed_tasks_total = $7, paid_tasks_30d = $8, fill_rate_30d = $9,
           active_verified_providers = $10, anchor_demand_accounts = $11,
           average_contribution_cents = $12, dispute_rate_30d = $13,
           no_show_rate_30d = $14, cancellation_rate_30d = $15,
           repeat_demand_rate_30d = $16, dispatch_allowed = $17,
           public_instant_requests_allowed = $18, expansion_eligible = $19,
           max_concurrent_dispatches = $20,
           provider_earnings_sample_size = $21,
           average_provider_net_hourly_cents = $22, updated_at = NOW()
         WHERE id = $1`,
        [cell.id, decision.state, decision.policyVersion, evaluatedIso, stableSince,
          JSON.stringify(decision.reasons), metrics.completedTasksTotal, metrics.paidTasks30d,
          metrics.fillRate30d, metrics.activeVerifiedProviders, metrics.anchorDemandAccounts,
          metrics.averageContributionCents, metrics.disputeRate30d, metrics.noShowRate30d,
          metrics.cancellationRate30d, metrics.repeatDemandRate30d, decision.dispatchAllowed,
          decision.publicInstantRequestsAllowed, decision.expansionEligible, decision.maxConcurrentDispatches,
          metrics.providerEarningsSampleSize, metrics.averageProviderNetHourlyCents],
      );
      await query(
        `INSERT INTO zone_category_cell_events
           (cell_id, from_state, to_state, policy_version, metrics_hash, reasons, actor_type, actor_id)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,'ADMIN',$7)`,
        [cell.id, cell.state, decision.state, decision.policyVersion, metricsHash(metrics), JSON.stringify(decision.reasons), actorId],
      );
      return { success: true as const, data: { id: cell.id, state: decision.state, expansionEligible: decision.expansionEligible } };
    });
  } catch {
    return { success: false, error: { code: 'DB_ERROR', message: 'Liquidity cell recalculation failed.' } };
  }
}

async function bindTaskToCell(
  taskId: string,
  cellId: string,
  query: QueryFn = db.query,
): Promise<ServiceResult<{ taskId: string; cellId: string }>> {
  try {
    const result = await query<{ id: string; liquidity_cell_id: string }>(
      `UPDATE tasks t SET liquidity_cell_id = c.id, geo_zone = c.geo_zone, updated_at = NOW()
         FROM zone_category_cells c
        WHERE t.id = $1 AND c.id = $2 AND t.category = c.category
          AND t.state IN ('OPEN','MATCHING')
          AND t.automation_classification = 'PRODUCTION'
          AND c.environment = 'PRODUCTION' AND c.is_test IS FALSE
        RETURNING t.id, t.liquidity_cell_id`,
      [taskId, cellId],
    );
    if (!result.rows[0]) {
      return { success: false, error: { code: 'INVALID_STATE', message: 'Task cannot be bound to that liquidity cell.' } };
    }
    return { success: true, data: { taskId: result.rows[0].id, cellId: result.rows[0].liquidity_cell_id } };
  } catch {
    return { success: false, error: { code: 'DB_ERROR', message: 'Task liquidity binding failed.' } };
  }
}

async function requestAdjacentExpansion(
  rawInput: AdjacentExpansionInput,
  actorId: string,
  requestedAt: Date = new Date(),
): Promise<ServiceResult<AdjacentExpansionResult>> {
  const input = normalizedExpansionInput(rawInput);
  if (!validExpansionInput(input, actorId)) {
    return { success: false, error: { code: 'INVALID_INPUT', message: 'Expansion request is invalid.' } };
  }
  const requestHash = expansionRequestHash(input);
  try {
    return await db.transaction(async (query) => {
      const replayResult = await query<ExpansionRequestRow>(
        `SELECT id,target_cell_id,request_hash,decision,reasons
           FROM liquidity_expansion_requests
          WHERE actor_id=$1 AND idempotency_key=$2`,
        [actorId, input.idempotencyKey],
      );
      const replay = replayResult.rows[0];
      if (replay) {
        if (replay.request_hash !== requestHash) {
          return { success: false as const, error: { code: 'CONFLICT', message: 'Expansion replay payload conflicts with the original request.' } };
        }
        return { success: true as const, data: resultFromExpansionRow(replay, true) };
      }

      const sourceResult = await query<ExpansionSourceRow>(
        `SELECT id,geo_zone,geography_label,category,operating_window,state,policy_version,
                launch_cell_enabled,green_category,metrics_computed_at,evaluated_at,stable_since,
                environment,is_test,
                suspension_reason,expansion_eligible,completed_tasks_total,paid_tasks_30d,
                fill_rate_30d,active_verified_providers,anchor_demand_accounts,
                average_contribution_cents,minimum_provider_net_hourly_cents,
                provider_earnings_policy_version,provider_earnings_policy_state,
                provider_earnings_sample_size,average_provider_net_hourly_cents,
                dispute_rate_30d,no_show_rate_30d,
                cancellation_rate_30d,repeat_demand_rate_30d
           FROM zone_category_cells
          WHERE id=$1 AND environment='PRODUCTION' AND is_test IS FALSE
          FOR UPDATE`,
        [input.sourceCellId],
      );
      const source = sourceResult.rows[0];
      if (!source) {
        return { success: false as const, error: { code: 'NOT_FOUND', message: 'Expansion source cell was not found.' } };
      }

      const geoChanged = input.targetGeoZone !== source.geo_zone;
      const categoryChanged = input.targetCategory !== source.category;
      const adjacencyKind = geoChanged === categoryChanged ? 'INVALID'
        : geoChanged ? 'GEOGRAPHY' : 'CATEGORY';
      const structuralReasons: string[] = [];
      if (adjacencyKind === 'INVALID') structuralReasons.push('target_must_change_exactly_one_dimension');
      const targetResult = await query<{ id: string }>(
        `SELECT id FROM zone_category_cells
          WHERE geo_zone=$1 AND category=$2 AND operating_window=$3
            AND environment='PRODUCTION' AND is_test IS FALSE`,
        [input.targetGeoZone, input.targetCategory, input.targetOperatingWindow],
      );
      if (targetResult.rows[0]) structuralReasons.push('target_cell_already_exists');

      const eligibilityReasons: string[] = [];
      if (!['OPEN', 'DENSE'].includes(source.state)) eligibilityReasons.push('source_not_open_or_dense');
      if (!source.expansion_eligible) eligibilityReasons.push('source_not_expansion_eligible');
      if (source.policy_version !== LIQUIDITY_CELL_POLICY_VERSION) eligibilityReasons.push('source_policy_version_stale');
      if (staleCell(source, requestedAt)) eligibilityReasons.push('source_decision_stale');
      eligibilityReasons.push(...expansionFloorReasons(source, requestedAt));

      let decision: ExpansionDecision = 'DENIED';
      let reasons = [...structuralReasons, ...eligibilityReasons];
      const overrideIsValid = validOverride(input, requestedAt);
      if (structuralReasons.length === 0 && eligibilityReasons.length === 0) {
        decision = 'APPROVED';
        reasons = ['source_expansion_policy_passed'];
      } else if (structuralReasons.length === 0 && input.override && overrideIsValid) {
        decision = 'OVERRIDE_PREPARED';
        reasons = [...eligibilityReasons, 'override_prepared_closed_only'];
      } else if (input.override && !overrideIsValid) {
        reasons.push('override_invalid_or_overlong');
      }
      if (reasons.length === 0) reasons = ['expansion_denied'];

      const requestId = randomUUID();
      const targetCellId = decision === 'DENIED' ? null : randomUUID();
      const sourceMetricsHash = metricsHash(expansionMetrics(source));
      const preparedOverride = decision === 'OVERRIDE_PREPARED' ? input.override! : null;
      const inserted = await query<ExpansionRequestRow>(
        `INSERT INTO liquidity_expansion_requests
           (id,source_cell_id,target_cell_id,actor_id,idempotency_key,request_hash,
            source_metrics_hash,policy_version,adjacency_kind,target_geo_zone,
            target_geography_label,target_category,target_operating_window,decision,reasons,
            override_owner,override_reason,override_expires_at,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18,$19)
         RETURNING id,target_cell_id,request_hash,decision,reasons`,
        [requestId, source.id, targetCellId, actorId, input.idempotencyKey, requestHash,
          sourceMetricsHash, LIQUIDITY_CELL_POLICY_VERSION, adjacencyKind, input.targetGeoZone,
          input.targetGeographyLabel, input.targetCategory, input.targetOperatingWindow,
          decision, JSON.stringify(reasons), preparedOverride?.owner ?? null,
          preparedOverride?.reason ?? null, preparedOverride?.expiresAt ?? null, requestedAt.toISOString()],
      );

      if (targetCellId) {
        const targetState = decision === 'APPROVED' ? 'SEEDING' : 'CLOSED';
        const targetEnabled = decision === 'APPROVED';
        await query(
          `INSERT INTO zone_category_cells
             (id,geo_zone,geography_label,category,operating_window,state,policy_version,
              launch_cell_enabled,green_category,state_reasons,dispatch_allowed,
              public_instant_requests_allowed,expansion_eligible,max_concurrent_dispatches,
              expansion_request_id,environment,is_test,created_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9::jsonb,FALSE,FALSE,FALSE,0,$10,'PRODUCTION',FALSE,$11,$11)`,
          [targetCellId, input.targetGeoZone, input.targetGeographyLabel, input.targetCategory,
            input.targetOperatingWindow, targetState, LIQUIDITY_CELL_POLICY_VERSION,
            targetEnabled, JSON.stringify(reasons), requestId, requestedAt.toISOString()],
        );
        await query(
          `INSERT INTO zone_category_cell_events
             (cell_id,from_state,to_state,policy_version,metrics_hash,reasons,actor_type,actor_id)
           VALUES ($1,NULL,$2,$3,$4,$5::jsonb,'ADMIN',$6)`,
          [targetCellId, targetState, LIQUIDITY_CELL_POLICY_VERSION, sourceMetricsHash,
            JSON.stringify(reasons), actorId],
        );
      }
      return { success: true as const, data: resultFromExpansionRow(inserted.rows[0]!, false) };
    });
  } catch {
    return { success: false, error: { code: 'DB_ERROR', message: 'Adjacent expansion request failed.' } };
  }
}

export const LiquidityCellService = { getPublicSnapshot, recalculateCell, bindTaskToCell, requestAdjacentExpansion };
