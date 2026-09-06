import type { Database, QueryFn } from '../db.js';
import {
  UniversalV1StandardizedQuoteError,
  type UniversalV1FakePaymentMethodReadinessRecord,
  type UniversalV1StandardizedQuoteAcceptanceRecord,
  type UniversalV1StandardizedQuoteRecord,
} from './UniversalV1StandardizedQuoteContracts.js';

export interface StandardizedQuoteDatabase {
  query: Database['query'];
  serializableTransaction: Database['serializableTransaction'];
}

export interface QuoteRouteRow {
  routing_decision_id: string;
  routing_decision_version: number | string;
}

export interface QuoteRow {
  id: string;
  task_draft_id: string;
  routing_decision_id: string;
  routing_decision_version: number | string;
  relationship_origin_id: string;
  relationship_origin_version: number | string;
  service_cell_authority_id: string;
  service_cell_authority_version: number | string;
  quote_version: number | string;
  quote_kind: 'STANDARDIZED_SCOPE_FIXED_PRICE';
  scope_artifact_kind: 'TASK_DRAFT_STANDARDIZED_SCOPE_V1';
  scope_artifact_id: string;
  scope_artifact_version: number | string;
  work_category_code: string;
  region_code: string;
  rough_location: string;
  risk_level: 'LOW' | 'MEDIUM' | 'HIGH' | 'IN_HOME';
  requires_proof: boolean;
  scope_snapshot: Record<string, unknown>;
  scope_sha256: string;
  price_book_id: string;
  price_book_mapping_id: string;
  pricing_policy_version: string;
  pricing_snapshot: Record<string, unknown>;
  pricing_sha256: string;
  quote_evidence_sha256: string;
  customer_total_cents: number | string;
  provider_payout_cents: number | string;
  platform_margin_cents: number | string;
  currency: 'usd';
  payment_posture: 'PAYMENT_CREATION_FROZEN';
  environment_class: 'local' | 'preview' | 'staging';
  issuance_build_commit_sha: string;
  issuance_release_manifest_digest: string;
  issuance_capability_policy_digest: string;
  issuance_evidence_sha256: string;
  idempotency_key: string;
  request_sha256: string;
  valid_until: Date | string;
  created_at: Date | string;
  routing_current?: boolean;
  quote_unexpired?: boolean;
}

export interface AcceptanceRow {
  id: string;
  task_draft_id: string;
  quote_version_id: string;
  quote_version: number | string;
  routing_decision_id: string;
  routing_decision_version: number | string;
  scope_artifact_kind: 'TASK_DRAFT_STANDARDIZED_SCOPE_V1';
  scope_artifact_id: string;
  scope_artifact_version: number | string;
  scope_sha256: string;
  pricing_sha256: string;
  quote_evidence_sha256: string;
  customer_total_cents: number | string;
  currency: 'usd';
  acceptance_version: number | string;
  accepted_by_user_id: string;
  environment_class: 'local' | 'preview' | 'staging';
  command_build_commit_sha: string;
  command_release_manifest_digest: string;
  command_capability_policy_digest: string;
  command_evidence_sha256: string;
  idempotency_key: string;
  request_sha256: string;
  accepted_at: Date | string;
}

export interface ReadinessRow {
  id: string;
  task_draft_id: string;
  acceptance_fact_id: string;
  quote_version_id: string;
  quote_version: number | string;
  readiness_version: number | string;
  provider_kind: 'FAKE';
  environment_class: 'local' | 'preview' | 'staging';
  prepared_by_user_id: string;
  fake_provider_operation_id: string;
  opaque_reference_sha256: string;
  command_build_commit_sha: string;
  command_release_manifest_digest: string;
  command_capability_policy_digest: string;
  command_evidence_sha256: string;
  idempotency_key: string;
  request_sha256: string;
  expires_at: Date | string;
  created_at: Date | string;
  is_current: boolean;
  readiness_chain_head: boolean;
  readiness_unexpired: boolean;
  routing_current: boolean;
}

export function fail(
  code: ConstructorParameters<typeof UniversalV1StandardizedQuoteError>[0],
  message: string
): never {
  throw new UniversalV1StandardizedQuoteError(code, message);
}

export function exactInteger(value: number | string, label: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return fail('INTERNAL_SERVER_ERROR', `${label} returned an invalid exact integer.`);
  }
  return parsed;
}

export function iso(value: Date | string): string {
  const timestamp = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    return fail('INTERNAL_SERVER_ERROR', 'Standardized quote fact returned an invalid timestamp.');
  }
  return timestamp.toISOString();
}

export function quoteRecord(row: QuoteRow): UniversalV1StandardizedQuoteRecord {
  if (row.requires_proof !== true) {
    return fail('INTERNAL_SERVER_ERROR', 'Standardized quote lost its proof requirement.');
  }
  return {
    quoteVersionId: row.id,
    taskDraftId: row.task_draft_id,
    routingDecisionId: row.routing_decision_id,
    routingDecisionVersion: exactInteger(row.routing_decision_version, 'Routing decision'),
    relationshipOriginId: row.relationship_origin_id,
    relationshipOriginVersion: exactInteger(row.relationship_origin_version, 'Relationship origin'),
    serviceCellAuthorityId: row.service_cell_authority_id,
    serviceCellAuthorityVersion: exactInteger(
      row.service_cell_authority_version,
      'Service cell authority'
    ),
    quoteVersion: exactInteger(row.quote_version, 'Quote'),
    quoteKind: row.quote_kind,
    scopeArtifactKind: row.scope_artifact_kind,
    scopeArtifactId: row.scope_artifact_id,
    scopeArtifactVersion: exactInteger(row.scope_artifact_version, 'Scope artifact'),
    workCategoryCode: row.work_category_code,
    regionCode: row.region_code,
    roughLocation: row.rough_location,
    riskLevel: row.risk_level,
    requiresProof: true,
    scopeSnapshot: row.scope_snapshot,
    scopeSha256: row.scope_sha256.trim(),
    priceBookId: row.price_book_id,
    priceBookMappingId: row.price_book_mapping_id,
    pricingPolicyVersion: row.pricing_policy_version,
    pricingSnapshot: row.pricing_snapshot,
    pricingSha256: row.pricing_sha256.trim(),
    quoteEvidenceSha256: row.quote_evidence_sha256.trim(),
    customerTotalCents: exactInteger(row.customer_total_cents, 'Customer total'),
    providerPayoutCents: exactInteger(row.provider_payout_cents, 'Provider payout'),
    platformMarginCents: exactInteger(row.platform_margin_cents, 'Platform margin'),
    currency: row.currency,
    paymentPosture: row.payment_posture,
    environment: row.environment_class,
    issuanceEvidence: {
      environment: row.environment_class,
      buildCommitSha: row.issuance_build_commit_sha.trim(),
      releaseManifestDigest: row.issuance_release_manifest_digest,
      capabilityPolicyDigest: row.issuance_capability_policy_digest,
    },
    issuanceEvidenceSha256: row.issuance_evidence_sha256.trim(),
    idempotencyKey: row.idempotency_key,
    requestSha256: row.request_sha256.trim(),
    validUntil: iso(row.valid_until),
    createdAt: iso(row.created_at),
  };
}

export function acceptanceRecord(
  row: AcceptanceRow
): UniversalV1StandardizedQuoteAcceptanceRecord {
  if (exactInteger(row.acceptance_version, 'Acceptance') !== 1) {
    return fail('INTERNAL_SERVER_ERROR', 'Acceptance returned an unsupported version.');
  }
  return {
    acceptanceFactId: row.id,
    taskDraftId: row.task_draft_id,
    quoteVersionId: row.quote_version_id,
    quoteVersion: exactInteger(row.quote_version, 'Quote'),
    routingDecisionId: row.routing_decision_id,
    routingDecisionVersion: exactInteger(row.routing_decision_version, 'Routing decision'),
    scopeArtifactKind: row.scope_artifact_kind,
    scopeArtifactId: row.scope_artifact_id,
    scopeArtifactVersion: exactInteger(row.scope_artifact_version, 'Scope artifact'),
    scopeSha256: row.scope_sha256.trim(),
    pricingSha256: row.pricing_sha256.trim(),
    quoteEvidenceSha256: row.quote_evidence_sha256.trim(),
    customerTotalCents: exactInteger(row.customer_total_cents, 'Customer total'),
    currency: row.currency,
    acceptanceVersion: 1,
    acceptedByUserId: row.accepted_by_user_id,
    environment: row.environment_class,
    commandEvidence: {
      environment: row.environment_class,
      buildCommitSha: row.command_build_commit_sha.trim(),
      releaseManifestDigest: row.command_release_manifest_digest,
      capabilityPolicyDigest: row.command_capability_policy_digest,
    },
    commandEvidenceSha256: row.command_evidence_sha256.trim(),
    idempotencyKey: row.idempotency_key,
    requestSha256: row.request_sha256.trim(),
    acceptedAt: iso(row.accepted_at),
  };
}

function exactBooleanProjection(value: unknown, label: string): boolean {
  if (value !== true && value !== false) {
    return fail(
      'INTERNAL_SERVER_ERROR',
      `${label} projection was missing or was not a PostgreSQL boolean.`
    );
  }
  return value;
}

export function readinessRecord(
  row: ReadinessRow
): UniversalV1FakePaymentMethodReadinessRecord {
  const readinessVersion = exactInteger(row.readiness_version, 'Readiness');
  const routingCurrent = exactBooleanProjection(row.routing_current, 'Readiness routing');
  const readinessChainHead = exactBooleanProjection(
    row.readiness_chain_head,
    'Readiness chain-head'
  );
  const readinessUnexpired = exactBooleanProjection(
    row.readiness_unexpired,
    'Readiness expiry'
  );
  const currentStatus =
    routingCurrent === false
      ? ('ROUTE_REVIEW_REQUIRED' as const)
      : readinessChainHead === false
        ? ('SUPERSEDED' as const)
        : readinessUnexpired === false
          ? ('EXPIRED' as const)
          : ('CURRENT' as const);
  const isCurrent = currentStatus === 'CURRENT';
  return {
    readinessFactId: row.id,
    taskDraftId: row.task_draft_id,
    acceptanceFactId: row.acceptance_fact_id,
    quoteVersionId: row.quote_version_id,
    quoteVersion: exactInteger(row.quote_version, 'Quote'),
    readinessVersion,
    providerKind: row.provider_kind,
    environment: row.environment_class,
    preparedByUserId: row.prepared_by_user_id,
    fakeProviderOperationId: row.fake_provider_operation_id,
    opaqueReferenceSha256: row.opaque_reference_sha256.trim(),
    commandEvidence: {
      environment: row.environment_class,
      buildCommitSha: row.command_build_commit_sha.trim(),
      releaseManifestDigest: row.command_release_manifest_digest,
      capabilityPolicyDigest: row.command_capability_policy_digest,
    },
    commandEvidenceSha256: row.command_evidence_sha256.trim(),
    idempotencyKey: row.idempotency_key,
    requestSha256: row.request_sha256.trim(),
    expiresAt: iso(row.expires_at),
    createdAt: iso(row.created_at),
    currentStatus,
    isCurrent,
  };
}

export function translateDatabaseError(error: unknown): never {
  if (error instanceof UniversalV1StandardizedQuoteError) throw error;
  const message = error instanceof Error ? error.message : String(error);
  if (/HXUV1-STDQUOTE-(?:3|7|8|9|12|14|16):/u.test(message)) {
    return fail('CONFLICT', 'The exact standardized quote command version changed.');
  }
  if (/HXUV1-STDQUOTE-/u.test(message)) {
    return fail(
      'PRECONDITION_FAILED',
      'The standardized-scope quote or fake-readiness preconditions are not satisfied.'
    );
  }
  if ((error as { code?: unknown })?.code === '23505') {
    return fail('CONFLICT', 'The idempotency key or immutable fact already exists.');
  }
  if (['40001', '40P01'].includes(String((error as { code?: unknown })?.code ?? ''))) {
    return fail(
      'CONFLICT',
      'The standardized quote lifecycle changed concurrently; retry the exact command.'
    );
  }
  throw error;
}

function retryableSerializationError(error: unknown): boolean {
  return ['40001', '40P01'].includes(String((error as { code?: unknown })?.code ?? ''));
}

export async function assertOwnedDraft(
  query: QueryFn,
  actorUserId: string,
  taskDraftId: string
) {
  const result = await query(
    `SELECT 1
       FROM public.task_drafts draft
       JOIN public.users actor ON actor.id = draft.poster_user_id
      WHERE draft.id = $1::UUID
        AND draft.poster_user_id = $2::UUID
        AND draft.universal_contract_version = 1
        AND draft.ingress_origin = 'BACKEND_POSTGRESQL'
        AND draft.status = 'account_claimed'
        AND draft.task_id IS NULL
        AND actor.default_mode = 'poster'
        AND actor.account_status = 'ACTIVE'
        AND actor.is_minor IS FALSE
        AND COALESCE(actor.is_banned, FALSE) IS FALSE`,
    [taskDraftId, actorUserId]
  );
  if (result.rowCount !== 1) {
    return fail('NOT_FOUND', 'Owned open TaskDraft was not found.');
  }
}

export async function runSerializable<T>(
  database: StandardizedQuoteDatabase,
  operation: (query: QueryFn) => Promise<T>
): Promise<T> {
  const maximumAttempts = 3;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      return await database.serializableTransaction(operation);
    } catch (error) {
      if (!retryableSerializationError(error) || attempt === maximumAttempts) throw error;
    }
  }
  return fail('INTERNAL_SERVER_ERROR', 'Serializable retry loop exhausted unexpectedly.');
}
