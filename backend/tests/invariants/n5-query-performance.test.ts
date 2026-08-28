/**
 * N5 Query Performance Invariants
 *
 * Uses the production query builder and real PostgreSQL plans. Schema support
 * and execution bounds are separate assertions because a small test fixture
 * may rationally choose a sequential scan even when the correct index exists.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  eligibleTaskCandidatesQuery,
  personalizedFeedQuery,
} from '../../src/services/TaskDiscoveryQueryBuilder';
import { createTestPool, hasDb } from '../setup';

let pool: pg.Pool;

type ExplainDocument = {
  Plan: Record<string, unknown>;
  'Planning Time': number;
  'Execution Time': number;
};

async function explain(sql: string, params: unknown[]): Promise<ExplainDocument> {
  const result = await pool.query<{ 'QUERY PLAN': ExplainDocument[] }>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
    params,
  );
  return result.rows[0]['QUERY PLAN'][0];
}

beforeAll(async () => {
  if (!hasDb) return;
  pool = createTestPool();
  await pool.query(
    `ANALYZE users, tasks, escrows, capability_profiles, verified_trades,
             task_applications, disputes, zone_category_cells, task_matching_scores`,
  );
});

afterAll(async () => {
  if (pool) await pool.end();
});

describe.skipIf(!hasDb)('PERF-N5 canonical feed query hardening', () => {
  it('builds candidate and personalized queries from current authority fields only', () => {
    const userId = '00000000-0000-0000-0000-000000000001';
    const candidate = eligibleTaskCandidatesQuery(userId).sql;
    const personalized = personalizedFeedQuery(userId, {}, 20, 0).sql;

    for (const sql of [candidate, personalized]) {
      expect(sql).toContain('JOIN capability_profiles cp');
      expect(sql).toContain('JOIN escrows feed_escrow');
      expect(sql).toContain('FROM license_verifications license');
      expect(sql).toContain('FROM insurance_verifications insurance');
      expect(sql).toContain('FROM background_checks screening');
      expect(sql).toContain('FROM task_applications application');
      expect(sql).toContain('FROM disputes dispute');
      expect(sql).toContain("t.state = 'OPEN'");
      expect(sql).not.toContain('required_trade');
      expect(sql).not.toContain('t.payout_cents');
      expect(sql).not.toContain('FROM applications a');
    }
  });

  it('has indexes matching every multi-row eligibility hot predicate', async () => {
    const expected = [
      'idx_disputes_worker_active',
      'idx_background_checks_user_clear',
      'idx_escrows_task_state',
      'idx_insurance_verifications_user_status',
      'idx_license_verifications_user_trade',
      'idx_matching_scores_hustler_feed',
      'idx_task_app_active_per_hustler',
      'idx_tasks_actionable_feed',
      'idx_tasks_worker_active',
    ];
    const result = await pool.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef
       FROM pg_indexes
       WHERE schemaname = 'public' AND indexname = ANY($1::text[])
       ORDER BY indexname`,
      [expected],
    );

    expect(result.rows.map(row => row.indexname)).toEqual([...expected].sort());
    expect(result.rows.find(row => row.indexname === 'idx_tasks_actionable_feed')?.indexdef)
      .toContain("WHERE (((state)::text = 'OPEN'::text) AND (worker_id IS NULL))");
    expect(result.rows.find(row => row.indexname === 'idx_task_app_active_per_hustler')?.indexdef)
      .toContain('task_id, hustler_id');
  });

  it('plans and executes the eligibility-bound score candidate query within 1 second', async () => {
    const spec = eligibleTaskCandidatesQuery('00000000-0000-0000-0000-000000000001');
    const plan = await explain(spec.sql, spec.params);

    expect(plan.Plan).toBeDefined();
    expect(Number(plan['Planning Time'])).toBeLessThan(1000);
    expect(Number(plan['Execution Time'])).toBeLessThan(1000);
  });

  it('plans and executes the production personalized feed query within 1 second', async () => {
    const spec = personalizedFeedQuery(
      '00000000-0000-0000-0000-000000000001',
      {},
      20,
      0,
    );
    const plan = await explain(spec.sql, spec.params);

    expect(plan.Plan).toBeDefined();
    expect(Number(plan['Planning Time'])).toBeLessThan(1000);
    expect(Number(plan['Execution Time'])).toBeLessThan(1000);
  });
});
