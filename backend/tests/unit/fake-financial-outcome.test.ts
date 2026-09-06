import { createHash, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueryFn } from '../../src/database-contracts.js';

const state = vi.hoisted(() => ({
  read: {} as Record<string, unknown>,
  response: {} as Record<string, unknown>,
  recoveryResponse: {} as Record<string, any>,
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
  rowCount: 1,
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
          rowCount: state.rowCount,
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
import {
  acquireFakeFinancialReconcileLease,
  recordFakeFinancialOutcome,
} from '../../src/jobs/fake-financial-outcome.js';
import { materializeFakeFinancialEvent } from '../../src/jobs/fake-financial-materialization.js';
import { readFakeFinancialProgress } from '../../src/jobs/fake-financial-progress.js';
import { fakeFinancialWebhookSignedBytes } from '../../src/services/payment/FakeFinancialWebhookAuthentication.js';
import { financialProviderOutcomeProjectionSha256 } from '../../src/services/payment/FinancialProviderCommandRecovery.js';

beforeEach(async () => {
  vi.clearAllMocks();
  state.failCommit = 0;
  state.failQuery = 0;
  state.count = 0;
  state.rowCount = 1;
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
  const memory = new InMemoryFakeFinancialOperationRepository(
    () => new Date('2026-09-04T01:00:00.500Z')
  );
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
  state.recoveryResponse = state.response;
});
const jobInput = () => ({
  jobId: state.read.bullmq_job_id as string,
  payload: {
    version: 1 as const,
    kind: 'UNIVERSAL_V1_FAKE_FINANCIAL_COMMAND' as const,
    commandId: state.read.command_id as string,
    outboxRequestId: state.read.outbox_request_id as string,
    jobAuthoritySha256: state.read.job_authority_sha256 as string,
  },
});

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const lease = () => state.response.recovery_lease as Record<string, any>;
const outcome = () => state.response.outcome_fact as Record<string, any>;
const input = () => ({
  ...jobInput(),
  jobValidationId: state.read.job_validation_id as string,
  workerInstanceId: lease().lease_owner_id as string,
  recoveryLeaseId: lease().recovery_lease_id as string,
});
function leaseHash() {
  const row = lease();
  row.lease_identity_sha256 = hash(
    [
      row.command_id,
      row.recovery_lease_id,
      row.recovery_action,
      row.lease_owner_id,
      String(row.lease_duration_seconds),
    ].join(':')
  );
}
function outcomeHash() {
  const row = outcome();
  row.outcome_identity_sha256 = hash(
    [
      row.command_id,
      row.dispatch_attempt_id,
      row.recovery_lease_id,
      row.outcome_kind,
      row.observation_idempotency_key,
      row.provider_result_sha256 ?? '',
      row.provider_state ?? '',
      row.provider_result_version === null ? '' : String(row.provider_result_version),
      row.effect_certainty,
      String(row.retryable),
      row.failure_code ?? '',
      row.recovery_delay_seconds === null ? '' : String(row.recovery_delay_seconds),
    ].join(':')
  );
}
function unknown() {
  Object.assign(outcome(), {
    outcome_kind: 'OUTCOME_UNKNOWN',
    provider_result_sha256: null,
    provider_state: null,
    provider_result_version: null,
    amount_cents: null,
    currency: null,
    external_reference_sha256: null,
    effect_certainty: 'UNKNOWN',
    retryable: true,
    failure_code: 'FAKE_EVENT_NOT_OBSERVED',
    recovery_delay_seconds: 1,
    recovery_not_before: '2026-09-04T01:00:02.123456+00:00',
  });
  state.response.provider_event = null;
  outcomeHash();
}
function reconcile() {
  Object.assign(lease(), {
    recovery_action: 'RECONCILE',
    recovery_lease_id: randomUUID(),
    lease_owner_id: randomUUID(),
    admitted_job_validation_id: state.read.job_validation_id,
  });
  leaseHash();
  delete state.response.outcome_fact;
  delete state.response.provider_event;
}
function fenced() {
  unknown();
  const saved = { ...outcome() };
  reconcile();
  state.response.outcome_fact = saved;
  state.response.provider_event = null;
  state.read.lease_expires_at = '2026-09-04T01:00:01.123456+00:00';
  state.read.outcome_deadline_at = '2026-09-04T01:00:01.123456+00:00';
  Object.assign(outcome(), {
    outcome_kind: 'FAILED',
    effect_certainty: 'CONFIRMED_NO_EFFECT',
    failure_code: 'FAKE_ADMISSION_FENCED_NO_EFFECT',
    recovery_lease_id: lease().recovery_lease_id,
    observation_idempotency_key: 'finance-outcome-v13:' + lease().recovery_lease_id,
  });
  outcomeHash();
}
beforeEach(() => {
  const reference = hash(state.event.external_reference as string);
  state.response = {
    admission_evidence: state.read,
    provider_event: state.event,
    idempotency_replayed: false,
    recovery_lease: {
      recovery_lease_id: state.read.recovery_lease_id,
      command_id: state.read.command_id,
      recovery_action: 'DISPATCH',
      lease_owner_id: state.read.worker_instance_id,
      lease_duration_seconds: 30,
      admitted_job_validation_id: null,
      acquired_at: '2026-09-04T01:00:00.123456+00:00',
      expires_at: '2026-09-04T01:00:30.123456+00:00',
    },
    outcome_fact: {
      outcome_fact_id: randomUUID(),
      command_id: state.read.command_id,
      dispatch_attempt_id: state.read.dispatch_attempt_id,
      recovery_lease_id: state.read.recovery_lease_id,
      observation_idempotency_key: `finance-outcome-v13:${state.read.recovery_lease_id}`,
      outcome_kind: 'OUTCOME_OBSERVED',
      provider_state: 'SUCCEEDED',
      provider_result_version: 1,
      amount_cents: null,
      currency: null,
      external_reference_sha256: reference,
      provider_result_sha256: hash(
        [
          state.read.operation_id,
          'PREPARE_PAYMENT_METHOD',
          'FAKE',
          'SUCCEEDED',
          '1',
          '',
          '',
          reference,
          'false',
        ].join(':')
      ),
      effect_certainty: 'CONFIRMED_EFFECT',
      retryable: false,
      failure_code: null,
      recovery_delay_seconds: null,
      recovery_not_before: null,
      recorded_at: '2026-09-04T01:00:01.123456+00:00',
    },
  };
  leaseHash();
  outcomeHash();
});
async function terminalObservationFixture(
  operationKind: 'PREPARE_PAYMENT_METHOD' | 'AUTHORIZE' = 'PREPARE_PAYMENT_METHOD'
) {
  if (operationKind === 'AUTHORIZE') await authorizeFixture();
  const request = {
    ...JSON.parse(String(state.read.canonical_provider_request)),
    scenario: 'TIMEOUT' as const,
  };
  const durable = encodeFakeFinancialDurableRequest(operationKind, request);
  const memory = new InMemoryFakeFinancialOperationRepository(
    () => new Date('2026-09-04T01:00:00.500Z')
  );
  if (operationKind === 'AUTHORIZE') await new FakeFinancialProvider(memory, 2).authorize(request);
  else await new FakeFinancialProvider(memory, 2).preparePaymentMethod(request);
  const raw = (await memory.findByIdempotencyKey(request.idempotencyKey))!;
  Object.assign(state.read, {
    canonical_provider_request: durable.canonicalRequestJson,
    provider_request_sha256: durable.providerRequestSha256,
  });
  Object.assign(state.recoveryResponse.request_evidence, {
    canonical_provider_request: durable.canonicalRequestJson,
    provider_request_sha256: durable.providerRequestSha256,
  });
  Object.assign(state.event, {
    event_id: raw.eventId,
    state: raw.state,
    scenario: raw.scenario,
    identity_sha256: raw.identitySha256,
    request_sha256: raw.requestSha256,
    provider_request_sha256: raw.providerRequestSha256,
    response_sha256: raw.responseSha256,
    retryable: raw.retryable,
    metadata: raw.metadata,
    external_reference: raw.externalReference,
    expires_at: raw.expiresAt,
  });
  const savedOutcome = { ...outcome() };
  reconcile();
  state.response.outcome_fact = savedOutcome;
  const payload = {
    version: 'HX_SYNTHETIC_FINANCIAL_OBSERVATION_V1',
    kind: 'FINANCIAL_OPERATION_OBSERVED',
    providerKind: 'FAKE',
    providerEventReference: 'terminal-observation:' + randomUUID(),
    operationId: state.read.operation_id,
    operationKind,
    predecessorProviderVersion: 0,
    observedProviderVersion: 1,
    observedState: 'SUCCEEDED',
    externalReference: raw.externalReference,
    amountCents: raw.amountCents,
    currency: raw.currency?.toUpperCase() ?? null,
    providerOccurredAt: '2026-09-04T01:00:00.750Z',
  };
  const row = {
    contract_version: 1,
    observation_id: randomUUID(),
    receipt_id: randomUUID(),
    key_id: randomUUID(),
    target_authority_id: String(state.read.target_authority_id),
    raw_payload: JSON.stringify(payload),
    raw_payload_sha256: '',
    signed_payload_sha256: '',
    authentication_evidence_sha256: 'a'.repeat(64),
    authenticated_at: '2026-09-04T01:00:00.900Z',
    verified_at: '2026-09-04T01:00:00.950Z',
    provider_occurred_at: payload.providerOccurredAt,
    provider_expires_at: (operationKind === 'AUTHORIZE' ? '2026-09-04T01:15:00.750Z' : null) as
      | string
      | null,
    provider_result_sha256: financialProviderOutcomeProjectionSha256({
      operationId: String(state.read.operation_id),
      operationKind,
      providerKind: 'FAKE',
      state: 'SUCCEEDED',
      version: 1,
      amountCents: raw.amountCents,
      currency: raw.currency?.toUpperCase() ?? null,
      externalReference: raw.externalReference,
      retryable: false,
      idempotencyReplayed: true,
      recordedAt: payload.providerOccurredAt,
      expiresAt: operationKind === 'AUTHORIZE' ? '2026-09-04T01:15:00.750Z' : null,
    }),
    resolution_identity_sha256: '',
  };
  const refreshProof = () => {
    row.raw_payload_sha256 = hash(row.raw_payload);
    row.signed_payload_sha256 = createHash('sha256')
      .update(
        fakeFinancialWebhookSignedBytes(
          {
            keyId: row.key_id,
            targetAuthorityId: row.target_authority_id,
            targetAuthorityVersion: 1,
            targetDatabaseName: 'hx_ci_system_test',
            environment: 'local',
            releaseManifestSha256: state.manifestDigest,
          },
          Buffer.from(row.raw_payload)
        )
      )
      .digest('hex');
    const parts = [
      'HX_FAKE_TERMINAL_OBSERVATION_RESOLUTION_V13',
      '1',
      state.read.command_id,
      state.read.job_validation_id,
      state.read.dispatch_attempt_id,
      raw.eventId,
      raw.responseSha256,
      state.read.provider_request_sha256,
      row.observation_id,
      row.receipt_id,
      row.raw_payload_sha256,
      row.authentication_evidence_sha256,
      row.signed_payload_sha256,
      row.target_authority_id,
      row.provider_result_sha256,
      String(BigInt(new Date(row.provider_occurred_at).getTime()) * 1000n),
      row.provider_expires_at === null
        ? ''
        : String(BigInt(new Date(row.provider_expires_at).getTime()) * 1000n),
    ].map(String);
    row.resolution_identity_sha256 = hash(
      parts.map((value) => `${Buffer.byteLength(value, 'utf8')}:${value}`).join('|')
    );
  };
  refreshProof();
  Object.assign(outcome(), {
    recovery_lease_id: lease().recovery_lease_id,
    observation_idempotency_key: 'finance-outcome-v13:' + lease().recovery_lease_id,
    provider_result_sha256: row.provider_result_sha256,
    external_reference_sha256: hash(raw.externalReference),
  });
  outcomeHash();
  state.response.provider_event = {
    kind: 'HX_FAKE_TERMINAL_OBSERVATION_V13',
    original_event: state.event,
    resolution: row,
  };
  return { row, payload, refreshProof };
}

describe('versioned terminal observation outcome receipts', () => {
  it('derives successful authorization expiry from signed provider time while preserving the pending projection', async () => {
    const { row, refreshProof } = await terminalObservationFixture('AUTHORIZE');
    row.raw_payload = row.raw_payload.replace('"amountCents":12500', '"amountCents":12500.0');
    refreshProof();
    const result = await recordFakeFinancialOutcome(input());
    expect(result.observation?.providerResult).toMatchObject({
      state: 'PENDING',
      recordedAt: '2026-09-04T01:00:00.500Z',
      expiresAt: null,
    });
    expect(result.resolution?.providerResult).toMatchObject({
      state: 'SUCCEEDED',
      amountCents: 12500,
      recordedAt: '2026-09-04T01:00:00.750Z',
      expiresAt: '2026-09-04T01:15:00.750Z',
    });
  });
  it('preserves signed decimal integer spelling while using canonical numeric outcome hashes', async () => {
    const { row, refreshProof } = await terminalObservationFixture();
    row.raw_payload = row.raw_payload.replace(
      '"observedProviderVersion":1',
      '"observedProviderVersion":1.0'
    );
    refreshProof();
    expect((await recordFakeFinancialOutcome(input())).resolution?.providerResult.version).toBe(1);
  });
  it('refuses timestamp precision beyond the six-digit ingress contract', async () => {
    const { row, refreshProof } = await terminalObservationFixture();
    row.raw_payload = row.raw_payload.replace('.750Z', '.7500001Z');
    refreshProof();
    await expect(recordFakeFinancialOutcome(input())).rejects.toThrow('PROVIDER_TIME_MISMATCH');
  });
  it('commits a terminal result while preserving the original pending event and exact provenance', async () => {
    const { row } = await terminalObservationFixture();
    const result = await recordFakeFinancialOutcome(input());
    expect(result.outcome).toMatchObject({
      provider_state: 'SUCCEEDED',
      retryable: false,
      effect_certainty: 'CONFIRMED_EFFECT',
    });
    expect(result.observation?.event).toMatchObject({
      state: 'PENDING',
      retryable: true,
      projectionContractVersion: 2,
    });
    expect(result.resolution?.evidence).toEqual(row);
    expect(result.resolution?.providerResult).toMatchObject({
      state: 'SUCCEEDED',
      version: 1,
      retryable: false,
    });
    expect(Object.isFrozen(result.resolution?.evidence)).toBe(true);
    expect(state.order).toEqual(['begin:1', 'commit:1']);
    expect(state.query).toHaveBeenCalledTimes(1);
  });
  it('allows durable progress to compare the unchanged original raw event', async () => {
    await terminalObservationFixture();
    const receipt = { ...state.response, idempotency_replayed: true };
    state.recoveryResponse.provider_event = state.event;
    state.response = { recovery_evidence: state.recoveryResponse, recorded_outcome: receipt };
    const result = await readFakeFinancialProgress(jobInput());
    expect(result.observation?.event.state).toBe('PENDING');
    expect(result.recordedOutcome?.resolution?.providerResult.state).toBe('SUCCEEDED');
  });
  it.each([
    'operationId',
    'operationKind',
    'predecessorProviderVersion',
    'observedProviderVersion',
    'externalReference',
    'amountCents',
    'currency',
    'providerOccurredAt',
    'observedState',
  ])('rejects a hash-consistent terminal observation with changed %s', async (field) => {
    const { row, payload, refreshProof } = await terminalObservationFixture();
    const values: Record<string, unknown> = {
      operationId: randomUUID(),
      operationKind: 'SETTLE',
      predecessorProviderVersion: 1,
      observedProviderVersion: 2,
      externalReference: 'wrong-reference',
      amountCents: 1,
      currency: 'USD',
      providerOccurredAt: '2026-09-04T00:59:00.000Z',
      observedState: 'VOIDED',
    };
    row.raw_payload = JSON.stringify({ ...payload, [field]: values[field] });
    refreshProof();
    await expect(recordFakeFinancialOutcome(input())).rejects.toThrow();
    expect(state.order).toEqual(['begin:1']);
  });
  it.each([
    'target_authority_id',
    'raw_payload_sha256',
    'signed_payload_sha256',
    'resolution_identity_sha256',
    'provider_expires_at',
  ])('rejects changed %s evidence before COMMIT', async (field) => {
    const { row } = await terminalObservationFixture();
    (row as Record<string, unknown>)[field] =
      field === 'target_authority_id'
        ? randomUUID()
        : field === 'provider_expires_at'
          ? '2026-09-04T01:15:00.750Z'
          : 'f'.repeat(64);
    await expect(recordFakeFinancialOutcome(input())).rejects.toThrow();
    expect(state.order).toEqual(['begin:1']);
  });
  it('refuses a terminal resolution on the original DISPATCH lease', async () => {
    await terminalObservationFixture();
    Object.assign(lease(), {
      recovery_action: 'DISPATCH',
      recovery_lease_id: state.read.recovery_lease_id,
      lease_owner_id: state.read.worker_instance_id,
      admitted_job_validation_id: null,
    });
    leaseHash();
    Object.assign(outcome(), {
      recovery_lease_id: lease().recovery_lease_id,
      observation_idempotency_key: 'finance-outcome-v13:' + lease().recovery_lease_id,
    });
    outcomeHash();
    await expect(recordFakeFinancialOutcome(input())).rejects.toThrow(
      'RESOLUTION_RECONCILE_REQUIRED'
    );
  });
  it('does not return terminal certainty or retry the transaction after lost COMMIT acknowledgement', async () => {
    await terminalObservationFixture();
    state.failCommit = 1;
    await expect(recordFakeFinancialOutcome(input())).rejects.toThrow('COMMIT_UNCONFIRMED');
    expect(state.query).toHaveBeenCalledTimes(1);
  });
});

describe('database-derived fake-financial outcomes', () => {
  it('returns an expired reconcile no-effect fence only after commit with no execution capability', async () => {
    fenced();
    const result = await recordFakeFinancialOutcome(input());
    expect(result.outcome).toMatchObject({
      outcome_kind: 'FAILED',
      effect_certainty: 'CONFIRMED_NO_EFFECT',
      retryable: true,
    });
    expect(result.observation).toBeNull();
    expect(result.providerExecutionCapability).toBe(false);
    expect(state.order).toEqual(['begin:1', 'commit:1']);
  });
  it.each([
    [
      'unexpired window',
      () => {
        state.read.lease_expires_at = '2026-09-04T01:00:01.123457+00:00';
        state.read.outcome_deadline_at = '2026-09-04T01:00:01.123457+00:00';
      },
    ],
    [
      'unknown certainty',
      () => {
        outcome().effect_certainty = 'UNKNOWN';
      },
    ],
    [
      'no retry',
      () => {
        outcome().retryable = false;
      },
    ],
    [
      'wrong failure code',
      () => {
        outcome().failure_code = 'FAKE_EVENT_NOT_OBSERVED';
      },
    ],
    [
      'provider projection',
      () => {
        outcome().provider_state = 'SUCCEEDED';
      },
    ],
    [
      'dispatch lease',
      () => {
        Object.assign(lease(), {
          recovery_action: 'DISPATCH',
          admitted_job_validation_id: null,
          recovery_lease_id: state.read.recovery_lease_id,
          lease_owner_id: state.read.worker_instance_id,
        });
        outcome().recovery_lease_id = lease().recovery_lease_id;
        outcome().observation_idempotency_key = 'finance-outcome-v13:' + lease().recovery_lease_id;
        leaseHash();
      },
    ],
  ] as const)(
    'rejects a fence with %s even with a recomputed outcome hash',
    async (_label, change) => {
      fenced();
      change();
      outcomeHash();
      await expect(recordFakeFinancialOutcome(input())).rejects.toThrow('FENCE_BUNDLE_MISMATCH');
      expect(state.order).toEqual(['begin:1']);
    }
  );
  it('preserves fence identity on an explicit replay after an uncertain commit', async () => {
    fenced();
    const binding = input(),
      saved = { ...outcome() };
    state.failCommit = 1;
    await expect(recordFakeFinancialOutcome(binding)).rejects.toThrow('COMMIT_UNCONFIRMED');
    state.response.idempotency_replayed = true;
    expect((await recordFakeFinancialOutcome(binding)).outcome).toEqual(saved);
    expect(state.query).toHaveBeenCalledTimes(2);
  });
  it('validates a money-valued AUTHORIZE receipt with uppercase outcome currency and exact raw expiry', async () => {
    await authorizeFixture();
    const result = await recordFakeFinancialOutcome(input());
    expect(result.outcome).toMatchObject({
      amount_cents: 12500,
      currency: 'USD',
      effect_certainty: 'CONFIRMED_EFFECT',
    });
    expect(result.observation?.event.expiresAt).toBe('2026-09-04T01:15:00.500Z');
  });
  it('validates an exact observation and returns frozen evidence only after commit through the normal worker data plane', async () => {
    const binding = input();
    const result = await recordFakeFinancialOutcome(binding);
    expect(result.outcome.effect_certainty).toBe('CONFIRMED_EFFECT');
    expect(result.observation?.event.idempotencyReplayed).toBe(true);
    expect(state.order).toEqual(['begin:1', 'commit:1']);
    expect(state.authorize).toHaveBeenCalledWith({ component: 'worker' });
    expect(state.configure).toHaveBeenCalledWith('worker');
    expect(state.query).toHaveBeenCalledExactlyOnceWith(
      'SELECT * FROM public.hxos_record_fake_financial_outcome_v13($1,$2,$3)',
      [binding.jobValidationId, binding.workerInstanceId, binding.recoveryLeaseId]
    );
    for (const value of [
      result,
      result.outcome,
      result.lease,
      result.admission,
      result.observation,
    ])
      expect(Object.isFrozen(value)).toBe(true);
    expect(result).toMatchObject({
      providerExecutionCapability: false,
      positiveMoneyCapability: false,
      productionCapability: false,
    });
  });
  it('returns explicit unknown evidence with no provider projection or no-effect assertion', async () => {
    unknown();
    const result = await recordFakeFinancialOutcome(input());
    expect(result.outcome).toMatchObject({
      outcome_kind: 'OUTCOME_UNKNOWN',
      effect_certainty: 'UNKNOWN',
      retryable: true,
    });
    expect(result.observation).toBeNull();
  });
  it('uses the stable reconcile lease UUID without accepting dispatch authority', async () => {
    reconcile();
    const binding = { ...input(), leaseSeconds: 30 };
    const result = await acquireFakeFinancialReconcileLease(binding);
    expect(result.lease.admitted_job_validation_id).toBe(state.read.job_validation_id);
    expect(state.query).toHaveBeenCalledExactlyOnceWith(
      'SELECT * FROM public.hxos_acquire_fake_financial_reconcile_lease_v13($1,$2,$3,$4)',
      [binding.jobValidationId, binding.workerInstanceId, binding.recoveryLeaseId, 30]
    );
    expect(Object.isFrozen(result.lease)).toBe(true);
  });
  it('allows an expired historical lease receipt to replay without granting renewal', async () => {
    reconcile();
    state.response.idempotency_replayed = true;
    const result = await acquireFakeFinancialReconcileLease({ ...input(), leaseSeconds: 30 });
    expect(result.idempotencyReplayed).toBe(true);
    expect(result.lease.expires_at).toBe('2026-09-04T01:00:30.123456+00:00');
  });
  it('keeps an unknown replay unknown and never issues an event lookup or provider call', async () => {
    unknown();
    state.response.idempotency_replayed = true;
    expect((await recordFakeFinancialOutcome(input())).outcome.outcome_kind).toBe(
      'OUTCOME_UNKNOWN'
    );
    expect(state.query).toHaveBeenCalledTimes(1);
  });
  it('permits original release provenance while requiring the current reader database and environment', async () => {
    state.read.release_manifest_digest = `sha256:${'b'.repeat(64)}`;
    state.read.release_revision = '9'.repeat(40);
    await expect(recordFakeFinancialOutcome(input())).resolves.toMatchObject({
      outcome: { outcome_kind: 'OUTCOME_OBSERVED' },
    });
  });
  it.each(['provider_result_sha256', 'external_reference_sha256', 'outcome_identity_sha256'])(
    'rejects an altered %s',
    async (key) => {
      outcome()[key] = '0'.repeat(64);
      await expect(recordFakeFinancialOutcome(input())).rejects.toThrow(
        /BUNDLE_MISMATCH|HASH_MISMATCH/u
      );
    }
  );
  it.each([
    'amount_cents',
    'currency',
    'provider_state',
    'provider_result_version',
    'effect_certainty',
    'retryable',
  ])('rejects forged observed %s even with a recomputed outcome identity', async (key) => {
    outcome()[key] = (
      {
        amount_cents: 1,
        currency: 'USD',
        provider_state: 'DECLINED',
        provider_result_version: 2,
        effect_certainty: 'CONFIRMED_NO_EFFECT',
        retryable: true,
      } as Record<string, unknown>
    )[key];
    outcomeHash();
    await expect(recordFakeFinancialOutcome(input())).rejects.toThrow('OBSERVED_BUNDLE_MISMATCH');
  });
  it.each(['command_id', 'dispatch_attempt_id', 'recovery_lease_id'])(
    'rejects a foreign outcome %s',
    async (key) => {
      outcome()[key] = randomUUID();
      outcomeHash();
      await expect(recordFakeFinancialOutcome(input())).rejects.toThrow('OUTCOME_BINDING_MISMATCH');
    }
  );
  it('rejects a one-microsecond lease window mismatch', async () => {
    lease().expires_at = '2026-09-04T01:00:30.123457+00:00';
    await expect(recordFakeFinancialOutcome(input())).rejects.toThrow('LEASE_WINDOW_MISMATCH');
  });
  it('rejects a one-microsecond recovery window mismatch', async () => {
    unknown();
    outcome().recovery_not_before = '2026-09-04T01:00:02.123457+00:00';
    await expect(recordFakeFinancialOutcome(input())).rejects.toThrow('OUTCOME_WINDOW_MISMATCH');
  });
  it('rejects an outcome at the exclusive expiry boundary', async () => {
    outcome().recorded_at = lease().expires_at;
    await expect(recordFakeFinancialOutcome(input())).rejects.toThrow(
      'OUTCOME_LEASE_WINDOW_MISMATCH'
    );
  });
  it('rejects an unbound reconcile lease', async () => {
    reconcile();
    lease().admitted_job_validation_id = null;
    await expect(
      acquireFakeFinancialReconcileLease({ ...input(), leaseSeconds: 30 })
    ).rejects.toThrow('LEASE_ADMISSION_MISMATCH');
  });
  it('rejects acquisition receipts for DISPATCH', async () => {
    delete state.response.outcome_fact;
    delete state.response.provider_event;
    await expect(
      acquireFakeFinancialReconcileLease({ ...input(), leaseSeconds: 30 })
    ).rejects.toThrow('RECONCILE_LEASE_REQUIRED');
  });
  it.each([0, 901, 1.5])(
    'rejects invalid lease duration %s before accessing the data plane',
    async (leaseSeconds) => {
      reconcile();
      await expect(
        acquireFakeFinancialReconcileLease({ ...input(), leaseSeconds })
      ).rejects.toThrow();
      expect(state.query).not.toHaveBeenCalled();
    }
  );
  it('refuses caller-supplied certainty and failure projections before querying', async () => {
    await expect(
      recordFakeFinancialOutcome({ ...input(), effectCertainty: 'CONFIRMED_NO_EFFECT' } as any)
    ).rejects.toThrow();
    expect(state.query).not.toHaveBeenCalled();
  });
  it('refuses an unknown receipt carrying provider evidence', async () => {
    unknown();
    state.response.provider_event = state.event;
    await expect(recordFakeFinancialOutcome(input())).rejects.toThrow('UNKNOWN_BUNDLE_MISMATCH');
  });
  it('refuses observed receipts without committed raw provenance', async () => {
    state.response.provider_event = null;
    await expect(recordFakeFinancialOutcome(input())).rejects.toThrow('COMMITTED_EVENT_REQUIRED');
  });
  it('refuses forged raw provenance even when the outcome projection is otherwise correct', async () => {
    state.event.admitted_job_validation_id = randomUUID();
    await expect(recordFakeFinancialOutcome(input())).rejects.toThrow('EVENT_ADMISSION_MISMATCH');
  });
  it('does not retry or manufacture unknown evidence after an unconfirmed commit', async () => {
    state.failCommit = 1;
    const binding = input();
    await expect(recordFakeFinancialOutcome(binding)).rejects.toThrow('COMMIT_UNCONFIRMED');
    expect(state.query).toHaveBeenCalledTimes(1);
    state.response.idempotency_replayed = true;
    await expect(recordFakeFinancialOutcome(binding)).resolves.toMatchObject({
      idempotencyReplayed: true,
    });
    expect(state.query.mock.calls[1]).toEqual(state.query.mock.calls[0]);
  });
  it('does not retry or replace a reconcile lease UUID after an uncertain commit', async () => {
    reconcile();
    state.failCommit = 1;
    const binding = { ...input(), leaseSeconds: 30 };
    await expect(acquireFakeFinancialReconcileLease(binding)).rejects.toThrow('COMMIT_UNCONFIRMED');
    expect(state.query).toHaveBeenCalledTimes(1);
    state.response.idempotency_replayed = true;
    await expect(acquireFakeFinancialReconcileLease(binding)).resolves.toMatchObject({
      idempotencyReplayed: true,
    });
    expect(state.query.mock.calls[1]).toEqual(state.query.mock.calls[0]);
  });
  it('propagates database authority refusal without writing a guessed outcome', async () => {
    state.failQuery = 1;
    await expect(recordFakeFinancialOutcome(input())).rejects.toThrow('LIVE_AUTHORITY_REFUSED');
    expect(state.query).toHaveBeenCalledTimes(1);
  });
  it('refuses reader-authority changes at commit', async () => {
    state.changeAtCommit = true;
    await expect(recordFakeFinancialOutcome(input())).rejects.toThrow('AUTHORITY_CHANGED');
  });
  it('refuses invalid normal release authority before querying', async () => {
    state.authorize.mockImplementation(() => {
      throw Error('RELEASE_REFUSED');
    });
    await expect(recordFakeFinancialOutcome(input())).rejects.toThrow('RELEASE_REFUSED');
    expect(state.query).not.toHaveBeenCalled();
  });
  it('refuses a forged queue identity before querying', async () => {
    await expect(recordFakeFinancialOutcome({ ...input(), jobId: 'forged' })).rejects.toThrow(
      'JOB_IDENTITY_MISMATCH'
    );
    expect(state.query).not.toHaveBeenCalled();
  });
});

async function authorizeFixture() {
  const request = {
    operationId: randomUUID().toUpperCase(),
    idempotencyKey: `outcome-money:${randomUUID()}`,
    expectedVersion: 0,
    amountCents: 12500,
    currency: 'usd',
    relatedOperationId: randomUUID(),
    paymentMethodReference: 'fake_payment_method_0001',
  };
  const durable = encodeFakeFinancialDurableRequest('AUTHORIZE', request);
  const memory = new InMemoryFakeFinancialOperationRepository(
    () => new Date('2026-09-04T01:00:00.500Z')
  );
  await new FakeFinancialProvider(memory, 2).authorize(request);
  const stored = (await memory.findByIdempotencyKey(request.idempotencyKey))!;
  Object.assign(state.read, {
    operation_kind: 'AUTHORIZE',
    operation_id: request.operationId.toLowerCase(),
    idempotency_key: request.idempotencyKey,
    canonical_provider_request: durable.canonicalRequestJson,
    provider_request_sha256: durable.providerRequestSha256,
  });
  Object.assign(state.event, {
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
  });
  const reference = hash(stored.externalReference);
  Object.assign(outcome(), {
    amount_cents: 12500,
    currency: 'USD',
    external_reference_sha256: reference,
    provider_result_sha256: hash(
      [
        request.operationId.toLowerCase(),
        'AUTHORIZE',
        'FAKE',
        'SUCCEEDED',
        '1',
        '12500',
        'USD',
        reference,
        'false',
      ].join(':')
    ),
  });
  outcomeHash();
}

const event = () => state.response.financial_event as Record<string, any>;
const bridge = () => state.response.lifecycle_bridge as Record<string, any>;
const materializationInput = () => ({
  ...jobInput(),
  jobValidationId: state.read.job_validation_id as string,
  outcomeFactId: outcome().outcome_fact_id as string,
});
function materializationFixture() {
  const money = state.read.operation_kind === 'AUTHORIZE';
  state.response.financial_event = {
    id: randomUUID(),
    task_draft_id: randomUUID(),
    task_id: randomUUID(),
    eligibility_decision_id: randomUUID(),
    scope_version_id: randomUUID(),
    change_order_id: null,
    completion_fact_id: null,
    predecessor_event_id: money ? randomUUID() : null,
    recorded_by: randomUUID(),
    amount_cents: money ? 12500 : null,
    currency: money ? 'USD' : null,
    event_kind: money ? 'AUTHORIZED' : 'PAYMENT_METHOD_PREPARED',
    status: 'SUCCEEDED',
    operation_id: state.read.operation_id,
    idempotency_key: state.read.idempotency_key,
    expected_version: money ? 1 : 0,
    provider_kind: 'FAKE',
    external_reference: state.event.external_reference,
    evidence: {
      providerState: state.event.state,
      providerOperationVersion: state.event.event_version,
      providerIdempotencyReplayed: false,
    },
    occurred_at: state.event.recorded_at,
    expires_at: state.event.expires_at,
    created_at: '2026-09-04T01:02:00.123456+00:00',
  };
  const financial = event();
  state.response.lifecycle_bridge = {
    bridge_id: randomUUID(),
    prepared_command_id: state.read.prepared_command_id,
    command_id: state.read.command_id,
    dispatch_attempt_id: state.read.dispatch_attempt_id,
    outcome_fact_id: outcome().outcome_fact_id,
    fake_operation_event_id: state.event.event_id,
    task_financial_security_event_id: financial.id,
    fake_operation_id: state.event.operation_id,
    fake_operation_kind: state.event.operation_kind,
    fake_event_version: state.event.event_version,
    fake_provider_state: state.event.state,
    lifecycle_event_kind: financial.event_kind,
    lifecycle_status: financial.status,
    provider_expected_version: 0,
    lifecycle_expected_version: financial.expected_version,
    related_operation_id: state.event.related_operation_id,
    prepared_authority_sha256: state.read.prepared_authority_sha256,
    provider_request_sha256: state.read.provider_request_sha256,
    command_identity_sha256: state.read.command_identity_sha256,
    dispatch_attempt_identity_sha256: '1'.repeat(64),
    outcome_identity_sha256: outcome().outcome_identity_sha256,
    fake_operation_identity_sha256: state.event.identity_sha256,
    fake_event_request_sha256: state.event.request_sha256,
    fake_event_response_sha256: state.event.response_sha256,
    external_reference_sha256: outcome().external_reference_sha256,
    provider_recorded_at: state.event.recorded_at,
    provider_expires_at: state.event.expires_at,
    materialized_at: '2026-09-04T01:02:00.654321+00:00',
  };
  for (const key of [
    'task_draft_id',
    'task_id',
    'eligibility_decision_id',
    'scope_version_id',
    'change_order_id',
    'completion_fact_id',
    'predecessor_event_id',
    'recorded_by',
    'amount_cents',
    'currency',
  ])
    bridge()[key] = financial[key];
  materializationHashes();
}
function materializationHashes() {
  const financial = event();
  // Fixtures use the published SQL bridge identity recipe; the PostgreSQL cohort
  // also validates genuine worker receipts with the application decoder.
  const b = bridge();
  const resolved = b.resolution_contract_version === 1;
  const resolutionParts = resolved
    ? [1, b.resolution_observation_id, b.resolution_receipt_id, b.resolution_identity_sha256]
    : [];
  const providerTime = resolved ? b.provider_recorded_at : state.event.recorded_at;
  const providerExpiry = resolved ? b.provider_expires_at : state.event.expires_at;
  // Provider fixture clocks have millisecond precision; the real PG receipts
  // independently exercise SQL epoch-microsecond serialization.
  b.expiry_authority_sha256 = hash(
    [
      ...(resolved ? ['HUSTLEXP_UNIVERSAL_V1_FAKE_EXPIRY_RESOLUTION_V1'] : []),
      state.event.event_id,
      financial.id,
      BigInt(new Date(providerTime as string).getTime()) * 1000n,
      providerExpiry === null
        ? 'NO_EXPIRY'
        : BigInt(new Date(providerExpiry as string).getTime()) * 1000n,
      ...resolutionParts,
    ].join(':')
  );
  b.lifecycle_event_identity_sha256 = hash(
    [
      resolved
        ? 'HUSTLEXP_UNIVERSAL_V1_FAKE_LIFECYCLE_EVENT_RESOLUTION_V1'
        : 'HUSTLEXP_UNIVERSAL_V1_FAKE_LIFECYCLE_EVENT_V1',
      financial.id,
      financial.operation_id,
      financial.event_kind,
      financial.status,
      financial.expected_version,
      financial.task_draft_id,
      financial.task_id,
      financial.eligibility_decision_id,
      financial.scope_version_id,
      financial.change_order_id,
      financial.completion_fact_id,
      financial.predecessor_event_id,
      financial.amount_cents,
      financial.currency,
      financial.recorded_by,
      state.event.event_id,
      state.event.response_sha256,
      ...resolutionParts,
    ].join(':')
  );
  b.authority_chain_sha256 = hash(
    [
      resolved
        ? 'HUSTLEXP_UNIVERSAL_V1_FAKE_FINANCIAL_LIFECYCLE_BRIDGE_RESOLUTION_V1'
        : 'HUSTLEXP_UNIVERSAL_V1_FAKE_FINANCIAL_LIFECYCLE_BRIDGE_V1',
      state.read.prepared_command_id,
      state.read.prepared_authority_sha256,
      state.read.command_id,
      state.read.command_identity_sha256,
      state.read.dispatch_attempt_id,
      b.dispatch_attempt_identity_sha256,
      outcome().outcome_fact_id,
      outcome().outcome_identity_sha256,
      state.event.operation_id,
      state.event.operation_kind,
      state.event.identity_sha256,
      state.event.event_id,
      state.event.event_version,
      state.event.provider_request_sha256,
      state.event.request_sha256,
      state.event.response_sha256,
      financial.id,
      b.lifecycle_event_identity_sha256,
      ...resolutionParts,
    ].join(':')
  );
}
async function resolvedMaterializationFixture(
  kind: 'PREPARE_PAYMENT_METHOD' | 'AUTHORIZE' = 'AUTHORIZE'
) {
  const { row } = await terminalObservationFixture(kind);
  materializationFixture();
  Object.assign(event(), {
    occurred_at: row.provider_occurred_at,
    expires_at: row.provider_expires_at,
  });
  event().evidence.providerState = 'SUCCEEDED';
  Object.assign(bridge(), {
    fake_provider_state: 'SUCCEEDED',
    provider_recorded_at: row.provider_occurred_at,
    provider_expires_at: row.provider_expires_at,
    resolution_contract_version: 1,
    resolution_observation_id: row.observation_id,
    resolution_receipt_id: row.receipt_id,
    resolution_identity_sha256: row.resolution_identity_sha256,
  });
  materializationHashes();
  return row;
}
describe('explicit terminal-resolution lifecycle receipts', () => {
  it.each([
    'event.occurred_at',
    'event.expires_at',
    'bridge.provider_recorded_at',
    'bridge.provider_expires_at',
  ])('refuses a seventh fractional timestamp digit in %s', async (field) => {
    await resolvedMaterializationFixture();
    const [source, key] = field.split('.');
    const row = source === 'event' ? event() : bridge();
    row[key!] = row[key!].replace('.750Z', '.7500001Z');
    await expect(materializeFakeFinancialEvent(materializationInput())).rejects.toThrow(
      'RESPONSE_INVALID'
    );
  });

  it.each(['PREPARE_PAYMENT_METHOD', 'AUTHORIZE'] as const)(
    'decodes %s lifecycle from separate committed observation while keeping raw pending evidence',
    async (kind) => {
      const row = await resolvedMaterializationFixture(kind);
      const result = await materializeFakeFinancialEvent(materializationInput());
      expect(result.observation?.event.state).toBe('PENDING');
      expect(result.financialEvent.evidence.providerState).toBe('SUCCEEDED');
      expect(result.financialEvent.occurred_at).toBe(row.provider_occurred_at);
      expect(result.financialEvent.expires_at).toBe(row.provider_expires_at);
      expect(result.lifecycleBridge.fake_event_response_sha256).toBe(state.event.response_sha256);
      expect(result.providerExecutionCapability).toBe(false);
    }
  );
  it.each([
    'resolution_contract_version',
    'resolution_observation_id',
    'resolution_receipt_id',
    'resolution_identity_sha256',
  ])('refuses missing resolution bridge field %s', async (key) => {
    await resolvedMaterializationFixture();
    delete bridge()[key];
    await expect(materializeFakeFinancialEvent(materializationInput())).rejects.toThrow();
  });
  it.each(['resolution_observation_id', 'resolution_receipt_id', 'resolution_identity_sha256'])(
    'refuses a rehashed bridge with substituted %s',
    async (key) => {
      await resolvedMaterializationFixture();
      bridge()[key] = key.endsWith('sha256') ? '9'.repeat(64) : randomUUID();
      materializationHashes();
      await expect(materializeFakeFinancialEvent(materializationInput())).rejects.toThrow(
        'RESOLUTION_PROVENANCE_MISMATCH'
      );
    }
  );
  it.each(['occurred_at', 'expires_at'])(
    'refuses a rehashed lifecycle with altered signed %s',
    async (key) => {
      await resolvedMaterializationFixture();
      event()[key] = new Date(Date.parse(event()[key]) + 1).toISOString();
      bridge()[key === 'occurred_at' ? 'provider_recorded_at' : 'provider_expires_at'] =
        event()[key];
      materializationHashes();
      await expect(materializeFakeFinancialEvent(materializationInput())).rejects.toThrow(
        'EVENT_PROJECTION_MISMATCH'
      );
    }
  );
  it('refuses resolved bridge metadata attached to an ordinary direct-success outcome', async () => {
    materializationFixture();
    Object.assign(bridge(), {
      resolution_contract_version: 1,
      resolution_observation_id: randomUUID(),
      resolution_receipt_id: randomUUID(),
      resolution_identity_sha256: '9'.repeat(64),
    });
    materializationHashes();
    await expect(materializeFakeFinancialEvent(materializationInput())).rejects.toThrow(
      'RESOLUTION_PROVENANCE_MISMATCH'
    );
  });
});
describe('committed fake-financial lifecycle materialization application port', () => {
  beforeEach(materializationFixture);
  it('uses only two IDs at the sealed port and returns deeply frozen event/bridge after commit', async () => {
    const input = materializationInput();
    const result = await materializeFakeFinancialEvent(input);
    expect(state.query).toHaveBeenCalledExactlyOnceWith(
      'SELECT * FROM public.hxos_materialize_fake_financial_event_v13($1,$2)',
      [input.jobValidationId, input.outcomeFactId]
    );
    expect(state.order).toEqual(['begin:1', 'commit:1']);
    expect(result.financialEvent).toEqual(event());
    expect(result.lifecycleBridge).toEqual(bridge());
    expect(result.observation?.event.idempotencyReplayed).toBe(true);
    expect(result.financialEvent.evidence.providerIdempotencyReplayed).toBe(false);
    expect(result.idempotencyReplayed).toBe(false);
    for (const object of [
      result,
      result.financialEvent,
      result.financialEvent.evidence,
      result.lifecycleBridge,
      result.outcome,
      result.lease,
    ])
      expect(Object.isFrozen(object)).toBe(true);
    expect(state.authorize).toHaveBeenCalledWith({ component: 'worker' });
    expect(result).toMatchObject({
      providerExecutionCapability: false,
      positiveMoneyCapability: false,
      productionCapability: false,
    });
  });
  it('preserves monetary AUTHORIZE amount/currency and raw event expiry', async () => {
    await authorizeFixture();
    materializationFixture();
    const result = await materializeFakeFinancialEvent(materializationInput());
    expect(result.financialEvent).toMatchObject({
      event_kind: 'AUTHORIZED',
      amount_cents: 12500,
      currency: 'USD',
      occurred_at: '2026-09-04T01:00:00.500Z',
      expires_at: '2026-09-04T01:15:00.500Z',
    });
  });
  it('replays the recorded RECONCILE lease after its expiry without renewing or substituting the original dispatch', async () => {
    const savedOutcome = { ...outcome() };
    const savedEvent = state.event;
    reconcile();
    state.response.outcome_fact = savedOutcome;
    state.response.provider_event = savedEvent;
    outcome().recovery_lease_id = lease().recovery_lease_id;
    outcome().observation_idempotency_key = 'finance-outcome-v13:' + lease().recovery_lease_id;
    outcomeHash();
    materializationFixture();
    state.response.idempotency_replayed = true;
    const result = await materializeFakeFinancialEvent(materializationInput());
    expect(result.lease.recovery_action).toBe('RECONCILE');
    expect(result.lifecycleBridge.dispatch_attempt_id).toBe(state.read.dispatch_attempt_id);
    expect(result.idempotencyReplayed).toBe(true);
    expect(state.query).toHaveBeenCalledTimes(1);
  });
  it('rejects a one-microsecond change in the provider expiry bridge', async () => {
    await authorizeFixture();
    materializationFixture();
    bridge().provider_expires_at = '2026-09-04T01:15:00.500001Z';
    await expect(materializeFakeFinancialEvent(materializationInput())).rejects.toThrow(
      'EXPIRY_AUTHORITY_MISMATCH'
    );
    expect(state.order).toEqual(['begin:1']);
  });
  it('compares provider timestamp instants rather than their time-zone text', async () => {
    bridge().provider_recorded_at = '2026-09-03T18:00:00.500000-07:00';
    event().occurred_at = '2026-09-04T02:00:00.500000+01:00';
    expect((await materializeFakeFinancialEvent(materializationInput())).financialEvent.id).toBe(
      event().id
    );
  });
  it('rejects an internally hash-consistent PREPARE that pretends to be a later lifecycle event', async () => {
    event().expected_version = bridge().lifecycle_expected_version = 1;
    event().predecessor_event_id = bridge().predecessor_event_id = randomUUID();
    materializationHashes();
    await expect(materializeFakeFinancialEvent(materializationInput())).rejects.toThrow(
      'EVENT_LIFECYCLE_INVALID'
    );
  });
  it('rejects an internally hash-consistent AUTHORIZE with no preceding lifecycle event', async () => {
    await authorizeFixture();
    materializationFixture();
    event().predecessor_event_id = bridge().predecessor_event_id = null;
    materializationHashes();
    await expect(materializeFakeFinancialEvent(materializationInput())).rejects.toThrow(
      'EVENT_LIFECYCLE_INVALID'
    );
  });
  it('rejects an internally hash-consistent PREPARE with invented completion evidence', async () => {
    event().completion_fact_id = bridge().completion_fact_id = randomUUID();
    materializationHashes();
    await expect(materializeFakeFinancialEvent(materializationInput())).rejects.toThrow(
      'EVENT_LIFECYCLE_INVALID'
    );
    expect(state.order).toEqual(['begin:1']);
  });
  it('rejects an internally hash-consistent AUTHORIZE with invented change-order context', async () => {
    await authorizeFixture();
    materializationFixture();
    event().change_order_id = bridge().change_order_id = randomUUID();
    materializationHashes();
    await expect(materializeFakeFinancialEvent(materializationInput())).rejects.toThrow(
      'EVENT_LIFECYCLE_INVALID'
    );
    expect(state.order).toEqual(['begin:1']);
  });
  it.each([
    [
      'expiry hash',
      () => {
        bridge().expiry_authority_sha256 = '6'.repeat(64);
      },
    ],
    [
      'provider occurrence microsecond',
      () => {
        bridge().provider_recorded_at = '2026-09-04T01:00:00.500001Z';
      },
    ],
    [
      'legacy null expiry bundle',
      () => {
        bridge().provider_recorded_at = null;
        bridge().provider_expires_at = null;
        bridge().expiry_authority_sha256 = null;
      },
    ],
    [
      'task root',
      () => {
        event().task_id = randomUUID();
      },
    ],
    [
      'event id',
      () => {
        event().id = randomUUID();
      },
    ],
    [
      'event amount',
      () => {
        event().amount_cents = 1;
      },
    ],
    [
      'event operation kind',
      () => {
        event().event_kind = 'AUTHORIZED';
      },
    ],
    [
      'event timestamp microsecond',
      () => {
        event().occurred_at = '2026-09-04T01:00:00.500001Z';
      },
    ],
    [
      'invented expiry',
      () => {
        event().expires_at = '2026-09-04T01:15:00.500Z';
      },
    ],
    [
      'invented replay evidence',
      () => {
        event().evidence.providerIdempotencyReplayed = true;
      },
    ],
    [
      'original dispatch',
      () => {
        bridge().dispatch_attempt_id = randomUUID();
      },
    ],
    [
      'outcome identity',
      () => {
        bridge().outcome_fact_id = randomUUID();
      },
    ],
    [
      'prepared authority',
      () => {
        bridge().prepared_authority_sha256 = '3'.repeat(64);
      },
    ],
    [
      'provider version',
      () => {
        bridge().provider_expected_version = 1;
      },
    ],
    [
      'lifecycle hash',
      () => {
        bridge().lifecycle_event_identity_sha256 = '4'.repeat(64);
      },
    ],
    [
      'chain hash',
      () => {
        bridge().authority_chain_sha256 = '5'.repeat(64);
      },
    ],
    [
      'unexpected field',
      () => {
        event().authority = true;
      },
    ],
    [
      'private transaction marker',
      () => {
        outcome().recording_transaction_id = '123';
      },
    ],
  ])('rejects drift in %s before commit', async (_label, change) => {
    change();
    await expect(materializeFakeFinancialEvent(materializationInput())).rejects.toThrow();
    expect(state.order).toEqual(['begin:1']);
  });
  it('refuses UNKNOWN without manufacturing a terminal event', async () => {
    unknown();
    await expect(materializeFakeFinancialEvent(materializationInput())).rejects.toThrow(
      'TERMINAL_OUTCOME_REQUIRED'
    );
    expect(state.order).toEqual(['begin:1']);
  });
  it('rejects caller state/amount projections and forged job identity before opening a transaction', async () => {
    await expect(
      materializeFakeFinancialEvent({ ...materializationInput(), amountCents: 1 } as any)
    ).rejects.toThrow();
    await expect(
      materializeFakeFinancialEvent({ ...materializationInput(), jobId: 'forged' })
    ).rejects.toThrow('JOB_IDENTITY_MISMATCH');
    expect(state.count).toBe(0);
  });
  it('rejects a different requested outcome even when the returned bundle is internally consistent', async () => {
    await expect(
      materializeFakeFinancialEvent({ ...materializationInput(), outcomeFactId: randomUUID() })
    ).rejects.toThrow('TERMINAL_OUTCOME_REQUIRED');
  });
  it('rejects bad row cardinality', async () => {
    state.rowCount = 0;
    await expect(materializeFakeFinancialEvent(materializationInput())).rejects.toThrow(
      'CARDINALITY'
    );
  });
  it('does not retry uncertain COMMIT; a later explicit call replays the same durable IDs', async () => {
    const input = materializationInput();
    state.failCommit = 1;
    await expect(materializeFakeFinancialEvent(input)).rejects.toThrow('COMMIT_UNCONFIRMED');
    expect(state.query).toHaveBeenCalledTimes(1);
    state.response.idempotency_replayed = true;
    expect((await materializeFakeFinancialEvent(input)).idempotencyReplayed).toBe(true);
    expect(state.query).toHaveBeenCalledTimes(2);
  });
  it('refuses reader authority drift at commit and propagates live data-plane denial', async () => {
    state.changeAtCommit = true;
    await expect(materializeFakeFinancialEvent(materializationInput())).rejects.toThrow(
      'AUTHORITY_CHANGED'
    );
    state.changeAtCommit = false;
    state.failQuery = 2;
    await expect(materializeFakeFinancialEvent(materializationInput())).rejects.toThrow(
      'LIVE_AUTHORITY_REFUSED'
    );
    expect(state.query).toHaveBeenCalledTimes(2);
  });
});

function progressFixture(recorded: Record<string, unknown> | null = state.response) {
  state.response = {
    recovery_evidence: state.recoveryResponse,
    recorded_outcome: recorded === null ? null : { ...recorded, idempotency_replayed: true },
  };
}
describe('committed fake-financial progress readback', () => {
  it('recovers the existing terminal outcome and recording lease after restart without creating new identities', async () => {
    const previous = { ...outcome() };
    progressFixture();
    const result = await readFakeFinancialProgress(jobInput());
    expect(state.query).toHaveBeenCalledExactlyOnceWith(
      'SELECT * FROM public.hxos_read_fake_financial_progress_v13($1,$2,$3)',
      [jobInput().payload.outboxRequestId, jobInput().jobId, jobInput().payload.jobAuthoritySha256]
    );
    expect(result.recordedOutcome?.outcome).toEqual(previous);
    expect(result.recordedOutcome?.lease.recovery_lease_id).toBe(previous.recovery_lease_id);
    expect(result.recordedOutcome?.idempotencyReplayed).toBe(true);
    expect(state.order).toEqual(['begin:1', 'commit:1']);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.recordedOutcome)).toBe(true);
    expect(result.providerExecutionCapability).toBe(false);
    expect(result.positiveMoneyCapability).toBe(false);
    expect(result.productionCapability).toBe(false);
  });
  it('preserves UNKNOWN even when a separate raw read now finds a committed event', async () => {
    unknown();
    progressFixture();
    const result = await readFakeFinancialProgress(jobInput());
    expect(result.kind).toBe('COMMITTED_EVENT');
    expect(result.recordedOutcome?.outcome.outcome_kind).toBe('OUTCOME_UNKNOWN');
    expect(result.recordedOutcome?.observation).toBeNull();
  });
  it.each(['NO_COMMITTED_ADMISSION', 'NO_COMMITTED_EVENT', 'COMMITTED_EVENT'])(
    'reports %s with no invented outcome',
    async (kind) => {
      if (kind !== 'COMMITTED_EVENT') state.recoveryResponse.provider_event = null;
      if (kind === 'NO_COMMITTED_ADMISSION') state.recoveryResponse.admission_evidence = null;
      progressFixture(null);
      const result = await readFakeFinancialProgress(jobInput());
      expect(result.kind).toBe(kind);
      expect(result.recordedOutcome).toBeNull();
      expect(result.providerExecutionCapability).toBe(false);
    }
  );
  it('uses the historical RECONCILE owner rather than inventing a replacement recording lease', async () => {
    const saved = { ...outcome() };
    reconcile();
    state.response.outcome_fact = saved;
    state.response.provider_event = state.event;
    outcome().recovery_lease_id = lease().recovery_lease_id;
    outcome().observation_idempotency_key = 'finance-outcome-v13:' + lease().recovery_lease_id;
    outcomeHash();
    const owner = lease().lease_owner_id;
    progressFixture();
    expect(
      (await readFakeFinancialProgress(jobInput())).recordedOutcome?.lease.lease_owner_id
    ).toBe(owner);
  });
  it.each([
    [
      'non-replay',
      () => {
        (state.response.recorded_outcome as any).idempotency_replayed = false;
      },
    ],
    [
      'different raw event',
      () => {
        state.recoveryResponse.provider_event = { ...state.event, event_id: randomUUID() };
      },
    ],
    [
      'same event with changed occurrence time',
      () => {
        state.recoveryResponse.provider_event = {
          ...state.event,
          recorded_at: '2026-09-04T01:00:00.501Z',
        };
      },
    ],
    [
      'different prepared identity',
      () => {
        (state.response.recorded_outcome as any).admission_evidence = {
          ...state.read,
          prepared_command_id: randomUUID(),
        };
      },
    ],
    [
      'extra progress field',
      () => {
        state.response.dispatch_allowed = true;
      },
    ],
    [
      'outcome without admission',
      () => {
        state.recoveryResponse.admission_evidence = null;
        state.recoveryResponse.provider_event = null;
      },
    ],
  ])('rejects %s inside the transaction', async (_label, change) => {
    progressFixture();
    change();
    await expect(readFakeFinancialProgress(jobInput())).rejects.toThrow();
    expect(state.order).toEqual(['begin:1']);
  });
  it('propagates lost read COMMIT without retry, and rejects authority drift after commit', async () => {
    progressFixture();
    state.failCommit = 1;
    await expect(readFakeFinancialProgress(jobInput())).rejects.toThrow('COMMIT_UNCONFIRMED');
    expect(state.query).toHaveBeenCalledTimes(1);
    state.changeAtCommit = true;
    await expect(readFakeFinancialProgress(jobInput())).rejects.toThrow('AUTHORITY_CHANGED');
  });
  it('rejects forged IDs before reads and malformed cardinality before commit', async () => {
    progressFixture();
    await expect(readFakeFinancialProgress({ ...jobInput(), jobId: 'forged' })).rejects.toThrow(
      'JOB_IDENTITY_MISMATCH'
    );
    expect(state.count).toBe(0);
    state.rowCount = 0;
    await expect(readFakeFinancialProgress(jobInput())).rejects.toThrow('CARDINALITY');
    expect(state.order).toEqual(['begin:1']);
  });
});
