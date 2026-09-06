import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../../src/db.js';
import type { QueryFn } from '../../src/database-contracts.js';
import { PostgresUniversalV1FinancialPredecessorReader } from '../../src/services/payment/UniversalV1FinancialPredecessor.js';
import {
  buildUniversalV1CanonicalActorRequest,
  parseUniversalV1ActorCommandPayload,
} from '../../src/auth/universal-v1-actor-attestation-contracts.js';
import { PostgresUniversalV1CanonicalRequestAuthority } from '../../src/services/UniversalV1ActorAttesterClient.js';
import { UniversalV1FinancialRequestService } from '../../src/services/payment/UniversalV1FinancialRequestService.js';
import type { UniversalV1PreparedFinancialCommandAuthority } from '../../src/services/payment/PreparedFinancialCommandAuthority.js';
import type { FinancialProviderCommandJournal } from '../../src/services/payment/FinancialProviderCommandJournal.js';

const id = (n: number) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const release = {
  manifestDigest: 'sha256:' + 'a'.repeat(64),
  releaseId: 'synthetic.predecessor',
  revision: 'b'.repeat(40),
  environment: 'local' as const,
  authenticationStatus: 'VERIFIED' as const,
};
const payload = {
  operationKind: 'PREPARE_PAYMENT_METHOD' as const,
  operationId: id(2),
  taskDraftId: id(3),
  idempotencyKey: 'predecessor-fixture:prep',
};
const command = {
  commandKind: 'READ_FAKE_FINANCIAL_PREDECESSOR' as const,
  commandPayload: payload,
};
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
  operationKind: payload.operationKind,
  taskDraftId: id(3),
  taskId: null,
  requestedAt: '2026-09-05T00:00:00.000Z',
  observedAt: '2026-09-05T00:00:01.000Z',
  requestState: 'REQUESTED' as const,
  progressState: 'MATERIALIZED' as const,
  financialEvent: { id: id(7), eventKind: 'PAYMENT_METHOD_PREPARED', status: 'SUCCEEDED' as const },
});
const predecessor = () => ({
  commandId: id(1),
  idempotencyKey: payload.idempotencyKey,
  preparedCommandId: id(8),
  operationId: id(2),
  operationKind: payload.operationKind,
  financialEventId: id(7),
  eventKind: 'PAYMENT_METHOD_PREPARED',
  lifecycleExpectedVersion: 0,
  taskDraftId: id(3),
  taskId: null,
  scopeVersionId: null,
  eligibilityDecisionId: null,
  predecessorEventId: null,
  amountCents: null,
  currency: null,
  externalReference: 'fake:private-preparation-reference',
  occurredAt: '2026-09-05T00:00:00.000123Z',
  expiresAt: null,
  sourceTargetAuthorityId: id(9),
  sourceReleaseSha256: 'sha256:' + 'e'.repeat(64),
});
const facts = () => ({
  idempotencyKey: payload.idempotencyKey,
  progress: progress(),
  predecessor: predecessor(),
});
const receipt = () => ({
  financial_facts: facts(),
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
  const reader = new PostgresUniversalV1FinancialPredecessorReader({
    transaction,
  } as unknown as Database);
  return {
    query,
    transaction,
    issue,
    reader,
    read: () => reader.read(payload, id(4), { issue }, release),
  };
}

describe('authenticated historical financial predecessor', () => {
  it('binds the closed operation identity through the dedicated actor builder', async () => {
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
    const query = vi.fn().mockResolvedValue({
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
      'public.hxos_build_fake_financial_predecessor_actor_request_v13'
    );
    expect(query.mock.calls[0][1]).toEqual([command.commandKind, payload]);
  });
  it.each(['actorId', 'externalReference', 'status', 'commandId', 'releaseManifestSha256'])(
    'refuses caller-shaped %s before issuing an assertion',
    async (field) => {
      const f = fixture();
      expect(() =>
        parseUniversalV1ActorCommandPayload(command.commandKind, { ...payload, [field]: id(99) })
      ).toThrow();
      await expect(
        f.reader.read({ ...payload, [field]: id(99) }, id(4), { issue: f.issue }, release)
      ).rejects.toThrow('UNIVERSAL_FINANCE_PREDECESSOR_UNAVAILABLE');
      expect(f.issue).not.toHaveBeenCalled();
      expect(f.query).not.toHaveBeenCalled();
    }
  );
  it('returns immutable backend facts after one sealed read and preserves historical source identity', async () => {
    const f = fixture();
    const result = await f.read();
    expect(result).toEqual(facts());
    for (const part of [
      result,
      result?.predecessor,
      result?.progress,
      result?.progress.financialEvent,
    ])
      expect(Object.isFrozen(part)).toBe(true);
    expect(f.issue).toHaveBeenCalledExactlyOnceWith(command);
    expect(f.query).toHaveBeenCalledExactlyOnceWith(
      'SELECT * FROM public.hxos_read_authenticated_fake_financial_predecessor_v13($1,$2)',
      ['d'.repeat(64), payload]
    );
    expect(result?.predecessor?.sourceReleaseSha256).not.toBe(release.manifestDigest);
  });
  it('returns null for absent or unauthorized identities', async () => {
    expect(await fixture({ ...receipt(), financial_facts: null }).read()).toBeNull();
  });
  it.each(['REQUESTED', 'PUBLISHED', 'PROCESSING', 'RECOVERY_REQUIRED'])(
    'does not create a usable predecessor from %s',
    async (progressState) => {
      const value = {
        ...facts(),
        progress: { ...progress(), progressState, financialEvent: null },
        predecessor: null,
      };
      expect(await fixture({ ...receipt(), financial_facts: value }).read()).toEqual(value);
    }
  );
  it.each(['FAILED', 'DECLINED'])(
    'retains the %s status without a successor input',
    async (status) => {
      const value = {
        ...facts(),
        progress: { ...progress(), financialEvent: { ...progress().financialEvent, status } },
        predecessor: null,
      };
      expect(await fixture({ ...receipt(), financial_facts: value }).read()).toEqual(value);
    }
  );
  it.each([
    { actor_user_id: id(99) },
    { actor_request_sha256: 'f'.repeat(64) },
    { reader_release_sha256: 'sha256:' + 'f'.repeat(64) },
    { actor_assertion_id: null },
    { privateTransport: 'leaked' },
    { financial_facts: { ...facts(), idempotencyKey: 'wrong-predecessor-key' } },
    { financial_facts: { ...facts(), progress: { ...progress(), operationId: id(99) } } },
    {
      financial_facts: { ...facts(), predecessor: { ...predecessor(), financialEventId: id(99) } },
    },
    { financial_facts: { ...facts(), predecessor: null } },
    {
      financial_facts: {
        ...facts(),
        progress: { ...progress(), progressState: 'PROCESSING', financialEvent: null },
      },
    },
    { financial_facts: { ...facts(), predecessor: { ...predecessor(), providerRequest: {} } } },
    {
      financial_facts: {
        ...facts(),
        predecessor: { ...predecessor(), amountCents: 10, currency: 'USD' },
      },
    },
  ])('rejects changed or overbroad receipt %#', async (change) => {
    await expect(fixture({ ...receipt(), ...change }).read()).rejects.toThrow(
      'UNIVERSAL_FINANCE_PREDECESSOR_RECEIPT_BINDING_MISMATCH'
    );
  });
  it.each([
    { command_kind: 'READ_FAKE_FINANCIAL_REQUEST_PROGRESS' },
    { actor_assertion_token: '0'.repeat(64) },
    { canonical_request_sha256: '0'.repeat(64) },
    { assertion_expires_at: '2000-01-01T00:00:00.000Z' },
  ])('rejects wrong-kind, zero or expired assertions %#', async (change) => {
    const f = fixture();
    f.issue.mockResolvedValue({ ...assertion(), ...change });
    await expect(f.read()).rejects.toThrow('UNIVERSAL_FINANCE_PREDECESSOR_ASSERTION_INVALID');
    expect(f.query).not.toHaveBeenCalled();
  });
  it('does not return a receipt before COMMIT acknowledgement and redacts its loss', async () => {
    const f = fixture();
    let reached!: () => void, releaseCommit!: () => void;
    const entered = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const commit = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    f.transaction.mockImplementation(async (callback) => {
      await callback(f.query as QueryFn);
      reached();
      await commit;
      throw Error('SQL private-reference and assertion-token');
    });
    let returned = false;
    const result = f.read().then(
      (value) => {
        returned = true;
        return value;
      },
      (error) => error as Error
    );
    await entered;
    expect(returned).toBe(false);
    releaseCommit();
    expect(await result).toEqual(new Error('UNIVERSAL_FINANCE_PREDECESSOR_UNAVAILABLE'));
  });
  it('rechecks release authority after the backend fact read', async () => {
    const authorize = vi
      .fn()
      .mockReturnValueOnce(release)
      .mockReturnValue({ ...release, manifestDigest: 'sha256:' + 'f'.repeat(64) });
    const read = vi.fn().mockResolvedValue(facts());
    const service = new UniversalV1FinancialRequestService(
      {} as UniversalV1PreparedFinancialCommandAuthority,
      {} as FinancialProviderCommandJournal,
      authorize,
      undefined,
      { read }
    );
    await expect(service.readPredecessor(payload, id(4), { issue: vi.fn() })).rejects.toThrow(
      'RELEASE_AUTHORITY_CHANGED'
    );
    expect(read).toHaveBeenCalledOnce();
  });
});
