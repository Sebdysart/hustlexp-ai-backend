import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db.js';
import { NotificationService } from '../../src/services/NotificationService.js';

const enabled = process.env.HX_ALLOW_NOTIFICATION_PG === '1';
const describePg = enabled ? describe : describe.skip;

function assertDisposableDatabase(databaseUrl: string): void {
  const parsed = new URL(databaseUrl);
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
  const disposableName = /(?:e2e|test|startup|clean|baseline)/i.test(parsed.pathname.slice(1));
  if (!loopback || !disposableName) {
    throw new Error(`Refusing notification batching test against ${parsed.hostname}/${parsed.pathname.slice(1)}`);
  }
}

describePg('notification batching PostgreSQL idempotency', () => {
  const databaseUrl = process.env.DATABASE_URL ?? '';
  const runId = randomUUID();
  const userId = randomUUID();
  const collisionUserId = randomUUID();

  beforeAll(async () => {
    assertDisposableDatabase(databaseUrl);
    await db.query('SELECT 1');
    await db.query(
      `INSERT INTO users(id,email,full_name,default_mode,trust_tier,trust_hold)
       VALUES
         ($1,$3,'Notification Batch PG','poster',2,FALSE),
         ($2,$4,'Notification Batch Collision PG','poster',2,FALSE)`,
      [
        userId,
        collisionUserId,
        `notification-batch-${runId}@e2e.invalid`,
        `notification-batch-collision-${runId}@e2e.invalid`,
      ],
    );
  });

  afterAll(async () => {
    await db.query('DELETE FROM notifications WHERE user_id = ANY($1::UUID[])', [[userId, collisionUserId]])
      .catch(() => undefined);
    await db.query('DELETE FROM users WHERE id = ANY($1::UUID[])', [[userId, collisionUserId]])
      .catch(() => undefined);
  });

  it('persists one batch append for concurrent exact retries and rejects global-key reuse', async () => {
    for (let index = 0; index < 5; index += 1) {
      const accepted = await NotificationService.createNotification({
        userId,
        category: 'new_matching_task',
        title: `Seed task ${index}`,
        body: 'Synthetic frequency seed.',
        deepLink: `/tasks/${runId}-seed-${index}`,
        channels: ['in_app'],
        objectRef: { type: 'task_offer', id: `${runId}-seed-${index}` },
        dedupeKey: `notification-batch:${runId}:seed:${index}`,
      });
      expect(accepted.success).toBe(true);
    }

    const targetBefore = await db.query<{
      id: string;
      body: string;
      group_position: number | null;
    }>(
      `SELECT id,body,group_position
       FROM notifications
       WHERE user_id=$1 AND category='new_matching_task'
       ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );
    const dedupeKey = `notification-batch:${runId}:exact-retry`;
    const input = {
      userId,
      category: 'new_matching_task' as const,
      title: 'One batched task',
      body: 'This producer event must append once.',
      deepLink: `/tasks/${runId}-batched`,
      channels: ['in_app'] as const,
      objectRef: { type: 'task_offer', id: `${runId}-batched` },
      dedupeKey,
    };

    const [first, retry] = await Promise.all([
      NotificationService.createNotification(input),
      NotificationService.createNotification(input),
    ]);
    if (!first.success) {
      throw new Error(`Initial batch failed [${first.error.code}]: ${first.error.message}`);
    }
    if (!retry.success) {
      throw new Error(`Concurrent batch replay failed [${retry.error.code}]: ${retry.error.message}`);
    }
    expect(retry.data.id).toBe(first.data.id);
    expect(first.data.id).toBe(targetBefore.rows[0].id);

    const persisted = await db.query<{
      notifications: string;
      body: string;
      group_position: number | null;
      metadata: Record<string, unknown>;
    }>(
      `SELECT COUNT(*) OVER ()::TEXT AS notifications,body,group_position,metadata
       FROM notifications
       WHERE user_id=$1 AND category='new_matching_task'
       ORDER BY (id=$2) DESC,created_at DESC
       LIMIT 1`,
      [userId, first.data.id],
    );
    const items = persisted.rows[0].metadata.batched_items as Array<Record<string, unknown>>;
    expect(persisted.rows[0].notifications).toBe('5');
    expect(persisted.rows[0].group_position).toBe(targetBefore.rows[0].group_position);
    expect(persisted.rows[0].body.match(/Plus/g)).toHaveLength(1);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      dedupe_key: dedupeKey,
      object_type: 'task_offer',
      object_id: `${runId}-batched`,
    });

    const collision = await NotificationService.createNotification({
      ...input,
      userId: collisionUserId,
      objectRef: { type: 'task_offer', id: `${runId}-different-identity` },
      deepLink: `/tasks/${runId}-different-identity`,
    });
    expect(collision).toMatchObject({ success: false, error: { code: 'INVALID_INPUT' } });

    const unchanged = await db.query<{ batched_count: string }>(
      `SELECT COALESCE(metadata->>'batched_count','0') AS batched_count
       FROM notifications WHERE id=$1`,
      [first.data.id],
    );
    expect(unchanged.rows[0].batched_count).toBe('1');
  });
});
