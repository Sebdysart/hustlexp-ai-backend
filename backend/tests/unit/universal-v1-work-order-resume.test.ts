import { describe, expect, it, vi } from 'vitest';
import { UniversalV1WorkOrderApplication } from '../../src/services/UniversalV1WorkOrderApplication.js';
import { UniversalV1WorkOrderPublicResultSchema } from '../../src/services/UniversalV1WorkOrderContracts.js';
import { deterministicUuid } from '../../src/services/UniversalV1WorkOrderPostgresRepository.js';
import type { WorkOrderHistory } from '../../src/auth/work-order-history-command-contract.js';
import type { FinancialPredecessorFacts } from '../../src/auth/financial-predecessor-command-contract.js';

const id = (n: number) => '30000000-0000-4000-8000-' + String(n).padStart(12, '0');
const key = 'workorder:resume:0001';
function fixture() {
  const now = new Date().toISOString(),
    later = new Date(Date.now() + 120_000).toISOString();
  const context = {
    task_id: id(1),
    task_draft_id: id(2),
    scope_version_id: id(3),
    scope_version: 1,
    routing_decision_id: id(4),
    provider_user_id: id(5),
    provider_organization_id: null,
    provider_class: 'GENERAL_SERVICE_PROVIDER' as const,
    trade_credential_id: null,
    predecessor_eligibility_id: id(6),
    predecessor_eligibility_version: 2,
    predecessor_valid_until: later,
    poster_user_id: id(7),
    interest_application_id: id(8),
    eligibility_decision_id: id(6),
    eligibility_version: 2,
    eligibility_valid_until: later,
    conditional_hold_id: id(9),
    hold_reserved_at: now,
    hold_expires_at: later,
    provider_estimate_submission_id: id(10),
    customer_total_cents: 12000,
    currency: 'USD',
  };
  const phase = {
    completed: false as const,
    context,
    idempotencyKey: key,
    requestSha256: 'a'.repeat(64),
    occurredAt: now,
  };
  const source = {
    targetAuthorityId: id(11),
    releaseSha256: 'sha256:' + 'b'.repeat(64),
    canonicalRequestSha256: 'c'.repeat(64),
    preparationExecutionId: id(12),
  };
  const prepared: WorkOrderHistory = { state: 'PREPARED', phase, source, observedAt: now };
  const result = {
    work_order_id: id(13),
    financial_security_event_id: id(22),
    replayed: true as const,
    hard_assignment_created: false as const,
    payment_creation_performed: false as const,
  };
  const completed: WorkOrderHistory = {
    state: 'COMPLETED',
    phase,
    source,
    result,
    observedAt: now,
  };
  const compensation = {
    compensation_command_id: id(14),
    work_order_idempotency_key: key,
    task_draft_id: id(2),
    task_id: id(1),
    scope_version_id: id(3),
    eligibility_decision_id: id(6),
    secured_event_id: id(22),
    secured_operation_id: deterministicUuid(key, 'secure'),
    void_operation_id: deterministicUuid(key, 'void'),
    void_idempotency_key: key + ':void',
    amount_cents: 12000,
    currency: 'USD',
    requested_by: id(7),
    created_at: now,
    reason_code: 'FINALIZATION_FAILED' as const,
  };
  const claimed: Extract<WorkOrderHistory, { state: 'COMPENSATION_CLAIM' }> = {
    state: 'COMPENSATION_CLAIM',
    phase,
    source,
    compensation,
    voidProgress: null,
    observedAt: now,
  };
  const kinds = ['PREPARE_PAYMENT_METHOD', 'AUTHORIZE', 'SECURE'] as const;
  const labels = ['prepare', 'authorize', 'secure'];
  const suffixes = ['prep', 'auth', 'secure'];
  const eventKinds = ['PAYMENT_METHOD_PREPARED', 'AUTHORIZED', 'SECURED'];
  const events: FinancialPredecessorFacts[] = kinds.map((kind, n) => ({
    idempotencyKey: key + ':' + suffixes[n],
    progress: {
      commandId: id(30 + n),
      operationId: deterministicUuid(key, labels[n]!),
      operationKind: kind,
      taskDraftId: id(2),
      taskId: id(1),
      requestedAt: now,
      observedAt: now,
      requestState: 'REQUESTED',
      progressState: 'MATERIALIZED',
      financialEvent: { id: id(20 + n), eventKind: eventKinds[n]!, status: 'SUCCEEDED' },
    },
    predecessor: {
      commandId: id(30 + n),
      idempotencyKey: key + ':' + suffixes[n],
      preparedCommandId: id(40 + n),
      operationId: deterministicUuid(key, labels[n]!),
      operationKind: kind,
      financialEventId: id(20 + n),
      eventKind: eventKinds[n]!,
      lifecycleExpectedVersion: n,
      taskDraftId: id(2),
      taskId: id(1),
      scopeVersionId: id(3),
      eligibilityDecisionId: id(6),
      predecessorEventId: n === 0 ? null : id(19 + n),
      amountCents: n === 0 ? null : 12000,
      currency: n === 0 ? null : 'USD',
      externalReference: n === 0 ? 'fake:private-payment-reference' : null,
      occurredAt: now,
      expiresAt: n === 0 ? null : later,
      sourceTargetAuthorityId: id(11),
      sourceReleaseSha256: source.releaseSha256,
    },
  }));
  const history = { read: vi.fn().mockResolvedValue(prepared) };
  const repo = {
    prepareMaterialization: vi.fn().mockResolvedValue(phase),
    finalizeMaterialization: vi.fn().mockResolvedValue({ ...result, replayed: false }),
    claimMaterializationCompensation: vi
      .fn()
      .mockResolvedValue({ completed: false, command: compensation }),
  };
  const finance = {
    requestFinancialEvent: vi.fn().mockResolvedValue({}),
    readPredecessor: vi
      .fn()
      .mockImplementation(
        async (selector) =>
          events.find((e) => e.progress.operationKind === selector.operationKind) ?? null
      ),
  };
  const issue = vi.fn().mockResolvedValue({ actor_assertion_token: 'd'.repeat(64) });
  const facts = {
    workOrder: vi.fn(() => {
      throw Error('NO_RAW_WORK_ORDER_READ');
    }),
  };
  const createFinance = vi.fn().mockResolvedValue(finance);
  const app = new UniversalV1WorkOrderApplication(
    facts as never,
    repo as never,
    createFinance,
    history
  );
  const input = {
    conditional_hold_id: id(9),
    expected_eligibility_version: 2,
    idempotency_key: key,
    client_ts: now,
  };
  const run = () =>
    app.secureAndMaterializeFakeWorkOrder(
      id(7),
      { ...input, client_ts: new Date().toISOString() },
      { issue }
    );
  return {
    run,
    input,
    context,
    phase,
    prepared,
    completed,
    claimed,
    result,
    events,
    repo,
    finance,
    history,
    issue,
    facts,
    createFinance,
  };
}

describe('foreground Work Order committed-history resume', () => {
  it('authorizes before Phase A and requests only PREPARE before returning pending', async () => {
    const f = fixture();
    f.history.read.mockResolvedValueOnce(null).mockResolvedValue(f.prepared);
    f.finance.readPredecessor.mockResolvedValue(null);
    const result = await f.run();
    expect(result).toEqual({
      status: 'PENDING',
      stage: 'PAYMENT_SETUP',
      retry_after_ms: 1000,
      hard_assignment_created: false,
      payment_creation_performed: false,
    });
    expect(f.createFinance.mock.invocationCallOrder[0]).toBeLessThan(
      f.repo.prepareMaterialization.mock.invocationCallOrder[0]!
    );
    expect(f.repo.prepareMaterialization).toHaveBeenCalledWith(
      { conditional_hold_id: f.input.conditional_hold_id, eligibility_version: 2 },
      key,
      'd'.repeat(64),
      expect.any(String)
    );
    expect(f.finance.requestFinancialEvent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        operationKind: 'PREPARE_PAYMENT_METHOD',
        operationId: deterministicUuid(key, 'prepare'),
      }),
      { issue: f.issue }
    );
    expect(f.repo.finalizeMaterialization).not.toHaveBeenCalled();
    expect(f.facts.workOrder).not.toHaveBeenCalled();
  });
  it.each([0, 1, 2])(
    'resumes from committed boundary %i without reissuing earlier operations',
    async (boundary) => {
      const f = fixture();
      f.finance.readPredecessor.mockImplementation(
        async (selector) =>
          f.events
            .slice(0, boundary)
            .find((e) => e.predecessor?.operationKind === selector.operationKind) ?? null
      );
      const result = await f.run();
      expect(result.status).toBe('PENDING');
      expect(f.repo.prepareMaterialization).not.toHaveBeenCalled();
      expect(f.finance.requestFinancialEvent).toHaveBeenCalledTimes(1);
      const command = f.finance.requestFinancialEvent.mock.calls[0]![0] as any;
      expect(command.operationKind).toBe(
        ['PREPARE_PAYMENT_METHOD', 'AUTHORIZE', 'SECURE'][boundary]
      );
      if (boundary > 0)
        expect(command.predecessorEventId).toBe(
          f.events[boundary - 1]!.predecessor!.financialEventId
        );
      expect(JSON.stringify(result)).not.toContain('fake:private');
      expect(f.repo.finalizeMaterialization).not.toHaveBeenCalled();
    }
  );
  it('waits for a committed successful materialization before issuing a successor', async () => {
    const f = fixture();
    f.events[0]!.predecessor = null;
    f.events[0]!.progress.progressState = 'PROCESSING';
    f.events[0]!.progress.financialEvent = null;
    await expect(f.run()).resolves.toMatchObject({ status: 'PENDING', stage: 'PAYMENT_SETUP' });
    expect(f.finance.requestFinancialEvent).not.toHaveBeenCalled();
    expect(f.repo.finalizeMaterialization).not.toHaveBeenCalled();
  });
  it('finalizes using fresh authority and the exact original Phase A request', async () => {
    const f = fixture();
    await expect(f.run()).resolves.toEqual({
      status: 'MATERIALIZED',
      ...f.result,
      replayed: false,
    });
    expect(f.issue).toHaveBeenCalledExactlyOnceWith({
      commandKind: 'MATERIALIZE_FAKE_WORK_ORDER',
      commandPayload: {
        idempotency_key: key,
        request_sha256: f.phase.requestSha256,
        secured_event_id: id(22),
      },
    });
    expect(f.repo.finalizeMaterialization).toHaveBeenCalledWith(f.phase, id(22), 'd'.repeat(64));
    expect(f.finance.requestFinancialEvent).not.toHaveBeenCalled();
  });
  it('reads completed history after expiry without finance or preparation writes', async () => {
    const f = fixture();
    f.context.hold_expires_at = '2020-01-01T00:00:00.000Z';
    f.history.read.mockResolvedValue(f.completed);
    await expect(f.run()).resolves.toEqual({ status: 'MATERIALIZED', ...f.result });
    expect(f.repo.prepareMaterialization).not.toHaveBeenCalled();
    expect(f.finance.readPredecessor).not.toHaveBeenCalled();
    expect(f.issue).not.toHaveBeenCalled();
  });
  it.each(['hold_expires_at', 'eligibility_valid_until'] as const)(
    'never renews an expired %s to issue a new request',
    async (field) => {
      const f = fixture();
      f.context[field] = '2020-01-01T00:00:00.000Z';
      f.finance.readPredecessor.mockResolvedValue(null);
      await expect(f.run()).resolves.toMatchObject({ status: 'RECOVERY_REQUIRED' });
      expect(f.finance.requestFinancialEvent).not.toHaveBeenCalled();
    }
  );
  it('does not secure an expired authorization', async () => {
    const f = fixture();
    f.events[1]!.predecessor!.expiresAt = '2020-01-01T00:00:00.000Z';
    f.events.pop();
    await expect(f.run()).resolves.toMatchObject({
      status: 'RECOVERY_REQUIRED',
      stage: 'FINANCIAL_SECURITY',
    });
    expect(f.finance.requestFinancialEvent).not.toHaveBeenCalled();
  });
  it.each([
    'operationId',
    'scopeVersionId',
    'eligibilityDecisionId',
    'predecessorEventId',
  ] as const)('refuses substituted predecessor %s', async (field) => {
    const f = fixture();
    f.events[1]!.predecessor![field] = id(99);
    await expect(f.run()).rejects.toThrow('WORK_ORDER_RESUME_HISTORY_UNAVAILABLE');
    expect(f.finance.requestFinancialEvent).not.toHaveBeenCalled();
    expect(f.repo.finalizeMaterialization).not.toHaveBeenCalled();
  });
  it('resolves a lost finalization COMMIT from history before compensation', async () => {
    const f = fixture();
    f.repo.finalizeMaterialization.mockRejectedValue(Error('COMMIT_ACK_LOST'));
    f.history.read.mockResolvedValueOnce(f.prepared).mockResolvedValueOnce(f.completed);
    await expect(f.run()).resolves.toEqual({ status: 'MATERIALIZED', ...f.result });
    expect(f.repo.claimMaterializationCompensation).not.toHaveBeenCalled();
    expect(f.finance.requestFinancialEvent).not.toHaveBeenCalled();
  });
  it('claims compensation with fresh authority and submits one claim-bound VOID', async () => {
    const f = fixture();
    f.repo.finalizeMaterialization.mockRejectedValue(Error('FINALIZE_FAILED'));
    f.history.read
      .mockResolvedValueOnce(f.prepared)
      .mockResolvedValueOnce(f.prepared)
      .mockResolvedValueOnce(f.claimed);
    await expect(f.run()).resolves.toMatchObject({ status: 'COMPENSATING', stage: 'COMPENSATION' });
    expect(f.issue).toHaveBeenNthCalledWith(2, {
      commandKind: 'REQUEST_FAKE_WORK_ORDER_RECOVERY',
      commandPayload: {
        idempotency_key: key,
        request_sha256: f.phase.requestSha256,
        secured_event_id: id(22),
      },
    });
    expect(f.finance.requestFinancialEvent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        operationKind: 'VOID',
        operationId: f.claimed.compensation.void_operation_id,
        relatedOperationId: deterministicUuid(key, 'secure'),
        predecessorEventId: id(22),
        lifecycleExpectedVersion: 3,
      }),
      { issue: f.issue }
    );
  });
  it('honors the concurrent finalizer winner at the recovery claim boundary', async () => {
    const f = fixture();
    f.repo.finalizeMaterialization.mockRejectedValue(Error('AMBIGUOUS_COMMIT'));
    f.repo.claimMaterializationCompensation.mockResolvedValue({
      completed: true,
      result: f.result,
    } as never);
    await expect(f.run()).resolves.toEqual({ status: 'MATERIALIZED', ...f.result });
    expect(f.finance.requestFinancialEvent).not.toHaveBeenCalled();
  });
  it('resumes compensation first even after hold expiry without replaying preparation', async () => {
    const f = fixture();
    f.context.hold_expires_at = '2020-01-01T00:00:00.000Z';
    f.history.read.mockResolvedValue(f.claimed);
    await expect(f.run()).resolves.toMatchObject({ status: 'COMPENSATING' });
    expect(f.finance.readPredecessor).not.toHaveBeenCalled();
    expect(f.repo.finalizeMaterialization).not.toHaveBeenCalled();
    expect(f.repo.prepareMaterialization).not.toHaveBeenCalled();
  });
  it.each(['REQUESTED', 'RECOVERY_REQUIRED', 'MATERIALIZED'] as const)(
    'does not duplicate a claim VOID in %s',
    async (state) => {
      const f = fixture();
      f.claimed.voidProgress = {
        ...f.events[2]!.progress,
        operationKind: 'VOID',
        operationId: f.claimed.compensation.void_operation_id,
        progressState: state,
        financialEvent:
          state === 'MATERIALIZED'
            ? { id: id(50), eventKind: 'VOIDED', status: 'SUCCEEDED' }
            : null,
      };
      f.history.read.mockResolvedValue(f.claimed);
      await expect(f.run()).resolves.toMatchObject({
        status:
          state === 'MATERIALIZED'
            ? 'COMPENSATED'
            : state === 'REQUESTED'
              ? 'COMPENSATING'
              : 'RECOVERY_REQUIRED',
      });
      expect(f.finance.requestFinancialEvent).not.toHaveBeenCalled();
      expect(f.repo.finalizeMaterialization).not.toHaveBeenCalled();
    }
  );
  it('keeps committed outcomes awaiting materialization pollable without another request', async () => {
    const f = fixture();
    f.events[0]!.predecessor = null;
    f.events[0]!.progress.progressState = 'RECOVERY_REQUIRED';
    f.events[0]!.progress.financialEvent = null;
    await expect(f.run()).resolves.toMatchObject({
      status: 'RECOVERY_REQUIRED',
      retry_after_ms: 1000,
    });
    expect(f.finance.requestFinancialEvent).not.toHaveBeenCalled();
  });
  it('uses database observation time when the API clock is ahead of hold expiry', async () => {
    const f = fixture();
    f.finance.readPredecessor.mockResolvedValue(null);
    const skew = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 180_000);
    try {
      await expect(f.run()).resolves.toMatchObject({ status: 'PENDING', stage: 'PAYMENT_SETUP' });
      expect(f.finance.requestFinancialEvent).toHaveBeenCalledTimes(1);
    } finally {
      skew.mockRestore();
    }
  });
  it('rejects private additions and inconsistent public status contracts', () => {
    const pending = {
      status: 'PENDING',
      stage: 'PAYMENT_SETUP',
      retry_after_ms: 1000,
      hard_assignment_created: false,
      payment_creation_performed: false,
    };
    expect(
      UniversalV1WorkOrderPublicResultSchema.safeParse({ ...pending, providerReference: 'secret' })
        .success
    ).toBe(false);
    expect(
      UniversalV1WorkOrderPublicResultSchema.safeParse({ ...pending, status: 'COMPENSATED' })
        .success
    ).toBe(false);
    expect(
      UniversalV1WorkOrderPublicResultSchema.safeParse({
        ...pending,
        hard_assignment_created: true,
      }).success
    ).toBe(false);
  });
});
