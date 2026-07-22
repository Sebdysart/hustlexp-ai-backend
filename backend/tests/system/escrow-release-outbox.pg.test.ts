import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

const enabled = process.env.HX_ALLOW_E2E_LIFECYCLE === '1';
const describePg = enabled ? describe : describe.skip;

function assertDisposableDatabase(databaseUrl: string): void {
  const parsed = new URL(databaseUrl);
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
  const disposableName = /(?:e2e|test|startup)/i.test(parsed.pathname.slice(1));
  if (!loopback || !disposableName) {
    throw new Error(
      `Refusing lifecycle database test against non-disposable target ${parsed.hostname}/${parsed.pathname.slice(1)}`,
    );
  }
}

describePg('PostgreSQL escrow release outbox contract', () => {
  const databaseUrl = process.env.DATABASE_URL ?? '';
  const client = new Client({ connectionString: databaseUrl });
  const posterId = randomUUID();
  const workerId = randomUUID();
  const taskId = randomUUID();
  const escrowId = randomUUID();
  const outboxKey = `escrow.released:${escrowId}`;
  let connected = false;

  beforeAll(async () => {
    assertDisposableDatabase(databaseUrl);
    await client.connect();
    connected = true;
    await client.query('BEGIN');
    try {
      // Fixture creation bypasses unrelated task-creation gates. The release
      // transition itself runs with every production trigger enabled below.
      await client.query('SET LOCAL session_replication_role = replica');
      await client.query(
        `INSERT INTO users(id, email, full_name)
         VALUES ($1, $2, $3), ($4, $5, $6)`,
        [
          posterId, `poster-${posterId}@e2e.invalid`, 'Poster Trigger Fixture',
          workerId, `worker-${workerId}@e2e.invalid`, 'Worker Trigger Fixture',
        ],
      );
      await client.query(
        `INSERT INTO tasks(
           id, poster_id, worker_id, title, description, price, state, progress_state
         ) VALUES ($1, $2, $3, $4, $5, 5000, 'COMPLETED', 'COMPLETED')`,
        [taskId, posterId, workerId, 'Trigger proof', 'Disposable release trigger proof'],
      );
      await client.query(
        `INSERT INTO escrows(
           id, task_id, amount, platform_fee_cents, state, stripe_transfer_id, version
         ) VALUES ($1, $2, 5000, 1000, 'FUNDED', NULL, 2)`,
        [escrowId, taskId],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });

  afterAll(async () => {
    if (!enabled || !connected) return;
    await client.query('BEGIN');
    try {
      await client.query('SET LOCAL session_replication_role = replica');
      await client.query('DELETE FROM revenue_ledger WHERE escrow_id = $1', [escrowId]);
      await client.query('DELETE FROM outbox_events WHERE aggregate_id = $1', [escrowId]);
      await client.query('DELETE FROM escrow_events WHERE escrow_id = $1', [escrowId]);
      await client.query('DELETE FROM escrows WHERE id = $1', [escrowId]);
      await client.query('DELETE FROM tasks WHERE id = $1', [taskId]);
      await client.query('DELETE FROM users WHERE id IN ($1, $2)', [posterId, workerId]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      await client.end();
    }
  });

  it('commits and rolls back the release state and reconciliation outbox atomically', async () => {
    await client.query('BEGIN');
    await client.query(
      `UPDATE escrows
       SET state = 'RELEASED', stripe_transfer_id = 'tr_trigger_exact', version = version + 1
       WHERE id = $1`,
      [escrowId],
    );
    const inside = await client.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM outbox_events WHERE idempotency_key = $1',
      [outboxKey],
    );
    expect(inside.rows[0].count).toBe('1');
    await client.query('ROLLBACK');

    const rolledBack = await client.query<{ state: string; count: string }>(
      `SELECT e.state,
              (SELECT COUNT(*)::text FROM outbox_events o WHERE o.idempotency_key = $2) AS count
       FROM escrows e WHERE e.id = $1`,
      [escrowId, outboxKey],
    );
    expect(rolledBack.rows[0]).toEqual({ state: 'FUNDED', count: '0' });

    await client.query(
      `UPDATE escrows
       SET state = 'RELEASED', stripe_transfer_id = 'tr_trigger_exact', version = version + 1
       WHERE id = $1`,
      [escrowId],
    );
    const committed = await client.query<{
      state: string;
      stripe_transfer_id: string;
      event_type: string;
      queue_name: string;
      status: string;
      count: string;
    }>(
      `SELECT e.state, e.stripe_transfer_id, o.event_type, o.queue_name, o.status,
              (SELECT COUNT(*)::text FROM outbox_events x WHERE x.idempotency_key = o.idempotency_key) AS count
       FROM escrows e
       JOIN outbox_events o ON o.idempotency_key = $2
       WHERE e.id = $1`,
      [escrowId, outboxKey],
    );
    expect(committed.rows[0]).toEqual({
      state: 'RELEASED',
      stripe_transfer_id: 'tr_trigger_exact',
      event_type: 'escrow.released',
      queue_name: 'critical_payments',
      status: 'pending',
      count: '1',
    });
  });

  it('enforces one platform-fee ledger row per escrow across different Stripe envelopes', async () => {
    await client.query(
      `INSERT INTO revenue_ledger(
         event_type, user_id, task_id, amount_cents, gross_amount_cents,
         platform_fee_cents, net_amount_cents, escrow_id, stripe_event_id
       ) VALUES ('platform_fee', $1, $2, 1000, 5000, 1000, 4000, $3, $4)`,
      [posterId, taskId, escrowId, `evt-fee-${randomUUID()}`],
    );
    await expect(client.query(
      `INSERT INTO revenue_ledger(
         event_type, user_id, task_id, amount_cents, gross_amount_cents,
         platform_fee_cents, net_amount_cents, escrow_id, stripe_event_id
       ) VALUES ('platform_fee', $1, $2, 1000, 5000, 1000, 4000, $3, $4)`,
      [posterId, taskId, escrowId, `evt-fee-${randomUUID()}`],
    )).rejects.toMatchObject({ code: '23505' });
  });
});
