/**
 * N6 Mutation Eligibility Invariants
 *
 * Proves that direct task-ID mutations cannot bypass the same authoritative
 * policy used by discovery, and that PostgreSQL rejects every transition into
 * ACCEPTED when worker authority is invalid.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { taskRouter } from '../../src/routers/task';
import type { User } from '../../src/types';
import {
  createTestEscrow,
  createTestPool,
  createTestTask,
  createTestUser,
  hasDb,
} from '../setup';

let pool: pg.Pool;

async function userRow(userId: string): Promise<User> {
  const result = await pool.query<User>('SELECT * FROM users WHERE id = $1', [userId]);
  if (!result.rows[0]) throw new Error(`Missing test user ${userId}`);
  return result.rows[0];
}

async function createWorker(): Promise<string> {
  const worker = await createTestUser(pool);
  await pool.query(
    `UPDATE users
     SET default_mode = 'worker', trust_tier = 2,
         date_of_birth = DATE '1990-01-01', is_minor = FALSE,
         is_banned = FALSE, trust_hold = FALSE, trust_hold_until = NULL,
         account_status = 'ACTIVE', plan = 'free',
         is_verified = TRUE,
         phone = '+1206' || substr(replace(id::text, '-', ''), 1, 7),
         stripe_connect_id = 'acct_test_' || replace(id::text, '-', ''),
         payouts_enabled = TRUE
     WHERE id = $1`,
    [worker.id],
  );
  await pool.query(
    `INSERT INTO capability_profiles
       (user_id, trust_tier, risk_clearance, location_state, location_city, updated_at)
     VALUES ($1, 2, ARRAY['low','medium']::text[], 'WA', 'Seattle', NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       trust_tier = 2,
       risk_clearance = ARRAY['low','medium']::text[],
       updated_at = NOW()`,
    [worker.id],
  );
  return worker.id;
}

async function createPoster(): Promise<string> {
  const poster = await createTestUser(pool);
  await pool.query(
    `UPDATE users
     SET default_mode = 'poster', date_of_birth = DATE '1990-01-01', is_minor = FALSE
     WHERE id = $1`,
    [poster.id],
  );
  return poster.id;
}

async function createDecisionReadyTask(
  posterId: string,
  funded = true,
  policy: {
    cancellationPolicyVersion?: string;
    mutualConsentRequired?: boolean;
    mutualConsentAccepted?: boolean;
  } = {},
): Promise<string> {
  const task = await createTestTask(pool, { posterId, ...policy });
  if (funded) await createTestEscrow(pool, task.id, 'FUNDED');
  return task.id;
}

async function createOffer(taskId: string, workerId: string): Promise<void> {
  await pool.query(
    `INSERT INTO worker_offer_decisions (
       task_id, worker_id, policy_version, payload_hash, decision_ready,
       blocking_reasons, customer_total_cents, payout_cents,
       estimated_net_hourly_cents, distance_miles, estimated_duration_minutes,
       scope_hash, cancellation_policy_version, rank_score, rank_reasons,
       snapshot, expires_at
     )
     SELECT id, $2, 'hx-n6-v1', repeat('d', 64), TRUE,
            '[]', price, hustler_payout_cents,
            hustler_payout_cents, 1, estimated_duration_minutes,
            scope_hash, cancellation_policy_version, 1, '[]', '{}',
            NOW() + INTERVAL '1 hour'
     FROM tasks WHERE id = $1`,
    [taskId, workerId],
  );
}

function caller(user: User) {
  return taskRouter.createCaller({
    user,
    firebaseUid: `n6-${user.id}`,
    ip: '127.0.0.1',
  });
}

async function expectAcceptRejected(
  mutateWorker: (workerId: string, taskId: string, posterId: string) => Promise<void>,
  errorMarker: string,
): Promise<void> {
  const posterId = await createPoster();
  const workerId = await createWorker();
  const taskId = await createDecisionReadyTask(posterId);
  await createOffer(taskId, workerId);
  await mutateWorker(workerId, taskId, posterId);

  await expect(
    pool.query(
      `UPDATE tasks SET state = 'ACCEPTED', worker_id = $2, accepted_at = NOW()
       WHERE id = $1`,
      [taskId, workerId],
    ),
  ).rejects.toMatchObject({ code: 'P0001', message: expect.stringContaining(errorMarker) });
  await expect(pool.query('SELECT state, worker_id FROM tasks WHERE id = $1', [taskId]))
    .resolves.toMatchObject({ rows: [{ state: 'OPEN', worker_id: null }] });
}

beforeAll(async () => {
  if (!hasDb) return;
  pool = createTestPool();
});

afterAll(async () => {
  if (pool) await pool.end();
});

describe.skipIf(!hasDb)('INV-N6 mutation eligibility authority', () => {
  it('allows an eligible worker to apply once and atomically rejects replay', async () => {
    const posterId = await createPoster();
    const workerId = await createWorker();
    const taskId = await createDecisionReadyTask(posterId);
    const workerCaller = caller(await userRow(workerId));

    await expect(workerCaller.applyForTask({ taskId, message: 'Ready to help' }))
      .resolves.toMatchObject({ taskId, status: 'pending' });
    await expect(workerCaller.applyForTask({ taskId, message: 'Replay' }))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    const applications = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM task_applications
       WHERE task_id = $1 AND hustler_id = $2 AND status = 'pending'`,
      [taskId, workerId],
    );
    expect(applications.rows[0].count).toBe('1');
  });

  it('uses current database authority even when the request context is stale', async () => {
    const posterId = await createPoster();
    const workerId = await createWorker();
    const taskId = await createDecisionReadyTask(posterId);
    const staleCaller = caller(await userRow(workerId));
    await pool.query('UPDATE users SET is_banned = TRUE WHERE id = $1', [workerId]);

    await expect(staleCaller.applyForTask({ taskId }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    const applications = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM task_applications WHERE task_id = $1',
      [taskId],
    );
    expect(applications.rows[0].count).toBe('0');
  });

  it.each([
    ['minor account', 'HXWE4', async (workerId: string) => {
      await pool.query('UPDATE users SET is_minor = TRUE WHERE id = $1', [workerId]);
    }],
    ['active trust hold', 'HXWE5', async (workerId: string) => {
      await pool.query(
        `UPDATE users SET trust_hold = TRUE, trust_hold_until = NOW() + INTERVAL '1 hour' WHERE id = $1`,
        [workerId],
      );
    }],
    ['payout disabled', 'HXWE6', async (workerId: string) => {
      await pool.query('UPDATE users SET payouts_enabled = FALSE WHERE id = $1', [workerId]);
    }],
    ['missing capability authority', 'HXWE3', async (workerId: string) => {
      await pool.query('DELETE FROM capability_profiles WHERE user_id = $1', [workerId]);
    }],
    ['stale capability trust', 'HXWE7', async (workerId: string) => {
      await pool.query('UPDATE users SET trust_tier = 1 WHERE id = $1', [workerId]);
    }],
  ] as const)('database acceptance rejects %s', async (_label, marker, mutation) => {
    await expectAcceptRejected(async workerId => mutation(workerId), marker);
  });

  it('makes Tier 0 browse-only at the acceptance boundary', async () => {
    await expectAcceptRejected(async (workerId) => {
      await pool.query('UPDATE users SET trust_tier = 0 WHERE id = $1', [workerId]);
      await pool.query('UPDATE capability_profiles SET trust_tier = 0 WHERE user_id = $1', [workerId]);
    }, 'HXWE15');
  });

  it('database acceptance rejects a legacy task without a v2 template-policy witness', async () => {
    const posterId = await createPoster();
    const workerId = await createWorker();
    const taskId = await createDecisionReadyTask(posterId, true, {
      cancellationPolicyVersion: 'task-template-v1:standard_physical',
    });
    await createOffer(taskId, workerId);
    await expect(
      pool.query(`UPDATE tasks SET state = 'ACCEPTED', worker_id = $2 WHERE id = $1`, [taskId, workerId]),
    ).rejects.toMatchObject({ code: 'P0001', message: expect.stringContaining('HXTP2') });
  });

  it('database acceptance rejects consent-required work without atomic consent', async () => {
    const posterId = await createPoster();
    const workerId = await createWorker();
    const taskId = await createDecisionReadyTask(posterId, true, {
      mutualConsentRequired: true,
      mutualConsentAccepted: false,
    });
    await createOffer(taskId, workerId);
    await expect(
      pool.query(`UPDATE tasks SET state = 'ACCEPTED', worker_id = $2 WHERE id = $1`, [taskId, workerId]),
    ).rejects.toMatchObject({ code: 'P0001', message: expect.stringContaining('HXTP3') });
  });

  it('database rejects post-create template policy mutation', async () => {
    const taskId = await createDecisionReadyTask(await createPoster());
    await expect(
      pool.query('UPDATE tasks SET trust_tier_required = 4 WHERE id = $1', [taskId]),
    ).rejects.toMatchObject({ code: 'P0001', message: expect.stringContaining('HXTP1') });
  });

  it('database acceptance rejects unfunded work', async () => {
    const posterId = await createPoster();
    const workerId = await createWorker();
    const taskId = await createDecisionReadyTask(posterId, false);
    await createOffer(taskId, workerId);
    await expect(
      pool.query(`UPDATE tasks SET state = 'ACCEPTED', worker_id = $2 WHERE id = $1`, [taskId, workerId]),
    ).rejects.toMatchObject({ code: 'P0001', message: expect.stringContaining('HXWE12') });
  });

  it('database acceptance rejects a worker with an active dispute', async () => {
    await expectAcceptRejected(async (workerId, taskId, posterId) => {
      const escrow = await pool.query<{ id: string }>(
        `SELECT id FROM escrows WHERE task_id = $1 AND state = 'FUNDED' LIMIT 1`,
        [taskId],
      );
      await pool.query(
        `INSERT INTO disputes
           (task_id, escrow_id, initiated_by, poster_id, worker_id, state, reason, description)
         VALUES ($1, $2, $3, $3, $4, 'OPEN', 'OTHER', 'N6 active dispute gate')`,
        [taskId, escrow.rows[0].id, posterId, workerId],
      );
    }, 'HXWE13');
  });

  it('serializes competing poster assignments so exactly one worker wins', async () => {
    const posterId = await createPoster();
    const firstWorker = await createWorker();
    const secondWorker = await createWorker();
    const taskId = await createDecisionReadyTask(posterId);
    const firstCaller = caller(await userRow(firstWorker));
    const secondCaller = caller(await userRow(secondWorker));
    await Promise.all([
      firstCaller.applyForTask({ taskId }),
      secondCaller.applyForTask({ taskId }),
    ]);
    await Promise.all([createOffer(taskId, firstWorker), createOffer(taskId, secondWorker)]);

    const posterCaller = caller(await userRow(posterId));
    const attempts = await Promise.allSettled([
      posterCaller.assignWorker({ taskId, workerId: firstWorker }),
      posterCaller.assignWorker({ taskId, workerId: secondWorker }),
    ]);
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter(result => result.status === 'rejected')).toHaveLength(1);

    const finalTask = await pool.query<{ state: string; worker_id: string }>(
      'SELECT state, worker_id FROM tasks WHERE id = $1',
      [taskId],
    );
    expect(finalTask.rows[0].state).toBe('ACCEPTED');
    expect([firstWorker, secondWorker]).toContain(finalTask.rows[0].worker_id);
    const statuses = await pool.query<{ status: string; count: string }>(
      `SELECT status, COUNT(*)::text AS count FROM task_applications
       WHERE task_id = $1 GROUP BY status ORDER BY status`,
      [taskId],
    );
    expect(statuses.rows).toEqual([
      { status: 'accepted', count: '1' },
      { status: 'rejected', count: '1' },
    ]);
  });
});
