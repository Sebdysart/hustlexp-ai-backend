import { describe, expect, it, vi } from 'vitest';

import { UniversalV1ExecutionApplication } from '../../src/services/UniversalV1ExecutionApplication.js';
import {
  AdvanceUniversalV1WorkOrderExecutionPublicSchema,
  UniversalV1ExecutionError,
  resolveUniversalV1ExecutionTransition,
  universalV1ExecutionRequestSha256,
  type AdvanceUniversalV1WorkOrderExecutionPublic,
  type UniversalV1ExecutionAdvanceResult,
} from '../../src/services/UniversalV1ExecutionContracts.js';

const ids = {
  actor: '10000000-0000-4000-8000-000000000001',
  otherActor: '10000000-0000-4000-8000-000000000002',
  workOrder: '10000000-0000-4000-8000-000000000003',
  task: '10000000-0000-4000-8000-000000000004',
  scope: '10000000-0000-4000-8000-000000000005',
  fact: '10000000-0000-4000-8000-000000000006',
};

const now = Date.parse('2026-08-27T18:00:00.000Z');

function command(
  overrides: Partial<AdvanceUniversalV1WorkOrderExecutionPublic> = {}
): AdvanceUniversalV1WorkOrderExecutionPublic {
  return {
    work_order_id: ids.workOrder,
    action: 'ACKNOWLEDGE',
    expected_execution_version: 1,
    expected_scope_version: 1,
    idempotency_key: 'execution:test:0001',
    client_ts: new Date(now).toISOString(),
    ...overrides,
  };
}

const advanced: UniversalV1ExecutionAdvanceResult = {
  execution_fact_id: ids.fact,
  work_order_id: ids.workOrder,
  task_id: ids.task,
  scope_version_id: ids.scope,
  scope_version: 1,
  execution_version: 2,
  state: 'ACKNOWLEDGED',
  transition_kind: 'ACKNOWLEDGE',
  recorded_at: '2026-08-27T18:00:00.000Z',
  replayed: false,
  hard_assignment_created: false,
  payment_creation_performed: false,
};

describe('Universal V1 execution contracts', () => {
  it('requires a bounded pause reason and rejects reasons on other actions', () => {
    expect(() =>
      AdvanceUniversalV1WorkOrderExecutionPublicSchema.parse(
        command({ action: 'PAUSE_WORK', expected_execution_version: 5 })
      )
    ).toThrow();
    expect(
      AdvanceUniversalV1WorkOrderExecutionPublicSchema.parse(
        command({
          action: 'PAUSE_WORK',
          expected_execution_version: 5,
          reason: '  Waiting for the customer to confirm the revised access window.  ',
        })
      ).reason
    ).toBe('Waiting for the customer to confirm the revised access window.');
    expect(() =>
      AdvanceUniversalV1WorkOrderExecutionPublicSchema.parse(
        command({ reason: 'This must not accompany an acknowledgement.' })
      )
    ).toThrow();
    expect(() =>
      AdvanceUniversalV1WorkOrderExecutionPublicSchema.parse(
        command({ action: 'PAUSE_WORK', reason: 'x'.repeat(501) })
      )
    ).toThrow();
  });

  it.each([
    ['MATERIALIZED', 'ACKNOWLEDGE', 'ACKNOWLEDGED'],
    ['ACKNOWLEDGED', 'MARK_EN_ROUTE', 'EN_ROUTE'],
    ['ACKNOWLEDGED', 'MARK_ARRIVED', 'ARRIVED'],
    ['EN_ROUTE', 'MARK_ARRIVED', 'ARRIVED'],
    ['ACKNOWLEDGED', 'START_WORK', 'IN_PROGRESS'],
    ['ARRIVED', 'START_WORK', 'IN_PROGRESS'],
    ['IN_PROGRESS', 'PAUSE_WORK', 'PAUSED'],
    ['PAUSED', 'RESUME_WORK', 'IN_PROGRESS'],
    ['REWORK_REQUIRED', 'RESUME_REWORK', 'IN_PROGRESS'],
  ] as const)('maps %s + %s to %s on the server', (state, action, expected) => {
    expect(resolveUniversalV1ExecutionTransition(state, action)).toBe(expected);
  });

  it('rejects an action that is not valid from the current state', () => {
    expect(resolveUniversalV1ExecutionTransition('MATERIALIZED', 'START_WORK')).toBeNull();
    expect(resolveUniversalV1ExecutionTransition('COMPLETED', 'RESUME_WORK')).toBeNull();
  });

  it('uses a stable actor-bound command hash', () => {
    const first = command();
    const reordered = {
      client_ts: first.client_ts,
      idempotency_key: first.idempotency_key,
      expected_scope_version: first.expected_scope_version,
      expected_execution_version: first.expected_execution_version,
      action: first.action,
      work_order_id: first.work_order_id,
    } satisfies AdvanceUniversalV1WorkOrderExecutionPublic;

    expect(universalV1ExecutionRequestSha256(ids.actor, first)).toBe(
      universalV1ExecutionRequestSha256(ids.actor, reordered)
    );
    expect(universalV1ExecutionRequestSha256(ids.actor, first)).not.toBe(
      universalV1ExecutionRequestSha256(ids.otherActor, first)
    );

    const uppercaseWorkOrder = command({
      work_order_id: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
    });
    const lowercaseWorkOrder = command({
      work_order_id: uppercaseWorkOrder.work_order_id.toLowerCase(),
    });
    expect(
      universalV1ExecutionRequestSha256('BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB', uppercaseWorkOrder)
    ).toBe(
      universalV1ExecutionRequestSha256('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', lowercaseWorkOrder)
    );
  });
});

describe('UniversalV1ExecutionApplication', () => {
  it('rejects a timestamp beyond five minutes before calling the repository', () => {
    const repository = {
      getWorkOrderExecutionState: vi.fn(),
      advanceWorkOrderExecution: vi.fn(),
    };
    const application = new UniversalV1ExecutionApplication(repository, () => now);

    let rejected: unknown;
    try {
      application.advanceWorkOrderExecution(
        ids.actor,
        command({ client_ts: new Date(now - 5 * 60_000 - 1).toISOString() })
      );
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toMatchObject<Partial<UniversalV1ExecutionError>>({
      code: 'EXECUTION_REQUEST_STALE',
    });
    expect(repository.advanceWorkOrderExecution).not.toHaveBeenCalled();
  });

  it('parses a command and delegates its stable actor-bound hash', async () => {
    const repository = {
      getWorkOrderExecutionState: vi.fn(),
      advanceWorkOrderExecution: vi.fn().mockResolvedValue(advanced),
    };
    const application = new UniversalV1ExecutionApplication(repository, () => now);
    const raw = command({ idempotency_key: '  execution:test:0002  ' });

    const result = await application.advanceWorkOrderExecution(ids.actor, raw);

    const normalized = command({ idempotency_key: 'execution:test:0002' });
    expect(repository.advanceWorkOrderExecution).toHaveBeenCalledWith(
      ids.actor,
      normalized,
      universalV1ExecutionRequestSha256(ids.actor, normalized)
    );
    expect(result).toMatchObject({
      hard_assignment_created: false,
      payment_creation_performed: false,
    });
  });

  it('parses the read boundary and delegates only the opaque Work Order id', async () => {
    const repository = {
      getWorkOrderExecutionState: vi.fn().mockResolvedValue(advanced),
      advanceWorkOrderExecution: vi.fn(),
    };
    const application = new UniversalV1ExecutionApplication(repository, () => now);

    await application.getWorkOrderExecutionState(ids.actor, { work_order_id: ids.workOrder });

    expect(repository.getWorkOrderExecutionState).toHaveBeenCalledWith(ids.actor, ids.workOrder);
  });
});
