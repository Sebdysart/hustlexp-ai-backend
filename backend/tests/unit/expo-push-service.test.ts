import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../src/db.js', () => ({ db: { query: mocks.query } }));
vi.mock('../../src/logger.js', () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => log };
  return { logger: log };
});

import { sendExpoPushForNotification } from '../../src/services/ExpoPushService.js';

const userId = '11111111-1111-4111-8111-111111111111';
const notificationId = '22222222-2222-4222-8222-222222222222';
const deviceId = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  mocks.query.mockReset();
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM notifications n')) return { rows: [{ id: notificationId, type: 'TASK_UPDATED', entity_type: null,
      entity_id: null, action_url: '/dashboard', deep_link: null, push_enabled: true }] };
    if (sql.includes('FROM mobile_push_devices d')) return { rows: [{ id: deviceId, app_variant: 'poster',
      expo_push_token: 'ExpoPushToken[test-token]' }] };
    return { rows: [], rowCount: 1 };
  });
});

describe('Expo push delivery', () => {
  it('sends generic copy only to the destination-owning app and stores the ticket', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ status: 'ok', id: 'ticket-1' }] }) });
    vi.stubGlobal('fetch', fetch);
    expect(await sendExpoPushForNotification(userId, notificationId)).toEqual({ sent: 1, failed: 0, reason: undefined });
    const registrations = mocks.query.mock.calls.find(([sql]) => sql.includes('FROM mobile_push_devices d'));
    expect(registrations?.[0]).toContain("account_status NOT IN ('DELETED', 'SUSPENDED')");
    expect(registrations?.[1]).toEqual([userId, ['poster']]);
    const payload = JSON.parse(fetch.mock.calls[0][1].body);
    expect(payload).toEqual([{ to: 'ExpoPushToken[test-token]', sound: 'default', channelId: 'hustlexp-default',
      priority: 'high', title: 'HustleXP update', body: 'You have a new update. Open the app for details.',
      data: { notificationId, appVariant: 'poster' } }]);
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO mobile_push_receipts'))).toBe(true);
  });

  it('deactivates an invalid token without exposing notification content', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      data: [{ status: 'error', details: { error: 'DeviceNotRegistered' } }],
    }) }));
    expect(await sendExpoPushForNotification(userId, notificationId)).toEqual({ sent: 0, failed: 1, reason: 'provider_error' });
    expect(mocks.query.mock.calls.some(([sql, params]) =>
      sql.includes('UPDATE mobile_push_devices SET is_active = FALSE') && params[0] === deviceId)).toBe(true);
  });

  it('does not retry an already accepted push if storing its receipt fails', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM notifications n')) return { rows: [{ id: notificationId, type: 'TASK_UPDATED', entity_type: null,
        entity_id: null, action_url: '/dashboard', deep_link: null, push_enabled: true }] };
      if (sql.includes('FROM mobile_push_devices d')) return { rows: [{ id: deviceId, app_variant: 'poster',
        expo_push_token: 'ExpoPushToken[test-token]' }] };
      if (sql.includes('INSERT INTO mobile_push_receipts')) throw new Error('database unavailable');
      return { rows: [], rowCount: 1 };
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ status: 'ok', id: 'ticket-1' }] }) }));
    expect(await sendExpoPushForNotification(userId, notificationId)).toEqual({ sent: 1, failed: 0, reason: undefined });
  });

  it('honors a category opt-out made after the notification was queued', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ id: notificationId, type: 'TASK_UPDATED', category: 'task_completed',
      entity_type: null, entity_id: null, action_url: '/dashboard', deep_link: null, push_enabled: true,
      category_preferences: { task_completed: { enabled: false } } }] });
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await sendExpoPushForNotification(userId, notificationId)).toEqual({ sent: 0, failed: 0, reason: 'not_eligible' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
