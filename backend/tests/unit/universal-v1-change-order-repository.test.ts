import { describe, expect, it, vi } from 'vitest';

import type { Database, QueryFn, QueryResult } from '../../src/db.js';
import { PostgresUniversalV1ChangeOrderRepository } from '../../src/services/UniversalV1ChangeOrderPostgresRepository.js';

const ids = {
  actor: '10000000-0000-4000-8000-000000000001',
  provider: '10000000-0000-4000-8000-000000000002',
  workOrder: '10000000-0000-4000-8000-000000000003',
  task: '10000000-0000-4000-8000-000000000004',
  draft: '10000000-0000-4000-8000-000000000005',
  scope: '10000000-0000-4000-8000-000000000006',
  newScope: '10000000-0000-4000-8000-000000000007',
  proposal: '10000000-0000-4000-8000-000000000008',
  approval: '10000000-0000-4000-8000-000000000009',
  eligibility: '10000000-0000-4000-8000-000000000010',
  financial: '10000000-0000-4000-8000-000000000011',
  adjustment: '10000000-0000-4000-8000-000000000012',
  amendment: '10000000-0000-4000-8000-000000000013',
  operation: '10000000-0000-4000-8000-000000000014',
  execution: '10000000-0000-4000-8000-000000000015',
  amendmentExecution: '10000000-0000-4000-8000-000000000016',
};
const scopeSha256 = 'a'.repeat(64);
const proposalRequestSha256 = 'b'.repeat(64);
const now = '2026-08-27T12:00:00.000Z';

const currentScope = {
  scope_version_id: ids.scope,
  scope_version: 1,
  scope_hash: 'c'.repeat(64),
  title: 'Replace a kitchen faucet',
  description: 'Remove the existing faucet and install the originally selected faucet.',
  requirements: null,
  checklist: ['Shut off water', 'Install faucet'],
  customer_total_cents: 12_000,
  provider_payout_cents: 9_000,
  currency: 'USD',
};
const proposedScope = {
  title: 'Install the approved replacement faucet',
  description: 'Remove the existing faucet and install the newly approved replacement.',
  requirements: 'Use the customer-selected fixture.',
  checklist: ['Shut off water', 'Install replacement', 'Verify no leaks'],
};

function rows<T>(values: T[]): QueryResult<T> {
  return { rows: values, rowCount: values.length };
}

function databaseFor(query: QueryFn, readQuery: QueryFn = query): Database {
  return {
    query: vi.fn(() =>
      Promise.reject(new Error('direct query is forbidden'))
    ) as unknown as QueryFn,
    readQuery,
    transaction: vi.fn(() => Promise.reject(new Error('nonserializable transaction is forbidden'))),
    serializableTransaction: async <T>(callback: (bound: QueryFn) => Promise<T>) => callback(query),
    healthCheck: vi.fn(),
    getPool: vi.fn(),
    getPoolStats: vi.fn(),
    close: vi.fn(),
  } as unknown as Database;
}

function proposalContextFixture() {
  return {
    work_order_id: ids.workOrder,
    task_id: ids.task,
    task_draft_id: ids.draft,
    poster_user_id: ids.actor,
    provider_user_id: ids.provider,
    provider_organization_id: null,
    ...currentScope,
    latest_amendment_id: null,
    latest_amendment_version: null,
    latest_proposal_id: null,
    latest_proposal_version: null,
    latest_proposal_status: null,
    actor_is_customer: true,
    actor_is_provider: false,
    provider_authority_current: true,
  };
}

describe('PostgresUniversalV1ChangeOrderRepository', () => {
  it('creates one exact pending proposal using the PostgreSQL scope digest', async () => {
    const statements: string[] = [];
    const parameters: unknown[][] = [];
    const context = proposalContextFixture();
    let call = 0;
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      statements.push(sql);
      parameters.push(params);
      call += 1;
      if (call === 1) return rows([]);
      if (call === 2) return rows([context]);
      if (call === 3) return rows([]);
      if (call === 4) return rows([{ scope_sha256: scopeSha256 }]);
      if (call === 5) return rows([{ request_sha256: proposalRequestSha256 }]);
      if (call === 6)
        return rows([
          {
            id: ids.proposal,
            proposal_version: 1,
            change_order_kind: 'SCOPE_ONLY',
            proposed_by: ids.actor,
            proposer_role: 'POSTER',
            proposed_scope_sha256: scopeSha256,
            request_sha256: proposalRequestSha256,
            idempotency_key: 'change-order:proposal:0001',
            status: 'PENDING',
          },
        ]);
      throw new Error(`unexpected query ${call}: ${sql}`);
    }) as unknown as QueryFn;
    const repository = new PostgresUniversalV1ChangeOrderRepository(databaseFor(query));
    const result = await repository.proposeChangeOrder(ids.actor, {
      work_order_id: ids.workOrder,
      expected_scope_version: 1,
      expected_amendment_version: 0,
      expected_latest_proposal_version: 0,
      observed_scope_summary: 'The exact execution scope changed after inspection.',
      proposed_scope: proposedScope,
      change_order_kind: 'SCOPE_ONLY',
      idempotency_key: 'change-order:proposal:0001',
      client_ts: now,
    });
    expect(result).toMatchObject({
      proposal_id: ids.proposal,
      proposal_version: 1,
      proposer_party: 'CUSTOMER',
      replayed: false,
      payment_creation_performed: false,
      hard_assignment_created: false,
    });
    expect(statements[0]).toContain('pg_advisory_xact_lock');
    expect(statements[1]).toContain('customer_organization.client_enabled');
    expect(statements[1]).toContain("'CREATE_WORK_ORDER'");
    expect(statements[2]).toContain('replay_base_amendment_version');
    expect(statements[3]).toContain('public.universal_v1_change_scope_sha256');
    expect(statements[4]).toContain('universal_v1_change_proposal_request_sha256');
    expect(statements[5]).toContain('application_contract_version');
    expect(statements[5]).toContain('proposed_scope_sha256');
    expect(parameters[5]?.[16]).toBe('change-order:proposal:0001');
    expect(parameters[5]?.[17]).toBe(proposalRequestSha256);
    expect(statements.join('\n')).not.toContain('task_work_order_amendments (');
    expect(statements.join('\n')).not.toContain('task_financial_security_events (');
  });

  it.each([
    ['exact replay', proposalRequestSha256, true],
    ['changed request', 'f'.repeat(64), false],
  ] as const)('%s preserves strict proposal idempotency', async (_label, storedHash, succeeds) => {
    const replayContext = {
      ...proposalContextFixture(),
      latest_proposal_id: ids.proposal,
      latest_proposal_version: 1,
      latest_proposal_status: 'PENDING',
    };
    let call = 0;
    const query = vi.fn(async (sql: string) => {
      call += 1;
      if (call === 1) return rows([]);
      if (call === 2) return rows([replayContext]);
      if (call === 3)
        return rows([
          {
            id: ids.proposal,
            task_id: ids.task,
            base_version_id: ids.scope,
            proposal_version: 1,
            supersedes_proposal_id: null,
            change_order_kind: 'SCOPE_ONLY',
            proposed_by: ids.actor,
            proposer_role: 'POSTER',
            observed_scope_summary: 'The exact execution scope changed after inspection.',
            proposed_checklist: proposedScope.checklist,
            proposed_customer_total_cents: null,
            proposed_provider_payout_cents: null,
            proposed_title: proposedScope.title,
            proposed_description: proposedScope.description,
            proposed_requirements: proposedScope.requirements,
            proposed_scope_sha256: scopeSha256,
            request_sha256: storedHash,
            idempotency_key: 'change-order:proposal:0001',
            status: 'PENDING',
            replay_base_scope_version: 1,
            replay_base_customer_total_cents: 12_000,
            replay_base_provider_payout_cents: 9_000,
            replay_base_currency: 'USD',
            replay_base_amendment_version: 0,
          },
        ]);
      if (call === 4) return rows([{ scope_sha256: scopeSha256 }]);
      if (call === 5) return rows([{ request_sha256: proposalRequestSha256 }]);
      throw new Error(`unexpected replay write: ${sql}`);
    }) as unknown as QueryFn;
    const repository = new PostgresUniversalV1ChangeOrderRepository(databaseFor(query));
    const invocation = repository.proposeChangeOrder(ids.actor, {
      work_order_id: ids.workOrder,
      expected_scope_version: 1,
      expected_amendment_version: 0,
      expected_latest_proposal_version: 0,
      observed_scope_summary: 'The exact execution scope changed after inspection.',
      proposed_scope: proposedScope,
      change_order_kind: 'SCOPE_ONLY',
      idempotency_key: 'change-order:proposal:0001',
      client_ts: now,
    });
    if (succeeds) {
      await expect(invocation).resolves.toMatchObject({ replayed: true });
    } else {
      await expect(invocation).rejects.toMatchObject({
        code: 'CHANGE_ORDER_IDEMPOTENCY_CONFLICT',
      });
    }
    expect(call).toBe(5);
  });

  it('derives provider decision authority through APPROVE_SPEND and records one immutable fact', async () => {
    const statements: string[] = [];
    const context = {
      proposal_id: ids.proposal,
      proposal_version: 1,
      proposal_status: 'PENDING',
      proposal_request_sha256: proposalRequestSha256,
      base_version_id: ids.scope,
      work_order_id: ids.workOrder,
      task_id: ids.task,
      poster_user_id: ids.actor,
      provider_user_id: ids.provider,
      provider_organization_id: null,
      ...currentScope,
      customer_approval_actor_id: ids.actor,
      provider_approval_actor_id: null,
      actor_is_customer: false,
      actor_is_provider: true,
      provider_authority_current: true,
    };
    let call = 0;
    const query = vi.fn(async (sql: string) => {
      statements.push(sql);
      call += 1;
      if (call === 1) return rows([]);
      if (call === 2) return rows([context]);
      if (call === 3) return rows([{ request_sha256: 'd'.repeat(64) }]);
      if (call === 4) return rows([]);
      if (call === 5)
        return rows([
          {
            id: ids.approval,
            proposal_id: ids.proposal,
            approver_role: 'PROVIDER',
            decision: 'APPROVED',
            actor_id: ids.provider,
            expected_proposal_version: 1,
            reason: 'The provider accepts the exact replacement scope.',
            idempotency_key: 'change-order:decision:0001',
            request_sha256: 'd'.repeat(64),
          },
        ]);
      throw new Error(`unexpected query ${call}: ${sql}`);
    }) as unknown as QueryFn;
    const repository = new PostgresUniversalV1ChangeOrderRepository(databaseFor(query));
    const result = await repository.decideChangeOrder(ids.provider, {
      proposal_id: ids.proposal,
      expected_proposal_version: 1,
      decision: 'APPROVED',
      reason: 'The provider accepts the exact replacement scope.',
      idempotency_key: 'change-order:decision:0001',
      client_ts: now,
    });
    expect(statements[1]).toContain('customer_organization.client_enabled');
    expect(statements[1]).toContain("'APPROVE_SPEND'");
    expect(statements[1]).not.toMatch(/membership\.role\s+IN\s*\([^)]*CREW/iu);
    expect(statements[2]).toContain('universal_v1_change_decision_request_sha256');
    expect(statements[4]).toContain('request_sha256');
    expect(statements.join('\n')).not.toContain("SET status = 'APPROVED'");
    expect(result).toMatchObject({
      approver_party: 'PROVIDER',
      decision: 'APPROVED',
      proposal_status: 'PENDING',
      replayed: false,
    });
  });

  it('admits finalization reads only through current customer approval authority', async () => {
    const readQuery = vi.fn(async (sql: string) => {
      expect(sql).toContain('customer_organization.client_enabled');
      expect(sql).toContain("'APPROVE_SPEND'");
      expect(sql).toContain('task.business_organization_id IS NULL');
      return rows([{ change_order_kind: 'SCOPE_ONLY' }]);
    }) as unknown as QueryFn;
    const repository = new PostgresUniversalV1ChangeOrderRepository(
      databaseFor(vi.fn() as unknown as QueryFn, readQuery)
    );

    await expect(repository.readFinalizationKind(ids.actor, ids.proposal)).resolves.toBe(
      'SCOPE_ONLY'
    );
    expect(readQuery).toHaveBeenCalledOnce();
  });

  it.each([
    ['SCOPE_ONLY', 12_000, 9_000, false],
    ['PRICE_AND_SCOPE', 15_000, 11_000, true],
  ] as const)(
    'materializes a %s amendment in one ordered transaction',
    async (changeOrderKind, customerTotal, providerPayout, expectsAdjustment) => {
      const markers: string[] = [];
      const statements: string[] = [];
      const context = {
        proposal_id: ids.proposal,
        proposal_version: 1,
        proposal_status: 'PENDING',
        proposal_request_sha256: proposalRequestSha256,
        base_version_id: ids.scope,
        change_order_kind: changeOrderKind,
        observed_scope_summary: 'The exact execution scope changed after inspection.',
        proposed_title: proposedScope.title,
        proposed_description: proposedScope.description,
        proposed_requirements: proposedScope.requirements,
        proposed_checklist: proposedScope.checklist,
        proposed_customer_total_cents: expectsAdjustment ? customerTotal : null,
        proposed_provider_payout_cents: expectsAdjustment ? providerPayout : null,
        proposed_scope_sha256: scopeSha256,
        financial_adjustment_required: expectsAdjustment,
        work_order_id: ids.workOrder,
        task_id: ids.task,
        task_draft_id: ids.draft,
        poster_user_id: ids.actor,
        provider_user_id: ids.provider,
        provider_organization_id: null,
        eligibility_decision_id: ids.eligibility,
        ...currentScope,
        latest_amendment_id: null,
        latest_amendment_version: null,
        customer_approval_actor_id: ids.actor,
        customer_approval_decision: 'APPROVED',
        customer_approval_current: true,
        provider_approval_actor_id: ids.provider,
        provider_approval_decision: 'APPROVED',
        provider_approval_current: true,
        provider_authority_current: true,
        latest_financial_event_id: ids.financial,
        latest_financial_operation_id: ids.operation,
        latest_financial_event_kind: 'SECURED',
        latest_financial_status: 'SUCCEEDED',
        latest_financial_version: 2,
        latest_financial_occurred_at: '2026-08-27T11:00:00.000Z',
        execution_fact_id: ids.execution,
        execution_version: 1,
        execution_state: 'PAUSED',
      };
      let call = 0;
      const query = vi.fn(async (sql: string) => {
        statements.push(sql);
        call += 1;
        if (call === 1) return rows([]);
        if (call === 2) return rows([{ work_order_id: ids.workOrder }]);
        if (call === 3) return rows([]);
        if (call === 4) return rows([]);
        if (call === 5) return rows([context]);
        if (call === 6) return rows([{ scope_sha256: scopeSha256 }]);
        if (call === 7) {
          markers.push('SQL:SCOPE');
          return rows([{ id: ids.newScope }]);
        }
        if (call === 8) {
          markers.push('SQL:APPROVE');
          return { rows: [], rowCount: 1 };
        }
        if (call === 9) return rows([{ request_sha256: 'e'.repeat(64) }]);
        if (call === 10) {
          markers.push('SQL:TASK');
          return rows([{ worker_id: null }]);
        }
        if (call === 11) {
          markers.push('SQL:AMENDMENT');
          return rows([{ id: ids.amendment }]);
        }
        if (call === 12) {
          markers.push('SQL:EXECUTION');
          return rows([{ id: ids.amendmentExecution }]);
        }
        throw new Error(`unexpected query ${call}: ${sql}`);
      }) as unknown as QueryFn;
      const executeFinancialEvent = vi.fn(async (command: Record<string, unknown>) => {
        markers.push('FINANCE:ADJUST');
        return {
          id: ids.adjustment,
          operationId: command.operationId,
          eventKind: 'ADJUSTMENT_AUTHORIZED',
          status: 'SUCCEEDED',
          providerKind: 'FAKE',
          externalReference: 'fake:adjustment',
          providerOperationVersion: 1,
          lifecycleExpectedVersion: 3,
          idempotencyReplayed: false,
          taskDraftId: ids.draft,
          taskId: ids.task,
          eligibilityDecisionId: ids.eligibility,
          scopeVersionId: ids.newScope,
          changeOrderId: ids.proposal,
          predecessorEventId: ids.financial,
          completionFactId: null,
          amountCents: customerTotal,
          currency: 'USD',
          providerState: 'SUCCEEDED',
          recordedBy: ids.actor,
          occurredAt: now,
        };
      });
      const financeFactory = vi.fn().mockReturnValue({ executeFinancialEvent });
      const repository = new PostgresUniversalV1ChangeOrderRepository(databaseFor(query));
      const result = await repository.authorizeAndMaterializeFakeChangeOrder(
        ids.actor,
        {
          proposal_id: ids.proposal,
          expected_proposal_version: 1,
          expected_scope_version: 1,
          expected_amendment_version: 0,
          expected_execution_version: 1,
          expected_financial_version: 2,
          idempotency_key: `change-order:finalize:${changeOrderKind.toLowerCase()}:0001`,
          client_ts: now,
        },
        expectsAdjustment ? financeFactory : undefined
      );
      expect(markers).toEqual(
        expectsAdjustment
          ? [
              'SQL:SCOPE',
              'SQL:APPROVE',
              'FINANCE:ADJUST',
              'SQL:TASK',
              'SQL:AMENDMENT',
              'SQL:EXECUTION',
            ]
          : ['SQL:SCOPE', 'SQL:APPROVE', 'SQL:TASK', 'SQL:AMENDMENT', 'SQL:EXECUTION']
      );
      expect(statements[3]).toContain('customer_organization.client_enabled');
      expect(statements[4]).toContain('customer_approval_current');
      expect(statements[4]).toContain('customer_organization.client_enabled');
      expect(statements[9]).toContain('platform_margin_cents = $5::integer - $6::integer');
      expect(executeFinancialEvent).toHaveBeenCalledTimes(expectsAdjustment ? 1 : 0);
      if (expectsAdjustment) {
        expect(executeFinancialEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            operationKind: 'ADJUST',
            providerKind: 'FAKE',
            scopeVersionId: ids.newScope,
            changeOrderId: ids.proposal,
            predecessorEventId: ids.financial,
            lifecycleExpectedVersion: 3,
            amountCents: customerTotal,
            currency: 'usd',
          })
        );
      }
      expect(result).toMatchObject({
        amendment_id: ids.amendment,
        amendment_version: 1,
        scope_version_id: ids.newScope,
        scope_version: 2,
        adjustment_event_id: expectsAdjustment ? ids.adjustment : null,
        provider_kind: expectsAdjustment ? 'FAKE' : null,
        payment_creation_performed: false,
        hard_assignment_created: false,
      });
      expect(markers.at(-1)).toBe('SQL:EXECUTION');
    }
  );

  it.each([
    ['exact financial version', 2, true],
    ['changed financial version', 3, false],
  ] as const)(
    '%s preserves strict scope-only amendment replay',
    async (_label, expectedFinancialVersion, succeeds) => {
      const statements: string[] = [];
      let call = 0;
      const query = vi.fn(async (sql: string) => {
        statements.push(sql);
        call += 1;
        if (call === 1) return rows([]);
        if (call === 2) return rows([{ work_order_id: ids.workOrder }]);
        if (call === 3) return rows([]);
        if (call === 4)
          return rows([
            {
              amendment_id: ids.amendment,
              amendment_version: 1,
              change_order_id: ids.proposal,
              proposal_version: 1,
              scope_version_id: ids.newScope,
              scope_version: 2,
              adjustment_event_id: null,
              adjustment_expected_version: null,
              change_order_kind: 'SCOPE_ONLY',
              proposal_request_sha256: proposalRequestSha256,
              request_sha256: 'e'.repeat(64),
              materialized_by: ids.actor,
              adjustment_event_kind: null,
              adjustment_status: null,
              adjustment_provider_kind: null,
              expected_financial_version: 2,
              execution_fact_id: ids.amendmentExecution,
              execution_version: 2,
              execution_state: 'PAUSED',
              execution_actor_user_id: ids.actor,
            },
          ]);
        throw new Error(`unexpected replay write: ${sql}`);
      }) as unknown as QueryFn;
      const financeFactory = vi.fn();
      const repository = new PostgresUniversalV1ChangeOrderRepository(databaseFor(query));
      const invocation = repository.authorizeAndMaterializeFakeChangeOrder(
        ids.actor,
        {
          proposal_id: ids.proposal,
          expected_proposal_version: 1,
          expected_scope_version: 1,
          expected_amendment_version: 0,
          expected_execution_version: 1,
          expected_financial_version: expectedFinancialVersion,
          idempotency_key: 'change-order:finalize:scope_only:0001',
          client_ts: now,
        },
        financeFactory
      );
      if (succeeds) {
        await expect(invocation).resolves.toMatchObject({
          replayed: true,
          adjustment_event_id: null,
        });
      } else {
        await expect(invocation).rejects.toMatchObject({
          code: 'CHANGE_ORDER_IDEMPOTENCY_CONFLICT',
        });
      }
      expect(call).toBe(4);
      expect(statements[3]).toContain('amendment.expected_financial_version');
      expect(statements[3]).toContain('customer_organization.client_enabled');
      expect(financeFactory).not.toHaveBeenCalled();
    }
  );
});
