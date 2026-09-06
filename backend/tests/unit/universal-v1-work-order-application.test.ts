import { describe, expect, it, vi } from 'vitest';
import { UniversalV1WorkOrderApplication } from '../../src/services/UniversalV1WorkOrderApplication.js';
import { transactionBoundDatabase } from '../../src/services/UniversalV1WorkOrderPostgresRepository.js';

const ids = {
  task: '10000000-0000-4000-8000-000000000001',
  draft: '10000000-0000-4000-8000-000000000002',
  scope: '10000000-0000-4000-8000-000000000003',
  route: '10000000-0000-4000-8000-000000000004',
  provider: '10000000-0000-4000-8000-000000000005',
  poster: '10000000-0000-4000-8000-000000000006',
  prior: '10000000-0000-4000-8000-000000000007',
  interest: '10000000-0000-4000-8000-000000000008',
  elig: '10000000-0000-4000-8000-000000000009',
  hold: '10000000-0000-4000-8000-000000000010',
  estimate: '10000000-0000-4000-8000-000000000011',
};
const base = {
  task_id: ids.task,
  task_draft_id: ids.draft,
  scope_version_id: ids.scope,
  scope_version: 1,
  routing_decision_id: ids.route,
  provider_user_id: ids.provider,
  provider_organization_id: null,
  provider_class: 'GENERAL_SERVICE_PROVIDER' as const,
  trade_credential_id: null,
  predecessor_eligibility_id: ids.prior,
  predecessor_eligibility_version: 1,
  predecessor_valid_until: new Date(Date.now() + 60_000).toISOString(),
};

function actorAttestation(...tokens: string[]) {
  const issue = vi.fn();
  for (const token of tokens) {
    issue.mockResolvedValueOnce({ actor_assertion_token: token });
  }
  return { issue } as never;
}

describe('UniversalV1WorkOrderApplication', () => {
  it('reuses the outer QueryFn without opening a nested transaction', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const outer: any = {
      transaction: vi.fn(),
      serializableTransaction: vi.fn(),
      query: vi.fn(),
      readQuery: vi.fn(),
    };
    const bound = transactionBoundDatabase(query, outer);
    await bound.transaction(async (q) => q('SELECT 1'));
    await bound.serializableTransaction(async (q) => q('SELECT 2'));
    expect(query).toHaveBeenCalledTimes(2);
    expect(outer.transaction).not.toHaveBeenCalled();
    expect(outer.serializableTransaction).not.toHaveBeenCalled();
  });
  it('derives interest authority and rejects stale client scope', async () => {
    const facts: any = { interest: vi.fn().mockResolvedValue(base) };
    const repo: any = { express: vi.fn().mockResolvedValue({ replayed: false }) };
    const app = new UniversalV1WorkOrderApplication(facts, repo, vi.fn() as any);
    await expect(
      app.expressProviderInterest(ids.provider, {
        task_id: ids.task,
        expected_scope_version: 2,
        idempotency_key: 'interest:test:0001',
        client_ts: new Date().toISOString(),
      })
    ).rejects.toMatchObject({ code: 'WORK_ORDER_VERSION_CONFLICT' });
    expect(repo.express).not.toHaveBeenCalled();
  });
  it('authorizes fake finance before committing the witness, then queues preparation and returns pending', async () => {
    const hold = {
      ...base,
      poster_user_id: ids.poster,
      interest_application_id: ids.interest,
      eligibility_decision_id: ids.elig,
      eligibility_version: 2,
      eligibility_valid_until: new Date(Date.now() + 60_000).toISOString(),
      conditional_hold_id: ids.hold,
      hold_reserved_at: new Date().toISOString(),
      hold_expires_at: new Date(Date.now() + 60_000).toISOString(),
      provider_estimate_submission_id: ids.estimate,
      customer_total_cents: 12000,
      currency: 'USD',
    };
    const phase = {
      completed: false as const,
      context: hold,
      idempotencyKey: 'workorder:test:0001',
      requestSha256: 'a'.repeat(64),
      occurredAt: hold.hold_reserved_at,
    };
    const facts: any = { workOrder: vi.fn().mockResolvedValue(hold) };
    const repo: any = {
      prepareMaterialization: vi.fn().mockResolvedValue(phase),
      finalizeMaterialization: vi.fn().mockResolvedValue({
        work_order_id: 'x',
        hard_assignment_created: false,
        payment_creation_performed: false,
      }),
    };
    const requestFinancialEvent = vi.fn().mockResolvedValue({});
    const readPredecessor = vi.fn().mockResolvedValue(null);
    const createFinance = vi.fn().mockResolvedValue({ requestFinancialEvent, readPredecessor });
    const history = {
      read: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValue({ state: 'PREPARED', phase, observedAt: new Date().toISOString() }),
    };
    const app = new UniversalV1WorkOrderApplication(facts, repo, createFinance, history);
    const clientTs = new Date().toISOString();
    const prepareToken = '1'.repeat(64);
    const materializeToken = '2'.repeat(64);
    const out = await app.secureAndMaterializeFakeWorkOrder(
      ids.poster,
      {
        conditional_hold_id: ids.hold,
        expected_eligibility_version: 2,
        idempotency_key: 'workorder:test:0001',
        client_ts: clientTs,
      },
      actorAttestation(prepareToken, materializeToken)
    );
    expect(createFinance.mock.invocationCallOrder[0]).toBeLessThan(
      repo.prepareMaterialization.mock.invocationCallOrder[0]
    );
    expect(repo.prepareMaterialization).toHaveBeenCalledWith(
      { conditional_hold_id: ids.hold, eligibility_version: 2 },
      'workorder:test:0001',
      prepareToken,
      clientTs
    );
    expect(requestFinancialEvent).toHaveBeenCalledTimes(1);
    expect(requestFinancialEvent.mock.calls[0]![0]).toMatchObject({
      operationKind: 'PREPARE_PAYMENT_METHOD',
    });
    expect(facts.workOrder).not.toHaveBeenCalled();
    expect(repo.finalizeMaterialization).not.toHaveBeenCalled();
    expect(out).toMatchObject({ status: 'PENDING', stage: 'PAYMENT_SETUP' });
    expect(out).toMatchObject({
      hard_assignment_created: false,
      payment_creation_performed: false,
    });
  });
  it.each(['production', undefined] as const)(
    'refuses fake finance in %s before any Phase-A witness write',
    async (environment) => {
      const hold = {
        ...base,
        poster_user_id: ids.poster,
        interest_application_id: ids.interest,
        eligibility_decision_id: ids.elig,
        eligibility_version: 2,
        eligibility_valid_until: new Date(Date.now() + 60_000).toISOString(),
        conditional_hold_id: ids.hold,
        hold_reserved_at: new Date().toISOString(),
        hold_expires_at: new Date(Date.now() + 60_000).toISOString(),
        provider_estimate_submission_id: ids.estimate,
        customer_total_cents: 12000,
        currency: 'USD',
      };
      const repo: any = { prepareMaterialization: vi.fn(), finalizeMaterialization: vi.fn() };
      const createFinance = vi
        .fn()
        .mockRejectedValue(
          new Error(
            `NONPRODUCTION_FAKE_FINANCE_REFUSED:${environment === 'production' ? 'PRODUCTION_RUNTIME_CANNOT_USE_FAKE_FINANCE' : 'HX_ENVIRONMENT_MUST_BE_LOCAL_PREVIEW_OR_STAGING'}`
          )
        );
      const app = new UniversalV1WorkOrderApplication(
        { workOrder: vi.fn().mockResolvedValue(hold) } as any,
        repo,
        createFinance as any
      );
      await expect(
        app.secureAndMaterializeFakeWorkOrder(ids.poster, {
          conditional_hold_id: ids.hold,
          expected_eligibility_version: 2,
          idempotency_key: 'workorder:refused:0001',
          client_ts: new Date().toISOString(),
        })
      ).rejects.toThrow('NONPRODUCTION_FAKE_FINANCE_REFUSED:');
      expect(createFinance).toHaveBeenCalledTimes(1);
      expect(repo.prepareMaterialization).not.toHaveBeenCalled();
      expect(repo.finalizeMaterialization).not.toHaveBeenCalled();
    }
  );
  it('authorizes an exact completed fake replay but performs no financial event or terminal write', async () => {
    const hold = {
      ...base,
      poster_user_id: ids.poster,
      interest_application_id: ids.interest,
      eligibility_decision_id: ids.elig,
      eligibility_version: 2,
      eligibility_valid_until: new Date(Date.now() + 60_000).toISOString(),
      conditional_hold_id: ids.hold,
      hold_reserved_at: new Date().toISOString(),
      hold_expires_at: new Date(Date.now() + 60_000).toISOString(),
      provider_estimate_submission_id: ids.estimate,
      customer_total_cents: 12000,
      currency: 'USD',
    };
    const result = {
      work_order_id: 'x',
      financial_security_event_id: ids.elig,
      replayed: true,
      hard_assignment_created: false as const,
      payment_creation_performed: false as const,
    };
    const repo: any = {
      prepareMaterialization: vi.fn().mockResolvedValue({ completed: true, result }),
      finalizeMaterialization: vi.fn(),
    };
    const requestFinancialEvent = vi.fn();
    const createFinance = vi
      .fn()
      .mockReturnValue({ requestFinancialEvent, readPredecessor: vi.fn() });
    const history = { read: vi.fn().mockResolvedValue({ state: 'COMPLETED', result }) };
    const app = new UniversalV1WorkOrderApplication(
      { workOrder: vi.fn().mockResolvedValue(hold) } as any,
      repo,
      createFinance,
      history
    );
    const replayToken = '3'.repeat(64);
    await expect(
      app.secureAndMaterializeFakeWorkOrder(
        ids.poster,
        {
          conditional_hold_id: ids.hold,
          expected_eligibility_version: 2,
          idempotency_key: 'workorder:replay:0001',
          client_ts: new Date().toISOString(),
        },
        actorAttestation(replayToken)
      )
    ).resolves.toEqual({ status: 'MATERIALIZED', ...result });
    expect(createFinance).toHaveBeenCalledTimes(1);
    expect(requestFinancialEvent).not.toHaveBeenCalled();
    expect(repo.prepareMaterialization).not.toHaveBeenCalled();
    expect(repo.finalizeMaterialization).not.toHaveBeenCalled();
  });
});
