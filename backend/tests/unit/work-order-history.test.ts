import { describe, expect, it, vi } from 'vitest';
import type { QueryFn } from '../../src/database-contracts.js';
import { PostgresUniversalV1WorkOrderHistoryReader } from '../../src/services/UniversalV1WorkOrderHistory.js';
import {
  WorkOrderHistoryPayloadSchema,
  WorkOrderHistorySchema,
} from '../../src/auth/work-order-history-command-contract.js';
import { parseUniversalV1ActorCommandPayload } from '../../src/auth/universal-v1-actor-attestation-contracts.js';

const id = (n: number) => '40000000-0000-4000-8000-' + String(n).padStart(12, '0');
const key = 'history:read:000001';
const release = {
  manifestDigest: 'sha256:' + 'a'.repeat(64),
  releaseId: 'history-fixture',
  revision: 'b'.repeat(40),
  environment: 'local' as const,
  authenticationStatus: 'VERIFIED' as const,
};
const payload = {
  conditional_hold_id: id(1),
  expected_eligibility_version: 2,
  idempotency_key: key,
};
function prepared() {
  const time = '2026-01-01T00:00:00.000123Z';
  return {
    state: 'PREPARED' as const,
    observedAt: '2026-09-05T00:00:00.000Z',
    phase: {
      completed: false as const,
      idempotencyKey: key,
      requestSha256: 'd'.repeat(64),
      occurredAt: time,
      context: {
        task_id: id(2),
        task_draft_id: id(3),
        scope_version_id: id(4),
        scope_version: 1,
        routing_decision_id: id(5),
        provider_user_id: id(6),
        provider_organization_id: null,
        provider_class: 'GENERAL_SERVICE_PROVIDER' as const,
        trade_credential_id: null,
        predecessor_eligibility_id: id(7),
        predecessor_eligibility_version: 2,
        predecessor_valid_until: time,
        poster_user_id: id(8),
        interest_application_id: id(9),
        eligibility_decision_id: id(7),
        eligibility_version: 2,
        eligibility_valid_until: time,
        conditional_hold_id: id(1),
        hold_reserved_at: time,
        hold_expires_at: time,
        provider_estimate_submission_id: id(10),
        customer_total_cents: 12000,
        currency: 'USD',
      },
    },
    source: {
      targetAuthorityId: id(11),
      releaseSha256: 'sha256:' + 'e'.repeat(64),
      canonicalRequestSha256: 'f'.repeat(64),
      preparationExecutionId: id(12),
    },
  };
}
function receipt() {
  return {
    history: prepared(),
    actor_user_id: id(8),
    actor_assertion_id: id(13),
    actor_request_sha256: 'c'.repeat(64),
    target_authority_id: id(14),
    reader_release_sha256: release.manifestDigest,
  };
}
function fixture(row: unknown = receipt()) {
  const issue = vi.fn().mockResolvedValue({
    schema_version: 1,
    command_kind: 'READ_FAKE_WORK_ORDER_HISTORY',
    canonical_request_sha256: 'c'.repeat(64),
    actor_assertion_token: 'd'.repeat(64),
    assertion_expires_at: new Date(Date.now() + 60_000).toISOString(),
  });
  const query = vi.fn().mockResolvedValue({ rows: [row], rowCount: 1 });
  const transaction = vi.fn(async (callback: (query: QueryFn) => Promise<unknown>) =>
    callback(query as QueryFn)
  );
  const authorize = vi.fn(() => release);
  const reader = new PostgresUniversalV1WorkOrderHistoryReader({ transaction } as never, authorize);
  return {
    issue,
    query,
    transaction,
    authorize,
    reader,
    read: () => reader.read(payload, id(8), { issue }),
  };
}
describe('fresh authenticated Work Order history contract', () => {
  it('binds the closed identity without a replacement timestamp or caller financial facts', () => {
    expect(parseUniversalV1ActorCommandPayload('READ_FAKE_WORK_ORDER_HISTORY', payload)).toEqual(
      payload
    );
    for (const extra of [
      { client_ts: new Date().toISOString() },
      { actor_user_id: id(8) },
      { commandId: id(9) },
      { secured_event_id: id(9) },
    ])
      expect(WorkOrderHistoryPayloadSchema.safeParse({ ...payload, ...extra }).success).toBe(false);
    expect(
      WorkOrderHistoryPayloadSchema.safeParse({
        ...payload,
        expected_eligibility_version: 2147483648,
      }).success
    ).toBe(false);
  });
  it('returns immutable old source facts under fresh current read authority without renewing expiry', async () => {
    const f = fixture();
    const history = await f.read();
    expect(history).toEqual(prepared());
    expect(f.issue).toHaveBeenCalledExactlyOnceWith({
      commandKind: 'READ_FAKE_WORK_ORDER_HISTORY',
      commandPayload: payload,
    });
    expect(f.query).toHaveBeenCalledExactlyOnceWith(
      'SELECT * FROM public.hxos_read_authenticated_work_order_history_v13($1,$2)',
      ['d'.repeat(64), payload]
    );
    expect(Object.isFrozen(history!.phase.context)).toBe(true);
    expect(Object.isFrozen(history!.source)).toBe(true);
    expect(f.authorize).toHaveBeenCalledTimes(2);
  });
  it('does not release history before COMMIT resolves', async () => {
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
    let returned = false;
    const read = f.read().then((value) => {
      returned = true;
      return value;
    });
    await vi.waitFor(() => expect(f.query).toHaveBeenCalledTimes(1));
    expect(returned).toBe(false);
    commit();
    await expect(read).resolves.toEqual(prepared());
  });
  it('treats a lost COMMIT acknowledgement as unavailable instead of returning prepared authority', async () => {
    const f = fixture();
    f.transaction.mockImplementation(async (callback) => {
      await callback(f.query as QueryFn);
      throw Error('private database failure');
    });
    await expect(f.read()).rejects.toThrow('WORK_ORDER_HISTORY_UNAVAILABLE');
  });
  it('rejects a release change while the read commits', async () => {
    const f = fixture();
    f.authorize
      .mockReturnValueOnce(release)
      .mockReturnValue({ ...release, manifestDigest: 'sha256:' + 'f'.repeat(64) });
    await expect(f.read()).rejects.toThrow('WORK_ORDER_HISTORY_RELEASE_AUTHORITY_CHANGED');
  });
  it.each(['actor_user_id', 'actor_request_sha256', 'reader_release_sha256'] as const)(
    'rejects a substituted %s receipt',
    async (field) => {
      const row = receipt();
      row[field] =
        field === 'actor_user_id'
          ? id(99)
          : field === 'actor_request_sha256'
            ? 'f'.repeat(64)
            : 'sha256:' + 'f'.repeat(64);
      await expect(fixture(row).read()).rejects.toThrow(
        'WORK_ORDER_HISTORY_RECEIPT_BINDING_MISMATCH'
      );
    }
  );
  it.each(['conditional_hold_id', 'poster_user_id'] as const)(
    'rejects a substituted historical %s',
    async (field) => {
      const row = receipt();
      row.history.phase.context[field] = id(99);
      await expect(fixture(row).read()).rejects.toThrow(
        'WORK_ORDER_HISTORY_RECEIPT_BINDING_MISMATCH'
      );
    }
  );
  it('allows an authenticated absent result but rejects private additions and inconsistent historical timestamps', async () => {
    await expect(fixture({ ...receipt(), history: null }).read()).resolves.toBeNull();
    await expect(fixture({ ...receipt(), providerReference: 'private' }).read()).rejects.toThrow(
      'WORK_ORDER_HISTORY_RECEIPT_BINDING_MISMATCH'
    );
    const history = prepared();
    history.phase.occurredAt = '2026-01-01T00:00:01.000123Z';
    expect(WorkOrderHistorySchema.safeParse(history).success).toBe(false);
  });
  it.each([
    { command_kind: 'PREPARE_FAKE_WORK_ORDER' },
    { actor_assertion_token: '0'.repeat(64) },
    { assertion_expires_at: '2020-01-01T00:00:00.000Z' },
  ])('rejects invalid or expired assertion metadata before the database', async (override) => {
    const f = fixture();
    const original = await f.issue();
    f.issue.mockResolvedValue({ ...original, ...override });
    await expect(f.read()).rejects.toThrow('WORK_ORDER_HISTORY_ASSERTION_INVALID');
    expect(f.query).not.toHaveBeenCalled();
  });
  it('rejects malformed caller payload before issuing an assertion', async () => {
    const f = fixture();
    await expect(
      f.reader.read({ ...payload, idempotency_key: 'too-short' }, id(8), { issue: f.issue })
    ).rejects.toThrow('WORK_ORDER_HISTORY_UNAVAILABLE');
    expect(f.issue).not.toHaveBeenCalled();
  });
});
