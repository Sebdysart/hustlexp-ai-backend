import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueryFn } from '../../src/database-contracts.js';

const state = vi.hoisted(() => ({
  read: {} as Record<string, unknown>,
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
          rows: [sql.includes('execute_admitted') ? state.event : state.read] as T[],
        };
      };
      const result = await callback(query);
      if (state.failCommit === number) throw Error('COMMIT_UNCONFIRMED');
      state.order.push(`commit:${number}`);
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
import {
  executeAdmittedFakeFinancialCommand,
  issueAdmittedFakeFinancialExecutionCapability,
} from '../../src/jobs/fake-financial-admitted-execution.js';

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
});
const issue = () =>
  issueAdmittedFakeFinancialExecutionCapability(
    state.read.job_validation_id as string,
    state.read.worker_instance_id as string
  );
describe('single admitted fake-financial execution capability', () => {
  it('binds normal authority and enrolled worker configuration, commits issuance, and validates the stored result before returning', async () => {
    const capability = await issue();
    expect(Object.isFrozen(capability)).toBe(true);
    expect(state.order).toEqual(['begin:1', 'commit:1']);
    const result = await executeAdmittedFakeFinancialCommand(capability);
    expect(state.order).toEqual(['begin:1', 'commit:1', 'begin:2', 'commit:2']);
    expect(state.authorize).toHaveBeenCalledWith({ component: 'worker' });
    expect(state.configure).toHaveBeenCalledWith('worker');
    expect(state.query.mock.calls[1]).toEqual([
      'SELECT * FROM public.hxos_execute_admitted_fake_financial_request_v13($1,$2)',
      [state.read.job_validation_id, state.read.worker_instance_id],
    ]);
    expect(result.providerResult).toMatchObject({
      operationId: state.read.operation_id,
      state: 'SUCCEEDED',
      version: 1,
    });
    expect(result.event.identitySha256).toBe(state.event.identity_sha256);
    for (const value of [result, result.event, result.event.metadata, result.providerResult])
      expect(Object.isFrozen(value)).toBe(true);
  });
  it('refuses forged, copied and consumed capabilities before execution', async () => {
    const capability = await issue();
    await expect(executeAdmittedFakeFinancialCommand({ ...capability })).rejects.toThrow(
      'OPAQUE_CAPABILITY_REQUIRED'
    );
    await executeAdmittedFakeFinancialCommand(capability);
    await expect(executeAdmittedFakeFinancialCommand(capability)).rejects.toThrow(
      'OPAQUE_CAPABILITY_REQUIRED'
    );
    expect(state.query).toHaveBeenCalledTimes(2);
  });
  it('permits only one of two concurrent consumers', async () => {
    const capability = await issue();
    const results = await Promise.allSettled([
      executeAdmittedFakeFinancialCommand(capability),
      executeAdmittedFakeFinancialCommand(capability),
    ]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(state.query).toHaveBeenCalledTimes(2);
  });
  it.each([1, 2])(
    'does not return evidence when transaction %i loses COMMIT acknowledgement',
    async (number) => {
      state.failCommit = number;
      if (number === 1) {
        await expect(issue()).rejects.toThrow('COMMIT_UNCONFIRMED');
        expect(state.query).toHaveBeenCalledTimes(1);
      } else {
        const capability = await issue();
        await expect(executeAdmittedFakeFinancialCommand(capability)).rejects.toThrow(
          'COMMIT_UNCONFIRMED'
        );
        await expect(executeAdmittedFakeFinancialCommand(capability)).rejects.toThrow(
          'OPAQUE_CAPABILITY_REQUIRED'
        );
        expect(state.query).toHaveBeenCalledTimes(2);
      }
    }
  );
  it('consumes the capability on database hold/refusal without retrying the provider', async () => {
    const capability = await issue();
    state.failQuery = 2;
    await expect(executeAdmittedFakeFinancialCommand(capability)).rejects.toThrow(
      'LIVE_AUTHORITY_REFUSED'
    );
    await expect(executeAdmittedFakeFinancialCommand(capability)).rejects.toThrow(
      'OPAQUE_CAPABILITY_REQUIRED'
    );
    expect(state.query).toHaveBeenCalledTimes(2);
  });
  it('rejects revoked application authority before any database execution', async () => {
    const capability = await issue();
    state.authorize.mockImplementation(() => {
      throw Error('RELEASE_REVOKED');
    });
    await expect(executeAdmittedFakeFinancialCommand(capability)).rejects.toThrow(
      'RELEASE_REVOKED'
    );
    expect(state.query).toHaveBeenCalledTimes(1);
    await expect(executeAdmittedFakeFinancialCommand(capability)).rejects.toThrow(
      'OPAQUE_CAPABILITY_REQUIRED'
    );
  });
  it('rejects changed enrolled target after issuance', async () => {
    const capability = await issue();
    state.targetDigest = 'target-two';
    await expect(executeAdmittedFakeFinancialCommand(capability)).rejects.toThrow(
      'AUTHORITY_CHANGED'
    );
    expect(state.query).toHaveBeenCalledTimes(1);
  });
  it.each(['release_manifest_digest', 'release_id', 'release_revision', 'target_database_name'])(
    'rejects mismatched %s at issuance',
    async (field) => {
      state.read[field] =
        field === 'release_manifest_digest'
          ? `sha256:${'9'.repeat(64)}`
          : field === 'release_revision'
            ? '9'.repeat(40)
            : 'different-valid-value';
      await expect(issue()).rejects.toThrow('RELEASE_TARGET_MISMATCH');
      expect(state.query).toHaveBeenCalledTimes(1);
    }
  );
  it.each(['identity_sha256', 'request_sha256', 'provider_request_sha256', 'response_sha256'])(
    'rejects altered result %s before commit',
    async (field) => {
      const capability = await issue();
      state.event[field] = '9'.repeat(64);
      await expect(executeAdmittedFakeFinancialCommand(capability)).rejects.toThrow(
        'EXACT_EVENT_IDENTITY_MISMATCH'
      );
      expect(state.order).toEqual(['begin:1', 'commit:1', 'begin:2']);
    }
  );
  it('rejects an event with another admission', async () => {
    const capability = await issue();
    state.event.admitted_job_validation_id = randomUUID();
    await expect(executeAdmittedFakeFinancialCommand(capability)).rejects.toThrow(
      'EVENT_ADMISSION_MISMATCH'
    );
  });
  it('rejects unknown event fields before commit', async () => {
    const capability = await issue();
    state.event.unexpected = true;
    await expect(executeAdmittedFakeFinancialCommand(capability)).rejects.toThrow('EVENT_INVALID');
  });
});
