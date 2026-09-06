import { describe, expect, it, vi } from 'vitest';

import {
  UniversalV1StandardizedQuoteApplication,
  type UniversalV1StandardizedQuoteRepository,
} from '../../src/services/UniversalV1StandardizedQuoteApplication';
import {
  AcceptUniversalV1StandardizedQuoteSchema,
  PrepareUniversalV1FakePaymentMethodSchema,
  PrepareUniversalV1StandardizedQuoteSchema,
  universalV1StandardizedQuoteAuthority,
  type UniversalV1FakePaymentMethodReadinessRecord,
  type UniversalV1StandardizedQuoteAcceptanceRecord,
  type UniversalV1StandardizedQuoteRecord,
  type UniversalV1StandardizedQuoteRuntimeEvidence,
} from '../../src/services/UniversalV1StandardizedQuoteContracts';

const ACTOR_ID = '11111111-1111-4111-8111-111111111111';
const DRAFT_ID = '22222222-2222-4222-8222-222222222222';
const ROUTE_ID = '33333333-3333-4333-8333-333333333333';
const ORIGIN_ID = '44444444-4444-4444-8444-444444444444';
const CELL_ID = '55555555-5555-4555-8555-555555555555';
const QUOTE_ID = '66666666-6666-4666-8666-666666666666';
const ACCEPTANCE_ID = '77777777-7777-4777-8777-777777777777';
const READINESS_ID = '88888888-8888-4888-8888-888888888888';
const NOW = Date.parse('2026-08-31T12:00:00.000Z');

const issuanceEvidence: UniversalV1StandardizedQuoteRuntimeEvidence = {
  environment: 'staging',
  buildCommitSha: 'a'.repeat(40),
  releaseManifestDigest: `sha256:${'b'.repeat(64)}`,
  capabilityPolicyDigest: `sha256:${'c'.repeat(64)}`,
};

const laterCommandEvidence: UniversalV1StandardizedQuoteRuntimeEvidence = {
  environment: 'staging',
  buildCommitSha: 'd'.repeat(40),
  releaseManifestDigest: `sha256:${'e'.repeat(64)}`,
  capabilityPolicyDigest: `sha256:${'f'.repeat(64)}`,
};

function quoteRecord(): UniversalV1StandardizedQuoteRecord {
  return {
    quoteVersionId: QUOTE_ID,
    taskDraftId: DRAFT_ID,
    routingDecisionId: ROUTE_ID,
    routingDecisionVersion: 1,
    relationshipOriginId: ORIGIN_ID,
    relationshipOriginVersion: 1,
    serviceCellAuthorityId: CELL_ID,
    serviceCellAuthorityVersion: 1,
    quoteVersion: 1,
    quoteKind: 'STANDARDIZED_SCOPE_FIXED_PRICE',
    scopeArtifactKind: 'TASK_DRAFT_STANDARDIZED_SCOPE_V1',
    scopeArtifactId: QUOTE_ID,
    scopeArtifactVersion: 1,
    workCategoryCode: 'furniture_assembly',
    regionCode: 'US-WA',
    roughLocation: 'North district',
    riskLevel: 'LOW',
    requiresProof: true,
    scopeSnapshot: { workCategoryCode: 'furniture_assembly' },
    scopeSha256: '1'.repeat(64),
    priceBookId: '99999999-9999-4999-8999-999999999999',
    priceBookMappingId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    pricingPolicyVersion: 'hxos-price-book-v1',
    pricingSnapshot: { basePriceCents: 12_000 },
    pricingSha256: '2'.repeat(64),
    quoteEvidenceSha256: '3'.repeat(64),
    customerTotalCents: 12_000,
    providerPayoutCents: 7_000,
    platformMarginCents: 5_000,
    currency: 'usd',
    paymentPosture: 'PAYMENT_CREATION_FROZEN',
    environment: 'staging',
    issuanceEvidence,
    issuanceEvidenceSha256: '8'.repeat(64),
    idempotencyKey: 'quote:prepare:0001',
    requestSha256: '4'.repeat(64),
    validUntil: '2026-09-03T12:00:00.000Z',
    createdAt: '2026-08-31T12:00:00.000Z',
  };
}

function acceptanceRecord(): UniversalV1StandardizedQuoteAcceptanceRecord {
  return {
    acceptanceFactId: ACCEPTANCE_ID,
    taskDraftId: DRAFT_ID,
    quoteVersionId: QUOTE_ID,
    quoteVersion: 1,
    routingDecisionId: ROUTE_ID,
    routingDecisionVersion: 1,
    scopeArtifactKind: 'TASK_DRAFT_STANDARDIZED_SCOPE_V1',
    scopeArtifactId: QUOTE_ID,
    scopeArtifactVersion: 1,
    scopeSha256: '1'.repeat(64),
    pricingSha256: '2'.repeat(64),
    quoteEvidenceSha256: '3'.repeat(64),
    customerTotalCents: 12_000,
    currency: 'usd',
    acceptanceVersion: 1,
    acceptedByUserId: ACTOR_ID,
    environment: 'staging',
    commandEvidence: laterCommandEvidence,
    commandEvidenceSha256: '9'.repeat(64),
    idempotencyKey: 'quote:accept:00001',
    requestSha256: '5'.repeat(64),
    acceptedAt: '2026-09-01T12:00:00.000Z',
  };
}

function readinessRecord(
  version: number,
  status:
    | boolean
    | UniversalV1FakePaymentMethodReadinessRecord['currentStatus'] = 'CURRENT'
): UniversalV1FakePaymentMethodReadinessRecord {
  const currentStatus = status === true
    ? 'CURRENT'
    : status === false
      ? 'EXPIRED'
      : status;
  const isCurrent = currentStatus === 'CURRENT';
  const isUnexpired = currentStatus !== 'EXPIRED';
  return {
    readinessFactId: READINESS_ID,
    taskDraftId: DRAFT_ID,
    acceptanceFactId: ACCEPTANCE_ID,
    quoteVersionId: QUOTE_ID,
    quoteVersion: 1,
    readinessVersion: version,
    providerKind: 'FAKE',
    environment: 'staging',
    preparedByUserId: ACTOR_ID,
    fakeProviderOperationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    opaqueReferenceSha256: '6'.repeat(64),
    commandEvidence: laterCommandEvidence,
    commandEvidenceSha256: 'a'.repeat(64),
    idempotencyKey: `readiness:prepare:000${version}`,
    requestSha256: '7'.repeat(64),
    expiresAt: isUnexpired
      ? '2026-08-31T12:30:00.000Z'
      : '2026-08-31T11:30:00.000Z',
    createdAt: isUnexpired
      ? '2026-08-31T12:00:00.000Z'
      : '2026-08-31T11:00:00.000Z',
    currentStatus,
    isCurrent,
  };
}

function repository(
  overrides: Partial<UniversalV1StandardizedQuoteRepository> = {}
): UniversalV1StandardizedQuoteRepository {
  return {
    findQuoteReplay: vi.fn(async () => null),
    prepareQuote: vi.fn(async () => ({ record: quoteRecord(), replayed: false })),
    getCurrent: vi.fn(async () => ({
      quote: quoteRecord(),
      acceptance: null,
      readiness: null,
      routingCurrent: true,
      acceptanceOpen: true,
      priceLocked: false,
      fakePaymentMethodReady: false,
      actionableState: 'ACCEPT_QUOTE',
    })),
    findAcceptanceReplay: vi.fn(async () => null),
    acceptQuote: vi.fn(async () => ({ record: acceptanceRecord(), replayed: false })),
    findFakePaymentMethodReplay: vi.fn(async () => null),
    prepareFakePaymentMethod: vi.fn(async (command) => ({
      record: {
        ...readinessRecord(command.input.expectedReadinessVersion + 1),
        opaqueReferenceSha256: command.opaqueReferenceSha256,
        commandEvidence: command.evidence,
      },
      replayed: false,
    })),
    ...overrides,
  };
}

describe('UniversalV1StandardizedQuoteApplication', () => {
  it('rejects command versions outside the PostgreSQL INTEGER boundary', () => {
    const postgresIntegerMax = 2_147_483_647;
    const outsidePostgresInteger = postgresIntegerMax + 1;
    for (const exactVersionSchema of [
      PrepareUniversalV1StandardizedQuoteSchema.shape.expectedRoutingDecisionVersion,
      AcceptUniversalV1StandardizedQuoteSchema.shape.expectedRoutingDecisionVersion,
      AcceptUniversalV1StandardizedQuoteSchema.shape.expectedQuoteVersion,
      PrepareUniversalV1FakePaymentMethodSchema.shape.expectedQuoteVersion,
    ]) {
      expect(exactVersionSchema.safeParse(postgresIntegerMax).success).toBe(true);
      expect(exactVersionSchema.safeParse(outsidePostgresInteger).success).toBe(false);
    }
    for (const incrementedVersionSchema of [
      PrepareUniversalV1StandardizedQuoteSchema.shape.expectedQuoteVersion,
      PrepareUniversalV1FakePaymentMethodSchema.shape.expectedReadinessVersion,
    ]) {
      expect(incrementedVersionSchema.safeParse(postgresIntegerMax - 1).success).toBe(true);
      expect(incrementedVersionSchema.safeParse(postgresIntegerMax).success).toBe(false);
    }
  });

  it('prepares only an effect-free quote under server-supplied issuance evidence', async () => {
    const store = repository();
    const app = new UniversalV1StandardizedQuoteApplication(store, {
      now: () => NOW,
      runtimeEvidence: () => issuanceEvidence,
    });
    const response = await app.prepareQuote(ACTOR_ID, {
      taskDraftId: DRAFT_ID,
      expectedRoutingDecisionVersion: 1,
      expectedQuoteVersion: 0,
      idempotencyKey: 'quote:prepare:0001',
      clientTs: NOW,
    });

    expect(response).toMatchObject({
      state: 'QUOTED',
      paymentCreationFrozen: true,
      taskCreated: false,
      assignmentCreated: false,
      workOrderCreated: false,
    });
    expect(vi.mocked(store.prepareQuote).mock.calls[0]?.[0].evidence).toEqual(
      issuanceEvidence
    );
  });

  it('accepts under a later release witness without mutating issuance evidence', async () => {
    const store = repository();
    const app = new UniversalV1StandardizedQuoteApplication(store, {
      now: () => NOW,
      runtimeEvidence: () => laterCommandEvidence,
    });
    await expect(
      app.acceptQuote(ACTOR_ID, {
        taskDraftId: DRAFT_ID,
        quoteVersionId: QUOTE_ID,
        expectedRoutingDecisionVersion: 1,
        expectedQuoteVersion: 1,
        expectedAcceptanceVersion: 0,
        idempotencyKey: 'quote:accept:00001',
        clientTs: NOW,
      })
    ).resolves.toMatchObject({
      state: 'ACCEPTED',
      acceptance: { pricingSha256: '2'.repeat(64) },
      paymentCreationCreated: false,
      financialSecurityEventCreated: false,
      assignmentCreated: false,
    });

    const command = vi.mocked(store.acceptQuote).mock.calls[0]?.[0];
    expect(command?.evidence).toEqual(laterCommandEvidence);
    expect(command?.evidence).not.toEqual(issuanceEvidence);
  });

  it('recovers the quote-to-readiness crash gap and renews an expired head by exact version', async () => {
    const prepareFakePaymentMethod = vi
      .fn<UniversalV1StandardizedQuoteRepository['prepareFakePaymentMethod']>()
      .mockImplementation(async (command) => ({
        record: readinessRecord(command.input.expectedReadinessVersion + 1),
        replayed: false,
      }));
    const store = repository({
      getCurrent: vi.fn(async () => ({
        quote: quoteRecord(),
        acceptance: acceptanceRecord(),
        readiness: readinessRecord(1, false),
        routingCurrent: true,
        acceptanceOpen: false,
        priceLocked: true,
        fakePaymentMethodReady: false,
        actionableState: 'PREPARE_OR_RENEW_FAKE_PAYMENT_METHOD',
      })),
      prepareFakePaymentMethod,
    });
    const app = new UniversalV1StandardizedQuoteApplication(store, {
      now: () => NOW,
      runtimeEvidence: () => laterCommandEvidence,
    });

    await expect(app.getCurrent(ACTOR_ID, { taskDraftId: DRAFT_ID })).resolves.toMatchObject({
      acceptance: { acceptanceFactId: ACCEPTANCE_ID },
      readiness: { readinessVersion: 1, isCurrent: false },
      priceLocked: true,
      fakePaymentMethodReady: false,
      actionableState: 'PREPARE_OR_RENEW_FAKE_PAYMENT_METHOD',
    });
    const renewed = await app.prepareFakePaymentMethod(ACTOR_ID, {
      taskDraftId: DRAFT_ID,
      acceptanceFactId: ACCEPTANCE_ID,
      expectedQuoteVersion: 1,
      expectedReadinessVersion: 1,
      idempotencyKey: 'readiness:renew:0001',
      clientTs: NOW,
    });
    expect(renewed).toMatchObject({
      state: 'FAKE_PAYMENT_METHOD_READY',
      readiness: { readinessVersion: 2 },
      providerKind: 'FAKE',
      networkCalled: false,
      customerMoneyCreated: false,
      authorizationCreated: false,
      financialSecurityEventCreated: false,
      captureCreated: false,
      workOrderCreated: false,
      settlementCreated: false,
      payoutCreated: false,
    });
    expect(prepareFakePaymentMethod.mock.calls[0]?.[0].input.expectedReadinessVersion).toBe(1);
  });

  it('makes exact replays deterministic while distinct readiness versions get distinct fake references', async () => {
    const prepareFakePaymentMethod = vi
      .fn<UniversalV1StandardizedQuoteRepository['prepareFakePaymentMethod']>()
      .mockImplementation(async (command) => ({
        record: readinessRecord(command.input.expectedReadinessVersion + 1),
        replayed: false,
      }));
    const findFakePaymentMethodReplay = vi
      .fn<UniversalV1StandardizedQuoteRepository['findFakePaymentMethodReplay']>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(readinessRecord(1))
      .mockResolvedValueOnce(null);
    const store = repository({ findFakePaymentMethodReplay, prepareFakePaymentMethod });
    const app = new UniversalV1StandardizedQuoteApplication(store, {
      now: () => NOW,
      runtimeEvidence: () => laterCommandEvidence,
    });
    const firstInput = {
      taskDraftId: DRAFT_ID,
      acceptanceFactId: ACCEPTANCE_ID,
      expectedQuoteVersion: 1,
      expectedReadinessVersion: 0,
      idempotencyKey: 'readiness:prepare:0001',
      clientTs: NOW,
    };
    const first = await app.prepareFakePaymentMethod(ACTOR_ID, firstInput);
    const replay = await app.prepareFakePaymentMethod(ACTOR_ID, firstInput);
    expect(replay).toMatchObject({ idempotencyReplayed: true });
    expect(prepareFakePaymentMethod).toHaveBeenCalledOnce();
    const renewal = await app.prepareFakePaymentMethod(ACTOR_ID, {
      ...firstInput,
      expectedReadinessVersion: 1,
      idempotencyKey: 'readiness:prepare:0002',
    });

    expect(replay.fakePaymentMethodReference).toBe(first.fakePaymentMethodReference);
    expect(renewal.fakePaymentMethodReference).not.toBe(first.fakePaymentMethodReference);
    expect(first.fakePaymentMethodReference).toMatch(/^fake_pm_[a-f0-9]{64}$/u);
    expect(prepareFakePaymentMethod).toHaveBeenCalledTimes(2);
  });

  it('labels an expired idempotent readiness replay as expired without new authority or mutation', async () => {
    const expiredReplay = readinessRecord(1, false);
    const prepareFakePaymentMethod = vi.fn<
      UniversalV1StandardizedQuoteRepository['prepareFakePaymentMethod']
    >();
    const runtimeEvidence = vi.fn(() => laterCommandEvidence);
    const store = repository({
      findFakePaymentMethodReplay: vi.fn(async () => expiredReplay),
      prepareFakePaymentMethod,
    });
    const app = new UniversalV1StandardizedQuoteApplication(store, {
      now: () => NOW,
      runtimeEvidence,
    });

    await expect(app.prepareFakePaymentMethod(ACTOR_ID, {
      taskDraftId: DRAFT_ID,
      acceptanceFactId: ACCEPTANCE_ID,
      expectedQuoteVersion: 1,
      expectedReadinessVersion: 0,
      idempotencyKey: 'readiness:expired:0001',
      clientTs: NOW,
    })).resolves.toMatchObject({
      state: 'FAKE_PAYMENT_METHOD_EXPIRED',
      readiness: {
        readinessVersion: 1,
        currentStatus: 'EXPIRED',
        isCurrent: false,
      },
      idempotencyReplayed: true,
      renewalRequired: true,
      routeReviewRequired: false,
      networkCalled: false,
      customerMoneyCreated: false,
      financialSecurityEventCreated: false,
    });
    expect(runtimeEvidence).not.toHaveBeenCalled();
    expect(prepareFakePaymentMethod).not.toHaveBeenCalled();
  });

  it.each([
    {
      currentStatus: 'SUPERSEDED' as const,
      state: 'FAKE_PAYMENT_METHOD_SUPERSEDED',
    },
    {
      currentStatus: 'ROUTE_REVIEW_REQUIRED' as const,
      state: 'FAKE_PAYMENT_METHOD_ROUTE_REVIEW_REQUIRED',
    },
  ])(
    'labels a $currentStatus replay without claiming an actionable renewal',
    async ({ currentStatus, state }) => {
      const replay = readinessRecord(1, currentStatus);
      const store = repository({
        findFakePaymentMethodReplay: vi.fn(async () => replay),
      });
      const app = new UniversalV1StandardizedQuoteApplication(store, {
        now: () => NOW,
        runtimeEvidence: () => laterCommandEvidence,
      });

      await expect(app.prepareFakePaymentMethod(ACTOR_ID, {
        taskDraftId: DRAFT_ID,
        acceptanceFactId: ACCEPTANCE_ID,
        expectedQuoteVersion: 1,
        expectedReadinessVersion: 0,
        idempotencyKey: 'readiness:noncurrent:0001',
        clientTs: NOW,
      })).resolves.toMatchObject({
        state,
        readiness: { currentStatus, isCurrent: false },
        idempotencyReplayed: true,
        renewalRequired: false,
        routeReviewRequired: currentStatus === 'ROUTE_REVIEW_REQUIRED',
      });
    }
  );

  it('rejects a stale first execution after replay lookup and before runtime authority or mutation', async () => {
    const store = repository();
    const runtimeEvidence = vi.fn(() => issuanceEvidence);
    const app = new UniversalV1StandardizedQuoteApplication(store, {
      now: () => NOW,
      runtimeEvidence,
    });

    await expect(
      app.prepareQuote(ACTOR_ID, {
        taskDraftId: DRAFT_ID,
        expectedRoutingDecisionVersion: 1,
        expectedQuoteVersion: 0,
        idempotencyKey: 'quote:prepare:stale',
        clientTs: NOW - 10 * 60 * 1_000 - 1,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(runtimeEvidence).not.toHaveBeenCalled();
    expect(store.findQuoteReplay).toHaveBeenCalledOnce();
    expect(store.prepareQuote).not.toHaveBeenCalled();
  });

  it('replays a lost committed response after ten minutes and across a deployment', async () => {
    const store = repository({
      findAcceptanceReplay: vi.fn(async () => acceptanceRecord()),
    });
    const runtimeEvidence = vi.fn(() => issuanceEvidence);
    const app = new UniversalV1StandardizedQuoteApplication(store, {
      now: () => NOW + 60 * 60 * 1_000,
      runtimeEvidence,
    });

    await expect(
      app.acceptQuote(ACTOR_ID, {
        taskDraftId: DRAFT_ID,
        quoteVersionId: QUOTE_ID,
        expectedRoutingDecisionVersion: 1,
        expectedQuoteVersion: 1,
        expectedAcceptanceVersion: 0,
        idempotencyKey: 'quote:accept:00001',
        clientTs: NOW,
      })
    ).resolves.toMatchObject({
      state: 'ACCEPTED',
      idempotencyReplayed: true,
      acceptance: { commandEvidence: laterCommandEvidence },
    });
    expect(runtimeEvidence).not.toHaveBeenCalled();
    expect(store.acceptQuote).not.toHaveBeenCalled();
  });

  it('never promotes the shared database witness into manifest or financial authority', () => {
    expect(universalV1StandardizedQuoteAuthority).toMatchObject({
      databaseCallerIdentityAttested: false,
      releaseEvidenceAuthority: 'APPLICATION_MEASURED_DB_WITNESS_ONLY',
      directDatabaseInvocation: 'NO_RELEASE_OR_FINANCIAL_AUTHORITY',
      networkAccess: false,
      externalValue: false,
      paymentCreationAuthority: 'NONE',
      financialSecurityEventAuthority: 'NONE',
      assignmentAuthority: 'NONE',
      workOrderAuthority: 'NONE',
    });
  });
});
