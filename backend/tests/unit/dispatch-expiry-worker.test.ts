import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db', () => ({ db: { query: vi.fn() } }));
vi.mock('../../src/logger', () => ({
  workerLogger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));
vi.mock('../../src/services/AutomationLifecycleService', () => ({
  AutomationLifecycleService: { expireDue: vi.fn() },
}));
vi.mock('../../src/services/TaskSafetyCheckinService', () => ({
  TaskSafetyCheckinService: { escalateDue: vi.fn() },
}));
vi.mock('../../src/services/TaskSafetyLocationService', () => ({
  TaskSafetyLocationService: { expireDue: vi.fn() },
}));
vi.mock('../../src/services/UnattendedCompletionSweepService', () => ({
  UnattendedCompletionSweepService: { completeDue: vi.fn() },
}));
vi.mock('../../src/services/NotificationDeliveryRecoveryService', () => ({
  NotificationDeliveryRecoveryService: { recoverDue: vi.fn() },
}));
vi.mock('../../src/services/BusinessNotificationDigestService', () => ({
  BusinessNotificationDigestService: { createPreviousWeekDigests: vi.fn() },
}));
vi.mock('../../src/services/MediaUploadFinalizationService', () => ({
  expireMediaUploadReceipts: vi.fn(),
}));

import type { Job } from 'bullmq';
import { processMaintenanceJob } from '../../src/jobs/maintenance-worker';
import { AutomationLifecycleService } from '../../src/services/AutomationLifecycleService';
import { TaskSafetyCheckinService } from '../../src/services/TaskSafetyCheckinService';
import { TaskSafetyLocationService } from '../../src/services/TaskSafetyLocationService';
import { UnattendedCompletionSweepService } from '../../src/services/UnattendedCompletionSweepService';
import { NotificationDeliveryRecoveryService } from '../../src/services/NotificationDeliveryRecoveryService';
import { BusinessNotificationDigestService } from '../../src/services/BusinessNotificationDigestService';
import { expireMediaUploadReceipts } from '../../src/services/MediaUploadFinalizationService';

const expireDue = vi.mocked(AutomationLifecycleService.expireDue);
const escalateDue = vi.mocked(TaskSafetyCheckinService.escalateDue);
const expireSafetyLocations = vi.mocked(TaskSafetyLocationService.expireDue);
const completeUnattended = vi.mocked(UnattendedCompletionSweepService.completeDue);
const recoverNotificationDelivery = vi.mocked(NotificationDeliveryRecoveryService.recoverDue);
const createBusinessDigests = vi.mocked(BusinessNotificationDigestService.createPreviousWeekDigests);
const expireMediaUploads = vi.mocked(expireMediaUploadReceipts);

beforeEach(() => vi.clearAllMocks());

describe('dispatch expiry maintenance worker', () => {
  it('runs a bounded batch', async () => {
    expireDue.mockResolvedValueOnce({
      success: true,
      data: { inspected: 2, expired: 1, blocked: 1, results: [] },
    });
    await processMaintenanceJob({ name: 'dispatch.expire_unfilled', data: { limit: 10_000 } } as Job);
    expect(expireDue).toHaveBeenCalledWith({ limit: 100 });
  });

  it('throws so BullMQ retries a failed batch', async () => {
    expireDue.mockResolvedValueOnce({
      success: false,
      error: { code: 'DB_ERROR', message: 'down' },
    });
    await expect(processMaintenanceJob({ name: 'dispatch.expire_unfilled', data: { limit: 50 } } as Job))
      .rejects.toThrow('DB_ERROR');
  });
});

describe('timed safety check-in maintenance worker', () => {
  it('runs a bounded overdue escalation batch', async () => {
    escalateDue.mockResolvedValueOnce({ escalated: 1, checkinIds: ['checkin-1'] });
    await processMaintenanceJob({
      name: 'safety.escalate_overdue_checkins', data: { limit: 10_000 },
    } as Job);
    expect(escalateDue).toHaveBeenCalledWith(100);
  });
});

describe('safety location evidence maintenance worker', () => {
  it('runs a bounded expiry batch', async () => {
    expireSafetyLocations.mockResolvedValueOnce({ expired: 2, incidentIds: ['incident-1', 'incident-2'] });
    await processMaintenanceJob({
      name: 'safety.expire_location_evidence', data: { limit: 10_000 },
    } as Job);
    expect(expireSafetyLocations).toHaveBeenCalledWith(100);
  });
});

describe('unattended completion maintenance worker', () => {
  it('runs a bounded due-task sweep', async () => {
    completeUnattended.mockResolvedValueOnce({ inspected: 1, completed: 1, blocked: 0, results: [] });
    await processMaintenanceJob({ name: 'completion.complete_due', data: { limit: 10_000 } } as Job);
    expect(completeUnattended).toHaveBeenCalledWith(100);
  });
});

describe('media upload expiry maintenance worker', () => {
  it('runs a bounded raw and canonical object cleanup batch', async () => {
    expireMediaUploads.mockResolvedValueOnce({ expired: 2, failed: 0 });
    await processMaintenanceJob({ name: 'media.expire_uploads', data: { limit: 10_000 } } as Job);
    expect(expireMediaUploads).toHaveBeenCalledWith(100);
  });

  it('throws so BullMQ retries any object cleanup failure', async () => {
    expireMediaUploads.mockResolvedValueOnce({ expired: 1, failed: 1 });
    await expect(
      processMaintenanceJob({ name: 'media.expire_uploads', data: { limit: 50 } } as Job),
    ).rejects.toThrow('1 object cleanup failure');
  });
});

describe('notification delivery maintenance worker', () => {
  it('runs a bounded missing-outbox recovery sweep', async () => {
    recoverNotificationDelivery.mockResolvedValueOnce({
      inspected: 2, recovered: 1, failed: 1, skipped: 0,
    });
    await processMaintenanceJob({
      name: 'notification.recover_due', data: { limit: 10_000 },
    } as Job);
    expect(recoverNotificationDelivery).toHaveBeenCalledWith(100);
  });
});

describe('business digest maintenance worker', () => {
  it('runs a bounded operational digest batch', async () => {
    createBusinessDigests.mockResolvedValueOnce({ inspected: 2, created: 2, skipped: 0, failed: 0 });
    await processMaintenanceJob({
      name: 'notification.business_weekly_digest', data: { limit: 10_000 },
    } as Job);
    expect(createBusinessDigests).toHaveBeenCalledWith(expect.any(Date), 100);
  });
});
