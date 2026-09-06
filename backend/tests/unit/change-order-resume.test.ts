import { describe, expect, it, vi } from 'vitest';
import { UniversalV1ChangeOrderApplication } from '../../src/services/UniversalV1ChangeOrderApplication.js';
import {
  UniversalV1ChangeOrderPublicResultSchema,
  UniversalV1ChangeOrderError,
} from '../../src/services/UniversalV1ChangeOrderContracts.js';
import type { ChangeOrderHistory } from '../../src/auth/change-order-history-command-contract.js';
import { deterministicUuid } from '../../src/services/UniversalV1WorkOrderPostgresRepository.js';
import { UniversalV1FinancialRequestService } from '../../src/services/payment/UniversalV1FinancialRequestService.js';
import { InMemoryUniversalV1PreparedFinancialCommandAuthority } from '../../src/services/payment/PreparedFinancialCommandAuthority.js';
import { InMemoryFinancialProviderCommandJournal } from '../../src/services/payment/FinancialProviderCommandJournal.js';

const id = (n: number) => '40000000-0000-4000-8000-' + String(n).padStart(12, '0');
function fixture() {
  const now = Date.now(),
    current = new Date(now).toISOString(),
    old = new Date(now - 600_000).toISOString();
  const identity = {
    proposal_id: id(1),
    expected_proposal_version: 1,
    expected_scope_version: 1,
    expected_amendment_version: 0,
    expected_execution_version: 1,
    expected_financial_version: 2,
    idempotency_key: 'changeorder:resume:0001',
  };
  const phase = {
    completed: false as const,
    idempotencyKey: identity.idempotency_key,
    requestSha256: 'a'.repeat(64),
    context: {
      proposalId: id(1),
      workOrderId: id(2),
      taskId: id(3),
      taskDraftId: id(4),
      eligibilityDecisionId: id(5),
      scopeVersionId: id(6),
      scopeVersion: 2,
      customerTotalCents: 15000,
      currency: 'USD',
      predecessorEventId: id(7),
      predecessorOperationId: id(8),
      expectedFinancialVersion: 2,
      adjustmentOperationId: deterministicUuid(identity.idempotency_key, 'adjust'),
      occurredAt: old,
    },
  };
  const common = { identity, phase, observedAt: current, actorUserId: id(9) };
  const prepared: Extract<ChangeOrderHistory, { state: 'PREPARED' }> = {
    ...common,
    state: 'PREPARED',
    adjustmentRequestState: 'NOT_REQUESTED',
    adjustmentProgress: null,
    predecessorExpiresAt: new Date(now + 60_000).toISOString(),
  };
  const result = {
    amendment_id: id(10),
    amendment_version: 1,
    proposal_id: id(1),
    scope_version_id: id(6),
    scope_version: 2,
    adjustment_event_id: id(11),
    provider_kind: 'FAKE' as const,
    replayed: true as const,
    payment_creation_performed: false as const,
    hard_assignment_created: false as const,
  };
  const completed: ChangeOrderHistory = { ...common, state: 'COMPLETED', result };
  const progress = {
    commandId: id(12),
    operationId: phase.context.adjustmentOperationId,
    operationKind: 'ADJUST' as const,
    taskDraftId: id(4),
    taskId: id(3),
    requestedAt: old,
    observedAt: current,
    requestState: 'REQUESTED' as const,
    progressState: 'PROCESSING' as const,
    financialEvent: null,
  };
  const adjusted: Extract<ChangeOrderHistory, { state: 'PREPARED' }> = {
    ...prepared,
    adjustmentRequestState: 'OUTBOX_RECORDED',
    adjustmentProgress: {
      ...progress,
      progressState: 'MATERIALIZED',
      financialEvent: { id: id(11), eventKind: 'ADJUSTMENT_AUTHORIZED', status: 'SUCCEEDED' },
    },
  };
  const claimed: Extract<ChangeOrderHistory, { state: 'COMPENSATION_CLAIM' }> = {
    ...common,
    state: 'COMPENSATION_CLAIM',
    compensation: {
      compensationCommandId: id(13),
      adjustmentEventId: id(11),
      reversalOperationId: id(14),
      reversalIdempotencyKey: identity.idempotency_key + ':reverse',
      baseScopeVersionId: id(15),
      lifecycleExpectedVersion: 4,
      amountCents: 15000,
      currency: 'USD',
      requestedBy: id(9),
      createdAt: old,
      semanticLimitation: 'PRIOR_SECURED_STATE_NOT_RESTORED',
    },
    reversalRequestState: 'NOT_REQUESTED',
    reversalProgress: null,
  };
  const cancelled: ChangeOrderHistory = {
    ...common,
    state: 'CANCELLED',
    terminal: {
      terminalFactId: id(16),
      evidenceKind: 'REVERSAL',
      priorSecuredStateRestored: false,
      executionResumeAuthorized: false,
      captureResumeAuthorized: false,
    },
  };
  const materialization = {
    readKind: vi.fn().mockResolvedValue('PRICE_AND_SCOPE'),
    prepare: vi.fn().mockResolvedValue(phase),
    finalize: vi.fn().mockResolvedValue({ ...result, replayed: false }),
  };
  const history = { read: vi.fn().mockResolvedValue(prepared) };
  const finance = { requestFinancialEvent: vi.fn().mockResolvedValue({}) };
  const createFinance = vi.fn().mockResolvedValue(finance),
    attestation = { issue: vi.fn() },
    commands = { propose: vi.fn(), decide: vi.fn() };
  const app = new UniversalV1ChangeOrderApplication(
    materialization as never,
    createFinance,
    () => now,
    commands,
    history
  );
  const input = { ...identity, client_ts: current },
    run = () => app.authorizeAndMaterializeFakeChangeOrder(id(9), input, attestation);
  return {
    now,
    input,
    run,
    phase,
    prepared,
    completed,
    adjusted,
    claimed,
    cancelled,
    result,
    progress,
    materialization,
    history,
    finance,
    createFinance,
    attestation,
  };
}

describe('foreground ChangeOrder committed-history resume', () => {
  it.each(['adjustment_event_id', 'provider_kind'] as const)(
    'rejects incomplete materialized %s evidence',
    (field) => {
      const f = fixture();
      expect(
        UniversalV1ChangeOrderPublicResultSchema.safeParse({
          status: 'MATERIALIZED',
          ...f.result,
          [field]: null,
        }).success
      ).toBe(false);
    }
  );
  it.each([
    'CHANGE_ORDER_VERSION_CONFLICT',
    'CHANGE_ORDER_IDEMPOTENCY_CONFLICT',
    'CHANGE_ORDER_INDEPENDENT_APPROVAL_REQUIRED',
    'CHANGE_ORDER_REQUEST_STALE',
  ] as const)('preserves definitive %s rejection when no preparation committed', async (code) => {
    const f = fixture(),
      error = new UniversalV1ChangeOrderError(code, 'Preparation refused.');
    f.history.read.mockResolvedValue(null);
    f.materialization.prepare.mockRejectedValue(error);
    await expect(f.run()).rejects.toBe(error);
    expect(f.history.read).toHaveBeenCalledTimes(2);
    expect(f.finance.requestFinancialEvent).not.toHaveBeenCalled();
    expect(f.materialization.finalize).not.toHaveBeenCalled();
  });
  it('keeps an ambiguous preparation failure in recovery when history has no witness', async () => {
    const f = fixture();
    f.history.read.mockResolvedValue(null);
    f.materialization.prepare.mockRejectedValue(
      new UniversalV1ChangeOrderError('CHANGE_ORDER_MATERIALIZATION_FAILED', 'Ambiguous commit.')
    );
    expect(await f.run()).toMatchObject({
      status: 'RECOVERY_REQUIRED',
      stage: 'ADJUSTMENT',
      retry_after_ms: null,
    });
    expect(f.materialization.prepare).toHaveBeenCalledOnce();
    expect(f.finance.requestFinancialEvent).not.toHaveBeenCalled();
  });
  it('commits preparation, re-reads history and submits one durable adjustment', async () => {
    const f = fixture();
    f.history.read.mockResolvedValueOnce(null).mockResolvedValue(f.prepared);
    expect(await f.run()).toMatchObject({
      status: 'PENDING',
      stage: 'ADJUSTMENT',
      retry_after_ms: 1000,
    });
    expect(f.materialization.prepare).toHaveBeenCalledExactlyOnceWith(
      id(9),
      f.input,
      f.attestation
    );
    expect(f.createFinance.mock.invocationCallOrder[0]).toBeLessThan(
      f.materialization.prepare.mock.invocationCallOrder[0]!
    );
    expect(f.materialization.prepare.mock.invocationCallOrder[0]).toBeLessThan(
      f.finance.requestFinancialEvent.mock.invocationCallOrder[0]!
    );
    expect(f.finance.requestFinancialEvent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        operationKind: 'ADJUST',
        recordedBy: id(9),
        operationId: f.phase.context.adjustmentOperationId,
        idempotencyKey: f.input.idempotency_key + ':adjust',
        lifecycleExpectedVersion: 3,
        scopeVersionId: id(6),
        predecessorEventId: id(7),
        relatedOperationId: id(8),
        amountCents: 15000,
        currency: 'usd',
        occurredAt: f.phase.context.occurredAt,
      }),
      f.attestation
    );
    expect(f.materialization.finalize).not.toHaveBeenCalled();
  });
  it('resumes an old prepared witness without generating a replacement', async () => {
    const f = fixture();
    expect(await f.run()).toMatchObject({ status: 'PENDING' });
    expect(f.materialization.prepare).not.toHaveBeenCalled();
    expect(f.finance.requestFinancialEvent.mock.calls[0]![0].occurredAt).toBe(
      f.phase.context.occurredAt
    );
  });
  it.each(['REQUESTED', 'PUBLISHED', 'PROCESSING', 'RECOVERY_REQUIRED'] as const)(
    'observes admitted %s progress without resubmission',
    async (progressState) => {
      const f = fixture();
      f.history.read.mockResolvedValue({
        ...f.prepared,
        adjustmentRequestState: 'OUTBOX_RECORDED',
        adjustmentProgress: { ...f.progress, progressState },
      });
      expect(await f.run()).toMatchObject({
        status: progressState === 'RECOVERY_REQUIRED' ? 'RECOVERY_REQUIRED' : 'PENDING',
        stage: 'ADJUSTMENT',
        retry_after_ms: 1000,
      });
      expect(f.finance.requestFinancialEvent).not.toHaveBeenCalled();
      expect(f.materialization.prepare).not.toHaveBeenCalled();
      expect(f.materialization.finalize).not.toHaveBeenCalled();
    }
  );
  it('holds an unadmitted legacy request without inventing admission', async () => {
    const f = fixture();
    f.history.read.mockResolvedValue({ ...f.prepared, adjustmentRequestState: 'UNADMITTED_HELD' });
    expect(await f.run()).toMatchObject({ status: 'RECOVERY_REQUIRED', retry_after_ms: null });
    expect(f.finance.requestFinancialEvent).not.toHaveBeenCalled();
  });
  it('does not request against expired predecessor security', async () => {
    const f = fixture();
    f.history.read.mockResolvedValue({
      ...f.prepared,
      predecessorExpiresAt: new Date(f.now - 1).toISOString(),
    });
    expect(await f.run()).toMatchObject({ status: 'RECOVERY_REQUIRED' });
    expect(f.finance.requestFinancialEvent).not.toHaveBeenCalled();
  });
  it('finalizes committed ADJUST with fresh client time even when original predecessor has expired', async () => {
    const f = fixture();
    f.history.read.mockResolvedValue({
      ...f.adjusted,
      predecessorExpiresAt: new Date(f.now - 1).toISOString(),
    });
    expect(await f.run()).toMatchObject({ status: 'MATERIALIZED', replayed: false });
    expect(f.materialization.finalize).toHaveBeenCalledExactlyOnceWith(
      id(9),
      f.input,
      f.phase.requestSha256,
      id(11),
      f.input.client_ts,
      f.attestation
    );
    expect(f.finance.requestFinancialEvent).not.toHaveBeenCalled();
    expect(f.materialization.prepare).not.toHaveBeenCalled();
  });
  it.each(['DECLINED', 'FAILED'] as const)(
    'reports %s adjustment as recovery without materializing',
    async (status) => {
      const f = fixture();
      f.history.read.mockResolvedValue({
        ...f.adjusted,
        adjustmentProgress: {
          ...f.adjusted.adjustmentProgress!,
          financialEvent: { id: id(11), eventKind: 'ADJUSTMENT_AUTHORIZED', status },
        },
      });
      expect(await f.run()).toMatchObject({ status: 'RECOVERY_REQUIRED', stage: 'ADJUSTMENT' });
      expect(f.materialization.finalize).not.toHaveBeenCalled();
      expect(f.finance.requestFinancialEvent).not.toHaveBeenCalled();
    }
  );
  it('returns completed history before trying current preparation or financial requests', async () => {
    const f = fixture();
    f.history.read.mockResolvedValue(f.completed);
    expect(await f.run()).toEqual({ status: 'MATERIALIZED', ...f.result });
    expect(f.materialization.prepare).not.toHaveBeenCalled();
    expect(f.materialization.finalize).not.toHaveBeenCalled();
    expect(f.finance.requestFinancialEvent).not.toHaveBeenCalled();
  });
  it('resolves an ambiguous finalization COMMIT from committed history', async () => {
    const f = fixture();
    f.history.read.mockResolvedValueOnce(f.adjusted).mockResolvedValue(f.completed);
    f.materialization.finalize.mockRejectedValue(Error('LOST_COMMIT_RESPONSE'));
    expect(await f.run()).toEqual({ status: 'MATERIALIZED', ...f.result });
    expect(f.materialization.finalize).toHaveBeenCalledOnce();
    expect(f.finance.requestFinancialEvent).not.toHaveBeenCalled();
  });
  it('preserves a successful adjustment when finalization needs governed recovery', async () => {
    const f = fixture();
    f.history.read.mockResolvedValue(f.adjusted);
    f.materialization.finalize.mockRejectedValue(Error('AUTHORITY_REVOKED'));
    expect(await f.run()).toMatchObject({
      status: 'RECOVERY_REQUIRED',
      stage: 'FINALIZATION',
      retry_after_ms: null,
    });
    expect(f.finance.requestFinancialEvent).not.toHaveBeenCalled();
  });
  it('resolves an ambiguous request COMMIT without submitting another request', async () => {
    const f = fixture();
    f.history.read.mockResolvedValueOnce(f.prepared).mockResolvedValue({
      ...f.prepared,
      adjustmentRequestState: 'OUTBOX_RECORDED',
      adjustmentProgress: f.progress,
    });
    f.finance.requestFinancialEvent.mockRejectedValue(Error('LOST_REQUEST_RESPONSE'));
    expect(await f.run()).toMatchObject({ status: 'PENDING' });
    expect(f.finance.requestFinancialEvent).toHaveBeenCalledOnce();
  });
  it('propagates unavailable history after an ambiguous request without retrying the write', async () => {
    const f = fixture();
    f.history.read
      .mockResolvedValueOnce(f.prepared)
      .mockRejectedValue(Error('HISTORY_UNAVAILABLE'));
    f.finance.requestFinancialEvent.mockRejectedValue(Error('LOST_REQUEST_RESPONSE'));
    await expect(f.run()).rejects.toThrow('HISTORY_UNAVAILABLE');
    expect(f.finance.requestFinancialEvent).toHaveBeenCalledOnce();
    expect(f.materialization.prepare).not.toHaveBeenCalled();
    expect(f.materialization.finalize).not.toHaveBeenCalled();
  });
  it('requests only the exact stored reversal for a compensation claim', async () => {
    const f = fixture();
    const service = new UniversalV1FinancialRequestService(
      new InMemoryUniversalV1PreparedFinancialCommandAuthority(),
      new InMemoryFinancialProviderCommandJournal(),
      () => ({
        manifestDigest: 'sha256:' + 'b'.repeat(64),
        releaseId: 'synthetic.changeorder.resume',
        revision: 'd'.repeat(40),
        environment: 'local',
        authenticationStatus: 'VERIFIED',
      })
    );
    f.finance.requestFinancialEvent.mockImplementation(service.requestFinancialEvent.bind(service));
    f.history.read.mockResolvedValue(f.claimed);
    expect(await f.run()).toMatchObject({ status: 'COMPENSATING', stage: 'COMPENSATION' });
    expect(f.finance.requestFinancialEvent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        operationKind: 'REVERSAL',
        operationId: id(14),
        recordedBy: id(9),
        idempotencyKey: f.claimed.compensation.reversalIdempotencyKey,
        lifecycleExpectedVersion: 4,
        scopeVersionId: id(15),
        predecessorEventId: id(11),
        relatedOperationId: f.phase.context.adjustmentOperationId,
        occurredAt: f.claimed.compensation.createdAt,
      }),
      f.attestation
    );
    expect(f.finance.requestFinancialEvent.mock.calls[0]![0]).not.toHaveProperty('changeOrderId');
    expect(f.materialization.finalize).not.toHaveBeenCalled();
  });
  it('keeps a denied delegate reversal in recovery without claiming compensation succeeded', async () => {
    const f = fixture();
    f.history.read.mockResolvedValue(f.claimed);
    f.finance.requestFinancialEvent.mockRejectedValue(Error('CUSTOMER_AUTHORITY_REVOKED'));
    expect(await f.run()).toMatchObject({
      status: 'RECOVERY_REQUIRED',
      stage: 'COMPENSATION',
      retry_after_ms: null,
    });
    expect(f.finance.requestFinancialEvent).toHaveBeenCalledOnce();
  });
  it('does not convert a materialized reversal into a cancelled domain fact', async () => {
    const f = fixture();
    f.history.read.mockResolvedValue({
      ...f.claimed,
      reversalRequestState: 'OUTBOX_RECORDED',
      reversalProgress: {
        ...f.progress,
        operationKind: 'REVERSAL',
        operationId: id(14),
        progressState: 'MATERIALIZED',
        financialEvent: { id: id(17), eventKind: 'REVERSED', status: 'SUCCEEDED' },
      },
    });
    expect(await f.run()).toMatchObject({ status: 'RECOVERY_REQUIRED', stage: 'COMPENSATION' });
    expect(f.finance.requestFinancialEvent).not.toHaveBeenCalled();
  });
  it('returns authoritative cancellation without restoring prior security or authorizing execution', async () => {
    const f = fixture();
    f.history.read.mockResolvedValue(f.cancelled);
    const result = await f.run();
    expect(result).toEqual({
      status: 'CANCELLED',
      stage: 'COMPENSATION',
      retry_after_ms: null,
      prior_secured_state_restored: false,
      execution_resume_authorized: false,
      capture_resume_authorized: false,
      payment_creation_performed: false,
      hard_assignment_created: false,
    });
    expect(UniversalV1ChangeOrderPublicResultSchema.safeParse(result).success).toBe(true);
    expect(f.finance.requestFinancialEvent).not.toHaveBeenCalled();
    expect(f.materialization.prepare).not.toHaveBeenCalled();
  });
  it.each(['actor', 'version', 'request'])(
    'refuses mismatched committed %s history before consequential work',
    async (kind) => {
      const f = fixture();
      const bad = structuredClone(f.prepared);
      if (kind === 'actor') bad.actorUserId = id(99);
      if (kind === 'version') bad.identity.expected_execution_version++;
      if (kind === 'request') bad.phase.requestSha256 = '0'.repeat(64);
      f.history.read.mockResolvedValue(bad);
      await expect(f.run()).rejects.toMatchObject({ code: 'CHANGE_ORDER_CONTEXT_UNAVAILABLE' });
      expect(f.finance.requestFinancialEvent).not.toHaveBeenCalled();
      expect(f.materialization.finalize).not.toHaveBeenCalled();
    }
  );
});
