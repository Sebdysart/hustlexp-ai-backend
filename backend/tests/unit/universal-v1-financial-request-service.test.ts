import { describe, expect, it, vi } from 'vitest';
import { UniversalV1FinancialRequestService } from '../../src/services/payment/UniversalV1FinancialRequestService.js';
import { InMemoryUniversalV1PreparedFinancialCommandAuthority } from '../../src/services/payment/PreparedFinancialCommandAuthority.js';
import { InMemoryFinancialProviderCommandJournal } from '../../src/services/payment/FinancialProviderCommandJournal.js';
import type { UniversalV1ActorAttestationHandle } from '../../src/auth/universal-v1-actor-attestation-contracts.js';
const id = (n: number) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const command = () => ({
  providerKind: 'FAKE' as const,
  operationKind: 'PREPARE_PAYMENT_METHOD' as const,
  operationId: id(1),
  idempotencyKey: 'request:prepared:0001',
  providerExpectedVersion: 0,
  lifecycleExpectedVersion: 0,
  taskDraftId: id(2),
  recordedBy: id(3),
  customerId: id(3),
  occurredAt: '2026-09-05T00:00:00.000Z',
});
const release = {
  manifestDigest: 'sha256:' + 'b'.repeat(64),
  releaseId: 'synthetic.request.test',
  revision: 'd'.repeat(40),
  environment: 'local' as const,
  authenticationStatus: 'VERIFIED' as const,
};
const attestation: UniversalV1ActorAttestationHandle = { issue: vi.fn() };
function fixture() {
  const preparation = new InMemoryUniversalV1PreparedFinancialCommandAuthority();
  const journal = new InMemoryFinancialProviderCommandJournal();
  const prepare = vi.fn(preparation.prepare.bind(preparation));
  const recordRequested = vi.fn(journal.recordRequested.bind(journal));
  const authorize = vi.fn(() => ({ ...release }));
  return {
    prepare,
    recordRequested,
    authorize,
    service: new UniversalV1FinancialRequestService({ prepare }, { recordRequested }, authorize),
  };
}
describe('authenticated financial request submission', () => {
  it('requires attestation and stable release authority for progress without preparing or requesting', async () => {
    const f = fixture(),
      read = vi.fn().mockResolvedValue(null);
    const service = new UniversalV1FinancialRequestService(
      { prepare: f.prepare },
      { recordRequested: f.recordRequested },
      f.authorize,
      { read }
    );
    await expect(service.readProgress(id(1), id(3), undefined)).rejects.toThrow(
      'ACTOR_ATTESTATION_REQUIRED'
    );
    expect(read).not.toHaveBeenCalled();
    expect(await service.readProgress(id(1), id(3), attestation)).toBeNull();
    expect(read).toHaveBeenCalledExactlyOnceWith(id(1), id(3), attestation, release);
    f.authorize
      .mockReturnValueOnce(release)
      .mockReturnValue({ ...release, revision: 'e'.repeat(40) });
    await expect(service.readProgress(id(1), id(3), attestation)).rejects.toThrow(
      'RELEASE_AUTHORITY_CHANGED'
    );
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.recordRequested).not.toHaveBeenCalled();
  });
  it('returns only committed request identity and replays without provider or queue access', async () => {
    const f = fixture(),
      input = command();
    const first = await f.service.requestFinancialEvent(input, attestation);
    const second = await f.service.requestFinancialEvent(input, attestation);
    expect(second).toEqual({ ...first, idempotencyReplayed: true });
    expect(first).toEqual({
      commandId: id(1),
      preparedCommandId: expect.any(String),
      operationId: id(1),
      requestState: 'REQUESTED',
      requestedAt: expect.any(String),
      idempotencyReplayed: false,
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(f.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ providerRequestSha256: expect.stringMatching(/^[a-f0-9]{64}$/u) }),
      attestation
    );
    expect(f.recordRequested).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { actorId: id(3), actorKind: 'PARTICIPANT' },
        release,
        exactRequest: {
          operationId: id(1),
          idempotencyKey: input.idempotencyKey,
          expectedVersion: 0,
          customerId: id(3),
        },
      })
    );
  });
  it('accepts uppercase operation UUIDs and exactly replays their committed request', async () => {
    const f = fixture();
    const input = { ...command(), operationId: 'ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF' };
    const first = await f.service.requestFinancialEvent(input, attestation);
    expect(first.operationId).toBe(input.operationId.toLowerCase());
    expect(await f.service.requestFinancialEvent(input, attestation)).toEqual({
      ...first,
      idempotencyReplayed: true,
    });
    expect(f.recordRequested.mock.calls[0][0].exactRequest).toMatchObject({
      operationId: input.operationId,
    });
  });
  it('requires a request-scoped attestation before any persistence', async () => {
    const f = fixture();
    await expect(f.service.requestFinancialEvent(command(), undefined)).rejects.toThrow(
      'ACTOR_ATTESTATION_REQUIRED'
    );
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.recordRequested).not.toHaveBeenCalled();
  });
  it('does not request after uncertain preparation commit', async () => {
    const f = fixture();
    f.prepare.mockRejectedValueOnce(new Error('PREPARE_COMMIT_ACK_LOST'));
    await expect(f.service.requestFinancialEvent(command(), attestation)).rejects.toThrow(
      'PREPARE_COMMIT_ACK_LOST'
    );
    expect(f.recordRequested).not.toHaveBeenCalled();
  });
  it('does not return success or retry after uncertain REQUESTED commit', async () => {
    const f = fixture();
    f.recordRequested.mockRejectedValueOnce(new Error('REQUEST_COMMIT_ACK_LOST'));
    await expect(f.service.requestFinancialEvent(command(), attestation)).rejects.toThrow(
      'REQUEST_COMMIT_ACK_LOST'
    );
    expect(f.recordRequested).toHaveBeenCalledTimes(1);
  });
  it('refuses release changes between preparation and REQUESTED', async () => {
    const f = fixture();
    f.authorize
      .mockReturnValueOnce(release)
      .mockReturnValue({ ...release, revision: 'e'.repeat(40) });
    await expect(f.service.requestFinancialEvent(command(), attestation)).rejects.toThrow(
      'RELEASE_AUTHORITY_CHANGED'
    );
    expect(f.recordRequested).not.toHaveBeenCalled();
  });
  it('refuses release changes after REQUESTED commit without retrying', async () => {
    const f = fixture();
    f.authorize
      .mockReturnValueOnce(release)
      .mockReturnValueOnce(release)
      .mockReturnValue({ ...release, revision: 'e'.repeat(40) });
    await expect(f.service.requestFinancialEvent(command(), attestation)).rejects.toThrow(
      'RELEASE_AUTHORITY_CHANGED'
    );
    expect(f.recordRequested).toHaveBeenCalledTimes(1);
  });
  it('snapshots the full provider request before awaiting preparation', async () => {
    const f = fixture(),
      input = command(),
      real = f.prepare.getMockImplementation()!;
    f.prepare.mockImplementationOnce(async (value) => {
      input.customerId = 'mutated-reference';
      input.operationId = id(99);
      return real(value);
    });
    const result = await f.service.requestFinancialEvent(input, attestation);
    expect(result.operationId).toBe(id(1));
    expect(f.recordRequested.mock.calls[0][0].exactRequest).toMatchObject({
      operationId: id(1),
      customerId: id(3),
    });
  });
  it.each([
    'commandId',
    'requestSha256',
    'commandIdentitySha256',
    'operationId',
    'preparedFinancialCommandId',
    'recordedAt',
  ] as const)('refuses malformed or mismatched %s receipts', async (field) => {
    const f = fixture(),
      real = f.recordRequested.getMockImplementation()!;
    f.recordRequested.mockImplementationOnce(async (input) => ({
      ...(await real(input)),
      [field]: field !== 'commandId' && field.endsWith('Id') ? id(999) : 'malformed',
    }));
    await expect(f.service.requestFinancialEvent(command(), attestation)).rejects.toThrow(
      /RECEIPT_/u
    );
  });
  it('refuses approved-provider input before preparation', async () => {
    const f = fixture();
    await expect(
      f.service.requestFinancialEvent(
        { ...command(), providerKind: 'APPROVED_PROVIDER' },
        attestation
      )
    ).rejects.toThrow();
    expect(f.prepare).not.toHaveBeenCalled();
  });
});
