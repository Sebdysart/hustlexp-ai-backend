import { deterministicUuid } from '../../src/services/UniversalV1WorkOrderPostgresRepository.js';
import { describe, expect, it, vi } from 'vitest';

import type { UniversalV1ActorAttestationHandle } from '../../src/auth/universal-v1-actor-attestation-contracts.js';
import { UniversalV1WorkOrderApplication } from '../../src/services/UniversalV1WorkOrderApplication.js';

const now = new Date();
const ids = {
  actor: '10000000-0000-4000-8000-000000000001',
  task: '10000000-0000-4000-8000-000000000002',
  draft: '10000000-0000-4000-8000-000000000003',
  scope: '10000000-0000-4000-8000-000000000004',
  route: '10000000-0000-4000-8000-000000000005',
  eligibility: '10000000-0000-4000-8000-000000000006',
  interest: '10000000-0000-4000-8000-000000000007',
  hold: '10000000-0000-4000-8000-000000000008',
  estimate: '10000000-0000-4000-8000-000000000009',
  secured: '10000000-0000-4000-8000-000000000010',
};

function attestation(
  tokens: string[]
): UniversalV1ActorAttestationHandle & { issue: ReturnType<typeof vi.fn> } {
  const issue = vi.fn();
  for (const token of tokens) {
    issue.mockResolvedValueOnce({
      schema_version: 1,
      command_kind: 'EXPRESS_POST_ESTIMATE_INTEREST',
      canonical_request_sha256: 'a'.repeat(64),
      actor_assertion_token: token,
      assertion_expires_at: new Date(now.getTime() + 55_000).toISOString(),
    });
  }
  return { issue } as never;
}

const interestContext = {
  task_id: ids.task,
  task_draft_id: ids.draft,
  scope_version_id: ids.scope,
  scope_version: 2,
  routing_decision_id: ids.route,
  provider_user_id: ids.actor,
  provider_organization_id: null,
  provider_class: 'GENERAL_SERVICE_PROVIDER' as const,
  trade_credential_id: null,
  predecessor_eligibility_id: ids.eligibility,
  predecessor_eligibility_version: 1,
  predecessor_valid_until: new Date(now.getTime() + 60_000).toISOString(),
};

function financeFixture(phase: any) {
  const kinds = ['PREPARE_PAYMENT_METHOD', 'AUTHORIZE', 'SECURE'];
  const labels = ['prepare', 'authorize', 'secure'];
  const suffixes = ['prep', 'auth', 'secure'];
  const events = [ids.draft, ids.scope, ids.secured],
    c = phase.context;
  return {
    requestFinancialEvent: vi.fn(),
    readPredecessor: vi.fn(async (selector: any) => {
      const n = kinds.indexOf(selector.operationKind);
      return {
        predecessor: {
          operationKind: kinds[n],
          operationId: deterministicUuid(phase.idempotencyKey, labels[n]!),
          idempotencyKey: phase.idempotencyKey + ':' + suffixes[n],
          lifecycleExpectedVersion: n,
          taskDraftId: c.task_draft_id,
          taskId: c.task_id,
          scopeVersionId: c.scope_version_id,
          eligibilityDecisionId: c.eligibility_decision_id,
          financialEventId: events[n],
          predecessorEventId: n === 0 ? null : events[n - 1],
          amountCents: n === 0 ? null : c.customer_total_cents,
          currency: n === 0 ? null : c.currency,
          externalReference: n === 0 ? 'pm' : null,
          expiresAt: c.hold_expires_at,
        },
      };
    }),
  };
}

describe('UniversalV1WorkOrderApplication actor-attestation propagation', () => {
  it('binds provider interest to the exact public command and passes only the one-time token', async () => {
    const token = '1'.repeat(64);
    const authority = attestation([token]);
    const repo = { express: vi.fn().mockResolvedValue({ replayed: false }) };
    const app = new UniversalV1WorkOrderApplication(
      { interest: vi.fn().mockResolvedValue(interestContext) } as never,
      repo as never,
      vi.fn() as never
    );
    const input = {
      task_id: ids.task,
      expected_scope_version: 2,
      idempotency_key: 'interest:test:0001',
      client_ts: now.toISOString(),
    };
    await app.expressProviderInterest(ids.actor, input, authority);

    expect(authority.issue).toHaveBeenCalledWith({
      commandKind: 'EXPRESS_POST_ESTIMATE_INTEREST',
      commandPayload: {
        task_id: ids.task,
        expected_scope_version: 2,
        idempotency_key: 'interest:test:0001',
        client_timestamp_epoch_ms: now.getTime(),
      },
    });
    expect(repo.express).toHaveBeenCalledWith(
      interestContext,
      token,
      input.idempotency_key,
      input.client_ts
    );
    expect(repo.express.mock.calls.flat()).not.toContain(ids.actor);
  });

  it('uses distinct prepare and materialize assertions and never regenerates client_ts', async () => {
    const prepareToken = '2'.repeat(64);
    const materializeToken = '3'.repeat(64);
    const authority = attestation([prepareToken, materializeToken]);
    const hold = {
      ...interestContext,
      poster_user_id: ids.actor,
      interest_application_id: ids.interest,
      eligibility_decision_id: ids.eligibility,
      eligibility_version: 2,
      eligibility_valid_until: new Date(now.getTime() + 60_000).toISOString(),
      conditional_hold_id: ids.hold,
      hold_reserved_at: now.toISOString(),
      hold_expires_at: new Date(now.getTime() + 60_000).toISOString(),
      provider_estimate_submission_id: ids.estimate,
      customer_total_cents: 12_000,
      currency: 'USD',
    };
    const phase = {
      completed: false as const,
      context: hold,
      idempotencyKey: 'workorder:test:0001',
      requestSha256: 'd'.repeat(64),
      occurredAt: now.toISOString(),
    };
    const repo = {
      prepareMaterialization: vi.fn().mockResolvedValue(phase),
      finalizeMaterialization: vi.fn().mockResolvedValue({
        work_order_id: ids.task,
        hard_assignment_created: false,
        payment_creation_performed: false,
      }),
      claimMaterializationCompensation: vi.fn(),
    };
    const finance = financeFixture(phase);
    const history = {
      read: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValue({ state: 'PREPARED', phase, observedAt: now.toISOString() }),
    };
    const app = new UniversalV1WorkOrderApplication(
      { workOrder: vi.fn().mockResolvedValue(hold) } as never,
      repo as never,
      vi.fn().mockResolvedValue(finance) as never,
      history
    );
    const input = {
      conditional_hold_id: ids.hold,
      expected_eligibility_version: 2,
      idempotency_key: phase.idempotencyKey,
      client_ts: now.toISOString(),
    };
    await app.secureAndMaterializeFakeWorkOrder(ids.actor, input, authority);

    expect(authority.issue.mock.calls.map(([request]) => request.commandKind)).toEqual([
      'PREPARE_FAKE_WORK_ORDER',
      'MATERIALIZE_FAKE_WORK_ORDER',
    ]);
    expect(repo.prepareMaterialization).toHaveBeenCalledWith(
      { conditional_hold_id: ids.hold, eligibility_version: 2 },
      input.idempotency_key,
      prepareToken,
      input.client_ts
    );
    expect(repo.finalizeMaterialization).toHaveBeenCalledWith(phase, ids.secured, materializeToken);
  });

  it('uses a fresh recovery assertion after a consumed/failed materialization attempt', async () => {
    const authority = attestation(['4'.repeat(64), '5'.repeat(64), '6'.repeat(64)]);
    const hold = {
      ...interestContext,
      poster_user_id: ids.actor,
      interest_application_id: ids.interest,
      eligibility_decision_id: ids.eligibility,
      eligibility_version: 2,
      eligibility_valid_until: new Date(now.getTime() + 60_000).toISOString(),
      conditional_hold_id: ids.hold,
      hold_reserved_at: now.toISOString(),
      hold_expires_at: new Date(now.getTime() + 60_000).toISOString(),
      provider_estimate_submission_id: ids.estimate,
      customer_total_cents: 12_000,
      currency: 'USD',
    };
    const phase = {
      completed: false as const,
      context: hold,
      idempotencyKey: 'workorder:test:recovery',
      requestSha256: 'e'.repeat(64),
      occurredAt: now.toISOString(),
    };
    const repo = {
      prepareMaterialization: vi.fn().mockResolvedValue(phase),
      finalizeMaterialization: vi.fn().mockRejectedValue(new Error('ambiguous')),
      claimMaterializationCompensation: vi.fn().mockResolvedValue({
        completed: true,
        result: {
          work_order_id: ids.task,
          hard_assignment_created: false,
          payment_creation_performed: false,
        },
      }),
    };
    const finance = financeFixture(phase);
    const history = {
      read: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValue({ state: 'PREPARED', phase, observedAt: now.toISOString() }),
    };
    const app = new UniversalV1WorkOrderApplication(
      { workOrder: vi.fn().mockResolvedValue(hold) } as never,
      repo as never,
      vi.fn().mockResolvedValue(finance) as never,
      history
    );
    await app.secureAndMaterializeFakeWorkOrder(
      ids.actor,
      {
        conditional_hold_id: ids.hold,
        expected_eligibility_version: 2,
        idempotency_key: phase.idempotencyKey,
        client_ts: now.toISOString(),
      },
      authority
    );
    expect(authority.issue.mock.calls.map(([request]) => request.commandKind)).toEqual([
      'PREPARE_FAKE_WORK_ORDER',
      'MATERIALIZE_FAKE_WORK_ORDER',
      'REQUEST_FAKE_WORK_ORDER_RECOVERY',
    ]);
    expect(repo.claimMaterializationCompensation).toHaveBeenCalledWith(
      phase,
      ids.secured,
      '6'.repeat(64)
    );
  });

  it('rejects sub-millisecond timestamps before attestation or database work', async () => {
    const authority = attestation(['7'.repeat(64)]);
    const repo = { express: vi.fn() };
    const app = new UniversalV1WorkOrderApplication(
      { interest: vi.fn().mockResolvedValue(interestContext) } as never,
      repo as never,
      vi.fn() as never
    );
    const subMillisecondTimestamp = new Date()
      .toISOString()
      .replace(/(\.\d{3})Z$/u, (_match, milliseconds: string) => `${milliseconds}456Z`);

    await expect(
      app.expressProviderInterest(
        ids.actor,
        {
          task_id: ids.task,
          expected_scope_version: 2,
          idempotency_key: 'interest:test:submillisecond',
          client_ts: subMillisecondTimestamp,
        },
        authority
      )
    ).rejects.toThrow('CLIENT_TIMESTAMP_INVALID');
    expect(authority.issue).not.toHaveBeenCalled();
    expect(repo.express).not.toHaveBeenCalled();
  });
});
