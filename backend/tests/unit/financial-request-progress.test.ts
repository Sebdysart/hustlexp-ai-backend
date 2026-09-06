import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../../src/db.js';
import type { QueryFn } from '../../src/database-contracts.js';
import { PostgresUniversalV1FinancialRequestProgressReader } from '../../src/services/payment/UniversalV1FinancialRequestProgress.js';
import {
  buildUniversalV1CanonicalActorRequest,
  parseUniversalV1ActorCommandPayload,
} from '../../src/auth/universal-v1-actor-attestation-contracts.js';
import { PostgresUniversalV1CanonicalRequestAuthority } from '../../src/services/UniversalV1ActorAttesterClient.js';
const id = (n: number) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const release = {
  manifestDigest: 'sha256:' + 'a'.repeat(64),
  releaseId: 'synthetic.progress',
  revision: 'b'.repeat(40),
  environment: 'local' as const,
  authenticationStatus: 'VERIFIED' as const,
};
const command = {
  commandKind: 'READ_FAKE_FINANCIAL_REQUEST_PROGRESS',
  commandPayload: { commandId: id(1) },
} as const;
const assertion = () => ({
  schema_version: 1 as const,
  command_kind: command.commandKind,
  canonical_request_sha256: 'c'.repeat(64),
  actor_assertion_token: 'd'.repeat(64),
  assertion_expires_at: new Date(Date.now() + 60_000).toISOString(),
});
const progress = () => ({
  commandId: id(1),
  operationId: id(2),
  operationKind: 'PREPARE_PAYMENT_METHOD' as const,
  taskDraftId: id(3),
  taskId: null,
  requestedAt: '2026-09-05T00:00:00.000Z',
  observedAt: '2026-09-05T00:00:01.000Z',
  requestState: 'REQUESTED' as const,
  progressState: 'REQUESTED' as const,
  financialEvent: null,
});
const receipt = () => ({
  progress: progress(),
  actor_user_id: id(4),
  actor_assertion_id: id(5),
  target_authority_id: id(6),
  actor_request_sha256: 'c'.repeat(64),
  reader_release_sha256: release.manifestDigest,
});
function fixture(row: unknown = receipt()) {
  const query = vi.fn().mockResolvedValue({ rows: [row], rowCount: 1 });
  const transaction = vi.fn(async (callback: (query: QueryFn) => Promise<unknown>) =>
    callback(query as QueryFn)
  );
  const issue = vi.fn().mockResolvedValue(assertion());
  const reader = new PostgresUniversalV1FinancialRequestProgressReader({
    transaction,
  } as unknown as Database);
  return { query, transaction, issue, read: () => reader.read(id(1), id(4), { issue }, release) };
}
describe('attested public financial progress', () => {
  it('uses the closed progress builder and binds only the requested command ID', async () => {
    const target = {
      id: id(6),
      version: 1,
      database: 'hx_ci_admin_test',
      environment: 'local' as const,
      release: release.manifestDigest,
    };
    const canonical = buildUniversalV1CanonicalActorRequest(
      release.manifestDigest,
      command,
      target
    );
    const query = vi
      .fn()
      .mockResolvedValue({
        rows: [
          {
            target_authority_id: id(6),
            environment: 'local',
            release_manifest_sha256: release.manifestDigest,
            canonical_request: canonical,
            actor_request_sha256: 'c'.repeat(64),
          },
        ],
        rowCount: 1,
      });
    expect(
      (await new PostgresUniversalV1CanonicalRequestAuthority(query as QueryFn).build(command))
        .canonicalRequest
    ).toEqual(canonical);
    expect(query.mock.calls[0][0]).toContain(
      'public.hxos_build_fake_financial_progress_actor_request_v13'
    );
    expect(query.mock.calls[0][1]).toEqual([command.commandKind, { commandId: id(1) }]);
    expect(() =>
      parseUniversalV1ActorCommandPayload(command.commandKind, {
        ...command.commandPayload,
        actorId: id(4),
      })
    ).toThrow();
  });
  it('returns a frozen minimal snapshot through one sealed transactional call', async () => {
    const f = fixture();
    const result = await f.read();
    expect(result).toEqual(progress());
    expect(Object.isFrozen(result)).toBe(true);
    expect(f.issue).toHaveBeenCalledExactlyOnceWith(command);
    expect(f.query).toHaveBeenCalledExactlyOnceWith(
      'SELECT * FROM public.hxos_read_authenticated_fake_financial_progress_v13($1,$2)',
      ['d'.repeat(64), { commandId: id(1) }]
    );
  });
  it('returns the same absence shape for an unknown or unauthorized command', async () => {
    expect(await fixture({ ...receipt(), progress: null }).read()).toBeNull();
  });
  it.each(['REQUESTED', 'PUBLISHED', 'PROCESSING', 'RECOVERY_REQUIRED'])(
    'accepts the unfinished %s fact without claiming a financial event',
    async (progressState) => {
      expect(
        await fixture({ ...receipt(), progress: { ...progress(), progressState } }).read()
      ).toMatchObject({ progressState, financialEvent: null });
    }
  );
  it.each(['SUCCEEDED', 'DECLINED', 'FAILED'])(
    'materialization retains terminal financial status %s',
    async (status) => {
      const financialEvent = { id: id(7), eventKind: 'PAYMENT_METHOD_PREPARED', status };
      const result = await fixture({
        ...receipt(),
        progress: { ...progress(), progressState: 'MATERIALIZED', financialEvent },
      }).read();
      expect(result?.financialEvent).toEqual(financialEvent);
      expect(Object.isFrozen(result?.financialEvent)).toBe(true);
    }
  );
  it.each([
    { actor_user_id: id(99) },
    { actor_request_sha256: 'e'.repeat(64) },
    { reader_release_sha256: 'sha256:' + 'f'.repeat(64) },
    { target_authority_id: 'malformed' },
    { actor_assertion_id: null },
    { privateProviderReference: 'private' },
    { progress: { ...progress(), commandId: id(99) } },
    { progress: { ...progress(), externalReference: 'private' } },
    { progress: { ...progress(), progressState: 'SUCCESS' } },
    { progress: { ...progress(), observedAt: '2026-09-04T00:00:00.000Z' } },
    { progress: { ...progress(), progressState: 'MATERIALIZED' } },
    {
      progress: {
        ...progress(),
        financialEvent: { id: id(7), eventKind: 'PAYMENT_METHOD_PREPARED', status: 'SUCCEEDED' },
      },
    },
    {
      progress: {
        ...progress(),
        progressState: 'MATERIALIZED',
        financialEvent: { id: id(7), eventKind: 'CAPTURED', status: 'SUCCEEDED' },
      },
    },
    {
      progress: {
        ...progress(),
        progressState: 'MATERIALIZED',
        financialEvent: { id: id(7), eventKind: 'PAYMENT_METHOD_PREPARED', status: 'PENDING' },
      },
    },
  ])('refuses malformed, private or mismatched persisted evidence %#', async (changed) => {
    await expect(fixture({ ...receipt(), ...changed }).read()).rejects.toThrow(
      'RECEIPT_BINDING_MISMATCH'
    );
  });
  it.each([
    { command_kind: 'PREPARE_FAKE_FINANCIAL_COMMAND' },
    { actor_assertion_token: '0'.repeat(64) },
    { canonical_request_sha256: '0'.repeat(64) },
    { assertion_expires_at: '2000-01-01T00:00:00.000Z' },
  ])('rejects unusable assertions before database access %#', async (change) => {
    const f = fixture();
    f.issue.mockResolvedValue({ ...assertion(), ...change });
    await expect(f.read()).rejects.toThrow('ASSERTION_INVALID');
    expect(f.transaction).not.toHaveBeenCalled();
  });
  it.each([
    { rows: [], rowCount: 0 },
    { rows: [receipt(), receipt()], rowCount: 2 },
    { rows: [receipt()], rowCount: 0 },
  ])('refuses incomplete receipts %#', async (response) => {
    const f = fixture();
    f.query.mockResolvedValue(response);
    await expect(f.read()).rejects.toThrow('RECEIPT_INVALID');
  });
  it('withholds the snapshot until assertion consumption commits', async () => {
    const f = fixture();
    let commit!: () => void;
    const barrier = new Promise<void>((resolve) => {
      commit = resolve;
    });
    f.transaction.mockImplementation(async (callback) => {
      const value = await callback(f.query as QueryFn);
      await barrier;
      return value;
    });
    let returned = false;
    const result = f.read().then((value) => {
      returned = true;
      return value;
    });
    await vi.waitFor(() => expect(f.query).toHaveBeenCalledTimes(1));
    expect(returned).toBe(false);
    commit();
    expect(await result).toEqual(progress());
  });
  it('sanitizes uncertain commit without replaying a one-use assertion or returning progress', async () => {
    const f = fixture();
    f.transaction.mockImplementation(async (callback) => {
      await callback(f.query as QueryFn);
      throw new Error('COMMIT_ACK_LOST private-provider-reference');
    });
    await expect(f.read()).rejects.toThrow(/^UNIVERSAL_FINANCE_PROGRESS_UNAVAILABLE$/u);
    expect(f.transaction).toHaveBeenCalledTimes(1);
    expect(f.issue).toHaveBeenCalledTimes(1);
  });
});
