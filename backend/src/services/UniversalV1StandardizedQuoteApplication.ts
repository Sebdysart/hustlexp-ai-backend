import { buildIdentity } from '../buildIdentity.js';
import { releaseManifestDigest } from '../releaseManifest.js';
import { assertNonproductionFakeFinanceAuthorized } from './payment/NonproductionFinancialAuthorization.js';
import {
  universalV1FakePaymentMethodReadinessRequestSha256,
  universalV1FakePaymentMethodReference,
  universalV1FakePaymentMethodReferenceSha256,
  universalV1StandardizedQuoteAcceptanceRequestSha256,
  universalV1StandardizedQuoteAuthority,
  UniversalV1StandardizedQuoteError,
  universalV1StandardizedQuoteRequestSha256,
  type AcceptUniversalV1StandardizedQuoteInput,
  type GetCurrentUniversalV1StandardizedQuoteInput,
  type PrepareUniversalV1FakePaymentMethodInput,
  type PrepareUniversalV1StandardizedQuoteInput,
  type UniversalV1FakePaymentMethodReadinessRecord,
  type UniversalV1StandardizedQuoteAcceptanceRecord,
  type UniversalV1StandardizedQuoteCurrentState,
  type UniversalV1StandardizedQuoteRecord,
  type UniversalV1StandardizedQuoteRuntimeEvidence,
} from './UniversalV1StandardizedQuoteContracts.js';

export interface PrepareUniversalV1StandardizedQuoteCommand {
  actorUserId: string;
  input: PrepareUniversalV1StandardizedQuoteInput;
  requestSha256: string;
  evidence: UniversalV1StandardizedQuoteRuntimeEvidence;
}

export interface AcceptUniversalV1StandardizedQuoteCommand {
  actorUserId: string;
  input: AcceptUniversalV1StandardizedQuoteInput;
  requestSha256: string;
  evidence: UniversalV1StandardizedQuoteRuntimeEvidence;
}

export interface PrepareUniversalV1FakePaymentMethodCommand {
  actorUserId: string;
  input: PrepareUniversalV1FakePaymentMethodInput;
  requestSha256: string;
  opaqueReferenceSha256: string;
  evidence: UniversalV1StandardizedQuoteRuntimeEvidence;
}

export interface UniversalV1StandardizedQuoteRepository {
  findQuoteReplay(
    actorUserId: string,
    input: PrepareUniversalV1StandardizedQuoteInput,
    requestSha256: string
  ): Promise<UniversalV1StandardizedQuoteRecord | null>;
  prepareQuote(command: PrepareUniversalV1StandardizedQuoteCommand): Promise<{
    record: UniversalV1StandardizedQuoteRecord;
    replayed: boolean;
  }>;
  getCurrent(
    actorUserId: string,
    input: GetCurrentUniversalV1StandardizedQuoteInput
  ): Promise<UniversalV1StandardizedQuoteCurrentState>;
  findAcceptanceReplay(
    actorUserId: string,
    input: AcceptUniversalV1StandardizedQuoteInput,
    requestSha256: string
  ): Promise<UniversalV1StandardizedQuoteAcceptanceRecord | null>;
  acceptQuote(command: AcceptUniversalV1StandardizedQuoteCommand): Promise<{
    record: UniversalV1StandardizedQuoteAcceptanceRecord;
    replayed: boolean;
  }>;
  findFakePaymentMethodReplay(
    actorUserId: string,
    input: PrepareUniversalV1FakePaymentMethodInput,
    requestSha256: string
  ): Promise<UniversalV1FakePaymentMethodReadinessRecord | null>;
  prepareFakePaymentMethod(command: PrepareUniversalV1FakePaymentMethodCommand): Promise<{
    record: UniversalV1FakePaymentMethodReadinessRecord;
    replayed: boolean;
  }>;
}

function quoteResponse(
  record: UniversalV1StandardizedQuoteRecord,
  replayed: boolean
) {
  return {
    state: 'QUOTED' as const,
    quote: record,
    idempotencyReplayed: replayed,
    paymentCreationFrozen: true as const,
    taskCreated: false as const,
    assignmentCreated: false as const,
    workOrderCreated: false as const,
    authority: universalV1StandardizedQuoteAuthority,
  };
}

function acceptanceResponse(
  record: UniversalV1StandardizedQuoteAcceptanceRecord,
  replayed: boolean
) {
  return {
    state: 'ACCEPTED' as const,
    acceptance: record,
    idempotencyReplayed: replayed,
    paymentCreationCreated: false as const,
    financialSecurityEventCreated: false as const,
    taskCreated: false as const,
    assignmentCreated: false as const,
    workOrderCreated: false as const,
    authority: universalV1StandardizedQuoteAuthority,
  };
}

function readinessResponse(
  record: UniversalV1FakePaymentMethodReadinessRecord,
  fakePaymentMethodReference: string,
  replayed: boolean
) {
  const state = record.currentStatus === 'CURRENT'
    ? 'FAKE_PAYMENT_METHOD_READY' as const
    : record.currentStatus === 'EXPIRED'
      ? 'FAKE_PAYMENT_METHOD_EXPIRED' as const
      : record.currentStatus === 'SUPERSEDED'
        ? 'FAKE_PAYMENT_METHOD_SUPERSEDED' as const
        : 'FAKE_PAYMENT_METHOD_ROUTE_REVIEW_REQUIRED' as const;
  return {
    state,
    readiness: record,
    fakePaymentMethodReference,
    idempotencyReplayed: replayed,
    renewalRequired: record.currentStatus === 'EXPIRED',
    routeReviewRequired: record.currentStatus === 'ROUTE_REVIEW_REQUIRED',
    providerKind: 'FAKE' as const,
    networkCalled: false as const,
    externalValueCreated: false as const,
    customerMoneyCreated: false as const,
    authorizationCreated: false as const,
    financialSecurityEventCreated: false as const,
    captureCreated: false as const,
    taskCreated: false as const,
    assignmentCreated: false as const,
    workOrderCreated: false as const,
    settlementCreated: false as const,
    payoutCreated: false as const,
    authority: universalV1StandardizedQuoteAuthority,
  };
}

export interface UniversalV1StandardizedQuoteApplicationDependencies {
  now: () => number;
  runtimeEvidence: () => UniversalV1StandardizedQuoteRuntimeEvidence;
}

function defaultRuntimeEvidence(): UniversalV1StandardizedQuoteRuntimeEvidence {
  try {
    const manifest = assertNonproductionFakeFinanceAuthorized({ component: 'backend' });
    return {
      environment: manifest.environment,
      buildCommitSha: buildIdentity.revision,
      releaseManifestDigest: releaseManifestDigest(manifest),
      capabilityPolicyDigest: manifest.authority.capabilityPolicyDigest,
    };
  } catch {
    throw new UniversalV1StandardizedQuoteError(
      'PRECONDITION_FAILED',
      'Exact nonproduction FAKE release authority is required.'
    );
  }
}

function assertFresh(clientTimestamp: number, serverTimestamp: number): void {
  if (Math.abs(serverTimestamp - clientTimestamp) > 10 * 60 * 1_000) {
    throw new UniversalV1StandardizedQuoteError(
      'BAD_REQUEST',
      'Request timestamp is outside the ten-minute command window.'
    );
  }
}

export class UniversalV1StandardizedQuoteApplication {
  private readonly dependencies: UniversalV1StandardizedQuoteApplicationDependencies;

  constructor(
    private readonly repository: UniversalV1StandardizedQuoteRepository,
    dependencyOverrides: Partial<UniversalV1StandardizedQuoteApplicationDependencies> = {}
  ) {
    this.dependencies = {
      now: Date.now,
      runtimeEvidence: defaultRuntimeEvidence,
      ...dependencyOverrides,
    };
  }

  async prepareQuote(actorUserId: string, input: PrepareUniversalV1StandardizedQuoteInput) {
    const requestSha256 = universalV1StandardizedQuoteRequestSha256(actorUserId, input);
    const replay = await this.repository.findQuoteReplay(actorUserId, input, requestSha256);
    if (replay) return quoteResponse(replay, true);
    assertFresh(input.clientTs, this.dependencies.now());
    const evidence = this.dependencies.runtimeEvidence();
    const result = await this.repository.prepareQuote({
      actorUserId,
      input,
      evidence,
      requestSha256,
    });
    return quoteResponse(result.record, result.replayed);
  }

  async getCurrent(actorUserId: string, input: GetCurrentUniversalV1StandardizedQuoteInput) {
    const state = await this.repository.getCurrent(actorUserId, input);
    return {
      ...state,
      paymentCreationFrozen: true as const,
      taskCreated: false as const,
      assignmentCreated: false as const,
      workOrderCreated: false as const,
      authority: universalV1StandardizedQuoteAuthority,
    };
  }

  async acceptQuote(actorUserId: string, input: AcceptUniversalV1StandardizedQuoteInput) {
    const requestSha256 = universalV1StandardizedQuoteAcceptanceRequestSha256(
      actorUserId,
      input
    );
    const replay = await this.repository.findAcceptanceReplay(
      actorUserId,
      input,
      requestSha256
    );
    if (replay) return acceptanceResponse(replay, true);
    assertFresh(input.clientTs, this.dependencies.now());
    const evidence = this.dependencies.runtimeEvidence();
    const result = await this.repository.acceptQuote({
      actorUserId,
      input,
      evidence,
      requestSha256,
    });
    return acceptanceResponse(result.record, result.replayed);
  }

  async prepareFakePaymentMethod(
    actorUserId: string,
    input: PrepareUniversalV1FakePaymentMethodInput
  ) {
    const fakePaymentMethodReference = universalV1FakePaymentMethodReference(
      actorUserId,
      input
    );
    const opaqueReferenceSha256 = universalV1FakePaymentMethodReferenceSha256(
      fakePaymentMethodReference
    );
    const requestSha256 = universalV1FakePaymentMethodReadinessRequestSha256(
      actorUserId,
      input,
      opaqueReferenceSha256
    );
    const replay = await this.repository.findFakePaymentMethodReplay(
      actorUserId,
      input,
      requestSha256
    );
    if (replay) return readinessResponse(replay, fakePaymentMethodReference, true);
    assertFresh(input.clientTs, this.dependencies.now());
    const evidence = this.dependencies.runtimeEvidence();
    const result = await this.repository.prepareFakePaymentMethod({
      actorUserId,
      input,
      evidence,
      opaqueReferenceSha256,
      requestSha256,
    });
    return readinessResponse(
      result.record,
      fakePaymentMethodReference,
      result.replayed
    );
  }
}
