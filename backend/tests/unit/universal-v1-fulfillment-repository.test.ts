import { describe, expect, it, vi } from 'vitest';

import type { Database, QueryFn } from '../../src/db.js';
import { PostgresUniversalV1FulfillmentRepository } from '../../src/services/UniversalV1FulfillmentPostgresRepository.js';

const ids = {
  workOrder: '10000000-0000-4000-8000-000000000001',
  draft: '10000000-0000-4000-8000-000000000002',
  task: '10000000-0000-4000-8000-000000000003',
  scope: '10000000-0000-4000-8000-000000000004',
  poster: '10000000-0000-4000-8000-000000000005',
  provider: '10000000-0000-4000-8000-000000000006',
  eligibility: '10000000-0000-4000-8000-000000000007',
  secured: '10000000-0000-4000-8000-000000000008',
  proof: '10000000-0000-4000-8000-000000000009',
  submitted: '10000000-0000-4000-8000-000000000010',
  approved: '10000000-0000-4000-8000-000000000011',
  capture: '10000000-0000-4000-8000-000000000012',
  settle: '10000000-0000-4000-8000-000000000013',
  refund: '10000000-0000-4000-8000-000000000014',
  reconciliation: '10000000-0000-4000-8000-000000000015',
  fund: '10000000-0000-4000-8000-000000000016',
  providerRelease: '10000000-0000-4000-8000-000000000017',
  payout: '10000000-0000-4000-8000-000000000018',
  bankSettlement: '10000000-0000-4000-8000-000000000019',
  execution: '10000000-0000-4000-8000-000000000020',
  completionExecution: '10000000-0000-4000-8000-000000000021',
};

const context = {
  work_order_id: ids.workOrder,
  task_draft_id: ids.draft,
  task_id: ids.task,
  scope_version_id: ids.scope,
  scope_version: 1,
  scope_hash: 'a'.repeat(64),
  customer_total_cents: 12_000,
  provider_payout_cents: 9_000,
  currency: 'USD',
  poster_user_id: ids.poster,
  provider_user_id: ids.provider,
  provider_organization_id: null,
  eligibility_decision_id: ids.eligibility,
  financial_security_event_id: ids.secured,
  provider_authority_current: true,
  incident_blocked: false,
  execution_fact_id: ids.execution,
  execution_version: 4,
  execution_state: 'IN_PROGRESS',
};

function databaseFor(query: QueryFn): Database {
  const transaction = async <T>(callback: (bound: QueryFn) => Promise<T>) => callback(query);
  return {
    query,
    readQuery: query,
    transaction,
    serializableTransaction: transaction,
    healthCheck: vi.fn(),
    getPool: vi.fn(),
    getPoolStats: vi.fn(),
    close: vi.fn(),
  } as unknown as Database;
}

function successEvent(operationKind: string) {
  const eventIds: Record<string, string> = {
    CAPTURE: ids.capture,
    SETTLE: ids.settle,
    FUND: ids.fund,
    PROVIDER_RELEASE: ids.providerRelease,
    PAYOUT: ids.payout,
    OBSERVE_BANK_SETTLEMENT: ids.bankSettlement,
    REFUND: ids.refund,
  };
  const operationSuffixes: Record<string, string> = {
    CAPTURE: '01',
    SETTLE: '02',
    FUND: '03',
    PROVIDER_RELEASE: '04',
    PAYOUT: '05',
    OBSERVE_BANK_SETTLEMENT: '06',
    REFUND: '07',
  };
  return {
    id: eventIds[operationKind],
    operationId: `20000000-0000-4000-8000-0000000000${operationSuffixes[operationKind]}`,
    eventKind: operationKind,
    status: 'SUCCEEDED',
    providerKind: 'FAKE',
    externalReference: `fake:${operationKind}`,
    providerOperationVersion: 1,
    lifecycleExpectedVersion: 3,
    idempotencyReplayed: false,
    taskDraftId: ids.draft,
    taskId: ids.task,
    eligibilityDecisionId: ids.eligibility,
    scopeVersionId: ids.scope,
    changeOrderId: null,
    predecessorEventId: ids.secured,
    completionFactId: operationKind === 'CAPTURE' ? ids.approved : null,
    amountCents: ['PROVIDER_RELEASE', 'PAYOUT', 'OBSERVE_BANK_SETTLEMENT'].includes(operationKind)
      ? 9_000
      : 12_000,
    currency: 'USD',
    providerState: 'SUCCEEDED',
    recordedBy: ids.poster,
    occurredAt: new Date().toISOString(),
  };
}

describe('PostgresUniversalV1FulfillmentRepository', () => {
  it('records completion evidence as a Work Order fact without hard assignment', async () => {
    const statements: string[] = [];
    const query = vi.fn(async (sql: string) => {
      statements.push(sql);
      if (sql.includes('SELECT work_order.id AS work_order_id'))
        return { rows: [context], rowCount: 1 };
      if (sql.includes('FROM proofs proof') && sql.includes('client_submission_id'))
        return { rows: [], rowCount: 0 };
      if (sql.includes('FROM task_completion_facts') && sql.includes('ORDER BY completion_version'))
        return { rows: [], rowCount: 0 };
      if (sql.includes('INSERT INTO proofs')) {
        return { rows: [{ id: ids.proof, submitted_at: new Date() }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO task_completion_facts')) {
        return { rows: [{ id: ids.submitted }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO task_work_order_execution_facts')) {
        return { rows: [{ id: ids.completionExecution }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    }) as unknown as QueryFn;
    const repository = new PostgresUniversalV1FulfillmentRepository(databaseFor(query));
    const result = await repository.submitCompletionEvidence(ids.provider, {
      work_order_id: ids.workOrder,
      expected_scope_version: 1,
      expected_execution_version: 4,
      description: 'The exact accepted scope is complete.',
      photo_evidence: [],
      decision_reason: 'Provider submitted completion for customer review.',
      idempotency_key: 'fulfillment:test:repo:0001',
      client_ts: new Date().toISOString(),
    });
    expect(result).toMatchObject({
      proof_id: ids.proof,
      completion_fact_id: ids.submitted,
      completion_version: 1,
      evidence_kind: 'COMPLETION',
      hard_assignment_created: false,
    });
    expect(statements.join('\n')).toContain('work_order_id, evidence_kind');
    expect(statements.join('\n')).not.toMatch(/UPDATE\s+tasks[\s\S]*worker_id/iu);
  });

  it.each([
    [
      'SETTLED',
      ['CAPTURE', 'SETTLE', 'FUND', 'PROVIDER_RELEASE', 'PAYOUT', 'OBSERVE_BANK_SETTLEMENT'],
      ids.settle,
      null,
      'MATCHED',
      12_000,
      9_000,
    ],
    ['FULL_REFUND', ['CAPTURE', 'REFUND'], null, ids.refund, 'CLOSED', 0, 0],
  ] as const)(
    'executes capture then the %s fake path and reconciles in one outer transaction',
    async (
      path,
      expectedOperations,
      expectedSettlementId,
      expectedRefundId,
      expectedReconciliationState,
      expectedCustomerLedger,
      expectedProviderLedger
    ) => {
      const query = vi.fn(async (sql: string) => {
        if (sql.includes('SELECT work_order.id AS work_order_id'))
          return {
            rows: [{ ...context, execution_version: 6, execution_state: 'COMPLETED' }],
            rowCount: 1,
          };
        if (sql.includes('FROM task_reconciliation_facts') && sql.includes('idempotency_key')) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('FROM task_completion_facts completion')) {
          return {
            rows: [
              {
                id: ids.approved,
                work_order_id: ids.workOrder,
                task_id: ids.task,
                scope_version_id: ids.scope,
                proof_id: ids.proof,
                completion_version: 2,
                fact_kind: 'APPROVED',
                incident_gate: 'CLEAR',
                amount_approved_cents: 12_000,
                delivery_event_id: '30000000-0000-4000-8000-000000000001',
                actor_id: ids.poster,
                idempotency_key: 'completion:approved',
                proof_state: 'ACCEPTED',
              },
            ],
            rowCount: 1,
          };
        }
        if (sql.includes('FROM task_financial_security_events')) {
          return {
            rows: [
              {
                id: ids.secured,
                operation_id: '20000000-0000-4000-8000-000000000000',
                event_kind: 'SECURED',
                status: 'SUCCEEDED',
                expected_version: 2,
                amount_cents: 12_000,
                currency: 'USD',
                scope_version_id: ids.scope,
              },
            ],
            rowCount: 1,
          };
        }
        if (
          sql.includes('FROM task_reconciliation_facts') &&
          sql.includes('ORDER BY reconciliation_version')
        ) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 1 };
      }) as unknown as QueryFn;
      const executeFinancialEvent = vi.fn(async (command: { operationKind: string }) =>
        successEvent(command.operationKind)
      );
      const onboardProvider = vi.fn().mockResolvedValue({
        externalReference: 'fake_provider_account_onboarded',
      });
      const refreshProviderAccountState = vi.fn().mockResolvedValue({
        externalReference: 'fake_provider_account_enabled',
        accountState: 'ENABLED',
        payoutsEnabled: true,
      });
      const reconcile = vi.fn().mockResolvedValue({
        id: ids.reconciliation,
        operationId: '20000000-0000-4000-8000-000000000004',
        providerState: 'MATCHED',
        providerOperationVersion: 1,
        reconciliationVersion: 1,
        idempotencyReplayed: false,
        workOrderId: ids.workOrder,
        reconciliationState: expectedReconciliationState,
        mismatchCodes: [],
      });
      const financeFactory = vi.fn().mockReturnValue({
        executeFinancialEvent,
        onboardProvider,
        refreshProviderAccountState,
        reconcile,
      });
      const repository = new PostgresUniversalV1FulfillmentRepository(databaseFor(query));
      const result = await repository.completeFakeFinancialLifecycle(
        ids.poster,
        {
          work_order_id: ids.workOrder,
          approved_completion_fact_id: ids.approved,
          path,
          expected_execution_version: 6,
          expected_financial_version: 2,
          expected_reconciliation_version: 0,
          idempotency_key: `fulfillment:test:${path.toLowerCase()}:0001`,
          client_ts: new Date().toISOString(),
        },
        financeFactory
      );

      expect(executeFinancialEvent.mock.calls.map(([command]) => command.operationKind)).toEqual(
        expectedOperations
      );
      const expectedSnapshot = {
        captureEventId: ids.capture,
        ...(expectedSettlementId ? { settlementEventId: expectedSettlementId } : {}),
        ...(expectedSettlementId
          ? {
              fundingEventId: ids.fund,
              providerReleaseEventId: ids.providerRelease,
              payoutEventId: ids.payout,
              bankSettlementEventId: ids.bankSettlement,
              fundingState: 'FUNDED',
              providerReleaseState: 'RELEASED',
              payoutState: 'PAID',
              bankSettlementState: 'SETTLED',
            }
          : {}),
        ...(expectedRefundId ? { refundEventId: expectedRefundId } : {}),
        reconciliationState: expectedReconciliationState,
        customerLedgerAmountCents: expectedCustomerLedger,
        providerLedgerAmountCents: expectedProviderLedger,
      };
      expect(reconcile).toHaveBeenCalledWith(
        expect.objectContaining({
          providerKind: 'FAKE',
          snapshot: expect.objectContaining(expectedSnapshot),
        })
      );
      expect(result).toMatchObject({
        path,
        capture_event_id: ids.capture,
        settlement_event_id: expectedSettlementId,
        funding_event_id: expectedSettlementId ? ids.fund : null,
        provider_release_event_id: expectedSettlementId ? ids.providerRelease : null,
        payout_event_id: expectedSettlementId ? ids.payout : null,
        bank_settlement_event_id: expectedSettlementId ? ids.bankSettlement : null,
        refund_event_id: expectedRefundId,
        provider_kind: 'FAKE',
        payment_creation_performed: false,
        hard_assignment_created: false,
      });
      expect(onboardProvider).toHaveBeenCalledTimes(path === 'SETTLED' ? 1 : 0);
      expect(refreshProviderAccountState).toHaveBeenCalledTimes(path === 'SETTLED' ? 1 : 0);
      expect(financeFactory).toHaveBeenCalledOnce();
    }
  );
});
