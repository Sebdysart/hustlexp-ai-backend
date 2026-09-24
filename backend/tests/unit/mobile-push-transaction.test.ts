import { describe, expect, it, vi } from 'vitest';
import type { QueryFn } from '../../src/db.js';

vi.mock('../../src/db.js', () => ({ db: { query: vi.fn(), transaction: vi.fn() } }));
vi.mock('../../src/config.js', () => ({ config: { redis: { restUrl: null, restToken: null } } }));
vi.mock('../../src/logger.js', () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => log };
  return { logger: log };
});

import { NotificationService } from '../../src/services/NotificationService.js';
import { db } from '../../src/db.js';

describe('mobile push outbox isolation', () => {
  it('retains the canonical in-app notification and schedules recovery when push queueing fails', async () => {
    const notificationId = '22222222-2222-4222-8222-222222222222';
    const statements: string[] = [];
    const query = vi.fn(async (sql: string) => {
      statements.push(sql);
      if (sql.includes('FROM notification_preferences')) return { rows: [{ push_enabled: true,
        quiet_hours_enabled: false, category_preferences: {} }], rowCount: 1 };
      if (sql.includes('INSERT INTO notifications')) return { rows: [{ id: notificationId,
        user_id: '11111111-1111-4111-8111-111111111111', category: 'TASK_UPDATED',
        deep_link: '/dashboard', priority: 'MEDIUM', channels: ['in_app', 'push'] }], rowCount: 1 };
      if (sql.includes('INSERT INTO outbox_events')) throw new Error('outbox insert failed');
      return { rows: [], rowCount: 1 };
    });

    await expect(NotificationService.createInTransaction(query as unknown as QueryFn, {
      userId: '11111111-1111-4111-8111-111111111111', type: 'TASK_UPDATED',
      title: 'Update', message: 'A task changed.', actionUrl: '/dashboard',
    })).resolves.toBeUndefined();

    expect(statements.some((sql) => sql.includes('INSERT INTO notifications'))).toBe(true);
    expect(statements).toContain('SAVEPOINT hustlexp_mobile_push_queue');
    expect(statements).toContain('ROLLBACK TO SAVEPOINT hustlexp_mobile_push_queue');
    expect(statements).toContain('RELEASE SAVEPOINT hustlexp_mobile_push_queue');
    expect(statements.some((sql) => sql.includes("SET state = 'retry_pending'"))).toBe(true);
  });

  it('preserves mobile-only delivery when the recovery worker requeues a direct notification', async () => {
    const notificationId = '22222222-2222-4222-8222-222222222222';
    const query = vi.mocked(db.query);
    query.mockReset();
    query.mockImplementation(async (sql) => {
      if (sql.includes('SELECT notification.*, delivery.available_at')) return { rows: [{
        id: notificationId, user_id: '11111111-1111-4111-8111-111111111111',
        category: 'TASK_UPDATED', type: 'TASK_UPDATED', dedupe_key: 'in_app:recipient:event',
        deep_link: '/dashboard', priority: 'MEDIUM', delivery_available_at: new Date(0),
      }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });

    expect(await NotificationService.retryDelivery(notificationId, 'push')).toMatchObject({
      success: true, data: { queued: true },
    });
    const outbox = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO outbox_events'));
    const payload = JSON.parse(String(outbox?.[1]?.[5]));
    expect(payload.data.mobileOnly).toBe('true');
  });

  it('applies default quiet hours before the user saves any preferences', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-24T06:00:00Z')); // 23:00 Pacific daylight time
    try {
      const query = vi.fn(async (sql: string, _params?: unknown[]) => {
        if (sql.includes('FROM notification_preferences')) return { rows: [], rowCount: 0 };
        if (sql.includes('INSERT INTO notifications')) return { rows: [{
          id: '22222222-2222-4222-8222-222222222222',
          user_id: '11111111-1111-4111-8111-111111111111', category: 'TASK_UPDATED',
          deep_link: '/dashboard', priority: 'MEDIUM', channels: ['in_app', 'push'],
        }], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      });
      await NotificationService.createInTransaction(query as unknown as QueryFn, {
        userId: '11111111-1111-4111-8111-111111111111', type: 'TASK_UPDATED',
        title: 'Update', message: 'A task changed.', actionUrl: '/dashboard',
      });
      const insert = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO notifications'));
      expect(insert?.[1]?.[20]).toBe(true);
      expect(insert?.[1]?.[19]).toBeInstanceOf(Date);
      expect((insert?.[1]?.[19] as Date).getTime()).toBeGreaterThan(Date.now());
    } finally {
      vi.useRealTimers();
    }
  });
});
