import { createHash } from 'node:crypto';

import { z } from 'zod';

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const exactVersion = z.number().int().positive().max(POSTGRES_INTEGER_MAX);
const expectedVersion = z.number().int().min(0).max(POSTGRES_INTEGER_MAX - 1);
const idempotencyKey = z.string().regex(/^[A-Za-z0-9:_-]{16,96}$/u);
const clientTimestamp = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const PrepareUniversalV1StandardizedQuoteSchema = z
  .object({
    taskDraftId: z.string().uuid(),
    expectedRoutingDecisionVersion: exactVersion,
    expectedQuoteVersion: expectedVersion,
    idempotencyKey,
    clientTs: clientTimestamp,
  })
  .strict();

export const GetCurrentUniversalV1StandardizedQuoteSchema = z
  .object({
    taskDraftId: z.string().uuid(),
  })
  .strict();

export const AcceptUniversalV1StandardizedQuoteSchema = z
  .object({
    taskDraftId: z.string().uuid(),
    quoteVersionId: z.string().uuid(),
    expectedRoutingDecisionVersion: exactVersion,
    expectedQuoteVersion: exactVersion,
    expectedAcceptanceVersion: z.literal(0),
    idempotencyKey,
    clientTs: clientTimestamp,
  })
  .strict();

export const PrepareUniversalV1FakePaymentMethodSchema = z
  .object({
    taskDraftId: z.string().uuid(),
    acceptanceFactId: z.string().uuid(),
    expectedQuoteVersion: exactVersion,
    expectedReadinessVersion: expectedVersion,
    idempotencyKey,
    clientTs: clientTimestamp,
  })
  .strict();

export type PrepareUniversalV1StandardizedQuoteInput = z.infer<
  typeof PrepareUniversalV1StandardizedQuoteSchema
>;
export type GetCurrentUniversalV1StandardizedQuoteInput = z.infer<
  typeof GetCurrentUniversalV1StandardizedQuoteSchema
>;
export type AcceptUniversalV1StandardizedQuoteInput = z.infer<
  typeof AcceptUniversalV1StandardizedQuoteSchema
>;
export type PrepareUniversalV1FakePaymentMethodInput = z.infer<
  typeof PrepareUniversalV1FakePaymentMethodSchema
>;

export type UniversalV1StandardizedQuoteEnvironment = 'local' | 'preview' | 'staging';

export interface UniversalV1StandardizedQuoteRuntimeEvidence {
  environment: UniversalV1StandardizedQuoteEnvironment;
  buildCommitSha: string;
  releaseManifestDigest: string;
  capabilityPolicyDigest: string;
}

export const universalV1StandardizedQuoteAuthority = {
  contractVersion: 'HX_UNIVERSAL_V1_STANDARDIZED_QUOTE_READINESS_V1',
  databaseCallerIdentityAttested: false,
  releaseEvidenceAuthority: 'APPLICATION_MEASURED_DB_WITNESS_ONLY',
  directDatabaseInvocation: 'NO_RELEASE_OR_FINANCIAL_AUTHORITY',
  relationshipOriginAuthority: 'OBSERVED_ONLY',
  scopeAuthority: 'STANDARDIZED_PRICE_BOOK_SCOPE_ONLY',
  pricingAuthority: 'DETERMINISTIC_NONPRODUCTION_STANDARDIZED_BASE_POLICY',
  providerKind: 'FAKE',
  networkAccess: false,
  externalValue: false,
  paymentCreationAuthority: 'NONE',
  financialSecurityEventAuthority: 'NONE',
  authorizationAuthority: 'NONE',
  captureAuthority: 'NONE',
  taskAuthority: 'NONE',
  eligibilityAuthority: 'NONE',
  reservationAuthority: 'NONE',
  assignmentAuthority: 'NONE',
  workOrderAuthority: 'NONE',
  addressContactAuthority: 'NONE',
  settlementAuthority: 'NONE',
  payoutAuthority: 'NONE',
} as const;

export interface UniversalV1StandardizedQuoteRecord {
  quoteVersionId: string;
  taskDraftId: string;
  routingDecisionId: string;
  routingDecisionVersion: number;
  relationshipOriginId: string;
  relationshipOriginVersion: number;
  serviceCellAuthorityId: string;
  serviceCellAuthorityVersion: number;
  quoteVersion: number;
  quoteKind: 'STANDARDIZED_SCOPE_FIXED_PRICE';
  scopeArtifactKind: 'TASK_DRAFT_STANDARDIZED_SCOPE_V1';
  scopeArtifactId: string;
  scopeArtifactVersion: number;
  workCategoryCode: string;
  regionCode: string;
  roughLocation: string;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'IN_HOME';
  requiresProof: true;
  scopeSnapshot: Record<string, unknown>;
  scopeSha256: string;
  priceBookId: string;
  priceBookMappingId: string;
  pricingPolicyVersion: string;
  pricingSnapshot: Record<string, unknown>;
  pricingSha256: string;
  quoteEvidenceSha256: string;
  customerTotalCents: number;
  providerPayoutCents: number;
  platformMarginCents: number;
  currency: 'usd';
  paymentPosture: 'PAYMENT_CREATION_FROZEN';
  environment: UniversalV1StandardizedQuoteEnvironment;
  issuanceEvidence: UniversalV1StandardizedQuoteRuntimeEvidence;
  issuanceEvidenceSha256: string;
  idempotencyKey: string;
  requestSha256: string;
  validUntil: string;
  createdAt: string;
}

export interface UniversalV1StandardizedQuoteAcceptanceRecord {
  acceptanceFactId: string;
  taskDraftId: string;
  quoteVersionId: string;
  quoteVersion: number;
  routingDecisionId: string;
  routingDecisionVersion: number;
  scopeArtifactKind: 'TASK_DRAFT_STANDARDIZED_SCOPE_V1';
  scopeArtifactId: string;
  scopeArtifactVersion: number;
  scopeSha256: string;
  pricingSha256: string;
  quoteEvidenceSha256: string;
  customerTotalCents: number;
  currency: 'usd';
  acceptanceVersion: 1;
  acceptedByUserId: string;
  environment: UniversalV1StandardizedQuoteEnvironment;
  commandEvidence: UniversalV1StandardizedQuoteRuntimeEvidence;
  commandEvidenceSha256: string;
  idempotencyKey: string;
  requestSha256: string;
  acceptedAt: string;
}

export interface UniversalV1FakePaymentMethodReadinessRecord {
  readinessFactId: string;
  taskDraftId: string;
  acceptanceFactId: string;
  quoteVersionId: string;
  quoteVersion: number;
  readinessVersion: number;
  providerKind: 'FAKE';
  environment: UniversalV1StandardizedQuoteEnvironment;
  preparedByUserId: string;
  fakeProviderOperationId: string;
  opaqueReferenceSha256: string;
  commandEvidence: UniversalV1StandardizedQuoteRuntimeEvidence;
  commandEvidenceSha256: string;
  idempotencyKey: string;
  requestSha256: string;
  expiresAt: string;
  createdAt: string;
  currentStatus:
    | 'CURRENT'
    | 'EXPIRED'
    | 'SUPERSEDED'
    | 'ROUTE_REVIEW_REQUIRED';
  isCurrent: boolean;
}

export interface UniversalV1StandardizedQuoteCurrentState {
  quote: UniversalV1StandardizedQuoteRecord | null;
  acceptance: UniversalV1StandardizedQuoteAcceptanceRecord | null;
  /** Latest readiness chain head, including an expired head needed for renewal versioning. */
  readiness: UniversalV1FakePaymentMethodReadinessRecord | null;
  routingCurrent: boolean;
  acceptanceOpen: boolean;
  priceLocked: boolean;
  fakePaymentMethodReady: boolean;
  actionableState:
    | 'PREPARE_QUOTE_OR_REVIEW_ROUTE'
    | 'ACCEPT_QUOTE'
    | 'REQUOTE_OR_REVIEW_ROUTE'
    | 'ROUTE_REVIEW_REQUIRED_AFTER_ACCEPTANCE'
    | 'PREPARE_OR_RENEW_FAKE_PAYMENT_METHOD'
    | 'READY_FOR_PROVIDER_DISCOVERY';
}

export type UniversalV1StandardizedQuoteErrorCode =
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'CONFLICT'
  | 'PRECONDITION_FAILED'
  | 'INTERNAL_SERVER_ERROR';

export class UniversalV1StandardizedQuoteError extends Error {
  constructor(
    readonly code: UniversalV1StandardizedQuoteErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'UniversalV1StandardizedQuoteError';
  }
}

function sha256(parts: Array<string | number>): string {
  return createHash('sha256').update(parts.join('|'), 'utf8').digest('hex');
}

function canonicalUuid(value: string): string {
  return value.toLowerCase();
}

export function universalV1StandardizedQuoteRequestSha256(
  actorUserId: string,
  input: PrepareUniversalV1StandardizedQuoteInput
): string {
  return sha256([
    'HX_UNIVERSAL_V1_STANDARDIZED_QUOTE_PREPARE_V1',
    canonicalUuid(actorUserId),
    canonicalUuid(input.taskDraftId),
    input.expectedRoutingDecisionVersion,
    input.expectedQuoteVersion,
    input.idempotencyKey,
    input.clientTs,
  ]);
}

export function universalV1StandardizedQuoteAcceptanceRequestSha256(
  actorUserId: string,
  input: AcceptUniversalV1StandardizedQuoteInput
): string {
  return sha256([
    'HX_UNIVERSAL_V1_STANDARDIZED_QUOTE_ACCEPT_V1',
    canonicalUuid(actorUserId),
    canonicalUuid(input.taskDraftId),
    canonicalUuid(input.quoteVersionId),
    input.expectedRoutingDecisionVersion,
    input.expectedQuoteVersion,
    input.expectedAcceptanceVersion,
    input.idempotencyKey,
    input.clientTs,
  ]);
}

export function universalV1FakePaymentMethodReference(
  actorUserId: string,
  input: PrepareUniversalV1FakePaymentMethodInput
): string {
  return `fake_pm_${sha256([
    'HX_UNIVERSAL_V1_FAKE_PAYMENT_METHOD_REFERENCE_V1',
    canonicalUuid(actorUserId),
    canonicalUuid(input.taskDraftId),
    canonicalUuid(input.acceptanceFactId),
    input.expectedQuoteVersion,
    input.expectedReadinessVersion,
    input.idempotencyKey,
  ])}`;
}

export function universalV1FakePaymentMethodReferenceSha256(reference: string): string {
  return createHash('sha256').update(reference, 'utf8').digest('hex');
}

export function universalV1FakePaymentMethodReadinessRequestSha256(
  actorUserId: string,
  input: PrepareUniversalV1FakePaymentMethodInput,
  opaqueReferenceSha256: string
): string {
  return sha256([
    'HX_UNIVERSAL_V1_FAKE_PAYMENT_METHOD_READINESS_V1',
    canonicalUuid(actorUserId),
    canonicalUuid(input.taskDraftId),
    canonicalUuid(input.acceptanceFactId),
    input.expectedQuoteVersion,
    input.expectedReadinessVersion,
    input.idempotencyKey,
    input.clientTs,
    opaqueReferenceSha256,
  ]);
}
