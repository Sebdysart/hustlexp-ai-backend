/**
 * Read-only liquidity snapshot + 30-day series for the /ops Liquidity tab.
 */
import { db } from '../db.js';
import { logger } from '../logger.js';

const log = logger.child({ service: 'OpsLiquidityService' });

export type LiquiditySnapshot = {
  betaTesters: number;
  activeTasks: number;
  escrowHeldCents: number;
  payoutsPendingCents: number;
  updatedAt: string;
};

export type TimeSeriesPoint = {
  date: string;
  tasksCreated: number;
  tasksCompleted: number;
  escrowHeldCents: number;
  escrowReleasedCents: number;
};

export type OpsLiquidityPayload = {
  snapshot: LiquiditySnapshot;
  series: TimeSeriesPoint[];
};

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function emptySeries(days = 30): TimeSeriesPoint[] {
  const today = new Date();
  const series: TimeSeriesPoint[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - i);
    series.push({
      date: fmtDate(d),
      tasksCreated: 0,
      tasksCompleted: 0,
      escrowHeldCents: 0,
      escrowReleasedCents: 0,
    });
  }
  return series;
}

export async function getOpsLiquidityPayload(): Promise<OpsLiquidityPayload> {
  try {
    const [users, active, held, pending, createdSeries, completedSeries, fundedSeries, releasedSeries] =
      await Promise.all([
        db.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM users'),
        db.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM tasks
           WHERE state NOT IN ('COMPLETED','CANCELLED','EXPIRED')`,
        ),
        db.query<{ cents: string }>(
          `SELECT COALESCE(SUM(amount), 0)::text AS cents FROM escrows
           WHERE state IN ('FUNDED','LOCKED_DISPUTE')`,
        ),
        db.query<{ cents: string }>(
          `SELECT COALESCE(SUM(amount), 0)::text AS cents FROM escrows
           WHERE state = 'FUNDED'`,
        ),
        db.query<{ day: string; count: string }>(
          `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
                  COUNT(*)::text AS count
           FROM tasks
           WHERE created_at >= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '30 days'
           GROUP BY 1`,
        ),
        db.query<{ day: string; count: string }>(
          `SELECT to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
                  COUNT(*)::text AS count
           FROM tasks
           WHERE state = 'COMPLETED'
             AND updated_at >= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '30 days'
           GROUP BY 1`,
        ),
        db.query<{ day: string; cents: string }>(
          `SELECT to_char(COALESCE(funded_at, created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
                  COALESCE(SUM(amount), 0)::text AS cents
           FROM escrows
           WHERE state IN ('FUNDED','LOCKED_DISPUTE','RELEASED','REFUND_PARTIAL')
             AND COALESCE(funded_at, created_at) >= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '30 days'
           GROUP BY 1`,
        ),
        db.query<{ day: string; cents: string }>(
          `SELECT to_char(COALESCE(released_at, updated_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
                  COALESCE(SUM(COALESCE(release_amount, amount)), 0)::text AS cents
           FROM escrows
           WHERE state IN ('RELEASED','REFUND_PARTIAL')
             AND COALESCE(released_at, updated_at) >= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '30 days'
           GROUP BY 1`,
        ),
      ]);

    const series = emptySeries(30);
    const byDate = new Map(series.map((row) => [row.date, row]));
    for (const row of createdSeries.rows) {
      const point = byDate.get(row.day);
      if (point) point.tasksCreated = Number(row.count) || 0;
    }
    for (const row of completedSeries.rows) {
      const point = byDate.get(row.day);
      if (point) point.tasksCompleted = Number(row.count) || 0;
    }
    for (const row of fundedSeries.rows) {
      const point = byDate.get(row.day);
      if (point) point.escrowHeldCents = Number(row.cents) || 0;
    }
    for (const row of releasedSeries.rows) {
      const point = byDate.get(row.day);
      if (point) point.escrowReleasedCents = Number(row.cents) || 0;
    }

    return {
      snapshot: {
        betaTesters: Number(users.rows[0]?.count ?? 0) || 0,
        activeTasks: Number(active.rows[0]?.count ?? 0) || 0,
        escrowHeldCents: Number(held.rows[0]?.cents ?? 0) || 0,
        payoutsPendingCents: Number(pending.rows[0]?.cents ?? 0) || 0,
        updatedAt: new Date().toISOString(),
      },
      series,
    };
  } catch (error) {
    log.error({ err: error }, 'Ops liquidity snapshot failed');
    throw error;
  }
}
