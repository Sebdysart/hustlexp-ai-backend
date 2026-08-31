import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/AlphaInstrumentation', () => ({
  AlphaInstrumentation: { emitTrustDeltaApplied: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../../src/services/StreakService', () => ({
  updateStreakOnTaskCompletion: vi.fn().mockResolvedValue({
    success: true,
    data: { streakChanged: false, newStreak: 0 },
  }),
}));

import { db } from '../../src/db.js';
import { XPService } from '../../src/services/XPService.js';

const enabled = process.env.HX_ALLOW_E2E_LIFECYCLE === '1';
const describePg = enabled ? describe : describe.skip;

function assertDisposableDatabase(databaseUrl: string): void {
  const parsed = new URL(databaseUrl);
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
  const disposableName = /(?:e2e|test|startup|clean|baseline)/i.test(parsed.pathname.slice(1));
  if (!loopback || !disposableName) {
    throw new Error(`Refusing XP concurrency test against ${parsed.hostname}/${parsed.pathname.slice(1)}`);
  }
}

describePg('PostgreSQL authoritative daily XP cap', () => {
  const databaseUrl = process.env.DATABASE_URL ?? '';
  const runId = randomUUID();
  const posterId = randomUUID();
  const workerId = randomUUID();
  const taskIds = [randomUUID(), randomUUID(), randomUUID()];
  const escrowIds = [randomUUID(), randomUUID(), randomUUID()];

  beforeAll(async () => {
    assertDisposableDatabase(databaseUrl);
    await db.transaction(async (query) => {
      // Fixtures bypass unrelated lifecycle transition guards. XPService calls
      // below run with every production XP trigger enabled.
      await query('SET LOCAL session_replication_role = replica');
      await query(
        `INSERT INTO users(id,email,full_name,default_mode,trust_tier,current_streak,xp_total,current_level)
         VALUES ($1,$2,'XP Cap Poster','poster',1,0,0,1),
                ($3,$4,'XP Cap Worker','worker',1,0,9999,8)`,
        [
          posterId,
          `xp-cap-poster-${runId}@e2e.invalid`,
          workerId,
          `xp-cap-worker-${runId}@e2e.invalid`,
        ],
      );
      for (let index = 0; index < taskIds.length; index += 1) {
        await query(
          `INSERT INTO tasks(
             id,poster_id,worker_id,title,description,price,state,progress_state,completed_at
           ) VALUES ($1,$2,$3,$4,'Disposable XP cap concurrency witness',100,
             'COMPLETED','COMPLETED',NOW())`,
          [taskIds[index], posterId, workerId, `XP cap witness ${index}`],
        );
        await query(
          `INSERT INTO escrows(id,task_id,amount,platform_fee_cents,state,version)
           VALUES ($1,$2,100,0,'RELEASED',1)`,
          [escrowIds[index], taskIds[index]],
        );
      }
      await query(
        `INSERT INTO xp_ledger(
           user_id,task_id,escrow_id,base_xp,streak_multiplier,trust_multiplier,
           live_mode_multiplier,surge_multiplier,effective_xp,reason,
           user_xp_before,user_xp_after,user_level_before,user_level_after,user_streak_at_award
         ) VALUES ($1,$2,$3,9999,1,1,1,1,9999,'task_completion',0,9999,1,8,0)`,
        [workerId, taskIds[0], escrowIds[0]],
      );
    });
  });

  afterAll(async () => {
    if (!enabled) return;
    await db.transaction(async (query) => {
      await query('SET LOCAL session_replication_role = replica');
      await query('DELETE FROM xp_ledger WHERE user_id=$1', [workerId]);
      await query('DELETE FROM escrows WHERE id=ANY($1::UUID[])', [escrowIds]);
      await query('DELETE FROM tasks WHERE id=ANY($1::UUID[])', [taskIds]);
      await query('DELETE FROM users WHERE id=ANY($1::UUID[])', [[posterId, workerId]]);
    });
  });

  it('allows exactly one of two concurrent cap-minus-one awards', async () => {
    const results = await Promise.all([
      XPService.awardXP({ userId: workerId, taskId: taskIds[1], escrowId: escrowIds[1], baseXP: 1 }),
      XPService.awardXP({ userId: workerId, taskId: taskIds[2], escrowId: escrowIds[2], baseXP: 1 }),
    ]);

    expect(results.filter((result) => result.success)).toHaveLength(1);
    const rejected = results.find((result) => !result.success);
    expect(rejected).toMatchObject({ success: false, error: { code: 'XP_DAILY_CAP' } });

    const authority = await db.query<{
      awarded_today: string;
      candidate_rows: string;
      user_total: number;
    }>(
      `SELECT
         (SELECT COALESCE(SUM(effective_xp),0)::TEXT
            FROM xp_ledger
           WHERE user_id=$1
             AND awarded_at >= DATE_TRUNC('day',NOW() AT TIME ZONE 'UTC')
             AND awarded_at < DATE_TRUNC('day',NOW() AT TIME ZONE 'UTC') + INTERVAL '1 day'
         ) AS awarded_today,
         (SELECT COUNT(*)::TEXT FROM xp_ledger WHERE escrow_id=ANY($2::UUID[])) AS candidate_rows,
         (SELECT xp_total FROM users WHERE id=$1) AS user_total`,
      [workerId, [escrowIds[1], escrowIds[2]]],
    );
    expect(authority.rows[0]).toEqual({
      awarded_today: '10000',
      candidate_rows: '1',
      user_total: 10000,
    });
  });
});
