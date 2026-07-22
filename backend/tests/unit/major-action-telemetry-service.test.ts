import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../src/db.js', () => ({
  db: { query: mocks.query },
}));
vi.mock('../../src/logger.js', () => ({
  logger: { child: () => ({ error: mocks.error }) },
}));

import {
  MajorActionTelemetryService,
  majorActionPayloadHash,
} from '../../src/services/MajorActionTelemetryService.js';
import type { MajorActionRecordInput } from '../../src/services/MajorActionTelemetryTypes.js';

const input: MajorActionRecordInput = {
  eventName: 'execution.task_started',
  actionClass: 'EXECUTION',
  automationClass: 'A2',
  actorRole: 'HUSTLER',
  actorRef: '00000000-0000-4000-8000-000000000001',
  aggregateType: 'task',
  aggregateId: '00000000-0000-4000-8000-000000000002',
  previousLifecycleState: 'EN_ROUTE',
  lifecycleState: 'IN_PROGRESS',
  syncState: 'SERVER_CONFIRMED',
  entrySurface: 'FOCUS_MODE',
  contextSource: 'CANONICAL_ENGINE',
  policyVersion: 'task-execution-state-v1',
  policyApplicability: 'APPLIED',
  modelVersion: 'NOT_APPLICABLE',
  modelApplicability: 'NOT_APPLICABLE',
  riskClass: 'MEDIUM',
  correlationId: 'task:00000000-0000-4000-8000-000000000002',
  causationId: 'task-start:00000000-0000-4000-8000-000000000002',
  idempotencyKey: 'task-start:00000000-0000-4000-8000-000000000002',
  result: 'SUCCESS',
  changeReasonCode: 'WORKER_STARTED_TASK',
  reversible: true,
  sourceTable: 'task_execution_service',
  sourceEventId: '00000000-0000-4000-8000-000000000003',
  occurredAt: '2026-07-20T00:00:00.000Z',
};

describe('MajorActionTelemetryService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('hashes normalized evidence deterministically', () => {
    expect(majorActionPayloadHash({ b: 2, a: { y: 2, x: 1 } }))
      .toBe(majorActionPayloadHash({ a: { x: 1, y: 2 }, b: 2 }));
  });

  it('writes through the database-enforced recorder', async () => {
    mocks.query.mockResolvedValue({ rows: [{ event_id: 'event-1' }] });
    await expect(MajorActionTelemetryService.record(input)).resolves.toEqual({
      success: true,
      data: { eventId: 'event-1' },
    });
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining('record_major_action_event'),
      expect.arrayContaining([
        'execution.task_started', 'EXECUTION', 'HUSTLER',
        'task-execution-state-v1', 'SERVER_CONFIRMED',
      ]),
    );
    const values = mocks.query.mock.calls[0]?.[1] as unknown[];
    expect(values[22]).toMatch(/^[a-f0-9]{64}$/);
    expect(values[27]).toBe('NOT_APPLICABLE');
    expect(values[28]).toBe('NOT_APPLICABLE');
  });

  it('fails closed when an applicable experiment lacks a variant', async () => {
    await expect(MajorActionTelemetryService.record({
      ...input,
      experimentApplicable: true,
    })).resolves.toMatchObject({
      success: false,
      error: { code: 'MAJOR_ACTION_AUDIT_FAILED' },
    });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('maps database replay conflicts to a stable product error', async () => {
    mocks.query.mockRejectedValue(new Error('HXOBS2: idempotency conflict'));
    await expect(MajorActionTelemetryService.record(input)).resolves.toMatchObject({
      success: false,
      error: { code: 'IDEMPOTENCY_CONFLICT' },
    });
  });

  it('records normalized realized outcomes without raw payload input', async () => {
    mocks.query.mockResolvedValue({ rows: [{ outcome_id: 'outcome-1' }] });
    await expect(MajorActionTelemetryService.recordOutcome({
      majorActionEventId: '00000000-0000-4000-8000-000000000003',
      outcomeType: 'PAYOUT_PAID',
      outcomeObjectType: 'cash_out_request',
      outcomeObjectId: '00000000-0000-4000-8000-000000000004',
      realizedResult: 'CONFIRMED',
      realizedAmountCents: 3900,
      currency: 'usd',
      sourceTable: 'worker_cash_out_events',
      sourceEventId: '00000000-0000-4000-8000-000000000005',
      measuredAt: '2026-07-20T00:00:01.000Z',
    })).resolves.toEqual({ success: true, data: { outcomeId: 'outcome-1' } });
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining('record_major_action_outcome'),
      expect.arrayContaining(['PAYOUT_PAID', 3900, 'usd']),
    );
  });
});
