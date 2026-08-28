import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Database } from '../../src/db.js';
import {
  assertSyntheticFinancialWebhookHmac,
  SyntheticFinancialCommandAuthority,
} from '../../src/services/payment/SyntheticFinancialCommandAuthority.js';

const query = vi.fn();
const authority = new SyntheticFinancialCommandAuthority({ query } as unknown as Database);
const actorId = '00000000-0000-4000-8000-000000000501';
const draftId = '00000000-0000-4000-8000-000000000502';
const taskId = '00000000-0000-4000-8000-000000000503';
const workOrderId = '00000000-0000-4000-8000-000000000504';

beforeEach(() => vi.clearAllMocks());

describe('SyntheticFinancialCommandAuthority', () => {
  it('requires an unassigned Universal V1 CONTROLLED_TEST task and exact participant', async () => {
    query.mockResolvedValueOnce({ rows: [{ authorized: true }], rowCount: 1 });
    await authority.assertTaskParticipant(actorId, draftId, taskId);

    const [sql, parameters] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("task.automation_classification = 'CONTROLLED_TEST'");
    expect(sql).toContain('task.worker_id IS NULL');
    expect(sql).toContain('draft.universal_contract_version = 1');
    expect(sql).toContain('work_order.provider_user_id = $1');
    expect(parameters).toEqual([actorId, draftId, taskId]);
  });

  it('fails closed when task ownership or the synthetic marker is absent', async () => {
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(authority.assertTaskParticipant(actorId, draftId, taskId))
      .rejects.toThrow('SYNTHETIC_FINANCIAL_AUTHORITY_REFUSED');
  });

  it('requires the exact synthetic Work Order participant for reconciliation', async () => {
    query.mockResolvedValueOnce({ rows: [{ authorized: true }], rowCount: 1 });
    await authority.assertWorkOrderParticipant(actorId, workOrderId);
    const [sql, parameters] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('FROM task_work_orders work_order');
    expect(sql).toContain("task.automation_classification = 'CONTROLLED_TEST'");
    expect(sql).toContain('task.worker_id IS NULL');
    expect(parameters).toEqual([actorId, workOrderId]);

    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(authority.assertWorkOrderParticipant(actorId, workOrderId))
      .rejects.toThrow('SYNTHETIC_FINANCIAL_AUTHORITY_REFUSED');
  });

  it('verifies a bounded fake-provider HMAC and rejects missing or substituted authority', () => {
    const rawBody = JSON.stringify({ providerKind: 'FAKE', operationId: taskId });
    const secret = 'synthetic-webhook-secret-that-is-at-least-32-bytes';
    const signature = createHmac('sha256', secret).update(rawBody).digest('hex');
    expect(() => assertSyntheticFinancialWebhookHmac(rawBody, signature, {
      HX_FAKE_FINANCIAL_WEBHOOK_SECRET: secret,
    })).not.toThrow();
    expect(() => assertSyntheticFinancialWebhookHmac(rawBody, signature, {}))
      .toThrow('WEBHOOK_SECRET_UNAVAILABLE');
    expect(() => assertSyntheticFinancialWebhookHmac(rawBody, '0'.repeat(64), {
      HX_FAKE_FINANCIAL_WEBHOOK_SECRET: secret,
    })).toThrow('WEBHOOK_HMAC_INVALID');
  });

  it('binds fake webhooks to an existing controlled-test operation recorded by a participant', async () => {
    query.mockResolvedValueOnce({ rows: [{ authorized: true }], rowCount: 1 });
    await authority.assertWebhookOperationBoundary(draftId, taskId, workOrderId);
    const [sql, parameters] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('FROM task_financial_operations operation');
    expect(sql).toContain("operation.provider_kind = 'FAKE'");
    expect(sql).toContain('FROM task_financial_security_events event');
    expect(sql).toContain('event.recorded_by = draft.poster_user_id');
    expect(sql).toContain("task.automation_classification = 'CONTROLLED_TEST'");
    expect(parameters).toEqual([draftId, taskId, workOrderId]);

    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(authority.assertWebhookOperationBoundary(draftId, taskId, workOrderId))
      .rejects.toThrow('WEBHOOK_OPERATION_OR_SYNTHETIC_BOUNDARY');
  });
});
