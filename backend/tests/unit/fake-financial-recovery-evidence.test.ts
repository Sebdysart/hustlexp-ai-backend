import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueryFn } from '../../src/database-contracts.js';

const state = vi.hoisted(() => ({
  read: {} as Record<string, unknown>,
  response: {} as Record<string, unknown>,
  changeAtCommit: false,
  event: {} as Record<string, unknown>,
  manifest: {
    environment: 'local',
    releaseId: 'admitted.execution.test',
    components: { backend: { revision: '1'.repeat(40) }, worker: { revision: '2'.repeat(40) } },
  },
  manifestDigest: `sha256:${'a'.repeat(64)}`,
  targetDigest: 'target-one',
  failCommit: 0,
  failQuery: 0,
  count: 0,
  order: [] as string[],
  authorize: vi.fn(),
  configure: vi.fn(),
  query: vi.fn(),
}));
vi.mock('../../src/db.js', () => ({
  db: {
    transaction: async (callback: (query: QueryFn) => Promise<unknown>) => {
      const number = ++state.count;
      state.order.push(`begin:${number}`);
      const query: QueryFn = async <T>(sql: string, params?: unknown[]) => {
        state.query(sql, params);
        if (state.failQuery === number) throw Error('LIVE_AUTHORITY_REFUSED');
        return {
          rowCount: 1,
          rows: [state.response] as T[],
        };
      };
      const result = await callback(query);
      if (state.failCommit === number) throw Error('COMMIT_UNCONFIRMED');
      state.order.push(`commit:${number}`);
      if (state.changeAtCommit) state.targetDigest = 'changed-at-commit';
      return result;
    },
  },
}));
vi.mock('../../src/services/payment/NonproductionFinancialAuthorization.js', () => ({
  assertNonproductionFakeFinanceAuthorized: state.authorize,
  nonproductionFakeFinanceEnabled: () => true,
}));
vi.mock('../../src/jobs/runtime-database-startup-config.js', () => ({
  configuredRuntimeDatabaseStartup: state.configure,
}));
vi.mock('../../src/releaseManifest.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/releaseManifest.js')>()),
  releaseManifestDigest: () => state.manifestDigest,
}));
import {
  FakeFinancialProvider,
  InMemoryFakeFinancialOperationRepository,
} from '../../src/services/payment/FakeFinancialProvider.js';
import { encodeFakeFinancialDurableRequest } from '../../src/services/payment/FakeFinancialDurableRequest.js';
import { readFakeFinancialRecoveryEvidence } from '../../src/jobs/fake-financial-recovery-evidence.js';

beforeEach(async () => {
  vi.clearAllMocks();
  state.failCommit = 0;
  state.failQuery = 0;
  state.count = 0;
  state.order = [];
  state.manifestDigest = `sha256:${'a'.repeat(64)}`;
  state.targetDigest = 'target-one';
  state.authorize.mockImplementation(() => state.manifest);
  state.configure.mockImplementation(() => ({
    targetDigest: state.targetDigest,
    expectedTarget: { databaseName: 'hx_ci_system_test', environment: 'local' },
  }));
  const request = {
    operationId: randomUUID().toUpperCase(),
    idempotencyKey: `execution:${randomUUID()}`,
    expectedVersion: 0,
    customerId: 'fake-😀-é',
  };
  const durable = encodeFakeFinancialDurableRequest('PREPARE_PAYMENT_METHOD', request);
  const memory = new InMemoryFakeFinancialOperationRepository();
  await new FakeFinancialProvider(memory, 2).preparePaymentMethod(request);
  const stored = (await memory.findByIdempotencyKey(request.idempotencyKey))!;
  const commandId = randomUUID();
  const validationId = randomUUID();
  state.read = {
    job_validation_id: validationId,
    command_id: commandId,
    worker_instance_id: randomUUID(),
    recovery_lease_id: randomUUID(),
    dispatch_attempt_id: randomUUID(),
    dispatch_admission_id: randomUUID(),
    outbox_request_id: randomUUID(),
    provider_request_sha256: durable.providerRequestSha256,
    command_identity_sha256: 'b'.repeat(64),
    prepared_command_id: randomUUID(),
    prepared_authority_sha256: 'c'.repeat(64),
    validation_identity_sha256: 'd'.repeat(64),
    admission_identity_sha256: 'e'.repeat(64),
    job_authority_sha256: 'f'.repeat(64),
    bullmq_job_id: `hx-fake-fin-${commandId.replaceAll('-', '')}-${'f'.repeat(64)}`,
    payload_contract_version: 1,
    canonical_provider_request: durable.canonicalRequestJson,
    operation_kind: durable.operationKind,
    operation_id: request.operationId.toLowerCase(),
    idempotency_key: request.idempotencyKey,
    provider_expected_version: '0',
    lease_expires_at: new Date(Date.now() + 30_000),
    outcome_deadline_at: new Date(Date.now() + 10_000),
    target_authority_id: randomUUID(),
    target_authority_version: 1,
    target_database_name: 'hx_ci_system_test',
    release_environment: 'local',
    release_manifest_digest: state.manifestDigest,
    release_id: state.manifest.releaseId,
    release_revision: state.manifest.components.backend.revision,
    provider_execution_capability: false,
    positive_money_capability: false,
    production_capability: false,
  };
  state.event = {
    projection_contract_version: stored.projectionContractVersion,
    event_id: stored.eventId,
    operation_id: stored.operationId.toLowerCase(),
    operation_kind: stored.operationKind,
    event_version: stored.version,
    state: stored.state,
    scenario: stored.scenario,
    amount_cents: stored.amountCents,
    currency: stored.currency,
    related_operation_id: stored.relatedOperationId,
    external_reference: stored.externalReference,
    idempotency_key: stored.idempotencyKey,
    identity_sha256: stored.identitySha256,
    request_sha256: stored.requestSha256,
    provider_request_sha256: stored.providerRequestSha256,
    response_sha256: stored.responseSha256,
    retryable: stored.retryable,
    metadata: stored.metadata,
    recorded_at: stored.recordedAt,
    expires_at: stored.expiresAt,
    admitted_job_validation_id: validationId,
    idempotency_replayed: false,
  };
  state.changeAtCommit = false;
  state.event.idempotency_replayed = true;
  const requestEvidence = { ...state.read };
  for (const key of [
    'job_validation_id',
    'worker_instance_id',
    'dispatch_admission_id',
    'recovery_lease_id',
    'dispatch_attempt_id',
    'validation_identity_sha256',
    'admission_identity_sha256',
    'lease_expires_at',
    'outcome_deadline_at',
    'provider_execution_capability',
    'positive_money_capability',
    'production_capability',
  ])
    delete requestEvidence[key];
  state.response = {
    request_evidence: requestEvidence,
    admission_evidence: state.read,
    provider_event: state.event,
  };
});
const input = () => ({
  jobId: state.read.bullmq_job_id as string,
  payload: {
    version: 1 as const,
    kind: 'UNIVERSAL_V1_FAKE_FINANCIAL_COMMAND' as const,
    commandId: state.read.command_id as string,
    outboxRequestId: state.read.outbox_request_id as string,
    jobAuthoritySha256: state.read.job_authority_sha256 as string,
  },
});
describe('durable fake-financial recovery evidence', () => {
  it('reads a committed exact observation with normal enrolled worker authority and returns only frozen evidence after commit', async () => {
    const result = await readFakeFinancialRecoveryEvidence(input());
    expect(state.authorize).toHaveBeenCalledWith({ component: 'worker' });
    expect(state.configure).toHaveBeenCalledWith('worker');
    expect(state.order).toEqual(['begin:1', 'commit:1']);
    expect(state.query).toHaveBeenCalledExactlyOnceWith(
      'SELECT * FROM public.hxos_read_fake_financial_recovery_evidence_v13($1,$2,$3)',
      [state.read.outbox_request_id, state.read.bullmq_job_id, state.read.job_authority_sha256]
    );
    expect(result).toMatchObject({
      kind: 'COMMITTED_EVENT',
      providerExecutionCapability: false,
      positiveMoneyCapability: false,
      productionCapability: false,
      observation: { providerResult: { state: 'SUCCEEDED' } },
    });
    for (const object of [
      result,
      result.request,
      result.request.evidence,
      result.request.durableRequest,
      result.admission,
      result.observation,
      result.observation!.event,
      result.observation!.event.metadata,
    ])
      expect(Object.isFrozen(object)).toBe(true);
  });
  it('retains original admission identity across expired leases and a historical release/target', async () => {
    for (const row of [state.read, state.response.request_evidence as Record<string, unknown>]) {
      row.release_manifest_digest = `sha256:${'9'.repeat(64)}`;
      row.release_id = 'historical.release';
      row.release_revision = '8'.repeat(40);
      row.target_authority_id = '11111111-1111-4111-8111-111111111111';
      row.target_authority_version = 1;
    }
    state.read.lease_expires_at = '2020-01-01T00:00:02.000Z';
    state.read.outcome_deadline_at = '2020-01-01T00:00:01.000Z';
    expect(
      (await readFakeFinancialRecoveryEvidence(input())).admission!.evidence.worker_instance_id
    ).toBe(state.read.worker_instance_id);
  });
  it.each([false, true])(
    'reports snapshot absence without granting redispatch when admitted=%s',
    async (admitted) => {
      state.response.provider_event = null;
      if (!admitted) state.response.admission_evidence = null;
      const result = await readFakeFinancialRecoveryEvidence(input());
      expect(result.kind).toBe(admitted ? 'NO_COMMITTED_EVENT' : 'NO_COMMITTED_ADMISSION');
      expect(result.providerExecutionCapability).toBe(false);
      expect(result.observation).toBeNull();
      expect(result).not.toHaveProperty('effectCertainty');
    }
  );
  it('does not return evidence or automatically retry after lost read COMMIT acknowledgement', async () => {
    state.failCommit = 1;
    await expect(readFakeFinancialRecoveryEvidence(input())).rejects.toThrow('COMMIT_UNCONFIRMED');
    expect(state.query).toHaveBeenCalledTimes(1);
  });
  it('refuses revoked normal worker authority before querying', async () => {
    state.authorize.mockImplementation(() => {
      throw Error('RELEASE_AUTHORITY_REVOKED');
    });
    await expect(readFakeFinancialRecoveryEvidence(input())).rejects.toThrow(
      'RELEASE_AUTHORITY_REVOKED'
    );
    expect(state.query).not.toHaveBeenCalled();
  });
  it('refuses reader target changes after read commit', async () => {
    state.changeAtCommit = true;
    await expect(readFakeFinancialRecoveryEvidence(input())).rejects.toThrow(
      'READER_AUTHORITY_CHANGED'
    );
  });
  it('propagates installed data-plane refusal without a fallback or extra query', async () => {
    state.failQuery = 1;
    await expect(readFakeFinancialRecoveryEvidence(input())).rejects.toThrow(
      'LIVE_AUTHORITY_REFUSED'
    );
    expect(state.query).toHaveBeenCalledTimes(1);
  });
  it('rejects a malformed retained job before querying', async () => {
    await expect(
      readFakeFinancialRecoveryEvidence({ ...input(), jobId: 'forged' })
    ).rejects.toThrow('JOB_IDENTITY_MISMATCH');
    expect(state.query).not.toHaveBeenCalled();
  });
  it.each(['command_id', 'outbox_request_id', 'job_authority_sha256', 'bullmq_job_id'])(
    'rejects altered request binding %s',
    async (key) => {
      const row = state.response.request_evidence as Record<string, unknown>;
      row[key] =
        key.endsWith('_id') && key !== 'bullmq_job_id'
          ? randomUUID()
          : key.endsWith('sha256')
            ? '0'.repeat(64)
            : 'other-job';
      await expect(readFakeFinancialRecoveryEvidence(input())).rejects.toThrow(
        'JOB_BINDING_MISMATCH'
      );
    }
  );
  it.each(['target_database_name', 'release_environment'])(
    'rejects historical evidence from another %s',
    async (key) => {
      (state.response.request_evidence as Record<string, unknown>)[key] =
        key === 'release_environment' ? 'staging' : 'another_database';
      await expect(readFakeFinancialRecoveryEvidence(input())).rejects.toThrow(
        'ENVIRONMENT_TARGET_MISMATCH'
      );
    }
  );
  it('rejects mismatched request/admission provenance', async () => {
    state.read.prepared_authority_sha256 = '1'.repeat(64);
    await expect(readFakeFinancialRecoveryEvidence(input())).rejects.toThrow(
      'ADMISSION_BINDING_MISMATCH'
    );
  });
  it('rejects an event without admission evidence', async () => {
    state.response.admission_evidence = null;
    await expect(readFakeFinancialRecoveryEvidence(input())).rejects.toThrow(
      'EVENT_WITHOUT_ADMISSION'
    );
  });
  it.each(['identity_sha256', 'request_sha256', 'provider_request_sha256', 'response_sha256'])(
    'rejects corrupted event %s',
    async (key) => {
      state.event[key] = '0'.repeat(64);
      await expect(readFakeFinancialRecoveryEvidence(input())).rejects.toThrow();
    }
  );
  it('refuses a receipt that claims fresh provider execution', async () => {
    state.event.idempotency_replayed = false;
    await expect(readFakeFinancialRecoveryEvidence(input())).rejects.toThrow(
      'EVENT_REPLAY_REQUIRED'
    );
  });
  it('rejects unrecognized outer response fields', async () => {
    state.response.extra = true;
    await expect(readFakeFinancialRecoveryEvidence(input())).rejects.toThrow('RESPONSE_INVALID');
  });
});
