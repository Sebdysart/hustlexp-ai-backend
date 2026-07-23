import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  createNotification: vi.fn(),
}));

vi.mock('../../src/db.js', () => ({ db: { query: mocks.query } }));
vi.mock('../../src/services/NotificationService.js', () => ({
  NotificationService: { createNotification: mocks.createNotification },
}));
vi.mock('../../src/logger.js', () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => log };
  return { logger: log };
});

import { BusinessNotificationDigestService } from '../../src/services/BusinessNotificationDigestService.js';

const NOW = new Date('2026-07-22T12:00:00.000Z');

function digestRow(overrides: Record<string, unknown> = {}) {
  return {
    organization_id: 'org-1',
    display_name: 'Northwest Field Ops',
    user_id: 'user-1',
    completed_count: 4,
    cancelled_count: 1,
    disputed_count: 0,
    active_count: 3,
    upcoming_count: 2,
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('business operational notification digest', () => {
  it('uses a stable closed-week window and active READ_WORKSPACE membership authority', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [digestRow()], rowCount: 1 });
    mocks.createNotification.mockResolvedValueOnce({ success: true, data: { id: 'n-1' } });

    const result = await BusinessNotificationDigestService.createPreviousWeekDigests(NOW, 10_000);

    expect(result).toEqual({ inspected: 1, created: 1, skipped: 0, failed: 0 });
    const [sql, params] = mocks.query.mock.calls[0];
    expect(sql).toContain("organization.status = 'ACTIVE'");
    expect(sql).toContain("membership.status = 'ACTIVE'");
    expect(sql).toContain("business_membership_has_action(organization.id,membership.user_id,'READ_WORKSPACE')");
    expect(sql).toContain('task.business_organization_id');
    expect(params).toEqual([
      new Date('2026-07-13T00:00:00.000Z'),
      new Date('2026-07-20T00:00:00.000Z'),
      new Date('2026-07-27T00:00:00.000Z'),
      100,
    ]);
  });

  it('creates one nonfinancial digest per recipient with deterministic object and dedupe identity', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [digestRow()], rowCount: 1 });
    mocks.createNotification.mockResolvedValueOnce({ success: true, data: { id: 'n-1' } });

    await BusinessNotificationDigestService.createPreviousWeekDigests(NOW, 100);

    expect(mocks.createNotification).toHaveBeenCalledWith({
      userId: 'user-1',
      category: 'business_operational_digest',
      title: 'Weekly operations — Northwest Field Ops',
      body: 'Last week: 4 completed, 1 cancelled, 0 disputed. Now: 3 active, 2 upcoming.',
      deepLink: '/business/org-1/operations?week=2026-07-13',
      channels: ['in_app', 'email'],
      priority: 'LOW',
      objectRef: { type: 'business_week', id: 'org-1:2026-07-13' },
      dedupeKey: 'business-digest:org-1:user-1:2026-07-13',
      metadata: {
        organizationId: 'org-1',
        periodStart: '2026-07-13T00:00:00.000Z',
        periodEnd: '2026-07-20T00:00:00.000Z',
        completedCount: 4,
        cancelledCount: 1,
        disputedCount: 0,
        activeCount: 3,
        upcomingCount: 2,
      },
    });
    const payload = mocks.createNotification.mock.calls[0][0];
    expect(JSON.stringify(payload)).not.toMatch(/cents|settled|refund|invoice/i);
  });

  it('does not create noise when no organization has operational activity', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await expect(BusinessNotificationDigestService.createPreviousWeekDigests(NOW, 100))
      .resolves.toEqual({ inspected: 0, created: 0, skipped: 0, failed: 0 });
    expect(mocks.createNotification).not.toHaveBeenCalled();
  });

  it('isolates preference skips and failures per recipient', async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [digestRow(), digestRow({ user_id: 'user-2' }), digestRow({ user_id: 'user-3' })],
      rowCount: 3,
    });
    mocks.createNotification
      .mockResolvedValueOnce({ success: true, data: { id: 'n-1' } })
      .mockResolvedValueOnce({
        success: false,
        error: { code: 'PREFERENCE_DISABLED', message: 'disabled' },
      })
      .mockRejectedValueOnce(new Error('database unavailable'));

    await expect(BusinessNotificationDigestService.createPreviousWeekDigests(NOW, 100))
      .resolves.toEqual({ inspected: 3, created: 1, skipped: 1, failed: 1 });
  });
});
