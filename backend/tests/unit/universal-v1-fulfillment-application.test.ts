import { describe, expect, it, vi } from 'vitest';

import { UniversalV1FulfillmentApplication } from '../../src/services/UniversalV1FulfillmentApplication.js';
import {
  createUniversalContractRouter,
  universalV1EstimateRouteError,
} from '../../src/routers/universalContract.js';
import {
  CompleteUniversalV1FakeFinancialLifecyclePublicSchema,
  DecideUniversalV1CompletionPublicSchema,
  RecordUniversalV1ExecutionEvidencePublicSchema,
  SubmitUniversalV1CompletionEvidencePublicSchema,
  UniversalV1FulfillmentError,
} from '../../src/services/UniversalV1FulfillmentContracts.js';
import type { User } from '../../src/types.js';

const ids = {
  workOrder: '10000000-0000-4000-8000-000000000001',
  completion: '10000000-0000-4000-8000-000000000002',
  delivery: '10000000-0000-4000-8000-000000000003',
};

describe('UniversalV1FulfillmentApplication', () => {
  it('requires durable evidence and exact approval-delivery shape', () => {
    const common = {
      work_order_id: ids.workOrder,
      expected_scope_version: 1,
      expected_execution_version: 4,
      idempotency_key: 'fulfillment:test:0001',
      client_ts: new Date().toISOString(),
    };
    expect(
      RecordUniversalV1ExecutionEvidencePublicSchema.safeParse({
        ...common,
        evidence_kind: 'PROGRESS',
        photo_evidence: [],
      }).success
    ).toBe(false);
    expect(
      SubmitUniversalV1CompletionEvidencePublicSchema.safeParse({
        ...common,
        description: 'Exact completion evidence',
        decision_reason: 'Provider reports the accepted scope complete.',
        photo_evidence: [],
      }).success
    ).toBe(true);
    expect(
      DecideUniversalV1CompletionPublicSchema.safeParse({
        work_order_id: ids.workOrder,
        submitted_completion_fact_id: ids.completion,
        expected_completion_version: 1,
        expected_execution_version: 5,
        decision: 'APPROVED',
        decision_reason: 'Customer accepted the completion evidence.',
        idempotency_key: 'fulfillment:test:0002',
        client_ts: new Date().toISOString(),
      }).success
    ).toBe(false);
    expect(
      DecideUniversalV1CompletionPublicSchema.safeParse({
        work_order_id: ids.workOrder,
        submitted_completion_fact_id: ids.completion,
        expected_completion_version: 1,
        expected_execution_version: 5,
        decision: 'APPROVED',
        delivery_event_id: ids.delivery,
        decision_reason: 'Customer accepted the completion evidence.',
        idempotency_key: 'fulfillment:test:0002',
        client_ts: new Date().toISOString(),
      }).success
    ).toBe(true);
  });

  it('offers only the explicit settled and full-refund fake terminal paths', () => {
    const base = {
      work_order_id: ids.workOrder,
      approved_completion_fact_id: ids.completion,
      expected_financial_version: 2,
      expected_execution_version: 6,
      expected_reconciliation_version: 0,
      idempotency_key: 'fulfillment:test:0003',
      client_ts: new Date().toISOString(),
    };
    expect(
      CompleteUniversalV1FakeFinancialLifecyclePublicSchema.parse({
        ...base,
        path: 'SETTLED',
      }).path
    ).toBe('SETTLED');
    expect(
      CompleteUniversalV1FakeFinancialLifecyclePublicSchema.parse({
        ...base,
        path: 'FULL_REFUND',
      }).path
    ).toBe('FULL_REFUND');
    expect(
      CompleteUniversalV1FakeFinancialLifecyclePublicSchema.safeParse({
        ...base,
        path: 'PAYOUT',
      }).success
    ).toBe(false);
  });

  it('rejects a stale command before consulting persistence', async () => {
    const repository = { recordExecutionEvidence: vi.fn() };
    const application = new UniversalV1FulfillmentApplication(repository as never);
    expect(() =>
      application.recordExecutionEvidence('actor', {
        work_order_id: ids.workOrder,
        expected_scope_version: 1,
        expected_execution_version: 4,
        evidence_kind: 'PROGRESS',
        description: 'Measured progress evidence',
        photo_evidence: [],
        idempotency_key: 'fulfillment:test:0004',
        client_ts: new Date(Date.now() - 10 * 60_000).toISOString(),
      })
    ).toThrow(expect.objectContaining({ code: 'FULFILLMENT_REQUEST_STALE' }));
    expect(repository.recordExecutionEvidence).not.toHaveBeenCalled();
  });

  it('authorizes exact-manifest fake finance before repository delegation', async () => {
    const financeFactory = vi.fn();
    const authorizeFinance = vi.fn().mockReturnValue(financeFactory);
    const repository = {
      completeFakeFinancialLifecycle: vi.fn().mockResolvedValue({
        path: 'SETTLED',
        provider_kind: 'FAKE',
        payment_creation_performed: false,
      }),
    };
    const application = new UniversalV1FulfillmentApplication(
      repository as never,
      authorizeFinance
    );
    const input = {
      work_order_id: ids.workOrder,
      approved_completion_fact_id: ids.completion,
      path: 'SETTLED' as const,
      expected_financial_version: 2,
      expected_execution_version: 6,
      expected_reconciliation_version: 0,
      idempotency_key: 'fulfillment:test:0005',
      client_ts: new Date().toISOString(),
    };
    await application.completeFakeFinancialLifecycle('actor', input);
    expect(authorizeFinance).toHaveBeenCalledOnce();
    expect(repository.completeFakeFinancialLifecycle).toHaveBeenCalledWith(
      'actor',
      input,
      financeFactory
    );
  });

  it('wires the four protected fulfillment commands to the authenticated actor', async () => {
    const user = {
      id: '10000000-0000-4000-8000-000000000099',
      email: 'fulfillment@example.invalid',
      full_name: 'Fulfillment Actor',
      default_mode: 'worker',
      is_minor: false,
      role_was_overridden: false,
      trust_tier: 0,
      trust_hold: false,
      xp_total: 0,
      current_level: 1,
      current_streak: 0,
      is_verified: false,
      student_id_verified: false,
      plan: 'free',
      live_mode_state: 'OFF',
      live_mode_total_tasks: 0,
      daily_active_minutes: 0,
      consecutive_active_days: 0,
      account_status: 'ACTIVE',
    } satisfies User;
    const estimates = {
      issueProviderEstimateInvitation: vi.fn(),
      submitProviderEstimate: vi.fn(),
      acceptProviderEstimate: vi.fn(),
    };
    const workOrders = {
      expressProviderInterest: vi.fn(),
      placeConditionalHold: vi.fn(),
      secureAndMaterializeFakeWorkOrder: vi.fn(),
    };
    const fulfillment = {
      recordExecutionEvidence: vi.fn().mockResolvedValue({ evidence_kind: 'PROGRESS' }),
      submitCompletionEvidence: vi.fn(),
      decideCompletion: vi.fn(),
      completeFakeFinancialLifecycle: vi.fn(),
    };
    const caller = createUniversalContractRouter(estimates, workOrders, fulfillment).createCaller({
      user,
      firebaseUid: 'firebase-fulfillment-actor',
      ip: '203.0.113.44',
    });
    const input = {
      work_order_id: ids.workOrder,
      expected_scope_version: 1,
      expected_execution_version: 4,
      evidence_kind: 'PROGRESS' as const,
      description: 'Measured execution progress.',
      photo_evidence: [],
      idempotency_key: 'fulfillment:test:router:0001',
      client_ts: new Date().toISOString(),
    };
    await expect(caller.recordExecutionEvidence(input)).resolves.toEqual({
      evidence_kind: 'PROGRESS',
    });
    expect(fulfillment.recordExecutionEvidence).toHaveBeenCalledWith(user.id, input);
  });

  it('maps fulfillment authority and invariant failures without raw details', () => {
    expect(
      universalV1EstimateRouteError(
        new UniversalV1FulfillmentError(
          'FULFILLMENT_PROVIDER_AUTHORITY_REVOKED',
          'private membership row detail'
        )
      )
    ).toMatchObject({
      code: 'NOT_FOUND',
      message: 'The Work Order fulfillment action is unavailable.',
    });
    expect(
      universalV1EstimateRouteError(
        new UniversalV1FulfillmentError('FULFILLMENT_INCIDENT_BLOCKED', 'private incident detail')
      )
    ).toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'The Work Order lifecycle action is not currently permitted.',
    });
  });
});
