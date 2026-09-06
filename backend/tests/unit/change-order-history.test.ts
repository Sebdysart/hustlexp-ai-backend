import { describe, expect, it, vi } from 'vitest';
import type { QueryFn } from '../../src/database-contracts.js';
import { PostgresUniversalV1ChangeOrderHistoryReader } from '../../src/services/UniversalV1ChangeOrderHistory.js';
import {
  ChangeOrderHistoryPayloadSchema,
  ChangeOrderHistorySchema,
} from '../../src/auth/change-order-history-command-contract.js';
import { parseUniversalV1ActorCommandPayload } from '../../src/auth/universal-v1-actor-attestation-contracts.js';
import { deterministicUuid } from '../../src/services/UniversalV1WorkOrderPostgresRepository.js';

const id = (n: number) => '40000000-0000-4000-8000-' + String(n).padStart(12, '0');
const key = 'change:history:000001';
const release = {
  manifestDigest: 'sha256:' + 'a'.repeat(64),
  releaseId: 'change-history-fixture',
  revision: 'b'.repeat(40),
  environment: 'local' as const,
  authenticationStatus: 'VERIFIED' as const,
};
const payload = {
  proposal_id: id(1),
  expected_proposal_version: 1,
  expected_scope_version: 2,
  expected_amendment_version: 0,
  expected_execution_version: 1,
  expected_financial_version: 2,
  idempotency_key: key,
};
function prepared() {
  return {
    state: 'PREPARED' as const,
    actorUserId: id(8),
    identity: { ...payload },
    observedAt: '2026-09-05T12:00:00.000Z',
    predecessorExpiresAt: '2026-01-01T00:15:00.000Z',
    phase: {
      completed: false as const,
      idempotencyKey: key,
      requestSha256: 'd'.repeat(64),
      context: {
        proposalId: id(1),
        workOrderId: id(2),
        taskId: id(3),
        taskDraftId: id(4),
        eligibilityDecisionId: id(5),
        scopeVersionId: id(6),
        scopeVersion: 3,
        customerTotalCents: 15000,
        currency: 'USD',
        predecessorEventId: id(7),
        predecessorOperationId: id(9),
        expectedFinancialVersion: 2,
        adjustmentOperationId: deterministicUuid(key, 'adjust'),
        occurredAt: '2026-01-01T00:00:00.000123Z',
      },
    },
    adjustmentRequestState: 'NOT_REQUESTED' as const,
    adjustmentProgress: null,
  };
}
function receipt() {
  return {
    history: prepared(),
    actor_user_id: id(8),
    actor_assertion_id: id(10),
    actor_request_sha256: 'c'.repeat(64),
    target_authority_id: id(11),
    reader_release_sha256: release.manifestDigest,
  };
}
function fixture(row: unknown = receipt()) {
  const issue = vi
    .fn()
    .mockResolvedValue({
      schema_version: 1,
      command_kind: 'READ_FAKE_CHANGE_ORDER_HISTORY',
      canonical_request_sha256: 'c'.repeat(64),
      actor_assertion_token: 'd'.repeat(64),
      assertion_expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
  const query = vi.fn().mockResolvedValue({ rows: [row], rowCount: 1 });
  const transaction = vi.fn(async (callback: (query: QueryFn) => Promise<unknown>) =>
    callback(query as QueryFn)
  );
  const authorize = vi.fn(() => release);
  const reader = new PostgresUniversalV1ChangeOrderHistoryReader(
    { transaction } as never,
    authorize
  );
  return {
    issue,
    query,
    transaction,
    authorize,
    reader,
    read: () => reader.read(payload, id(8), { issue }),
  };
}

describe('fresh authenticated change-order history', () => {
  it('binds all original expected versions without caller-selected identity or financial facts', () => {
    expect(parseUniversalV1ActorCommandPayload('READ_FAKE_CHANGE_ORDER_HISTORY', payload)).toEqual(
      payload
    );
    for (const extra of [
      { client_ts: new Date().toISOString() },
      { actor_user_id: id(8) },
      { adjustmentEventId: id(9) },
      { requestSha256: 'e'.repeat(64) },
    ])
      expect(ChangeOrderHistoryPayloadSchema.safeParse({ ...payload, ...extra }).success).toBe(
        false
      );
    for (const field of [
      'expected_proposal_version',
      'expected_scope_version',
      'expected_amendment_version',
      'expected_execution_version',
      'expected_financial_version',
    ]) {
      expect(
        ChangeOrderHistoryPayloadSchema.safeParse({ ...payload, [field]: 2147483648 }).success
      ).toBe(false);
      expect(ChangeOrderHistoryPayloadSchema.safeParse({ ...payload, [field]: -1 }).success).toBe(
        false
      );
    }
  });
  it('returns deeply immutable original time and expired predecessor truth under fresh read authority', async () => {
    const f = fixture(),
      history = await f.read();
    expect(history).toEqual(prepared());
    expect(history?.phase.context.occurredAt).toBe('2026-01-01T00:00:00.000123Z');
    expect(Object.isFrozen(history?.phase.context)).toBe(true);
    expect(Object.isFrozen(history?.identity)).toBe(true);
    expect(f.issue).toHaveBeenCalledExactlyOnceWith({
      commandKind: 'READ_FAKE_CHANGE_ORDER_HISTORY',
      commandPayload: payload,
    });
    expect(f.query).toHaveBeenCalledExactlyOnceWith(
      'SELECT * FROM public.hxos_read_authenticated_change_order_history_v13($1,$2)',
      ['d'.repeat(64), payload]
    );
    expect(f.authorize).toHaveBeenCalledTimes(2);
  });
  it('returns a uniform absent history without inventing a new phase', async () => {
    expect(await fixture({ ...receipt(), history: null }).read()).toBeNull();
  });
  it('waits for COMMIT and withholds history on ambiguous transaction completion', async () => {
    const f = fixture();
    let commit!: () => void;
    const gate = new Promise<void>((resolve) => {
      commit = resolve;
    });
    f.transaction.mockImplementation(async (callback) => {
      const result = await callback(f.query as QueryFn);
      await gate;
      return result;
    });
    let published = false;
    const pending = f.read().then((result) => {
      published = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(published).toBe(false);
    commit();
    expect(await pending).toEqual(prepared());
    f.transaction.mockRejectedValueOnce(new Error('COMMIT acknowledgement lost'));
    await expect(f.read()).rejects.toThrow('CHANGE_ORDER_HISTORY_UNAVAILABLE');
  });
  it.each([
    'actor',
    'request',
    'release',
    'identity',
    'operation',
    'scope',
    'version',
    'extra',
  ] as const)('rejects substituted receipt authority: %s', async (field) => {
    const row = receipt();
    if (field === 'actor') row.actor_user_id = id(12);
    if (field === 'request') row.actor_request_sha256 = 'e'.repeat(64);
    if (field === 'release') row.reader_release_sha256 = 'sha256:' + 'e'.repeat(64);
    if (field === 'identity') row.history.identity.expected_proposal_version++;
    if (field === 'operation') row.history.phase.context.adjustmentOperationId = id(12);
    if (field === 'scope') row.history.phase.context.scopeVersion++;
    if (field === 'version') row.history.phase.context.expectedFinancialVersion++;
    const f = fixture(
      field === 'extra' ? { ...row, externalReference: 'hidden-provider-data' } : row
    );
    await expect(f.read()).rejects.toThrow('CHANGE_ORDER_HISTORY_RECEIPT_BINDING_MISMATCH');
  });
  it.each(['kind', 'expired', 'token', 'digest'] as const)(
    'rejects invalid assertion before database access: %s',
    async (field) => {
      const f = fixture(),
        assertion = await f.issue();
      f.issue.mockClear();
      if (field === 'kind') assertion.command_kind = 'READ_FAKE_WORK_ORDER_HISTORY';
      if (field === 'expired') assertion.assertion_expires_at = '2020-01-01T00:00:00.000Z';
      if (field === 'token') assertion.actor_assertion_token = '0'.repeat(64);
      if (field === 'digest') assertion.canonical_request_sha256 = '0'.repeat(64);
      f.issue.mockResolvedValueOnce(assertion);
      await expect(f.read()).rejects.toThrow('CHANGE_ORDER_HISTORY_ASSERTION_INVALID');
      expect(f.transaction).not.toHaveBeenCalled();
    }
  );
  it('rejects release rollover before returning committed history', async () => {
    const f = fixture();
    f.authorize
      .mockReturnValueOnce(release)
      .mockReturnValueOnce({ ...release, manifestDigest: 'sha256:' + 'e'.repeat(64) });
    await expect(f.read()).rejects.toThrow('CHANGE_ORDER_HISTORY_RELEASE_AUTHORITY_CHANGED');
  });
  it('retains terminal cancellation without granting execution or capture', () => {
    const {
      adjustmentProgress: _progress,
      adjustmentRequestState: _request,
      predecessorExpiresAt: _expiry,
      ...common
    } = prepared();
    const cancelled = {
      ...common,
      state: 'CANCELLED',
      terminal: {
        terminalFactId: id(12),
        evidenceKind: 'NO_EFFECT',
        priorSecuredStateRestored: false,
        executionResumeAuthorized: false,
        captureResumeAuthorized: false,
      },
    };
    expect(ChangeOrderHistorySchema.safeParse(cancelled).success).toBe(true);
    for (const field of [
      'priorSecuredStateRestored',
      'executionResumeAuthorized',
      'captureResumeAuthorized',
    ])
      expect(
        ChangeOrderHistorySchema.safeParse({
          ...cancelled,
          terminal: { ...cancelled.terminal, [field]: true },
        }).success
      ).toBe(false);
  });
  it('binds compensation amount, actor, version and reversal progress to the original phase', () => {
    const {
      predecessorExpiresAt: _expiry,
      adjustmentProgress: _progress,
      adjustmentRequestState: _request,
      ...common
    } = prepared();
    const claim = {
      ...common,
      state: 'COMPENSATION_CLAIM',
      reversalRequestState: 'NOT_REQUESTED',
      reversalProgress: null,
      compensation: {
        compensationCommandId: id(12),
        adjustmentEventId: id(13),
        reversalOperationId: id(14),
        reversalIdempotencyKey: key + ':reversal',
        baseScopeVersionId: id(15),
        lifecycleExpectedVersion: 4,
        amountCents: 15000,
        currency: 'USD',
        requestedBy: id(8),
        createdAt: common.observedAt,
        semanticLimitation: 'PRIOR_SECURED_STATE_NOT_RESTORED',
      },
    };
    expect(ChangeOrderHistorySchema.safeParse(claim).success).toBe(true);
    for (const update of [
      { amountCents: 1 },
      { requestedBy: id(16) },
      { lifecycleExpectedVersion: 3 },
    ])
      expect(
        ChangeOrderHistorySchema.safeParse({
          ...claim,
          compensation: { ...claim.compensation, ...update },
        }).success
      ).toBe(false);
  });
  it('keeps a request without a verified outbox distinct from absence and rejects incomplete outbox progress', () => {
    expect(
      ChangeOrderHistorySchema.parse({ ...prepared(), adjustmentRequestState: 'UNADMITTED_HELD' })
        .state
    ).toBe('PREPARED');
    expect(
      ChangeOrderHistorySchema.safeParse({
        ...prepared(),
        adjustmentRequestState: 'OUTBOX_RECORDED',
      }).success
    ).toBe(false);
  });
});
