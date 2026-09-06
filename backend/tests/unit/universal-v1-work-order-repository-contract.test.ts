import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import type {
  ProviderInterestContext,
  WorkOrderContext,
} from '../../src/services/UniversalV1WorkOrderContracts.js';
import {
  PostgresUniversalV1WorkOrderRepository,
  type WorkOrderMaterializationPhase,
} from '../../src/services/UniversalV1WorkOrderPostgresRepository.js';

const source = readFileSync(
  new URL('../../src/services/UniversalV1WorkOrderPostgresRepository.ts', import.meta.url),
  'utf8'
);
const token = 'a'.repeat(64);
const clientTimestamp = '2026-09-01T12:00:00.000Z';
const ids = {
  draft: '20000000-0000-4000-8000-000000000001',
  task: '20000000-0000-4000-8000-000000000002',
  scope: '20000000-0000-4000-8000-000000000003',
  route: '20000000-0000-4000-8000-000000000004',
  provider: '20000000-0000-4000-8000-000000000005',
  predecessor: '20000000-0000-4000-8000-000000000006',
  interest: '20000000-0000-4000-8000-000000000007',
  eligibility: '20000000-0000-4000-8000-000000000008',
  hold: '20000000-0000-4000-8000-000000000009',
  estimate: '20000000-0000-4000-8000-000000000010',
  poster: '20000000-0000-4000-8000-000000000011',
  workOrder: '20000000-0000-4000-8000-000000000012',
  secured: '20000000-0000-4000-8000-000000000013',
  compensation: '20000000-0000-4000-8000-000000000014',
  securedOperation: '20000000-0000-4000-8000-000000000015',
  voidOperation: '20000000-0000-4000-8000-000000000016',
};
const interestContext: ProviderInterestContext = {
  task_id: ids.task,
  task_draft_id: ids.draft,
  scope_version_id: ids.scope,
  scope_version: 3,
  routing_decision_id: ids.route,
  provider_user_id: ids.provider,
  provider_organization_id: null,
  provider_class: 'GENERAL_SERVICE_PROVIDER',
  trade_credential_id: null,
  predecessor_eligibility_id: ids.predecessor,
  predecessor_eligibility_version: 2,
  predecessor_valid_until: '2026-09-01T12:05:00.000Z',
};
const workOrderContext: WorkOrderContext = {
  ...interestContext,
  poster_user_id: ids.poster,
  interest_application_id: ids.interest,
  eligibility_decision_id: ids.eligibility,
  eligibility_version: 3,
  eligibility_valid_until: '2026-09-01T12:05:00.000Z',
  conditional_hold_id: ids.hold,
  hold_reserved_at: clientTimestamp,
  hold_expires_at: '2026-09-01T12:05:00.000Z',
  provider_estimate_submission_id: ids.estimate,
  customer_total_cents: 12_500,
  currency: 'USD',
};
const idempotencyKey = 'work-order:sealed-port:0001';
const requestSha256 = 'b'.repeat(64);

function repositoryWith(rows: readonly Record<string, unknown>[]) {
  const query = vi.fn().mockResolvedValue({ rows, rowCount: rows.length });
  const serializableTransaction = vi.fn(async (run: (queryFn: typeof query) => Promise<unknown>) =>
    run(query)
  );
  return {
    query,
    serializableTransaction,
    repository: new PostgresUniversalV1WorkOrderRepository({ serializableTransaction } as never),
  };
}

describe('Universal V1 Work Order sealed repository ports', () => {
  it('contains no protected direct DML, actor setting, or legacy lock path', () => {
    expect(source).not.toMatch(
      /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE)\s+(?:public\.)?(?:task_work_order_command_requests|task_provider_eligibility_decisions|task_work_orders|task_work_order_execution_facts|task_reservations|task_applications)\b/iu
    );
    expect(source).not.toContain('set_config(');
    expect(source).not.toContain('lock_universal_v1_estimate_authority');
    for (const port of [
      'hxos_express_universal_v1_post_estimate_interest_v1',
      'hxos_place_universal_v1_conditional_hold_v1',
      'hxos_prepare_universal_v1_fake_work_order_v1',
      'hxos_materialize_universal_v1_fake_work_order_v1',
      'hxos_request_universal_v1_fake_work_order_recovery_v1',
    ]) {
      expect(source).toContain(`public.${port}`);
    }
  });

  it('routes interest and hold through exact token, version, idempotency, and timestamp bindings', async () => {
    const interest = repositoryWith([
      {
        interest_application_id: ids.interest,
        eligibility_decision_id: ids.eligibility,
        eligibility_version: 3,
        replayed: false,
        hard_assignment_created: false,
        payment_creation_performed: false,
      },
    ]);
    await expect(
      interest.repository.express(interestContext, token, idempotencyKey, clientTimestamp)
    ).resolves.toEqual({
      interest_application_id: ids.interest,
      eligibility_decision_id: ids.eligibility,
      eligibility_version: 3,
      replayed: false,
    });
    expect(interest.query.mock.calls[0]![1]).toEqual([
      token,
      ids.task,
      3,
      idempotencyKey,
      clientTimestamp,
    ]);

    const hold = repositoryWith([
      {
        conditional_hold_id: ids.hold,
        expires_at: '2026-09-01T12:05:00.000Z',
        replayed: true,
        hard_assignment_created: false,
        payment_creation_performed: false,
      },
    ]);
    await expect(
      hold.repository.hold(workOrderContext, token, idempotencyKey, clientTimestamp)
    ).resolves.toEqual({
      conditional_hold_id: ids.hold,
      expires_at: '2026-09-01T12:05:00.000Z',
      replayed: true,
    });
    expect(hold.query.mock.calls[0]![1]).toEqual([
      token,
      ids.interest,
      3,
      idempotencyKey,
      clientTimestamp,
    ]);
  });

  it('maps one sealed Phase-A witness without trusting caller-supplied domain context', async () => {
    const setup = repositoryWith([
      {
        completed: false,
        work_order_id: null,
        financial_security_event_id: null,
        ...workOrderContext,
        idempotency_key: idempotencyKey,
        request_sha256: requestSha256,
        occurred_at: clientTimestamp,
        replayed: false,
        hard_assignment_created: false,
        payment_creation_performed: false,
      },
    ]);
    await expect(
      setup.repository.prepareMaterialization(
        workOrderContext,
        idempotencyKey,
        token,
        clientTimestamp
      )
    ).resolves.toEqual({
      completed: false,
      context: workOrderContext,
      idempotencyKey,
      requestSha256,
      occurredAt: clientTimestamp,
    });
    expect(setup.query.mock.calls[0]![1]).toEqual([
      token,
      ids.hold,
      3,
      idempotencyKey,
      clientTimestamp,
    ]);
  });

  it('routes materialization and recovery through separate one-time assertions', async () => {
    const phase: Extract<WorkOrderMaterializationPhase, { completed: false }> = {
      completed: false,
      context: workOrderContext,
      idempotencyKey,
      requestSha256,
      occurredAt: clientTimestamp,
    };
    const materialize = repositoryWith([
      {
        work_order_id: ids.workOrder,
        financial_security_event_id: ids.secured,
        replayed: false,
        hard_assignment_created: false,
        payment_creation_performed: false,
      },
    ]);
    await expect(
      materialize.repository.finalizeMaterialization(phase, ids.secured, token)
    ).resolves.toEqual({
      work_order_id: ids.workOrder,
      financial_security_event_id: ids.secured,
      replayed: false,
      hard_assignment_created: false,
      payment_creation_performed: false,
    });
    expect(materialize.query.mock.calls[0]![1]).toEqual([
      token,
      idempotencyKey,
      requestSha256,
      ids.secured,
    ]);

    const recovery = repositoryWith([
      {
        completed: false,
        work_order_id: null,
        financial_security_event_id: null,
        compensation_command_id: ids.compensation,
        work_order_idempotency_key: idempotencyKey,
        task_draft_id: ids.draft,
        task_id: ids.task,
        scope_version_id: ids.scope,
        eligibility_decision_id: ids.eligibility,
        compensation_secured_event_id: ids.secured,
        secured_operation_id: ids.securedOperation,
        void_operation_id: ids.voidOperation,
        void_idempotency_key: `${idempotencyKey}:void`,
        amount_cents: '12500',
        currency: 'USD',
        requested_by: ids.poster,
        created_at: clientTimestamp,
        replayed: false,
        hard_assignment_created: false,
        payment_creation_performed: false,
      },
    ]);
    await expect(
      recovery.repository.claimMaterializationCompensation(phase, ids.secured, token)
    ).resolves.toEqual({
      completed: false,
      command: {
        compensation_command_id: ids.compensation,
        work_order_idempotency_key: idempotencyKey,
        task_draft_id: ids.draft,
        task_id: ids.task,
        scope_version_id: ids.scope,
        eligibility_decision_id: ids.eligibility,
        secured_event_id: ids.secured,
        secured_operation_id: ids.securedOperation,
        void_operation_id: ids.voidOperation,
        void_idempotency_key: `${idempotencyKey}:void`,
        amount_cents: 12_500,
        currency: 'USD',
        requested_by: ids.poster,
        created_at: clientTimestamp,
      },
    });
  });

  it('fails before PostgreSQL for a caller UUID masquerading as an assertion', async () => {
    const setup = repositoryWith([]);
    await expect(
      setup.repository.express(interestContext, ids.provider, idempotencyKey, clientTimestamp)
    ).rejects.toMatchObject({ code: 'WORK_ORDER_AUTHORITY_REVOKED' });
    expect(setup.query).not.toHaveBeenCalled();
  });
});
