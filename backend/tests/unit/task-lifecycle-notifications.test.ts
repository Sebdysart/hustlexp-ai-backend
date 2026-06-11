/**
 * task-lifecycle-notifications.test.ts
 *
 * The lifecycle layer must (1) send the right category/recipient per event and
 * (2) NEVER throw — notification failure must not fail a task/financial mutation.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../../src/services/NotificationService.js', () => ({
  NotificationService: { createNotification: vi.fn() },
}));

vi.mock('../../src/logger', () => {
  const base = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), child: () => base };
  return {
    logger: base, escrowLogger: base, taskLogger: base, aiLogger: base,
    stripeLogger: base, authLogger: base, workerLogger: base, dbLogger: base,
  };
});

import { NotificationService } from '../../src/services/NotificationService.js';
import {
  notifyApplicationReceived,
  notifyWorkerAssigned,
  notifyTaskAccepted,
  notifyProofSubmitted,
  notifyProofRejected,
  notifyTaskCompleted,
  notifyPaymentReleased,
} from '../../src/lib/task-lifecycle-notifications.js';

const create = NotificationService.createNotification as unknown as ReturnType<typeof vi.fn>;
const TASK = '10000000-0000-0000-0000-0000000000cc';

beforeEach(() => {
  vi.clearAllMocks();
  create.mockResolvedValue({ success: true });
});

describe('recipient + category routing', () => {
  it('application received → poster, new_matching_task', async () => {
    await notifyApplicationReceived('poster-1', TASK, 'Move boxes');
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'poster-1', category: 'new_matching_task', taskId: TASK,
    }));
  });

  it('worker assigned → worker, task_accepted, HIGH priority', async () => {
    await notifyWorkerAssigned('worker-1', TASK, 'Move boxes');
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'worker-1', category: 'task_accepted', priority: 'HIGH',
    }));
  });

  it('instant accept → poster, task_accepted', async () => {
    await notifyTaskAccepted('poster-1', TASK, 'Move boxes');
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'poster-1', category: 'task_accepted',
    }));
  });

  it('proof submitted → poster, proof_submitted', async () => {
    await notifyProofSubmitted('poster-1', TASK, 'Move boxes');
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'poster-1', category: 'proof_submitted',
    }));
  });

  it('proof rejected → worker, proof_rejected, includes reason', async () => {
    await notifyProofRejected('worker-1', TASK, 'Move boxes', 'photo is blurry');
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'worker-1', category: 'proof_rejected',
      body: expect.stringContaining('photo is blurry'),
    }));
  });

  it('task completed → worker, task_completed', async () => {
    await notifyTaskCompleted('worker-1', TASK, 'Move boxes');
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'worker-1', category: 'task_completed',
    }));
  });

  it('payment released → worker, payment_released, CRITICAL, formatted dollars', async () => {
    await notifyPaymentReleased('worker-1', TASK, 8300);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'worker-1', category: 'payment_released', priority: 'CRITICAL',
      body: expect.stringContaining('$83.00'),
    }));
  });
});

describe('failure isolation', () => {
  it('NotificationService rejection is swallowed — caller never sees a throw', async () => {
    create.mockRejectedValue(new Error('FCM exploded'));
    await expect(notifyPaymentReleased('worker-1', TASK, 8300)).resolves.toBeUndefined();
    await expect(notifyWorkerAssigned('worker-1', TASK, 'x')).resolves.toBeUndefined();
    await expect(notifyApplicationReceived('poster-1', TASK, 'x')).resolves.toBeUndefined();
  });
});
